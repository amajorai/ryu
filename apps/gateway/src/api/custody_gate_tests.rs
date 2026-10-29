//! Route gates that depend on [`GatewayCustody`].
//!
//! Every refused case asserts the exact status and code, zero calls on the
//! mock upstream, and one audit row. Each one has a benign control that
//! dispatches, so a passing refusal cannot just mean the route is broken.
use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{Method, Request, StatusCode},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::{
    audit::{AuditLogger, AuditRecord, EventType},
    config::{AuditConfig, GatewayConfig, ProviderId},
    custody::GatewayCustody,
    evals::EvalsRunner,
    providers::Provider,
    state::AppState,
};

const MASTER: &str = "master-secret";
const FIXTURE: &str = "custody-fixture";
/// A syntactically hosted Gateway token. It resolves nowhere; the refusal must
/// happen before any resolution is attempted.
const RGW_TOKEN: &str = "rgw_test_0000000000000001";

/// An audit backend that keeps every row in memory.
#[derive(Default)]
struct RecordingAudit {
    rows: Mutex<Vec<AuditRecord>>,
}

impl RecordingAudit {
    fn rows(&self) -> Vec<AuditRecord> {
        self.rows.lock().expect("audit rows lock").clone()
    }
}

impl crate::audit::AuditBackend for RecordingAudit {
    fn log(&self, record: AuditRecord) {
        self.rows.lock().expect("audit rows lock").push(record);
    }
    fn is_enabled(&self) -> bool {
        true
    }
    fn token_usage(&self, _api_key: &str) -> u64 {
        0
    }
    fn add_tokens(&self, _api_key: &str, _n: u64) {}
    fn query(
        &self,
        _query: &crate::audit::AuditQuery,
    ) -> anyhow::Result<Vec<crate::audit::AuditEntry>> {
        Ok(Vec::new())
    }
    fn summary(&self) -> anyhow::Result<crate::audit::AuditSummary> {
        Ok(crate::audit::AuditSummary::default())
    }
    fn usage_rollup(
        &self,
        _query: &crate::audit::AuditUsageQuery,
    ) -> anyhow::Result<Vec<crate::audit::AuditUsageEvent>> {
        Ok(Vec::new())
    }
}

type ProviderFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ryu_gw_providers::ProviderError>> + Send + 'a>>;

/// Records every completion it is asked for and answers a fixed reply.
struct FixtureProvider {
    calls: Arc<AtomicUsize>,
}

impl Provider for FixtureProvider {
    fn name(&self) -> &'static str {
        FIXTURE
    }

    fn complete<'a>(&'a self, _model: &'a str, _body: &'a Value) -> ProviderFuture<'a, Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Ok(json!({
                "id": "chatcmpl-custody",
                "object": "chat.completion",
                "model": "fixture-model",
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": "ok" },
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
        Box::pin(async { Ok(Body::from("data: [DONE]\n\n")) })
    }
}

struct Harness {
    app: Router,
    audit: Arc<RecordingAudit>,
}

fn state_with(
    custody: GatewayCustody,
    configure: impl FnOnce(&mut GatewayConfig),
) -> (AppState, Arc<RecordingAudit>) {
    let mut config = GatewayConfig::default();
    config.auth.require_auth = true;
    config.auth.master_key = Some(MASTER.to_owned());
    config.cache.enabled = false;
    configure(&mut config);
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    // The registry is built for `custody` too, so fleet-only slots match it.
    let mut state = AppState::new_for_test_with_custody(
        config,
        audit,
        EvalsRunner::new(Default::default()),
        custody,
    );
    let recording = Arc::new(RecordingAudit::default());
    state.audit.register(
        crate::audit::AuditRegistry::BUILTIN,
        Arc::clone(&recording) as Arc<dyn crate::audit::AuditBackend>,
    );
    (state, recording)
}

