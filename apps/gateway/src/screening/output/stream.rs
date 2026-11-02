//! Stream screening: windows classified asynchronously as the text arrives.
//! A block, or hard codes a healthy screener left undecided, ends the stream
//! with an SSE error frame; the frame carrying `[DONE]` is held until the
//! final window is classified.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use futures_util::{FutureExt, StreamExt};
use serde_json::Value;

use super::text::delta_text;
use super::{
    active_for, block_frame, classify, note, record_output, stronger, tail, unavailable_frame,
    OutputVerdict, OUTPUT_CONTEXT_CHARS, WINDOW_CHARS, WINDOW_TOKENS,
};
use crate::pipeline::RequestContext;
use crate::screening::ActiveChain;
use crate::state::AppState;
use ryu_gw_screening::ScreenTier;

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

    /// A window is sent at about 400 tokens, by characters or by estimated
    /// tokens, so dense text (CJK, base64) does not wait for 1,600 chars.
    fn window_full(&self) -> bool {
        self.window.chars().count() >= WINDOW_CHARS
            || ryu_gw_screening::estimate_tokens(&self.window) >= WINDOW_TOKENS
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
        let node_closed = state.config.screening.node_fails_closed();
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
                    node_closed,
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
        let frame = match &verdict {
            OutputVerdict::Blocked(block) => {
                tracing::warn!(
                    request_id = %self.ctx.request_id,
                    categories = ?block.categories,
                    "screening: stream cut by an output window"
                );
                self.state.metrics.inc_firewall_blocked();
                block_frame(block)
            }
            // Hard codes a healthy screener left undecided (a reply outside
            // its grammar, a refusal, a timeout): the stream fails closed as
            // the buffered response does, never forwarding more unscreened.
            OutputVerdict::Unavailable => {
                tracing::warn!(
                    request_id = %self.ctx.request_id,
                    "screening: stream cut, an output window was left undecided"
                );
                unavailable_frame(self.active.tier)
            }
            _ => return None,
        };
        self.ended = true;
        note(
            &self.state,
            &self.ctx,
            &self.active,
            &self.worst,
            self.event_id.clone(),
        );
        self.state
            .screening
            .publish_transitions(&self.state.traffic);
        Some(frame)
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
            if s.pending.is_none() && s.window_full() {
                s.start_window();
            }
            return Some((Ok(chunk), s));
        }
    });
    axum::body::Body::from_stream(stream)
}
