use super::*;
use crate::server::vault_api::tests::{caller, ctx, node, parts};
use crate::server::vault_api::value_actions::{secret_action_with, VersionActionBody};

fn operator() -> Ctx {
    ctx(None, None, true, Vec::new())
}

fn member_on(store: &'static PluginSecretStore) -> Ctx {
    let mut member = ctx(
        Some(node(NodeScope::Org, None, None)),
        Some(caller("user-1", OrgRole::Member, &[])),
        false,
        Vec::new(),
    );
    member.store = store;
    member
}

fn lock_body(scope_id: &str, reason: &str) -> LockBody {
    serde_json::from_value(json!({
        "scope": "user", "scopeId": scope_id, "environment": "default", "reason": reason,
    }))
    .unwrap()
}

#[tokio::test]
async fn a_locked_subtree_answers_423_until_an_admin_unlocks_it() {
    let ctx = operator();
    let (status, _) =
        parts(put_secret_with(&ctx, "API_KEY", json!({ "value": "v1" })).await).await;
    assert_eq!(status, StatusCode::OK);

    // A member is not an admin on `sys/namespaces/...`.
    let member = member_on(ctx.store);
    let (status, _) = parts(lock_namespace_with(&member, lock_body("local", "")).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = parts(list_namespace_locks_with(&member).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, body) =
        parts(lock_namespace_with(&ctx, lock_body("local", "rotation incident")).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let lock: Value = serde_json::from_str(&body).unwrap();
    let id = lock["lock"]["id"].as_str().unwrap().to_owned();

    let (status, body) =
        parts(put_secret_with(&ctx, "API_KEY", json!({ "value": "v2" })).await).await;
    assert_eq!(status, StatusCode::LOCKED);
    assert!(body.contains("vault_locked"), "{body}");
    assert!(body.contains("rotation incident"), "{body}");
    let reveal: VersionActionBody = serde_json::from_value(json!({})).unwrap();
    let (status, _) = parts(secret_action_with(&ctx, "API_KEY", "reveal", reveal).await).await;
    assert_eq!(status, StatusCode::LOCKED);
    let coords = SecretCoords::root(SecretScope::User, "local", None, "API_KEY");
    assert!(ctx.caps(&coords).is_empty());
    // The lock names one environment: the same scope elsewhere stays writable.
    let other = json!({ "value": "x", "environment": "staging" });
    let (status, body) = parts(put_secret_with(&ctx, "OTHER", other).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, _) = parts(unlock_namespace_with(&ctx, "vnl_missing").await).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = parts(unlock_namespace_with(&ctx, &id).await).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) =
        parts(put_secret_with(&ctx, "API_KEY", json!({ "value": "v2" })).await).await;
    assert_eq!(status, StatusCode::OK);
}
