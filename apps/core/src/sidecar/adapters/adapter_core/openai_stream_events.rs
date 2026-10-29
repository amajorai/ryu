use super::*;

use crate::routing_policy::reactive::TurnWatch;

/// Turn-wide handles every failure exit of the OpenAI-compat stream reports to.
#[derive(Clone, Copy)]
pub(crate) struct OpenAiFailureSink<'a> {
    pub(crate) traces: &'a TraceStore,
    pub(crate) turn_error_span: &'a tracing::Span,
    pub(crate) watch: &'a TurnWatch,
    pub(crate) watch_agent_id: Option<&'a str>,
    pub(crate) watch_model: &'a str,
}

/// Per-iteration streaming state of one upstream request.
pub(crate) struct OpenAiIterState {
    pub(crate) text_open: bool,
    pub(crate) iter_reply: String,
    pub(crate) tool_calls: Vec<AccToolCall>,
    pub(crate) first_token_at: Option<std::time::Instant>,
    pub(crate) delta_count: u64,
    pub(crate) last_timings: Option<Value>,
    pub(crate) last_usage: Option<Value>,
}

/// The opening frames of the turn: start, memory citations, applied agent control.
pub(crate) fn openai_prologue_frames<'a>(
    memory_citations: &'a [MemoryCitation],
    agent_control_applied: Option<&'a crate::agent_control::AgentControlApplied>,
) -> impl futures_util::Stream<Item = Vec<u8>> + 'a {
    async_stream::stream! {
        yield ui_start();
        if !memory_citations.is_empty() {
            yield ui_memory_citations(
                memory_citations,
            );
        }
        if let Some(control) = agent_control_applied {
            yield ui_data(
                "ryu-agent-control",
                &serde_json::to_value(control).unwrap_or(Value::Null),
            );
        }
    }
}

/// Open this attempt's content-free Core model-call span (when the turn has a conversation).
pub(crate) async fn openai_open_model_span(
    traces: &TraceStore,
    session_id: Option<&str>,
    model: &str,
) -> Option<String> {
    // Pair each Gateway attempt with a Core model-call span. Keep the
    // span deliberately content-free: the transcript owns prompts and
    // completions, while this store owns sequencing and failure timing.
    if let Some(conversation_id) = session_id.filter(|value| !value.is_empty()) {
        match traces
            .open_span(
                conversation_id,
                "model-call",
                model,
                None,
                Some(conversation_id),
            )
            .await
        {
            Ok(span_id) => Some(span_id),
            Err(cause) => {
                tracing::warn!("trace model span open failed: {cause:#}");
                None
            }
        }
    } else {
        None
    }
}

/// Close this attempt's model-call span after a clean end of the upstream stream.
pub(crate) async fn openai_close_model_span(
    traces: &TraceStore,
    model_span_id: &mut Option<String>,
) {
    if let Some(span_id) = model_span_id.take() {
        if let Err(cause) = traces.close_span(&span_id, None).await {
            tracing::warn!("trace model span close failed: {cause:#}");
        }
    }
}

