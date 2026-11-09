//! Persisted replay protection for device-lane signatures.
//!
//! The in-process cache in `identity` forgets everything on restart, which
//! would let a request signed just before a restart be replayed just after it.
//! Every accepted replay key (the signature's canonical low-S form, never the
//! header text) is therefore also recorded here until its window ends.

use rusqlite::params;

use super::DeviceToolStore;
use crate::device_tools::identity::REPLAY_WINDOW_MS;

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS device_replay (
  device_id TEXT NOT NULL,
  replay_key TEXT NOT NULL,
  expires_ms INTEGER NOT NULL,
  PRIMARY KEY (device_id, replay_key)
);
CREATE INDEX IF NOT EXISTS device_replay_expiry ON device_replay (expires_ms);
";

impl DeviceToolStore {
    /// Record an accepted signature. `false` when the same `(device, key)` was
    /// already accepted inside its window (a replay, also across restarts) or
    /// when the store cannot answer (fail closed).
    pub(crate) fn accept_signature(&self, device_id: &str, replay_key: &str, now_ms: i64) -> bool {
        self.with(|conn| {
            conn.execute(
                "DELETE FROM device_replay WHERE expires_ms <= ?1",
                params![now_ms],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO device_replay (device_id, replay_key, expires_ms) VALUES (?1, ?2, ?3)",
                params![device_id, replay_key, now_ms + REPLAY_WINDOW_MS],
            )
        })
        .is_ok_and(|inserted| inserted == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_accepted_once_per_window_and_survives_reopening() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("device_tools.db");
        let now = 1_800_000_000_000;
        let store = DeviceToolStore::open(&path).unwrap();
        assert!(store.accept_signature("dev-1", "k1", now));
        assert!(!store.accept_signature("dev-1", "k1", now + 1));
        assert!(
            store.accept_signature("dev-2", "k1", now),
            "keys are per device"
        );
        drop(store);
        // A restart (a new connection on the same file) still refuses it.
        let reopened = DeviceToolStore::open(&path).unwrap();
        assert!(!reopened.accept_signature("dev-1", "k1", now + 2));
        // After the window the row is pruned; the timestamp check refuses
        // such an old request long before that.
        assert!(reopened.accept_signature("dev-1", "k1", now + REPLAY_WINDOW_MS + 1));
    }
}
