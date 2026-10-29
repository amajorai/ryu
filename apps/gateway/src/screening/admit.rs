//! Inbound admission: screen what a request will send upstream, after the
//! regex floor (`screen_residual_inbound`) and before dispatch, on every
//! floor-bound route, on fallback attempts and on every tool round.
//!
//! The screen keys off custody and tier only, never the tenant's firewall
//! switches, so a tenant that turns its own scanner off is still screened by
//! Ryu's floor on the fleet.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use base64::Engine as _;
use ryu_gw_screening::{
    ChainVerdict, CodeSet, Direction, LeafClass, Role, ScreenImage, ScreenItem, ScreenRequest,
    ScreenTier, SegmentKey, TaxonomyId,
};
use serde_json::Value;

use super::policy::{CodeAction, FloorScreener};
use super::{publish_degraded, short_code, ActiveChain, SCREENING_RETRY_AFTER_SECS};
use crate::error::{ContentBlock, ContentBlockLayer, GatewayError};
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
/// Most items one request may need classified at floor tier, about 2.4 M
/// characters at the overlapped chunk step (a chat body is bounded at 2 MiB
/// on the wire, plus decoded forms). Past it the request is refused with 413
/// `screening_capacity_exceeded`.
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
    /// Why the screen ran in a reduced mode: `t2`, `vision` or `deadline`.
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

/// The chat projection: each message's text under its role's class, tool
/// call arguments, top-level prompt fields, tool definitions, and media
/// parts.
pub fn chat_input(body: &Value) -> ScreenInput {
    let mut input = ScreenInput {
        model: body.get("model").and_then(Value::as_str).map(str::to_owned),
        ..ScreenInput::default()
    };
    for message in body["messages"].as_array().into_iter().flatten() {
        let class = match message["role"].as_str() {
            Some("system" | "developer") => LeafClass::System,
            Some("assistant") => LeafClass::Assistant,
            Some("tool" | "function") => LeafClass::ToolResult,
            _ => LeafClass::User,
        };
        collect_content(&message["content"], class, &mut input);
        for call in message["tool_calls"].as_array().into_iter().flatten() {
            if let Some(arguments) = call["function"]["arguments"].as_str() {
                input.push(LeafClass::ToolArgs, arguments);
            }
        }
        if let Some(arguments) = message["function_call"]["arguments"].as_str() {
            input.push(LeafClass::ToolArgs, arguments);
        }
    }
    for key in ["prompt", "system", "instructions", "suffix"] {
        collect_content(&body[key], LeafClass::User, &mut input);
    }
    // Predicted output is sent upstream as a draft of the reply, and the regex
    // floor counts it as conversation, so it is never in the residual either.
    collect_content(
        &body["prediction"]["content"],
        LeafClass::Assistant,
        &mut input,
    );
    if !body["input"].is_null() {
        let mut text = String::new();
        walk_value(&body["input"], &mut text, &mut input.media, Walk::Parts);
        input.push(LeafClass::User, &text);
    }
    for tool in body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(body["functions"].as_array().into_iter().flatten())
    {
        let mut text = String::new();
        collect_strings(tool, &mut text);
        input.push(LeafClass::Definition, &text);
    }
    input
}

fn collect_content(content: &Value, class: LeafClass, input: &mut ScreenInput) {
    match content {
        Value::String(text) => input.push(class, text),
        Value::Array(parts) => {
            for part in parts {
                if let Some(media) = media_part(part) {
                    input.media.push(media);
                    continue;
                }
                match part {
                    Value::String(text) => input.push(class, text),
                    Value::Object(_) => {
                        let mut text = String::new();
                        for key in ["text", "content", "input_text", "output_text"] {
                            collect_strings(&part[key], &mut text);
                        }
                        input.push(class, &text);
                    }
                    _ => {}
                }
            }
        }
        Value::Object(_) => {
            let mut text = String::new();
            collect_strings(content, &mut text);
            input.push(class, &text);
        }
        _ => {}
    }
}

