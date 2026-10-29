//! SQLite-backed [`IdentityStore`] for the Identity Vault (Unit 0, #518).
//!
//! Mirrors [`crate::agents::AgentStore`]: open-creating the DB under
//! `~/.ryu/identities.db`, a migration-on-open, and the encrypted-column pattern.
//! The credential state of a connection is sealed with [`ryu_crypto`] before it
//! ever touches disk, and is **never** returned in `Debug`/`Display` or written to
//! a log line. See `docs/identity-vault-spec.md` §4.
//!
//! ## Sealing modes
//!
//! * [`IdentityStore::open`] (Core's embedded vault) seals with the master-key
//!   `FieldCipher` (`enc:v1:`), unchanged.
//! * [`IdentityStore::open_for_tenant`] (standalone Passport) seals with a
//!   [`TenantCipher`] (`enc:v2:`): a per-tenant subkey, with the tenant id, the
//!   table and column, and the row's stable identifiers as AEAD associated data.
//!   Ciphertext moved to another row, table, or tenant store fails to open.
//!   Opening never accepts a legacy (unbound) value. A store from an earlier
//!   release is converted only by an explicit, operator-initiated migration
//!   ([`IdentityStore::migrate_legacy_database`]): any marker kept inside the
//!   data directory could be deleted by the same party who could plant a
//!   captured `enc:v1:` value, so the decision to accept legacy values cannot
//!   rest on state in the store itself.
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
use tokio::sync::Mutex;

use ryu_crypto::{global_cipher, tenant_cipher, BoundSealError, SealContext, TenantCipher};

use super::source::{is_known_source, known_source_ids};
use super::{
    ConnectionAccessLevel, ConnectionRecord, ConnectionStatus, FlowStatus,
    McpOAuthConnectionRecord, McpOAuthConnectionStatus, Profile, SealedState, SecretState,
};

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
    sealing: Sealing,
}

/// How this store seals credential columns. See the module docs.
#[derive(Clone)]
enum Sealing {
    /// Master-key `enc:v1:` envelope with no binding (Core's embedded vault).
    Unbound,
    /// Tenant-bound `enc:v2:` envelope (standalone Passport tenant stores).
    Tenant(TenantCipher),
}

/// Purpose (AAD) of `connections.encrypted_state`.
const CONNECTION_STATE_PURPOSE: &str = "ryu-vault.connections.encrypted_state";
/// Purpose (AAD) of `mcp_oauth_connections.encrypted_state`.
const MCP_OAUTH_STATE_PURPOSE: &str = "ryu-vault.mcp_oauth_connections.encrypted_state";
/// Purpose (AAD) of the store's binding record.
const BINDING_RECORD_PURPOSE: &str = "ryu-vault.sealed_state_binding";
/// Plaintext of the binding record. Not secret: the record proves only that
/// this store was bound for this tenant under this master key.
const BINDING_RECORD_PLAINTEXT: &str = "ryu-vault tenant-bound sealed state";

/// Associated data for one `connections` row: the row id, its profile, and the
/// domain its credentials are sent to. None of these change for the life of a
/// row, and binding the domain stops an edited row from redirecting a login.
fn connection_state_context(id: &str, profile_id: &str, domain: &str) -> SealContext {
    SealContext::new(CONNECTION_STATE_PURPOSE)
        .with("id", id)
        .with("profile_id", profile_id)
        .with("domain", domain)
}

/// Associated data for one `mcp_oauth_connections` row: the row id, the unique
/// owner/profile/plugin/server binding, and the resource and issuer the token
/// bundle is used with. The upsert rewrites the resource, issuer, and sealed
/// bundle together, so binding them never strands a live row.
fn mcp_oauth_state_context(
    id: &str,
    owner_user_id: &str,
    profile_id: &str,
    plugin_id: &str,
    server_name: &str,
    resource_uri: &str,
    issuer: &str,
) -> SealContext {
    SealContext::new(MCP_OAUTH_STATE_PURPOSE)
        .with("id", id)
        .with("owner_user_id", owner_user_id)
        .with("profile_id", profile_id)
        .with("plugin_id", plugin_id)
        .with("server_name", server_name)
        .with("resource_uri", resource_uri)
        .with("issuer", issuer)
}

fn binding_record_context() -> SealContext {
    SealContext::new(BINDING_RECORD_PURPOSE).with("envelope", "enc:v2")
}

/// The identifying columns of one `mcp_oauth_connections` row, in AAD order.
struct McpOAuthBinding {
    id: String,
    owner_user_id: String,
    profile_id: String,
    plugin_id: String,
    server_name: String,
    resource_uri: String,
    issuer: String,
}

impl McpOAuthBinding {
    fn context(&self) -> SealContext {
        mcp_oauth_state_context(
            &self.id,
            &self.owner_user_id,
            &self.profile_id,
            &self.plugin_id,
            &self.server_name,
            &self.resource_uri,
            &self.issuer,
        )
    }
}

/// What the caller of [`IdentityStore::migrate_legacy_database`] wants done
/// with stored values that cannot be migrated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnreadableLegacyState {
    /// Clear the value and send the connection back to re-authentication, so
    /// one damaged row does not keep the whole tenant from starting.
    Quarantine,
    /// Fail without changing anything (an all-or-nothing import).
    Abort,
}

/// Outcome of [`IdentityStore::migrate_legacy_database`]. Carries row ids only,
/// never credential material.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LegacyMigration {
    /// The store already had a binding record for this tenant; nothing changed.
    pub already_bound: bool,
    /// Legacy `enc:v1:` values resealed as tenant-bound `enc:v2:` values.
    pub resealed: usize,
    /// Rows whose stored value could not be migrated and was cleared.
    pub quarantined: Vec<QuarantinedState>,
}

/// One row whose legacy value was cleared during migration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuarantinedState {
    /// `connections` or `mcp_oauth_connections`.
    pub table: &'static str,
    /// The row id.
    pub id: String,
    /// Why the value was not migrated.
    pub reason: &'static str,
}

/// A tenant store holds credential values that are not tenant-bound and has
/// no binding record, so [`IdentityStore::open_for_tenant`] refused it. Either
/// it comes from an earlier release and needs its one-time explicit migration,
/// or someone who can write the store planted the values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnmigratedLegacyState {
    /// The tenant the store was opened for.
    pub tenant: String,
    /// How many stored values are not tenant-bound.
    pub values: usize,
}

impl std::fmt::Display for UnmigratedLegacyState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "identity store for tenant `{}` holds {} credential value(s) that are not bound to \
             the tenant and has no binding record: either it comes from an earlier release and \
             needs its one-time explicit migration, or someone who can write the store planted \
             them; refusing to open it",
            self.tenant, self.values
        )
    }
}

impl std::error::Error for UnmigratedLegacyState {}

#[derive(PartialEq, Eq)]
enum BindingRecord {
    Verified,
    Missing,
}

/// Non-null sealed values in both credential tables, split by envelope.
struct SealedValueCounts {
    bound: usize,
    unbound: usize,
}

/// Create the binding table if needed and check its record. A record that does
/// not open for this tenant is an error, never "missing".
fn read_binding_record(
    transaction: &rusqlite::Transaction<'_>,
    cipher: &TenantCipher,
) -> Result<BindingRecord> {
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS sealed_state_binding (
                singleton   INTEGER PRIMARY KEY CHECK (singleton = 1),
                envelope    TEXT NOT NULL,
                proof       TEXT NOT NULL,
                bound_at    INTEGER NOT NULL
            );",
        )
        .context("creating the sealed-state binding table")?;
    let proof = transaction
        .query_row(
            "SELECT proof FROM sealed_state_binding WHERE singleton = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(proof) = proof else {
        return Ok(BindingRecord::Missing);
    };
    let verified = cipher
        .open(&proof, &binding_record_context())
        .is_ok_and(|plain| plain == BINDING_RECORD_PLAINTEXT);
    if !verified {
        bail!(
            "identity store is not bound to tenant `{}` under this master key: it was copied \
             from another tenant, altered, or the master key changed; refusing to open it",
            cipher.tenant()
        );
    }
    Ok(BindingRecord::Verified)
}

