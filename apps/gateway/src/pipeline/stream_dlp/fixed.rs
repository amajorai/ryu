//! The released tail of fixed protocol fields (`delta.role`,
//! `finish_reason`, a content filter's `severity`, ...). Their values are
//! never part of the scan text, but the buffered lanes join each field across
//! frames, so a released `assistant` followed by a held `@example.com` is one
//! lane there: the final checks seed what each path already sent.

use std::collections::BTreeMap;

use serde_json::Value;

use super::StreamingDlp;

/// Bytes of each fixed path's released text kept: protocol words are short,
/// and a match joining them needs only the characters right before the join.
const FIXED_TAIL: usize = 256;

/// Fixed paths tracked per stream; real responses carry a handful.
const FIXED_PATHS: usize = 64;

/// The last path segment of every `fixed_path` suffix.
const FIXED_KEYS: [&str; 5] = [
    "role",
    "finish_reason",
    "native_finish_reason",
    "severity",
    "type",
];

/// Whether a lane path is a fixed protocol field.
pub(super) fn fixed_path(path: &str) -> bool {
    [
        "/delta/role",
        "/finish_reason",
        "/native_finish_reason",
        "/severity",
        "/reasoning_details/0/type",
    ]
    .iter()
    .any(|suffix| path.ends_with(suffix))
}

/// Whether some object entry directly holds a string under a `FIXED_KEYS`
/// key. A fixed lane is a string leaf whose last path segment is one of
/// them, and an array entry's segment (digits or `~...`) or an escaped key
/// equals one only for that very key, so without such an entry the frame
/// has no fixed lane (`"finish_reason": null` is no string leaf).
pub(super) fn has_fixed_leaf(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields.iter().any(|(key, value)| match value {
            Value::String(_) => FIXED_KEYS.contains(&key.as_str()),
            value => has_fixed_leaf(value),
        }),
        Value::Array(values) => values.iter().any(has_fixed_leaf),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => false,
    }
}

impl StreamingDlp {
    /// Record a released frame's fixed protocol fields.
    pub(super) fn record_fixed(&mut self, frame: &Value) {
        if !has_fixed_leaf(frame) {
            // The skipped walk would have found no fixed lane.
            debug_assert!({
                let mut lanes = BTreeMap::new();
                super::super::collect_sse_payload_lanes_where(frame, "", &mut lanes, fixed_path);
                lanes.is_empty()
            });
            return;
        }
        let mut lanes = BTreeMap::new();
        super::super::collect_sse_payload_lanes_where(frame, "", &mut lanes, fixed_path);
        for (path, text) in lanes {
            if !fixed_path(&path) {
                continue;
            }
            // Bounded per stream: past the cap the rest is held whole, but
            // this frame is going out now, so its value is still kept (one
            // release batch past the cap, bounded by the held limit).
            if !self.released_fixed.contains_key(&path) && self.released_fixed.len() >= FIXED_PATHS
            {
                self.buffer_remaining = true;
            }
            let kept = self.released_fixed.entry(path).or_default();
            kept.push_str(&text);
            if kept.len() > FIXED_TAIL {
                let mut cut = kept.len() - FIXED_TAIL;
                while !kept.is_char_boundary(cut) {
                    cut += 1;
                }
                kept.drain(..cut);
            }
        }
    }

    /// The released fixed fields, as `(path, text)` seeds for a lane map.
    pub(super) fn fixed_seeds(&self) -> impl Iterator<Item = (String, String)> + '_ {
        self.released_fixed
            .iter()
            .map(|(path, text)| (path.clone(), text.clone()))
    }

    /// The held frames, each with whether it counts as a new provider frame
    /// (the answer half continues the reasoning half's), and the released
    /// frames' envelope runs to continue from.
    fn held_runs(&self) -> (Vec<(&Value, bool)>, super::super::EnvelopeRuns) {
        let mut previous_half = self.released_half;
        let held = self
            .held
            .iter()
            .map(|frame| {
                let counts = !previous_half;
                previous_half = frame.reasoning_half;
                (&frame.value, counts)
            })
            .collect();
        (held, self.released_runs.snapshot())
    }

    /// The held frames' detection lane pieces, continued from the released
    /// frames' envelope runs so the hold's start does not change how
    /// envelope values join (`EnvelopeRuns::feed`).
    pub(super) fn held_envelope_pieces(
        &self,
        envelope: bool,
        pieces: &mut BTreeMap<String, Vec<String>>,
    ) {
        let (held, mut runs) = self.held_runs();
        for (frame, counts) in held {
            runs.feed(frame, counts, envelope, Some(pieces));
        }
    }

    /// The lanes a held-whole stream's final step judges: released text that
    /// continues a lane, then the held frames' lanes. Also the held envelope
    /// pieces, built with `judged_by_lanes` (so `held_envelope_pieces(true)`
    /// whenever the envelope is unmatched).
    pub(super) fn final_lanes(&self) -> (BTreeMap<String, String>, BTreeMap<String, Vec<String>>) {
        let mut lanes = BTreeMap::new();
        // The released text continues its own field's lane only.
        lanes.extend(self.fixed_seeds());
        if let Some((path, raw, _)) = self.released_lane(None) {
            lanes.insert(path, raw);
        }
        // A field that resumed after another continues its whole
        // released text.
        for (path, raw, _) in self.fields.seeds() {
            lanes.insert(path, raw);
        }
        // Envelope lanes only when the envelope is judged by these lanes,
        // continued from the released frames' envelope runs so the hold's
        // start does not change how envelope values join.
        let envelope = self.envelope.judged_by_lanes();
        let mut held = BTreeMap::new();
        self.held_envelope_pieces(envelope, &mut held);
        for (path, pieces) in &held {
            let joined: String = pieces.concat();
            lanes.entry(path.clone()).or_default().push_str(&joined);
        }
        // Each other choice's text (all of it held), keyed to sort before the
        // token-sequence (`\u{2}tokens/`) and path (`/`) lanes, so choice
        // texts are judged first, as on the buffered path. An envelope key
        // (`/path\u{1}N`) starts with `/`, so none collides.
        for (lane, text) in self.fields.choices.texts() {
            lanes.insert(format!("\u{1}choice/{lane}"), text.to_owned());
        }
        (lanes, held)
    }
}
