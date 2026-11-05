//! The lane released text belongs to: after a switch of delta text field
//! (reasoning to answer) only the released text of the current field
//! continues that field's lane.

use std::collections::BTreeMap;

use serde_json::Value;

use super::StreamingDlp;

impl StreamingDlp {
    /// The JSON path, raw text and sent text of the released frames within
    /// reach that belong to the last released frame's text field. `straddle`
    /// is the verified sent text of a frame straddling the reach start
    /// (`straddle_sent`), used in place of its raw tail.
    pub(super) fn released_lane(&self, straddle: Option<&str>) -> Option<(String, String, String)> {
        let key = self.recent.iter().rev().find_map(|frame| frame.key)?;
        let mut raw_parts = Vec::new();
        let mut sent_parts = Vec::new();
        for frame in self.recent.iter().rev() {
            if frame.end <= self.scan_from || frame.key.is_some_and(|other| other != key) {
                break;
            }
            // The frame's own text starts after its separator, by position.
            let body = frame.start
                + if frame.separated {
                    super::super::FIELD_SEPARATOR.len()
                } else {
                    0
                };
            let start = body.max(self.scan_from);
            let raw = &self.text[start - self.base..frame.end - self.base];
            // A frame whose body is all within reach (the reach can start
            // inside the separator) contributes its sent body; one straddling
            // the reach start its verified sent tail, else its raw tail.
            let sent = if self.scan_from <= body {
                &frame.sent[body - frame.start..]
            } else {
                straddle.unwrap_or(raw)
            };
            raw_parts.push(raw);
            sent_parts.push(sent);
            // The field started at this frame.
            if frame.separated {
                break;
            }
        }
        raw_parts.reverse();
        sent_parts.reverse();
        Some((
            format!("/choices/0/delta/{key}"),
            raw_parts.concat(),
            sent_parts.concat(),
        ))
    }
}

/// Raw bytes of released text kept per delta text field (between one and two
/// times this, as it is trimmed in halves), for a field that
/// resumes after another (see [`Fields`]). The whole field is kept, so its
/// lane is judged exactly as the buffered path judges it; a field past this
/// size is trimmed and, should it resume, its continuation is masked.
const FIELD_HISTORY: usize = 1024 * 1024;

/// One delta text field's released text, raw and as sent. `sent` is kept
/// only from the first frame whose sent text differed; until then it equals
/// `raw`.
#[derive(Default)]
struct History {
    raw: String,
    sent: Option<String>,
    /// The front was dropped: the lane can no longer be judged whole.
    trimmed: bool,
    /// An open keyword form left at the end of the dropped front
    /// (`reach::keyword_tail`), put back in front of the raw text when the
    /// lane is seeded.
    form: Option<String>,
}

impl History {
    /// Append a released frame's text. `trim` is false for the last release:
    /// what it adds was held whole and is judged exactly (it is bounded by
    /// the held-text cap), so only earlier trims fail a lane closed.
    fn push(&mut self, raw: &str, sent: &str, trim: bool) {
        if self.sent.is_none() && raw != sent {
            self.sent = Some(self.raw.clone());
        }
        if let Some(history) = &mut self.sent {
            history.push_str(sent);
        }
        self.raw.push_str(raw);
        if !trim {
            return;
        }
        // Any resume of this field now fails closed, so the cut need not
        // line up between raw and sent. Trimmed in halves, so the cost is
        // amortized per byte rather than a full move per frame.
        if self.raw.len() > FIELD_HISTORY {
            self.trimmed = true;
        }
        if self.raw.len() > 2 * FIELD_HISTORY {
            let dropped = drain_front(&mut self.raw, FIELD_HISTORY);
            self.form = super::reach::keyword_tail(&dropped, self.form.take());
        }
        // `sent` is cut only once the field is trimmed, so an uncut raw is
        // never compared with a cut sent.
        if let Some(sent) = self.sent.as_mut().filter(|_| self.trimmed) {
            if sent.len() > 2 * FIELD_HISTORY {
                drain_front(sent, FIELD_HISTORY);
            }
        }
    }
}

