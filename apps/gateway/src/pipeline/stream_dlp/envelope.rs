//! Provider envelope strings: frame fields outside `choices` (`id`, `model`,
//! `system_fingerprint`, OpenAI's per-chunk `obfuscation` padding, ...), and
//! the provider strings inside a choice that are not text (`reasoning_details`
//! `format` / `id`, Azure custom blocklist ids).
//!
//! Each frame's envelope strings are redacted on their own with the rest of
//! the frame. A value split across several frames' envelope fields would slip
//! past that, and an envelope field has no whitespace boundary to release on,
//! so:
//!
//! - `obfuscation` is random padding that only equalizes chunk sizes; it is
//!   replaced with filler of the same length ([`normalize_padding`]) and so
//!   carries nothing.
//! - `id` is left out: some OpenAI-compatible servers issue a fresh id per
//!   chunk, and holding those streams whole would disable streaming for them.
//!   Each id is still redacted and scanned with its own frame.
//! - Every other field normally repeats one value (`model`, ...). A field
//!   whose value appears in one frame and changes in the very next could
//!   carry a split value, so the stream is held whole from then on
//!   ([`EnvelopeLanes::observe`]) and those values are checked complete at
//!   the end: scanned for violations, and masked where the joined values
//!   redact differently than each value on its own.

use std::collections::BTreeMap;

use serde_json::Value;

use super::redact::Transform;
use crate::firewall::{FirewallBackend, FirewallMatch};

mod runs;

/// The top-level padding field providers add to equalize chunk sizes.
const PADDING_FIELD: &str = "obfuscation";

/// Replace the provider's random padding with filler of the same length.
pub(in crate::pipeline) fn normalize_padding(frame: &mut Value) {
    match frame.get_mut(PADDING_FIELD) {
        Some(Value::String(padding)) => {
            let filler = "x".repeat(padding.len());
            *padding = filler;
        }
        // Not padding as providers send it: drop whatever it carries.
        Some(other) => *other = Value::Null,
        None => {}
    }
}

/// `key` as one JSON-pointer reference token (RFC 6901).
pub(in crate::pipeline) fn pointer_token(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

/// Envelope paths tracked per stream (`EnvelopeLanes::push`).
const MAX_LANES: usize = 4096;

/// One value an envelope field kept over consecutive frames.
struct Run {
    value: String,
    repeats: usize,
    last_frame: u64,
    /// Runs that can carry one split value share a segment (see `push`).
    segment: u64,
}

#[derive(Default)]
pub(in crate::pipeline) struct EnvelopeLanes {
    lanes: BTreeMap<String, Vec<Run>>,
    frame: u64,
    segments: u64,
    varying: bool,
    fresh: bool,
    /// A path the buffered lanes name differently (`unmatched_path`).
    unmatched: bool,
    /// More paths than [`MAX_LANES`]: some went untracked, so a split value
    /// there cannot be told apart and every envelope string is masked.
    overflowed: bool,
    /// With `unmatched`: an envelope lane as the buffered path names it
    /// redacts differently joined (`judge_unmatched`), so every envelope
    /// string is masked.
    unmatched_lane_changes: bool,
}

/// Whether an unmatched stream's lane is envelope rather than a choice's
/// text (its delta, message or choice-level `text` copy) or a mirror of it
/// (token sequences, token mirrors), which the per-string fail-closed mask
/// covers instead.
fn envelope_piece(path: &str) -> bool {
    let choice_text = path
        .strip_prefix("/choices/")
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(_, rest)| {
            rest == "text" || rest.starts_with("delta/") || rest.starts_with("message/")
        });
    path.starts_with('/')
        && !path.contains("/delta/")
        && !choice_text
        && !super::super::token_mirror_lane(path)
}