/// How [`walk_value`] reads media.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Walk {
    /// Media content parts only (chat, embeddings, tool rounds).
    Parts,
    /// A media route: a bare `image`, `mask` or similar field, or a data
    /// URL, is media too.
    MediaRoute,
    /// A transcription on a node's own tier: the audio fields are skipped,
    /// everything else is read as on a media route (spec D17).
    SkipAudio,
    /// A transcription on the floor tier: the audio is media no backend can
    /// screen, so it is refused; everything else is read as on a media route.
    RefuseAudio,
}

/// The audio fields of a transcription body.
const AUDIO_KEYS: &[&str] = &["file", "audio", "input_audio", "audio_url"];

/// Every string leaf of `value` into `text`, media aside.
fn walk_value(value: &Value, text: &mut String, media: &mut Vec<MediaPart>, walk: Walk) {
    match value {
        Value::String(s) => {
            let audio = s
                .get(..11)
                .is_some_and(|head| head.eq_ignore_ascii_case("data:audio/"));
            if audio && walk == Walk::SkipAudio {
                return;
            }
            if audio && walk == Walk::RefuseAudio {
                media.push(MediaPart::Unscreenable);
                return;
            }
            if walk != Walk::Parts && looks_like_media(s) {
                media.push(decode_data_url(s).unwrap_or(MediaPart::Unscreenable));
            } else {
                text.push_str(s);
                text.push('\n');
            }
        }
        Value::Array(items) => items.iter().for_each(|v| walk_value(v, text, media, walk)),
        Value::Object(map) => {
            if let Some(part) = media_part(value) {
                media.push(part);
                return;
            }
            for (key, v) in map {
                if AUDIO_KEYS.contains(&key.as_str()) {
                    match walk {
                        Walk::SkipAudio => continue,
                        Walk::RefuseAudio if !v.is_null() => {
                            media.push(MediaPart::Unscreenable);
                            continue;
                        }
                        _ => {}
                    }
                }
                if walk != Walk::Parts && MEDIA_KEYS.contains(&key.as_str()) && !v.is_null() {
                    media.push(match v.as_str().and_then(decode_data_url) {
                        Some(part) => part,
                        None => MediaPart::Unscreenable,
                    });
                    continue;
                }
                walk_value(v, text, media, walk);
            }
        }
        _ => {}
    }
}

/// Body keys that carry an input image or other media on a media route.
const MEDIA_KEYS: &[&str] = &[
    "image",
    "images",
    "image_url",
    "mask",
    "input_image",
    "init_image",
    "reference_image",
    "start_image",
    "end_image",
    "video",
    "audio",
    "file",
];

fn looks_like_media(s: &str) -> bool {
    let head = s.get(..16).unwrap_or(s).to_ascii_lowercase();
    head.starts_with("data:image/")
        || head.starts_with("data:audio/")
        || head.starts_with("data:video/")
}

/// A content part that carries media, if `part` is one.
fn media_part(part: &Value) -> Option<MediaPart> {
    let kind = part["type"].as_str().unwrap_or("");
    let is_media = matches!(
        kind,
        "image_url"
            | "input_image"
            | "image"
            | "input_audio"
            | "audio"
            | "file"
            | "input_file"
            | "video"
            | "document"
    ) || part.get("image_url").is_some()
        || part.get("input_audio").is_some();
    if !is_media {
        return None;
    }
    let url = part["image_url"]["url"]
        .as_str()
        .or_else(|| part["image_url"].as_str())
        .or_else(|| part["url"].as_str());
    Some(
        url.and_then(decode_data_url)
            .unwrap_or(MediaPart::Unscreenable),
    )
}

/// The bytes of a `data:image/...;base64,` URL. Anything else (a remote URL,
/// audio, a malformed URL) is unscreenable.
fn decode_data_url(url: &str) -> Option<MediaPart> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let mime = meta.strip_suffix(";base64")?;
    if !mime.starts_with("image/") {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .ok()?;
    Some(MediaPart::Image(ScreenImage::new(bytes, mime)))
}

