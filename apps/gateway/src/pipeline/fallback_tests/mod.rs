#[path = "floor_bypass_test.rs"]
mod floor_bypass;
#[path = "headroom_compression_runtime_test.rs"]
mod headroom_compression_runtime;
#[path = "health_signal_probe_test.rs"]
mod health_signal_probe;
#[path = "safety_health_signal_test.rs"]
mod safety_health_signal;
#[path = "upstream_signals_test.rs"]
mod upstream_signals;
use super::stages::{self, PipelineStage};
use super::{
    enforce_budget, extract_definition_text, run, BudgetChargeKind, DegradedMode, OutputCeiling,
    RequestContext,
};
use crate::audit::AuditLogger;
use crate::config::{
    AuditConfig, CircuitBreakerConfig, EvalsConfig, FirewallConfig, GatewayConfig, ProviderId,
    RoutingConfig,
};
use crate::error::GatewayError;
use crate::providers::Provider;
use crate::router::RouteDecision;
use crate::state::AppState;
use ryu_gw_providers::ProviderError;
use serde_json::{json, Value};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// What a scripted provider does on `complete()`.
#[derive(Clone, Copy)]
enum Mode {
    /// Return a valid completion.
    Ok,
    /// Return a 429 → `ProviderError::RateLimited` (capacity signal, demote).
    RateLimited,
    /// Return a 402 account/payment condition (demote without provider fault).
    PaymentRequired,
    /// Return a generic provider failure (fault, trip circuit + fail over).
    Fail,
    /// Return an upstream refusal with this 4xx status
    /// (`ProviderError::Rejected`).
    Rejected(u16),
    /// Return an upstream safety refusal of this scope, as the provider
    /// crate builds it from a safety-signal table row.
    SafetyRefused(ryu_gw_providers::SafetyScope),
    /// Return a completion the model's safety system cut
    /// (`finish_reason: "content_filter"`).
    SoftRefusal,
    DeliveryUncertain,
    RestrictedToolCalls,
}

/// The error a stub returns for [`Mode::SafetyRefused`].
fn stub_safety_refusal(id: &str, scope: ryu_gw_providers::SafetyScope) -> ProviderError {
    ProviderError::SafetyRefused {
        provider: id.to_owned(),
        status: 403,
        scope,
        row: "test.stub",
        code: Some("ryu_test_signal".to_owned()),
        message: "RYU_TEST_FIXTURE upstream wording".to_owned(),
    }
}

struct StubProvider {
    id: &'static str,
    mode: Mode,
    calls: Arc<AtomicUsize>,
    bodies: std::sync::Mutex<Vec<Value>>,
}

impl StubProvider {
    fn new(id: &'static str, mode: Mode) -> (Arc<Self>, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let p = Arc::new(Self {
            id,
            mode,
            calls: Arc::clone(&calls),
            bodies: std::sync::Mutex::new(Vec::new()),
        });
        (p, calls)
    }
}

impl Provider for StubProvider {
    fn name(&self) -> &'static str {
        self.id
    }

    fn submit_video_bound<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<ryu_gw_providers::AcceptedVideo, ProviderError>>
                + Send
                + 'a,
        >,
    > {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let pending = matches!(self.mode, Mode::Fail);
        Box::pin(async move {
            Ok(ryu_gw_providers::AcceptedVideo {
                initial: ryu_gw_providers::VideoJob {
                    provider_ref: "private-fixture".into(),
                    status: if pending {
                        crate::jobs::JobStatus::Queued
                    } else {
                        crate::jobs::JobStatus::Succeeded
                    },
                    output: if pending {
                        None
                    } else {
                        Some(json!({"data":[{"url":"https://example.test/video.mp4"}]}))
                    },
                    error: None,
                },
                origin: Arc::new(FinishedVideoOrigin),
            })
        })
    }

    fn submit_media_job_bound<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        kind: ryu_gw_providers::MediaJobKind,
    ) -> Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<ryu_gw_providers::AcceptedMediaJob, ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        if kind == ryu_gw_providers::MediaJobKind::Video {
            return self.submit_video_bound(model, body);
        }
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.bodies
            .lock()
            .unwrap()
            .push(json!({"kind": kind.as_str(), "body": body.clone()}));
        Box::pin(async move {
            Ok(ryu_gw_providers::AcceptedVideo {
                initial: ryu_gw_providers::VideoJob {
                    provider_ref: "private-audio-fixture".into(),
                    status: crate::jobs::JobStatus::Succeeded,
                    output: Some(json!({"data":[{"url":"https://example.test/music.wav"}]})),
                    error: None,
                },
                origin: Arc::new(FinishedVideoOrigin),
            })
        })
    }

    fn complete<'a>(
        &'a self,
        _model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.bodies.lock().unwrap().push(body.clone());
        let mode = self.mode;
        let id = self.id;
        Box::pin(async move {
            match mode {
                Mode::RestrictedToolCalls => {
                    assert!(body.get("tools").is_none());
                    assert!(body.get("tool_choice").is_none());
                    assert_eq!(body["max_tokens"], 128);
                    Ok(json!({
                        "choices": [{"index": 0, "message": {
                            "role": "assistant", "content": "pong",
                            "tool_calls": [
                                {"id":"search", "type":"function", "function":{"name":"tool_search","arguments":"{}"}},
                                {"id":"alias", "type":"function", "function":{"name":"composio__GMAIL_SEARCH_EMAILS","arguments":"{}"}},
                                {"id":"skill", "type":"function", "function":{"name":"skills.load","arguments":"{}"}}
                            ]
                        }, "finish_reason":"tool_calls"}],
                        "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
                    }))
                }
                Mode::Ok => Ok(json!({
                    "id": "chatcmpl-stub",
                    "object": "chat.completion",
                    "model": "stub-1",
                    "choices": [{
                        "index": 0,
                        "message": {"role": "assistant", "content": "pong"},
                        "finish_reason": "stop"
                    }],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
                })),
                Mode::RateLimited => Err(ProviderError::RateLimited {
                    provider: id.to_string(),
                    retry_after: Some(30),
                    reset_at: None,
                }),
                Mode::PaymentRequired => Err(ProviderError::PaymentRequired {
                    provider: id.to_string(),
                    message: "no credits".to_owned(),
                }),
                Mode::Fail => Err(ProviderError::Provider(format!("{id} boom"))),
                Mode::Rejected(status) => Err(ProviderError::Rejected {
                    status,
                    message: format!("{id} error {status}"),
                }),
                Mode::SafetyRefused(scope) => Err(stub_safety_refusal(id, scope)),
                Mode::SoftRefusal => Ok(json!({
                    "id": "chatcmpl-stub",
                    "object": "chat.completion",
                    "model": "stub-1",
                    "choices": [{
                        "index": 0,
                        "message": {"role": "assistant", "content": ""},
                        "finish_reason": "content_filter"
                    }],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 0, "total_tokens": 1}
                })),
                Mode::DeliveryUncertain => Err(ProviderError::DeliveryUncertain(
                    "accepted body, no response".to_owned(),
                )),
            }
        })
    }

    fn synthesize_speech<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        self.complete(model, body)
    }

    fn embed<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        self.complete(model, body)
    }

    fn rerank<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        self.complete(model, body)
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        body: &'a Value,
    ) -> Pin<
        Box<dyn std::future::Future<Output = Result<axum::body::Body, ProviderError>> + Send + 'a>,
    > {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.bodies.lock().unwrap().push(body.clone());
        let mode = self.mode;
        let id = self.id;
        Box::pin(async move {
            match mode {
                Mode::Ok | Mode::RestrictedToolCalls => {
                    if matches!(mode, Mode::RestrictedToolCalls) {
                        assert!(body.get("tools").is_none());
                        assert!(body.get("tool_choice").is_none());
                        assert_eq!(body["max_tokens"], 128);
                    }
                    // A minimal but well-formed SSE stream with a terminal usage
                    // frame + [DONE], so the stream observer has real counts.
                    let sse = concat!(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"pong\"}}]}\n\n",
                        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n",
                        "data: [DONE]\n\n",
                    );
                    Ok(axum::body::Body::from(sse))
                }
                Mode::RateLimited => Err(ProviderError::RateLimited {
                    provider: id.to_string(),
                    retry_after: None,
                    reset_at: None,
                }),
                Mode::PaymentRequired => Err(ProviderError::PaymentRequired {
                    provider: id.to_string(),
                    message: "no credits".to_owned(),
                }),
                Mode::Fail => Err(ProviderError::Provider(format!("{id} stream boom"))),
                Mode::Rejected(status) => Err(ProviderError::Rejected {
                    status,
                    message: format!("{id} stream error {status}"),
                }),
                Mode::SafetyRefused(scope) => Err(stub_safety_refusal(id, scope)),
                Mode::SoftRefusal => Err(ProviderError::Provider(format!(
                    "{id} has no streamed soft refusal"
                ))),
                Mode::DeliveryUncertain => Err(ProviderError::DeliveryUncertain(
                    "accepted body, no response".to_owned(),
                )),
            }
        })
    }
}

/// Build a state whose routing pins `primary` first, then `secondary`, with the
/// firewall + circuit breaker configured for a deterministic test.
fn chain_state(threshold: u32) -> AppState {
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary"), ProviderId::from("secondary")],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        circuit_breaker: CircuitBreakerConfig {
            enabled: true,
            failure_threshold: threshold,
            reset_timeout_secs: 30,
        },
        ..GatewayConfig::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    AppState::new_for_test(config, audit, evals)
}

