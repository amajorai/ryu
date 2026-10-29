//! Coverage probes for platform standing (spec 05.5) across input shapes.
//!
//! `standing_tests` proves the pieces one at a time: the parser, the push
//! handler, a `StandingGuard`, and `guard_stream` over a bare body. These
//! probes drive the whole router with an `rgw_` key that resolves through a
//! local control-plane mock, so every wrapper above the standing checks is in
//! the path: the compat translators, the Responses translator, the stream
//! observer and DLP, the tool loops, the hosted Responses loop, fallback,
//! and the response cache.
//!
//! Nothing here carries real harmful content. The only payloads are plain
//! words and the window markers below. Every refused shape has a benign twin
//! that is served in full, so a refusal cannot just mean the harness is
//! broken.
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use axum::body::{to_bytes, Body, BodyDataStream};
use axum::extract::ConnectInfo;
use axum::http::{Method, Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use super::{EnforcementPush, INTERNAL_SECRET_HEADER, MAX_PUSH_BYTES};
use crate::config::{CoreProviderConfig, FirewallPolicy, GatewayConfig, ProviderId};
use crate::custody::GatewayCustody;
use crate::error::GatewayError;
use crate::policy::{CredentialUse, ResolveCache};
use crate::providers::Provider;
use crate::state::AppState;

const SECRET: &str = "probe-push-secret";
const MASTER: &str = "probe-master-key";
const PRIMARY: &str = "standing-probe-primary";
const FALLBACK: &str = "standing-probe-fallback";
const APPEAL: &str = "https://ryu.example/appeal";
/// Text the provider sends in the window before a push lands.
const FIRST: &str = "first-window-text";
/// Text the provider sends in the window after a push lands.
const SECOND: &str = "second-window-text";
/// The plain answer a scripted model gives once its script is spent.
const FINAL: &str = "final-answer-text";
const UNIFIED_TOOL: &str = "exa.search";
const COMPOSIO_ACTION: &str = "GMAIL_GET_MESSAGE";

/// Token, org, credential id, owner user id, creator user id.
const ALPHA: &str = "rgw_probe_alpha_0001";
const ALPHA_TWO: &str = "rgw_probe_alpha_0002";
const BETA: &str = "rgw_probe_beta_0001";
const SUBJECTS: &[(&str, &str, &str, Option<&str>, &str)] = &[
    (
        ALPHA,
        "org_alpha",
        "cred_alpha",
        Some("usr_alpha"),
        "usr_alpha",
    ),
    // An org credential with no owner, minted by a custodian.
    (ALPHA_TWO, "org_alpha", "cred_alpha_two", None, "usr_maker"),
    (BETA, "org_beta", "cred_beta", Some("usr_beta"), "usr_beta"),
];

type ProviderFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ryu_gw_providers::ProviderError>> + Send + 'a>>;
type Hook = Box<dyn FnOnce() + Send>;
type StateCell = Arc<OnceLock<Weak<AppState>>>;

fn standing(state: &str, refuses: &str) -> Value {
    json!({
        "state": state,
        "refuses": refuses,
        "reasonClass": "fraud",
        "until": null,
        "appealUrl": APPEAL,
        "enforcementVersion": 0
    })
}

fn banned() -> Value {
    standing("user_banned", "all")
}

/// One-shot actions keyed by the 1-based call index they run on.
#[derive(Clone, Default)]
struct Hooks(Arc<Mutex<HashMap<usize, Hook>>>);

impl Hooks {
    fn at(&self, call: usize, hook: Hook) {
        self.0.lock().unwrap().insert(call, hook);
    }

    fn fire(&self, call: usize) {
        let hook = self.0.lock().unwrap().remove(&call);
        if let Some(hook) = hook {
            hook();
        }
    }
}

// ─── Control plane and Core mock ───────────────────────────────────────────

/// Answers `/gateway/resolve` with whatever standing the test last set, and
/// Core's tool routes for the tool loops. A refuse-all standing gets the
/// minimal body the control plane really sends (control-plane.ts, resolve).
#[derive(Clone, Default)]
struct Plane {
    standings: Arc<Mutex<HashMap<String, Value>>>,
    revoked: Arc<Mutex<HashSet<String>>>,
    resolves: Arc<AtomicUsize>,
    executions: Arc<AtomicUsize>,
    execution_hooks: Hooks,
}

impl Plane {
    fn set(&self, token: &str, value: Value) {
        self.standings
            .lock()
            .unwrap()
            .insert(token.to_owned(), value);
    }

    fn revoke(&self, token: &str) {
        self.revoked.lock().unwrap().insert(token.to_owned());
    }

    fn resolves(&self) -> usize {
        self.resolves.load(Ordering::SeqCst)
    }

    fn executions(&self) -> usize {
        self.executions.load(Ordering::SeqCst)
    }

    fn resolve(&self, key: &str) -> axum::response::Response {
        self.resolves.fetch_add(1, Ordering::SeqCst);
        if self.revoked.lock().unwrap().contains(key) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let Some((_, org, credential, owner, creator)) =
            SUBJECTS.iter().find(|(token, ..)| *token == key)
        else {
            return StatusCode::UNAUTHORIZED.into_response();
        };
        let standing = self
            .standings
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .unwrap_or_else(|| standing("active", "none"));
        let credential = json!({
            "id": credential,
            "nodeId": credential,
            "teamId": null,
            "ownerUserId": owner,
            "createdBy": creator,
            "purpose": "gateway_relay",
            "allowedOperations": [
                "gateway.inference",
                "gateway.web.search",
                "gateway.web.fetch"
            ]
        });
        if standing["refuses"] == "all" {
            return Json(json!({
                "managedTierUnavailable": true,
                "organization": { "id": org, "name": org, "slug": org },
                "credential": credential,
                "standing": standing
            }))
            .into_response();
        }
        Json(json!({
            "organization": { "id": org },
            "credential": credential,
            "managedInference": false,
            "standing": standing
        }))
        .into_response()
    }

    async fn serve(&self) -> (String, tokio::task::JoinHandle<()>) {
        let resolve_plane = self.clone();
        let call_plane = self.clone();
        let app = Router::new()
            .route(
                "/api/control-plane/gateway/resolve",
                get(move |headers: axum::http::HeaderMap| {
                    let plane = resolve_plane.clone();
                    async move {
                        let key = headers
                            .get("x-gateway-key")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default()
                            .to_owned();
                        plane.resolve(&key)
                    }
                }),
            )
            .route(
                "/api/mcp/tools/call",
                post(move || {
                    let plane = call_plane.clone();
                    async move {
                        let call = plane.executions.fetch_add(1, Ordering::SeqCst) + 1;
                        plane.execution_hooks.fire(call);
                        Json(json!({ "ok": true, "output": { "result": "plain tool output" } }))
                    }
                }),
            )
            .route(
                "/api/tools/search",
                get(|| async {
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
                get(|| async {
                    Json(json!({
                        "id": UNIFIED_TOOL,
                        "name": "search",
                        "description": "Search the web.",
                        "args": [{
                            "name": "query",
                            "type": "string",
                            "description": "Search terms",
                            "required": true
                        }]
                    }))
                }),
            )
            .fallback(|| async { Json(json!({})) });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}"), task)
    }
}

// ─── Provider ──────────────────────────────────────────────────────────────

/// Answers completions from `script` (assistant messages, then [`FINAL`]),
/// and streams from bodies the test queued (else a short default stream).
/// Hooks run when the provider is called, before it answers.
struct ProbeProvider {
    name: &'static str,
    script: Vec<Value>,
    fail_first: bool,
    calls: AtomicUsize,
    served: AtomicUsize,
    hooks: Hooks,
    feeds: Mutex<VecDeque<Body>>,
}

impl ProbeProvider {
    fn new(name: &'static str, script: Vec<Value>, fail_first: bool) -> Self {
        Self {
            name,
            script,
            fail_first,
            calls: AtomicUsize::new(0),
            served: AtomicUsize::new(0),
            hooks: Hooks::default(),
            feeds: Mutex::new(VecDeque::new()),
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    fn feed(&self, body: Body) {
        self.feeds.lock().unwrap().push_back(body);
    }

    /// Count the call and run its hook. `false` when this call should fail.
    fn enter(&self) -> bool {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        self.hooks.fire(call);
        !(self.fail_first && call == 1)
    }
}

fn outage() -> ryu_gw_providers::ProviderError {
    ryu_gw_providers::ProviderError::Provider("probe upstream outage".to_owned())
}

impl Provider for ProbeProvider {
    fn name(&self) -> &'static str {
        self.name
    }

    fn complete<'a>(&'a self, _model: &'a str, _body: &'a Value) -> ProviderFuture<'a, Value> {
        if !self.enter() {
            return Box::pin(async { Err(outage()) });
        }
        let served = self.served.fetch_add(1, Ordering::SeqCst);
        let message = self
            .script
            .get(served)
            .cloned()
            .unwrap_or_else(|| json!({ "role": "assistant", "content": FINAL }));
        let finish = if message.get("tool_calls").is_some() {
            "tool_calls"
        } else {
            "stop"
        };
        Box::pin(async move {
            Ok(json!({
                "id": format!("chatcmpl-probe-{served}"),
                "object": "chat.completion",
                "model": "fixture-model",
                "choices": [{ "index": 0, "message": message, "finish_reason": finish }],
                "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
            }))
        })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> ProviderFuture<'a, Body> {
        if !self.enter() {
            return Box::pin(async { Err(outage()) });
        }
        let fed = self.feeds.lock().unwrap().pop_front();
        Box::pin(async move {
            Ok(fed.unwrap_or_else(|| Body::from(format!("{}{}", chunk(FINAL, true), done()))))
        })
    }
}

fn chunk(text: &str, last: bool) -> String {
    let mut frame = json!({
        "id": "chatcmpl-probe-stream",
        "object": "chat.completion.chunk",
        "model": "fixture-model",
        "choices": [{
            "index": 0,
            "delta": { "role": "assistant", "content": text },
            "finish_reason": if last { Value::from("stop") } else { Value::Null }
        }]
    });
    if last {
        frame["usage"] = json!({ "prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5 });
    }
    format!("data: {frame}\n\n")
}

fn done() -> &'static str {
    "data: [DONE]\n\n"
}

type Feed = tokio::sync::mpsc::Sender<Result<bytes::Bytes, std::io::Error>>;

/// A provider body fed one window at a time by the test.
fn channel_body() -> (Feed, Body) {
    let (sender, receiver) = tokio::sync::mpsc::channel(8);
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|item| (item, receiver))
    });
    (sender, Body::from_stream(stream))
}

