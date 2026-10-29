//! SQLite-backed persistence for the kernel notification-delivery store.
//!
//! Four tables live in `~/.ryu/notify.db` — the shared notification-delivery
//! state that USED to live inside the monitors crate but is **kernel** (an
//! adjudicated not-a-capability), so it stays compiled into Core and keeps
//! serving `notifications_api`, `policy_alerts`, `workflow`, and `approvals`
//! even after the monitor ENGINE moves out-of-process:
//!
//!   - `notifications` — the app-inbox feed: user-scoped pings a workflow (or any
//!     Core subsystem) pushes to a specific member. `ack_required` marks a HITL
//!     notification whose ack resumes a suspended workflow run.
//!   - `policy_alert_dedupe` — one row per gateway `dedupe_key`, with the last
//!     time it fired; a short cooldown debounces the same stamp re-read on every
//!     tool-loop iteration so a single turn delivers a policy alert once.
//!   - `alert_delivery` — a single JSON row holding the node-level fan-out
//!     channels + email recipients that policy alerts deliver to.
//!   - `push_tokens` — Expo push tokens registered by mobile devices, so a
//!     triggered alert / user notification can fan out to them.
//!
//! Credentials are sealed at rest with the master key (`enc:v1:`): the whole
//! `alert_delivery` JSON (Telegram bot tokens, Slack/Discord incoming-webhook
//! URLs, Expo tokens, email recipients), and every `push_tokens.token`. A push
//! token is looked up by `token_hash` (SHA-256 of the high-entropy token), so the
//! sealed value can use a fresh nonce. Reads accept legacy plaintext; opening the
//! store seals what is still plaintext once, under `secure_delete`, and records
//! the scrub debt (`vacuum_pending`, store [`NOTIFY_STORE`]) in the same
//! transaction. The freed pages are then scrubbed and the file vacuumed by the
//! shared gated flow (`finish_store`, a size-gated `VACUUM` on the boot path and
//! a deferred compaction for a large file). A scrub that fails is logged and
//! stays owed; it never stops the store from opening. Writes fail closed when
//! the master key is unavailable.
//!
//! Placement (Core vs Gateway): this stores *what was delivered to whom* — it
//! opens delivery sockets, it does not decide policy — so it is Core kernel.

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::{looks_sealed, FieldCipher, SecretSealer};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

use ryu_notify::AlertDeliveryTargets;

/// The name `notify.db`'s seal and scrub record is kept under in
/// `ryu_content_seal`.
pub(crate) const NOTIFY_STORE: &str = "notify.db";

/// How long a statement waits for another connection. The driver default,
/// stated here so the scrub's checkpoint wait is explicit; short under test so
/// a blocked checkpoint is observable without a long wait.
const BUSY_TIMEOUT: std::time::Duration = if cfg!(test) {
    std::time::Duration::from_millis(50)
} else {
    std::time::Duration::from_secs(5)
};

fn default_db_path() -> PathBuf {
    crate::paths::db_path("notify.db")
}

/// SQLite-backed notification-delivery store. Cheap to clone (wraps an `Arc`).
#[derive(Clone)]
pub struct NotifyStore {
    conn: Arc<Mutex<Connection>>,
    /// The master-key cipher, or `None` when the key could not be resolved at
    /// open. The inbox keeps working without it; storing a credential fails
    /// closed and a sealed credential cannot be read.
    cipher: Option<FieldCipher>,
}

/// The lookup key of a push token: SHA-256 of the token. Expo tokens are
/// high-entropy bearer identifiers, so the digest does not reveal them.
fn push_token_hash(token: &str) -> String {
    ryu_crypto::sha256_hex(token.as_bytes())
}

impl NotifyStore {
    /// Open (or create) the store at the default path (`<data dir>/db/notify.db`).
    pub fn open_default() -> Result<Self> {
        Self::open(default_db_path())
    }

    /// Open (or create) the store at a specific path and run migrations.
    pub fn open(path: PathBuf) -> Result<Self> {
        // Idempotent; lets tests and embedders open the store without Core's boot.
        crate::crypto_host::install();
        let cipher = match ryu_crypto::global_cipher() {
            Ok(cipher) => Some(cipher),
            Err(error) => {
                tracing::warn!(
                    "notify store: master key unavailable ({error:#}); alert delivery targets and push tokens cannot be stored"
                );
                None
            }
        };
        Self::open_with_cipher(path, cipher)
    }