fn write_binding_record(
    transaction: &rusqlite::Transaction<'_>,
    cipher: &TenantCipher,
) -> Result<()> {
    let proof = cipher
        .seal(BINDING_RECORD_PLAINTEXT, &binding_record_context())
        .context("sealing the store binding record")?;
    transaction.execute(
        "INSERT INTO sealed_state_binding (singleton, envelope, proof, bound_at)
         VALUES (1, 'enc:v2', ?1, ?2)",
        params![proof, now_unix()],
    )?;
    Ok(())
}

fn count_sealed_values(transaction: &rusqlite::Transaction<'_>) -> Result<SealedValueCounts> {
    let (bound, total): (i64, i64) = transaction.query_row(
        "SELECT
            (SELECT COUNT(*) FROM connections WHERE encrypted_state LIKE 'enc:v2:%')
          + (SELECT COUNT(*) FROM mcp_oauth_connections WHERE encrypted_state LIKE 'enc:v2:%'),
            (SELECT COUNT(*) FROM connections WHERE encrypted_state IS NOT NULL)
          + (SELECT COUNT(*) FROM mcp_oauth_connections WHERE encrypted_state IS NOT NULL)",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(SealedValueCounts {
        bound: usize::try_from(bound).unwrap_or(usize::MAX),
        unbound: usize::try_from(total - bound).unwrap_or(usize::MAX),
    })
}

/// A credential row considered by the legacy migration.
enum LegacyRow {
    Connection {
        id: String,
        profile_id: String,
        domain: String,
    },
    McpOAuth(McpOAuthBinding),
}

impl LegacyRow {
    fn table(&self) -> &'static str {
        match self {
            Self::Connection { .. } => "connections",
            Self::McpOAuth(_) => "mcp_oauth_connections",
        }
    }

    fn id(&self) -> &str {
        match self {
            Self::Connection { id, .. } => id,
            Self::McpOAuth(binding) => &binding.id,
        }
    }

    fn context(&self) -> SealContext {
        match self {
            Self::Connection {
                id,
                profile_id,
                domain,
            } => connection_state_context(id, profile_id, domain),
            Self::McpOAuth(binding) => binding.context(),
        }
    }

    fn quarantined(&self, reason: &'static str) -> QuarantinedState {
        QuarantinedState {
            table: self.table(),
            id: self.id().to_owned(),
            reason,
        }
    }
}

/// Every non-null credential value in both tables, with its row identifiers.
fn legacy_rows(transaction: &rusqlite::Transaction<'_>) -> Result<Vec<(LegacyRow, String)>> {
    let mut rows = Vec::new();
    let mut statement = transaction.prepare(
        "SELECT id, profile_id, domain, encrypted_state FROM connections
         WHERE encrypted_state IS NOT NULL",
    )?;
    for row in statement.query_map([], |row| {
        Ok((
            LegacyRow::Connection {
                id: row.get(0)?,
                profile_id: row.get(1)?,
                domain: row.get(2)?,
            },
            row.get::<_, String>(3)?,
        ))
    })? {
        rows.push(row?);
    }
    let mut statement = transaction.prepare(
        "SELECT id, owner_user_id, profile_id, plugin_id, server_name, resource_uri,
                issuer, encrypted_state
         FROM mcp_oauth_connections WHERE encrypted_state IS NOT NULL",
    )?;
    for row in statement.query_map([], |row| {
        Ok((
            LegacyRow::McpOAuth(McpOAuthBinding {
                id: row.get(0)?,
                owner_user_id: row.get(1)?,
                profile_id: row.get(2)?,
                plugin_id: row.get(3)?,
                server_name: row.get(4)?,
                resource_uri: row.get(5)?,
                issuer: row.get(6)?,
            }),
            row.get::<_, String>(7)?,
        ))
    })? {
        rows.push(row?);
    }
    Ok(rows)
}