/// Keep at most the last `keep` bytes of `text`, from a token edge outside
/// any group chain; returns the dropped front.
fn drain_front(text: &mut String, keep: usize) -> String {
    let mut start = text.len().saturating_sub(keep);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let next_edge = |from: usize| {
        text[from..]
            .char_indices()
            .find(|(_, character)| {
                character.is_ascii_whitespace() || super::reach::is_script_boundary(*character)
            })
            .map_or(text.len(), |(index, character)| {
                from + index + character.len_utf8()
            })
    };
    // From a token edge outside any group chain: a token or a chain of
    // digit groups cut short could match where the whole one does not.
    start = next_edge(start);
    while start < text.len() {
        let floor = start.saturating_sub(super::digits::DIGIT_RUN_REACH);
        if super::digits::chain_start(text, start, floor).0 >= start {
            break;
        }
        // Past the whole chain in one step.
        start = next_edge(super::digits::chain_end(text, start));
    }
    text.drain(..start).collect()
}

/// Delta text fields across the stream. A field that comes back after
/// another (answer, reasoning, answer: interleaved thinking) is one string in
/// a non-streamed response, so a value can run across the gap. From such a
/// return on the stream is held whole, and at its end the field's text is
/// checked as one lane: its released text (raw and as sent) plus what is
/// held. Only the first choice (index 0) is tracked; frames for other
/// choices already hold the stream whole and are judged per choice lane.
#[derive(Default)]
pub(super) struct Fields {
    /// Every other choice's text, each its own lane (`ChoiceTexts`): all held,
    /// and judged at the end (`final_lanes`).
    pub(super) choices: super::super::ChoiceTexts,
    seen: Vec<&'static str>,
    resumed: Vec<&'static str>,
    /// Fields that continued in a frame with another lane's text: judged
    /// whole at the end like resumed ones, but a trimmed history is not by
    /// itself a mismatch (nothing came back after a gap).
    mixed: Vec<&'static str>,
    /// The text fields of the last first-choice frame with text.
    last: Vec<&'static str>,
    history: BTreeMap<&'static str, History>,
    /// Copies of a field elsewhere in the frame (`mirror.rs`).
    pub(super) mirrors: super::mirror::Mirrors,
}