struct FinishedVideoOrigin;
impl ryu_gw_providers::VideoPollOrigin for FinishedVideoOrigin {
    fn poll(&self) -> ryu_gw_providers::VideoPollFuture<'_> {
        Box::pin(async {
            Ok(ryu_gw_providers::VideoJob {
                provider_ref: "private-fixture".into(),
                status: crate::jobs::JobStatus::Succeeded,
                output: Some(json!({"data":[{"url":"https://example.test/video.mp4"}]})),
                error: None,
            })
        })
    }
}

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
            let client = super::auxiliary::GovernedInference::new(state, ctx, "fixture");
            client
                .complete_target(
                    0,
                    &super::pool_execution::PoolTarget {
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
            super::run_stream(state, ctx, body).await.unwrap();
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
            let result = super::submit_video_job(
                Arc::clone(&state),
                ctx.clone(),
                json!({"model":"anything","prompt":prompt}),
            )
            .await
            .unwrap();
            let id = result["id"].as_str().unwrap().to_owned();
            assert_ne!(id, ctx.request_id);
            if matches!(mode, Mode::Fail) {
                let polled = super::poll_video_job(Arc::clone(&state), ctx.clone(), id.clone())
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

    let result = super::submit_audio_job(
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
    let wrong_route = super::poll_video_job(Arc::clone(&state), ctx.clone(), id.clone())
        .await
        .unwrap_err();
    assert!(
        wrong_route.to_string().contains("no such video job"),
        "{wrong_route}"
    );
    let polled = super::poll_audio_job(Arc::clone(&state), ctx.clone(), id.clone())
        .await
        .unwrap();
    assert_eq!(polled["status"], "succeeded");

    // Synchronous modalities never reach the queued-job path.
    let refused = super::submit_media_job(
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
        super::submit_media_job(Arc::clone(&state), ctx, body(), modality.clone())
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
    let blocked = super::submit_audio_job(Arc::clone(&state), ctx.clone(), body())
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
        let blocked = super::submit_audio_job(
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
    super::submit_audio_job(
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
        super::submit_audio_job(
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
            let result = super::submit_audio_job(
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
            super::run_stream(Arc::clone(&state), plain_ctx(), ping_body())
                .await
                .err()
                .unwrap()
        } else if operation == "tts" {
            super::run_speech(
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

fn plain_ctx() -> RequestContext {
    RequestContext {
        org_limits: None,
        identity: None,
        standing: None,
        enforcement: None,
        host_conversation: None,
        authorized_operation: crate::config::ApiKeyOperation::Inference,
        provider_snapshot: None,
        request_id: "fallback-req".to_string(),
        api_key: "sk-test".to_string(),
        owner_binding: ryu_gw_credentials::fingerprint("sk-test"),
        is_master_key: false,
        org_id: None,
        team_id: None,
        project_id: None,
        user_name: None,
        user_id: None,
        agent_id: None,
        agent_provider_access: None,
        key_config: None,
        skill_ids: None,
        tool_actions: None,
        tools_header_present: false,
        capability_hints: None,
        slot_provider: None,
        slot_model: None,
        own_supply_route: None,
        violation_attempt: Default::default(),
        session_id: None,
        feature: None,
        purpose: None,
        companion_source: false,
        tool_search_requested: false,
        untrusted_caller: false,
        priority: crate::concurrency::Priority::Interactive,
        tool_profile: None,
        raw_tools: false,
        managed_inference: false,
        openrouter_routing_enabled: false,
        remaining_budget_micro_usd: None,
        unrestricted_budget_micro_usd: None,
        pool_budgets_micro_usd: std::collections::HashMap::new(),
        credit_accounting_unavailable: false,
        budget_resolved_at: None,
        resolved_policy: None,
        prompt_cache_mode: None,
        prompt_cache_ttl: None,
        node_routing: None,
    }
}

fn ping_body() -> Value {
    json!({ "model": "anything", "messages": [{"role": "user", "content": "ping"}] })
}

// ── own-supply routing, end to end through `run()` / `run_stream()` ──────

/// A managed fleet whose default route is the Ryu Router (`openrouter`)
/// slot, plus Ryu's own `anthropic-credits` slot in `own` mode.
fn own_supply_state(own: Mode) -> (Arc<AppState>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
    own_supply_state_with(own, None)
}

fn own_supply_state_with(
    own: Mode,
    runtime: Option<crate::own_supply_table::OwnSupplyRuntime>,
) -> (Arc<AppState>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
    let mut config = GatewayConfig::default();
    config.firewall.enabled = false;
    config.routing.default_provider = ProviderId::from("openrouter");
    config.routing.fallback_chain = Vec::new();
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);
    let (router, router_calls) = StubProvider::new("openrouter", Mode::Ok);
    let (slot, slot_calls) = StubProvider::new("anthropic-credits", own);
    state
        .provider_runtime
        .register_for_test(router as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(slot as Arc<dyn Provider>);
    if let Some(runtime) = runtime {
        state.own_supply = Arc::new(runtime);
    }
    (Arc::new(state), router_calls, slot_calls)
}

/// A fleet gateway's published table with one dynamically linked model
/// that has no Ryu alias (`claude-opus-4-1`).
fn fleet_runtime_with_opus_41() -> crate::own_supply_table::OwnSupplyRuntime {
    let (table, _) = crate::own_supply_table::parse_table(&json!({
        "version": 4,
        "rows": [{
            "id": "anthropic/claude-opus-4.1",
            "slot": "anthropic-credits",
            "upstream": "claude-opus-4-1",
            "userPrice": {
                "inPer1kMicroUsd": 15000,
                "outPer1kMicroUsd": 75000,
                "cacheReadPer1kMicroUsd": 1500,
                "cacheWritePer1kMicroUsd": 18750
            }
        }],
        "poolDefaults": {}
    }))
    .unwrap();
    crate::own_supply_table::OwnSupplyRuntime::fleet_for_test(table, None)
}

fn opus_41_body() -> Value {
    json!({
        "model": "anthropic/claude-opus-4.1",
        "messages": [{"role": "user", "content": "ping"}]
    })
}

#[tokio::test]
async fn a_published_row_routes_only_after_its_canary_and_shows_the_picked_id() {
    // Fleet gateway, no canary yet: the Ryu Router route.
    let (state, router_calls, slot_calls) =
        own_supply_state_with(Mode::Ok, Some(fleet_runtime_with_opus_41()));
    run(
        Arc::clone(&state),
        free_credit_ctx(5_000_000),
        opus_41_body(),
    )
    .await
    .expect("router serves");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 0);
    assert_eq!(router_calls.load(Ordering::SeqCst), 1);
    // A seed id that is not in the published table never goes to a slot.
    run(
        Arc::clone(&state),
        free_credit_ctx(5_000_000),
        sonnet_body(),
    )
    .await
    .expect("router serves");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 0);

    // Canary passed: served from own supply under the picked id, priced at
    // the row's price rather than the flat rate.
    state.own_supply.record_canary(
        "anthropic-credits",
        "claude-opus-4-1",
        crate::own_supply_table::CanaryResult {
            ok: true,
            at: std::time::Instant::now(),
            key_fingerprint: "test".into(),
        },
    );
    let out = run(
        Arc::clone(&state),
        free_credit_ctx(5_000_000),
        opus_41_body(),
    )
    .await
    .expect("own supply serves");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 1);
    assert_eq!(out.response["model"], "anthropic/claude-opus-4.1");
    assert_eq!(out.provider_used, "ryu");
    assert_eq!(
        super::response_cost_micro_usd(
            &state,
            Some("anthropic-credits"),
            None,
            1000,
            1000,
            "claude-opus-4-1",
            None
        ),
        90_000
    );
    // A cached prompt is billed like OpenRouter bills it: 900 of the 1,000
    // prompt tokens read from cache at $1.50/M, 100 fresh at $15/M.
    assert_eq!(
        super::response_cost_micro_usd(
            &state,
            Some("anthropic-credits"),
            None,
            1000,
            1000,
            "claude-opus-4-1",
            Some(super::provider_usage::ProviderCacheUsage {
                read_tokens: 900,
                write_tokens: 0,
                write_1h_tokens: 0,
            })
        ),
        1_500 + 1_350 + 75_000
    );
    // A one-hour cache write is billed at 2x the prompt price ($30/M for
    // Opus), not the catalog's five-minute write rate ($18.75/M).
    assert_eq!(
        super::response_cost_micro_usd(
            &state,
            Some("anthropic-credits"),
            None,
            1000,
            1000,
            "claude-opus-4-1",
            Some(super::provider_usage::ProviderCacheUsage {
                read_tokens: 0,
                write_tokens: 1000,
                write_1h_tokens: 1000,
            })
        ),
        30_000 + 75_000
    );

    // Quarantined (a runtime 404): back to the Ryu Router route.
    state
        .own_supply
        .quarantine("anthropic-credits", "claude-opus-4-1");
    let mut fresh = opus_41_body();
    fresh["messages"][0]["content"] = json!("ping again");
    run(Arc::clone(&state), free_credit_ctx(5_000_000), fresh)
        .await
        .expect("router serves");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 1);
    assert_eq!(router_calls.load(Ordering::SeqCst), 3);
}

fn free_credit_ctx(free: i64) -> RequestContext {
    let mut ctx = plain_ctx();
    ctx.org_id = Some("own-supply".to_owned());
    ctx.managed_inference = true;
    ctx.remaining_budget_micro_usd = Some(1_000_000 + free);
    ctx.unrestricted_budget_micro_usd = Some(1_000_000);
    // Granted against a DIFFERENT own pool: free credit is not model-bound.
    ctx.pool_budgets_micro_usd =
        std::collections::HashMap::from([("openai-credits".to_owned(), free)]);
    ctx
}

fn sonnet_body() -> Value {
    json!({
        "model": "anthropic/claude-sonnet-4.5",
        "messages": [{"role": "user", "content": "ping"}]
    })
}

#[tokio::test]
async fn free_credit_serves_an_equivalent_pick_from_own_supply_under_the_picked_id() {
    let (state, router_calls, slot_calls) = own_supply_state(Mode::Ok);
    let out = run(
        Arc::clone(&state),
        free_credit_ctx(5_000_000),
        sonnet_body(),
    )
    .await
    .expect("own supply serves");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 1);
    assert_eq!(router_calls.load(Ordering::SeqCst), 0);
    assert_eq!(out.response["model"], "anthropic/claude-sonnet-4.5");
    assert_eq!(out.model_used, "anthropic/claude-sonnet-4.5");
    assert_eq!(out.provider_used, "ryu");

    let out = super::run_stream(state, free_credit_ctx(5_000_000), sonnet_body())
        .await
        .expect("own supply streams");
    assert_eq!(out.model_used, "anthropic/claude-sonnet-4.5");
    assert_eq!(out.provider_used, "ryu");
    let _ = axum::body::to_bytes(out.body, usize::MAX).await.unwrap();
    assert_eq!(slot_calls.load(Ordering::SeqCst), 2);
    assert_eq!(router_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn without_free_credit_the_pick_goes_to_the_ryu_router_route() {
    let (state, router_calls, slot_calls) = own_supply_state(Mode::Ok);
    let out = run(state, free_credit_ctx(0), sonnet_body())
        .await
        .expect("router serves");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 0);
    assert_eq!(router_calls.load(Ordering::SeqCst), 1);
    // A managed caller never sees the serving slot, OpenRouter included.
    assert_eq!(out.provider_used, "ryu");
}

#[tokio::test]
async fn a_fully_dialed_row_serves_paid_traffic_and_falls_back_on_failure() {
    let paid_runtime = || {
        let (table, _) = crate::own_supply_table::parse_table(&json!({
            "version": 5,
            "rows": [{
                "id": "anthropic/claude-sonnet-4.5",
                "slot": "anthropic-credits",
                "upstream": "claude-sonnet-4-5",
                "userPrice": {"inPer1kMicroUsd": 3000, "outPer1kMicroUsd": 15000},
                "paidRolloutBps": 10000
            }],
            "poolDefaults": {}
        }))
        .unwrap();
        let runtime = crate::own_supply_table::OwnSupplyRuntime::fleet_for_test(table, None);
        runtime.record_canary(
            "anthropic-credits",
            "claude-sonnet-4-5",
            crate::own_supply_table::CanaryResult {
                ok: true,
                at: std::time::Instant::now(),
                key_fingerprint: "test".into(),
            },
        );
        runtime
    };
    // Paid traffic needs the pool reported, with no donation ceiling.
    let report = |remaining_micro_usd: Option<i64>| {
        std::collections::HashMap::from([(
            "anthropic-credits".to_owned(),
            crate::credit_pools::PoolAllowance {
                remaining_micro_usd,
                expires_at: None,
            },
        )])
    };
    let (state, router_calls, slot_calls) = own_supply_state_with(Mode::Ok, Some(paid_runtime()));
    let out = run(Arc::clone(&state), free_credit_ctx(0), sonnet_body())
        .await
        .expect("router serves a paid caller while no allowance is known");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 0);
    assert_eq!(router_calls.load(Ordering::SeqCst), 1);
    assert_eq!(out.provider_used, "ryu");

    // A donated allowance (any ceiling) keeps paid traffic on the router.
    // (A new prompt, so the router's response cache cannot answer it.)
    state.pool_allowances.observe(&report(Some(1_000_000_000)));
    let mut capped_body = sonnet_body();
    capped_body["messages"][0]["content"] = json!("ping on a capped pool");
    run(Arc::clone(&state), free_credit_ctx(0), capped_body)
        .await
        .expect("router serves a paid caller on a capped pool");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 0);
    assert_eq!(router_calls.load(Ordering::SeqCst), 2);

    state.pool_allowances.observe(&report(None));
    let out = run(Arc::clone(&state), free_credit_ctx(0), sonnet_body())
        .await
        .expect("own supply serves a paid caller");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 1);
    assert_eq!(router_calls.load(Ordering::SeqCst), 2);
    assert_eq!(out.response["model"], "anthropic/claude-sonnet-4.5");
    assert_eq!(out.provider_used, "ryu");

    let (state, router_calls, slot_calls) = own_supply_state_with(Mode::Fail, Some(paid_runtime()));
    state.pool_allowances.observe(&report(None));
    run(state, free_credit_ctx(0), sonnet_body())
        .await
        .expect("the router route rescues a paid request");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 1);
    assert_eq!(router_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn an_own_supply_failure_before_output_falls_back_to_the_ryu_router() {
    let (state, router_calls, slot_calls) = own_supply_state(Mode::Fail);
    let out = run(
        Arc::clone(&state),
        free_credit_ctx(5_000_000),
        sonnet_body(),
    )
    .await
    .expect("the router route rescues the request");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 1);
    assert_eq!(router_calls.load(Ordering::SeqCst), 1);
    assert_eq!(out.provider_used, "ryu");

    // An outage that never reached a provider (rate limit) falls back on
    // the streaming path too.
    let (state, router_calls, _) = own_supply_state(Mode::RateLimited);
    let out = super::run_stream(state, free_credit_ctx(5_000_000), sonnet_body())
        .await
        .expect("the router route rescues the stream");
    let _ = axum::body::to_bytes(out.body, usize::MAX).await.unwrap();
    assert_eq!(router_calls.load(Ordering::SeqCst), 1);
}

fn current_circuit_key(state: &AppState, provider: &str) -> String {
    state
        .provider_runtime
        .snapshot()
        .epoch
        .circuit_key(provider)
}

// ── node routing preferences, end to end through `run()` ─────────────────

/// `chain_state` with a third provider in the chain, so a preference has
/// something to actually reorder.
fn three_chain_state() -> AppState {
    // Built from config, not mutated afterwards: `AppState::new_for_test`
    // constructs the router registry from `config.routing`, so a chain widened
    // after the fact would never reach the router.
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![
                ProviderId::from("primary"),
                ProviderId::from("secondary"),
                ProviderId::from("tertiary"),
            ],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        circuit_breaker: CircuitBreakerConfig {
            enabled: true,
            failure_threshold: 10,
            reset_timeout_secs: 30,
        },
        ..GatewayConfig::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    AppState::new_for_test(config, audit, evals)
}

fn prefs(fallback: &[&str]) -> super::node_routing::NodeRoutingPrefs {
    super::node_routing::NodeRoutingPrefs {
        fallback: fallback.iter().map(|s| (*s).to_string()).collect(),
        firewall: None,
        openrouter: None,
        openrouter_model_fallbacks: Vec::new(),
    }
}

/// A node preference REORDERS the fleet's chain: with the primary demoting,
/// the node's preferred fallback serves before the fleet's default second.
#[tokio::test]
async fn a_node_preference_reorders_the_fleet_fallback_chain() {
    let mut state = three_chain_state();
    let (primary, _) = StubProvider::new("primary", Mode::RateLimited);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    let (tertiary, tertiary_calls) = StubProvider::new("tertiary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(tertiary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let mut ctx = plain_ctx();
    ctx.node_routing = Some(prefs(&["tertiary"]));

    let out = run(Arc::clone(&state), ctx, ping_body())
        .await
        .expect("the preferred fallback must serve");

    assert_eq!(out.provider_used, "tertiary");
    assert_eq!(
        secondary_calls.load(Ordering::SeqCst),
        0,
        "the fleet's default second was reordered behind the node's preference"
    );
    assert_eq!(tertiary_calls.load(Ordering::SeqCst), 1);
}

/// THE acceptance criterion: a preference may narrow and reorder the org's
/// envelope, never widen it. A provider the fleet's own chain does not
/// contain is never dispatched to, even when it is registered and healthy —
/// because `preflight_credit_gate` only ever gated the PRIMARY's pool.
#[tokio::test]
async fn a_node_preference_can_never_add_a_provider_to_the_chain() {
    let mut state = chain_state(10);
    let (primary, _) = StubProvider::new("primary", Mode::RateLimited);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    // Registered and perfectly healthy, but NOT in the fleet's fallback chain.
    let (offchain, offchain_calls) = StubProvider::new("tertiary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(offchain as Arc<dyn Provider>);
    let state = Arc::new(state);

    let mut ctx = plain_ctx();
    ctx.node_routing = Some(prefs(&["tertiary"]));

    let out = run(Arc::clone(&state), ctx, ping_body())
        .await
        .expect("the fleet's own chain still serves the turn");

    assert_eq!(out.provider_used, "secondary");
    assert_eq!(
        offchain_calls.load(Ordering::SeqCst),
        0,
        "a preference must not route out of a credit pool nothing gated"
    );
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
}

fn provider_access(ids: &[&str]) -> Option<Arc<std::collections::HashSet<String>>> {
    Some(Arc::new(ids.iter().map(|id| (*id).to_owned()).collect()))
}

/// An agent limited to one provider is served from it even when another is
/// the primary: the denied primary is skipped like any policy refusal.
#[tokio::test]
async fn agent_provider_access_skips_providers_the_agent_may_not_use() {
    let mut state = chain_state(10);
    let (primary, primary_calls) = StubProvider::new("primary", Mode::Ok);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let mut ctx = plain_ctx();
    ctx.agent_provider_access = provider_access(&["secondary"]);
    let out = run(Arc::clone(&state), ctx, ping_body())
        .await
        .expect("the allowed provider serves the turn");
    assert_eq!(out.provider_used, "secondary");
    assert_eq!(primary_calls.load(Ordering::SeqCst), 0);
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);

    // With no provider allowed, nothing is dispatched and the refusal says why.
    let mut ctx = plain_ctx();
    ctx.agent_provider_access = provider_access(&[]);
    ctx.is_master_key = true;
    let Err(error) = run(Arc::clone(&state), ctx, ping_body()).await else {
        panic!("no provider may serve this agent");
    };
    assert!(
        error.to_string().contains("account access"),
        "unexpected error: {error}"
    );
    assert_eq!(primary_calls.load(Ordering::SeqCst), 0);
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn agent_provider_access_allows_only_listed_and_credential_free_slots() {
    let state = AppState::new_for_test_default();
    let none = {
        let mut ctx = plain_ctx();
        ctx.agent_provider_access = provider_access(&[]);
        ctx
    };
    for denied in ["openai", "openrouter", "core", "anthropic", "genai"] {
        assert!(
            crate::pipeline::inference_governance::authorize_agent_provider(
                &state,
                &none,
                &ProviderId::from(denied)
            )
            .is_err(),
            "{denied}"
        );
    }
    for allowed in [
        "local",
        crate::config::CLASSIFY_PROVIDER_ID,
        crate::config::OPENAI_CREDITS_PROVIDER_ID,
        crate::config::BEDROCK_PROVIDER_ID,
        crate::config::CLOUDFLARE_PROVIDER_ID,
        "genai-ollama",
    ] {
        assert!(
            crate::pipeline::inference_governance::authorize_agent_provider(
                &state,
                &none,
                &ProviderId::from(allowed)
            )
            .is_ok(),
            "{allowed}"
        );
    }
    // Gemini's registry id is `genai`; the list carries registry ids.
    let mut gemini = plain_ctx();
    gemini.agent_provider_access = provider_access(&["genai"]);
    assert!(
        crate::pipeline::inference_governance::authorize_agent_provider(
            &state,
            &gemini,
            &ProviderId::from("genai")
        )
        .is_ok()
    );
    assert!(
        crate::pipeline::inference_governance::authorize_agent_provider(
            &state,
            &gemini,
            &ProviderId::from("genai-openai")
        )
        .is_err()
    );
    // No list: unrestricted, as before.
    assert!(
        crate::pipeline::inference_governance::authorize_agent_provider(
            &state,
            &plain_ctx(),
            &ProviderId::from("openai")
        )
        .is_ok()
    );
    // The master key does not bypass an agent's list.
    let mut master = plain_ctx();
    master.is_master_key = true;
    master.agent_provider_access = provider_access(&["anthropic"]);
    assert!(
        crate::pipeline::inference_governance::authorize_provider_region(
            &AppState::new_for_test_default(),
            &master,
            &ProviderId::from("openai")
        )
        .is_err()
    );
    assert!(
        crate::pipeline::inference_governance::authorize_provider_region(
            &AppState::new_for_test_default(),
            &master,
            &ProviderId::from("anthropic")
        )
        .is_ok()
    );
}

fn fleet_tenant_ctx() -> RequestContext {
    let mut ctx = plain_ctx();
    ctx.org_id = Some("o1".to_owned());
    ctx.managed_inference = true;
    ctx.remaining_budget_micro_usd = Some(10_000);
    ctx
}

fn billing_state() -> AppState {
    let mut config = crate::GatewayConfig::default();
    config.credits.enabled = true;
    config.credits.internal_secret = Some("debit-secret".to_owned());
    config.credits.base_url = "http://control-plane.invalid".to_owned();
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    AppState::new_for_test(config, audit, evals)
}

/// A hosted organisation's managed inference on a billing gateway runs on
/// the fleet's keys and is billed to the organisation, so an agent's
/// provider list (which limits the user's own credentials) does not block
/// it. Every other combination stays limited.
#[test]
fn agent_provider_access_exempts_fleet_supply_for_managed_tenants() {
    let billing = billing_state();
    let not_billing = AppState::new_for_test_default();
    let fleet_tenant = {
        let mut ctx = fleet_tenant_ctx();
        ctx.agent_provider_access = provider_access(&[]);
        ctx
    };
    let check = |state: &AppState, ctx: &RequestContext, provider: &str| {
        crate::pipeline::inference_governance::authorize_agent_provider(
            state,
            ctx,
            &ProviderId::from(provider),
        )
    };
    for provider in ["openrouter", "openai", "anthropic", "genai"] {
        assert!(
            check(&billing, &fleet_tenant, provider).is_ok(),
            "{provider}"
        );
        // A gateway that does not bill may hold the operator's (the
        // user's) own keys: still limited.
        assert!(
            check(&not_billing, &fleet_tenant, provider).is_err(),
            "{provider}"
        );
    }
    // A static or scoped key on a billing gateway is not managed inference.
    let mut static_key = fleet_tenant.clone();
    static_key.managed_inference = false;
    assert!(check(&billing, &static_key, "openrouter").is_err());
    // Without a resolved organisation there is no tenant wallet.
    let mut no_org = fleet_tenant.clone();
    no_org.org_id = None;
    assert!(check(&billing, &no_org, "openai").is_err());
    // The master key never stands for a hosted tenant.
    let mut master = fleet_tenant.clone();
    master.is_master_key = true;
    assert!(check(&billing, &master, "openai").is_err());
    // No list stays unrestricted on every gateway.
    assert!(check(&not_billing, &fleet_tenant_ctx(), "openai").is_ok());
}

/// The exemption only lifts the agent's account check: the organisation's
/// own provider policy still binds the fleet-served turn.
#[test]
fn managed_tenant_policy_still_binds_an_exempt_agent() {
    let billing = billing_state();
    let mut ctx = fleet_tenant_ctx();
    ctx.agent_provider_access = provider_access(&[]);
    ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
        approved_providers: vec!["anthropic".to_owned()],
        ..Default::default()
    });
    assert!(
        crate::pipeline::inference_governance::authorize_provider_region(
            &billing,
            &ctx,
            &ProviderId::from("anthropic")
        )
        .is_ok()
    );
    let Err(error) = crate::pipeline::inference_governance::authorize_provider_region(
        &billing,
        &ctx,
        &ProviderId::from("openrouter"),
    ) else {
        panic!("the organisation's policy must still refuse openrouter");
    };
    assert!(
        error.to_string().contains("control-plane provider"),
        "unexpected error: {error}"
    );
}

#[test]
fn agent_provider_access_header_parses_and_narrows() {
    assert!(super::parse_agent_provider_access("none").is_empty());
    assert!(super::parse_agent_provider_access(" NONE ").is_empty());
    assert_eq!(
        super::parse_agent_provider_access("openai, anthropic,,Bad Id,genai"),
        ["openai", "anthropic", "genai"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    );
    let narrowed = super::narrow_agent_provider_access(
        provider_access(&["openai", "anthropic"]),
        Some(vec!["anthropic".to_owned()]),
    )
    .unwrap();
    assert_eq!(narrowed.len(), 1);
    assert!(narrowed.contains("anthropic"));
    assert!(super::narrow_agent_provider_access(None, None).is_none());
    assert!(super::narrow_agent_provider_access(None, Some(Vec::new()))
        .unwrap()
        .is_empty());
}

/// A locked node ignores the preference wholesale — the `[node_routing]`
/// lever, mirroring `[prompt_cache].allow_request_override`.
#[tokio::test]
async fn a_locked_node_ignores_the_preference_end_to_end() {
    let mut state = three_chain_state();
    state.config.node_routing.allow_request_override = false;
    let (primary, _) = StubProvider::new("primary", Mode::RateLimited);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    let (tertiary, tertiary_calls) = StubProvider::new("tertiary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(tertiary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let mut ctx = plain_ctx();
    ctx.node_routing = Some(prefs(&["tertiary"]));

    let out = run(Arc::clone(&state), ctx, ping_body())
        .await
        .expect("the fleet order stands");

    assert_eq!(out.provider_used, "secondary");
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
    assert_eq!(tertiary_calls.load(Ordering::SeqCst), 0);
}

/// The polarity of the credit gate `clamped_fallback_chain` hands the clamp
/// (`preflight_credit_gate(..).is_none()` — `Some(err)` means REJECTED) is
/// expressed in exactly ONE place in production. A unit test that writes its
/// own closure cannot pin it: inverting the adapter leaves such a test green
/// while every reorder starts promoting providers the org cannot pay for.
///
/// So this drives the real thing through `run()`. The setup is the segregated
/// credit-pool case, which is also the only shape where the bug is reachable:
/// the org has grant money in the PRIMARY's pool (so `enforce_budget` admits
/// the request — it gates the primary's pool only) and nothing unrestricted,
/// so the preferred fallback in a DIFFERENT pool is unfunded and must not be
/// promoted ahead of the fleet's own next choice.
#[tokio::test]
async fn credit_gate_polarity_is_wired_correctly_end_to_end() {
    // Real provider ids, because `pool_for_gateway_provider` is a fixed table:
    // `openrouter` → the retail pool (funded here by its own grant),
    // `cloudflare` → own supply, which a retail primary may never fail over
    // onto (`keep_own_supply_in_its_lane`), and the made-up `secondary` is
    // untagged, so it needs unrestricted credit.
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("openrouter"),
            fallback_chain: vec![
                ProviderId::from("openrouter"),
                ProviderId::from("secondary"),
                ProviderId::from("cloudflare"),
            ],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        circuit_breaker: CircuitBreakerConfig {
            enabled: true,
            failure_threshold: 10,
            reset_timeout_secs: 30,
        },
        credits: crate::config::CreditsConfig {
            reserve_enabled: true,
            min_reserve_micro_usd: 10_000,
            ..Default::default()
        },
        rate_limit: crate::config::RateLimitConfig {
            max_burst_per_second: 0,
            ..Default::default()
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

    let (primary, _) = StubProvider::new("openrouter", Mode::RateLimited);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    let (own_supply, bedrock_calls) = StubProvider::new("cloudflare", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(own_supply as Arc<dyn Provider>);
    let state = Arc::new(state);

    let mut ctx = plain_ctx();
    ctx.managed_inference = true;
    ctx.org_id = Some("fallback-pool-test".into());
    // Total is positive (so the wallet is not simply empty), but ALL of it is
    // the PRIMARY's own pool grant: the untagged fallback is unfunded, and
    // the own-supply one is out of lane however the node prefers it.
    ctx.remaining_budget_micro_usd = Some(50_000);
    ctx.unrestricted_budget_micro_usd = Some(0);
    ctx.pool_budgets_micro_usd =
        std::collections::HashMap::from([("openrouter".to_string(), 50_000_i64)]);
    ctx.node_routing = Some(prefs(&["cloudflare"]));

    for preference in [
        Some(prefs(&["cloudflare"])),
        Some(prefs(&["secondary"])),
        None,
    ] {
        ctx.node_routing = preference;
        assert!(matches!(
            run(Arc::clone(&state), ctx.clone(), ping_body()).await,
            Err(GatewayError::InsufficientCredits)
        ));
        assert!(matches!(
            super::run_stream(Arc::clone(&state), ctx.clone(), ping_body()).await,
            Err(GatewayError::InsufficientCredits)
        ));
        assert!(matches!(
            super::run_speech(
                Arc::clone(&state),
                ctx.clone(),
                json!({"model":"stub-1","input":"ping"})
            )
            .await,
            Err(GatewayError::InsufficientCredits)
        ));
        for operation in [
            super::EmbeddingOperation::Embed,
            super::EmbeddingOperation::Rerank,
        ] {
            assert!(matches!(
                super::run_embedding(
                    Arc::clone(&state),
                    ctx.clone(),
                    json!({"model":"stub-1","input":"ping","query":"ping","documents":["pong"]}),
                    operation
                )
                .await,
                Err(GatewayError::InsufficientCredits)
            ));
        }
        assert_eq!(
            bedrock_calls.load(Ordering::SeqCst),
            0,
            "a retail primary never fails over onto own supply"
        );
        assert_eq!(
            secondary_calls.load(Ordering::SeqCst),
            0,
            "untagged fallback requires unrestricted credit"
        );
    }
    ctx.unrestricted_budget_micro_usd = Some(50_000);
    ctx.remaining_budget_micro_usd = Some(100_000);
    let out = run(Arc::clone(&state), ctx.clone(), ping_body())
        .await
        .unwrap();
    assert_eq!(
        out.provider_used, "secondary",
        "funded fallback still serves"
    );
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
    assert_eq!(bedrock_calls.load(Ordering::SeqCst), 0);
    let out = super::run_stream(Arc::clone(&state), ctx, ping_body())
        .await
        .unwrap();
    assert!(
        state.wallet.in_flight_micro_usd("fallback-pool-test") >= 10_000,
        "the funded fallback holds its own reservation throughout streaming"
    );
    let _ = axum::body::to_bytes(out.body, usize::MAX).await.unwrap();
    assert_eq!(state.wallet.in_flight_micro_usd("fallback-pool-test"), 0);
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 2);
    assert_eq!(bedrock_calls.load(Ordering::SeqCst), 0);
}

// ── slot-model allowlist bypass (pre-existing hole) ──────────────────────

/// `x-ryu-slot-chat-model` replaced the dispatched model AFTER the Policy
/// stage had only checked `body["model"]`, so an `rgw_` bearer could name an
/// approved model in the body and the real one in the slot headers and route
/// around the org's `approved_models`. The disallowed slot is now IGNORED —
/// the turn still runs, under a model the org did approve.
///
/// The slot provider is set too, and that is not incidental: `route_modality`
/// in `ryu-gw-router` only consults `slot_model` inside the
/// `if let Some(provider) = slot_provider` arm, so the bypass needs BOTH
/// `x-ryu-slot-chat-provider` and `-model`. Verified against the router rather
/// than assumed from the pipeline's `slot_provider.is_some() ||
/// slot_model.is_some()` guard, which is looser than what actually routes.
#[tokio::test]
async fn a_slot_model_outside_the_org_allowlist_is_ignored_not_dispatched() {
    let mut state = chain_state(10);
    let (primary, _) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let mut ctx = plain_ctx();
    ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
        approved_models: vec!["approved-model".into()],
        ..Default::default()
    });
    ctx.slot_provider = Some(ProviderId::from("primary"));
    ctx.slot_model = Some("forbidden-model".into());

    let out = run(
        Arc::clone(&state),
        ctx,
        json!({
            "model": "approved-model",
            "messages": [{"role": "user", "content": "ping"}]
        }),
    )
    .await
    .expect("the turn still succeeds under the approved model");

    assert_ne!(
        out.model_used, "forbidden-model",
        "the client-supplied slot model bypassed the org's approved_models"
    );
    assert_eq!(out.model_used, "approved-model");
}

/// The other half: an ALLOWED slot model still wins, so the clamp did not
/// break per-agent slot pinning. And with no allowlist at all (every
/// non-allowlisted deployment) nothing changes.
#[tokio::test]
async fn an_allowed_slot_model_and_an_empty_allowlist_both_still_pin() {
    let mut state = chain_state(10);
    let (primary, _) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let mut ctx = plain_ctx();
    ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
        approved_models: vec!["approved-model".into(), "slot-model".into()],
        ..Default::default()
    });
    ctx.slot_provider = Some(ProviderId::from("primary"));
    ctx.slot_model = Some("slot-model".into());
    let out = run(
        Arc::clone(&state),
        ctx,
        json!({"model": "approved-model", "messages": [{"role": "user", "content": "ping"}]}),
    )
    .await
    .expect("an approved slot model dispatches");
    assert_eq!(out.model_used, "slot-model");

    let mut ctx = plain_ctx();
    ctx.slot_provider = Some(ProviderId::from("primary"));
    ctx.slot_model = Some("anything-at-all".into());
    let out = run(Arc::clone(&state), ctx, ping_body())
        .await
        .expect("no allowlist ⇒ unchanged behaviour");
    assert_eq!(out.model_used, "anything-at-all");
}

/// A rate-limited primary demotes to the next provider in the chain: the
/// secondary serves the turn, the response is flagged as a degraded fallback,
/// and — crucially — the primary's circuit is NOT tripped (a 429 is a capacity
/// signal, not a fault).
#[tokio::test]
async fn rate_limited_primary_demotes_to_secondary_without_tripping_circuit() {
    let mut state = chain_state(1);
    let (primary, primary_calls) = StubProvider::new("primary", Mode::RateLimited);
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
        .expect("secondary must serve after primary rate-limits");

    assert_eq!(out.provider_used, "secondary");
    assert_eq!(
        out.degraded,
        Some(DegradedMode::Fallback("secondary".into()))
    );
    assert_eq!(primary_calls.load(Ordering::SeqCst), 1, "primary was tried");
    assert_eq!(
        secondary_calls.load(Ordering::SeqCst),
        1,
        "secondary served"
    );
    // The 429 must NOT open the primary's circuit even with threshold=1.
    assert!(
        !state
            .circuit_breaker
            .is_open(&current_circuit_key(&state, "primary")),
        "a rate-limit is a capacity signal and must not trip the circuit"
    );
}

#[tokio::test]
async fn payment_required_primary_demotes_without_tripping_circuit() {
    let mut state = chain_state(1);
    let (primary, primary_calls) = StubProvider::new("primary", Mode::PaymentRequired);
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
        .expect("secondary must serve after the selected account returns 402");

    assert_eq!(out.provider_used, "secondary");
    assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
    assert!(
        !state
            .circuit_breaker
            .is_open(&current_circuit_key(&state, "primary")),
        "a payment condition belongs to the account, not provider health"
    );
}

#[tokio::test]
async fn exhausted_chain_preserves_the_payment_required_reason() {
    let mut state = chain_state(1);
    let (primary, _) = StubProvider::new("primary", Mode::PaymentRequired);
    let (secondary, _) = StubProvider::new("secondary", Mode::Fail);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let err = match run(Arc::clone(&state), plain_ctx(), ping_body()).await {
        Err(error) => error,
        Ok(_) => panic!("an exhausted fallback chain must fail"),
    };
    assert!(
        matches!(err, GatewayError::ProviderPaymentRequired { .. }),
        "the actionable 402 must survive a later generic fallback error: {err:?}"
    );
}

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

/// Answers with an email address so outbound DLP has something to act on.
struct PiiAnswerProvider {
    calls: Arc<AtomicUsize>,
}

impl Provider for PiiAnswerProvider {
    fn name(&self) -> &'static str {
        "primary"
    }

    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Ok(json!({
                "id": "pii",
                "object": "chat.completion",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": "write to ceo@example.com"},
                    "finish_reason": "stop"
                }],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
            }))
        })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<dyn std::future::Future<Output = Result<axum::body::Body, ProviderError>> + Send + 'a>,
    > {
        Box::pin(async { Ok(axum::body::Body::empty()) })
    }
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
    use super::run_stream;
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
    use super::run_stream;
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

