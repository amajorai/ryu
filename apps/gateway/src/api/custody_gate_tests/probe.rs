//! Coverage probes for the custody route gates.
//!
//! Each probe places the fake `rgw_test_...` token (or a harmless batch body)
//! in an input shape the main suite does not exercise. Query probes always
//! send a valid master header, so a missed refusal dispatches (200 and one
//! upstream call) instead of looking like an ordinary 401.
use super::*;

/// The fixed fake token with its prefix spelled out, for shapes that rebuild it.
fn token_tail() -> &'static str {
    &RGW_TOKEN[4..]
}

async fn send_with(
    app: &Router,
    method: Method,
    uri: &str,
    content_type: &str,
    body: String,
    loopback: bool,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", content_type)
        .header("authorization", format!("Bearer {MASTER}"))
        .extension(peer(loopback))
        .body(Body::from(body))
        .expect("request builds");
    let response = app.clone().oneshot(request).await.expect("router responds");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body reads");
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned())),
    )
}

/// Refused with the query-credential row and no upstream call.
fn assert_refused(
    status: StatusCode,
    body: &Value,
    harness: &Harness,
    calls: &AtomicUsize,
    route: &str,
    shape: &str,
) {
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{shape}: {body}");
    assert_eq!(body["error"]["type"], "invalid_api_key", "{shape}");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "{shape}: upstream was called"
    );
    let rows = harness.audit.rows();
    assert_eq!(rows.len(), 1, "{shape}: {rows:?}");
    assert_eq!(rows[0].model, route, "{shape}");
    assert_eq!(
        rows[0].error.as_deref(),
        Some(crate::api::QUERY_CREDENTIAL_REFUSED),
        "{shape}"
    );
    let dump = format!("{rows:?}");
    assert!(!dump.contains(token_tail()), "{shape}: audit leaked token");
    assert!(
        !body.to_string().contains(token_tail()),
        "{shape}: body echoed token"
    );
}

async fn probe_chat_query(query: &str) {
    let (harness, calls) = fixture_harness(GatewayCustody::Fleet);
    let uri = format!("/v1/chat/completions?{query}");
    let (status, body) = send(&harness.app, &uri, Some(MASTER), &chat_body(), true).await;
    assert_refused(
        status,
        &body,
        &harness,
        &calls,
        "/v1/chat/completions",
        query,
    );
}

// ── Streaming variants ──────────────────────────────────────────────────────

#[tokio::test]
async fn probe_gemini_stream_query_token_is_refused() {
    let (harness, calls) = fixture_harness(GatewayCustody::Fleet);
    let uri = format!("/v1beta/models/fixture-model:streamGenerateContent?alt=sse&key={RGW_TOKEN}");
    let (status, body) = send(&harness.app, &uri, Some(MASTER), &gemini_body(), true).await;
    assert_refused(
        status,
        &body,
        &harness,
        &calls,
        "/v1beta/models/:spec",
        "gemini stream",
    );
}

