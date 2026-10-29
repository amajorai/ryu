//! Route probes for ladder L2 (Throttle), L3 (Restrict) and the new-key
//! limit (spec 04.8.1). Each probe drives the whole router with an `rgw_` key
//! that resolves through a local control-plane mock, on `Fleet` custody with
//! a qualified hazard screener (the deterministic `TestBackend`), so the
//! chat, stream, compat, media and provider-call paths run as deployed.
//!
//! Content is plain words and the spec 00.9 sentinels only. Every refused
//! shape has a twin that is served (another key, another custody, or the
//! same key before its level changed), so a refusal cannot just mean the
//! harness is broken, and every refusal is checked to have made no upstream
//! call.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use ryu_gw_screening::backends::test::{TestBackend, SENTINEL_HAZARD_S1};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::config::{GatewayConfig, ProviderId, ScreeningBackendKind};
use crate::custody::GatewayCustody;
use crate::platform_floor::{FloorStore, PlatformFloor};
use crate::policy::ResolveCache;
use crate::providers::Provider;
use crate::screening::ScreeningRuntime;
use crate::state::AppState;
use ryu_gw_screening::ScreenerBackend;

const MASTER: &str = "ladder-probe-master";
const SECRET: &str = "ladder-probe-push-secret";
const FIXTURE: &str = "ladder-probe-upstream";
const APPEAL: &str = "https://ryu.example/appeal";
/// The one model on the floor's restricted list.
const LISTED: &str = "fixture-model";
/// A model the restricted list does not name.
const UNLISTED: &str = "other-model";
const ZEROS: &str = "0000000000000000";
const FIRST: &str = "first-window-text";

/// The probe keys: token, org, credential id.
const ALPHA: &str = "rgw_ladder_alpha_0001";
const BETA: &str = "rgw_ladder_beta_0001";
const KEYS: &[(&str, &str, &str)] = &[
    (ALPHA, "org_alpha", "cred_alpha"),
    (BETA, "org_beta", "cred_beta"),
];

type ProviderFuture<'a, T> = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<T, ryu_gw_providers::ProviderError>> + Send + 'a>,
>;

// ─── Control plane ─────────────────────────────────────────────────────────

/// Answers `/gateway/resolve` with the standing, `createdAt` and
/// `activeGateways` the test last set for each token.
#[derive(Clone, Default)]
struct Plane {
    standings: Arc<Mutex<HashMap<String, Value>>>,
    created_at: Arc<Mutex<HashMap<String, String>>>,
    active_gateways: Arc<Mutex<Option<u64>>>,
}

impl Plane {
    fn set(&self, token: &str, standing: Value) {
        self.standings
            .lock()
            .unwrap()
            .insert(token.to_owned(), standing);
    }

    fn set_created(&self, token: &str, at: chrono::DateTime<chrono::Utc>) {
        self.created_at
            .lock()
            .unwrap()
            .insert(token.to_owned(), at.to_rfc3339());
    }

    fn resolve(&self, key: &str) -> axum::response::Response {
        let Some((_, org, credential)) = KEYS.iter().find(|(token, ..)| *token == key) else {
            return StatusCode::UNAUTHORIZED.into_response();
        };
        let standing = self
            .standings
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .unwrap_or_else(|| ladder(json!([])));
        let mut credential = json!({
            "id": credential,
            "nodeId": credential,
            "purpose": "gateway_relay",
            "allowedOperations": [
                "gateway.inference",
                "gateway.web.search",
                "gateway.web.fetch"
            ]
        });
        if let Some(at) = self.created_at.lock().unwrap().get(key) {
            credential["createdAt"] = json!(at);
        }
        let mut body = json!({
            "organization": { "id": org },
            "credential": credential,
            "managedInference": false,
            "standing": standing,
        });
        if let Some(active) = *self.active_gateways.lock().unwrap() {
            body["activeGateways"] = json!(active);
        }
        Json(body).into_response()
    }

