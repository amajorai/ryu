//! Fleet screener probes: the committed `fleet/screening.toml` on the wire,
//! qualified, across every inbound route, output, tools, providers, fallback
//! and caches. The shared harness is in `fleet_probe_tests.rs`.

use super::*;

// ── the committed table on the wire, qualified ──────────────────────────────

/// With a qualification naming the fleet model and digest, the committed
/// table's decision model blocks S9 on every floor-bound inbound route, and
/// the model the compose sets is the model on the wire.
#[tokio::test]
async fn probe_fleet_table_blocks_a_hard_code_on_every_inbound_route() {
    let mock = MockServer::systemone().await;
    let g = fleet_gateway(&mock.base_url, fleet_qualified_floor(3), "ok");
    let mut misses = Vec::new();
    // A distinct text per route, so no route is answered from another's
    // segment cache entry.
    let count = inbound_routes("count").len();
    for index in 0..count {
        let (route, uri, body) =
            inbound_routes(&format!("{SENTINEL_HAZARD_S9} request {index}")).swap_remove(index);
        let before = mock.calls();
        let (status, _, raw) = send(&g.app, Method::POST, &uri, Some(&body)).await;
        if status != StatusCode::FORBIDDEN || !raw.contains("platform_floor_blocked") {
            misses.push(format!("{route}: {status} {}", short(&raw)));
        } else if mock.calls() == before {
            misses.push(format!("{route}: blocked without asking the screener"));
        }
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
    assert_eq!(
        g.calls.load(Ordering::SeqCst),
        0,
        "a blocked request reached the provider"
    );
    let models: Vec<Value> = mock
        .requests()
        .iter()
        .map(|r| r.body["model"].clone())
        .collect();
    assert!(
        !models.is_empty() && models.iter().all(|m| m == FLEET_MODEL),
        "the screener was not sent the compose model: {models:?}"
    );

    let mut misses = Vec::new();
    for (route, uri, body) in inbound_routes("benign fleet twin") {
        let (status, _, raw) = send(&g.app, Method::POST, &uri, Some(&body)).await;
        if screening_refusal(status, &raw) {
            misses.push(format!("{route}: {status} {}", short(&raw)));
        }
    }
    assert!(
        misses.is_empty(),
        "benign twins refused:\n{}",
        misses.join("\n")
    );
}

#[tokio::test]
async fn probe_fleet_table_blocks_output_buffered_and_streamed() {
    let mock = MockServer::systemone().await;
    let g = fleet_gateway(
        &mock.base_url,
        fleet_qualified_floor(3),
        &format!("reply {SENTINEL_HAZARD_S9}"),
    );
    let mut misses = Vec::new();
    for (route, uri, body) in output_routes(false) {
        let (status, _, raw) = send(&g.app, Method::POST, &uri, Some(&body)).await;
        if status != StatusCode::FORBIDDEN
            || !raw.contains("platform_floor_output_blocked")
            || raw.contains(SENTINEL_HAZARD_S9)
        {
            misses.push(format!("buffered {route}: {status} {}", short(&raw)));
        }
    }
    for (route, uri, body) in output_routes(true) {
        let (status, _, raw) = send(&g.app, Method::POST, &uri, Some(&body)).await;
        let clean = ["[DONE]", "message_stop", "response.completed"]
            .iter()
            .any(|marker| raw.contains(marker));
        if !raw.contains("platform_floor_output_blocked") || clean {
            misses.push(format!("stream {route}: {status}, clean finish {clean}"));
        }
    }
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
}

/// A private-network locality (the fleet's service-name host) puts the same
/// keyless client on the wire.
#[tokio::test]
async fn probe_fleet_private_network_client_screens_on_the_wire() {
    let mock = MockServer::systemone().await;
    let backend = DecisionBackend::local(
        DecisionConfig {
            id: "decision_local".into(),
            url: mock.base_url.clone(),
            model: FLEET_MODEL.into(),
            weights_sha256: Some(FLEET_SHA.into()),
            hard_timeout_ms: 800,
            max_concurrency: 4,
        },
        ryu_gw_screening::Locality::PrivateNetwork,
    )
    .expect("a private-network decision backend over the mock");
    let runtime = ScreeningRuntime::with_backends(
        &fleet_table(),
        vec![(
            Arc::new(backend) as Arc<dyn ScreenerBackend>,
            ScreeningBackendKind::DecisionLocal,
            None,
        )],
    );
    let g = gateway(
        GatewayCustody::Fleet,
        runtime,
        Some(fleet_qualified_floor(3)),
        "ok",
    );
    let (status, _, body) = chat(&g, SENTINEL_HAZARD_S9).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "platform_floor_blocked");
    assert!(mock.calls() >= 1);
    assert!(mock
        .requests()
        .iter()
        .all(|r| r.header("authorization").is_none()));

    // The committed table with the compose URL builds the same locality.
    let compose = ScreeningRuntime::from_config(
        &fleet_table(),
        &fleet_lookup("http://screener:11435/v1/systemone", FLEET_SHA),
    );
    let g = gateway(
        GatewayCustody::Fleet,
        compose,
        Some(fleet_qualified_floor(3)),
        "ok",
    );
    let report = status_report(&g).await;
    assert_eq!(
        report["backends"][0]["locality"], "private_network",
        "{report}"
    );
    assert_eq!(report["backends"][0]["model"], FLEET_MODEL);
}

