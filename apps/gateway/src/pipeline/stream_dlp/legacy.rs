//! The per-string redaction path's fail-closed check, used for frames the
//! text-level split cannot handle (other lanes, or a value reaching back into
//! released text).

use std::collections::BTreeMap;

use super::{HeldFrame, StreamingDlp};
use crate::firewall::FirewallBackend;

#[cfg(test)]
mod straddle_test;

impl StreamingDlp {
    /// The per-string path's fail-closed check: whether a protected value
    /// still crosses strings once every held frame is redacted on its own.
    pub(super) fn legacy_mask(
        &self,
        safe_end: usize,
        lanes: &BTreeMap<String, String>,
        scanner: &dyn FirewallBackend,
    ) -> bool {
        let region = &self.text[self.scan_from - self.base..safe_end - self.base];
        // `sanitize_pending` also reads the scan view, so a match only the
        // fold reveals (a zero-width split, a fullwidth `＠`) is a change too.
        let changes = |text: &str| {
            scanner.redact_outbound(text).0 != text
                || (self.sanitize && super::super::sanitize_pending(text, scanner))
        };
        // Every lane the comparison below reads, envelope lanes included
        // (the verdict `lanes` leave those to `EnvelopeLanes`).
        let mut every_lane = BTreeMap::new();
        for frame in &self.held {
            super::super::collect_sse_payload_lanes(&frame.value, "", &mut every_lane);
            super::super::token_sequences(&frame.value, &mut every_lane);
        }
        if !changes(region)
            && !lanes.values().any(|text| changes(text))
            && !every_lane.iter().any(|(path, text): (&String, &String)| {
                !super::super::token_mirror_lane(path) && changes(text)
            })
        {
            return false;
        }
        // Exact, not "nothing still matches": removing a value's head on its
        // own can leave a tail that no longer matches, so the per-string
        // result must equal the transform of the joined text, lane by lane.
        let transform = super::redact::Transform::new(scanner, self.sanitize);
        // Released text within reach is compared as it was sent, so a value
        // already redacted at text level is not seen as still crossing frames.
        // A released frame that straddles the reach start contributes the
        // verified end of what it sent (`straddle_sent`), else its raw
        // retained tail: if it was rewritten, that differs and the check masks.
        let straddle = self.straddle_sent(&transform);
        let mut sent = String::new();
        let mut from = self.released_end;
        for frame in &self.recent {
            if frame.end <= self.scan_from {
                continue;
            }
            if from == self.released_end {
                from = frame.start.max(self.scan_from);
            }
            if frame.start < self.scan_from {
                let separator = super::super::FIELD_SEPARATOR.len();
                if frame.separated && self.scan_from <= frame.start + separator {
                    // The reach starts inside the separator: the frame's
                    // whole body is in reach, as sent (the separator part of
                    // `sent` equals the scan text's).
                    sent.push_str(&frame.sent[self.scan_from - frame.start..]);
                } else {
                    let raw_tail = &self.text[self.scan_from - self.base..frame.end - self.base];
                    sent.push_str(straddle.as_deref().unwrap_or(raw_tail));
                }
            } else {
                sent.push_str(&frame.sent);
            }
        }
        // Each held choice's text on its own (`ChoiceTexts`): no other
        // choice's text was released, so it is all held.
        debug_assert!(self.fields.choices.is_empty() || !lanes.is_empty());
        let mut raw_choices = super::super::ChoiceTexts::default();
        let mut remaining_choices = super::super::ChoiceTexts::default();
        let released = &self.text[from - self.base..self.released_end - self.base];
        let mut raw = released.to_owned();
        let mut raw_lanes = BTreeMap::new();
        let mut remaining = sent;
        let mut remaining_lanes = BTreeMap::new();
        // Released fixed fields went out as they are.
        for (path, text) in self.fixed_seeds() {
            raw_lanes.insert(path.clone(), text.clone());
            remaining_lanes.insert(path, text);
        }
        // Only the released text of the field the lane belongs to seeds it.
        if let Some((path, lane_raw, lane_sent)) = self.released_lane(straddle.as_deref()) {
            raw_lanes.insert(path.clone(), lane_raw);
            remaining_lanes.insert(path, lane_sent);
        }
        for (path, lane_raw, lane_sent) in self.fields.seeds() {
            let lane_sent = lane_sent.unwrap_or_else(|| transform.apply(&lane_raw));
            raw_lanes.insert(path.clone(), lane_raw);
            remaining_lanes.insert(path, lane_sent);
        }
        // Envelope fields release masks first (see `release`) are compared
        // masked, as they will go out.
        let split = self.split_envelope(&transform);
        let batch_mirrors = self.held.iter().any(HeldFrame::mirrors);
        let mut rewritten = Vec::with_capacity(self.held.len());
        for frame in &self.held {
            let mut value = frame.value.clone();
            super::envelope::EnvelopeLanes::mask(&mut value, &split);
            if frame.separated {
                raw.push_str(super::super::FIELD_SEPARATOR);
            }
            raw_choices.push_frame(&value, &mut raw);
            super::super::collect_sse_payload_lanes(&value, "", &mut raw_lanes);
            super::super::token_sequences(&value, &mut raw_lanes);
            // Masking rewrites strings only: `batch_mirrors` covers it.
            debug_assert!(batch_mirrors || !super::super::has_token_mirrors(&value));
            let before = batch_mirrors.then(|| value.clone());
            if self.sanitize {
                super::super::sanitize_json_strings(&mut value, scanner);
            } else {
                super::super::redact_json_strings(&mut value, scanner);
            }
            let changed = before.is_some_and(|before| before != value);
            rewritten.push((frame.separated, value, changed));
        }
        // As `release` will: the mirrors of a rewritten frame go, and at the
        // every frame's once anything in the batch changed.
        let drop_all =
            self.sanitize || (batch_mirrors && rewritten.iter().any(|(_, _, changed)| *changed));
        for (separated, mut value, changed) in rewritten {
            if drop_all || changed {
                super::super::drop_choice_logprobs(&mut value);
            }
            if separated {
                remaining.push_str(super::super::FIELD_SEPARATOR);
            }
            remaining_choices.push_frame(&value, &mut remaining);
            super::super::collect_sse_payload_lanes(&value, "", &mut remaining_lanes);
            super::super::token_sequences(&value, &mut remaining_lanes);
        }
        transform.apply(&raw) != remaining
            || !super::super::ChoiceTexts::same_transform(
                &raw_choices,
                &remaining_choices,
                &transform,
            )
            || raw_lanes.iter().any(|(path, text)| {
                // Token mirrors are compared as a sequence, never by
                // position (`token_mirror_lane`); a dropped sequence has
                // nothing left to compare.
                let dropped = !path.starts_with('/') && !remaining_lanes.contains_key(path);
                !super::super::token_mirror_lane(path)
                    && !dropped
                    && remaining_lanes.get(path) != Some(&transform.apply(text))
            })
    }