    async fn serve(&self) -> (String, tokio::task::JoinHandle<()>) {
        let plane = self.clone();
        let app = Router::new()
            .route(
                "/api/control-plane/gateway/resolve",
                get(move |headers: HeaderMap| {
                    let plane = plane.clone();
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
            .fallback(|| async { Json(json!({})) });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}"), task)
    }
}

/// An active standing with `ladder`.
fn ladder(ladder: Value) -> Value {
    json!({
        "state": "active",
        "refuses": "none",
        "reasonClass": null,
        "until": null,
        "appealUrl": APPEAL,
        "enforcementVersion": 0,
        "ladder": ladder,
    })
}

fn credential_level(level: u8, rpm: u64, concurrency: u32) -> Value {
    ladder(json!([{
        "scope": "credential",
        "level": level,
        "rpm": rpm,
        "concurrency": concurrency,
        "reasonClass": "velocity",
    }]))
}

// ─── Upstream ──────────────────────────────────────────────────────────────

/// Counts every call; answers `reply`, buffered or streamed, or streams a
/// body the test queued.
struct Upstream {
    name: &'static str,
    calls: Arc<AtomicUsize>,
    reply: String,
    feeds: Mutex<VecDeque<Body>>,
}

impl Provider for Upstream {
    fn name(&self) -> &'static str {
        self.name
    }

    fn complete<'a>(&'a self, _model: &'a str, _body: &'a Value) -> ProviderFuture<'a, Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let reply = self.reply.clone();
        Box::pin(async move {
            Ok(json!({
                "id": "chatcmpl-ladder",
                "object": "chat.completion",
                "model": LISTED,
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": reply },
                    "finish_reason": "stop"
                }],
                "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
            }))
        })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> ProviderFuture<'a, Body> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let fed = self.feeds.lock().unwrap().pop_front();
        let reply = self.reply.clone();
        Box::pin(async move {
            Ok(fed.unwrap_or_else(|| Body::from(format!("{}{}", chunk(&reply, true), DONE))))
        })
    }
}

const DONE: &str = "data: [DONE]\n\n";

fn chunk(text: &str, last: bool) -> String {
    let mut frame = json!({
        "id": "chatcmpl-ladder-stream",
        "object": "chat.completion.chunk",
        "model": LISTED,
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

type Feed = tokio::sync::mpsc::Sender<Result<bytes::Bytes, std::io::Error>>;

fn channel_body() -> (Feed, Body) {
    let (sender, receiver) = tokio::sync::mpsc::channel(8);
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|item| (item, receiver))
    });
    (sender, Body::from_stream(stream))
}

// ─── Harness ───────────────────────────────────────────────────────────────

struct Options {
    custody: GatewayCustody,
    /// Whether the floor qualifies the screener (false: degraded mode).
    qualified: bool,
    reply: &'static str,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            custody: GatewayCustody::Fleet,
            qualified: true,
            reply: "plain answer text",
        }
    }
}

