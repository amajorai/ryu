//! Plugin-owned key/value storage — the extracted `storage` primitive crate.
//!
//! Each plugin gets an isolated, namespaced KV space exposed **only** through the
//! plugin-host `storage` capability (gated by the `storage:kv` grant). This is
//! where a plugin keeps durable state instead of Core growing bespoke columns for
//! it — e.g. the goal plugin's per-conversation completion condition + turn count
//! live here (key = conversation id), not on the `conversations` table.
//!
//! Placement (Core vs Gateway): this stores *what a plugin is tracking* — it
//! decides what runs, not what is allowed — so it is Core-tier. Rows are
//! namespaced by `(plugin_id, namespace, key)` so one plugin can never read
//! another's state.
//!
//! This crate is a **pure** primitive: [`PluginStorage::open`] takes an explicit
//! db path, so the crate has ZERO dependency on `apps/core`. The single kernel
//! coupling — choosing the default `~/.ryu/plugin-storage.db` path — and the
//! process-global handle stay Core-side as wiring (`apps/core/src/plugin_storage`).

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// SQLite-backed per-plugin KV store. Cheap to clone (wraps an `Arc`).
#[derive(Clone)]
pub struct PluginStorage {
    conn: Arc<Mutex<Connection>>,
}

impl PluginStorage {
    /// Open (or create) the store at a specific path and run migrations.
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening plugin-storage db {}", path.display()))?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// In-memory store for tests.
    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory plugin-storage db")?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS plugin_kv (
                 plugin_id  TEXT NOT NULL,
                 namespace  TEXT NOT NULL,
                 key        TEXT NOT NULL,
                 value      TEXT NOT NULL,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY (plugin_id, namespace, key)
             );",
        )
        .context("initializing plugin-storage schema")?;
        Ok(())
    }

    /// Read a value. `Ok(None)` when the key is unset.
    pub async fn get(&self, plugin_id: &str, namespace: &str, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().await;
        let v = conn
            .query_row(
                "SELECT value FROM plugin_kv WHERE plugin_id = ?1 AND namespace = ?2 AND key = ?3",
                params![plugin_id, namespace, key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("reading plugin_kv")?;
        Ok(v)
    }

    /// Upsert a value.
    pub async fn set(
        &self,
        plugin_id: &str,
        namespace: &str,
        key: &str,
        value: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO plugin_kv (plugin_id, namespace, key, value, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(plugin_id, namespace, key)
             DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![plugin_id, namespace, key, value, now_millis()],
        )
        .context("writing plugin_kv")?;
        Ok(())
    }

    /// Delete a value (no-op if absent).
    pub async fn delete(&self, plugin_id: &str, namespace: &str, key: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM plugin_kv WHERE plugin_id = ?1 AND namespace = ?2 AND key = ?3",
            params![plugin_id, namespace, key],
        )
        .context("deleting plugin_kv")?;
        Ok(())
    }

    /// List the keys a plugin has set within a namespace (newest first).
    pub async fn keys(&self, plugin_id: &str, namespace: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT key FROM plugin_kv WHERE plugin_id = ?1 AND namespace = ?2
                 ORDER BY updated_at DESC",
            )
            .context("preparing plugin_kv keys query")?;
        let rows = stmt
            .query_map(params![plugin_id, namespace], |row| row.get::<_, String>(0))
            .context("querying plugin_kv keys")?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.context("reading plugin_kv key row")?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn set_get_delete_roundtrip() {
        let s = PluginStorage::in_memory().unwrap();
        assert_eq!(s.get("p", "ns", "k").await.unwrap(), None);
        s.set("p", "ns", "k", "v1").await.unwrap();
        assert_eq!(s.get("p", "ns", "k").await.unwrap().as_deref(), Some("v1"));
        // Upsert overwrites.
        s.set("p", "ns", "k", "v2").await.unwrap();
        assert_eq!(s.get("p", "ns", "k").await.unwrap().as_deref(), Some("v2"));
        s.delete("p", "ns", "k").await.unwrap();
        assert_eq!(s.get("p", "ns", "k").await.unwrap(), None);
    }

    #[tokio::test]
    async fn plugins_are_isolated_by_id_and_namespace() {
        let s = PluginStorage::in_memory().unwrap();
        s.set("plugin-a", "default", "shared", "a").await.unwrap();
        s.set("plugin-b", "default", "shared", "b").await.unwrap();
        // Same key, different plugin → isolated.
        assert_eq!(
            s.get("plugin-a", "default", "shared")
                .await
                .unwrap()
                .as_deref(),
            Some("a")
        );
        assert_eq!(
            s.get("plugin-b", "default", "shared")
                .await
                .unwrap()
                .as_deref(),
            Some("b")
        );
        // Same plugin, different namespace → isolated.
        s.set("plugin-a", "other", "shared", "a2").await.unwrap();
        assert_eq!(
            s.get("plugin-a", "default", "shared")
                .await
                .unwrap()
                .as_deref(),
            Some("a")
        );
    }

    #[tokio::test]
    async fn keys_lists_namespaced_keys() {
        let s = PluginStorage::in_memory().unwrap();
        s.set("p", "goals", "conv-1", "x").await.unwrap();
        s.set("p", "goals", "conv-2", "y").await.unwrap();
        s.set("p", "other", "conv-3", "z").await.unwrap();
        let mut keys = s.keys("p", "goals").await.unwrap();
        keys.sort();
        assert_eq!(keys, vec!["conv-1".to_string(), "conv-2".to_string()]);
    }
}
