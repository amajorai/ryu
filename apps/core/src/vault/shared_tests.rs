//! Tests for [`super`]: gating, proxied requests and refusals.

use super::*;

#[tokio::test]
async fn disabled_without_a_registered_node() {
    assert!(!is_enabled());
    let context = SecretResolutionContext {
        user_id: Some("u1".into()),
        node_id: "node-1".into(),
        ..Default::default()
    };
    assert_eq!(
        resolve(&context, SecretScope::Org, "org-1", "default", "/", "TOKEN").await,
        None
    );
    assert!(matches!(
        proxy(reqwest::Method::GET, "/secrets", &[], "jwt", None, false).await,
        Err(ProxyError::Unavailable)
    ));
}

fn header<'a>(request: &'a reqwest::Request, name: &str) -> Option<&'a str> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
}

#[test]
fn every_proxied_request_carries_the_node_key_and_only_a_vouch_asks_for_one() {
    let client = reqwest::Client::new();
    let build = |node_proof: bool| {
        build_proxy_request(
            &client,
            "http://control-plane.test/api/control-plane/orgs/o/vault/export".to_owned(),
            reqwest::Method::POST,
            &[],
            "user.jwt.token",
            "rgw_node_key",
            Some(json!({ "environment": "default" })),
            node_proof,
        )
        .build()
        .expect("request builds")
    };
    let plain = build(false);
    assert_eq!(header(&plain, "x-gateway-key"), Some("rgw_node_key"));
    assert_eq!(
        header(&plain, "authorization"),
        Some("Bearer user.jwt.token")
    );
    assert_eq!(header(&plain, NODE_VOUCH_HEADER), None);
    assert_eq!(header(&plain, "x-ryu-user-jwt"), None);
    assert_eq!(header(&plain, "cookie"), None);
    let vouched = build(true);
    assert_eq!(header(&vouched, "x-gateway-key"), Some("rgw_node_key"));
    assert_eq!(header(&vouched, NODE_VOUCH_HEADER), Some("1"));
}

#[test]
fn the_proxied_subpaths_are_exactly_the_control_plane_allowlist() {
    // Paired with `CORE_FORWARDED_JWT_ROUTES` in
    // packages/api/src/lib/forwarded-user-jwt.ts (its guard test reads this
    // list): the control plane takes a forwarded JWT on these and no other.
    let get = reqwest::Method::GET;
    let post = reqwest::Method::POST;
    let put = reqwest::Method::PUT;
    let delete = reqwest::Method::DELETE;
    for (method, subpath) in [
        (&get, "/secrets"),
        (&put, "/secrets/API_KEY"),
        (&delete, "/secrets/API%20KEY"),
        (&get, "/secrets/API_KEY/versions"),
        (&post, "/secrets/API_KEY/reveal"),
        (&post, "/secrets/API_KEY/rollback"),
        (&post, "/secrets/API_KEY/restore"),
        (&post, "/secrets/API_KEY/destroy"),
        (&post, "/export"),
        (&post, "/import"),
        (&get, "/change-requests"),
        (&post, "/change-requests/cr_1/approve"),
    ] {
        assert!(is_proxied_subpath(method, subpath), "{method} {subpath}");
    }
    for (method, subpath) in [
        (&get, "/policies"),
        (&get, "/audit"),
        (&put, "/environments/staging"),
        (&get, "/export"),
        (&post, "/secrets"),
        (&post, "/secrets//reveal"),
        (&post, "/secrets/API_KEY/share"),
        (&post, "/export/"),
    ] {
        assert!(!is_proxied_subpath(method, subpath), "{method} {subpath}");
    }
    assert_eq!(PROXIED_SUBPATHS.len(), 12);
}

#[test]
fn only_a_stale_or_unaccepted_jwt_refusal_drops_the_minted_token() {
    let on = |status: u16, code: &str| minted_jwt_on_refusal(status, &json!({ "code": code }));
    assert_eq!(on(401, "user_jwt_session_ended"), MintedJwtOnRefusal::Drop);
    // A policy that keeps refusing re-mints at most once a minute.
    assert_eq!(
        on(401, "user_jwt_org_not_admitted"),
        MintedJwtOnRefusal::DropIfOlderThan(REFUSAL_REMINT_SECS)
    );
    // A token minted before the control plane bound tokens to sessions is
    // re-minted at once; any other refused token at most once a minute.
    assert_eq!(
        on(401, "user_jwt_invalid"),
        MintedJwtOnRefusal::DropIfUnboundOrOlderThan(REFUSAL_REMINT_SECS)
    );
    for code in [
        "user_jwt_session_ended",
        "user_jwt_org_not_admitted",
        "user_jwt_invalid",
    ] {
        assert_eq!(on(403, code), MintedJwtOnRefusal::Keep);
    }
    for code in [
        "personal_node_required",
        "node_proxy_required",
        "not_an_org_member",
        "org_session_expired",
        "user_jwt_lookup_unavailable",
    ] {
        assert_eq!(on(401, code), MintedJwtOnRefusal::Keep);
    }
    assert_eq!(
        minted_jwt_on_refusal(401, &Value::Null),
        MintedJwtOnRefusal::Keep
    );
}

#[test]
fn a_project_value_is_asked_for_with_the_project_scope_and_id() {
    let context = SecretResolutionContext {
        user_id: Some("u1".into()),
        org_id: Some("org-1".into()),
        project_id: Some("proj-1".into()),
        node_id: "node-1".into(),
        conversation_id: Some("conv-1".into()),
        ..Default::default()
    };
    let body = resolve_body(
        &context,
        "u1",
        SecretScope::Project,
        "proj-1",
        ("production", "/", "DB_URL"),
    );
    assert_eq!(body["scope"], "project");
    assert_eq!(body["scopeId"], "proj-1");
    assert_eq!(body["userId"], "u1");
    assert_eq!(body["name"], "DB_URL");
    assert_eq!(body["conversationId"], "conv-1");
}
