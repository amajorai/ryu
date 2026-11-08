use super::*;
use crate::plugin_secrets::{SecretResolutionContext, SecretScope};

fn coords() -> SecretCoords {
    SecretCoords {
        scope: SecretScope::Node,
        scope_id: "node-1".into(),
        environment: "prod".into(),
        path: "/".into(),
        binding: None,
        name: "API_KEY".into(),
    }
}

/// A requester whose own baseline grants the change (a personal value).
fn authority() -> RequesterAuthority {
    RequesterAuthority {
        subjects: vec!["user:dev".into(), "role:member".into()],
        baseline: [Capability::Write, Capability::Delete]
            .into_iter()
            .collect(),
    }
}

#[tokio::test]
async fn requests_apply_after_enough_distinct_approvals() {
    let store = PluginSecretStore::in_memory().unwrap();
    let requester = AuditActor::new("user", Some("dev"));
    let request = store
        .create_change_request(
            coords(),
            ChangeOperation::Write,
            Some("new"),
            json!({}),
            2,
            &requester,
            &authority(),
        )
        .await
        .unwrap();
    assert!(request.has_value);
    assert!(store
        .approve_change_request(&request.id, &requester, None)
        .await
        .is_err());
    let first = AuditActor::new("user", Some("lead"));
    let pending = store
        .approve_change_request(&request.id, &first, None)
        .await
        .unwrap();
    assert_eq!(pending.status, ChangeStatus::Pending);
    assert!(store
        .approve_change_request(&request.id, &first, None)
        .await
        .is_err());
    let applied = store
        .approve_change_request(&request.id, &AuditActor::new("user", Some("cto")), None)
        .await
        .unwrap();
    assert_eq!(applied.status, ChangeStatus::Applied);
    assert!(
        !applied.has_value,
        "the sealed proposal is cleared once applied"
    );
    let context = SecretResolutionContext::node_only("node-1", Vec::new());
    assert_eq!(
        store
            .resolve_vault_secret("prod:API_KEY", &context)
            .await
            .unwrap()
            .as_deref(),
        Some("new")
    );
}

#[tokio::test]
async fn only_the_requester_can_cancel_and_closed_requests_are_final() {
    let store = PluginSecretStore::in_memory().unwrap();
    let requester = AuditActor::new("user", Some("dev"));
    let request = store
        .create_change_request(
            coords(),
            ChangeOperation::Delete,
            None,
            json!({}),
            1,
            &requester,
            &authority(),
        )
        .await
        .unwrap();
    let other = AuditActor::new("user", Some("lead"));
    assert!(store
        .close_change_request(&request.id, &other, None, true)
        .await
        .is_err());
    let rejected = store
        .close_change_request(&request.id, &other, Some("not now"), false)
        .await
        .unwrap();
    assert_eq!(rejected.status, ChangeStatus::Rejected);
    assert!(store
        .approve_change_request(&request.id, &other, None)
        .await
        .is_err());
    assert_eq!(
        store
            .list_change_requests(Some(ChangeStatus::Rejected))
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn expired_requests_are_rejected_instead_of_applied() {
    let store = PluginSecretStore::in_memory().unwrap();
    let requester = AuditActor::new("user", Some("dev"));
    let request = store
        .create_change_request(
            coords(),
            ChangeOperation::Write,
            Some("stale"),
            json!({}),
            1,
            &requester,
            &authority(),
        )
        .await
        .unwrap();
    assert_eq!(
        request.expires_at,
        request.requested_at + CHANGE_REQUEST_TTL_MS
    );
    store
        .conn
        .lock()
        .await
        .execute(
            "UPDATE vault_change_requests SET requested_at = ?1 WHERE id = ?2",
            params![now_millis() - CHANGE_REQUEST_TTL_MS - 1, request.id],
        )
        .unwrap();
    let lead = AuditActor::new("user", Some("lead"));
    let error = store
        .approve_change_request(&request.id, &lead, Some(1))
        .await
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<VaultError>(),
        Some(VaultError::Conflict(_))
    ));
    let closed = store.change_request(&request.id).await.unwrap();
    assert_eq!(closed.status, ChangeStatus::Rejected);
    assert_eq!(closed.reason.as_deref(), Some("expired"));
    assert!(!closed.has_value, "the sealed proposal is dropped");
    let context = SecretResolutionContext::node_only("node-1", Vec::new());
    assert_eq!(
        store
            .resolve_vault_secret("prod:API_KEY", &context)
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn a_raised_environment_threshold_covers_pending_requests() {
    let store = PluginSecretStore::in_memory().unwrap();
    let requester = AuditActor::new("user", Some("dev"));
    let request = store
        .create_change_request(
            coords(),
            ChangeOperation::Write,
            Some("new"),
            json!({}),
            1,
            &requester,
            &authority(),
        )
        .await
        .unwrap();
    let pending = store
        .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(2))
        .await
        .unwrap();
    assert_eq!(pending.status, ChangeStatus::Pending);
    let applied = store
        .approve_change_request(&request.id, &AuditActor::new("user", Some("cto")), Some(2))
        .await
        .unwrap();
    assert_eq!(applied.status, ChangeStatus::Applied);
}

/// A requester whose `write` came from a temporary policy binding.
async fn request_through_binding(
    store: &PluginSecretStore,
    expires_at: Option<i64>,
) -> (ChangeRequest, String) {
    let binding = {
        let conn = store.conn.lock().await;
        super::super::policy::put_policy(
            &conn,
            &super::super::policy::Policy {
                name: "prod-writers".into(),
                description: String::new(),
                rules: vec![super::super::policy::PolicyRule {
                    path: "prod/**".into(),
                    capabilities: vec![Capability::Write],
                    ..Default::default()
                }],
            },
        )
        .unwrap();
        super::super::policy::bind(&conn, "prod-writers", "user:dev", expires_at, None).unwrap()
    };
    let request = store
        .create_change_request(
            coords(),
            ChangeOperation::Write,
            Some("new"),
            json!({}),
            1,
            &AuditActor::new("user", Some("dev")),
            &RequesterAuthority {
                subjects: vec!["user:dev".into(), "role:member".into()],
                baseline: [Capability::List, Capability::Use].into_iter().collect(),
            },
        )
        .await
        .unwrap();
    (request, binding.id)
}

async fn assert_rejected_unapplied(store: &PluginSecretStore, id: &str, reason: &str) {
    let closed = store.change_request(id).await.unwrap();
    assert_eq!(closed.status, ChangeStatus::Rejected);
    assert_eq!(closed.reason.as_deref(), Some(reason));
    assert!(!closed.has_value, "the sealed proposal is dropped");
    let context = SecretResolutionContext::node_only("node-1", Vec::new());
    assert_eq!(
        store
            .resolve_vault_secret("prod:API_KEY", &context)
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn a_requester_whose_binding_expired_is_not_applied() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (request, binding) = request_through_binding(&store, Some(now_millis() + 60_000)).await;
    store
        .conn
        .lock()
        .await
        .execute(
            "UPDATE vault_policy_bindings SET expires_at = 1 WHERE id = ?1",
            params![binding],
        )
        .unwrap();
    let error = store
        .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
        .await
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<VaultError>(),
        Some(VaultError::Conflict(_))
    ));
    assert_rejected_unapplied(&store, &request.id, REQUESTER_NO_LONGER_AUTHORIZED).await;
}

