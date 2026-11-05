//! How envelope strings become runs: the walk that names each string by its
//! path, and the per-path run list it extends.

use std::fmt::Write as _;

use serde_json::Value;

use super::{EnvelopeLanes, Run, MAX_LANES};

impl EnvelopeLanes {
    /// Every string under `value`, keyed by `path` plus its JSON-pointer
    /// segments. Each child appends its segment to `path` and truncates it
    /// back, so `path` always equals the `format!("{path}/{segment}")` form.
    pub(super) fn collect(&mut self, value: &Value, path: &mut String) {
        match value {
            Value::String(text) => self.push(path, text),
            Value::Array(values) => {
                for (index, value) in values.iter().enumerate() {
                    // The buffered lanes name an entry by its own `index`
                    // (`choice_lane`): where that differs from its position,
                    // values one lane joins would never meet here, so the
                    // stream is held whole and judged by the buffered lanes.
                    self.unmatched |= crate::pipeline::choice_lane(value, index) != index as u64
                        || crate::pipeline::odd_index(value);
                    let len = path.len();
                    path.push('/');
                    let _ = write!(path, "{index}");
                    self.collect(value, path);
                    path.truncate(len);
                }
            }
            Value::Object(fields) => {
                for (key, value) in fields {
                    let len = path.len();
                    path.push('/');
                    crate::pipeline::push_pointer_token(path, key);
                    self.collect(value, path);
                    path.truncate(len);
                }
            }
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
        }
    }

    /// A value continues the previous one as a possible split only when that
    /// value appeared in exactly one frame, the frame just before this one.
    /// That is what the incremental path can still catch: a frame introducing
    /// a value is held until the next frame arrives (`take_fresh`), and a
    /// value that repeats, or a field that skips a frame, has been released
    /// by then. The buffered path uses the same definition.
    pub(super) fn push(&mut self, path: &str, text: &str) {
        // An empty value carries nothing (Azure's first chunk sends "" for
        // `model` / `object` before the real values).
        if text.is_empty() {
            return;
        }
        let frame = self.frame;
        if let Some(runs) = self.lanes.get_mut(path) {
            extend_runs(
                runs,
                text,
                frame,
                &mut self.segments,
                &mut self.varying,
                &mut self.fresh,
            );
            return;
        }
        // Bounded per stream: past the cap a field is not tracked and the
        // stream is held whole (then bounded by the held-bytes limit and
        // judged by the buffered lanes at the end). The path is copied only
        // when its lane is created.
        if self.lanes.len() >= MAX_LANES {
            self.unmatched = true;
            self.overflowed = true;
            return;
        }
        let runs = self.lanes.entry(path.to_owned()).or_default();
        extend_runs(
            runs,
            text,
            frame,
            &mut self.segments,
            &mut self.varying,
            &mut self.fresh,
        );
    }
}

/// Extend one lane's runs with `text`, seen in `frame` (`EnvelopeLanes::push`
/// over its disjoint fields).
fn extend_runs(
    runs: &mut Vec<Run>,
    text: &str,
    frame: u64,
    segments: &mut u64,
    varying: &mut bool,
    fresh: &mut bool,
) {
    if let Some(last) = runs.last_mut() {
        if last.value == text {
            last.repeats += 1;
            last.last_frame = frame;
            return;
        }
    }
    let joins = runs
        .last()
        .filter(|last| last.repeats == 1 && last.last_frame + 1 == frame)
        .map(|last| last.segment);
    let segment = joins.unwrap_or_else(|| {
        *segments += 1;
        *segments
    });
    *varying |= joins.is_some();
    // A run alone in its segment can never join a split candidate once
    // another value follows it (only the last run is ever joined): drop
    // it, so a field changing value every other frame keeps no history.
    if joins.is_none() {
        let len = runs.len();
        let alone = len >= 1 && (len < 2 || runs[len - 2].segment != runs[len - 1].segment);
        if alone {
            runs.pop();
        }
    }
    runs.push(Run {
        value: text.to_owned(),
        repeats: 1,
        last_frame: frame,
        segment,
    });
    *fresh = true;
}