fn fixture_harness(custody: GatewayCustody) -> (Harness, Arc<AtomicUsize>) {
    let (mut state, audit) = state_with(custody, |config| {
        config.routing.default_provider = ProviderId::from(FIXTURE);
        config.routing.fallback_chain = vec![];
    });
    let calls = Arc::new(AtomicUsize::new(0));
    state
        .provider_runtime
        .register_for_test(Arc::new(FixtureProvider {
            calls: Arc::clone(&calls),
        }));
    (
        Harness {
            app: crate::api::router(Arc::new(state)),
            audit,
        },
        calls,
    )
}

fn peer(loopback: bool) -> ConnectInfo<std::net::SocketAddr> {
    let ip = if loopback {
        [127, 0, 0, 1]
    } else {
        [203, 0, 113, 7]
    };
    ConnectInfo(std::net::SocketAddr::from((ip, 40_000)))
}

async fn send(
    app: &Router,
    uri: &str,
    bearer: Option<&str>,
    body: &Value,
    loopback: bool,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("content-type", "application/json")
        .extension(peer(loopback));
    if let Some(key) = bearer {
        request = request.header("authorization", format!("Bearer {key}"));
    }
    let response = app
        .clone()
        .oneshot(
            request
                .body(Body::from(body.to_string()))
                .expect("request builds"),
        )
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

fn gemini_body() -> Value {
    json!({ "contents": [{ "role": "user", "parts": [{ "text": "Hi" }] }] })
}

fn chat_body() -> Value {
    json!({ "model": "fixture-model", "messages": [{ "role": "user", "content": "Hi" }] })
}

const GEMINI: &str = "/v1beta/models/fixture-model:generateContent";

// ── /passthrough/* ───────────────────────────────────────────────────────────

#[tokio::test]
async fn passthrough_routes_are_not_mounted_on_fleet() {
    let (state, _) = state_with(GatewayCustody::Fleet, |_| {});
    let app = crate::api::router(Arc::new(state));
    for path in [
        "/passthrough/anthropic/v1/messages",
        "/passthrough/openai-responses/responses",
    ] {
        let (status, _) = send(&app, path, None, &json!({}), true).await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "{path} must not exist on fleet"
        );
    }
}

#[tokio::test]
async fn control_passthrough_routes_stay_mounted_off_fleet() {
    // A remote peer reaches the mounted handler, which refuses it before any
    // upstream request, so this proves the route exists without a network call.
    for custody in [GatewayCustody::SelfHosted, GatewayCustody::ManagedNode] {
        let (state, _) = state_with(custody, |_| {});
        let app = crate::api::router(Arc::new(state));
        for path in [
            "/passthrough/anthropic/v1/messages",
            "/passthrough/openai-responses/responses",
        ] {
            let (status, body) = send(&app, path, None, &json!({}), false).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{custody:?} {path}");
            assert_eq!(
                body,
                json!("passthrough proxy is loopback-only"),
                "{custody:?} {path}"
            );
        }
    }
}

// ── POST /v1/batches ─────────────────────────────────────────────────────────

struct BatchUpstream {
    base: String,
    submissions: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for BatchUpstream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn spawn_batch_upstream() -> BatchUpstream {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("mock OpenRouter binds");
    let base = format!("http://{}", listener.local_addr().expect("mock address"));
    let submissions = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&submissions);
    let router = Router::new().route(
        "/api/v1/batches",
        post(move || {
            let counted = Arc::clone(&counted);
            async move {
                counted.fetch_add(1, Ordering::SeqCst);
                (
                    StatusCode::ACCEPTED,
                    Json(json!({ "id": "batch_local_1", "status": "validating" })),
                )
            }
        }),
    );
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("mock OpenRouter serves");
    });
    BatchUpstream {
        base,
        submissions,
        task,
    }
}

