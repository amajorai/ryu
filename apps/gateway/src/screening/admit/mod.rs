//! Inbound admission: screen what a request will send upstream, after the
//! regex floor (`screen_residual_inbound`) and before dispatch, on every
//! floor-bound route, on fallback attempts and on every tool round.
//!
//! The screen keys off custody and tier only, never the tenant's firewall
//! switches, so a tenant that turns its own scanner off is still screened by
//! Ryu's floor on the fleet.

mod health;
mod items;
mod project;
mod run;
mod template;

use std::time::Duration;

use ryu_gw_screening::{Direction, LeafClass, ScreenImage, ScreenTier, TaxonomyId};
use serde_json::Value;

pub use health::floor_degraded;
pub(crate) use health::Snapshot;
pub use project::chat_input;
use project::{walk_value, Walk};

use super::policy::FloorScreener;
use super::{publish_degraded, short_code, SCREENING_RETRY_AFTER_SECS};
use crate::error::GatewayError;
use crate::pipeline::RequestContext;
use crate::state::AppState;
use crate::traffic::{DecidedBy, TrafficVerdict, VerdictAction};

/// Characters per screened item, about 2,048 tokens (spec 02.5.4).
pub const CHUNK_CHARS: usize = 8_000;
/// Estimated tokens per screened item's text (spec 02.5.4). A chunk is cut at
/// whichever comes first, [`CHUNK_CHARS`] or this, so token-dense text (CJK,
/// hex, base64, code) is split before it can overrun the engine's context.
pub const CHUNK_TOKENS: u32 = 2_048;
/// Estimated tokens of prior text sent as an item's context (spec 02.5.4).
pub const CONTEXT_TOKENS: u32 = 2_048;
/// Characters each chunk repeats from the end of the one before it, about
/// 128 tokens (spec 02.5.4), so a hard code that straddles a chunk boundary
/// is whole inside one item.
pub const OVERLAP_CHARS: usize = 512;
/// Characters of prior text sent as an item's context.
pub const CONTEXT_CHARS: usize = 8_000;
/// Most items one request may need classified, about 2.4 M characters at
/// the overlapped chunk step (a chat body is bounded at 2 MiB on the wire,
/// plus decoded forms). Past it the request is refused with 413
/// `screening_capacity_exceeded` on both tiers: a node never drops the tail.
pub const MAX_ITEMS: usize = 320;

/// Which surface deadline applies (spec 02.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    Chat,
    /// A tool result appended inside a tool loop.
    ToolRound,
    /// The model's own turn inside a tool loop: its text and the arguments
    /// of the calls it chose (spec 03.4.2 `tool_args`).
    ToolArgs,
    Embeddings,
    /// Image, video and speech routes.
    Media,
    /// Speech-to-text: the prompt is screened. No backend classifies audio,
    /// so on the floor tier the audio is media no backend can screen and is
    /// refused; on a node's own tier it is forwarded unclassified (spec D17).
    Transcription,
    /// `/v1/providers/call`.
    ProviderCall,
}

impl Surface {
    fn deadline(self, screener: &FloorScreener) -> Duration {
        let d = &screener.deadlines;
        let ms = match self {
            Surface::Chat | Surface::Embeddings | Surface::ProviderCall => d.chat,
            Surface::ToolRound | Surface::ToolArgs => d.tool_round,
            Surface::Media | Surface::Transcription => d.media,
        };
        Duration::from_millis(u64::from(ms))
    }

    const fn is_media(self) -> bool {
        matches!(self, Surface::Media | Surface::Transcription)
    }

    const fn direction(self) -> Direction {
        match self {
            Surface::ToolRound => Direction::ToolResult,
            Surface::ToolArgs | Surface::ProviderCall => Direction::ToolArgs,
            _ => Direction::Inbound,
        }
    }
}

/// One text the request sends upstream.
#[derive(Debug, Clone)]
pub struct Segment {
    pub class: LeafClass,
    pub text: String,
}