    fn open_with_cipher(path: PathBuf, cipher: Option<FieldCipher>) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening notify db {}", path.display()))?;
        conn.busy_timeout(BUSY_TIMEOUT)
            .context("setting the notify db busy timeout")?;
        // Every rewritten or deleted cell is zeroed, so a resealed credential
        // does not stay readable in the page it replaced.
        ryu_crypto::content_sqlite::enable_secure_delete(&conn)?;
        Self::init_schema(&conn)?;
        let resealed = match &cipher {
            Some(cipher) => Self::reseal_plaintext_credentials(&conn, cipher)?,
            None => 0,
        };
        Self::scrub_after_reseal(&conn, &path, resealed);
        let compaction_owed =
            ryu_crypto::content_sqlite::compaction_owed(&conn, NOTIFY_STORE).unwrap_or(false);
        let conn = Arc::new(Mutex::new(conn));
        if compaction_owed {
            // Too large to compact while Core boots: the background worker
            // runs it later under this store's connection lock.
            ryu_crypto::content_sqlite::defer_compaction_with(
                NOTIFY_STORE,
                &path,
                &conn,
                |owner, run| run(&*owner.blocking_lock()),
            );
        }
        Ok(Self { conn, cipher })
    }

    /// Scrub the pages a reseal freed, or the debt an earlier start left. A
    /// failure (low disk for the `VACUUM`, a reader blocking the checkpoint) is
    /// logged and the debt stays recorded for the next start: the credentials
    /// are already sealed, so the store must still open.
    fn scrub_after_reseal(conn: &Connection, path: &std::path::Path, resealed: usize) {
        if resealed > 0 {
            if let Err(error) = ryu_crypto::content_sqlite::finish_store(conn, path, NOTIFY_STORE) {
                tracing::warn!(%error, "notify store: credential page scrub deferred");
            }
        } else if ryu_crypto::content_sqlite::compaction_owed(conn, NOTIFY_STORE).unwrap_or(false) {
            // Core's boot path: a file over `VACUUM_NOW_MAX_BYTES` only gets its
            // freelist scrub here; its `VACUUM` is deferred by the caller.
            if let Err(error) =
                ryu_crypto::content_sqlite::run_pending_vacuum_gated(conn, path, NOTIFY_STORE)
            {
                tracing::warn!(%error, "notify store: credential page scrub deferred");
            }
        }
    }

    fn cipher(&self) -> Result<&FieldCipher> {
        self.cipher
            .as_ref()
            .ok_or_else(|| anyhow!("refusing to store a notification credential unsealed: the at-rest master key is unavailable"))
    }

    /// Open a stored credential: legacy plaintext passes through; a sealed value
    /// needs the key and must open.
    fn open_value(&self, stored: &str) -> Result<String> {
        if !looks_sealed(stored) {
            return Ok(stored.to_owned());
        }
        let cipher = self
            .cipher
            .as_ref()
            .ok_or_else(|| anyhow!("the at-rest master key is unavailable"))?;
        SecretSealer::open(cipher, stored)
    }

    /// Open every token of a push-token query; a token that cannot be opened is
    /// skipped (logged), never returned as an empty or placeholder token.
    fn open_tokens(&self, stored: Vec<String>) -> Vec<String> {
        stored
            .into_iter()
            .filter_map(|value| match self.open_value(&value) {
                Ok(token) => Some(token),
                Err(error) => {
                    tracing::warn!(
                        "notify store: skipping a push token that cannot be opened: {error:#}"
                    );
                    None
                }
            })
            .collect()
    }

    /// Record that `notify.db` owes a freelist scrub and vacuum, before any
    /// cell is rewritten: the state row commits with the rewrite, so a crash
    /// after the commit still leaves the debt for the next start. Keeps an
    /// existing `vacuum_pending` row as it is.
    fn mark_scrub_owed(conn: &Connection) -> Result<()> {
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
            params![NOTIFY_STORE, STORE_ITEM, states::VACUUM_PENDING],
        )
        .context("recording the notify credential scrub")?;
        Ok(())
    }

    /// Seal, once, the alert-delivery JSON and every push token still stored as
    /// legacy plaintext, in one transaction that first records the scrub debt.
    /// Returns how many values it rewrote; the caller scrubs the freed pages.
    fn reseal_plaintext_credentials(conn: &Connection, cipher: &FieldCipher) -> Result<usize> {
        let delivery: Option<String> = conn
            .query_row("SELECT json FROM alert_delivery WHERE id = 1", [], |row| {
                row.get(0)
            })
            .optional()
            .context("reading alert delivery targets for reseal")?;
        let sealed_delivery = match delivery
            .as_deref()
            .map(|json| cipher.reseal_if_plaintext(json))
            .transpose()
        {
            Ok(Some(Some(sealed))) => Some(sealed),
            Ok(_) => None,
            // Leave the row as it is; reads report the error instead of
            // pretending there are no targets.
            Err(error) => {
                tracing::warn!("notify store: alert delivery targets not resealed: {error:#}");
                None
            }
        };
        let legacy_tokens = {
            let mut stmt = conn
                .prepare("SELECT token FROM push_tokens WHERE token_hash IS NULL")
                .context("listing push tokens for reseal")?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .context("listing push tokens for reseal")?
                .collect::<rusqlite::Result<Vec<_>>>()
                .context("listing push tokens for reseal")?;
            rows
        };
        let mut sealed_tokens = Vec::new();
        for stored in legacy_tokens {
            let token = match SecretSealer::open(cipher, &stored) {
                Ok(token) => token,
                Err(error) => {
                    tracing::warn!("notify store: push token not resealed: {error:#}");
                    continue;
                }
            };
            let sealed = if cipher.is_sealed(&stored) {
                stored.clone()
            } else {
                cipher.seal(&token).context("sealing a push token")?
            };
            sealed_tokens.push((sealed, push_token_hash(&token), stored));
        }
        let resealed = usize::from(sealed_delivery.is_some()) + sealed_tokens.len();
        if resealed == 0 {
            return Ok(0);
        }
        let tx =
            rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
                .context("starting the notify credential reseal")?;
        Self::mark_scrub_owed(&tx)?;
        if let Some(sealed) = sealed_delivery {
            tx.execute(
                "UPDATE alert_delivery SET json = ?1 WHERE id = 1",
                params![sealed],
            )
            .context("resealing alert delivery targets")?;
        }
        for (sealed, hash, stored) in sealed_tokens {
            tx.execute(
                "UPDATE push_tokens SET token = ?1, token_hash = ?2 WHERE token = ?3",
                params![sealed, hash, stored],
            )
            .context("resealing a push token")?;
        }
        tx.commit()
            .context("committing the notify credential reseal")?;
        tracing::info!(
            count = resealed,
            "notify store: sealed legacy plaintext credentials"
        );
        Ok(resealed)
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS push_tokens (
                 token       TEXT PRIMARY KEY,
                 platform    TEXT,
                 user_id     TEXT,
                 created_at  TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_push_tokens_user
                 ON push_tokens(user_id);
             CREATE TABLE IF NOT EXISTS notifications (
                 id              TEXT PRIMARY KEY,
                 user_id         TEXT,
                 title           TEXT NOT NULL,
                 body            TEXT,
                 level           TEXT NOT NULL DEFAULT 'info',
                 workflow_run_id TEXT,
                 node_id         TEXT,
                 ack_required    INTEGER NOT NULL DEFAULT 0,
                 acked           INTEGER NOT NULL DEFAULT 0,
                 read_at         TEXT,
                 created_at      TEXT NOT NULL,
                 source_app_id   TEXT,
                 archived_at     TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_notifications_user
                 ON notifications(user_id, created_at DESC);
             CREATE TABLE IF NOT EXISTS policy_alert_dedupe (
                 dedupe_key TEXT PRIMARY KEY,
                 fired_at   TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS alert_delivery (
                 id   INTEGER PRIMARY KEY CHECK (id = 1),
                 json TEXT NOT NULL
             );",
        )
        .context("initializing notify schema")?;
        // Idempotent additive migration for DBs created before the app-inbox feed
        // recorded who sent a row (`source_app_id`) or whether the user archived it
        // (`archived_at`). `CREATE TABLE IF NOT EXISTS` above already shapes a fresh
        // DB; an existing one gains the two columns here, one ALTER per missing one.
        for (column, decl) in [
            (
                "source_app_id",
                "ALTER TABLE notifications ADD COLUMN source_app_id TEXT",
            ),
            (
                "archived_at",
                "ALTER TABLE notifications ADD COLUMN archived_at TEXT",
            ),
        ] {
            let has: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('notifications') WHERE name = ?1",
                    params![column],
                    |r| r.get(0),
                )
                .context("reading notifications columns")?;
            if has == 0 {
                conn.execute(decl, [])
                    .with_context(|| format!("adding notifications.{column}"))?;
            }
        }
        // A device opts in to "agent finished" pushes when it registers (the
        // mobile Finished alerts setting). Older rows and older app builds stay
        // opted out, so they keep relying on their own local alert.
        let has_run_finished: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('push_tokens') WHERE name = 'run_finished'",
                [],
                |r| r.get(0),
            )
            .context("reading push_tokens columns")?;
        if has_run_finished == 0 {
            conn.execute(
                "ALTER TABLE push_tokens ADD COLUMN run_finished INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .context("adding push_tokens.run_finished")?;
        }
        // Push tokens are sealed with a fresh nonce, so lookups go through a
        // deterministic digest column. Legacy rows get theirs when the store
        // reseals them on open.
        let has_token_hash: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('push_tokens') WHERE name = 'token_hash'",
                [],
                |r| r.get(0),
            )
            .context("reading push_tokens columns")?;
        if has_token_hash == 0 {
            conn.execute("ALTER TABLE push_tokens ADD COLUMN token_hash TEXT", [])
                .context("adding push_tokens.token_hash")?;
        }
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_push_tokens_hash ON push_tokens(token_hash)",
            [],
        )
        .context("indexing push_tokens.token_hash")?;
        Ok(())
    }

    // ---- policy alerts (dedupe + delivery targets) ------------------------

    /// Atomically claim a policy-alert `dedupe_key` for delivery. Returns `true`
    /// when the caller may deliver (first fire, or the previous fire is older than
    /// `cooldown_secs`), `false` when it is still within the cooldown window. The
    /// SELECT + UPSERT run under one connection lock so concurrent claims of the
    /// same key (one per tool-loop iteration) cannot both win.
    pub async fn claim_policy_alert(&self, dedupe_key: &str, cooldown_secs: i64) -> Result<bool> {
        let now = chrono::Utc::now();
        let conn = self.conn.lock().await;
        let prev: Option<String> = conn
            .query_row(
                "SELECT fired_at FROM policy_alert_dedupe WHERE dedupe_key = ?1",
                params![dedupe_key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("reading policy alert dedupe")?;
        if let Some(fired_at) = prev {
            if let Ok(prev_ts) = chrono::DateTime::parse_from_rfc3339(&fired_at) {
                if now.signed_duration_since(prev_ts.with_timezone(&chrono::Utc))
                    < chrono::Duration::seconds(cooldown_secs)
                {
                    return Ok(false);
                }
            }
        }
        conn.execute(
            "INSERT INTO policy_alert_dedupe (dedupe_key, fired_at) VALUES (?1, ?2)
             ON CONFLICT(dedupe_key) DO UPDATE SET fired_at = ?2",
            params![dedupe_key, now.to_rfc3339()],
        )
        .context("claiming policy alert dedupe")?;
        Ok(true)
    }

    /// Read the node-level alert delivery targets (empty default when unset).
    /// A sealed row that cannot be opened, or JSON that does not parse, is an
    /// error: answering "no targets" would let the next save silently drop them.
    pub async fn get_alert_delivery(&self) -> Result<AlertDeliveryTargets> {
        let conn = self.conn.lock().await;
        let json: Option<String> = conn
            .query_row("SELECT json FROM alert_delivery WHERE id = 1", [], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .context("reading alert delivery targets")?;
        drop(conn);
        match json {
            Some(stored) => {
                let json = self
                    .open_value(&stored)
                    .context("opening the sealed alert delivery targets")?;
                serde_json::from_str(&json).context("parsing alert delivery targets")
            }
            None => Ok(AlertDeliveryTargets::default()),
        }
    }

    /// Persist the node-level alert delivery targets (single-row upsert), sealed
    /// with the master key. Fails closed without the key.
    pub async fn set_alert_delivery(&self, cfg: &AlertDeliveryTargets) -> Result<()> {
        let json = serde_json::to_string(cfg).context("serializing alert delivery targets")?;
        let json = self
            .cipher()?
            .seal(&json)
            .context("sealing alert delivery targets")?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO alert_delivery (id, json) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET json = ?1",
            params![json],
        )
        .context("writing alert delivery targets")?;
        Ok(())
    }

    // ---- push tokens ------------------------------------------------------

    /// Register (or refresh) an Expo push token for mobile notifications.
    ///
    /// `user_id` scopes the token to the member who registered it so a workflow
    /// can push to a specific person's devices. It is optional: an anonymous /
    /// single-user node registers `None` and the token still receives the
    /// broadcast fan-out (monitor alerts).
    pub async fn register_push_token(
        &self,
        token: &str,
        platform: Option<&str>,
        user_id: Option<&str>,
    ) -> Result<bool> {
        let now = chrono::Utc::now().to_rfc3339();
        let sealed = self.cipher()?.seal(token).context("sealing push token")?;
        let conn = self.conn.lock().await;
        let changed = conn
            .execute(
                "INSERT INTO push_tokens (token, token_hash, platform, user_id, created_at)
             VALUES (?1, ?5, ?2, ?3, ?4)
             ON CONFLICT(token_hash) DO UPDATE SET platform = ?2, created_at = ?4
             WHERE push_tokens.user_id IS ?3",
                params![sealed, platform, user_id, now, push_token_hash(token)],
            )
            .context("registering push token")?;
        Ok(changed > 0)
    }

    /// Record whether a device wants "agent finished" pushes. Scoped to the
    /// token's owner (`None` for an anonymous single-user node) so one member
    /// cannot change another member's device. Returns whether a row changed.
    pub async fn set_push_token_run_finished(
        &self,
        token: &str,
        user_id: Option<&str>,
        enabled: bool,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "UPDATE push_tokens SET run_finished = ?1
             WHERE (token_hash = ?4 OR (token_hash IS NULL AND token = ?2)) AND user_id IS ?3",
            params![enabled, token, user_id, push_token_hash(token)],
        )?;
        Ok(n > 0)
    }

    /// Tokens of the devices that opted in to "agent finished" pushes for a
    /// conversation owner. `None` is the owner of an anonymous single-user node,
    /// whose devices register without a member id.
    pub async fn run_finished_push_tokens(&self, owner: Option<&str>) -> Result<Vec<String>> {
        let conn = self.conn.lock().await;
        let mut stmt =
            conn.prepare("SELECT token FROM push_tokens WHERE run_finished = 1 AND user_id IS ?1")?;
        let rows = stmt.query_map(params![owner], |row| row.get::<_, String>(0))?;
        let stored = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        drop(conn);
        Ok(self.open_tokens(stored))
    }

    /// Remove a push token (device opted out / token rotated).
    pub async fn remove_push_token(&self, token: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "DELETE FROM push_tokens WHERE token_hash = ?2 OR (token_hash IS NULL AND token = ?1)",
            params![token, push_token_hash(token)],
        )?;
        Ok(n > 0)
    }

    /// Remove a push token only when it belongs to `user_id`.
    ///
    /// The token is the public path identifier, so callers handling an
    /// authenticated member request must use this owner-scoped variant rather
    /// than the node-level removal above.
    pub async fn remove_push_token_for_user(&self, token: &str, user_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "DELETE FROM push_tokens
             WHERE (token_hash = ?3 OR (token_hash IS NULL AND token = ?1)) AND user_id = ?2",
            params![token, user_id, push_token_hash(token)],
        )?;
        Ok(n > 0)
    }

    /// All registered Expo push tokens.
    pub async fn push_tokens(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT token FROM push_tokens")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let stored = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        drop(conn);
        Ok(self.open_tokens(stored))
    }

    /// Every registered Expo push token with the member who registered it
    /// (`None` for an anonymous single-user registration). For a fan-out whose
    /// content depends on what each owner may see.
    pub async fn push_tokens_with_owners(&self) -> Result<Vec<(String, Option<String>)>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT token, user_id FROM push_tokens")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;
        let stored = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        drop(conn);
        // Tokens are sealed at rest; one that cannot be opened is skipped, as
        // `push_tokens` does, never returned as ciphertext.
        Ok(stored
            .into_iter()
            .filter_map(|(value, owner)| match self.open_value(&value) {
                Ok(token) => Some((token, owner)),
                Err(error) => {
                    tracing::warn!(
                        "notify store: skipping a push token that cannot be opened: {error:#}"
                    );
                    None
                }
            })
            .collect())
    }

    /// Expo push tokens registered by a specific member. Used to push a
    /// user-targeted notification to just that person's devices rather than the
    /// whole-node broadcast.
    pub async fn push_tokens_for_user(&self, user_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT token FROM push_tokens WHERE user_id = ?1")?;
        let rows = stmt.query_map(params![user_id], |row| row.get::<_, String>(0))?;
        let stored = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        drop(conn);
        Ok(self.open_tokens(stored))
    }

    // ---- notifications (app inbox) ----------------------------------------

    /// Insert a user-scoped notification into the app-inbox feed.
    pub async fn insert_notification(&self, n: &NotificationRow) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO notifications
                 (id, user_id, title, body, level, workflow_run_id, node_id, ack_required, acked, read_at, created_at, source_app_id, archived_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                n.id,
                n.user_id,
                n.title,
                n.body,
                n.level,
                n.workflow_run_id,
                n.node_id,
                n.ack_required as i64,
                n.acked as i64,
                n.read_at,
                n.created_at,
                n.source_app_id,
                n.archived_at,
            ],
        )
        .context("inserting notification")?;
        Ok(())
    }

    /// The most recent notifications for a member, newest first.
    ///
    /// `archived` filters by the archive state: `None` = every row, `Some(true)` =
    /// only archived rows, `Some(false)` (the API default) = only un-archived rows.
    pub async fn list_notifications_for_user(
        &self,
        user_id: &str,
        limit: i64,
        archived: Option<bool>,
    ) -> Result<Vec<NotificationRow>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, user_id, title, body, level, workflow_run_id, node_id,
                    ack_required, acked, read_at, created_at, source_app_id, archived_at
             FROM notifications
             WHERE user_id = ?1
               AND (?2 = 0 OR archived_at IS NOT NULL)
               AND (?3 = 0 OR archived_at IS NULL)
             ORDER BY created_at DESC
             LIMIT ?4",
        )?;
        let rows = stmt.query_map(
            params![
                user_id,
                (archived == Some(true)) as i64,
                (archived == Some(false)) as i64,
                limit,
            ],
            NotificationRow::from_row,
        )?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Fetch a single notification by id.
    pub async fn get_notification(&self, id: &str) -> Result<Option<NotificationRow>> {
        let conn = self.conn.lock().await;
        let row = conn
            .query_row(
                "SELECT id, user_id, title, body, level, workflow_run_id, node_id,
                        ack_required, acked, read_at, created_at, source_app_id, archived_at
                 FROM notifications WHERE id = ?1",
                params![id],
                NotificationRow::from_row,
            )
            .optional()
            .context("reading notification")?;
        Ok(row)
    }

    /// Mark a notification read (stamps `read_at`). Returns true when a row changed.
    pub async fn mark_notification_read(&self, id: &str) -> Result<bool> {
        let now = chrono::Utc::now().to_rfc3339();
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "UPDATE notifications SET read_at = ?2 WHERE id = ?1 AND read_at IS NULL",
            params![id, now],
        )?;
        Ok(n > 0)
    }

    /// Mark a notification acknowledged. Returns true when a row changed.
    pub async fn mark_notification_acked(&self, id: &str) -> Result<bool> {
        let now = chrono::Utc::now().to_rfc3339();
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "UPDATE notifications SET acked = 1, read_at = COALESCE(read_at, ?2) WHERE id = ?1",
            params![id, now],
        )?;
        Ok(n > 0)
    }

    /// Archive a notification (stamps `archived_at`, also marking it read). Returns
    /// true when a row changed. Idempotent: re-archiving an archived row is a no-op.
    pub async fn mark_notification_archived(&self, id: &str) -> Result<bool> {
        let now = chrono::Utc::now().to_rfc3339();
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "UPDATE notifications
                SET archived_at = ?2, read_at = COALESCE(read_at, ?2)
              WHERE id = ?1 AND archived_at IS NULL",
            params![id, now],
        )?;
        Ok(n > 0)
    }

    /// Un-archive a notification (clears `archived_at`). Returns true when a row
    /// changed. Idempotent: un-archiving an already-live row is a no-op.
    pub async fn mark_notification_unarchived(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "UPDATE notifications SET archived_at = NULL
              WHERE id = ?1 AND archived_at IS NOT NULL",
            params![id],
        )?;
        Ok(n > 0)
    }
}

