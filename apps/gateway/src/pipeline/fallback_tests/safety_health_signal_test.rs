//! Safety outcomes and upstream refusals are never provider health signals.
//!
//! On a hosted fleet Gateway an upstream 4xx other than 402, 408 and 429 ends
//! the request: it is not retried with another provider, an own-supply attempt
//! is not re-run on the Ryu Router route, it does not count toward the shared
//! circuit (apart from a refused credential) and it never quarantines an
//! own-supply row. Safety and policy outcomes do none of these on any custody.
//!
//! Every refused case asserts the returned error, zero calls on the provider it
//! must not reach and a failure audit row, and has a benign control that does
//! dispatch or fall back, so a passing refusal cannot just mean the route is
//! broken. Firewall triggers are the AWS documentation example key only.
use super::super::{run_embedding, run_speech, run_stream, EmbeddingOperation};
use super::*;
use crate::audit::{AuditBackend, AuditRecord, AuditRegistry};
use crate::custody::GatewayCustody;
use axum::response::IntoResponse;
use std::sync::atomic::AtomicU16;
use std::sync::Mutex;

/// The AWS documentation example access key id: a fake secret every
/// secret-detection pattern recognises.
const FAKE_AWS_KEY: &str = "AKIAIOSFODNN7EXAMPLE";
const OWN_SLOT: &str = "anthropic-credits";

/// An audit backend that keeps every row in memory.
#[derive(Default)]
struct RecordingAudit {
    rows: Mutex<Vec<AuditRecord>>,
}

impl RecordingAudit {
    fn failures(&self) -> usize {
        self.rows
            .lock()
            .expect("audit rows lock")
            .iter()
            .filter(|row| row.error.is_some())
            .count()
    }
}

