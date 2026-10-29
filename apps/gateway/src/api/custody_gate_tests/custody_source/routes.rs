//! Custody-source probes over the floor-bound routes, the exposure hardening
//! and hosted route gates under compose custody, and the hazard screener on
//! every floor-bound route.
use super::*;

// ── floor-bound routes ───────────────────────────────────────────────────────

#[tokio::test]
async fn probe_floor_bound_routes_refuse_on_vault_custody_without_a_floor() {
    let mut misses = Vec::new();
    for (case_env, env) in [
        ("vault pair", vault_pair_env()),
        ("vault required", vault_required_env()),
    ] {
        let probe = probe_gateway(&env, |_| {});
        assert_eq!(probe.custody, GatewayCustody::Fleet);
        for (route, uri, body) in floor_bound_routes() {
            let before = probe.calls.load(Ordering::SeqCst);
            let (status, reply) = send(&probe.app, uri, Some(TENANT), &body, false).await;
            let after = probe.calls.load(Ordering::SeqCst);
            if !is_screening_unavailable(status, &reply) || after != before {
                misses.push(format!(
                    "{case_env} {route}: {status} calls+{} {reply}",
                    after - before
                ));
            }
        }
        let provider_call = json!({
            "provider": "composio",
            "toolId": "probe-tool",
            "method": "POST",
            "requestId": "probe-request-1",
            "orgId": ORG
        });
        let (status, reply) = send(
            &probe.app,
            "/v1/providers/call",
            Some(CORE),
            &provider_call,
            false,
        )
        .await;
        if !is_screening_unavailable(status, &reply) {
            misses.push(format!("{case_env} providers/call: {status} {reply}"));
        }
    }
    assert!(
        misses.is_empty(),
        "floor-bound routes served without a floor:\n{}",
        misses.join("\n")
    );
}

#[tokio::test]
async fn probe_floor_bound_routes_dispatch_on_the_self_host_compose_env() {
    let probe = probe_gateway(&compose_env(), |_| {});
    assert_eq!(probe.custody, GatewayCustody::SelfHosted);
    assert!(probe.state.config.fleet, "the compose flag is loaded");
    assert!(probe.state.platform_floor.current().is_none());
    let mut misses = Vec::new();
    for (route, uri, body) in floor_bound_routes() {
        let before = probe.calls.load(Ordering::SeqCst);
        let (status, reply) = send(&probe.app, uri, Some(TENANT), &body, false).await;
        let after = probe.calls.load(Ordering::SeqCst);
        if status != StatusCode::OK || after != before + 1 {
            misses.push(format!(
                "{route}: {status} calls+{} {reply}",
                after - before
            ));
        }
    }
    let provider_call = json!({
        "provider": "composio",
        "toolId": "probe-tool",
        "method": "POST",
        "requestId": "probe-request-1",
        "orgId": ORG
    });
    let (status, reply) = send(
        &probe.app,
        "/v1/providers/call",
        Some(CORE),
        &provider_call,
        false,
    )
    .await;
    if is_screening_unavailable(status, &reply) {
        misses.push(format!(
            "providers/call: the floor bound a self-hosted node: {reply}"
        ));
    }
    assert!(
        misses.is_empty(),
        "self-hosted compose routes did not dispatch:\n{}",
        misses.join("\n")
    );
}

#[tokio::test]
async fn probe_cache_hit_never_serves_a_fleet_request_once_the_floor_is_gone() {
    let body =
        json!({ "model": "fixture-model", "messages": [{ "role": "user", "content": SENTINEL }] });
    let fleet = probe_gateway(&vault_pair_env(), |config| config.cache.enabled = true);
    assert!(fleet
        .state
        .platform_floor
        .observe(Some(&PlatformFloor::setting_nothing())));
    let (status, reply) = send(
        &fleet.app,
        "/v1/chat/completions",
        Some(TENANT),
        &body,
        false,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "warm-up: {reply}");
    let warmed = fleet.calls.load(Ordering::SeqCst);
    assert_eq!(warmed, 1);
    fleet.state.platform_floor.clear();
    let (status, reply) = send(
        &fleet.app,
        "/v1/chat/completions",
        Some(TENANT),
        &body,
        false,
    )
    .await;
    assert!(
        is_screening_unavailable(status, &reply),
        "cache served past the floor: {status} {reply}"
    );
    assert_eq!(fleet.calls.load(Ordering::SeqCst), warmed);

    // The compose twin holds no floor at all and serves both requests.
    let twin = probe_gateway(&compose_env(), |config| config.cache.enabled = true);
    for round in 0..2 {
        let (status, reply) = send(
            &twin.app,
            "/v1/chat/completions",
            Some(TENANT),
            &body,
            false,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "round {round}: {reply}");
    }
    assert!(twin.calls.load(Ordering::SeqCst) >= 1);
}

