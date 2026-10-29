//! Screener glue tests (screener addendum section 12.2). Request content is
//! the spec 00.9 sentinels only, answered by the deterministic `TestBackend`
//! and the mock systemone server; no real harmful text appears here.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::extract::ConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use axum::Router;
use ryu_gw_screening::backends::decision::{DecisionBackend, DecisionConfig, RemotePermit};
use ryu_gw_screening::backends::test::{
    TestBackend, SENTINEL_HAZARD_S1, SENTINEL_HAZARD_S4, SENTINEL_HAZARD_S9, SENTINEL_LEXICON,
};
use ryu_gw_screening::testing::MockServer;
use ryu_gw_screening::BackendError;
use serde_json::{json, Value};
use tower::ServiceExt;

use super::admit::{screen_chat, screen_chat_as, screen_value, Surface};
use super::*;
use crate::audit::{AuditConfig, AuditLogger};
use crate::config::{
    GatewayConfig, ProviderEnvironment, ProviderId, ScreeningBackendConfig, ScreeningBackendKind,
};
use crate::error::GatewayError;
use crate::evals::EvalsRunner;
use crate::platform_floor::{FloorStore, PlatformFloor};
use crate::providers::Provider;
use crate::state::AppState;

const MASTER: &str = "screening-master";
const FIXTURE: &str = "screening-fixture";
const ZEROS: &str = "0000000000000000";

// ── fixtures ────────────────────────────────────────────────────────────────

type ProviderFuture<'a, T> = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<T, ryu_gw_providers::ProviderError>> + Send + 'a>,
>;

/// Counts every upstream call and answers `reply`, buffered or streamed.
struct Upstream {
    calls: Arc<AtomicUsize>,
    reply: String,
}

