//! Coverage probes for upstream identity (spec 03 and 00.8).
//!
//! `upstream_identity` proves the main chat and embedding paths. These probes
//! send the same tenant identifiers down the paths a per-attempt stamp tends
//! to miss: a fallback attempt on a different provider, tool-loop rounds, the
//! protocol-compat routes, multimodal routes, a provider with no field, the
//! response cache, and every identity source the actor precedence reads.
//!
//! Every assertion is on the bytes the mock upstream (or a recording
//! provider) received. Markers are test values only: `RYU_TEST_LEXICON`
//! sentinels and a made-up end-user id.
use super::*;
use crate::config::{ApiKeyConfig, ApiKeyOperation, CoreProviderConfig};
use crate::tools::{catalog_client::model_tool_name, ToolSearchClient};

/// A static relay key that is not a trusted forwarder.
const PLAIN_STATIC: &str = "sk-probe-plain-static";
/// A static relay key that is a trusted forwarder (Core's role).
const FORWARDER_STATIC: &str = "sk-probe-forwarder-static";
/// A provider id that has no upstream identity field.
const UNLISTED: &str = "probe-unlisted";
const UNIFIED_TOOL: &str = "exa.search";

/// One request the probe upstream received, headers included.
#[derive(Clone, Debug)]
struct Seen {
    path: String,
    headers: axum::http::HeaderMap,
    raw: Vec<u8>,
    body: Value,
}

struct ProbeUpstream {
    base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    task: tokio::task::JoinHandle<()>,
}

impl ProbeUpstream {
    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().expect("seen lock").clone()
    }

    fn under(&self, prefix: &str) -> Vec<Seen> {
        self.seen()
            .into_iter()
            .filter(|seen| seen.path.starts_with(prefix))
            .collect()
    }
}

impl Drop for ProbeUpstream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn media_reply(path: &str) -> Option<axum::response::Response> {
    use axum::response::IntoResponse;
    if path.ends_with("/images/generations") {
        return Some(
            Json(json!({ "created": 1, "data": [{ "b64_json": "aGVsbG8=" }] })).into_response(),
        );
    }
    if path.ends_with("/audio/speech") {
        return Some(
            axum::response::Response::builder()
                .header("content-type", "audio/wav")
                .body(Body::from(vec![0_u8; 64]))
                .expect("audio response builds"),
        );
    }
    if path.ends_with("/audio/transcriptions") {
        return Some(Json(json!({ "text": "ok" })).into_response());
    }
    None
}

/// A mock that answers like the shared one, captures raw bytes and headers,
/// and answers `503` to every request under a `failing` prefix.
async fn spawn_probe_upstream(failing: &'static [&'static str]) -> ProbeUpstream {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("probe upstream binds");
    let base = format!("http://{}", listener.local_addr().expect("probe address"));
    let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
    let captured = Arc::clone(&seen);
    let router = Router::new()
        .route(
            "/api/control-plane/gateway/resolve",
            axum::routing::get(|headers: axum::http::HeaderMap| async move {
                use axum::response::IntoResponse;
                let key = headers
                    .get("x-gateway-key")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default();
                match resolve_payload(key) {
                    Some(payload) => Json(payload).into_response(),
                    None => StatusCode::UNAUTHORIZED.into_response(),
                }
            }),
        )
        .fallback(
            move |uri: axum::http::Uri, headers: axum::http::HeaderMap, raw: axum::body::Bytes| {
                let captured = Arc::clone(&captured);
                async move {
                    use axum::response::IntoResponse;
                    let path = uri.path().to_owned();
                    let body = serde_json::from_slice(&raw).unwrap_or(Value::Null);
                    captured.lock().expect("seen lock").push(Seen {
                        path: path.clone(),
                        headers,
                        raw: raw.to_vec(),
                        body: body.clone(),
                    });
                    if failing.iter().any(|prefix| path.starts_with(prefix)) {
                        return (
                            StatusCode::SERVICE_UNAVAILABLE,
                            Json(json!({ "error": { "message": "probe outage" } })),
                        )
                            .into_response();
                    }
                    media_reply(&path).unwrap_or_else(|| reply_for(&path, &body))
                }
            },
        );
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("probe upstream serves");
    });
    ProbeUpstream { base, seen, task }
}

