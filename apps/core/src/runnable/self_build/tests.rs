use super::*;

#[test]
fn validate_write_target_rejects_traversal() {
    assert!(validate_write_target("../escape").is_err());
    assert!(validate_write_target("/absolute").is_err());
    assert!(validate_write_target("a/b").is_err());
    assert!(validate_write_target("a\\b").is_err());
    assert!(validate_write_target("").is_err());
    assert!(validate_write_target("..").is_err());
}

#[test]
fn validate_write_target_accepts_valid_id() {
    let result = validate_write_target("com.example.my-agent");
    assert!(result.is_ok(), "valid id should be accepted: {result:?}");
    let path = result.unwrap();
    assert!(path.ends_with("com.example.my-agent"));
}

#[test]
fn parse_runnable_kind_round_trips() {
    use crate::runnable::RunnableKind;
    assert!(matches!(
        parse_runnable_kind("agent"),
        Ok(RunnableKind::Agent)
    ));
    assert!(matches!(
        parse_runnable_kind("workflow"),
        Ok(RunnableKind::Workflow)
    ));
    assert!(parse_runnable_kind("unknown").is_err());
}

#[test]
fn tools_are_listed_with_correct_server() {
    let ts = tools();
    assert_eq!(ts.len(), 6);
    for t in &ts {
        assert_eq!(t.server, SERVER_NAME);
        assert!(t.id.starts_with("ryu_self_build."));
    }
}

#[tokio::test]
async fn hot_reload_inserts_and_replaces() {
    let store = Arc::new(RwLock::new(vec![]));
    let m1 = PluginManifest {
        id: "com.test.app".into(),
        name: "Test".into(),
        version: "1.0.0".into(),
        runnables: vec![],
        permission_grants: vec![],
        companion: None,
        ..Default::default()
    };
    hot_reload_manifest(m1.clone(), Arc::clone(&store)).await;
    {
        let r = store.read().await;
        assert_eq!(r.len(), 1);
    }

    let m2 = PluginManifest {
        id: "com.test.app".into(),
        name: "Test v2".into(),
        version: "2.0.0".into(),
        runnables: vec![],
        permission_grants: vec![],
        companion: None,
        ..Default::default()
    };
    hot_reload_manifest(m2, Arc::clone(&store)).await;
    {
        let r = store.read().await;
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].version, "2.0.0");
    }
}

// ── self_build:write grant enforcement ───────────────────────────────────────

/// Serve `body` with HTTP 200 on `POST /v1/grants/validate`, as the Gateway
/// does for both approvals and denials.
async fn grant_stub(body: serde_json::Value) -> (String, tokio::task::JoinHandle<()>) {
    use std::future::IntoFuture;
    let app = axum::Router::new().route(
        "/v1/grants/validate",
        axum::routing::post(move || {
            let body = body.clone();
            async move { axum::Json(body) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).into_future().await;
    });
    (base, server)
}

#[tokio::test]
async fn self_build_grant_rejects_gateway_denial_with_http_200() {
    let (base, server) = grant_stub(serde_json::json!({
        "approved": [], "denied": ["self_build:write"], "all_approved": false
    }))
    .await;
    let result = check_self_build_grant_at("com.acme.notes", &base, None).await;
    server.abort();
    let err = result.expect_err("a 200 denial body must not authorize self-build");
    assert!(err.to_string().contains("denied"), "{err}");
}

#[tokio::test]
async fn self_build_grant_rejects_malformed_200_body() {
    let (base, server) = grant_stub(serde_json::json!({"ok": true})).await;
    let result = check_self_build_grant_at("com.acme.notes", &base, None).await;
    server.abort();
    assert!(result.is_err(), "a malformed body must fail closed");
}

#[tokio::test]
async fn self_build_grant_accepts_explicit_approval() {
    let (base, server) = grant_stub(serde_json::json!({
        "approved": ["self_build:write"], "denied": [], "all_approved": true
    }))
    .await;
    let result = check_self_build_grant_at("com.acme.notes", &base, None).await;
    server.abort();
    assert!(result.is_ok(), "explicit approval must pass: {result:?}");
}

#[test]
fn self_build_grant_body_requires_consistent_approval() {
    use serde_json::json;
    assert!(ensure_self_build_write_approved(&json!({
        "approved": ["self_build:write"], "denied": [], "all_approved": true
    }))
    .is_ok());
    for body in [
        json!({"approved": [], "denied": ["self_build:write"], "all_approved": false}),
        json!({"approved": ["self_build:write"], "denied": [], "all_approved": false}),
        json!({"approved": [], "denied": [], "all_approved": true}),
        json!({"approved": ["other:grant"], "denied": [], "all_approved": true}),
        json!({"approved": ["self_build:write"], "denied": ["self_build:write"], "all_approved": true}),
        json!({"approved": "self_build:write", "denied": [], "all_approved": true}),
        json!({}),
    ] {
        assert!(ensure_self_build_write_approved(&body).is_err(), "{body}");
    }
}