impl Fields {
    /// Record the text fields a frame carries; `true` when one of them
    /// returns after another field (in any slot of the frame), or continues
    /// across a field switch the scan text separates (`separated`: vLLM's
    /// mirrored `reasoning` going on alone after `reasoning_content`).
    /// `scan_len` is the length of the frame's scan text (choice 0's alone,
    /// `ChoiceTexts::push_frame`); `fields` is `text_fields(frame)`. Another
    /// choice's text is not in it, so it neither separates choice 0's field
    /// from its earlier text nor mixes with it: choice 0's scan text stays
    /// contiguous, as for a stream with that choice alone.
    /// The held text is still judged whole, with `carried` and the reach.
    /// Text of another lane of choice 0 (tool arguments, a refusal) counts.
    pub(super) fn observe(
        &mut self,
        frame: &Value,
        fields: &[(&'static str, &str)],
        separated: bool,
        scan_len: usize,
    ) -> bool {
        debug_assert_eq!(fields, text_fields(frame).as_slice());
        if ambiguous_first_choice(frame) {
            // Choice 0 is not plainly the first entry (`index: 0.0`,
            // reordered or repeated): its text still joins the /choices/0
            // lanes, so every field and copy is judged whole (fail closed).
            for key in super::super::DELTA_TEXT_KEYS {
                if !self.resumed.contains(&key) {
                    self.resumed.push(key);
                }
            }
            self.mirrors.break_all();
            return true;
        }
        if fields.is_empty() {
            // Text from another lane of choice 0 (tool arguments, a refusal)
            // between two frames of a field separates them in the scan text,
            // so a keyword before it no longer reaches a value after it: the
            // field's next frame is judged whole.
            if scan_len != 0 {
                self.last.clear();
            }
            return false;
        }
        // Text of another lane of choice 0 in the same frame (tool
        // arguments, a refusal) also separates the field from its earlier text,
        // whichever order the scan text puts them in.
        // Two text fields of the frame also separate each other.
        let mirrored = delta_field(frame, "reasoning_content");
        let (own, own_len) = fields
            .iter()
            .filter(|(key, text)| *key != "reasoning" || mirrored != Some(*text))
            .fold((0_usize, 0_usize), |(count, total), (_, text)| {
                (count + 1, total + text.len())
            });
        let other_lane = own > 1 || scan_len > own_len;
        let mut resumed = false;
        for (key, _) in fields {
            if !self.seen.contains(key) {
                self.seen.push(key);
            } else if separated || !self.last.contains(key) {
                if !self.resumed.contains(key) {
                    self.resumed.push(key);
                }
                resumed = true;
            } else if other_lane {
                if !self.mixed.contains(key) {
                    self.mixed.push(key);
                }
                resumed = true;
            }
        }
        self.last.clear();
        if !other_lane {
            self.last.extend(fields.iter().map(|(key, _)| *key));
        }
        resumed
    }

    /// Record a released frame's text fields and copies, raw (captured with
    /// [`released_texts`] before redaction) and as sent in `sent_frame`.
    pub(super) fn record(
        &mut self,
        raw: Vec<(&'static str, String)>,
        sent_frame: &Value,
        final_step: bool,
    ) {
        for (key, raw) in raw {
            let sent = if key.starts_with('/') {
                super::mirror::copy_value(sent_frame, key).and_then(Value::as_str)
            } else {
                delta_field(sent_frame, key)
            };
            self.history
                .entry(key)
                .or_default()
                .push(&raw, sent.unwrap_or_default(), !final_step);
        }
    }

    /// The history keys judged whole at the end: each resumed field and each
    /// broken copy.
    fn checked(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.resumed
            .iter()
            .copied()
            .chain(self.mirrors.broken_keys())
    }

    /// Every lane that must be judged with its released text at the end:
    /// JSON path, raw, as sent.
    /// A trimmed mixed field's raw and sent no longer line up, so it is
    /// seeded with its raw text and no sent text: compared against the
    /// transform of that raw text, which is exact at the junction with the
    /// held text (where a value could cross).
    pub(super) fn seeds(&self) -> Vec<(String, String, Option<String>)> {
        self.checked()
            .chain(
                self.mixed
                    .iter()
                    .copied()
                    .filter(|key| !self.resumed.contains(key)),
            )
            .map(|key| {
                let mixed_only = !self.resumed.contains(&key)
                    && !self.mirrors.broken_keys().any(|broken| broken == key);
                let (raw, sent) = self.history.get(key).map_or_else(
                    || (String::new(), Some(String::new())),
                    |history| {
                        let sent = history.sent.as_ref().unwrap_or(&history.raw);
                        let rejudged = mixed_only && history.trimmed;
                        let sent = (!rejudged).then(|| sent.clone());
                        // A keyword form open at the dropped front still
                        // reaches a value at the junction.
                        let mut raw = String::new();
                        if rejudged {
                            raw.push_str(history.form.as_deref().unwrap_or_default());
                        }
                        raw.push_str(&history.raw);
                        (raw, sent)
                    },
                );
                let path = if key.starts_with('/') {
                    key.to_owned()
                } else {
                    format!("/choices/0/delta/{key}")
                };
                (path, raw, sent)
            })
            .collect()
    }

    /// Whether a lane judged whole was sent differently from the transform of
    /// its raw text (a value ran across a gap), or can no longer be judged
    /// whole (fail closed).
    pub(super) fn checked_mismatch(&self, transform: &super::redact::Transform<'_>) -> bool {
        let differs = |history: &History| {
            transform.apply(&history.raw) != *history.sent.as_ref().unwrap_or(&history.raw)
        };
        self.checked().any(|key| {
            self.history
                .get(key)
                .is_some_and(|history| history.trimmed || differs(history))
        }) || self.mixed.iter().any(|key| {
            self.history
                .get(key)
                .is_some_and(|history| !history.trimmed && differs(history))
        })
    }
}

/// A released frame's raw text fields and copies, by history key.
pub(super) fn released_texts(frame: &Value) -> Vec<(&'static str, String)> {
    if !first_choice(frame) {
        return Vec::new();
    }
    text_fields(frame)
        .into_iter()
        .chain(super::mirror::copies(frame))
        .map(|(key, text)| (key, text.to_owned()))
        .collect()
}

/// Whether choice 0's text could join the /choices/0 lanes (which key
/// choices by `index`, else position) other than as the plain first entry.
fn ambiguous_first_choice(frame: &Value) -> bool {
    let Some(choices) = frame.get("choices") else {
        return false;
    };
    // `choices` as an object (`{"0": {...}}`): its text joins the /choices/0
    // lanes but not the scan text.
    let Some(choices) = choices.as_array() else {
        return !choices.is_null();
    };
    let lane_zero = choices
        .iter()
        .enumerate()
        .filter(|(position, choice)| super::super::choice_lane(choice, *position) == 0)
        .count();
    lane_zero > 1 || (lane_zero == 1 && !first_choice(frame))
}

/// The non-empty delta text fields of a frame's first choice, when that is
/// choice 0, in `DELTA_TEXT_KEYS` order. vLLM's `reasoning` that repeats
/// `reasoning_content` is included: the scan text holds that text once, but
/// the client builds each field as its own string.
pub(super) fn text_fields(frame: &Value) -> Vec<(&'static str, &str)> {
    if !first_choice(frame) {
        return Vec::new();
    }
    let Some(delta) = choice_zero(frame).and_then(|choice| choice.get("delta")) else {
        return Vec::new();
    };
    super::super::DELTA_TEXT_KEYS
        .iter()
        .filter_map(|key| {
            let text = delta.get(*key)?.as_str().filter(|text| !text.is_empty())?;
            Some((*key, text))
        })
        .collect()
}

/// Whether a frame's first choice is choice 0 (index absent, null or 0).
pub(super) fn first_choice(frame: &Value) -> bool {
    choice_zero(frame).is_some_and(|choice| {
        choice
            .get("index")
            .is_none_or(|index| index.is_null() || index.as_u64() == Some(0))
    })
}

/// The text of a frame's `delta.<key>` field.
pub(super) fn delta_field<'a>(frame: &'a Value, key: &str) -> Option<&'a str> {
    frame
        .get("choices")?
        .get(0)?
        .get("delta")?
        .get(key)?
        .as_str()
}

/// One `Value::pointer` step for an unescaped token: serde_json 1.0.151's fold
/// body (object member, else canonical array index, i.e. its `parse_index`).
pub(super) fn step<'a>(value: &'a Value, token: &str) -> Option<&'a Value> {
    debug_assert!(!token.contains(['~', '/']));
    match value {
        Value::Object(map) => map.get(token),
        Value::Array(list) => index(token).and_then(|index| list.get(index)),
        _ => None,
    }
}

/// [`step`] on a mutable value (`Value::pointer_mut`'s fold body).
pub(super) fn step_mut<'a>(value: &'a mut Value, token: &str) -> Option<&'a mut Value> {
    debug_assert!(!token.contains(['~', '/']));
    match value {
        Value::Object(map) => map.get_mut(token),
        Value::Array(list) => index(token).and_then(|index| list.get_mut(index)),
        _ => None,
    }
}

/// serde_json's `parse_index`: a canonical decimal array index.
fn index(token: &str) -> Option<usize> {
    if token.starts_with('+') || (token.starts_with('0') && token.len() != 1) {
        return None;
    }
    token.parse().ok()
}

/// `frame.pointer("/choices/0")`; an object keyed "0" counts, as in pointer.
pub(super) fn choice_zero(frame: &Value) -> Option<&Value> {
    step(frame, "choices").and_then(|choices| step(choices, "0"))
}

/// `frame.pointer_mut("/choices/0")`.
pub(super) fn choice_zero_mut(frame: &mut Value) -> Option<&mut Value> {
    step_mut(frame, "choices").and_then(|choices| step_mut(choices, "0"))
}
