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
pub mod lifecycle;
pub mod seed;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

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
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
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
        Ok(())
    }

    /// Insert a new app record (install). Fails if an app with the same id is
    /// already present (use `update_version` for upgrades).
    pub async fn insert(&self, id: &str, version: &str) -> Result<PluginRecord> {
        let now = chrono::Utc::now().to_rfc3339();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO apps (id, version, enabled, approved_grants, created_at, updated_at)
             VALUES (?1, ?2, 0, '[]', ?3, ?3)",
            params![id, version, now],
        )
        .with_context(|| format!("inserting app '{id}'"))?;
        Ok(PluginRecord {
            id: id.to_owned(),
            version: version.to_owned(),
            enabled: false,
            approved_grants: vec![],
            created_at: Some(now.clone()),
            updated_at: Some(now),
        })
    }

    /// Fetch a single app record by id.
    pub async fn get(&self, id: &str) -> Result<Option<PluginRecord>> {
        let conn = self.conn.lock().await;
        let record = conn
            .query_row(
                "SELECT id, version, enabled, approved_grants, created_at, updated_at
                 FROM apps WHERE id = ?1",
                params![id],
                row_to_record,
            )
            .optional()?;
        Ok(record)
    }

    /// List all app records.
    pub async fn list(&self) -> Result<Vec<PluginRecord>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, version, enabled, approved_grants, created_at, updated_at
             FROM apps ORDER BY created_at ASC",
        )?;
        let rows = stmt
            .query_map([], row_to_record)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
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

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<PluginRecord> {
    let grants_json: String = row.get(3)?;
    let approved_grants = serde_json::from_str(&grants_json).unwrap_or_default();
    Ok(PluginRecord {
        id: row.get(0)?,
        version: row.get(1)?,
        enabled: row.get::<_, i64>(2)? != 0,
        approved_grants,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> PluginStore {
        PluginStore::open_in_memory().unwrap()
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
