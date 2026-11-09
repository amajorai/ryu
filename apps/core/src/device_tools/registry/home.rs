//! The signed Home accessory cache (design §3.2, table
//! `device_home_accessories`).
//!
//! After every `device.home.list` the phone posts a signed map of its
//! accessories to their HomeKit service types. Core decides whether a
//! `device.home.set` is security class from this cache alone, never from what
//! the model passes through. Each post replaces the device's whole snapshot.

use rusqlite::{params, OptionalExtension};

use super::DeviceToolStore;
use crate::device_tools::home::HomeAccessory;

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS device_home_accessories (
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  accessory_id TEXT NOT NULL,
  name TEXT NOT NULL,
  services TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, device_id, accessory_id)
);
";

/// One cached accessory and when the phone last reported it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CachedAccessory {
    pub(crate) accessory: HomeAccessory,
    pub(crate) updated_ms: i64,
}

impl DeviceToolStore {
    /// Replace the device's accessory snapshot.
    pub(crate) fn replace_home_accessories(
        &self,
        principal_id: &str,
        device_id: &str,
        accessories: &[HomeAccessory],
        now_ms: i64,
    ) -> anyhow::Result<()> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| anyhow::anyhow!("device tool store poisoned"))?;
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM device_home_accessories WHERE principal_id = ?1 AND device_id = ?2",
            params![principal_id, device_id],
        )?;
        for accessory in accessories {
            tx.execute(
                "INSERT OR REPLACE INTO device_home_accessories (principal_id, device_id, accessory_id, name, services, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    principal_id,
                    device_id,
                    accessory.id,
                    accessory.name,
                    serde_json::to_string(&accessory.services)?,
                    now_ms
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// One cached accessory of one device, if the phone reported it.
    pub(crate) fn home_accessory(
        &self,
        principal_id: &str,
        device_id: &str,
        accessory_id: &str,
    ) -> Option<CachedAccessory> {
        let row: Option<(String, String, i64)> = self
            .with(|conn| {
                conn.query_row(
                    "SELECT name, services, updated_at FROM device_home_accessories
                     WHERE principal_id = ?1 AND device_id = ?2 AND accessory_id = ?3",
                    params![principal_id, device_id, accessory_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
            })
            .ok()
            .flatten();
        let (name, services, updated_ms) = row?;
        // An unreadable services column reads as "unknown", which the
        // classifier treats as security class (fails closed).
        let services: Vec<String> = serde_json::from_str(&services).ok()?;
        Some(CachedAccessory {
            accessory: HomeAccessory {
                id: accessory_id.to_owned(),
                name,
                services,
            },
            updated_ms,
        })
    }
}
