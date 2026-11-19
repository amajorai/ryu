//! Namespace locks: freeze a user, node, team or org subtree of the vault.
//!
//! A lock names one scope and its id, optionally narrowed to one environment
//! and a folder prefix. While it holds, every value under it refuses reads,
//! writes, deletes, version actions, moves and runtime resolution: the
//! management routes answer `423 vault_locked`, store writes fail with
//! `vault_denied`, and a `secret:` reference resolves to "absent" (audited
//! as a denied use). An org lock also covers the team and project values of
//! that org on the node registered to it, so locking an org freezes its whole
//! subtree.
//!
//! Locks cover values only, never `sys/` keys, so the unlock route stays
//! reachable while a subtree is frozen. Locking and unlocking need `admin`
//! on `sys/namespaces/<scope>/<id>` and are audited (`namespace.lock`,
//! `namespace.unlock`). Lock rows are metadata, not secrets, so the table is
//! not sealed.
//!
//! Team and org values a managed node forwards to the control plane are
//! governed by the control plane; a Core lock refuses their runtime
//! resolution through this node but not the forwarded management routes.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, RwLock};

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::plugin_secrets::{is_valid_scope_id, PluginSecretStore, SecretCoords, SecretScope};
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::{is_valid_environment, normalize_path, now_millis, VaultError, ROOT_PATH};

/// Maximum concurrent locks.
pub const MAX_LOCKS: usize = 256;
/// Maximum reason length.
pub const MAX_REASON_LEN: usize = 512;

/// One lock on a scope subtree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceLock {
    #[serde(default)]
    pub id: String,
    pub scope: SecretScope,
    pub scope_id: String,
    /// Only this environment (every environment when unset).
    #[serde(default)]
    pub environment: Option<String>,
    /// Only this folder and its sub-folders (every folder when unset).
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub locked_by: Option<String>,
    #[serde(default)]
    pub locked_at: i64,
}

impl NamespaceLock {
    /// Whether this lock covers a value at `(scope, scope_id, environment,
    /// path)`. `node_org` is the org this node is registered to: an org lock
    /// reaches that org's team and project values through it.
    pub fn covers(
        &self,
        scope: SecretScope,
        scope_id: &str,
        environment: &str,
        path: &str,
        node_org: Option<&str>,
    ) -> bool {
        let scope_matches = (self.scope == scope && self.scope_id == scope_id)
            || (self.scope == SecretScope::Org
                && matches!(scope, SecretScope::Team | SecretScope::Project)
                && node_org == Some(self.scope_id.as_str()));
        if !scope_matches {
            return false;
        }
        if self
            .environment
            .as_deref()
            .is_some_and(|locked| locked != environment)
        {
            return false;
        }
        match self.path.as_deref() {
            None | Some(ROOT_PATH) => true,
            Some(prefix) => {
                path == prefix
                    || path
                        .strip_prefix(prefix)
                        .is_some_and(|rest| rest.starts_with('/'))
            }
        }
    }

    /// Whether this lock covers `coords`.
    pub fn covers_coords(&self, coords: &SecretCoords, node_org: Option<&str>) -> bool {
        self.covers(
            coords.scope,
            &coords.scope_id,
            &coords.environment,
            &coords.path,
            node_org,
        )
    }

    /// `scope:id[/environment][path]`, for error messages and audit rows.
    pub fn label(&self) -> String {
        let mut label = format!("{}:{}", self.scope.as_str(), self.scope_id);
        if let Some(environment) = &self.environment {
            label.push('/');
            label.push_str(environment);
        }
        if let Some(path) = self.path.as_deref().filter(|path| *path != ROOT_PATH) {
            label.push_str(path);
        }
        label
    }

    /// The refusal message for a value under this lock.
    pub fn refusal(&self) -> String {
        if self.reason.is_empty() {
            format!("namespace `{}` is locked", self.label())
        } else {
            format!("namespace `{}` is locked: {}", self.label(), self.reason)
        }
    }
}

fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_namespace_locks (
             id          TEXT PRIMARY KEY,
             scope       TEXT NOT NULL,
             scope_id    TEXT NOT NULL,
             environment TEXT,
             path        TEXT,
             reason      TEXT NOT NULL DEFAULT '',
             locked_by   TEXT,
             locked_at   INTEGER NOT NULL
         );",
    )
    .context("initializing vault namespace-lock schema")
}