struct Harness {
    app: Router,
    state: Arc<AppState>,
    plane: Plane,
    upstream: Arc<Upstream>,
    calls: Arc<AtomicUsize>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Harness {
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

fn floor(qualified: bool) -> Arc<PlatformFloor> {
    let mut screener = json!({
        "templateVersion": 1,
        "roles": {
            "textHazard": ["decision_local"],
            "promptAttack": ["decision_local"],
            "output": ["decision_local"],
        },
    });
    if qualified {
        screener["qualifications"] = json!([{
            "backendId": "decision_local",
            "model": "test-model",
            "weightsSha256": ZEROS,
            "templateVersion": 1,
            "codes": ["hazard.S4", "hazard.S9"],
            "evalRef": "eval_test_sentinels",
        }]);
    }
    PlatformFloor::from_wire(
        Some(&json!({
            "version": 7,
            "contentHash": "ladder-probe",
            "overlay": { "enabled": true, "scan_inbound": true, "policy": "block" },
            "screener": screener,
            // An upstream-chosen route stays refused even when listed.
            "restrictedModels": [LISTED, "openrouter/auto"],
        })),
        false,
    )
    .expect("probe floor parses")
}

async fn harness(options: Options) -> Harness {
    let plane = Plane::default();
    let (base, server) = plane.serve().await;
    let mut config = GatewayConfig::default();
    config.auth.require_auth = true;
    config.auth.master_key = Some(MASTER.to_owned());
    config.cache.enabled = false;
    config.firewall.enabled = false;
    // The gateway's own per-key limits are not under test.
    config.rate_limit.enabled = false;
    config.routing.default_provider = ProviderId::from(FIXTURE);
    config.routing.fallback_chain = vec![];
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
    let backend = Arc::new(TestBackend::new("decision_local"));
    state.screening = Arc::new(ScreeningRuntime::with_backends(
        &Default::default(),
        vec![(
            backend as Arc<dyn ScreenerBackend>,
            ScreeningBackendKind::DecisionLocal,
            None,
        )],
    ));
    state.platform_floor = FloorStore::with(floor(options.qualified));
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    state.resolve_cache = Some(ResolveCache::for_test(base, http));
    state.enforcement_push_secret = Some(SECRET.to_owned());
    let calls = Arc::new(AtomicUsize::new(0));
    let upstream = Arc::new(Upstream {
        name: FIXTURE,
        calls: Arc::clone(&calls),
        reply: options.reply.to_owned(),
        feeds: Mutex::new(VecDeque::new()),
    });
    state
        .provider_runtime
        .register_for_test(Arc::clone(&upstream) as Arc<dyn Provider>);
    // The Ryu Router slot, so `openrouter/auto` routes as it does deployed.
    state.provider_runtime.register_for_test(Arc::new(Upstream {
        name: "openrouter",
        calls: Arc::clone(&calls),
        reply: options.reply.to_owned(),
        feeds: Mutex::new(VecDeque::new()),
    }));
    let state = Arc::new(state);
    Harness {
        app: crate::api::router(Arc::clone(&state)),
        state,
        plane,
        upstream,
        calls,
        server,
    }
}

fn peer() -> ConnectInfo<std::net::SocketAddr> {
    ConnectInfo(std::net::SocketAddr::from(([127, 0, 0, 1], 40_000)))
}

fn post(uri: &str, token: &str, body: &Value) -> Request<Body> {
    let builder = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .extension(peer())
        .header("content-type", "application/json");
    let builder = if uri.starts_with("/v1beta/") {
        builder.header("x-goog-api-key", token)
    } else {
        builder.header("authorization", format!("Bearer {token}"))
    };
    builder.body(Body::from(body.to_string())).unwrap()
}

struct Answer {
    status: StatusCode,
    retry_after: Option<String>,
    text: String,
}

impl Answer {
    fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or(Value::Null)
    }

    fn code(&self) -> String {
        self.json()["error"]["code"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }
}

async fn send(app: &Router, request: Request<Body>) -> Answer {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let retry_after = response
        .headers()
        .get(axum::http::header::RETRY_AFTER)
        .map(|value| value.to_str().unwrap().to_owned());
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    Answer {
        status,
        retry_after,
        text: String::from_utf8_lossy(&bytes).into_owned(),
    }
}

fn chat(model: &str, text: &str, stream: bool) -> Value {
    json!({
        "model": model,
        "stream": stream,
        "messages": [{ "role": "user", "content": text }]
    })
}

/// Every inference route a fleet tenant reaches, with a plain body.
fn inference_routes() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        ("chat", "/v1/chat/completions", chat(LISTED, "Hi", false)),
        (
            "chat stream",
            "/v1/chat/completions",
            chat(LISTED, "Hi", true),
        ),
        (
            "anthropic messages",
            "/v1/messages",
            json!({ "model": LISTED, "max_tokens": 16, "stream": true,
                    "messages": [{ "role": "user", "content": "Hi" }] }),
        ),
        (
            "gemini",
            "/v1beta/models/fixture-model:generateContent",
            json!({ "contents": [{ "role": "user", "parts": [{ "text": "Hi" }] }] }),
        ),
        (
            "responses",
            "/v1/responses",
            json!({ "model": LISTED, "input": "Hi" }),
        ),
    ]
}

