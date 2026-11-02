//! Client hang-ups during buffered calls and streams.

use super::*;

/// An `openai` stand-in whose buffered completion waits for a release
/// signal, so a test can drop the caller while the provider is working.
struct GatedProvider {
    started: Arc<tokio::sync::Notify>,
    release: tokio::sync::watch::Receiver<bool>,
}
impl Provider for GatedProvider {
    fn name(&self) -> &'static str {
        "openai"
    }
    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<Value, ryu_gw_providers::ProviderError>>
                + Send
                + 'a,
        >,
    > {
        self.started.notify_one();
        let mut release = self.release.clone();
        Box::pin(async move {
            while !*release.borrow() {
                if release.changed().await.is_err() {
                    break;
                }
            }
            Ok(json!({
                "choices": [{"message": {"content": "done"}}],
                "usage": {"prompt_tokens": 20, "completion_tokens": 5, "cost": 0.003}
            }))
        })
    }
    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<Body, ryu_gw_providers::ProviderError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async { Ok(Body::empty()) })
    }
}
#[tokio::test]
async fn client_hang_up_during_a_buffered_call_still_settles_and_debits() {
    let control_plane = DebitFixture::start().await;
    let (mut state, _) = fixture(|config| {
        control_plane.meter(config);
        config.routing.smart_routing.enabled = false;
    });
    let started = Arc::new(tokio::sync::Notify::new());
    let (release_tx, release_rx) = tokio::sync::watch::channel(false);
    Arc::get_mut(&mut state)
        .unwrap()
        .provider_runtime
        .register_for_test(Arc::new(GatedProvider {
            started: Arc::clone(&started),
            release: release_rx,
        }));
    let mut events = state.traffic.subscribe();

    let handler = tokio::spawn(super::super::run(
        state.clone(),
        managed_ctx("req-client-timeout"),
        prompt(),
    ));
    started.notified().await;
    // The client times out: hyper drops the handler future mid-call.
    handler.abort();
    assert!(matches!(handler.await, Err(error) if error.is_cancelled()));
    release_tx.send(true).unwrap();

    let debits = control_plane.wait_for(1).await;
    assert_eq!(debits.len(), 1, "accepted work is billed: {debits:?}");
    assert_eq!(debits[0]["reason"], "gateway_usage");
    assert_eq!(debits[0]["refId"], "req-client-timeout");
    assert_eq!(debits[0]["inputTokens"], 20);
    assert_eq!(debits[0]["outputTokens"], 5);
    // The provider-reported $0.003.
    assert_eq!(debits[0]["amountMicroUsd"], 3_000);
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
        .await
        .expect("the abandoned call is audited")
        .unwrap();
    assert_eq!(event["request_id"], "req-client-timeout");
    assert_eq!(event["provider_cost_micro_usd"], 3_000);
}
#[tokio::test]
async fn unmetered_buffered_call_is_cancelled_with_its_client() {
    // A Desktop's local Gateway bills nothing, so a hang-up keeps
    // cancelling the call: work nobody will read must not hold a local
    // engine slot or queue place.
    let (mut state, _) = fixture(|config| config.routing.smart_routing.enabled = false);
    assert!(!state.config.credits.is_active());
    let started = Arc::new(tokio::sync::Notify::new());
    let (release_tx, release_rx) = tokio::sync::watch::channel(false);
    Arc::get_mut(&mut state)
        .unwrap()
        .provider_runtime
        .register_for_test(Arc::new(GatedProvider {
            started: Arc::clone(&started),
            release: release_rx,
        }));
    let mut events = state.traffic.subscribe();

    let handler = tokio::spawn(super::super::run(state.clone(), ctx(), prompt()));
    started.notified().await;
    handler.abort();
    assert!(matches!(handler.await, Err(error) if error.is_cancelled()));
    let _ = release_tx.send(true);

    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(300), events.recv())
            .await
            .is_err(),
        "the cancelled call never completed, so nothing settled"
    );
}
/// An `openai` stand-in whose stream opens only on a release signal, so a
/// test can drop the caller before the first byte.
struct GatedStreamProvider {
    started: Arc<tokio::sync::Notify>,
    release: tokio::sync::watch::Receiver<bool>,
    /// Refuse the stream once released, as after exhausted 5xx retries.
    refuse: bool,
}
impl Provider for GatedStreamProvider {
    fn name(&self) -> &'static str {
        "openai"
    }
    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<Value, ryu_gw_providers::ProviderError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async {
            Err(ryu_gw_providers::ProviderError::Provider(
                "stream only".into(),
            ))
        })
    }
    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<Body, ryu_gw_providers::ProviderError>>
                + Send
                + 'a,
        >,
    > {
        self.started.notify_one();
        let mut release = self.release.clone();
        let refuse = self.refuse;
        Box::pin(async move {
            while !*release.borrow() {
                if release.changed().await.is_err() {
                    break;
                }
            }
            if refuse {
                return Err(ryu_gw_providers::ProviderError::Provider(
                    "openai error 503 after 3 retries".into(),
                ));
            }
            let delta = json!({"choices":[{"delta":{"content":"late"}}]});
            Ok(Body::from(format!("data: {delta}\n\ndata: [DONE]\n\n")))
        })
    }
}
fn gated_stream(
    state: &mut Arc<AppState>,
    refuse: bool,
) -> (Arc<tokio::sync::Notify>, tokio::sync::watch::Sender<bool>) {
    let started = Arc::new(tokio::sync::Notify::new());
    let (release_tx, release_rx) = tokio::sync::watch::channel(false);
    Arc::get_mut(state)
        .unwrap()
        .provider_runtime
        .register_for_test(Arc::new(GatedStreamProvider {
            started: Arc::clone(&started),
            release: release_rx,
            refuse,
        }));
    (started, release_tx)
}
#[tokio::test]
async fn client_hang_up_before_the_first_byte_bills_the_accepted_prompt() {
    let control_plane = DebitFixture::start().await;
    let (mut state, _) = fixture(|config| {
        control_plane.meter(config);
        config.routing.smart_routing.enabled = false;
    });
    let (started, release) = gated_stream(&mut state, false);
    let mut events = state.traffic.subscribe();
    let mut context = managed_ctx("req-before-first-byte");
    context.remaining_budget_micro_usd = Some(1_000_000);
    let body = json!({"model":"test","messages":[{"role":"user","content":"a".repeat(4_000)}]});
    assert_eq!(super::super::estimate_prompt_tokens(&body), 1_000);

    let handler = tokio::spawn(super::super::run_stream(state.clone(), context, body));
    started.notified().await;
    assert!(
        state.wallet.in_flight_micro_usd("org") > 0,
        "the stream holds a claim"
    );
    // The client hangs up while the provider is still opening the stream.
    handler.abort();
    assert!(matches!(handler.await, Err(error) if error.is_cancelled()));
    // Nothing is decided until the provider answers.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(control_plane.debits.lock().unwrap().is_empty());
    assert!(state.wallet.in_flight_micro_usd("org") > 0, "still held");
    // The provider accepts the prompt.
    release.send(true).unwrap();

    let debits = control_plane.wait_for(1).await;
    assert_eq!(
        debits.len(),
        1,
        "the accepted prompt is billed once: {debits:?}"
    );
    let debit = &debits[0];
    assert_eq!(debit["reason"], "gateway_usage");
    assert_eq!(debit["refId"], "req-before-first-byte");
    assert_eq!(debit["inputTokens"], 1_000);
    assert_eq!(debit["outputTokens"], 0);
    // 1_000 estimated prompt tokens at the flat 2_000 micro-USD per 1k.
    assert_eq!(debit["amountMicroUsd"], 2_000);
    assert_eq!(debit["estimated"], true);
    assert_eq!(state.wallet.in_flight_micro_usd("org"), 0);
    let event = events.try_recv().expect("the hang-up is audited");
    assert_eq!(event["input_tokens"], 1_000);
    assert!(event["error"]
        .as_str()
        .unwrap()
        .contains("before the first byte"));
    assert!(events.try_recv().is_err());
}
#[tokio::test]
async fn a_stream_the_provider_refuses_after_a_hang_up_costs_nothing() {
    let control_plane = DebitFixture::start().await;
    let (mut state, _) = fixture(|config| {
        control_plane.meter(config);
        config.routing.smart_routing.enabled = false;
    });
    let (started, release) = gated_stream(&mut state, true);
    let mut events = state.traffic.subscribe();
    let mut context = managed_ctx("req-refused");
    context.remaining_budget_micro_usd = Some(1_000_000);
    let handler = tokio::spawn(super::super::run_stream(state.clone(), context, prompt()));
    started.notified().await;
    handler.abort();
    assert!(matches!(handler.await, Err(error) if error.is_cancelled()));
    assert!(
        state.wallet.in_flight_micro_usd("org") > 0,
        "held until it resolves"
    );
    // The provider gives up: it never accepted the prompt.
    release.send(true).unwrap();

    for _ in 0..200 {
        if state.wallet.in_flight_micro_usd("org") == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(state.wallet.in_flight_micro_usd("org"), 0, "claim released");
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(
        control_plane.debits.lock().unwrap().is_empty(),
        "nothing charged"
    );
    assert!(events.try_recv().is_err(), "nothing was served or settled");
}
#[tokio::test]
async fn unmetered_stream_hang_up_before_the_first_byte_records_nothing() {
    let (mut state, _) = fixture(|config| config.routing.smart_routing.enabled = false);
    let (started, release) = gated_stream(&mut state, false);
    let mut events = state.traffic.subscribe();
    let handler = tokio::spawn(super::super::run_stream(state.clone(), ctx(), prompt()));
    started.notified().await;
    handler.abort();
    assert!(matches!(handler.await, Err(error) if error.is_cancelled()));
    let _ = release.send(true);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(300), events.recv())
            .await
            .is_err(),
        "an unmetered stream keeps cancel-on-drop"
    );
}