    /// What the released frame straddling the reach start sent for its part
    /// within reach: the transform of the reach from its start, split at the
    /// released frame ends, whose first segment ends the frame's sent text.
    /// The check then judges the client's text from that point exactly as it
    /// judges text from a frame start; a value running on into held text
    /// changes the transform but not this claim, so the check still masks.
    /// `None` (compare the raw tail, which masks a rewritten one) unless the
    /// frame went out at text level (its scan text is its lane text) with the
    /// reach start inside its own text, and the split is verified.
    fn straddle_sent(&self, transform: &super::redact::Transform<'_>) -> Option<String> {
        let frame = self
            .recent
            .iter()
            .find(|frame| frame.end > self.scan_from)?;
        let separator = super::super::FIELD_SEPARATOR.len();
        if frame.start >= self.scan_from
            || !frame.text_level
            || (frame.separated && self.scan_from <= frame.start + separator)
        {
            return None;
        }
        // Bounded: a value cut short by the region only fails the claim. The
        // later frame ends keep the first segment from running past a value
        // the straddler's own (often mid-token) end would leave merged.
        let reach = frame.end.max(self.scan_from + 2 * super::SCAN_BACK);
        let mut bounds = vec![self.scan_from];
        for end in self.recent.iter().map(|recent| recent.end) {
            if end > reach {
                break;
            }
            if end > *bounds.last()? {
                bounds.push(end);
            }
        }
        let cap = *bounds.last()?;
        let region = &self.text[self.scan_from - self.base..cap - self.base];
        let segments =
            super::redact::split_transformed(region, self.scan_from, &bounds, transform)?;
        // Every span split: fewer would leave a later bound inside a value.
        if segments.len() + 1 != bounds.len() {
            return None;
        }
        let claim = segments.into_iter().next()?;
        frame.sent.ends_with(&claim).then_some(claim)
    }