#[tokio::test]
async fn a_requester_who_was_unbound_is_not_applied() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (request, binding) = request_through_binding(&store, None).await;
    assert!(super::super::policy::unbind(&*store.conn.lock().await, &binding).unwrap());
    assert!(store
        .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
        .await
        .is_err());
    assert_rejected_unapplied(&store, &request.id, REQUESTER_NO_LONGER_AUTHORIZED).await;
}

#[tokio::test]
async fn a_requester_who_still_holds_the_binding_is_applied() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (request, _) = request_through_binding(&store, Some(now_millis() + 60_000)).await;
    let applied = store
        .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
        .await
        .unwrap();
    assert_eq!(applied.status, ChangeStatus::Applied);
}

#[tokio::test]
async fn a_request_without_a_recorded_authority_fails_closed() {
    let store = PluginSecretStore::in_memory().unwrap();
    let request = store
        .create_change_request(
            coords(),
            ChangeOperation::Delete,
            None,
            json!({}),
            1,
            &AuditActor::new("user", Some("dev")),
            &authority(),
        )
        .await
        .unwrap();
    store
        .conn
        .lock()
        .await
        .execute(
            "UPDATE vault_change_requests
             SET requester_subjects = NULL, requester_baseline = NULL WHERE id = ?1",
            params![request.id],
        )
        .unwrap();
    assert!(store
        .approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1))
        .await
        .is_err());
    assert_rejected_unapplied(&store, &request.id, REQUESTER_NO_LONGER_AUTHORIZED).await;
}

#[tokio::test]
async fn an_unwrapped_approval_does_not_drop_a_requesters_wrapped_write() {
    let store = PluginSecretStore::in_memory().unwrap();
    {
        let conn = store.conn.lock().await;
        crate::vault::policy::put_policy(
            &conn,
            &crate::vault::policy::Policy {
                name: "prod-wrapped-writers".into(),
                description: String::new(),
                rules: vec![crate::vault::policy::PolicyRule {
                    path: "prod/**".into(),
                    capabilities: vec![Capability::Write],
                    min_wrapping_ttl_secs: Some(60),
                    ..Default::default()
                }],
            },
        )
        .unwrap();
        crate::vault::policy::bind(&conn, "prod-wrapped-writers", "user:dev", None, None).unwrap();
    }
    let request = store
        .create_change_request(
            coords(),
            ChangeOperation::Write,
            Some("new"),
            json!({}),
            1,
            &AuditActor::new("user", Some("dev")),
            &RequesterAuthority {
                subjects: vec!["user:dev".into()],
                baseline: CapabilitySet::new(),
            },
        )
        .await
        .unwrap();
    // The approver's request carries no wrap TTL; the requester's rule needs one.
    let (approved, violations) = crate::vault::policy::wrap_requirement::scope(
        None,
        store.approve_change_request(&request.id, &AuditActor::new("user", Some("lead")), Some(1)),
    )
    .await;
    assert_eq!(approved.unwrap().status, ChangeStatus::Applied);
    assert!(violations.is_empty(), "{violations:?}");
    let context = SecretResolutionContext::node_only("node-1", Vec::new());
    assert_eq!(
        store
            .resolve_vault_secret("prod:API_KEY", &context)
            .await
            .unwrap()
            .as_deref(),
        Some("new")
    );
}

#[path = "tests_base.rs"]
mod base;