/// The media generation routes.
fn media_routes() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "image",
            "/v1/images/generations",
            json!({ "model": "image-model", "prompt": "a plain red square" }),
        ),
        (
            "speech",
            "/v1/audio/speech",
            json!({ "model": "speech-model", "input": "plain words", "voice": "alloy" }),
        ),
        (
            "video",
            "/v1/videos/generations",
            json!({ "model": "video-model", "prompt": "a plain red square" }),
        ),
    ]
}

fn assert_appeal(answer: &Answer, code: &str, status: StatusCode, what: &str) {
    assert_eq!(answer.status, status, "{what}: {}", answer.text);
    assert_eq!(answer.code(), code, "{what}: {}", answer.text);
    let error = &answer.json()["error"];
    assert_eq!(error["layer"], "platform", "{what}");
    assert_eq!(error["remedy"], "appeal", "{what}");
    assert_eq!(error["appeal_url"], APPEAL, "{what}");
}

// ─── Throttle (L2) ─────────────────────────────────────────────────────────

#[tokio::test]
async fn probe_throttle_refuses_past_the_rate_on_every_route() {
    let h = harness(Options::default()).await;
    h.plane.set(ALPHA, credential_level(2, 1, 50));
    let first = send(
        &h.app,
        post("/v1/chat/completions", ALPHA, &chat(LISTED, "Hi", false)),
    )
    .await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.text);
    assert_eq!(h.calls(), 1);
    let mut routes = inference_routes();
    routes.extend(media_routes());
    routes.push((
        "embeddings",
        "/v1/embeddings",
        json!({ "model": "embed-model", "input": "plain words" }),
    ));
    routes.push((
        "web search",
        "/v1/web/search",
        json!({ "query": "plain words" }),
    ));
    for (what, uri, body) in routes {
        let answer = send(&h.app, post(uri, ALPHA, &body)).await;
        assert_appeal(
            &answer,
            "abuse_throttled",
            StatusCode::TOO_MANY_REQUESTS,
            what,
        );
        assert_eq!(answer.retry_after.as_deref(), Some("60"), "{what}");
        assert_eq!(
            answer.json()["error"]["type"],
            "rate_limit_exceeded",
            "{what}"
        );
        assert_eq!(answer.json()["error"]["reason_class"], "velocity", "{what}");
    }
    assert_eq!(h.calls(), 1, "no throttled request reached the upstream");
    // The twin key in the same gateway is served on every inference route.
    for (what, uri, body) in inference_routes() {
        let answer = send(&h.app, post(uri, BETA, &body)).await;
        assert_eq!(answer.status, StatusCode::OK, "{what}: {}", answer.text);
    }
}

#[tokio::test]
async fn probe_throttle_counts_provider_calls_against_the_same_rate() {
    let h = harness(Options::default()).await;
    h.plane.set(ALPHA, credential_level(2, 1, 50));
    let ctx = crate::pipeline::authenticate(
        &h.state,
        crate::pipeline::AuthInputs::with_key(Some(&format!("Bearer {ALPHA}"))),
    )
    .await
    .expect("the key resolves");
    assert!(ctx.enforcement.is_some());
    crate::pipeline::provider_call_guard::rate_limit(&h.state, &ctx).expect("first call");
    let refused = crate::pipeline::provider_call_guard::rate_limit(&h.state, &ctx);
    assert!(
        matches!(refused, Err(crate::error::GatewayError::AbuseThrottled(_))),
        "{refused:?}"
    );
}