async fn send_window(feed: &Feed, text: String) {
    feed.send(Ok(bytes::Bytes::from(text))).await.unwrap();
}

// ─── Harness ───────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum Loop {
    Unified,
    Composio,
}

struct Options {
    custody: GatewayCustody,
    tools: Option<Loop>,
    cache: bool,
    dlp: bool,
    script: Vec<Value>,
    fail_primary_once: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            custody: GatewayCustody::SelfHosted,
            tools: None,
            cache: false,
            dlp: false,
            script: Vec::new(),
            fail_primary_once: false,
        }
    }
}

struct Harness {
    app: Router,
    state: Arc<AppState>,
    plane: Plane,
    primary: Arc<ProbeProvider>,
    fallback: Arc<ProbeProvider>,
    cell: StateCell,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Harness {
    fn cache(&self) -> &ResolveCache {
        self.state.resolve_cache.as_ref().unwrap()
    }

    fn provider_calls(&self) -> (usize, usize) {
        (self.primary.calls(), self.fallback.calls())
    }

    /// A hook that sets `token`'s standing and then applies `push`, the way
    /// a control-plane action lands mid-request.
    fn flip_and_push(&self, token: &'static str, value: Value, push: EnforcementPush) -> Hook {
        let plane = self.plane.clone();
        let cell = Arc::clone(&self.cell);
        Box::new(move || {
            plane.set(token, value);
            let state = cell.get().and_then(Weak::upgrade).expect("state is set");
            let outcome = state
                .resolve_cache
                .as_ref()
                .expect("resolve cache")
                .apply_enforcement_push(&push);
            assert!(outcome.applied, "the probe push must apply");
        })
    }
}

fn user_push(user: &str, version: u64) -> EnforcementPush {
    EnforcementPush {
        user_id: Some(user.to_owned()),
        version,
        ..Default::default()
    }
}

fn org_push(org: &str, version: u64) -> EnforcementPush {
    EnforcementPush {
        org_id: Some(org.to_owned()),
        version,
        ..Default::default()
    }
}

async fn harness(options: Options) -> Harness {
    let plane = Plane::default();
    let (base, server) = plane.serve().await;
    let mut config = GatewayConfig::default();
    config.auth.require_auth = true;
    config.auth.master_key = Some(MASTER.to_owned());
    config.cache.enabled = options.cache;
    if options.dlp {
        config.firewall.enabled = true;
        config.firewall.scan_inbound = true;
        config.firewall.scan_outbound = true;
        config.firewall.policy = FirewallPolicy::Block;
    } else {
        config.firewall.enabled = false;
    }
    config.routing.default_provider = ProviderId::from(PRIMARY);
    // A fallback is configured so a refusal that fell through to the
    // fallback chain shows up as a fallback call.
    config.routing.fallback_chain = vec![ProviderId::from(FALLBACK)];
    if options.tools == Some(Loop::Composio) {
        config.composio.enabled = true;
        config.composio.api_key = Some("composio-test-key".to_owned());
        config.composio.actions = vec![COMPOSIO_ACTION.to_owned()];
    }
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let mut state = AppState::new_for_test(
        config,
        audit,
        crate::evals::EvalsRunner::new(Default::default()),
    );
    state.custody = options.custody;
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    state.resolve_cache = Some(ResolveCache::for_test(base.clone(), http.clone()));
    state.enforcement_push_secret = Some(SECRET.to_owned());
    if options.tools.is_some() {
        state.tools = Some(crate::tools::ToolSearchClient::new(
            &CoreProviderConfig {
                base_url: base.clone(),
                token: None,
            },
            http.clone(),
        ));
    }
    if options.tools == Some(Loop::Composio) {
        // Unused: the legacy loop dispatches through Core when it is wired.
        state.composio = Some(crate::composio::ComposioClient::for_test(
            state.config.composio.clone(),
            http,
            "http://127.0.0.1:9/unused".to_owned(),
        ));
    }
    let primary = Arc::new(ProbeProvider::new(
        PRIMARY,
        options.script.clone(),
        options.fail_primary_once,
    ));
    let fallback = Arc::new(ProbeProvider::new(FALLBACK, options.script, false));
    state
        .provider_runtime
        .register_for_test(Arc::clone(&primary) as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(Arc::clone(&fallback) as Arc<dyn Provider>);
    let state = Arc::new(state);
    let cell: StateCell = Arc::new(OnceLock::new());
    cell.set(Arc::downgrade(&state)).unwrap();
    Harness {
        app: crate::api::router(Arc::clone(&state)),
        state,
        plane,
        primary,
        fallback,
        cell,
        server,
    }
}

fn peer() -> ConnectInfo<std::net::SocketAddr> {
    ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 40_000)))
}