impl AuditBackend for RecordingAudit {
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

fn record_audit(state: &mut AppState) -> Arc<RecordingAudit> {
    let recording = Arc::new(RecordingAudit::default());
    state.audit.register(
        AuditRegistry::BUILTIN,
        Arc::clone(&recording) as Arc<dyn AuditBackend>,
    );
    recording
}

struct Chain {
    state: Arc<AppState>,
    primary: Arc<AtomicUsize>,
    secondary: Arc<AtomicUsize>,
    audit: Arc<RecordingAudit>,
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
    let audit = record_audit(&mut state);
    Chain {
        state: Arc::new(state),
        primary: primary_calls,
        secondary: secondary_calls,
        audit,
    }
}

fn primary_circuit_open(state: &AppState) -> bool {
    state
        .circuit_breaker
        .is_open(&current_circuit_key(state, "primary"))
}

fn assert_refused(error: &GatewayError, status: u16) {
    assert!(
        matches!(error, GatewayError::ProviderRejected { status: carried, .. } if *carried == status),
        "expected the upstream {status} itself, got {error:?}"
    );
}

#[tokio::test]
async fn a_fleet_upstream_refusal_ends_the_chain_without_a_circuit_penalty() {
    for status in [400, 403, 404, 409, 422, 451] {
        let chain = build_chain(GatewayCustody::Fleet, Mode::Rejected(status), Mode::Ok);
        let error = run(Arc::clone(&chain.state), plain_ctx(), ping_body())
            .await
            .err()
            .expect("a refusal is returned");
        assert_refused(&error, status);
        assert_eq!(chain.primary.load(Ordering::SeqCst), 1, "{status}");
        assert_eq!(
            chain.secondary.load(Ordering::SeqCst),
            0,
            "{status}: a refused request is never retried with another provider"
        );
        assert!(!primary_circuit_open(&chain.state), "{status}");
        assert_eq!(chain.audit.failures(), 1, "{status}");
        // Returned as the upstream failure, never as a retryable outage.
        let response = error.into_response();
        assert_eq!(response.status(), axum::http::StatusCode::BAD_GATEWAY);

        let error = run_stream(Arc::clone(&chain.state), plain_ctx(), ping_body())
            .await
            .err()
            .expect("a streamed refusal is returned");
        assert_refused(&error, status);
        assert_eq!(chain.primary.load(Ordering::SeqCst), 2, "{status}");
        assert_eq!(chain.secondary.load(Ordering::SeqCst), 0, "{status}");
        assert!(!primary_circuit_open(&chain.state), "{status}");
        assert_eq!(chain.audit.failures(), 2, "{status}");
    }
}

#[tokio::test]
async fn a_fleet_refused_credential_ends_the_chain_and_counts_as_a_health_fault() {
    let chain = build_chain(GatewayCustody::Fleet, Mode::Rejected(401), Mode::Ok);
    let error = run(Arc::clone(&chain.state), plain_ctx(), ping_body())
        .await
        .err()
        .expect("a refused credential is returned");
    assert_refused(&error, 401);
    assert_eq!(chain.secondary.load(Ordering::SeqCst), 0);
    assert!(
        primary_circuit_open(&chain.state),
        "a credential the upstream no longer accepts is broken for every caller"
    );
    assert_eq!(chain.audit.failures(), 1);
}

#[tokio::test]
async fn fleet_health_faults_and_capacity_still_fall_back() {
    for (mode, opens_circuit) in [(Mode::Fail, true), (Mode::RateLimited, false)] {
        let chain = build_chain(GatewayCustody::Fleet, mode, Mode::Ok);
        let out = run(Arc::clone(&chain.state), plain_ctx(), ping_body())
            .await
            .expect("the secondary serves");
        assert_eq!(out.provider_used, "secondary");
        assert_eq!(chain.primary.load(Ordering::SeqCst), 1);
        assert_eq!(chain.secondary.load(Ordering::SeqCst), 1);
        assert_eq!(primary_circuit_open(&chain.state), opens_circuit);
    }
}

#[tokio::test]
async fn self_hosted_a_refusal_still_moves_on_but_never_opens_the_circuit() {
    for custody in [GatewayCustody::SelfHosted] {
        let chain = build_chain(custody, Mode::Rejected(403), Mode::Ok);
        let out = run(Arc::clone(&chain.state), plain_ctx(), ping_body())
            .await
            .expect("the secondary serves");
        assert_eq!(out.provider_used, "secondary", "{custody:?}");
        assert_eq!(chain.secondary.load(Ordering::SeqCst), 1, "{custody:?}");
        assert!(
            !primary_circuit_open(&chain.state),
            "{custody:?}: one caller's refused content must not cut the provider off"
        );
    }
}

#[tokio::test]
async fn a_fleet_refusal_ends_media_and_embedding_chains_too() {
    let speech = || json!({"model": "stub-1", "input": "ping"});
    let embed = || json!({"model": "stub-1", "input": "ping"});

    let chain = build_chain(GatewayCustody::Fleet, Mode::Rejected(403), Mode::Ok);
    let error = run_speech(Arc::clone(&chain.state), plain_ctx(), speech())
        .await
        .err()
        .expect("a media refusal is returned");
    assert_refused(&error, 403);
    assert_eq!(chain.primary.load(Ordering::SeqCst), 1);
    assert_eq!(chain.secondary.load(Ordering::SeqCst), 0);
    let error = run_embedding(
        Arc::clone(&chain.state),
        plain_ctx(),
        embed(),
        EmbeddingOperation::Embed,
    )
    .await
    .err()
    .expect("an embedding refusal is returned");
    assert_refused(&error, 403);
    assert_eq!(chain.primary.load(Ordering::SeqCst), 2);
    assert_eq!(chain.secondary.load(Ordering::SeqCst), 0);
    assert!(!primary_circuit_open(&chain.state));
    assert_eq!(chain.audit.failures(), 2);

    // Benign control: a health fault still moves both to the secondary.
    let chain = build_chain(GatewayCustody::Fleet, Mode::Fail, Mode::Ok);
    run_speech(Arc::clone(&chain.state), plain_ctx(), speech())
        .await
        .expect("the secondary serves speech");
    run_embedding(
        Arc::clone(&chain.state),
        plain_ctx(),
        embed(),
        EmbeddingOperation::Embed,
    )
    .await
    .expect("the secondary serves the embedding");
    assert_eq!(chain.secondary.load(Ordering::SeqCst), 2);
}

// ── own supply on the fleet ────────────────────────────────────────────────

/// An own-supply slot whose reply can be switched between requests: a success
/// (`0`), an upstream refusal (a 4xx) or a provider outage (a 5xx).
struct SwitchableSlot {
    refuse_with: Arc<AtomicU16>,
    calls: Arc<AtomicUsize>,
}

impl SwitchableSlot {
    fn reply(&self) -> Result<(), ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match self.refuse_with.load(Ordering::SeqCst) {
            0 => Ok(()),
            status if status >= 500 => Err(ProviderError::Provider(format!(
                "{OWN_SLOT} error {status}"
            ))),
            status => Err(ProviderError::Rejected {
                status,
                message: format!("{OWN_SLOT} error {status}"),
            }),
        }
    }
}

impl Provider for SwitchableSlot {
    fn name(&self) -> &'static str {
        OWN_SLOT
    }

    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        let reply = self.reply();
        Box::pin(async move {
            reply.map(|()| {
                json!({
                    "id": "chatcmpl-own",
                    "object": "chat.completion",
                    "model": "own-1",
                    "choices": [{
                        "index": 0,
                        "message": {"role": "assistant", "content": "pong"},
                        "finish_reason": "stop"
                    }],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
                })
            })
        })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<dyn std::future::Future<Output = Result<axum::body::Body, ProviderError>> + Send + 'a>,
    > {
        let reply = self.reply();
        Box::pin(async move {
            reply.map(|()| {
                axum::body::Body::from(concat!(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"pong\"}}]}\n\n",
                    "data: [DONE]\n\n",
                ))
            })
        })
    }
}

