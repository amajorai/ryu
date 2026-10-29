//! Output screening (screener addendum section 8, spec 02.10).
//!
//! - **Buffered responses** are classified on the `output` role before they
//!   return. A block withholds the response with 403
//!   `platform_floor_output_blocked`.
//! - **Streams** are classified in windows of about 400 tokens as the text
//!   arrives, asynchronously: forwarding continues while a window is
//!   classified, and a block stops forwarding, ends the stream with the
//!   `platform_floor_output_blocked` SSE error frame and drops the upstream.
//!   The frame carrying `[DONE]` is held until the final window is
//!   classified, so a block in the last window still ends the stream with
//!   the error instead of a clean finish.
//! - **Outages.** A window that cannot be classified is marked degraded and
//!   the stream is not cut. Holding a window back for hard codes
//!   (`hold_back_windows: 1`) and queueing degraded windows for later
//!   classification are not built yet.

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use futures_util::{FutureExt, StreamExt};
use ryu_gw_screening::{
    CodeSet, Direction, LeafClass, Role, ScreenItem, ScreenRequest, ScreenTier, SegmentKey,
    TaxonomyId,
};
use serde_json::{json, Value};

use super::admit::new_screening_id;
use super::policy::CodeAction;
use super::{
    detections_of, record_detections, short_code, ActiveChain, Detection,
    SCREENING_RETRY_AFTER_SECS,
};
use crate::error::{ContentBlock, ContentBlockLayer, GatewayError};
use crate::pipeline::RequestContext;
use crate::state::AppState;
use crate::traffic::{DecidedBy, TrafficVerdict, VerdictAction};

/// Characters per stream window, about 400 tokens.
pub const WINDOW_CHARS: usize = 1_600;
/// Characters of earlier output sent as a window's context.
const OUTPUT_CONTEXT_CHARS: usize = 8_000;
/// Deadline for one output classification (spec 02.10: 300 ms p99 target;
/// the per-call hard timeout still applies inside it).
const OUTPUT_DEADLINE: Duration = Duration::from_millis(1_500);

/// The verdict on one piece of output.
#[derive(Debug, Clone, PartialEq)]
pub enum OutputVerdict {
    Clean,
    /// Flagged codes, recorded, forwarded.
    Flagged(Vec<TaxonomyId>),
    /// Not classified; forwarded and marked degraded.
    Degraded,
    /// Hard codes left undecided while a healthy qualified backend exists.
    Unavailable,
    Blocked(ContentBlock),
}

fn active_for(state: &AppState) -> Option<Arc<ActiveChain>> {
    let tier = state.screening.tier(state.custody)?;
    let screener = crate::platform_floor::binding_floor(state.custody, &state.platform_floor)
        .and_then(|floor| floor.screener.clone());
    let active = state.screening.active(tier, screener);
    (!active.chain.backends(Role::Output).is_empty()).then_some(active)
}

/// Classify `text` (with `context` before it) on the output role. The
/// detections are every backend's flag or block score, for violation events.
/// `strict` is ladder L3 (spec 04.8.1): every flagged code blocks.
async fn classify(
    active: &ActiveChain,
    scope: &[u8],
    correlation_id: &str,
    text: &str,
    context: &str,
    model: Option<&str>,
    strict: bool,
) -> (OutputVerdict, Vec<Detection>) {
    if text.trim().is_empty() {
        return (OutputVerdict::Clean, Vec::new());
    }
    // Bound to its context, as on admission: a window cached beside one
    // prefix is classified again beside another.
    let context = (!context.is_empty()).then_some(context);
    let key = SegmentKey::for_text_in_context(scope, LeafClass::Assistant, text, context);
    let mut item = ScreenItem::text(key, LeafClass::Assistant, text);
    if let Some(context) = context {
        item = item.with_context(context);
    }
    let items = [item];
    let wanted = CodeSet::hazards();
    let request = ScreenRequest {
        correlation_id,
        direction: Direction::Outbound,
        tier: active.tier,
        items: &items,
        wanted: &wanted,
        deadline: Instant::now() + OUTPUT_DEADLINE,
    };
    let verdict = active.chain.screen(Role::Output, &request).await;
    let screener = &active.screener;
    let adult = screener.adult_permitted(model);
    let detections = detections_of(screener, &verdict, &items, adult);
    (decide(active, &verdict, adult, strict), detections)
}