impl IdentityStore {
    /// Open (creating if needed) the identities DB at `<dir>/identities.db` and
    /// run the schema migration. `dir` is injected by the caller (Core passes its
    /// `<data dir>/db` via `crate::paths::db_dir()`; Passport a tenant dir): the one kernel
    /// coupling this primitive would otherwise have, inverted as a constructor
    /// parameter rather than a global host trait since there is a single
    /// construction site.
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        let conn = Self::open_connection(dir.as_ref())?;
        Self::migrate(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            sealing: Sealing::Unbound,
        })
    }

    /// Open (creating if needed) a **tenant-bound** store at
    /// `<dir>/identities.db`. Credential columns are sealed in the `enc:v2:`
    /// envelope under `tenant_id`'s subkey, with the row's stable identifiers as
    /// associated data (see the module docs).
    ///
    /// Opening never migrates. It fails if the binding record does not open for
    /// this tenant (a store copied from another tenant, or a different master
    /// key), and with [`UnmigratedLegacyState`] if the store has no binding
    /// record but holds any credential value that is not tenant-bound: written
    /// by an earlier release, or planted. Such a store must be converted once
    /// with [`Self::migrate_legacy_database`] by an explicit operator action. A
    /// store with no record and only empty or bound values (new, or one whose
    /// record was deleted) gets a fresh record; bound values still verify one
    /// by one.
    ///
    /// The tenant id becomes part of every sealed value, so it must stay the same
    /// for the life of the store. Needs the process-global master key, like
    /// [`ryu_crypto::global_cipher`].
    pub fn open_for_tenant(dir: impl AsRef<Path>, tenant_id: &str) -> Result<Self> {
        let cipher = tenant_cipher(tenant_id).context("deriving the tenant sealing key")?;
        let mut conn = Self::open_connection(dir.as_ref())?;
        Self::migrate(&conn)?;
        Self::verify_binding(&mut conn, &cipher)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            sealing: Sealing::Tenant(cipher),
        })
    }

    fn open_connection(dir: &Path) -> Result<Connection> {
        let path = dir.join("identities.db");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("creating the identities.db directory")?;
        }
        Connection::open(&path)
            .with_context(|| format!("opening identities db at {}", path.display()))
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
            sealing: Sealing::Unbound,
        })
    }

    /// In-memory tenant-bound store, used by tests (see [`Self::open_for_tenant`]).
    #[cfg(any(test, feature = "test-support"))]
    pub fn open_in_memory_for_tenant(tenant_id: &str) -> Result<Self> {
        crate::ensure_test_cipher();
        let cipher = tenant_cipher(tenant_id).context("deriving the tenant sealing key")?;
        let mut conn = Connection::open_in_memory()?;
        Self::migrate(&conn)?;
        Self::verify_binding(&mut conn, &cipher)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            sealing: Sealing::Tenant(cipher),
        })
    }

    /// The tenant this store seals for, or `None` for an unbound (Core) store.
    pub fn tenant_id(&self) -> Option<&str> {
        match &self.sealing {
            Sealing::Unbound => None,
            Sealing::Tenant(cipher) => Some(cipher.tenant()),
        }
    }

    /// Convert the database at `path` (an `identities.db`) from an earlier
    /// release to tenant-bound sealed state, once. **Call this only from an
    /// explicit operator action** — an import, or a one-time upgrade command —
    /// never automatically on open: whoever can write the store could otherwise
    /// strip its binding record and plant a captured `enc:v1:` value, or
    /// arbitrary plaintext, for the migration to bind.
    ///
    /// In one transaction: every `enc:v1:` value that opens with the master key
    /// is resealed as `enc:v2:` for its row, and the binding record is written.
    /// A value that is not an `enc:v1:` envelope (plaintext or another scheme)
    /// is never accepted. Such values, and `enc:v1:` values that do not open,
    /// are handled per `unreadable`: [`UnreadableLegacyState::Quarantine`]
    /// clears them and sends the row back to re-authentication (logged by row
    /// id), [`UnreadableLegacyState::Abort`] fails without changing anything.
    ///
    /// Refused without changes when no `enc:v1:` value opens at all (almost
    /// certainly the wrong master key), when the binding record exists but does
    /// not open for this tenant, and when the store holds bound values but no
    /// binding record (it was converted before and has since been altered). A
    /// store whose record already verifies is left alone (`already_bound`).
    pub fn migrate_legacy_database(
        path: &Path,
        cipher: &TenantCipher,
        unreadable: UnreadableLegacyState,
    ) -> Result<LegacyMigration> {
        let mut conn = Connection::open(path)
            .with_context(|| format!("opening identities db at {}", path.display()))?;
        Self::migrate(&conn)?;
        Self::migrate_legacy(&mut conn, cipher, unreadable)
    }

    /// Strict binding check for every tenant open. Never accepts legacy values.
    fn verify_binding(conn: &mut Connection, cipher: &TenantCipher) -> Result<()> {
        let transaction = conn
            .transaction()
            .context("starting the sealed-state binding check")?;
        if read_binding_record(&transaction, cipher)? == BindingRecord::Verified {
            transaction.commit()?;
            return Ok(());
        }
        let counts = count_sealed_values(&transaction)?;
        if counts.unbound > 0 {
            return Err(UnmigratedLegacyState {
                tenant: cipher.tenant().to_owned(),
                values: counts.unbound,
            }
            .into());
        }
        if counts.bound > 0 {
            // Only bound values remain, and each still verifies on its own, so
            // a fresh record admits nothing. The record was deleted, though.
            tracing::warn!(
                tenant = %cipher.tenant(),
                "identity store had tenant-bound values but no binding record; recreated it"
            );
        }
        write_binding_record(&transaction, cipher)?;
        transaction
            .commit()
            .context("committing the sealed-state binding record")?;
        Ok(())
    }

    fn migrate_legacy(
        conn: &mut Connection,
        cipher: &TenantCipher,
        unreadable: UnreadableLegacyState,
    ) -> Result<LegacyMigration> {
        let tenant = cipher.tenant().to_owned();
        let transaction = conn
            .transaction()
            .context("starting the legacy sealed-state migration")?;
        if read_binding_record(&transaction, cipher)? == BindingRecord::Verified {
            transaction.commit()?;
            return Ok(LegacyMigration {
                already_bound: true,
                ..LegacyMigration::default()
            });
        }
        if count_sealed_values(&transaction)?.bound > 0 {
            bail!(
                "identity store for tenant `{tenant}` holds tenant-bound values but no binding \
                 record: it was converted before and has since been altered, so its unbound \
                 values were not written by Passport; refusing to migrate it (restore a trusted \
                 backup or import the source vault again)"
            );
        }

        // Classify every stored value before writing anything.
        let mut reseal = Vec::new();
        let mut quarantine = Vec::new();
        let mut legacy_seen = 0usize;
        for (row, stored) in legacy_rows(&transaction)? {
            let context = row.context();
            if !ryu_crypto::FieldCipher::is_sealed(&stored) {
                quarantine.push(row.quarantined("not an enc:v1 envelope"));
                continue;
            }
            legacy_seen += 1;
            match cipher.open_allowing_legacy(&stored, &context) {
                Ok(opened) => reseal.push((row, context, opened.into_plaintext())),
                Err(_) => quarantine.push(row.quarantined("enc:v1 value does not open")),
            }
        }
        if legacy_seen > 0 && reseal.is_empty() {
            bail!(
                "none of the {legacy_seen} legacy credential values in the store for tenant \
                 `{tenant}` opens with this master key; check RYU_MASTER_KEY or the keychain \
                 entry. Nothing was changed"
            );
        }
        if unreadable == UnreadableLegacyState::Abort && !quarantine.is_empty() {
            let ids = quarantine
                .iter()
                .map(|row| format!("{} `{}` ({})", row.table, row.id, row.reason))
                .collect::<Vec<_>>()
                .join(", ");
            bail!(
                "{} stored credential value(s) cannot be migrated: {ids}. Nothing was changed",
                quarantine.len()
            );
        }

        let now = now_unix();
        for (row, context, plain) in &reseal {
            let sealed = cipher
                .seal(plain, context)
                .context("resealing legacy credential state")?;
            transaction.execute(
                &format!(
                    "UPDATE {} SET encrypted_state = ?2 WHERE id = ?1",
                    row.table()
                ),
                params![row.id(), sealed],
            )?;
        }
        for row in &quarantine {
            match row.table {
                "connections" => transaction.execute(
                    "UPDATE connections
                     SET encrypted_state = NULL, status = ?2, updated_at = ?3 WHERE id = ?1",
                    params![row.id, ConnectionStatus::NeedsAuth.as_str(), now],
                )?,
                _ => transaction.execute(
                    "UPDATE mcp_oauth_connections
                     SET encrypted_state = NULL, expires_at = NULL, status = ?2, updated_at = ?3
                     WHERE id = ?1",
                    params![
                        row.id,
                        McpOAuthConnectionStatus::ReauthRequired.as_str(),
                        now
                    ],
                )?,
            };
            tracing::warn!(
                tenant = %tenant,
                table = row.table,
                id = %row.id,
                reason = row.reason,
                "cleared legacy credential state that could not be migrated; the connection \
                 needs authentication again"
            );
        }
        write_binding_record(&transaction, cipher)?;
        transaction
            .commit()
            .context("committing the legacy sealed-state migration")?;
        tracing::info!(
            tenant = %tenant,
            resealed = reseal.len(),
            quarantined = quarantine.len(),
            "identity store migrated to tenant-bound sealed state"
        );
        Ok(LegacyMigration {
            already_bound: false,
            resealed: reseal.len(),
            quarantined: quarantine,
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
                ON connections(profile_id);

            CREATE TABLE IF NOT EXISTS mcp_oauth_connections (
                id              TEXT PRIMARY KEY,
                owner_user_id   TEXT NOT NULL,
                profile_id      TEXT NOT NULL,
                plugin_id       TEXT NOT NULL,
                server_name     TEXT NOT NULL,
                resource_uri    TEXT NOT NULL,
                issuer          TEXT NOT NULL,
                status          TEXT NOT NULL DEFAULT 'REAUTH_REQUIRED',
                account_label   TEXT,
                scopes_json     TEXT NOT NULL DEFAULT '[]',
                expires_at      INTEGER,
                encrypted_state TEXT,
                created_at      INTEGER NOT NULL,
                updated_at      INTEGER NOT NULL,
                UNIQUE(owner_user_id, profile_id, plugin_id, server_name)
            );
            CREATE INDEX IF NOT EXISTS idx_mcp_oauth_owner_plugin
                ON mcp_oauth_connections(owner_user_id, plugin_id);

            CREATE TABLE IF NOT EXISTS connection_access_policies (
                owner_user_id   TEXT NOT NULL,
                provider        TEXT NOT NULL,
                connection_key  TEXT NOT NULL,
                access_level    TEXT NOT NULL DEFAULT 'risk_based',
                updated_at      INTEGER NOT NULL,
                PRIMARY KEY(owner_user_id, provider, connection_key)
            );
            CREATE INDEX IF NOT EXISTS idx_connection_access_owner
                ON connection_access_policies(owner_user_id, provider);",
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
        let cipher = match &self.sealing {
            Sealing::Unbound => {
                // Sealed before the lock is taken, as it always was.
                let sealed = global_cipher()
                    .context("loading the at-rest cipher for identity state")?
                    .seal(raw.expose())
                    .context("sealing identity credential state")?;
                let conn = self.conn.lock().await;
                return write_imported_state(&conn, id, &sealed);
            }
            Sealing::Tenant(cipher) => cipher,
        };
        // The row's identifiers are bound into the ciphertext, so read them
        // under the same lock as the write.
        let conn = self.conn.lock().await;
        let Some((profile_id, domain)) = conn
            .query_row(
                "SELECT profile_id, domain FROM connections WHERE id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
        else {
            return Ok(false);
        };
        let sealed = cipher
            .seal(
                raw.expose(),
                &connection_state_context(id, &profile_id, &domain),
            )
            .context("sealing identity credential state")?;
        write_imported_state(&conn, id, &sealed)
    }

    /// Open (decrypt) a connection's sealed credential state. Returns `None` if the
    /// row has no state. **The returned [`SecretState`] must never be logged or
    /// placed in an API response** — it is for tool-call-time credential use only.
    ///
    /// In a tenant-bound store, state that was sealed for another row, tenant,
    /// or domain fails with an error carrying [`BoundSealError`].
    pub async fn open_state(&self, id: &str) -> Result<Option<SecretState>> {
        let row = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT encrypted_state, profile_id, domain FROM connections WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
        };
        let Some((Some(sealed), profile_id, domain)) = row else {
            return Ok(None);
        };
        let plain = match &self.sealing {
            Sealing::Unbound => open_unbound(&sealed),
            Sealing::Tenant(cipher) => {
                cipher.open(&sealed, &connection_state_context(id, &profile_id, &domain))
            }
        }
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

    // ── Connected-account access policy ─────────────────────────────────────

    /// Read the owner's per-connection action ceiling. Missing or unknown
    /// values deliberately resolve to `RiskBased`, so older data folders and
    /// forward-written values never widen access by accident.
    pub async fn get_connection_access_level(
        &self,
        owner_user_id: &str,
        provider: &str,
        connection_key: &str,
    ) -> Result<ConnectionAccessLevel> {
        let conn = self.conn.lock().await;
        let stored = conn
            .query_row(
                "SELECT access_level
                 FROM connection_access_policies
                 WHERE owner_user_id = ?1 AND provider = ?2 AND connection_key = ?3",
                params![owner_user_id, provider, connection_key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(stored
            .as_deref()
            .map(ConnectionAccessLevel::from_str)
            .unwrap_or_default())
    }

    /// Persist the owner's selected per-connection action ceiling. The policy
    /// contains no credential material and is safe to keep when a provider
    /// connection is temporarily disconnected, so a later reconnect retains
    /// the user's choice.
    pub async fn set_connection_access_level(
        &self,
        owner_user_id: &str,
        provider: &str,
        connection_key: &str,
        access_level: ConnectionAccessLevel,
    ) -> Result<()> {
        if !valid_policy_component(owner_user_id)
            || !valid_policy_component(provider)
            || !valid_policy_component(connection_key)
        {
            bail!("connection access policy requires owner, provider, and connection key");
        }
        let now = now_unix();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO connection_access_policies
                (owner_user_id, provider, connection_key, access_level, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(owner_user_id, provider, connection_key) DO UPDATE SET
                access_level = excluded.access_level,
                updated_at = excluded.updated_at",
            params![
                owner_user_id,
                provider,
                connection_key,
                access_level.as_str(),
                now,
            ],
        )?;
        Ok(())
    }

    // ── Remote MCP OAuth ───────────────────────────────────────────────────

    /// Insert or replace the single active OAuth account for a
    /// `(owner, profile, plugin, server)` binding. The token bundle is sealed
    /// before the transaction acquires the database lock.
    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_mcp_oauth_connection(
        &self,
        owner_user_id: &str,
        profile_id: &str,
        plugin_id: &str,
        server_name: &str,
        resource_uri: &str,
        issuer: &str,
        account_label: Option<&str>,
        scopes: &[String],
        expires_at: Option<i64>,
        raw_state: &SecretState,
    ) -> Result<McpOAuthConnectionRecord> {
        let unbound = match &self.sealing {
            Sealing::Unbound => Some(
                global_cipher()
                    .context("loading the at-rest cipher for MCP OAuth state")?
                    .seal(raw_state.expose())
                    .context("sealing MCP OAuth token state")?,
            ),
            Sealing::Tenant(_) => None,
        };
        let scopes_json = serde_json::to_string(scopes).context("serializing OAuth scopes")?;
        let now = now_unix();
        let fresh_id = format!("mcp_oauth_{}", uuid::Uuid::new_v4().simple());
        let conn = self.conn.lock().await;
        let (id, sealed) = match (&self.sealing, unbound) {
            (Sealing::Tenant(cipher), _) => {
                // An upsert onto an existing binding keeps that row's id, and a
                // bound value names its row id, so resolve the id under the
                // same lock as the write.
                let id = conn
                    .query_row(
                        "SELECT id FROM mcp_oauth_connections
                         WHERE owner_user_id = ?1 AND profile_id = ?2
                           AND plugin_id = ?3 AND server_name = ?4",
                        params![owner_user_id, profile_id, plugin_id, server_name],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                    .unwrap_or(fresh_id);
                let sealed = cipher
                    .seal(
                        raw_state.expose(),
                        &mcp_oauth_state_context(
                            &id,
                            owner_user_id,
                            profile_id,
                            plugin_id,
                            server_name,
                            resource_uri,
                            issuer,
                        ),
                    )
                    .context("sealing MCP OAuth token state")?;
                (id, sealed)
            }
            (Sealing::Unbound, sealed) => (
                fresh_id,
                sealed.context("unbound MCP OAuth state was not sealed")?,
            ),
        };
        conn.execute(
            "INSERT INTO mcp_oauth_connections
                (id, owner_user_id, profile_id, plugin_id, server_name, resource_uri,
                 issuer, status, account_label, scopes_json, expires_at,
                 encrypted_state, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
             ON CONFLICT(owner_user_id, profile_id, plugin_id, server_name) DO UPDATE SET
                 resource_uri = excluded.resource_uri,
                 issuer = excluded.issuer,
                 status = excluded.status,
                 account_label = excluded.account_label,
                 scopes_json = excluded.scopes_json,
                 expires_at = excluded.expires_at,
                 encrypted_state = excluded.encrypted_state,
                 updated_at = excluded.updated_at",
            params![
                id,
                owner_user_id,
                profile_id,
                plugin_id,
                server_name,
                resource_uri,
                issuer,
                McpOAuthConnectionStatus::Connected.as_str(),
                account_label,
                scopes_json,
                expires_at,
                sealed,
                now,
            ],
        )?;
        drop(conn);
        self.find_mcp_oauth_connection(owner_user_id, profile_id, plugin_id, server_name)
            .await?
            .context("OAuth connection disappeared after upsert")
    }

    /// Metadata-only list of OAuth connections owned by one principal and plugin.
    pub async fn list_mcp_oauth_connections(
        &self,
        owner_user_id: &str,
        plugin_id: &str,
    ) -> Result<Vec<McpOAuthConnectionRecord>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, owner_user_id, profile_id, plugin_id, server_name,
                    resource_uri, issuer, status, account_label, scopes_json,
                    expires_at, encrypted_state, created_at, updated_at
             FROM mcp_oauth_connections
             WHERE owner_user_id = ?1 AND plugin_id = ?2
             ORDER BY server_name, profile_id",
        )?;
        let rows = stmt
            .query_map(params![owner_user_id, plugin_id], row_to_mcp_oauth_record)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Internal lifecycle view across every owner. This is intentionally not
    /// used by REST handlers; uninstall needs it so every locally held binding
    /// owned by the removed plugin can be revoked and erased.
    pub async fn list_mcp_oauth_connections_for_plugin(
        &self,
        plugin_id: &str,
    ) -> Result<Vec<McpOAuthConnectionRecord>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, owner_user_id, profile_id, plugin_id, server_name,
                    resource_uri, issuer, status, account_label, scopes_json,
                    expires_at, encrypted_state, created_at, updated_at
             FROM mcp_oauth_connections
             WHERE plugin_id = ?1
             ORDER BY owner_user_id, server_name, profile_id",
        )?;
        let rows = stmt
            .query_map(params![plugin_id], row_to_mcp_oauth_record)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Find the exact owner/profile/plugin/server binding.
    pub async fn find_mcp_oauth_connection(
        &self,
        owner_user_id: &str,
        profile_id: &str,
        plugin_id: &str,
        server_name: &str,
    ) -> Result<Option<McpOAuthConnectionRecord>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT id, owner_user_id, profile_id, plugin_id, server_name,
                    resource_uri, issuer, status, account_label, scopes_json,
                    expires_at, encrypted_state, created_at, updated_at
             FROM mcp_oauth_connections
             WHERE owner_user_id = ?1 AND profile_id = ?2
               AND plugin_id = ?3 AND server_name = ?4",
            params![owner_user_id, profile_id, plugin_id, server_name],
            row_to_mcp_oauth_record,
        )
        .optional()
        .map_err(Into::into)
    }

    /// Decrypt the token bundle for runtime use. It must never cross an API or
    /// logging boundary.
    pub async fn open_mcp_oauth_state(&self, id: &str) -> Result<Option<SecretState>> {
        let row = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT encrypted_state, owner_user_id, profile_id, plugin_id, server_name,
                        resource_uri, issuer
                 FROM mcp_oauth_connections WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        McpOAuthBinding {
                            id: id.to_owned(),
                            owner_user_id: row.get(1)?,
                            profile_id: row.get(2)?,
                            plugin_id: row.get(3)?,
                            server_name: row.get(4)?,
                            resource_uri: row.get(5)?,
                            issuer: row.get(6)?,
                        },
                    ))
                },
            )
            .optional()?
        };
        let Some((Some(sealed), binding)) = row else {
            return Ok(None);
        };
        let plain = match &self.sealing {
            Sealing::Unbound => open_unbound(&sealed),
            Sealing::Tenant(cipher) => cipher.open(&sealed, &binding.context()),
        }
        .context("opening sealed MCP OAuth token state")?;
        Ok(Some(SecretState::new(plain)))
    }

    /// Mark a connection unusable without retaining an apparently-live access
    /// token. Used on refresh `invalid_grant` and binding changes.
    pub async fn mark_mcp_oauth_reauth_required(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE mcp_oauth_connections
             SET status = ?2, encrypted_state = NULL, expires_at = NULL, updated_at = ?3
             WHERE id = ?1",
            params![
                id,
                McpOAuthConnectionStatus::ReauthRequired.as_str(),
                now_unix()
            ],
        )?;
        Ok(updated > 0)
    }

    /// Delete the exact OAuth binding. Ownership stays in the predicate so a
    /// guessed connection id cannot cross a principal boundary.
    pub async fn delete_mcp_oauth_connection(
        &self,
        owner_user_id: &str,
        profile_id: &str,
        plugin_id: &str,
        server_name: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let removed = conn.execute(
            "DELETE FROM mcp_oauth_connections
             WHERE owner_user_id = ?1 AND profile_id = ?2
               AND plugin_id = ?3 AND server_name = ?4",
            params![owner_user_id, profile_id, plugin_id, server_name],
        )?;
        Ok(removed > 0)
    }
}

