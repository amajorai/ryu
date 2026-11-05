//! Text-level redaction of streamed content deltas.
//!
//! Providers stream one to a few characters per delta, so a secret or PII
//! value almost always spans several frames. Redacting each delta string on
//! its own never matches the split value, and replacing every string in the
//! affected frames (the old fail-closed fallback) wiped whole answers to
//! `[REDACTED][REDACTED]…`.
//!
//! Instead, the outbound transform runs once over the concatenated content
//! text (with its scan context), and the result is mapped back onto frame
//! boundaries. The mapping is never inferred: every kept boundary is marked
//! with a distinct private-use sentinel, the transform runs again over the
//! marked text, and the split is accepted only if each sentinel survives
//! exactly once, in order, and removing them reproduces the unmarked result.
//! A match crossing a boundary would absorb or break its sentinel and fail
//! that check, so the frames on both sides are merged into one segment. When
//! no verified split exists, the caller falls back to masking.

use std::cell::OnceCell;
use std::collections::HashSet;

use serde_json::Value;

use crate::firewall::FirewallBackend;

pub(in crate::pipeline) use super::frames::{apply_segments, content_eligible};
pub(super) use super::junction::word_start;
use super::spans::replaced_spans;
pub(in crate::pipeline) use super::spans::{sanitize_folded, sanitize_text};
pub(super) use sentinel::RegionCache;
use sentinel::{is_sentinel, sentinel, verified_split, SENTINEL_COUNT};

pub(super) mod sentinel;

/// Placeholder prefix both `sanitize` and `redact_outbound` emit.
pub(super) const PLACEHOLDER: &str = "[REDACTED";
/// Candidate release prefixes verified before falling back to the mask.
const MAX_PREFIX_ATTEMPTS: usize = 4;
/// Envelope strings and keys repeat on every frame; cap the memo per stream.
const MAX_CACHED: usize = 64;

/// The outbound transform for one stream: always `redact_outbound`, plus
/// `sanitize` once a Sanitize violation has been seen. Matches the per-string
/// path (`redact_json_strings`, then `sanitize_json_strings`).
pub(in crate::pipeline) struct Transform<'a> {
    scanner: &'a dyn FirewallBackend,
    sanitize: bool,
    cache: Vec<(String, Option<String>)>,
}

/// `apply_cached` entries carried across releases; valid only for the
/// scanner and Sanitize flag they were computed with.
#[derive(Default)]
pub(in crate::pipeline) struct EnvelopeMemo {
    scanner: usize,
    sanitize: bool,
    cache: Vec<(String, Option<String>)>,
}

impl EnvelopeMemo {
    /// Strings memoized (tests).
    #[cfg(test)]
    pub(super) fn cached(&self) -> usize {
        self.cache.len()
    }
}

impl<'a> Transform<'a> {
    pub(in crate::pipeline) fn new(scanner: &'a dyn FirewallBackend, sanitize: bool) -> Self {
        Self {
            scanner,
            sanitize,
            cache: Vec::new(),
        }
    }

    /// The outbound scrub, or under Sanitize the fail-closed Sanitize rewrite
    /// every JSON string gets (`sanitize_text_closed`): a match only the scan
    /// view shows (a zero-width split, a fullwidth `＠`) is folded and
    /// rewritten, or masked, so it never passes as redacted.
    pub(in crate::pipeline) fn apply(&self, text: &str) -> String {
        if self.sanitize {
            super::super::sanitize_text_closed(self.scanner, text)
        } else {
            self.scanner.redact_outbound(text).0
        }
    }

    /// Swap the envelope memo in or out, first dropping it if it was
    /// computed for another scanner or flag (or a zero-sized scanner, whose
    /// address says nothing).
    pub(super) fn swap_memo(&mut self, memo: &mut EnvelopeMemo) {
        let scanner = std::ptr::from_ref(self.scanner).cast::<()>() as usize;
        if memo.scanner != scanner
            || memo.sanitize != self.sanitize
            || std::mem::size_of_val(self.scanner) == 0
        {
            *memo = EnvelopeMemo {
                scanner,
                sanitize: self.sanitize,
                cache: Vec::new(),
            };
        }
        std::mem::swap(&mut self.cache, &mut memo.cache);
    }

