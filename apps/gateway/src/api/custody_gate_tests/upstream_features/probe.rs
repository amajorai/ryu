//! Coverage probes for the fleet's Anthropic server-tool and beta refusal.
//!
//! Each probe places a harmless marker (a real Anthropic tool type or beta
//! identifier, which names a feature and carries no content) in an input shape
//! the main suite does not exercise: long padding, odd spellings, alias routes,
//! tool-loop headers, a fallback chain, streaming, duplicate headers, query
//! strings, stringified JSON and private body fields. A shape the guard must
//! refuse asserts the catalogue refusal, zero upstream requests and one audit
//! row. A shape the guard need not refuse asserts that the marker never reaches
//! the mock upstream, and that a dispatched request reached it exactly once.
use super::*;

/// The server-tool marker. A real type identifier, so it is a safe trigger.
const SERVER_TOOL_TYPE: &str = "web_fetch_20250910";
/// The beta marker the parent module already uses.
const BETA_MARKER: &str = CODE_EXECUTION_BETA;
/// The two values the fleet forwards.
const PERMITTED: [&str; 2] = ["prompt-caching-2024-07-31", "extended-cache-ttl-2025-04-11"];

/// Benign filler placed before a marker.
fn padding(bytes: usize) -> String {
    "lorem ipsum dolor sit amet ".repeat(bytes / 27 + 1)
}

/// `count` distinct, ordinary function tools.
fn many_function_tools(count: usize) -> Vec<Value> {
    (0..count)
        .map(|index| {
            json!({
                "type": "function",
                "function": {
                    "name": format!("lookup_{index}"),
                    "description": "Look up a record by id.",
                    "parameters": { "type": "object", "properties": {} }
                }
            })
        })
        .collect()
}

/// `count` distinct Anthropic custom tools.
fn many_custom_tools(count: usize) -> Vec<Value> {
    (0..count)
        .map(|index| {
            json!({
                "name": format!("lookup_{index}"),
                "description": "Look up a record by id.",
                "input_schema": { "type": "object", "properties": {} }
            })
        })
        .collect()
}

/// Send a raw body with an arbitrary header list (repeats allowed).
async fn send_raw(
    app: &Router,
    uri: &str,
    headers: &[(&str, &str)],
    body: String,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {MASTER}"))
        .extension(peer(true));
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body)).expect("request builds"))
        .await
        .expect("router responds");
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

/// The shape need not be refused, but nothing in it may reach the upstream:
/// no marker in any captured body, no beta outside the allowlist, and a
/// dispatched request reached the mock exactly once.
fn assert_marker_never_forwarded(
    status: StatusCode,
    response: &Value,
    upstream: &AnthropicUpstream,
    markers: &[&str],
    case: &str,
) {
    let requests = upstream.requests();
    for captured in &requests {
        let wire = captured.body.to_string();
        for marker in markers {
            assert!(
                !wire.contains(marker),
                "{case}: {marker} reached upstream: {wire}"
            );
        }
        assert!(
            captured.body.get("ryu_anthropic_beta").is_none(),
            "{case}: private field reached upstream"
        );
        if let Some(beta) = captured.beta.as_deref() {
            for value in beta.split(',').map(str::trim).filter(|v| !v.is_empty()) {
                assert!(
                    PERMITTED.contains(&value),
                    "{case}: beta {value} reached upstream"
                );
            }
        }
    }
    if status.is_success() {
        assert_eq!(requests.len(), 1, "{case}: {response}");
    } else {
        assert!(
            requests.is_empty(),
            "{case}: {status} but upstream was called"
        );
    }
}

/// Benign control on the same harness shape, so a refusal cannot just mean the
/// route is broken.
async fn assert_route_dispatches(uri: &str, body: &Value) {
    let upstream = spawn_anthropic_upstream().await;
    let harness = anthropic_harness(GatewayCustody::Fleet, &upstream);
    let (status, response) = send_raw(
        &harness.app,
        uri,
        &[("anthropic-beta", CACHING_BETAS)],
        body.to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "control {uri}: {response}");
    assert_eq!(upstream.requests().len(), 1, "control {uri}");
}

async fn probe_refused(uri: &str, headers: &[(&str, &str)], body: String, case: &str) {
    let upstream = spawn_anthropic_upstream().await;
    let harness = anthropic_harness(GatewayCustody::Fleet, &upstream);
    let (status, response) = send_raw(&harness.app, uri, headers, body).await;
    assert_refused(status, &response, &harness, &upstream, case);
}

