use super::*;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::policy::{self, Policy, PolicyRule};

fn store() -> &'static PluginSecretStore {
    Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()))
}

/// A member `user_id` holding the policies bound to them now.
async fn member(store: &'static PluginSecretStore, user_id: &str) -> Ctx {
    let policies = {
        let conn = store.conn.lock().await;
        policy::policies_for(&conn, &[format!("user:{user_id}")]).unwrap()
    };
    Ctx::test_member(store, user_id, policies)
}

fn admin_policy() -> Policy {
    Policy {
        name: "access-admin".to_owned(),
        description: String::new(),
        rules: vec![PolicyRule {
            path: "sys/access-requests".to_owned(),
            capabilities: vec![Capability::Admin],
            ..Default::default()
        }],
    }
}

async fn body_json(response: Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn request_approve_and_revoke_through_the_routes() {
    let store = store();
    let carol = Ctx::test_member(store, "carol", vec![admin_policy()]);
    let alice = member(store, "alice").await;

    // Only an admin writes access policies.
    let chain = json!({
        "path": "prod/**",
        "capabilities": ["use", "read"],
        "maxDurationSecs": 3600,
        "steps": [{ "name": "lead", "approvers": ["user:bob"], "approvals": 1 }],
    });
    let refused = put_policy_for(&alice, "prod", chain.clone()).await;
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    let stored = put_policy_for(&carol, "prod", chain).await;
    assert_eq!(stored.status(), StatusCode::OK);
    let listed = body_json(list_policies_for(&alice).await).await;
    assert_eq!(listed["accessPolicies"][0]["name"], "prod");

    let opened = create_request_for(
        &alice,
        json!({ "path": "prod/api/*", "capabilities": ["read"], "durationSecs": 600,
                "reason": "debug the outage" }),
    )
    .await;
    assert_eq!(opened.status(), StatusCode::CREATED);
    let opened = body_json(opened).await;
    let id = opened["accessRequest"]["id"].as_str().unwrap().to_owned();
    assert_eq!(opened["accessRequest"]["status"], "pending");
    assert_eq!(opened["accessRequest"]["currentStep"], "prod/lead");

    // Strangers see nothing; the requester cannot approve.
    let eve = member(store, "eve").await;
    let hidden = decide_for(&eve, &id, "approve", Value::Null).await;
    assert_eq!(hidden.status(), StatusCode::NOT_FOUND);
    let own = decide_for(&alice, &id, "approve", Value::Null).await;
    assert_eq!(own.status(), StatusCode::FORBIDDEN);
    let bob = member(store, "bob").await;
    let pending = body_json(list_requests_for(&bob).await).await;
    assert_eq!(pending["accessRequests"][0]["id"], id.as_str());

    let granted = decide_for(&bob, &id, "approve", Value::Null).await;
    assert_eq!(granted.status(), StatusCode::OK);
    let granted = body_json(granted).await;
    assert_eq!(granted["accessRequest"]["status"], "granted");
    assert!(granted["accessRequest"]["grantExpiresAt"].is_string());

    // The grant is an ordinary expiring binding: alice now reads under it.
    let alice = member(store, "alice").await;
    assert!(alice.sys_caps("prod/api/KEY").contains(&Capability::Read));
    assert!(!alice.sys_caps("prod/web/KEY").contains(&Capability::Read));

    let revoked = decide_for(&alice, &id, "revoke", Value::Null).await;
    assert_eq!(revoked.status(), StatusCode::OK);
    let alice = member(store, "alice").await;
    assert!(alice.sys_caps("prod/api/KEY").is_empty());

    let unknown = decide_for(&alice, &id, "escalate", Value::Null).await;
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn bad_bodies_and_uncovered_paths_are_refused() {
    let store = store();
    let alice = member(store, "alice").await;
    let unknown_field = create_request_for(
        &alice,
        json!({ "path": "prod/**", "capabilities": ["use"], "durationSecs": 600,
                "reason": "x", "approver": "user:alice" }),
    )
    .await;
    assert_eq!(unknown_field.status(), StatusCode::BAD_REQUEST);
    let uncovered = create_request_for(
        &alice,
        json!({ "path": "prod/**", "capabilities": ["use"], "durationSecs": 600, "reason": "x" }),
    )
    .await;
    assert_eq!(uncovered.status(), StatusCode::FORBIDDEN);
    let bad_deny = decide_for(&alice, "missing", "deny", json!({ "note": 1 })).await;
    assert_eq!(bad_deny.status(), StatusCode::BAD_REQUEST);
}