/// Media the request sends upstream.
#[derive(Debug, Clone)]
pub enum MediaPart {
    /// Bytes the gateway holds and would forward.
    Image(ScreenImage),
    /// A remote URL, an audio part or another blob the gateway cannot hand a
    /// classifier as the exact bytes the provider would receive.
    Unscreenable,
}

/// Everything one screen covers.
#[derive(Debug, Clone, Default)]
pub struct ScreenInput {
    pub segments: Vec<Segment>,
    pub media: Vec<MediaPart>,
    /// The model the request names, for `adultPermittedModels`.
    pub model: Option<String>,
}

impl ScreenInput {
    pub fn is_empty(&self) -> bool {
        self.media.is_empty() && self.segments.iter().all(|s| s.text.trim().is_empty())
    }

    pub fn push(&mut self, class: LeafClass, text: &str) {
        if !text.trim().is_empty() {
            self.segments.push(Segment {
                class,
                text: text.to_owned(),
            });
        }
    }
}

/// What the screen decided. Per detector and per code, so violation events
/// can be keyed `{requestId}:{attempt}:{detectorId}:{category}` (G5).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScreenReport {
    pub tier: Option<&'static str>,
    pub screening_id: String,
    pub blocked: Vec<TaxonomyId>,
    pub flagged: Vec<TaxonomyId>,
    /// `(code, backend id)` for every code that cleared a flag or block rule.
    pub detections: Vec<(TaxonomyId, String)>,
    /// Why the screen ran in a reduced mode: `t2` (a hazard code left
    /// undecided), `t1` (prompt attack left undecided), `vision` or
    /// `deadline`.
    pub degraded: Option<&'static str>,
    /// Remote processors that received content.
    pub processors: Vec<String>,
    /// The violation event the live feed verdict joins on (spec 00.6).
    pub event_id: Option<String>,
}

/// A fresh screening id: `scr_` and 32 hex characters.
pub fn new_screening_id() -> String {
    format!("scr_{}", uuid::Uuid::new_v4().simple())
}

/// Screen a chat-shaped body (chat completions, compat routes and the
/// Responses translation all reach the pipeline as one).
pub async fn screen_chat(
    state: &AppState,
    ctx: &RequestContext,
    body: &Value,
    surface: Surface,
) -> Result<ScreenReport, GatewayError> {
    if state.screening.tier(state.custody).is_none() {
        return Ok(ScreenReport::default());
    }
    screen(state, ctx, surface, chat_input(body)).await
}

/// [`screen_chat`] for the model this attempt will actually dispatch to, not
/// the one the caller named in the body: a slot header, a fallback or a pool
/// member can replace it after routing, and `adultPermittedModels` must follow
/// the model that receives the content (the output screen already does).
pub async fn screen_chat_as(
    state: &AppState,
    ctx: &RequestContext,
    body: &Value,
    surface: Surface,
    dispatch_model: &str,
) -> Result<ScreenReport, GatewayError> {
    if state.screening.tier(state.custody).is_none() {
        return Ok(ScreenReport::default());
    }
    let mut input = chat_input(body);
    input.model = Some(dispatch_model.to_owned());
    screen(state, ctx, surface, input).await
}

/// [`screen_chat`] plus `extra` text (the residual) as freeform input.
pub async fn screen_chat_with(
    state: &AppState,
    ctx: &RequestContext,
    body: &Value,
    extra: Option<String>,
    surface: Surface,
) -> Result<ScreenReport, GatewayError> {
    if state.screening.tier(state.custody).is_none() {
        return Ok(ScreenReport::default());
    }
    let mut input = chat_input(body);
    if let Some(extra) = extra {
        input.push(LeafClass::Freeform, &extra);
    }
    screen(state, ctx, surface, input).await
}