async fn probe_not_forwarded(
    uri: &str,
    headers: &[(&str, &str)],
    body: String,
    markers: &[&str],
    case: &str,
) {
    let upstream = spawn_anthropic_upstream().await;
    let harness = anthropic_harness(GatewayCustody::Fleet, &upstream);
    let (status, response) = send_raw(&harness.app, uri, headers, body).await;
    assert_marker_never_forwarded(status, &response, &upstream, markers, case);
}

// ── /v1/chat/completions: shapes the guard must refuse ──────────────────────

#[tokio::test]
async fn probe_server_tool_behind_long_padding_and_many_function_tools() {
    for stream in [false, true] {
        let mut tools = many_function_tools(100);
        tools.push(web_fetch_tool());
        let body = json!({
            "model": ANTHROPIC_MODEL,
            "stream": stream,
            "messages": [{ "role": "user", "content": padding(100 * 1024) }],
            "tools": tools
        });
        probe_refused(
            "/v1/chat/completions",
            &[],
            body.to_string(),
            &format!("padded server tool, stream={stream}"),
        )
        .await;
    }
    let mut tools = many_function_tools(100);
    tools.push(function_tool());
    assert_route_dispatches(
        "/v1/chat/completions",
        &json!({
            "model": ANTHROPIC_MODEL,
            "messages": [{ "role": "user", "content": padding(100 * 1024) }],
            "tools": tools
        }),
    )
    .await;
}

#[tokio::test]
async fn probe_function_type_spellings_that_are_not_function() {
    let function = json!({ "name": "lookup", "parameters": { "type": "object" } });
    for kind in [
        json!("Function"),
        json!("FUNCTION"),
        json!("function "),
        json!(" function"),
        json!(""),
        json!(["function"]),
        json!({ "name": "function" }),
        json!(true),
    ] {
        let body = chat_with_tools(
            vec![
                function_tool(),
                json!({ "type": kind, "function": function, "name": "web_fetch" }),
            ],
            false,
        );
        probe_refused(
            "/v1/chat/completions",
            &[],
            body.to_string(),
            &format!("type {kind}"),
        )
        .await;
    }
}

#[tokio::test]
async fn probe_server_tool_nested_in_an_array_entry() {
    let body = json!({
        "model": ANTHROPIC_MODEL,
        "messages": [{ "role": "user", "content": "Hi" }],
        "tools": [function_tool(), [web_fetch_tool()]]
    });
    probe_refused(
        "/v1/chat/completions",
        &[],
        body.to_string(),
        "nested array",
    )
    .await;
}

#[tokio::test]
async fn probe_alias_routes_refuse_server_tools_and_betas() {
    for uri in [
        "/v1/cursor/chat/completions",
        "/v1/agents/probe-agent/chat/completions",
    ] {
        assert_route_dispatches(uri, &chat_with_tools(vec![function_tool()], false)).await;
        let body = chat_with_tools(vec![function_tool(), web_fetch_tool()], false);
        probe_refused(uri, &[], body.to_string(), &format!("{uri} server tool")).await;
        let body = chat_with_tools(vec![function_tool()], true);
        probe_refused(
            uri,
            &[("anthropic-beta", BETA_MARKER)],
            body.to_string(),
            &format!("{uri} beta"),
        )
        .await;
    }
}

#[tokio::test]
async fn probe_tool_loop_headers_do_not_bypass_the_refusal() {
    for header in [
        ("x-ryu-raw-tools", "on"),
        ("x-ryu-tool-search", "on"),
        ("x-ryu-tools", "lookup_order"),
        ("x-ryu-prompt-cache", "auto"),
    ] {
        for stream in [false, true] {
            let body = chat_with_tools(vec![function_tool(), web_fetch_tool()], stream);
            probe_refused(
                "/v1/chat/completions",
                &[header],
                body.to_string(),
                &format!("{header:?} server tool, stream={stream}"),
            )
            .await;
            let body = chat_with_tools(vec![function_tool()], stream);
            probe_refused(
                "/v1/chat/completions",
                &[header, ("anthropic-beta", BETA_MARKER)],
                body.to_string(),
                &format!("{header:?} beta, stream={stream}"),
            )
            .await;
        }
    }
}