#[tokio::test]
async fn probe_fallback_after_an_upstream_refusal_follows_custody_not_the_flag() {
    let body =
        json!({ "model": "fixture-model", "messages": [{ "role": "user", "content": SENTINEL }] });
    let chain = |config: &mut GatewayConfig| {
        config.routing.default_provider = ProviderId::from(REJECTING);
        config.routing.fallback_chain = vec![ProviderId::from(FIXTURE)];
    };

    // Self-hosted with the compose flag keeps its configured fallback chain.
    let twin = probe_gateway(&compose_env(), chain);
    let (status, reply) = send(
        &twin.app,
        "/v1/chat/completions",
        Some(TENANT),
        &body,
        false,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "self-hosted fallback: {reply}");
    assert_eq!(
        twin.calls.load(Ordering::SeqCst),
        2,
        "refusal then fallback"
    );

    // Fleet custody ends the chain on the refusal.
    let fleet = probe_gateway(&vault_pair_env(), chain);
    assert!(fleet
        .state
        .platform_floor
        .observe(Some(&PlatformFloor::setting_nothing())));
    let (status, reply) = send(
        &fleet.app,
        "/v1/chat/completions",
        Some(TENANT),
        &body,
        false,
    )
    .await;
    assert_ne!(
        status,
        StatusCode::OK,
        "fleet fell back after a refusal: {reply}"
    );
    assert_eq!(
        fleet.calls.load(Ordering::SeqCst),
        1,
        "fleet tried a second provider"
    );
}

// ── exposure hardening and hosted route gates under compose custody ──────────

#[tokio::test]
async fn probe_compose_passthrough_is_mounted_but_hardened() {
    let probe = probe_gateway(&compose_env(), |_| {});
    let (status, body) = send(
        &probe.app,
        "/passthrough/anthropic/v1/messages",
        None,
        &json!({}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body, json!("passthrough proxy is disabled in fleet mode"));

    let fleet = probe_gateway(&vault_pair_env(), |_| {});
    let (status, _) = send(
        &fleet.app,
        "/passthrough/anthropic/v1/messages",
        None,
        &json!({}),
        true,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "vault custody mounts no passthrough"
    );
}

#[tokio::test]
async fn probe_compose_flag_drops_loopback_admin_trust_on_zero_config() {
    let zero_config = |config: &mut GatewayConfig| {
        config.auth.require_auth = false;
        config.auth.master_key = None;
        config.auth.api_keys = Vec::new();
    };
    let flagged = probe_gateway(&compose_env(), zero_config);
    assert_eq!(flagged.custody, GatewayCustody::SelfHosted);
    let (status, text) = get_route(&flagged.app, "/v1/egress/posture", true).await;
    assert_ne!(
        status,
        StatusCode::OK,
        "compose flag trusted a loopback admin: {text}"
    );

    // Control: the same self-hosted env without the flag keeps local trust.
    let mut unflagged_env = compose_env();
    unflagged_env.remove("RYU_GATEWAY_FLEET");
    let unflagged = probe_gateway(&unflagged_env, zero_config);
    let (status, text) = get_route(&unflagged.app, "/v1/egress/posture", true).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "control must reach the admin route: {text}"
    );
}

#[tokio::test]
async fn probe_compose_custody_keeps_self_host_route_gates_open() {
    let probe = probe_gateway(&compose_env(), |_| {});
    // A Gateway token in the query is a fleet-only refusal.
    let chat =
        json!({ "model": "fixture-model", "messages": [{ "role": "user", "content": SENTINEL }] });
    let uri = format!("/v1/chat/completions?key={RGW_TOKEN}");
    let (status, reply) = send(&probe.app, &uri, Some(TENANT), &chat, false).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "query credential refused on self-host: {reply}"
    );

    // Server tools are a fleet-only refusal.
    let mut tooled = chat.clone();
    tooled["tools"] = json!([{ "type": "web_search_20250305", "name": "web_search" }]);
    let (status, reply) = send(
        &probe.app,
        "/v1/chat/completions",
        Some(TENANT),
        &tooled,
        false,
    )
    .await;
    assert!(
        !reply.to_string().contains("feature_not_permitted"),
        "server tool refused on self-host: {status} {reply}"
    );
    assert_eq!(status, StatusCode::OK, "server tool on self-host: {reply}");

    // The same request on vault custody is refused for both.
    let fleet = probe_gateway(&vault_pair_env(), |_| {});
    assert!(fleet
        .state
        .platform_floor
        .observe(Some(&PlatformFloor::setting_nothing())));
    let (status, _) = send(&fleet.app, &uri, Some(TENANT), &chat, false).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "fleet accepted a query credential"
    );
    let before = fleet.calls.load(Ordering::SeqCst);
    let (status, reply) = send(
        &fleet.app,
        "/v1/chat/completions",
        Some(TENANT),
        &tooled,
        false,
    )
    .await;
    assert!(
        reply.to_string().contains("feature_not_permitted"),
        "fleet served a server tool: {status} {reply}"
    );
    assert_eq!(fleet.calls.load(Ordering::SeqCst), before);
}

