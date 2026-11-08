use super::*;

#[test]
fn vault_routers_merge_without_route_conflicts() {
    // Mirrors the registration in `server::create_router`: axum panics on
    // overlapping routes, so building the merged router is the check.
    let _router: axum::Router<ServerState> = axum::Router::new()
        .merge(super::super::vault_public_routes())
        .merge(super::super::vault_routes());
}

#[tokio::test]
async fn every_public_vault_route_rides_the_request_layer() {
    use tower::ServiceExt;
    // `request_layer` rejects a malformed wrap TTL before any handler
    // runs, so a 400 here proves the route gets the client address,
    // login quotas, and wrapping that the layer provides.
    let directory = tempfile::tempdir().unwrap();
    let router = super::super::vault_public_routes().with_state(
        super::super::isolated_plugin_hook_test_state(directory.path()),
    );
    for (method, uri) in [
        ("POST", "/api/vault/auth/approle/login"),
        ("POST", "/api/vault/auth/cert/login"),
        ("POST", "/api/vault/auth/aws/login"),
        ("POST", "/api/vault/auth/kubernetes/login"),
        ("POST", "/v1/auth/approle/login"),
        ("POST", "/v1/auth/jwt/login"),
        ("GET", "/v1/secret/data/app/db"),
        ("POST", "/api/vault/agent/broker/sessions"),
        ("GET", "/api/vault/agent/broker/discover"),
        ("GET", "/api/vault/agent/totp/code/github"),
        ("POST", "/api/vault/agent/identity/token/ci"),
        ("GET", "/api/vault/agent/self/lookup"),
    ] {
        let request = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header(WRAP_TTL_HEADER, HeaderValue::from_bytes(b"\xff").unwrap())
            .header("content-type", "application/json")
            .body(axum::body::Body::from("{}"))
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{method} {uri}");
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        assert!(
            String::from_utf8_lossy(&body).contains("invalid wrap TTL header"),
            "{method} {uri}"
        );
    }
}

#[test]
fn wrap_ttl_headers_and_alias_parse() {
    let mut headers = HeaderMap::new();
    assert_eq!(request_layer::wrap_ttl(&headers).unwrap(), None);
    headers.insert(VAULT_WRAP_TTL_HEADER, HeaderValue::from_static("5m"));
    assert_eq!(request_layer::wrap_ttl(&headers).unwrap(), Some(300));
    headers.insert(WRAP_TTL_HEADER, HeaderValue::from_static("30"));
    assert_eq!(request_layer::wrap_ttl(&headers).unwrap(), Some(30));
    headers.insert(WRAP_TTL_HEADER, HeaderValue::from_static("2d"));
    assert_eq!(
        request_layer::wrap_ttl(&headers).unwrap_err().status(),
        StatusCode::BAD_REQUEST
    );
}

#[test]
fn dynamic_issue_routes_are_recognized_for_lease_quotas() {
    assert_eq!(
        dynamic_issue_role(&Method::POST, "/api/vault/dynamic/issue/db"),
        Some(Ok("db".to_owned()))
    );
    assert_eq!(
        dynamic_issue_role(&Method::POST, "/api/vault/agent/dynamic/db"),
        Some(Ok("db".to_owned()))
    );
    // Percent-encoding cannot hide the role from lease-count quotas.
    assert_eq!(
        dynamic_issue_role(&Method::POST, "/api/vault/dynamic/issue/%64b"),
        Some(Ok("db".to_owned()))
    );
    assert_eq!(
        dynamic_issue_role(&Method::POST, "/api/vault/agent/dynamic/%64b"),
        Some(Ok("db".to_owned()))
    );
    assert_eq!(
        dynamic_issue_role(&Method::POST, "/api/vault/dynamic/issue/a%2Fb"),
        Some(Err(()))
    );
    assert_eq!(
        dynamic_issue_role(&Method::GET, "/api/vault/dynamic/issue/db"),
        None
    );
    assert_eq!(
        dynamic_issue_role(&Method::POST, "/api/vault/dynamic/roles/db"),
        None
    );
    assert!(is_wrapping_route("/api/vault/sys/wrapping/unwrap"));
    assert!(!is_wrapping_route("/api/vault/agent/secrets/X"));
}