impl EnvelopeLanes {
    /// Record a frame's envelope strings. `true` once a field has carried
    /// distinct values in consecutive frames (a possible split value): the
    /// stream must then be held whole.
    pub(in crate::pipeline) fn observe(&mut self, frame: &Value) -> bool {
        self.frame += 1;
        // A frame that is not an object has no envelope this tracks: its
        // strings are judged by the buffered lanes and masked whole.
        if !frame.is_object() {
            self.unmatched = true;
            self.overflowed = true;
        }
        if let Some(fields) = frame.as_object() {
            let mut path = String::new();
            for (key, value) in fields {
                if !matches!(key.as_str(), "choices" | PADDING_FIELD | "id") {
                    path.clear();
                    path.push('/');
                    super::super::push_pointer_token(&mut path, key);
                    self.collect(value, &mut path);
                }
            }
        }
        // Only the entry at position 0 is tracked; the lanes name it by its
        // index, so any other layout is judged by the buffered lanes.
        if let Some(choices) = frame.get("choices").and_then(Value::as_array) {
            for (position, entry) in choices.iter().enumerate() {
                let lane_zero = !super::super::odd_index(entry)
                    && super::super::choice_lane(entry, position) == 0;
                self.unmatched |= lane_zero != (position == 0);
            }
        }
        if let Some(choice) = super::lanes::choice_zero(frame) {
            self.observe_choice(choice);
        }
        self.varying || self.unmatched
    }

    /// The provider strings a simple frame may carry inside its choice:
    /// OpenRouter's `reasoning_details` `format` / `id` / `signature` /
    /// `data`, and Azure's custom
    /// blocklist ids. They are not part of the scan text, so they are lanes
    /// like the top-level fields.
    fn observe_choice(&mut self, choice: &Value) {
        for (key, path) in [
            ("stop_reason", "/choices/0/stop_reason"),
            ("matched_stop", "/choices/0/matched_stop"),
        ] {
            if let Some(text) = choice.get(key).and_then(Value::as_str) {
                self.push(path, text);
            }
        }
        // Not an array (an object keyed "0"): its lanes are named like array
        // entries but not tracked here, so the buffered lanes judge them.
        let details = choice.get("delta").and_then(|d| d.get("reasoning_details"));
        if details.is_some_and(|d| !d.is_null() && !d.is_array()) {
            self.unmatched = true;
        }
        if let Some(details) = details.and_then(Value::as_array) {
            for (index, entry) in details.iter().enumerate() {
                self.unmatched |= super::super::choice_lane(entry, index) != index as u64
                    || super::super::odd_index(entry);
                for field in ["format", "id", "signature", "data"] {
                    if let Some(text) = entry.get(field).and_then(Value::as_str) {
                        self.push(
                            &format!("/choices/0/delta/reasoning_details/{index}/{field}"),
                            text,
                        );
                    }
                }
            }
        }
        for annotation in ["content_filter_results", "content_filter_offsets"] {
            let Some(node) = choice.get(annotation) else {
                continue;
            };
            if let Some(lists) = node.get("custom_blocklists") {
                self.collect(
                    lists,
                    &mut format!("/choices/0/{annotation}/custom_blocklists"),
                );
            }
            for material in ["protected_material_code", "protected_material_text"] {
                if let Some(citation) = node.get(material).and_then(|m| m.get("citation")) {
                    self.collect(
                        citation,
                        &mut format!("/choices/0/{annotation}/{material}/citation"),
                    );
                }
            }
        }
    }

    /// Runs kept across every lane (tests).
    #[cfg(test)]
    pub(in crate::pipeline) fn retained_runs(&self) -> usize {
        self.lanes.values().map(Vec::len).sum()
    }

    /// Every tracked lane path, in order (tests).
    #[cfg(test)]
    pub(in crate::pipeline) fn lane_paths(&self) -> Vec<&str> {
        self.lanes.keys().map(String::as_str).collect()
    }