fn static_key(key: &str, name: &str, trusted_forwarder: bool) -> ApiKeyConfig {
    ApiKeyConfig {
        allowed_operations: vec![ApiKeyOperation::Inference],
        key: key.to_owned(),
        name: name.to_owned(),
        org_id: Some("org_a".to_owned()),
        team_id: None,
        channel_id: None,
        project_id: None,
        requests_per_minute: None,
        tokens_per_minute: None,
        token_budget_total: None,
        downgrade_to: None,
        trusted_forwarder,
    }
}

/// The shared identity harness, with a fallback chain, extra config and a
/// hook on the state before the router is built.
fn probe_harness(
    custody: GatewayCustody,
    provider: &str,
    fallbacks: &[&str],
    upstream: &ProbeUpstream,
    keys: IdentityKeys,
    configure: impl FnOnce(&mut GatewayConfig),
    prepare: impl FnOnce(&mut AppState),
) -> Harness {
    let base = upstream.base.clone();
    let provider = provider.to_owned();
    let fallbacks: Vec<ProviderId> = fallbacks.iter().map(|id| ProviderId::from(*id)).collect();
    let (mut state, audit) = state_with(custody, |config| {
        config.providers.openai = Some(crate::config::OpenAiProviderConfig {
            api_key: "sk-openai-mock".to_owned(),
            api_keys: Vec::new(),
            base_url: format!("{base}/openai"),
        });
        config.providers.anthropic = Some(crate::config::AnthropicProviderConfig {
            api_key: "sk-ant-mock".to_owned(),
            api_keys: Vec::new(),
            base_url: format!("{base}/anthropic"),
        });
        config.providers.openrouter = Some(crate::config::OpenRouterProviderConfig {
            api_key: "sk-or-mock".to_owned(),
            api_keys: Vec::new(),
            base_url: format!("{base}/openrouter"),
            site_url: "https://ryu.example".to_owned(),
            site_name: "Ryu".to_owned(),
            data_collection: String::new(),
            zdr: false,
            sort: String::new(),
            response_healing: false,
            usage_accounting: true,
            org_api_keys: Default::default(),
        });
        config.routing.default_provider = ProviderId::from(provider.as_str());
        config.routing.fallback_chain = fallbacks;
        config.auth.api_keys = vec![
            static_key(PLAIN_STATIC, "probe-plain", false),
            static_key(FORWARDER_STATIC, "probe-forwarder", true),
        ];
        configure(config);
    });
    state.resolve_cache = Some(crate::policy::ResolveCache::for_test(
        upstream.base.clone(),
        reqwest::Client::new(),
    ));
    state.identity_keys = Arc::new(keys);
    prepare(&mut state);
    Harness {
        app: crate::api::router(Arc::new(state)),
        audit,
    }
}

fn fleet(provider: &str, upstream: &ProbeUpstream) -> Harness {
    probe_harness(
        GatewayCustody::Fleet,
        provider,
        &[],
        upstream,
        keys(),
        |_| {},
        |_| {},
    )
}

