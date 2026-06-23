//! SQLite-backed [`IdentityStore`] for the Identity Vault (Unit 0, #518).
//!
//! Mirrors [`crate::agents::AgentStore`]: open-creating the DB under
//! `~/.ryu/identities.db`, a migration-on-open, and the encrypted-column pattern.
//! The credential state of a connection is sealed with [`crate::crypto`]'s
//! `FieldCipher` (`enc:v1:` envelope) before it ever touches disk, and is **never**
//! returned in `Debug`/`Display` or written to a log line. See
//! `docs/identity-vault-spec.md` §4.
//!
//! ## Data model
//!
//! A [`ConnectionRecord`] is one per-domain login belonging to a *profile*
//! (`profile_id`). A [`Profile`] is the grouping key: one profile aggregates many
//! per-domain connections, so an agent bound to a profile is "logged in to every
//! connected domain" at once.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::crypto::global_cipher;
use crate::sidecar::download_manager::ryu_dir;

use super::{ConnectionRecord, ConnectionStatus, FlowStatus, Profile, SealedState, SecretState};

/// Default backend id used when a connection's `source` is unspecified.
const DEFAULT_SOURCE: &str = "manual";

fn db_path() -> PathBuf {
    ryu_dir().join("identities.db")
}

fn now_unix() -> i64 {
    chrono::Utc::now().timestamp()
}

/// SQLite-backed store for identity connections. Cheap to clone (`Arc` inside).
#[derive(Clone)]
pub struct IdentityStore {
    conn: Arc<Mutex<Connection>>,
}