/// Every lock, oldest first.
pub fn load(conn: &Connection) -> Result<Vec<NamespaceLock>> {
    ensure_schema(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, scope, scope_id, environment, path, reason, locked_by, locked_at
         FROM vault_namespace_locks ORDER BY locked_at, id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(NamespaceLock {
            id: row.get(0)?,
            // A scope this binary does not parse keeps its row under a scope
            // no request names rather than dropping the lock.
            scope: SecretScope::from_str(&row.get::<_, String>(1)?)
                .unwrap_or(SecretScope::Project),
            scope_id: row.get(2)?,
            environment: row.get(3)?,
            path: row.get(4)?,
            reason: row.get(5)?,
            locked_by: row.get(6)?,
            locked_at: row.get(7)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("reading vault namespace locks")
}

/// The org this node is registered to, if any.
pub fn node_org() -> Option<String> {
    crate::sidecar::control_plane::registered_node().map(|node| node.org.id)
}

/// The first lock covering `coords`.
pub fn lock_for<'a>(
    locks: &'a [NamespaceLock],
    coords: &SecretCoords,
    node_org: Option<&str>,
) -> Option<&'a NamespaceLock> {
    locks
        .iter()
        .find(|lock| lock.covers_coords(coords, node_org))
}

/// Refuse a store operation on a locked value (`vault_denied`).
pub fn guard_unlocked(conn: &Connection, coords: &SecretCoords) -> Result<()> {
    let locks = load(conn)?;
    match lock_for(&locks, coords, node_org().as_deref()) {
        Some(lock) => Err(VaultError::Denied(lock.refusal()).into()),
        None => Ok(()),
    }
}

/// Request-time view of each store's locks, so synchronous capability checks
/// can see them. Keyed by the store's address: tests run many isolated
/// stores in one process.
static CACHE: LazyLock<RwLock<HashMap<usize, Arc<Vec<NamespaceLock>>>>> =
    LazyLock::new(RwLock::default);

fn cache_key(store: &PluginSecretStore) -> usize {
    std::ptr::from_ref(store) as usize
}

/// Reload `store`'s lock cache from its connection.
pub fn refresh(store: &PluginSecretStore, conn: &Connection) -> Result<()> {
    let locks = Arc::new(load(conn)?);
    if let Ok(mut cache) = CACHE.write() {
        cache.insert(cache_key(store), locks);
    }
    Ok(())
}

/// The locks last loaded for `store` (empty before the first load).
pub fn cached(store: &PluginSecretStore) -> Arc<Vec<NamespaceLock>> {
    CACHE
        .read()
        .ok()
        .and_then(|cache| cache.get(&cache_key(store)).cloned())
        .unwrap_or_default()
}

fn validated(lock: NamespaceLock) -> Result<NamespaceLock> {
    if lock.scope == SecretScope::Project {
        bail!("project values live only in the control plane; lock the org instead");
    }
    let scope_id = lock.scope_id.trim().to_owned();
    if !is_valid_scope_id(&scope_id) {
        bail!("invalid scope id");
    }
    if let Some(environment) = &lock.environment {
        if !is_valid_environment(environment) {
            bail!("invalid environment");
        }
    }
    let path = match lock.path.as_deref() {
        Some(path) => {
            Some(normalize_path(path).ok_or_else(|| anyhow::anyhow!("invalid folder path"))?)
        }
        None => None,
    };
    let reason = lock.reason.trim().to_owned();
    if reason.len() > MAX_REASON_LEN || reason.chars().any(char::is_control) {
        bail!("reason must be at most {MAX_REASON_LEN} printable characters");
    }
    Ok(NamespaceLock {
        scope_id,
        path: path.filter(|path| path != ROOT_PATH),
        reason,
        ..lock
    })
}

fn audit_entry(actor: &AuditActor, action: &str, lock: &NamespaceLock) -> AuditEntry {
    let mut entry = AuditEntry::new(actor, action, "ok").details(json!({
        "id": lock.id,
        "reason": lock.reason,
    }));
    entry.scope = Some(lock.scope.as_str().to_owned());
    entry.scope_id = Some(lock.scope_id.clone());
    entry.environment = lock.environment.clone();
    entry.path = lock.path.clone();
    entry
}

impl PluginSecretStore {
    /// Every namespace lock (refreshing the request-time cache).
    pub async fn namespace_locks(&self) -> Result<Vec<NamespaceLock>> {
        let conn = self.conn.lock().await;
        refresh(self, &conn)?;
        load(&conn)
    }

    /// Lock a subtree. A second lock on exactly the same target conflicts.
    pub async fn lock_namespace(
        &self,
        lock: NamespaceLock,
        actor: &AuditActor,
    ) -> Result<NamespaceLock> {
        let lock = validated(lock)?;
        let conn = self.conn.lock().await;
        let existing = load(&conn)?;
        if existing.len() >= MAX_LOCKS {
            return Err(VaultError::Conflict(format!("at most {MAX_LOCKS} locks")).into());
        }
        if existing.iter().any(|held| {
            held.scope == lock.scope
                && held.scope_id == lock.scope_id
                && held.environment == lock.environment
                && held.path == lock.path
        }) {
            return Err(
                VaultError::Conflict(format!("`{}` is already locked", lock.label())).into(),
            );
        }
        let stored = NamespaceLock {
            id: format!("vnl_{}", uuid::Uuid::new_v4().simple()),
            locked_by: actor.id.clone(),
            locked_at: now_millis(),
            ..lock
        };
        conn.execute(
            "INSERT INTO vault_namespace_locks
                 (id, scope, scope_id, environment, path, reason, locked_by, locked_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                stored.id,
                stored.scope.as_str(),
                stored.scope_id,
                stored.environment,
                stored.path,
                stored.reason,
                stored.locked_by,
                stored.locked_at
            ],
        )?;
        self.audit_locked(&conn, &audit_entry(actor, "namespace.lock", &stored));
        refresh(self, &conn)?;
        Ok(stored)
    }

    /// Remove a lock. `Ok(false)` when no lock has this id.
    pub async fn unlock_namespace(&self, id: &str, actor: &AuditActor) -> Result<bool> {
        let conn = self.conn.lock().await;
        let existing = load(&conn)?;
        let Some(lock) = existing.into_iter().find(|lock| lock.id == id) else {
            return Ok(false);
        };
        conn.execute(
            "DELETE FROM vault_namespace_locks WHERE id = ?1",
            params![id],
        )?;
        self.audit_locked(&conn, &audit_entry(actor, "namespace.unlock", &lock));
        refresh(self, &conn)?;
        Ok(true)
    }
}

#[cfg(test)]
#[path = "namespace_locks_tests.rs"]
mod tests;
