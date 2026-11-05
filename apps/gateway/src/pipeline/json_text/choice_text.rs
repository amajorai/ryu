//! Per-choice scan text. A client merges streamed choices by `index`, so
//! each choice is its own text, as each choice's strings are their own
//! strings in a non-streamed response (`json_string_projection` puts them on
//! separate lines). The primary lane (choice 0, and frames without
//! `choices`) is the scan text both stream paths have always built; every
//! other choice gets its own lane, so a value that forms only where two
//! choices' deltas meet in wire order is no match, and one inside a choice
//! is caught even when its chunks are interleaved with another choice's.
//!
//! A delta carrying both reasoning and answer text (vLLM's boundary step,
//! when `split_boundary` cannot split it: token mirrors, or a choice other
//! than 0) is scanned as the split frames are: the reasoning, then
//! [`FIELD_SEPARATOR`], then the answer, as the two are separate strings in
//! a non-streamed response.
//!
//! So is a switch between a delta text field and a tool call's (or the
//! legacy `function_call`'s) text, or between two tool calls (`TextLane`):
//! each is its own string in a non-streamed response, so no pattern may run
//! from the answer into a call's arguments.

use std::collections::{BTreeMap, HashSet};

use serde_json::Value;

use super::{
    choice_lane, collect_text_fields, lane_segment, odd_index, skipped_member, DELTA_TEXT_KEYS,
    FIELD_SEPARATOR,
};

/// The delta members that hold reasoning: the first part of a boundary
/// delta's scan text (`split_boundary`'s reasoning half).
const REASONING_KEYS: [&str; 3] = ["reasoning_content", "reasoning", "reasoning_details"];

/// Whether an array entry belongs to the primary lane: choice 0 by `index`
/// as clients read it (`choice_lane`), never an index that is no lane number.
fn primary(entry: &Value, position: usize) -> bool {
    match entry.get("index") {
        None | Some(Value::Null) => position == 0,
        Some(_) => !odd_index(entry) && choice_lane(entry, position) == 0,
    }
}

fn non_empty(delta: &Value, key: &str) -> bool {
    delta
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty())
}

/// The reasoning field of a delta that carries answer text (`content`) too:
/// its scan text is the reasoning, [`FIELD_SEPARATOR`], then the answer.
fn boundary_key(delta: &Value) -> Option<&'static str> {
    if !non_empty(delta, "content") {
        return None;
    }
    ["reasoning_content", "reasoning"]
        .into_iter()
        .find(|key| non_empty(delta, key))
}

/// The delta text fields an entry's scan text starts and ends in: the first
/// non-empty one of its `delta` for both, except for a boundary delta
/// (`boundary_key`), which starts in its reasoning field and ends in
/// `content`. The start decides the separator before the entry; the end is
/// the field the next frame's text continues.
fn entry_text_keys(entry: &Value) -> Option<(&'static str, &'static str)> {
    let delta = entry.get("delta")?;
    let last = DELTA_TEXT_KEYS
        .iter()
        .copied()
        .find(|key| non_empty(delta, key))?;
    Some((boundary_key(delta).unwrap_or(last), last))
}

/// The lanes an entry's scan text starts and ends in (`entry_text`), a
/// delta text field named as `entry_text_keys` names it. The start decides
/// the separator before the entry; the end is the lane the next frame's
/// text continues.
fn entry_text_lanes(entry: &Value) -> Option<(TextLane, TextLane)> {
    let (first, last) = entry_text(entry, None)?;
    let keys = entry_text_keys(entry);
    let named = |lane: TextLane, key: Option<&'static str>| match (lane, key) {
        (TextLane::Field(_), Some(key)) => TextLane::Field(key),
        (lane, _) => lane,
    };
    Some((
        named(first, keys.map(|(start, _)| start)),
        named(last, keys.map(|(_, end)| end)),
    ))
}

/// A frame's first primary entry: the one whose text fields the primary
/// lane's separators read.
fn primary_entry(frame: &Value) -> Option<&Value> {
    let choices = frame.as_object()?.get("choices")?.as_array()?;
    let (_, entry) = choices
        .iter()
        .enumerate()
        .find(|(position, entry)| primary(entry, *position))?;
    Some(entry)
}

/// The delta text fields the primary lane's text starts and ends in for a
/// frame, if any (`entry_text_keys`): those of the frame's first primary
/// entry. For a frame whose entries are all primary and carry one text field
/// each, both are `delta_text_key`.
pub(in crate::pipeline) fn primary_text_keys(
    frame: &Value,
) -> Option<(&'static str, &'static str)> {
    entry_text_keys(primary_entry(frame)?)
}

/// The lanes the primary lane's text starts and ends in for a frame, if any
/// (`entry_text_lanes` of its first primary entry): where a stream puts
/// [`FIELD_SEPARATOR`] before a frame's text.
pub(in crate::pipeline) fn primary_text_lanes(frame: &Value) -> Option<(TextLane, TextLane)> {
    entry_text_lanes(primary_entry(frame)?)
}