#[derive(Clone, Copy)]
enum Credential {
    Bearer,
    XApiKey,
    XGoogApiKey,
}

fn request(
    method: Method,
    uri: &str,
    token: &str,
    credential: Credential,
    content_type: &str,
    body: Vec<u8>,
) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri).extension(peer());
    builder = match credential {
        Credential::Bearer => builder.header("authorization", format!("Bearer {token}")),
        Credential::XApiKey => builder.header("x-api-key", token),
        Credential::XGoogApiKey => builder.header("x-goog-api-key", token),
    };
    if !content_type.is_empty() {
        builder = builder.header("content-type", content_type);
    }
    builder.body(Body::from(body)).unwrap()
}

fn json_request(uri: &str, token: &str, body: &Value) -> Request<Body> {
    request(
        Method::POST,
        uri,
        token,
        Credential::Bearer,
        "application/json",
        body.to_string().into_bytes(),
    )
}

async fn send(app: &Router, request: Request<Body>) -> (StatusCode, String) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

fn chat_body(stream: bool) -> Value {
    json!({
        "model": "fixture-model",
        "stream": stream,
        "messages": [{ "role": "user", "content": "Hi" }]
    })
}

async fn push_http(app: &Router, body: Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/internal/enforcement/invalidate")
        .header("content-type", "application/json")
        .header(INTERNAL_SECRET_HEADER, SECRET)
        .extension(peer())
        .body(Body::from(body.to_string()))
        .unwrap();
    let (status, text) = send(app, request).await;
    (status, parse(&text))
}

/// Read the client stream until `needle` shows up (or 5 s pass).
async fn read_until(stream: &mut BodyDataStream, needle: &str) -> String {
    let mut text = String::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        while !text.contains(needle) {
            match stream.next().await {
                Some(Ok(bytes)) => text.push_str(&String::from_utf8_lossy(&bytes)),
                _ => break,
            }
        }
    })
    .await;
    text
}

/// Read the rest of the client stream (or what arrives within 5 s).
async fn read_rest(stream: &mut BodyDataStream) -> String {
    let mut text = String::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(Ok(bytes)) = stream.next().await {
            text.push_str(&String::from_utf8_lossy(&bytes));
        }
    })
    .await;
    text
}

// ─── At-auth refusal on every route ────────────────────────────────────────

struct RouteCase {
    name: &'static str,
    method: Method,
    uri: &'static str,
    credential: Credential,
    content_type: &'static str,
    body: Vec<u8>,
}

fn json_case(name: &'static str, uri: &'static str, body: Value) -> RouteCase {
    RouteCase {
        name,
        method: Method::POST,
        uri,
        credential: Credential::Bearer,
        content_type: "application/json",
        body: body.to_string().into_bytes(),
    }
}