#[tokio::test]
async fn run_stream_retries_a_pool_member_with_its_own_model() {
    use super::run_stream;
    use crate::config::{
        ModelMapping, ProviderPoolConfig, ProviderPoolMemberConfig, ProviderPoolStrategy,
    };

    let mut config = GatewayConfig::default();
    config.firewall.enabled = false;
    config.routing.model_map.insert(
        "balanced-chat".to_owned(),
        ModelMapping {
            provider: ProviderId::from("pool:balanced"),
            provider_model: None,
        },
    );
    config.routing.provider_pools.insert(
        "balanced".to_owned(),
        ProviderPoolConfig {
            strategy: ProviderPoolStrategy::Priority,
            sticky_limit: 1,
            wait_for_cooldown_ms: 0,
            members: vec![
                ProviderPoolMemberConfig {
                    provider: ProviderId::from("primary"),
                    model: "first-model".to_owned(),
                    priority: 0,
                    weight: 1,
                    enabled: true,
                    last_resort: false,
                    context_tokens: None,
                },
                ProviderPoolMemberConfig {
                    provider: ProviderId::from("secondary"),
                    model: "second-model".to_owned(),
                    priority: 1,
                    weight: 1,
                    enabled: true,
                    last_resort: false,
                    context_tokens: None,
                },
            ],
            execution: Default::default(),
            judge: None,
            auto_weights: None,
        },
    );
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);
    let (primary, primary_calls) = StubProvider::new("primary", Mode::RateLimited);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let out = run_stream(
        Arc::clone(&state),
        plain_ctx(),
        json!({"model":"balanced-chat","messages":[{"role":"user","content":"ping"}]}),
    )
    .await
    .expect("secondary pool member streams in the same turn");
    assert_eq!(out.provider_used, "secondary");
    assert_eq!(out.model_used, "second-model");
    assert_eq!(
        out.degraded,
        Some(DegradedMode::Fallback("secondary".to_owned()))
    );
    assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
    let bytes = axum::body::to_bytes(out.body, usize::MAX).await.unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains("[DONE]"));
}

