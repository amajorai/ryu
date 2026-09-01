//! App lifecycle store: persisted install/enable state for Ryu Apps.
//!
//! Core owns *what runs*, so the install/enable/disable/update lifecycle lives
//! here, backed by SQLite (mirroring the [`crate::agents::AgentStore`] pattern).
//!
//! ## Core-vs-Gateway boundary
//!
//! - **Core** (this module): tracks *lifecycle state* — is the app installed,
//!   is it enabled, which version is installed, which grants were approved.
//! - **Gateway**: decides *whether a grant is allowed*. When an app is enabled,
//!   Core calls the Gateway's `/v1/grants/validate` endpoint for each declared
//!   grant. Core stores the result but contains no inline policy decision.
//!   If the Gateway is unreachable, enable fails closed (app stays disabled).
//!
//! ## Semver
//!
//! [`PluginStore::update`] compares the new manifest version against the installed
//! version and refuses a downgrade unless `force = true`.

pub mod app_contrib;
pub mod binding;
pub mod builtins;
pub mod catalog;
pub mod graph;
pub mod isolation;
pub mod lifecycle;
pub mod runtime;
pub mod seed;

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::governance::{resolve_field, GovernanceScope, HookPolicyOverride, ScopedValue};
use crate::sidecar::download_manager::ryu_dir;

// ── Record types ──────────────────────────────────────────────────────────────

/// A persisted App lifecycle record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginRecord {
    /// Reverse-domain app id (e.g. `"com.example.my-app"`), matches the
    /// manifest's `id` field.
    pub id: String,
    /// Installed semver version string (e.g. `"1.0.0"`).
    pub version: String,
    /// Whether the app is currently enabled (its Runnables are active).
    pub enabled: bool,
    /// JSON-serialised list of grants that were approved by the Gateway on
    /// the last successful enable. Empty when never enabled or last enable
    /// failed.
    #[serde(default)]
    pub approved_grants: Vec<String>,
    /// The release channel this install FOLLOWS — `stable`, `beta`, `nightly`,
    /// `canary`, … — i.e. the train `POST /api/plugins/:id/update` re-resolves on.
    ///
    /// Absent in the column ⇒ derived from the installed version's own prerelease
    /// identifier ([`crate::update::channel_of`]), the same self-describing rule
    /// Core applies to its own builds: a record sitting on `1.2.0-beta.3` follows
    /// `beta` without anyone having stored a preference. The column exists for the
    /// intent the version string cannot express — someone who picks `canary` on a
    /// listing whose canary train has no build yet still stays on `canary` rather
    /// than being silently re-pinned to whatever they happen to have installed.
    #[serde(default = "default_channel")]
    pub channel: String,
    /// Where this install came from, captured at install time — the catalog
    /// source, the publishing org, and whether that org carried the marketplace
    /// identity check *then*. Drives [`isolation::TrustBasis`].
    ///
    /// `None` means nothing was captured (the record predates the column, or the
    /// install path supplied none). That reads as **untrusted**, never as
    /// trusted-by-default; see [`isolation::TrustPolicy::resolve_trust`].
    #[serde(default)]
    pub provenance: Option<isolation::PluginProvenance>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// The channel a record follows when nothing else says otherwise. Serde's default
/// for [`PluginRecord::channel`], so a record persisted before the column existed
/// deserializes onto the stable train rather than an empty string.
fn default_channel() -> String {
    crate::update::STABLE_CHANNEL.to_owned()
}

/// Result of a grant-validation call to the Gateway.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrantValidationResult {
    /// Grants that the Gateway approved.
    pub approved: Vec<String>,
    /// Grants that the Gateway denied.
    pub denied: Vec<String>,
    /// Whether all requested grants were approved.
    pub all_approved: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookOverrideRecord {
    pub hook_key: String,
    pub managed: bool,
    pub policy: HookPolicyOverride,
    pub scope: GovernanceScope,
}

fn governance_scope_key(scope: GovernanceScope) -> &'static str {
    match scope {
        GovernanceScope::Node => "node",
        GovernanceScope::Organization => "organization",
        GovernanceScope::Team => "team",
        GovernanceScope::User => "user",
    }
}

fn parse_governance_scope(value: &str) -> Option<GovernanceScope> {
    match value {
        "node" => Some(GovernanceScope::Node),
        "organization" => Some(GovernanceScope::Organization),
        "team" => Some(GovernanceScope::Team),
        "user" => Some(GovernanceScope::User),
        _ => None,
    }
}

fn resolve_hook_override_records(
    records: &[HookOverrideRecord],
    hook_key: &str,
) -> HookPolicyOverride {
    let field = |pick: fn(&HookPolicyOverride) -> Option<bool>| {
        resolve_field(
            [
                GovernanceScope::Node,
                GovernanceScope::Organization,
                GovernanceScope::Team,
                GovernanceScope::User,
            ]
            .into_iter()
            .map(|scope| {
                let value = records
                    .iter()
                    .filter(|record| record.hook_key == hook_key && record.scope == scope)
                    .find_map(|record| pick(&record.policy));
                ScopedValue::new(scope, value)
            }),
        )
        .map(|resolved| resolved.value)
    };
    HookPolicyOverride {
        enabled: field(|policy| policy.enabled),
        trusted: field(|policy| policy.trusted),
    }
}

/// Resolve the plugins lifecycle DB path.
///
/// Defaults to `~/.ryu/plugins.db`. To avoid orphaning installs made before the
/// apps→plugins rename, if the new DB does not exist but the legacy
/// `~/.ryu/apps.db` does, the legacy path is used.
fn db_path() -> PathBuf {
    let dir = ryu_dir();
    let new_path = dir.join("plugins.db");
    let legacy_path = dir.join("apps.db");
    if !new_path.exists() && legacy_path.exists() {
        return legacy_path;
    }
    new_path
}

