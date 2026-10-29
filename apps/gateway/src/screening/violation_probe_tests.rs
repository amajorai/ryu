//! Coverage probes for violation events (screener addendum 11.1 and 13.1 G5,
//! spec 00.6 and 03.4). They drive the real router with an `rgw_` tenant key
//! against a mock control plane that resolves a 24-hex tenant org and a
//! credential, then read the outbox: every floor-bound route, buffered and
//! streamed, tool rounds, fallback attempts, cache hits, cross-org caching,
//! backend failures, the remote processor rules and self-hosted custody. The
//! last probe drains the outbox through the reporter to the mock ingest.
//!
//! Each probe first checks the request was decided (the block or flag the
//! response shows), so an empty outbox never passes for a route that was
//! never screened. Content is the spec 00.9 sentinels only.

use ryu_gw_screening::backends::test::SENTINEL_PROMPT_ATTACK;

use super::*;
use crate::audit::{
    EnforcementAction, FailMode, PolicyLayer, SpendOwner, ViolationDirection, ViolationEvent,
};
use crate::identity::{Actor, CredentialIdentity, RequestIdentity, SubjectKind};
use crate::policy::ResolveCache;

const TENANT_A_TOKEN: &str = "rgw_violation_probe_tenant_a_0123456789";
const TENANT_B_TOKEN: &str = "rgw_violation_probe_tenant_b_0123456789";
const ORG_A: &str = "6650c0a1b2c3d4e5f6a7c001";
const ORG_B: &str = "6650c0a1b2c3d4e5f6a7c002";
const CRED_A: &str = "6650c0a1b2c3d4e5f6a7d001";
const CRED_B: &str = "6650c0a1b2c3d4e5f6a7d002";
const REPORTER_KEY: &str = "rgw_violation_probe_reporter";
/// The AWS documentation example key, already a fixture across the repo.
const EXAMPLE_KEY: &str = "AKIAIOSFODNN7EXAMPLE";

// ── harness ────────────────────────────────────────────────────────────────

type Ingested = Arc<std::sync::Mutex<Vec<Value>>>;

struct ControlPlane {
    base: String,
    ingested: Ingested,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for ControlPlane {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Resolves the two tenant tokens to their own 24-hex org and credential,
/// records every abuse ingest body and accepts it, and answers anything else
/// with the smallest body each client accepts.
async fn spawn_control_plane() -> ControlPlane {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("control plane mock binds");
    let base = format!("http://{}", listener.local_addr().expect("mock address"));
    let ingested: Ingested = Arc::default();
    let recorded = Arc::clone(&ingested);
    let router = Router::new()
        .route(
            "/api/control-plane/gateway/resolve",
            get(|headers: HeaderMap| async move {
                use axum::response::IntoResponse;
                let token = headers
                    .get("x-gateway-key")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default();
                let (org, credential) = match token {
                    TENANT_A_TOKEN => (ORG_A, CRED_A),
                    TENANT_B_TOKEN => (ORG_B, CRED_B),
                    _ => return StatusCode::UNAUTHORIZED.into_response(),
                };
                Json(json!({
                    "organization": { "id": org },
                    "credential": {
                        "id": credential,
                        "purpose": "gateway_relay",
                        "allowedOperations": ["gateway.inference"]
                    },
                    "managedInference": false,
                    "standing": { "state": "active", "refuses": "none" },
                    "platformFloorUnavailable": false
                }))
                .into_response()
            }),
        )
        .route(
            "/api/abuse/ingest",
            post(move |Json(body): Json<Value>| {
                let recorded = Arc::clone(&recorded);
                async move {
                    let count = body["events"].as_array().map_or(0, Vec::len);
                    recorded.lock().unwrap().push(body);
                    Json(
                        json!({ "ingested": count, "duplicates": 0, "windows": 0, "rejected": [] }),
                    )
                }
            }),
        )
        .fallback(|| async {
            Json(json!({ "balanceMicroUsd": 900_000, "wentNonPositive": false }))
        });
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    ControlPlane {
        base,
        ingested,
        task,
    }
}

fn install_resolve(state: &mut AppState, control: &ControlPlane) {
    state.resolve_cache = Some(ResolveCache::for_test(
        control.base.clone(),
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("resolve client"),
    ));
}

/// `gateway_with` whose `rgw_` tenants resolve through `control`.
fn tenant_gateway(
    control: &ControlPlane,
    custody: GatewayCustody,
    runtime: ScreeningRuntime,
    floor: Option<Arc<PlatformFloor>>,
    reply: &str,
    configure: impl FnOnce(&mut GatewayConfig),
    register: impl FnOnce(&mut AppState),
) -> Gateway {
    gateway_with(custody, runtime, floor, reply, configure, |state| {
        install_resolve(state, control);
        register(state);
    })
}

fn tenant_fleet(control: &ControlPlane, reply: &str) -> (Gateway, Arc<TestBackend>) {
    let backend = test_backend("decision_local");
    let g = tenant_gateway(
        control,
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), std::slice::from_ref(&backend)),
        Some(qualified_floor(3)),
        reply,
        |_| {},
        |_| {},
    );
    (g, backend)
}

async fn tenant_send(
    g: &Gateway,
    token: &str,
    uri: &str,
    body: &Value,
) -> (StatusCode, HeaderMap, String) {
    send_with(&g.app, Method::POST, uri, token, &[], Some(body)).await
}

fn outbox(g: &Gateway) -> Vec<ViolationEvent> {
    g.state.violations.all_events().expect("outbox reads")
}

fn since(g: &Gateway, before: usize) -> Vec<ViolationEvent> {
    outbox(g).into_iter().skip(before).collect()
}

