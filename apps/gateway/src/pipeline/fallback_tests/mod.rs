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

mod support;
use support::*;
mod part1;
mod part2;
mod part3;
mod part4;
mod part5;
mod part6;
mod part7;
mod part8;

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

// ── own-supply routing, end to end through `run()` / `run_stream()` ──────

// ── node routing preferences, end to end through `run()` ─────────────────

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

// ── Budget / credit enforcement (money path) ──────────────────────────────
