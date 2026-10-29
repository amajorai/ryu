//! Coverage probe for P0-1 (spec 00.11 and 00.12): safety outcomes and
//! upstream refusals are never health signals, and on a floor-bound Gateway
//! only a transport error, a 5xx, a 408 or a 429 may move a request to another
//! provider.
//!
//! These probes push shapes the first suite did not: a payment-required reply,
//! a managed node, a health fault followed by a refusal in one chain, unusual
//! 4xx statuses, refusals on the streamed own-supply path, a firewall marker
//! hidden in content-part arrays and stringified JSON after long benign
//! padding, an outbound firewall block of an own-supply answer, and the
//! inbound limiter left on. Every refused case asserts the returned error, zero
//! calls on the provider it must not reach and a failure audit row, and has a
//! benign control that dispatches. The firewall trigger is the AWS
//! documentation example key only.
use super::super::run_stream;
use super::*;
use crate::audit::{AuditBackend, AuditRecord, AuditRegistry};
use crate::custody::GatewayCustody;
use std::sync::Mutex;

const FAKE_AWS_KEY: &str = "AKIAIOSFODNN7EXAMPLE";
const OWN_SLOT: &str = "anthropic-credits";

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

fn disabled_audit() -> AuditLogger {
    AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger")
}

fn circuit_open(state: &AppState, provider: &str) -> bool {
    state
        .circuit_breaker
        .is_open(&current_circuit_key(state, provider))
}

fn assert_refused(error: &GatewayError, status: u16, case: &str) {
    assert!(
        matches!(error, GatewayError::ProviderRejected { status: carried, .. } if *carried == status),
        "{case}: expected the upstream {status} itself, got {error:?}"
    );
}

// ── stub chains ────────────────────────────────────────────────────────────

struct Chain {
    state: Arc<AppState>,
    calls: Vec<Arc<AtomicUsize>>,
    audit: Arc<RecordingAudit>,
}

impl Chain {
    fn calls(&self, index: usize) -> usize {
        self.calls[index].load(Ordering::SeqCst)
    }
}

/// `modes` in chain order (`primary`, `secondary`, `tertiary`), circuit
/// threshold 1, on `custody`.
fn chain(custody: GatewayCustody, modes: &[Mode]) -> Chain {
    const NAMES: [&str; 3] = ["primary", "secondary", "tertiary"];
    let names = &NAMES[..modes.len()];
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from(names[0]),
            fallback_chain: names.iter().map(|name| ProviderId::from(*name)).collect(),
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        circuit_breaker: CircuitBreakerConfig {
            enabled: true,
            failure_threshold: 1,
            reset_timeout_secs: 30,
        },
        ..GatewayConfig::default()
    };
    let mut state = AppState::new_for_test(
        config,
        disabled_audit(),
        crate::evals::EvalsRunner::new(EvalsConfig::default()),
    );
    state.custody = custody;
    let mut calls = Vec::new();
    for (name, mode) in names.iter().zip(modes) {
        let (provider, counter) = StubProvider::new(name, *mode);
        state
            .provider_runtime
            .register_for_test(provider as Arc<dyn Provider>);
        calls.push(counter);
    }
    let audit = record_audit(&mut state);
    Chain {
        state: Arc::new(state),
        calls,
        audit,
    }
}

#[tokio::test]
async fn probe_fleet_payment_required_is_terminal() {
    // Spec 00.12: on a floor-bound attempt only transport errors, 5xx, 408 and
    // 429 may fall back. A 402 is an upstream 4xx.
    let chain = chain(GatewayCustody::Fleet, &[Mode::PaymentRequired, Mode::Ok]);
    let result = run(Arc::clone(&chain.state), plain_ctx(), ping_body()).await;
    assert!(result.is_err(), "a 402 on the fleet ends the request");
    assert_eq!(
        chain.calls(1),
        0,
        "a 402 is never retried with another vendor"
    );

    let result = run_stream(Arc::clone(&chain.state), plain_ctx(), ping_body()).await;
    assert!(
        result.is_err(),
        "a streamed 402 on the fleet ends the request"
    );
    assert_eq!(chain.calls(1), 0);
    assert_eq!(chain.audit.failures(), 2);
}