#[test]
fn wrap_tokens_come_from_the_body_or_headers() {
    let mut headers = HeaderMap::new();
    assert!(wrap_routes::presented_wrap_token(&headers, None).is_err());
    headers.insert(VAULT_TOKEN_HEADER, HeaderValue::from_static("rvw_header"));
    assert_eq!(
        wrap_routes::presented_wrap_token(&headers, None).unwrap(),
        "rvw_header"
    );
    let body = Json(WrapTokenBody {
        token: Some(" rvw_body ".into()),
    });
    assert_eq!(
        wrap_routes::presented_wrap_token(&headers, Some(body)).unwrap(),
        "rvw_body"
    );
}

#[tokio::test]
async fn wrapping_replaces_a_success_body_and_passes_errors_through() {
    let store = PluginSecretStore::in_memory().unwrap();
    let context = RequestContext::new(None);
    let secret = respond(json!({ "secretId": "sid_plain" }));
    let wrapped = wrap_body(
        &store,
        secret,
        60,
        "/api/vault/machines/x/secret-ids",
        &context,
    )
    .await;
    assert_eq!(wrapped.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(wrapped.into_body(), 1 << 20)
        .await
        .unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(!text.contains("sid_plain"), "{text}");
    let body: Value = serde_json::from_str(&text).unwrap();
    let token = body["wrapInfo"]["token"].as_str().unwrap();
    let payload = store.wrap_unwrap(token).await.unwrap();
    assert!(String::from_utf8(payload).unwrap().contains("sid_plain"));
    let error = invalid_request("nope");
    let passed = wrap_body(&store, error, 60, "/x", &context).await;
    assert_eq!(passed.status(), StatusCode::BAD_REQUEST);
}

/// A wrap header on an event stream is refused instead of buffering a
/// body that never ends.
#[tokio::test]
async fn streaming_routes_refuse_wrapping() {
    use axum::body::Body;
    use axum::response::sse::{Event, KeepAlive, Sse};
    use axum::routing::get;
    use tower::ServiceExt as _;

    let endless = || async {
        let stream = futures_util::stream::pending::<Result<Event, std::convert::Infallible>>();
        Sse::new(stream).keep_alive(KeepAlive::default())
    };
    assert!(is_streaming_route("/api/vault/events"));
    assert!(is_streaming_route("/api/vault/agent/events"));
    assert!(is_streaming_route("/api/vault/items/abc/events"));
    assert!(!is_streaming_route("/api/vault/items/abc"));

    let router = axum::Router::new()
        .route("/api/vault/events", get(endless))
        .layer(axum::middleware::from_fn(request_layer));
    let request = axum::http::Request::builder()
        .uri("/api/vault/events")
        .header(WRAP_TTL_HEADER, "60")
        .body(Body::empty())
        .unwrap();
    let refused = tokio::time::timeout(std::time::Duration::from_secs(5), router.oneshot(request))
        .await
        .expect("the wrap refusal returns at once")
        .unwrap();
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);

    // Defense in depth: `wrap_body` never buffers an event stream.
    let store = PluginSecretStore::in_memory().unwrap();
    let context = RequestContext::new(None);
    let stream = endless().await.into_response();
    let dropped = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        wrap_body(&store, stream, 60, "/api/vault/other", &context),
    )
    .await
    .expect("an event stream is not buffered");
    assert_eq!(dropped.status(), StatusCode::BAD_REQUEST);
}

