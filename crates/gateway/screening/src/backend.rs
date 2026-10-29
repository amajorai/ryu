//! The `ScreenerBackend` trait and the verdict types every backend returns
//! (screener addendum section 3).
//!
//! A backend turns text or image items into per-code scores on the shared
//! taxonomy. The model's own allow, flag or block answer is recorded as
//! [`ModelSignal`] for audit only: the floor matrix decides the action from
//! the scores, so a cached score stays valid when the floor changes.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Instant;

use sha2::{Digest, Sha256};

pub use ryu_gw_firewall::taxonomy::TaxonomyId;

use crate::cache::SegmentKey;

/// Which way the screened content travels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Direction {
    Inbound,
    Outbound,
    ToolArgs,
    ToolResult,
    MediaInput,
    MediaOutput,
}

impl Direction {
    pub const fn as_str(self) -> &'static str {
        match self {
            Direction::Inbound => "inbound",
            Direction::Outbound => "outbound",
            Direction::ToolArgs => "tool_args",
            Direction::ToolResult => "tool_result",
            Direction::MediaInput => "media_input",
            Direction::MediaOutput => "media_output",
        }
    }

    /// Whether the content was produced by the model rather than sent to it.
    pub const fn is_output(self) -> bool {
        matches!(self, Direction::Outbound | Direction::MediaOutput)
    }
}

/// The position class of a projected segment (spec 02.5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum LeafClass {
    User,
    Assistant,
    System,
    ToolResult,
    ToolArgs,
    Definition,
    Freeform,
    Decoded,
}

impl LeafClass {
    pub const fn as_str(self) -> &'static str {
        match self {
            LeafClass::User => "user",
            LeafClass::Assistant => "assistant",
            LeafClass::System => "system",
            LeafClass::ToolResult => "tool_result",
            LeafClass::ToolArgs => "tool_args",
            LeafClass::Definition => "definition",
            LeafClass::Freeform => "freeform",
            LeafClass::Decoded => "decoded",
        }
    }
}

/// Which policy tier the screen runs for. A remote processor checks this
/// before it sends anything (section 4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ScreenTier {
    /// A self-hosted node's own opt-in classifiers. Never bound by Ryu's floor.
    Node,
    /// Ryu's platform floor (Fleet custody, floor-bound attempts).
    Floor,
}

/// A set of taxonomy codes, ordered for stable output.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodeSet(BTreeSet<TaxonomyId>);

impl CodeSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every MLCommons hazard code, `hazard.S1` to `hazard.S14`.
    pub fn hazards() -> Self {
        TaxonomyId::HAZARDS.into_iter().collect()
    }

    pub fn insert(&mut self, id: TaxonomyId) -> bool {
        self.0.insert(id)
    }

    pub fn contains(&self, id: TaxonomyId) -> bool {
        self.0.contains(&id)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn iter(&self) -> impl Iterator<Item = TaxonomyId> + '_ {
        self.0.iter().copied()
    }

    pub fn union(&self, other: &CodeSet) -> CodeSet {
        self.0.union(&other.0).copied().collect()
    }

    pub fn intersection(&self, other: &CodeSet) -> CodeSet {
        self.0.intersection(&other.0).copied().collect()
    }

    pub fn difference(&self, other: &CodeSet) -> CodeSet {
        self.0.difference(&other.0).copied().collect()
    }

    pub fn is_subset(&self, other: &CodeSet) -> bool {
        self.0.is_subset(&other.0)
    }
}

impl FromIterator<TaxonomyId> for CodeSet {
    fn from_iter<I: IntoIterator<Item = TaxonomyId>>(iter: I) -> Self {
        Self(iter.into_iter().collect())
    }
}

impl<const N: usize> From<[TaxonomyId; N]> for CodeSet {
    fn from(ids: [TaxonomyId; N]) -> Self {
        ids.into_iter().collect()
    }
}