impl Provider for Upstream {
    fn name(&self) -> &'static str {
        FIXTURE
    }

    fn complete<'a>(&'a self, _model: &'a str, _body: &'a Value) -> ProviderFuture<'a, Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let reply = self.reply.clone();
        Box::pin(async move {
            Ok(json!({
                "id": "chatcmpl-screening",
                "object": "chat.completion",
                "model": "fixture-model",
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
        // A window of benign filler, the reply, then more filler.
        let filler = "lorem ipsum dolor sit amet ".repeat(80);
        let mut frames = Vec::new();
        for text in [filler.as_str(), self.reply.as_str(), filler.as_str()] {
            let chunk = json!({
                "id": "chatcmpl-screening",
                "object": "chat.completion.chunk",
                "choices": [{ "index": 0, "delta": { "content": text } }]
            });
            frames.push(Ok::<_, std::io::Error>(bytes::Bytes::from(format!(
                "data: {chunk}\n\n"
            ))));
        }
        frames.push(Ok(bytes::Bytes::from("data: [DONE]\n\n")));
        Box::pin(async move { Ok(Body::from_stream(futures_util::stream::iter(frames))) })
    }
}

fn test_backend(id: &str) -> Arc<TestBackend> {
    Arc::new(TestBackend::new(id))
}

fn runtime_with(
    config: &crate::config::ScreeningConfig,
    backends: &[Arc<TestBackend>],
) -> ScreeningRuntime {
    ScreeningRuntime::with_backends(
        config,
        backends
            .iter()
            .map(|b| {
                (
                    Arc::clone(b) as Arc<dyn ScreenerBackend>,
                    ScreeningBackendKind::DecisionLocal,
                    None,
                )
            })
            .collect(),
    )
}

/// The floor's `screener` object. `qualified` qualifies `decision_local` (the
/// test backend's build) for S4 and S9.
fn screener_json(text_hazard: &[&str], qualified: bool, extra: Value) -> Value {
    let mut screener = json!({
        "templateVersion": 1,
        "roles": {
            "textHazard": text_hazard,
            "promptAttack": text_hazard,
            "output": text_hazard,
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
    if let (Some(target), Some(extra)) = (screener.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            target.insert(key.clone(), value.clone());
        }
    }
    screener
}

fn record() -> Value {
    json!({ "remoteProcessors": [{
        "processorId": "typesafe", "backendId": "jev", "retentionDays": 0, "zdr": true,
        "dpaRef": "dpa-1", "region": "eu", "recordedBy": "admin-a", "approvedBy": "admin-b"
    }] })
}

fn floor_json(version: u64, screener: Option<Value>) -> Value {
    let mut floor = json!({
        "version": version,
        "contentHash": "test",
        "overlay": {
            "enabled": true,
            "scan_inbound": true,
            "policy": "block",
            "custom_patterns": [
                { "name": "ryu_test_lexicon", "regex": SENTINEL_LEXICON, "kind": "secret" }
            ],
        },
    });
    if let Some(screener) = screener {
        floor["screener"] = screener;
    }
    floor
}

fn floor(version: u64, screener: Option<Value>) -> Arc<PlatformFloor> {
    PlatformFloor::from_wire(Some(&floor_json(version, screener)), false)
        .expect("test floor parses")
}

fn build_state(
    custody: GatewayCustody,
    runtime: ScreeningRuntime,
    floor: Option<Arc<PlatformFloor>>,
    reply: &str,
) -> (AppState, Arc<AtomicUsize>) {
    let mut config = GatewayConfig::default();
    config.auth.require_auth = true;
    config.auth.master_key = Some(MASTER.to_owned());
    config.cache.enabled = false;
    config.routing.default_provider = ProviderId::from(FIXTURE);
    config.routing.fallback_chain = vec![];
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let mut state = AppState::new_for_test(config, audit, EvalsRunner::new(Default::default()));
    state.custody = custody;
    state.screening = Arc::new(runtime);
    if let Some(floor) = floor {
        state.platform_floor = FloorStore::with(floor);
    }
    let calls = Arc::new(AtomicUsize::new(0));
    state.provider_runtime.register_for_test(Arc::new(Upstream {
        calls: Arc::clone(&calls),
        reply: reply.to_owned(),
    }));
    (state, calls)
}

struct Gateway {
    app: Router,
    state: Arc<AppState>,
    calls: Arc<AtomicUsize>,
}

fn gateway(
    custody: GatewayCustody,
    runtime: ScreeningRuntime,
    floor: Option<Arc<PlatformFloor>>,
    reply: &str,
) -> Gateway {
    let (state, calls) = build_state(custody, runtime, floor, reply);
    let state = Arc::new(state);
    Gateway {
        app: crate::api::router(Arc::clone(&state)),
        state,
        calls,
    }
}

async fn send(
    app: &Router,
    method: Method,
    uri: &str,
    body: Option<&Value>,
) -> (StatusCode, HeaderMap, String) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {MASTER}"))
        .extension(ConnectInfo(std::net::SocketAddr::from((
            [203, 0, 113, 7],
            40_000,
        ))));
    let response = app
        .clone()
        .oneshot(
            request
                .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
                .expect("request builds"),
        )
        .await
        .expect("router responds");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body reads");
    (
        status,
        headers,
        String::from_utf8_lossy(&bytes).into_owned(),
    )
}

async fn chat(gateway: &Gateway, text: &str) -> (StatusCode, HeaderMap, Value) {
    let body =
        json!({ "model": "fixture-model", "messages": [{ "role": "user", "content": text }] });
    let (status, headers, raw) = send(
        &gateway.app,
        Method::POST,
        "/v1/chat/completions",
        Some(&body),
    )
    .await;
    (
        status,
        headers,
        serde_json::from_str(&raw).unwrap_or(Value::String(raw)),
    )
}

fn qualified_fleet(reply: &str) -> (Gateway, Arc<TestBackend>) {
    let backend = test_backend("decision_local");
    let gateway = gateway(
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), std::slice::from_ref(&backend)),
        Some(floor(
            3,
            Some(screener_json(&["decision_local"], true, json!({}))),
        )),
        reply,
    );
    (gateway, backend)
}

fn plain_ctx() -> crate::pipeline::RequestContext {
    crate::pipeline::test_support::plain_request_context()
}

fn chat_body(text: &str) -> Value {
    json!({ "messages": [{ "role": "user", "content": text }] })
}

// ── floor parse and replica validation ──────────────────────────────────────

#[test]
fn baseline_names_the_decision_model_first() {
    let baseline = FloorScreener::baseline();
    assert_eq!(baseline.roles.text_hazard[0], "decision_local");
    assert!(baseline.qualifications.is_empty());
    assert!(baseline.remote_processors.is_empty());
    assert!(!baseline.explicit);
}

#[test]
fn a_floor_without_qualifications_is_accepted_not_rejected() {
    let parsed = floor(
        4,
        Some(screener_json(&["decision_local"], false, json!({}))),
    );
    let screener = parsed.screener.as_ref().expect("screener kept");
    assert!(screener.explicit);
    assert!(screener.qualifications.is_empty());
    let runtime = runtime_with(&Default::default(), &[test_backend("decision_local")]);
    assert_eq!(runtime.validate_floor(screener), Ok(()));
}

#[test]
fn the_floor_is_rejected_as_a_whole_for_a_bad_screener() {
    let remote = |recorded_by: &str, approved_by: &str| {
        json!({ "remoteProcessors": [{
            "processorId": "typesafe", "backendId": "jev", "retentionDays": 0, "zdr": true,
            "dpaRef": "dpa", "region": "eu", "recordedBy": recorded_by, "approvedBy": approved_by
        }] })
    };
    let bad = [
        // S4 can only block (spec F4).
        screener_json(
            &["decision_local"],
            false,
            json!({ "hazards": { "hazard.S4": { "action": "flag", "flagThreshold": 0.5 } } }),
        ),
        // Thresholds are in (0, 1] and block is at least flag.
        screener_json(
            &["decision_local"],
            false,
            json!({ "hazards": { "hazard.S9": { "action": "block", "blockThreshold": 1.5, "flagThreshold": 0.2 } } }),
        ),
        screener_json(
            &["decision_local"],
            false,
            json!({ "hazards": { "hazard.S9": { "action": "block", "blockThreshold": 0.1, "flagThreshold": 0.2 } } }),
        ),
        screener_json(
            &["decision_local"],
            false,
            json!({ "hazards": { "hazard.S99": { "action": "flag", "flagThreshold": 0.2 } } }),
        ),
        // Unknown keys.
        screener_json(&["decision_local"], false, json!({ "shadow": true })),
        // A remote record without a second approver, or missing a field.
        screener_json(&["decision_local"], false, remote("admin-a", "admin-a")),
        screener_json(&["decision_local"], false, remote("admin-a", "")),
        // An empty or repeated text-hazard role.
        screener_json(&[], false, json!({})),
        screener_json(&["decision_local", "decision_local"], false, json!({})),
    ];
    for screener in bad {
        assert!(
            PlatformFloor::from_wire(Some(&floor_json(5, Some(screener.clone()))), false).is_none(),
            "{screener}"
        );
    }
    // SG-9: no tenant overlay path to the screener exists.
    let mut overlay_screener = floor_json(5, None);
    overlay_screener["overlay"]["screener"] = screener_json(&["decision_local"], false, json!({}));
    assert!(PlatformFloor::from_wire(Some(&overlay_screener), false).is_none());
    // SG-10: any other unknown top-level key still rejects the whole floor.
    let mut unknown = floor_json(5, None);
    unknown["screenerV2"] = json!({});
    assert!(PlatformFloor::from_wire(Some(&unknown), false).is_none());
}

#[test]
fn s4_is_forced_to_block_at_thresholds_no_looser_than_the_default() {
    let parsed = floor(
        6,
        Some(screener_json(
            &["decision_local"],
            false,
            json!({ "hazards": {
                "hazard.S4": { "action": "block", "blockThreshold": 0.9, "flagThreshold": 0.8 },
                "hazard.S12": { "action": "block", "blockThreshold": 0.7, "flagThreshold": 0.4 },
                "hazard.S1": { "action": "flag", "flagThreshold": 0.3, "hard": true }
            }, "adultPermittedModels": ["adult-model"] }),
        )),
    );
    let screener = parsed.screener.as_ref().unwrap();
    let s4 = screener.rule(TaxonomyId::S4);
    assert_eq!(s4.block_threshold, 0.5);
    assert_eq!(s4.flag_threshold, 0.2);
    assert!(s4.hard);
    assert!(screener.hard_codes().contains(TaxonomyId::S1));
    assert!(screener.hard_codes().contains(TaxonomyId::S9));
    let s12 = screener.rule(TaxonomyId::S12);
    assert_eq!(s12.decide(0.9, false), policy::CodeAction::Block);
    assert!(screener.adult_permitted(Some("adult-model")));
    assert_eq!(s12.decide(0.9, true), policy::CodeAction::Flag);
    assert_eq!(s12.decide(0.1, false), policy::CodeAction::Allow);
}

fn configured_runtime(backends: &[(&str, ScreeningBackendConfig)]) -> ScreeningRuntime {
    let mut config = crate::config::ScreeningConfig::default();
    for (id, backend) in backends {
        config.backends.insert((*id).to_owned(), backend.clone());
    }
    ScreeningRuntime::from_config(&config, &|_| None)
}

fn backend_config(kind: ScreeningBackendKind, url: &str) -> ScreeningBackendConfig {
    let mut backend = ScreeningBackendConfig::of_kind(kind);
    backend.base_url = Some(url.to_owned());
    backend.model = Some("model".to_owned());
    backend.weights_sha256 = Some(ZEROS.to_owned());
    backend
}

#[test]
fn replica_checks_reject_unknown_ids_unrecorded_remotes_and_uncovered_hard_codes() {
    let mut qwen = backend_config(ScreeningBackendKind::GuardModel, "http://127.0.0.1:9/v1");
    qwen.dialect = Some("qwen3guard".to_owned());
    let mut jev = backend_config(
        ScreeningBackendKind::DecisionRemote,
        "https://api.typesafe.invalid/v1/systemone",
    );
    jev.processor_id = Some("typesafe".to_owned());
    let runtime = configured_runtime(&[
        (
            "decision_local",
            backend_config(
                ScreeningBackendKind::DecisionLocal,
                "http://127.0.0.1:9/v1/systemone",
            ),
        ),
        ("guard_qwen", qwen),
        ("jev", jev),
    ]);
    assert!(
        runtime.build_errors().is_empty(),
        "{:?}",
        runtime.build_errors()
    );
    let check = |screener: Value| {
        let parsed = floor(7, Some(screener));
        runtime.validate_floor(parsed.screener.as_ref().unwrap())
    };
    assert!(check(screener_json(&["missing"], false, json!({}))).is_err());
    // SG-6: Jev in a role with no retention record rejects the floor.
    assert!(check(screener_json(&["decision_local", "jev"], false, json!({}))).is_err());
    // SB-4: a Qwen3Guard-only text role never covers S4.
    assert!(check(screener_json(&["guard_qwen"], false, json!({}))).is_err());
    assert_eq!(
        check(screener_json(&["decision_local", "jev"], false, record())),
        Ok(())
    );
}

#[test]
fn a_local_decision_model_without_pinned_weights_is_absent_not_fatal() {
    let mut unpinned = backend_config(
        ScreeningBackendKind::DecisionLocal,
        "http://127.0.0.1:9/v1/systemone",
    );
    unpinned.weights_sha256 = None;
    let runtime = configured_runtime(&[("decision_local", unpinned)]);
    assert!(runtime.slot("decision_local").is_none());
    assert_eq!(
        runtime
            .build_errors()
            .get("decision_local")
            .map(String::as_str),
        Some("a local decision model must pin its weights sha256")
    );
}

fn resolved_with(floor: Arc<PlatformFloor>) -> crate::policy::ResolvedOrg {
    crate::policy::ResolvedOrg {
        org_id: "org-floor".to_string(),
        managed_inference: false,
        openrouter_routing_enabled: false,
        remaining_budget_micro_usd: None,
        unrestricted_budget_micro_usd: None,
        pool_budgets_micro_usd: std::collections::HashMap::new(),
        pool_allowances: std::collections::HashMap::new(),
        policy: crate::policy::EffectivePolicy::default(),
        credential_id: None,
        service_account_id: None,
        credential: None,
        identity_salt_epoch: 1,
        team_id: None,
        owner_user_id: None,
        owner_team_ids: None,
        limits: Arc::default(),
        billed_limits: Arc::default(),
        managed_tier_unavailable: false,
        limits_spend: None,
        active_gateways: None,
        policy_version: None,
        fetched_at: std::time::Instant::now(),
        standing: crate::standing::PlatformStanding::active(),
        platform_floor: Some(floor),
        enforcement_seen: 0,
        credential_created_at: None,
    }
}

#[test]
fn a_rejected_floor_keeps_the_previous_one_and_raises_screening_degraded() {
    let g = gateway(
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), &[test_backend("decision_local")]),
        Some(floor(3, None)),
        "ok",
    );
    let mut receiver = g.state.traffic.subscribe();
    let resolved = resolved_with(floor(
        9,
        Some(screener_json(&["missing"], false, json!({}))),
    ));
    g.state.observe_platform_floor(&resolved);
    assert_eq!(g.state.platform_floor.current().map(|f| f.version), Some(3));
    let event = receiver.try_recv().expect("screening_degraded published");
    assert_eq!(event["kind"], "screening_degraded");
    assert_eq!(event["reason"], "floor_rejected");
    // No org id, so only the master key or the local operator sees it, and
    // the base request fields are present for feed consumers.
    assert!(event["org_id"].is_null());
    assert_eq!(event["provider"], "gateway");
    assert_eq!(event["latency_ms"], 0);

    let accepted = resolved_with(floor(
        10,
        Some(screener_json(&["decision_local"], false, json!({}))),
    ));
    g.state.observe_platform_floor(&accepted);
    assert_eq!(
        g.state.platform_floor.current().map(|f| f.version),
        Some(10)
    );
}

