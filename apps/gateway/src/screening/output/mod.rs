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
//! - **Every window is read whole.** Text is cut into pieces no larger than
//!   the smallest item the output backends read, each with the output before
//!   it as context, so a window that grew while the previous one was being
//!   classified (or one dense burst) is never skipped as too large.
//! - **Fail rules.** Hard codes a screener that was healthy when the window
//!   started left undecided (a reply outside its grammar, a refusal, a
//!   timeout) are 503 `screening_unavailable` for a buffered response and
//!   end a stream with the same error as an SSE frame, on the floor and on
//!   a node that fails closed. With no healthy screener (every breaker open)
//!   the window is marked degraded and forwarded. Holding a window back for
//!   hard codes (`hold_back_windows: 1`) is not built yet.

mod stream;
mod text;

use std::sync::Arc;
use std::time::{Duration, Instant};

use ryu_gw_screening::{
    CodeSet, Direction, LeafClass, Role, ScreenItem, ScreenRequest, ScreenTier, SegmentKey,
    TaxonomyId,
};
use serde_json::json;

use super::admit::{new_screening_id, Snapshot, CHUNK_TOKENS};
use super::policy::CodeAction;
use super::{
    detections_of, record_detections, short_code, ActiveChain, Detection,
    SCREENING_RETRY_AFTER_SECS,
};
use crate::error::{ContentBlock, ContentBlockLayer, GatewayError};
use crate::pipeline::RequestContext;
use crate::state::AppState;
use crate::traffic::{DecidedBy, TrafficVerdict, VerdictAction};

pub use stream::guard_stream;
pub use text::response_text;

/// Characters per stream window, about 400 tokens.
pub const WINDOW_CHARS: usize = 1_600;
/// Estimated tokens per stream window: a window starts at whichever comes
/// first, this or [`WINDOW_CHARS`].
pub const WINDOW_TOKENS: u32 = 400;
/// Characters of earlier output sent as a window's context.
const OUTPUT_CONTEXT_CHARS: usize = 8_000;
/// The fewest estimated tokens a piece is cut to, whatever a backend
/// declares, so a window never turns into thousands of calls.
const MIN_PIECE_TOKENS: u32 = 256;
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

/// The smallest item, in estimated tokens, an output backend on this tier
/// reads, bounded to an admission chunk.
fn piece_budget(active: &ActiveChain) -> u32 {
    active
        .chain
        .backends(Role::Output)
        .iter()
        .filter(|backend| backend.permits(active.tier))
        .map(|backend| backend.descriptor().max_item_tokens)
        .min()
        .unwrap_or(CHUNK_TOKENS)
        .clamp(MIN_PIECE_TOKENS, CHUNK_TOKENS)
}

/// `text` cut into consecutive pieces of at most `budget` estimated tokens
/// and [`WINDOW_CHARS`] * 4 characters. Nothing is dropped.
fn pieces(text: &str, budget: u32) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let mut end = (start + WINDOW_CHARS * 4).min(chars.len());
        loop {
            let tokens = ryu_gw_screening::estimate_tokens_chars(chars[start..end].iter().copied());
            let len = end - start;
            if tokens <= budget || len <= 1 {
                break;
            }
            // Keep the share the budget allows, at least one fewer character
            // than now, so every pass shrinks and the loop ends.
            let keep = (len as u64 * u64::from(budget) / u64::from(tokens)) as usize;
            end = start + keep.clamp(1, len - 1);
        }
        out.push(chars[start..end].iter().collect());
        start = end;
    }
    out
}

