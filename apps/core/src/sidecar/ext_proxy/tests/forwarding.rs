use super::*;

#[tokio::test]
async fn sequential_proxy_requests_reuse_connections_and_keep_headers_per_request() {
    use axum::extract::ConnectInfo;
    use std::net::SocketAddr;
    use std::sync::Arc;

    let seen = Arc::new(tokio::sync::Mutex::new(Vec::<(SocketAddr, String)>::new()));
    let captured = seen.clone();
    let app = Router::new().route(
        "/pool",
        get(
            move |ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap| {
                let captured = captured.clone();
                async move {
                    let bearer = headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default()
                        .to_owned();
                    captured.lock().await.push((peer, bearer));
                    headers
                        .get("x-request-case")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default()
                        .to_owned()
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    for (plugin, value) in [
        ("com.test.pool-one", "first"),
        ("com.test.pool-two", "second"),
    ] {
        let mut headers = HeaderMap::new();
        headers.insert("x-request-case", value.parse().unwrap());
        let response = forward_to_sidecar(ForwardArgs {
            target: ForwardTarget::for_test(port),
            upstream_path: "/pool",
            query: "",
            method: reqwest::Method::GET,
            src_headers: &headers,
            body: Vec::new(),
            hop_plugin_id: plugin,
            forward_payment_authorization: false,
            forward_cookie_names: &[],
            forward_caller_email: false,
            caller: None,
            caller_resource_ids: None,
            caller_rate_subject: None,
            caller_agent_id: None,
            caller_agent_egress_allowlist: None,
            caller_agent_restricted: false,
            event_delivery: None,
            trusted_first_party: false,
        })
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(body.as_ref(), value.as_bytes());
        tokio::task::yield_now().await;
    }
    let captured = seen.lock().await;
    assert_eq!(captured.len(), 2);
    assert_eq!(
        captured[0].0, captured[1].0,
        "sequential hops should reuse one TCP connection"
    );
    assert!(
        captured[0].1 != captured[1].1,
        "hop credentials must remain request-specific"
    );
    server.abort();
}

// ── Kill-isolation (the behavioral seam test) ───────────────────────────────

/// A live sidecar's route works; when the sidecar dies, the SAME route 502s and
/// nothing else is affected — Core is never blocked. This drives the REAL hop
/// (`forward_to_sidecar`, shared by the inbound proxy AND the capability broker)
/// against a REAL stub server on a real loopback port, then actually drops it.
#[tokio::test]
async fn dead_sidecar_502s_only_its_own_route() {
    use axum::routing::get;
    use axum::Router;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback");
    let port = listener.local_addr().unwrap().port();
    let app = Router::new()
        .route("/ok", get(|| async { "UP" }))
        .route("/health", get(|| async { "OK" }));
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .expect("stub server runs");
    });

    let call = || async {
        forward_to_sidecar(ForwardArgs {
            target: ForwardTarget::for_test(port),
            upstream_path: "/ok",
            query: "",
            method: reqwest::Method::GET,
            src_headers: &HeaderMap::new(),
            body: Vec::new(),
            hop_plugin_id: "com.test.app",
            forward_payment_authorization: false,
            forward_cookie_names: &[],
            forward_caller_email: false,
            caller: None,
            caller_resource_ids: None,
            caller_rate_subject: None,
            caller_agent_id: None,
            caller_agent_egress_allowlist: None,
            caller_agent_restricted: false,
            event_delivery: None,
            trusted_first_party: false,
        })
        .await
    };

    // Alive → the proxied route works.
    assert_eq!(call().await.status(), StatusCode::OK);

    // Kill the sidecar and wait for it to actually stop.
    let _ = shutdown_tx.send(());
    let _ = server.await;

    // Dead → the SAME route now 502s. The failure is isolated to this sidecar;
    // the forwarder itself is healthy (it returned a clean 502, not a panic/hang).
    assert_eq!(call().await.status(), StatusCode::BAD_GATEWAY);
}

/// Regression for the SSE header-hang: a sidecar endpoint whose body streams (one
/// chunk, then a long pause before it ends) must yield response HEADERS at once, not
/// after the whole body. The old `resp.bytes().await` buffered the full body first,
/// so an unending stream never produced headers and `forward_to_sidecar` would block
/// far past this test's 1s bound. With `bytes_stream()` → `Body::from_stream` the
/// status + headers come back immediately, well inside the bound.
#[tokio::test]
async fn streaming_response_yields_headers_before_body_completes() {
    use axum::routing::get;
    use axum::Router;
    use std::time::Duration;

    async fn slow_stream() -> Response {
        // One chunk now, then a 3s gap before the stream ends — long past the 1s
        // assertion bound below, so a buffering proxy could not yet have returned.
        let s = async_stream::stream! {
            yield Ok::<_, std::convert::Infallible>(axum::body::Bytes::from("data: hi\n\n"));
            tokio::time::sleep(Duration::from_secs(3)).await;
        };
        Response::builder()
            .header(axum::http::header::CONTENT_TYPE, "text/event-stream")
            .body(Body::from_stream(s))
            .unwrap()
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = Router::new().route("/events", get(slow_stream));
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let src_headers = HeaderMap::new();
    let fut = forward_to_sidecar(ForwardArgs {
        target: ForwardTarget::for_test(port),
        upstream_path: "/events",
        query: "",
        method: reqwest::Method::GET,
        src_headers: &src_headers,
        body: Vec::new(),
        hop_plugin_id: "com.test.sse",
        forward_payment_authorization: false,
        forward_cookie_names: &[],
        forward_caller_email: false,
        caller: None,
        caller_resource_ids: None,
        caller_rate_subject: None,
        caller_agent_id: None,
        caller_agent_egress_allowlist: None,
        caller_agent_restricted: false,
        event_delivery: None,
        trusted_first_party: false,
    });
    // Headers must arrive well before the body finishes (buffering ⇒ >3s ⇒ timeout).
    let resp = tokio::time::timeout(Duration::from_secs(1), fut)
        .await
        .expect("headers must arrive before the stream body completes");
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers()
            .get(axum::http::header::CONTENT_TYPE)
            .expect("content-type passed through"),
        "text/event-stream"
    );
}
