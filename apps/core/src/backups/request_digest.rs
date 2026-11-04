//! The idempotency digest of a backup request.
//!
//! A retried `create` with the same idempotency key must find its operation even
//! when the app re-sends its JSON payload with the keys in another order:
//! `serde_json/preserve_order` is on for the whole build, so the plain bytes
//! follow the caller's order. The digest is over canonical JSON (object keys
//! sorted recursively). Operations recorded before hold the digest of the
//! insertion-order bytes; a retry of the same request still matches them.

use anyhow::Result;
use ryu_backup::BackupScope;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The digest a new operation records, plus the insertion-order form an older
/// operation may hold for the same request.
pub(super) struct RequestDigest {
    pub(super) canonical: String,
    legacy: Option<String>,
}

impl RequestDigest {
    /// The digest of a backup of `scope` carrying `app_data`.
    pub(super) fn for_backup(scope: &BackupScope, app_data: Option<&Value>) -> Result<Self> {
        let canonical = digest(
            ryu_safe_actions::canonical_json(scope)?,
            app_data.map(ryu_safe_actions::canonical_json).transpose()?,
        );
        let legacy = digest(
            serde_json::to_vec(scope)?,
            app_data.map(serde_json::to_vec).transpose()?,
        );
        Ok(Self {
            canonical,
            legacy: Some(legacy),
        })
    }

    /// Whether an operation that recorded `recorded` was made by this request.
    pub(super) fn matches(&self, recorded: &str) -> bool {
        recorded == self.canonical || self.legacy.as_deref() == Some(recorded)
    }
}

/// A request identified by an exact value with one form (a restore keys on its
/// backup id).
impl From<String> for RequestDigest {
    fn from(canonical: String) -> Self {
        Self {
            canonical,
            legacy: None,
        }
    }
}

impl From<&str> for RequestDigest {
    fn from(canonical: &str) -> Self {
        canonical.to_owned().into()
    }
}

fn digest(scope: Vec<u8>, payload: Option<Vec<u8>>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(scope);
    if let Some(payload) = payload {
        hasher.update(payload);
    }
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app() -> BackupScope {
        BackupScope::App {
            app_id: "@ryu/example".into(),
            namespace: "default".into(),
            tenant: "alice".into(),
        }
    }

    fn data(json: &str) -> Value {
        serde_json::from_str(json).expect("fixture data parses")
    }

    #[test]
    fn a_reordered_retry_matches_and_a_real_change_does_not() {
        let original = data(r#"{"notes":[{"title":"a","body":"b"}],"version":2}"#);
        let reordered = data(r#"{"version":2,"notes":[{"body":"b","title":"a"}]}"#);
        let changed = data(r#"{"notes":[{"title":"a","body":"c"}],"version":2}"#);
        let recorded = RequestDigest::for_backup(&app(), Some(&original)).unwrap();
        let retry = RequestDigest::for_backup(&app(), Some(&reordered)).unwrap();
        // The fixture really is reordered: the insertion-order bytes differ.
        assert_ne!(recorded.legacy, retry.legacy);
        assert!(retry.matches(&recorded.canonical));
        let changed = RequestDigest::for_backup(&app(), Some(&changed)).unwrap();
        assert!(!changed.matches(&recorded.canonical));
        let node = RequestDigest::for_backup(&BackupScope::Node, None).unwrap();
        assert!(!node.matches(&recorded.canonical));
    }

    #[test]
    fn an_operation_recorded_before_the_canonical_digest_still_matches() {
        let original = data(r#"{"notes":[{"title":"a","body":"b"}],"version":2}"#);
        // What `create` recorded before: SHA-256 over the scope bytes then the
        // payload bytes, both in insertion order.
        let mut hasher = Sha256::new();
        hasher.update(serde_json::to_vec(&app()).unwrap());
        hasher.update(serde_json::to_vec(&original).unwrap());
        let recorded = hex::encode(hasher.finalize());
        let retry = RequestDigest::for_backup(&app(), Some(&original)).unwrap();
        assert_ne!(retry.canonical, recorded);
        assert!(retry.matches(&recorded));
        let changed = data(r#"{"notes":[{"title":"a","body":"c"}],"version":2}"#);
        let changed = RequestDigest::for_backup(&app(), Some(&changed)).unwrap();
        assert!(!changed.matches(&recorded));
    }

    #[test]
    fn an_exact_digest_has_no_second_form() {
        let restore = RequestDigest::from("backup-1");
        assert!(restore.matches("backup-1"));
        assert!(!restore.matches("backup-2"));
    }
}