#[tokio::test]
async fn pool_fallback_checks_the_next_members_credit_pool() {
    use crate::config::{
        ModelMapping, ProviderPoolConfig, ProviderPoolMemberConfig, ProviderPoolStrategy,
    };

    let make_state = || {
        let mut config = GatewayConfig::default();
        config.firewall.enabled = false;
        config.credits.reserve_enabled = true;
        config.credits.min_reserve_micro_usd = 10_000;
        config.routing.model_map.insert(
            "balanced-chat".to_owned(),
            ModelMapping {
                provider: ProviderId::from("pool:balanced"),
                provider_model: None,
            },
        );
        config.routing.provider_pools.insert(
            "balanced".to_owned(),
            ProviderPoolConfig {
                strategy: ProviderPoolStrategy::Priority,
                sticky_limit: 1,
                wait_for_cooldown_ms: 0,
                members: [
                    ("cloudflare", "first-model", 0),
                    ("openrouter", "second-model", 1),
                ]
                .into_iter()
                .map(|(provider, model, priority)| ProviderPoolMemberConfig {
                    provider: ProviderId::from(provider),
                    model: model.to_owned(),
                    priority,
                    weight: 1,
                    enabled: true,
                    last_resort: false,
                    context_tokens: None,
                })
                .collect(),
                execution: Default::default(),
                judge: None,
                auto_weights: None,
            },
        );
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap();
        let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
        let mut state = AppState::new_for_test(config, audit, evals);
        let (primary, primary_calls) = StubProvider::new("cloudflare", Mode::RateLimited);
        let (secondary, secondary_calls) = StubProvider::new("openrouter", Mode::Ok);
        state
            .provider_runtime
            .register_for_test(primary as Arc<dyn Provider>);
        state
            .provider_runtime
            .register_for_test(secondary as Arc<dyn Provider>);
        (Arc::new(state), primary_calls, secondary_calls)
    };
    let make_ctx = |retail_credit| {
        let mut ctx = plain_ctx();
        ctx.org_id = Some("o1".to_owned());
        ctx.managed_inference = true;
        ctx.remaining_budget_micro_usd = Some(50_000);
        ctx.unrestricted_budget_micro_usd = Some(0);
        ctx.pool_budgets_micro_usd = std::collections::HashMap::from([
            ("cloudflare".to_owned(), 50_000),
            ("openrouter".to_owned(), retail_credit),
        ]);
        ctx
    };
    let body = json!({"model":"balanced-chat","messages":[{"role":"user","content":"ping"}]});

    let (state, primary_calls, secondary_calls) = make_state();
    let output = run(state, make_ctx(50_000), body.clone())
        .await
        .expect("funded fallback should complete");
    // The secondary (retail) member served it — see the call counts; a
    // managed caller reads it as Ryu Router.
    assert_eq!(output.provider_used, "ryu");
    assert_eq!(output.model_used, "second-model");
    assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);

    let (state, primary_calls, secondary_calls) = make_state();
    let error = match run(state, make_ctx(0), body).await {
        Err(error) => error,
        Ok(_) => panic!("unfunded fallback must not dispatch"),
    };
    assert!(matches!(error, GatewayError::InsufficientCredits));
    assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 0);
}

