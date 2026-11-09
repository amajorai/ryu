//! Per-member revocation of app route delegations.
//!
//! A delegation (`rad1.` token, see [`super::app_route_delegation`]) names the
//! member it acts for and when it was issued. Revoking a member records a
//! revocation epoch for them: every delegation issued to that member at or
//! before the epoch is refused on its next use, while ones minted afterwards
//! (the member is re-added) work again.
//!
//! An epoch is bumped:
//!
//! - when the member's app data is purged because they were removed from this
//!   node's organization or deleted their account (`POST /api/data/purge-user`,
//!   including the control plane's purge delegation);
//! - by the node owner or an organization admin for one member
//!   (`POST /api/app-delegations/revoke`).
//!
//! Epochs persist under `state/` so a restart does not resurrect a revoked
//! delegation. An epoch older than the longest delegation lifetime can no
//! longer refuse anything live, so it is pruned.
//!
//! The store fails closed: when the state file exists but cannot be read or
//! parsed, every member delegation issued before it was loaded is refused (a
//! node-wide epoch), since any of them may have been revoked. Clients mint a
//! new one.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::app_route_delegation::MAX_TTL_SECONDS;

const STATE_FILE: &str = "app-route-revocations.json";
/// How long past an epoch it is kept: the longest lifetime plus skew.
const RETAIN_SECONDS: u64 = MAX_TTL_SECONDS + 60;

/// Revocation epochs per member: `user_id -> revoked_at` (Unix seconds).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Revocations {
    #[serde(default)]
    users: BTreeMap<String, u64>,
    /// Refuses every member delegation issued at or before it: set when the
    /// stored epochs could not be read. 0 when unset.
    #[serde(default, skip_serializing_if = "is_zero")]
    all_members: u64,
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

impl Revocations {
    /// Revoke every delegation issued to `user_id` at or before `now`.
    pub(crate) fn revoke(&mut self, user_id: &str, now: u64) {
        let epoch = self.users.entry(user_id.to_owned()).or_insert(0);
        *epoch = (*epoch).max(now);
    }

    /// Whether a delegation for `user` issued at `iat` is revoked. The owner
    /// of an unbound node (`None`) is revoked only by rotating the node token.
    pub(crate) fn refuses(&self, user: Option<&str>, iat: u64) -> bool {
        let Some(user) = user else {
            return false;
        };
        iat <= self.all_members || self.users.get(user).is_some_and(|epoch| iat <= *epoch)
    }

    /// Drop epochs that no live delegation can predate any more.
    pub(crate) fn prune(&mut self, now: u64) {
        self.users
            .retain(|_, epoch| epoch.saturating_add(RETAIN_SECONDS) > now);
        if self.all_members.saturating_add(RETAIN_SECONDS) <= now {
            self.all_members = 0;
        }
    }

    /// The epoch recorded for `user_id`.
    pub(crate) fn epoch(&self, user_id: &str) -> Option<u64> {
        self.users.get(user_id).copied()
    }
}

/// The stored epochs. A missing file is empty; an unreadable or corrupt one
/// fails closed, refusing every member delegation issued at or before `now`.
fn load_from(path: &Path, now: u64) -> Revocations {
    let failed_closed = || Revocations {
        all_members: now,
        ..Revocations::default()
    };
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Revocations::default();
        }
        Err(error) => {
            tracing::error!(
                %error,
                "app-delegations: revocations unreadable; refusing member delegations issued before now"
            );
            return failed_closed();
        }
    };
    serde_json::from_slice(&bytes).unwrap_or_else(|error| {
        tracing::error!(
            %error,
            "app-delegations: revocations corrupt; refusing member delegations issued before now"
        );
        failed_closed()
    })
}

fn save_to(path: &Path, revocations: &Revocations) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(revocations).map_err(std::io::Error::other)?;
    crate::atomic_file::write_atomic(path, &bytes)
}

fn state_file() -> PathBuf {
    crate::paths::state_path(STATE_FILE)
}

static CACHE: Mutex<Option<Revocations>> = Mutex::new(None);