fn collect_strings(value: &Value, out: &mut String) {
    match value {
        Value::String(s) => {
            out.push_str(s);
            out.push('\n');
        }
        Value::Array(items) => items.iter().for_each(|v| collect_strings(v, out)),
        Value::Object(map) => map.values().for_each(|v| collect_strings(v, out)),
        _ => {}
    }
}

/// Split segments into items of at most [`CHUNK_CHARS`], overlapping by
/// [`OVERLAP_CHARS`], each with up to [`CONTEXT_CHARS`] of the text before it. Consecutive segments of the same
/// class share an item (many small tool definitions are one item, not one
/// call each); a class change starts a new item.
fn items_for(scope: &[u8], input: &ScreenInput) -> Vec<ScreenItem> {
    let mut runs: Vec<(LeafClass, String)> = Vec::new();
    for segment in &input.segments {
        match runs.last_mut() {
            Some((class, text))
                if *class == segment.class
                    && text.chars().count() + segment.text.chars().count() < CHUNK_CHARS =>
            {
                text.push('\n');
                text.push_str(&segment.text);
            }
            _ => runs.push((segment.class, segment.text.clone())),
        }
    }
    let mut items = Vec::new();
    let mut prior = String::new();
    for (class, run) in &runs {
        let chars: Vec<char> = run.chars().collect();
        let mut start = 0;
        loop {
            let end = chunk_end(&chars, start);
            let last = end == chars.len();
            let step = (end - start).saturating_sub(OVERLAP_CHARS).max(1);
            let text: String = chars[start..end].iter().collect();
            let context = (!prior.is_empty()).then(|| {
                let from = prior
                    .char_indices()
                    .rev()
                    .nth(CONTEXT_CHARS.saturating_sub(1))
                    .map_or(0, |(i, _)| i);
                ryu_gw_screening::context_tail(&prior[from..], CONTEXT_TOKENS)
            });
            let context = context.filter(|c| !c.is_empty());
            // Definitions are tenant-authored schemas shared across requests,
            // so a definition read on its own is keyed in a global scope (spec
            // 02.8). Once it carries an org's conversation as context its
            // score is no longer a property of the definition alone, so it is
            // keyed in the org scope: a score one org's context produced never
            // decides another org's request.
            let key_scope: &[u8] = if *class == LeafClass::Definition && context.is_none() {
                b"definition"
            } else {
                scope
            };
            // The key binds the context the item is classified with, so a
            // segment cached on its own is classified again beside a new
            // prefix (spec 02.8, combination verdict).
            let key = SegmentKey::for_text_in_context(key_scope, *class, &text, context);
            let mut item = ScreenItem::text(key, *class, text.as_str());
            if let Some(context) = context {
                item = item.with_context(context);
            }
            items.push(item);
            // The context of the next chunk is the text before its start, so
            // the overlap is never read twice.
            if last {
                prior.push_str(&text);
                prior.push('\n');
            } else {
                prior.extend(&chars[start..start + step]);
            }
            if prior.len() > CONTEXT_CHARS * 2 {
                let cut = prior.len() - CONTEXT_CHARS;
                let cut = (cut..prior.len())
                    .find(|i| prior.is_char_boundary(*i))
                    .unwrap_or(prior.len());
                prior.drain(..cut);
            }
            if last {
                break;
            }
            start += step;
        }
    }
    items
}

/// Where the chunk that starts at `start` ends: at most [`CHUNK_CHARS`]
/// characters and at most [`CHUNK_TOKENS`] estimated tokens.
fn chunk_end(chars: &[char], start: usize) -> usize {
    let mut end = (start + CHUNK_CHARS).min(chars.len());
    loop {
        let tokens = ryu_gw_screening::estimate_tokens_chars(chars[start..end].iter().copied());
        let len = end - start;
        if tokens <= CHUNK_TOKENS || len <= 1 {
            return end;
        }
        // Keep the share of the chunk the budget allows, at least one fewer
        // character than now, so every pass shrinks and the loop ends.
        let keep = (len as u64 * u64::from(CHUNK_TOKENS) / u64::from(tokens)) as usize;
        end = start + keep.clamp(1, len - 1);
    }
}