/// The output verdict for one classified window.
fn decide(
    active: &ActiveChain,
    verdict: &ryu_gw_screening::ChainVerdict,
    adult: bool,
    strict: bool,
) -> OutputVerdict {
    let screener = &active.screener;
    let mut blocked = Vec::new();
    let mut flagged = Vec::new();
    for item in &verdict.items {
        for (code, score) in &item.scores {
            let action = screener
                .rule(*code)
                .decide(*score, adult && *code == TaxonomyId::S12);
            match crate::enforcement::strict(action, strict) {
                CodeAction::Block => blocked.push(*code),
                CodeAction::Flag => flagged.push(*code),
                CodeAction::Allow => {}
            }
        }
    }
    if !blocked.is_empty() {
        blocked.sort();
        blocked.dedup();
        return OutputVerdict::Blocked(ContentBlock {
            layer: if active.tier == ScreenTier::Floor {
                ContentBlockLayer::Platform
            } else {
                ContentBlockLayer::Node
            },
            output: true,
            categories: blocked.iter().map(|c| short_code(*c)).collect(),
            screening_id: new_screening_id(),
            charged_micro_usd: None,
        });
    }
    let undecided_hard = verdict.undecided_hard(active.policy());
    if !undecided_hard.is_empty() && active.tier == ScreenTier::Floor {
        let transient = undecided_hard.iter().any(|code| {
            active.chain.backends(Role::Output).iter().any(|backend| {
                let d = backend.descriptor();
                d.covers.contains(code)
                    && active.policy().may_decide(&d.reference, code, active.tier)
                    && active
                        .breakers
                        .get(d.id())
                        .is_none_or(|b| b.breaker.allows())
            })
        });
        return if transient {
            OutputVerdict::Unavailable
        } else {
            OutputVerdict::Degraded
        };
    }
    if !verdict.undecided().is_empty() {
        return OutputVerdict::Degraded;
    }
    if flagged.is_empty() {
        OutputVerdict::Clean
    } else {
        flagged.sort();
        flagged.dedup();
        OutputVerdict::Flagged(flagged)
    }
}

fn note(
    state: &AppState,
    ctx: &RequestContext,
    active: &ActiveChain,
    verdict: &OutputVerdict,
    event_id: Option<String>,
) {
    let decided_by = if active.tier == ScreenTier::Floor {
        DecidedBy::PlatformFloor
    } else {
        DecidedBy::Node
    };
    let traffic = match verdict {
        OutputVerdict::Clean => return,
        OutputVerdict::Flagged(codes) => codes.iter().fold(
            TrafficVerdict::new(decided_by, VerdictAction::Warn),
            |v, code| v.with_category(short_code(*code)),
        ),
        OutputVerdict::Degraded | OutputVerdict::Unavailable => {
            let mut v = TrafficVerdict::new(decided_by, VerdictAction::Allow);
            v.degraded = Some("t2");
            v
        }
        OutputVerdict::Blocked(block) => block.categories.iter().fold(
            TrafficVerdict::new(decided_by, VerdictAction::Block),
            |v, code| v.with_category(code),
        ),
    };
    state
        .traffic
        .note_verdict(&ctx.request_id, traffic.with_event(event_id));
}