#[tokio::test]
async fn probe_beta_lists_with_unusual_separators_and_padding() {
    let long_padding = format!("{}{BETA_MARKER}", ", ".repeat(2048));
    let tabbed = format!("{}\t{BETA_MARKER}", PERMITTED[0]);
    let semicolon = format!("{};{BETA_MARKER}", PERMITTED[0]);
    let doubled = format!("{},,,{BETA_MARKER},", PERMITTED[0]);
    let quoted = format!("\"{BETA_MARKER}\"");
    let spaced = format!("{} {BETA_MARKER}", PERMITTED[1]);
    for (name, value) in [
        ("anthropic-beta", long_padding.as_str()),
        ("anthropic-beta", tabbed.as_str()),
        ("anthropic-beta", semicolon.as_str()),
        ("anthropic-beta", doubled.as_str()),
        ("anthropic-beta", quoted.as_str()),
        ("anthropic-beta", spaced.as_str()),
        ("Anthropic-Beta", BETA_MARKER),
        ("ANTHROPIC-BETA", BETA_MARKER),
    ] {
        for uri in ["/v1/chat/completions", "/v1/messages"] {
            let body = if uri == "/v1/messages" {
                messages_with_tools(vec![custom_tool()])
            } else {
                chat_with_tools(vec![function_tool()], false)
            };
            probe_refused(
                uri,
                &[(name, value)],
                body.to_string(),
                &format!("{uri} {name}: {value:.40}"),
            )
            .await;
        }
    }
}

const DUPLICATE_BETA_HEADERS: [(&str, &str); 2] = [
    ("anthropic-beta", PERMITTED[0]),
    ("anthropic-beta", BETA_MARKER),
];

#[tokio::test]
async fn probe_a_second_beta_header_line_is_refused_on_chat() {
    let body = chat_with_tools(vec![function_tool()], false);
    probe_refused(
        "/v1/chat/completions",
        &DUPLICATE_BETA_HEADERS,
        body.to_string(),
        "chat duplicate beta header",
    )
    .await;
}

#[tokio::test]
async fn probe_a_second_beta_header_line_is_refused_on_messages() {
    let body = messages_with_tools(vec![custom_tool()]);
    probe_refused(
        "/v1/messages",
        &DUPLICATE_BETA_HEADERS,
        body.to_string(),
        "messages duplicate beta header",
    )
    .await;
}

#[tokio::test]
async fn probe_a_second_beta_header_line_is_never_forwarded() {
    for uri in ["/v1/chat/completions", "/v1/messages"] {
        let body = if uri == "/v1/messages" {
            messages_with_tools(vec![custom_tool()])
        } else {
            chat_with_tools(vec![function_tool()], false)
        };
        probe_not_forwarded(
            uri,
            &DUPLICATE_BETA_HEADERS,
            body.to_string(),
            &[BETA_MARKER],
            &format!("{uri} duplicate beta header"),
        )
        .await;
    }
}

#[tokio::test]
async fn probe_fallback_chain_never_carries_a_refused_request() {
    let upstream = spawn_anthropic_upstream().await;
    let base_url = upstream.base.clone();
    let (mut state, audit) = state_with(GatewayCustody::Fleet, |config| {
        config.providers.anthropic = Some(crate::config::AnthropicProviderConfig {
            api_key: "sk-ant-mock".to_owned(),
            api_keys: Vec::new(),
            base_url,
        });
        config.routing.default_provider = ProviderId::from("anthropic");
        config.routing.fallback_chain = vec![ProviderId::from(FIXTURE)];
    });
    let calls = Arc::new(AtomicUsize::new(0));
    state
        .provider_runtime
        .register_for_test(Arc::new(FixtureProvider {
            calls: Arc::clone(&calls),
        }));
    let harness = Harness {
        app: crate::api::router(Arc::new(state)),
        audit,
    };
    for stream in [false, true] {
        let body = chat_with_tools(vec![function_tool(), web_fetch_tool()], stream);
        let (status, response) =
            send_raw(&harness.app, "/v1/chat/completions", &[], body.to_string()).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "stream={stream}: {response}");
        assert_eq!(response["error"]["code"], "feature_not_permitted");
        let body = chat_with_tools(vec![function_tool()], stream);
        let (status, response) = send_raw(
            &harness.app,
            "/v1/chat/completions",
            &[("anthropic-beta", BETA_MARKER)],
            body.to_string(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "stream={stream}: {response}");
        assert_eq!(response["error"]["code"], "feature_not_permitted");
    }
    assert!(upstream.requests().is_empty(), "{:?}", upstream.requests());
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "fallback provider was called"
    );
    let rows = harness.audit.rows();
    assert_eq!(rows.len(), 4, "{rows:?}");
    assert!(rows.iter().all(|row| row
        .error
        .as_deref()
        .is_some_and(|error| error.contains("feature_not_permitted"))));

    let body = chat_with_tools(vec![function_tool()], false);
    let (status, response) =
        send_raw(&harness.app, "/v1/chat/completions", &[], body.to_string()).await;
    assert_eq!(status, StatusCode::OK, "control: {response}");
    assert_eq!(upstream.requests().len(), 1, "control");
}

