//! `ViolationEvent`, the only verdict record, and the local outbox the
//! control-plane reporter drains (managed guardrails spec 03.4, screener
//! addendum section 11.1).
//!
//! The outbox is its own SQLite file (`violations.db` beside `audit.db`), not
//! a table behind the audit writer: the audit queue drops rows when it is
//! full, and an audit backlog must never delay a strike signal. It keeps its
//! own delivery cursor for the same reason.
//!
//! Rules the outbox enforces whatever its caller passes:
//! - one row per `dedupeKey`, so a re-screen of the same body on a fallback
//!   attempt or a tool round never double counts (spec SC-4);
//! - no excerpt is ever stored for `hazard.S4`, and an S4 row purges every
//!   excerpt already stored for its request and refuses later ones;
//! - an excerpt is at most [`MAX_EXCERPT_BYTES`] of UTF-8, sealed at rest
//!   with a gateway-local key, dropped after [`EXCERPT_TTL_SECS`] even
//!   without acknowledgement, dropped (oldest first) past the size cap, and
//!   cleared once the control plane acknowledges its row.

use std::path::Path;
use std::sync::{Mutex, PoisonError};

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rusqlite::{params, Connection, OptionalExtension};

#[path = "violation_types.rs"]
mod types;
pub use types::{
    dedupe_key, ActorKind, DetectorKind, DetectorRef, EnforcementAction, EnforcementMode, FailMode,
    OutboxLimits, OutboxMaintenance, OutboxRow, PolicyLayer, PolicyRef, RecordOutcome, Severity,
    SpendOwner, ViolationDirection, ViolationEvent, ACKNOWLEDGED_RETENTION_SECS, CHILD_SAFETY_CODE,
    DEFAULT_MAX_EXCERPT_BYTES_TOTAL, DEFAULT_MAX_ROWS, EXCERPT_TTL_SECS, MAX_EXCERPT_BYTES,
    VIOLATION_REPORT_CURSOR,
};

/// The SQLite outbox. Writes are one small statement each and happen only
/// in verdict branches, so they run inline behind a mutex.
pub struct ViolationOutbox {
    conn: Mutex<Connection>,
    cipher: Aes256Gcm,
    limits: OutboxLimits,
}

impl std::fmt::Debug for ViolationOutbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ViolationOutbox").finish_non_exhaustive()
    }
}

