//! Tool-loop hang-ups, pool deadlines and failed rounds.

use super::*;

#[tokio::test]
async fn client_hang_up_mid_buffered_tool_loop_stops_the_tools_and_bills_the_rounds() {
    for hang_up in [true, false] {
        let control_plane = DebitFixture::start().await;
        let started = Arc::new(tokio::sync::Notify::new());
        let (release_tx, release_rx) = tokio::sync::watch::channel(false);
        let provider = Arc::new(ScriptedRounds {
            script: vec![
                tool_call_round_named("notes_append", 100, 10, 0.001),
                tool_call_round_named("notes_append", 200, 20, 0.002),
                answer_round(300, 30, 0.003),
            ],
            calls: AtomicUsize::new(0),
            hold: hang_up.then(|| (1, Arc::clone(&started), release_rx)),
        });
        let mut state = tool_loop_fixture(&control_plane, Arc::clone(&provider));
        let (catalog, tool_calls, server) = counting_tool_catalog().await;
        Arc::get_mut(&mut state).unwrap().tools = Some(crate::tools::ToolSearchClient::new(
            &crate::config::CoreProviderConfig {
                base_url: catalog,
                token: None,
            },
            state.http.clone(),
        ));
        let mut context = tool_ctx("req-buffered-loop");
        context.tool_actions = Some("notes_append".into());

        let handler = tokio::spawn(super::super::run(state.clone(), context, prompt()));
        if hang_up {
            // The first round ran its tool; the provider is working on the
            // second, which will ask for the tool again.
            started.notified().await;
            assert_eq!(tool_calls.load(Ordering::SeqCst), 1);
            handler.abort();
            assert!(matches!(handler.await, Err(error) if error.is_cancelled()));
            assert!(
                state.wallet.in_flight_micro_usd("org") > 0,
                "held until settled"
            );
            release_tx.send(true).unwrap();
        } else {
            let output = handler.await.unwrap().unwrap();
            assert_eq!(output.response["choices"][0]["message"]["content"], "done");
        }

        let debits = control_plane.wait_for(1).await;
        assert_eq!(debits.len(), 1, "hang_up={hang_up}: {debits:?}");
        let debit = &debits[0];
        assert_eq!(debit["reason"], "gateway_usage");
        assert_eq!(debit["refId"], "req-buffered-loop");
        assert_eq!(debit["estimated"], false);
        if hang_up {
            // The answered round and the in-flight one, from their real
            // usage; the loop stopped there.
            assert_eq!(debit["inputTokens"], 300);
            assert_eq!(debit["outputTokens"], 30);
            assert_eq!(debit["amountMicroUsd"], 3_000);
            assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
            assert_eq!(tool_calls.load(Ordering::SeqCst), 1, "no tool ran after it");
        } else {
            assert_eq!(debit["inputTokens"], 600);
            assert_eq!(debit["outputTokens"], 60);
            assert_eq!(debit["amountMicroUsd"], 6_000);
            assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
            assert_eq!(tool_calls.load(Ordering::SeqCst), 2);
        }
        assert_eq!(state.wallet.in_flight_micro_usd("org"), 0, "claim released");
        server.abort();
    }
}
#[tokio::test]
async fn a_round_still_running_at_the_pool_deadline_is_billed_once_it_answers() {
    use super::super::tool_rounds::{MeteredRounds, ToolRoundLedger};
    let control_plane = DebitFixture::start().await;
    let (state, _) = fixture(|config| control_plane.meter(config));
    let started = Arc::new(tokio::sync::Notify::new());
    let (release_tx, release_rx) = tokio::sync::watch::channel(false);
    let provider = Arc::new(ScriptedRounds {
        script: vec![
            tool_call_round(100, 10, 0.001),
            tool_call_round(200, 20, 0.002),
        ],
        calls: AtomicUsize::new(0),
        hold: Some((1, Arc::clone(&started), release_rx)),
    });
    // The metered loop's provider, as `run_attached` builds it.
    let ledger = Arc::new(ToolRoundLedger::default());
    let rounds = MeteredRounds::new(provider.clone(), Arc::clone(&ledger), true);
    let body = prompt();
    rounds.complete("test", &body).await.unwrap();
    // The second round is in flight when the pool deadline drops the loop.
    let cut_off = tokio::time::timeout(
        std::time::Duration::from_millis(50),
        rounds.complete("test", &body),
    )
    .await;
    assert!(cut_off.is_err(), "the deadline cut the loop off");
    started.notified().await;
    let claim = state.wallet.try_reserve("org", 50_000, 1_000_000);

    super::super::settle_timed_out_tool_rounds(
        &state,
        &managed_ctx("req-pool-deadline"),
        0,
        &ledger,
        "openai",
        "test",
        None,
        Instant::now(),
        claim,
    );
    // Nothing is billed while the round runs; the claim stays held.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(control_plane.debits.lock().unwrap().is_empty());
    assert_eq!(state.wallet.in_flight_micro_usd("org"), 50_000);
    // The provider answers the late round.
    release_tx.send(true).unwrap();

    let debits = control_plane.wait_for(1).await;
    assert_eq!(debits.len(), 1, "every round, billed once: {debits:?}");
    let debit = &debits[0];
    assert_eq!(debit["refId"], "req-pool-deadline:attempt-0");
    // The answered round plus the late one, from its real usage.
    assert_eq!(debit["inputTokens"], 300);
    assert_eq!(debit["outputTokens"], 30);
    assert_eq!(debit["amountMicroUsd"], 3_000);
    assert_eq!(debit["estimated"], false);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    assert_eq!(state.wallet.in_flight_micro_usd("org"), 0, "claim released");
}
#[tokio::test]
async fn the_token_limit_judges_the_answering_round_not_the_whole_loop() {
    // 135 + 15 tokens over three rounds against a 100 tokens/minute limit:
    // the answering round (55) fits, as it did before rounds were billed.
    // Refusing the sum would 429 a request whose tools already ran and
    // were paid for, and the client's retry would pay for them again.
    let control_plane = DebitFixture::start().await;
    let provider = Arc::new(ScriptedRounds {
        script: vec![
            tool_call_round(40, 5, 0.001),
            tool_call_round(45, 5, 0.001),
            answer_round(50, 5, 0.001),
        ],
        calls: AtomicUsize::new(0),
        hold: None,
    });
    let state = tool_loop_fixture_with(&control_plane, Arc::clone(&provider), |config| {
        config.rate_limit.tokens_per_minute = Some(100);
    });
    let output = super::super::run(state.clone(), tool_ctx("req-tpm"), prompt())
        .await
        .expect("the answering round is within the limit");
    assert_eq!(output.response["usage"]["prompt_tokens"], 50);
    let debits = control_plane.wait_for(1).await;
    assert_eq!(debits.len(), 1, "{debits:?}");
    assert_eq!(debits[0]["refId"], "req-tpm");
    assert_eq!(debits[0]["inputTokens"], 135);
    assert_eq!(debits[0]["outputTokens"], 15);
    assert_eq!(debits[0]["amountMicroUsd"], 3_000);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
    // The earlier rounds still count: the bucket is spent for now.
    assert!(!state.rate_limiter.check_tokens_for_key("sk-test", 1, None));
}
#[tokio::test]
async fn rounds_before_a_failed_tool_round_are_billed_under_their_attempt_ref() {
    for stream in [true, false] {
        let control_plane = DebitFixture::start().await;
        let provider = Arc::new(ScriptedRounds {
            script: vec![
                tool_call_round(100, 10, 0.001),
                Err("upstream failed".to_owned()),
            ],
            calls: AtomicUsize::new(0),
            hold: None,
        });
        let state = tool_loop_fixture(&control_plane, Arc::clone(&provider));
        let request_id = if stream {
            "req-loop-fails-stream"
        } else {
            "req-loop-fails"
        };
        let failed = if stream {
            super::super::run_stream(state.clone(), tool_ctx(request_id), prompt())
                .await
                .is_err()
        } else {
            super::super::run(state.clone(), tool_ctx(request_id), prompt())
                .await
                .is_err()
        };
        assert!(failed, "stream={stream}");
        let debits = control_plane.wait_for(1).await;
        assert_eq!(debits.len(), 1, "stream={stream}: {debits:?}");
        let debit = &debits[0];
        // Its own ref: a fallback attempt that succeeded would debit the
        // request id, and must not be deduplicated against this charge.
        assert_eq!(debit["refId"], format!("{request_id}:attempt-0"));
        assert_eq!(debit["inputTokens"], 100, "stream={stream}");
        assert_eq!(debit["outputTokens"], 10, "stream={stream}");
        assert_eq!(debit["amountMicroUsd"], 1_000, "stream={stream}");
        assert_eq!(debit["estimated"], false, "stream={stream}");
        assert_eq!(state.wallet.in_flight_micro_usd("org"), 0);
    }
}
#[tokio::test]
async fn never_polled_stream_still_records_dispatched_prompt_on_drop() {
    let (state, _) = fixture(|_| {});
    let mut events = state.traffic.subscribe();
    let body = attach_stream_observer(
        Body::empty(),
        state.clone(),
        ctx(),
        "openai".into(),
        "test".into(),
        ryu_gw_providers::PromptCacheOutcome::Disabled,
        9,
        Instant::now(),
        None,
        None,
    );
    drop(body);
    let event = events.try_recv().unwrap();
    assert_eq!(event["input_tokens"], 9);
    assert!(event["error"].is_string());
    assert!(events.try_recv().is_err());
}
#[tokio::test]
async fn oversized_stream_aborts_without_serving_unscanned_output() {
    let (state, provider) = fixture(|config| {
        config.routing.smart_routing.enabled = false;
        config.firewall.enabled = true;
        config.firewall.policy = FirewallPolicy::Block;
    });
    *provider.response_text.lock().unwrap() = Some("a".repeat(MAX_PROVIDER_STREAM_BYTES + 1));
    let mut events = state.traffic.subscribe();
    let output = run_stream(state.clone(), ctx(), prompt()).await.unwrap();
    let bytes = axum::body::to_bytes(output.body, 4096).await.unwrap();
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("Unable to scan"));
    assert!(!text.contains(&"a".repeat(1000)));
    let event = events.try_recv().unwrap();
    assert!(event["error"].as_str().unwrap().contains("8 MiB"));
    assert!(state.audit.token_usage("sk-test") > 0);
}