// ── /v1/chat/completions: shapes whose marker must never reach upstream ─────

#[tokio::test]
async fn probe_tools_in_shapes_the_provider_cannot_read() {
    let stringified = serde_json::to_string(&json!([web_fetch_tool()])).expect("encodes");
    for tools in [
        json!(stringified),
        json!({ "0": web_fetch_tool() }),
        json!([{
            "type": "function",
            "function": {
                "name": "lookup",
                "type": SERVER_TOOL_TYPE,
                "parameters": { "type": "object" }
            },
            "server": web_fetch_tool()
        }]),
    ] {
        let body = json!({
            "model": ANTHROPIC_MODEL,
            "messages": [{ "role": "user", "content": "Hi" }],
            "tools": tools
        });
        probe_not_forwarded(
            "/v1/chat/completions",
            &[],
            body.to_string(),
            &[SERVER_TOOL_TYPE],
            &format!("tools {tools}"),
        )
        .await;
    }
}

#[tokio::test]
async fn probe_duplicate_tools_keys_resolve_the_same_way_for_guard_and_provider() {
    let function = function_tool().to_string();
    let server = web_fetch_tool().to_string();
    let message = r#"[{"role":"user","content":"Hi"}]"#;
    // The last key wins in the parser both readers share; whichever wins,
    // a server tool must not reach the upstream.
    for (first, second) in [(&function, &server), (&server, &function)] {
        let body = format!(
            r#"{{"model":"{ANTHROPIC_MODEL}","messages":{message},"tools":[{first}],"tools":[{second}]}}"#
        );
        probe_not_forwarded(
            "/v1/chat/completions",
            &[],
            body,
            &[SERVER_TOOL_TYPE],
            "duplicate tools keys",
        )
        .await;
    }
}

#[tokio::test]
async fn probe_private_beta_field_written_by_the_caller() {
    for stream in [false, true] {
        let mut body = chat_with_tools(vec![function_tool()], stream);
        body["ryu_anthropic_beta"] = json!(BETA_MARKER);
        probe_not_forwarded(
            "/v1/chat/completions",
            &[],
            body.to_string(),
            &[BETA_MARKER],
            &format!("private field, stream={stream}"),
        )
        .await;
    }
    let mut body = messages_with_tools(vec![custom_tool()]);
    body["ryu_anthropic_beta"] = json!(BETA_MARKER);
    probe_not_forwarded(
        "/v1/messages",
        &[],
        body.to_string(),
        &[BETA_MARKER],
        "private field on /v1/messages",
    )
    .await;
}

#[tokio::test]
async fn probe_beta_in_the_query_string_is_never_forwarded() {
    let query = format!("anthropic-beta={BETA_MARKER}&ryu_anthropic_beta={BETA_MARKER}");
    for uri in ["/v1/chat/completions", "/v1/messages"] {
        let body = if uri == "/v1/messages" {
            messages_with_tools(vec![custom_tool()])
        } else {
            chat_with_tools(vec![function_tool()], false)
        };
        probe_not_forwarded(
            &format!("{uri}?{query}"),
            &[],
            body.to_string(),
            &[BETA_MARKER],
            &format!("{uri} query"),
        )
        .await;
    }
}

#[tokio::test]
async fn probe_upstream_feature_fields_outside_tools_are_not_forwarded() {
    let fields = json!({
        "mcp_servers": [{ "type": "url", "url": "https://mcp.example.invalid/sse", "name": "probe" }],
        "container": "container_probe_marker",
        "context_management": { "edits": [{ "type": "clear_tool_uses_20250919" }] }
    });
    for uri in ["/v1/chat/completions", "/v1/messages"] {
        for stream in [false, true] {
            let mut body = if uri == "/v1/messages" {
                messages_with_tools(vec![custom_tool()])
            } else {
                chat_with_tools(vec![function_tool()], false)
            };
            body["stream"] = json!(stream);
            for (key, value) in fields.as_object().expect("object") {
                body[key] = value.clone();
            }
            probe_not_forwarded(
                uri,
                &[],
                body.to_string(),
                &[
                    "mcp_servers",
                    "example.invalid",
                    "container_probe_marker",
                    "clear_tool_uses_20250919",
                ],
                &format!("{uri} feature fields, stream={stream}"),
            )
            .await;
        }
    }
}

// ── /v1/messages: shapes the guard must refuse ──────────────────────────────

