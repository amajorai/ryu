//! Tool-loop rounds are billed once each.

use super::*;

#[tokio::test]
async fn client_hang_up_mid_tool_loop_bills_every_round_once() {
    let control_plane = DebitFixture::start().await;
    let started = Arc::new(tokio::sync::Notify::new());
    let (release_tx, release_rx) = tokio::sync::watch::channel(false);
    let provider = Arc::new(ScriptedRounds {
        script: vec![
            tool_call_round(100, 10, 0.001),
            answer_round(200, 20, 0.002),
        ],
        calls: AtomicUsize::new(0),
        hold: Some((1, Arc::clone(&started), release_rx)),
    });
    let state = tool_loop_fixture(&control_plane, Arc::clone(&provider));
    let mut events = state.traffic.subscribe();

    let handler = tokio::spawn(super::super::run_stream(
        state.clone(),
        tool_ctx("req-tool-hang-up"),
        prompt(),
    ));
    // The first round is answered; the provider is working on the second.
    started.notified().await;
    handler.abort();
    assert!(matches!(handler.await, Err(error) if error.is_cancelled()));
    assert!(
        state.wallet.in_flight_micro_usd("org") > 0,
        "held until settled"
    );
    release_tx.send(true).unwrap();

    let debits = control_plane.wait_for(1).await;
    assert_eq!(debits.len(), 1, "one debit for the whole loop: {debits:?}");
    let debit = &debits[0];
    assert_eq!(debit["reason"], "gateway_usage");
    assert_eq!(debit["refId"], "req-tool-hang-up");
    // Both rounds: the answered one and the one the hang-up interrupted.
    assert_eq!(debit["inputTokens"], 300);
    assert_eq!(debit["outputTokens"], 30);
    // The provider-reported $0.001 + $0.002.
    assert_eq!(debit["amountMicroUsd"], 3_000);
    assert_eq!(debit["estimated"], false);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2, "the loop stopped");
    assert_eq!(state.wallet.in_flight_micro_usd("org"), 0);
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
        .await
        .expect("the abandoned loop is audited")
        .unwrap();
    assert_eq!(event["input_tokens"], 300);
    assert_eq!(event["provider_cost_micro_usd"], 3_000);
    assert!(event["error"].as_str().unwrap().contains("tool loop"));
}
#[tokio::test]
async fn a_tool_loop_is_billed_for_every_round_it_ran() {
    for stream in [true, false] {
        let control_plane = DebitFixture::start().await;
        let provider = Arc::new(ScriptedRounds {
            script: vec![
                tool_call_round(100, 10, 0.001),
                answer_round(200, 20, 0.002),
            ],
            calls: AtomicUsize::new(0),
            hold: None,
        });
        let state = tool_loop_fixture(&control_plane, Arc::clone(&provider));
        let request_id = if stream {
            "req-tool-stream"
        } else {
            "req-tool-buffered"
        };
        if stream {
            let output = super::super::run_stream(state.clone(), tool_ctx(request_id), prompt())
                .await
                .unwrap();
            let bytes = axum::body::to_bytes(output.body, 1024 * 1024)
                .await
                .unwrap();
            let text = String::from_utf8_lossy(&bytes);
            assert!(text.contains("done"), "{text}");
            // The client still sees the final round's own usage.
            assert!(text.contains(r#""prompt_tokens":200"#), "{text}");
        } else {
            let output = super::super::run(state.clone(), tool_ctx(request_id), prompt())
                .await
                .unwrap();
            assert_eq!(output.response["usage"]["prompt_tokens"], 200);
            assert_eq!(output.response["usage"]["completion_tokens"], 20);
        }
        let debits = control_plane.wait_for(1).await;
        assert_eq!(debits.len(), 1, "stream={stream}: {debits:?}");
        let debit = &debits[0];
        assert_eq!(debit["refId"], request_id);
        assert_eq!(debit["inputTokens"], 300, "stream={stream}");
        assert_eq!(debit["outputTokens"], 30, "stream={stream}");
        assert_eq!(debit["amountMicroUsd"], 3_000, "stream={stream}");
        assert_eq!(debit["estimated"], false, "stream={stream}");
        assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
        assert_eq!(state.wallet.in_flight_micro_usd("org"), 0);
    }
}
