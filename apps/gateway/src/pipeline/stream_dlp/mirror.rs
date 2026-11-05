//! Copies of a delta text field that providers put elsewhere in a frame:
//! Together's choice-level `text`, OpenRouter's `reasoning_details` text and
//! vLLM's `reasoning` next to `reasoning_content`.
//!
//! A client builds each copy as its own string from the frames that carry
//! it. The scan text holds the copied field once, so a copy is covered only
//! while it copies every text frame of one field. Once it skips a frame or
//! follows another field it can join text the scan keeps apart: the stream
//! is then held whole, and at the end the copy is judged as a lane of its
//! own, seeded with the copies already released (kept like a field's
//! history, see `lanes::Fields`).

use serde_json::Value;

use super::lanes::step;

/// Where a frame carries the Together copy, and OpenRouter's (one entry, at
/// index 0, see `reasoning_mirror`).
pub(super) const TEXT_COPY: &str = "/choices/0/text";
pub(super) const DETAILS_COPY: &str = "/choices/0/delta/reasoning_details/0/text";
/// OpenRouter's `reasoning.summary` entry (OpenAI reasoning models).
pub(super) const SUMMARY_COPY: &str = "/choices/0/delta/reasoning_details/0/summary";

/// One copy's consistency so far.
#[derive(Default)]
struct Copy {
    /// The field every copy so far followed.
    followed: Option<&'static str>,
    /// Fields whose text frames came without a copy before any copy.
    plain_before: Vec<&'static str>,
    broken: bool,
}

impl Copy {
    /// `key`: the field of the frame's text (if any) and that text; `copy`:
    /// the frame's non-empty copy, if any.
    fn observe(&mut self, key: Option<(&'static str, &str)>, copy: Option<&str>) {
        if self.broken {
            return;
        }
        self.broken = match (key, copy, self.followed) {
            // A copy that differs from the text it copies.
            (Some((_, text)), Some(copy), _) if copy != text => true,
            (Some((key, _)), Some(_), None) => {
                self.followed = Some(key);
                self.plain_before.contains(&key)
            }
            (Some((key, _)), Some(_), Some(followed)) => key != followed,
            // A frame of the followed field without its copy is a skip; a
            // frame of another field is not (the copy never carried it).
            (Some((key, _)), None, Some(followed)) => key == followed,
            (None, Some(_), _) => true,
            (Some((key, _)), None, None) => {
                if !self.plain_before.contains(&key) {
                    self.plain_before.push(key);
                }
                false
            }
            (None, None, _) => false,
        };
    }
}

#[derive(Default)]
pub(super) struct Mirrors {
    text: Copy,
    details: Copy,
    summary: Copy,
    /// vLLM's `reasoning` repeating `reasoning_content` in the same frame.
    pair: Copy,
}

/// The string `value` holds, if it is a non-empty one.
fn non_empty(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// What `frame.pointer` reads at `/choices/0`, `…/delta` and
/// `…/delta/reasoning_details`, read once per frame.
pub(super) struct Slots<'a> {
    frame: &'a Value,
    choice: Option<&'a Value>,
    delta: Option<&'a Value>,
    details: Option<&'a Value>,
}

impl<'a> Slots<'a> {
    pub(super) fn of(frame: &'a Value) -> Self {
        let choice = super::lanes::choice_zero(frame);
        let delta = choice.and_then(|choice| step(choice, "delta"));
        let details = delta.and_then(|delta| step(delta, "reasoning_details"));
        Self {
            frame,
            choice,
            delta,
            details,
        }
    }

    /// `frame.pointer(path)`; a path other than the three copies is read
    /// with `pointer`.
    pub(super) fn value(&self, path: &str) -> Option<&'a Value> {
        let entry = || self.details.and_then(|details| step(details, "0"));
        match path {
            TEXT_COPY => self.choice.and_then(|choice| step(choice, "text")),
            DETAILS_COPY => entry().and_then(|entry| step(entry, "text")),
            SUMMARY_COPY => entry().and_then(|entry| step(entry, "summary")),
            _ => self.frame.pointer(path),
        }
    }