// ── admission ───────────────────────────────────────────────────────────────

/// SG-1: a hard code with a qualified source blocks before dispatch with the
/// 00.7 envelope and zero upstream calls.
#[tokio::test]
async fn a_qualified_hard_code_blocks_before_dispatch_with_zero_upstream_calls() {
    let (g, backend) = qualified_fleet("ok");
    let (status, _, body) = chat(&g, &format!("{SENTINEL_HAZARD_S9} screening probe")).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["type"], "policy_violation");
    assert_eq!(body["error"]["code"], "platform_floor_blocked");
    assert_eq!(body["error"]["layer"], "platform");
    assert_eq!(body["error"]["remedy"], "report_false_positive");
    assert_eq!(body["error"]["categories"], json!(["S9"]));
    assert!(body["error"]["screening_id"]
        .as_str()
        .unwrap()
        .starts_with("scr_"));
    let rendered = body.to_string();
    assert!(!rendered.contains("decision_local") && !rendered.contains(SENTINEL_HAZARD_S9));
    assert_eq!(g.calls.load(Ordering::SeqCst), 0);
    assert!(backend.calls() >= 1);

    let (status, _, body) = chat(&g, SENTINEL_HAZARD_S4).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["categories"], json!(["S4"]));
    assert_eq!(g.calls.load(Ordering::SeqCst), 0);
}

