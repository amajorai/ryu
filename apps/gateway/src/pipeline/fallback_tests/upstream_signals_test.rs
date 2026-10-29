//! Upstream abuse signals end to end through the attempt loops (spec 03.5,
//! acceptance ID-10, ID-12, ID-12b, ID-13 and AT-17).
//!
//! A provider safety refusal on a Ryu-held credential is a safety outcome: it
//! returns the catalogue 403, is never retried on another vendor, never opens
//! the circuit or quarantines an own-supply row, and records exactly one
//! violation event. On a self-hosted Gateway the same refusal is an ordinary
//! upstream rejection and records nothing. Upstream wording in the stubs is
//! a test sentinel only.
use super::super::{run_embedding, run_stream, EmbeddingOperation};
use super::*;
use crate::audit::{
    ActorKind, DetectorKind, EnforcementAction, Severity, SpendOwner, ViolationDirection,
};
use crate::custody::GatewayCustody;
use axum::response::IntoResponse;
use ryu_gw_providers::SafetyScope;

const UPSTREAM_SUBJECT: &str = "ryu.1.00112233445566778899aabbccddeeff";

struct Chain {
    state: Arc<AppState>,
    primary: Arc<AtomicUsize>,
    secondary: Arc<AtomicUsize>,
}

/// `primary` then `secondary`, circuit threshold 1, on `custody`.
fn build_chain(custody: GatewayCustody, primary: Mode, secondary: Mode) -> Chain {
    let mut state = chain_state(1);
    state.custody = custody;
    let (first, primary_calls) = StubProvider::new("primary", primary);
    let (second, secondary_calls) = StubProvider::new("secondary", secondary);
    state
        .provider_runtime
        .register_for_test(first as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(second as Arc<dyn Provider>);
    Chain {
        state: Arc::new(state),
        primary: primary_calls,
        secondary: secondary_calls,
    }
}

/// A tenant request whose identity carries Ryu's stamped upstream subject.
fn tenant(request_id: &str) -> RequestContext {
    let mut ctx = crate::violations::test_support::tenant_ctx(request_id);
    let mut identity = ctx.identity.as_deref().cloned().expect("tenant identity");
    identity.upstream_subject = Some(UPSTREAM_SUBJECT.to_owned());
    ctx.identity = Some(Arc::new(identity));
    ctx
}

fn primary_circuit_open(state: &AppState) -> bool {
    state
        .circuit_breaker
        .is_open(&current_circuit_key(state, "primary"))
}

fn events(state: &AppState) -> Vec<crate::audit::ViolationEvent> {
    state.violations.all_events().expect("outbox readable")
}

async fn envelope(error: GatewayError) -> (u16, Value) {
    let response = error.into_response();
    let status = response.status().as_u16();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (status, serde_json::from_slice(&bytes).expect("JSON body"))
}

#[tokio::test]
async fn a_fleet_content_refusal_is_terminal_and_records_one_event() {
    let chain = build_chain(
        GatewayCustody::Fleet,
        Mode::SafetyRefused(SafetyScope::Content),
        Mode::Ok,
    );
    let error = run(Arc::clone(&chain.state), tenant("req-up-1"), ping_body())
        .await
        .err()
        .expect("the refusal is returned");
    assert!(
        matches!(&error, GatewayError::UpstreamSafetyRefused(_)),
        "{error:?}"
    );
    assert_eq!(chain.primary.load(Ordering::SeqCst), 1);
    assert_eq!(
        chain.secondary.load(Ordering::SeqCst),
        0,
        "a safety refusal is never retried on another vendor"
    );
    assert!(!primary_circuit_open(&chain.state));

    let recorded = events(&chain.state);
    assert_eq!(recorded.len(), 1, "{recorded:?}");
    let event = &recorded[0];
    assert_eq!(event.category, "abuse.upstream_content_refused");
    assert_eq!(event.detector.kind, DetectorKind::Upstream);
    assert_eq!(event.detector.id, "test.stub");
    assert_eq!(event.action, EnforcementAction::RefusedUpstream);
    assert_eq!(event.direction, ViolationDirection::Upstream);
    assert_eq!(event.spend, SpendOwner::Ryu);
    assert_eq!(event.provider.as_deref(), Some("primary"));
    assert_eq!(event.upstream_subject.as_deref(), Some(UPSTREAM_SUBJECT));
    assert_eq!(
        event.org_id.as_deref(),
        Some(crate::violations::test_support::TENANT_ORG)
    );
    assert_eq!(
        event.credential_id.as_deref(),
        Some(crate::violations::test_support::TENANT_CREDENTIAL)
    );
    assert_eq!(event.actor_kind, ActorKind::Credential);
    assert!(event.evidence_hmac.is_none(), "no upstream text is kept");

    let (status, body) = envelope(error).await;
    assert_eq!(status, 403);
    assert_eq!(body["error"]["type"], "policy_violation");
    assert_eq!(body["error"]["code"], "upstream_content_refused");
    assert_eq!(body["error"]["layer"], "upstream");
    assert_eq!(body["error"]["provider"], "primary");
    assert_eq!(body["error"]["remedy"], "report_false_positive");
    assert!(!body.to_string().contains("RYU_TEST_FIXTURE"));
}

#[tokio::test]
async fn a_streamed_fleet_refusal_is_terminal_too() {
    let chain = build_chain(
        GatewayCustody::Fleet,
        Mode::SafetyRefused(SafetyScope::Content),
        Mode::Ok,
    );
    let error = run_stream(Arc::clone(&chain.state), tenant("req-up-s"), ping_body())
        .await
        .err()
        .expect("the streamed refusal is returned");
    assert!(
        matches!(&error, GatewayError::UpstreamSafetyRefused(_)),
        "{error:?}"
    );
    assert_eq!(chain.secondary.load(Ordering::SeqCst), 0);
    assert!(!primary_circuit_open(&chain.state));
    assert_eq!(events(&chain.state).len(), 1);
}

#[tokio::test]
async fn a_fleet_identifier_block_and_an_account_warning_carry_their_severity() {
    for (scope, code, category, severity, remedy) in [
        (
            SafetyScope::Identifier,
            "upstream_identifier_blocked",
            "abuse.upstream_identifier_blocked",
            Severity::High,
            "appeal",
        ),
        (
            SafetyScope::Account,
            "principal_blocked",
            "abuse.upstream_account_warning",
            Severity::Critical,
            "appeal",
        ),
    ] {
        let chain = build_chain(GatewayCustody::Fleet, Mode::SafetyRefused(scope), Mode::Ok);
        let error = run(Arc::clone(&chain.state), tenant("req-up-2"), ping_body())
            .await
            .err()
            .expect("the refusal is returned");
        assert_eq!(chain.secondary.load(Ordering::SeqCst), 0, "{code}");
        assert!(
            !primary_circuit_open(&chain.state),
            "{code}: the signal never opens the circuit"
        );
        let recorded = events(&chain.state);
        assert_eq!(recorded.len(), 1, "{code}");
        assert_eq!(recorded[0].category, category);
        assert_eq!(recorded[0].severity, severity);
        assert_eq!(recorded[0].action, EnforcementAction::BlockedUpstream);
        let (status, body) = envelope(error).await;
        assert_eq!(status, 403);
        assert_eq!(body["error"]["code"], code);
        assert_eq!(body["error"]["layer"], "upstream");
        assert_eq!(body["error"]["remedy"], remedy);
    }
}

#[tokio::test]
async fn a_fleet_refusal_ends_an_embedding_chain() {
    let chain = build_chain(
        GatewayCustody::Fleet,
        Mode::SafetyRefused(SafetyScope::Content),
        Mode::Ok,
    );
    let error = run_embedding(
        Arc::clone(&chain.state),
        tenant("req-up-e"),
        json!({"model": "stub-1", "input": "ping"}),
        EmbeddingOperation::Embed,
    )
    .await
    .err()
    .expect("the refusal is returned");
    assert!(matches!(error, GatewayError::UpstreamSafetyRefused(_)));
    assert_eq!(chain.secondary.load(Ordering::SeqCst), 0);
    assert_eq!(events(&chain.state).len(), 1);
}

#[tokio::test]
async fn self_hosted_the_same_refusal_is_an_ordinary_rejection_with_no_event() {
    let chain = build_chain(
        GatewayCustody::SelfHosted,
        Mode::SafetyRefused(SafetyScope::Identifier),
        Mode::Ok,
    );
    let out = run(Arc::clone(&chain.state), tenant("req-up-3"), ping_body())
        .await
        .expect("the self-hosted chain moves on as before");
    assert_eq!(out.provider_used, "secondary");
    assert_eq!(chain.secondary.load(Ordering::SeqCst), 1);
    assert!(!primary_circuit_open(&chain.state));
    assert!(
        events(&chain.state).is_empty(),
        "an operator's own key never raises a safety signal"
    );

    // With nowhere to fall back to, the caller sees the ordinary upstream
    // failure, not a Ryu safety code.
    let alone = build_chain(
        GatewayCustody::SelfHosted,
        Mode::SafetyRefused(SafetyScope::Identifier),
        Mode::SafetyRefused(SafetyScope::Identifier),
    );
    let error = run(Arc::clone(&alone.state), tenant("req-up-4"), ping_body())
        .await
        .err()
        .expect("both refuse");
    assert!(
        matches!(
            &error,
            GatewayError::ProviderRejected { signal: None, .. }
                | GatewayError::AllProvidersUnavailable(_)
        ),
        "{error:?}"
    );
    assert!(events(&alone.state).is_empty());
}

#[tokio::test]
async fn a_fleet_soft_refusal_is_returned_unchanged_and_recorded() {
    let chain = build_chain(GatewayCustody::Fleet, Mode::SoftRefusal, Mode::Ok);
    let out = run(Arc::clone(&chain.state), tenant("req-up-5"), ping_body())
        .await
        .expect("a soft refusal is a success");
    assert_eq!(
        out.response["choices"][0]["finish_reason"],
        "content_filter"
    );
    assert_eq!(chain.secondary.load(Ordering::SeqCst), 0);
    let recorded = events(&chain.state);
    assert_eq!(recorded.len(), 1, "{recorded:?}");
    assert_eq!(recorded[0].category, "abuse.upstream_content_refused");
    assert_eq!(recorded[0].detector.id, "primary.content_filter");
    assert_eq!(recorded[0].action, EnforcementAction::RefusedUpstream);

    // Self-hosted: returned the same, nothing recorded.
    let own = build_chain(GatewayCustody::SelfHosted, Mode::SoftRefusal, Mode::Ok);
    run(Arc::clone(&own.state), tenant("req-up-6"), ping_body())
        .await
        .expect("a soft refusal is a success");
    assert!(events(&own.state).is_empty());

    // Benign control: an ordinary completion records nothing.
    let plain = build_chain(GatewayCustody::Fleet, Mode::Ok, Mode::Ok);
    run(Arc::clone(&plain.state), tenant("req-up-7"), ping_body())
        .await
        .expect("served");
    assert!(events(&plain.state).is_empty());
}

// ── own supply (AT-17) ─────────────────────────────────────────────────────

const OWN_SLOT: &str = "anthropic-credits";

/// Ryu's own Anthropic slot, refusing every request for a content reason.
struct RefusingSlot {
    calls: Arc<AtomicUsize>,
}

impl Provider for RefusingSlot {
    fn name(&self) -> &'static str {
        OWN_SLOT
    }

    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Err(stub_safety_refusal(OWN_SLOT, SafetyScope::Content)) })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<dyn std::future::Future<Output = Result<axum::body::Body, ProviderError>> + Send + 'a>,
    > {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Err(stub_safety_refusal(OWN_SLOT, SafetyScope::Content)) })
    }
}