/// Streaming exhaustion: every provider faults, so `run_stream` surfaces the
/// wrapped `AllProvidersUnavailable` error rather than an empty stream.
#[tokio::test]
async fn run_stream_exhausted_chain_errors() {
    use super::run_stream;
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

    let err = match run_stream(Arc::clone(&state), plain_ctx(), ping_body()).await {
        Err(e) => e,
        Ok(_) => panic!("an exhausted stream chain must error"),
    };
    assert!(matches!(err, GatewayError::AllProvidersUnavailable(_)));
}

/// The per-key request rate limiter gates the pipeline: with a 1-request/min
/// budget the second identical (uncached) request is refused with `RateLimited`
/// before the provider is reached.
#[tokio::test]
async fn per_key_request_rate_limit_rejects_the_second_call() {
    use crate::config::RateLimitConfig;
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        rate_limit: RateLimitConfig {
            enabled: true,
            requests_per_minute: Some(1),
            tokens_per_minute: None,
            max_burst_per_second: 0,
        },
        // Disable the exact cache so the second call actually reaches the limiter
        // rather than being served from cache.
        cache: crate::config::CacheConfig {
            enabled: false,
            ..crate::config::CacheConfig::default()
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
    let (primary, _) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let state = Arc::new(state);

    // First request is within budget.
    run(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("first request under the limit");
    // Second request exceeds 1/min ⇒ RateLimited.
    let err = match run(Arc::clone(&state), plain_ctx(), ping_body()).await {
        Err(e) => e,
        Ok(_) => panic!("second request must be rate limited"),
    };
    // The per-key refusal names the 1/min policy that refused it.
    assert!(matches!(
        err,
        GatewayError::RateLimitedBy(ref policy)
            if policy.policy == "requests" && policy.quota == 1 && policy.retry_after_secs == 60
    ));
}

/// Smart routing (Keyword strategy, no network) rewrites the request's model
/// BEFORE provider routing: a rule whose description matches the prompt sends
/// the turn to the rule's target model, which then resolves to the default
/// provider as any hand-picked model would.
#[tokio::test]
async fn smart_routing_keyword_rewrites_the_model() {
    use crate::config::{RouteStrategy, SmartRoutingConfig, SmartRule};
    let mut routing = RoutingConfig {
        default_provider: ProviderId::from("primary"),
        fallback_chain: vec![ProviderId::from("primary")],
        ..RoutingConfig::default()
    };
    routing.smart_routing = SmartRoutingConfig {
        enabled: true,
        strategy: RouteStrategy::Keyword,
        rules: vec![SmartRule {
            description: "ping".to_string(),
            model: "rewritten-model".to_string(),
            weight: 1.0,
        }],
        ..Default::default()
    };
    let config = GatewayConfig {
        routing,
        firewall: FirewallConfig {
            enabled: false,
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

    let out = run(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("smart-routed request serves");
    // The model was rewritten by the matching keyword rule.
    assert_eq!(out.model_used, "rewritten-model");
    // ...and still resolved to the default provider.
    assert_eq!(out.provider_used, "primary");
    assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
}

/// A request that captured the old provider generation may finish after a
/// one-account publication. Its cache write belongs only to the old epoch;
/// a new request must dispatch through the replacement instead of reading
/// that old result from the shared exact cache.
#[tokio::test]
async fn delayed_old_generation_completion_cannot_fill_replacement_cache() {
    let mut state = chain_state(5);
    let (old_provider, old_calls) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(old_provider as Arc<dyn Provider>);
    let old_snapshot = state.provider_runtime.snapshot();
    let (replacement, replacement_calls) = StubProvider::new("primary", Mode::Ok);
    let replacement_epoch = state
        .provider_runtime
        .publish_for_test(replacement as Arc<dyn Provider>);
    assert_ne!(old_snapshot.epoch, replacement_epoch);
    let state = Arc::new(state);

    let mut delayed_ctx = plain_ctx();
    delayed_ctx.provider_snapshot = Some(old_snapshot);
    let delayed = run(Arc::clone(&state), delayed_ctx, ping_body())
        .await
        .expect("captured old generation completes after publication");
    assert!(!delayed.cache_hit);
    assert_eq!(old_calls.load(Ordering::SeqCst), 1);

    let current = run(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("replacement generation dispatches");
    assert!(
        !current.cache_hit,
        "old epoch entry cannot satisfy new work"
    );
    assert_eq!(replacement_calls.load(Ordering::SeqCst), 1);
}

/// Outbound firewall: a provider response carrying a secret is blocked on the
/// egress path when the policy is `Block`, so the leaked secret never reaches
/// the client (`FirewallBlocked`).
#[tokio::test]
async fn outbound_firewall_block_stops_a_leaked_secret_response() {
    use crate::config::FirewallPolicy;

    // A provider that leaks a secret in its completion content.
    struct LeakyProvider;
    impl Provider for LeakyProvider {
        fn name(&self) -> &'static str {
            "primary"
        }
        fn complete<'a>(
            &'a self,
            _model: &'a str,
            _body: &'a serde_json::Value,
        ) -> Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                Ok(json!({
                    "choices": [{
                        "index": 0,
                        "message": {"role": "assistant", "content": "here is a key sk-abcdefghijklmnopqrstu"},
                        "finish_reason": "stop"
                    }],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 5, "total_tokens": 6}
                }))
            })
        }
        fn complete_stream<'a>(
            &'a self,
            _model: &'a str,
            _body: &'a serde_json::Value,
        ) -> Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<axum::body::Body, ryu_gw_providers::ProviderError>,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                Err(ryu_gw_providers::ProviderError::Provider(
                    "no stream".into(),
                ))
            })
        }
    }

    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: true,
            scan_inbound: false,
            scan_outbound: true,
            policy: FirewallPolicy::Block,
            ..FirewallConfig::default()
        },
        cache: crate::config::CacheConfig {
            enabled: false,
            ..crate::config::CacheConfig::default()
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
    state
        .provider_runtime
        .register_for_test(Arc::new(LeakyProvider) as Arc<dyn Provider>);
    let state = Arc::new(state);

    let err = match run(Arc::clone(&state), plain_ctx(), ping_body()).await {
        Err(e) => e,
        Ok(_) => panic!("a leaked-secret response must be blocked outbound"),
    };
    assert!(
        matches!(err, GatewayError::FirewallBlocked(..)),
        "expected outbound FirewallBlocked, got {err:?}"
    );
}

// ── Budget / credit enforcement (money path) ──────────────────────────────