/// Classify `text` (with `context` before it) on the output role. The
/// detections are every backend's flag or block score, for violation events.
/// `strict` is ladder L3 (spec 04.8.1): every flagged code blocks.
/// `node_closed` is the node's `node_fail_mode = "closed"`.
async fn classify(
    active: &ActiveChain,
    scope: &[u8],
    correlation_id: &str,
    text: &str,
    context: &str,
    model: Option<&str>,
    strict: bool,
    node_closed: bool,
) -> (OutputVerdict, Vec<Detection>) {
    if text.trim().is_empty() {
        return (OutputVerdict::Clean, Vec::new());
    }
    // Every piece is bound to its context, as on admission: a window cached
    // beside one prefix is classified again beside another.
    let mut prior = context.to_owned();
    let mut items = Vec::new();
    for piece in pieces(text, piece_budget(active)) {
        let context = tail(&prior);
        let context = (!context.is_empty()).then_some(context);
        let key = SegmentKey::for_text_in_context(scope, LeafClass::Assistant, &piece, context);
        let mut item = ScreenItem::text(key, LeafClass::Assistant, piece.as_str());
        if let Some(context) = context {
            item = item.with_context(context);
        }
        items.push(item);
        prior.push_str(&piece);
        if prior.len() > OUTPUT_CONTEXT_CHARS * 2 {
            prior = tail(&prior).to_owned();
        }
    }
    let wanted = CodeSet::hazards();
    let request = ScreenRequest {
        correlation_id,
        direction: Direction::Outbound,
        tier: active.tier,
        items: &items,
        wanted: &wanted,
        deadline: Instant::now() + OUTPUT_DEADLINE,
    };
    // Health as it was before this window's calls, so a window whose content
    // derails a backend cannot open its breaker and be judged degraded.
    let snapshot = Snapshot::now(active);
    let verdict = active.chain.screen(Role::Output, &request).await;
    let screener = &active.screener;
    let adult = screener.adult_permitted(model);
    let detections = detections_of(screener, &verdict, &items, adult);
    let rules = FailRules {
        snapshot: &snapshot,
        node_closed,
    };
    (decide(active, &verdict, adult, strict, &rules), detections)
}

/// What the fail rules read beside the verdict.
struct FailRules<'a> {
    snapshot: &'a Snapshot,
    node_closed: bool,
}

/// The output verdict for one classified window.
fn decide(
    active: &ActiveChain,
    verdict: &ryu_gw_screening::ChainVerdict,
    adult: bool,
    strict: bool,
    rules: &FailRules<'_>,
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
    if !undecided_hard.is_empty() {
        let refuse = if active.tier == ScreenTier::Floor {
            undecided_hard
                .iter()
                .any(|code| rules.snapshot.healthy_source(active, Role::Output, code))
        } else {
            rules.node_closed
                && !rules
                    .snapshot
                    .outage_only(active, Role::Output, verdict, &undecided_hard)
        };
        return if refuse {
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
        OutputVerdict::Degraded => {
            let mut v = TrafficVerdict::new(decided_by, VerdictAction::Allow);
            v.degraded = Some("t2");
            v
        }
        // Withheld (503, or a stream cut): the output never reached the caller.
        OutputVerdict::Unavailable => {
            let mut v = TrafficVerdict::new(decided_by, VerdictAction::Block);
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

/// Classify a buffered response before it returns. A block is 403
/// `platform_floor_output_blocked`; hard codes a healthy screener left
/// undecided are 503 `screening_unavailable`.
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
    let node_closed = state.config.screening.node_fails_closed();
    let mut verdict = OutputVerdict::Clean;
    let mut event_id = None;
    let chars: Vec<char> = text.chars().collect();
    let mut prior = String::new();
    for window in chars.chunks(WINDOW_CHARS * 4) {
        let window: String = window.iter().collect();
        let (next, detections) = crate::screening::breaker::for_subject(
            ctx,
            classify(
                &active,
                &scope,
                &ctx.request_id,
                &window,
                tail(&prior),
                model,
                strict,
                node_closed,
            ),
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

/// The final SSE frame of a stream cut because a window's hard codes were
/// left undecided: the error object of the buffered 503.
pub fn unavailable_frame(tier: ScreenTier) -> bytes::Bytes {
    let layer = if tier == ScreenTier::Floor {
        "platform"
    } else {
        "node"
    };
    let error = json!({
        "message": "Request screening is temporarily unavailable. Please retry shortly.",
        "type": "service_unavailable",
        "code": "screening_unavailable",
        "reason": "output_screener_incomplete",
        "layer": layer,
        "remedy": "none",
        "retry_after": SCREENING_RETRY_AFTER_SECS,
    });
    bytes::Bytes::from(format!("data: {}\n\n", json!({ "error": error })))
}

#[cfg(test)]
#[path = "piece_tests.rs"]
mod piece_tests;

#[cfg(test)]
#[path = "fail_tests.rs"]
mod fail_tests;