/// The exact image bytes that will be forwarded, with their sha256.
#[derive(Debug, Clone)]
pub struct ScreenImage {
    pub bytes: Arc<[u8]>,
    pub mime: String,
    pub sha256: [u8; 32],
}

impl ScreenImage {
    pub fn new(bytes: impl Into<Arc<[u8]>>, mime: impl Into<String>) -> Self {
        let bytes = bytes.into();
        let sha256 = Sha256::digest(&bytes).into();
        Self {
            bytes,
            mime: mime.into(),
            sha256,
        }
    }
}

/// A conservative token estimate for `chars`, in whole tokens, with no
/// tokenizer: the classifier engines differ and the gateway holds none. Prose
/// costs about a quarter token per letter. A long unbroken alphanumeric run
/// (hex, base64, a minified identifier) costs half a token per character,
/// punctuation half a token and any non-ASCII character a whole token, which
/// is what CJK text and emoji cost. It is the unit `max_item_tokens` is
/// enforced in.
pub fn estimate_tokens_chars(chars: impl IntoIterator<Item = char>) -> u32 {
    /// Alphanumeric runs longer than this are token-dense.
    const DENSE_RUN: u64 = 12;
    fn run_quarters(len: u64) -> u64 {
        if len > DENSE_RUN {
            len * 2
        } else {
            len
        }
    }
    let mut quarters: u64 = 0;
    let mut run: u64 = 0;
    for c in chars {
        if c.is_ascii_alphanumeric() {
            run += 1;
            continue;
        }
        quarters += run_quarters(run);
        run = 0;
        if c.is_ascii_whitespace() {
            continue;
        }
        quarters += if c.is_ascii() { 2 } else { 4 };
    }
    quarters += run_quarters(run);
    u32::try_from(quarters.div_ceil(4)).unwrap_or(u32::MAX)
}

/// [`estimate_tokens_chars`] for a string.
pub fn estimate_tokens(text: &str) -> u32 {
    estimate_tokens_chars(text.chars())
}

impl ScreenItem {
    /// Estimated tokens the backend prompt carries for this item: its text
    /// plus its context.
    pub fn estimated_tokens(&self) -> u32 {
        let text = self.text.as_deref().map_or(0, estimate_tokens);
        let context = self.context.as_deref().map_or(0, estimate_tokens);
        text.saturating_add(context)
    }

    /// This item with its context cut from the front until the text and
    /// context fit `max_tokens`. `None` when the text alone does not fit: the
    /// engine would truncate or fail it, so it is never sent.
    pub fn fitted_to(&self, max_tokens: u32) -> Option<ScreenItem> {
        let text = self.text.as_deref().map_or(0, estimate_tokens);
        if text > max_tokens {
            return None;
        }
        let Some(context) = self.context.as_deref() else {
            return Some(self.clone());
        };
        let room = max_tokens - text;
        if estimate_tokens(context) <= room {
            return Some(self.clone());
        }
        let mut fitted = self.clone();
        let tail = context_tail(context, room);
        fitted.context = (!tail.is_empty()).then(|| Arc::from(tail));
        Some(fitted)
    }
}

/// The longest suffix of `text` estimated at no more than `max_tokens`.
pub fn context_tail(text: &str, max_tokens: u32) -> &str {
    let mut from = 0;
    let mut total = estimate_tokens(text);
    while total > max_tokens {
        let chars = text[from..].chars().count();
        if chars == 0 {
            break;
        }
        // Keep the share of the remaining chars the budget allows, at least
        // one fewer than now, so every pass shrinks and the loop ends.
        let keep = (chars as u64 * u64::from(max_tokens) / u64::from(total)) as usize;
        let keep = keep.min(chars - 1);
        let cut = text[from..]
            .char_indices()
            .nth(chars - keep)
            .map_or(text.len(), |(i, _)| from + i);
        from = cut;
        total = estimate_tokens(&text[from..]);
    }
    &text[from..]
}