/// The highest composed score per code across verdicts.
fn scores_of(verdicts: &[&ChainVerdict]) -> BTreeMap<TaxonomyId, (f32, String)> {
    let mut scores: BTreeMap<TaxonomyId, (f32, String)> = BTreeMap::new();
    for verdict in verdicts {
        for item in &verdict.items {
            for (code, score) in &item.scores {
                let source = item.sources.get(code).cloned().unwrap_or_default();
                let slot = scores.entry(*code).or_insert((*score, source.clone()));
                if *score > slot.0 {
                    *slot = (*score, source);
                }
            }
        }
    }
    scores
}

/// Whether some backend in `role` covers `code`, may decide it under the
/// active policy and has a closed breaker: a hard code it left undecided on
/// this request is then a transient failure, not a coverage gap.
fn healthy_source(active: &ActiveChain, role: Role, code: TaxonomyId) -> bool {
    active.chain.backends(role).iter().any(|backend| {
        let d = backend.descriptor();
        d.covers.contains(code)
            && backend.permits(active.tier)
            && active.policy().may_decide(&d.reference, code, active.tier)
            && breaker_allows(active, d.id())
    })
}

/// Whether the floor's degraded row decides this gateway's text right now:
/// floor tier, and some hard code has no healthy qualified text-hazard
/// backend (an open breaker, or no qualification record in the floor). The
/// regex floor then decides alone, plus the throttle (addendum section 6).
pub fn floor_degraded(state: &AppState) -> bool {
    if state.screening.tier(state.custody) != Some(ScreenTier::Floor) {
        return false;
    }
    let floor_screener = crate::platform_floor::binding_floor(state.custody, &state.platform_floor)
        .and_then(|floor| floor.screener.clone());
    let active = state.screening.active(ScreenTier::Floor, floor_screener);
    let hard = active.policy().hard_set();
    let degraded = hard
        .iter()
        .any(|code| !healthy_source(&active, Role::TextHazard, code));
    degraded
}

/// Whether some backend in `role` may decide `code` at all (qualified at
/// floor tier), whatever its breaker says.
fn qualified_source(active: &ActiveChain, role: Role, code: TaxonomyId) -> bool {
    active.chain.backends(role).iter().any(|backend| {
        let d = backend.descriptor();
        d.covers.contains(code)
            && backend.permits(active.tier)
            && active.policy().may_decide(&d.reference, code, active.tier)
    })
}

fn breaker_allows(active: &ActiveChain, id: &str) -> bool {
    active
        .breakers
        .get(id)
        .is_none_or(|backend| backend.breaker.allows())
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
    let result = run(state, ctx, surface, input, &active).await;
    runtime.publish_transitions(&state.traffic);
    result
}