/// Record the violation events for one classified window: a blocked code
/// takes `block_action` (`blocked` for a buffered response,
/// `stream_terminated` for a stream), a flagged one `logged_only`. Returns
/// the id the feed verdict joins on (see `record_detections`).
fn record_output(
    state: &AppState,
    ctx: &RequestContext,
    active: &ActiveChain,
    verdict: &OutputVerdict,
    detections: &[Detection],
    block_action: crate::audit::EnforcementAction,
) -> Option<String> {
    if detections.is_empty() {
        return None;
    }
    let (blocked, screening_id): (Vec<TaxonomyId>, &str) = match verdict {
        OutputVerdict::Blocked(block) => (
            detections
                .iter()
                .map(|d| d.code)
                .filter(|code| block.categories.contains(&short_code(*code)))
                .collect(),
            block.screening_id.as_str(),
        ),
        _ => (Vec::new(), ""),
    };
    record_detections(
        state,
        ctx,
        active,
        detections,
        &blocked,
        block_action,
        Direction::Outbound,
        screening_id,
    )
}

/// Text a provider returns beside `content` that the gateway still forwards
/// to the caller: reasoning (`reasoning`, `reasoning_content`,
/// `reasoning_details[].text` and `.summary`), a `refusal`, and the legacy
/// `function_call.arguments`. A model can be walked through hazardous text
/// there, so the output role reads it too. `sep` follows each piece (a newline
/// in a buffered response, nothing between stream deltas).
fn push_side_channels(holder: &Value, out: &mut String, sep: &str) {
    let mut push = |text: &str| {
        out.push_str(text);
        out.push_str(sep);
    };
    for key in ["reasoning", "reasoning_content", "refusal"] {
        if let Some(text) = holder[key].as_str() {
            push(text);
        }
    }
    for detail in holder["reasoning_details"].as_array().into_iter().flatten() {
        for key in ["text", "summary"] {
            if let Some(text) = detail[key].as_str() {
                push(text);
            }
        }
    }
    if let Some(arguments) = holder["function_call"]["arguments"].as_str() {
        push(arguments);
    }
}

/// The assistant text of a buffered chat response: every choice's content,
/// tool call arguments and side channels (reasoning, refusal, legacy
/// function call).
pub fn response_text(response: &Value) -> String {
    let mut out = String::new();
    for choice in response["choices"].as_array().into_iter().flatten() {
        let message = &choice["message"];
        push_content(&message["content"], &mut out);
        push_side_channels(message, &mut out, "\n");
        for call in message["tool_calls"].as_array().into_iter().flatten() {
            if let Some(arguments) = call["function"]["arguments"].as_str() {
                out.push_str(arguments);
                out.push('\n');
            }
        }
        if let Some(text) = choice["text"].as_str() {
            out.push_str(text);
            out.push('\n');
        }
    }
    out
}

fn push_content(content: &Value, out: &mut String) {
    match content {
        Value::String(s) => {
            out.push_str(s);
            out.push('\n');
        }
        Value::Array(parts) => {
            for part in parts {
                if let Some(text) = part["text"].as_str() {
                    out.push_str(text);
                    out.push('\n');
                }
            }
        }
        _ => {}
    }
}