// `synchronous=NORMAL` keeps `record()` (inline on the request path, behind
// the mutex) from fsyncing on every commit, which under the default FULL
// serialized every guardrail hit process-wide on a 0.5-5 ms fsync. In WAL
// mode NORMAL is still crash-safe for the process and never corrupts the
// database; only an OS crash or power loss can lose the last few commits,
// which is acceptable for an outbox the reporter re-drains. `synchronous` is
// per connection and not persisted, so this runs on every open: SCHEMA is
// applied by `from_connection`, which both `open` and `in_memory` call.
const SCHEMA: &str = "
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS violation_event (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id       TEXT    NOT NULL UNIQUE,
        dedupe_key     TEXT    NOT NULL UNIQUE,
        request_id     TEXT    NOT NULL,
        org_id         TEXT,
        category       TEXT    NOT NULL,
        recorded_at    INTEGER NOT NULL,
        event_json     TEXT    NOT NULL,
        excerpt_sealed BLOB,
        excerpt_bytes  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_violation_request ON violation_event(request_id);
    CREATE INDEX IF NOT EXISTS idx_violation_recorded ON violation_event(recorded_at);
    CREATE TABLE IF NOT EXISTS violation_report_cursors (
        name    TEXT PRIMARY KEY,
        last_id INTEGER NOT NULL
    );
";

fn lock(mutex: &Mutex<Connection>) -> std::sync::MutexGuard<'_, Connection> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `text` cut to at most `max` UTF-8 bytes on a character boundary.
pub fn truncate_bytes(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// The sealing key beside the outbox file, created on first open. A copy of
/// the outbox without this file holds no readable excerpt.
fn load_or_create_key(path: &Path) -> anyhow::Result<[u8; 32]> {
    if let Ok(bytes) = std::fs::read(path) {
        if let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice()) {
            return Ok(key);
        }
        anyhow::bail!("violation outbox key {} is not 32 bytes", path.display());
    }
    let key: [u8; 32] = Aes256Gcm::generate_key(OsRng).into();
    std::fs::write(path, key)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(key)
}

impl ViolationOutbox {
    /// Open (or create) the outbox at `path`, with its sealing key at
    /// `path` with the `key` extension.
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let key = load_or_create_key(&path.with_extension("key"))?;
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let outbox = Self::from_connection(conn, key)?;
        // Excerpts left from an earlier run expire on open too, not only
        // when a reporter or the maintenance task next runs.
        outbox.maintain()?;
        Ok(outbox)
    }

    /// An outbox that lives only as long as the process, for a gateway with
    /// auditing disabled (no data directory to sit in) and for tests.
    pub fn in_memory() -> anyhow::Result<Self> {
        let key: [u8; 32] = Aes256Gcm::generate_key(OsRng).into();
        Self::from_connection(Connection::open_in_memory()?, key)
    }

    fn from_connection(conn: Connection, key: [u8; 32]) -> anyhow::Result<Self> {
        conn.execute_batch(SCHEMA)?;
        conn.execute_batch(windows::WINDOW_SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
            cipher: Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key)),
            limits: OutboxLimits::default(),
        })
    }

    pub fn with_limits(mut self, limits: OutboxLimits) -> Self {
        self.limits = limits;
        self
    }

    fn seal(&self, text: &str) -> anyhow::Result<Vec<u8>> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let sealed = self
            .cipher
            .encrypt(&nonce, text.as_bytes())
            .map_err(|_| anyhow::anyhow!("excerpt sealing failed"))?;
        let mut out = nonce.to_vec();
        out.extend_from_slice(&sealed);
        Ok(out)
    }

    fn unseal(&self, sealed: &[u8]) -> Option<String> {
        if sealed.len() < 12 {
            return None;
        }
        let (nonce, body) = sealed.split_at(12);
        let plain = self.cipher.decrypt(Nonce::from_slice(nonce), body).ok()?;
        String::from_utf8(plain).ok()
    }

    /// Store one event, with its redacted excerpt when its category allows
    /// one. The event's `evidenceRef` is not stored: [`Self::pending`] sets it
    /// only while an excerpt is still held.
    pub fn record(
        &self,
        event: &ViolationEvent,
        excerpt: Option<&str>,
    ) -> anyhow::Result<RecordOutcome> {
        self.record_at(event, excerpt, now_secs())
    }

    fn record_at(
        &self,
        event: &ViolationEvent,
        excerpt: Option<&str>,
        recorded_at: i64,
    ) -> anyhow::Result<RecordOutcome> {
        let mut stored = event.clone();
        stored.evidence_ref = None;
        let json = serde_json::to_string(&stored)?;
        let conn = lock(&self.conn);
        let child_safety = event.excerpt_forbidden();
        let request_has_s4 = || -> rusqlite::Result<bool> {
            conn.query_row(
                "SELECT 1 FROM violation_event WHERE request_id = ?1 AND category = ?2 LIMIT 1",
                params![event.request_id, CHILD_SAFETY_CODE],
                |_| Ok(()),
            )
            .optional()
            .map(|row| row.is_some())
        };
        let sealed = match excerpt.map(str::trim).filter(|text| !text.is_empty()) {
            Some(text) if !child_safety && !request_has_s4()? => {
                Some(self.seal(truncate_bytes(text, MAX_EXCERPT_BYTES))?)
            }
            _ => None,
        };
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO violation_event
                 (event_id, dedupe_key, request_id, org_id, category, recorded_at,
                  event_json, excerpt_sealed, excerpt_bytes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                event.event_id,
                event.dedupe_key,
                event.request_id,
                event.org_id,
                event.category,
                recorded_at,
                json,
                sealed,
                sealed.as_ref().map_or(0, Vec::len) as i64,
            ],
        )? == 1;
        let outcome = if inserted {
            RecordOutcome::Inserted
        } else {
            self.upgrade(&conn, &stored, sealed.as_deref())?
        };
        if child_safety {
            // Any S4 verdict for a request erases every excerpt stored for
            // it, including ones from earlier detectors or attempts.
            conn.execute(
                "UPDATE violation_event SET excerpt_sealed = NULL, excerpt_bytes = 0
                 WHERE request_id = ?1",
                params![event.request_id],
            )?;
        }
        Ok(outcome)
    }

    /// A second event for a `dedupeKey` already in the outbox. While that row
    /// is unreported and held a weaker action (an admission flag, then an
    /// output block by the same backend), it takes the stronger event under
    /// its original `eventId`. A row the control plane already acknowledged
    /// is left as it is: the control plane keeps the first event per key.
    fn upgrade(
        &self,
        conn: &Connection,
        event: &ViolationEvent,
        sealed: Option<&[u8]>,
    ) -> anyhow::Result<RecordOutcome> {
        let cursor: i64 = conn
            .query_row(
                "SELECT last_id FROM violation_report_cursors WHERE name = ?1",
                params![VIOLATION_REPORT_CURSOR],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);
        let existing = conn
            .query_row(
                "SELECT id, event_json FROM violation_event WHERE dedupe_key = ?1",
                params![event.dedupe_key],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let Some((id, json)) = existing else {
            return Ok(RecordOutcome::Duplicate);
        };
        let Ok(previous) = serde_json::from_str::<ViolationEvent>(&json) else {
            return Ok(RecordOutcome::Duplicate);
        };
        if id <= cursor || event.action.rank() <= previous.action.rank() {
            return Ok(RecordOutcome::Duplicate);
        }
        let mut stronger = event.clone();
        stronger.event_id = previous.event_id.clone();
        conn.execute(
            "UPDATE violation_event SET event_json = ?1 WHERE id = ?2",
            params![serde_json::to_string(&stronger)?, id],
        )?;
        if let Some(sealed) = sealed {
            conn.execute(
                "UPDATE violation_event SET excerpt_sealed = ?1, excerpt_bytes = ?2 WHERE id = ?3",
                params![sealed, sealed.len() as i64, id],
            )?;
        }
        Ok(RecordOutcome::Upgraded {
            event_id: previous.event_id,
        })
    }

    /// The delivery cursor: the highest row id the control plane acknowledged.
    pub fn cursor(&self) -> anyhow::Result<i64> {
        let conn = lock(&self.conn);
        let cursor = conn
            .query_row(
                "SELECT last_id FROM violation_report_cursors WHERE name = ?1",
                params![VIOLATION_REPORT_CURSOR],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        Ok(cursor.unwrap_or(0))
    }

    /// Rows after the cursor, oldest first, at most `limit`.
    pub fn pending(&self, limit: usize) -> anyhow::Result<Vec<OutboxRow>> {
        let cursor = self.cursor()?;
        let conn = lock(&self.conn);
        let mut statement = conn.prepare(
            "SELECT id, event_json, excerpt_sealed FROM violation_event
             WHERE id > ?1 ORDER BY id ASC LIMIT ?2",
        )?;
        let rows = statement
            .query_map(params![cursor, limit as i64], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<Vec<u8>>>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::with_capacity(rows.len());
        for (id, json, sealed) in rows {
            let Ok(mut event) = serde_json::from_str::<ViolationEvent>(&json) else {
                tracing::warn!(row = id, "violation outbox row does not parse; skipped");
                continue;
            };
            let excerpt = sealed
                .as_deref()
                .and_then(|sealed| self.unseal(sealed))
                .filter(|_| !event.excerpt_forbidden());
            event.evidence_ref = excerpt.as_ref().map(|_| format!("evd_{}", event.event_id));
            out.push(OutboxRow { id, event, excerpt });
        }
        Ok(out)
    }

    /// Advance the cursor to `through_id` (never backwards) and clear every
    /// excerpt at or below it: the control plane holds its own sealed copy.
    pub fn acknowledge(&self, through_id: i64) -> anyhow::Result<()> {
        let conn = lock(&self.conn);
        conn.execute(
            "INSERT INTO violation_report_cursors (name, last_id) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)",
            params![VIOLATION_REPORT_CURSOR, through_id],
        )?;
        conn.execute(
            "UPDATE violation_event SET excerpt_sealed = NULL, excerpt_bytes = 0
             WHERE id <= ?1 AND excerpt_sealed IS NOT NULL",
            params![through_id],
        )?;
        Ok(())
    }

    /// Drop one event's excerpt and keep the event (the control plane refused
    /// the excerpt for its category).
    pub fn drop_excerpt(&self, event_id: &str) -> anyhow::Result<()> {
        lock(&self.conn).execute(
            "UPDATE violation_event SET excerpt_sealed = NULL, excerpt_bytes = 0
             WHERE event_id = ?1",
            params![event_id],
        )?;
        Ok(())
    }
}

#[path = "violation_maintain.rs"]
mod maintain;

#[path = "violation_windows.rs"]
mod windows;
pub use windows::{
    WindowMaintenance, WindowRecord, WindowRow, DEFAULT_MAX_WINDOW_ROWS, USAGE_WINDOW_REPORT_CURSOR,
};

#[cfg(test)]
#[path = "violation_tests.rs"]
mod tests;