/// SG-2: a soft code flags and the request goes through.
#[tokio::test]
async fn a_soft_code_flags_and_dispatches() {
    let (g, _) = qualified_fleet("ok");
    let (status, _, body) = chat(&g, SENTINEL_HAZARD_S1).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(g.calls.load(Ordering::SeqCst), 1);
}

/// SG-17: a re-screen of the same body (a fallback attempt) answers from the
/// segment cache, so the backend is called once.
#[tokio::test]
async fn re_admission_of_an_unchanged_body_is_one_backend_call() {
    let (g, backend) = qualified_fleet("ok");
    let ctx = plain_ctx();
    let body = chat_body("plain fallback probe");
    for _ in 0..3 {
        screen_chat(&g.state, &ctx, &body, Surface::Chat)
            .await
            .unwrap();
    }
    assert_eq!(backend.calls(), 1);
}

/// SG-11: a template version bump in the floor never reuses cached scores.
#[tokio::test]
async fn a_template_version_bump_misses_the_cache() {
    let backend = test_backend("decision_local");
    let (mut state, _) = build_state(
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), std::slice::from_ref(&backend)),
        Some(floor(
            3,
            Some(screener_json(&["decision_local"], true, json!({}))),
        )),
        "ok",
    );
    let ctx = plain_ctx();
    let body = chat_body("template probe");
    screen_chat(&state, &ctx, &body, Surface::Chat)
        .await
        .unwrap();
    screen_chat(&state, &ctx, &body, Surface::Chat)
        .await
        .unwrap();
    assert_eq!(backend.calls(), 1);
    state.platform_floor = FloorStore::with(floor(
        4,
        Some(screener_json(
            &["decision_local"],
            true,
            json!({ "templateVersion": 2 }),
        )),
    ));
    screen_chat(&state, &ctx, &body, Surface::Chat)
        .await
        .unwrap();
    assert_eq!(backend.calls(), 2);
    // The new cache holds nothing from version 1: one miss, then the prompt
    // attack role answers from what the hazard role just stored.
    let stats = state.screening.cache_stats();
    assert_eq!((stats.misses, stats.hits), (1, 1));
}

/// SG-3: the backend sleeps past the deadline on a hard-code request while
/// its breaker is closed: 503 with `Retry-After` and zero upstream calls.
#[tokio::test]
async fn a_deadline_miss_with_a_healthy_qualified_backend_is_a_503() {
    let backend = Arc::new(TestBackend::new("decision_local").delay(Duration::from_millis(900)));
    let g = gateway(
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), std::slice::from_ref(&backend)),
        Some(floor(
            3,
            Some(screener_json(
                &["decision_local"],
                true,
                json!({ "deadlinesMs": { "chat": 100 } }),
            )),
        )),
        "ok",
    );
    let (status, headers, body) = chat(&g, SENTINEL_HAZARD_S9).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["error"]["code"], "screening_unavailable");
    assert!(headers.get("retry-after").is_some());
    assert_eq!(g.calls.load(Ordering::SeqCst), 0);
}