/// POST with any headers and a raw body.
async fn send_raw(
    app: &Router,
    uri: &str,
    headers: &[(&str, &[u8])],
    content_type: &str,
    body: Vec<u8>,
) -> (StatusCode, String) {
    let mut request = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("content-type", content_type)
        .extension(peer(false));
    for (name, value) in headers {
        request = request.header(
            *name,
            axum::http::HeaderValue::from_bytes(value).expect("header bytes"),
        );
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
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

async fn send_json(
    app: &Router,
    uri: &str,
    key: &str,
    extra: &[(&str, &[u8])],
    body: &Value,
) -> (StatusCode, String) {
    let bearer = format!("Bearer {key}");
    let mut headers: Vec<(&str, &[u8])> = vec![("authorization", bearer.as_bytes())];
    headers.extend_from_slice(extra);
    send_raw(
        app,
        uri,
        &headers,
        "application/json",
        body.to_string().into_bytes(),
    )
    .await
}

fn provider_of(path: &str) -> &'static str {
    if path.starts_with("/openai") {
        "openai"
    } else if path.starts_with("/anthropic") {
        "anthropic"
    } else if path.starts_with("/openrouter") {
        "openrouter"
    } else {
        panic!("request to an unexpected path: {path}")
    }
}

/// The attempt carried exactly `subject` in its provider's field, no tenant
/// identifier in its body, and no end-user value in any header.
fn assert_clean_attempt(seen: &Seen, subject: &str, case: &str) {
    let provider = provider_of(&seen.path);
    assert_eq!(
        stamped_field(provider, &seen.body),
        json!(subject),
        "{case}: {} {}",
        seen.path,
        seen.body
    );
    assert_no_tenant_identifier(&seen.body);
    assert_no_end_user_header(seen, case);
}

fn assert_no_end_user_header(seen: &Seen, case: &str) {
    assert!(
        seen.headers.get("x-ryu-end-user").is_none(),
        "{case}: x-ryu-end-user forwarded to {}",
        seen.path
    );
    for (name, value) in &seen.headers {
        let value = String::from_utf8_lossy(value.as_bytes());
        assert!(
            !value.contains(END_USER),
            "{case}: raw end user reached upstream in header {name}"
        );
    }
}

// ─── Fallback attempts ───────────────────────────────────────────────────────

#[tokio::test]
async fn probe_each_fallback_attempt_carries_only_its_own_providers_field() {
    let subject = credential_subject("cred_default");
    let cases: [(&str, &str, &'static [&'static str]); 3] = [
        ("openai", "anthropic", &["/openai"]),
        ("anthropic", "openrouter", &["/anthropic"]),
        ("openrouter", "openai", &["/openrouter"]),
    ];
    for (primary, fallback, failing) in cases {
        for stream in [false, true] {
            let case = format!("{primary}->{fallback} stream={stream}");
            let upstream = spawn_probe_upstream(failing).await;
            let harness = probe_harness(
                GatewayCustody::Fleet,
                primary,
                &[fallback],
                &upstream,
                keys(),
                |_| {},
                |_| {},
            );
            let (status, reply) = send_json(
                &harness.app,
                "/v1/chat/completions",
                DEFAULT_KEY,
                &[],
                &tenant_chat("fixture-model", stream),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{case}: {reply}");
            let failed = upstream.under(failing[0]);
            let served = upstream.under(&format!("/{fallback}"));
            assert!(!failed.is_empty(), "{case}: primary never attempted");
            assert!(!served.is_empty(), "{case}: fallback never attempted");
            for seen in upstream.seen() {
                assert_clean_attempt(&seen, &subject, &case);
            }
        }
    }
}

// ─── Tool-loop rounds ────────────────────────────────────────────────────────

/// Answers round 1 with a tool call and later rounds with a plain answer.
/// Named like a real provider, so the stamp picks its field.
struct ToolRoundProvider {
    name: &'static str,
    tool: String,
    calls: Arc<Mutex<Vec<Value>>>,
}

impl Provider for ToolRoundProvider {
    fn name(&self) -> &'static str {
        self.name
    }

    fn complete<'a>(&'a self, _model: &'a str, body: &'a Value) -> ProviderFuture<'a, Value> {
        let round = {
            let mut calls = self.calls.lock().expect("calls lock");
            calls.push(body.clone());
            calls.len()
        };
        let message = if round == 1 {
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": { "name": self.tool, "arguments": "{\"query\":\"weather\"}" }
                }]
            })
        } else {
            json!({ "role": "assistant", "content": "done" })
        };
        Box::pin(async move {
            Ok(json!({
                "id": format!("chatcmpl-probe-{round}"),
                "object": "chat.completion",
                "model": "fixture-model",
                "choices": [{ "index": 0, "message": message, "finish_reason": "stop" }],
                "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
            }))
        })
    }

    fn complete_stream<'a>(&'a self, _model: &'a str, body: &'a Value) -> ProviderFuture<'a, Body> {
        self.calls.lock().expect("calls lock").push(body.clone());
        Box::pin(async { Ok(Body::from(chat_sse())) })
    }
}

struct CoreMock {
    base: String,
    executions: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for CoreMock {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn spawn_core() -> CoreMock {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("core mock binds");
    let base = format!("http://{}", listener.local_addr().expect("core address"));
    let executions = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&executions);
    let router = Router::new()
        .route(
            "/api/mcp/tools/call",
            axum::routing::post(move || {
                let counted = Arc::clone(&counted);
                async move {
                    counted.fetch_add(1, Ordering::SeqCst);
                    Json(json!({ "ok": true, "output": { "result": "sunny" } }))
                }
            }),
        )
        .route(
            "/api/tools/search",
            axum::routing::get(|| async {
                Json(json!({
                    "object": "list",
                    "data": [{
                        "id": UNIFIED_TOOL,
                        "name": "search",
                        "description": "Search the web",
                        "kind": "mcp"
                    }]
                }))
            }),
        )
        .route(
            "/api/tools/describe",
            axum::routing::get(|| async {
                Json(json!({
                    "id": UNIFIED_TOOL,
                    "name": "search",
                    "description": "Search the web.",
                    "args": [{ "name": "query", "type": "string",
                               "description": "Search terms", "required": true }]
                }))
            }),
        )
        .fallback(|| async { Json(json!({})) });
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("core mock serves");
    });
    CoreMock {
        base,
        executions,
        task,
    }
}

