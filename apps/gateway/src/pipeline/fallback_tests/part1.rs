use super::*;

#[tokio::test]
async fn openrouter_policy_filters_outbound_models_for_all_completion_paths() {
    for operation in ["buffered", "streaming", "auxiliary"] {
        let mut state = chain_state(10);
        let (provider, calls) = StubProvider::new("openrouter", Mode::Ok);
        state
            .provider_runtime
            .register_for_test(provider.clone() as Arc<dyn Provider>);
        let state = Arc::new(state);
        let mut ctx = plain_ctx();
        ctx.slot_provider = Some("openrouter".into());
        ctx.slot_model = Some("anything".into());
        ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
            approved_models: vec!["anything".into(), "approved-fallback".into()],
            ..Default::default()
        });
        let mut body = ping_body();
        body["models"] = json!(["blocked-fallback", "approved-fallback"]);
        if operation == "auxiliary" {
            let client = super::super::auxiliary::GovernedInference::new(state, ctx, "fixture");
            client
                .complete_target(
                    0,
                    &super::super::pool_execution::PoolTarget {
                        provider: "openrouter".into(),
                        model: "anything".into(),
                    },
                    body,
                    1000,
                )
                .await
                .unwrap()
                .unwrap();
        } else if operation == "streaming" {
            super::super::run_stream(state, ctx, body).await.unwrap();
        } else {
            run(state, ctx, body).await.unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            provider.bodies.lock().unwrap()[0]["models"],
            json!(["approved-fallback"])
        );
    }
}

#[tokio::test]
async fn repeated_video_correlation_keeps_distinct_jobs_and_debits() {
    for mode in [Mode::Ok, Mode::Fail] {
        let (sender, mut receiver) = tokio::sync::mpsc::channel::<Value>(4);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                axum::Router::new().route(
                    "/api/credits/debit",
                    axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                        let sender = sender.clone();
                        async move {
                            sender.send(body).await.unwrap();
                            axum::Json(json!({"balanceMicroUsd":1000000}))
                        }
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let mut state = chain_state(10);
        state.config.credits.enabled = true;
        state.config.credits.base_url = format!("http://{address}");
        state.config.credits.internal_secret = Some("fixture-secret".into());
        state.config.credits.cost_per_video_micro_usd = 1;
        let (provider, calls) = StubProvider::new("primary", mode);
        state
            .provider_runtime
            .register_for_test(provider as Arc<dyn Provider>);
        let state = Arc::new(state);
        let mut ctx = plain_ctx();
        ctx.request_id = "repeat".into();
        ctx.org_id = Some("test-org".into());
        ctx.slot_provider = Some("primary".into());
        let mut ids = Vec::new();
        let mut debit_refs = Vec::new();
        for prompt in ["first", "second"] {
            let result = super::super::submit_video_job(
                Arc::clone(&state),
                ctx.clone(),
                json!({"model":"anything","prompt":prompt}),
            )
            .await
            .unwrap();
            let id = result["id"].as_str().unwrap().to_owned();
            assert_ne!(id, ctx.request_id);
            if matches!(mode, Mode::Fail) {
                let polled =
                    super::super::poll_video_job(Arc::clone(&state), ctx.clone(), id.clone())
                        .await
                        .unwrap();
                assert_eq!(polled["status"], "succeeded");
            }
            let debit = tokio::time::timeout(std::time::Duration::from_secs(5), receiver.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(debit["refId"], format!("{id}:video"));
            debit_refs.push(debit["refId"].clone());
            ids.push(id);
        }
        assert_ne!(ids[0], ids[1]);
        assert_ne!(debit_refs[0], debit_refs[1]);
        assert!(state.jobs.get(&ids[0]).is_some());
        assert!(state.jobs.get(&ids[1]).is_some());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        server.abort();
    }
}

#[tokio::test]
async fn audio_jobs_route_by_audio_slot_meter_as_audio_and_stay_out_of_video_polls() {
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<Value>(4);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new().route(
                "/api/credits/debit",
                axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                    let sender = sender.clone();
                    async move {
                        sender.send(body).await.unwrap();
                        axum::Json(json!({"balanceMicroUsd":1000000}))
                    }
                }),
            ),
        )
        .await
        .unwrap();
    });
    let mut state = chain_state(10);
    state.config.credits.enabled = true;
    state.config.credits.base_url = format!("http://{address}");
    state.config.credits.internal_secret = Some("fixture-secret".into());
    state.config.credits.cost_per_video_micro_usd = 7;
    // `primary` is the default route; the audio slot must override it.
    let (primary, primary_calls) = StubProvider::new("primary", Mode::Ok);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(Arc::clone(&secondary) as Arc<dyn Provider>);
    let state = Arc::new(state);
    let mut ctx = plain_ctx();
    ctx.org_id = Some("test-org".into());
    ctx.slot_provider = Some("secondary".into());
    ctx.slot_model = Some("music-model".into());

    let result = super::super::submit_audio_job(
        Arc::clone(&state),
        ctx.clone(),
        json!({"model":"caller-model","prompt":"warm pad","seconds_total":10}),
    )
    .await
    .unwrap();
    assert_eq!(result["status"], "succeeded");
    assert_eq!(result["data"][0]["url"], "https://example.test/music.wav");
    let id = result["id"].as_str().unwrap().to_owned();

    assert_eq!(primary_calls.load(Ordering::SeqCst), 0);
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
    let recorded = secondary.bodies.lock().unwrap()[0].clone();
    assert_eq!(recorded["kind"], "audio");
    assert_eq!(recorded["body"]["seconds_total"], 10);
    assert_eq!(state.jobs.get(&id).unwrap().model, "music-model");

    let debit = tokio::time::timeout(std::time::Duration::from_secs(5), receiver.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(debit["refId"], format!("{id}:audio"));
    assert_eq!(debit["taskLabel"], "audio (estimated cost)");
    assert!(debit["amountMicroUsd"].as_u64().unwrap() >= 7);

    // An audio job id is not a video job, even for its owner.
    let wrong_route = super::super::poll_video_job(Arc::clone(&state), ctx.clone(), id.clone())
        .await
        .unwrap_err();
    assert!(
        wrong_route.to_string().contains("no such video job"),
        "{wrong_route}"
    );
    let polled = super::super::poll_audio_job(Arc::clone(&state), ctx.clone(), id.clone())
        .await
        .unwrap();
    assert_eq!(polled["status"], "succeeded");

    // Synchronous modalities never reach the queued-job path.
    let refused = super::super::submit_media_job(
        Arc::clone(&state),
        ctx,
        json!({"model":"m","prompt":"p"}),
        crate::config::Modality::Image,
    )
    .await
    .unwrap_err();
    assert!(
        refused
            .to_string()
            .contains("not a job-based media modality"),
        "{refused}"
    );
    server.abort();
}