    /// With `unmatched`, judge the envelope lanes the buffered path names
    /// (`detection_lanes` over `frames`): any outside the delta text that
    /// redacts differently joined than in pieces masks every envelope string.
    pub(in crate::pipeline) fn judge_unmatched<'a>(
        &mut self,
        frames: impl IntoIterator<Item = (&'a Value, bool)>,
        transform: &Transform<'_>,
        mut seed: super::super::EnvelopeRuns,
    ) {
        if !self.unmatched {
            return;
        }
        let mut pieces = BTreeMap::new();
        for (frame, counts) in frames {
            seed.feed(frame, counts, true, Some(&mut pieces));
        }
        self.judge_pieces(&pieces, transform);
    }

    /// `judge_unmatched` over lane pieces already built.
    pub(in crate::pipeline) fn judge_pieces(
        &mut self,
        pieces: &BTreeMap<String, Vec<String>>,
        transform: &Transform<'_>,
    ) {
        if !self.unmatched {
            return;
        }
        self.unmatched_lane_changes = pieces.iter().any(|(path, pieces)| {
            let joined = pieces.concat();
            let whole = transform.apply(&joined);
            envelope_piece(path)
                && whole != joined
                && whole
                    != pieces
                        .iter()
                        .map(|piece| transform.apply(piece))
                        .collect::<String>()
        });
    }

    /// Whether `judge_unmatched` found an unmatched envelope lane that
    /// redacts differently joined.
    pub(in crate::pipeline) fn unmatched_changes(&self) -> bool {
        self.unmatched_lane_changes
    }

    /// Whether a path the buffered lanes name differently was seen
    /// (`judge_pieces` judges nothing otherwise).
    pub(in crate::pipeline) fn unmatched(&self) -> bool {
        self.unmatched
    }

    /// Whether a path the buffered lanes name differently was seen, or the
    /// path cap was hit: the envelope is then judged by the buffered lanes.
    pub(in crate::pipeline) fn judged_by_lanes(&self) -> bool {
        self.unmatched || self.overflowed
    }

    /// Whether the path cap left some envelope paths untracked.
    pub(in crate::pipeline) fn overflowed(&self) -> bool {
        self.overflowed
    }

    pub(in crate::pipeline) fn varying(&self) -> bool {
        self.varying
    }

    /// Whether the last observed frame introduced a value. Such a frame waits
    /// for the next one: if the field then continues it, the stream is held
    /// whole before the first part goes out.
    pub(in crate::pipeline) fn take_fresh(&mut self) -> bool {
        std::mem::take(&mut self.fresh)
    }

    /// Each field's runs grouped into split candidates of two or more values.
    fn joined_segments(&self) -> impl Iterator<Item = (&String, Vec<&Run>)> {
        self.lanes.iter().flat_map(|(path, runs)| {
            runs.chunk_by(|a, b| a.segment == b.segment)
                .filter(|group| group.len() > 1)
                .map(move |group| (path, group.iter().collect()))
        })
    }

    /// A violation in a split candidate's joined values.
    pub(in crate::pipeline) fn scan(&self, scanner: &dyn FirewallBackend) -> Option<FirewallMatch> {
        self.joined_segments()
            .find_map(|(_, runs)| scanner.scan_outbound(&joined(&runs)))
    }

    /// Fields with a split candidate whose joined values redact differently
    /// than each value on its own: a protected value split across frames.
    pub(in crate::pipeline) fn split_paths(&self, transform: &Transform<'_>) -> Vec<String> {
        if self.overflowed {
            return vec![EVERY_FIELD.to_owned()];
        }
        if self.unmatched && self.unmatched_lane_changes {
            return vec![EVERY_FIELD.to_owned()];
        }
        let mut paths: Vec<String> = self
            .joined_segments()
            .filter(|(_, runs)| {
                let joined = joined(runs);
                let whole = transform.apply(&joined);
                whole != joined
                    && whole
                        != runs
                            .iter()
                            .map(|run| transform.apply(&run.value).repeat(run.repeats))
                            .collect::<String>()
            })
            .map(|(path, _)| path.clone())
            .collect();
        paths.dedup();
        paths
    }

