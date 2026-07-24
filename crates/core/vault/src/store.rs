//! SQLite-backed [`IdentityStore`] for the Identity Vault (Unit 0, #518).
//!
//! Mirrors [`crate::agents::AgentStore`]: open-creating the DB under
//! `~/.ryu/identities.db`, a migration-on-open, and the encrypted-column pattern.
//! The credential state of a connection is sealed with [`ryu_crypto`]'s
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

use std::path::Path;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use ryu_crypto::global_cipher;

use super::source::{is_known_source, known_source_ids};
use super::{ConnectionRecord, ConnectionStatus, FlowStatus, Profile, SealedState, SecretState};

/// Default backend id used when a connection's `source` is unspecified.
const DEFAULT_SOURCE: &str = "manual";

/// Backend ids that **used to be registered** and were retired. Rows persisted
/// under one of these by an older build are rewritten to [`DEFAULT_SOURCE`] by
/// the migration, so no row is left naming a backend that no longer exists.
///
/// **Append here when you retire a backend** — this list, not the complement of
/// [`known_source_ids`], is what the sweep matches on. The difference matters:
/// matching "anything not currently known" would also rewrite an id that is
/// merely *unrecognized by this binary* — e.g. an older Core opening a
/// `~/.ryu/identities.db` written by a newer one (a downgrade, or a mixed-version
/// data folder) would silently clobber a perfectly valid future backend id, and
/// the rewrite is one-way. Naming the retired ids explicitly keeps the sweep to
/// ids we know are dead. Leaving an unknown id alone is safe: both readers
/// degrade gracefully — `server::identity_api` falls back to the per-domain
/// registry when `CredentialBackend::from_id` returns `None`, and the health
/// sweep resolves through the registry and never reads the column.
///
/// - `browser-tool` — a `NotImplemented` stub for a browser engine Core doesn't ship.
/// - `composio` — a dead vault backend: Composio holds credentials server-side,
///   so `begin_login`/`import`/`fetch_state` could only bail. (The *live*
///   Composio integration is a separate seam and is unaffected.)
///
/// Retiring a row this way is lossless: neither backend could ever `import`, so
/// such a row carries no `encrypted_state` to lose — and the sweep touches only
/// the `source` column regardless.
const RETIRED_SOURCE_IDS: &[&str] = &["browser-tool", "composio"];

fn now_unix() -> i64 {
    chrono::Utc::now().timestamp()
}

/// SQLite-backed store for identity connections. Cheap to clone (`Arc` inside).
#[derive(Clone)]
pub struct IdentityStore {
    conn: Arc<Mutex<Connection>>,
}