/// `X-Vault-Wrap-TTL` on `/v1` is refused before any store lookup.
#[tokio::test]
async fn compat_routes_refuse_vault_wrap_ttl() {
    use axum::body::Body;
    use axum::routing::get;
    use tower::ServiceExt as _;

    let router = axum::Router::new()
        .route("/v1/secret/data/app", get(|| async { "value" }))
        .layer(axum::middleware::from_fn(request_layer));
    let request = |wrap: Option<&str>| {
        let mut request = axum::http::Request::builder().uri("/v1/secret/data/app");
        if let Some(ttl) = wrap {
            request = request.header(VAULT_WRAP_TTL_HEADER, ttl);
        }
        request.body(Body::empty()).unwrap()
    };
    let refused = router.clone().oneshot(request(Some("5m"))).await.unwrap();
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(refused.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert!(body["errors"][0].as_str().unwrap().contains("wrapping"));
    let plain = router.oneshot(request(None)).await.unwrap();
    assert_ne!(plain.status(), StatusCode::BAD_REQUEST);
}

/// Router-level checks of [`request_layer`] against stub vault routes.
/// The layer reads the process-global store; publishing an in-memory one
/// is safe because every publisher in the test binary publishes one
/// (first set wins) and the names used here are unique to this test.
#[tokio::test]
async fn request_layer_enforces_quotas_and_wraps_on_real_routes() {
    use crate::vault::leases::NewLease;
    use axum::body::Body;
    use axum::routing::post;
    use tower::ServiceExt as _;

    crate::plugin_secrets::set_global(PluginSecretStore::in_memory().unwrap());
    let store = crate::plugin_secrets::global().unwrap();
    let router = axum::Router::new()
        .route("/api/vault/auth/approle/login", post(|| async { "ok" }))
        .route(
            "/api/vault/dynamic/issue/:role",
            post(|Path(role): Path<String>| async move { respond(json!({ "role": role })) }),
        )
        .route(
            "/api/vault/machines/:name/secret-ids",
            post(|| async { respond(json!({ "secretId": "sid_layer_plain" })) }),
        )
        .layer(axum::middleware::from_fn(request_layer));
    let call = |uri: &str, peer: Option<&str>, wrap: Option<&str>| {
        let mut request = axum::http::Request::builder().method(Method::POST).uri(uri);
        if let Some(ttl) = wrap {
            request = request.header(WRAP_TTL_HEADER, ttl);
        }
        let mut request = request.body(Body::empty()).unwrap();
        if let Some(peer) = peer {
            let addr: SocketAddr = format!("{peer}:4000").parse().unwrap();
            request.extensions_mut().insert(ConnectInfo(addr));
        }
        router.clone().oneshot(request)
    };

    // The built-in login quota (60/min) limits one known client...
    let login = "/api/vault/auth/approle/login";
    for _ in 0..quotas::DEFAULT_LOGIN_RATE_PER_MIN {
        assert_eq!(
            call(login, Some("192.0.2.211"), None)
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    let limited = call(login, Some("192.0.2.211"), None).await.unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(limited
        .headers()
        .contains_key(axum::http::header::RETRY_AFTER));
    // ...without touching another client's bucket.
    assert_eq!(
        call(login, Some("192.0.2.212"), None)
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    // An unknown address never shares one drainable built-in bucket.
    for _ in 0..=quotas::DEFAULT_LOGIN_RATE_PER_MIN {
        assert_eq!(
            call(login, None, None).await.unwrap().status(),
            StatusCode::OK
        );
    }

    // A lease-count quota cannot be bypassed by percent-encoding the role.
    store
        .lease_create(
            NewLease {
                role: "layerq",
                provider: "random",
                issued_to: Some("machine:layer"),
                ttl_secs: 600,
                max_ttl_secs: 600,
                renewable: true,
                revoke_data: &Value::Null,
            },
            &AuditActor::system(),
        )
        .await
        .unwrap();
    store
        .quota_put(
            "layerq-cap",
            QuotaRule::LeaseCount {
                role: "layerq".into(),
                max_leases: 1,
            },
            &AuditActor::system(),
        )
        .await
        .unwrap();
    for uri in [
        "/api/vault/dynamic/issue/layerq",
        "/api/vault/dynamic/issue/%6Cayerq",
    ] {
        let response = call(uri, Some("192.0.2.213"), None).await.unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS, "{uri}");
    }
    let invalid = call("/api/vault/dynamic/issue/a%2Fb", Some("192.0.2.213"), None)
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

    // A wrap header turns a secret-id response into a wrapping token, and
    // a bad TTL is refused before the handler can run.
    let secret_ids = "/api/vault/machines/layer/secret-ids";
    let wrapped = call(secret_ids, Some("192.0.2.214"), Some("60"))
        .await
        .unwrap();
    assert_eq!(wrapped.status(), StatusCode::OK);
    assert!(wrapped.headers().contains_key("x-ryu-wrapped"));
    let bytes = axum::body::to_bytes(wrapped.into_body(), 1 << 20)
        .await
        .unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(!text.contains("sid_layer_plain"), "{text}");
    let bad = call(secret_ids, Some("192.0.2.214"), Some("2d"))
        .await
        .unwrap();
    assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
}

#[test]
fn wrapping_refusals_are_explained_only_when_they_match() {
    use crate::vault::policy::wrap_requirement::{Bounds, Violation};
    let violation = Violation {
        path: "prod/KEY".to_owned(),
        capability: Capability::Read,
        bounds: Bounds {
            min_secs: Some(60),
            max_secs: None,
        },
    };
    let violations = [violation.clone()];
    let denied =
        json!({ "error": "vault_denied: the `read` capability is required on `prod/KEY`" });
    let (found, body) = super::wrap_policy::explain(&denied, &violations).unwrap();
    assert_eq!(found, violation);
    let error = body["error"].as_str().unwrap();
    assert!(error.starts_with("vault_wrapping_required:"), "{error}");
    assert!(error.contains("at least 60s"), "{error}");
    // Another capability or key is a different refusal.
    for other in [
        json!({ "error": "vault_denied: the `write` capability is required on `prod/KEY`" }),
        json!({ "error": "vault_denied: the `read` capability is required on `prod/OTHER`" }),
        json!({ "errors": ["permission denied: the environment is protected"] }),
    ] {
        assert!(
            super::wrap_policy::explain(&other, &violations).is_none(),
            "{other}"
        );
    }
    // The Vault-compatible API keeps its error envelope.
    let compat = json!({ "errors": ["permission denied"] });
    let (_, body) = super::wrap_policy::explain(&compat, &violations).unwrap();
    let message = body["errors"][0].as_str().unwrap();
    assert!(message.starts_with("permission denied:"), "{message}");
    assert!(message.contains("/api/vault"), "{message}");
}

#[test]
fn lease_search_queries_ignore_an_empty_prefix_and_hide_revoked_by_default() {
    let query: lease_routes::LeaseSearchQuery =
        serde_json::from_value(json!({ "prefix": "", "issuedTo": "machine:m1" })).unwrap();
    let filter = query.filter();
    assert_eq!(filter.prefix, None);
    assert_eq!(filter.issued_to, Some("machine:m1"));
    assert!(!filter.include_revoked);
    let query: lease_routes::LeaseSearchQuery =
        serde_json::from_value(json!({ "prefix": "db/", "includeRevoked": true })).unwrap();
    let filter = query.filter();
    assert_eq!(filter.prefix, Some("db/"));
    assert!(filter.include_revoked);
}

#[test]
fn renew_bodies_take_an_optional_increment() {
    let body: token_routes::RenewBody =
        serde_json::from_value(json!({ "incrementSecs": 60 })).unwrap();
    assert_eq!(body.increment_secs, Some(60));
    let body: token_routes::RenewBody = serde_json::from_value(json!({})).unwrap();
    assert_eq!(body.increment_secs, None);
}
