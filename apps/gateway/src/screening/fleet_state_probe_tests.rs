//! Fleet screener probes: backend failures on the committed table, the
//! shipped state with no qualification record, remote processors and
//! self-hosted custody. The shared harness is in `fleet_probe_tests.rs`.

use super::*;

// ── backend failures on the committed table ─────────────────────────────────

#[tokio::test]
async fn probe_fleet_screener_timeout_garbage_and_5xx_are_503_never_a_pass() {
    let cases: Vec<(
        &str,
        Box<dyn Fn(&mut ryu_gw_screening::testing::MockBehaviour)>,
    )> = vec![
        (
            "timeout",
            Box::new(|b| b.delay = Some(Duration::from_secs(3))),
        ),
        (
            "garbage",
            Box::new(|b| b.raw_body = Some("not a systemone answer".into())),
        ),
        ("5xx", Box::new(|b| b.status = Some(500))),
    ];
    for (case, behaviour) in cases {
        let mock = MockServer::systemone().await;
        mock.set(|b| behaviour(b));
        let g = fleet_gateway(
            &mock.base_url,
            floor(
                3,
                Some(fleet_screener(
                    Some((FLEET_MODEL, FLEET_SHA)),
                    json!({ "deadlinesMs": { "chat": 200 } }),
                )),
            ),
            "ok",
        );
        let started = std::time::Instant::now();
        let (status, headers, body) = chat(&g, SENTINEL_HAZARD_S9).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{case}: {body}");
        assert_eq!(body["error"]["code"], "screening_unavailable", "{case}");
        assert_eq!(body["error"]["type"], "service_unavailable", "{case}");
        assert!(headers.get("retry-after").is_some(), "{case}");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{case}: the deadline was not kept"
        );
        assert_eq!(
            g.calls.load(Ordering::SeqCst),
            0,
            "{case}: reached the provider"
        );
        assert!(mock.calls() >= 1, "{case}: the mock was never asked");
        assert_eq!(
            g.state.screening.cache_stats().entries,
            0,
            "{case}: a failure was cached"
        );
    }
}