struct OwnSupply {
    state: Arc<AppState>,
    refuse_with: Arc<AtomicU16>,
    slot: Arc<AtomicUsize>,
    router: Arc<AtomicUsize>,
    audit: Arc<RecordingAudit>,
}

impl OwnSupply {
    fn slot_quarantined(&self) -> bool {
        !self
            .state
            .own_supply
            .take_quarantine_counts(OWN_SLOT)
            .is_empty()
    }

    fn slot_circuit_open(&self) -> bool {
        self.state
            .circuit_breaker
            .is_open(&current_circuit_key(&self.state, OWN_SLOT))
    }
}

/// A fleet Gateway whose default route is the Ryu Router (`openrouter`) and
/// that also holds Ryu's own `anthropic-credits` slot, circuit threshold 1.
/// With `firewall` on, the inbound firewall blocks detected secrets.
fn own_supply_fleet(refuse_with: u16, firewall: bool) -> OwnSupply {
    let mut config = GatewayConfig::default();
    config.firewall.enabled = firewall;
    config.firewall.scan_inbound = true;
    config.firewall.policy = crate::config::FirewallPolicy::Block;
    config.cache.enabled = false;
    // The inbound per-key limiter is itself a safety outcome; off here so the
    // loop below exercises the firewall, policy and upstream refusals.
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
    if !firewall {
        // The compiled baseline floor would turn the firewall back on.
        state.platform_floor = crate::platform_floor::FloorStore::with(
            crate::platform_floor::PlatformFloor::setting_nothing(),
        );
    }
    let (router, router_calls) = StubProvider::new("openrouter", Mode::Ok);
    let refuse = Arc::new(AtomicU16::new(refuse_with));
    let slot_calls = Arc::new(AtomicUsize::new(0));
    state
        .provider_runtime
        .register_for_test(router as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(Arc::new(SwitchableSlot {
            refuse_with: Arc::clone(&refuse),
            calls: Arc::clone(&slot_calls),
        }) as Arc<dyn Provider>);
    let audit = record_audit(&mut state);
    OwnSupply {
        state: Arc::new(state),
        refuse_with: refuse,
        slot: slot_calls,
        router: router_calls,
        audit,
    }
}

fn secret_body() -> Value {
    json!({
        "model": "anthropic/claude-sonnet-4.5",
        "messages": [{"role": "user", "content": format!("deploy with {FAKE_AWS_KEY}")}]
    })
}

/// A free-credit caller whose org policy locks the secrets guardrail, so a
/// detected secret is a `PolicyViolation` even with the local firewall off.
fn locked_secrets_ctx() -> RequestContext {
    let mut ctx = free_credit_ctx(5_000_000);
    ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
        locked_guardrails: vec!["secrets".to_owned()],
        ..crate::policy::EffectivePolicy::default()
    });
    ctx
}

#[tokio::test]
async fn a_fleet_own_supply_refusal_is_returned_not_retried_on_the_ryu_router() {
    let own = own_supply_fleet(400, false);
    let error = run(
        Arc::clone(&own.state),
        free_credit_ctx(5_000_000),
        sonnet_body(),
    )
    .await
    .err()
    .expect("the own-supply refusal is returned");
    assert_refused(&error, 400);
    assert_eq!(own.slot.load(Ordering::SeqCst), 1);
    assert_eq!(
        own.router.load(Ordering::SeqCst),
        0,
        "a refused body is never re-run on the Ryu Router route"
    );
    assert!(!own.slot_quarantined());
    assert!(!own.slot_circuit_open());
    assert_eq!(own.audit.failures(), 1);

    let error = run_stream(
        Arc::clone(&own.state),
        free_credit_ctx(5_000_000),
        sonnet_body(),
    )
    .await
    .err()
    .expect("the streamed own-supply refusal is returned");
    assert_refused(&error, 400);
    assert_eq!(own.slot.load(Ordering::SeqCst), 2);
    assert_eq!(own.router.load(Ordering::SeqCst), 0);
    assert_eq!(own.audit.failures(), 2);

    // Benign control: a slot outage (a 5xx) still rescues the request on the
    // Ryu Router route.
    let outage = own_supply_fleet(503, false);
    let out = run(
        Arc::clone(&outage.state),
        free_credit_ctx(5_000_000),
        sonnet_body(),
    )
    .await
    .expect("the router route rescues an outage");
    assert_eq!(outage.slot.load(Ordering::SeqCst), 1);
    assert_eq!(outage.router.load(Ordering::SeqCst), 1);
    assert_eq!(out.provider_used, "ryu");
}