/// Classify a buffered response before it returns. A block is 403
/// `platform_floor_output_blocked`; hard codes left undecided while a
/// healthy qualified backend exists are 503 `screening_unavailable`.
pub async fn screen_buffered(
    state: &AppState,
    ctx: &RequestContext,
    text: &str,
    model: Option<&str>,
) -> Result<(), GatewayError> {
    let Some(active) = active_for(state) else {
        return Ok(());
    };
    let scope = state.screening.scope_key(ctx.org_id.as_deref());
    let strict = active.tier == ScreenTier::Floor && crate::enforcement::is_restricted(ctx);
    let mut verdict = OutputVerdict::Clean;
    let mut event_id = None;
    let chars: Vec<char> = text.chars().collect();
    let mut prior = String::new();
    for window in chars.chunks(WINDOW_CHARS * 4) {
        let window: String = window.iter().collect();
        let (next, detections) = classify(
            &active,
            &scope,
            &ctx.request_id,
            &window,
            tail(&prior),
            model,
            strict,
        )
        .await;
        let recorded = record_output(
            state,
            ctx,
            &active,
            &next,
            &detections,
            crate::audit::EnforcementAction::Blocked,
        );
        // The window that blocks names the verdict's event.
        if matches!(next, OutputVerdict::Blocked(_)) || event_id.is_none() {
            event_id = recorded.or(event_id);
        }
        prior.push_str(&window);
        verdict = stronger(verdict, next);
        if matches!(verdict, OutputVerdict::Blocked(_)) {
            break;
        }
    }
    state.screening.publish_transitions(&state.traffic);
    note(state, ctx, &active, &verdict, event_id);
    match verdict {
        OutputVerdict::Blocked(block) => {
            tracing::warn!(
                request_id = %ctx.request_id,
                categories = ?block.categories,
                "screening: withheld a buffered response"
            );
            state.metrics.inc_firewall_blocked();
            Err(GatewayError::ContentBlocked(Box::new(block)))
        }
        OutputVerdict::Unavailable => Err(GatewayError::ScreeningUnavailable {
            reason: "output_screener_incomplete",
            retry_after_secs: SCREENING_RETRY_AFTER_SECS,
        }),
        _ => Ok(()),
    }
}

fn rank(verdict: &OutputVerdict) -> u8 {
    match verdict {
        OutputVerdict::Clean => 0,
        OutputVerdict::Flagged(_) => 1,
        OutputVerdict::Degraded => 2,
        OutputVerdict::Unavailable => 3,
        OutputVerdict::Blocked(_) => 4,
    }
}

fn stronger(a: OutputVerdict, b: OutputVerdict) -> OutputVerdict {
    if rank(&b) > rank(&a) {
        b
    } else {
        a
    }
}

fn tail(text: &str) -> &str {
    let start = text
        .char_indices()
        .rev()
        .nth(OUTPUT_CONTEXT_CHARS.saturating_sub(1))
        .map_or(0, |(i, _)| i);
    &text[start..]
}

/// The final SSE frame of a stream the screener cut.
pub fn block_frame(block: &ContentBlock) -> bytes::Bytes {
    bytes::Bytes::from(format!(
        "data: {}\n\n",
        json!({ "error": block.error_object() })
    ))
}

/// Text deltas in one SSE chunk: chat `delta.content`, tool call argument
/// deltas, reasoning, refusal and legacy function-call deltas, legacy `text`,
/// and Responses `delta` strings.
fn delta_text(frame: &Value, out: &mut String) {
    for choice in frame["choices"].as_array().into_iter().flatten() {
        let delta = &choice["delta"];
        push_content(&delta["content"], out);
        push_side_channels(delta, out, "");
        for call in delta["tool_calls"].as_array().into_iter().flatten() {
            if let Some(arguments) = call["function"]["arguments"].as_str() {
                out.push_str(arguments);
            }
        }
        if let Some(text) = choice["text"].as_str() {
            out.push_str(text);
        }
    }
    if let Some(delta) = frame["delta"].as_str() {
        out.push_str(delta);
    }
}

/// What one turn of the stream loop produced.
enum Step {
    Verdict((OutputVerdict, Option<String>)),
    Item(Option<Result<bytes::Bytes, axum::Error>>),
}

struct StreamScreen {
    inner: axum::body::BodyDataStream,
    state: Arc<AppState>,
    ctx: RequestContext,
    /// The same context, shared with the window futures that record events.
    shared_ctx: Arc<RequestContext>,
    active: Arc<ActiveChain>,
    scope: [u8; 32],
    model: Option<String>,
    /// Partial SSE line carried across chunks.
    line: String,
    window: String,
    prior: String,
    pending: Option<BoxFuture<'static, (OutputVerdict, Option<String>)>>,
    worst: OutputVerdict,
    /// The event the feed verdict joins on: the cut, else the first flag.
    event_id: Option<String>,
    ended: bool,
}