/// Store sealed state and flip the connection to `AUTHENTICATED`/`DONE`.
fn write_imported_state(conn: &Connection, id: &str, sealed: &str) -> Result<bool> {
    let now = now_unix();
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

/// Open a value in an unbound (Core) store: `FieldCipher::open`, except that a
/// tenant-bound `enc:v2:` value is refused instead of being returned verbatim
/// as legacy plaintext.
fn open_unbound(sealed: &str) -> Result<String> {
    if TenantCipher::is_sealed(sealed) {
        return Err(anyhow::Error::new(BoundSealError::Unbound)
            .context("value is sealed for a tenant-bound store, not this unbound store"));
    }
    global_cipher()
        .context("loading the at-rest cipher for identity state")?
        .open(sealed)
}

fn valid_policy_component(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && trimmed.len() <= 512 && !trimmed.chars().any(char::is_control)
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

    #[tokio::test]
    async fn mcp_oauth_is_unique_owner_bound_encrypted_and_metadata_only() {
        let store = IdentityStore::open_in_memory().unwrap();
        let scopes = vec!["email.send".to_owned()];
        let first = store
            .upsert_mcp_oauth_connection(
                "user_a",
                "personal",
                "com.example.mail",
                "mail",
                "https://mcp.example.com/",
                "https://auth.example.com/",
                Some("alice@example.com"),
                &scopes,
                Some(1_800_000_000),
                &SecretState::new(r#"{"access_token":"top-secret"}"#.to_owned()),
            )
            .await
            .unwrap();
        store
            .upsert_mcp_oauth_connection(
                "user_a",
                "personal",
                "com.example.mail",
                "mail",
                "https://mcp.example.com/",
                "https://auth.example.com/",
                Some("alice@example.com"),
                &scopes,
                Some(1_900_000_000),
                &SecretState::new(r#"{"access_token":"rotated-secret"}"#.to_owned()),
            )
            .await
            .unwrap();

        let records = store
            .list_mcp_oauth_connections("user_a", "com.example.mail")
            .await
            .unwrap();
        assert_eq!(records.len(), 1, "the binding permits one active account");
        assert!(!serde_json::to_string(&records[0])
            .unwrap()
            .contains("secret"));
        assert!(store
            .list_mcp_oauth_connections("user_b", "com.example.mail")
            .await
            .unwrap()
            .is_empty());

        let opened = store
            .open_mcp_oauth_state(&records[0].id)
            .await
            .unwrap()
            .unwrap();
        assert!(opened.expose().contains("rotated-secret"));
        let conn = store.conn.lock().await;
        let sealed: String = conn
            .query_row(
                "SELECT encrypted_state FROM mcp_oauth_connections WHERE id = ?1",
                params![records[0].id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(sealed.starts_with("enc:v1:"));
        assert!(!sealed.contains("rotated-secret"));
        assert_eq!(first.owner_user_id, "user_a");
    }

    #[tokio::test]
    async fn connection_access_policy_defaults_and_round_trips_per_owner() {
        let store = IdentityStore::open_in_memory().unwrap();

        assert_eq!(
            store
                .get_connection_access_level("user_a", "composio", "gmail")
                .await
                .unwrap(),
            ConnectionAccessLevel::RiskBased
        );

        store
            .set_connection_access_level(
                "user_a",
                "composio",
                "gmail",
                ConnectionAccessLevel::ReadOnly,
            )
            .await
            .unwrap();
        assert_eq!(
            store
                .get_connection_access_level("user_a", "composio", "gmail")
                .await
                .unwrap(),
            ConnectionAccessLevel::ReadOnly
        );
        assert_eq!(
            store
                .get_connection_access_level("user_b", "composio", "gmail")
                .await
                .unwrap(),
            ConnectionAccessLevel::RiskBased
        );
    }

    #[tokio::test]
    async fn unknown_connection_access_policy_fails_safe_to_risk_based() {
        let store = IdentityStore::open_in_memory().unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "INSERT INTO connection_access_policies
                    (owner_user_id, provider, connection_key, access_level, updated_at)
                 VALUES ('user_a', 'mcp', 'plugin:server', 'future_level', 0)",
                [],
            )
            .unwrap();
        }
        assert_eq!(
            store
                .get_connection_access_level("user_a", "mcp", "plugin:server")
                .await
                .unwrap(),
            ConnectionAccessLevel::RiskBased
        );
    }

    // ── Tenant-bound sealed state (`enc:v2:`) ───────────────────────────────

    /// A unique scratch directory removed on drop. The crate has no tempfile
    /// dev-dependency, and adding one would touch the shared lockfile.
    struct ScratchDir(std::path::PathBuf);

    impl ScratchDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "ryu-vault-binding-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn raw_state(store: &IdentityStore, table: &str, id: &str) -> Option<String> {
        let conn = store.conn.lock().await;
        conn.query_row(
            &format!("SELECT encrypted_state FROM {table} WHERE id = ?1"),
            params![id],
            |row| row.get(0),
        )
        .unwrap()
    }

    async fn set_raw_state(store: &IdentityStore, table: &str, id: &str, value: &str) {
        let conn = store.conn.lock().await;
        conn.execute(
            &format!("UPDATE {table} SET encrypted_state = ?2 WHERE id = ?1"),
            params![id, value],
        )
        .unwrap();
    }

    fn assert_binding_refused(error: &anyhow::Error, expected: BoundSealError) {
        assert_eq!(
            error.downcast_ref::<BoundSealError>(),
            Some(&expected),
            "{error:#}"
        );
    }

    async fn upsert_mail(store: &IdentityStore, server: &str, token: &str) -> String {
        store
            .upsert_mcp_oauth_connection(
                "user_a",
                "personal",
                "com.example.mail",
                server,
                "https://mcp.example.com/",
                "https://auth.example.com/",
                None,
                &[],
                None,
                &SecretState::new(format!(r#"{{"access_token":"{token}"}}"#)),
            )
            .await
            .unwrap()
            .id
    }

    #[tokio::test]
    async fn tenant_store_seals_bound_state_and_round_trips() {
        let store = IdentityStore::open_in_memory_for_tenant("tenant-a").unwrap();
        assert_eq!(store.tenant_id(), Some("tenant-a"));
        let conn = store.create("prof", "app.example.com", None).await.unwrap();
        let raw = SecretState::new("cookie=hunter2".to_owned());
        assert!(store.import_state(&conn.id, &raw).await.unwrap());
        assert!(!store.import_state("conn_missing", &raw).await.unwrap());

        let sealed = raw_state(&store, "connections", &conn.id).await.unwrap();
        assert!(sealed.starts_with("enc:v2:"), "{sealed}");
        assert!(!sealed.contains("hunter2"));
        assert_eq!(
            store.open_state(&conn.id).await.unwrap().unwrap().expose(),
            "cookie=hunter2"
        );
        // Unbound (Core) stores keep the legacy envelope.
        assert_eq!(IdentityStore::open_in_memory().unwrap().tenant_id(), None);
    }

    #[tokio::test]
    async fn tenant_store_refuses_state_moved_between_rows_or_redirected() {
        let store = IdentityStore::open_in_memory_for_tenant("tenant-a").unwrap();
        let first = store.create("prof", "a.example.com", None).await.unwrap();
        let second = store.create("prof", "b.example.com", None).await.unwrap();
        for (connection, secret) in [(&first, "session=a"), (&second, "session=b")] {
            store
                .import_state(&connection.id, &SecretState::new(secret.to_owned()))
                .await
                .unwrap();
        }
        let a = raw_state(&store, "connections", &first.id).await.unwrap();
        let b = raw_state(&store, "connections", &second.id).await.unwrap();
        set_raw_state(&store, "connections", &first.id, &b).await;
        set_raw_state(&store, "connections", &second.id, &a).await;
        for id in [&first.id, &second.id] {
            let error = store.open_state(id).await.unwrap_err();
            assert_binding_refused(&error, BoundSealError::Mismatch);
            assert!(
                format!("{error:#}").contains("does not belong"),
                "{error:#}"
            );
        }

        // Restoring the value but pointing the row at another domain is refused
        // too: the domain is the destination the credential would be sent to.
        set_raw_state(&store, "connections", &first.id, &a).await;
        assert!(store.open_state(&first.id).await.is_ok());
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE connections SET domain = 'attacker.example' WHERE id = ?1",
                params![first.id],
            )
            .unwrap();
        }
        let error = store.open_state(&first.id).await.unwrap_err();
        assert_binding_refused(&error, BoundSealError::Mismatch);
    }

    #[tokio::test]
    async fn tenant_store_refuses_a_row_copied_from_another_tenant() {
        let a = IdentityStore::open_in_memory_for_tenant("tenant-a").unwrap();
        let b = IdentityStore::open_in_memory_for_tenant("tenant-b").unwrap();
        let conn = a.create("prof", "app.example.com", None).await.unwrap();
        a.import_state(&conn.id, &SecretState::new("session=a".to_owned()))
            .await
            .unwrap();
        let sealed = raw_state(&a, "connections", &conn.id).await.unwrap();
        // Same id, profile, and domain: only the tenant differs.
        {
            let target = b.conn.lock().await;
            target
                .execute(
                    "INSERT INTO connections
                        (id, profile_id, domain, status, flow_status, source,
                         encrypted_state, last_checked, created_at, updated_at)
                     VALUES (?1, 'prof', 'app.example.com', 'AUTHENTICATED', 'DONE',
                             'manual', ?2, 0, 0, 0)",
                    params![conn.id, sealed],
                )
                .unwrap();
        }
        let error = b.open_state(&conn.id).await.unwrap_err();
        assert_binding_refused(&error, BoundSealError::Mismatch);
        assert_eq!(
            a.open_state(&conn.id).await.unwrap().unwrap().expose(),
            "session=a"
        );
    }

    fn db_path(dir: &ScratchDir) -> std::path::PathBuf {
        dir.path().join("identities.db")
    }

    fn test_tenant(tenant: &str) -> TenantCipher {
        crate::ensure_test_cipher();
        tenant_cipher(tenant).unwrap()
    }

    fn migrate(
        dir: &ScratchDir,
        tenant: &str,
        unreadable: UnreadableLegacyState,
    ) -> Result<LegacyMigration> {
        IdentityStore::migrate_legacy_database(&db_path(dir), &test_tenant(tenant), unreadable)
    }

    fn unmigrated(error: &anyhow::Error) -> Option<&UnmigratedLegacyState> {
        error.downcast_ref::<UnmigratedLegacyState>()
    }

    fn open_error(dir: &ScratchDir, tenant: &str) -> anyhow::Error {
        match IdentityStore::open_for_tenant(dir.path(), tenant) {
            Ok(_) => panic!("the tenant store must not open"),
            Err(error) => error,
        }
    }

    /// Run SQL against the on-disk store as someone with write access to the
    /// data directory but no key.
    fn tamper(dir: &ScratchDir, sql: &str, values: &[&str]) {
        let raw = Connection::open(db_path(dir)).unwrap();
        raw.execute(sql, rusqlite::params_from_iter(values))
            .unwrap();
    }

    fn stored_value(dir: &ScratchDir, id: &str) -> Option<String> {
        Connection::open(db_path(dir))
            .unwrap()
            .query_row(
                "SELECT encrypted_state FROM connections WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[tokio::test]
    async fn legacy_store_is_refused_until_an_explicit_migration_then_refuses_legacy_values() {
        crate::ensure_test_cipher();
        let dir = ScratchDir::new();
        // A store written by an earlier release (or Core): `enc:v1:` values.
        let (conn_id, oauth_id, legacy_value) = {
            let legacy = IdentityStore::open(dir.path()).unwrap();
            let conn = legacy
                .create("prof", "app.example.com", None)
                .await
                .unwrap();
            legacy
                .import_state(&conn.id, &SecretState::new("session=legacy".to_owned()))
                .await
                .unwrap();
            let oauth_id = upsert_mail(&legacy, "mail", "legacy-token").await;
            let value = raw_state(&legacy, "connections", &conn.id).await.unwrap();
            assert!(value.starts_with("enc:v1:"));
            (conn.id, oauth_id, value)
        };

        // Opening never migrates: it names the condition and changes nothing.
        let error = open_error(&dir, "tenant-a");
        assert_eq!(
            unmigrated(&error),
            Some(&UnmigratedLegacyState {
                tenant: "tenant-a".to_owned(),
                values: 2
            })
        );
        assert_eq!(stored_value(&dir, &conn_id).unwrap(), legacy_value);

        // The explicit migration reseals both values.
        let report = migrate(&dir, "tenant-a", UnreadableLegacyState::Quarantine).unwrap();
        assert_eq!(
            report,
            LegacyMigration {
                already_bound: false,
                resealed: 2,
                quarantined: vec![]
            }
        );
        let store = IdentityStore::open_for_tenant(dir.path(), "tenant-a").unwrap();
        for (table, id) in [
            ("connections", &conn_id),
            ("mcp_oauth_connections", &oauth_id),
        ] {
            let value = raw_state(&store, table, id).await.unwrap();
            assert!(value.starts_with("enc:v2:"), "{table}: {value}");
        }
        assert_eq!(
            store.open_state(&conn_id).await.unwrap().unwrap().expose(),
            "session=legacy"
        );
        assert!(store
            .open_mcp_oauth_state(&oauth_id)
            .await
            .unwrap()
            .unwrap()
            .expose()
            .contains("legacy-token"));
        // New writes are bound.
        store
            .import_state(&conn_id, &SecretState::new("session=new".to_owned()))
            .await
            .unwrap();
        let rewritten = raw_state(&store, "connections", &conn_id).await.unwrap();
        assert!(rewritten.starts_with("enc:v2:"));
        drop(store);

        // A second migration is a no-op.
        let again = migrate(&dir, "tenant-a", UnreadableLegacyState::Quarantine).unwrap();
        assert!(again.already_bound);
        assert_eq!(stored_value(&dir, &conn_id).unwrap(), rewritten);

        // A captured pre-migration value planted back is refused, not migrated,
        // and the store still opens (the record is intact).
        tamper(
            &dir,
            "UPDATE connections SET encrypted_state = ?2 WHERE id = ?1",
            &[&conn_id, &legacy_value],
        );
        let store = IdentityStore::open_for_tenant(dir.path(), "tenant-a").unwrap();
        let error = store.open_state(&conn_id).await.unwrap_err();
        assert_binding_refused(&error, BoundSealError::Unbound);
        assert!(
            migrate(&dir, "tenant-a", UnreadableLegacyState::Quarantine)
                .unwrap()
                .already_bound
        );
        assert_eq!(stored_value(&dir, &conn_id).unwrap(), legacy_value);
    }

    /// The reviewer's bypass: with write access but no key, make a converted
    /// store look never-migrated (clear its bound values, delete the binding
    /// record) and plant another tenant's pre-upgrade `enc:v1:` value, or
    /// attacker-chosen plaintext, into a row pointed at an attacker's domain.
    /// Opening must refuse it rather than bind the planted value to that row.
    #[tokio::test]
    async fn a_stripped_store_with_planted_legacy_state_is_refused_on_open() {
        crate::ensure_test_cipher();
        // Tenant B's pre-upgrade value, as found in an old backup.
        let tenant_b_backup_value = global_cipher().unwrap().seal("session=tenant-b").unwrap();
        for planted in [tenant_b_backup_value.as_str(), "cookie=attacker-chosen"] {
            let dir = ScratchDir::new();
            let (victim, attacker_row) = {
                let a = IdentityStore::open_for_tenant(dir.path(), "tenant-a").unwrap();
                let victim = a.create("prof", "app.example.com", None).await.unwrap();
                a.import_state(&victim.id, &SecretState::new("session=a".to_owned()))
                    .await
                    .unwrap();
                let attacker_row = a.create("prof", "attacker.example", None).await.unwrap();
                upsert_mail(&a, "mail", "token-a").await;
                // A row that went through reauth already has NULL state.
                let oauth = a
                    .list_mcp_oauth_connections("user_a", "com.example.mail")
                    .await
                    .unwrap();
                a.mark_mcp_oauth_reauth_required(&oauth[0].id)
                    .await
                    .unwrap();
                (victim.id, attacker_row.id)
            };
            tamper(&dir, "UPDATE connections SET encrypted_state = NULL", &[]);
            tamper(
                &dir,
                "UPDATE connections SET encrypted_state = ?2, status = 'AUTHENTICATED' WHERE id = ?1",
                &[&attacker_row, planted],
            );
            tamper(&dir, "DELETE FROM sealed_state_binding", &[]);

            let error = open_error(&dir, "tenant-a");
            assert_eq!(
                unmigrated(&error).map(|state| state.values),
                Some(1),
                "{error:#}"
            );
            // Nothing was bound: the planted value is exactly as written.
            assert_eq!(stored_value(&dir, &attacker_row).unwrap(), planted);
            assert!(stored_value(&dir, &victim).is_none());
        }
    }

    #[tokio::test]
    async fn migration_never_accepts_plaintext_and_quarantines_unreadable_rows() {
        crate::ensure_test_cipher();
        let dir = ScratchDir::new();
        let (good, foreign, plaintext) = {
            let legacy = IdentityStore::open(dir.path()).unwrap();
            let good = legacy.create("prof", "good.example", None).await.unwrap();
            legacy
                .import_state(&good.id, &SecretState::new("session=good".to_owned()))
                .await
                .unwrap();
            let foreign = legacy
                .create("prof", "foreign.example", None)
                .await
                .unwrap();
            let plaintext = legacy.create("prof", "plain.example", None).await.unwrap();
            (good.id, foreign.id, plaintext.id)
        };
        let foreign_value = ryu_crypto::FieldCipher::new(&[9u8; 32]).seal("x").unwrap();
        for (id, value) in [
            (&foreign, foreign_value.as_str()),
            (&plaintext, "cookie=attacker-chosen"),
        ] {
            tamper(
                &dir,
                "UPDATE connections SET encrypted_state = ?2, status = 'AUTHENTICATED' WHERE id = ?1",
                &[id, value],
            );
        }

        // An all-or-nothing caller (import) changes nothing.
        let error = migrate(&dir, "tenant-a", UnreadableLegacyState::Abort).unwrap_err();
        let message = format!("{error:#}");
        assert!(
            message.contains(&foreign) && message.contains(&plaintext),
            "{message}"
        );
        assert!(stored_value(&dir, &plaintext).is_some());
        assert!(open_error(&dir, "tenant-a")
            .downcast_ref::<UnmigratedLegacyState>()
            .is_some());

        // The upgrade path quarantines the two rows instead of stopping the tenant.
        let report = migrate(&dir, "tenant-a", UnreadableLegacyState::Quarantine).unwrap();
        assert_eq!(report.resealed, 1);
        let mut quarantined = report
            .quarantined
            .iter()
            .map(|row| (row.table, row.id.clone(), row.reason))
            .collect::<Vec<_>>();
        quarantined.sort();
        let mut expected = vec![
            ("connections", foreign.clone(), "enc:v1 value does not open"),
            ("connections", plaintext.clone(), "not an enc:v1 envelope"),
        ];
        expected.sort();
        assert_eq!(quarantined, expected);

        let store = IdentityStore::open_for_tenant(dir.path(), "tenant-a").unwrap();
        assert_eq!(
            store.open_state(&good).await.unwrap().unwrap().expose(),
            "session=good"
        );
        for id in [&foreign, &plaintext] {
            let record = store.get(id).await.unwrap().unwrap();
            assert!(record.encrypted_state.is_none());
            assert_eq!(record.status, ConnectionStatus::NeedsAuth);
            assert!(store.open_state(id).await.unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn migration_with_the_wrong_master_key_changes_nothing() {
        crate::ensure_test_cipher();
        let dir = ScratchDir::new();
        let conn_id = {
            let legacy = IdentityStore::open(dir.path()).unwrap();
            legacy
                .create("prof", "app.example.com", None)
                .await
                .unwrap()
                .id
        };
        // Every legacy value is sealed under some other master key.
        let foreign = ryu_crypto::FieldCipher::new(&[9u8; 32]).seal("x").unwrap();
        tamper(
            &dir,
            "UPDATE connections SET encrypted_state = ?2 WHERE id = ?1",
            &[&conn_id, &foreign],
        );
        let error = migrate(&dir, "tenant-a", UnreadableLegacyState::Quarantine).unwrap_err();
        assert!(format!("{error:#}").contains("RYU_MASTER_KEY"), "{error:#}");
        assert_eq!(stored_value(&dir, &conn_id).unwrap(), foreign);
        let records: i64 = Connection::open(db_path(&dir))
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'sealed_state_binding'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            records, 0,
            "the whole migration, binding table included, rolls back"
        );
    }

    #[tokio::test]
    async fn tenant_open_refuses_another_tenants_store_and_migration_refuses_an_altered_one() {
        crate::ensure_test_cipher();
        let dir_a = ScratchDir::new();
        let dir_b = ScratchDir::new();
        let conn_id = {
            let a = IdentityStore::open_for_tenant(dir_a.path(), "tenant-a").unwrap();
            let conn = a.create("prof", "app.example.com", None).await.unwrap();
            a.import_state(&conn.id, &SecretState::new("session=a".to_owned()))
                .await
                .unwrap();
            conn.id
        };
        // The whole database file moved into another tenant's directory.
        std::fs::copy(db_path(&dir_a), db_path(&dir_b)).unwrap();
        let error = open_error(&dir_b, "tenant-b");
        assert!(
            format!("{error:#}").contains("not bound to tenant `tenant-b`"),
            "{error:#}"
        );
        assert!(migrate(&dir_b, "tenant-b", UnreadableLegacyState::Quarantine).is_err());

        // A deleted record alone admits nothing: only bound values remain, so
        // opening recreates it and each value still verifies.
        tamper(&dir_a, "DELETE FROM sealed_state_binding", &[]);
        {
            let a = IdentityStore::open_for_tenant(dir_a.path(), "tenant-a").unwrap();
            assert_eq!(
                a.open_state(&conn_id).await.unwrap().unwrap().expose(),
                "session=a"
            );
        }
        // An explicit migration refuses a converted store that lost its record.
        tamper(&dir_a, "DELETE FROM sealed_state_binding", &[]);
        let error = migrate(&dir_a, "tenant-a", UnreadableLegacyState::Quarantine).unwrap_err();
        assert!(format!("{error:#}").contains("no binding"), "{error:#}");
    }

    #[tokio::test]
    async fn tenant_mcp_oauth_state_is_bound_to_its_row_and_resource() {
        let store = IdentityStore::open_in_memory_for_tenant("tenant-a").unwrap();
        let mail = upsert_mail(&store, "mail", "first").await;
        // An upsert onto the same binding keeps the row id and stays openable.
        assert_eq!(upsert_mail(&store, "mail", "rotated").await, mail);
        let calendar = upsert_mail(&store, "calendar", "other").await;
        assert!(store
            .open_mcp_oauth_state(&mail)
            .await
            .unwrap()
            .unwrap()
            .expose()
            .contains("rotated"));

        let mail_value = raw_state(&store, "mcp_oauth_connections", &mail)
            .await
            .unwrap();
        assert!(mail_value.starts_with("enc:v2:"));
        let calendar_value = raw_state(&store, "mcp_oauth_connections", &calendar)
            .await
            .unwrap();
        set_raw_state(&store, "mcp_oauth_connections", &mail, &calendar_value).await;
        let error = store.open_mcp_oauth_state(&mail).await.unwrap_err();
        assert_binding_refused(&error, BoundSealError::Mismatch);

        // Redirecting the row to another resource server is refused.
        set_raw_state(&store, "mcp_oauth_connections", &mail, &mail_value).await;
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE mcp_oauth_connections SET resource_uri = 'https://evil.example/'
                 WHERE id = ?1",
                params![mail],
            )
            .unwrap();
        }
        let error = store.open_mcp_oauth_state(&mail).await.unwrap_err();
        assert_binding_refused(&error, BoundSealError::Mismatch);
    }

    #[tokio::test]
    async fn unbound_store_refuses_tenant_bound_values() {
        let bound = IdentityStore::open_in_memory_for_tenant("tenant-a").unwrap();
        let conn = bound.create("prof", "app.example.com", None).await.unwrap();
        bound
            .import_state(&conn.id, &SecretState::new("session=a".to_owned()))
            .await
            .unwrap();
        let sealed = raw_state(&bound, "connections", &conn.id).await.unwrap();

        let unbound = IdentityStore::open_in_memory().unwrap();
        let local = unbound
            .create("prof", "app.example.com", None)
            .await
            .unwrap();
        set_raw_state(&unbound, "connections", &local.id, &sealed).await;
        // Without the guard, `FieldCipher::open` would hand back the envelope
        // text as if it were legacy plaintext credential state.
        let error = unbound.open_state(&local.id).await.unwrap_err();
        assert_binding_refused(&error, BoundSealError::Unbound);
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

fn row_to_mcp_oauth_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<McpOAuthConnectionRecord> {
    let status: String = row.get(7)?;
    let scopes_json: String = row.get(9)?;
    let encrypted_state: Option<String> = row.get(11)?;
    Ok(McpOAuthConnectionRecord {
        id: row.get(0)?,
        owner_user_id: row.get(1)?,
        profile_id: row.get(2)?,
        plugin_id: row.get(3)?,
        server_name: row.get(4)?,
        resource_uri: row.get(5)?,
        issuer: row.get(6)?,
        status: McpOAuthConnectionStatus::from_str(&status),
        account_label: row.get(8)?,
        scopes: serde_json::from_str(&scopes_json).unwrap_or_default(),
        expires_at: row.get(10)?,
        encrypted_state: encrypted_state.map(SealedState::new),
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}
