//! Detection lanes: each JSON path's strings joined across frames, as the
//! buffered verdict and a held-whole stream's final step judge them.

use serde_json::Value;

use super::{
    choice_lane, collect_envelope_lanes, collect_sse_payload_lanes,
    collect_sse_payload_lanes_where, odd_index,
};

/// Whether a lane path is an envelope lane `EnvelopeLanes` keeps as runs:
/// any path outside `choices`, or a choice's `stop_reason` / `matched_stop`,
/// `reasoning_details` `format` / `id` / `signature` / `data`, blocklists and
/// protected-material citations (`EnvelopeLanes::observe_choice`).
pub(in crate::pipeline) fn envelope_lane(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/choices/") else {
        // A bare `choices` value is no envelope field `EnvelopeLanes` tracks.
        return path != "/choices";
    };
    // Only the first choice's envelope is tracked (`observe_choice`); other
    // choices' values stay in the joined lanes.
    let Some(("0", rest)) = rest.split_once('/') else {
        return false;
    };
    // Whole path segments, exactly as `observe_choice` records them.
    let under = |rest: &str, key: &str| {
        rest == key
            || rest
                .strip_prefix(key)
                .is_some_and(|tail| tail.starts_with('/'))
    };
    matches!(rest, "stop_reason" | "matched_stop")
        || rest
            .strip_prefix("delta/reasoning_details/")
            .and_then(|rest| rest.split_once('/'))
            .is_some_and(|(_, field)| matches!(field, "format" | "id" | "signature" | "data"))
        || ["content_filter_results/", "content_filter_offsets/"]
            .iter()
            .any(|annotation| {
                rest.strip_prefix(annotation).is_some_and(|rest| {
                    under(rest, "custom_blocklists")
                        || under(rest, "protected_material_code/citation")
                        || under(rest, "protected_material_text/citation")
                })
            })
}

/// Whether a `choices` array entry at `position` may hold a lane
/// `envelope_lane` accepts. It must accept every entry `envelope_lane` could
/// accept a lane under (a superset): that takes lane segment `0` (`~...` for
/// an odd index, else `choice_lane`) and, in an object, a `stop_reason`,
/// `matched_stop`, `content_filter_results` or `content_filter_offsets` key
/// or a `delta` object holding `reasoning_details`.
pub(super) fn may_hold_envelope(entry: &Value, position: usize) -> bool {
    if odd_index(entry) || choice_lane(entry, position) != 0 {
        return false;
    }
    let Some(fields) = entry.as_object() else {
        return true;
    };
    [
        "stop_reason",
        "matched_stop",
        "content_filter_results",
        "content_filter_offsets",
    ]
    .iter()
    .any(|key| fields.contains_key(*key))
        || fields
            .get("delta")
            .and_then(Value::as_object)
            .is_some_and(|delta| delta.contains_key("reasoning_details"))
}

/// Detection lanes over `frames` in order, as `collect_sse_payload_lanes`
/// builds them (`lane_pieces`, joined).
pub(in crate::pipeline) fn detection_lanes<'a>(
    frames: impl IntoIterator<Item = &'a Value>,
    envelope: bool,
) -> std::collections::BTreeMap<String, String> {
    lane_pieces(frames.into_iter().map(|frame| (frame, true)), envelope)
        .into_iter()
        .map(|(path, pieces)| (path, pieces.concat()))
        .collect()
}

/// Each detection lane's pieces, in order (`EnvelopeRuns::feed`), from no
/// earlier frames.
pub(in crate::pipeline) fn lane_pieces<'a>(
    frames: impl IntoIterator<Item = (&'a Value, bool)>,
    envelope: bool,
) -> std::collections::BTreeMap<String, Vec<String>> {
    let mut runs = EnvelopeRuns::default();
    let mut lanes = std::collections::BTreeMap::new();
    for (frame, counts) in frames {
        runs.feed(frame, counts, envelope, Some(&mut lanes));
    }
    lanes
}

struct Last {
    value: String,
    frame: u64,
    repeats: u32,
    segment: usize,
}