    /// A non-empty string at `path` in the frame.
    fn text(&self, path: &str) -> Option<&'a str> {
        non_empty(self.value(path))
    }

    /// A non-empty string at `/choices/0/delta/<key>`.
    pub(super) fn delta_text(&self, key: &str) -> Option<&'a str> {
        non_empty(self.delta.and_then(|delta| step(delta, key)))
    }
}

/// `frame.pointer(path)`, with the copy paths read without `pointer`.
pub(super) fn copy_value<'a>(frame: &'a Value, path: &str) -> Option<&'a Value> {
    Slots::of(frame).value(path)
}

impl Mirrors {
    /// Record a first-choice frame (`fields` is `lanes::text_fields(frame)`);
    /// `true` once either copy is broken.
    pub(super) fn observe(
        &mut self,
        frame: &Value,
        fields: &[(&'static str, &str)],
        key: Option<&'static str>,
    ) -> bool {
        debug_assert_eq!(fields, super::lanes::text_fields(frame).as_slice());
        // Judged against the field it follows, wherever that sits in the
        // frame (a frame can carry several fields; `key` is the first).
        let slots = Slots::of(frame);
        let followed = self
            .text
            .followed
            .and_then(|followed| fields.iter().copied().find(|(field, _)| *field == followed));
        let first = key.and_then(|key| fields.iter().copied().find(|(field, _)| *field == key));
        self.text.observe(followed.or(first), slots.text(TEXT_COPY));
        let reasoning = slots.delta_text("reasoning");
        // The copies are read at array position 0; the buffered lanes name an
        // entry by its own `index`, so an entry out of position joins them
        // there unseen here: give the copies up (their history is then judged
        // whole, `Fields::seeds`).
        let misplaced = slots
            .details
            .and_then(Value::as_array)
            .is_some_and(|entries| {
                entries.iter().enumerate().any(|(position, entry)| {
                    super::super::choice_lane(entry, position) != position as u64
                        || super::super::odd_index(entry)
                })
            });
        if misplaced {
            self.details.broken = true;
            self.summary.broken = true;
        }
        for (copy, path) in [
            (&mut self.details, DETAILS_COPY),
            (&mut self.summary, SUMMARY_COPY),
        ] {
            copy.observe(reasoning.map(|text| ("reasoning", text)), slots.text(path));
        }
        // A `reasoning` frame without `reasoning_content` (Groq, OpenRouter)
        // is a field of its own (`lanes::Fields`), not part of the pair.
        let reasoning_content = slots.delta_text("reasoning_content");
        self.pair.observe(
            reasoning_content.map(|text| ("reasoning_content", text)),
            reasoning_content.and(reasoning),
        );
        self.broken()
    }

    /// Give up on both copies (a frame whose first choice is ambiguous).
    pub(super) fn break_all(&mut self) {
        self.text.broken = true;
        self.details.broken = true;
        self.summary.broken = true;
        self.pair.broken = true;
    }

    pub(super) fn broken(&self) -> bool {
        self.text.broken || self.details.broken || self.summary.broken || self.pair.broken
    }

    /// The history keys of the broken copies (`lanes::Fields`): a lane path
    /// for the Together and OpenRouter copies, the field for vLLM's.
    pub(super) fn broken_keys(&self) -> impl Iterator<Item = &'static str> + '_ {
        [
            (TEXT_COPY, &self.text),
            (DETAILS_COPY, &self.details),
            (SUMMARY_COPY, &self.summary),
            ("reasoning", &self.pair),
        ]
        .into_iter()
        .filter_map(|(key, copy)| copy.broken.then_some(key))
    }
}

/// The non-empty copies a frame carries, by lane path.
pub(super) fn copies(frame: &Value) -> Vec<(&'static str, &str)> {
    let slots = Slots::of(frame);
    [TEXT_COPY, DETAILS_COPY, SUMMARY_COPY]
        .into_iter()
        .filter_map(|path| Some((path, slots.text(path)?)))
        .collect()
}