#[tokio::test]
async fn probe_every_tool_loop_round_is_stamped() {
    let subject = credential_subject("cred_default");
    for name in ["openai", "anthropic"] {
        let case = format!("tool loop on {name}");
        let upstream = spawn_probe_upstream(&[]).await;
        let core = spawn_core().await;
        let calls: Arc<Mutex<Vec<Value>>> = Arc::default();
        let recorded = Arc::clone(&calls);
        let core_base = core.base.clone();
        let harness = probe_harness(
            GatewayCustody::Fleet,
            name,
            &[],
            &upstream,
            keys(),
            |config| {
                config.providers.openai = None;
                config.providers.anthropic = None;
            },
            move |state| {
                state.tools = Some(ToolSearchClient::new(
                    &CoreProviderConfig {
                        base_url: core_base,
                        token: None,
                    },
                    reqwest::Client::builder()
                        .no_proxy()
                        .build()
                        .expect("core client"),
                ));
                state
                    .provider_runtime
                    .register_for_test(Arc::new(ToolRoundProvider {
                        name,
                        tool: model_tool_name(UNIFIED_TOOL),
                        calls: recorded,
                    }));
            },
        );
        let (status, reply) = send_json(
            &harness.app,
            "/v1/chat/completions",
            DEFAULT_KEY,
            &[("x-ryu-tools", UNIFIED_TOOL.as_bytes())],
            &tenant_chat("fixture-model", false),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{case}: {reply}");
        let bodies = calls.lock().expect("calls lock").clone();
        assert!(
            core.executions.load(Ordering::SeqCst) >= 1,
            "{case}: the tool never ran ({} rounds)",
            bodies.len()
        );
        assert!(bodies.len() >= 2, "{case}: {} rounds", bodies.len());
        for (round, body) in bodies.iter().enumerate() {
            let wire = body.to_string();
            for sentinel in [TENANT_USER, TENANT_SAFETY, TENANT_META] {
                assert!(!wire.contains(sentinel), "{case} round {round}: {wire}");
            }
            assert!(body.get("user").is_none(), "{case} round {round}: {wire}");
            match name {
                "openai" => {
                    assert_eq!(body["safety_identifier"], json!(subject), "{case} {round}");
                    assert!(body.get("ryu_upstream_subject").is_none(), "{case} {round}");
                }
                _ => {
                    assert_eq!(
                        body["ryu_upstream_subject"],
                        json!(subject),
                        "{case} {round}"
                    );
                    assert!(body.get("safety_identifier").is_none(), "{case} {round}");
                }
            }
        }
    }
}

// ─── Actor precedence and identity sources ───────────────────────────────────

fn stamped_ids(upstream: &ProbeUpstream) -> Vec<String> {
    upstream
        .seen()
        .iter()
        .map(|seen| {
            assert_no_tenant_identifier(&seen.body);
            seen.body["safety_identifier"]
                .as_str()
                .unwrap_or_else(|| panic!("no safety_identifier: {}", seen.body))
                .to_owned()
        })
        .collect()
}

#[tokio::test]
async fn probe_a_forged_user_header_on_an_rgw_key_keeps_the_credential_subject() {
    let upstream = spawn_probe_upstream(&[]).await;
    let harness = fleet("openai", &upstream);
    for forged in ["forged-user-1", "forged-user-2"] {
        let (status, reply) = send_json(
            &harness.app,
            "/v1/chat/completions",
            DEFAULT_KEY,
            &[("x-ryu-user-id", forged.as_bytes())],
            &tenant_chat("fixture-model", false),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{forged}: {reply}");
    }
    let ids = stamped_ids(&upstream);
    assert_eq!(ids.len(), 2);
    assert!(ids
        .iter()
        .all(|id| *id == credential_subject("cred_default")));
}

#[tokio::test]
async fn probe_static_keys_follow_the_forwarder_rule() {
    let keys = keys();
    let upstream = spawn_probe_upstream(&[]).await;
    let harness = fleet("openai", &upstream);
    let mut plain = Vec::new();
    let mut forwarded = Vec::new();
    for user in ["claimed-1", "claimed-2"] {
        for (key, out) in [
            (PLAIN_STATIC, &mut plain),
            (FORWARDER_STATIC, &mut forwarded),
        ] {
            let before = upstream.seen().len();
            let (status, reply) = send_json(
                &harness.app,
                "/v1/chat/completions",
                key,
                &[("x-ryu-user-id", user.as_bytes())],
                &tenant_chat("fixture-model", false),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{key} {user}: {reply}");
            let seen = upstream.seen();
            assert_eq!(seen.len(), before + 1, "{key} {user}");
            let body = &seen[before].body;
            assert_no_tenant_identifier(body);
            out.push((user, body["safety_identifier"].as_str().unwrap().to_owned()));
        }
    }
    // A plain key cannot rotate its subject with a claimed user header.
    assert_eq!(plain[0].1, plain[1].1, "{plain:?}");
    for (user, id) in &plain {
        assert_ne!(
            Some(id.clone()),
            keys.upstream_subject(SubjectKind::User, user)
        );
    }
    // A forwarder's claimed user is hashed per org and never a global user.
    assert_ne!(forwarded[0].1, forwarded[1].1, "{forwarded:?}");
    for (user, id) in &forwarded {
        let hash = keys.forwarded_user_hash("org_a", 1, user);
        assert_eq!(
            Some(id.clone()),
            keys.upstream_subject(SubjectKind::ForwardedUser, &hash),
            "{user}"
        );
        assert_ne!(
            Some(id.clone()),
            keys.upstream_subject(SubjectKind::User, user)
        );
    }
}

#[tokio::test]
async fn probe_the_end_user_subject_follows_each_requests_own_header() {
    let upstream = spawn_probe_upstream(&[]).await;
    let harness = fleet("openai", &upstream);
    let requests: [Option<&[u8]>; 4] = [
        Some(b"eu-probe-1"),
        Some(b"eu-probe-2"),
        None,
        Some(b"eu-probe-1"),
    ];
    for end_user in requests {
        let extra: Vec<(&str, &[u8])> = end_user
            .map(|value| vec![("x-ryu-end-user", value)])
            .unwrap_or_default();
        let (status, reply) = send_json(
            &harness.app,
            "/v1/chat/completions",
            SERVES_A,
            &extra,
            &tenant_chat("fixture-model", false),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{end_user:?}: {reply}");
    }
    let ids = stamped_ids(&upstream);
    assert_eq!(
        ids,
        vec![
            end_user_subject("org_a", "eu-probe-1"),
            end_user_subject("org_a", "eu-probe-2"),
            credential_subject("cred_serves_a"),
            end_user_subject("org_a", "eu-probe-1"),
        ]
    );
}

#[tokio::test]
async fn probe_a_repeated_end_user_header_is_refused_on_every_route() {
    let upstream = spawn_probe_upstream(&[]).await;
    let harness = fleet("openai", &upstream);
    let cases: [(&str, Value); 5] = [
        ("/v1/chat/completions", tenant_chat("fixture-model", false)),
        ("/v1/chat/completions", tenant_chat("fixture-model", true)),
        (
            "/v1/messages",
            json!({ "model": "fixture-model", "max_tokens": 16,
                    "messages": [{ "role": "user", "content": "Hi" }] }),
        ),
        (
            "/v1/embeddings",
            json!({ "model": "fixture-embed", "input": "hello" }),
        ),
        (
            "/v1/images/generations",
            json!({ "model": "fixture-image", "prompt": "a lighthouse" }),
        ),
    ];
    for (uri, body) in cases {
        let bearer = format!("Bearer {SERVES_A}");
        let (status, reply) = send_raw(
            &harness.app,
            uri,
            &[
                ("authorization", bearer.as_bytes()),
                ("x-ryu-end-user", b"eu-one"),
                ("x-ryu-end-user", b"eu-two"),
            ],
            "application/json",
            body.to_string().into_bytes(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}: {reply}");
        assert!(reply.contains("invalid_end_user"), "{uri}: {reply}");
    }
    assert!(upstream.seen().is_empty());
    // Control: one header on the same route dispatches.
    let (status, reply) = send_json(
        &harness.app,
        "/v1/chat/completions",
        SERVES_A,
        &[("x-ryu-end-user", b"eu-one")],
        &tenant_chat("fixture-model", false),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reply}");
}

// ─── Protocol-compat routes ──────────────────────────────────────────────────

#[tokio::test]
async fn probe_compat_routes_stamp_and_strip_on_every_provider() {
    for provider in ["openai", "anthropic", "openrouter"] {
        let upstream = spawn_probe_upstream(&[]).await;
        let harness = fleet(provider, &upstream);
        let cases: Vec<(&str, Value)> = vec![
            (
                "/v1/messages",
                json!({ "model": "fixture-model", "max_tokens": 16, "stream": false,
                        "messages": [{ "role": "user", "content": "Hi" }],
                        "metadata": { "user_id": TENANT_META } }),
            ),
            (
                "/v1/messages",
                json!({ "model": "fixture-model", "max_tokens": 16, "stream": true,
                        "messages": [{ "role": "user", "content": "Hi" }],
                        "metadata": { "user_id": TENANT_META } }),
            ),
            (
                "/v1beta/models/fixture-model:generateContent",
                json!({ "contents": [{ "role": "user", "parts": [{ "text": "Hi" }] }] }),
            ),
            (
                "/v1beta/models/fixture-model:streamGenerateContent",
                json!({ "contents": [{ "role": "user", "parts": [{ "text": "Hi" }] }] }),
            ),
            (
                "/v1/responses",
                json!({ "model": "fixture-model", "input": "Hi", "store": false,
                        "metadata": { "user_id": TENANT_META } }),
            ),
            (
                "/v1/responses",
                json!({ "model": "fixture-model", "input": "Hi", "store": false,
                        "stream": true, "metadata": { "user_id": TENANT_META } }),
            ),
            (
                "/v1/cursor/chat/completions",
                tenant_chat("fixture-model", true),
            ),
        ];
        for (uri, body) in cases {
            let case = format!("{provider} {uri} {body}");
            let before = upstream.seen().len();
            let (status, reply) = send_json(
                &harness.app,
                uri,
                SERVES_A,
                &[("x-ryu-end-user", END_USER.as_bytes())],
                &body,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{case}: {reply}");
            let seen = upstream.seen();
            assert_eq!(seen.len(), before + 1, "{case}");
            assert_clean_attempt(&seen[before], &end_user_subject("org_a", END_USER), &case);
        }
    }
}

#[tokio::test]
async fn probe_responses_refuses_body_identifiers_before_any_upstream_call() {
    let upstream = spawn_probe_upstream(&[]).await;
    let harness = fleet("openai", &upstream);
    for field in ["safety_identifier", "user"] {
        let mut body = json!({ "model": "fixture-model", "input": "Hi", "store": false });
        body[field] = json!(TENANT_SAFETY);
        let (status, reply) =
            send_json(&harness.app, "/v1/responses", DEFAULT_KEY, &[], &body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{field}: {reply}");
    }
    assert!(upstream.seen().is_empty());
}

// ─── Multimodal routes ───────────────────────────────────────────────────────

#[tokio::test]
async fn probe_openai_images_carry_the_subject_as_user() {
    let upstream = spawn_probe_upstream(&[]).await;
    let harness = fleet("openai", &upstream);
    let (status, reply) = send_json(
        &harness.app,
        "/v1/images/generations",
        SERVES_A,
        &[("x-ryu-end-user", END_USER.as_bytes())],
        &json!({
            "model": "fixture-image",
            "prompt": "a lighthouse",
            "user": TENANT_USER,
            "safety_identifier": TENANT_SAFETY,
            "metadata": { "user_id": TENANT_META },
            "ryu_upstream_subject": "ryu.1.ffffffffffffffffffffffffffffffff"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    let seen = upstream.seen();
    assert_eq!(seen.len(), 1);
    assert!(
        seen[0].path.ends_with("/images/generations"),
        "{}",
        seen[0].path
    );
    assert_eq!(
        seen[0].body["user"],
        json!(end_user_subject("org_a", END_USER))
    );
    assert!(seen[0].body.get("safety_identifier").is_none());
    assert_no_tenant_identifier(&seen[0].body);
    assert_no_end_user_header(&seen[0], "images");
}

#[tokio::test]
async fn probe_openai_speech_strips_tenant_identifiers_and_stamps_none() {
    let upstream = spawn_probe_upstream(&[]).await;
    let harness = fleet("openai", &upstream);
    let (status, reply) = send_json(
        &harness.app,
        "/v1/audio/speech",
        DEFAULT_KEY,
        &[],
        &json!({
            "model": "fixture-tts",
            "input": "hello",
            "voice": "alloy",
            "user": TENANT_USER,
            "safety_identifier": TENANT_SAFETY,
            "ryu_upstream_subject": "ryu.1.ffffffffffffffffffffffffffffffff"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    let seen = upstream.seen();
    assert_eq!(seen.len(), 1);
    assert!(seen[0].path.ends_with("/audio/speech"), "{}", seen[0].path);
    assert!(seen[0].body.get("user").is_none(), "{}", seen[0].body);
    assert!(seen[0].body.get("safety_identifier").is_none());
    assert_no_tenant_identifier(&seen[0].body);
}

#[tokio::test]
async fn probe_openai_transcription_never_forwards_a_tenant_user_form_field() {
    let upstream = spawn_probe_upstream(&[]).await;
    let harness = fleet("openai", &upstream);
    let boundary = "probe-boundary-7";
    let mut form = Vec::new();
    for (name, value) in [
        ("model", "fixture-stt"),
        ("user", TENANT_USER),
        ("safety_identifier", TENANT_SAFETY),
    ] {
        form.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    form.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .as_bytes(),
    );
    form.extend_from_slice(&[0_u8; 64]);
    form.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let bearer = format!("Bearer {DEFAULT_KEY}");
    let (status, reply) = send_raw(
        &harness.app,
        "/v1/audio/transcriptions",
        &[("authorization", bearer.as_bytes())],
        &format!("multipart/form-data; boundary={boundary}"),
        form,
    )
    .await;
    // Either the route refuses the unknown fields or it drops them; neither
    // may put them on the wire.
    assert!(
        status == StatusCode::OK || status == StatusCode::BAD_REQUEST,
        "{status}: {reply}"
    );
    for seen in upstream.seen() {
        let wire = String::from_utf8_lossy(&seen.raw);
        assert!(!wire.contains(TENANT_USER), "{}: {wire}", seen.path);
        assert!(!wire.contains(TENANT_SAFETY), "{}: {wire}", seen.path);
    }
}

// ─── A provider with no field ────────────────────────────────────────────────

/// Records every body; answers a fixed completion.
struct RecordingProvider {
    calls: Arc<Mutex<Vec<Value>>>,
}

impl Provider for RecordingProvider {
    fn name(&self) -> &'static str {
        UNLISTED
    }

    fn complete<'a>(&'a self, _model: &'a str, body: &'a Value) -> ProviderFuture<'a, Value> {
        self.calls.lock().expect("calls lock").push(body.clone());
        Box::pin(async { Ok(chat_completion()) })
    }

    fn complete_stream<'a>(&'a self, _model: &'a str, body: &'a Value) -> ProviderFuture<'a, Body> {
        self.calls.lock().expect("calls lock").push(body.clone());
        Box::pin(async { Ok(Body::from(chat_sse())) })
    }
}

/// Identity fields of every value type, beside a metadata key that must stay.
fn odd_identity_chat(stream: bool) -> Value {
    json!({
        "model": "fixture-model",
        "stream": stream,
        "messages": [{ "role": "user", "content": "Hi" }],
        "user": 123,
        "safety_identifier": { "nested": TENANT_SAFETY },
        "metadata": { "user_id": 7, "tag": "keep-me" },
        "ryu_upstream_subject": { "forged": true }
    })
}

#[tokio::test]
async fn probe_an_unlisted_provider_gets_no_identifier_of_any_type() {
    for stream in [false, true] {
        let upstream = spawn_probe_upstream(&[]).await;
        let calls: Arc<Mutex<Vec<Value>>> = Arc::default();
        let recorded = Arc::clone(&calls);
        let harness = probe_harness(
            GatewayCustody::Fleet,
            UNLISTED,
            &[],
            &upstream,
            keys(),
            |_| {},
            move |state| {
                state
                    .provider_runtime
                    .register_for_test(Arc::new(RecordingProvider { calls: recorded }));
            },
        );
        let (status, reply) = send_json(
            &harness.app,
            "/v1/chat/completions",
            DEFAULT_KEY,
            &[],
            &odd_identity_chat(stream),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "stream={stream}: {reply}");
        let bodies = calls.lock().expect("calls lock").clone();
        assert_eq!(bodies.len(), 1, "stream={stream}");
        let body = &bodies[0];
        for field in ["user", "safety_identifier", "ryu_upstream_subject"] {
            assert!(body.get(field).is_none(), "stream={stream} {field}: {body}");
        }
        assert_eq!(body["metadata"], json!({ "tag": "keep-me" }), "{body}");
    }
}

#[tokio::test]
async fn probe_openai_keeps_sibling_metadata_and_replaces_odd_identifiers() {
    let upstream = spawn_probe_upstream(&[]).await;
    let harness = fleet("openai", &upstream);
    let (status, reply) = send_json(
        &harness.app,
        "/v1/chat/completions",
        DEFAULT_KEY,
        &[],
        &odd_identity_chat(false),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reply}");
    let seen = upstream.seen();
    assert_eq!(seen.len(), 1);
    let body = &seen[0].body;
    assert_eq!(
        body["safety_identifier"],
        json!(credential_subject("cred_default"))
    );
    assert!(body.get("user").is_none(), "{body}");
    assert!(body.get("ryu_upstream_subject").is_none(), "{body}");
    assert_eq!(body["metadata"], json!({ "tag": "keep-me" }), "{body}");
}

// ─── Response cache and prompt-cache bytes ───────────────────────────────────

#[tokio::test]
async fn probe_a_cache_hit_still_works_on_the_fleet() {
    for custody in [GatewayCustody::SelfHosted, GatewayCustody::Fleet] {
        let upstream = spawn_probe_upstream(&[]).await;
        let local_keys = if custody.is_fleet() {
            keys()
        } else {
            IdentityKeys::local()
        };
        let harness = probe_harness(
            custody,
            "openai",
            &[],
            &upstream,
            local_keys,
            |config| config.cache.enabled = true,
            |_| {},
        );
        let body = json!({
            "model": "fixture-model",
            "messages": [{ "role": "user", "content": "cache probe" }],
            "temperature": 0
        });
        for _ in 0..2 {
            let (status, reply) = send_json(
                &harness.app,
                "/v1/chat/completions",
                DEFAULT_KEY,
                &[],
                &body,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{custody:?}: {reply}");
        }
        let seen = upstream.seen();
        assert_eq!(
            seen.len(),
            1,
            "{custody:?}: the second request missed the cache"
        );
        if custody.is_fleet() {
            assert_clean_attempt(&seen[0], &credential_subject("cred_default"), "cache");
        }
    }
}

#[tokio::test]
async fn probe_stamping_leaves_anthropic_prompt_bytes_identical() {
    let body = json!({
        "model": "fixture-model",
        "messages": [
            { "role": "system", "content": [{ "type": "text", "text": "Be brief.",
              "cache_control": { "type": "ephemeral" } }] },
            { "role": "user", "content": "Hi" }
        ],
        "metadata": { "user_id": TENANT_META }
    });
    let mut wire = Vec::new();
    for custody in [GatewayCustody::SelfHosted, GatewayCustody::Fleet] {
        let upstream = spawn_probe_upstream(&[]).await;
        let local_keys = if custody.is_fleet() {
            keys()
        } else {
            IdentityKeys::local()
        };
        let harness = probe_harness(
            custody,
            "anthropic",
            &[],
            &upstream,
            local_keys,
            |_| {},
            |_| {},
        );
        let (status, reply) = send_json(
            &harness.app,
            "/v1/chat/completions",
            DEFAULT_KEY,
            &[],
            &body,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{custody:?}: {reply}");
        let seen = upstream.seen();
        assert_eq!(seen.len(), 1);
        wire.push(seen[0].body.clone());
    }
    let (self_hosted, fleet_body) = (&wire[0], &wire[1]);
    for field in ["messages", "system", "tools"] {
        assert_eq!(self_hosted.get(field), fleet_body.get(field), "{field}");
    }
    assert!(self_hosted.get("metadata").is_none(), "{self_hosted}");
    assert_eq!(
        fleet_body["metadata"],
        json!({ "user_id": credential_subject("cred_default") })
    );
}