/// One unit of content to screen.
#[derive(Debug, Clone)]
pub struct ScreenItem {
    /// Keyed segment hash (spec 02.8), used to join results and key the cache.
    pub key: SegmentKey,
    pub class: LeafClass,
    pub text: Option<Arc<str>>,
    /// Up to 2,048 tokens of conversation before the segment.
    pub context: Option<Arc<str>>,
    pub image: Option<ScreenImage>,
}

impl ScreenItem {
    pub fn text(key: SegmentKey, class: LeafClass, text: impl Into<Arc<str>>) -> Self {
        Self {
            key,
            class,
            text: Some(text.into()),
            context: None,
            image: None,
        }
    }

    pub fn with_context(mut self, context: impl Into<Arc<str>>) -> Self {
        self.context = Some(context.into());
        self
    }

    pub fn image(key: SegmentKey, class: LeafClass, image: ScreenImage) -> Self {
        Self {
            key,
            class,
            text: None,
            context: None,
            image: Some(image),
        }
    }
}

/// One batch sent to one backend.
#[derive(Debug, Clone, Copy)]
pub struct ScreenRequest<'a> {
    /// Request-scoped id. Never a tenant, org, credential or end-user id.
    pub correlation_id: &'a str,
    pub direction: Direction,
    pub tier: ScreenTier,
    /// At most the backend's `max_batch` items.
    pub items: &'a [ScreenItem],
    /// Codes the caller needs a verdict on for this surface.
    pub wanted: &'a CodeSet,
    /// The remaining surface budget. A backend never extends it.
    pub deadline: Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BackendKind {
    GuardModel,
    DecisionLocal,
    DecisionRemote,
    Inspector,
    Test,
}

impl BackendKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            BackendKind::GuardModel => "guard_model",
            BackendKind::DecisionLocal => "decision_local",
            BackendKind::DecisionRemote => "decision_remote",
            BackendKind::Inspector => "inspector",
            BackendKind::Test => "test",
        }
    }
}

/// Where a backend runs, which decides whether a third party sees content.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Locality {
    Loopback,
    PrivateNetwork,
    RemoteProcessor { processor_id: String },
}

impl Locality {
    pub fn is_remote(&self) -> bool {
        matches!(self, Locality::RemoteProcessor { .. })
    }

    pub fn processor_id(&self) -> Option<&str> {
        match self {
            Locality::RemoteProcessor { processor_id } => Some(processor_id),
            _ => None,
        }
    }
}

/// The identity of one backend build: what a qualification record and a
/// cache entry are pinned to.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct BackendRef {
    pub id: String,
    pub kind: BackendKind,
    pub model: String,
    pub weights_sha256: Option<String>,
    pub template_version: u32,
}

impl BackendRef {
    /// `backend_id@model@weights_sha256[0..8]#template_version` (section 7.3).
    /// A changed model, weights or template never reuses old scores.
    pub fn cache_scope(&self) -> String {
        let sha = self
            .weights_sha256
            .as_deref()
            .map(|s| s.get(..8).unwrap_or(s))
            .unwrap_or("-");
        format!(
            "{}@{}@{}#{}",
            self.id, self.model, sha, self.template_version
        )
    }

    /// The `ViolationEvent` detector version: `model@sha8#t<template>`.
    pub fn detector_version(&self) -> String {
        let sha = self
            .weights_sha256
            .as_deref()
            .map(|s| s.get(..8).unwrap_or(s))
            .unwrap_or("-");
        format!("{}@{}#t{}", self.model, sha, self.template_version)
    }
}