/// Record a connect failure (span, run scope, watch, `failed` persist) before the error frames.
pub(crate) async fn openai_record_connect_failure<F, Fut>(
    e: &str,
    sink: OpenAiFailureSink<'_>,
    model_span_id: &mut Option<String>,
    run_finisher: &mut Option<ryu_tracing::ScopeGuard>,
    persist: &mut Option<F>,
    reply_all: &mut String,
) where
    F: FnOnce(String, &'static str, Vec<Value>) -> Fut,
    Fut: std::future::Future<Output = Option<String>>,
{
    if let Some(span_id) = model_span_id.take() {
        let _ = sink.traces.close_span(&span_id, Some(e)).await;
    }
    if let Some(finisher) = run_finisher.as_mut() {
        finisher.fail(e.to_owned());
    }
    crate::sidecar::gen_ai_spans::record_agent_error(sink.turn_error_span, "connect_error");
    sink.watch.record_failure(
        sink.watch_agent_id.unwrap_or_default(),
        Some(sink.watch_model),
        crate::routing_policy::reactive::FailureKind::Other,
        e,
    );
    // Suppressed when the wrapper is going to retry: a `failed`
    // assistant row written now would sit ahead of the retry's
    // good reply on reload.
    if sink.watch.retryable().is_none() {
        if let Some(p) = persist.take() {
            let _ = p(std::mem::take(reply_all), "failed", Vec::new()).await;
        }
    }
}

/// Record a non-success upstream response and return the detail the error frames carry.
pub(crate) async fn openai_record_upstream_failure<F, Fut>(
    upstream: reqwest::Response,
    sink: OpenAiFailureSink<'_>,
    model_span_id: &mut Option<String>,
    run_finisher: &mut Option<ryu_tracing::ScopeGuard>,
    persist: &mut Option<F>,
    reply_all: &mut String,
) -> String
where
    F: FnOnce(String, &'static str, Vec<Value>) -> Fut,
    Fut: std::future::Future<Output = Option<String>>,
{
    let status = upstream.status();
    // Prefer the gateway's structured error message so a firewall
    // policy block ("policy_violation"), rate limit, or budget
    // rejection surfaces a clear, actionable result to the client
    // instead of a bare status code. The gateway speaks OpenAI's
    // `{ "error": { "message", "type" } }` shape (apps/gateway/src/error.rs).
    let body = upstream.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|json| {
            let err = &json["error"];
            let message = err["message"].as_str()?.to_owned();
            match err["type"].as_str() {
                Some(kind) => Some(format!("{message} ({kind})")),
                None => Some(message),
            }
        })
        .unwrap_or_else(|| format!("Agent returned HTTP {status}"));
    if let Some(span_id) = model_span_id.take() {
        let _ = sink.traces.close_span(&span_id, Some(&detail)).await;
    }
    if let Some(finisher) = run_finisher.as_mut() {
        finisher.fail(detail.clone());
    }
    crate::sidecar::gen_ai_spans::record_agent_error(sink.turn_error_span, status.as_str());
    // Unlike the ACP plane, the Gateway names the reason in a typed
    // field (`apps/gateway/src/error.rs`), so classify on that and on
    // the status — never on the human message, which is prose.
    sink.watch.record_failure(
        sink.watch_agent_id.unwrap_or_default(),
        Some(sink.watch_model),
        crate::routing_policy::reactive::gateway_failure_kind(
            status.as_u16(),
            crate::routing_policy::reactive::error_type_of(&body).as_deref(),
        ),
        &detail,
    );
    if sink.watch.retryable().is_none() {
        if let Some(p) = persist.take() {
            let _ = p(std::mem::take(reply_all), "failed", Vec::new()).await;
        }
    }
    detail
}

/// Record a mid-stream read failure and return the detail the error frames carry.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn openai_record_stream_failure<F, Fut>(
    e: &reqwest::Error,
    stream_hop: StreamHop,
    sink: OpenAiFailureSink<'_>,
    model_span_id: &mut Option<String>,
    run_finisher: &mut Option<ryu_tracing::ScopeGuard>,
    persist: &mut Option<F>,
    reply_all: &mut String,
    iter_reply: &str,
) -> String
where
    F: FnOnce(String, &'static str, Vec<Value>) -> Fut,
    Fut: std::future::Future<Output = Option<String>>,
{
    // A stalled provider surfaces here once the idle read
    // timeout trips; name it so the turn ends as an error.
    let detail = describe_stream_error(e, stream_hop.idle_read_timeout());
    if let Some(span_id) = model_span_id.take() {
        let _ = sink.traces.close_span(&span_id, Some(&detail)).await;
    }
    if let Some(finisher) = run_finisher.as_mut() {
        finisher.fail(e.to_string());
    }
    crate::sidecar::gen_ai_spans::record_agent_error(sink.turn_error_span, "stream_error");
    reply_all.push_str(iter_reply);
    if let Some(p) = persist.take() {
        let _ = p(std::mem::take(reply_all), "failed", Vec::new()).await;
    }
    detail
}

/// Fold one parsed SSE chunk into the iteration state, yielding its UI frames.
pub(crate) fn openai_sse_event_frames<'a>(
    json: &'a Value,
    st: &'a mut OpenAiIterState,
    turn_registration: Option<&'a turn_control::TurnRegistration>,
    watch: &'a TurnWatch,
    checkpoint: Option<&'a ReplyCheckpoint>,
    reply_all: &'a str,
    text_id: &'a str,
) -> impl futures_util::Stream<Item = Vec<u8>> + 'a {
    async_stream::stream! {
        if let Some(completion_id) = json.get("id").and_then(Value::as_str) {
            if let Some(registration) = turn_registration {
                if turn_control::set_completion_id(
                    &registration.turn_id,
                    completion_id,
                ) {
                    yield ui_data(
                        "ryu-turn-control",
                        &turn_control::descriptor(registration, "reasoning"),
                    );
                }
            }
        }
        // Stats siblings (llama.cpp `timings` / OpenAI `usage`)
        // arrive on a trailing `choices: []` chunk; keep the last.
        if json.get("timings").is_some_and(Value::is_object) {
            st.last_timings = json.get("timings").cloned();
        }
        if json.get("usage").is_some_and(Value::is_object) {
            st.last_usage = json.get("usage").cloned();
        }
        let delta = json
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("delta"));
        // Reasoning is the model's first output on thinking
        // models: counting from the first answer token instead
        // folded the whole thinking phase into TTFT and divided
        // reasoning-inclusive `completion_tokens` by the
        // answer-only window, inflating tokens/sec.
        if st.first_token_at.is_none()
            && delta.is_some_and(|d| {
                ["reasoning_content", "reasoning"].iter().any(|key| {
                    d.get(*key)
                        .and_then(Value::as_str)
                        .is_some_and(|text| !text.is_empty())
                })
            })
        {
            st.first_token_at = Some(std::time::Instant::now());
        }
        if let Some(delta_text) = delta
            .and_then(|d| d.get("content"))
            .and_then(|t| t.as_str())
        {
            if !delta_text.is_empty() {
                if let Some(registration) = turn_registration {
                    if turn_control::mark_answering(&registration.turn_id) {
                        yield ui_data(
                            "ryu-turn-control",
                            &turn_control::descriptor(registration, "answering"),
                        );
                    }
                }
                if st.first_token_at.is_none() {
                    st.first_token_at = Some(std::time::Instant::now());
                }
                st.delta_count += 1;
                st.iter_reply.push_str(delta_text);
                // The user is now reading an answer; a later
                // failure can no longer be retried on another plan.
                watch.mark_content();
                if let Some(checkpoint) = checkpoint {
                    checkpoint.observe(reply_all, &st.iter_reply).await;
                }
                if !st.text_open {
                    st.text_open = true;
                    yield ui_text_start(text_id);
                }
                yield ui_text_delta(text_id, delta_text);
            }
        }
        // Accumulate `tool_calls` deltas by `index`: each fragment
        // carries an `id`/`function.name` once and `function.
        // arguments` in streamed pieces to concatenate.
        if let Some(tcs) = delta
            .and_then(|d| d.get("tool_calls"))
            .and_then(Value::as_array)
        {
            for tc in tcs {
                let index = tc
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                while st.tool_calls.len() <= index {
                    st.tool_calls.push(AccToolCall::default());
                }
                let slot = &mut st.tool_calls[index];
                if let Some(id) = tc.get("id").and_then(Value::as_str) {
                    if !id.is_empty() {
                        slot.id = id.to_owned();
                    }
                }
                if let Some(func) = tc.get("function") {
                    if let Some(name) =
                        func.get("name").and_then(Value::as_str)
                    {
                        if !name.is_empty() {
                            slot.name.push_str(name);
                        }
                    }
                    if let Some(args) =
                        func.get("arguments").and_then(Value::as_str)
                    {
                        slot.arguments.push_str(args);
                    }
                }
            }
        }
    }
}