fn with_revocations<T>(apply: impl FnOnce(&mut Revocations) -> T) -> T {
    let mut guard = CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let revocations =
        guard.get_or_insert_with(|| load_from(&state_file(), crate::pairing::now_secs()));
    apply(revocations)
}

/// Revoke `user_id`'s outstanding delegations as of `now` and persist it.
/// Returns the epoch now in force.
pub(crate) fn revoke_user(user_id: &str, now: u64) -> u64 {
    with_revocations(|revocations| {
        revocations.revoke(user_id, now);
        revocations.prune(now);
        if let Err(error) = save_to(&state_file(), revocations) {
            // The epoch still holds in memory until restart.
            tracing::error!(%error, "app-delegations: could not persist a revocation");
        }
        revocations.epoch(user_id).unwrap_or(now)
    })
}

/// The epoch recorded for `user_id` alone (ignoring an all-members revocation).
#[cfg(test)]
pub(crate) fn user_epoch(user_id: &str) -> Option<u64> {
    with_revocations(|revocations| revocations.epoch(user_id))
}

/// Whether a delegation for `user` issued at `iat` has been revoked.
pub(crate) fn is_revoked(user: Option<&str>, iat: u64) -> bool {
    user.is_some() && with_revocations(|revocations| revocations.refuses(user, iat))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_revocation_refuses_delegations_issued_at_or_before_it() {
        let mut revocations = Revocations::default();
        revocations.revoke("u1", 1_000);
        assert!(revocations.refuses(Some("u1"), 999));
        assert!(revocations.refuses(Some("u1"), 1_000));
        assert!(!revocations.refuses(Some("u1"), 1_001));
        assert!(!revocations.refuses(Some("u2"), 999));
        assert!(!revocations.refuses(None, 999));
    }

    #[test]
    fn an_epoch_never_moves_backwards() {
        let mut revocations = Revocations::default();
        revocations.revoke("u1", 2_000);
        revocations.revoke("u1", 1_000);
        assert_eq!(revocations.epoch("u1"), Some(2_000));
    }

    #[test]
    fn epochs_older_than_any_live_delegation_are_pruned() {
        let mut revocations = Revocations::default();
        revocations.revoke("old", 1_000);
        revocations.revoke("new", 1_000 + RETAIN_SECONDS);
        revocations.prune(1_000 + RETAIN_SECONDS);
        assert_eq!(revocations.epoch("old"), None);
        assert_eq!(revocations.epoch("new"), Some(1_000 + RETAIN_SECONDS));
    }

    #[test]
    fn revocations_survive_a_reload_and_a_missing_file_reads_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(STATE_FILE);
        assert_eq!(load_from(&path, 5_000), Revocations::default());
        let mut revocations = Revocations::default();
        revocations.revoke("u1", 42);
        save_to(&path, &revocations).expect("save");
        assert_eq!(load_from(&path, 5_000), revocations);
    }

    #[test]
    fn a_corrupt_file_refuses_member_delegations_issued_before_the_load() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(STATE_FILE);
        std::fs::write(&path, b"not json").expect("write");
        let mut revocations = load_from(&path, 5_000);
        assert!(revocations.refuses(Some("anyone"), 4_999));
        assert!(revocations.refuses(Some("anyone"), 5_000));
        assert!(!revocations.refuses(Some("anyone"), 5_001));
        // The unbound owner is revoked only by rotating the node token.
        assert!(!revocations.refuses(None, 4_999));
        // Persisted, the node-wide epoch survives the next reload...
        save_to(&path, &revocations).expect("save");
        assert!(load_from(&path, 6_000).refuses(Some("anyone"), 4_999));
        // ...until no live delegation can predate it.
        revocations.prune(5_000 + RETAIN_SECONDS);
        assert!(!revocations.refuses(Some("anyone"), 4_999));
    }

    #[test]
    fn an_unreadable_file_fails_closed() {
        let dir = tempfile::tempdir().expect("tempdir");
        // A directory where the file should be: present but not readable.
        let path = dir.path().join(STATE_FILE);
        std::fs::create_dir(&path).expect("mkdir");
        assert!(load_from(&path, 7_000).refuses(Some("u1"), 6_000));
    }
}