/// Core merges an app's `provider_input` into the cloud body, so DLP must
/// see every non-`data:` text leaf of a media body, not only `prompt`.
#[tokio::test]
async fn media_job_dlp_scans_every_text_leaf_but_not_inline_media_or_routing() {
    let secret = "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD";
    let inline = "data:audio/wav;base64,UklGRg==";
    let body = || {
        json!({
            "model": "music-model",
            "prompt": "calm piano",
            "lyrics": {"verses": [format!("token {secret}")]},
            "audio_url": inline,
            "negative_prompt": "no drums"
        })
    };
    for modality in [
        crate::config::Modality::Audio,
        crate::config::Modality::Video,
    ] {
        let mut state = chain_state(10);
        state.update_firewall_config(FirewallConfig {
            enabled: true,
            policy: crate::config::FirewallPolicy::Sanitize,
            ..FirewallConfig::default()
        });
        let (provider, _) = StubProvider::new("primary", Mode::Ok);
        state
            .provider_runtime
            .register_for_test(Arc::clone(&provider) as Arc<dyn Provider>);
        let state = Arc::new(state);
        let mut ctx = plain_ctx();
        ctx.slot_provider = Some("primary".into());
        super::super::submit_media_job(Arc::clone(&state), ctx, body(), modality.clone())
            .await
            .unwrap();
        if modality == crate::config::Modality::Audio {
            let sent = provider.bodies.lock().unwrap()[0]["body"].clone();
            let verse = sent["lyrics"]["verses"][0].as_str().unwrap();
            assert!(
                !verse.contains(secret),
                "nested provider_input text must be sanitized"
            );
            assert_eq!(sent["audio_url"], inline, "inline media is not text");
            assert_eq!(sent["model"], "music-model");
            assert_eq!(sent["negative_prompt"], "no drums");
        }
    }

    let mut state = chain_state(10);
    state.update_firewall_config(FirewallConfig {
        enabled: true,
        policy: crate::config::FirewallPolicy::Block,
        ..FirewallConfig::default()
    });
    let (provider, calls) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(provider as Arc<dyn Provider>);
    let state = Arc::new(state);
    let mut ctx = plain_ctx();
    ctx.slot_provider = Some("primary".into());
    let blocked = super::super::submit_audio_job(Arc::clone(&state), ctx.clone(), body())
        .await
        .unwrap_err();
    assert!(
        matches!(blocked, GatewayError::FirewallBlocked(..)),
        "{blocked}"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    // A `data:` string that is not base64 image/video/audio carries
    // readable text, so a secret in it is scanned and blocked.
    for smuggled in [
        format!("data:text/plain,{secret}"),
        format!("data:text/plain;base64,{secret}"),
        format!("data:application/json,{{\"k\":\"{secret}\"}}"),
        format!("data:audio/wav,{secret}"),
        format!("DATA:image/png;base64,{secret} trailing text"),
    ] {
        let blocked = super::super::submit_audio_job(
            Arc::clone(&state),
            ctx.clone(),
            json!({"model":"m","prompt":"calm","lyrics": smuggled}),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(blocked, GatewayError::FirewallBlocked(..)),
            "{smuggled}: {blocked}"
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    // Well-formed base64 media is binary payload and is not scanned, even
    // when its bytes happen to spell a credential.
    super::super::submit_audio_job(
        Arc::clone(&state),
        ctx.clone(),
        json!({"model":"m","prompt":"calm","audio_url": format!("data:audio/wav;base64,{secret}")}),
    )
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

/// A presigned object-storage reference URL carries its signing key id in
/// the query string. DLP scans the URL's host and path but leaves the signed
/// query alone, so the provider can still fetch the input.
#[tokio::test]
async fn media_job_dlp_keeps_presigned_reference_urls_fetchable() {
    let presigned = "https://bucket.s3.amazonaws.com/a.wav?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261017%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Signature=0123abcd";
    let leaked_path = "https://media.example.test/AKIAIOSFODNN7EXAMPLE/a.wav";
    let leaked_query = "https://media.example.test/a.wav?key=AKIAIOSFODNN7EXAMPLE";
    for policy in [
        crate::config::FirewallPolicy::Block,
        crate::config::FirewallPolicy::Sanitize,
    ] {
        let mut state = chain_state(10);
        state.update_firewall_config(FirewallConfig {
            enabled: true,
            policy: policy.clone(),
            ..FirewallConfig::default()
        });
        let (provider, calls) = StubProvider::new("primary", Mode::Ok);
        state
            .provider_runtime
            .register_for_test(Arc::clone(&provider) as Arc<dyn Provider>);
        let state = Arc::new(state);
        let mut ctx = plain_ctx();
        ctx.slot_provider = Some("primary".into());
        super::super::submit_audio_job(
            Arc::clone(&state),
            ctx.clone(),
            json!({"model":"m","prompt":"restyle","audio_url": presigned}),
        )
        .await
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let sent = provider.bodies.lock().unwrap()[0]["body"].clone();
        assert_eq!(sent["audio_url"], presigned, "signed query must be intact");

        // Only a presigned query is excluded: a credential in the path or
        // in an ordinary query is still scanned.
        for url in [leaked_path, leaked_query] {
            let result = super::super::submit_audio_job(
                Arc::clone(&state),
                ctx.clone(),
                json!({"model":"m","prompt":"restyle","audio_url": url}),
            )
            .await;
            if policy == crate::config::FirewallPolicy::Block {
                assert!(
                    matches!(result, Err(GatewayError::FirewallBlocked(..))),
                    "{url}"
                );
            } else {
                result.unwrap();
                let bodies = provider.bodies.lock().unwrap();
                let sent = bodies.last().unwrap()["body"]["audio_url"].clone();
                assert!(
                    !sent.as_str().unwrap().contains("AKIAIOSFODNN7EXAMPLE"),
                    "{url} -> {sent}"
                );
            }
        }
    }
}

#[tokio::test]
async fn uncertain_delivery_stops_chat_and_paid_media_fallback() {
    for operation in ["buffered", "streaming", "tts"] {
        let mut state = chain_state(1);
        let (primary, primary_calls) = StubProvider::new("primary", Mode::DeliveryUncertain);
        let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
        state
            .provider_runtime
            .register_for_test(primary as Arc<dyn Provider>);
        state
            .provider_runtime
            .register_for_test(secondary as Arc<dyn Provider>);
        let state = Arc::new(state);
        let error = if operation == "streaming" {
            super::super::run_stream(Arc::clone(&state), plain_ctx(), ping_body())
                .await
                .err()
                .unwrap()
        } else if operation == "tts" {
            super::super::run_speech(
                Arc::clone(&state),
                plain_ctx(),
                json!({"model":"stub-1","input":"ping"}),
            )
            .await
            .err()
            .unwrap()
        } else {
            run(Arc::clone(&state), plain_ctx(), ping_body())
                .await
                .err()
                .unwrap()
        };
        assert!(matches!(error, GatewayError::ProviderDeliveryUncertain(_)));
        assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
        assert_eq!(secondary_calls.load(Ordering::SeqCst), 0);
        assert!(!state
            .circuit_breaker
            .is_open(&current_circuit_key(&state, "primary")));
    }
}
