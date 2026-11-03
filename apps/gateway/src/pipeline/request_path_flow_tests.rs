//! Flow tests for the request paths split out of `pipeline/mod.rs`: the
//! stage loop, the buffered and streamed chat attempts, embeddings and the
//! media answer, driven against a scripted provider.

use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use serde_json::{json, Value};

use super::test_support::plain_request_context;
use super::*;
use crate::config::{
    AuditConfig, EvalsConfig, FirewallConfig, GatewayConfig, ProviderId, RoutingConfig,
};
use crate::error::GatewayError;
use crate::providers::Provider;
use crate::router::RouteDecision;
use crate::state::AppState;
use ryu_gw_providers::ProviderError;

type Reply<'a, T> =
    Pin<Box<dyn std::future::Future<Output = Result<T, ProviderError>> + Send + 'a>>;

struct Scripted {
    id: &'static str,
    fail: bool,
    calls: AtomicUsize,
}

impl Provider for Scripted {
    fn name(&self) -> &'static str {
        self.id
    }

    fn complete<'a>(&'a self, _model: &'a str, _body: &'a Value) -> Reply<'a, Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let (id, fail) = (self.id, self.fail);
        Box::pin(async move {
            if fail {
                return Err(ProviderError::Provider(format!("{id} boom")));
            }
            Ok(json!({
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "pong"},
                    "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                "data": [{"embedding": [0.1, 0.2], "index": 0, "url": "https://example.test/a.png"}]
            }))
        })
    }

    fn embed<'a>(&'a self, model: &'a str, body: &'a Value) -> Reply<'a, Value> {
        self.complete(model, body)
    }

    fn complete_stream<'a>(&'a self, _model: &'a str, _body: &'a Value) -> Reply<'a, Body> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let (id, fail) = (self.id, self.fail);
        Box::pin(async move {
            if fail {
                return Err(ProviderError::Provider(format!("{id} stream boom")));
            }
            Ok(Body::from(concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"pong\"}}]}\n\n",
                "data: [DONE]\n\n",
            )))
        })
    }
}

/// A state routing `primary` then `secondary`, firewall off, with `primary`
/// failing when `primary_fails`.
fn chain(primary_fails: bool) -> (Arc<AppState>, Arc<Scripted>, Arc<Scripted>) {
    chain_with(primary_fails, false)
}

fn chain_with(
    primary_fails: bool,
    secondary_fails: bool,
) -> (Arc<AppState>, Arc<Scripted>, Arc<Scripted>) {
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
        ..GatewayConfig::default()
    };
    let audit = crate::audit::AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);
    let scripted = |id, fail| {
        Arc::new(Scripted {
            id,
            fail,
            calls: AtomicUsize::new(0),
        })
    };
    let (primary, secondary) = (
        scripted("primary", primary_fails),
        scripted("secondary", secondary_fails),
    );
    state
        .provider_runtime
        .register_for_test(primary.clone() as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary.clone() as Arc<dyn Provider>);
    (Arc::new(state), primary, secondary)
}

fn chat_body() -> Value {
    json!({"model": "stub-model", "messages": [{"role": "user", "content": "ping"}]})
}

fn decision(provider: &str) -> RouteDecision {
    RouteDecision {
        provider: ProviderId::from(provider),
        model: "stub-model".into(),
    }
}

async fn text_of(body: Body) -> String {
    let bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .expect("a body");
    String::from_utf8(bytes.to_vec()).expect("utf-8")
}

#[tokio::test]
async fn the_stage_loop_routes_and_a_disabled_inspector_leaves_the_turn_alone() {
    let (state, _, _) = chain(false);
    let ctx = plain_request_context();
    let mut body = chat_body();
    let (routed, cache_key, _, pool) = pre_process::pre_process(&state, &ctx, &mut body)
        .await
        .expect("admitted");
    assert_eq!(routed.provider, ProviderId::from("primary"));
    assert!(!cache_key.is_empty() && pool.is_none());

    let scanner = state.resolved_scanner(&ctx);
    let before = body.clone();
    inbound_inspector::inspector_stage(&state, &ctx, &mut body, &scanner)
        .await
        .expect("a disabled inspector is a no-op");
    assert_eq!(body, before);
}