/// One row of the app-inbox notification feed.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NotificationRow {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub level: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    pub ack_required: bool,
    pub acked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_at: Option<String>,
    pub created_at: String,
    /// The plugin/app id that raised this notification (an out-of-process app via
    /// the `notify.deliver` kernel capability, or a Core-internal producer that
    /// named itself). `None` for legacy Core producers that did not identify
    /// themselves. The desktop resolves the app's icon/name from this.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_app_id: Option<String>,
    /// When the user archived this row. `None` = live in the inbox.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

impl NotificationRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            user_id: row.get(1)?,
            title: row.get(2)?,
            body: row.get(3)?,
            level: row.get(4)?,
            workflow_run_id: row.get(5)?,
            node_id: row.get(6)?,
            ack_required: row.get::<_, i64>(7)? != 0,
            acked: row.get::<_, i64>(8)? != 0,
            read_at: row.get(9)?,
            created_at: row.get(10)?,
            source_app_id: row.get(11)?,
            archived_at: row.get(12)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ryu_notify::NotifyTarget;

    /// A NotifyStore in a fresh, unique temp directory.
    fn temp_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ryu-notify-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn temp_store() -> NotifyStore {
        NotifyStore::open(temp_dir().join("notify.db")).expect("open temp store")
    }

    #[tokio::test]
    async fn policy_alert_claim_debounces_within_cooldown() {
        let store = temp_store();
        assert!(store.claim_policy_alert("k1", 300).await.unwrap());
        assert!(!store.claim_policy_alert("k1", 300).await.unwrap());
        assert!(store.claim_policy_alert("k2", 300).await.unwrap());
        assert!(store.claim_policy_alert("k1", 0).await.unwrap());
    }

    #[tokio::test]
    async fn run_finished_pushes_are_opt_in_per_owned_device() {
        let store = temp_store();
        store
            .register_push_token("tok-alice", Some("ios"), Some("alice"))
            .await
            .unwrap();
        store
            .register_push_token("tok-solo", Some("android"), None)
            .await
            .unwrap();
        // Registered devices start opted out.
        assert!(store
            .run_finished_push_tokens(Some("alice"))
            .await
            .unwrap()
            .is_empty());
        // Another member cannot opt alice's device in.
        assert!(!store
            .set_push_token_run_finished("tok-alice", Some("bob"), true)
            .await
            .unwrap());
        assert!(store
            .set_push_token_run_finished("tok-alice", Some("alice"), true)
            .await
            .unwrap());
        assert!(store
            .set_push_token_run_finished("tok-solo", None, true)
            .await
            .unwrap());
        assert_eq!(
            store.run_finished_push_tokens(Some("alice")).await.unwrap(),
            vec!["tok-alice"]
        );
        assert_eq!(
            store.run_finished_push_tokens(None).await.unwrap(),
            vec!["tok-solo"]
        );
        assert!(store
            .set_push_token_run_finished("tok-alice", Some("alice"), false)
            .await
            .unwrap());
        assert!(store
            .run_finished_push_tokens(Some("alice"))
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn owner_scoped_push_token_removal_cannot_cross_members() {
        let store = temp_store();
        store
            .register_push_token("tok-owner", Some("ios"), Some("alice"))
            .await
            .unwrap();

        assert!(!store
            .remove_push_token_for_user("tok-owner", "bob")
            .await
            .unwrap());
        assert_eq!(store.push_tokens().await.unwrap(), vec!["tok-owner"]);
        assert!(store
            .remove_push_token_for_user("tok-owner", "alice")
            .await
            .unwrap());
        assert!(store.push_tokens().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn push_token_registration_cannot_transfer_another_members_device() {
        let store = temp_store();
        assert!(store
            .register_push_token("tok-owner", Some("ios"), Some("alice"))
            .await
            .unwrap());
        assert!(!store
            .register_push_token("tok-owner", Some("android"), Some("bob"))
            .await
            .unwrap());
        assert!(store
            .remove_push_token_for_user("tok-owner", "alice")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn alert_delivery_roundtrips() {
        let store = temp_store();
        let empty = store.get_alert_delivery().await.unwrap();
        assert!(empty.emails.is_empty() && empty.targets.is_empty());
        let cfg = AlertDeliveryTargets {
            targets: vec![NotifyTarget::Webhook {
                url: "https://example.test/hook".to_string(),
            }],
            emails: vec!["ops@example.test".to_string()],
        };
        store.set_alert_delivery(&cfg).await.unwrap();
        let read = store.get_alert_delivery().await.unwrap();
        assert_eq!(read.emails, vec!["ops@example.test".to_string()]);
        assert_eq!(read.targets.len(), 1);
    }

    fn file_bytes(path: &std::path::Path) -> String {
        let mut text = String::new();
        for suffix in ["", "-wal", "-journal"] {
            let candidate = PathBuf::from(format!("{}{suffix}", path.display()));
            if let Ok(bytes) = std::fs::read(candidate) {
                text.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
        text
    }

    fn test_cipher() -> FieldCipher {
        FieldCipher::new(&[0x33; 32])
    }

    #[tokio::test]
    async fn alert_delivery_is_sealed_on_disk_and_round_trips() {
        let path = temp_dir().join("notify.db");
        let store = NotifyStore::open_with_cipher(path.clone(), Some(test_cipher())).unwrap();
        let cfg = AlertDeliveryTargets {
            targets: vec![
                NotifyTarget::Telegram {
                    bot_token: "123456:sealed-bot-token".into(),
                    chat_id: "42".into(),
                },
                NotifyTarget::Webhook {
                    url: "https://hooks.slack.test/services/T/B/sealed-hook".into(),
                },
            ],
            emails: vec![],
        };
        store.set_alert_delivery(&cfg).await.unwrap();
        let read = store.get_alert_delivery().await.unwrap();
        assert_eq!(read.targets, cfg.targets);
        let stored: String = store
            .conn
            .lock()
            .await
            .query_row("SELECT json FROM alert_delivery WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(FieldCipher::is_sealed(&stored));
        drop(store);
        let bytes = file_bytes(&path);
        assert!(!bytes.contains("sealed-bot-token"));
        assert!(!bytes.contains("sealed-hook"));
    }

    #[tokio::test]
    async fn credential_writes_fail_closed_without_a_key() {
        let store = NotifyStore::open_with_cipher(temp_dir().join("notify.db"), None).unwrap();
        assert!(store
            .set_alert_delivery(&AlertDeliveryTargets::default())
            .await
            .is_err());
        assert!(store
            .register_push_token("ExponentPushToken[x]", None, None)
            .await
            .is_err());
        // The inbox itself still works.
        assert!(store.claim_policy_alert("k", 60).await.unwrap());
    }

    #[tokio::test]
    async fn legacy_plaintext_is_read_then_resealed_on_open() {
        let path = temp_dir().join("notify.db");
        {
            // A store written by an older build: plaintext JSON and tokens.
            let legacy = NotifyStore::open_with_cipher(path.clone(), None).unwrap();
            let conn = legacy.conn.lock().await;
            conn.execute(
                "INSERT INTO alert_delivery (id, json) VALUES (1, ?1)",
                params![r#"{"targets":[{"kind":"telegram","bot_token":"999:legacy-bot-token","chat_id":"7"}],"emails":["ops@example.test"]}"#],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO push_tokens (token, platform, user_id, created_at, run_finished)
                 VALUES ('ExponentPushToken[legacy-device]', 'ios', 'alice', 'now', 1)",
                [],
            )
            .unwrap();
            drop(conn);
            // Legacy plaintext reads without a key.
            assert_eq!(
                legacy.get_alert_delivery().await.unwrap().emails,
                vec!["ops@example.test".to_string()]
            );
            assert_eq!(
                legacy.push_tokens().await.unwrap(),
                vec!["ExponentPushToken[legacy-device]"]
            );
        }
        let store = NotifyStore::open_with_cipher(path.clone(), Some(test_cipher())).unwrap();
        // Readers still see the same values.
        let cfg = store.get_alert_delivery().await.unwrap();
        assert!(matches!(
            &cfg.targets[0],
            NotifyTarget::Telegram { bot_token, .. } if bot_token == "999:legacy-bot-token"
        ));
        assert_eq!(
            store.run_finished_push_tokens(Some("alice")).await.unwrap(),
            vec!["ExponentPushToken[legacy-device]"]
        );
        // Lookups by the plaintext token still find the migrated row.
        assert!(store
            .set_push_token_run_finished("ExponentPushToken[legacy-device]", Some("alice"), false)
            .await
            .unwrap());
        drop(store);
        let bytes = file_bytes(&path);
        assert!(!bytes.contains("legacy-bot-token"));
        assert!(!bytes.contains("legacy-device"));
    }

    /// Write the plaintext rows an older build left, then close the store.
    async fn write_legacy_plaintext(path: &std::path::Path) {
        let legacy = NotifyStore::open_with_cipher(path.to_owned(), None).unwrap();
        let conn = legacy.conn.lock().await;
        conn.execute(
            "INSERT INTO alert_delivery (id, json) VALUES (1, ?1)",
            params![r#"{"targets":[{"kind":"telegram","bot_token":"999:debt-bot-token","chat_id":"7"}],"emails":[]}"#],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO push_tokens (token, platform, user_id, created_at, run_finished)
             VALUES ('ExponentPushToken[debt-device]', 'ios', 'alice', 'now', 1)",
            [],
        )
        .unwrap();
    }

    #[tokio::test]
    async fn a_reseal_that_scrubs_cleanly_leaves_no_debt() {
        let path = temp_dir().join("notify.db");
        write_legacy_plaintext(&path).await;
        let store = NotifyStore::open_with_cipher(path.clone(), Some(test_cipher())).unwrap();
        let conn = store.conn.lock().await;
        assert!(!ryu_crypto::content_sqlite::compaction_owed(&conn, NOTIFY_STORE).unwrap());
        let secure_delete: i64 = conn
            .query_row("PRAGMA secure_delete", [], |row| row.get(0))
            .unwrap();
        assert_eq!(secure_delete, 1);
    }

    #[tokio::test]
    async fn a_scrub_that_fails_still_opens_the_store_and_stays_owed() {
        let path = temp_dir().join("notify.db");
        write_legacy_plaintext(&path).await;
        // A reader holding an old snapshot blocks the WAL checkpoint the scrub
        // needs, so `finish_store` fails after the credentials are sealed.
        let reader = Connection::open(&path).unwrap();
        reader.execute_batch("BEGIN").unwrap();
        let _: i64 = reader
            .query_row("SELECT count(*) FROM push_tokens", [], |row| row.get(0))
            .unwrap();
        let store = NotifyStore::open_with_cipher(path.clone(), Some(test_cipher()))
            .expect("a failed scrub must not stop the store from opening");
        let conn = store.conn.lock().await;
        let stored: String = conn
            .query_row("SELECT json FROM alert_delivery WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(FieldCipher::is_sealed(&stored));
        let token: String = conn
            .query_row("SELECT token FROM push_tokens", [], |r| r.get(0))
            .unwrap();
        assert!(FieldCipher::is_sealed(&token));
        assert!(
            ryu_crypto::content_sqlite::compaction_owed(&conn, NOTIFY_STORE).unwrap(),
            "the scrub debt stays recorded for the next start"
        );
    }

    #[tokio::test]
    async fn push_tokens_are_sealed_and_found_by_digest() {
        let path = temp_dir().join("notify.db");
        let store = NotifyStore::open_with_cipher(path.clone(), Some(test_cipher())).unwrap();
        assert!(store
            .register_push_token("ExponentPushToken[sealed-device]", Some("ios"), Some("bob"))
            .await
            .unwrap());
        // Re-registering the same token updates the row instead of adding one.
        assert!(store
            .register_push_token(
                "ExponentPushToken[sealed-device]",
                Some("android"),
                Some("bob")
            )
            .await
            .unwrap());
        assert_eq!(
            store.push_tokens_for_user("bob").await.unwrap(),
            vec!["ExponentPushToken[sealed-device]"]
        );
        assert!(store
            .remove_push_token("ExponentPushToken[sealed-device]")
            .await
            .unwrap());
        assert!(store.push_tokens().await.unwrap().is_empty());
        store
            .register_push_token("ExponentPushToken[kept-device]", None, None)
            .await
            .unwrap();
        drop(store);
        assert!(!file_bytes(&path).contains("kept-device"));
    }

    #[tokio::test]
    async fn notification_roundtrips_and_acks() {
        let store = temp_store();
        let row = NotificationRow {
            id: "ntf_1".into(),
            user_id: Some("u1".into()),
            title: "hi".into(),
            body: None,
            level: "info".into(),
            workflow_run_id: None,
            node_id: None,
            ack_required: false,
            acked: false,
            read_at: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            source_app_id: Some("@ryu/monitors".into()),
            archived_at: None,
        };
        store.insert_notification(&row).await.unwrap();
        // Un-archived filter is the default view.
        let live = store
            .list_notifications_for_user("u1", 10, Some(false))
            .await
            .unwrap();
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].source_app_id.as_deref(), Some("@ryu/monitors"));
        // No filter sees everything.
        let all = store
            .list_notifications_for_user("u1", 10, None)
            .await
            .unwrap();
        assert_eq!(all.len(), 1);
        assert!(store.mark_notification_read("ntf_1").await.unwrap());
        assert!(store.mark_notification_acked("ntf_1").await.unwrap());
        // Archive hides the row from the live feed but keeps it readable.
        assert!(store.mark_notification_archived("ntf_1").await.unwrap());
        assert!(store
            .list_notifications_for_user("u1", 10, Some(false))
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .list_notifications_for_user("u1", 10, Some(true))
                .await
                .unwrap()
                .len(),
            1
        );
        // Re-archive is a no-op; un-archive restores it.
        assert!(!store.mark_notification_archived("ntf_1").await.unwrap());
        assert!(store.mark_notification_unarchived("ntf_1").await.unwrap());
        assert_eq!(
            store
                .list_notifications_for_user("u1", 10, Some(false))
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn push_tokens_with_owners_reports_each_registering_member() {
        let store = temp_store();
        store
            .register_push_token("tok-alice", Some("ios"), Some("alice"))
            .await
            .unwrap();
        store
            .register_push_token("tok-solo", Some("android"), None)
            .await
            .unwrap();
        let mut owners = store.push_tokens_with_owners().await.unwrap();
        owners.sort();
        assert_eq!(
            owners,
            vec![
                ("tok-alice".to_owned(), Some("alice".to_owned())),
                ("tok-solo".to_owned(), None),
            ]
        );
    }
}