#[tokio::test]
async fn probe_managed_node_refusal_is_terminal() {
    // Spec P0-1 and the 00.12 Phase 0 note: the rule applies on custody
    // `Fleet` or `ManagedNode`.
    let chain = chain(
        GatewayCustody::ManagedNode,
        &[Mode::Rejected(403), Mode::Ok],
    );
    let error = run(Arc::clone(&chain.state), plain_ctx(), ping_body())
        .await
        .err()
        .expect("a managed-node refusal is returned");
    assert_refused(&error, 403, "managed node");
    assert_eq!(
        chain.calls(1),
        0,
        "a refusal is never retried on another vendor"
    );
    assert!(!circuit_open(&chain.state, "primary"));
}

#[tokio::test]
async fn probe_fleet_health_fault_then_refusal_ends_at_the_refusal() {
    // The primary is genuinely down, the secondary refuses: the tertiary is
    // never asked, the refusal itself is returned, and only the faulty
    // provider's circuit opens.
    for streaming in [false, true] {
        let chain = chain(
            GatewayCustody::Fleet,
            &[Mode::Fail, Mode::Rejected(403), Mode::Ok],
        );
        let error = if streaming {
            run_stream(Arc::clone(&chain.state), plain_ctx(), ping_body())
                .await
                .err()
        } else {
            run(Arc::clone(&chain.state), plain_ctx(), ping_body())
                .await
                .err()
        }
        .expect("the refusal is returned");
        let case = format!("streaming={streaming}");
        assert_refused(&error, 403, &case);
        assert_eq!(chain.calls(0), 1, "{case}");
        assert_eq!(chain.calls(1), 1, "{case}");
        assert_eq!(
            chain.calls(2),
            0,
            "{case}: no vendor shopping after a refusal"
        );
        assert!(circuit_open(&chain.state, "primary"), "{case}");
        assert!(!circuit_open(&chain.state, "secondary"), "{case}");
        assert_eq!(chain.audit.failures(), 1, "{case}");
    }

    // Benign control: two health faults still reach the tertiary.
    let chain = chain(GatewayCustody::Fleet, &[Mode::Fail, Mode::Fail, Mode::Ok]);
    let out = run(Arc::clone(&chain.state), plain_ctx(), ping_body())
        .await
        .expect("the tertiary serves");
    assert_eq!(out.provider_used, "tertiary");
}

#[tokio::test]
async fn probe_fleet_unusual_client_statuses_are_terminal() {
    for status in [
        405, 406, 410, 411, 413, 415, 418, 421, 423, 424, 425, 426, 428, 431, 499,
    ] {
        for streaming in [false, true] {
            let chain = chain(GatewayCustody::Fleet, &[Mode::Rejected(status), Mode::Ok]);
            let error = if streaming {
                run_stream(Arc::clone(&chain.state), plain_ctx(), ping_body())
                    .await
                    .err()
            } else {
                run(Arc::clone(&chain.state), plain_ctx(), ping_body())
                    .await
                    .err()
            }
            .expect("the refusal is returned");
            let case = format!("{status} streaming={streaming}");
            assert_refused(&error, status, &case);
            assert_eq!(chain.calls(1), 0, "{case}");
            assert!(!circuit_open(&chain.state, "primary"), "{case}");
            assert_eq!(chain.audit.failures(), 1, "{case}");
        }
    }
}

// ── own supply on the fleet ────────────────────────────────────────────────

/// What the own-supply slot answers with.
#[derive(Clone, Copy)]
enum SlotReply {
    /// A completion whose text is `content`.
    Ok(&'static str),
    /// An upstream 4xx refusal with this status.
    Rejected(u16),
    /// A 402 account payment state.
    PaymentRequired,
    /// A health fault whose message mentions a refusal status.
    FaultMentioning403,
}

struct ScriptedSlot {
    reply: Arc<Mutex<SlotReply>>,
    calls: Arc<AtomicUsize>,
}

impl ScriptedSlot {
    fn answer(&self) -> Result<&'static str, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match *self.reply.lock().expect("slot reply lock") {
            SlotReply::Ok(content) => Ok(content),
            SlotReply::Rejected(status) => Err(ProviderError::Rejected {
                status,
                message: format!("{OWN_SLOT} error {status}"),
            }),
            SlotReply::PaymentRequired => Err(ProviderError::PaymentRequired {
                provider: OWN_SLOT.to_owned(),
                message: "no credits".to_owned(),
            }),
            SlotReply::FaultMentioning403 => Err(ProviderError::Provider(format!(
                "{OWN_SLOT} error 500: upstream said 403 forbidden, model not found, no access"
            ))),
        }
    }
}