/// SG-4: with every qualified backend's breaker open the replica runs the
/// degraded row: the regex floor still blocks its lexicon, other traffic
/// passes, and the org's excess gets 429. Never a 503.
#[tokio::test]
async fn an_outage_runs_the_regex_floor_plus_throttle_never_a_503() {
    let backend =
        Arc::new(TestBackend::new("decision_local").fail_always(BackendError::Unavailable("down")));
    let config = crate::config::ScreeningConfig {
        degraded_rpm: 2,
        ..Default::default()
    };
    let g = gateway(
        GatewayCustody::Fleet,
        runtime_with(&config, std::slice::from_ref(&backend)),
        Some(floor(
            3,
            Some(screener_json(&["decision_local"], true, json!({}))),
        )),
        "ok",
    );
    g.state
        .screening
        .slot("decision_local")
        .unwrap()
        .backend
        .breaker
        .force_open();

    let (status, _, body) = chat(&g, SENTINEL_LEXICON).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(g.calls.load(Ordering::SeqCst), 0);

    let (status, _, body) = chat(&g, SENTINEL_HAZARD_S1).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _, _) = chat(&g, "second degraded request").await;
    assert_eq!(status, StatusCode::OK);
    let (status, headers, body) = chat(&g, "third degraded request").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["error"]["code"], "screening_degraded_throttle");
    assert!(headers.get("retry-after").is_some());
    assert_eq!(g.calls.load(Ordering::SeqCst), 2);
    // An open breaker sends nothing.
    assert_eq!(backend.calls(), 0);
}

/// The user decision for a fresh fleet: until a qualification lands, the
/// degraded row applies (no blanket 503), and a hard-code score from an
/// unqualified backend never decides.
#[tokio::test]
async fn no_qualified_backend_degrades_instead_of_refusing_everything() {
    let backend = test_backend("decision_local");
    let g = gateway(
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), std::slice::from_ref(&backend)),
        Some(floor(3, None)),
        "ok",
    );
    let (status, _, body) = chat(&g, "fresh fleet probe").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _, _) = chat(&g, SENTINEL_HAZARD_S9).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(g.calls.load(Ordering::SeqCst), 2);
    let report = super::status::report(&g.state);
    assert_eq!(report["mode"], "degraded");
    assert_eq!(report["floorScreener"], false);
}

/// SG-15 and the no-GPU decision: media no backend can screen is refused on
/// the fleet with 403 `media_unscreenable` and zero upstream calls.
#[tokio::test]
async fn unscreenable_media_is_refused_on_the_fleet() {
    let (g, backend) = qualified_fleet("ok");
    let body = json!({ "model": "fixture-model", "messages": [{ "role": "user", "content": [
        { "type": "text", "text": "describe" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgo=" } }
    ] }] });
    let (status, _, raw) = send(&g.app, Method::POST, "/v1/chat/completions", Some(&body)).await;
    let body: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "media_unscreenable");
    assert_eq!(g.calls.load(Ordering::SeqCst), 0);
    assert_eq!(backend.calls(), 0);
}

fn image_body() -> Value {
    json!({ "model": "fixture-model", "messages": [{ "role": "user", "content": [
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgo=" } }
    ] }] })
}

/// A fleet whose floor names `decision_local` for the vision role too.
fn vision_fleet(backend: &Arc<TestBackend>, deadlines: Value) -> Gateway {
    gateway(
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), std::slice::from_ref(backend)),
        Some(floor(
            3,
            Some(screener_json(
                &["decision_local"],
                true,
                json!({
                    "roles": {
                        "textHazard": ["decision_local"],
                        "promptAttack": ["decision_local"],
                        "output": ["decision_local"],
                        "vision": ["decision_local"],
                    },
                    "deadlinesMs": deadlines,
                }),
            )),
        )),
        "ok",
    )
}

/// An image the qualified vision backend never answered (it ran past the
/// image deadline) is refused with a 503 on the floor, never forwarded with no
/// S4 decision.
#[tokio::test]
async fn an_image_the_vision_backend_timed_out_on_is_refused_not_forwarded() {
    let backend = Arc::new(
        TestBackend::new("decision_local")
            .flag_image([0; 32], TaxonomyId::S4)
            .delay(Duration::from_millis(400)),
    );
    let g = vision_fleet(&backend, json!({ "chat": 100, "media": 100 }));
    let error = screen_chat(&g.state, &plain_ctx(), &image_body(), Surface::Chat)
        .await
        .expect_err("an undecided S4 image is refused");
    assert!(
        matches!(
            error,
            GatewayError::ScreeningUnavailable {
                reason: "vision_unavailable",
                ..
            }
        ),
        "{error:?}"
    );
}

/// The image call has its own budget: a chat deadline too short for a VLM
/// does not starve it into an undecided image.
#[tokio::test]
async fn the_vision_call_is_not_starved_by_the_chat_deadline() {
    let backend = Arc::new(
        TestBackend::new("decision_local")
            .flag_image([0; 32], TaxonomyId::S4)
            .delay(Duration::from_millis(300)),
    );
    let g = vision_fleet(&backend, json!({ "chat": 100, "media": 3000 }));
    let report = screen_chat(&g.state, &plain_ctx(), &image_body(), Surface::Chat)
        .await
        .expect("the image is screened inside its own deadline");
    assert!(report.blocked.is_empty());
    assert_eq!(backend.calls(), 1);
}