fn multipart_body() -> Vec<u8> {
    let boundary = "probe-boundary";
    format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nfixture-stt\r\n\
         --{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\n\
         Content-Type: audio/wav\r\n\r\nRIFF\r\n--{boundary}--\r\n"
    )
    .into_bytes()
}

fn route_cases() -> Vec<RouteCase> {
    let anthropic = |stream: bool| {
        json!({
            "model": "fixture-model",
            "max_tokens": 16,
            "stream": stream,
            "messages": [{ "role": "user", "content": "Hi" }]
        })
    };
    let gemini = json!({ "contents": [{ "role": "user", "parts": [{ "text": "Hi" }] }] });
    let mut cases = vec![
        json_case("chat buffered", "/v1/chat/completions", chat_body(false)),
        json_case("chat stream", "/v1/chat/completions", chat_body(true)),
        json_case(
            "cursor alias",
            "/v1/cursor/chat/completions",
            chat_body(false),
        ),
        json_case(
            "agent alias",
            "/v1/agents/agent_probe/chat/completions",
            chat_body(true),
        ),
        json_case("anthropic stream", "/v1/messages", anthropic(true)),
        json_case(
            "gemini stream",
            "/v1beta/models/fixture-model:streamGenerateContent",
            gemini.clone(),
        ),
        json_case(
            "responses buffered",
            "/v1/responses",
            json!({ "model": "fixture-model", "input": "Hi" }),
        ),
        json_case(
            "responses stream",
            "/v1/responses",
            json!({ "model": "fixture-model", "input": "Hi", "stream": true }),
        ),
        json_case(
            "responses hosted web",
            "/v1/responses",
            json!({ "model": "fixture-model", "input": "Hi", "tools": [{ "type": "web_search" }] }),
        ),
        json_case(
            "embeddings",
            "/v1/embeddings",
            json!({ "model": "fixture-embed", "input": "Hi" }),
        ),
        json_case(
            "rerank",
            "/v1/rerank",
            json!({ "model": "fixture-rerank", "query": "q", "documents": ["a", "b"] }),
        ),
        json_case(
            "image generation",
            "/v1/images/generations",
            json!({ "model": "fixture-image", "prompt": "a lighthouse" }),
        ),
        json_case(
            "speech",
            "/v1/audio/speech",
            json!({ "model": "fixture-tts", "input": "Hi", "voice": "alloy" }),
        ),
        json_case(
            "video submit",
            "/v1/videos/generations",
            json!({ "model": "fixture-video", "prompt": "a lighthouse" }),
        ),
        json_case(
            "provider call",
            "/v1/providers/call",
            json!({ "provider": "composio", "toolId": "probe", "method": "GET", "requestId": "req_probe" }),
        ),
        json_case(
            "web search",
            "/v1/web/search",
            json!({ "query": "plain words" }),
        ),
        json_case(
            "web fetch",
            "/v1/web/fetch",
            json!({ "url": "https://example.com/" }),
        ),
    ];
    cases.push(RouteCase {
        name: "anthropic buffered (x-api-key)",
        credential: Credential::XApiKey,
        ..json_case("", "/v1/messages", anthropic(false))
    });
    cases.push(RouteCase {
        name: "gemini generate (x-goog-api-key)",
        credential: Credential::XGoogApiKey,
        ..json_case("", "/v1beta/models/fixture-model:generateContent", gemini)
    });
    cases.push(RouteCase {
        name: "transcription",
        method: Method::POST,
        uri: "/v1/audio/transcriptions",
        credential: Credential::Bearer,
        content_type: "multipart/form-data; boundary=probe-boundary",
        body: multipart_body(),
    });
    for (name, uri) in [
        ("video poll", "/v1/videos/generations/vid_probe_1"),
        ("models", "/v1/models"),
        ("modalities", "/v1/modalities"),
    ] {
        cases.push(RouteCase {
            name,
            method: Method::GET,
            uri,
            credential: Credential::Bearer,
            content_type: "",
            body: Vec::new(),
        });
    }
    cases
}

/// Send every route with `token` and collect each one that is not refused
/// with `code` (403 `policy_violation`, layer platform, the appeal link).
async fn refusals_missing(h: &Harness, token: &str, code: &str) -> Vec<String> {
    let mut misses = Vec::new();
    for case in route_cases() {
        let (status, text) = send(
            &h.app,
            request(
                case.method,
                case.uri,
                token,
                case.credential,
                case.content_type,
                case.body,
            ),
        )
        .await;
        let body = parse(&text);
        let error = &body["error"];
        let refused = status == StatusCode::FORBIDDEN
            && error["code"] == code
            && error["type"] == "policy_violation"
            && error["layer"] == "platform"
            && error["appeal_url"] == APPEAL;
        if !refused {
            misses.push(format!("{}: {status} {text}", case.name));
        }
    }
    misses
}

#[tokio::test]
async fn probe_a_banned_key_is_refused_on_every_route_before_any_provider_call() {
    let h = harness(Options::default()).await;
    h.plane.set(ALPHA, banned());
    let misses = refusals_missing(&h, ALPHA, "user_banned").await;
    assert!(
        misses.is_empty(),
        "routes not refused:\n{}",
        misses.join("\n")
    );
    assert_eq!(h.provider_calls(), (0, 0));
}

#[tokio::test]
async fn probe_a_suspended_key_is_refused_on_every_route() {
    let h = harness(Options::default()).await;
    h.plane.set(ALPHA, standing("key_suspended", "all"));
    let misses = refusals_missing(&h, ALPHA, "key_suspended_abuse").await;
    assert!(
        misses.is_empty(),
        "routes not refused:\n{}",
        misses.join("\n")
    );
    assert_eq!(h.provider_calls(), (0, 0));
}

#[tokio::test]
async fn probe_a_floor_bound_suspension_is_refused_on_every_fleet_route() {
    let h = harness(Options {
        custody: GatewayCustody::Fleet,
        ..Options::default()
    })
    .await;
    h.plane.set(ALPHA, standing("org_suspended", "floor_bound"));
    let misses = refusals_missing(&h, ALPHA, "org_suspended").await;
    assert!(
        misses.is_empty(),
        "routes not refused:\n{}",
        misses.join("\n")
    );
    assert_eq!(h.provider_calls(), (0, 0));
}

