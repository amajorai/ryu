//! The loop's pure helpers: the env toggle, error mapping and push skipping.

use super::*;
use crate::server::sync::payloads::{document_needs_push, effective_replay_tenancy};
use crate::server::sync::sync_loop::{env_sync_enabled, is_auth_rejection, warn_token_rejected};

/// `env_sync_enabled` is truthy only for the documented tokens; anything else
/// (including `0`/`false`/unset) keeps the local-first default OFF.
#[test]
fn env_sync_enabled_only_for_truthy_tokens() {
    let _guard = ENV_GUARD.lock().unwrap();
    let prior = std::env::var(SYNC_ENABLED_ENV).ok();

    for truthy in ["1", "true", "TRUE", "yes"] {
        std::env::set_var(SYNC_ENABLED_ENV, truthy);
        assert!(env_sync_enabled(), "'{truthy}' must enable sync");
    }
    for falsy in ["0", "false", "no", "", "TrUe", "enabled"] {
        std::env::set_var(SYNC_ENABLED_ENV, falsy);
        assert!(!env_sync_enabled(), "'{falsy}' must NOT enable sync");
    }
    std::env::remove_var(SYNC_ENABLED_ENV);
    assert!(
        !env_sync_enabled(),
        "unset must default to OFF (local-first)"
    );

    // Restore whatever the environment had before this test.
    match prior {
        Some(v) => std::env::set_var(SYNC_ENABLED_ENV, v),
        None => std::env::remove_var(SYNC_ENABLED_ENV),
    }
}

/// `effective_replay_tenancy`: an unbound context stays byte-identical
/// (`Unattributed`, author ignored); a bound context owns the row by the PAYLOAD
/// author scoped to the node's org, and an author-less payload collapses to
/// `Unattributed` (the pair the caller then refuses on a bound node).
#[test]
fn effective_replay_tenancy_derives_owner_from_payload() {
    let authored = sample_payload("c1");

    // Unbound: author ignored, NULL-tenanted.
    assert_eq!(
        effective_replay_tenancy(&authored, &Tenancy::Unattributed),
        Tenancy::Unattributed
    );

    // Bound: owned by the payload's author ("bob"), scoped to the node's org —
    // never the context user ("device-owner").
    let ctx = Tenancy::Owned {
        user_id: "device-owner".to_owned(),
        org_id: Some("org1".to_owned()),
    };
    assert_eq!(
        effective_replay_tenancy(&authored, &ctx),
        Tenancy::owned_by(Some("bob"), Some("org1"))
    );

    // Bound + author-less payload → Unattributed (fail-closed sentinel).
    let mut orphan = sample_payload("c2");
    orphan.owner_user_id = None;
    assert_eq!(
        effective_replay_tenancy(&orphan, &ctx),
        Tenancy::Unattributed
    );
}

/// `SyncError` renders each variant distinctly and `From<reqwest::Error>` maps to
/// the `Http` arm (the `?`-conversion the client relies on).
#[test]
fn sync_error_display_and_from() {
    assert_eq!(
        SyncError::Unauthenticated.to_string(),
        "no auth token found — complete device login first"
    );
    assert_eq!(
        SyncError::ServerError(503, "down".to_owned()).to_string(),
        "server returned 503: down"
    );
    assert!(SyncError::Store(anyhow::anyhow!("boom"))
        .to_string()
        .contains("boom"));
}

/// Only a refusal of the token itself stops the tick; per-item and transient
/// failures keep retrying item by item.
#[test]
fn is_auth_rejection_matches_only_token_refusals() {
    let rejected = |status| is_auth_rejection(&SyncError::ServerError(status, String::new()));
    assert!(rejected(401));
    assert!(rejected(403));
    for status in [413, 500, 502] {
        assert!(!rejected(status));
    }
    assert!(!is_auth_rejection(&SyncError::Unauthenticated));
    let store_error = SyncError::Store(anyhow::anyhow!("boom"));
    assert!(!is_auth_rejection(&store_error));
}

#[test]
fn warn_token_rejected_sets_the_throttle_flag() {
    let mut warned = false;
    let error = SyncError::ServerError(401, String::new());
    warn_token_rejected(&mut warned, &error);
    assert!(warned);
    warn_token_rejected(&mut warned, &error);
    assert!(warned);
}

/// An unchanged document is not re-uploaded every tick; a newer `updated_at`
/// (any edit, including icon or visibility) is pushed again.
#[test]
fn document_needs_push_skips_only_an_already_pushed_stamp() {
    let mut payload = DocumentSyncPayload {
        document_id: "doc".to_owned(),
        title: "Doc".to_owned(),
        source: "body".to_owned(),
        kind: "page".to_owned(),
        parent_id: None,
        icon: None,
        created_at: 1,
        updated_at: 10,
        revision: 1,
        owner_user_id: None,
        space: ryu_spaces::SpaceSyncRecord {
            id: "space".to_owned(),
            name: "Space".to_owned(),
            description: None,
            created_at: 1,
            updated_at: 1,
            retrieval_mode: "hybrid".to_owned(),
            visibility: "private".to_owned(),
            team_id: None,
        },
    };
    let mut pushed = std::collections::HashMap::new();
    assert!(document_needs_push(&pushed, &payload));

    pushed.insert(payload.document_id.clone(), payload.updated_at);
    assert!(!document_needs_push(&pushed, &payload));

    payload.updated_at = 11;
    assert!(document_needs_push(&pushed, &payload));

    payload.document_id = "other".to_owned();
    payload.updated_at = 10;
    assert!(document_needs_push(&pushed, &payload));
}