#[tokio::test]
async fn probe_fleet_tool_rounds_are_screened_by_the_table() {
    let mock = MockServer::systemone().await;
    let body = json!({ "model": "fixture-model", "messages": [
        { "role": "user", "content": "benign tool loop question" }
    ] });
    for (result, arguments, expect_executions) in [
        (
            format!("{SENTINEL_HAZARD_S9} tool probe"),
            "{\"query\":\"weather\"}".to_owned(),
            1,
        ),
        (
            "sunny".to_owned(),
            format!("{{\"query\":\"{SENTINEL_HAZARD_S9} lookup\"}}"),
            0,
        ),
    ] {
        let core = spawn_core(json!({ "result": result })).await;
        let rounds = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&rounds);
        let base = core.base.clone();
        let g = gateway_with(
            GatewayCustody::Fleet,
            fleet_runtime(&mock.base_url),
            Some(fleet_qualified_floor(3)),
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
        let (status, _, raw) = send_with(
            &g.app,
            Method::POST,
            "/v1/chat/completions",
            MASTER,
            &[("x-ryu-tools", UNIFIED_TOOL)],
            Some(&body),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{}", short(&raw));
        assert!(raw.contains("platform_floor_blocked"), "{}", short(&raw));
        assert_eq!(rounds.load(Ordering::SeqCst), 1, "{}", short(&raw));
        assert_eq!(core.executions.load(Ordering::SeqCst), expect_executions);
    }
}

#[tokio::test]
async fn probe_fleet_provider_call_is_screened_by_the_table() {
    let mock = MockServer::systemone().await;
    let g = fleet_gateway(&mock.base_url, fleet_qualified_floor(3), "ok");
    let ctx = ctx_of("req-fleet-provider-call", ORG_A, CRED_A);
    let call = provider_call(json!({ "text": format!("{SENTINEL_HAZARD_S9} post") }));
    let result = crate::pipeline::provider_call_guard::screen_hazard(&g.state, &ctx, &call).await;
    assert!(
        matches!(result, Err(GatewayError::ContentBlocked(_))),
        "{result:?}"
    );
    assert!(mock.calls() >= 1);
}

/// A fallback attempt re-admits from the segment cache, and the spare's
/// output is screened like the primary's.
#[tokio::test]
async fn probe_fleet_fallback_attempts_are_screened_once_and_the_spare_output_blocks() {
    let body = json!({ "model": "fixture-model", "messages": [
        { "role": "user", "content": "benign fleet fallback probe" }
    ] });
    let direct_mock = MockServer::systemone().await;
    let direct = fallback_pair(
        fleet_runtime(&direct_mock.base_url),
        Some(fleet_qualified_floor(3)),
        Some("ok"),
        "ok",
    );
    let (status, _, raw) = send(
        &direct.gateway.app,
        Method::POST,
        "/v1/chat/completions",
        Some(&body),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", short(&raw));

    let mock = MockServer::systemone().await;
    let pair = fallback_pair(
        fleet_runtime(&mock.base_url),
        Some(fleet_qualified_floor(3)),
        None,
        "ok",
    );
    let (status, _, raw) = send(
        &pair.gateway.app,
        Method::POST,
        "/v1/chat/completions",
        Some(&body),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", short(&raw));
    assert_eq!(pair.spare.load(Ordering::SeqCst), 1, "no fallback happened");
    assert_eq!(
        mock.calls(),
        direct_mock.calls(),
        "the attempt was screened twice"
    );

    let spare_mock = MockServer::systemone().await;
    let pair = fallback_pair(
        fleet_runtime(&spare_mock.base_url),
        Some(fleet_qualified_floor(3)),
        None,
        &format!("spare {SENTINEL_HAZARD_S9}"),
    );
    let (status, _, raw) = send(
        &pair.gateway.app,
        Method::POST,
        "/v1/chat/completions",
        Some(&body),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{}", short(&raw));
    assert!(
        raw.contains("platform_floor_output_blocked"),
        "{}",
        short(&raw)
    );
    assert!(!raw.contains(SENTINEL_HAZARD_S9));
}

/// A response cached while the fleet ran the reduced row is screened again
/// once the qualification record lands.
#[tokio::test]
async fn probe_fleet_response_cache_hit_is_rescreened_after_qualification() {
    let mock = MockServer::systemone().await;
    let g = gateway_with(
        GatewayCustody::Fleet,
        fleet_runtime(&mock.base_url),
        Some(fleet_unqualified_floor(3)),
        &format!("reply {SENTINEL_HAZARD_S9}"),
        |config| config.cache.enabled = true,
        |_| {},
    );
    let (status, _, body) = chat(&g, "benign fleet cache probe").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _, _) = chat(&g, "benign fleet cache probe").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        g.calls.load(Ordering::SeqCst),
        1,
        "the response cache never answered"
    );

    assert!(g
        .state
        .platform_floor
        .observe(Some(&fleet_qualified_floor(4))));
    let (status, _, body) = chat(&g, "benign fleet cache probe").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "platform_floor_output_blocked");
    assert_eq!(g.calls.load(Ordering::SeqCst), 1);
}

/// One org's screen is never another org's segment cache hit.
#[tokio::test]
async fn probe_fleet_segment_cache_is_org_scoped() {
    let mock = MockServer::systemone().await;
    let g = fleet_gateway(&mock.base_url, fleet_qualified_floor(3), "ok");
    let body = chat_body("shared fleet text across tenants");
    screen_chat(&g.state, &ctx_for("org-a"), &body, Surface::Chat)
        .await
        .expect("org-a screened");
    let after_a = mock.calls();
    assert!(after_a >= 1);
    screen_chat(&g.state, &ctx_for("org-a"), &body, Surface::Chat)
        .await
        .expect("org-a again");
    assert_eq!(
        mock.calls(),
        after_a,
        "org-a's own repeat was not a cache hit"
    );
    screen_chat(&g.state, &ctx_for("org-b"), &body, Surface::Chat)
        .await
        .expect("org-b screened");
    assert_eq!(mock.calls(), after_a * 2, "org-b was served org-a's scores");
}

#[tokio::test]
async fn probe_fleet_capacity_overflow_is_413_before_the_screener() {
    let mock = MockServer::systemone().await;
    let g = fleet_gateway(&mock.base_url, fleet_qualified_floor(3), "ok");
    let messages: Vec<Value> = (0..(crate::screening::admit::MAX_ITEMS + 10))
        .map(|i| {
            json!({
                "role": if i % 2 == 0 { "user" } else { "assistant" },
                "content": format!("turn {i}")
            })
        })
        .collect();
    let body = json!({ "model": "fixture-model", "messages": messages });
    let (status, _, raw) = send(&g.app, Method::POST, "/v1/chat/completions", Some(&body)).await;
    let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{}", short(&raw));
    assert_eq!(parsed["error"]["code"], "screening_capacity_exceeded");
    assert_eq!(parsed["error"]["type"], "request_too_large");
    assert_eq!(mock.calls(), 0);
    assert_eq!(g.calls.load(Ordering::SeqCst), 0);
}