    /// Replace the strings at `paths` in a raw `frame` with `[REDACTED]`.
    pub(in crate::pipeline) fn mask(frame: &mut Value, paths: &[String]) {
        if paths.iter().any(|path| path == EVERY_FIELD) {
            mask_envelope(frame);
            return;
        }
        for path in paths {
            if let Some(Value::String(text)) = frame.pointer_mut(path) {
                "[REDACTED]".clone_into(text);
            }
        }
    }
}

/// The split path that stands for every envelope string (`overflowed`).
const EVERY_FIELD: &str = "*";

/// Mask every envelope string of a frame: its top-level fields (but the
/// choices, `id` and padding), and the first choice's envelope lanes
/// (`observe_choice`). An array frame masks each element.
fn mask_envelope(frame: &mut Value) {
    if let Value::Array(frames) = frame {
        frames.iter_mut().for_each(mask_envelope);
        return;
    }
    if let Some(fields) = frame.as_object_mut() {
        for (key, value) in fields.iter_mut() {
            if !matches!(key.as_str(), "choices" | "id" | PADDING_FIELD) {
                mask_strings(value);
            }
        }
    }
    let Some(choice) = super::lanes::choice_zero_mut(frame) else {
        return;
    };
    for key in ["stop_reason", "matched_stop"] {
        if let Some(Value::String(text)) = choice.get_mut(key) {
            "[REDACTED]".clone_into(text);
        }
    }
    let details = choice
        .get_mut("delta")
        .and_then(|d| d.get_mut("reasoning_details"));
    if let Some(Value::Array(details)) = details {
        for entry in details {
            for field in ["format", "id", "signature", "data"] {
                if let Some(Value::String(text)) = entry.get_mut(field) {
                    "[REDACTED]".clone_into(text);
                }
            }
        }
    }
    for annotation in ["content_filter_results", "content_filter_offsets"] {
        let Some(annotation) = choice.get_mut(annotation) else {
            continue;
        };
        if let Some(lists) = annotation.get_mut("custom_blocklists") {
            mask_strings(lists);
        }
        for material in ["protected_material_code", "protected_material_text"] {
            let citation = annotation
                .get_mut(material)
                .and_then(|m| m.get_mut("citation"));
            if let Some(citation) = citation {
                mask_strings(citation);
            }
        }
    }
}

fn mask_strings(value: &mut Value) {
    match value {
        Value::String(text) => "[REDACTED]".clone_into(text),
        Value::Array(values) => values.iter_mut().for_each(mask_strings),
        Value::Object(fields) => fields.values_mut().for_each(mask_strings),
        _ => {}
    }
}

fn joined(runs: &[&Run]) -> String {
    runs.iter()
        .map(|run| run.value.repeat(run.repeats))
        .collect()
}

/// For a whole buffered payload (raw frames): normalize the padding field and
/// mask the envelope fields that carry a value split across frames, before the
/// frames are redacted.
/// `provider` holds the frames as the provider sent them (before a reasoning
/// / answer split), each observed once and whole, as the stream observes them.
pub(in crate::pipeline) fn prepare_buffered(
    frames: &mut [Value],
    transform: &Transform<'_>,
    provider: &[Value],
) {
    for frame in frames.iter_mut() {
        normalize_padding(frame);
    }
    let mut lanes = EnvelopeLanes::default();
    for frame in provider {
        lanes.observe(frame);
    }
    lanes.judge_unmatched(
        provider.iter().map(|frame| (frame, true)),
        transform,
        super::super::EnvelopeRuns::default(),
    );
    let split = if lanes.varying() || lanes.overflowed() || lanes.unmatched_changes() {
        lanes.split_paths(transform)
    } else {
        Vec::new()
    };
    if !split.is_empty() {
        for frame in frames {
            EnvelopeLanes::mask(frame, &split);
        }
    }
}