/// `adultPermittedModels` follows the model that receives the content: the
/// model the caller names in the body is not enough once routing, a slot
/// header or a fallback replaces it.
#[tokio::test]
async fn the_adult_exemption_follows_the_dispatched_model_not_the_named_one() {
    let backend = Arc::new(TestBackend::new("decision_local").fixed_score(TaxonomyId::S12, 0.99));
    let g = gateway(
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), std::slice::from_ref(&backend)),
        Some(floor(
            3,
            Some(screener_json(
                &["decision_local"],
                true,
                json!({ "adultPermittedModels": ["adult-model"] }),
            )),
        )),
        "ok",
    );
    let body = json!({ "model": "adult-model", "messages": [{ "role": "user", "content": "adult probe" }] });
    // Named and dispatched alike: flagged, not blocked.
    let report = screen_chat_as(&g.state, &plain_ctx(), &body, Surface::Chat, "adult-model")
        .await
        .expect("an adult-permitted model flags S12");
    assert_eq!(report.flagged, vec![TaxonomyId::S12]);
    // Named adult-permitted but dispatched to a mainstream model: blocked.
    let error = screen_chat_as(&g.state, &plain_ctx(), &body, Surface::Chat, "mainstream")
        .await
        .expect_err("S12 blocks on a model that is not adult-permitted");
    assert!(
        matches!(error, GatewayError::ContentBlocked(_)),
        "{error:?}"
    );
}

#[tokio::test]
async fn the_other_surfaces_screen_tool_rounds_embeddings_and_provider_calls() {
    let (g, _) = qualified_fleet("ok");
    let ctx = plain_ctx();
    for surface in [
        Surface::ToolRound,
        Surface::Embeddings,
        Surface::ProviderCall,
    ] {
        let error = screen_value(
            &g.state,
            &ctx,
            &json!({ "content": [SENTINEL_HAZARD_S9] }),
            surface,
        )
        .await
        .expect_err("blocked");
        assert!(
            matches!(error, GatewayError::ContentBlocked(_)),
            "{surface:?}"
        );
        assert!(error.is_safety_outcome());
    }
}

/// No backend classifies audio, so transcription audio is media no backend
/// can screen: the floor refuses it before any backend or provider call,
/// while a node's own tier forwards it unclassified (spec D17) and screens
/// only the prompt. An input image on a media route is media no backend can
/// screen.
#[tokio::test]
async fn transcription_audio_is_refused_on_the_floor_and_skipped_on_a_node() {
    let (g, backend) = qualified_fleet("ok");
    let ctx = plain_ctx();
    for body in [
        json!({ "file": "UklGRg==", "filename": "a.wav", "prompt": "meeting notes" }),
        json!({ "file": "data:audio/wav;base64,UklGRg==", "prompt": "meeting notes" }),
        json!({ "audio_url": "https://x.invalid/a.wav" }),
        json!({ "prompt": "meeting notes", "extra": ["data:audio/wav;base64,UklGRg=="] }),
    ] {
        let error = screen_value(&g.state, &ctx, &body, Surface::Transcription)
            .await
            .expect_err("the floor refuses transcription audio");
        assert_eq!(
            error.wire_status_and_code().1,
            "media_unscreenable",
            "{body}"
        );
    }
    assert_eq!(backend.calls(), 0, "refused before any backend call");

    let opt_in = crate::config::ScreeningConfig {
        node_classifiers: true,
        ..Default::default()
    };
    let node_backend = test_backend("decision_local");
    let node = gateway(
        GatewayCustody::SelfHosted,
        runtime_with(&opt_in, std::slice::from_ref(&node_backend)),
        None,
        "ok",
    );
    screen_value(
        &node.state,
        &ctx,
        &json!({ "file": "data:audio/wav;base64,UklGRg==", "prompt": "meeting notes" }),
        Surface::Transcription,
    )
    .await
    .expect("node tier: prompt screened, audio skipped");
    assert!(node_backend.calls() > 0, "the prompt is screened");
    assert!(node_backend
        .seen()
        .iter()
        .all(|text| !text.contains("UklGRg")));

    let error = screen_value(
        &g.state,
        &ctx,
        &json!({ "prompt": "edit this", "image": "https://x.invalid/cat.png" }),
        Surface::Media,
    )
    .await
    .expect_err("an input image no backend can screen");
    assert_eq!(error.wire_status_and_code().1, "media_unscreenable");
}

/// The benign control of the upstream-features padding probe (100 KiB of
/// text and 100 function tools) fits the item cap: definitions share items.
#[tokio::test]
async fn a_long_body_with_many_tools_is_classified_not_413() {
    let (g, backend) = qualified_fleet("ok");
    let tools: Vec<Value> = (0..100)
        .map(|i| {
            json!({ "type": "function", "function": {
                "name": format!("tool_{i}"),
                "description": "Look up one record by id.",
                "parameters": { "type": "object", "properties": { "id": { "type": "string" } } }
            } })
        })
        .collect();
    let body = json!({
        "messages": [{ "role": "user", "content": "lorem ipsum ".repeat(100 * 1024 / 12) }],
        "tools": tools
    });
    screen_chat(&g.state, &plain_ctx(), &body, Surface::Chat)
        .await
        .expect("classified");
    assert!(backend.calls() < 40, "{}", backend.calls());
}

#[tokio::test]
async fn an_oversized_request_is_413_at_floor_tier() {
    let (g, _) = qualified_fleet("ok");
    let ctx = plain_ctx();
    let huge = "a".repeat(admit::CHUNK_CHARS * (admit::MAX_ITEMS + 1));
    let error = screen_chat(&g.state, &ctx, &chat_body(&huge), Surface::Chat)
        .await
        .expect_err("over the cap");
    assert!(matches!(error, GatewayError::ScreeningCapacityExceeded));
}