/// Static facts about a backend.
#[derive(Debug, Clone)]
pub struct BackendDescriptor {
    pub reference: BackendRef,
    pub locality: Locality,
    pub text: bool,
    pub images: bool,
    /// Codes it can positively detect, from its dialect table.
    pub covers: CodeSet,
    pub max_batch: usize,
    pub max_item_tokens: u32,
    /// The tier's hard timeout (spec 02.7). Each call uses
    /// `min(hard_timeout_ms, deadline remaining)`.
    pub hard_timeout_ms: u32,
    /// Concurrent calls this replica sends (llama-server `--parallel N`).
    pub max_concurrency: usize,
}

impl BackendDescriptor {
    pub fn id(&self) -> &str {
        &self.reference.id
    }
}

/// What the model itself said. Audit only; the floor matrix decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ModelSignal {
    Allow,
    Flag,
    Block,
}

/// How the scores were obtained.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfidenceSource {
    Logprob,
    ProbabilityMap,
    Fixed,
}

/// One item's answer from one backend.
#[derive(Debug, Clone, PartialEq)]
pub struct ItemVerdict {
    pub key: SegmentKey,
    /// 0.0 to 1.0, only for codes in `covered`.
    pub scores: Vec<(TaxonomyId, f32)>,
    /// Codes this answer speaks to. An absent code means no opinion.
    pub covered: CodeSet,
    pub model_signal: ModelSignal,
    pub confidence: ConfidenceSource,
}

impl ItemVerdict {
    pub fn score(&self, code: TaxonomyId) -> Option<f32> {
        self.scores
            .iter()
            .find_map(|(id, score)| (*id == code).then_some(*score))
    }
}