fn batch_harness(custody: GatewayCustody, upstream: &BatchUpstream) -> Harness {
    let base_url = format!("{}/api/v1", upstream.base);
    let (state, audit) = state_with(custody, |config| {
        config.providers.openrouter = Some(crate::config::OpenRouterProviderConfig {
            api_key: "sk-or-mock".to_owned(),
            api_keys: Vec::new(),
            base_url,
            site_url: "https://ryu.example".to_owned(),
            site_name: "Ryu".to_owned(),
            data_collection: String::new(),
            zdr: false,
            sort: String::new(),
            response_healing: false,
            usage_accounting: true,
            org_api_keys: Default::default(),
        });
    });
    Harness {
        app: crate::api::router(Arc::new(state)),
        audit,
    }
}

fn batch_body() -> Value {
    json!({
        "endpoint": "/v1/chat/completions",
        "model": "openai/gpt-4o-mini",
        "completion_window": "24h",
        "requests": [{
            "custom_id": "eval-1",
            "body": { "messages": [{ "role": "user", "content": "Hi" }] }
        }]
    })
}

#[tokio::test]
async fn batch_creation_is_refused_on_fleet() {
    let upstream = spawn_batch_upstream().await;
    let harness = batch_harness(GatewayCustody::Fleet, &upstream);
    let (status, body) = send(
        &harness.app,
        "/v1/batches",
        Some(MASTER),
        &batch_body(),
        true,
    )
    .await;

    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["type"], "policy_violation");
    assert_eq!(body["error"]["code"], "feature_not_permitted");
    assert_eq!(body["error"]["layer"], "platform");
    assert_eq!(body["error"]["remedy"], "none");
    assert_eq!(upstream.submissions.load(Ordering::SeqCst), 0);

    let rows = harness.audit.rows();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].event_type, EventType::ExecCall);
    assert_eq!(rows[0].provider, "openrouter");
    assert_eq!(rows[0].model, "batches.create");
    assert_eq!(rows[0].error.as_deref(), Some("feature_not_permitted"));
}

#[tokio::test]
async fn control_batch_creation_dispatches_off_fleet() {
    for custody in [GatewayCustody::SelfHosted, GatewayCustody::ManagedNode] {
        let upstream = spawn_batch_upstream().await;
        let harness = batch_harness(custody, &upstream);
        let (status, body) = send(
            &harness.app,
            "/v1/batches",
            Some(MASTER),
            &batch_body(),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED, "{custody:?}: {body}");
        assert_eq!(body["id"], "batch_local_1");
        assert_eq!(
            upstream.submissions.load(Ordering::SeqCst),
            1,
            "{custody:?}"
        );
    }
}

#[tokio::test]
async fn unauthenticated_batch_creation_on_fleet_is_still_unauthorized() {
    let upstream = spawn_batch_upstream().await;
    let harness = batch_harness(GatewayCustody::Fleet, &upstream);
    let (status, _) = send(&harness.app, "/v1/batches", None, &batch_body(), true).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(upstream.submissions.load(Ordering::SeqCst), 0);
}

// ── Gateway tokens in the query string ───────────────────────────────────────

fn assert_query_refusal(status: StatusCode, body: &Value, harness: &Harness, path: &str) {
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}: {body}");
    assert_eq!(body["error"]["type"], "invalid_api_key", "{path}");
    let rows = harness.audit.rows();
    assert_eq!(rows.len(), 1, "{path}: {rows:?}");
    assert_eq!(rows[0].provider, "gateway");
    assert_eq!(rows[0].model, path);
    assert_eq!(
        rows[0].error.as_deref(),
        Some(crate::api::QUERY_CREDENTIAL_REFUSED)
    );
    assert!(rows[0].api_key.is_empty());
    let row = format!("{rows:?}");
    assert!(
        !row.contains(RGW_TOKEN),
        "audit row leaked the token: {row}"
    );
    assert!(
        !body.to_string().contains(RGW_TOKEN),
        "error body echoed the token"
    );
}

