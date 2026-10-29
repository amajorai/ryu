//! Online evals wiring: sample completed production requests on the hot path
//! (a hash and a `try_send`, nothing awaited) and score them with catalog
//! evaluators on a bounded background worker.
//!
//! The transport-free pieces (config, sampling, queue, judge budget, store)
//! live in `ryu-gw-evals` ([`crate::evals::online`]); this module adapts them
//! to the Gateway request context and pipeline:
//!
//! * consent: nothing is sampled unless `[evals.online] enabled = true` and the
//!   tenant resolves to a policy with at least one evaluator;
//! * DLP: only text that already passed the outbound firewall is copied (the
//!   streaming path re-applies the resolved scanner's redaction because its
//!   observer sits before the outbound wrapper), and judge calls run through
//!   the normal pipeline so inbound DLP, budgets and audit apply to them too;
//! * recursion: eval traffic (`x-ryu-feature` `eval` / `online-eval`) is never
//!   sampled.

use std::sync::Arc;

use futures_util::stream::{self, StreamExt};
use serde_json::Value;
use tracing::debug;

use crate::{
    api::evals::{EVAL_FEATURE, ONLINE_EVAL_FEATURE},
    config::FirewallPolicy,
    evals::online::{
        clip_text, sampled, trace_id_from_traceparent, OfferOutcome, OnlineEvalJob, LOCAL_TENANT,
    },
    pipeline::RequestContext,
    state::AppState,
};

/// Tenant key for online-eval policy and judge budgets: the organization, or
/// [`LOCAL_TENANT`] for requests without one.
pub(crate) fn tenant_of(ctx: &RequestContext) -> String {
    ctx.org_id
        .as_deref()
        .map(str::trim)
        .filter(|org| !org.is_empty())
        .unwrap_or(LOCAL_TENANT)
        .to_owned()
}

fn is_eval_traffic(ctx: &RequestContext) -> bool {
    matches!(
        ctx.feature.as_deref(),
        Some(EVAL_FEATURE | ONLINE_EVAL_FEATURE)
    )
}

/// Text of an OpenAI-style message `content` (string or content-part array).
fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Latest user message of a chat request body.
pub(crate) fn latest_user_text(body: &Value) -> String {
    body["messages"]
        .as_array()
        .and_then(|messages| {
            messages
                .iter()
                .rev()
                .find(|message| message["role"] == "user")
        })
        .map(|message| content_text(&message["content"]))
        .unwrap_or_default()
}

/// Assistant text of a non-streaming chat completion.
pub(crate) fn response_text(response: &Value) -> String {
    content_text(&response["choices"][0]["message"]["content"])
}

/// Assistant text of an OpenAI-style SSE stream (`choices[0].delta.content`).
pub(crate) fn sse_response_text(raw: &str) -> String {
    let mut out = String::new();
    for line in raw.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if let Some(delta) = frame["choices"][0]["delta"]["content"].as_str() {
            out.push_str(delta);
        }
    }
    out
}

/// Offer a completed request to the online scorer. Cheap and non-blocking:
/// returns immediately when online evals are off, the request is eval
/// traffic, the tenant has no policy, or the request was not sampled.
pub(crate) fn maybe_enqueue(
    state: &AppState,
    ctx: &RequestContext,
    prompt: &str,
    response: &str,
    model: &str,
    provider: &str,
) {
    if !state.online_evals.is_running() || is_eval_traffic(ctx) {
        return;
    }
    let config = &state.config.evals.online;
    let tenant = tenant_of(ctx);
    let Some(policy) = config.resolve(&tenant) else {
        return;
    };
    if !sampled(&ctx.request_id, policy.sample_rate) || response.trim().is_empty() {
        return;
    }
    let max_chars = config.effective_text_chars();
    let trace_id = crate::telemetry::propagation::current_traceparent()
        .and_then(|traceparent| trace_id_from_traceparent(&traceparent));
    let job = OnlineEvalJob {
        request_id: ctx.request_id.clone(),
        trace_id,
        tenant,
        agent_id: ctx.agent_id.clone(),
        model: model.to_owned(),
        provider: provider.to_owned(),
        prompt: clip_text(prompt, max_chars),
        response: clip_text(response, max_chars),
        evaluators: policy.evaluators,
        judge_model: policy.judge_model,
        max_judge_calls_per_minute: policy.max_judge_calls_per_minute,
        enqueued_at_ms: chrono::Utc::now().timestamp_millis(),
        context: ctx.clone(),
    };
    if state.online_evals.offer(job) == OfferOutcome::QueueFull {
        debug!(request_id = %ctx.request_id, "online evals: queue full, sample dropped");
    }
}

/// Streaming variant: the stream observer sees provider bytes before the
/// outbound firewall wrapper, so re-apply the resolved scanner here. A stream
/// the outbound policy would block is not scored.
pub(crate) fn maybe_enqueue_stream(
    state: &AppState,
    ctx: &RequestContext,
    prompt: Option<&str>,
    raw_sse: &str,
    model: &str,
    provider: &str,
) {
    let Some(prompt) = prompt else {
        return;
    };
    if !state.online_evals.is_running() || is_eval_traffic(ctx) {
        return;
    }
    let text = sse_response_text(raw_sse);
    if text.trim().is_empty() {
        return;
    }
    let scanner = state.resolved_scanner(ctx);
    if scanner.outbound_enabled()
        && matches!(scanner.policy(), FirewallPolicy::Block)
        && scanner.scan_outbound(&text).is_some()
    {
        return;
    }
    let (redacted, _) = scanner.redact_outbound(&text);
    let sanitized = scanner.sanitize(&redacted);
    maybe_enqueue(state, ctx, prompt, &sanitized, model, provider);
}

/// Start the background scorer when online evals are enabled. Idempotent:
/// the queue receiver is taken once; later calls return `false`.
pub fn spawn_worker(state: &Arc<AppState>) -> bool {
    let receiver = state
        .online_eval_receiver
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    let Some(receiver) = receiver else {
        return false;
    };
    let concurrency = state.config.evals.online.effective_concurrency();
    let state = Arc::clone(state);
    tokio::spawn(async move {
        stream::unfold(receiver, |mut receiver| async move {
            receiver.recv().await.map(|job| (job, receiver))
        })
        .for_each_concurrent(concurrency, |job| {
            let state = Arc::clone(&state);
            async move {
                let record = crate::api::evals::score_online_job(Arc::clone(&state), job).await;
                state.online_evals.record(record);
            }
        })
        .await;
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_latest_user_prompt_and_response_text() {
        let body = json!({"messages": [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "a"},
            {"role": "user", "content": [{"type": "text", "text": "second"}, {"type": "image_url"}]}
        ]});
        assert_eq!(latest_user_text(&body), "second");
        assert_eq!(latest_user_text(&json!({})), "");
        let response = json!({"choices": [{"message": {"content": "answer"}}]});
        assert_eq!(response_text(&response), "answer");
    }

    #[test]
    fn sse_text_joins_only_delta_content() {
        let raw = "data: {\"id\":\"x\",\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n\
                   data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n\
                   data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n\
                   : keep-alive\n\
                   data: [DONE]\n\n";
        assert_eq!(sse_response_text(raw), "Hello");
    }
}