#[tokio::test]
async fn a_buffered_chat_falls_back_past_a_failed_primary() {
    let (state, primary, secondary) = chain(true);
    let output = chat_buffered::run_attached(state, plain_request_context(), chat_body(), None)
        .await
        .expect("the secondary answers");
    assert_eq!(output.provider_used, "secondary");
    assert_eq!(
        output.degraded,
        Some(DegradedMode::Fallback("secondary".into()))
    );
    assert_eq!(output.response["choices"][0]["message"]["content"], "pong");
    assert_eq!(primary.calls.load(Ordering::SeqCst), 1);
    assert_eq!(secondary.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_caller_gone_before_dispatch_never_reaches_the_provider() {
    let (state, primary, _) = chain(false);
    let ctx = plain_request_context();
    let provider: Arc<dyn Provider> = primary.clone();
    let caller = tokio_util::sync::CancellationToken::new();
    caller.cancel();
    let ledger = Some(Arc::new(tool_rounds::ToolRoundLedger::default()));
    let mut claim = None;
    let routed = decision("primary");
    let outcome = chat_buffered_dispatch::dispatch_buffered(
        chat_buffered_dispatch::BufferedDispatch {
            state: &state,
            ctx: &ctx,
            provider: &provider,
            decision: &routed,
            loop_kind: ToolLoopKind::Plain,
            tools_restricted: false,
            round_ledger: &ledger,
            caller: Some(&caller),
            execution_ceiling: None,
            attempt_index: 0,
            budget: &None,
            start: std::time::Instant::now(),
        },
        &mut chat_body(),
        &mut claim,
    )
    .await;
    assert!(matches!(outcome, Err(GatewayError::Internal(_))));
    assert_eq!(primary.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_pool_final_answer_over_its_byte_limit_is_refused() {
    let (state, primary, _) = chain(false);
    let provider: Arc<dyn Provider> = primary;
    let routed = decision("primary");
    let route = routing::bind_route(&state, &plain_request_context(), &routed).expect("bound");
    let attempt = ChatAttemptRoute {
        decision: routed.clone(),
        pool: None,
    };
    let body = chat_body();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    let answer = chat_buffered_answer::BufferedAnswer {
        state: &state,
        ctx: plain_request_context(),
        attempt_index: 0,
        attempt: &attempt,
        route: &route,
        provider: &provider,
        decision: routed,
        body: &body,
        pool_base_body: &body,
        round_ledger: &None,
        execution_ceiling: Some((deadline, 1)),
        budget: None,
        credit_reservation: None,
        start: std::time::Instant::now(),
        admission: crate::concurrency::AdmissionPermit::none(),
        primary_skipped: false,
        prompt_cache_outcome: ryu_gw_providers::PromptCacheOutcome::Disabled,
        policy_alert: None,
        cache: ChatCache {
            allowed: false,
            origin: (ProviderId::from("primary"), "stub-model".into()),
            key: String::new(),
            semantic_scope: String::new(),
            semantic_embedding: None,
        },
    };
    let response = json!({"choices": [{"message": {"role": "assistant", "content": "too long"}}]});
    let refused = chat_buffered_answer::finish_buffered_answer(answer, response, 0).await;
    assert!(matches!(refused, Err(GatewayError::ProviderError(_))));
}

#[tokio::test]
async fn a_streamed_chat_falls_back_and_streams_the_answer() {
    let (state, _, secondary) = chain(true);
    let output = chat_stream::run_stream_unaliased(state, plain_request_context(), chat_body())
        .await
        .expect("the secondary streams");
    assert_eq!(output.provider_used, "secondary");
    assert_eq!(
        output.degraded,
        Some(DegradedMode::Fallback("secondary".into()))
    );
    assert!(text_of(output.body).await.contains("pong"));
    assert_eq!(secondary.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn stream_attempts_exhaust_into_the_typed_error() {
    let (state, primary, secondary) = chain_with(true, true);
    let chat = chat_stream::StreamChat {
        state,
        ctx: plain_request_context(),
        body: chat_body(),
        decision: decision("primary"),
        requested_model: "stub-model".into(),
        start: std::time::Instant::now(),
        settles_after_hang_up: false,
        sampling_extensions: SamplingExtensions::take(&mut chat_body()),
        pool_route: None,
        execution_ceiling: None,
        original_max_tokens: None,
        original_max_completion_tokens: None,
        budget: None,
        credit_reservation: None,
        budget_hold: None,
        policy_alert: None,
        estimated_tokens: 1,
        tools_restricted: false,
        tools_active: false,
    };
    let error = match chat_stream_attempts::run_stream_attempts(chat).await {
        Err(error) => error,
        Ok(_) => panic!("the only member failed"),
    };
    assert!(matches!(error, GatewayError::AllProvidersUnavailable(_)));
    assert_eq!(primary.calls.load(Ordering::SeqCst), 1);
    assert_eq!(secondary.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn opening_a_plain_upstream_returns_the_provider_stream() {
    let (state, primary, _) = chain(false);
    let provider: Arc<dyn Provider> = primary;
    let ctx = plain_request_context();
    let routed = decision("primary");
    let opened = chat_stream_answer::open_upstream(
        chat_stream_answer::UpstreamOpen {
            state: &state,
            ctx: &ctx,
            provider: &provider,
            decision: &routed,
            tools_active: false,
            tools_restricted: false,
            round_ledger: &None,
            detached_open: &None,
            settles_after_hang_up: false,
        },
        &mut chat_body(),
    )
    .await
    .expect("opened");
    assert!(text_of(opened).await.contains("[DONE]"));
}

#[tokio::test]
async fn embeddings_fall_back_past_a_failed_primary() {
    let (state, _, _) = chain(true);
    let body = json!({"model": "stub-model", "input": "hello"});
    let output = embedding::run_embedding_attached(
        state,
        plain_request_context(),
        body,
        EmbeddingOperation::Embed,
    )
    .await
    .expect("the secondary embeds");
    assert_eq!(output.provider_used, "secondary");
    assert_eq!(
        output.degraded,
        Some(DegradedMode::Fallback("secondary".into()))
    );
}

#[tokio::test]
async fn a_media_answer_reports_the_fallback_it_was_served_by() {
    let (state, _, secondary) = chain(false);
    let provider: Arc<dyn Provider> = secondary;
    let candidate = ProviderId::from("secondary");
    let response = json!({"data": [{"url": "https://example.test/a.png"}]});
    let (output, origin) = multimodal_answer::finish_media_answer(
        multimodal_answer::MediaAnswer {
            state: &state,
            ctx: plain_request_context(),
            attempt_index: 1,
            candidate_provider: &candidate,
            provider: &provider,
            decision: decision("secondary"),
            modality: crate::config::Modality::Image,
            start: std::time::Instant::now(),
            primary_skipped: true,
            budget: None,
            credit_reservation: None,
            policy_alert: None,
            speech_origin: None,
        },
        response,
    )
    .await
    .expect("served");
    assert!(origin.is_none());
    assert_eq!(output.provider_used, "secondary");
    assert_eq!(
        output.degraded,
        Some(DegradedMode::Fallback("secondary".into()))
    );
    assert_eq!(
        output.response["data"][0]["url"],
        "https://example.test/a.png"
    );
}