#[tokio::test]
async fn probe_chat_stream_query_token_is_refused_and_control_dispatches() {
    let mut stream_body = chat_body();
    stream_body["stream"] = json!(true);

    let (harness, calls) = fixture_harness(GatewayCustody::Fleet);
    let uri = format!("/v1/chat/completions?token={RGW_TOKEN}");
    let (status, body) = send(&harness.app, &uri, Some(MASTER), &stream_body, true).await;
    assert_refused(
        status,
        &body,
        &harness,
        &calls,
        "/v1/chat/completions",
        "chat stream",
    );

    let (control, control_calls) = fixture_harness(GatewayCustody::Fleet);
    let (status, body) = send(
        &control.app,
        "/v1/chat/completions?alt=sse",
        Some(MASTER),
        &stream_body,
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(control_calls.load(Ordering::SeqCst), 1);
}

// ── Ordering, size and decoding ─────────────────────────────────────────────

#[tokio::test]
async fn probe_duplicate_parameter_with_token_last_is_refused() {
    let (harness, calls) = fixture_harness(GatewayCustody::Fleet);
    let uri = format!("{GEMINI}?key=benign-value&key={RGW_TOKEN}");
    let (status, body) = send(&harness.app, &uri, Some(MASTER), &gemini_body(), true).await;
    assert_refused(
        status,
        &body,
        &harness,
        &calls,
        "/v1beta/models/:spec",
        "duplicate key",
    );
}

#[tokio::test]
async fn probe_long_benign_padding_before_the_token_is_refused() {
    let padding = "a".repeat(20_000);
    probe_chat_query(&format!("pad={padding}&token={RGW_TOKEN}")).await;
}

#[tokio::test]
async fn probe_many_benign_parameters_before_the_token_is_refused_and_control_dispatches() {
    let benign: Vec<String> = (0..500).map(|index| format!("p{index}=v{index}")).collect();
    let benign = benign.join("&");
    probe_chat_query(&format!("{benign}&token={RGW_TOKEN}")).await;

    let (control, calls) = fixture_harness(GatewayCustody::Fleet);
    let uri = format!("/v1/chat/completions?{benign}");
    let (status, body) = send(&control.app, &uri, Some(MASTER), &chat_body(), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn probe_percent_encoded_and_whitespace_prefixed_tokens_are_refused() {
    let tail = token_tail();
    for query in [
        format!("token=rgw%5F{tail}"),
        format!("token=%72%67%77%5F{tail}"),
        format!("token=%09rgw_{tail}"),
        format!("token=%0Argw_{tail}"),
        format!("token=%20%20rgw_{tail}"),
        format!("token=bearer%20rgw_{tail}"),
    ] {
        probe_chat_query(&query).await;
    }
}

#[tokio::test]
async fn probe_array_style_parameter_names_are_refused() {
    for query in [
        format!("key[]={RGW_TOKEN}"),
        format!("key[0]={RGW_TOKEN}"),
        format!("auth.key={RGW_TOKEN}"),
        format!("x=1&&&key={RGW_TOKEN}&&"),
    ] {
        probe_chat_query(&query).await;
    }
}

#[tokio::test]
async fn probe_invalid_percent_bytes_elsewhere_do_not_hide_the_token() {
    let tail = token_tail();
    for query in [
        format!("x=%FF&token={RGW_TOKEN}"),
        format!("x=%FF&token=%72gw_{tail}"),
        format!("x=%ZZ&token={RGW_TOKEN}"),
        format!("x=%E2%82&token={RGW_TOKEN}"),
    ] {
        probe_chat_query(&query).await;
    }
}

// ── Route shapes ────────────────────────────────────────────────────────────

#[tokio::test]
async fn probe_query_token_is_refused_on_other_governed_routes() {
    let tail = token_tail();
    let cases: [(Method, String, &str, &str, String); 9] = [
        (
            Method::POST,
            format!("/v1/messages?key=rgw_{tail}"),
            "/v1/messages",
            "application/json",
            json!({ "model": "fixture-model", "max_tokens": 8, "messages": [{ "role": "user", "content": "Hi" }] }).to_string(),
        ),
        (
            Method::POST,
            format!("/v1/responses?key=rgw_{tail}"),
            "/v1/responses",
            "application/json",
            json!({ "model": "fixture-model", "input": "Hi" }).to_string(),
        ),
        (
            Method::POST,
            format!("/v1/embeddings?key=rgw_{tail}"),
            "/v1/embeddings",
            "application/json",
            json!({ "model": "fixture-model", "input": "Hi" }).to_string(),
        ),
        (
            Method::POST,
            format!("/v1/cursor/chat/completions?key=rgw_{tail}"),
            "/v1/cursor/chat/completions",
            "application/json",
            chat_body().to_string(),
        ),
        (
            Method::POST,
            format!("/v1/agents/agent-1/chat/completions?key=rgw_{tail}"),
            "/v1/agents/:agent_id/chat/completions",
            "application/json",
            chat_body().to_string(),
        ),
        (
            Method::POST,
            format!("/v1/audio/transcriptions?key=rgw_{tail}"),
            "/v1/audio/transcriptions",
            "application/json",
            "{}".to_owned(),
        ),
        (
            Method::GET,
            format!("/v1/batches?key=rgw_{tail}"),
            "/v1/batches",
            "application/json",
            String::new(),
        ),
        (
            Method::GET,
            format!("/health?key=rgw_{tail}"),
            "/health",
            "application/json",
            String::new(),
        ),
        (
            Method::GET,
            format!("/voice/twilio/stream?key=rgw_{tail}"),
            "/voice/twilio/stream",
            "application/json",
            String::new(),
        ),
    ];
    for (method, uri, route, content_type, body) in cases {
        let (harness, calls) = fixture_harness(GatewayCustody::Fleet);
        let (status, response) =
            send_with(&harness.app, method, &uri, content_type, body, true).await;
        assert_refused(status, &response, &harness, &calls, route, route);
    }
}

#[tokio::test]
async fn probe_query_token_on_a_wrong_method_is_refused() {
    let (harness, calls) = fixture_harness(GatewayCustody::Fleet);
    let uri = format!("/v1/chat/completions?token={RGW_TOKEN}");
    let (status, body) = send_with(
        &harness.app,
        Method::GET,
        &uri,
        "application/json",
        String::new(),
        true,
    )
    .await;
    assert_refused(
        status,
        &body,
        &harness,
        &calls,
        "/v1/chat/completions",
        "GET on a POST route",
    );
}

#[tokio::test]
async fn probe_query_token_on_unmatched_paths_is_refused() {
    for path in [
        "/v1/does-not-exist",
        "/passthrough/anthropic/v1/messages",
        "/v1/chat/completions/",
    ] {
        let (harness, calls) = fixture_harness(GatewayCustody::Fleet);
        let uri = format!("{path}?token={RGW_TOKEN}");
        let (status, body) = send(&harness.app, &uri, Some(MASTER), &chat_body(), true).await;
        assert_refused(status, &body, &harness, &calls, "unmatched", path);
    }
}

// ── Token embedded inside a value (leak-only shapes) ────────────────────────
//
// No handler reads these as a credential, so a miss only leaves the token in
// URL logs. Each one places a full fake token after a clear delimiter.

#[tokio::test]
async fn probe_token_inside_stringified_json_value_is_refused() {
    let tail = token_tail();
    probe_chat_query(&format!("filter=%7B%22key%22%3A%22rgw_{tail}%22%7D")).await;
}

#[tokio::test]
async fn probe_token_after_a_semicolon_separator_is_refused() {
    probe_chat_query(&format!("alt=json;key={RGW_TOKEN}")).await;
}

#[tokio::test]
async fn probe_token_in_a_comma_list_is_refused() {
    probe_chat_query(&format!("keys=benign-value,{RGW_TOKEN}")).await;
}

#[tokio::test]
async fn probe_token_behind_an_encoded_equals_in_the_name_is_refused() {
    let tail = token_tail();
    probe_chat_query(&format!("key%3Drgw_{tail}")).await;
}

#[tokio::test]
async fn probe_token_behind_an_uppercase_scheme_is_refused() {
    probe_chat_query(&format!("key=BEARER+{RGW_TOKEN}")).await;
}

// ── /passthrough/* path shapes on Fleet ─────────────────────────────────────

#[tokio::test]
async fn probe_passthrough_path_variants_are_not_reachable_on_fleet() {
    let (state, _) = state_with(GatewayCustody::Fleet, |_| {});
    let app = crate::api::router(Arc::new(state));
    let paths = [
        "/passthrough/anthropic/v1/models",
        "/passthrough/anthropic/",
        "/passthrough/anthropic/v1/messages?beta=true",
        "/passthrough/openai-responses/v1/responses",
        "/passthrough/openai-responses/responses/compact",
        "//passthrough/anthropic/v1/messages",
        "/Passthrough/anthropic/v1/messages",
        "/passthrough%2Fanthropic/v1/messages",
        "/%70assthrough/anthropic/v1/messages",
        "/passthrough/anthropic/%2E%2E/v1/messages",
    ];
    for path in paths {
        for method in [Method::GET, Method::POST, Method::PUT, Method::DELETE] {
            let (status, body) = send_with(
                &app,
                method.clone(),
                path,
                "application/json",
                "{}".to_owned(),
                true,
            )
            .await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}: {body}");
        }
    }
}

#[tokio::test]
async fn control_passthrough_canonical_paths_reach_the_handler_off_fleet() {
    let (state, _) = state_with(GatewayCustody::SelfHosted, |_| {});
    let app = crate::api::router(Arc::new(state));
    for path in [
        "/passthrough/anthropic/v1/models",
        "/passthrough/openai-responses/v1/responses",
    ] {
        let (status, body) = send_with(
            &app,
            Method::GET,
            path,
            "application/json",
            String::new(),
            false,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}: {body}");
    }
}

// ── POST /v1/batches body shapes on Fleet ───────────────────────────────────

fn assert_batch_refused(
    status: StatusCode,
    body: &Value,
    harness: &Harness,
    upstream: &BatchUpstream,
    shape: &str,
) {
    assert_eq!(status, StatusCode::FORBIDDEN, "{shape}: {body}");
    assert_eq!(body["error"]["code"], "feature_not_permitted", "{shape}");
    assert_eq!(body["error"]["layer"], "platform", "{shape}");
    assert_eq!(
        upstream.submissions.load(Ordering::SeqCst),
        0,
        "{shape}: upstream was called"
    );
    let rows = harness.audit.rows();
    assert_eq!(rows.len(), 1, "{shape}: {rows:?}");
    assert_eq!(rows[0].model, "batches.create", "{shape}");
    assert_eq!(rows[0].error.as_deref(), Some("feature_not_permitted"));
}

fn many_requests_body(count: usize, padding: &str) -> Value {
    let requests: Vec<Value> = (0..count)
        .map(|index| {
            json!({
                "custom_id": format!("item-{index}"),
                "body": {
                    "messages": [{
                        "role": "user",
                        "content": [{ "type": "text", "text": format!("{padding}item {index}") }]
                    }],
                    "metadata": { "nested": { "deeper": [{ "note": "AKIAIOSFODNN7EXAMPLE" }] } }
                }
            })
        })
        .collect();
    json!({
        "endpoint": "/v1/chat/completions",
        "model": "openai/gpt-4o-mini",
        "completion_window": "24h",
        "requests": requests
    })
}

#[tokio::test]
async fn probe_batch_body_shapes_are_all_refused_on_fleet() {
    let mut odd_endpoint = batch_body();
    odd_endpoint["endpoint"] = json!("/v1/embeddings-not-a-real-endpoint");
    let mut extra_fields = batch_body();
    // The create body denies unknown top-level fields (422 before the handler),
    // so the stringified JSON rides inside an item body instead.
    extra_fields["requests"][0]["body"]["metadata"] = json!({ "payload": "{\"requests\":[]}" });
    extra_fields["provider"] = json!({ "only": ["openai"] });
    let shapes = [
        (
            "many requests",
            "/v1/batches",
            many_requests_body(1_000, ""),
        ),
        (
            "padded items",
            "/v1/batches",
            many_requests_body(4, &"x".repeat(200_000)),
        ),
        ("unknown endpoint", "/v1/batches", odd_endpoint),
        ("extra fields", "/v1/batches", extra_fields),
        (
            "query on route",
            "/v1/batches?beta=true&alt=json",
            batch_body(),
        ),
    ];
    for (shape, uri, body) in shapes {
        let upstream = spawn_batch_upstream().await;
        let harness = batch_harness(GatewayCustody::Fleet, &upstream);
        let (status, response) = send(&harness.app, uri, Some(MASTER), &body, true).await;
        assert_batch_refused(status, &response, &harness, &upstream, shape);
    }
}

#[tokio::test]
async fn control_many_request_batch_dispatches_off_fleet() {
    let upstream = spawn_batch_upstream().await;
    let harness = batch_harness(GatewayCustody::SelfHosted, &upstream);
    let (status, body) = send(
        &harness.app,
        "/v1/batches",
        Some(MASTER),
        &many_requests_body(1_000, ""),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(upstream.submissions.load(Ordering::SeqCst), 1);
}