#[tokio::test]
async fn an_own_supply_refusal_never_moves_to_the_ryu_router() {
    let mut config = GatewayConfig::default();
    config.firewall.enabled = false;
    config.cache.enabled = false;
    config.rate_limit.enabled = false;
    config.circuit_breaker = CircuitBreakerConfig {
        enabled: true,
        failure_threshold: 1,
        reset_timeout_secs: 30,
    };
    config.routing.default_provider = ProviderId::from("openrouter");
    config.routing.fallback_chain = Vec::new();
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let mut state = AppState::new_for_test(
        config,
        audit,
        crate::evals::EvalsRunner::new(EvalsConfig::default()),
    );
    state.custody = GatewayCustody::Fleet;
    state.platform_floor = crate::platform_floor::FloorStore::with(
        crate::platform_floor::PlatformFloor::setting_nothing(),
    );
    let (router, router_calls) = StubProvider::new("openrouter", Mode::Ok);
    let slot_calls = Arc::new(AtomicUsize::new(0));
    state
        .provider_runtime
        .register_for_test(router as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(Arc::new(RefusingSlot {
            calls: Arc::clone(&slot_calls),
        }) as Arc<dyn Provider>);
    let state = Arc::new(state);

    let error = run(
        Arc::clone(&state),
        free_credit_ctx(5_000_000),
        sonnet_body(),
    )
    .await
    .err()
    .expect("the own-supply refusal is returned");
    assert!(
        matches!(&error, GatewayError::UpstreamSafetyRefused(_)),
        "{error:?}"
    );
    assert_eq!(slot_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        router_calls.load(Ordering::SeqCst),
        0,
        "a refused body is never re-run on the Ryu Router route"
    );
    assert!(state.own_supply.take_quarantine_counts(OWN_SLOT).is_empty());
    assert!(!state
        .circuit_breaker
        .is_open(&current_circuit_key(&state, OWN_SLOT)));
    let recorded = events(&state);
    assert_eq!(recorded.len(), 1, "{recorded:?}");
    assert_eq!(recorded[0].slot_id.as_deref(), Some(OWN_SLOT));
    let (_, body) = envelope(error).await;
    assert_eq!(
        body["error"]["provider"], "anthropic",
        "Ryu's own slot is named after its vendor"
    );
}

// ── provider-pool legs ─────────────────────────────────────────────────────

/// A Fusion or Pipeline pool `flow`, reached through the `ensemble` model,
/// on scripted `panel`, `refuser` and `judge` providers.
struct PoolChain {
    state: Arc<AppState>,
    panel: Arc<AtomicUsize>,
    refuser: Arc<AtomicUsize>,
    judge: Arc<AtomicUsize>,
}

fn pool_chain(strategy: &str, members: &[(&str, &str)]) -> PoolChain {
    let mut config = GatewayConfig::default();
    config.routing.default_provider = ProviderId::from("panel");
    config.routing.fallback_chain = vec![ProviderId::from("panel")];
    config.firewall.enabled = false;
    config.cache.enabled = false;
    config.rate_limit.enabled = false;
    config.circuit_breaker = CircuitBreakerConfig {
        enabled: true,
        failure_threshold: 1,
        reset_timeout_secs: 30,
    };
    config.routing.model_map.insert(
        "ensemble".into(),
        serde_json::from_value(json!({"provider": "pool:flow"})).expect("pool route"),
    );
    let members: Vec<Value> = members
        .iter()
        .map(|(provider, model)| json!({"provider": provider, "model": model}))
        .collect();
    // Quorum covers every panel, so the join waits for the refusal and the
    // outcome never depends on which leg finishes first.
    let mut pool = json!({
        "strategy": strategy,
        "execution": {
            "quorum": members.len(),
            "grace_ms": 1,
            "leg_timeout_ms": 1000,
            "total_timeout_ms": 2000,
            "max_output_bytes": 262_144
        },
        "members": members,
    });
    if strategy == "fusion" {
        pool["judge"] = json!({"provider": "judge", "model": "j"});
    }
    config.routing.provider_pools.insert(
        "flow".into(),
        serde_json::from_value(pool).expect("pool config"),
    );
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let mut state = AppState::new_for_test(
        config,
        audit,
        crate::evals::EvalsRunner::new(EvalsConfig::default()),
    );
    state.custody = GatewayCustody::Fleet;
    let (panel, panel_calls) = StubProvider::new("panel", Mode::Ok);
    let (refuser, refuser_calls) =
        StubProvider::new("refuser", Mode::SafetyRefused(SafetyScope::Content));
    let (judge, judge_calls) = StubProvider::new("judge", Mode::Ok);
    for provider in [panel, refuser, judge] {
        state
            .provider_runtime
            .register_for_test(provider as Arc<dyn Provider>);
    }
    PoolChain {
        state: Arc::new(state),
        panel: panel_calls,
        refuser: refuser_calls,
        judge: judge_calls,
    }
}

fn ensemble_body() -> Value {
    json!({"model": "ensemble", "max_tokens": 128, "messages": [{"role": "user", "content": "ping"}]})
}

/// The single event a refused leg records, linked to the parent request.
fn assert_one_leg_event(state: &AppState, request_id: &str, attempt: u8) {
    let recorded = events(state);
    assert_eq!(recorded.len(), 1, "{recorded:?}");
    let event = &recorded[0];
    assert_eq!(event.category, "abuse.upstream_content_refused");
    assert_eq!(event.detector.id, "test.stub");
    assert_eq!(event.action, EnforcementAction::RefusedUpstream);
    assert_eq!(event.provider.as_deref(), Some("refuser"));
    assert_eq!(
        event.request_id, request_id,
        "a leg's event belongs to the request the caller sent"
    );
    assert_eq!(event.attempt, attempt, "the leg's position is its attempt");
}

#[tokio::test]
async fn a_refused_fusion_panel_ends_the_request_before_the_judge() {
    let chain = pool_chain("fusion", &[("panel", "a"), ("refuser", "b")]);
    let error = run(
        Arc::clone(&chain.state),
        tenant("req-up-fusion"),
        ensemble_body(),
    )
    .await
    .err()
    .expect("the panel refusal is returned");
    assert!(
        matches!(&error, GatewayError::UpstreamSafetyRefused(_)),
        "{error:?}"
    );
    assert_eq!(chain.refuser.load(Ordering::SeqCst), 1);
    assert_eq!(
        chain.judge.load(Ordering::SeqCst),
        0,
        "the other panel answers are never judged or served"
    );
    assert!(!chain
        .state
        .circuit_breaker
        .is_open(&current_circuit_key(&chain.state, "refuser")));
    assert_one_leg_event(&chain.state, "req-up-fusion", 1);
    let (status, body) = envelope(error).await;
    assert_eq!(status, 403);
    assert_eq!(body["error"]["code"], "upstream_content_refused");
    assert_eq!(body["error"]["layer"], "upstream");
}

#[tokio::test]
async fn a_refused_pipeline_stage_ends_the_request_before_the_next_stage() {
    let chain = pool_chain("pipeline", &[("refuser", "a"), ("panel", "b")]);
    let error = run(
        Arc::clone(&chain.state),
        tenant("req-up-pipeline"),
        ensemble_body(),
    )
    .await
    .err()
    .expect("the stage refusal is returned");
    assert!(
        matches!(&error, GatewayError::UpstreamSafetyRefused(_)),
        "{error:?}"
    );
    assert_eq!(chain.refuser.load(Ordering::SeqCst), 1);
    assert_eq!(
        chain.panel.load(Ordering::SeqCst),
        0,
        "the next stage never receives the refused body"
    );
    assert_eq!(chain.judge.load(Ordering::SeqCst), 0);
    assert_one_leg_event(&chain.state, "req-up-pipeline", 0);
    let (status, body) = envelope(error).await;
    assert_eq!(status, 403);
    assert_eq!(body["error"]["code"], "upstream_content_refused");
}

#[tokio::test]
async fn a_self_hosted_pool_leg_refusal_records_nothing() {
    let chain = pool_chain("fusion", &[("panel", "a"), ("refuser", "b")]);
    let mut state = Arc::try_unwrap(chain.state).ok().expect("sole owner");
    state.custody = GatewayCustody::SelfHosted;
    let state = Arc::new(state);
    let out = run(
        Arc::clone(&state),
        tenant("req-up-pool-own"),
        ensemble_body(),
    )
    .await
    .expect("an operator's own pool keeps its surviving panel");
    assert_eq!(out.model_used, "a");
    assert_eq!(chain.judge.load(Ordering::SeqCst), 0);
    assert!(events(&state).is_empty());
}

// ── auxiliary sub-calls carrying the tenant's text ─────────────────────────

/// The model id the inspector or the escalation judge is configured with,
/// mapped to the scripted `refuser`.
const AUX_MODEL: &str = "aux-judge";

struct AuxChain {
    state: Arc<AppState>,
    primary: Arc<AtomicUsize>,
    secondary: Arc<AtomicUsize>,
    refuser: Arc<AtomicUsize>,
    /// The provider id the refusing sub-call reaches.
    refuser_id: &'static str,
}

/// `primary` then `secondary` serve the request; the sub-call under test,
/// turned on by `configure`, reaches a provider that answers with a content
/// refusal: `refuser` through `AUX_MODEL`, or `openai` for the semantic
/// cache's embedding, which always dispatches there.
fn aux_chain(custody: GatewayCustody, configure: impl FnOnce(&mut GatewayConfig)) -> AuxChain {
    let mut config = GatewayConfig::default();
    config.routing.default_provider = ProviderId::from("primary");
    config.routing.fallback_chain =
        vec![ProviderId::from("primary"), ProviderId::from("secondary")];
    config.routing.model_map.insert(
        AUX_MODEL.into(),
        serde_json::from_value(json!({"provider": "refuser"})).expect("aux route"),
    );
    config.firewall.enabled = false;
    config.cache.enabled = false;
    config.rate_limit.enabled = false;
    config.circuit_breaker = CircuitBreakerConfig {
        enabled: true,
        failure_threshold: 1,
        reset_timeout_secs: 30,
    };
    configure(&mut config);
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let mut state = AppState::new_for_test(
        config,
        audit,
        crate::evals::EvalsRunner::new(EvalsConfig::default()),
    );
    state.custody = custody;
    let refuser_id = if state.config.semantic_cache.enabled {
        state.semantic_cache = crate::semantic_cache::SemanticCacheRegistry::from_cache(
            crate::semantic_cache::SemanticCache::new(
                state.config.semantic_cache.clone(),
                60,
                state.config.cache.max_entries,
            ),
        );
        "openai"
    } else {
        "refuser"
    };
    let (primary, primary_calls) = StubProvider::new("primary", Mode::Ok);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    let (refuser, refuser_calls) =
        StubProvider::new(refuser_id, Mode::SafetyRefused(SafetyScope::Content));
    for provider in [primary, secondary, refuser] {
        state
            .provider_runtime
            .register_for_test(provider as Arc<dyn Provider>);
    }
    AuxChain {
        state: Arc::new(state),
        primary: primary_calls,
        secondary: secondary_calls,
        refuser: refuser_calls,
        refuser_id,
    }
}

fn with_inspector(config: &mut GatewayConfig) {
    config.firewall.enabled = true;
    config.firewall.inspector.enabled = true;
    config.firewall.inspector.min_chars = 0;
    config.firewall.inspector.model = AUX_MODEL.into();
}

fn with_escalation_judge(config: &mut GatewayConfig) {
    config.routing.smart_routing = crate::config::SmartRoutingConfig {
        enabled: true,
        router_type: crate::config::ModelRouterType::Escalation,
        escalation_weak_model: "weak-model".into(),
        escalation_strong_model: "strong-model".into(),
        escalation_judge_model: AUX_MODEL.into(),
        escalation_confirmations: 1,
        ..Default::default()
    };
}

fn with_semantic_cache(config: &mut GatewayConfig) {
    config.providers.openai = Some(
        serde_json::from_value(json!({"api_key": "test-key", "base_url": "http://127.0.0.1:1/v1"}))
            .expect("openai config"),
    );
    config.semantic_cache.enabled = true;
    config.semantic_cache.embedding_model = "embed-model".into();
}

/// The sub-calls that send the tenant's text before the request is served,
/// with whether a streamed request makes them too. The semantic cache is
/// consulted on buffered requests only, so a stream sends no embedding.
const AUX_SUB_CALLS: [(&str, fn(&mut GatewayConfig), bool); 3] = [
    ("inspector", with_inspector, true),
    ("escalation judge", with_escalation_judge, true),
    ("semantic cache embedding", with_semantic_cache, false),
];

#[tokio::test]
async fn a_fleet_refusal_of_an_auxiliary_sub_call_ends_the_request() {
    for (name, configure, streams) in AUX_SUB_CALLS {
        let pipelines: &[bool] = if streams { &[false, true] } else { &[false] };
        for &stream in pipelines {
            let label = format!("{name} (stream: {stream})");
            let chain = aux_chain(GatewayCustody::Fleet, configure);
            let result = if stream {
                run_stream(Arc::clone(&chain.state), tenant("req-up-aux"), ping_body())
                    .await
                    .map(|_| ())
            } else {
                run(Arc::clone(&chain.state), tenant("req-up-aux"), ping_body())
                    .await
                    .map(|_| ())
            };
            let error = result
                .err()
                .unwrap_or_else(|| panic!("{label}: the sub-call refusal is returned"));
            assert!(
                matches!(&error, GatewayError::UpstreamSafetyRefused(_)),
                "{label}: {error:?}"
            );
            assert_eq!(chain.refuser.load(Ordering::SeqCst), 1, "{label}");
            assert_eq!(
                chain.primary.load(Ordering::SeqCst) + chain.secondary.load(Ordering::SeqCst),
                0,
                "{label}: the refused text is never dispatched as the main request"
            );
            assert!(
                !chain
                    .state
                    .circuit_breaker
                    .is_open(&current_circuit_key(&chain.state, chain.refuser_id)),
                "{label}: the signal never opens the circuit"
            );

            let recorded = events(&chain.state);
            assert_eq!(recorded.len(), 1, "{label}: {recorded:?}");
            let event = &recorded[0];
            assert_eq!(event.category, "abuse.upstream_content_refused", "{label}");
            assert_eq!(event.detector.id, "test.stub", "{label}");
            assert_eq!(event.action, EnforcementAction::RefusedUpstream, "{label}");
            assert_eq!(event.provider.as_deref(), Some(chain.refuser_id), "{label}");
            assert_eq!(
                event.request_id, "req-up-aux",
                "{label}: the event belongs to the request the caller sent"
            );
            assert_eq!(
                usize::from(event.attempt),
                crate::pipeline::upstream_signals::AUXILIARY_ATTEMPT,
                "{label}: a sub-call refusal keeps its own attempt slot"
            );

            let (status, body) = envelope(error).await;
            assert_eq!(status, 403, "{label}");
            assert_eq!(body["error"]["code"], "upstream_content_refused", "{label}");
            assert_eq!(body["error"]["layer"], "upstream", "{label}");
        }
    }
}

#[tokio::test]
async fn a_self_hosted_auxiliary_sub_call_refusal_still_fails_open() {
    for (label, configure, _) in AUX_SUB_CALLS {
        let chain = aux_chain(GatewayCustody::SelfHosted, configure);
        run(
            Arc::clone(&chain.state),
            tenant("req-up-aux-own"),
            ping_body(),
        )
        .await
        .unwrap_or_else(|error| {
            panic!("{label}: an operator's own sub-call fails open: {error:?}")
        });
        assert_eq!(chain.refuser.load(Ordering::SeqCst), 1, "{label}");
        assert_eq!(chain.primary.load(Ordering::SeqCst), 1, "{label}");
        assert!(events(&chain.state).is_empty(), "{label}");
    }
}