/// Build a state whose per-user budget for `u1` is `rule`, with a healthy
/// `primary` provider registered. Returns `(state, primary_call_counter)`.
fn budget_state(rule: crate::config::BudgetRule) -> (Arc<AppState>, Arc<AtomicUsize>) {
    use std::collections::HashMap;
    let mut users = HashMap::new();
    users.insert("u1".to_string(), rule);
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        budgets: crate::config::BudgetConfig {
            users,
            ..Default::default()
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
    let (primary, calls) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let state = Arc::new(state);
    // Seed usage above the rule's limit so the very next request trips it.
    state.with_budget(|b| b.record(Some("u1"), None, 1_000_000));
    (state, calls)
}

fn u1_ctx() -> RequestContext {
    let mut ctx = plain_ctx();
    ctx.user_id = Some("u1".to_string());
    ctx
}

/// Build a state whose per-agent budget for `agent-a` is `rule`, with a
/// healthy `primary` provider registered. Returns `(state, primary_call_counter)`.
fn agent_budget_state(rule: crate::config::BudgetRule) -> (Arc<AppState>, Arc<AtomicUsize>) {
    use std::collections::HashMap;
    let mut agents = HashMap::new();
    agents.insert("agent-a".to_string(), rule);
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        budgets: crate::config::BudgetConfig {
            agents,
            ..Default::default()
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
    let (primary, calls) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let state = Arc::new(state);
    // Seed usage above the rule's limit so the very next request trips it.
    state.with_budget(|b| b.record(None, Some("agent-a"), 1_000_000));
    (state, calls)
}

#[tokio::test]
async fn scoped_inference_auth_binds_identity_and_enforces_agent_budget() {
    use crate::config::{BudgetAction, BudgetRule};
    let (state, calls) = agent_budget_state(BudgetRule {
        limit: 1_000_000,
        window: Default::default(),
        action: BudgetAction::Stop,
        downgrade_to: None,
        restrict_max_tokens: 256,
        alert: crate::config::AlertTier::Silent,
        include: crate::config::BudgetChargeInclusion::default(),
    });
    let signer = "gwcore_0123456789abcdef0123456789abcdef";
    state.update_auth_config(vec![serde_json::from_value(serde_json::json!({
        "key": signer, "name":"local-core", "trusted_forwarder":true,
    }))
    .unwrap()]);
    let token = ryu_gw_credentials::InferenceScope {
        agent_id: "agent-a".into(),
        user_id: Some("user-a".into()),
        session_id: Some("session-a".into()),
        expires_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600,
        provider_access: None,
    }
    .sign(signer)
    .unwrap();
    let bearer = format!("Bearer {token}");
    for operation in [
        crate::config::ApiKeyOperation::WebSearch,
        crate::config::ApiKeyOperation::WebFetch,
    ] {
        assert!(matches!(
            super::authenticate_for_operation(
                &state,
                super::AuthInputs::with_key(Some(&bearer)),
                operation
            )
            .await,
            Err(GatewayError::Unauthorized(_))
        ));
    }
    let context = super::authenticate(&state, super::AuthInputs::with_key(Some(&bearer)))
        .await
        .unwrap();
    assert_eq!(context.agent_id.as_deref(), Some("agent-a"));
    assert_eq!(context.user_id.as_deref(), Some("user-a"));
    assert_eq!(context.session_id.as_deref(), Some("session-a"));
    assert!(!context.is_master_key);
    assert!(!context
        .key_config
        .as_ref()
        .is_some_and(|key| key.trusted_forwarder));
    for (agent_id, user_id, session_id) in [
        (Some("agent-b"), None, None),
        (None, Some("user-b"), None),
        (None, None, Some("session-b")),
    ] {
        let mut input = super::AuthInputs::with_key(Some(&bearer));
        input.agent_id = agent_id.map(str::to_owned);
        input.user_id = user_id.map(str::to_owned);
        input.session_id = session_id.map(str::to_owned);
        assert!(matches!(
            super::authenticate(&state, input).await,
            Err(GatewayError::Unauthorized(_))
        ));
    }
    let tampered = format!("{token}0");
    assert!(matches!(
        super::authenticate(&state, super::AuthInputs::with_key(Some(&tampered))).await,
        Err(GatewayError::Unauthorized(_))
    ));
    // A scope's provider list binds the bearer; a header can only narrow it.
    let limited = ryu_gw_credentials::InferenceScope {
        agent_id: "agent-a".into(),
        user_id: None,
        session_id: None,
        expires_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600,
        provider_access: Some(vec!["anthropic".into()]),
    }
    .sign(signer)
    .unwrap();
    let limited_bearer = format!("Bearer {limited}");
    let mut input = super::AuthInputs::with_key(Some(&limited_bearer));
    input.agent_provider_access = Some("openai,anthropic".into());
    let scoped = super::authenticate(&state, input).await.unwrap();
    let access = scoped.agent_provider_access.expect("scope applies");
    assert_eq!(access.len(), 1);
    assert!(access.contains("anthropic"));
    let unscoped_header = super::authenticate(&state, {
        let mut input = super::AuthInputs::with_key(Some(&bearer));
        input.agent_provider_access = Some("none".into());
        input
    })
    .await
    .unwrap();
    assert!(unscoped_header
        .agent_provider_access
        .expect("header applies")
        .is_empty());

    let result = run(Arc::clone(&state), context, ping_body()).await;
    assert!(matches!(result, Err(GatewayError::BudgetExceeded(_))));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "scoped agent budget must stop before provider dispatch"
    );
}

#[tokio::test]
async fn scoped_inference_owner_survives_a_remint_but_not_a_scope_change() {
    let (state, _) = agent_budget_state(crate::config::BudgetRule {
        limit: 1_000_000,
        window: Default::default(),
        action: crate::config::BudgetAction::Stop,
        downgrade_to: None,
        restrict_max_tokens: 256,
        alert: crate::config::AlertTier::Silent,
        include: crate::config::BudgetChargeInclusion::default(),
    });
    let signer = "gwcore_0123456789abcdef0123456789abcdef";
    state.update_auth_config(vec![serde_json::from_value(serde_json::json!({
        "key": signer, "name":"local-core", "trusted_forwarder":true,
    }))
    .unwrap()]);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let owner_with = |agent: &str,
                      user: Option<&str>,
                      session: Option<&str>,
                      expires_at: u64,
                      provider_access: Option<&[&str]>| {
        let token = ryu_gw_credentials::InferenceScope {
            agent_id: agent.into(),
            user_id: user.map(str::to_owned),
            session_id: session.map(str::to_owned),
            expires_at,
            provider_access: provider_access
                .map(|ids| ids.iter().map(|id| (*id).to_owned()).collect()),
        }
        .sign(signer)
        .unwrap();
        let state = Arc::clone(&state);
        async move {
            let bearer = format!("Bearer {token}");
            super::authenticate(&state, super::AuthInputs::with_key(Some(&bearer)))
                .await
                .unwrap()
                .owner_binding
        }
    };
    let owner = |agent: &str, user: Option<&str>, session: Option<&str>, expires_at: u64| {
        owner_with(agent, user, session, expires_at, None)
    };
    let first = owner("agent-a", None, Some("chat-1"), now + 3600).await;
    let reminted = owner("agent-a", None, Some("chat-1"), now + 1800).await;
    assert_eq!(first, reminted, "a reminted bearer keeps its responses");
    for other in [
        owner("agent-b", None, Some("chat-1"), now + 3600).await,
        owner("agent-a", Some("user-a"), Some("chat-1"), now + 3600).await,
        owner("agent-a", None, Some("chat-2"), now + 3600).await,
        owner("agent-a", None, None, now + 3600).await,
    ] {
        assert_ne!(first, other, "distinct scopes never share responses");
    }
    // The signed provider list is part of the scope, in any order.
    let limited = owner_with(
        "agent-a",
        None,
        Some("chat-1"),
        now + 3600,
        Some(&["b", "a"]),
    )
    .await;
    let limited_reminted = owner_with(
        "agent-a",
        None,
        Some("chat-1"),
        now + 1800,
        Some(&["a", "b"]),
    )
    .await;
    assert_eq!(limited, limited_reminted);
    assert_ne!(
        first, limited,
        "a limited bearer never shares an unlimited one's responses"
    );
    let empty = owner_with("agent-a", None, Some("chat-1"), now + 3600, Some(&[])).await;
    assert_ne!(first, empty);
    assert_ne!(limited, empty);
}

fn agent_a_ctx() -> RequestContext {
    let mut ctx = plain_ctx();
    ctx.agent_id = Some("agent-a".to_string());
    ctx
}

/// A `Stop` budget rule at/over its limit rejects the request with a hard
/// `BudgetExceeded` before the provider is reached.
#[tokio::test]
async fn budget_stop_rejects_over_limit_before_dispatch() {
    use crate::config::{BudgetAction, BudgetRule};
    let (state, calls) = budget_state(BudgetRule {
        limit: 1_000_000,
        window: Default::default(),
        action: BudgetAction::Stop,
        downgrade_to: None,
        restrict_max_tokens: 256,
        alert: crate::config::AlertTier::Silent,
        include: crate::config::BudgetChargeInclusion::default(),
    });
    let err = match run(Arc::clone(&state), u1_ctx(), ping_body()).await {
        Err(e) => e,
        Ok(_) => panic!("an over-limit Stop budget must reject"),
    };
    assert!(
        matches!(err, GatewayError::BudgetExceeded(_)),
        "expected BudgetExceeded, got {err:?}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "a hard budget stop must not reach the provider"
    );
}

/// An agent-specific `Stop` budget rejects the matching agent before the
/// provider is reached.
#[tokio::test]
async fn agent_budget_stop_rejects_over_limit_before_dispatch() {
    use crate::config::{BudgetAction, BudgetRule};
    let (state, calls) = agent_budget_state(BudgetRule {
        limit: 1_000_000,
        window: Default::default(),
        action: BudgetAction::Stop,
        downgrade_to: None,
        restrict_max_tokens: 256,
        alert: crate::config::AlertTier::Silent,
        include: crate::config::BudgetChargeInclusion::default(),
    });
    let err = match run(Arc::clone(&state), agent_a_ctx(), ping_body()).await {
        Err(e) => e,
        Ok(_) => panic!("an over-limit agent Stop budget must reject"),
    };
    assert!(
        matches!(err, GatewayError::BudgetExceeded(_)),
        "expected BudgetExceeded, got {err:?}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "a hard agent budget stop must not reach the provider"
    );
}

/// A `Downgrade` rule rewrites the request's model to the cheaper target and
/// still serves the turn.
#[tokio::test]
async fn budget_downgrade_rewrites_model_and_serves() {
    use crate::config::{BudgetAction, BudgetRule};
    let (state, calls) = budget_state(BudgetRule {
        limit: 1_000_000,
        window: Default::default(),
        action: BudgetAction::Downgrade,
        downgrade_to: Some("cheap-model".to_string()),
        restrict_max_tokens: 256,
        alert: crate::config::AlertTier::Silent,
        include: crate::config::BudgetChargeInclusion::default(),
    });
    let out = run(Arc::clone(&state), u1_ctx(), ping_body())
        .await
        .expect("downgrade still serves");
    assert_eq!(out.model_used, "cheap-model", "the model was downgraded");
    assert_eq!(out.provider_used, "primary");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn an_unhealthy_spend_store_refuses_metered_requests_only() {
    use crate::config::{BudgetAction, BudgetRule};

    struct Mismatched;
    impl crate::budget::SpendStore for Mismatched {
        fn spent(&self, _: &str, _: &str, _: crate::budget::BudgetWindow, _: i64) -> u64 {
            0
        }
        fn add(&self, _: &str, _: &str, _: u64, _: i64) {}
        fn health(&self) -> Result<(), String> {
            Err(crate::budget::KEY_MISMATCH.to_owned())
        }
    }

    let mut config = GatewayConfig::default();
    config.budgets.users.insert(
        "capped".to_owned(),
        BudgetRule {
            limit: 1_000,
            window: Default::default(),
            action: BudgetAction::Stop,
            downgrade_to: None,
            restrict_max_tokens: 256,
            alert: crate::config::AlertTier::Silent,
            include: crate::config::BudgetChargeInclusion::default(),
        },
    );
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);
    state.spend_store = Arc::new(Mismatched);

    let mut capped = plain_ctx();
    capped.user_id = Some("capped".to_owned());
    match super::spend_store_gate(&state, &capped) {
        Some(GatewayError::BudgetStoreUnavailable(reason)) => {
            assert_eq!(reason, "budget store key mismatch");
        }
        other => panic!("a capped caller must be refused, got {other:?}"),
    }
    let mut uncapped = plain_ctx();
    uncapped.user_id = Some("free".to_owned());
    assert!(super::spend_store_gate(&state, &uncapped).is_none());
    capped.is_master_key = true;
    assert!(super::spend_store_gate(&state, &capped).is_none());
}

#[test]
fn a_keyless_gateway_keeps_metering_on_a_legacy_plaintext_spend_db() {
    let dir = std::env::temp_dir().join(format!(
        "ryu-gw-keyless-spend-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(crate::budget::SPEND_STORE);
    {
        // spend.db as a pre-sealing Gateway wrote it.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE spend_counters (
                     scope TEXT NOT NULL, id TEXT NOT NULL, window TEXT NOT NULL,
                     window_start INTEGER NOT NULL, amount INTEGER NOT NULL DEFAULT 0,
                     PRIMARY KEY (scope, id, window, window_start));
                 INSERT INTO spend_counters VALUES ('org', 'org-legacy', 'lifetime', 0, 70);",
        )
        .unwrap();
    }
    let store =
        crate::budget::SqliteSpendStore::open(&path, Err("no sealing key".to_owned())).unwrap();
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(GatewayConfig::default(), audit, evals);
    state.spend_store = Arc::new(store);
    assert_eq!(state.spend_store.sealing(), "no key");
    assert_eq!(
        state.spend_store.spent(
            "org",
            "org-legacy",
            crate::budget::BudgetWindow::Lifetime,
            crate::budget::unix_now()
        ),
        70
    );

    let mut tenant = plain_ctx();
    tenant.org_limits = Some(Arc::new(crate::org_limits::OrgLimitContext {
        org_id: "org-legacy".to_owned(),
        limits: Arc::new(crate::org_limits::OrgLimits::default()),
        credential_id: None,
        service_account_id: None,
        bound_user_id: None,
        team_ids: Vec::new(),
        remote_spend: None,
        active_gateways: None,
        tags: Vec::new(),
    }));
    assert!(
        super::spend_store_gate(&state, &tenant).is_none(),
        "a keyless Gateway on a never-sealed spend.db must keep serving metered traffic"
    );
    drop(state);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn budget_downgrade_reserves_against_the_final_provider_pool() {
    use crate::config::{BudgetAction, BudgetRule, ModelMapping};

    let mut config = GatewayConfig::default();
    config.routing.default_provider = ProviderId::from("cloudflare");
    config.routing.model_map.insert(
        "cheap-model".to_owned(),
        ModelMapping {
            provider: ProviderId::from("openrouter"),
            provider_model: None,
        },
    );
    config.budgets.users.insert(
        "u1".to_owned(),
        BudgetRule {
            limit: 1,
            window: Default::default(),
            action: BudgetAction::Downgrade,
            downgrade_to: Some("cheap-model".to_owned()),
            restrict_max_tokens: 256,
            alert: crate::config::AlertTier::Silent,
            include: crate::config::BudgetChargeInclusion::default(),
        },
    );
    config.credits.reserve_enabled = true;
    config.credits.min_reserve_micro_usd = 10_000;
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let state = AppState::new_for_test(config, audit, evals);
    state.with_budget(|budgets| budgets.record(Some("u1"), None, 1));

    let mut ctx = plain_ctx();
    ctx.org_id = Some("o1".to_owned());
    ctx.managed_inference = true;
    ctx.remaining_budget_micro_usd = Some(50_000);
    ctx.user_id = Some("u1".to_owned());
    ctx.unrestricted_budget_micro_usd = Some(0);
    ctx.pool_budgets_micro_usd =
        std::collections::HashMap::from([("openrouter".to_owned(), 50_000)]);
    let mut body = json!({ "model": "primary-model", "messages": [] });
    let mut decision = RouteDecision {
        provider: ProviderId::from("cloudflare"),
        model: "primary-model".to_owned(),
    };
    let admitted = enforce_budget(
        &state,
        &ctx,
        &mut body,
        &mut decision,
        BudgetChargeKind::Model,
        OutputCeiling::Clamp,
    )
    .expect("funded downgrade pool should admit the final route");
    assert_eq!(decision.provider.as_str(), "openrouter");
    assert_eq!(decision.model, "cheap-model");
    assert!(admitted.reservation.is_some());
    drop(admitted);

    ctx.pool_budgets_micro_usd =
        std::collections::HashMap::from([("cloudflare".to_owned(), 50_000)]);
    let mut body = json!({ "model": "primary-model", "messages": [] });
    let mut decision = RouteDecision {
        provider: ProviderId::from("cloudflare"),
        model: "primary-model".to_owned(),
    };
    assert!(matches!(
        enforce_budget(
            &state,
            &ctx,
            &mut body,
            &mut decision,
            BudgetChargeKind::Model,
            OutputCeiling::Clamp,
        ),
        Err(GatewayError::InsufficientCredits)
    ));
    assert_eq!(decision.provider.as_str(), "openrouter");
}

#[test]
fn concurrent_requests_count_each_others_budget_claims() {
    use crate::config::{BudgetAction, BudgetRule};

    let mut config = GatewayConfig::default();
    config.budgets.users.insert(
        "u1".to_owned(),
        BudgetRule {
            limit: 1_000_000,
            window: Default::default(),
            action: BudgetAction::Stop,
            downgrade_to: None,
            restrict_max_tokens: 256,
            alert: crate::config::AlertTier::Silent,
            include: crate::config::BudgetChargeInclusion::default(),
        },
    );
    config.credits.min_reserve_micro_usd = 10_000;
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let state = AppState::new_for_test(config, audit, evals);
    // $0.995 of a $1 Stop cap is already recorded.
    state.with_budget(|budgets| budgets.record(Some("u1"), None, 995_000));

    let mut ctx = plain_ctx();
    ctx.user_id = Some("u1".to_owned());
    let admit = || {
        let mut body = json!({ "model": "primary-model", "messages": [] });
        let mut decision = RouteDecision {
            provider: ProviderId::from("openai"),
            model: "primary-model".to_owned(),
        };
        enforce_budget(
            &state,
            &ctx,
            &mut body,
            &mut decision,
            BudgetChargeKind::Model,
            OutputCeiling::Clamp,
        )
    };

    let first = admit().expect("a lone request below the cap is admitted");
    assert!(first.budget_hold.is_some());
    // While the first runs, its estimate fills the remaining headroom.
    assert!(matches!(admit(), Err(GatewayError::BudgetExceeded(_))));
    drop(first);
    assert!(admit().is_ok(), "a finished request frees its claim");
}

/// A `Restrict` rule serves the turn but stamps the Restrict decision on the
/// output (the request path strips tools + caps max_tokens).
#[tokio::test]
async fn budget_restrict_serves_with_a_restrict_decision() {
    use crate::config::{BudgetAction, BudgetRule};
    let (state, _calls) = budget_state(BudgetRule {
        limit: 1_000_000,
        window: Default::default(),
        action: BudgetAction::Restrict,
        downgrade_to: None,
        restrict_max_tokens: 128,
        alert: crate::config::AlertTier::Silent,
        include: crate::config::BudgetChargeInclusion::default(),
    });
    let out = run(Arc::clone(&state), u1_ctx(), ping_body())
        .await
        .expect("restrict still serves a minimal answer");
    let budget = out.budget.expect("a budget decision is stamped");
    assert_eq!(budget.action, BudgetAction::Restrict);
}

#[tokio::test]
async fn budget_restrict_blocks_hints_search_and_unsolicited_dispatch_in_both_paths() {
    use crate::config::{BudgetAction, BudgetRule, CoreProviderConfig};
    let catalog_calls = Arc::new(AtomicUsize::new(0));
    let calls = Arc::clone(&catalog_calls);
    let app = axum::Router::new().fallback(move || {
        let calls = Arc::clone(&calls);
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            axum::Json(json!({}))
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    for stream in [false, true] {
        let (mut state, _) = budget_state(BudgetRule {
            limit: 1_000_000,
            window: Default::default(),
            action: BudgetAction::Restrict,
            downgrade_to: None,
            restrict_max_tokens: 128,
            alert: crate::config::AlertTier::Silent,
            include: crate::config::BudgetChargeInclusion::default(),
        });
        let state_mut = Arc::get_mut(&mut state).unwrap();
        state_mut.tools = Some(crate::tools::ToolSearchClient::new(
            &CoreProviderConfig {
                base_url: base_url.clone(),
                token: None,
            },
            state_mut.http.clone(),
        ));
        let (provider, provider_calls) = StubProvider::new("primary", Mode::RestrictedToolCalls);
        state_mut
            .provider_runtime
            .register_for_test(provider as Arc<dyn Provider>);
        let mut ctx = u1_ctx();
        ctx.tools_header_present = true;
        ctx.tool_search_requested = true;
        ctx.capability_hints =
            Some(r#"{"tools":["composio.GMAIL_SEARCH_EMAILS"],"skills":["mail"]}"#.into());
        let mut body = ping_body();
        body["max_tokens"] = json!(4096);
        body["tools"] = json!([{"type":"function","function":{"name":"skills.load"}}]);
        body["tool_choice"] = json!("required");
        if stream {
            let out = super::run_stream(state, ctx, body).await.unwrap();
            let bytes = axum::body::to_bytes(out.body, usize::MAX).await.unwrap();
            assert!(String::from_utf8_lossy(&bytes).contains("pong"));
        } else {
            let out = run(state, ctx, body).await.unwrap();
            assert_eq!(out.budget.unwrap().action, BudgetAction::Restrict);
        }
        assert_eq!(
            provider_calls.load(Ordering::SeqCst),
            1,
            "restricted turns never enter a tool round"
        );
        assert_eq!(
            catalog_calls.load(Ordering::SeqCst),
            0,
            "no describe, search, skill load or execution reaches Core"
        );
    }
    server.abort();
}

/// A `Notify` rule is non-blocking: it serves the turn and stamps the Notify
/// decision without altering the model.
#[tokio::test]
async fn budget_notify_is_non_blocking() {
    use crate::config::{BudgetAction, BudgetRule};
    let (state, calls) = budget_state(BudgetRule {
        limit: 1_000_000,
        window: Default::default(),
        action: BudgetAction::Notify,
        downgrade_to: None,
        restrict_max_tokens: 256,
        alert: crate::config::AlertTier::Silent,
        include: crate::config::BudgetChargeInclusion::default(),
    });
    let out = run(Arc::clone(&state), u1_ctx(), ping_body())
        .await
        .expect("notify never blocks");
    assert_eq!(out.budget.expect("decision").action, BudgetAction::Notify);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

/// The pre-flight credit gate: a managed-inference tenant whose resolved wallet
/// balance is already zero is rejected with a hard `InsufficientCredits` (402)
/// before any provider is reached.
#[tokio::test]
async fn preflight_credit_gate_rejects_exhausted_managed_tenant() {
    let mut state = chain_state(5);
    let (primary, calls) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let mut ctx = plain_ctx();
    ctx.org_id = Some("org-managed".to_string());
    ctx.managed_inference = true;
    ctx.remaining_budget_micro_usd = Some(0);

    let err = match run(Arc::clone(&state), ctx, ping_body()).await {
        Err(e) => e,
        Ok(_) => panic!("an exhausted managed wallet must be rejected pre-flight"),
    };
    assert!(
        matches!(err, GatewayError::InsufficientCredits),
        "expected InsufficientCredits, got {err:?}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "the credit gate must short-circuit before dispatch"
    );
}

/// The streaming outbound firewall (Block policy) buffers the upstream SSE,
/// scans the assembled text, and emits a blocked frame instead of the leaked
/// secret — so a secret never streams to the client.
#[tokio::test]
async fn run_stream_outbound_firewall_block_redacts_leaked_secret() {
    use super::run_stream;
    use crate::config::FirewallPolicy;

    struct LeakyStream;
    impl Provider for LeakyStream {
        fn name(&self) -> &'static str {
            "primary"
        }
        fn complete<'a>(
            &'a self,
            _model: &'a str,
            _body: &'a serde_json::Value,
        ) -> Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move { Err(ryu_gw_providers::ProviderError::Provider("n/a".into())) })
        }
        fn complete_stream<'a>(
            &'a self,
            _model: &'a str,
            _body: &'a serde_json::Value,
        ) -> Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<axum::body::Body, ryu_gw_providers::ProviderError>,
                    > + Send
                    + 'a,
            >,
        > {
            let sse = concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"key sk-abcdefghijklmnopqrstu\"}}]}\n\n",
                "data: [DONE]\n\n",
            );
            Box::pin(async move { Ok(axum::body::Body::from(sse)) })
        }
    }

    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: true,
            scan_inbound: false,
            scan_outbound: true,
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
    state
        .provider_runtime
        .register_for_test(Arc::new(LeakyStream) as Arc<dyn Provider>);
    let state = Arc::new(state);

    let out = run_stream(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("stream is served (as a blocked frame)");
    let bytes = axum::body::to_bytes(out.body, usize::MAX)
        .await
        .expect("drain sse body");
    let text = String::from_utf8_lossy(&bytes);
    assert!(
        !text.contains("sk-abcdefghijklmnopqrstu"),
        "the outbound firewall must not let the secret stream through: {text}"
    );
}

/// Build a state with the firewall on at `policy` (+ optional alert tier) and a
/// healthy `primary` provider. Exact cache disabled so each run re-scans.
fn firewall_state(
    policy: crate::config::FirewallPolicy,
    alert: crate::config::AlertTier,
) -> (Arc<AppState>, Arc<AtomicUsize>) {
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
            policy,
            alert,
            ..FirewallConfig::default()
        },
        cache: crate::config::CacheConfig {
            enabled: false,
            ..crate::config::CacheConfig::default()
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
    let (primary, calls) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    (Arc::new(state), calls)
}

fn secret_body() -> serde_json::Value {
    json!({
        "model": "anything",
        "messages": [{
            "role": "user",
            "content": "Contact user@example.com or use key sk-abcdefghijklmnopqrstu"
        }]
    })
}

/// A `Sanitize` inbound policy redacts the offending content in place and still
/// serves the turn (never blocks).
#[tokio::test]
async fn inbound_firewall_sanitize_serves_the_request() {
    use crate::config::{AlertTier, FirewallPolicy};
    let (state, calls) = firewall_state(FirewallPolicy::Sanitize, AlertTier::Silent);
    let out = run(Arc::clone(&state), plain_ctx(), secret_body())
        .await
        .expect("sanitize never blocks");
    assert_eq!(out.provider_used, "primary");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "the sanitized request still reaches the provider"
    );
}