/// Inputs to the terminal (tool-free) finalize of an OpenAI-compat turn.
pub(crate) struct OpenAiFinish<'a> {
    pub(crate) session_id: Option<&'a str>,
    pub(crate) agent_id: Option<&'a str>,
    pub(crate) plugin_flags: &'a std::collections::HashMap<String, bool>,
    pub(crate) st: &'a OpenAiIterState,
    pub(crate) stream_open: std::time::Instant,
    pub(crate) stream_end: std::time::Instant,
    pub(crate) conversation_id: Option<&'a str>,
    pub(crate) cache_warmth_agent_id: &'a str,
    pub(crate) model: &'a str,
}

/// Finalize the turn (message_end hooks, persist, cache warmth), yielding the closing frames.
pub(crate) fn openai_finish_turn_frames<'a, F, Fut>(
    fin: OpenAiFinish<'a>,
    reply_all: &'a mut String,
    persist: &'a mut Option<F>,
) -> impl futures_util::Stream<Item = Vec<u8>> + 'a
where
    F: FnOnce(String, &'static str, Vec<Value>) -> Fut + 'a,
    Fut: std::future::Future<Output = Option<String>> + 'a,
{
    async_stream::stream! {
        // Finalize point on this plane. `message_end` runs before the
        // persist closure fires, so a `Replace` is what lands in the
        // transcript and what a reload shows. Deliberately NOT fired on the
        // connect-error exit above: that turn never produced a finalized
        // message, and handing a hook a half-stream as "the answer" would
        // let it rewrite an error into a reply.
        let rewritten_reply = run_message_end_hooks(
            reply_all,
            fin.session_id,
            fin.agent_id,
            fin.plugin_flags,
        )
        .await;
        if let Some(replacement) = rewritten_reply {
            *reply_all = replacement;
        }
        // The turn's stats are sealed into the persisted parts as well
        // as streamed, so the footer and context meter survive a reload.
        // The provider's own prompt count rides inside them, which is
        // where the Context panel reads it from.
        let stats = build_stats_value(
            fin.stream_open,
            fin.st.first_token_at,
            fin.stream_end,
            fin.st.delta_count,
            &fin.st.last_timings,
            &fin.st.last_usage,
        );
        if let Some(p) = persist.take() {
            let data_parts = stats
                .iter()
                .map(|data| serde_json::json!({ "type": "data-ryu-stats", "data": data }))
                .collect();
            if let Some(message_id) =
                p(std::mem::take(reply_all), "completed", data_parts).await
            {
                yield ui_assistant_message_id(
                    &message_id,
                );
            }
        }
        // Feed the provider's cache counters to the prompt-cache warmth
        // tracker so cache-expiry compaction sees this turn.
        if let (Some(conversation_id), Some(usage)) =
            (fin.conversation_id, fin.st.last_usage.as_ref())
        {
            prompt_cache_warmth::observe_usage(
                conversation_id,
                fin.cache_warmth_agent_id,
                None,
                Some(fin.model),
                usage,
            );
        }
        if let Some(stats) = stats {
            yield ui_data("ryu-stats", &stats);
        }
        yield ui_finish();
        yield DONE_SSE_LINE.as_bytes().to_vec();
    }
}
