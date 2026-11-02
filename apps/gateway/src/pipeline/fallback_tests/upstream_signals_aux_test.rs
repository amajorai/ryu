//! Upstream refusals of auxiliary sub-calls that carry the tenant's text
//! (the inspector, the escalation judge, the semantic-cache embedding).

use super::*;

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

/// Off the fleet a provider refusal is an operator's own business, not an
/// upstream safety event: a sub-call with a fallback keeps serving. The
/// inspector runs here under `warn_and_continue`, its documented opt-out,
/// because under `block` a refusal is a missing verdict and refuses the turn
/// (see the next test).
#[tokio::test]
async fn a_self_hosted_auxiliary_sub_call_refusal_still_fails_open() {
    for (label, configure, _) in AUX_SUB_CALLS {
        let chain = aux_chain(GatewayCustody::SelfHosted, |config| {
            configure(config);
            config.firewall.inspector.action = crate::config::FirewallPolicy::WarnAndContinue;
        });
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

/// GuardBreaker: a judge whose provider refuses gave no verdict, so a
/// self-hosted inspector under `block` refuses the turn rather than
/// forwarding it, and records no upstream-safety event.
#[tokio::test]
async fn a_self_hosted_block_inspector_refuses_a_turn_its_judge_refused() {
    let chain = aux_chain(GatewayCustody::SelfHosted, with_inspector);
    let error = run(
        Arc::clone(&chain.state),
        tenant("req-up-aux-block"),
        ping_body(),
    )
    .await
    .err()
    .expect("a Block inspector with no verdict refuses the turn");
    assert!(
        matches!(&error, GatewayError::FirewallBlocked(reason, _)
            if reason.contains(crate::firewall::inspector::UNAVAILABLE_CATEGORY)),
        "{error:?}"
    );
    assert_eq!(chain.refuser.load(Ordering::SeqCst), 1);
    assert_eq!(
        chain.primary.load(Ordering::SeqCst) + chain.secondary.load(Ordering::SeqCst),
        0,
        "the unjudged turn is never dispatched"
    );
    assert!(events(&chain.state)
        .iter()
        .all(|event| event.category != "abuse.upstream_content_refused"));
}