#[tokio::test]
async fn gemini_query_key_with_a_gateway_token_is_refused_on_fleet() {
    let (harness, calls) = fixture_harness(GatewayCustody::Fleet);
    // Even with a valid header credential, the URL token is refused.
    let uri = format!("{GEMINI}?key={RGW_TOKEN}");
    let (status, body) = send(&harness.app, &uri, Some(MASTER), &gemini_body(), true).await;
    assert_query_refusal(status, &body, &harness, "/v1beta/models/:spec");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_gateway_token_in_any_query_parameter_is_refused_on_fleet() {
    for query in [
        format!("token={RGW_TOKEN}"),
        format!("alt=json&api_key=%72gw_{}", &RGW_TOKEN[4..]),
    ] {
        let (harness, calls) = fixture_harness(GatewayCustody::Fleet);
        let uri = format!("/v1/chat/completions?{query}");
        let (status, body) = send(&harness.app, &uri, Some(MASTER), &chat_body(), true).await;
        assert_query_refusal(status, &body, &harness, "/v1/chat/completions");
        assert_eq!(calls.load(Ordering::SeqCst), 0, "{query}");
    }
}

#[tokio::test]
async fn the_refusal_records_the_route_template_not_a_path_proof() {
    const PROOF: &str = "proof-segment-0000000000000001";
    let (harness, calls) = fixture_harness(GatewayCustody::Fleet);
    let uri = format!("/v1/agents/agent-1/{PROOF}/chat/completions?token={RGW_TOKEN}");
    let (status, body) = send(&harness.app, &uri, Some(MASTER), &chat_body(), true).await;
    assert_query_refusal(
        status,
        &body,
        &harness,
        "/v1/agents/:agent_id/:agent_proof/chat/completions",
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let rows = format!("{:?}", harness.audit.rows());
    assert!(
        !rows.contains(PROOF),
        "audit row leaked the path proof: {rows}"
    );
}

#[tokio::test]
async fn control_header_credential_dispatches_on_fleet() {
    let (harness, calls) = fixture_harness(GatewayCustody::Fleet);
    let (status, body) = send(&harness.app, GEMINI, Some(MASTER), &gemini_body(), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let uri = "/v1/chat/completions?alt=json";
    let (status, body) = send(&harness.app, uri, Some(MASTER), &chat_body(), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(harness
        .audit
        .rows()
        .iter()
        .all(|row| row.error.as_deref() != Some(crate::api::QUERY_CREDENTIAL_REFUSED)));
}

#[tokio::test]
async fn fleet_never_reads_a_gemini_credential_from_the_url() {
    let (harness, calls) = fixture_harness(GatewayCustody::Fleet);
    let uri = format!("{GEMINI}?key={MASTER}");
    let (status, _) = send(&harness.app, &uri, None, &gemini_body(), true).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn control_gemini_query_key_is_unchanged_off_fleet() {
    for custody in [GatewayCustody::SelfHosted, GatewayCustody::ManagedNode] {
        let (harness, calls) = fixture_harness(custody);
        let uri = format!("{GEMINI}?key={MASTER}");
        let (status, body) = send(&harness.app, &uri, None, &gemini_body(), true).await;
        assert_eq!(status, StatusCode::OK, "{custody:?}: {body}");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "{custody:?}");
        // The query-token layer is fleet-only: the header credential still wins.
        let uri = format!("{GEMINI}?key={RGW_TOKEN}");
        let (status, body) = send(&harness.app, &uri, Some(MASTER), &gemini_body(), true).await;
        assert_eq!(status, StatusCode::OK, "{custody:?}: {body}");
        assert_eq!(calls.load(Ordering::SeqCst), 2, "{custody:?}");
    }
}

#[cfg(test)]
mod custody_source;
#[cfg(test)]
mod media_knobs;
#[cfg(test)]
mod probe;
#[cfg(test)]
mod upstream_features;
#[cfg(test)]
mod upstream_identity;