/// One backend's answer for one batch.
#[derive(Debug, Clone)]
pub struct BackendVerdict {
    pub backend: BackendRef,
    /// Same order as the request.
    pub items: Vec<ItemVerdict>,
    pub latency_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BackendError {
    #[error("timeout")]
    Timeout,
    /// Refused, 5xx, 429 busy, redirect, or a judge that did not answer.
    #[error("unavailable: {0}")]
    Unavailable(&'static str),
    /// Output outside the closed grammar. Treated as down (spec 02.9).
    #[error("malformed")]
    Malformed,
    /// Admission bucket empty (spec 02.6.3).
    #[error("over capacity")]
    OverCapacity,
    /// A remote processor without a recorded retention term or node opt-in.
    #[error("not permitted")]
    NotPermitted,
}

/// Readiness from a probe. Never on the request path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendHealth {
    Ready,
    Down(&'static str),
    NotPermitted,
}

#[async_trait::async_trait]
pub trait ScreenerBackend: Send + Sync {
    fn descriptor(&self) -> &BackendDescriptor;

    async fn screen(&self, req: &ScreenRequest<'_>) -> Result<BackendVerdict, BackendError>;

    /// Whether this backend may answer for `tier` at all. A remote processor
    /// without its permit for the tier is absent: the chain checks this before
    /// the segment cache, so scores cached under another tier's permit never
    /// decide this one. `screen` still enforces the same rule on its own.
    fn permits(&self, _tier: ScreenTier) -> bool {
        true
    }

    /// Cheap readiness probe for the breaker and the admin status route.
    async fn probe(&self) -> BackendHealth;
}

/// Clamp a probability into a score, refusing non-finite values.
pub(crate) fn checked_score(p: f64) -> Result<f32, BackendError> {
    if p.is_finite() && (0.0..=1.0 + 1e-9).contains(&p) {
        Ok(p.clamp(0.0, 1.0) as f32)
    } else {
        Err(BackendError::Malformed)
    }
}

/// Milliseconds since `start`, saturating.
pub(crate) fn elapsed_ms(start: Instant) -> u32 {
    u32::try_from(start.elapsed().as_millis()).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(sha: Option<&str>, template: u32) -> BackendRef {
        BackendRef {
            id: "guard_text".into(),
            kind: BackendKind::GuardModel,
            model: "llama-guard-3-8b".into(),
            weights_sha256: sha.map(str::to_string),
            template_version: template,
        }
    }

    #[test]
    fn cache_scope_pins_model_weights_and_template() {
        let a = reference(Some("0123456789abcdef"), 1);
        assert_eq!(a.cache_scope(), "guard_text@llama-guard-3-8b@01234567#1");
        assert_ne!(
            a.cache_scope(),
            reference(Some("0123456789abcdef"), 2).cache_scope()
        );
        assert_ne!(
            a.cache_scope(),
            reference(Some("ffff456789abcdef"), 1).cache_scope()
        );
        assert_eq!(
            reference(None, 1).cache_scope(),
            "guard_text@llama-guard-3-8b@-#1"
        );
        assert_eq!(a.detector_version(), "llama-guard-3-8b@01234567#t1");
    }

    #[test]
    fn code_set_operations() {
        let a = CodeSet::from([TaxonomyId::S4, TaxonomyId::S9]);
        let b = CodeSet::from([TaxonomyId::S9, TaxonomyId::S1]);
        assert_eq!(a.intersection(&b), CodeSet::from([TaxonomyId::S9]));
        assert_eq!(a.difference(&b), CodeSet::from([TaxonomyId::S4]));
        assert_eq!(a.union(&b).len(), 3);
        assert_eq!(CodeSet::hazards().len(), 14);
    }

    #[test]
    fn checked_score_refuses_out_of_range() {
        assert_eq!(checked_score(0.5), Ok(0.5));
        assert!(checked_score(f64::NAN).is_err());
        assert!(checked_score(1.5).is_err());
        assert!(checked_score(-0.1).is_err());
    }
}

#[cfg(test)]
mod token_tests {
    use super::*;

    fn item(text: &str, context: Option<&str>) -> ScreenItem {
        let key = SegmentKey::for_text(b"org", LeafClass::User, text);
        let item = ScreenItem::text(key, LeafClass::User, text.to_string());
        match context {
            Some(context) => item.with_context(context.to_string()),
            None => item,
        }
    }

    #[test]
    fn estimates_follow_how_dense_the_text_is() {
        let prose = "the quick brown fox jumps over the lazy dog ".repeat(180);
        assert!(
            estimate_tokens(&prose) < 2_048,
            "{}",
            estimate_tokens(&prose)
        );
        assert!(estimate_tokens(&"\u{754c}".repeat(3_000)) >= 3_000);
        assert!(estimate_tokens(&"deadbeef".repeat(500)) >= 2_000);
        assert!(estimate_tokens("{}[]();,.:!?") >= 6);
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn an_item_whose_text_exceeds_the_limit_does_not_fit() {
        let dense = item(&"\u{754c}".repeat(5_000), None);
        assert!(dense.fitted_to(4_096).is_none());
        assert!(item("short", None).fitted_to(4_096).is_some());
    }

    #[test]
    fn context_is_cut_from_the_front_to_leave_the_text_its_room() {
        let context: String = (0..4_000)
            .map(|n| char::from(b'a' + (n % 26) as u8))
            .collect();
        let text = "t".repeat(400);
        let fitted = item(&text, Some(&context))
            .fitted_to(1_000)
            .expect("text fits");
        assert!(fitted.estimated_tokens() <= 1_000);
        let kept = fitted.context.expect("some context remains");
        assert!(
            context.ends_with(&*kept),
            "the end nearest the text is kept"
        );
        assert!(kept.len() < context.len());
        // Text that leaves no room drops the context altogether.
        let full = item(&"\u{754c}".repeat(950), Some("prior"))
            .fitted_to(950)
            .expect("fits");
        assert!(full.context.is_none());
    }

    #[test]
    fn context_tail_never_splits_a_character_and_always_ends() {
        let text = "\u{754c}".repeat(1_000);
        let tail = context_tail(&text, 300);
        assert!(estimate_tokens(tail) <= 300);
        assert!(!tail.is_empty());
        assert_eq!(context_tail("fits", 100), "fits");
        assert_eq!(context_tail(&text, 0), "");
    }
}
