//! Chat-memory preference, run-text sealing and the message search and
//! embedding index handles.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    /// Preference key shared by Core's preference route and the Memory app.
    pub const CHAT_MEMORY_ENABLED_PREF_KEY: &'static str = "chat-memory-enabled";

    /// Parse the persisted Memory source-index flag defensively. Only explicit
    /// truthy values enable it; unset or malformed values stay opt-in-off.
    pub fn parse_chat_memory_enabled(raw: Option<&str>) -> bool {
        matches!(
            raw.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
            Some("true") | Some("1") | Some("on") | Some("yes")
        )
    }

    /// Whether chat messages are currently opted into Memory search/Dream.
    pub fn chat_memory_enabled(&self) -> bool {
        self.chat_memory_enabled.load(Ordering::Acquire)
    }

    /// Update the process-local Memory source-index gate after a preference
    /// write. The preference store remains the durable source of truth.
    pub async fn set_chat_memory_enabled(&self, enabled: bool) -> Result<()> {
        self.chat_memory_enabled.store(enabled, Ordering::Release);
        Ok(())
    }

    /// Clear the derived semantic message index while retaining the encrypted
    /// conversation transcript. Re-enabling chat memory can backfill it again.
    pub async fn clear_message_embeddings(&self) -> anyhow::Result<()> {
        {
            let mut initialized = self.semantic_backfill.lock().await;
            if let Some(index) = self.message_index.clone() {
                index.clear().await?;
            }
            *initialized = false;
        }
        // The keyword index is derived from the same messages: turning chat
        // memory off empties it too (its blind tokens still reveal which
        // messages share words).
        let mut initialized = self.fts_backfill.lock().await;
        if let Some(index) = self.message_fts.clone() {
            index.clear().await?;
        }
        *initialized = false;
        Ok(())
    }

    /// Recall diagnostics for the conversation indexes: how much of the
    /// semantic index is searchable from memory (`vector_coverage`), and how many
    /// rows were skipped because a sealed value did not open.
    pub fn search_index_diagnostics(&self) -> serde_json::Value {
        let coverage = self
            .message_index
            .as_ref()
            .map(ryu_search::MessageIndex::vector_coverage);
        serde_json::json!({
            "vector_coverage": coverage,
            "unreadable": {
                "message_embeddings": self
                    .message_index
                    .as_ref()
                    .map_or(0, ryu_search::MessageIndex::unreadable_rows),
                "source_messages": self.index_unreadable.load(Ordering::Relaxed),
                "harness_runs": self.harness_unreadable.load(Ordering::Relaxed),
            },
        })
    }

    /// Seal legacy run text ([`Self::seal_legacy_run_text`]), then scrub the
    /// plaintext it leaves on disk. Older builds wrote run errors and fallback
    /// warnings in plaintext without `secure_delete`, so rows they deleted (and
    /// the old cells this reseal rewrites) can remain in free pages, inside
    /// partly used pages and in stale WAL frames. The debt is recorded in
    /// `ryu_content_seal` (store [`RUN_TEXT_STORE`], no key check value) before
    /// anything is rewritten: on the first open by a sealing build, and with
    /// every reseal. While it is recorded, `content_sqlite` truncates the WAL,
    /// zeroes the freelist and vacuums the file when it fits the size and
    /// free-space gates; a gated vacuum stays `vacuum_pending` and is retried at
    /// a later start. Call only while `conn` is the store's one open connection.
    pub(super) fn seal_and_scrub_legacy_run_text(
        conn: &Connection,
        path: &std::path::Path,
        cipher: &ryu_crypto::FieldCipher,
    ) -> Result<()> {
        use ryu_crypto::content_sqlite;
        let first_open = content_sqlite::read_store_record(conn, RUN_TEXT_STORE)?.is_none();
        if first_open {
            Self::mark_run_text_scrub_owed(conn)?;
        }
        let sealed = Self::seal_legacy_run_text(conn, cipher)?;
        if first_open || sealed > 0 {
            content_sqlite::finish_store(conn, path, RUN_TEXT_STORE)?;
        } else {
            content_sqlite::run_pending_vacuum_gated(conn, path, RUN_TEXT_STORE)?;
        }
        Ok(())
    }

    /// Hand a compaction too large for the boot path to the background
    /// compaction worker: it runs later under this store's connection lock, so
    /// requests wait for it instead of the boot.
    pub(super) fn defer_compaction(conn: &Arc<Mutex<Connection>>, path: PathBuf) {
        let weak = Arc::downgrade(conn);
        ryu_crypto::content_sqlite::defer_compaction(
            RUN_TEXT_STORE,
            Box::new(move || {
                let conn = weak.upgrade()?;
                let conn = conn.blocking_lock();
                Some(ryu_crypto::content_sqlite::compact_deferred(
                    &conn,
                    &path,
                    RUN_TEXT_STORE,
                ))
            }),
        );
    }

    /// Record that `conversations.db` owes the run-text scrub (keeps an existing
    /// `vacuum_pending` row and its retry time as they are).
    pub(super) fn mark_run_text_scrub_owed(conn: &Connection) -> Result<()> {
        use ryu_crypto::content_sqlite::{ensure_state_table, states, STATE_TABLE, STORE_ITEM};
        ensure_state_table(conn)?;
        conn.execute(
            &format!(
                "INSERT INTO {STATE_TABLE} (store, item, state, cursor, updated_at)
                 VALUES (?1, ?2, ?3, NULL, strftime('%s', 'now'))
                 ON CONFLICT(store, item) DO UPDATE SET state = excluded.state,
                    cursor = NULL, updated_at = excluded.updated_at
                 WHERE {STATE_TABLE}.state != excluded.state"
            ),
            params![RUN_TEXT_STORE, STORE_ITEM, states::VACUUM_PENDING],
        )
        .context("recording the run-text scrub")?;
        Ok(())
    }

    /// Seal `harness_runs.error`, `channel_turn_idempotency.fallback_warning` and
    /// `scope_guidance.goal` / `.instructions` values written before they were
    /// sealed (compare-and-swap per row).
    /// Returns how many values were sealed; each reseal records the scrub debt
    /// in the same transaction.
    pub(super) fn seal_legacy_run_text(
        conn: &Connection,
        cipher: &ryu_crypto::FieldCipher,
    ) -> Result<u64> {
        let mut sealed = 0u64;
        for (table, key, column) in [
            ("harness_runs", "id", "error"),
            (
                "channel_turn_idempotency",
                "idempotency_key",
                "fallback_warning",
            ),
            // Project and bot goals and project instructions are prompt text.
            ("scope_guidance", "scope", "goal"),
            ("scope_guidance", "scope", "instructions"),
        ] {
            let pending: Vec<(String, String)> = {
                let mut stmt = conn.prepare(&format!(
                    "SELECT {key}, {column} FROM {table}
                     WHERE {column} IS NOT NULL AND {column} != '' AND {column} NOT LIKE 'enc:%'"
                ))?;
                let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            if pending.is_empty() {
                continue;
            }
            let tx = conn.unchecked_transaction()?;
            Self::mark_run_text_scrub_owed(&tx)?;
            for (id, plain) in &pending {
                tx.execute(
                    &format!("UPDATE {table} SET {column} = ?1 WHERE {key} = ?2 AND {column} = ?3"),
                    params![cipher.seal(plain)?, id, plain],
                )?;
            }
            tx.commit()?;
            sealed += pending.len() as u64;
            tracing::info!(table, sealed = pending.len(), "sealed legacy run text");
        }
        Ok(sealed)
    }

    /// Open a sealed message body for a derived index. `None` when it does not
    /// open: the caller skips the row (never indexes placeholder text) and the
    /// skip is counted.
    pub(super) fn open_content_for_index(&self, stored: String) -> Option<String> {
        #[cfg(test)]
        self.content_reads.fetch_add(1, Ordering::Relaxed);
        match self.cipher.open(&stored) {
            Ok(content) => Some(content),
            Err(error) => {
                let total = self.index_unreadable.fetch_add(1, Ordering::Relaxed) + 1;
                tracing::warn!(
                    unreadable = total,
                    "search index: skipped a message whose sealed body did not open: {error}"
                );
                None
            }
        }
    }

    /// Wire the semantic message index (backing the `search_conversations` builtin
    /// tool) into the store. Cheap to clone (`Arc` inside). Must be called after
    /// construction to enable indexing-on-append + searchable history.
    pub fn with_message_index(mut self, index: ryu_search::MessageIndex) -> Self {
        self.message_index = Some(index);
        self.semantic_backfill = Arc::new(Mutex::new(false));
        self
    }

    /// Swap the semantic message provider before a coordinated re-embed pass.
    /// Message vectors contain metadata only; the encrypted message body remains
    /// in this store and is decrypted only for the embedding request.
    pub async fn set_message_embedder(
        &self,
        embedder: std::sync::Arc<dyn ryu_search::SearchEmbedder>,
    ) -> anyhow::Result<()> {
        let mut initialized = self.semantic_backfill.lock().await;
        if let Some(index) = self.message_index.clone() {
            index.set_embedder(embedder).await?;
        }
        // A dimension change clears the vector table, requiring a new backfill.
        // Same-width stale vectors are handled by the coordinated re-embed pass.
        *initialized = false;
        Ok(())
    }

    /// Re-embed stale message vectors using the current semantic provider.
    /// The conversation DB mutex is released before each provider call, and
    /// indexing remains best-effort per message so one malformed/deleted row
    /// cannot strand the rest of the pass.
    pub async fn reindex_message_embeddings(&self) -> anyhow::Result<usize> {
        let _backfill = self.semantic_backfill.lock().await;
        if !self.chat_memory_enabled() {
            return Ok(0);
        }
        let Some(index) = self.message_index.clone() else {
            return Ok(0);
        };
        let embedder = index.embedder();
        let stale = index
            .stale_ids(embedder.model_id(), embedder.dims())
            .await?;
        let indexed = index.indexed_ids().await?;
        if stale.is_empty() && indexed.len() == 0 {
            return Ok(0);
        }
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn
                .prepare("SELECT id, conversation_id, role, content, created_at FROM messages")?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })?;
            let mut pending = Vec::new();
            for row in rows {
                let (id, conversation_id, role, sealed, created_at) = row?;
                if stale.contains(&id) || !indexed.contains(&id) {
                    let Some(content) = self.open_content_for_index(sealed) else {
                        continue;
                    };
                    if !content.trim().is_empty() {
                        pending.push((id, conversation_id, role, content, created_at));
                    }
                }
            }
            pending
        };
        let model = embedder.model_id().to_owned();
        let mut updated = 0;
        for (id, conversation_id, role, content, created_at) in rows {
            let vector = embedder.embed(&content).await?;
            index
                .index_message(&id, &conversation_id, &role, &vector, &model, created_at)
                .await?;
            updated += 1;
        }
        Ok(updated)
    }

    /// Wire the full-text (FTS5) message index (backing the FTS session-search
    /// recall layer) into the store. Cheap to clone (`Arc` inside). Mirrors
    /// [`with_message_index`]. Population is lazy-on-search and default-OFF, so
    /// wiring the index alone materializes nothing until a search runs under the
    /// enabled FTS recall pref.
    pub fn with_message_fts_index(mut self, index: ryu_search::MessageFtsIndex) -> Self {
        self.message_fts = Some(index);
        self.fts_backfill = Arc::new(Mutex::new(false));
        self
    }

    /// Wire the room-keyed realtime registry so [`append_message`] publishes a
    /// live `Events` frame (keyed by conversation id) for every persisted turn.
    /// Pass a clone of the same [`ryu_realtime::RoomRegistry`] held by
    /// `ServerState` so the frames reach the WS handler's subscribers. Must be
    /// called after construction.
    pub fn with_realtime(mut self, realtime: ryu_realtime::RoomRegistry) -> Self {
        self.realtime = Some(realtime);
        self
    }
}