async fn run(
    state: &AppState,
    ctx: &RequestContext,
    surface: Surface,
    input: ScreenInput,
    active: &ActiveChain,
) -> Result<ScreenReport, GatewayError> {
    let runtime = &state.screening;
    let tier = active.tier;
    let floor = tier == ScreenTier::Floor;
    let screener = &active.screener;
    let mut report = ScreenReport {
        tier: Some(if floor { "floor" } else { "node" }),
        screening_id: new_screening_id(),
        ..ScreenReport::default()
    };
    let layer = if floor {
        ContentBlockLayer::Platform
    } else {
        ContentBlockLayer::Node
    };
    let decided_by = if floor {
        DecidedBy::PlatformFloor
    } else {
        DecidedBy::Node
    };
    let scope = runtime.scope_key(ctx.org_id.as_deref());
    // On the fleet one tenant's items queue on its own gate before the shared
    // one, so a request with hundreds of cache-miss items cannot hold every
    // permit and starve other tenants' screening into their deadlines.
    let share = floor.then(|| {
        runtime.scope_key(Some(
            &ctx.org_id
                .clone()
                .unwrap_or_else(|| crate::audit::credential_log_id(&ctx.api_key)),
        ))
    });
    let deadline = Instant::now() + surface.deadline(screener);

    // Media first, before any backend call: a permanent coverage gap is a
    // 403, an outage of a qualified vision backend a 503 (D11).
    let mut image_items = Vec::new();
    if !input.media.is_empty() {
        let unscreenable = input
            .media
            .iter()
            .any(|m| matches!(m, MediaPart::Unscreenable));
        if floor {
            if unscreenable || !qualified_source(active, Role::Vision, TaxonomyId::S4) {
                return Err(refuse(state, ctx, &report, floor_unscreenable()));
            }
            if !healthy_source(active, Role::Vision, TaxonomyId::S4) {
                return Err(refuse(
                    state,
                    ctx,
                    &report,
                    unavailable("vision_unavailable"),
                ));
            }
        }
        for part in &input.media {
            if let MediaPart::Image(image) = part {
                let key = SegmentKey::for_image(&scope, LeafClass::User, &image.sha256);
                image_items.push(ScreenItem::image(key, LeafClass::User, image.clone()));
            }
        }
        if !floor && active.chain.backends(Role::Vision).is_empty() {
            report.degraded = Some("vision");
            image_items.clear();
        }
    }

    let mut items = items_for(&scope, &input);
    if items.len() > MAX_ITEMS {
        if floor {
            return Err(refuse(
                state,
                ctx,
                &report,
                GatewayError::ScreeningCapacityExceeded,
            ));
        }
        items.truncate(MAX_ITEMS);
    }

    let hazards = CodeSet::hazards();
    let attack = CodeSet::from([TaxonomyId::PROMPT_INJECTION]);
    fn request<'a>(
        correlation_id: &'a str,
        tier: ScreenTier,
        deadline: Instant,
        items: &'a [ScreenItem],
        wanted: &'a CodeSet,
        direction: Direction,
    ) -> ScreenRequest<'a> {
        ScreenRequest {
            correlation_id,
            direction,
            tier,
            items,
            wanted,
            deadline,
        }
    }
    let correlation = ctx.request_id.as_str();
    let text_verdict = if items.is_empty() {
        None
    } else {
        Some(
            active
                .chain
                .screen_for(
                    Role::TextHazard,
                    &request(
                        correlation,
                        tier,
                        deadline,
                        &items,
                        &hazards,
                        surface.direction(),
                    ),
                    share,
                )
                .await,
        )
    };
    // Prompt attack runs after the hazard role, so a backend that serves both
    // (the decision model) answers from the cache the first call filled.
    let attack_verdict = if items.is_empty() || active.chain.backends(Role::PromptAttack).is_empty()
    {
        None
    } else {
        Some(
            active
                .chain
                .screen_for(
                    Role::PromptAttack,
                    &request(
                        correlation,
                        tier,
                        deadline,
                        &items,
                        &attack,
                        surface.direction(),
                    ),
                    share,
                )
                .await,
        )
    };
    // Vision has its own budget, started when the image call starts: a VLM
    // call cannot finish in what the text roles left of the chat deadline, and
    // an image the classifier never answered must not pass (section 6).
    let vision_deadline = Instant::now()
        + surface
            .deadline(screener)
            .max(Surface::Media.deadline(screener));
    let vision_verdict = if image_items.is_empty() {
        None
    } else {
        Some(
            active
                .chain
                .screen_for(
                    Role::Vision,
                    &request(
                        correlation,
                        tier,
                        vision_deadline,
                        &image_items,
                        &hazards,
                        Direction::MediaInput,
                    ),
                    share,
                )
                .await,
        )
    };
    let verdicts: Vec<&ChainVerdict> = [&text_verdict, &attack_verdict, &vision_verdict]
        .into_iter()
        .flatten()
        .collect();
    for verdict in &verdicts {
        for processor in &verdict.processors {
            if !report.processors.contains(processor) {
                report.processors.push(processor.clone());
            }
        }
    }

    // The matrix (spec 02.6.4): Block wins. At ladder L3 the matrix is
    // strict (spec 04.8.1): every flagged code blocks.
    let adult = screener.adult_permitted(input.model.as_deref());
    let strict = floor && crate::enforcement::is_restricted(ctx);
    for (code, (score, source)) in scores_of(&verdicts) {
        let rule = screener.rule(code);
        let action = crate::enforcement::strict(
            rule.decide(score, adult && code == TaxonomyId::S12),
            strict,
        );
        match action {
            CodeAction::Block => report.blocked.push(code),
            CodeAction::Flag => report.flagged.push(code),
            CodeAction::Allow => continue,
        }
        report.detections.push((code, source));
    }
    // One violation event per flagged or blocked code per detector (G5),
    // before any early return so a block still records the flags beside it.
    let mut blocked_event = false;
    for (verdict, scanned, direction) in [
        (&text_verdict, &items, surface.direction()),
        (&attack_verdict, &items, surface.direction()),
        (&vision_verdict, &image_items, Direction::MediaInput),
    ] {
        let Some(verdict) = verdict else {
            continue;
        };
        let detections = super::detections_of(screener, verdict, scanned, adult);
        let recorded = super::record_detections(
            state,
            ctx,
            active,
            &detections,
            &report.blocked,
            crate::audit::EnforcementAction::Blocked,
            direction,
            &report.screening_id,
        );
        // A block outranks a flag recorded by an earlier role.
        let is_block = detections.iter().any(|d| report.blocked.contains(&d.code));
        if report.event_id.is_none() || (is_block && !blocked_event) {
            if recorded.is_some() {
                report.event_id = recorded;
                blocked_event = is_block;
            }
        }
    }
    if !report.blocked.is_empty() {
        let block = ContentBlock {
            layer,
            output: false,
            categories: report.blocked.iter().map(|c| short_code(*c)).collect(),
            screening_id: report.screening_id.clone(),
            charged_micro_usd: None,
        };
        note(state, ctx, decided_by, VerdictAction::Block, &report);
        tracing::warn!(
            request_id = %ctx.request_id,
            categories = ?block.categories,
            tier = report.tier.unwrap_or(""),
            "screening: blocked before dispatch"
        );
        state.metrics.inc_firewall_blocked();
        return Err(GatewayError::ContentBlocked(Box::new(block)));
    }

    // An image a qualified vision backend left undecided (timeout, outage)
    // is never forwarded unscreened: the floor refuses it with a 503, since a
    // qualified source exists and failed this request (section 6). A hard
    // code no qualified vision backend covers is the pre-check's concern.
    let vision_undecided = vision_verdict
        .as_ref()
        .map(|v| {
            v.undecided_hard(active.policy())
                .iter()
                .filter(|code| qualified_source(active, Role::Vision, *code))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !vision_undecided.is_empty() {
        report.degraded = Some("vision");
        if floor {
            return Err(refuse(
                state,
                ctx,
                &report,
                unavailable("vision_unavailable"),
            ));
        }
    }

    // Undecided hard codes: the section 6 fail rules.
    let undecided_hard = text_verdict
        .as_ref()
        .map(|v| v.undecided_hard(active.policy()))
        .unwrap_or_default();
    let undecided_soft = text_verdict
        .as_ref()
        .map(|v| v.undecided().difference(&active.policy().hard_set()))
        .unwrap_or_default();
    if !undecided_hard.is_empty() {
        report.degraded = Some("t2");
        if floor {
            let transient = undecided_hard
                .iter()
                .any(|code| healthy_source(active, Role::TextHazard, code));
            if transient {
                note(state, ctx, decided_by, VerdictAction::Block, &report);
                return Err(unavailable("screener_incomplete"));
            }
            let none_qualified = !undecided_hard
                .iter()
                .all(|code| qualified_source(active, Role::TextHazard, code));
            degraded_alert(
                state,
                if none_qualified {
                    "no_qualified_backend"
                } else {
                    "breaker_open"
                },
            );
            // Media routes stay refused until a qualified backend is back
            // (spec 02.9): a permanent gap is a 403, an outage a 503.
            if surface.is_media() {
                let error = if none_qualified {
                    floor_unscreenable()
                } else {
                    unavailable("screener_degraded")
                };
                return Err(refuse(state, ctx, &report, error));
            }
            // A subject above ladder Warn is refused outright in degraded
            // mode, never served at the degraded rate (spec 02.9).
            if crate::enforcement::is_above_warn(ctx) {
                return Err(refuse(
                    state,
                    ctx,
                    &report,
                    unavailable("screener_degraded"),
                ));
            }
            let subject = ctx
                .org_id
                .clone()
                .unwrap_or_else(|| crate::audit::credential_log_id(&ctx.api_key));
            if let Err(retry_after_secs) = runtime.throttle_request(&ctx.request_id, &subject) {
                return Err(refuse(
                    state,
                    ctx,
                    &report,
                    GatewayError::ScreeningDegradedThrottle { retry_after_secs },
                ));
            }
        }
    } else if !undecided_soft.is_empty() {
        report.degraded = Some("t2");
    }
    if text_verdict.as_ref().is_some_and(|v| {
        v.outcomes
            .iter()
            .any(|o| o.error == Some(ryu_gw_screening::BackendError::Timeout))
    }) && report.degraded.is_some()
    {
        report.degraded = Some("deadline");
    }

    let action = if report.flagged.is_empty() {
        VerdictAction::Allow
    } else {
        VerdictAction::Warn
    };
    if action > VerdictAction::Allow || report.degraded.is_some() {
        note(state, ctx, decided_by, action, &report);
    }
    Ok(report)
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
mod chunk_tests {
    use super::*;
    use ryu_gw_screening::estimate_tokens;

    fn input(text: &str) -> ScreenInput {
        let mut input = ScreenInput::default();
        input.push(LeafClass::User, text);
        input
    }

    /// Token-dense text is cut by estimated tokens, not only by characters, so
    /// no item outruns the engine context; every marker stays whole in some
    /// item, and each item's context stays inside its own budget.
    #[test]
    fn token_dense_text_is_split_to_the_token_budget_without_losing_text() {
        let mut chars: Vec<char> = "\u{754c}".repeat(10_000).chars().collect();
        let markers = [
            ("M0", 0),
            ("M1", 2_040),
            ("M2", 2_047),
            ("M3", 5_000),
            ("M4", 9_990),
        ];
        for (marker, at) in markers {
            for (offset, c) in marker.chars().enumerate() {
                chars[at + offset] = c;
            }
        }
        let text: String = chars.into_iter().collect();
        let items = items_for(&[7; 32], &input(&text));
        assert!(items.len() >= 5, "{}", items.len());
        for item in &items {
            let body = item.text.as_deref().expect("text item");
            assert!(
                estimate_tokens(body) <= CHUNK_TOKENS,
                "{}",
                estimate_tokens(body)
            );
            if let Some(context) = item.context.as_deref() {
                assert!(estimate_tokens(context) <= CONTEXT_TOKENS);
            }
        }
        for (marker, _) in markers {
            assert!(
                items
                    .iter()
                    .any(|i| i.text.as_deref().is_some_and(|t| t.contains(marker))),
                "{marker} is whole in no item"
            );
        }
    }

    /// Prose stays at the character chunk size, so ordinary traffic costs no
    /// extra classifier calls.
    #[test]
    fn prose_keeps_the_character_chunk_size() {
        let prose = "the quick brown fox jumps over the lazy dog ".repeat(450);
        let items = items_for(&[7; 32], &input(&prose));
        let first = items[0].text.as_deref().expect("text item");
        assert_eq!(first.chars().count(), CHUNK_CHARS);
    }
}