impl StreamScreen {
    fn absorb(&mut self, chunk: &[u8]) -> bool {
        let mut saw_done = false;
        self.line.push_str(&String::from_utf8_lossy(chunk));
        while let Some(end) = self.line.find('\n') {
            let line: String = self.line.drain(..=end).collect();
            let Some(data) = line.trim_end().strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                saw_done = true;
                continue;
            }
            if let Ok(frame) = serde_json::from_str::<Value>(data) {
                delta_text(&frame, &mut self.window);
            }
        }
        saw_done
    }

    fn start_window(&mut self) {
        let text = std::mem::take(&mut self.window);
        let context = tail(&self.prior).to_owned();
        self.prior.push_str(&text);
        if self.prior.len() > OUTPUT_CONTEXT_CHARS * 2 {
            let keep = tail(&self.prior).to_owned();
            self.prior = keep;
        }
        let active = Arc::clone(&self.active);
        let scope = self.scope;
        let correlation = self.ctx.request_id.clone();
        let model = self.model.clone();
        let state = Arc::clone(&self.state);
        let ctx = Arc::clone(&self.shared_ctx);
        let strict = active.tier == ScreenTier::Floor && crate::enforcement::is_restricted(&ctx);
        self.pending = Some(
            async move {
                let (verdict, detections) = classify(
                    &active,
                    &scope,
                    &correlation,
                    &text,
                    &context,
                    model.as_deref(),
                    strict,
                )
                .await;
                let recorded = record_output(
                    &state,
                    &ctx,
                    &active,
                    &verdict,
                    &detections,
                    crate::audit::EnforcementAction::StreamTerminated,
                );
                (verdict, recorded)
            }
            .boxed(),
        );
    }

    /// Record a finished window. `Some` is the frame that ends the stream.
    fn settle(
        &mut self,
        (verdict, recorded): (OutputVerdict, Option<String>),
    ) -> Option<bytes::Bytes> {
        if matches!(verdict, OutputVerdict::Blocked(_)) || self.event_id.is_none() {
            self.event_id = recorded.or(self.event_id.take());
        }
        let worst = std::mem::replace(&mut self.worst, OutputVerdict::Clean);
        self.worst = stronger(worst, verdict.clone());
        if let OutputVerdict::Blocked(block) = verdict {
            self.ended = true;
            tracing::warn!(
                request_id = %self.ctx.request_id,
                categories = ?block.categories,
                "screening: stream cut by an output window"
            );
            self.state.metrics.inc_firewall_blocked();
            note(
                &self.state,
                &self.ctx,
                &self.active,
                &self.worst,
                self.event_id.clone(),
            );
            return Some(block_frame(&block));
        }
        None
    }

    async fn finish_pending(&mut self) -> Option<bytes::Bytes> {
        let pending = self.pending.take()?;
        let verdict = pending.await;
        self.settle(verdict)
    }
}

