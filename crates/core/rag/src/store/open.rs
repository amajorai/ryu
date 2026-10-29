//! Opening, migrating and backfilling a [`RetrievalStore`].

use super::*;

impl RetrievalStore {
    /// Open (or create) the retrieval store at `path` with a chosen embedder,
    /// reranker, and the configured default reranker model id.
    ///
    /// `backfill_owner` = `Some((owner_user_id, owner_org_id))` on an org-bound node
    /// with a signed-in account triggers the one-shot pre-tenancy memory-owner
    /// backfill; `None` (unbound node, or bound-without-account) skips it, byte
    /// identical to the pre-extraction behaviour. The registry/env read and the
    /// account/control-plane lookups that produce these arguments are the
    /// Core-side resolver's job (`apps/core/src/rag_host.rs`).
    ///
    /// Content, vectors and OKF metadata are sealed under the process content
    /// key (fails closed without one). Rows written by an older build are sealed
    /// by a background migration; reads accept both forms meanwhile.
    pub fn open(
        path: PathBuf,
        embedder: Embedder,
        reranker: Reranker,
        reranker_model_id: String,
        backfill_owner: Option<(String, String)>,
    ) -> Result<Self> {
        let keys = RetrievalKeys::resolve()?;
        let store = Self::open_unmigrated(
            path.clone(),
            embedder,
            reranker,
            reranker_model_id,
            backfill_owner,
            keys.clone(),
        )?;
        std::thread::Builder::new()
            .name("retrieval-seal".to_owned())
            .spawn(move || {
                if let Err(error) = Self::migrate_file(&path, &keys) {
                    tracing::warn!(
                        "retrieval store: sealing legacy rows did not finish (retried at the \
                         next start): {error:#}"
                    );
                }
            })
            .context("spawning the retrieval store migration")?;
        Ok(store)
    }

    /// [`Self::open`] with explicit keys, running the legacy-row migration
    /// synchronously before returning (tests).
    pub fn open_with_keys(
        path: PathBuf,
        embedder: Embedder,
        reranker: Reranker,
        reranker_model_id: String,
        backfill_owner: Option<(String, String)>,
        keys: RetrievalKeys,
    ) -> Result<Self> {
        let store = Self::open_unmigrated(
            path.clone(),
            embedder,
            reranker,
            reranker_model_id,
            backfill_owner,
            keys.clone(),
        )?;
        Self::migrate_file(&path, &keys)?;
        Ok(store)
    }

    /// Seal every legacy plaintext value of the store at `path` (content,
    /// vectors, OKF metadata), on its own connection: cursor-paginated,
    /// compare-and-swap, resumable and idempotent
    /// ([`ryu_crypto::content_sqlite::migrate_columns`]), then scrub the freed
    /// plaintext ([`ryu_crypto::content_sqlite::finish_store`]). Values that do
    /// not open are counted and left alone.
    pub fn migrate_file(
        path: &Path,
        keys: &RetrievalKeys,
    ) -> Result<content_sqlite::MigrationReport> {
        let mut conn = Connection::open(path)
            .with_context(|| format!("opening retrieval db {}", path.display()))?;
        content_sqlite::enable_secure_delete(&conn)?;
        let report = content_sqlite::migrate_columns(&mut conn, &keys.cipher, &seal_plans()?)?;
        content_sqlite::record_store_kcv(&conn, RETRIEVAL_STORE, keys.cipher.kcv())?;
        if report.sealed > 0 {
            tracing::info!(
                sealed = report.sealed,
                unreadable = report.unreadable,
                "retrieval store: sealed legacy rows"
            );
        }
        let owed = content_sqlite::read_store_record(&conn, RETRIEVAL_STORE)?
            .is_some_and(|record| record.state == content_sqlite::states::VACUUM_PENDING);
        if owed {
            content_sqlite::finish_store(&conn, path, RETRIEVAL_STORE)?;
        }
        Ok(report)
    }