    /// At the final step of a held-whole stream (tool calls, other lanes, a
    /// varying envelope field): how many leading plain-content frames there
    /// are, and whether they go out on their own at text level (only the
    /// frames from the first other lane on take the per-string path). Only
    /// when no lane carries a value across the head/tail boundary, and no
    /// frame carries token mirrors (judged over the whole batch, `release`);
    /// otherwise one per-string decision covers head and tail alike.
    pub(super) fn final_head(
        &self,
        release: usize,
        scanner: &dyn FirewallBackend,
    ) -> (usize, bool) {
        let frames = || self.held.iter().take(release);
        let head = frames()
            .take_while(|frame| {
                super::super::simple_content_delta(&frame.value)
                    && super::redact::content_eligible(&frame.value)
            })
            .count();
        let mirrors = frames().any(HeldFrame::mirrors);
        let split = head > 0 && head < release && !mirrors && self.splits_cleanly(head, scanner);
        (head, split)
    }

    /// Whether the first `head` held frames can be released on their own: in
    /// every lane, the joined text redacts the same as head and tail apart.
    pub(super) fn splits_cleanly(&self, head: usize, scanner: &dyn FirewallBackend) -> bool {
        let transform = super::redact::Transform::new(scanner, self.sanitize);
        let split = self.split_envelope(&transform);
        // Released text continues its lane into the head: a value running
        // from it through the head into the tail makes the split unclean.
        let mut head_lanes: BTreeMap<String, String> = self.fixed_seeds().collect();
        if let Some((path, raw, _)) = self.released_lane(None) {
            head_lanes.insert(path, raw);
        }
        for (path, raw, _) in self.fields.seeds() {
            head_lanes.insert(path, raw);
        }
        let mut tail_lanes = BTreeMap::new();
        for (index, frame) in self.held.iter().enumerate() {
            let lanes = if index < head {
                &mut head_lanes
            } else {
                &mut tail_lanes
            };
            let mut value = frame.value.clone();
            super::envelope::EnvelopeLanes::mask(&mut value, &split);
            super::super::collect_sse_payload_lanes(&value, "", lanes);
        }
        let apart = |head: &str, tail: &str| {
            let mut apart = transform.apply(head);
            apart.push_str(&transform.apply(tail));
            transform.apply(&format!("{head}{tail}")) == apart
        };
        // The scan text joins the head's content onto the tail's text (with
        // `FIELD_SEPARATOR` where the tail starts in another lane, such as a
        // tool call's arguments): the head is split from that joined region,
        // so it must redact as it does on its own.
        let head_end = self.held[head - 1].end - self.base;
        let from = self.scan_from - self.base;
        apart(&self.text[from..head_end], &self.text[head_end..])
            && tail_lanes.iter().all(|(path, tail)| {
                head_lanes
                    .get(path)
                    .is_none_or(|head: &String| apart(head, tail))
            })
    }

    /// Envelope fields carrying a value split across frames (none unless a
    /// field varied, which holds the stream whole).
    pub(super) fn split_envelope(&self, transform: &super::redact::Transform<'_>) -> Vec<String> {
        if self.envelope.varying()
            || self.envelope.overflowed()
            || self.envelope.unmatched_changes()
        {
            self.envelope.split_paths(transform)
        } else {
            Vec::new()
        }
    }
}
