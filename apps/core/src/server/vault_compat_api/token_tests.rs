//! `/v1/auth/token/*`: child tokens, renewal, lookup, Vault wire shapes,
//! refusals, sealed refusal, and agreement with the native token records.

use super::fixture_test::*;
use super::token::duration_secs;

#[test]
fn durations_accept_seconds_and_go_style_units() {
    for (value, secs) in [
        (json!(90), Some(90)),
        (json!("90"), Some(90)),
        (json!("90s"), Some(90)),
        (json!("15m"), Some(900)),
        (json!("1h30m"), Some(5_400)),
        (json!("7d"), Some(604_800)),
        (json!(0), Some(0)),
        (json!(-5), None),
        (json!("-5"), None),
        (json!("1.5h"), None),
        (json!("10x"), None),
        (json!("h"), None),
        (json!("5m3"), None),
        (json!(""), None),
        (json!(true), None),
        (json!("99999999999999999999d"), None),
    ] {
        assert_eq!(duration_secs(&value), secs, "{value}");
    }
}

#[tokio::test]
async fn token_create_returns_a_child_in_the_vault_auth_shape() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let app = &fixture.app;
    let token = login(&fixture).await;

    let (status, body) = call(
        app,
        "POST",
        "/v1/auth/token/create",
        Some(&token),
        Some(json!({ "ttl": "5m", "num_uses": 0, "meta": { "job": "ci" } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["data"].is_null());
    assert_eq!(body["lease_duration"], 0);
    let auth = &body["auth"];
    let child = auth["client_token"].as_str().unwrap().to_owned();
    assert!(child.starts_with("rvt_") && child != token);
    assert_eq!(auth["policies"], json!(["ci"]));
    assert_eq!(auth["token_policies"], json!(["ci"]));
    assert_eq!(auth["orphan"], false);
    assert_eq!(auth["renewable"], true);
    assert_eq!(auth["token_type"], "service");
    let ttl = auth["lease_duration"].as_i64().unwrap();
    assert!((280..=300).contains(&ttl), "{ttl}");

    // The child is a working token, and the store records it as a child.
    let (status, body) = call(app, "GET", "/v1/auth/token/lookup-self", Some(&child), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["orphan"], false);
    let info = fixture
        .store
        .token_info(auth["accessor"].as_str().unwrap())
        .await
        .unwrap();
    assert!(info.parent_accessor.is_some());

    let (status, body) = call(
        app,
        "POST",
        "/v1/auth/token/create",
        Some(&token),
        Some(json!({ "num_uses": 2, "renewable": false })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["auth"]["num_uses"], 2);
    assert_eq!(body["auth"]["renewable"], false);
}

#[tokio::test]
async fn token_create_refuses_what_the_native_route_refuses_and_unsupported_fields() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let app = &fixture.app;
    let token = login(&fixture).await;
    for (body, status) in [
        (json!({ "id": "my-token" }), StatusCode::BAD_REQUEST),
        (json!({ "type": "batch" }), StatusCode::BAD_REQUEST),
        (json!({ "ttl": "soon" }), StatusCode::BAD_REQUEST),
        (json!({ "num_uses": -1 }), StatusCode::BAD_REQUEST),
        (json!({ "policies": [1] }), StatusCode::BAD_REQUEST),
        // A child may not widen its parent's policies or detach itself.
        (json!({ "policies": ["admin"] }), StatusCode::FORBIDDEN),
        (json!({ "no_parent": true }), StatusCode::FORBIDDEN),
    ] {
        let (got, reply) = call(
            app,
            "POST",
            "/v1/auth/token/create",
            Some(&token),
            Some(body.clone()),
        )
        .await;
        assert_eq!(got, status, "{body}: {reply}");
        assert!(reply["errors"].is_array(), "{reply}");
        assert!(!reply.to_string().contains("rvt_"), "{reply}");
    }
    // A token role needs `use` on `sys/token-roles/<name>`.
    let (status, body) = call(
        app,
        "POST",
        "/v1/auth/token/create/deploy",
        Some(&token),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body, json!({ "errors": ["permission denied"] }));
}

#[tokio::test]
async fn renew_self_extends_the_token_and_matches_the_native_record() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let app = &fixture.app;
    let token = login(&fixture).await;
    let (_, body) = call(
        app,
        "POST",
        "/v1/auth/token/create",
        Some(&token),
        Some(json!({ "ttl": 120, "explicit_max_ttl": "1h" })),
    )
    .await;
    let child = body["auth"]["client_token"].as_str().unwrap().to_owned();
    let accessor = body["auth"]["accessor"].as_str().unwrap().to_owned();

    let (status, body) = call(
        app,
        "POST",
        "/v1/auth/token/renew-self",
        Some(&child),
        Some(json!({ "increment": "10m" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let auth = &body["auth"];
    assert_eq!(auth["client_token"], child);
    assert_eq!(auth["accessor"], accessor);
    let renewed = auth["lease_duration"].as_i64().unwrap();
    assert!(renewed > 120, "{renewed}");
    // The native agent route returns this same stored record.
    let info = fixture.store.token_info(&accessor).await.unwrap();
    assert!((info.ttl_secs - renewed).abs() <= 1);
    assert_eq!(auth["renewable"], info.renewable);
    assert_eq!(auth["policies"], json!(info.policies));

    let (status, body) = call(
        app,
        "POST",
        "/v1/auth/token/renew-self",
        Some(&child),
        Some(json!({ "increment": "ten minutes" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    let (_, body) = call(
        app,
        "POST",
        "/v1/auth/token/create",
        Some(&token),
        Some(json!({ "renewable": false })),
    )
    .await;
    let fixed = body["auth"]["client_token"].as_str().unwrap().to_owned();
    let (status, body) = call(app, "POST", "/v1/auth/token/renew-self", Some(&fixed), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body, json!({ "errors": ["permission denied"] }));
}

#[tokio::test]
async fn lookup_self_matches_the_native_token_record() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let token = login(&fixture).await;
    let (status, body) = call(
        &fixture.app,
        "GET",
        "/v1/auth/token/lookup-self",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let data = &body["data"];
    let info = fixture
        .store
        .token_info(data["accessor"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(data["renewable"], info.renewable);
    assert_eq!(data["orphan"], info.orphan);
    assert_eq!(data["num_uses"], info.num_uses_remaining.unwrap_or(0));
    assert_eq!(data["creation_time"], info.created_at / 1000);
    assert!((data["ttl"].as_i64().unwrap() - info.ttl_secs).abs() <= 1);
    assert!(!body.to_string().contains(&token));
}

#[tokio::test]
async fn token_routes_refuse_without_a_token_and_while_sealed() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let app = &fixture.app;
    let token = login(&fixture).await;
    let routes = [
        ("POST", "/v1/auth/token/create"),
        ("POST", "/v1/auth/token/create/deploy"),
        ("POST", "/v1/auth/token/renew-self"),
        ("GET", "/v1/auth/token/lookup-self"),
        ("POST", "/v1/auth/token/revoke-self"),
    ];
    for (method, uri) in routes {
        let (status, body) = call(app, method, uri, None, Some(json!({}))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}");
        assert_eq!(body, json!({ "errors": ["permission denied"] }));
    }
    seal(&fixture);
    for (method, uri) in routes {
        let (status, body) = call(app, method, uri, Some(&token), Some(json!({}))).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{uri}: {body}");
        assert_eq!(body, json!({ "errors": ["Vault is sealed"] }));
    }
    unseal(&fixture).await;
    // Nothing was revoked while sealed.
    let (status, _) = call(app, "GET", "/v1/auth/token/lookup-self", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
}