impl IdentityStore {
    /// Open (creating if needed) the identities DB at `<dir>/identities.db` and
    /// run the schema migration. `dir` is the active `~/.ryu` data dir, injected
    /// by the caller (Core passes `crate::paths::ryu_dir()`): the one kernel
    /// coupling this primitive would otherwise have, inverted as a constructor
    /// parameter rather than a global host trait since there is a single
    /// construction site.
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        let path = dir.as_ref().join("identities.db");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("creating ~/.ryu for identities.db")?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening identities db at {}", path.display()))?;
        Self::migrate(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// In-memory store, used by tests. Exposed under the `test-support` feature so
    /// Core's identity-governance tests (in `apps/core`) can build a store without
    /// touching disk.
    #[cfg(any(test, feature = "test-support"))]
    pub fn open_in_memory() -> Result<Self> {
        // Identity state is sealed via the process-global `global_cipher()`. Ensure
        // the crypto host + master key are installed so tests — which never run
        // `main` — resolve the key exactly as production does, without an OS
        // keychain.
        crate::ensure_test_cipher();
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

        // Retire rows written under a backend that no longer exists (the
        // `browser-tool` stub and the `composio` dead vault backend, both of which
        // older builds accepted). Such a row would otherwise resolve
        // inconsistently — `begin_login` would silently fall back to the
        // per-domain registry while the row still claimed a backend that is gone.
        //
        // The match is on [`RETIRED_SOURCE_IDS`] (ids we *know* are dead), NOT on
        // "any id not in `known_source_ids()`": see that const's docs — the
        // complement form also clobbers an id this binary merely doesn't recognize
        // (a downgrade / mixed-version data folder), and the rewrite is one-way.
        //
        // Idempotent: a re-run matches nothing. The ids are compile-time constants,
        // so the inlined list is never user input.
        let retired = RETIRED_SOURCE_IDS
            .iter()
            .map(|id| format!("'{id}'"))
            .collect::<Vec<_>>()
            .join(", ");
        conn.execute(
            &format!(
                "UPDATE connections SET source = '{DEFAULT_SOURCE}'
                 WHERE source IN ({retired})"
            ),
            [],
        )
        .context("normalizing retired identity source ids")?;
        Ok(())
    }

    // ── CRUD ────────────────────────────────────────────────────────────────

    /// Create a new connection for `profile_id` + `domain`, starting in
    /// `NEEDS_AUTH`/`IDLE` with no credential state. `source` defaults to
    /// `"manual"` when `None`.
    ///
    /// An unregistered `source` is **rejected here**, at creation. The store is
    /// the only writer of the `source` column, so this is the chokepoint that
    /// keeps an unselectable backend out of the DB. A retired id (`browser-tool`,
    /// `composio`) is no longer registered, so it is refused with a 400 naming the
    /// real options — where it used to be accepted verbatim and only blow up
    /// later, at `begin_login`, as an opaque 500 (or, worse, silently fall back to
    /// a different backend than the row named). See [`crate::identity::source`] on
    /// why only fully-implemented backends are registered.
    pub async fn create(
        &self,
        profile_id: &str,
        domain: &str,
        source: Option<&str>,
    ) -> Result<ConnectionRecord> {
        let id = format!("conn_{}", uuid::Uuid::new_v4().simple());
        let now = now_unix();
        let source = source.unwrap_or(DEFAULT_SOURCE).to_owned();
        if !is_known_source(&source) {
            bail!(
                "unknown identity source `{source}`; known sources: {}",
                known_source_ids().join(", ")
            );
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// An unregistered backend id must be refused **at create**, not accepted and
    /// then blown up at login time. This is what closes the `browser-tool` and
    /// `composio` traps on the HTTP path (`POST /api/identities/connections`
    /// forwards `source` verbatim).
    ///
    /// **The `composio` leg is the behavior change**: that create used to be
    /// `Ok`, and the connection it made then returned HTTP 500 from
    /// `POST /connections/{id}/login`. It is now rejected up front.
    #[tokio::test]
    async fn create_rejects_retired_and_unknown_sources() {
        let store = IdentityStore::open_in_memory().unwrap();

        for bad in ["browser-tool", "composio", "not-a-backend"] {
            let err = store
                .create("prof_1", "app.netflix.com", Some(bad))
                .await
                .unwrap_err();
            let msg = err.to_string();
            assert!(
                msg.contains("unknown identity source"),
                "`{bad}`: got {msg}"
            );
            // The error names the real options so a caller can fix the request.
            assert!(msg.contains("manual"), "`{bad}`: got {msg}");
        }

        // Nothing was written — the 500 that used to follow a `composio` create
        // (at `POST /connections/{id}/login`) is now unreachable: there is no row.
        assert!(store.list().await.unwrap().is_empty());

        // A registered source still works, and the default stays `manual`.
        let ok = store.create("prof_1", "a.example.com", None).await.unwrap();
        assert_eq!(ok.source, "manual");
        assert!(store
            .create("prof_2", "b.example.com", Some("manual"))
            .await
            .is_ok());
    }

    /// A row persisted by an older build under a now-retired id is normalized to
    /// `manual` by the migration, so it resolves consistently instead of naming a
    /// backend that no longer exists. Idempotent: re-running changes nothing.
    #[tokio::test]
    async fn migration_normalizes_retired_source_ids() {
        let store = IdentityStore::open_in_memory().unwrap();
        {
            let conn = store.conn.lock().await;
            // Simulate the pre-removal rows: both ids were accepted verbatim, and
            // `browser-tool` could even have state sealed under it.
            conn.execute(
                "INSERT INTO connections
                    (id, profile_id, domain, status, flow_status, source,
                     encrypted_state, last_checked, created_at, updated_at)
                 VALUES ('conn_legacy', 'prof_1', 'app.netflix.com', 'AUTHENTICATED',
                         'DONE', 'browser-tool', 'enc:v1:blob', 0, 0, 0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO connections
                    (id, profile_id, domain, status, flow_status, source,
                     encrypted_state, last_checked, created_at, updated_at)
                 VALUES ('conn_composio', 'prof_1', 'notion.so', 'NEEDS_AUTH',
                         'IDLE', 'composio', NULL, 0, 0, 0)",
                [],
            )
            .unwrap();
            IdentityStore::migrate(&conn).unwrap();
        }

        let record = store.get("conn_legacy").await.unwrap().unwrap();
        assert_eq!(record.source, "manual", "retired id must be normalized");
        // Normalization rewrites only `source` — the sealed state is untouched.
        assert!(record.encrypted_state.is_some());

        // The composio row is retired too, rather than left orphaned naming a
        // backend the dispatcher no longer resolves.
        assert_eq!(
            store.get("conn_composio").await.unwrap().unwrap().source,
            "manual"
        );

        // Re-running the migration is a no-op for an already-known id.
        {
            let conn = store.conn.lock().await;
            IdentityStore::migrate(&conn).unwrap();
        }
        assert_eq!(
            store.get("conn_legacy").await.unwrap().unwrap().source,
            "manual"
        );
    }

    /// A registered id is never rewritten by the normalization sweep.
    #[tokio::test]
    async fn migration_leaves_known_sources_alone() {
        let store = IdentityStore::open_in_memory().unwrap();
        store.create("prof_1", "a.example.com", None).await.unwrap();
        {
            let conn = store.conn.lock().await;
            IdentityStore::migrate(&conn).unwrap();
        }
        let found = store
            .find("prof_1", "a.example.com")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.source, "manual");
    }

    /// **Downgrade safety.** The sweep retires the ids we *know* are dead; it must
    /// NOT rewrite an id it merely doesn't recognize. An older Core opening a
    /// `~/.ryu/identities.db` written by a newer one (a downgrade, or a
    /// mixed-version data folder) would otherwise silently clobber a valid future
    /// backend id — a one-way loss. The row stays as written; both readers degrade
    /// gracefully to the per-domain registry.
    #[tokio::test]
    async fn migration_leaves_an_unrecognized_future_source_intact() {
        let store = IdentityStore::open_in_memory().unwrap();
        {
            let conn = store.conn.lock().await;
            // A backend a *newer* build registers and this one has never heard of
            // (e.g. the browser-extension cookie-jar source the source docs spec).
            conn.execute(
                "INSERT INTO connections
                    (id, profile_id, domain, status, flow_status, source,
                     encrypted_state, last_checked, created_at, updated_at)
                 VALUES ('conn_future', 'prof_1', 'app.netflix.com', 'AUTHENTICATED',
                         'DONE', 'extension', 'enc:v1:blob', 0, 0, 0)",
                [],
            )
            .unwrap();
            IdentityStore::migrate(&conn).unwrap();
        }

        let record = store.get("conn_future").await.unwrap().unwrap();
        assert_eq!(
            record.source, "extension",
            "an unknown-but-not-retired id must be left alone, not clobbered to manual"
        );
        assert!(record.encrypted_state.is_some());
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
