//! The per-device on-device confirmation key (design §2.4 step 8).
//!
//! Besides its signing key, a phone may register a second P-256 key at pairing
//! (`confirm_public_key_spki`) that the OS only lets it use after biometrics or
//! the device passcode (`.userPresence` / `setUserAuthenticationRequired`).
//! A Home security action is approved only by a signature from that key. The
//! key is public material, so it is stored as is; re-pairing replaces it.

use rusqlite::{params, OptionalExtension};

use super::DeviceToolStore;

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS device_confirm_keys (
  principal_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  public_key BLOB NOT NULL,
  set_at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, device_id)
);
";

impl DeviceToolStore {
    /// Store (or clear, with `None`) the device's confirmation key.
    pub(crate) fn set_confirm_key(
        &self,
        principal_id: &str,
        device_id: &str,
        public_key: Option<&[u8]>,
        now_ms: i64,
    ) -> anyhow::Result<()> {
        self.with(|conn| {
            match public_key {
                Some(key) => conn.execute(
                    "INSERT OR REPLACE INTO device_confirm_keys (principal_id, device_id, public_key, set_at) VALUES (?1, ?2, ?3, ?4)",
                    params![principal_id, device_id, key, now_ms],
                )?,
                None => conn.execute(
                    "DELETE FROM device_confirm_keys WHERE principal_id = ?1 AND device_id = ?2",
                    params![principal_id, device_id],
                )?,
            };
            Ok(())
        })
    }

    /// The confirmation key of an ACTIVE device; `None` for a pending device,
    /// an unknown one, or one that registered no confirmation key.
    pub(crate) fn confirm_key(&self, principal_id: &str, device_id: &str) -> Option<Vec<u8>> {
        self.active_key(principal_id, device_id)?;
        self.with(|conn| {
            conn.query_row(
                "SELECT public_key FROM device_confirm_keys WHERE principal_id = ?1 AND device_id = ?2",
                params![principal_id, device_id],
                |row| row.get(0),
            )
            .optional()
        })
        .ok()
        .flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::super::{DeviceState, NewDevice};
    use super::*;

    fn pair(store: &DeviceToolStore, state: DeviceState) {
        store
            .pair(
                &NewDevice {
                    principal_id: "user:u1",
                    device_id: "dev-1",
                    public_key: b"signing-key",
                    app: "ryu-bot",
                    platform: "ios",
                    label: "Phone",
                    attestation: None,
                    initial_state: state,
                },
                1,
            )
            .unwrap();
    }

    #[test]
    fn the_confirm_key_is_served_only_for_an_active_device_and_forget_drops_it() {
        let store = DeviceToolStore::open_in_memory().unwrap();
        pair(&store, DeviceState::Pending);
        store
            .set_confirm_key("user:u1", "dev-1", Some(b"confirm-key"), 2)
            .unwrap();
        assert_eq!(store.confirm_key("user:u1", "dev-1"), None, "pending");
        assert!(store.approve("user:u1", "dev-1").unwrap());
        assert_eq!(
            store.confirm_key("user:u1", "dev-1").as_deref(),
            Some(&b"confirm-key"[..])
        );
        assert_eq!(store.confirm_key("user:u2", "dev-1"), None, "per principal");
        store.set_confirm_key("user:u1", "dev-1", None, 3).unwrap();
        assert_eq!(store.confirm_key("user:u1", "dev-1"), None, "cleared");
        store
            .set_confirm_key("user:u1", "dev-1", Some(b"confirm-key"), 4)
            .unwrap();
        assert!(store.forget("user:u1", "dev-1").unwrap());
        pair(&store, DeviceState::Active);
        assert_eq!(
            store.confirm_key("user:u1", "dev-1"),
            None,
            "a forgotten device's confirm key does not come back on re-pair"
        );
    }
}