/// The field [`primary_text_keys`] starts in.
#[cfg(test)]
pub(in crate::pipeline) fn primary_text_key(frame: &Value) -> Option<&'static str> {
    primary_text_keys(frame).map(|(first, _)| first)
}

/// The lane of a choice a piece of its scan text is in: a delta text field
/// (`DELTA_TEXT_KEYS`), a tool call (by its `index` as clients merge calls,
/// else its position), or the legacy `function_call`. Each is its own string
/// in a non-streamed response, so where the text switches lane (between
/// classes, `class`) the scan text has [`FIELD_SEPARATOR`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::pipeline) enum TextLane {
    Field(&'static str),
    Call(u64),
    Function,
}

impl TextLane {
    /// Inside one entry the delta text fields are one class: a boundary
    /// delta's reasoning-to-answer switch has its own separator.
    fn class(self) -> Self {
        match self {
            Self::Field(_) => Self::Field(""),
            lane => lane,
        }
    }
}

/// Whether [`collect_text_fields`] appends any text for `value`.
fn has_text(value: &Value) -> bool {
    match value {
        Value::String(text) => !text.is_empty(),
        Value::Array(values) => values.iter().any(has_text),
        Value::Object(values) => values
            .iter()
            .any(|(key, value)| !skipped_member(values, key, value) && has_text(value)),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

/// An entry's scan text as it is built: appended to `out` when there is
/// one (else only its lanes are read), with the first and last lane its
/// text is in.
struct EntryText<'o> {
    out: Option<&'o mut String>,
    first: Option<TextLane>,
    last: Option<TextLane>,
    /// The lane the text so far ends in; reset by an explicit separator.
    current: Option<TextLane>,
}

impl EntryText<'_> {
    /// Append `value`'s text, in `lane` (`None`: text that joins whatever
    /// lane is around it), after [`FIELD_SEPARATOR`] on a class switch.
    fn piece(&mut self, lane: Option<TextLane>, value: &Value) {
        if let Some(lane) = lane.filter(|_| has_text(value)) {
            if self
                .current
                .is_some_and(|current| current.class() != lane.class())
            {
                self.separate();
            }
            self.first.get_or_insert(lane);
            self.last = Some(lane);
            self.current = Some(lane);
        }
        if let Some(out) = self.out.as_deref_mut() {
            collect_text_fields(value, out);
        }
    }

    fn separate(&mut self) {
        if let Some(out) = self.out.as_deref_mut() {
            out.push_str(FIELD_SEPARATOR);
        }
        self.current = None;
    }

    /// The members of a delta `collect_text_fields` reads, in its order:
    /// only the reasoning ones, or only the others, when `reasoning` is set.
    fn members(&mut self, fields: &serde_json::Map<String, Value>, reasoning: Option<bool>) {
        for (key, value) in fields {
            let key = key.as_str();
            if reasoning.is_some_and(|reasoning| REASONING_KEYS.contains(&key) != reasoning)
                || skipped_member(fields, key, value)
            {
                continue;
            }
            match (key, value) {
                ("tool_calls", Value::Array(calls)) => {
                    for (position, call) in calls.iter().enumerate() {
                        self.piece(Some(TextLane::Call(choice_lane(call, position))), call);
                    }
                }
                ("function_call", _) => self.piece(Some(TextLane::Function), value),
                (key, Value::String(_)) => {
                    let field = DELTA_TEXT_KEYS.iter().copied().find(|field| *field == key);
                    self.piece(field.map(TextLane::Field), value);
                }
                _ => self.piece(None, value),
            }
        }
    }
}

/// An entry's text (its `delta`, else its `message`), appended to `out` when
/// given, and the lanes it starts and ends in (`TextLane`; a delta's only).
/// A boundary delta (`boundary_key`) is its reasoning, [`FIELD_SEPARATOR`],
/// then the rest, in the order `split_boundary`'s halves give.
fn entry_text(entry: &Value, out: Option<&mut String>) -> Option<(TextLane, TextLane)> {
    let mut text = EntryText {
        out,
        first: None,
        last: None,
        current: None,
    };
    match entry.get("delta") {
        Some(delta @ Value::Object(fields)) if boundary_key(delta).is_some() => {
            text.members(fields, Some(true));
            text.separate();
            text.members(fields, Some(false));
        }
        Some(Value::Object(fields)) => text.members(fields, None),
        Some(delta) => text.piece(None, delta),
        None => {
            if let Some(message) = entry.get("message") {
                text.piece(None, message);
            }
        }
    }
    Some((text.first?, text.last?))
}

/// An entry's text appended to `out` (`entry_text`).
fn collect_entry_text(entry: &Value, out: &mut String) {
    entry_text(entry, Some(out));
}

/// The text of every choice lane but the primary one, keyed by lane segment
/// (`lane_segment`), each with the text lane it was last in.
#[derive(Default)]
pub(in crate::pipeline) struct ChoiceTexts {
    lanes: BTreeMap<String, (String, Option<TextLane>)>,
    bytes: usize,
}