#[tokio::test]
async fn probe_throttle_holds_an_in_flight_slot_for_a_whole_stream() {
    let h = harness(Options::default()).await;
    h.plane.set(ALPHA, credential_level(2, 100, 1));
    let (feed, body) = channel_body();
    h.upstream.feeds.lock().unwrap().push_back(body);
    let response = h
        .app
        .clone()
        .oneshot(post(
            "/v1/chat/completions",
            ALPHA,
            &chat(LISTED, "Hi", true),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    // The headers are out and the upstream is streaming; the platform
    // screener holds short text until a window fills, so no body bytes are
    // awaited here.
    let stream = response.into_body().into_data_stream();
    feed.send(Ok(bytes::Bytes::from(chunk(FIRST, false))))
        .await
        .unwrap();
    // The open stream holds the key's only slot, on every route.
    let blocked = send(
        &h.app,
        post("/v1/chat/completions", ALPHA, &chat(LISTED, "Hi", false)),
    )
    .await;
    assert_appeal(
        &blocked,
        "abuse_throttled",
        StatusCode::TOO_MANY_REQUESTS,
        "chat beside a stream",
    );
    assert_eq!(blocked.retry_after.as_deref(), Some("2"));
    let call = send(
        &h.app,
        post(
            "/v1/providers/call",
            ALPHA,
            &json!({ "provider": "composio", "toolId": "probe", "method": "GET", "requestId": "req_probe" }),
        ),
    )
    .await;
    assert_appeal(
        &call,
        "abuse_throttled",
        StatusCode::TOO_MANY_REQUESTS,
        "provider call beside a stream",
    );
    assert_eq!(h.calls(), 1);
    // A client that goes away frees the slot.
    drop(stream);
    drop(feed);
    let mut served = None;
    for _ in 0..50 {
        let answer = send(
            &h.app,
            post("/v1/chat/completions", ALPHA, &chat(LISTED, "Hi", false)),
        )
        .await;
        if answer.status == StatusCode::OK {
            served = Some(answer);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(served.is_some(), "the slot was never given back");
    assert_eq!(
        h.state.abuse_in_flight.count("abuse:credential:cred_alpha"),
        0
    );
}

#[tokio::test]
async fn probe_every_route_gives_its_in_flight_slot_back() {
    // One slot: a route that authenticated twice in one request, or kept a
    // clone of the request after answering, would refuse the next request.
    let h = harness(Options::default()).await;
    h.plane.set(ALPHA, credential_level(2, 1_000, 1));
    let mut routes = inference_routes();
    routes.extend(media_routes());
    routes.push((
        "embeddings",
        "/v1/embeddings",
        json!({ "model": "embed-model", "input": "plain words" }),
    ));
    routes.push((
        "web search",
        "/v1/web/search",
        json!({ "query": "plain words" }),
    ));
    for _ in 0..2 {
        for (what, uri, body) in &routes {
            let answer = send(&h.app, post(uri, ALPHA, body)).await;
            assert_ne!(answer.code(), "abuse_throttled", "{what}: {}", answer.text);
            // A detached buffered call settles on its own task; give it a
            // moment to finish before reading the counter.
            let mut held = u32::MAX;
            for _ in 0..50 {
                held = h.state.abuse_in_flight.count("abuse:credential:cred_alpha");
                if held == 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert_eq!(held, 0, "{what} kept its slot");
        }
    }
    for (what, uri, body) in inference_routes() {
        let answer = send(&h.app, post(uri, ALPHA, &body)).await;
        assert_eq!(answer.status, StatusCode::OK, "{what}: {}", answer.text);
    }
}

// ─── Restrict (L3) ─────────────────────────────────────────────────────────

#[tokio::test]
async fn probe_restrict_serves_listed_models_and_refuses_the_rest() {
    let h = harness(Options::default()).await;
    h.plane.set(ALPHA, credential_level(3, 100, 50));
    for (what, uri, body) in inference_routes() {
        let answer = send(&h.app, post(uri, ALPHA, &body)).await;
        assert_eq!(answer.status, StatusCode::OK, "{what}: {}", answer.text);
    }
    let served = h.calls();
    for model in [UNLISTED, "openrouter/auto"] {
        for stream in [false, true] {
            let answer = send(
                &h.app,
                post("/v1/chat/completions", ALPHA, &chat(model, "Hi", stream)),
            )
            .await;
            assert_appeal(&answer, "account_restricted", StatusCode::FORBIDDEN, model);
            assert_eq!(answer.json()["error"]["type"], "policy_violation");
        }
        let messages = send(
            &h.app,
            post(
                "/v1/messages",
                ALPHA,
                &json!({ "model": model, "max_tokens": 16,
                         "messages": [{ "role": "user", "content": "Hi" }] }),
            ),
        )
        .await;
        assert_eq!(messages.status, StatusCode::FORBIDDEN, "{}", messages.text);
        assert!(
            messages.text.contains("account_restricted"),
            "{}",
            messages.text
        );
    }
    for (what, uri, body) in media_routes() {
        let answer = send(&h.app, post(uri, ALPHA, &body)).await;
        assert_appeal(&answer, "account_restricted", StatusCode::FORBIDDEN, what);
    }
    assert_eq!(h.calls(), served, "no refused request reached the upstream");
    // The active twin is not restricted: an unlisted model is served and
    // media is not refused for the account.
    let twin = send(
        &h.app,
        post("/v1/chat/completions", BETA, &chat(UNLISTED, "Hi", false)),
    )
    .await;
    assert_eq!(twin.status, StatusCode::OK, "{}", twin.text);
    for (what, uri, body) in media_routes() {
        let answer = send(&h.app, post(uri, BETA, &body)).await;
        assert_ne!(
            answer.code(),
            "account_restricted",
            "{what}: {}",
            answer.text
        );
    }
}

#[tokio::test]
async fn probe_restrict_keeps_polling_a_video_job() {
    let h = harness(Options::default()).await;
    h.plane.set(ALPHA, credential_level(3, 100, 50));
    let request = Request::builder()
        .method(Method::GET)
        .uri("/v1/videos/generations/vid_unknown")
        .extension(peer())
        .header("authorization", format!("Bearer {ALPHA}"))
        .body(Body::empty())
        .unwrap();
    let answer = send(&h.app, request).await;
    assert_ne!(answer.code(), "account_restricted", "{}", answer.text);
}

#[tokio::test]
async fn probe_restrict_blocks_input_a_good_standing_key_only_flags() {
    let h = harness(Options::default()).await;
    h.plane.set(ALPHA, credential_level(3, 100, 50));
    let text = format!("plain words {SENTINEL_HAZARD_S1}");
    for stream in [false, true] {
        let twin = send(
            &h.app,
            post("/v1/chat/completions", BETA, &chat(LISTED, &text, stream)),
        )
        .await;
        assert_eq!(twin.status, StatusCode::OK, "flag only: {}", twin.text);
        let calls = h.calls();
        let blocked = send(
            &h.app,
            post("/v1/chat/completions", ALPHA, &chat(LISTED, &text, stream)),
        )
        .await;
        assert_eq!(blocked.status, StatusCode::FORBIDDEN, "{}", blocked.text);
        assert_eq!(blocked.code(), "platform_floor_blocked");
        assert_eq!(blocked.json()["error"]["categories"], json!(["S1"]));
        assert_eq!(h.calls(), calls, "a blocked request reached the upstream");
    }
}

#[tokio::test]
async fn probe_restrict_withholds_output_a_good_standing_key_receives() {
    let reply: &'static str =
        Box::leak(format!("plain answer {SENTINEL_HAZARD_S1}").into_boxed_str());
    let h = harness(Options {
        reply,
        ..Options::default()
    })
    .await;
    h.plane.set(ALPHA, credential_level(3, 100, 50));
    let twin = send(
        &h.app,
        post("/v1/chat/completions", BETA, &chat(LISTED, "Hi", false)),
    )
    .await;
    assert_eq!(twin.status, StatusCode::OK, "{}", twin.text);
    assert!(twin.text.contains(SENTINEL_HAZARD_S1));
    let withheld = send(
        &h.app,
        post("/v1/chat/completions", ALPHA, &chat(LISTED, "Hi", false)),
    )
    .await;
    assert_eq!(withheld.status, StatusCode::FORBIDDEN, "{}", withheld.text);
    assert_eq!(withheld.code(), "platform_floor_output_blocked");
    assert!(!withheld.text.contains(SENTINEL_HAZARD_S1));
    let streamed = send(
        &h.app,
        post("/v1/chat/completions", ALPHA, &chat(LISTED, "Hi", true)),
    )
    .await;
    assert!(
        streamed.text.contains("platform_floor_output_blocked"),
        "{}",
        streamed.text
    );
    assert!(
        !streamed.text.contains(SENTINEL_HAZARD_S1),
        "{}",
        streamed.text
    );
    let twin_stream = send(
        &h.app,
        post("/v1/chat/completions", BETA, &chat(LISTED, "Hi", true)),
    )
    .await;
    assert!(
        twin_stream.text.contains(SENTINEL_HAZARD_S1),
        "{}",
        twin_stream.text
    );
}

// ─── Degraded mode ─────────────────────────────────────────────────────────

#[tokio::test]
async fn probe_degraded_mode_refuses_a_throttled_key_outright() {
    let h = harness(Options {
        qualified: false,
        ..Options::default()
    })
    .await;
    h.plane.set(ALPHA, credential_level(2, 100, 50));
    let twin = send(
        &h.app,
        post("/v1/chat/completions", BETA, &chat(LISTED, "Hi", false)),
    )
    .await;
    assert_eq!(twin.status, StatusCode::OK, "degraded rate: {}", twin.text);
    let calls = h.calls();
    let refused = send(
        &h.app,
        post("/v1/chat/completions", ALPHA, &chat(LISTED, "Hi", false)),
    )
    .await;
    assert_eq!(
        refused.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        refused.text
    );
    assert_eq!(refused.code(), "screening_unavailable");
    assert_eq!(h.calls(), calls);
}

// ─── Custody ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn probe_managed_node_and_self_hosted_ignore_the_ladder_and_key_age() {
    for custody in [GatewayCustody::ManagedNode, GatewayCustody::SelfHosted] {
        let h = harness(Options {
            custody,
            ..Options::default()
        })
        .await;
        h.plane.set(ALPHA, credential_level(3, 1, 1));
        h.plane.set_created(ALPHA, chrono::Utc::now());
        *h.plane.active_gateways.lock().unwrap() = Some(30);
        for _ in 0..3 {
            for model in [LISTED, UNLISTED] {
                let answer = send(
                    &h.app,
                    post("/v1/chat/completions", ALPHA, &chat(model, "Hi", false)),
                )
                .await;
                assert_eq!(
                    answer.status,
                    StatusCode::OK,
                    "{custody:?} {model}: {}",
                    answer.text
                );
            }
        }
        for (what, uri, body) in media_routes() {
            let answer = send(&h.app, post(uri, ALPHA, &body)).await;
            assert!(
                !answer.text.contains("account_restricted")
                    && !answer.text.contains("abuse_throttled"),
                "{custody:?} {what}: {}",
                answer.text
            );
        }
    }
}

// ─── New keys ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn probe_a_key_under_a_day_old_has_a_lower_rate() {
    let h = harness(Options::default()).await;
    // 30 gateways share the new-key rate: one request a minute here.
    *h.plane.active_gateways.lock().unwrap() = Some(30);
    h.plane
        .set_created(ALPHA, chrono::Utc::now() - chrono::Duration::hours(2));
    h.plane
        .set_created(BETA, chrono::Utc::now() - chrono::Duration::days(3));
    let first = send(
        &h.app,
        post("/v1/chat/completions", ALPHA, &chat(LISTED, "Hi", false)),
    )
    .await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.text);
    for (what, uri, body) in inference_routes() {
        let answer = send(&h.app, post(uri, ALPHA, &body)).await;
        assert_eq!(
            answer.status,
            StatusCode::TOO_MANY_REQUESTS,
            "{what}: {}",
            answer.text
        );
        assert_eq!(answer.code(), "new_key_rate_limited", "{what}");
        let error = &answer.json()["error"];
        assert_eq!(error["remedy"], "none", "{what}");
        assert!(error.get("appeal_url").is_none(), "{what}");
        assert_eq!(answer.retry_after.as_deref(), Some("60"), "{what}");
    }
    assert_eq!(h.calls(), 1);
    for _ in 0..3 {
        let older = send(
            &h.app,
            post("/v1/chat/completions", BETA, &chat(LISTED, "Hi", false)),
        )
        .await;
        assert_eq!(older.status, StatusCode::OK, "{}", older.text);
    }
}

// ─── Pushes and the wire ───────────────────────────────────────────────────

async fn push(app: &Router, body: Value) -> Answer {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/internal/enforcement/invalidate")
        .header("content-type", "application/json")
        .header(crate::standing::INTERNAL_SECRET_HEADER, SECRET)
        .extension(peer())
        .body(Body::from(body.to_string()))
        .unwrap();
    send(app, request).await
}

#[tokio::test]
async fn probe_a_push_applies_a_new_level_to_the_next_request() {
    let h = harness(Options::default()).await;
    let before = send(
        &h.app,
        post("/v1/chat/completions", ALPHA, &chat(UNLISTED, "Hi", false)),
    )
    .await;
    assert_eq!(before.status, StatusCode::OK, "{}", before.text);
    // The control plane restricts the key and pushes; the cached
    // resolution is dropped at once rather than after its TTL.
    h.plane.set(ALPHA, credential_level(3, 100, 50));
    let still_cached = send(
        &h.app,
        post("/v1/chat/completions", ALPHA, &chat(UNLISTED, "Hi", false)),
    )
    .await;
    assert_eq!(still_cached.status, StatusCode::OK, "before the push");
    let pushed = push(
        &h.app,
        json!({ "credentialId": "cred_alpha", "enforcementVersion": 1 }),
    )
    .await;
    assert_eq!(pushed.status, StatusCode::OK, "{}", pushed.text);
    let after = send(
        &h.app,
        post("/v1/chat/completions", ALPHA, &chat(UNLISTED, "Hi", false)),
    )
    .await;
    assert_appeal(
        &after,
        "account_restricted",
        StatusCode::FORBIDDEN,
        "after the push",
    );
    // Lifting it the same way serves again.
    h.plane.set(ALPHA, ladder(json!([])));
    push(
        &h.app,
        json!({ "orgId": "org_alpha", "enforcementVersion": 2 }),
    )
    .await;
    let lifted = send(
        &h.app,
        post("/v1/chat/completions", ALPHA, &chat(UNLISTED, "Hi", false)),
    )
    .await;
    assert_eq!(lifted.status, StatusCode::OK, "{}", lifted.text);
}

#[tokio::test]
async fn probe_a_restricted_state_restricts_the_whole_org() {
    let h = harness(Options::default()).await;
    h.plane.set(
        ALPHA,
        json!({
            "state": "restricted", "refuses": "none", "reasonClass": "fraud",
            "until": null, "appealUrl": APPEAL, "enforcementVersion": 0
        }),
    );
    let listed = send(
        &h.app,
        post("/v1/chat/completions", ALPHA, &chat(LISTED, "Hi", false)),
    )
    .await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.text);
    let unlisted = send(
        &h.app,
        post("/v1/chat/completions", ALPHA, &chat(UNLISTED, "Hi", false)),
    )
    .await;
    assert_appeal(
        &unlisted,
        "account_restricted",
        StatusCode::FORBIDDEN,
        "restricted org",
    );
    assert_eq!(unlisted.json()["error"]["reason_class"], "fraud");
}

#[tokio::test]
async fn probe_a_malformed_ladder_is_refused_as_unavailable() {
    let h = harness(Options::default()).await;
    h.plane.set(
        ALPHA,
        ladder(json!([{ "scope": "credential", "level": 9 }])),
    );
    let answer = send(
        &h.app,
        post("/v1/chat/completions", ALPHA, &chat(LISTED, "Hi", false)),
    )
    .await;
    assert_eq!(
        answer.status,
        StatusCode::SERVICE_UNAVAILABLE,
        "{}",
        answer.text
    );
    assert_eq!(answer.code(), "standing_unavailable");
    assert_eq!(h.calls(), 0);
}