#[tokio::test]
async fn probe_health_reports_the_derived_custody_to_the_master_key() {
    for (env, expected) in [(compose_env(), "self_hosted"), (vault_pair_env(), "fleet")] {
        let probe = probe_gateway(&env, |_| {});
        let request = Request::builder()
            .method(Method::GET)
            .uri("/health")
            .header("authorization", format!("Bearer {MASTER}"))
            .extension(peer(false))
            .body(Body::empty())
            .expect("request builds");
        let response = probe
            .app
            .clone()
            .oneshot(request)
            .await
            .expect("router responds");
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body reads");
        let body: Value = serde_json::from_slice(&bytes).expect("health is json");
        assert_eq!(body["custody"], expected, "{body}");
    }
}

// ── the hazard screener on every floor-bound route ───────────────────────────

/// A vault-custody Gateway like [`probe_gateway`], with a live screener over
/// the deterministic `TestBackend` and a floor that qualifies it for S4 and
/// S9, so these probes reach the screener through each route rather than
/// through a direct call.
fn screened_probe() -> Probe {
    let custody = custody_of(&vault_pair_env());
    assert_eq!(custody, GatewayCustody::Fleet);
    let (mut state, _audit) = state_with(custody, |config| {
        config.rate_limit.enabled = false;
        config.auth.api_keys = vec![key(TENANT, "tenant", false), key(CORE, "core", true)];
        config.routing.default_provider = ProviderId::from(FIXTURE);
        config.routing.fallback_chain = vec![];
    });
    let backend: Arc<dyn ryu_gw_screening::ScreenerBackend> = Arc::new(
        ryu_gw_screening::backends::test::TestBackend::new("decision_local"),
    );
    state.screening = Arc::new(crate::screening::ScreeningRuntime::with_backends(
        &Default::default(),
        vec![(
            backend,
            crate::config::ScreeningBackendKind::DecisionLocal,
            None,
        )],
    ));
    let floor = PlatformFloor::from_wire(
        Some(&json!({
            "version": 4,
            "overlay": { "enabled": true, "scan_inbound": true },
            "screener": {
                "templateVersion": 1,
                "roles": {
                    "textHazard": ["decision_local"],
                    "promptAttack": ["decision_local"],
                    "output": ["decision_local"]
                },
                "qualifications": [{
                    "backendId": "decision_local",
                    "model": "test-model",
                    "weightsSha256": "0000000000000000",
                    "templateVersion": 1,
                    "codes": ["hazard.S4", "hazard.S9"],
                    "evalRef": "eval_test_sentinels"
                }]
            }
        })),
        false,
    )
    .expect("screener floor parses");
    state.platform_floor = crate::platform_floor::FloorStore::with(floor);
    let calls = Arc::new(AtomicUsize::new(0));
    state
        .provider_runtime
        .register_for_test(Arc::new(ProbeProvider {
            name: FIXTURE,
            calls: Arc::clone(&calls),
            reject: false,
        }));
    let state = Arc::new(state);
    Probe {
        app: crate::api::router(Arc::clone(&state)),
        state,
        calls,
        custody,
    }
}

/// The same body with the sentinel replaced by benign text.
fn benign(body: &Value) -> Value {
    serde_json::from_str(&body.to_string().replace(SENTINEL, "benign screener probe"))
        .expect("benign twin")
}

#[tokio::test]
async fn probe_the_screener_blocks_on_every_floor_bound_route_and_passes_its_twin() {
    let probe = screened_probe();
    let mut misses = Vec::new();
    let provider_call = json!({
        "provider": "composio",
        "toolId": "probe-tool",
        "method": "POST",
        "requestId": "probe-request-1",
        "orgId": ORG,
        "body": { "text": SENTINEL }
    });
    let mut routes: Vec<(&str, &str, Value, &str)> = floor_bound_routes()
        .into_iter()
        .map(|(route, uri, body)| (route, uri, body, TENANT))
        .collect();
    routes.push(("providers/call", "/v1/providers/call", provider_call, CORE));
    for (route, uri, body, bearer) in routes {
        let before = probe.calls.load(Ordering::SeqCst);
        let (status, reply) = send(&probe.app, uri, Some(bearer), &body, false).await;
        let after = probe.calls.load(Ordering::SeqCst);
        let text = reply.to_string();
        if status != StatusCode::FORBIDDEN
            || !text.contains("platform_floor_blocked")
            || after != before
        {
            misses.push(format!(
                "{route} blocked: {status} calls+{} {text}",
                after - before
            ));
        }
        if route == "providers/call" {
            // Its twin needs a live Composio account; the block is what this
            // probe proves for that route.
            continue;
        }
        let before = probe.calls.load(Ordering::SeqCst);
        let (status, reply) = send(&probe.app, uri, Some(bearer), &benign(&body), false).await;
        let after = probe.calls.load(Ordering::SeqCst);
        if status != StatusCode::OK || after != before + 1 {
            misses.push(format!(
                "{route} twin: {status} calls+{} {reply}",
                after - before
            ));
        }
    }
    assert!(
        misses.is_empty(),
        "screener misses on floor-bound routes:\n{}",
        misses.join("\n")
    );
    // The screener reached every route through the request path, not a
    // direct call: the tool-loop hook is live on this custody too.
    assert!(probe.state.screening.tier(probe.custody).is_some());
}
