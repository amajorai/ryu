//! Durable device-tool state in `db/device_tools.db` (via `crate::paths`).
//!
//! Tables: `devices` (one key per `(principal_id, device_id)`), `device_grants`
//! (one "Always allow" per principal, device and canonical tool) and
//! `device_quota` (one row per executed call, pruned after a day) and
//! `device_replay` (accepted signature keys for five minutes, see `replay`),
//! `device_confirm_keys` (the on-device confirmation key, see `confirm_key`)
//! and `device_home_accessories` (the signed Home cache, see `home`). Public keys
//! and grants are not secrets, so no column is sealed; P4 adds the sealed
//! `device_tool_pending` table.

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use rusqlite::{params, Connection, OptionalExtension};

mod confirm_key;
mod home;
mod replay;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DeviceState {
    /// Paired by a token-only caller; inactive until the host owner approves.
    Pending,
    Active,
}

impl DeviceState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Active => "active",
        }
    }

    fn parse(text: &str) -> Self {
        if text == "active" {
            Self::Active
        } else {
            Self::Pending
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DeviceRow {
    pub(crate) principal_id: String,
    pub(crate) device_id: String,
    pub(crate) public_key: Vec<u8>,
    pub(crate) app: String,
    pub(crate) platform: String,
    pub(crate) label: String,
    pub(crate) state: DeviceState,
    pub(crate) attestation: Option<String>,
    pub(crate) paired_at_ms: i64,
    pub(crate) last_seen_ms: i64,
}

/// A new pairing request, already validated by the HTTP layer.
pub(crate) struct NewDevice<'a> {
    pub(crate) principal_id: &'a str,
    pub(crate) device_id: &'a str,
    pub(crate) public_key: &'a [u8],
    pub(crate) app: &'a str,
    pub(crate) platform: &'a str,
    pub(crate) label: &'a str,
    pub(crate) attestation: Option<&'a str>,
    pub(crate) initial_state: DeviceState,
}

pub(crate) struct DeviceToolStore {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS devices (
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  public_key BLOB NOT NULL,
  app TEXT NOT NULL,
  platform TEXT NOT NULL,
  label TEXT NOT NULL,
  state TEXT NOT NULL,
  attestation TEXT,
  paired_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (principal_id, device_id)
);
CREATE TABLE IF NOT EXISTS device_grants (
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, device_id, tool)
);
CREATE TABLE IF NOT EXISTS device_quota (
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  units INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS device_quota_lookup ON device_quota (principal_id, device_id, tool, at_ms);
";

const DAY_MS: i64 = 86_400_000;

fn row_to_device(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeviceRow> {
    Ok(DeviceRow {
        principal_id: row.get(0)?,
        device_id: row.get(1)?,
        public_key: row.get(2)?,
        app: row.get(3)?,
        platform: row.get(4)?,
        label: row.get(5)?,
        state: DeviceState::parse(&row.get::<_, String>(6)?),
        attestation: row.get(7)?,
        paired_at_ms: row.get(8)?,
        last_seen_ms: row.get(9)?,
    })
}

const DEVICE_COLUMNS: &str =
    "principal_id, device_id, public_key, app, platform, label, state, attestation, paired_at, last_seen";

impl DeviceToolStore {
    pub(crate) fn open(path: &Path) -> anyhow::Result<Self> {
        Self::from_connection(Connection::open(path)?)
    }

    #[cfg(test)]
    pub(crate) fn open_in_memory() -> anyhow::Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> anyhow::Result<Self> {
        conn.execute_batch(SCHEMA)?;
        conn.execute_batch(replay::SCHEMA)?;
        conn.execute_batch(confirm_key::SCHEMA)?;
        conn.execute_batch(home::SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn with<T>(&self, run: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> anyhow::Result<T> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| anyhow::anyhow!("device tool store poisoned"))?;
        Ok(run(&conn)?)
    }

    /// Pair (or re-pair) a device. A new key for an existing row drops that
    /// device's grants and resets its state, so a re-pair never inherits trust.
    pub(crate) fn pair(&self, device: &NewDevice<'_>, now_ms: i64) -> anyhow::Result<DeviceState> {
        let existing = self.device(device.principal_id, device.device_id)?;
        let state = match &existing {
            Some(row) if row.public_key == device.public_key => {
                if row.state == DeviceState::Active {
                    DeviceState::Active
                } else {
                    device.initial_state
                }
            }
            _ => device.initial_state,
        };
        let key_changed = existing
            .as_ref()
            .is_some_and(|row| row.public_key != device.public_key);
        self.with(|conn| {
            if key_changed {
                for table in ["device_grants", "device_confirm_keys", "device_home_accessories"] {
                    conn.execute(
                        &format!("DELETE FROM {table} WHERE principal_id = ?1 AND device_id = ?2"),
                        params![device.principal_id, device.device_id],
                    )?;
                }
            }
            conn.execute(
                "INSERT INTO devices (principal_id, device_id, public_key, app, platform, label, state, attestation, paired_at, last_seen)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
                 ON CONFLICT (principal_id, device_id) DO UPDATE SET
                   public_key = excluded.public_key, app = excluded.app, platform = excluded.platform,
                   label = excluded.label, state = excluded.state, attestation = excluded.attestation,
                   paired_at = CASE WHEN devices.public_key = excluded.public_key THEN devices.paired_at ELSE excluded.paired_at END,
                   last_seen = excluded.last_seen",
                params![
                    device.principal_id,
                    device.device_id,
                    device.public_key,
                    device.app,
                    device.platform,
                    device.label,
                    state.as_str(),
                    device.attestation,
                    now_ms
                ],
            )?;
            Ok(state)
        })
    }

    pub(crate) fn device(
        &self,
        principal_id: &str,
        device_id: &str,
    ) -> anyhow::Result<Option<DeviceRow>> {
        self.with(|conn| {
            conn.query_row(
                &format!("SELECT {DEVICE_COLUMNS} FROM devices WHERE principal_id = ?1 AND device_id = ?2"),
                params![principal_id, device_id],
                row_to_device,
            )
            .optional()
        })
    }

    /// The device's key only when the row is active.
    pub(crate) fn active_key(&self, principal_id: &str, device_id: &str) -> Option<Vec<u8>> {
        self.device(principal_id, device_id)
            .ok()
            .flatten()
            .filter(|row| row.state == DeviceState::Active)
            .map(|row| row.public_key)
    }

    pub(crate) fn devices(&self, principal_id: &str) -> anyhow::Result<Vec<DeviceRow>> {
        self.with(|conn| {
            let mut statement = conn.prepare(&format!(
                "SELECT {DEVICE_COLUMNS} FROM devices WHERE principal_id = ?1 ORDER BY last_seen DESC"
            ))?;
            let rows = statement.query_map(params![principal_id], row_to_device)?;
            rows.collect()
        })
    }

    pub(crate) fn has_active_device(&self) -> bool {
        self.with(|conn| {
            conn.query_row(
                "SELECT EXISTS (SELECT 1 FROM devices WHERE state = 'active')",
                [],
                |row| row.get::<_, bool>(0),
            )
        })
        .unwrap_or(false)
    }

    /// Activate a pending device. `false` when there was no such pending row.
    pub(crate) fn approve(&self, principal_id: &str, device_id: &str) -> anyhow::Result<bool> {
        self.with(|conn| {
            Ok(conn.execute(
                "UPDATE devices SET state = 'active' WHERE principal_id = ?1 AND device_id = ?2 AND state = 'pending'",
                params![principal_id, device_id],
            )? == 1)
        })
    }

    pub(crate) fn rename(
        &self,
        principal_id: &str,
        device_id: &str,
        label: &str,
    ) -> anyhow::Result<bool> {
        self.with(|conn| {
            Ok(conn.execute(
                "UPDATE devices SET label = ?3 WHERE principal_id = ?1 AND device_id = ?2",
                params![principal_id, device_id, label],
            )? == 1)
        })
    }

    pub(crate) fn touch(&self, principal_id: &str, device_id: &str, now_ms: i64) {
        let _ = self.with(|conn| {
            conn.execute(
                "UPDATE devices SET last_seen = ?3 WHERE principal_id = ?1 AND device_id = ?2",
                params![principal_id, device_id, now_ms],
            )
        });
    }

    /// Forget a device with its keys, grants, quota rows and Home cache.
    pub(crate) fn forget(&self, principal_id: &str, device_id: &str) -> anyhow::Result<bool> {
        self.with(|conn| {
            let removed = conn.execute(
                "DELETE FROM devices WHERE principal_id = ?1 AND device_id = ?2",
                params![principal_id, device_id],
            )?;
            for table in [
                "device_grants",
                "device_quota",
                "device_confirm_keys",
                "device_home_accessories",
            ] {
                conn.execute(
                    &format!("DELETE FROM {table} WHERE principal_id = ?1 AND device_id = ?2"),
                    params![principal_id, device_id],
                )?;
            }
            Ok(removed == 1)
        })
    }

    pub(crate) fn has_grant(&self, principal_id: &str, device_id: &str, tool: &str) -> bool {
        self.with(|conn| {
            conn.query_row(
                "SELECT EXISTS (SELECT 1 FROM device_grants WHERE principal_id = ?1 AND device_id = ?2 AND tool = ?3)",
                params![principal_id, device_id, tool],
                |row| row.get::<_, bool>(0),
            )
        })
        .unwrap_or(false)
    }

    pub(crate) fn grant(
        &self,
        principal_id: &str,
        device_id: &str,
        tool: &str,
        now_ms: i64,
    ) -> anyhow::Result<()> {
        self.with(|conn| {
            conn.execute(
                "INSERT OR REPLACE INTO device_grants (principal_id, device_id, tool, granted_at) VALUES (?1, ?2, ?3, ?4)",
                params![principal_id, device_id, tool, now_ms],
            )
            .map(|_| ())
        })
    }

    pub(crate) fn revoke_grant(
        &self,
        principal_id: &str,
        device_id: &str,
        tool: &str,
    ) -> anyhow::Result<bool> {
        self.with(|conn| {
            Ok(conn.execute(
                "DELETE FROM device_grants WHERE principal_id = ?1 AND device_id = ?2 AND tool = ?3",
                params![principal_id, device_id, tool],
            )? == 1)
        })
    }

    pub(crate) fn grants(
        &self,
        principal_id: &str,
        device_id: &str,
    ) -> anyhow::Result<Vec<String>> {
        self.with(|conn| {
            let mut statement = conn.prepare(
                "SELECT tool FROM device_grants WHERE principal_id = ?1 AND device_id = ?2 ORDER BY tool",
            )?;
            let rows = statement.query_map(params![principal_id, device_id], |row| row.get(0))?;
            rows.collect()
        })
    }

    /// Record one executed call (`units` = contacts returned, else 1).
    pub(crate) fn record_use(
        &self,
        principal_id: &str,
        device_id: &str,
        conversation_id: &str,
        tool: &str,
        units: i64,
        now_ms: i64,
    ) {
        let _ = self.with(|conn| {
            conn.execute(
                "DELETE FROM device_quota WHERE at_ms < ?1",
                params![now_ms - DAY_MS],
            )?;
            conn.execute(
                "INSERT INTO device_quota (principal_id, device_id, conversation_id, tool, at_ms, units) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![principal_id, device_id, conversation_id, tool, now_ms, units],
            )
        });
    }

    /// `(calls, units)` for one tool on one device since `since_ms`. A store
    /// error reads as "over every quota" so the caller asks (fails closed).
    pub(crate) fn usage_since(
        &self,
        principal_id: &str,
        device_id: &str,
        tool: &str,
        since_ms: i64,
    ) -> (i64, i64) {
        self.with(|conn| {
            conn.query_row(
                "SELECT COUNT(*), COALESCE(SUM(units), 0) FROM device_quota
                 WHERE principal_id = ?1 AND device_id = ?2 AND tool = ?3 AND at_ms >= ?4",
                params![principal_id, device_id, tool, since_ms],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap_or((i64::MAX, i64::MAX))
    }
}

/// The process-wide store at `paths::db_path("device_tools.db")`; `None` when
/// it cannot be opened, in which case every device call fails closed.
pub(crate) fn store() -> Option<Arc<DeviceToolStore>> {
    static STORE: OnceLock<Option<Arc<DeviceToolStore>>> = OnceLock::new();
    STORE
        .get_or_init(
            || match DeviceToolStore::open(&crate::paths::db_path("device_tools.db")) {
                Ok(store) => Some(Arc::new(store)),
                Err(error) => {
                    tracing::warn!(%error, "device tools store unavailable; device tools are off");
                    None
                }
            },
        )
        .clone()
}