/// The screener container down at boot (no `depends_on`): `/health` stays
/// up, the probe opens the breaker and reports `canary_failed`, and the
/// replica serves the reduced row instead of refusing every request.
#[tokio::test]
async fn probe_fleet_screener_down_at_boot_degrades_and_never_touches_health() {
    let url = dead_screener_url().await;
    let config = crate::config::ScreeningConfig {
        degraded_rpm: 1_000,
        ..fleet_table()
    };
    let g = gateway(
        GatewayCustody::Fleet,
        fleet_runtime_with(&url, FLEET_SHA, &config),
        Some(fleet_qualified_floor(3)),
        "ok",
    );
    for (uri, status) in health(&g).await {
        assert_eq!(status, StatusCode::OK, "{uri} before the probe");
    }
    // Before the first probe the breaker is closed: the screener should
    // answer and cannot, so this one request is a 503.
    let (status, _, body) = chat(&g, "benign boot probe").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");

    g.state.screening.probe_all().await;
    for (uri, status) in health(&g).await {
        assert_eq!(status, StatusCode::OK, "{uri} with the screener down");
    }
    let report = status_report(&g).await;
    let backend = &report["backends"][0];
    assert_eq!(backend["breaker"], "open", "{report}");
    assert_eq!(
        backend["lastProbe"]["result"], "down:canary_failed",
        "{report}"
    );
    assert_eq!(report["mode"], "degraded", "{report}");
    assert_eq!(report["buildErrors"], json!([]), "{report}");

    let (status, _, body) = chat(&g, "benign boot probe again").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _, body) = chat(&g, SENTINEL_LEXICON).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, _, raw) = send(
        &g.app,
        Method::POST,
        "/v1/chat/completions",
        Some(&image_chat()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{}", short(&raw));
    assert!(
        raw.contains("media_unscreenable"),
        "an outage turned the media gap into {}",
        short(&raw)
    );
}

/// A served model name that does not match (the untagged digest pull the
/// runbook warns about) shows as `canary_failed`, never as a build error.
#[tokio::test]
async fn probe_fleet_unknown_model_is_canary_failed_not_a_startup_error() {
    let mock = MockServer::systemone().await;
    mock.set(|b| b.status = Some(404));
    let g = fleet_gateway(&mock.base_url, fleet_qualified_floor(3), "ok");
    g.state.screening.probe_all().await;
    let report = status_report(&g).await;
    assert_eq!(report["buildErrors"], json!([]), "{report}");
    assert_eq!(
        report["backends"][0]["lastProbe"]["result"], "down:canary_failed",
        "{report}"
    );
    assert_eq!(report["backends"][0]["breaker"], "open", "{report}");
    for (uri, status) in health(&g).await {
        assert_eq!(status, StatusCode::OK, "{uri}");
    }
}

// ── the shipped state: no qualification record yet ──────────────────────────

/// Until a qualification record exists the fleet runs the section 6 reduced
/// row: no blanket 503, the regex floor, the throttle, and every media input
/// refused as unscreenable.
#[tokio::test]
async fn probe_fleet_without_a_qualification_runs_the_reduced_row() {
    let mock = MockServer::systemone().await;
    let config = crate::config::ScreeningConfig {
        degraded_rpm: 10_000,
        ..fleet_table()
    };
    let g = gateway(
        GatewayCustody::Fleet,
        fleet_runtime_with(&mock.base_url, FLEET_SHA, &config),
        Some(fleet_unqualified_floor(3)),
        "ok",
    );
    // Text routes are served; media routes (image, video, speech) stay refused
    // as unscreenable while no backend is qualified (spec 02.9, documented in
    // the content-screening table).
    let mut misses = Vec::new();
    for (route, uri, body) in inbound_routes("benign reduced-mode request") {
        let (status, _, raw) = send(&g.app, Method::POST, &uri, Some(&body)).await;
        let media_route = uri.starts_with("/v1/images") || uri.starts_with("/v1/audio");
        let refused_as_media =
            status == StatusCode::FORBIDDEN && raw.contains("media_unscreenable");
        if media_route != refused_as_media || (!media_route && screening_refusal(status, &raw)) {
            misses.push(format!("{route}: {status} {}", short(&raw)));
        }
    }
    assert!(
        POLICY_PAGE.contains("or an image, video, speech or transcription request in reduced mode"),
        "the content-screening table no longer documents the reduced-mode media refusal"
    );
    assert!(misses.is_empty(), "\n{}", misses.join("\n"));
    // A fresh replica, so the route sweep above has not used the key's own
    // per-minute request limit.
    let g = gateway(
        GatewayCustody::Fleet,
        fleet_runtime_with(&mock.base_url, FLEET_SHA, &config),
        Some(fleet_unqualified_floor(3)),
        "ok",
    );
    let (status, _, body) = chat(&g, SENTINEL_HAZARD_S9).await;
    assert_ne!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    let (status, _, body) = chat(&g, SENTINEL_LEXICON).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    let media = [
        ("chat image", "/v1/chat/completions", image_chat()),
        (
            "image edit input",
            "/v1/images/generations",
            json!({ "model": "fixture-model", "prompt": "edit this",
                    "image": format!("data:image/png;base64,{PNG}") }),
        ),
    ];
    for (case, uri, body) in media {
        let (status, _, raw) = send(&g.app, Method::POST, uri, Some(&body)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{case}: {}", short(&raw));
        assert!(
            raw.contains("media_unscreenable"),
            "{case}: {}",
            short(&raw)
        );
    }
    let transcription = screen_value(
        &g.state,
        &plain_ctx(),
        &transcription_wire("meeting notes"),
        Surface::Transcription,
    )
    .await
    .expect_err("reduced mode refuses a transcription");
    assert_eq!(transcription.wire_status_and_code().1, "media_unscreenable");

    let report = status_report(&g).await;
    assert_eq!(report["mode"], "degraded", "{report}");
    assert_eq!(report["qualifications"], 0, "{report}");

    let throttled = gateway(
        GatewayCustody::Fleet,
        fleet_runtime_with(
            &mock.base_url,
            FLEET_SHA,
            &crate::config::ScreeningConfig {
                degraded_rpm: 1,
                ..fleet_table()
            },
        ),
        Some(fleet_unqualified_floor(3)),
        "ok",
    );
    let (status, _, body) = chat(&throttled, "benign throttle probe one").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, headers, body) = chat(&throttled, "benign throttle probe two").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["error"]["code"], "screening_degraded_throttle");
    assert!(headers.get("retry-after").is_some());
}

