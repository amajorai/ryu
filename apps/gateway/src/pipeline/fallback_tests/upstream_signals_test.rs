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

#[path = "upstream_signals_pool_test.rs"]
mod pool_legs;

#[path = "upstream_signals_aux_test.rs"]
mod aux_sub_calls;
