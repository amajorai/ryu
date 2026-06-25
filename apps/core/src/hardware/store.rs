//! Device registry (SQLite) — paired Ryu hardware and their tokens.
//!
//! Persists the device records backing the REST surface in PROTOCOL.md §6 and
//! the Bearer-token auth on the WS upgrade (§2). This is the system of record for
//! "which devices are paired to this node", extending the connections/presence
//! model with durable, per-device, revocable tokens.
//!
//! Placement (Core vs Gateway): the device registry + token lifecycle decide
//! *which device is allowed to drive this node and what it runs*, so this is
//! Core. It mirrors [`crate::meetings::store`]: one `rusqlite` connection behind
//! an `Arc<Mutex<…>>`, opened under `crate::paths::ryu_dir()`.
//!
//! The **raw** token is shown to the app exactly once (at pairing); only its
//! SHA-256 hash is persisted here. A device authenticates the WS upgrade by
//! presenting the raw token, which is re-hashed and compared against the row.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

use super::protocol::DeviceType;

fn default_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("hardware.db")
}

/// A paired device row. The `token_hash` is stored, never the raw token.
#[derive(Clone, Debug)]
pub struct DeviceRecord {
    pub device_id: String,
    pub device_type: DeviceType,
    pub name: String,
    /// Lowercase hex SHA-256 of the Bearer token (raw token shown once at pairing).
    pub token_hash: String,
    /// Epoch ms of last WS activity, or `None` if never connected.
    pub last_seen: Option<i64>,
    /// Latest reported battery percent, or `None`.
    pub battery_pct: Option<i32>,
    /// Free-form per-device prefs (JSON), e.g. wake word, ambient on/off.
    pub prefs: serde_json::Value,
    /// The long-running ambient meeting this device resumes on reconnect, so a
    /// reconnecting ambient device feeds the SAME meeting rather than spawning a
    /// fresh one each `hello` (PROTOCOL.md §4.2). `None` until first opened.
    pub ambient_meeting_id: Option<String>,
    pub created_at: i64,
}