// ── remote processors ───────────────────────────────────────────────────────

fn jev(mock: &MockServer, permit: RemotePermit) -> Arc<dyn ScreenerBackend> {
    Arc::new(
        DecisionBackend::remote_plaintext_for_test(
            DecisionConfig {
                id: "jev".into(),
                url: mock.base_url.clone(),
                model: "jev-latest".into(),
                weights_sha256: None,
                hard_timeout_ms: 2_000,
                max_concurrency: 2,
            },
            "typesafe",
            Some("test-only-screener-key".into()),
            permit,
        )
        .expect("remote backend"),
    )
}

fn jev_runtime(mock: &MockServer) -> ScreeningRuntime {
    let permit = RemotePermit::new();
    ScreeningRuntime::with_backends(
        &Default::default(),
        vec![(
            jev(mock, permit.clone()),
            ScreeningBackendKind::DecisionRemote,
            Some(permit),
        )],
    )
}

/// Jev is refused for floor traffic without an approved retention record:
/// the replica check rejects a floor that names it, and even a policy that
/// skipped that check sends the mock nothing.
#[tokio::test]
async fn jev_is_refused_for_floor_traffic_without_a_retention_record() {
    let mock = MockServer::systemone().await;
    let runtime = jev_runtime(&mock);
    let unrecorded = FloorScreener::parse(&screener_json(&["jev"], false, json!({}))).unwrap();
    assert!(runtime.validate_floor(&unrecorded).is_err());
    let g = gateway(GatewayCustody::Fleet, runtime, Some(floor(3, None)), "ok");
    let active = g
        .state
        .screening
        .active(ScreenTier::Floor, Some(Arc::new(unrecorded)));
    assert!(!active.chain.backends(Role::TextHazard)[0].permits(ScreenTier::Floor));
    // The baseline floor never names a remote processor either.
    let report = screen_chat(
        &g.state,
        &plain_ctx(),
        &chat_body(SENTINEL_HAZARD_S9),
        Surface::Chat,
    )
    .await
    .expect("degraded, not refused");
    assert!(report.processors.is_empty());
    assert_eq!(mock.calls(), 0);
}

/// SG-7: with an approved record Jev receives the systemone body and nothing
/// that names the tenant.
#[tokio::test]
async fn jev_with_an_approved_record_receives_no_tenant_identifiers() {
    let mock = MockServer::systemone().await;
    let runtime = jev_runtime(&mock);
    let floor = floor(3, Some(screener_json(&["jev"], false, record())));
    assert_eq!(
        runtime.validate_floor(floor.screener.as_ref().unwrap()),
        Ok(())
    );
    let g = gateway(GatewayCustody::Fleet, runtime, Some(floor), "ok");
    let mut ctx = plain_ctx();
    ctx.org_id = Some("org-tenant-marker".into());
    let report = screen_chat(
        &g.state,
        &ctx,
        &chat_body(SENTINEL_HAZARD_S1),
        Surface::Chat,
    )
    .await
    .expect("screened");
    assert_eq!(report.processors, vec!["typesafe".to_owned()]);
    let requests = mock.requests();
    assert!(!requests.is_empty());
    for request in requests {
        assert!(request.body.get("model").is_some());
        assert!(request.body.get("state").is_some());
        assert!(request.body.get("questions").is_some());
        let rendered = request.body.to_string();
        assert!(!rendered.contains("org-tenant-marker"));
        assert!(!rendered.contains(MASTER));
        assert!(request
            .headers
            .iter()
            .all(|(name, _)| !name.starts_with("x-ryu")));
        assert!(request.header("x-correlation-id").is_none());
    }
}

// ── custody ────────────────────────────────────────────────────────────────

/// Self-hosted and BYOK nodes are never bound by Ryu's floor: without the
/// opt-in nothing is screened, with it an unqualified backend decides at
/// node tier and an outage never refuses. A managed node never screens here.
#[tokio::test]
async fn self_hosted_nodes_are_never_bound_by_the_floor() {
    let backend = test_backend("decision_local");
    let g = gateway(
        GatewayCustody::SelfHosted,
        runtime_with(&Default::default(), std::slice::from_ref(&backend)),
        None,
        "ok",
    );
    let (status, _, _) = chat(&g, SENTINEL_HAZARD_S9).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(backend.calls(), 0);

    let opt_in = crate::config::ScreeningConfig {
        node_classifiers: true,
        ..Default::default()
    };
    let node_backend = test_backend("decision_local");
    let g = gateway(
        GatewayCustody::SelfHosted,
        runtime_with(&opt_in, std::slice::from_ref(&node_backend)),
        None,
        "ok",
    );
    let (status, _, body) = chat(&g, SENTINEL_HAZARD_S9).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "tenant_policy_blocked");
    assert_eq!(body["error"]["layer"], "node");

    let down =
        Arc::new(TestBackend::new("decision_local").fail_always(BackendError::Unavailable("down")));
    let g = gateway(
        GatewayCustody::SelfHosted,
        runtime_with(&opt_in, std::slice::from_ref(&down)),
        None,
        "ok",
    );
    let (status, _, _) = chat(&g, SENTINEL_HAZARD_S9).await;
    assert_eq!(status, StatusCode::OK);

    let managed = test_backend("decision_local");
    let g = gateway(
        GatewayCustody::ManagedNode,
        runtime_with(&opt_in, std::slice::from_ref(&managed)),
        None,
        "ok",
    );
    let (status, _, _) = chat(&g, SENTINEL_HAZARD_S9).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(managed.calls(), 0);
}