/// Screen any other body (embeddings, rerank, media, provider calls, a tool
/// round's appended item): every string leaf as freeform user text, and any
/// embedded media.
pub async fn screen_value(
    state: &AppState,
    ctx: &RequestContext,
    value: &Value,
    surface: Surface,
) -> Result<ScreenReport, GatewayError> {
    let Some(tier) = state.screening.tier(state.custody) else {
        return Ok(ScreenReport::default());
    };
    let mut input = ScreenInput {
        model: value
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned),
        ..ScreenInput::default()
    };
    let class = match surface {
        Surface::ToolRound => LeafClass::ToolResult,
        Surface::ToolArgs | Surface::ProviderCall => LeafClass::ToolArgs,
        _ => LeafClass::User,
    };
    let walk = match surface {
        Surface::Media => Walk::MediaRoute,
        Surface::Transcription if tier == ScreenTier::Floor => Walk::RefuseAudio,
        Surface::Transcription => Walk::SkipAudio,
        _ => Walk::Parts,
    };
    let mut text = String::new();
    walk_value(value, &mut text, &mut input.media, walk);
    input.push(class, &text);
    screen(state, ctx, surface, input).await
}

fn floor_unscreenable() -> GatewayError {
    GatewayError::PlatformRefused {
        code: "media_unscreenable",
        message:
            "This media cannot be screened by Ryu's platform safety policy, so it was not sent.",
    }
}

fn unavailable(reason: &'static str) -> GatewayError {
    GatewayError::ScreeningUnavailable {
        reason,
        retry_after_secs: SCREENING_RETRY_AFTER_SECS,
    }
}

/// The screen itself.
pub async fn screen(
    state: &AppState,
    ctx: &RequestContext,
    surface: Surface,
    input: ScreenInput,
) -> Result<ScreenReport, GatewayError> {
    let runtime = std::sync::Arc::clone(&state.screening);
    let Some(tier) = runtime.tier(state.custody) else {
        return Ok(ScreenReport::default());
    };
    if input.is_empty() {
        return Ok(ScreenReport::default());
    }
    let floor_screener = crate::platform_floor::binding_floor(state.custody, &state.platform_floor)
        .and_then(|floor| floor.screener.clone());
    let active = runtime.active(tier, floor_screener);
    let result =
        crate::screening::breaker::for_subject(ctx, run::run(state, ctx, surface, input, &active))
            .await;
    runtime.publish_transitions(&state.traffic);
    result
}

/// Note a refusal's verdict and hand the error back.
fn refuse(
    state: &AppState,
    ctx: &RequestContext,
    report: &ScreenReport,
    error: GatewayError,
) -> GatewayError {
    let decided_by = match report.tier {
        Some("node") => DecidedBy::Node,
        _ => DecidedBy::PlatformFloor,
    };
    note(state, ctx, decided_by, VerdictAction::Block, report);
    error
}

fn note(
    state: &AppState,
    ctx: &RequestContext,
    decided_by: DecidedBy,
    action: VerdictAction,
    report: &ScreenReport,
) {
    let mut verdict = TrafficVerdict::new(decided_by, action);
    for (code, source) in &report.detections {
        verdict = verdict
            .with_category(short_code(*code))
            .with_detector(source);
    }
    verdict.degraded = report.degraded;
    let verdict = verdict.with_event(report.event_id.clone());
    state.traffic.note_verdict(&ctx.request_id, verdict);
}

fn degraded_alert(state: &AppState, reason: &'static str) {
    if state.screening.alert_due() {
        tracing::warn!(
            reason,
            "screening: degraded mode, hard codes have no healthy qualified backend; \
             regex floor plus throttle"
        );
        publish_degraded(&state.traffic, serde_json::json!({ "reason": reason }));
    }
}

#[cfg(test)]
#[path = "fixture_tests.rs"]
pub(crate) mod fixture;
#[cfg(test)]
mod health_tests;
#[cfg(test)]
mod run_tests;