/// SQLite-backed store for App lifecycle records. Cheap to clone (`Arc` inside).
#[derive(Clone)]
pub struct PluginStore {
    conn: Arc<Mutex<Connection>>,
}

impl PluginStore {
    /// Open (creating if needed) the plugins DB under `~/.ryu/plugins.db`
    /// (falling back to the legacy `~/.ryu/apps.db` when present) and run the
    /// schema migration.
    pub fn open() -> Result<Self> {
        let path = db_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).context("creating ~/.ryu for plugins.db")?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening plugins db at {}", path.display()))?;
        Self::migrate(&conn)?;
        Self::record_verified_official_packages(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// In-memory store, used by tests.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::migrate(&conn)?;
        Self::record_verified_official_packages(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn migrate(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS apps (
                id              TEXT PRIMARY KEY,
                version         TEXT NOT NULL,
                enabled         INTEGER NOT NULL DEFAULT 0,
                approved_grants TEXT NOT NULL DEFAULT '[]',
                created_at      TEXT NOT NULL,
                updated_at      TEXT NOT NULL
            );",
        )
        .context("running apps schema migration")?;

        // Additive column for the third-party plugin runtime slice: the plugin's
        // bundled sandboxed-UI code, stored at (local) install and served ONLY for
        // an enabled plugin over `GET /api/plugins/:id/ui-bundle`. `ALTER TABLE ADD
        // COLUMN` errors if the column already exists, so tolerate that one error
        // and surface any other (keeps the migration idempotent across restarts).
        if let Err(e) = conn.execute("ALTER TABLE apps ADD COLUMN ui_code TEXT", []) {
            let msg = e.to_string();
            if !msg.contains("duplicate column name") {
                return Err(e).context("adding apps.ui_code column");
            }
        }

        // Additive column for release channels: the train this install follows.
        // Deliberately NULLable with no default backfill — a NULL reads as "derive
        // it from the installed version" ([`row_to_record`]), so every pre-existing
        // row keeps describing itself correctly (a record on `1.2.0-beta.3` follows
        // `beta`) instead of being force-written onto `stable`.
        if let Err(e) = conn.execute("ALTER TABLE apps ADD COLUMN channel TEXT", []) {
            let msg = e.to_string();
            if !msg.contains("duplicate column name") {
                return Err(e).context("adding apps.channel column");
            }
        }

        // Additive column for install provenance: which catalog source served this
        // install, which org published it, and whether that org carried the
        // marketplace identity check AT INSTALL TIME. Stored as JSON
        // ([`isolation::PluginProvenance`]).
        //
        // NULL is meaningful and is the ONLY safe reading for a pre-existing row:
        // "nothing was captured", which resolves to
        // [`isolation::TrustBasis::Untrusted`]. Deliberately NOT backfilled — a
        // backfill would have to invent a provenance nobody observed, and the one
        // value it could invent (trusted) is exactly the wrong default.
        if let Err(e) = conn.execute("ALTER TABLE apps ADD COLUMN provenance TEXT", []) {
            let msg = e.to_string();
            if !msg.contains("duplicate column name") {
                return Err(e).context("adding apps.provenance column");
            }
        }
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS hook_overrides (
                scope      TEXT NOT NULL,
                hook_key   TEXT NOT NULL,
                enabled    INTEGER,
                trusted    INTEGER,
                managed    INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (scope, hook_key, managed)
            );",
        )
        .context("creating hook_overrides table")?;
        Ok(())
    }

