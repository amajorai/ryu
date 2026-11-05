use super::*;

#[tokio::test]
async fn credential_client_does_not_follow_redirects() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = axum::Router::new()
        .route(
            "/start",
            axum::routing::post(|| async {
                axum::response::Redirect::temporary("/credential-sink")
            }),
        )
        .route(
            "/credential-sink",
            axum::routing::post(|| async { "leaked" }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let response = passthrough_http_client()
        .post(format!("http://{address}/start"))
        .header("x-api-key", "test-secret")
        .body("private prompt")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(response.url().path(), "/start");
    server.abort();
}

#[test]
fn anthropic_uses_the_proxy_only_while_the_claude_route_is_active() {
    assert!(!claude_route(Some(r#"{"active":[]}"#)).active);
    assert!(claude_route(Some(r#"{"active":["claude"]}"#)).active);
    // Unreadable or unexpected state counts as active, so it never goes direct.
    assert!(claude_route(None).active);
    assert!(claude_route(Some("not json")).active);
    assert!(claude_route(Some("{}")).active);
    assert_eq!(
        claude_route(Some(
            r#"{"active":["claude"],"proxy":"http://ryu:pw@127.0.0.1:2"}"#
        ))
        .proxy
        .as_deref(),
        Some("http://ryu:pw@127.0.0.1:2")
    );
}

#[test]
fn an_active_claude_route_without_a_proxy_refuses_instead_of_going_direct() {
    let spawned = Some("http://ryu:old@127.0.0.1:1".to_owned());
    let current = |active, proxy: Option<&str>| {
        Some(ClaudeRoute {
            active,
            proxy: proxy.map(str::to_owned),
        })
    };
    // No state file: this node does not route providers.
    assert_eq!(anthropic_proxy(None, None), Ok(None));
    assert_eq!(
        anthropic_proxy(current(false, None), spawned.clone()),
        Ok(None)
    );
    // The state file's listener replaces the one from spawn (Core restarted).
    assert_eq!(
        anthropic_proxy(
            current(true, Some("http://ryu:new@127.0.0.1:2")),
            spawned.clone()
        ),
        Ok(Some("http://ryu:new@127.0.0.1:2".to_owned()))
    );
    assert_eq!(
        anthropic_proxy(current(true, None), spawned),
        Ok(Some("http://ryu:old@127.0.0.1:1".to_owned()))
    );
    assert_eq!(
        anthropic_proxy(current(true, None), None),
        Err(CLAUDE_ROUTE_UNAVAILABLE)
    );
}

#[test]
fn provider_proxy_is_used_only_when_core_supplies_one() {
    assert!(provider_proxy(None).is_none());
    assert!(provider_proxy(Some("  ".to_owned())).is_none());
    assert!(provider_proxy(Some("http://ryu:secret@127.0.0.1:41000".to_owned())).is_some());
}
#[test]
fn codex_upstream_is_swappable() {
    std::env::set_var(
        "RYU_PASSTHROUGH_CODEX_UPSTREAM",
        "http://test-upstream.local",
    );
    assert_eq!(codex_upstream(), "http://test-upstream.local");
    std::env::remove_var("RYU_PASSTHROUGH_CODEX_UPSTREAM");
}