fn describe(events: &[ViolationEvent]) -> String {
    events
        .iter()
        .map(|e| {
            format!(
                "[{} {:?} {:?} {} route={} attempt={}]",
                e.category, e.action, e.direction, e.detector.id, e.route, e.attempt
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// What a tenant event on a floor-bound attempt must carry.
fn tenant_misses(case: &str, event: &ViolationEvent, org: &str, credential: &str) -> Vec<String> {
    let mut misses = Vec::new();
    if event.org_id.as_deref() != Some(org) {
        misses.push(format!("{case}: orgId {:?}", event.org_id));
    }
    if event.credential_id.as_deref() != Some(credential) {
        misses.push(format!("{case}: credentialId {:?}", event.credential_id));
    }
    if event.spend != SpendOwner::Ryu {
        misses.push(format!("{case}: spend {:?}", event.spend));
    }
    if event.policy.as_ref().map(|p| p.layer) != Some(PolicyLayer::Platform) {
        misses.push(format!("{case}: layer {:?}", event.policy));
    }
    if event.route.is_empty() || event.route == "unknown" {
        misses.push(format!("{case}: route {:?}", event.route));
    }
    let key = format!(
        "{}:{}:{}:{}",
        event.request_id, event.attempt, event.detector.id, event.category
    );
    if event.dedupe_key != key {
        misses.push(format!("{case}: dedupeKey {} != {key}", event.dedupe_key));
    }
    misses
}

/// A tenant request context for `org` and `credential`.
fn ctx_of(request_id: &str, org: &str, credential: &str) -> crate::pipeline::RequestContext {
    let mut ctx = plain_ctx();
    ctx.request_id = request_id.to_owned();
    ctx.org_id = Some(org.to_owned());
    let credential_identity = Arc::new(CredentialIdentity {
        credential_id: credential.to_owned(),
        node_id: None,
        team_id: None,
        owner_user_id: None,
        created_by: None,
        service_account_id: None,
        serves_end_users: false,
        purpose: "gateway_relay".to_owned(),
    });
    let mut identity = RequestIdentity::from_credential(Some(credential_identity), 1);
    identity.actor = Actor {
        kind: SubjectKind::Credential,
        subject_ref: credential.to_owned(),
    };
    ctx.identity = Some(Arc::new(identity));
    ctx
}

fn chat_json(text: &str, stream: bool) -> Value {
    json!({ "model": "fixture-model", "stream": stream,
            "messages": [{ "role": "user", "content": text }] })
}

/// Every floor-bound inbound route, with `text` where the user text goes.
fn inbound_routes(text: &str) -> Vec<(&'static str, String, Value)> {
    let anthropic = |stream: bool| {
        json!({ "model": "fixture-model", "max_tokens": 16, "stream": stream,
                "messages": [{ "role": "user", "content": text }] })
    };
    let gemini = json!({ "contents": [{ "role": "user", "parts": [{ "text": text }] }] });
    let responses =
        |stream: bool| json!({ "model": "fixture-model", "input": text, "stream": stream });
    vec![
        (
            "chat buffered",
            "/v1/chat/completions".to_owned(),
            chat_json(text, false),
        ),
        (
            "chat stream",
            "/v1/chat/completions".to_owned(),
            chat_json(text, true),
        ),
        (
            "cursor alias",
            "/v1/cursor/chat/completions".to_owned(),
            chat_json(text, false),
        ),
        (
            "anthropic messages",
            "/v1/messages".to_owned(),
            anthropic(false),
        ),
        (
            "anthropic messages stream",
            "/v1/messages".to_owned(),
            anthropic(true),
        ),
        (
            "gemini generateContent",
            "/v1beta/models/fixture-model:generateContent".to_owned(),
            gemini.clone(),
        ),
        (
            "gemini streamGenerateContent",
            "/v1beta/models/fixture-model:streamGenerateContent?alt=sse".to_owned(),
            gemini,
        ),
        ("responses", "/v1/responses".to_owned(), responses(false)),
        (
            "responses stream",
            "/v1/responses".to_owned(),
            responses(true),
        ),
        (
            "embeddings",
            "/v1/embeddings".to_owned(),
            json!({ "model": "fixture-model", "input": text }),
        ),
        (
            "image generation prompt",
            "/v1/images/generations".to_owned(),
            json!({ "model": "fixture-model", "prompt": text }),
        ),
        (
            "speech input",
            "/v1/audio/speech".to_owned(),
            json!({ "model": "fixture-model", "input": text, "voice": "alloy" }),
        ),
    ]
}

/// The chat and compat routes, benign input, buffered or streamed.
fn output_routes(stream: bool) -> Vec<(&'static str, String, Value)> {
    let mut routes = compat_routes(stream);
    routes.insert(
        0,
        (
            "chat",
            "/v1/chat/completions".to_owned(),
            chat_json("benign question", stream),
        ),
    );
    routes
}

// ── the tenant harness itself ───────────────────────────────────────────────

/// The `rgw_` path resolves the tenant org and credential, and the installed
/// floor survives a resolve that carries none.
#[tokio::test]
async fn probe_violation_an_rgw_tenant_block_names_the_tenant_org_and_credential() {
    let control = spawn_control_plane().await;
    let (g, _) = tenant_fleet(&control, "ok");
    let (status, _, raw) = tenant_send(
        &g,
        TENANT_A_TOKEN,
        "/v1/chat/completions",
        &chat_json(&format!("{SENTINEL_HAZARD_S9} probe"), false),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{}", short(&raw));
    assert!(raw.contains("platform_floor_blocked"), "{}", short(&raw));
    assert_eq!(g.calls.load(Ordering::SeqCst), 0);
    let events = outbox(&g);
    assert_eq!(events.len(), 1, "{}", describe(&events));
    let event = &events[0];
    let misses = tenant_misses("chat", event, ORG_A, CRED_A);
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
    assert_eq!(event.category, "hazard.S9");
    assert_eq!(event.action, EnforcementAction::Blocked);
    assert_eq!(event.direction, ViolationDirection::Inbound);
    assert_eq!(event.fail_mode, FailMode::ClassifierOk);
}

// ── every floor-bound route ─────────────────────────────────────────────────

/// An inbound hard code on every floor-bound route records exactly one
/// tenant event for its request, with the route it came in on.
#[tokio::test]
async fn probe_violation_inbound_blocks_record_one_tenant_event_on_every_route() {
    let control = spawn_control_plane().await;
    let (g, _) = tenant_fleet(&control, "ok");
    let mut misses = Vec::new();
    for (case, uri, body) in inbound_routes(&format!("{SENTINEL_HAZARD_S9} route probe")) {
        let before = outbox(&g).len();
        let (status, _, raw) = tenant_send(&g, TENANT_A_TOKEN, &uri, &body).await;
        if !raw.contains("platform_floor_blocked") {
            misses.push(format!(
                "{case}: not decided by the floor: {status} {}",
                short(&raw)
            ));
            continue;
        }
        let fresh = since(&g, before);
        let s9: Vec<&ViolationEvent> = fresh.iter().filter(|e| e.category == "hazard.S9").collect();
        if s9.len() != 1 {
            misses.push(format!(
                "{case}: {} S9 events: {}",
                s9.len(),
                describe(&fresh)
            ));
            continue;
        }
        let event = s9[0];
        misses.extend(tenant_misses(case, event, ORG_A, CRED_A));
        if event.action != EnforcementAction::Blocked
            || event.direction != ViolationDirection::Inbound
        {
            misses.push(format!("{case}: {:?} {:?}", event.action, event.direction));
        }
    }
    assert_eq!(
        g.calls.load(Ordering::SeqCst),
        0,
        "a blocked request reached the provider"
    );
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

/// A buffered output block records one outbound tenant event on the chat
/// route and every compat dialect.
#[tokio::test]
async fn probe_violation_buffered_output_blocks_record_outbound_events_on_every_dialect() {
    let control = spawn_control_plane().await;
    let (g, _) = tenant_fleet(&control, &format!("reply {SENTINEL_HAZARD_S9}"));
    let mut misses = Vec::new();
    for (case, uri, body) in output_routes(false) {
        let before = outbox(&g).len();
        let (status, _, raw) = tenant_send(&g, TENANT_A_TOKEN, &uri, &body).await;
        if !raw.contains("platform_floor_output_blocked") {
            misses.push(format!("{case}: not decided: {status} {}", short(&raw)));
            continue;
        }
        let fresh = since(&g, before);
        if fresh.len() != 1 {
            misses.push(format!(
                "{case}: {} events: {}",
                fresh.len(),
                describe(&fresh)
            ));
            continue;
        }
        let event = &fresh[0];
        misses.extend(tenant_misses(case, event, ORG_A, CRED_A));
        if event.category != "hazard.S9"
            || event.action != EnforcementAction::Blocked
            || event.direction != ViolationDirection::Outbound
        {
            misses.push(format!("{case}: {}", describe(&fresh)));
        }
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

/// A stream cut records `stream_terminated` outbound for the tenant on every
/// dialect, with the route stamped even though the cut happens after the
/// handler returned, and never an excerpt (S4).
#[tokio::test]
async fn probe_violation_stream_cuts_record_stream_terminated_on_every_dialect() {
    let control = spawn_control_plane().await;
    let (g, _) = tenant_fleet(&control, SENTINEL_HAZARD_S4);
    let mut misses = Vec::new();
    for (case, uri, body) in output_routes(true) {
        let before = outbox(&g).len();
        let (status, _, raw) = tenant_send(&g, TENANT_A_TOKEN, &uri, &body).await;
        if !raw.contains("platform_floor_output_blocked") {
            misses.push(format!("{case}: not decided: {status} {}", short(&raw)));
            continue;
        }
        let fresh = since(&g, before);
        let s4: Vec<&ViolationEvent> = fresh.iter().filter(|e| e.category == "hazard.S4").collect();
        if s4.len() != 1 {
            misses.push(format!(
                "{case}: {} S4 events: {}",
                s4.len(),
                describe(&fresh)
            ));
            continue;
        }
        let event = s4[0];
        misses.extend(tenant_misses(case, event, ORG_A, CRED_A));
        if event.action != EnforcementAction::StreamTerminated
            || event.direction != ViolationDirection::Outbound
        {
            misses.push(format!("{case}: {:?} {:?}", event.action, event.direction));
        }
        if g.state.violations.has_excerpt(&event.event_id).unwrap() {
            misses.push(format!("{case}: S4 kept an excerpt"));
        }
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

/// A prompt-attack sentinel is the `security.prompt_injection` code, decided
/// by the prompt-attack role, on the tenant's event.
#[tokio::test]
async fn probe_violation_a_prompt_attack_records_a_prompt_injection_event() {
    let control = spawn_control_plane().await;
    let (g, _) = tenant_fleet(&control, "ok");
    let (status, _, raw) = tenant_send(
        &g,
        TENANT_A_TOKEN,
        "/v1/chat/completions",
        &chat_json(&format!("{SENTINEL_PROMPT_ATTACK} probe"), false),
    )
    .await;
    let events = outbox(&g);
    let attack: Vec<&ViolationEvent> = events
        .iter()
        .filter(|e| e.category == "security.prompt_injection")
        .collect();
    assert_eq!(
        attack.len(),
        1,
        "{status} {}: {}",
        short(&raw),
        describe(&events)
    );
    let misses = tenant_misses("prompt attack", attack[0], ORG_A, CRED_A);
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

// ── /v1/providers/call ──────────────────────────────────────────────────────

fn provider_call(body: Value) -> crate::connections::ConnectionCall {
    serde_json::from_value(json!({
        "provider": "treg",
        "toolId": "x.post.create",
        "operation": "execute",
        "method": "POST",
        "query": [],
        "body": body,
        "requestId": "req-provider-call-probe",
    }))
    .expect("connection call parses")
}

/// The managed provider call's hazard screen records a tool-args event for
/// the tenant. Called at the guard (the route needs a trusted forwarder and a
/// live connection provider); the route runs exactly this function.
#[tokio::test]
async fn probe_violation_a_provider_call_hazard_records_a_tool_args_event() {
    let (g, _) = qualified_fleet("ok");
    let ctx = ctx_of("req-provider-call-s9", ORG_A, CRED_A);
    let call = provider_call(json!({ "text": format!("{SENTINEL_HAZARD_S9} post") }));
    let result = crate::pipeline::provider_call_guard::screen_hazard(&g.state, &ctx, &call).await;
    assert!(
        matches!(result, Err(GatewayError::ContentBlocked(_))),
        "{result:?}"
    );
    let events = outbox(&g);
    assert_eq!(events.len(), 1, "{}", describe(&events));
    let event = &events[0];
    assert_eq!(event.category, "hazard.S9");
    assert_eq!(event.org_id.as_deref(), Some(ORG_A));
    assert_eq!(event.credential_id.as_deref(), Some(CRED_A));
    assert_eq!(event.direction, ViolationDirection::ToolArgs);
    assert_eq!(event.action, EnforcementAction::Blocked);
}

/// The provider call's regex floor screen records its own regex event.
#[tokio::test]
async fn probe_violation_a_provider_call_regex_floor_block_records_an_event() {
    let (g, _) = qualified_fleet("ok");
    let ctx = ctx_of("req-provider-call-lexicon", ORG_A, CRED_A);
    let call = provider_call(json!({ "text": format!("{SENTINEL_LEXICON} post") }));
    let result = crate::pipeline::provider_call_guard::screen(&g.state, &ctx, &call);
    assert!(result.is_err(), "the floor lexicon was not refused");
    let events = outbox(&g);
    assert!(
        events
            .iter()
            .any(|e| e.org_id.as_deref() == Some(ORG_A) && e.action == EnforcementAction::Blocked),
        "a provider call regex block left no event: {}",
        describe(&events)
    );
}

// ── tool rounds ─────────────────────────────────────────────────────────────

/// `tool_loop_gateway` with tenant resolution.
fn tenant_tool_loop(
    control: &ControlPlane,
    core: &CoreMock,
    arguments: &str,
) -> (Gateway, Arc<AtomicUsize>) {
    let rounds = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&rounds);
    let base = core.base.clone();
    let arguments = arguments.to_owned();
    let g = tenant_gateway(
        control,
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), &[test_backend("decision_local")]),
        Some(qualified_floor(3)),
        "unused",
        |config| config.tools.enabled = true,
        move |state| {
            state.tools = Some(ToolSearchClient::new(
                &CoreProviderConfig {
                    base_url: base,
                    token: None,
                },
                reqwest::Client::builder()
                    .no_proxy()
                    .build()
                    .expect("core client"),
            ));
            state
                .provider_runtime
                .register_for_test(Arc::new(ToolRounds {
                    calls: counted,
                    arguments,
                }));
        },
    );
    (g, rounds)
}

async fn tool_loop_send(g: &Gateway, text: &str) -> (StatusCode, String) {
    let (status, _, raw) = send_with(
        &g.app,
        Method::POST,
        "/v1/chat/completions",
        TENANT_A_TOKEN,
        &[("x-ryu-tools", UNIFIED_TOOL)],
        Some(
            &json!({ "model": "fixture-model", "messages": [{ "role": "user", "content": text }] }),
        ),
    )
    .await;
    (status, raw)
}

#[tokio::test]
async fn probe_violation_a_tool_result_block_records_a_tool_result_event() {
    let control = spawn_control_plane().await;
    let core = spawn_core(json!({ "result": format!("{SENTINEL_HAZARD_S9} tool probe") })).await;
    let (g, _) = tenant_tool_loop(&control, &core, "{\"query\":\"weather\"}");
    let (status, raw) = tool_loop_send(&g, "benign tool loop question").await;
    assert_eq!(
        core.executions.load(Ordering::SeqCst),
        1,
        "{status} {}",
        short(&raw)
    );
    assert!(
        raw.contains("platform_floor_blocked"),
        "{status} {}",
        short(&raw)
    );
    let events = outbox(&g);
    let s9: Vec<&ViolationEvent> = events
        .iter()
        .filter(|e| e.category == "hazard.S9")
        .collect();
    assert_eq!(s9.len(), 1, "{}", describe(&events));
    let mut misses = tenant_misses("tool result", s9[0], ORG_A, CRED_A);
    if s9[0].direction != ViolationDirection::ToolResult {
        misses.push(format!("tool result: direction {:?}", s9[0].direction));
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

/// The model's own tool call arguments are `tool_args` (spec 03.4.2), not a
/// tool result.
#[tokio::test]
async fn probe_violation_a_tool_args_block_records_a_tool_args_event() {
    let control = spawn_control_plane().await;
    let core = spawn_core(json!({ "result": "sunny" })).await;
    let (g, _) = tenant_tool_loop(
        &control,
        &core,
        &format!("{{\"query\":\"{SENTINEL_HAZARD_S9} lookup\"}}"),
    );
    let (status, raw) = tool_loop_send(&g, "benign tool loop question").await;
    assert!(
        raw.contains("platform_floor_blocked"),
        "{status} {}",
        short(&raw)
    );
    assert_eq!(core.executions.load(Ordering::SeqCst), 0, "the tool ran");
    let events = outbox(&g);
    let s9: Vec<&ViolationEvent> = events
        .iter()
        .filter(|e| e.category == "hazard.S9")
        .collect();
    assert_eq!(s9.len(), 1, "{}", describe(&events));
    let mut misses = tenant_misses("tool args", s9[0], ORG_A, CRED_A);
    if s9[0].direction != ViolationDirection::ToolArgs {
        misses.push(format!("tool args: direction {:?}", s9[0].direction));
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

/// Spec 00.5: `attempt` is 0 for the primary and 1.. for a fallback or tool
/// round. A tool result flagged for the same code as the prompt is its own
/// detection, not a duplicate of the inbound one.
#[tokio::test]
async fn probe_violation_a_tool_round_flag_is_its_own_attempt() {
    let control = spawn_control_plane().await;
    let core = spawn_core(json!({ "result": format!("{SENTINEL_HAZARD_S1} tool probe") })).await;
    let (g, rounds) = tenant_tool_loop(&control, &core, "{\"query\":\"weather\"}");
    let (status, raw) = tool_loop_send(&g, &format!("{SENTINEL_HAZARD_S1} question")).await;
    assert_eq!(status, StatusCode::OK, "{}", short(&raw));
    assert_eq!(core.executions.load(Ordering::SeqCst), 1);
    assert!(
        rounds.load(Ordering::SeqCst) >= 2,
        "the tool result never reached a round"
    );
    let events = outbox(&g);
    let s1: Vec<&ViolationEvent> = events
        .iter()
        .filter(|e| e.category == "hazard.S1")
        .collect();
    assert!(
        s1.iter()
            .any(|e| e.direction == ViolationDirection::Inbound && e.attempt == 0),
        "{}",
        describe(&events)
    );
    assert!(
        s1.iter()
            .any(|e| e.direction == ViolationDirection::ToolResult && e.attempt >= 1),
        "the tool-round flag collapsed into the inbound event: {}",
        describe(&events)
    );
}

// ── fallback attempts ───────────────────────────────────────────────────────

struct TenantPair {
    gateway: Gateway,
    spare: Arc<AtomicUsize>,
}

/// `fallback_pair` with tenant resolution: `PRIMARY` fails like an outage,
/// `SPARE` answers `spare_reply`.
fn tenant_fallback(control: &ControlPlane, spare_reply: &str) -> TenantPair {
    let primary = Arc::new(AtomicUsize::new(0));
    let spare = Arc::new(AtomicUsize::new(0));
    let (p, s) = (Arc::clone(&primary), Arc::clone(&spare));
    let spare_reply = spare_reply.to_owned();
    let gateway = tenant_gateway(
        control,
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), &[test_backend("decision_local")]),
        Some(qualified_floor(3)),
        "unused",
        |config| {
            config.routing.default_provider = ProviderId::from(PRIMARY);
            config.routing.fallback_chain =
                vec![ProviderId::from(PRIMARY), ProviderId::from(SPARE)];
        },
        move |state| {
            state.provider_runtime.register_for_test(Arc::new(Named {
                name: PRIMARY,
                calls: p,
                reply: None,
            }));
            state.provider_runtime.register_for_test(Arc::new(Named {
                name: SPARE,
                calls: s,
                reply: Some(spare_reply),
            }));
        },
    );
    TenantPair { gateway, spare }
}

/// SG-17 through the router: an inbound flag on a request that falls back is
/// one event, and the spare's output block is one more, for the tenant.
#[tokio::test]
async fn probe_violation_a_fallback_request_records_one_flag_and_the_spare_block() {
    let control = spawn_control_plane().await;
    let pair = tenant_fallback(&control, &format!("reply {SENTINEL_HAZARD_S9}"));
    let (status, _, raw) = tenant_send(
        &pair.gateway,
        TENANT_A_TOKEN,
        "/v1/chat/completions",
        &chat_json(&format!("{SENTINEL_HAZARD_S1} fallback probe"), false),
    )
    .await;
    assert_eq!(
        pair.spare.load(Ordering::SeqCst),
        1,
        "no fallback: {status} {}",
        short(&raw)
    );
    assert!(
        raw.contains("platform_floor_output_blocked"),
        "{status} {}",
        short(&raw)
    );
    let events = outbox(&pair.gateway);
    let s1: Vec<&ViolationEvent> = events
        .iter()
        .filter(|e| e.category == "hazard.S1")
        .collect();
    let s9: Vec<&ViolationEvent> = events
        .iter()
        .filter(|e| e.category == "hazard.S9")
        .collect();
    assert_eq!(s1.len(), 1, "{}", describe(&events));
    assert_eq!(s9.len(), 1, "{}", describe(&events));
    let mut misses = tenant_misses("fallback flag", s1[0], ORG_A, CRED_A);
    misses.extend(tenant_misses("fallback block", s9[0], ORG_A, CRED_A));
    assert_eq!(s1[0].action, EnforcementAction::LoggedOnly);
    assert_eq!(s9[0].direction, ViolationDirection::Outbound);
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

/// Spec 00.5 and 00.6: the spare's output block is the fallback attempt
/// (attempt 1), and the event names the provider that attempt was bound to.
#[tokio::test]
async fn probe_violation_the_spare_output_block_names_the_fallback_attempt() {
    let control = spawn_control_plane().await;
    let pair = tenant_fallback(&control, &format!("reply {SENTINEL_HAZARD_S9}"));
    let (status, _, raw) = tenant_send(
        &pair.gateway,
        TENANT_A_TOKEN,
        "/v1/chat/completions",
        &chat_json("benign fallback probe", false),
    )
    .await;
    assert_eq!(
        pair.spare.load(Ordering::SeqCst),
        1,
        "no fallback: {status} {}",
        short(&raw)
    );
    assert!(
        raw.contains("platform_floor_output_blocked"),
        "{status} {}",
        short(&raw)
    );
    let events = outbox(&pair.gateway);
    assert_eq!(events.len(), 1, "{}", describe(&events));
    let event = &events[0];
    let mut misses = Vec::new();
    if event.attempt < 1 {
        misses.push(format!(
            "attempt {} for the fallback attempt",
            event.attempt
        ));
    }
    if event.provider.as_deref() != Some(SPARE) {
        misses.push(format!(
            "provider {:?}, the attempt ran on {SPARE}",
            event.provider
        ));
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

// ── cache hits ──────────────────────────────────────────────────────────────

/// A segment cache hit on a NEW request is still a verdict for that request:
/// the backend is not asked again, but the request gets its own event.
#[tokio::test]
async fn probe_violation_a_segment_cache_hit_on_a_new_request_records_its_own_event() {
    let (g, backend) = qualified_fleet("ok");
    let body = chat_body(&format!("{SENTINEL_HAZARD_S9} cached probe"));
    let first = screen_chat(
        &g.state,
        &ctx_of("req-cache-1", ORG_A, CRED_A),
        &body,
        Surface::Chat,
    )
    .await;
    assert!(
        matches!(first, Err(GatewayError::ContentBlocked(_))),
        "{first:?}"
    );
    let after_first = backend.calls();
    let second = screen_chat(
        &g.state,
        &ctx_of("req-cache-2", ORG_A, CRED_A),
        &body,
        Surface::Chat,
    )
    .await;
    assert!(
        matches!(second, Err(GatewayError::ContentBlocked(_))),
        "{second:?}"
    );
    assert_eq!(
        backend.calls(),
        after_first,
        "the segment cache did not answer"
    );
    let events = outbox(&g);
    let requests: std::collections::BTreeSet<&str> =
        events.iter().map(|e| e.request_id.as_str()).collect();
    assert_eq!(
        requests,
        ["req-cache-1", "req-cache-2"].into_iter().collect(),
        "{}",
        describe(&events)
    );
}

/// The response cache answers a request the degraded row let through; once a
/// qualified backend is back the cached reply is blocked at output, and that
/// block is an outbound tenant event.
#[tokio::test]
async fn probe_violation_a_response_cache_hit_output_block_records_an_event() {
    let control = spawn_control_plane().await;
    let g = tenant_gateway(
        &control,
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), &[test_backend("decision_local")]),
        Some(floor(
            3,
            Some(screener_json(&["decision_local"], false, json!({}))),
        )),
        &format!("reply {SENTINEL_HAZARD_S9}"),
        |config| config.cache.enabled = true,
        |_| {},
    );
    let body = chat_json("benign cache probe", false);
    let (status, _, raw) = tenant_send(&g, TENANT_A_TOKEN, "/v1/chat/completions", &body).await;
    assert_eq!(status, StatusCode::OK, "{}", short(&raw));
    let (status, _, _) = tenant_send(&g, TENANT_A_TOKEN, "/v1/chat/completions", &body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        g.calls.load(Ordering::SeqCst),
        1,
        "the response cache did not answer"
    );

    assert!(g.state.platform_floor.observe(Some(&qualified_floor(4))));
    let before = outbox(&g).len();
    let (status, _, raw) = tenant_send(&g, TENANT_A_TOKEN, "/v1/chat/completions", &body).await;
    assert!(
        raw.contains("platform_floor_output_blocked"),
        "{status} {}",
        short(&raw)
    );
    assert_eq!(g.calls.load(Ordering::SeqCst), 1);
    let fresh = since(&g, before);
    assert_eq!(fresh.len(), 1, "{}", describe(&fresh));
    let mut misses = tenant_misses("response cache hit", &fresh[0], ORG_A, CRED_A);
    if fresh[0].direction != ViolationDirection::Outbound {
        misses.push(format!("direction {:?}", fresh[0].direction));
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

/// Cache poisoning across orgs: one org's screen never attributes, suppresses
/// or invents another org's event, through the router with two tenant keys.
#[tokio::test]
async fn probe_violation_events_never_cross_orgs_through_the_cache() {
    let control = spawn_control_plane().await;
    let (g, _) = tenant_fleet(&control, "ok");
    let hazard = chat_json(&format!("{SENTINEL_HAZARD_S9} shared text"), false);
    let (status, _, raw) = tenant_send(&g, TENANT_A_TOKEN, "/v1/chat/completions", &hazard).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{}", short(&raw));
    let (status, _, raw) = tenant_send(&g, TENANT_B_TOKEN, "/v1/chat/completions", &hazard).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{}", short(&raw));
    let events = outbox(&g);
    assert_eq!(events.len(), 2, "{}", describe(&events));
    let mut misses = Vec::new();
    let a: Vec<&ViolationEvent> = events
        .iter()
        .filter(|e| e.org_id.as_deref() == Some(ORG_A))
        .collect();
    let b: Vec<&ViolationEvent> = events
        .iter()
        .filter(|e| e.org_id.as_deref() == Some(ORG_B))
        .collect();
    if a.len() != 1 || b.len() != 1 {
        misses.push(format!(
            "per-org counts a={} b={}: {}",
            a.len(),
            b.len(),
            describe(&events)
        ));
    } else {
        misses.extend(tenant_misses("org a", a[0], ORG_A, CRED_A));
        misses.extend(tenant_misses("org b", b[0], ORG_B, CRED_B));
        if a[0].dedupe_key == b[0].dedupe_key {
            misses.push("org a and org b share a dedupe key".to_owned());
        }
    }
    // A benign request from org b after org a's hazard adds nothing.
    let before = outbox(&g).len();
    let (status, _, raw) = tenant_send(
        &g,
        TENANT_B_TOKEN,
        "/v1/chat/completions",
        &chat_json("benign shared text", false),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", short(&raw));
    if !since(&g, before).is_empty() {
        misses.push(format!("org b benign: {}", describe(&since(&g, before))));
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

// ── backend timeout, outage and garbage ─────────────────────────────────────

/// A backend that answers garbage, times out or fails is not a verdict: the
/// request is refused with 503 and no event is recorded.
#[tokio::test]
async fn probe_violation_backend_failures_record_no_event() {
    let control = spawn_control_plane().await;
    let cases: Vec<(
        &str,
        Box<dyn Fn(&mut ryu_gw_screening::testing::MockBehaviour)>,
        Value,
    )> = vec![
        (
            "garbage",
            Box::new(|b| b.raw_body = Some("this is not a systemone answer".into())),
            json!({}),
        ),
        (
            "timeout",
            Box::new(|b| b.delay = Some(Duration::from_secs(3))),
            json!({ "deadlinesMs": { "chat": 200 } }),
        ),
        ("engine 5xx", Box::new(|b| b.status = Some(500)), json!({})),
    ];
    let mut misses = Vec::new();
    for (case, behaviour, extra) in cases {
        let mock = MockServer::systemone().await;
        mock.set(|b| behaviour(b));
        let g = tenant_gateway(
            &control,
            GatewayCustody::Fleet,
            systemone_runtime(&mock, &Default::default()),
            Some(floor(
                3,
                Some(screener_json(&["decision_local"], true, extra)),
            )),
            "ok",
            |_| {},
            |_| {},
        );
        // The first failure is refused with 503. What later requests get once
        // the breaker opens is the screener's fail-mode contract, probed in
        // `coverage_probe_tests`; here only the outbox is checked for them.
        for (index, text) in [SENTINEL_HAZARD_S9, SENTINEL_HAZARD_S4]
            .into_iter()
            .enumerate()
        {
            let (status, _, raw) = tenant_send(
                &g,
                TENANT_A_TOKEN,
                "/v1/chat/completions",
                &chat_json(text, false),
            )
            .await;
            if index == 0 && status != StatusCode::SERVICE_UNAVAILABLE {
                misses.push(format!("{case} {text}: {status} {}", short(&raw)));
            }
        }
        assert!(mock.calls() >= 1, "{case}: the mock was never asked");
        let events = outbox(&g);
        if !events.is_empty() {
            misses.push(format!("{case}: {}", describe(&events)));
        }
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

/// The healthy twin: the same wire with a good answer records the event, so
/// the empty outbox above is the failure handling, not a dead mock.
#[tokio::test]
async fn probe_violation_a_healthy_systemone_records_the_event() {
    let control = spawn_control_plane().await;
    let mock = MockServer::systemone().await;
    let g = tenant_gateway(
        &control,
        GatewayCustody::Fleet,
        systemone_runtime(&mock, &Default::default()),
        Some(qualified_floor(3)),
        "ok",
        |_| {},
        |_| {},
    );
    let (status, _, raw) = tenant_send(
        &g,
        TENANT_A_TOKEN,
        "/v1/chat/completions",
        &chat_json(SENTINEL_HAZARD_S9, false),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{}", short(&raw));
    let events = outbox(&g);
    assert_eq!(events.len(), 1, "{}", describe(&events));
    let misses = tenant_misses("systemone", &events[0], ORG_A, CRED_A);
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

/// Addendum 11.1: while the classifier is down and the regex floor decides,
/// the event's `failMode` is `classifier_unavailable_regex_floor`.
#[tokio::test]
async fn probe_violation_the_degraded_regex_floor_event_names_its_fail_mode() {
    let control = spawn_control_plane().await;
    let down =
        Arc::new(TestBackend::new("decision_local").fail_always(BackendError::Unavailable("down")));
    let g = tenant_gateway(
        &control,
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), std::slice::from_ref(&down)),
        Some(qualified_floor(3)),
        "ok",
        |_| {},
        |_| {},
    );
    // Open the breaker so the degraded row decides.
    let mut degraded = false;
    for attempt in 0..10 {
        let (status, _, _) = tenant_send(
            &g,
            TENANT_A_TOKEN,
            "/v1/chat/completions",
            &chat_json(&format!("benign outage probe {attempt}"), false),
        )
        .await;
        if status == StatusCode::OK {
            degraded = true;
            break;
        }
    }
    assert!(degraded, "the outage never reached the degraded row");
    let before = outbox(&g).len();
    let (status, _, raw) = tenant_send(
        &g,
        TENANT_A_TOKEN,
        "/v1/chat/completions",
        &chat_json(&format!("{SENTINEL_LEXICON} outage probe"), false),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{}", short(&raw));
    let fresh = since(&g, before);
    assert_eq!(fresh.len(), 1, "{}", describe(&fresh));
    let mut misses = tenant_misses("regex floor", &fresh[0], ORG_A, CRED_A);
    if fresh[0].fail_mode != FailMode::ClassifierUnavailableRegexFloor {
        misses.push(format!("failMode {:?}", fresh[0].fail_mode));
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

// ── remote processors ───────────────────────────────────────────────────────

/// Without an approved retention record Jev sees no floor traffic, so no
/// event names a processor.
#[tokio::test]
async fn probe_violation_jev_without_a_record_names_no_processor() {
    let mock = MockServer::systemone().await;
    let permit = RemotePermit::new();
    permit.set_node_opt_in(true);
    let g = fleet_with_jev(
        &mock,
        permit,
        screener_json(&["decision_local", "jev"], true, json!({})),
    );
    let _ = chat(&g, SENTINEL_HAZARD_S1).await;
    let _ = chat(&g, SENTINEL_HAZARD_S9).await;
    assert_eq!(mock.calls(), 0);
    let events = outbox(&g);
    assert!(
        events.iter().all(|e| e.processor_id.is_none()),
        "{}",
        describe(&events)
    );
}

/// SG-7: with an approved record the event carries `processorId`.
#[tokio::test]
async fn probe_violation_jev_with_an_approved_record_names_the_processor() {
    let mock = MockServer::systemone().await;
    let g = gateway(
        GatewayCustody::Fleet,
        jev_runtime(&mock),
        Some(floor(3, Some(screener_json(&["jev"], false, record())))),
        "ok",
    );
    let report = screen_chat(
        &g.state,
        &ctx_of("req-jev-record", ORG_A, CRED_A),
        &chat_body(SENTINEL_HAZARD_S1),
        Surface::Chat,
    )
    .await
    .expect("a flag passes");
    assert_eq!(report.processors, vec!["typesafe".to_owned()]);
    let events = outbox(&g);
    assert_eq!(events.len(), 1, "{}", describe(&events));
    assert_eq!(events[0].processor_id.as_deref(), Some("typesafe"));
    assert_eq!(events[0].org_id.as_deref(), Some(ORG_A));
    let wire = serde_json::to_string(&events[0]).unwrap();
    assert!(
        !wire.contains(&mock.base_url),
        "a processor URL left in the event"
    );
}

// ── self-hosted custody ─────────────────────────────────────────────────────

/// A self-hosted node is never bound by Ryu's floor: without the opt-in a
/// floor stored on it records no event for a hazard or the floor lexicon.
#[tokio::test]
async fn probe_violation_self_hosted_without_opt_in_records_no_floor_event() {
    let control = spawn_control_plane().await;
    let backend = test_backend("decision_local");
    let g = tenant_gateway(
        &control,
        GatewayCustody::SelfHosted,
        runtime_with(&Default::default(), std::slice::from_ref(&backend)),
        Some(qualified_floor(3)),
        "ok",
        |_| {},
        |_| {},
    );
    for text in [SENTINEL_HAZARD_S9, SENTINEL_HAZARD_S4, SENTINEL_LEXICON] {
        let (status, _, raw) = tenant_send(
            &g,
            TENANT_A_TOKEN,
            "/v1/chat/completions",
            &chat_json(&format!("{text} self-hosted"), false),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{text}: {}", short(&raw));
    }
    assert_eq!(backend.calls(), 0);
    let events = outbox(&g);
    assert!(
        events
            .iter()
            .all(|e| e.policy.as_ref().map(|p| p.layer) != Some(PolicyLayer::Platform)),
        "{}",
        describe(&events)
    );
    assert!(events.is_empty(), "{}", describe(&events));
}

/// With the node opt-in its events are node-tier tenant spend and keep no
/// excerpt, so no screened text leaves the node for them.
#[tokio::test]
async fn probe_violation_self_hosted_opt_in_events_are_node_tier_tenant_spend() {
    let control = spawn_control_plane().await;
    let opt_in = crate::config::ScreeningConfig {
        node_classifiers: true,
        ..Default::default()
    };
    let g = tenant_gateway(
        &control,
        GatewayCustody::SelfHosted,
        runtime_with(&opt_in, &[test_backend("decision_local")]),
        Some(qualified_floor(3)),
        "ok",
        |_| {},
        |_| {},
    );
    let (status, _, raw) = tenant_send(
        &g,
        TENANT_A_TOKEN,
        "/v1/chat/completions",
        &chat_json(
            &format!("{SENTINEL_HAZARD_S9} and {SENTINEL_HAZARD_S1} node probe"),
            false,
        ),
    )
    .await;
    let rows = g.state.violations.pending(100).unwrap();
    assert!(
        !rows.is_empty(),
        "the node tier decided nothing: {status} {}",
        short(&raw)
    );
    let mut misses = Vec::new();
    for row in &rows {
        let event = &row.event;
        if event.spend != SpendOwner::Tenant {
            misses.push(format!("{}: spend {:?}", event.category, event.spend));
        }
        if event.policy.as_ref().map(|p| p.layer) != Some(PolicyLayer::Node) {
            misses.push(format!("{}: layer {:?}", event.category, event.policy));
        }
        if row.excerpt.is_some() {
            misses.push(format!("{}: kept an excerpt", event.category));
        }
        if event.org_id.as_deref() != Some(ORG_A) {
            misses.push(format!("{}: orgId {:?}", event.category, event.org_id));
        }
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

// ── evidence ────────────────────────────────────────────────────────────────

/// A stored excerpt is redacted: a secret beside the hazard never sits in
/// the outbox in the clear, whatever decided the request.
#[tokio::test]
async fn probe_violation_an_excerpt_never_holds_a_raw_secret() {
    let control = spawn_control_plane().await;
    let backend = test_backend("decision_local");
    let g = tenant_gateway(
        &control,
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), std::slice::from_ref(&backend)),
        Some(qualified_floor(3)),
        "ok",
        |config| config.firewall.policy = crate::config::FirewallPolicy::WarnAndContinue,
        |_| {},
    );
    let (status, _, raw) = tenant_send(
        &g,
        TENANT_A_TOKEN,
        "/v1/chat/completions",
        &chat_json(
            &format!("{SENTINEL_HAZARD_S9} with key {EXAMPLE_KEY} attached"),
            false,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{}", short(&raw));
    let rows = g.state.violations.pending(100).unwrap();
    assert!(!rows.is_empty());
    for row in &rows {
        if let Some(excerpt) = &row.excerpt {
            assert!(
                !excerpt.contains(EXAMPLE_KEY),
                "{} excerpt holds the raw key",
                row.event.category
            );
        }
        let wire = serde_json::to_string(&row.event).unwrap();
        assert!(!wire.contains(EXAMPLE_KEY));
        assert!(!wire.contains(SENTINEL_HAZARD_S9));
    }
}

/// Spec 03.4.4 at the route: an S4 found later on output purges the excerpt
/// an inbound flag kept for the same request.
#[tokio::test]
async fn probe_violation_an_s4_output_purges_the_inbound_flag_excerpt() {
    let control = spawn_control_plane().await;
    for stream in [false, true] {
        let (g, _) = tenant_fleet(&control, SENTINEL_HAZARD_S4);
        let (status, _, raw) = tenant_send(
            &g,
            TENANT_A_TOKEN,
            "/v1/chat/completions",
            &chat_json(&format!("{SENTINEL_HAZARD_S1} flagged question"), stream),
        )
        .await;
        assert!(
            raw.contains("platform_floor_output_blocked"),
            "stream={stream}: {status} {}",
            short(&raw)
        );
        let events = outbox(&g);
        let flag = events
            .iter()
            .find(|e| e.category == "hazard.S1")
            .unwrap_or_else(|| panic!("stream={stream}: no S1 flag: {}", describe(&events)));
        let cut = events
            .iter()
            .find(|e| e.category == "hazard.S4")
            .unwrap_or_else(|| panic!("stream={stream}: no S4 event: {}", describe(&events)));
        assert_eq!(flag.request_id, cut.request_id);
        assert!(
            !g.state.violations.has_excerpt(&flag.event_id).unwrap(),
            "stream={stream}: the S1 excerpt survived the S4 output"
        );
    }
}

/// Media no backend can screen is refused on the fleet; nothing of the
/// media lands in the outbox.
#[tokio::test]
async fn probe_violation_unscreenable_media_leaves_no_media_in_the_outbox() {
    const PNG: &str = "iVBORw0KGgo=";
    let control = spawn_control_plane().await;
    let (g, _) = tenant_fleet(&control, "ok");
    let body = json!({ "model": "fixture-model", "messages": [{ "role": "user", "content": [
        { "type": "text", "text": format!("{SENTINEL_HAZARD_S1} describe") },
        { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{PNG}") } }
    ] }] });
    let (status, _, raw) = tenant_send(&g, TENANT_A_TOKEN, "/v1/chat/completions", &body).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{}", short(&raw));
    assert_eq!(g.calls.load(Ordering::SeqCst), 0);
    for row in g.state.violations.pending(100).unwrap() {
        assert!(!serde_json::to_string(&row.event).unwrap().contains(PNG));
        assert!(!row.excerpt.unwrap_or_default().contains(PNG));
    }
}

// ── the live feed (ID-15) ───────────────────────────────────────────────────

/// Spec 00.6: `traffic_event.verdict` carries the event id it joins on.
#[tokio::test]
async fn probe_violation_the_traffic_verdict_carries_the_event_id() {
    let control = spawn_control_plane().await;
    let (g, _) = tenant_fleet(&control, "ok");
    let (status, _, raw) = tenant_send(
        &g,
        TENANT_A_TOKEN,
        "/v1/chat/completions",
        &chat_json(SENTINEL_HAZARD_S9, false),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{}", short(&raw));
    let events = outbox(&g);
    assert_eq!(events.len(), 1);
    let rows = g.state.traffic.recent();
    let verdicts: Vec<&Value> = rows
        .iter()
        .map(|row| &row["verdict"])
        .filter(|v| v.is_object())
        .collect();
    assert!(!verdicts.is_empty(), "no verdict on the feed: {rows:?}");
    assert!(
        verdicts.iter().any(|v| {
            v["eventId"].as_str() == Some(events[0].event_id.as_str())
                || v["event_id"].as_str() == Some(events[0].event_id.as_str())
        }),
        "no verdict carries eventId {}: {verdicts:?}",
        events[0].event_id
    );
}

// ── reporter, end to end ────────────────────────────────────────────────────

/// Router requests to the mock ingest: every wire event carries the tenant
/// org and credential, no prompt text leaves outside `evidence`, and no S4
/// event has evidence.
#[tokio::test]
async fn probe_violation_routed_events_reach_ingest_with_tenant_ids_and_no_prompt_text() {
    let control = spawn_control_plane().await;
    let (g, _) = tenant_fleet(&control, SENTINEL_HAZARD_S4);
    let requests = [
        (
            TENANT_A_TOKEN,
            chat_json(&format!("{SENTINEL_HAZARD_S9} report probe"), false),
        ),
        (
            TENANT_B_TOKEN,
            chat_json(&format!("{SENTINEL_HAZARD_S1} report probe"), true),
        ),
        (
            TENANT_A_TOKEN,
            chat_json(&format!("{SENTINEL_LEXICON} report probe"), false),
        ),
    ];
    for (token, body) in &requests {
        let (status, _, raw) = tenant_send(&g, token, "/v1/chat/completions", body).await;
        assert!(
            raw.contains("platform_floor_blocked")
                || raw.contains("platform_floor_output_blocked")
                || status == StatusCode::FORBIDDEN,
            "{status} {}",
            short(&raw)
        );
    }
    let local = outbox(&g);
    assert!(local.len() >= 4, "{}", describe(&local));

    let mut config = GatewayConfig::default();
    config.control_plane.enabled = true;
    config.control_plane.base_url = control.base.clone();
    config.control_plane.gateway_key = Some(REPORTER_KEY.to_owned());
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let mut reporter = AppState::new_for_test(config, audit, EvalsRunner::new(Default::default()));
    reporter.custody = GatewayCustody::Fleet;
    reporter.violations = Arc::clone(&g.state.violations);
    let summary = crate::reporter::violations::push_violations(&reporter)
        .await
        .expect("ingest accepts");
    assert_eq!(summary.local_only, 0, "a tenant event stayed local");
    assert_eq!(summary.sent, local.len());

    let bodies = control.ingested.lock().unwrap().clone();
    let mut misses = Vec::new();
    let mut seen = 0;
    for body in &bodies {
        let evidence = body["evidence"].as_object().cloned().unwrap_or_default();
        for event in body["events"].as_array().cloned().unwrap_or_default() {
            seen += 1;
            let category = event["category"].as_str().unwrap_or_default().to_owned();
            let org = event["orgId"].as_str().unwrap_or_default();
            let credential = event["credentialId"].as_str().unwrap_or_default();
            if !matches!((org, credential), (ORG_A, CRED_A) | (ORG_B, CRED_B)) {
                misses.push(format!("{category}: org {org:?} credential {credential:?}"));
            }
            let wire = event.to_string();
            for sentinel in [
                SENTINEL_HAZARD_S1,
                SENTINEL_HAZARD_S4,
                SENTINEL_HAZARD_S9,
                SENTINEL_LEXICON,
                "report probe",
            ] {
                if wire.contains(sentinel) {
                    misses.push(format!("{category}: event carries {sentinel:?}"));
                }
            }
            if category == "hazard.S4" && !event["evidenceRef"].is_null() {
                misses.push("S4 event has an evidenceRef".to_owned());
            }
        }
        for (reference, entry) in &evidence {
            if entry.to_string().contains(SENTINEL_HAZARD_S4) {
                misses.push(format!("{reference}: evidence holds S4 text"));
            }
        }
    }
    assert_eq!(seen, local.len());
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

#[path = "fleet_probe_tests.rs"]
mod fleet_probe_tests;