impl Provider for ScriptedSlot {
    fn name(&self) -> &'static str {
        OWN_SLOT
    }

    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        let answer = self.answer();
        Box::pin(async move {
            answer.map(|content| {
                json!({
                    "id": "chatcmpl-own",
                    "object": "chat.completion",
                    "model": "own-1",
                    "choices": [{
                        "index": 0,
                        "message": {"role": "assistant", "content": content},
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
        let answer = self.answer();
        Box::pin(async move {
            answer.map(|content| {
                let chunk = json!({"choices": [{"delta": {"content": content}}]});
                axum::body::Body::from(format!("data: {chunk}\n\ndata: [DONE]\n\n"))
            })
        })
    }
}

struct OwnSupply {
    state: Arc<AppState>,
    reply: Arc<Mutex<SlotReply>>,
    slot: Arc<AtomicUsize>,
    router: Arc<AtomicUsize>,
    audit: Arc<RecordingAudit>,
}

impl OwnSupply {
    fn set(&self, reply: SlotReply) {
        *self.reply.lock().expect("slot reply lock") = reply;
    }
    fn slot_calls(&self) -> usize {
        self.slot.load(Ordering::SeqCst)
    }
    fn router_calls(&self) -> usize {
        self.router.load(Ordering::SeqCst)
    }
    fn slot_quarantined(&self) -> bool {
        !self
            .state
            .own_supply
            .take_quarantine_counts(OWN_SLOT)
            .is_empty()
    }
    fn slot_circuit_open(&self) -> bool {
        circuit_open(&self.state, OWN_SLOT)
    }
}

struct OwnSupplyOptions {
    firewall_inbound: bool,
    firewall_outbound: bool,
    requests_per_minute: Option<u64>,
}

const PLAIN: OwnSupplyOptions = OwnSupplyOptions {
    firewall_inbound: false,
    firewall_outbound: false,
    requests_per_minute: None,
};

/// A fleet Gateway whose default route is the Ryu Router (`openrouter`) and
/// that also holds Ryu's own `anthropic-credits` slot, circuit threshold 1.
fn own_supply_fleet(reply: SlotReply, options: &OwnSupplyOptions) -> OwnSupply {
    let mut config = GatewayConfig::default();
    config.firewall.enabled = options.firewall_inbound || options.firewall_outbound;
    config.firewall.scan_inbound = options.firewall_inbound;
    config.firewall.scan_outbound = options.firewall_outbound;
    config.firewall.policy = crate::config::FirewallPolicy::Block;
    config.cache.enabled = false;
    match options.requests_per_minute {
        Some(limit) => {
            config.rate_limit.enabled = true;
            config.rate_limit.requests_per_minute = Some(limit);
        }
        None => config.rate_limit.enabled = false,
    }
    config.circuit_breaker = CircuitBreakerConfig {
        enabled: true,
        failure_threshold: 1,
        reset_timeout_secs: 30,
    };
    config.routing.default_provider = ProviderId::from("openrouter");
    config.routing.fallback_chain = Vec::new();
    let mut state = AppState::new_for_test(
        config,
        disabled_audit(),
        crate::evals::EvalsRunner::new(EvalsConfig::default()),
    );
    state.custody = GatewayCustody::Fleet;
    let (router, router_calls) = StubProvider::new("openrouter", Mode::Ok);
    let reply = Arc::new(Mutex::new(reply));
    let slot_calls = Arc::new(AtomicUsize::new(0));
    state
        .provider_runtime
        .register_for_test(router as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(Arc::new(ScriptedSlot {
            reply: Arc::clone(&reply),
            calls: Arc::clone(&slot_calls),
        }) as Arc<dyn Provider>);
    let audit = record_audit(&mut state);
    OwnSupply {
        state: Arc::new(state),
        reply,
        slot: slot_calls,
        router: router_calls,
        audit,
    }
}

fn own_ctx() -> RequestContext {
    free_credit_ctx(5_000_000)
}

async fn own_error(own: &OwnSupply, body: Value, streaming: bool) -> GatewayError {
    if streaming {
        run_stream(Arc::clone(&own.state), own_ctx(), body)
            .await
            .err()
            .expect("the streamed request fails")
    } else {
        run(Arc::clone(&own.state), own_ctx(), body)
            .await
            .err()
            .expect("the request fails")
    }
}

async fn own_served(own: &OwnSupply, body: Value, streaming: bool) {
    if streaming {
        let out = run_stream(Arc::clone(&own.state), own_ctx(), body)
            .await
            .expect("the stream is served");
        let _ = axum::body::to_bytes(out.body, usize::MAX).await;
    } else {
        run(Arc::clone(&own.state), own_ctx(), body)
            .await
            .expect("the request is served");
    }
}

#[tokio::test]
async fn probe_fleet_own_supply_payment_required_is_not_rerun_on_the_ryu_router() {
    // Spec 00.12 and D16: an own-supply 4xx other than 408 and 429 is terminal.
    for streaming in [false, true] {
        let own = own_supply_fleet(SlotReply::PaymentRequired, &PLAIN);
        let _ = own_error(&own, sonnet_body(), streaming).await;
        assert_eq!(own.slot_calls(), 1, "streaming={streaming}");
        assert_eq!(
            own.router_calls(),
            0,
            "streaming={streaming}: a 402 is not shopped to the Ryu Router route"
        );
    }
}

#[tokio::test]
async fn probe_fleet_own_supply_stream_refusals_and_quarantine() {
    // A streamed 403 is returned, never re-run, never quarantines.
    let own = own_supply_fleet(SlotReply::Rejected(403), &PLAIN);
    let error = own_error(&own, sonnet_body(), true).await;
    assert_refused(&error, 403, "stream 403");
    assert_eq!(own.router_calls(), 0);
    assert!(!own.slot_circuit_open());
    assert!(!own.slot_quarantined());
    assert_eq!(own.audit.failures(), 1);

    // A streamed 401 is a refused credential: returned, not re-run, the row
    // leaves the table and the circuit opens.
    let own = own_supply_fleet(SlotReply::Rejected(401), &PLAIN);
    let error = own_error(&own, sonnet_body(), true).await;
    assert_refused(&error, 401, "stream 401");
    assert_eq!(own.router_calls(), 0);
    assert!(own.slot_circuit_open());
    assert!(own.slot_quarantined());

    // A streamed 404 quarantines the row.
    let own = own_supply_fleet(SlotReply::Rejected(404), &PLAIN);
    let error = own_error(&own, sonnet_body(), true).await;
    assert_refused(&error, 404, "stream 404");
    assert_eq!(own.router_calls(), 0);
    assert!(own.slot_quarantined());

    // Control: a health fault whose message mentions "403 forbidden" and "not
    // found" is rescued on the Ryu Router route and never quarantines.
    for streaming in [false, true] {
        let own = own_supply_fleet(SlotReply::FaultMentioning403, &PLAIN);
        own_served(&own, sonnet_body(), streaming).await;
        assert_eq!(own.slot_calls(), 1, "streaming={streaming}");
        assert_eq!(own.router_calls(), 1, "streaming={streaming}");
        assert!(!own.slot_quarantined(), "streaming={streaming}");
    }
}

/// Long benign padding, so the marker sits far past any prefix a scanner
/// might stop at.
fn padding() -> String {
    "lorem ipsum dolor sit amet ".repeat(2_500)
}

/// Request bodies that carry the fake key in shapes other than one plain
/// string: an array of content parts after padding, a second content part,
/// stringified JSON, a nested earlier turn and a tool result.
fn marker_bodies(marker: &str) -> Vec<(&'static str, Value)> {
    let pad = padding();
    let stringified = json!({"config": {"deploy": {"aws": {"access_key_id": marker}}}}).to_string();
    vec![
        (
            "content parts after padding",
            json!({
                "model": "anthropic/claude-sonnet-4.5",
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text": pad},
                    {"type": "text", "text": format!("deploy with {marker}")}
                ]}]
            }),
        ),
        (
            "stringified json",
            json!({
                "model": "anthropic/claude-sonnet-4.5",
                "messages": [{"role": "user", "content": format!("{pad} {stringified}")}]
            }),
        ),
        (
            "earlier turn",
            json!({
                "model": "anthropic/claude-sonnet-4.5",
                "messages": [
                    {"role": "user", "content": format!("{pad} deploy with {marker}")},
                    {"role": "assistant", "content": "ok"},
                    {"role": "user", "content": "ping"}
                ]
            }),
        ),
        (
            "system prompt",
            json!({
                "model": "anthropic/claude-sonnet-4.5",
                "messages": [
                    {"role": "system", "content": format!("{pad} key {marker}")},
                    {"role": "user", "content": "ping"}
                ]
            }),
        ),
    ]
}

#[tokio::test]
async fn probe_fleet_own_supply_marker_shapes_block_without_health_effects() {
    for streaming in [false, true] {
        for (shape, body) in marker_bodies(FAKE_AWS_KEY) {
            let case = format!("{shape} streaming={streaming}");
            let own = own_supply_fleet(
                SlotReply::Ok("pong"),
                &OwnSupplyOptions {
                    firewall_inbound: true,
                    ..PLAIN
                },
            );
            let error = own_error(&own, body, streaming).await;
            assert!(
                matches!(error, GatewayError::FirewallBlocked(..)),
                "{case}: {error:?}"
            );
            assert_eq!(own.slot_calls(), 0, "{case}");
            assert_eq!(own.router_calls(), 0, "{case}");
            assert!(!own.slot_circuit_open(), "{case}");
            assert!(!own.slot_quarantined(), "{case}");
            assert_eq!(own.audit.failures(), 1, "{case}");

            // Benign control: the same shape without the marker is served on
            // own supply by the same Gateway.
            let (_, clean) = marker_bodies("no-secret-here")
                .into_iter()
                .find(|(name, _)| *name == shape)
                .expect("matching clean shape");
            own_served(&own, clean, streaming).await;
            assert_eq!(own.slot_calls(), 1, "{case}");
            assert_eq!(own.router_calls(), 0, "{case}");
        }
    }
}

#[tokio::test]
async fn probe_fleet_own_supply_outbound_block_is_not_rerun_or_penalized() {
    // The slot answers with the fake key; the outbound firewall stops it. The
    // block must not re-run the request on the Ryu Router route, quarantine
    // the row or open the circuit.
    let leaked: &'static str = "the key is AKIAIOSFODNN7EXAMPLE";
    let own = own_supply_fleet(
        SlotReply::Ok(leaked),
        &OwnSupplyOptions {
            firewall_outbound: true,
            ..PLAIN
        },
    );
    let result = run(Arc::clone(&own.state), own_ctx(), sonnet_body()).await;
    match result {
        Err(error) => assert!(error.is_safety_outcome(), "{error:?}"),
        Ok(out) => assert!(
            !out.response.to_string().contains(FAKE_AWS_KEY),
            "an outbound secret is never returned"
        ),
    }
    assert_eq!(own.slot_calls(), 1);
    assert_eq!(own.router_calls(), 0, "an outbound block is not shopped");
    assert!(!own.slot_circuit_open());
    assert!(!own.slot_quarantined());

    // Benign control: a clean answer is served on own supply.
    own.set(SlotReply::Ok("pong"));
    own_served(&own, sonnet_body(), false).await;
    assert_eq!(own.slot_calls(), 2);
    assert_eq!(own.router_calls(), 0);
}

#[tokio::test]
async fn probe_fleet_inbound_limiter_is_not_a_health_signal() {
    // The inbound limiter left on with a tiny budget: once it refuses, the
    // refusal is returned as itself, nothing is dispatched or penalized, and
    // the served requests stayed on own supply.
    let own = own_supply_fleet(
        SlotReply::Ok("pong"),
        &OwnSupplyOptions {
            requests_per_minute: Some(2),
            ..PLAIN
        },
    );
    let mut limited = 0;
    for round in 0..6 {
        let mut body = sonnet_body();
        body["messages"][0]["content"] = json!(format!("ping {round}"));
        match run(Arc::clone(&own.state), own_ctx(), body).await {
            Ok(_) => {}
            Err(GatewayError::RateLimited | GatewayError::RateLimitedBy(_)) => limited += 1,
            Err(other) => panic!("round {round}: {other:?}"),
        }
    }
    assert!(limited > 0, "the limiter refuses once its budget is spent");
    assert_eq!(
        own.slot_calls(),
        6 - limited,
        "only admitted requests dispatch"
    );
    assert_eq!(own.router_calls(), 0, "a limited request is never shopped");
    assert!(!own.slot_circuit_open());
    assert!(!own.slot_quarantined());
    assert_eq!(own.audit.failures(), limited);
}