    fn record_verified_official_packages(conn: &Connection) -> Result<()> {
        let mut stmt =
            conn.prepare("SELECT id, provenance FROM apps WHERE provenance IS NOT NULL")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, json) = row?;
            if let Ok(provenance) = serde_json::from_str::<isolation::PluginProvenance>(&json) {
                // The manifest fingerprint is checked when the loaded manifest
                // asks for tier; the store only rehydrates the captured digest.
                crate::plugins::builtins::record_verified_official_digest(&id, &provenance);
            }
        }
        Ok(())
    }

    /// The store's one-time-migration counter (SQLite's own `PRAGMA user_version`,
    /// which lives in the db header and defaults to 0 on every pre-existing file).
    ///
    /// Distinct from [`Self::migrate`]: that runs `CREATE TABLE IF NOT EXISTS` /
    /// tolerated `ALTER TABLE` on EVERY open because those are idempotent. A DATA
    /// backfill is not idempotent in the same sense — re-running it would keep
    /// re-asserting a value the user is entitled to change afterwards — so it must
    /// run exactly once per install. See [`Self::run_one_time_migrations`].
    pub async fn schema_version(&self) -> Result<i64> {
        let conn = self.conn.lock().await;
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        Ok(v)
    }

    async fn set_schema_version(&self, version: i64) -> Result<()> {
        let conn = self.conn.lock().await;
        // PRAGMA does not accept a bound parameter, hence the format!. `version` is
        // an i64 the caller supplies from a const below, never user input.
        conn.execute_batch(&format!("PRAGMA user_version = {version}"))?;
        Ok(())
    }

    /// Move an app's lifecycle record from `from` to `to` — the plugin-id rename.
    ///
    /// The record carries the user's enabled/disabled choice AND the Gateway-approved
    /// grant set, neither of which is re-derivable: `set_enabled` is the only writer
    /// of `approved_grants`, so a lost record means the app silently reverts to
    /// disabled-and-ungranted and the user has to re-approve everything.
    ///
    /// A no-op when `to` already exists (a re-run, or the app was installed fresh
    /// under its new id): the newer record wins and the legacy row is dropped, so the
    /// migration is safe to attempt more than once.
    ///
    /// Returns true when a legacy record was actually moved.
    ///
    /// # Errors
    /// Returns `Err` if the underlying SQLite statements fail.
    pub async fn rekey(&self, from: &str, to: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        // `UPDATE OR IGNORE` leaves the row in place when `to` is already taken;
        // the DELETE below then reaps it either way.
        conn.execute(
            "UPDATE OR IGNORE apps SET id = ?2 WHERE id = ?1",
            params![from, to],
        )?;
        let removed = conn.execute("DELETE FROM apps WHERE id = ?1", params![from])?;
        Ok(removed > 0)
    }

    /// Union `grants` into an app's approved set WITHOUT touching `enabled`.
    ///
    /// Additive only — it can never revoke. Used by the one-time backfill, which must
    /// not disturb grants the user has already curated.
    pub async fn add_approved_grants(
        &self,
        id: &str,
        grants: &[String],
    ) -> Result<Option<PluginRecord>> {
        let Some(record) = self.get(id).await? else {
            return Ok(None);
        };
        let mut merged = record.approved_grants.clone();
        for grant in grants {
            if !merged.iter().any(|g| g == grant) {
                merged.push(grant.clone());
            }
        }
        if merged.len() == record.approved_grants.len() {
            return Ok(Some(record));
        }
        let grants_json = serde_json::to_string(&merged).unwrap_or_else(|_| "[]".to_owned());
        let now = chrono::Utc::now().to_rfc3339();
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "UPDATE apps SET approved_grants = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, grants_json, now],
            )?;
        }
        self.get(id).await
    }

    /// Insert a new app record (install). Fails if an app with the same id is
    /// already present (use `update_version` for upgrades).
    pub async fn insert(&self, id: &str, version: &str) -> Result<PluginRecord> {
        self.insert_with_provenance(id, version, None).await
    }

    /// Insert a new app record, recording where the install came from.
    ///
    /// Passing `None` is honest, not lax — it says the install path could not
    /// observe a provenance (a local sideload, a path with no catalog item behind
    /// it). It resolves to [`isolation::TrustBasis::Untrusted`], which is the
    /// correct reading of "we do not know".
    pub async fn insert_with_provenance(
        &self,
        id: &str,
        version: &str,
        provenance: Option<&isolation::PluginProvenance>,
    ) -> Result<PluginRecord> {
        let now = chrono::Utc::now().to_rfc3339();
        let provenance_json = provenance.and_then(|p| serde_json::to_string(p).ok());
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO apps (id, version, enabled, approved_grants, created_at, updated_at, provenance)
             VALUES (?1, ?2, 0, '[]', ?3, ?3, ?4)",
            params![id, version, now, provenance_json],
        )
        .with_context(|| format!("inserting app '{id}'"))?;
        Ok(PluginRecord {
            id: id.to_owned(),
            version: version.to_owned(),
            enabled: false,
            approved_grants: vec![],
            channel: crate::update::channel_of(version),
            provenance: provenance.cloned(),
            created_at: Some(now.clone()),
            updated_at: Some(now),
        })
        .inspect(|_| {
            crate::plugins::builtins::clear_verified_official_digest(id);
            if let Some(provenance) = provenance {
                crate::plugins::builtins::record_verified_official_digest(id, provenance);
            }
        })
    }

    /// Record (or refresh) an install's provenance.
    ///
    /// Written by the catalog-resolve install path once it knows which source
    /// served the item, and again on update — an update re-observes the publisher,
    /// which is the point at which a revoked verification stops counting.
    pub async fn set_provenance(
        &self,
        id: &str,
        provenance: Option<&isolation::PluginProvenance>,
    ) -> Result<Option<PluginRecord>> {
        let provenance_json = provenance.and_then(|p| serde_json::to_string(p).ok());
        let now = chrono::Utc::now().to_rfc3339();
        {
            let conn = self.conn.lock().await;
            let rows_affected = conn.execute(
                "UPDATE apps SET provenance = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, provenance_json, now],
            )?;
            if rows_affected == 0 {
                return Ok(None);
            }
        }
        crate::plugins::builtins::clear_verified_official_digest(id);
        if let Some(provenance) = provenance {
            crate::plugins::builtins::record_verified_official_digest(id, provenance);
        }
        self.get_record(id).await
    }

    /// Pin the release channel this install follows (`stable`, `beta`, `nightly`,
    /// `canary`, …). Written at install when the user chose a channel, and by the
    /// channel-switch half of the update handler.
    ///
    /// Stores the channel LOWERCASED and trimmed, matching
    /// [`crate::update::pick_version_for_channel`]'s comparison, so `Beta` and
    /// `beta` can never become two trains. Passing `None` clears the pin, which
    /// returns the record to deriving its channel from the installed version.
    ///
    /// Does NOT touch `version`: pinning a channel expresses which train to follow
    /// from now on, and the move onto that train is a separate, explicit update.
    pub async fn set_channel(
        &self,
        id: &str,
        channel: Option<&str>,
    ) -> Result<Option<PluginRecord>> {
        let normalized = channel
            .map(|c| c.trim().to_ascii_lowercase())
            .filter(|c| !c.is_empty());
        let now = chrono::Utc::now().to_rfc3339();
        {
            let conn = self.conn.lock().await;
            let rows_affected = conn.execute(
                "UPDATE apps SET channel = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, normalized, now],
            )?;
            if rows_affected == 0 {
                return Ok(None);
            }
        }
        self.get(id).await
    }

    /// Fetch a single app record by id, **as it should run right now**.
    ///
    /// Masked by Safe Mode exactly like [`Self::list`], and for the same reason:
    /// this is the read behind the per-plugin runtime gates (the sandboxed plugin
    /// bridge, the ext-proxy mount, the UI-bundle serve), and every one of them
    /// keys on `enabled`. See [`Self::get_record`] for the raw read.
    pub async fn get(&self, id: &str) -> Result<Option<PluginRecord>> {
        let Some(record) = self.get_record(id).await? else {
            return Ok(None);
        };
        Ok(apply_safe_mode_mask(vec![record], crate::safe_mode::is_active()).pop())
    }

    /// The RAW record for `id`, unmasked by Safe Mode. Lifecycle and management
    /// callers only — see [`Self::list_all_records`] for the full rule.
    pub async fn get_record(&self, id: &str) -> Result<Option<PluginRecord>> {
        let conn = self.conn.lock().await;
        let record = conn
            .query_row(
                "SELECT id, version, enabled, approved_grants, created_at, updated_at, channel,
                        provenance
                 FROM apps WHERE id = ?1",
                params![id],
                row_to_record,
            )
            .optional()?;
        Ok(record)
    }

    /// List all app records, **as they should run right now**.
    ///
    /// This is the read every runtime consumer uses, and every one of them filters
    /// on `enabled` — so this is the single seam Safe Mode masks: while
    /// [`crate::safe_mode::is_active`], every record outside the kernel tiers is
    /// reported `enabled = false` with its grants cleared. Hooks, adapters, plugin
    /// sidecars, plugin MCP servers, contributed panels and ext-proxy routes all
    /// fall out of that one change.
    ///
    /// The masked read is the DEFAULT name deliberately. A caller that should have
    /// used the raw one and didn't gets a cosmetic bug (a Store row rendering as
    /// off); the reverse mistake spawns a process safe mode exists to keep from
    /// spawning. See [`Self::list_all_records`] for the raw read, and note that
    /// nothing here writes: the persisted `enabled` bit is never touched, which is
    /// what makes leaving safe mode a no-op.
    pub async fn list(&self) -> Result<Vec<PluginRecord>> {
        let rows = self.list_all_records().await?;
        Ok(apply_safe_mode_mask(rows, crate::safe_mode::is_active()))
    }

    /// The RAW lifecycle rows, unmasked by Safe Mode.
    ///
    /// Only two kinds of caller may use this: the **lifecycle** paths
    /// (enable/disable/uninstall and their dependency resolution), which must see
    /// and edit the user's real choices even while safe mode is masking them, and
    /// the **management/Store surface**, which renders "installed, and disabled by
    /// Safe Mode" rather than pretending the user turned everything off. Nothing
    /// that spawns, injects, or routes may read this.
    pub async fn list_all_records(&self) -> Result<Vec<PluginRecord>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, version, enabled, approved_grants, created_at, updated_at, channel,
                        provenance
             FROM apps ORDER BY created_at ASC",
        )?;
        let rows = stmt
            .query_map([], row_to_record)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub async fn upsert_hook_override(
        &self,
        scope: GovernanceScope,
        hook_key: &str,
        policy: &HookPolicyOverride,
        managed: bool,
    ) -> Result<()> {
        let hook_key = hook_key.trim();
        if hook_key.is_empty() || hook_key.len() > 512 {
            anyhow::bail!("hook key must be between 1 and 512 characters");
        }
        let conn = self.conn.lock().await;
        if policy.enabled.is_none() && policy.trusted.is_none() {
            conn.execute(
                "DELETE FROM hook_overrides
                 WHERE scope = ?1 AND hook_key = ?2 AND managed = ?3",
                params![governance_scope_key(scope), hook_key, i64::from(managed)],
            )?;
            return Ok(());
        }
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO hook_overrides
                (scope, hook_key, enabled, trusted, managed, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(scope, hook_key, managed) DO UPDATE SET
                enabled = excluded.enabled,
                trusted = excluded.trusted,
                managed = excluded.managed,
                updated_at = excluded.updated_at",
            params![
                governance_scope_key(scope),
                hook_key,
                policy.enabled.map(i64::from),
                policy.trusted.map(i64::from),
                i64::from(managed),
                now,
            ],
        )?;
        Ok(())
    }

    pub async fn list_hook_overrides(&self) -> Result<Vec<HookOverrideRecord>> {
        let conn = self.conn.lock().await;
        let mut statement = conn.prepare(
            "SELECT scope, hook_key, enabled, trusted, managed
             FROM hook_overrides ORDER BY hook_key, scope, managed ASC",
        )?;
        let rows = statement.query_map([], |row| {
            let scope: String = row.get(0)?;
            let enabled: Option<i64> = row.get(2)?;
            let trusted: Option<i64> = row.get(3)?;
            Ok((
                scope,
                row.get::<_, String>(1)?,
                enabled,
                trusted,
                row.get::<_, i64>(4)? != 0,
            ))
        })?;
        let mut records = Vec::new();
        for row in rows {
            let (scope, hook_key, enabled, trusted, managed) = row?;
            let Some(scope) = parse_governance_scope(&scope) else {
                continue;
            };
            records.push(HookOverrideRecord {
                hook_key,
                managed,
                policy: HookPolicyOverride {
                    enabled: enabled.map(|value| value != 0),
                    trusted: trusted.map(|value| value != 0),
                },
                scope,
            });
        }
        Ok(records)
    }

    pub async fn effective_hook_override(&self, hook_key: &str) -> Result<HookPolicyOverride> {
        let records = self.list_hook_overrides().await?;
        Ok(resolve_hook_override_records(&records, hook_key))
    }

    pub async fn effective_hook_overrides(&self) -> Result<BTreeMap<String, HookPolicyOverride>> {
        let records = self.list_hook_overrides().await?;
        let hook_keys: BTreeSet<&str> = records
            .iter()
            .map(|record| record.hook_key.as_str())
            .collect();
        Ok(hook_keys
            .into_iter()
            .map(|hook_key| {
                (
                    hook_key.to_owned(),
                    resolve_hook_override_records(&records, hook_key),
                )
            })
            .collect())
    }

    pub async fn replace_managed_hook_overrides(
        &self,
        scope: GovernanceScope,
        overrides: &BTreeMap<String, HookPolicyOverride>,
    ) -> Result<()> {
        if scope == GovernanceScope::Node {
            anyhow::bail!("node hook overrides are local, not managed");
        }
        for hook_key in overrides.keys() {
            if hook_key.trim().is_empty() || hook_key.len() > 512 {
                anyhow::bail!("hook key must be between 1 and 512 characters");
            }
        }
        let mut conn = self.conn.lock().await;
        let transaction = conn.transaction()?;
        transaction.execute(
            "DELETE FROM hook_overrides WHERE scope = ?1 AND managed = 1",
            params![governance_scope_key(scope)],
        )?;
        let now = chrono::Utc::now().to_rfc3339();
        for (hook_key, policy) in overrides {
            if policy.enabled.is_none() && policy.trusted.is_none() {
                continue;
            }
            transaction.execute(
                "INSERT INTO hook_overrides
                    (scope, hook_key, enabled, trusted, managed, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 1, ?5)",
                params![
                    governance_scope_key(scope),
                    hook_key,
                    policy.enabled.map(i64::from),
                    policy.trusted.map(i64::from),
                    now,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Flip `enabled` to true and persist the approved grants.
    pub async fn set_enabled(
        &self,
        id: &str,
        approved_grants: &[String],
    ) -> Result<Option<PluginRecord>> {
        let grants_json =
            serde_json::to_string(approved_grants).unwrap_or_else(|_| "[]".to_owned());
        let now = chrono::Utc::now().to_rfc3339();
        {
            let conn = self.conn.lock().await;
            let rows_affected = conn.execute(
                "UPDATE apps SET enabled = 1, approved_grants = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, grants_json, now],
            )?;
            if rows_affected == 0 {
                return Ok(None);
            }
        }
        self.get(id).await
    }

    /// Flip `enabled` to false and clear the approved grants.
    pub async fn set_disabled(&self, id: &str) -> Result<Option<PluginRecord>> {
        let now = chrono::Utc::now().to_rfc3339();
        {
            let conn = self.conn.lock().await;
            let rows_affected = conn.execute(
                "UPDATE apps SET enabled = 0, approved_grants = '[]', updated_at = ?2 WHERE id = ?1",
                params![id, now],
            )?;
            if rows_affected == 0 {
                return Ok(None);
            }
        }
        self.get(id).await
    }

    /// Update the installed version of an app (used by the update lifecycle).
    /// Does NOT toggle `enabled` — that is handled by `set_enabled`.
    pub async fn set_version(&self, id: &str, version: &str) -> Result<Option<PluginRecord>> {
        let now = chrono::Utc::now().to_rfc3339();
        {
            let conn = self.conn.lock().await;
            let rows_affected = conn.execute(
                "UPDATE apps SET version = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, version, now],
            )?;
            if rows_affected == 0 {
                return Ok(None);
            }
        }
        self.get(id).await
    }

    /// Remove an app record (uninstall).
    pub async fn remove(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute("DELETE FROM apps WHERE id = ?1", params![id])?;
        drop(conn);
        if n > 0 {
            crate::plugins::builtins::clear_verified_official_digest(id);
        }
        Ok(n > 0)
    }

    /// Store (or clear) the plugin's bundled sandboxed-UI code on its record.
    /// Called at (local) install carriage. Returns `false` when no such record
    /// exists (install must precede setting code).
    pub async fn set_ui_code(&self, id: &str, ui_code: Option<&str>) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "UPDATE apps SET ui_code = ?2 WHERE id = ?1",
            params![id, ui_code],
        )?;
        Ok(n > 0)
    }

    /// Fetch the plugin's bundled UI code, if any. Served ONLY for an enabled
    /// plugin by the `ui-bundle` endpoint (enabled-state gating is the caller's
    /// responsibility, kept next to the token/loopback checks).
    pub async fn get_ui_code(&self, id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        let code: Option<Option<String>> = conn
            .query_row(
                "SELECT ui_code FROM apps WHERE id = ?1",
                params![id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?;
        Ok(code.flatten())
    }

    /// Whether the plugin has a stored UI bundle (cheap presence check for the
    /// contributions payload's `has_ui` flag — avoids loading the whole blob).
    pub async fn has_ui_code(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let present: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM apps WHERE id = ?1 AND ui_code IS NOT NULL",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(present.is_some())
    }
}

/// The Safe Mode read mask, as a pure function of the rows and the flag.
///
/// Pure and `active`-parameterised on purpose: the flag itself is a process-global
/// resolved once at boot, so a test that flipped it would leak safe mode into every
/// other test sharing the binary. This way the masking contract is asserted without
/// touching the global, and [`PluginStore::list`] / [`PluginStore::get`] are one
/// line each over it.
///
/// Records outside the kernel tiers come back `enabled = false` with their grants
/// cleared — grants for the same reason [`PluginStore::set_disabled`] clears them:
/// a masked-off plugin must not still present an approved `sidecar:process` (or
/// any other) grant to a gate that reads grants without re-checking `enabled`.
fn apply_safe_mode_mask(records: Vec<PluginRecord>, active: bool) -> Vec<PluginRecord> {
    if !active {
        return records;
    }
    records
        .into_iter()
        .map(|mut record| {
            if !crate::safe_mode::keeps_plugin_enabled(&record.id) {
                record.enabled = false;
                record.approved_grants.clear();
            }
            record
        })
        .collect()
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<PluginRecord> {
    let grants_json: String = row.get(3)?;
    let approved_grants = serde_json::from_str(&grants_json).unwrap_or_default();
    let version: String = row.get(1)?;
    // A NULL/blank column means nobody pinned a channel: read it off the installed
    // version, which is self-describing. Never defaulted to `stable` here — that
    // would report a record sitting on `1.2.0-nightly.4` as a stable install and
    // then quietly move it to the stable train on its next update.
    let channel = row
        .get::<_, Option<String>>(6)?
        .map(|c| c.trim().to_ascii_lowercase())
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| crate::update::channel_of(&version));
    // A malformed provenance blob reads as absent rather than failing the row.
    // The failure mode that matters is the other direction: an unparseable value
    // must never resolve to "trusted", and `None` is exactly the untrusted read.
    let provenance = row
        .get::<_, Option<String>>(7)?
        .and_then(|json| serde_json::from_str::<isolation::PluginProvenance>(&json).ok());
    Ok(PluginRecord {
        id: row.get(0)?,
        version,
        enabled: row.get::<_, i64>(2)? != 0,
        approved_grants,
        channel,
        provenance,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::governance::{GovernanceScope, HookPolicyOverride};

    fn store() -> PluginStore {
        PluginStore::open_in_memory().unwrap()
    }

    #[tokio::test]
    async fn hook_policy_fields_resolve_independently_by_scope() {
        let s = store();
        let key = "com.example.plugin::review";
        s.upsert_hook_override(
            GovernanceScope::Node,
            key,
            &HookPolicyOverride {
                enabled: Some(true),
                trusted: Some(false),
            },
            false,
        )
        .await
        .unwrap();
        s.upsert_hook_override(
            GovernanceScope::Team,
            key,
            &HookPolicyOverride {
                enabled: None,
                trusted: Some(true),
            },
            true,
        )
        .await
        .unwrap();
        s.upsert_hook_override(
            GovernanceScope::User,
            key,
            &HookPolicyOverride {
                enabled: Some(false),
                trusted: None,
            },
            false,
        )
        .await
        .unwrap();

        let effective = s.effective_hook_override(key).await.unwrap();
        assert_eq!(effective.enabled, Some(false));
        assert_eq!(effective.trusted, Some(true));
    }

    #[tokio::test]
    async fn replacing_managed_hook_overrides_preserves_local_choices() {
        let s = store();
        let key = "com.example.plugin::review";
        s.upsert_hook_override(
            GovernanceScope::User,
            key,
            &HookPolicyOverride {
                enabled: Some(false),
                trusted: None,
            },
            false,
        )
        .await
        .unwrap();

        s.replace_managed_hook_overrides(
            GovernanceScope::Organization,
            &BTreeMap::from([(
                key.to_owned(),
                HookPolicyOverride {
                    enabled: Some(true),
                    trusted: Some(true),
                },
            )]),
        )
        .await
        .unwrap();

        let effective = s.effective_hook_override(key).await.unwrap();
        assert_eq!(effective.enabled, Some(false));
        assert_eq!(effective.trusted, Some(true));
    }

    #[tokio::test]
    async fn local_user_fields_override_managed_user_fields_without_erasing_them() {
        let s = store();
        let key = "com.example.plugin::review";
        s.replace_managed_hook_overrides(
            GovernanceScope::User,
            &BTreeMap::from([(
                key.to_owned(),
                HookPolicyOverride {
                    enabled: Some(true),
                    trusted: Some(true),
                },
            )]),
        )
        .await
        .unwrap();
        s.upsert_hook_override(
            GovernanceScope::User,
            key,
            &HookPolicyOverride {
                enabled: Some(false),
                trusted: None,
            },
            false,
        )
        .await
        .unwrap();

        let effective = s.effective_hook_override(key).await.unwrap();
        assert_eq!(effective.enabled, Some(false));
        assert_eq!(effective.trusted, Some(true));
    }

    // ── Provenance: captured, never invented ─────────────────────────────────

    /// The migration trap this feature turns on. Every row written before the
    /// `provenance` column existed reads back as `None`, and `None` must resolve
    /// to untrusted — the opposite default would silently vouch for every plugin
    /// already on disk.
    #[tokio::test]
    async fn a_record_without_provenance_reads_as_untrusted() {
        let s = store();
        // `insert` is the pre-provenance entry point, so this is exactly the shape
        // of a legacy row.
        s.insert("com.test.legacy", "1.0.0").await.unwrap();

        let record = s.get_record("com.test.legacy").await.unwrap().unwrap();
        assert!(record.provenance.is_none());
        assert_eq!(
            isolation::TrustPolicy::default()
                .resolve_trust("com.test.legacy", record.provenance.as_ref()),
            isolation::TrustBasis::Untrusted
        );
    }

    /// A captured provenance survives the round-trip through SQLite intact — the
    /// trust decision is only as good as the fields it reads back.
    #[tokio::test]
    async fn provenance_round_trips_through_the_store() {
        let s = store();
        let captured = isolation::PluginProvenance {
            source_id: Some(isolation::OFFICIAL_MARKETPLACE_SOURCE_ID.to_owned()),
            publisher_org: Some("org_acme".to_owned()),
            org_verified: true,
            org_verified_tier: Some("gold".to_owned()),
            signature_verified: true,
            builtin: false,
            captured_at: Some("2026-08-14T00:00:00Z".to_owned()),
            ..isolation::PluginProvenance::default()
        };
        s.insert_with_provenance("com.acme.app", "1.0.0", Some(&captured))
            .await
            .unwrap();

        let record = s.get_record("com.acme.app").await.unwrap().unwrap();
        assert_eq!(record.provenance.as_ref(), Some(&captured));
        assert!(matches!(
            isolation::TrustPolicy::default()
                .resolve_trust("com.acme.app", record.provenance.as_ref()),
            isolation::TrustBasis::VerifiedPublisher { .. }
        ));
    }

    /// An update re-observes the publisher, so `set_provenance` must overwrite the
    /// capture rather than merge into it. This is the only path by which a revoked
    /// verification stops counting.
    #[tokio::test]
    async fn set_provenance_replaces_an_earlier_capture() {
        let s = store();
        let verified = isolation::PluginProvenance {
            source_id: Some(isolation::OFFICIAL_MARKETPLACE_SOURCE_ID.to_owned()),
            org_verified: true,
            signature_verified: true,
            ..isolation::PluginProvenance::default()
        };
        s.insert_with_provenance("com.acme.app", "1.0.0", Some(&verified))
            .await
            .unwrap();

        // The org lost its check; the next update re-captures without it.
        let revoked = isolation::PluginProvenance {
            source_id: Some(isolation::OFFICIAL_MARKETPLACE_SOURCE_ID.to_owned()),
            org_verified: false,
            signature_verified: true,
            ..isolation::PluginProvenance::default()
        };
        let updated = s
            .set_provenance("com.acme.app", Some(&revoked))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            updated.provenance.as_ref().map(|p| p.org_verified),
            Some(false)
        );
        assert_eq!(
            isolation::TrustPolicy::default()
                .resolve_trust("com.acme.app", updated.provenance.as_ref()),
            isolation::TrustBasis::OfficialMarketplace
        );
    }

    // ── Safe Mode: a read mask, never a write ────────────────────────────────

    /// The invariant the whole design rests on: safe mode changes what callers
    /// READ and leaves the `apps` table alone. That is what makes leaving safe mode
    /// a no-op with no bookkeeping to replay, and what makes a crash mid-toggle
    /// harmless.
    ///
    /// Asserted against the store rather than the pure helper because the claim is
    /// about persistence: mask the rows, then read the table again and find every
    /// bit exactly as the user left it.
    #[tokio::test]
    async fn safe_mode_masks_reads_without_writing_records() {
        let s = store();
        s.insert("com.test.app", "1.0.0").await.unwrap();
        s.set_enabled("com.test.app", &["sidecar:process".to_owned()])
            .await
            .unwrap();

        let masked = apply_safe_mode_mask(s.list_all_records().await.unwrap(), true);
        let app = masked.iter().find(|r| r.id == "com.test.app").unwrap();
        assert!(!app.enabled, "an ordinary app must read as disabled");
        assert!(
            app.approved_grants.is_empty(),
            "a masked-off app must not still present approved grants"
        );

        // The table is untouched.
        let raw = s.list_all_records().await.unwrap();
        let app = raw.iter().find(|r| r.id == "com.test.app").unwrap();
        assert!(app.enabled, "safe mode must NOT write the enabled column");
        assert_eq!(
            app.approved_grants,
            vec!["sidecar:process".to_owned()],
            "safe mode must NOT clear the persisted grants"
        );
    }

    /// The kernel tiers survive the mask. Without this, safe mode would boot a node
    /// with no Spaces (the root every retrieval path resolves through) and no
    /// engines — a "diagnostic" mode in which chat itself is broken, which tells the
    /// user nothing about the problem they came to measure.
    #[tokio::test]
    async fn safe_mode_keeps_the_kernel_plugins_running() {
        let s = store();
        for id in crate::plugins::builtins::MANDATORY_PLUGINS
            .iter()
            .chain(crate::plugins::builtins::LOAD_BEARING_PLUGINS)
        {
            s.insert(id, "1.0.0").await.unwrap();
            s.set_enabled(id, &[]).await.unwrap();
        }
        let masked = apply_safe_mode_mask(s.list_all_records().await.unwrap(), true);
        assert!(
            masked.iter().all(|r| r.enabled),
            "every kernel-tier plugin must stay enabled under safe mode"
        );
    }

    /// Inactive safe mode is byte-for-byte the identity function — the normal boot
    /// must not be paying for a mode nobody turned on.
    #[tokio::test]
    async fn the_mask_is_the_identity_when_safe_mode_is_off() {
        let s = store();
        s.insert("com.test.app", "1.0.0").await.unwrap();
        s.set_enabled("com.test.app", &["mcp:web_search".to_owned()])
            .await
            .unwrap();
        let raw = s.list_all_records().await.unwrap();
        let passed_through = apply_safe_mode_mask(raw.clone(), false);
        assert_eq!(passed_through.len(), raw.len());
        for (a, b) in passed_through.iter().zip(raw.iter()) {
            assert_eq!(a.id, b.id);
            assert_eq!(a.enabled, b.enabled);
            assert_eq!(a.approved_grants, b.approved_grants);
        }
    }

    #[tokio::test]
    async fn insert_get_roundtrip() {
        let s = store();
        let rec = s.insert("com.test.app", "1.0.0").await.unwrap();
        assert_eq!(rec.id, "com.test.app");
        assert_eq!(rec.version, "1.0.0");
        assert!(!rec.enabled);
        assert!(rec.approved_grants.is_empty());

        let fetched = s.get("com.test.app").await.unwrap().unwrap();
        assert_eq!(fetched.version, "1.0.0");
    }

    #[tokio::test]
    async fn enable_persists_grants() {
        let s = store();
        s.insert("com.test.app", "1.0.0").await.unwrap();
        let rec = s
            .set_enabled("com.test.app", &["mcp:web_search".to_owned()])
            .await
            .unwrap()
            .unwrap();
        assert!(rec.enabled);
        assert_eq!(rec.approved_grants, vec!["mcp:web_search"]);
    }

    #[tokio::test]
    async fn disable_clears_grants() {
        let s = store();
        s.insert("com.test.app", "1.0.0").await.unwrap();
        s.set_enabled("com.test.app", &["mcp:web_search".to_owned()])
            .await
            .unwrap();
        let rec = s.set_disabled("com.test.app").await.unwrap().unwrap();
        assert!(!rec.enabled);
        assert!(rec.approved_grants.is_empty());
    }

    #[tokio::test]
    async fn set_version_updates_version() {
        let s = store();
        s.insert("com.test.app", "1.0.0").await.unwrap();
        let rec = s
            .set_version("com.test.app", "2.0.0")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rec.version, "2.0.0");
    }

    /// An unpinned record describes its OWN channel, read off the installed
    /// version. This is what keeps a plugin installed at `1.2.0-nightly.4` on the
    /// nightly train after an upgrade that predates the column, instead of being
    /// silently moved to stable the next time it checks for an update.
    #[tokio::test]
    async fn channel_is_derived_from_the_installed_version_when_unpinned() {
        let s = store();
        s.insert("com.test.stable", "1.2.0").await.unwrap();
        s.insert("com.test.nightly", "1.2.0-nightly.4")
            .await
            .unwrap();
        assert_eq!(
            s.get("com.test.stable").await.unwrap().unwrap().channel,
            "stable"
        );
        assert_eq!(
            s.get("com.test.nightly").await.unwrap().unwrap().channel,
            "nightly"
        );
    }

    /// A pin outlives the version, which is the whole reason the column exists:
    /// someone who chose `canary` on a listing with no canary build yet is still
    /// on canary, however stable the version they are sitting on looks.
    #[tokio::test]
    async fn a_pinned_channel_survives_a_version_that_disagrees_with_it() {
        let s = store();
        s.insert("com.test.app", "1.2.0").await.unwrap();
        let pinned = s
            .set_channel("com.test.app", Some("  CANARY "))
            .await
            .unwrap()
            .unwrap();
        // Normalized on write, so `Canary` and `canary` are never two trains.
        assert_eq!(pinned.channel, "canary");
        // Pinning does not move the install; that is a separate, explicit update.
        assert_eq!(pinned.version, "1.2.0");
        assert_eq!(
            s.get("com.test.app").await.unwrap().unwrap().channel,
            "canary"
        );

        // Clearing the pin returns the record to describing itself.
        let cleared = s.set_channel("com.test.app", None).await.unwrap().unwrap();
        assert_eq!(cleared.channel, "stable");
    }

    #[tokio::test]
    async fn remove_deletes_record() {
        let s = store();
        s.insert("com.test.app", "1.0.0").await.unwrap();
        assert!(s.remove("com.test.app").await.unwrap());
        assert!(s.get("com.test.app").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn missing_record_returns_none() {
        let s = store();
        assert!(s.get("does.not.exist").await.unwrap().is_none());
        assert!(s
            .set_enabled("does.not.exist", &[])
            .await
            .unwrap()
            .is_none());
        assert!(s.set_disabled("does.not.exist").await.unwrap().is_none());
        assert!(!s.remove("does.not.exist").await.unwrap());
    }

    /// #444 Community tier: a Community plugin installs disabled, and its
    /// enable→disable transitions persist across store reads (the opt-in path).
    /// `tier_for` confirms a non-Core id is Community (never auto-seeded).
    #[tokio::test]
    async fn community_plugin_install_disabled_then_enable_disable_persists() {
        use crate::plugin_manifest::PluginTier;
        let s = store();
        let id = "com.example.community-thing";
        assert_eq!(builtins::tier_for(id), PluginTier::Community);

        // Install: lands disabled (opt-in), never auto-enabled.
        let rec = s.insert(id, "1.0.0").await.unwrap();
        assert!(!rec.enabled, "Community plugin installs disabled");

        // Enable persists.
        let enabled = s.set_enabled(id, &[]).await.unwrap().unwrap();
        assert!(enabled.enabled);
        let reread = s.get(id).await.unwrap().unwrap();
        assert!(reread.enabled, "enable persists across reads");

        // Disable persists.
        s.set_disabled(id).await.unwrap();
        let reread2 = s.get(id).await.unwrap().unwrap();
        assert!(!reread2.enabled, "disable persists across reads");
    }

    #[tokio::test]
    async fn migration_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        PluginStore::migrate(&conn).unwrap();
        PluginStore::migrate(&conn).unwrap();
    }

    #[tokio::test]
    async fn ui_code_roundtrip_and_presence() {
        let s = store();
        s.insert("com.test.ui", "1.0.0").await.unwrap();
        // No code yet.
        assert!(s.get_ui_code("com.test.ui").await.unwrap().is_none());
        assert!(!s.has_ui_code("com.test.ui").await.unwrap());

        // Store and read back.
        assert!(s
            .set_ui_code("com.test.ui", Some("export function activate(){}"))
            .await
            .unwrap());
        assert_eq!(
            s.get_ui_code("com.test.ui").await.unwrap().as_deref(),
            Some("export function activate(){}")
        );
        assert!(s.has_ui_code("com.test.ui").await.unwrap());

        // Clearing it (disable/uninstall carriage) drops presence.
        assert!(s.set_ui_code("com.test.ui", None).await.unwrap());
        assert!(!s.has_ui_code("com.test.ui").await.unwrap());

        // Setting code on a missing record is a no-op (install must precede it).
        assert!(!s.set_ui_code("does.not.exist", Some("x")).await.unwrap());
    }
}