/// Wrap a stream with window screening when the screener binds this request.
pub fn guard_stream(
    body: axum::body::Body,
    state: Arc<AppState>,
    ctx: RequestContext,
    model: Option<String>,
) -> axum::body::Body {
    let Some(active) = active_for(&state) else {
        return body;
    };
    let scope = state.screening.scope_key(ctx.org_id.as_deref());
    let shared_ctx = Arc::new(ctx.clone());
    let init = StreamScreen {
        inner: body.into_data_stream(),
        state,
        ctx,
        shared_ctx,
        active,
        scope,
        model,
        line: String::new(),
        window: String::new(),
        prior: String::new(),
        pending: None,
        worst: OutputVerdict::Clean,
        event_id: None,
        ended: false,
    };
    let stream = futures_util::stream::unfold(init, |mut s| async move {
        if s.ended {
            return None;
        }
        loop {
            let step = match s.pending.as_mut() {
                Some(pending) => {
                    tokio::select! {
                        biased;
                        verdict = pending => Step::Verdict(verdict),
                        item = s.inner.next() => Step::Item(item),
                    }
                }
                None => Step::Item(s.inner.next().await),
            };
            let next = match step {
                Step::Verdict(verdict) => {
                    s.pending = None;
                    if let Some(frame) = s.settle(verdict) {
                        return Some((Ok(frame), s));
                    }
                    continue;
                }
                Step::Item(item) => item,
            };
            let Some(item) = next else {
                // Upstream ended without `[DONE]`: classify what is left.
                if let Some(frame) = s.finish_pending().await {
                    return Some((Ok(frame), s));
                }
                if !s.window.trim().is_empty() {
                    s.start_window();
                    if let Some(frame) = s.finish_pending().await {
                        return Some((Ok(frame), s));
                    }
                }
                note(&s.state, &s.ctx, &s.active, &s.worst, s.event_id.clone());
                s.state.screening.publish_transitions(&s.state.traffic);
                return None;
            };
            let chunk = match item {
                Ok(chunk) => chunk,
                Err(error) => return Some((Err(error), s)),
            };
            let done = s.absorb(&chunk);
            if done {
                // Hold the final frame until every window is classified.
                if let Some(frame) = s.finish_pending().await {
                    return Some((Ok(frame), s));
                }
                if !s.window.trim().is_empty() {
                    s.start_window();
                    if let Some(frame) = s.finish_pending().await {
                        return Some((Ok(frame), s));
                    }
                }
                note(&s.state, &s.ctx, &s.active, &s.worst, s.event_id.clone());
                s.state.screening.publish_transitions(&s.state.traffic);
                s.ended = true;
                return Some((Ok(chunk), s));
            }
            if s.pending.is_none() && s.window.chars().count() >= WINDOW_CHARS {
                s.start_window();
            }
            return Some((Ok(chunk), s));
        }
    });
    axum::body::Body::from_stream(stream)
}

#[cfg(test)]
mod side_channel_tests {
    use super::*;
    use serde_json::json;

    /// Reasoning, refusal and legacy function-call text reach the caller, so
    /// the output role reads them like `content`.
    #[test]
    fn a_buffered_response_exposes_reasoning_refusal_and_function_call_text() {
        let response = json!({ "choices": [{ "message": {
            "role": "assistant",
            "content": "visible",
            "reasoning": "reasoning-marker",
            "reasoning_content": "reasoning-content-marker",
            "reasoning_details": [
                { "type": "reasoning.text", "text": "detail-text-marker" },
                { "type": "reasoning.summary", "summary": "detail-summary-marker" }
            ],
            "refusal": "refusal-marker",
            "function_call": { "name": "f", "arguments": "{\"legacy\":\"function-call-marker\"}" }
        } }] });
        let text = response_text(&response);
        for marker in [
            "visible",
            "reasoning-marker",
            "reasoning-content-marker",
            "detail-text-marker",
            "detail-summary-marker",
            "refusal-marker",
            "function-call-marker",
        ] {
            assert!(text.contains(marker), "{marker} missing from {text:?}");
        }
    }

    #[test]
    fn a_stream_frame_exposes_reasoning_deltas() {
        let frame = json!({ "choices": [{ "delta": {
            "content": "c",
            "reasoning": "r1",
            "reasoning_content": "r2",
            "reasoning_details": [{ "text": "r3" }],
            "refusal": "r4",
            "function_call": { "arguments": "r5" }
        } }] });
        let mut out = String::new();
        delta_text(&frame, &mut out);
        for delta in ["c", "r1", "r2", "r3", "r4", "r5"] {
            assert!(out.contains(delta), "{delta} missing from {out:?}");
        }
    }

    #[test]
    fn a_response_without_side_channels_is_unchanged() {
        let response = json!({ "choices": [{ "message": { "content": "only" } }] });
        assert_eq!(response_text(&response), "only\n");
    }
}