impl IdentityStore {
    /// Open (creating if needed) the identities DB under `~/.ryu/identities.db`
    /// and run the schema migration.
    pub fn open() -> Result<Self> {
        let path = db_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).context("creating ~/.ryu for identities.db")?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening identities db at {}", path.display()))?;
        Self::migrate(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// In-memory store, used by tests.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::migrate(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn migrate(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS connections (
                id              TEXT PRIMARY KEY,
                profile_id      TEXT NOT NULL,
                domain          TEXT NOT NULL,
                status          TEXT NOT NULL DEFAULT 'NEEDS_AUTH',
                flow_status     TEXT NOT NULL DEFAULT 'IDLE',
                source          TEXT NOT NULL DEFAULT 'manual',
                encrypted_state TEXT,
                last_checked    INTEGER NOT NULL DEFAULT 0,
                created_at      INTEGER NOT NULL,
                updated_at      INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_connections_profile
                ON connections(profile_id);",
        )
        .context("running identities schema migration")?;
        Ok(())
    }

    // ── CRUD ────────────────────────────────────────────────────────────────

    /// Create a new connection for `profile_id` + `domain`, starting in
    /// `NEEDS_AUTH`/`IDLE` with no credential state. `source` defaults to
    /// `"manual"` when `None`.
    pub async fn create(
        &self,
        profile_id: &str,
        domain: &str,
        source: Option<&str>,
    ) -> Result<ConnectionRecord> {
        let id = format!("conn_{}", uuid::Uuid::new_v4().simple());
        let now = now_unix();
        let source = source.unwrap_or(DEFAULT_SOURCE).to_owned();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO connections
                (id, profile_id, domain, status, flow_status, source,
                 encrypted_state, last_checked, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 0, ?7, ?7)",
            params![
                id,
                profile_id,
                domain,
                ConnectionStatus::NeedsAuth.as_str(),
                FlowStatus::Idle.as_str(),
                source,
                now,
            ],
        )?;
        Ok(ConnectionRecord {
            id,
            profile_id: profile_id.to_owned(),
            domain: domain.to_owned(),
            status: ConnectionStatus::NeedsAuth,
            flow_status: FlowStatus::Idle,
            source,
            encrypted_state: None,
            last_checked: 0,
            created_at: now,
            updated_at: now,
        })
    }

    /// Fetch a single connection by id.
    pub async fn get(&self, id: &str) -> Result<Option<ConnectionRecord>> {
        let conn = self.conn.lock().await;
        let record = conn
            .query_row(
                "SELECT id, profile_id, domain, status, flow_status, source,
                        encrypted_state, last_checked, created_at, updated_at
                 FROM connections WHERE id = ?1",
                params![id],
                row_to_record,
            )
            .optional()?;
        Ok(record)
    }

    /// List every connection, newest first.
    pub async fn list(&self) -> Result<Vec<ConnectionRecord>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, profile_id, domain, status, flow_status, source,
                    encrypted_state, last_checked, created_at, updated_at
             FROM connections ORDER BY created_at DESC",
        )?;
        let rows = stmt
            .query_map([], row_to_record)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// List connections belonging to one profile.
    pub async fn list_for_profile(&self, profile_id: &str) -> Result<Vec<ConnectionRecord>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, profile_id, domain, status, flow_status, source,
                    encrypted_state, last_checked, created_at, updated_at
             FROM connections WHERE profile_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt
            .query_map(params![profile_id], row_to_record)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Group all connections into [`Profile`]s keyed by `profile_id`. Profiles are
    /// returned sorted by id for a stable listing; connections within a profile
    /// keep the newest-first ordering.
    pub async fn list_profiles(&self) -> Result<Vec<Profile>> {
        let connections = self.list().await?;
        let mut by_id: std::collections::BTreeMap<String, Vec<ConnectionRecord>> =
            std::collections::BTreeMap::new();
        for record in connections {
            by_id
                .entry(record.profile_id.clone())
                .or_default()
                .push(record);
        }
        Ok(by_id
            .into_iter()
            .map(|(profile_id, connections)| Profile {
                profile_id,
                connections,
            })
            .collect())
    }

    /// Look up a profile's connection for a specific `domain`, if any.
    pub async fn find(&self, profile_id: &str, domain: &str) -> Result<Option<ConnectionRecord>> {
        let conn = self.conn.lock().await;
        let record = conn
            .query_row(
                "SELECT id, profile_id, domain, status, flow_status, source,
                        encrypted_state, last_checked, created_at, updated_at
                 FROM connections WHERE profile_id = ?1 AND domain = ?2",
                params![profile_id, domain],
                row_to_record,
            )
            .optional()?;
        Ok(record)
    }

    /// Update the flow status for an in-progress login. Bumps `updated_at`.
    /// Returns `false` if no row matched.
    pub async fn set_flow_status(&self, id: &str, flow_status: FlowStatus) -> Result<bool> {
        let now = now_unix();
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE connections SET flow_status = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, flow_status.as_str(), now],
        )?;
        Ok(updated > 0)
    }

    /// Seal `raw` credential state and store it, flipping the connection to
    /// `AUTHENTICATED`/`DONE` and stamping `last_checked`. The plaintext is sealed
    /// via [`global_cipher`] before it touches the row; nothing here logs it.
    /// Returns `false` if no row matched.
    pub async fn import_state(&self, id: &str, raw: &SecretState) -> Result<bool> {
        let cipher = global_cipher().context("loading the at-rest cipher for identity state")?;
        let sealed = cipher
            .seal(raw.expose())
            .context("sealing identity credential state")?;
        let now = now_unix();
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE connections
                SET encrypted_state = ?2, status = ?3, flow_status = ?4,
                    last_checked = ?5, updated_at = ?5
             WHERE id = ?1",
            params![
                id,
                sealed,
                ConnectionStatus::Authenticated.as_str(),
                FlowStatus::Done.as_str(),
                now,
            ],
        )?;
        Ok(updated > 0)
    }

    /// Open (decrypt) a connection's sealed credential state. Returns `None` if the
    /// row has no state. **The returned [`SecretState`] must never be logged or
    /// placed in an API response** — it is for tool-call-time credential use only.
    pub async fn open_state(&self, id: &str) -> Result<Option<SecretState>> {
        let sealed = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT encrypted_state FROM connections WHERE id = ?1",
                params![id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
        };
        let Some(sealed) = sealed else {
            return Ok(None);
        };
        let cipher = global_cipher().context("loading the at-rest cipher for identity state")?;
        let plain = cipher
            .open(&sealed)
            .context("opening sealed identity credential state")?;
        Ok(Some(SecretState::new(plain)))
    }

    /// Flip a connection back to `NEEDS_AUTH` (e.g. the health loop found it stale).
    /// Stamps `last_checked`/`updated_at`. Returns `false` if no row matched.
    pub async fn mark_needs_auth(&self, id: &str) -> Result<bool> {
        let now = now_unix();
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE connections
                SET status = ?2, last_checked = ?3, updated_at = ?3
             WHERE id = ?1",
            params![id, ConnectionStatus::NeedsAuth.as_str(), now],
        )?;
        Ok(updated > 0)
    }

    /// Stamp `last_checked` without changing status (health loop confirmed alive).
    /// Returns `false` if no row matched.
    pub async fn touch_checked(&self, id: &str) -> Result<bool> {
        let now = now_unix();
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE connections SET last_checked = ?2, updated_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
        Ok(updated > 0)
    }

    /// Delete a connection. Returns `true` if a row was removed.
    pub async fn delete(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let removed = conn.execute("DELETE FROM connections WHERE id = ?1", params![id])?;
        Ok(removed > 0)
    }
}

/// Parse a row into a [`ConnectionRecord`]. Unknown enum strings fail soft to the
/// `NEEDS_AUTH`/`IDLE` defaults so a forward-written value never breaks reads.
fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConnectionRecord> {
    let status: String = row.get(3)?;
    let flow_status: String = row.get(4)?;
    let encrypted_state: Option<String> = row.get(6)?;
    Ok(ConnectionRecord {
        id: row.get(0)?,
        profile_id: row.get(1)?,
        domain: row.get(2)?,
        status: ConnectionStatus::from_str(&status),
        flow_status: FlowStatus::from_str(&flow_status),
        source: row.get(5)?,
        encrypted_state: encrypted_state.map(SealedState::new),
        last_checked: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}