/// The envelope run state of the frames seen so far: each envelope lane's
/// last value, where it was seen and how often, as `EnvelopeLanes::push`
/// keeps it. A stream seeds it with its released frames, so a held-whole
/// final step joins envelope values exactly as a scan of every frame does.
#[derive(Default)]
pub(in crate::pipeline) struct EnvelopeRuns {
    last: std::collections::BTreeMap<String, Last>,
    frame: u64,
}

/// Envelope lanes an `EnvelopeRuns` keeps; past it new lanes start fresh
/// (an envelope that large is overflowed and masked whole anyway).
const MAX_RUNS: usize = 4096;

impl EnvelopeRuns {
    /// Feed one frame. It counts as a new provider frame only when `counts`
    /// (the answer half of a split provider frame continues the reasoning
    /// half's). Its detection lane pieces go to `lanes`, when given:
    /// non-envelope lanes always; envelope lanes (`envelope_lane`) only when
    /// `envelope` (an unmatched or overflowed envelope, judged by these lanes
    /// instead of `EnvelopeLanes`). There they follow `EnvelopeLanes::push`:
    /// an empty value adds nothing, a repeat joins once, and a new value
    /// continues the lane only when the value before was seen in exactly the
    /// frame before (a split candidate); otherwise it starts a lane of its
    /// own.
    pub(in crate::pipeline) fn feed(
        &mut self,
        frame: &Value,
        counts: bool,
        envelope: bool,
        mut lanes: Option<&mut std::collections::BTreeMap<String, Vec<String>>>,
    ) {
        if counts {
            self.frame += 1;
        }
        let frame_number = self.frame;
        let mut own = std::collections::BTreeMap::new();
        if lanes.is_some() {
            collect_sse_payload_lanes(frame, "", &mut own);
        } else {
            // Without `lanes` only envelope lanes have any effect below.
            collect_envelope_lanes(frame, &mut own);
            // The pruned walk must collect exactly what the full one does.
            debug_assert!({
                let mut full = std::collections::BTreeMap::new();
                collect_sse_payload_lanes_where(frame, "", &mut full, envelope_lane);
                full == own
            });
        }
        if let Some(lanes) = lanes.as_deref_mut() {
            let mut tokens = std::collections::BTreeMap::new();
            super::token_sequences(frame, &mut tokens);
            for (path, text) in tokens {
                lanes.entry(path).or_default().push(text);
            }
        }
        for (path, text) in own {
            if !envelope_lane(&path) {
                // Token mirrors are never joined across frames.
                if super::token_mirror_lane(&path) {
                    continue;
                }
                if let Some(lanes) = lanes.as_deref_mut() {
                    lanes.entry(path).or_default().push(text);
                }
                continue;
            }
            if text.is_empty() {
                continue;
            }
            if let Some(previous) = self.last.get_mut(&path) {
                if previous.value == text {
                    previous.repeats += 1;
                    previous.frame = frame_number;
                    continue;
                }
            }
            let segment = match self.last.get(&path) {
                Some(previous) if previous.repeats == 1 && previous.frame + 1 == frame_number => {
                    previous.segment
                }
                Some(previous) => previous.segment + 1,
                None => 0,
            };
            if envelope {
                if let Some(lanes) = lanes.as_deref_mut() {
                    let key = if segment == 0 {
                        path.clone()
                    } else {
                        format!("{path}\u{1}{segment}")
                    };
                    lanes.entry(key).or_default().push(text.clone());
                }
            }
            if self.last.contains_key(&path) || self.last.len() < MAX_RUNS {
                self.last.insert(
                    path,
                    Last {
                        value: text,
                        frame: frame_number,
                        repeats: 1,
                        segment,
                    },
                );
            }
        }
    }

    /// A copy to continue from (the stream's released frames, then its held
    /// ones).
    pub(in crate::pipeline) fn snapshot(&self) -> Self {
        Self {
            last: self
                .last
                .iter()
                .map(|(path, last)| {
                    (
                        path.clone(),
                        Last {
                            value: last.value.clone(),
                            frame: last.frame,
                            repeats: last.repeats,
                            segment: last.segment,
                        },
                    )
                })
                .collect(),
            frame: self.frame,
        }
    }
}