/// Sanitize must not make the provider-bound prefix depend on whether the
/// newest turn tripped the firewall: tools and earlier turns egress in the
/// same form on a clean turn and on a flagged one, so the provider's prompt
/// cache keeps hitting.
#[tokio::test]
async fn inbound_sanitize_keeps_the_cached_prompt_prefix_stable() {
    use crate::config::{AlertTier, FirewallPolicy};
    let (state, _) = firewall_state(FirewallPolicy::Sanitize, AlertTier::Silent);
    let tools = json!([{ "type": "function", "function": {
        "name": "notify",
        "description": "Send mail, e.g. to jane@example.com",
        "parameters": { "type": "object" }
    } }]);
    let history = json!([
        { "role": "system", "content": "You are helpful." },
        { "role": "user", "content": "hello" },
        { "role": "assistant", "content": "hi there" }
    ]);
    let mut clean = json!({ "model": "anything", "messages": history, "tools": tools });
    clean["messages"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "role": "user", "content": "what's new?" }));
    let mut flagged = json!({ "model": "anything", "messages": history, "tools": tools });
    flagged["messages"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "role": "user", "content": "use key sk-abcdefghijklmnopqrstu" }));

    let ctx = plain_ctx();
    super::pre_process(&state, &ctx, &mut clean)
        .await
        .expect("clean turn");
    super::pre_process(&state, &ctx, &mut flagged)
        .await
        .expect("sanitized turn");

    assert_eq!(
        clean["tools"], flagged["tools"],
        "tools must egress identically"
    );
    assert!(
        !clean["tools"].to_string().contains("jane@example.com"),
        "{}",
        clean["tools"]
    );
    for turn in 0..3 {
        assert_eq!(clean["messages"][turn], flagged["messages"][turn]);
    }
    assert!(!flagged["messages"][3]["content"]
        .as_str()
        .unwrap()
        .contains("sk-abcdefghijklmnopqrstu"));
}

