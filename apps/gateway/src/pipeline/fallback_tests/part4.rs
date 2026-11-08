use super::*;

/// A generic (non-429) primary failure trips the circuit breaker AND fails over
/// to the secondary. With `failure_threshold == 1` a single failure opens the
/// primary circuit.
#[tokio::test]
async fn generic_primary_failure_trips_circuit_and_fails_over() {
    let mut state = chain_state(1);
    let (primary, primary_calls) = StubProvider::new("primary", Mode::Fail);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let out = run(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("secondary must serve after primary faults");

    assert_eq!(out.provider_used, "secondary");
    assert_eq!(
        out.degraded,
        Some(DegradedMode::Fallback("secondary".into()))
    );
    assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
    // A fault DOES trip the circuit (threshold 1).
    assert!(
        state
            .circuit_breaker
            .is_open(&current_circuit_key(&state, "primary")),
        "a generic provider fault must open the primary's circuit"
    );
}

/// An already-open primary circuit is skipped entirely (its `complete()` is
/// never called), and the request is served by the secondary as a fallback.
#[tokio::test]
async fn open_primary_circuit_is_skipped() {
    let mut state = chain_state(1);
    let (primary, primary_calls) = StubProvider::new("primary", Mode::Ok);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    // Force the primary circuit open before any request.
    state
        .circuit_breaker
        .record_failure(&current_circuit_key(&state, "primary"));
    assert!(state
        .circuit_breaker
        .is_open(&current_circuit_key(&state, "primary")));
    let state = Arc::new(state);

    let out = run(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("secondary serves when primary circuit is open");

    assert_eq!(out.provider_used, "secondary");
    assert_eq!(
        out.degraded,
        Some(DegradedMode::Fallback("secondary".into()))
    );
    assert_eq!(
        primary_calls.load(Ordering::SeqCst),
        0,
        "an open circuit must skip the provider without calling it"
    );
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
}

/// When every provider in the chain rate-limits, the whole chain is exhausted
/// and the typed `ProviderRateLimited` error surfaces (never a silent success).
#[tokio::test]
async fn all_providers_rate_limited_surfaces_typed_error() {
    let mut state = chain_state(5);
    let (primary, _) = StubProvider::new("primary", Mode::RateLimited);
    let (secondary, _) = StubProvider::new("secondary", Mode::RateLimited);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let err = match run(Arc::clone(&state), plain_ctx(), ping_body()).await {
        Err(e) => e,
        Ok(_) => panic!("an exhausted chain must error, not succeed"),
    };
    // The last error was a rate-limit; it is preserved as the typed variant.
    assert!(
        matches!(err, GatewayError::ProviderRateLimited { .. }),
        "exhausted-by-rate-limit must surface ProviderRateLimited, got {err:?}"
    );
}

/// When a generic-fault chain is exhausted, the error is wrapped into the
/// stable `AllProvidersUnavailable` variant so clients get a consistent code.
#[tokio::test]
async fn all_providers_fault_surfaces_all_unavailable() {
    let mut state = chain_state(5);
    let (primary, _) = StubProvider::new("primary", Mode::Fail);
    let (secondary, _) = StubProvider::new("secondary", Mode::Fail);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let err = match run(Arc::clone(&state), plain_ctx(), ping_body()).await {
        Err(e) => e,
        Ok(_) => panic!("an exhausted fault chain must error"),
    };
    assert!(
        matches!(err, GatewayError::AllProvidersUnavailable(_)),
        "exhausted-by-fault must wrap into AllProvidersUnavailable, got {err:?}"
    );
}

/// The happy path: a healthy primary serves the turn and the response is NOT
/// flagged degraded (no fallback occurred).
#[tokio::test]
async fn healthy_primary_serves_without_degradation() {
    let mut state = chain_state(5);
    let (primary, primary_calls) = StubProvider::new("primary", Mode::Ok);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let out = run(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("healthy primary serves");

    assert_eq!(out.provider_used, "primary");
    assert_eq!(out.degraded, None, "no fallback ⇒ not degraded");
    assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        secondary_calls.load(Ordering::SeqCst),
        0,
        "secondary must not be touched when the primary succeeds"
    );
}

/// A second identical request is served from the exact-match cache: the
/// provider is invoked once (the priming call), and the cached turn reports
/// `cache_hit`.
#[tokio::test]
async fn identical_request_is_served_from_cache_on_second_call() {
    let mut state = chain_state(5);
    let (primary, primary_calls) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let state = Arc::new(state);

    // Prime the cache.
    let first = run(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("first call");
    assert!(!first.cache_hit, "the priming call is a miss");
    assert_eq!(primary_calls.load(Ordering::SeqCst), 1);

    // Identical body ⇒ exact-match hit; the provider is NOT called again.
    let second = run(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("second call served from cache");
    assert!(second.cache_hit, "identical request must hit the cache");
    assert_eq!(
        primary_calls.load(Ordering::SeqCst),
        1,
        "a cache hit must not re-invoke the provider"
    );
}

/// Two credentials with no org must not share an exact-cache entry: neither
/// can confirm or read the other's prompt and answer.
#[tokio::test]
async fn exact_cache_is_partitioned_by_credential() {
    let mut state = chain_state(5);
    let (primary, primary_calls) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let first = run(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("priming call");
    assert!(!first.cache_hit);

    let mut other = plain_ctx();
    other.api_key = "sk-other-team".to_string();
    other.owner_binding = ryu_gw_credentials::fingerprint("sk-other-team");
    let second = run(Arc::clone(&state), other, ping_body())
        .await
        .expect("other credential");
    assert!(
        !second.cache_hit,
        "another credential must not be served the first caller's entry"
    );
    assert_eq!(primary_calls.load(Ordering::SeqCst), 2);

    let third = run(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("same credential again");
    assert!(
        third.cache_hit,
        "the same credential still hits its own entry"
    );
    assert_eq!(primary_calls.load(Ordering::SeqCst), 2);
}

/// A cached answer was DLP'd for whoever populated it. A stricter agent served
/// that entry must still get its own outbound policy, not the lax one's.
#[tokio::test]
async fn cache_hit_applies_the_requesting_agents_outbound_dlp() {
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: true,
            scan_inbound: true,
            scan_outbound: false,
            ..FirewallConfig::default()
        },
        ..GatewayConfig::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);
    let calls = Arc::new(AtomicUsize::new(0));
    state
        .provider_runtime
        .register_for_test(Arc::new(PiiAnswerProvider {
            calls: Arc::clone(&calls),
        }) as Arc<dyn Provider>);
    let state = Arc::new(state);
    state.set_policy(crate::policy::EffectivePolicy {
        agent_overlays: std::collections::HashMap::from([(
            "strict-agent".to_owned(),
            crate::config::FirewallOverlay {
                scan_outbound: Some(true),
                ..Default::default()
            },
        )]),
        ..crate::policy::EffectivePolicy::default()
    });

    let lax = run(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("the lax agent is served the raw answer");
    assert!(!lax.cache_hit);
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let mut strict = plain_ctx();
    strict.agent_id = Some("strict-agent".to_owned());
    let err = match run(Arc::clone(&state), strict, ping_body()).await {
        Err(err) => err,
        Ok(out) => panic!(
            "the strict agent must not receive the cached PII: {}",
            out.response
        ),
    };
    assert!(
        matches!(err, GatewayError::FirewallBlocked(..)),
        "expected the strict agent's Block policy on the cache hit, got {err:?}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "the strict request was answered from the cache, not the provider"
    );
}

/// The firewall integration point: with the inbound scanner on and a `Block`
/// policy, a request carrying a detectable secret/PII is refused BEFORE any
/// provider is reached (`FirewallBlocked`, provider never called).
#[tokio::test]
async fn inbound_firewall_block_short_circuits_before_the_provider() {
    use crate::config::FirewallPolicy;
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: true,
            scan_inbound: true,
            policy: FirewallPolicy::Block,
            ..FirewallConfig::default()
        },
        ..GatewayConfig::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);
    let (primary, primary_calls) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let state = Arc::new(state);

    // A prompt carrying an email + an OpenAI-style key — the built-in scanner's
    // canonical detection fixture.
    let body = json!({
        "model": "anything",
        "messages": [{
            "role": "user",
            "content": "Contact user@example.com or use key sk-abcdefghijklmnopqrstu"
        }]
    });
    let err = match run(Arc::clone(&state), plain_ctx(), body).await {
        Err(e) => e,
        Ok(_) => panic!("a Block-policy firewall must refuse the request"),
    };
    assert!(
        matches!(err, GatewayError::FirewallBlocked(..)),
        "expected FirewallBlocked, got {err:?}"
    );
    assert_eq!(
        primary_calls.load(Ordering::SeqCst),
        0,
        "an inbound block must short-circuit before the provider is called"
    );
}

/// Streaming happy path: a healthy primary serves the SSE stream directly, the
/// turn is not degraded, and the body drains to the provider's frames.
#[tokio::test]
async fn run_stream_serves_primary_without_degradation() {
    use super::super::run_stream;
    let mut state = chain_state(5);
    let (primary, primary_calls) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let out = run_stream(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("primary streams");
    assert_eq!(out.provider_used, "primary");
    assert_eq!(out.degraded, None);
    assert_eq!(primary_calls.load(Ordering::SeqCst), 1);

    // Draining the SSE body yields the provider's frames.
    let bytes = axum::body::to_bytes(out.body, usize::MAX)
        .await
        .expect("drain sse body");
    let text = String::from_utf8_lossy(&bytes);
    assert!(
        text.contains("pong"),
        "stream carries the provider's content"
    );
    assert!(text.contains("[DONE]"), "stream is terminated");
}

/// Streaming fallback: a rate-limited primary demotes and the secondary streams,
/// with the turn flagged as a degraded fallback.
#[tokio::test]
async fn run_stream_demotes_rate_limited_primary_to_secondary() {
    use super::super::run_stream;
    let mut state = chain_state(5);
    let (primary, primary_calls) = StubProvider::new("primary", Mode::RateLimited);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let out = run_stream(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("secondary streams after primary rate-limits");
    assert_eq!(out.provider_used, "secondary");
    assert_eq!(
        out.degraded,
        Some(DegradedMode::Fallback("secondary".into()))
    );
    assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
    // The 429 on the stream path must not trip the primary's circuit either.
    assert!(!state
        .circuit_breaker
        .is_open(&current_circuit_key(&state, "primary")));

    // Body still drains cleanly.
    let bytes = axum::body::to_bytes(out.body, usize::MAX)
        .await
        .expect("drain sse body");
    assert!(String::from_utf8_lossy(&bytes).contains("[DONE]"));
}
