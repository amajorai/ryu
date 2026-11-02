//! Local engine slots shared by generation and output guardrails.

use super::*;

struct LocalRecording(Arc<RecordingProvider>);
impl Provider for LocalRecording {
    fn name(&self) -> &'static str {
        "local"
    }
    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<Value, ryu_gw_providers::ProviderError>>
                + Send
                + 'a,
        >,
    > {
        self.0.complete(model, body)
    }
    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<Body, ryu_gw_providers::ProviderError>>
                + Send
                + 'a,
        >,
    > {
        self.0.complete_stream(model, body)
    }
}
struct BlockingLocal {
    calls: Arc<AtomicUsize>,
    started: Arc<tokio::sync::Notify>,
    release: tokio::sync::watch::Receiver<bool>,
}

impl Provider for BlockingLocal {
    fn name(&self) -> &'static str {
        "local"
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
            Ok(json!({
                "choices": [{"message": {"content": "judge"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1}
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
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.started.notify_one();
        let mut release = self.release.clone();
        Box::pin(async move {
            let chunk = futures_util::stream::once(async move {
                while !*release.borrow() {
                    if release.changed().await.is_err() {
                        return Err(std::io::Error::other("release signal dropped"));
                    }
                }
                Ok::<_, std::io::Error>(axum::body::Bytes::from(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"alice@example.com\"}}]}\n\n",
                ))
            });
            Ok(Body::from_stream(chunk))
        })
    }
}

#[tokio::test]
async fn deterministic_output_guardrail_keeps_local_stream_admission_bounded() {
    let calls = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(tokio::sync::Notify::new());
    let (release_tx, release_rx) = tokio::sync::watch::channel(false);
    let mut config = GatewayConfig::default();
    config.routing.default_provider = ProviderId::from("local");
    config.routing.fallback_chain = vec![ProviderId::from("local")];
    config.routing.smart_routing.enabled = false;
    config.concurrency.enabled = true;
    config.concurrency.local_max_in_flight = 1;
    config.concurrency.local_max_queued = 0;
    config.firewall.enabled = false;
    config
        .firewall
        .evaluators
        .push(crate::evaluators::EvaluatorBinding {
            id: "pii_leakage".into(),
            enabled: true,
            inline_action: Some(FirewallPolicy::Sanitize),
            offline: None,
            locked: false,
        });
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let mut state = AppState::new_for_test(
        config,
        audit,
        crate::evals::EvalsRunner::new(Default::default()),
    );
    state
        .provider_runtime
        .register_for_test(Arc::new(BlockingLocal {
            calls: Arc::clone(&calls),
            started: Arc::clone(&started),
            release: release_rx,
        }));
    let state = Arc::new(state);

    let first = tokio::spawn(run_stream(Arc::clone(&state), ctx(), prompt()));
    started.notified().await;
    assert_eq!(
        state
            .admission
            .snapshots()
            .into_iter()
            .find(|snapshot| snapshot.provider == "local")
            .map(|snapshot| snapshot.in_flight),
        Some(1)
    );

    let second = tokio::spawn(run_stream(Arc::clone(&state), ctx(), prompt()));
    let second_result = tokio::time::timeout(std::time::Duration::from_secs(1), second)
        .await
        .expect("the second request should be rejected by the zero-length queue")
        .expect("the second request task should finish");
    assert!(matches!(second_result, Err(GatewayError::Overloaded(_))));
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    release_tx.send(true).unwrap();
    let first_output = first
        .await
        .expect("the first request task should finish")
        .expect("the first request should complete after the upstream releases");
    axum::body::to_bytes(first_output.body, 1024 * 1024)
        .await
        .unwrap();
}

#[tokio::test]
async fn output_judge_reuses_single_local_engine_slot_after_generation_finishes() {
    for stream in [false, true] {
        let (mut state, provider) = fixture(|config| {
            config.routing.default_provider = ProviderId::from("local");
            config.routing.fallback_chain = vec![ProviderId::from("local")];
            config.routing.smart_routing.enabled = false;
            config.concurrency.enabled = true;
            config.concurrency.local_max_in_flight = 1;
            config.concurrency.local_max_queued = 0;
            config.firewall.inspector.model = "test".into();
            let mut ev = EvaluatorRegistry::new().get("toxicity").unwrap().clone();
            ev.target = EvaluatorTarget::Output;
            config.custom_evaluators.push(ev);
            config
                .firewall
                .evaluators
                .push(crate::evaluators::EvaluatorBinding {
                    id: "toxicity".into(),
                    enabled: true,
                    inline_action: Some(FirewallPolicy::Block),
                    offline: None,
                    locked: false,
                });
        });
        Arc::get_mut(&mut state)
            .unwrap()
            .provider_runtime
            .register_for_test(Arc::new(LocalRecording(provider.clone())));
        let run = async {
            if stream {
                let output = run_stream(state, ctx(), prompt()).await?;
                axum::body::to_bytes(output.body, 1024 * 1024)
                    .await
                    .unwrap();
                Ok(())
            } else {
                super::super::run(state, ctx(), prompt()).await.map(|_| ())
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(1), run)
            .await
            .expect("output judge must not deadlock")
            .expect("output judge must receive released slot");
        assert_eq!(provider.requests.lock().unwrap().len(), 2);
    }
}