/// A gateway whose firewall is `firewall` and whose pipeline omits the
/// `disabled` stages, with one stub provider registered.
fn sanitize_posture_state(
    firewall: crate::config::FirewallConfig,
    disabled: &[PipelineStage],
) -> Arc<AppState> {
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall,
        pipeline: stages::PipelineOrderConfig {
            order: Vec::new(),
            disabled: disabled.to_vec(),
        },
        cache: crate::config::CacheConfig {
            enabled: false,
            ..crate::config::CacheConfig::default()
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
    let (primary, _) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    Arc::new(state)
}

/// A firewall that is on but does not itself redact (`WarnAndContinue`), so
/// only the inspector or an inline evaluator can put the gateway in a Sanitize
/// posture. The inspector skips every turn (`min_chars`), so it never needs a
/// model.
fn warn_only_firewall() -> crate::config::FirewallConfig {
    crate::config::FirewallConfig {
        enabled: true,
        scan_inbound: true,
        scan_outbound: false,
        policy: crate::config::FirewallPolicy::WarnAndContinue,
        alert: crate::config::AlertTier::Silent,
        inspector: crate::config::InspectorConfig {
            enabled: false,
            min_chars: usize::MAX,
            action: crate::config::FirewallPolicy::Sanitize,
            ..crate::config::InspectorConfig::default()
        },
        ..crate::config::FirewallConfig::default()
    }
}

fn sanitize_input_binding(enabled: bool) -> crate::evaluators::EvaluatorBinding {
    crate::evaluators::EvaluatorBinding {
        // An inline INPUT evaluator whose catalog default is Block, so only
        // the binding's own Sanitize action can make it a Sanitize posture.
        id: "code_injection".to_owned(),
        enabled,
        inline_action: Some(crate::config::FirewallPolicy::Sanitize),
        offline: None,
        locked: false,
    }
}

/// Tools and an earlier turn that carry PII the newest turn does not.
fn pii_in_prefix_body() -> serde_json::Value {
    json!({
        "model": "anything",
        "messages": [
            { "role": "user", "content": "mail jane@example.com about it" },
            { "role": "assistant", "content": "ok" },
            { "role": "user", "content": "what's new?" }
        ],
        "tools": [{ "type": "function", "function": {
            "name": "notify",
            "description": "Send mail, e.g. to jane@example.com",
            "parameters": { "type": "object" }
        } }]
    })
}

/// The inspector and inline-evaluator branches of the prefix-stabilizing
/// redaction: each configured Sanitize stage redacts every request, not only
/// the ones it flags, and only while its pipeline stage is present.
#[tokio::test]
async fn sanitize_posture_covers_the_inspector_and_inline_evaluator_branches() {
    use crate::config::{FirewallPolicy, InspectorConfig};
    let redacted = |body: &serde_json::Value| !body.to_string().contains("jane@example.com");
    let untouched = |body: &serde_json::Value| *body == pii_in_prefix_body();
    let ctx = plain_ctx();

    // Inspector under Sanitize, with the firewall itself only warning.
    let mut inspector = warn_only_firewall();
    inspector.inspector.enabled = true;
    let state = sanitize_posture_state(inspector.clone(), &[]);
    let mut body = pii_in_prefix_body();
    super::pre_process(&state, &ctx, &mut body)
        .await
        .expect("an unflagged turn is served");
    assert!(redacted(&body), "inspector Sanitize redacts: {body}");

    // Control: inspector disabled.
    let state = sanitize_posture_state(warn_only_firewall(), &[]);
    let mut body = pii_in_prefix_body();
    super::pre_process(&state, &ctx, &mut body).await.unwrap();
    assert!(untouched(&body), "no Sanitize posture: {body}");

    // Control: inspector Sanitize but the stage is not in the pipeline.
    let state = sanitize_posture_state(inspector.clone(), &[PipelineStage::Inspector]);
    let mut body = pii_in_prefix_body();
    super::pre_process(&state, &ctx, &mut body).await.unwrap();
    assert!(untouched(&body), "Inspector stage absent: {body}");

    // Control: inspector enabled but its action is not Sanitize.
    let mut warn_inspector = inspector.clone();
    warn_inspector.inspector = InspectorConfig {
        action: FirewallPolicy::WarnAndContinue,
        ..warn_inspector.inspector
    };
    let state = sanitize_posture_state(warn_inspector, &[]);
    let mut body = pii_in_prefix_body();
    super::pre_process(&state, &ctx, &mut body).await.unwrap();
    assert!(untouched(&body), "inspector action is not Sanitize: {body}");

    // Inline input evaluator resolving to Sanitize.
    let mut inline = warn_only_firewall();
    inline.evaluators = vec![sanitize_input_binding(true)];
    let state = sanitize_posture_state(inline.clone(), &[]);
    let mut body = pii_in_prefix_body();
    super::pre_process(&state, &ctx, &mut body)
        .await
        .expect("an unflagged turn is served");
    assert!(redacted(&body), "inline Sanitize redacts: {body}");

    // Control: the binding is disabled.
    let mut disabled = warn_only_firewall();
    disabled.evaluators = vec![sanitize_input_binding(false)];
    let state = sanitize_posture_state(disabled, &[]);
    let mut body = pii_in_prefix_body();
    super::pre_process(&state, &ctx, &mut body).await.unwrap();
    assert!(untouched(&body), "disabled binding: {body}");

    // Control: the InlineInput stage is not in the pipeline.
    let state = sanitize_posture_state(inline.clone(), &[PipelineStage::InlineInput]);
    let mut body = pii_in_prefix_body();
    super::pre_process(&state, &ctx, &mut body).await.unwrap();
    assert!(untouched(&body), "InlineInput stage absent: {body}");

    // Control: the binding keeps the catalog's own Block action.
    let mut blocking = warn_only_firewall();
    let mut binding = sanitize_input_binding(true);
    binding.inline_action = None;
    blocking.evaluators = vec![binding];
    let state = sanitize_posture_state(blocking, &[]);
    let mut body = pii_in_prefix_body();
    super::pre_process(&state, &ctx, &mut body).await.unwrap();
    assert!(untouched(&body), "a Block-action binding: {body}");
}

/// Without a Sanitize posture nothing is rewritten: an unflagged definition
/// egresses exactly as the client sent it.
#[tokio::test]
async fn inbound_block_policy_leaves_unflagged_definitions_untouched() {
    use crate::config::{AlertTier, FirewallPolicy};
    let (state, _) = firewall_state(FirewallPolicy::Block, AlertTier::Silent);
    let mut body = json!({
        "model": "anything",
        "messages": [{ "role": "user", "content": "hi" }],
        "tools": [{ "type": "function", "function": {
            "name": "notify",
            "description": "Send mail, e.g. to jane@example.com",
            "parameters": { "type": "object" }
        } }]
    });
    let original = body["tools"].clone();
    super::pre_process(&state, &plain_ctx(), &mut body)
        .await
        .expect("allowed");
    assert_eq!(body["tools"], original);
}

/// Under `Block`, a secret or injection placed outside `messages[].content`
/// (tool-call arguments, a tool definition, predicted output) is still scanned
/// and the request never reaches the provider.
#[tokio::test]
async fn inbound_firewall_block_scans_tool_arguments_definitions_and_prediction() {
    use crate::config::{AlertTier, FirewallPolicy};
    let smuggled = [
        json!({
            "model": "anything",
            "messages": [
                { "role": "user", "content": "hi" },
                { "role": "assistant", "content": null, "tool_calls": [{
                    "id": "call_1", "type": "function",
                    "function": { "name": "f", "arguments": "{\"k\":\"AKIAIOSFODNN7EXAMPLE\"}" }
                }] },
                { "role": "tool", "tool_call_id": "call_1", "content": "done" }
            ]
        }),
        json!({
            "model": "anything",
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [{ "type": "function", "function": {
                "name": "f",
                "description": "Deploy with key AKIAIOSFODNN7EXAMPLE",
                "parameters": { "type": "object" }
            } }]
        }),
        json!({
            "model": "anything",
            "messages": [{ "role": "user", "content": "hi" }],
            "prediction": { "type": "content", "content": "key sk-abcdefghijklmnopqrstu" }
        }),
    ];
    for body in smuggled {
        let (state, calls) = firewall_state(FirewallPolicy::Block, AlertTier::Silent);
        let err = match run(Arc::clone(&state), plain_ctx(), body.clone()).await {
            Err(err) => err,
            Ok(_) => panic!("smuggled content must be blocked: {body}"),
        };
        assert!(
            matches!(err, GatewayError::FirewallBlocked(..)),
            "expected FirewallBlocked for {body}, got {err:?}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0, "{body}");
    }
}

/// Tool definitions are developer-authored schemas: ordinary wording that the
/// prompt-injection patterns match, and example contact data the PII patterns
/// match, must not refuse every request from the agent under the default
/// Block posture. A secret in a definition is still caught (see the smuggling
/// test above).
#[tokio::test]
async fn inbound_firewall_does_not_block_injection_phrasing_in_tool_definitions() {
    use crate::config::{AlertTier, FirewallPolicy};
    let body = json!({
        "model": "anything",
        "messages": [{ "role": "user", "content": "list the lint failures" }],
        "tools": [
            { "type": "function", "function": {
                "name": "grep",
                "description": "Search files for a pattern",
                "parameters": { "type": "object", "properties": {
                    "ignore_case": {
                        "type": "boolean",
                        "description": "Whether to ignore case when matching rules"
                    }
                } }
            } },
            { "type": "function", "function": {
                "name": "Bash",
                "description": "Set dangerouslyDisableSandbox to override sandbox mode and run commands"
            } },
            { "type": "function", "function": {
                "name": "send_mail",
                "description": "Send an email, e.g. to jane@example.com or +1 415 555 0100"
            } }
        ]
    });
    assert!(
        extract_definition_text(&body).contains("ignore case when matching rules"),
        "the definition text still reaches the DLP screen"
    );
    let (state, calls) = firewall_state(FirewallPolicy::Block, AlertTier::Silent);
    run(Arc::clone(&state), plain_ctx(), body)
        .await
        .expect("schema wording is not a prompt injection");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

/// Locked guardrails read tool definitions for secrets and PII only: locked
/// prompt- and code-injection guardrails would otherwise refuse every turn
/// of an agent whose schemas use ordinary imperative or shell wording, while
/// a secret in a definition is still refused with the local firewall off.
#[tokio::test]
async fn locked_guardrails_screen_tool_definitions_for_secrets_and_pii_only() {
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        cache: crate::config::CacheConfig {
            enabled: false,
            ..crate::config::CacheConfig::default()
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
    let (primary, calls) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let state = Arc::new(state);
    let mut ctx = plain_ctx();
    ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
        locked_guardrails: vec![
            "prompt_injection".to_owned(),
            "code_injection".to_owned(),
            "secrets".to_owned(),
        ],
        ..crate::policy::EffectivePolicy::default()
    });
    let with_definition = |description: &str| {
        json!({
            "model": "anything",
            "messages": [{ "role": "user", "content": "commit the fix" }],
            "tools": [{ "type": "function", "function": {
                "name": "Bash",
                "description": description,
                "parameters": { "type": "object" }
            } }]
        })
    };

    run(
        Arc::clone(&state),
        ctx.clone(),
        with_definition(
            "Use dangerouslyDisableSandbox to override sandbox mode and run commands. \
             Commit with git commit -m \"$(cat <<'EOF' ... EOF)\"",
        ),
    )
    .await
    .expect("agent-authored schema wording is not a locked-guardrail violation");
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let err = match run(
        Arc::clone(&state),
        ctx,
        with_definition("Deploy with key AKIAIOSFODNN7EXAMPLE"),
    )
    .await
    {
        Err(err) => err,
        Ok(_) => panic!("a secret in a tool definition must violate the locked guardrail"),
    };
    assert!(
        matches!(err, GatewayError::PolicyViolation(_)),
        "expected a locked-guardrail refusal, got {err:?}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "the provider was not called"
    );
}

/// A `WarnAndContinue` inbound policy at a `Warn` alert tier serves the turn and
/// stamps a firewall policy alert on the response (observable, non-blocking).
#[tokio::test]
async fn inbound_firewall_warn_stamps_alert_and_serves() {
    use crate::config::{AlertTier, FirewallPolicy};
    let (state, calls) = firewall_state(FirewallPolicy::WarnAndContinue, AlertTier::Warn);
    let out = run(Arc::clone(&state), plain_ctx(), secret_body())
        .await
        .expect("warn-and-continue never blocks");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(
        out.policy_alert.is_some(),
        "a warn-tier firewall match must stamp a policy alert on the response"
    );
}