    /// The transform of `text`, or `None` when it leaves `text` unchanged
    /// (the common case, which then allocates nothing).
    fn apply_cached(&mut self, text: &str) -> Option<String> {
        // A stream repeats a handful of keys and envelope values on every
        // frame; a short linear scan beats hashing each of them.
        if let Some((_, hit)) = self.cache.iter().find(|(seen, _)| seen == text) {
            // A memo kept across releases must still be `apply` exactly.
            debug_assert!({
                let out = self.apply(text);
                *hit == (out != text).then_some(out)
            });
            return hit.clone();
        }
        let out = self.apply(text);
        let changed = (out != text).then_some(out);
        if self.cache.len() >= MAX_CACHED {
            self.cache.clear();
        }
        self.cache.push((text.to_owned(), changed.clone()));
        changed
    }

    /// Rewrite every string value and object key of `value` except
    /// `choices[*].delta.content`, which the caller sets from the text-level
    /// result. Same coverage as `redact_json_strings` / `sanitize_json_strings`.
    pub(in crate::pipeline) fn envelope(&mut self, value: &mut Value) {
        self.walk(value, Lane::Frame);
    }

    fn walk(&mut self, value: &mut Value, lane: Lane) {
        match value {
            Value::String(text) => {
                if lane != Lane::Content {
                    if let Some(rewritten) = self.apply_cached(text) {
                        *text = rewritten;
                    }
                }
            }
            Value::Array(values) => {
                let next = if lane == Lane::Choices {
                    Lane::Choice
                } else {
                    Lane::Other
                };
                for value in values {
                    self.walk(value, next);
                }
            }
            Value::Object(values) => {
                let mut renamed = Vec::new();
                for key in values.keys() {
                    if let Some(rewritten) = self.apply_cached(key) {
                        renamed.push((key.clone(), rewritten));
                    }
                }
                if !renamed.is_empty() {
                    for (key, field) in std::mem::take(values) {
                        let key = renamed
                            .iter()
                            .find(|(from, _)| *from == key)
                            .map_or(key, |(_, to)| to.clone());
                        values.insert(key, field);
                    }
                }
                for (key, field) in values.iter_mut() {
                    let next = match (lane, key.as_str()) {
                        (Lane::Frame, "choices") => Lane::Choices,
                        (Lane::Choice, "delta") => Lane::Delta,
                        (Lane::Delta, key) if super::super::DELTA_TEXT_KEYS.contains(&key) => {
                            Lane::Content
                        }
                        _ => Lane::Other,
                    };
                    self.walk(field, next);
                }
            }
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Lane {
    Frame,
    Choices,
    Choice,
    Delta,
    Content,
    Other,
}

/// Transformed text for each span between consecutive `bounds` (absolute
/// offsets, ascending, inside `region_start..region_start + region.len()`).
/// When a match crosses an inner boundary the spans on both sides merge: the
/// merged text is returned for the first span and the others are empty.
/// Fewer segments than spans means only that prefix may be released now (the
/// later bounds sit inside a replaced value); an empty result releases
/// nothing. `None` when the first boundary is crossed or no verified split
/// exists; the caller must then mask the frames.
pub(in crate::pipeline) fn split_transformed(
    region: &str,
    region_start: usize,
    bounds: &[usize],
    transform: &Transform<'_>,
) -> Option<Vec<String>> {
    split_transformed_with(region, region_start, bounds, transform, &OnceCell::new())
}

/// [`split_transformed`] with `whole` caching `transform.apply(region)`,
/// valid for this exact `region` and `transform` only.
pub(in crate::pipeline) fn split_transformed_with(
    region: &str,
    region_start: usize,
    bounds: &[usize],
    transform: &Transform<'_>,
    whole: &OnceCell<String>,
) -> Option<Vec<String>> {
    let cache = RegionCache::new(whole);
    split_transformed_cached(region, region_start, bounds, transform, &cache)
}

/// [`split_transformed`] with `cache` holding what this exact `region` and
/// `transform` give every split: `T(region)`, its replaced spans, the
/// sentinels in the region and the marked transforms.
pub(super) fn split_transformed_cached(
    region: &str,
    region_start: usize,
    bounds: &[usize],
    transform: &Transform<'_>,
    cache: &RegionCache<'_>,
) -> Option<Vec<String>> {
    let local: Vec<usize> = bounds
        .iter()
        .map(|bound| bound.checked_sub(region_start))
        .collect::<Option<_>>()?;
    if local.len() < 2
        || local.windows(2).any(|pair| pair[0] > pair[1])
        || local.last().is_some_and(|last| *last > region.len())
        || local.iter().any(|bound| !region.is_char_boundary(*bound))
    {
        return None;
    }
    // A first bound inside a word (a release that ended mid-token): its
    // sentinel would add a word boundary the joined text does not have, so
    // split from the word's start and drop its already-sent part, which must
    // come out unchanged.
    // When that fails (the word's sent part was rewritten, by a rule with no
    // word boundary), split at the bound itself: still exactly verified.
    let first = local[0];
    let start = word_start(region, first);
    if start < first {
        let mut shifted = bounds.to_vec();
        shifted[0] = region_start + start;
        if let Some(mut segments) =
            split_transformed_cached(region, region_start, &shifted, transform, cache)
        {
            let Some(head) = segments.first_mut() else {
                return Some(segments);
            };
            if let Some(rest) = head.strip_prefix(&region[start..first]) {
                *head = rest.to_owned();
                return Some(segments);
            }
        }
    }
    let whole: &str = cache.whole.get_or_init(|| transform.apply(region));
    if whole == region {
        return Some(
            local
                .windows(2)
                .map(|pair| region[pair[0]..pair[1]].to_owned())
                .collect(),
        );
    }
    // Sentinels never collide with the text: private-use characters already in
    // the region are skipped when the alphabet is chosen.
    let present = cache.present.get_or_init(|| sentinel::sentinels_in(region));
    debug_assert!(
        *present
            == region
                .chars()
                .filter(|c| is_sentinel(*c))
                .collect::<HashSet<_>>()
    );
    let alphabet: Vec<char> = (0..SENTINEL_COUNT)
        .map(sentinel)
        .filter(|character| !present.contains(character))
        .take(local.len())
        .collect();
    if alphabet.len() < local.len() {
        return None;
    }
    let split = |local: &[usize], keep: &[bool]| {
        verified_split(region, local, keep, whole, transform, &alphabet, cache)
    };
    if let Some(split) = split(&local, &vec![true; local.len()]) {
        return Some(split);
    }
    // The release cut may fall inside a value that is already complete in the
    // region. Release only up to a boundary outside every replaced span (the
    // rest is held until the cut passes the value), dropping the inner
    // boundaries a span crosses. The spans are an alignment hint, so the
    // longest few candidate prefixes are each verified in turn.
    let spans = cache.spans.get_or_init(|| replaced_spans(region, whole));
    debug_assert!(*spans == replaced_spans(region, whole));
    let Some(spans) = spans.as_deref() else {
        let mut keep = vec![false; local.len()];
        keep[0] = true;
        keep[local.len() - 1] = true;
        return split(&local, &keep);
    };
    let inside = |bound: &usize| {
        spans
            .iter()
            .any(|(start, end)| start < bound && bound < end)
    };
    if inside(&local[0]) {
        return None;
    }
    // Failing that, a release does not stop right at a value's end either
    // (but at the region end): unbounded classes (`[^&\s"']`) take that
    // bound's sentinel in, so it is held until a later bound and goes out
    // with the text after it.
    // Likewise a bound whose sentinel would change a word boundary a match
    // relies on (`word_start`): a frame ending there waits for a later bound.
    let holds = |bound: &usize| {
        inside(bound)
            || (*bound < region.len()
                && (word_start(region, *bound) != *bound
                    || spans
                        .iter()
                        .any(|(start, end)| start < bound && bound == end)))
    };
    let modes: [&dyn Fn(&usize) -> bool; 2] = [&inside, &holds];
    for held in modes {
        let candidates = (1..local.len())
            .rev()
            .filter(|index| !held(&local[*index]))
            .take(MAX_PREFIX_ATTEMPTS);
        for last in candidates {
            let prefix = &local[..=last];
            let mut keep: Vec<bool> = prefix.iter().map(|bound| !held(bound)).collect();
            keep[0] = true;
            // Each split skipped below repeats one that returned `None`: the
            // all-kept split of the whole region, or the split just above.
            let repeat = last == local.len() - 1 && keep.iter().all(|kept| *kept);
            if !repeat {
                if let Some(found) = split(prefix, &keep) {
                    return Some(found);
                }
            }
            // One segment for the whole prefix.
            if keep[1..last].iter().any(|kept| *kept) {
                for flag in &mut keep[1..last] {
                    *flag = false;
                }
                if let Some(found) = split(prefix, &keep) {
                    return Some(found);
                }
            }
        }
    }
    // No boundary after the first lies outside a value: hold everything.
    (1..local.len())
        .all(|index| holds(&local[index]))
        .then(Vec::new)
}

/// Text-level rewrite of a whole buffered SSE payload (an array of frames). Applied only when every frame is a
/// simple content delta; `false` leaves `payload` untouched for the caller's
/// per-string path.
pub(in crate::pipeline) fn rewrite_frames(
    payload: &mut Value,
    scanner: &dyn FirewallBackend,
    sanitize: bool,
    provider: &[Value],
) -> bool {
    let Some(frames) = payload.as_array() else {
        return false;
    };
    if !frames.iter().all(text_level_frame) {
        return false;
    }
    let mut transform = Transform::new(scanner, sanitize);
    let mut prepared = frames.clone();
    super::envelope::prepare_buffered(&mut prepared, &transform, provider);
    let Some(rewritten) = rewrite_prepared(frames, prepared, &mut transform) else {
        return false;
    };
    *payload = Value::Array(rewritten);
    true
}

/// Whether a buffered frame can be rewritten at text level: a simple
/// content delta whose content field can be set from a segment.
pub(in crate::pipeline) fn text_level_frame(frame: &Value) -> bool {
    super::super::simple_content_delta(frame) && content_eligible(frame)
}

/// The text-level rewrite of `originals` (frames `text_level_frame`
/// accepts), applied to `prepared`: the same frames after
/// `prepare_buffered`, which a caller runs once over a whole payload.
/// `None` when no verified split exists or a delta field would not come out
/// as the transform of the whole field.
pub(in crate::pipeline) fn rewrite_prepared(
    originals: &[Value],
    mut rewritten: Vec<Value>,
    transform: &mut Transform<'_>,
) -> Option<Vec<Value>> {
    let (scan_text, ends, separated) = super::super::sse_scan_text(originals);
    let mut bounds = Vec::with_capacity(ends.len() + 1);
    bounds.push(0);
    bounds.extend(ends);
    let segments = split_transformed(&scan_text, 0, &bounds, transform)?;
    let raw_fields = delta_fields(&rewritten);
    for frame in &mut rewritten {
        transform.envelope(frame);
        if transform.sanitize {
            super::super::drop_choice_logprobs(frame);
        }
    }
    if !apply_segments(&mut rewritten, segments, &separated) {
        return None;
    }
    // Token mirrors can run ahead of their frame's text (vLLM holds back a
    // stop string's length of text, not its ids): once anything changed,
    // every frame's mirrors go, as on the non-stream path.
    if rewritten
        .iter()
        .zip(originals)
        .any(|(frame, original)| frame != original)
    {
        for frame in &mut rewritten {
            super::super::drop_choice_logprobs(frame);
        }
    }
    // Each delta text field is one string in a non-streamed response, also
    // when another field interrupts it (interleaved thinking): it must come
    // out as the transform of the whole field.
    let sent_fields = delta_fields(&rewritten);
    raw_fields
        .iter()
        .zip(&sent_fields)
        .all(|(raw, sent)| transform.apply(raw) == *sent)
        .then_some(rewritten)
}

/// Each delta text field's text across `frames`, in `DELTA_TEXT_KEYS` order,
/// then the copies providers keep of it (`mirror.rs`).
pub(super) fn delta_fields(frames: &[Value]) -> Vec<String> {
    let fields = super::super::DELTA_TEXT_KEYS.map(|key| vec!["choices", "0", "delta", key]);
    fields
        .into_iter()
        .chain(COPY_TOKENS.map(<[&str]>::to_vec))
        .map(|tokens| {
            frames
                .iter()
                .filter_map(|frame| {
                    tokens
                        .iter()
                        .try_fold(frame, |value, token| super::lanes::step(value, token))
                        .and_then(Value::as_str)
                })
                .collect()
        })
        .collect()
}

/// The tokens of `mirror::{TEXT_COPY, DETAILS_COPY, SUMMARY_COPY}`.
pub(super) const COPY_TOKENS: [&[&str]; 3] = [
    &["choices", "0", "text"],
    &["choices", "0", "delta", "reasoning_details", "0", "text"],
    &["choices", "0", "delta", "reasoning_details", "0", "summary"],
];