#[tokio::test]
async fn probe_control_a_key_in_good_standing_is_served_on_chat_and_compat_routes() {
    let h = harness(Options::default()).await;
    for (uri, body) in [
        ("/v1/chat/completions", chat_body(false)),
        ("/v1/chat/completions", chat_body(true)),
        (
            "/v1/messages",
            json!({ "model": "fixture-model", "max_tokens": 16, "stream": true,
                    "messages": [{ "role": "user", "content": "Hi" }] }),
        ),
        (
            "/v1/responses",
            json!({ "model": "fixture-model", "input": "Hi", "stream": true }),
        ),
    ] {
        let (status, text) = send(&h.app, json_request(uri, ALPHA, &body)).await;
        assert_eq!(status, StatusCode::OK, "{uri}: {text}");
        assert!(text.contains(FINAL), "{uri}: {text}");
    }
    let (status, text) = send(
        &h.app,
        json_request(
            "/v1beta/models/fixture-model:streamGenerateContent",
            ALPHA,
            &json!({ "contents": [{ "role": "user", "parts": [{ "text": "Hi" }] }] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert!(text.contains(FINAL), "{text}");
}

#[tokio::test]
async fn probe_control_a_floor_bound_suspension_serves_off_the_fleet() {
    let h = harness(Options::default()).await;
    h.plane.set(ALPHA, standing("org_suspended", "floor_bound"));
    let (status, text) = send(
        &h.app,
        json_request("/v1/chat/completions", ALPHA, &chat_body(false)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
}

// ─── Mid-stream refusal through every dialect ──────────────────────────────

#[derive(Clone, Copy, Debug)]
enum Dialect {
    Chat,
    Anthropic,
    Gemini,
    Responses,
}

impl Dialect {
    fn request(self, token: &str) -> Request<Body> {
        match self {
            Dialect::Chat => json_request("/v1/chat/completions", token, &chat_body(true)),
            Dialect::Anthropic => json_request(
                "/v1/messages",
                token,
                &json!({ "model": "fixture-model", "max_tokens": 16, "stream": true,
                         "messages": [{ "role": "user", "content": "Hi" }] }),
            ),
            Dialect::Gemini => json_request(
                "/v1beta/models/fixture-model:streamGenerateContent",
                token,
                &json!({ "contents": [{ "role": "user", "parts": [{ "text": "Hi" }] }] }),
            ),
            Dialect::Responses => json_request(
                "/v1/responses",
                token,
                &json!({ "model": "fixture-model", "input": "Hi", "stream": true }),
            ),
        }
    }
}

/// What the client saw before and after the push.
struct Cut {
    before: String,
    after: String,
}

/// Stream one window, let `between` run (it may push), stream a second
/// window and the end, and return what the client read on each side.
async fn stream_across<F, Fut>(h: &Harness, dialect: Dialect, token: &str, between: F) -> Cut
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = ()>,
{
    let (feed, body) = channel_body();
    h.primary.feed(body);
    let response = h.app.clone().oneshot(dialect.request(token)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK, "{dialect:?} opens");
    let mut client = response.into_body().into_data_stream();
    // Stream DLP releases a frame only once a few hundred bytes of later
    // text follow it, so the marker frame is followed by a plain padding frame.
    send_window(&feed, chunk(FIRST, false)).await;
    send_window(&feed, chunk(&" plain words".repeat(64), false)).await;
    let before = read_until(&mut client, FIRST).await;
    assert!(
        before.contains(FIRST),
        "{dialect:?}: the first window must reach the client: {before}"
    );
    between().await;
    // The feed may already be closed when the stream was cut.
    let _ = feed.send(Ok(bytes::Bytes::from(chunk(SECOND, true)))).await;
    let _ = feed.send(Ok(bytes::Bytes::from(done()))).await;
    drop(feed);
    let after = read_rest(&mut client).await;
    Cut { before, after }
}

/// A ban pushed mid-stream must end the client's stream with the 00.7 code
/// and appeal link in that dialect, and withhold the next window.
async fn assert_cut_mid_stream(dialect: Dialect) {
    let h = harness(Options::default()).await;
    let hr = &h;
    let cut = stream_across(&h, dialect, ALPHA, move || async move {
        hr.plane.set(ALPHA, banned());
        let (status, body) = push_http(
            &hr.app,
            json!({ "userId": "usr_alpha", "enforcementVersion": 1 }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["applied"], true, "{body}");
    })
    .await;
    assert!(
        !cut.after.contains(SECOND),
        "{dialect:?}: the window after the ban must be withheld: {}",
        cut.after
    );
    assert!(
        cut.after.contains("user_banned") && cut.after.contains(APPEAL),
        "{dialect:?}: the client must see the user_banned code and appeal link, got: {}",
        cut.after
    );
}

#[tokio::test]
async fn probe_chat_stream_is_cut_with_the_code_at_the_next_window() {
    assert_cut_mid_stream(Dialect::Chat).await;
}

#[tokio::test]
async fn probe_anthropic_stream_is_cut_with_the_code_at_the_next_window() {
    assert_cut_mid_stream(Dialect::Anthropic).await;
}

#[tokio::test]
async fn probe_anthropic_stream_cut_never_reports_a_clean_end_turn() {
    let h = harness(Options::default()).await;
    let hr = &h;
    let cut = stream_across(&h, Dialect::Anthropic, ALPHA, move || async move {
        hr.plane.set(ALPHA, banned());
        push_http(
            &hr.app,
            json!({ "userId": "usr_alpha", "enforcementVersion": 1 }),
        )
        .await;
    })
    .await;
    assert!(
        !cut.after.contains("\"end_turn\""),
        "a refused stream must not finish as a normal end_turn: {}",
        cut.after
    );
}

#[tokio::test]
async fn probe_gemini_stream_is_cut_with_the_code_at_the_next_window() {
    assert_cut_mid_stream(Dialect::Gemini).await;
}

#[tokio::test]
async fn probe_responses_stream_is_cut_with_the_code_at_the_next_window() {
    assert_cut_mid_stream(Dialect::Responses).await;
}

#[tokio::test]
async fn probe_control_every_dialect_streams_both_windows_without_a_push() {
    for dialect in [
        Dialect::Chat,
        Dialect::Anthropic,
        Dialect::Gemini,
        Dialect::Responses,
    ] {
        let h = harness(Options::default()).await;
        let cut = stream_across(&h, dialect, ALPHA, || async {}).await;
        assert!(cut.before.contains(FIRST), "{dialect:?}");
        assert!(cut.after.contains(SECOND), "{dialect:?}: {}", cut.after);
        assert!(!cut.after.contains("user_banned"), "{dialect:?}");
        // One resolve at auth; the guard never re-resolved.
        assert_eq!(h.plane.resolves(), 1, "{dialect:?}");
    }
}

#[tokio::test]
async fn probe_chat_stream_with_outbound_dlp_is_still_cut_with_the_code() {
    let h = harness(Options {
        dlp: true,
        ..Options::default()
    })
    .await;
    let hr = &h;
    let cut = stream_across(&h, Dialect::Chat, ALPHA, move || async move {
        hr.plane.set(ALPHA, banned());
        hr.cache()
            .apply_enforcement_push(&user_push("usr_alpha", 1));
    })
    .await;
    assert!(!cut.after.contains(SECOND), "{}", cut.after);
    assert!(
        cut.after.contains("user_banned") && cut.after.contains(APPEAL),
        "{}",
        cut.after
    );
}

#[tokio::test]
async fn probe_fleet_floor_bound_suspension_cuts_a_stream_and_self_hosted_does_not() {
    for (custody, cut_expected) in [
        (GatewayCustody::Fleet, true),
        (GatewayCustody::SelfHosted, false),
    ] {
        let h = harness(Options {
            custody,
            ..Options::default()
        })
        .await;
        let hr = &h;
        let cut = stream_across(&h, Dialect::Chat, ALPHA, move || async move {
            hr.plane
                .set(ALPHA, standing("org_suspended", "floor_bound"));
            hr.cache().apply_enforcement_push(&org_push("org_alpha", 1));
        })
        .await;
        assert_eq!(
            cut.after.contains("org_suspended"),
            cut_expected,
            "{custody:?}: {}",
            cut.after
        );
        assert_eq!(!cut.after.contains(SECOND), cut_expected, "{custody:?}");
    }
}

#[tokio::test]
async fn probe_mid_stream_recheck_outcomes_per_push_shape() {
    // (token, what the control plane answers next, the push, expected code
    // in the cut frame or None when the stream must run to the end)
    enum Next {
        Standing(Value),
        Revoked,
    }
    let cases: Vec<(&str, &'static str, Next, EnforcementPush, Option<&str>)> = vec![
        (
            "unreadable standing",
            ALPHA,
            Next::Standing(json!({ "state": "standing_unavailable", "refuses": "all" })),
            org_push("org_alpha", 1),
            Some("standing_unavailable"),
        ),
        (
            "revoked token",
            ALPHA,
            Next::Revoked,
            org_push("org_alpha", 1),
            Some("invalid_api_key"),
        ),
        (
            "credential push",
            ALPHA,
            Next::Standing(standing("key_suspended", "all")),
            EnforcementPush {
                credential_id: Some("cred_alpha".to_owned()),
                version: 1,
                ..Default::default()
            },
            Some("key_suspended_abuse"),
        ),
        (
            "creator push on an ownerless key",
            ALPHA_TWO,
            Next::Standing(banned()),
            user_push("usr_maker", 1),
            Some("user_banned"),
        ),
        (
            "restricted",
            ALPHA,
            Next::Standing(standing("restricted", "none")),
            org_push("org_alpha", 1),
            None,
        ),
        (
            "push for another org",
            ALPHA,
            Next::Standing(banned()),
            org_push("org_beta", 1),
            None,
        ),
    ];
    for (name, token, next, push, expected) in cases {
        let h = harness(Options::default()).await;
        let hr = &h;
        let cut = stream_across(&h, Dialect::Chat, token, move || async move {
            match next {
                Next::Standing(value) => hr.plane.set(token, value),
                Next::Revoked => hr.plane.revoke(token),
            }
            hr.cache().apply_enforcement_push(&push);
        })
        .await;
        match expected {
            Some(code) => {
                assert!(cut.after.contains(code), "{name}: {}", cut.after);
                assert!(!cut.after.contains(SECOND), "{name}: {}", cut.after);
            }
            None => {
                assert!(cut.after.contains(SECOND), "{name}: {}", cut.after);
                assert!(!cut.after.contains("\"error\""), "{name}: {}", cut.after);
            }
        }
    }
}

// ─── Fallback ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn probe_a_ban_pushed_during_a_failed_attempt_stops_the_buffered_fallback() {
    let h = harness(Options {
        fail_primary_once: true,
        ..Options::default()
    })
    .await;
    h.primary.hooks.at(
        1,
        h.flip_and_push(ALPHA, banned(), user_push("usr_alpha", 1)),
    );
    let (status, text) = send(
        &h.app,
        json_request("/v1/chat/completions", ALPHA, &chat_body(false)),
    )
    .await;
    assert_eq!(
        h.fallback.calls(),
        0,
        "the fallback attempt dispatched after the ban was pushed: {status} {text}"
    );
    assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
}

#[tokio::test]
async fn probe_a_ban_pushed_during_a_failed_stream_attempt_withholds_the_fallback_output() {
    let h = harness(Options {
        fail_primary_once: true,
        ..Options::default()
    })
    .await;
    h.primary.hooks.at(
        1,
        h.flip_and_push(ALPHA, banned(), user_push("usr_alpha", 1)),
    );
    let (status, text) = send(
        &h.app,
        json_request("/v1/chat/completions", ALPHA, &chat_body(true)),
    )
    .await;
    assert!(!text.contains(FINAL), "{status}: {text}");
    assert!(text.contains("user_banned"), "{status}: {text}");
}

#[tokio::test]
async fn probe_control_a_failed_attempt_falls_back_without_a_push() {
    let h = harness(Options {
        fail_primary_once: true,
        ..Options::default()
    })
    .await;
    let (status, text) = send(
        &h.app,
        json_request("/v1/chat/completions", ALPHA, &chat_body(false)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(h.provider_calls(), (1, 1));
}

#[test]
fn probe_standing_errors_never_count_as_provider_health_faults() {
    let refused = super::PlatformStanding::from_wire(Some(&banned()))
        .refusal(GatewayCustody::SelfHosted)
        .unwrap();
    for error in [refused, GatewayError::StandingUnavailable] {
        assert!(error.is_safety_outcome(), "{error:?}");
        assert!(error.ends_hosted_attempt(), "{error:?}");
    }
}

// ─── Tool loops ────────────────────────────────────────────────────────────

fn tool_turn(kind: Loop) -> Value {
    let name = match kind {
        Loop::Unified => crate::tools::catalog_client::model_tool_name(UNIFIED_TOOL),
        Loop::Composio => COMPOSIO_ACTION.to_owned(),
    };
    json!({
        "role": "assistant",
        "content": null,
        "tool_calls": [{
            "id": "call_1",
            "type": "function",
            "function": { "name": name, "arguments": "{\"query\":\"plain words\"}" }
        }]
    })
}

fn tool_request(kind: Loop, stream: bool) -> Request<Body> {
    let mut request = json_request("/v1/chat/completions", ALPHA, &chat_body(stream));
    if kind == Loop::Unified {
        request
            .headers_mut()
            .insert("x-ryu-tools", UNIFIED_TOOL.parse().unwrap());
    }
    request
}

async fn tool_harness(kind: Loop, fail_primary_once: bool) -> Harness {
    harness(Options {
        tools: Some(kind),
        script: vec![tool_turn(kind)],
        fail_primary_once,
        ..Options::default()
    })
    .await
}

#[tokio::test]
async fn probe_control_tool_loops_run_two_rounds_without_a_push() {
    // The legacy Composio loop is buffered only: a streamed request
    // never enters it, so it has no streamed variant.
    for (kind, stream) in [
        (Loop::Unified, false),
        (Loop::Unified, true),
        (Loop::Composio, false),
    ] {
        let h = tool_harness(kind, false).await;
        let (status, text) = send(&h.app, tool_request(kind, stream)).await;
        let label = format!("unified={} stream={stream}", kind == Loop::Unified);
        assert_eq!(status, StatusCode::OK, "{label}: {text}");
        assert!(text.contains(FINAL), "{label}: {text}");
        assert_eq!(h.plane.executions(), 1, "{label}");
        assert_eq!(h.provider_calls(), (2, 0), "{label}");
    }
}

#[tokio::test]
async fn probe_a_ban_pushed_during_a_tool_run_stops_the_next_round() {
    // The legacy Composio loop is buffered only: a streamed request
    // never enters it, so it has no streamed variant.
    for (kind, stream) in [
        (Loop::Unified, false),
        (Loop::Unified, true),
        (Loop::Composio, false),
    ] {
        let h = tool_harness(kind, false).await;
        h.plane.execution_hooks.at(
            1,
            h.flip_and_push(ALPHA, banned(), user_push("usr_alpha", 1)),
        );
        let (status, text) = send(&h.app, tool_request(kind, stream)).await;
        let label = format!("unified={} stream={stream}", kind == Loop::Unified);
        assert_eq!(status, StatusCode::FORBIDDEN, "{label}: {text}");
        assert_eq!(parse(&text)["error"]["code"], "user_banned", "{label}");
        assert_eq!(parse(&text)["error"]["appeal_url"], APPEAL, "{label}");
        assert_eq!(h.plane.executions(), 1, "{label}");
        assert_eq!(
            h.provider_calls(),
            (1, 0),
            "{label}: no next round, no fallback"
        );
    }
}

#[tokio::test]
async fn probe_a_ban_pushed_during_the_first_completion_stops_the_tools() {
    // The legacy Composio loop is buffered only: a streamed request
    // never enters it, so it has no streamed variant.
    for (kind, stream) in [
        (Loop::Unified, false),
        (Loop::Unified, true),
        (Loop::Composio, false),
    ] {
        let h = tool_harness(kind, false).await;
        h.primary.hooks.at(
            1,
            h.flip_and_push(ALPHA, banned(), user_push("usr_alpha", 1)),
        );
        let (status, text) = send(&h.app, tool_request(kind, stream)).await;
        let label = format!("unified={} stream={stream}", kind == Loop::Unified);
        assert_eq!(status, StatusCode::FORBIDDEN, "{label}: {text}");
        assert_eq!(parse(&text)["error"]["code"], "user_banned", "{label}");
        assert_eq!(h.plane.executions(), 0, "{label}: no tool ran");
        assert_eq!(h.provider_calls(), (1, 0), "{label}");
    }
}

#[tokio::test]
async fn probe_a_ban_pushed_during_a_fallback_tool_loop_stops_it() {
    for kind in [Loop::Unified, Loop::Composio] {
        let h = tool_harness(kind, true).await;
        h.plane.execution_hooks.at(
            1,
            h.flip_and_push(ALPHA, banned(), user_push("usr_alpha", 1)),
        );
        let (status, text) = send(&h.app, tool_request(kind, false)).await;
        let label = format!("unified={}", kind == Loop::Unified);
        assert_eq!(status, StatusCode::FORBIDDEN, "{label}: {text}");
        assert_eq!(parse(&text)["error"]["code"], "user_banned", "{label}");
        // The primary failed once; the fallback ran one round, then stopped.
        assert_eq!(h.provider_calls(), (1, 1), "{label}");
    }
}

// ─── Hosted Responses web loop ─────────────────────────────────────────────

fn hosted_search_turn() -> Value {
    json!({
        "role": "assistant",
        "content": null,
        "tool_calls": [{
            "id": "web_call",
            "type": "function",
            "function": {
                "name": "ryu_responses_web_search",
                "arguments": "{\"query\":\"plain words\"}"
            }
        }]
    })
}

fn hosted_request() -> Request<Body> {
    json_request(
        "/v1/responses",
        ALPHA,
        &json!({
            "model": "fixture-model",
            "input": "Hi",
            "tools": [{ "type": "web_search" }],
            "max_tool_calls": 0
        }),
    )
}

#[tokio::test]
async fn probe_control_the_hosted_responses_loop_runs_two_model_rounds() {
    let h = harness(Options {
        script: vec![hosted_search_turn()],
        ..Options::default()
    })
    .await;
    let (status, text) = send(&h.app, hosted_request()).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert!(text.contains(FINAL), "{text}");
    assert_eq!(h.provider_calls(), (2, 0));
}

#[tokio::test]
async fn probe_a_ban_pushed_during_a_hosted_responses_round_stops_the_next_round() {
    let h = harness(Options {
        script: vec![hosted_search_turn()],
        ..Options::default()
    })
    .await;
    h.primary.hooks.at(
        1,
        h.flip_and_push(ALPHA, banned(), user_push("usr_alpha", 1)),
    );
    let (status, text) = send(&h.app, hosted_request()).await;
    assert_eq!(
        h.provider_calls(),
        (1, 0),
        "the next hosted round dispatched after the ban: {status} {text}"
    );
    assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
    assert_eq!(parse(&text)["error"]["code"], "user_banned");
}

// ─── Caches ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn probe_a_response_cache_hit_never_serves_a_banned_key() {
    let h = harness(Options {
        cache: true,
        ..Options::default()
    })
    .await;
    let (status, text) = send(
        &h.app,
        json_request("/v1/chat/completions", ALPHA, &chat_body(false)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    // Same body again: served from the response cache, no second call.
    let (status, _) = send(
        &h.app,
        json_request("/v1/chat/completions", ALPHA, &chat_body(false)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let calls = h.provider_calls();
    h.plane.set(ALPHA, banned());
    h.cache().apply_enforcement_push(&user_push("usr_alpha", 1));
    let (status, text) = send(
        &h.app,
        json_request("/v1/chat/completions", ALPHA, &chat_body(false)),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
    assert_eq!(parse(&text)["error"]["code"], "user_banned");
    assert_eq!(h.provider_calls(), calls);
}

#[tokio::test]
async fn probe_an_org_push_drops_the_inference_and_web_entries_of_a_token() {
    let h = harness(Options::default()).await;
    for credential_use in [
        CredentialUse::GatewayRelay,
        CredentialUse::GatewayWebSearch,
        CredentialUse::GatewayWebFetch,
    ] {
        h.cache()
            .resolve_cached_for(ALPHA, credential_use)
            .await
            .unwrap();
    }
    assert_eq!(h.plane.resolves(), 3);
    let outcome = h.cache().apply_enforcement_push(&org_push("org_alpha", 1));
    assert_eq!(outcome.dropped, 3);
    h.plane.set(ALPHA, banned());
    let (status, text) = send(
        &h.app,
        json_request("/v1/web/search", ALPHA, &json!({ "query": "plain words" })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
    assert_eq!(parse(&text)["error"]["code"], "user_banned");
}

#[tokio::test]
async fn probe_a_lift_push_serves_the_very_next_request() {
    let h = harness(Options::default()).await;
    h.plane.set(ALPHA, banned());
    let (status, _) = send(
        &h.app,
        json_request("/v1/chat/completions", ALPHA, &chat_body(false)),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // The refusal is cached; a lift push must not wait out its TTL.
    h.plane.set(ALPHA, standing("active", "none"));
    let (status, body) = push_http(
        &h.app,
        json!({ "userId": "usr_alpha", "enforcementVersion": 2 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["dropped"], 1, "{body}");
    let (status, text) = send(
        &h.app,
        json_request("/v1/chat/completions", ALPHA, &chat_body(false)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
}

#[tokio::test]
async fn probe_a_cached_refusal_of_one_key_does_not_refuse_its_org_sibling() {
    let h = harness(Options::default()).await;
    h.plane.set(ALPHA, standing("key_suspended", "all"));
    let (status, _) = send(
        &h.app,
        json_request("/v1/chat/completions", ALPHA, &chat_body(false)),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, text) = send(
        &h.app,
        json_request("/v1/chat/completions", ALPHA_TWO, &chat_body(false)),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
}

// ─── Push endpoint ─────────────────────────────────────────────────────────

#[tokio::test]
async fn probe_an_oversized_push_is_refused_and_applies_nothing() {
    let h = harness(Options::default()).await;
    let padding = "x".repeat(MAX_PUSH_BYTES);
    let (status, _) = push_http(
        &h.app,
        json!({ "orgId": "org_alpha", "enforcementVersion": 3, "note": padding }),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(h.cache().enforcement_ledger().latest(), 0);
}

#[tokio::test]
async fn probe_a_master_bearer_is_not_the_push_credential() {
    let h = harness(Options::default()).await;
    let request = Request::builder()
        .method(Method::POST)
        .uri("/internal/enforcement/invalidate")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {MASTER}"))
        .extension(peer())
        .body(Body::from(
            json!({ "orgId": "org_alpha", "enforcementVersion": 3 }).to_string(),
        ))
        .unwrap();
    let (status, _) = send(&h.app, request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(h.cache().enforcement_ledger().latest(), 0);
}

#[tokio::test]
async fn probe_a_credential_push_over_http_refuses_the_next_request() {
    let h = harness(Options::default()).await;
    let (status, _) = send(
        &h.app,
        json_request("/v1/chat/completions", ALPHA, &chat_body(false)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    h.plane.set(ALPHA, standing("key_suspended", "all"));
    let (status, body) = push_http(
        &h.app,
        json!({ "credentialId": "cred_alpha", "enforcementVersion": 4 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["appliedEnforcementVersion"], 4);
    let (status, text) = send(
        &h.app,
        json_request("/v1/chat/completions", ALPHA, &chat_body(false)),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
    assert_eq!(parse(&text)["error"]["code"], "key_suspended_abuse");
    // The org sibling was not named and stays served.
    let (status, _) = send(
        &h.app,
        json_request("/v1/chat/completions", ALPHA_TWO, &chat_body(false)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}