// ── output ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_buffered_output_block_withholds_the_response() {
    let (g, _) = qualified_fleet(&format!("reply {SENTINEL_HAZARD_S9}"));
    let (status, _, body) = chat(&g, "benign question").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "platform_floor_output_blocked");
    assert_eq!(body["error"]["categories"], json!(["S9"]));
    assert!(!body.to_string().contains(SENTINEL_HAZARD_S9));
    // The charge is not known here, so it is not claimed as zero.
    assert!(body["error"].get("charged_micro_usd").is_none());
    assert_eq!(g.calls.load(Ordering::SeqCst), 1);
}

/// SG-13: a stream whose output carries a hard code ends with the
/// output-blocked error frame and never finishes cleanly.
#[tokio::test]
async fn a_stream_window_block_ends_the_stream_with_the_error_frame() {
    let (g, _) = qualified_fleet(SENTINEL_HAZARD_S4);
    let body = json!({
        "model": "fixture-model",
        "stream": true,
        "messages": [{ "role": "user", "content": "benign question" }]
    });
    let (status, _, raw) = send(&g.app, Method::POST, "/v1/chat/completions", Some(&body)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(raw.contains("platform_floor_output_blocked"), "{raw}");
    assert!(raw.contains("\"S4\""));
    assert!(!raw.contains("[DONE]"), "{raw}");
}

#[tokio::test]
async fn a_clean_stream_finishes() {
    let (g, _) = qualified_fleet("all good");
    let body = json!({
        "model": "fixture-model",
        "stream": true,
        "messages": [{ "role": "user", "content": "benign question" }]
    });
    let (status, _, raw) = send(&g.app, Method::POST, "/v1/chat/completions", Some(&body)).await;
    assert_eq!(status, StatusCode::OK);
    assert!(raw.contains("[DONE]"), "{raw}");
    assert!(!raw.contains("platform_floor_output_blocked"));
}

// ── config, status and boot ────────────────────────────────────────────────

#[tokio::test]
async fn a_screening_config_write_is_platform_locked_on_the_fleet() {
    let (g, _) = qualified_fleet("ok");
    let patch = json!({ "screening": { "node_classifiers": true } });
    let (status, _, raw) = send(&g.app, Method::PUT, "/v1/config", Some(&patch)).await;
    let body: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "platform_locked");
}

#[tokio::test]
async fn the_status_route_reports_backends_without_urls_or_keys() {
    let (g, _) = qualified_fleet("ok");
    let (status, _, raw) = send(&g.app, Method::GET, "/v1/screening/status", None).await;
    assert_eq!(status, StatusCode::OK, "{raw}");
    let body: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(body["tier"], "floor");
    assert_eq!(body["mode"], "classified");
    assert_eq!(body["floorScreener"], true);
    assert_eq!(body["backends"][0]["id"], "decision_local");
    assert_eq!(body["backends"][0]["breaker"], "closed");
    assert_eq!(
        body["backends"][0]["qualifiedHardCodes"],
        json!(["S4", "S9"])
    );
    assert!(!raw.contains("http://") && !raw.contains("https://"));
}

#[tokio::test]
async fn an_engine_down_at_boot_opens_its_breaker() {
    let down =
        Arc::new(TestBackend::new("decision_local").fail_always(BackendError::Unavailable("down")));
    let runtime = runtime_with(&Default::default(), std::slice::from_ref(&down));
    runtime.probe_all().await;
    assert_eq!(
        runtime.slot("decision_local").unwrap().breaker_state(),
        breaker::BreakerState::Open
    );
    let traffic = crate::traffic::TrafficBus::new();
    let mut receiver = traffic.subscribe();
    runtime.publish_transitions(&traffic);
    let event = receiver.try_recv().expect("transition published");
    assert_eq!(event["kind"], "screening_degraded");
    assert_eq!(event["breaker"], "open");
}

#[test]
fn the_remote_processor_credential_cannot_be_a_chat_slot_credential() {
    let mut config = GatewayConfig::default();
    let mut jev = ScreeningBackendConfig::of_kind(ScreeningBackendKind::DecisionRemote);
    jev.api_key_env = Some("SCREENER_KEY".to_owned());
    config.screening.backends.insert("jev".to_owned(), jev);
    config.provider_environment = Some(ProviderEnvironment::from_values(BTreeMap::from([(
        "OPENAI_API_KEY".to_owned(),
        "shared-test-credential-1".to_owned(),
    )])));
    let shared =
        |name: &str| (name == "SCREENER_KEY").then(|| "shared-test-credential-1".to_owned());
    let distinct =
        |name: &str| (name == "SCREENER_KEY").then(|| "screener-only-credential".to_owned());
    assert!(check_remote_credentials(&config, &shared).is_err());
    assert!(check_remote_credentials(&config, &distinct).is_ok());
}

#[test]
fn the_degraded_throttle_passes_the_first_request() {
    let runtime = ScreeningRuntime::empty(&crate::config::ScreeningConfig {
        degraded_rpm: 1,
        ..Default::default()
    });
    assert!(runtime.throttle("org-a").is_ok());
    assert!(runtime.throttle("org-a").is_err());
    assert!(runtime.throttle("org-b").is_ok());
}

#[path = "coverage_probe_tests.rs"]
mod coverage_probe_tests;

#[path = "violation_tests.rs"]
mod violation_tests;

#[path = "fleet_config_tests.rs"]
mod fleet_config_tests;