    pub(crate) fn open_unmigrated(
        path: PathBuf,
        embedder: Embedder,
        reranker: Reranker,
        reranker_model_id: String,
        backfill_owner: Option<(String, String)>,
        keys: RetrievalKeys,
    ) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating retrieval db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening retrieval db {}", path.display()))?;
        content_sqlite::enable_secure_delete(&conn)?;
        // A compaction a previous run deferred runs before any request.
        if let Err(error) = content_sqlite::run_pending_vacuum_gated(&conn, &path, RETRIEVAL_STORE)
        {
            tracing::warn!("retrieval store: deferred compaction failed: {error:#}");
        }
        Self::init_schema(&conn)?;
        let writable = Self::check_keys(&conn, &keys)?;
        if writable {
            // OKF rows written before sealing carry the concept path inside their
            // chunk id; give them blind ids (and seal them) before serving.
            if let Err(e) = Self::seal_legacy_okf_ids(&conn, &keys) {
                tracing::warn!("retrieval OKF id migration skipped: {e:#}");
            }
        }
        // One-shot owner backfill for memory chunks indexed before per-resource
        // tenancy existed (best-effort; never blocks opening the store). Deliberately
        // NOT in `init_schema` (the in-memory test store runs that and must never
        // read the real account vault).
        if let Err(e) = Self::backfill_memory_owner(&conn, backfill_owner.clone()) {
            tracing::warn!("retrieval memory-owner backfill skipped: {e:#}");
        }
        // One-shot org-visibility backfill for pre-tenancy OKF Space chunks: stamps
        // the explicit shared stamp `space_tenancy_allows` now requires, so legacy
        // OKF content does not go dark under the fail-closed bare-unowned default.
        // Non-OKF legacy Space chunks (no `okf_chunks` row) are deliberately left
        // unowned — this store cannot tell a leaked private document from
        // node-shared content, so it fails closed exactly like the memory backfill
        // does for a bound-but-unresolvable owner.
        if let Err(e) = Self::backfill_okf_space_owner(&conn, backfill_owner) {
            tracing::warn!("retrieval OKF space-owner backfill skipped: {e:#}");
        }
        let compaction_owed =
            writable && content_sqlite::compaction_owed(&conn, RETRIEVAL_STORE).unwrap_or(false);
        let store = Self::assemble(conn, embedder, reranker, reranker_model_id, keys, writable);
        if compaction_owed {
            // Too large to compact while it opens: the background worker runs it
            // later under this store's lock.
            let weak = Arc::downgrade(&store.conn);
            content_sqlite::defer_compaction(
                RETRIEVAL_STORE,
                Box::new(move || {
                    let conn = weak.upgrade()?;
                    let conn = conn.blocking_lock();
                    Some(content_sqlite::compact_deferred(
                        &conn,
                        &path,
                        RETRIEVAL_STORE,
                    ))
                }),
            );
        }
        Ok(store)
    }

    pub(crate) fn assemble(
        conn: Connection,
        embedder: Embedder,
        reranker: Reranker,
        reranker_model_id: String,
        keys: RetrievalKeys,
        writable: bool,
    ) -> Self {
        Self {
            conn: Arc::new(Mutex::new(conn)),
            embedder: Arc::new(RwLock::new(embedder)),
            reranker,
            reranker_model_id,
            spaces: None,
            keys: Arc::new(keys),
            vectors: VectorIndex::new(RETRIEVAL_STORE),
            partitions: Arc::new(StdMutex::new(HashSet::new())),
            too_large: Arc::new(StdMutex::new(HashSet::new())),
            writable: Arc::new(AtomicBool::new(writable)),
            unreadable: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Check (and on first use record) the key that seals this store. A store
    /// sealed under a key this process does not hold is unhealthy: writes are
    /// refused. A retired key's values are walked again by the migration.
    pub(crate) fn check_keys(conn: &Connection, keys: &RetrievalKeys) -> Result<bool> {
        match content_sqlite::check_store_key(conn, &keys.cipher)? {
            StoreKeyState::Mismatch { .. } => Ok(false),
            StoreKeyState::Retired => {
                content_sqlite::reset_items(conn, RETRIEVAL_STORE, &seal_plans()?)?;
                Ok(true)
            }
            StoreKeyState::Recorded | StoreKeyState::Current => Ok(true),
        }
    }

    /// Attach the Spaces delegate that answers `opts.space_ids` (see
    /// [`SpaceRecall`] for what it buys and what it costs). Builder form because
    /// the hook needs the `SpaceStore`, which Core opens *before* the retrieval
    /// store; `RetrievalStore` is `Clone` over `Arc`s, so this must be applied to
    /// the ONE instance that goes into `ServerState` — a later `with_space_recall`
    /// on a clone would not reach the copies already handed out.
    #[must_use]
    pub fn with_space_recall(mut self, spaces: Arc<dyn SpaceRecall>) -> Self {
        self.spaces = Some(spaces);
        self
    }
}
