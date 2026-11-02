//! Upstream refusals of provider-pool legs (Fusion panels, Pipeline stages).

use super::*;

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