#[tokio::test]
async fn probe_messages_streaming_refuses_typed_tools_and_betas() {
    let mut body = messages_with_tools(vec![
        custom_tool(),
        json!({ "type": "web_search_20250305", "name": "web_search" }),
    ]);
    body["stream"] = json!(true);
    probe_refused(
        "/v1/messages",
        &[],
        body.to_string(),
        "streaming typed tool",
    )
    .await;

    let mut body = messages_with_tools(vec![custom_tool()]);
    body["stream"] = json!(true);
    probe_refused(
        "/v1/messages",
        &[("anthropic-beta", BETA_MARKER)],
        body.to_string(),
        "streaming beta",
    )
    .await;

    let mut body = messages_with_tools(vec![custom_tool()]);
    body["stream"] = json!(true);
    let upstream = spawn_anthropic_upstream().await;
    let harness = anthropic_harness(GatewayCustody::Fleet, &upstream);
    let (status, response) = send_raw(
        &harness.app,
        "/v1/messages",
        &[("anthropic-beta", CACHING_BETAS)],
        body.to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "control: {response}");
    assert_eq!(upstream.requests().len(), 1, "control");
}

#[tokio::test]
async fn probe_messages_custom_type_spellings_and_padding() {
    for kind in [
        json!("Custom"),
        json!("custom "),
        json!("function"),
        json!(""),
        json!(["custom"]),
    ] {
        let body = messages_with_tools(vec![
            custom_tool(),
            json!({ "type": kind, "name": "web_fetch", "input_schema": {} }),
        ]);
        probe_refused(
            "/v1/messages",
            &[],
            body.to_string(),
            &format!("type {kind}"),
        )
        .await;
    }
    let mut tools = many_custom_tools(100);
    tools.push(json!({ "type": SERVER_TOOL_TYPE, "name": "web_fetch" }));
    let body = json!({
        "model": ANTHROPIC_MODEL,
        "max_tokens": 64,
        "messages": [{ "role": "user", "content": padding(100 * 1024) }],
        "tools": tools
    });
    probe_refused("/v1/messages", &[], body.to_string(), "padded server tool").await;
}

// ── Other inference routes ──────────────────────────────────────────────────

#[tokio::test]
async fn probe_responses_route_never_forwards_a_server_tool() {
    let body = json!({
        "model": ANTHROPIC_MODEL,
        "input": "Hi",
        "tools": [{ "type": SERVER_TOOL_TYPE, "name": "web_fetch" }]
    });
    let upstream = spawn_anthropic_upstream().await;
    let harness = anthropic_harness(GatewayCustody::Fleet, &upstream);
    let (status, response) = send_raw(&harness.app, "/v1/responses", &[], body.to_string()).await;
    assert!(status.is_client_error(), "{status}: {response}");
    assert!(upstream.requests().is_empty(), "{:?}", upstream.requests());

    assert_route_dispatches(
        "/v1/responses",
        &json!({ "model": ANTHROPIC_MODEL, "input": "Hi" }),
    )
    .await;
}

#[tokio::test]
async fn probe_responses_route_refuses_a_beta_outside_the_allowlist() {
    for stream in [false, true] {
        let body = json!({ "model": ANTHROPIC_MODEL, "input": "Hi", "stream": stream });
        probe_refused(
            "/v1/responses",
            &[("anthropic-beta", BETA_MARKER)],
            body.to_string(),
            &format!("responses beta, stream={stream}"),
        )
        .await;
    }
}

#[tokio::test]
async fn probe_responses_route_never_forwards_a_beta() {
    for stream in [false, true] {
        let body = json!({ "model": ANTHROPIC_MODEL, "input": "Hi", "stream": stream });
        probe_not_forwarded(
            "/v1/responses",
            &[("anthropic-beta", BETA_MARKER)],
            body.to_string(),
            &[BETA_MARKER],
            &format!("responses beta, stream={stream}"),
        )
        .await;
    }
}

#[tokio::test]
async fn probe_gemini_route_never_forwards_server_tools_or_betas() {
    let body = json!({
        "contents": [{ "role": "user", "parts": [{ "text": "Hi" }] }],
        "tools": [
            { "type": SERVER_TOOL_TYPE, "name": "web_fetch" },
            { "googleSearch": {} },
            { "codeExecution": {} }
        ]
    });
    probe_not_forwarded(
        &format!("/v1beta/models/{ANTHROPIC_MODEL}:generateContent"),
        &[("anthropic-beta", BETA_MARKER), ("x-goog-api-key", MASTER)],
        body.to_string(),
        &[
            SERVER_TOOL_TYPE,
            "googleSearch",
            "codeExecution",
            BETA_MARKER,
        ],
        "gemini",
    )
    .await;
}