#[tokio::test]
async fn only_a_fleet_own_supply_not_found_takes_the_row_away() {
    let own = own_supply_fleet(404, false);
    let error = run(
        Arc::clone(&own.state),
        free_credit_ctx(5_000_000),
        sonnet_body(),
    )
    .await
    .err()
    .expect("the not-found is returned");
    assert_refused(&error, 404);
    assert_eq!(own.router.load(Ordering::SeqCst), 0);
    assert!(own.slot_quarantined(), "a retired model leaves the table");
}

#[tokio::test]
async fn repeated_refusals_never_close_own_supply_for_other_orgs() {
    let own = own_supply_fleet(0, true);
    // 25 inbound firewall blocks and 25 locked-guardrail policy refusals.
    for round in 0..25 {
        let error = run(
            Arc::clone(&own.state),
            free_credit_ctx(5_000_000),
            secret_body(),
        )
        .await
        .err()
        .expect("the firewall blocks");
        assert!(
            matches!(error, GatewayError::FirewallBlocked(..)),
            "{round}: {error:?}"
        );
    }
    let own_policy = own_supply_fleet(0, false);
    for round in 0..25 {
        let error = run(
            Arc::clone(&own_policy.state),
            locked_secrets_ctx(),
            secret_body(),
        )
        .await
        .err()
        .expect("the locked guardrail refuses");
        assert!(
            matches!(error, GatewayError::PolicyViolation(_)),
            "{round}: {error:?}"
        );
    }
    assert_eq!(own.slot.load(Ordering::SeqCst), 0);
    assert_eq!(own.router.load(Ordering::SeqCst), 0);
    assert_eq!(own_policy.slot.load(Ordering::SeqCst), 0);
    assert_eq!(own_policy.router.load(Ordering::SeqCst), 0);
    assert_eq!(own.audit.failures(), 25);
    assert_eq!(own_policy.audit.failures(), 25);

    // 50 raw upstream 403s whose message says "forbidden".
    own.refuse_with.store(403, Ordering::SeqCst);
    for round in 0..50 {
        let mut body = sonnet_body();
        body["messages"][0]["content"] = json!(format!("ping {round}"));
        let error = run(Arc::clone(&own.state), free_credit_ctx(5_000_000), body)
            .await
            .err()
            .expect("the upstream refuses");
        assert_refused(&error, 403);
    }
    assert_eq!(own.slot.load(Ordering::SeqCst), 50);
    assert_eq!(
        own.router.load(Ordering::SeqCst),
        0,
        "no refusal was shopped to the Ryu Router route"
    );
    assert!(!own.slot_circuit_open(), "the circuit stays closed");
    assert!(!own.slot_quarantined(), "the row stays in the table");

    // The next benign request from another org is served on own supply.
    own.refuse_with.store(0, Ordering::SeqCst);
    let mut other_org = free_credit_ctx(5_000_000);
    other_org.org_id = Some("another-org".to_owned());
    let out = run(Arc::clone(&own.state), other_org, sonnet_body())
        .await
        .expect("own supply serves");
    assert_eq!(own.slot.load(Ordering::SeqCst), 51);
    assert_eq!(own.router.load(Ordering::SeqCst), 0);
    assert_eq!(out.response["model"], "anthropic/claude-sonnet-4.5");
}

#[tokio::test]
async fn an_own_supply_policy_violation_is_not_rerun_on_the_ryu_router() {
    let own = own_supply_fleet(0, false);
    let state = Arc::clone(&own.state);
    let error = run(Arc::clone(&state), locked_secrets_ctx(), secret_body())
        .await
        .err()
        .expect("the locked guardrail refuses");
    assert!(
        matches!(error, GatewayError::PolicyViolation(_)),
        "{error:?}"
    );
    assert_eq!(own.slot.load(Ordering::SeqCst), 0);
    assert_eq!(own.router.load(Ordering::SeqCst), 0);
    // Screened once: the refusal was not re-run on the Ryu Router route.
    assert_eq!(own.audit.failures(), 1);
    assert_eq!(state.metrics.firewall_blocked.load(Ordering::SeqCst), 1);

    // Benign control: the same caller with a clean body is served.
    run(Arc::clone(&state), locked_secrets_ctx(), sonnet_body())
        .await
        .expect("own supply serves");
    assert_eq!(own.slot.load(Ordering::SeqCst), 1);
    assert_eq!(own.router.load(Ordering::SeqCst), 0);
}