/// Hash a raw Bearer token to the form stored in the registry. The token is a
/// 256-bit random secret (see [`super::pairing::generate_device_token`]); a plain
/// SHA-256 is sufficient for a high-entropy secret (no need for a slow KDF, which
/// only matters for low-entropy passwords).
pub fn hash_token(raw: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(raw.as_bytes());
    hex::encode(digest)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Handle to the device registry table. Cheaply cloneable (wraps an `Arc`).
#[derive(Clone)]
pub struct DeviceStore {
    conn: Arc<Mutex<Connection>>,
}

impl DeviceStore {
    /// Open (or create) the store at the default path (`~/.ryu/hardware.db`).
    pub fn open_default() -> Result<Self> {
        Self::open(default_db_path())
    }

    /// Open (or create) the store at a specific path and run migrations.
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening hardware db {}", path.display()))?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS devices (
                 device_id          TEXT PRIMARY KEY,
                 device_type        TEXT NOT NULL,
                 name               TEXT NOT NULL,
                 token_hash         TEXT NOT NULL,
                 last_seen          INTEGER,
                 battery_pct        INTEGER,
                 prefs              TEXT NOT NULL DEFAULT '{}',
                 ambient_meeting_id TEXT,
                 created_at         INTEGER NOT NULL
             );",
        )
        .context("initializing hardware schema")?;
        Ok(())
    }

    fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeviceRecord> {
        let device_type_str: String = row.get(1)?;
        let prefs_str: String = row.get(6)?;
        Ok(DeviceRecord {
            device_id: row.get(0)?,
            device_type: super::protocol::parse_device_type(&device_type_str)
                .unwrap_or(DeviceType::Necklace),
            name: row.get(2)?,
            token_hash: row.get(3)?,
            last_seen: row.get(4)?,
            battery_pct: row.get(5)?,
            prefs: serde_json::from_str(&prefs_str).unwrap_or(serde_json::Value::Null),
            ambient_meeting_id: row.get(7)?,
            created_at: row.get(8)?,
        })
    }

    /// Insert a freshly paired device (or replace one with the same id — a
    /// re-pair rotates the token), returning the stored record.
    pub async fn insert(&self, record: DeviceRecord) -> Result<DeviceRecord> {
        let device_type = super::protocol::device_type_str(record.device_type).to_string();
        let prefs = serde_json::to_string(&record.prefs).unwrap_or_else(|_| "{}".to_string());
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO devices
                 (device_id, device_type, name, token_hash, last_seen, battery_pct, prefs, ambient_meeting_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(device_id) DO UPDATE SET
                 device_type = ?2, name = ?3, token_hash = ?4, prefs = ?7",
            params![
                record.device_id,
                device_type,
                record.name,
                record.token_hash,
                record.last_seen,
                record.battery_pct,
                prefs,
                record.ambient_meeting_id,
                record.created_at,
            ],
        )
        .context("inserting device")?;
        Ok(record)
    }

    /// Look up a device by id.
    pub async fn get(&self, device_id: &str) -> Result<Option<DeviceRecord>> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT device_id, device_type, name, token_hash, last_seen, battery_pct, prefs, ambient_meeting_id, created_at
             FROM devices WHERE device_id = ?1",
            params![device_id],
            Self::row_to_record,
        )
        .optional()
        .context("reading device")
    }

    /// List all paired devices, newest first (drives `GET /api/hardware/devices`).
    pub async fn list(&self) -> Result<Vec<DeviceRecord>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT device_id, device_type, name, token_hash, last_seen, battery_pct, prefs, ambient_meeting_id, created_at
             FROM devices ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], Self::row_to_record)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Verify a raw Bearer token against a device's stored hash. Returns `true`
    /// only when the device exists and the hash matches.
    pub async fn verify_token(&self, device_id: &str, token: &str) -> Result<bool> {
        let Some(record) = self.get(device_id).await? else {
            return Ok(false);
        };
        Ok(record.token_hash == hash_token(token))
    }

    /// Update mutable fields (name/prefs) for `PATCH`. A `None` leaves the field
    /// unchanged. Returns `true` when a row was touched.
    pub async fn update(
        &self,
        device_id: &str,
        name: Option<String>,
        prefs: Option<serde_json::Value>,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let mut changed = 0usize;
        if let Some(name) = name {
            changed += conn.execute(
                "UPDATE devices SET name = ?2 WHERE device_id = ?1",
                params![device_id, name],
            )?;
        }
        if let Some(prefs) = prefs {
            let json = serde_json::to_string(&prefs).unwrap_or_else(|_| "{}".to_string());
            changed += conn.execute(
                "UPDATE devices SET prefs = ?2 WHERE device_id = ?1",
                params![device_id, json],
            )?;
        }
        Ok(changed > 0)
    }

    /// Mark a device seen now and record latest battery (from telemetry). A
    /// `None` battery leaves the stored value unchanged.
    pub async fn touch(&self, device_id: &str, battery_pct: Option<i32>) -> Result<()> {
        let conn = self.conn.lock().await;
        match battery_pct {
            Some(pct) => conn.execute(
                "UPDATE devices SET last_seen = ?2, battery_pct = ?3 WHERE device_id = ?1",
                params![device_id, now_ms(), pct],
            )?,
            None => conn.execute(
                "UPDATE devices SET last_seen = ?2 WHERE device_id = ?1",
                params![device_id, now_ms()],
            )?,
        };
        Ok(())
    }

    /// Persist the long-running ambient meeting id for a device so a reconnect
    /// resumes the same meeting (PROTOCOL.md §4.2).
    pub async fn set_ambient_meeting(&self, device_id: &str, meeting_id: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE devices SET ambient_meeting_id = ?2 WHERE device_id = ?1",
            params![device_id, meeting_id],
        )?;
        Ok(())
    }

    /// Revoke a device (deletes it / its token) for `DELETE`. Returns `true` when
    /// a row was removed.
    pub async fn revoke(&self, device_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute("DELETE FROM devices WHERE device_id = ?1", params![device_id])?;
        Ok(n > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> DeviceStore {
        let dir = std::env::temp_dir().join(format!("ryu-hw-test-{}", uuid::Uuid::new_v4()));
        DeviceStore::open(dir.join("hardware.db")).expect("open")
    }

    fn sample(id: &str, token: &str) -> DeviceRecord {
        DeviceRecord {
            device_id: id.to_string(),
            device_type: DeviceType::Watch,
            name: "Test Watch".to_string(),
            token_hash: hash_token(token),
            last_seen: None,
            battery_pct: None,
            prefs: serde_json::json!({}),
            ambient_meeting_id: None,
            created_at: now_ms(),
        }
    }

    #[tokio::test]
    async fn insert_get_and_verify_token() {
        let store = temp_store();
        store.insert(sample("rhw_1", "secret-token")).await.unwrap();

        let got = store.get("rhw_1").await.unwrap().expect("present");
        assert_eq!(got.device_id, "rhw_1");
        assert_eq!(got.device_type, DeviceType::Watch);

        assert!(store.verify_token("rhw_1", "secret-token").await.unwrap());
        assert!(!store.verify_token("rhw_1", "wrong").await.unwrap());
        assert!(!store.verify_token("nope", "secret-token").await.unwrap());
    }

    #[tokio::test]
    async fn touch_updates_last_seen_and_battery() {
        let store = temp_store();
        store.insert(sample("rhw_2", "t")).await.unwrap();
        store.touch("rhw_2", Some(81)).await.unwrap();
        let got = store.get("rhw_2").await.unwrap().unwrap();
        assert!(got.last_seen.is_some());
        assert_eq!(got.battery_pct, Some(81));
        // A None battery keeps the previous value.
        store.touch("rhw_2", None).await.unwrap();
        let got = store.get("rhw_2").await.unwrap().unwrap();
        assert_eq!(got.battery_pct, Some(81));
    }

    #[tokio::test]
    async fn update_revoke_and_ambient() {
        let store = temp_store();
        store.insert(sample("rhw_3", "t")).await.unwrap();
        assert!(store
            .update("rhw_3", Some("Kitchen".into()), None)
            .await
            .unwrap());
        store.set_ambient_meeting("rhw_3", "mtg_x").await.unwrap();
        let got = store.get("rhw_3").await.unwrap().unwrap();
        assert_eq!(got.name, "Kitchen");
        assert_eq!(got.ambient_meeting_id.as_deref(), Some("mtg_x"));
        assert!(store.revoke("rhw_3").await.unwrap());
        assert!(store.get("rhw_3").await.unwrap().is_none());
    }
}
