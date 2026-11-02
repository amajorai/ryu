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
//!     triggered alert / user notification can fan out to them, with the
//!     locale each device registered so pushes are rendered in its language.
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

mod inbox;
mod push_tokens;
mod schema;

pub use inbox::NotificationRow;
pub use push_tokens::PushTarget;

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
}

#[cfg(test)]
mod store_test;