/// The fleet gateway with no `[screening]` table at all (the table was never
/// pasted into gateway.toml) still runs the reduced row, never a 503.
#[tokio::test]
async fn probe_fleet_without_the_table_runs_the_reduced_row() {
    let runtime = ScreeningRuntime::from_config(&Default::default(), &|_| None);
    assert!(runtime.slots().next().is_none());
    let g = gateway(
        GatewayCustody::Fleet,
        runtime,
        Some(fleet_qualified_floor(3)),
        "ok",
    );
    let (status, _, body) = chat(&g, "benign tableless probe").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _, body) = chat(&g, SENTINEL_LEXICON).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, _, raw) = send(
        &g.app,
        Method::POST,
        "/v1/chat/completions",
        Some(&image_chat()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{}", short(&raw));
    assert!(raw.contains("media_unscreenable"));
}

/// A qualification must name the same model, digest and template version.
/// A swapped digest or an untagged name is not qualified (reduced row, not
/// a 503); the digest's letter case does not matter.
#[tokio::test]
async fn probe_fleet_qualification_must_match_the_pinned_build() {
    for (case, model, sha, decides) in [
        ("exact", FLEET_MODEL, FLEET_SHA.to_owned(), true),
        (
            "upper-case digest",
            FLEET_MODEL,
            FLEET_SHA.to_ascii_uppercase(),
            true,
        ),
        ("other digest", FLEET_MODEL, OTHER_SHA.to_owned(), false),
        (
            "untagged model",
            "fleet-screener",
            FLEET_SHA.to_owned(),
            false,
        ),
    ] {
        let mock = MockServer::systemone().await;
        let g = fleet_gateway(
            &mock.base_url,
            floor(3, Some(fleet_screener(Some((model, &sha)), json!({})))),
            "ok",
        );
        let report = status_report(&g).await;
        let (status, _, body) = chat(&g, SENTINEL_HAZARD_S9).await;
        if decides {
            assert_eq!(report["mode"], "classified", "{case}: {report}");
            assert_eq!(status, StatusCode::FORBIDDEN, "{case}: {body}");
        } else {
            assert_eq!(report["mode"], "degraded", "{case}: {report}");
            assert_ne!(status, StatusCode::SERVICE_UNAVAILABLE, "{case}: {body}");
            assert_ne!(
                body["error"]["code"], "platform_floor_blocked",
                "{case}: {body}"
            );
        }
    }
}

// ── remote processors ───────────────────────────────────────────────────────

/// The committed table carries no remote processor, so a floor naming one is
/// rejected by the replica. An operator who adds a Jev table with the node
/// opt-in still sends it no floor traffic without an approved record, and a
/// record recorded and approved by the same administrator never parses.
#[tokio::test]
async fn probe_fleet_remote_processor_needs_an_approved_record() {
    let mock = MockServer::systemone().await;
    let runtime = fleet_runtime(&mock.base_url);
    let names_jev = |records: Value| {
        let mut screener = fleet_screener(Some((FLEET_MODEL, FLEET_SHA)), records);
        screener["roles"]["textHazard"] = json!(["decision_local", "jev"]);
        screener
    };
    let parsed = FloorScreener::parse(&names_jev(record())).expect("parses");
    assert!(
        runtime.validate_floor(&parsed).is_err(),
        "the committed table has no jev endpoint, yet a floor naming one was accepted"
    );

    let mut table = fleet_table();
    let jev: crate::config::ScreeningBackendConfig = toml::from_str(
        r#"
kind = "decision_remote"
base_url = "https://jev.invalid/v1/systemone"
model = "jev"
processor_id = "typesafe"
allow_remote_processor = true
"#,
    )
    .expect("jev table");
    table.backends.insert("jev".into(), jev);
    let runtime = fleet_runtime_with(&mock.base_url, FLEET_SHA, &table);
    let without = FloorScreener::parse(&names_jev(json!({}))).expect("parses");
    assert!(
        runtime.validate_floor(&without).is_err(),
        "no record, yet accepted"
    );
    let active = runtime.active(ryu_gw_screening::ScreenTier::Floor, Some(Arc::new(without)));
    let slot = runtime.slot("jev").expect("jev built");
    assert!(
        !slot.backend.permits(ryu_gw_screening::ScreenTier::Floor),
        "the node opt-in admitted floor traffic"
    );
    drop(active);
    let with = FloorScreener::parse(&names_jev(record())).expect("parses");
    assert_eq!(runtime.validate_floor(&with), Ok(()));

    let same_admin = json!({ "remoteProcessors": [{
        "processorId": "typesafe", "backendId": "jev", "retentionDays": 0, "zdr": true,
        "dpaRef": "dpa-1", "region": "eu", "recordedBy": "admin-a", "approvedBy": "admin-a"
    }] });
    assert!(
        FloorScreener::parse(&names_jev(same_admin)).is_err(),
        "a record approved by its own recorder was accepted"
    );
}

// ── self-hosted custody ─────────────────────────────────────────────────────

/// The same table on a self-hosted node is never bound by Ryu's floor:
/// without the opt-in nothing is screened; with it an outage never refuses
/// and media is never refused as unscreenable.
#[tokio::test]
async fn probe_fleet_table_on_a_self_hosted_node_is_never_floor_bound() {
    let mock = MockServer::systemone().await;
    let g = gateway(
        GatewayCustody::SelfHosted,
        fleet_runtime(&mock.base_url),
        Some(fleet_qualified_floor(3)),
        "ok",
    );
    let (status, _, body) = chat(&g, SENTINEL_HAZARD_S9).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _, raw) = send(
        &g.app,
        Method::POST,
        "/v1/chat/completions",
        Some(&image_chat()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", short(&raw));
    assert_eq!(
        mock.calls(),
        0,
        "a self-hosted node without the opt-in was screened"
    );

    let url = dead_screener_url().await;
    let opt_in = crate::config::ScreeningConfig {
        node_classifiers: true,
        degraded_rpm: 1,
        ..fleet_table()
    };
    let g = gateway(
        GatewayCustody::SelfHosted,
        fleet_runtime_with(&url, FLEET_SHA, &opt_in),
        Some(fleet_qualified_floor(3)),
        "ok",
    );
    g.state.screening.probe_all().await;
    for attempt in 0..3 {
        let (status, _, body) = chat(&g, &format!("self-hosted outage {attempt}")).await;
        assert_eq!(status, StatusCode::OK, "{attempt}: {body}");
    }
    let (status, _, raw) = send(
        &g.app,
        Method::POST,
        "/v1/chat/completions",
        Some(&image_chat()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", short(&raw));
    for (uri, status) in health(&g).await {
        assert_eq!(status, StatusCode::OK, "{uri}");
    }
}