impl ChoiceTexts {
    /// Add a frame's text: the primary lane's to `primary` (no separator; the
    /// caller keeps its own), every other choice's to its lane, with
    /// [`FIELD_SEPARATOR`] where that choice's text lane changes.
    /// Reads the strings `collect_sse_payload_text` reads, plus
    /// [`FIELD_SEPARATOR`] between a text field and a tool call (or between two
    /// calls) inside one delta, which `collect_sse_payload_text` does not add.
    pub(in crate::pipeline) fn push_frame(&mut self, frame: &Value, primary: &mut String) {
        walk(frame, primary, Some(self), true);
    }

    /// Each lane's text, by lane segment.
    pub(in crate::pipeline) fn texts(&self) -> impl Iterator<Item = (&str, &str)> + '_ {
        self.lanes
            .iter()
            .map(|(lane, (text, _))| (lane.as_str(), text.as_str()))
    }

    /// Whether no entry outside the primary lane was seen.
    pub(in crate::pipeline) fn is_empty(&self) -> bool {
        self.lanes.is_empty()
    }

    /// Bytes of text held across the lanes.
    pub(in crate::pipeline) fn bytes(&self) -> usize {
        self.bytes
    }

    /// Whether `remaining` holds the same lanes as `raw`, each the
    /// transform of its raw text.
    pub(in crate::pipeline) fn same_transform(
        raw: &Self,
        remaining: &Self,
        transform: &crate::pipeline::stream_dlp::redact::Transform<'_>,
    ) -> bool {
        raw.lanes.len() == remaining.lanes.len()
            && raw.lanes.iter().all(|(lane, (text, _))| {
                remaining
                    .lanes
                    .get(lane)
                    .is_some_and(|(sent, _)| *sent == transform.apply(text))
            })
    }
}

/// The frame walk of `collect_sse_payload_text`, routing each choice to its
/// lane. `choices` is `None` to skip every non-primary entry. `top` is a
/// frame itself (not an entry of an array frame): only there does a choice's
/// lane switch insert a separator, as `choice_scan_texts` does.
fn walk(value: &Value, primary_out: &mut String, mut choices: Option<&mut ChoiceTexts>, top: bool) {
    match value {
        Value::Array(values) => {
            for value in values {
                walk(value, primary_out, choices.as_deref_mut(), false);
            }
        }
        Value::Object(values) if values.contains_key("choices") => {
            let Some(entries) = values.get("choices").and_then(Value::as_array) else {
                return;
            };
            // Lanes that already took text from an earlier entry of this
            // frame (a set: a frame can hold any number of entries).
            let mut keyed: HashSet<String> = HashSet::new();
            for (position, entry) in entries.iter().enumerate() {
                if primary(entry, position) {
                    collect_entry_text(entry, primary_out);
                    continue;
                }
                let Some(choices) = choices.as_deref_mut() else {
                    continue;
                };
                let segment = lane_segment(entry, position);
                let first = top && keyed.insert(segment.clone());
                let (lane_text, lane_key) = choices.lanes.entry(segment).or_default();
                let before = lane_text.len();
                if first {
                    if let Some((start, end)) = entry_text_lanes(entry) {
                        if lane_key.is_some_and(|key| key != start) {
                            lane_text.push_str(FIELD_SEPARATOR);
                        }
                        *lane_key = Some(end);
                    }
                }
                collect_entry_text(entry, lane_text);
                let added = lane_text.len() - before;
                choices.bytes += added;
            }
        }
        _ => collect_text_fields(value, primary_out),
    }
}

/// Every choice lane's scan text of a payload's frames: `"0"`, the primary
/// lane (always present, first), with [`FIELD_SEPARATOR`] wherever its text
/// lane changes (`TextLane`), then each other choice by lane segment. With every
/// entry primary, no boundary delta (`boundary_key`, which `split_boundary`
/// splits when it can) and no tool call or `function_call` (whose lanes add
/// separators) it is `{"0": sse_scan_text(frames).0}`.
pub(in crate::pipeline) fn choice_scan_texts(frames: &[Value]) -> BTreeMap<String, String> {
    let mut primary_text = String::new();
    let mut choices = ChoiceTexts::default();
    let mut field: Option<TextLane> = None;
    for frame in frames {
        if let Some((start, end)) = primary_text_lanes(frame) {
            if field.is_some_and(|field| field != start) {
                primary_text.push_str(FIELD_SEPARATOR);
            }
            field = Some(end);
        }
        choices.push_frame(frame, &mut primary_text);
    }
    let mut texts = BTreeMap::new();
    texts.insert("0".to_owned(), primary_text);
    for (lane, (text, _)) in choices.lanes {
        texts.insert(lane, text);
    }
    texts
}

/// A frame's primary-lane text appended to `out` (`push_frame` without the
/// other lanes).
pub(in crate::pipeline) fn primary_scan_text(frame: &Value, out: &mut String) {
    walk(frame, out, None, true);
}

#[cfg(test)]
#[path = "choice_text_test.rs"]
mod tests;
