//! A policy's `valueRules` refuse a value write through the vault API.

use super::*;
use crate::server::vault_api::tests::{caller, ctx, parts};

fn length_rule() -> Policy {
    serde_json::from_value(json!({
        "name": "strong",
        "description": "",
        "rules": [{
            "path": "**",
            "capabilities": ["read", "write"],
            "valueRules": { "minLength": 12, "require": ["digit"], "forbid": ["whitespace"] },
        }],
    }))
    .unwrap()
}

#[tokio::test]
async fn a_write_that_breaks_value_rules_is_refused_and_not_stored() {
    let ctx = ctx(
        None,
        Some(caller("alice", OrgRole::Member, &[])),
        true,
        vec![length_rule()],
    );
    let write = |value: &str| json!({ "scope": "user", "scopeId": "alice", "value": value });
    for (value, why) in [
        ("short1", "at least 12"),
        ("no-digits-here", "`digit`"),
        ("has space 123456", "`whitespace`"),
    ] {
        let (status, body) = parts(put_secret_with(&ctx, "DB_PASSWORD", write(value)).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{value}: {body}");
        assert!(
            body.contains("policy `strong`") && body.contains(why),
            "{body}"
        );
    }
    let coords = SecretCoords::root(SecretScope::User, "alice", None, "DB_PASSWORD");
    let actor = ctx.actor();
    assert!(ctx.store.reveal(&coords, None, &actor).await.is_err());

    let (status, body) =
        parts(put_secret_with(&ctx, "DB_PASSWORD", write("correct-horse-42")).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        ctx.store.reveal(&coords, None, &actor).await.unwrap(),
        "correct-horse-42"
    );
    // A metadata-only write carries no value, so the rules do not apply.
    let describe =
        json!({ "scope": "user", "scopeId": "alice", "metadata": { "description": "db" } });
    let (status, body) = parts(put_secret_with(&ctx, "DB_PASSWORD", describe).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
