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

/// An upstream that sends `chunks` body chunks, one every `gap`.
async fn paced_upstream(
    chunks: usize,
    gap: Duration,
) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    use futures_util::StreamExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = axum::Router::new().route(
        "/v1/messages",
        axum::routing::post(move || async move {
            let body = futures_util::stream::iter(0..chunks).then(move |index| async move {
                tokio::time::sleep(gap).await;
                Ok::<_, std::convert::Infallible>(format!("chunk-{index};"))
            });
            axum::body::Body::from_stream(body)
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (address, server)
}

/// The client total is the inert deadline. A prompt route lifts it, so a body
/// that streams for longer than the total arrives whole; an inert route is
/// still cut at the total. The total is scaled down so the test runs in about
/// a second; production uses 60 s and the two hour stream total.
#[tokio::test]
async fn a_prompt_route_outlives_the_client_total_and_an_inert_route_does_not() {
    let total = Duration::from_millis(400);
    let (address, server) = paced_upstream(8, Duration::from_millis(120)).await;
    let client = client_builder(total).build().unwrap();
    let url = format!("http://{address}/v1/messages");

    let prompt = with_route_deadline(client.post(&url), true)
        .send()
        .await
        .unwrap();
    let body = prompt.text().await.unwrap();
    assert_eq!(body.matches("chunk-").count(), 8, "{body}");
    assert!(body.ends_with("chunk-7;"), "{body}");

    let inert = with_route_deadline(client.post(&url), false).send().await;
    let cut = match inert {
        Ok(response) => response.text().await.unwrap_err(),
        Err(error) => error,
    };
    assert!(cut.is_timeout(), "{cut:?}");
    server.abort();
}

/// Lifting the total leaves the read timeout in force: an upstream that goes
/// silent mid-body still fails instead of holding the connection for hours.
#[tokio::test]
async fn a_stalled_prompt_stream_still_fails_on_the_read_timeout() {
    let (address, server) = paced_upstream(3, Duration::from_millis(600)).await;
    let client = client_builder(Duration::from_millis(100))
        .read_timeout(Duration::from_millis(200))
        .build()
        .unwrap();
    let stalled = with_route_deadline(client.post(format!("http://{address}/v1/messages")), true)
        .send()
        .await;
    let failure = match stalled {
        Ok(response) => response.text().await.unwrap_err(),
        Err(error) => error,
    };
    assert!(failure.is_timeout(), "{failure:?}");
    server.abort();
}

#[test]
fn the_production_deadlines_match_the_provider_stream_path() {
    assert_eq!(INERT_TOTAL_TIMEOUT, Duration::from_secs(60));
    assert_eq!(CONNECT_TIMEOUT, Duration::from_secs(30));
    assert_eq!(
        ryu_gw_providers::STREAM_READ_TIMEOUT,
        Duration::from_secs(300)
    );
    assert!(ryu_gw_providers::STREAM_TOTAL_TIMEOUT > INERT_TOTAL_TIMEOUT);
}
