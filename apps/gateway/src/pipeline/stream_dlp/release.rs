//! Releasing held frames: text-level redaction where it applies, the
//! per-string fallback otherwise, envelope masking, and the record of what was
//! sent.

use std::collections::BTreeMap;

use serde_json::Value;

use super::{envelope, redact, DlpOutput, HeldFrame, StreamingDlp};
use crate::firewall::{FirewallBackend, FirewallMatch};

#[cfg(test)]
mod notice_test;
#[cfg(test)]
mod survivor_test;

/// The redact-category match still on `frames` as they would be sent under
/// Sanitize: token mirrors dropped and, when `mask`, the text fields masked.
fn released_survivor(
    frames: &[Value],
    mask: bool,
    scanner: &dyn FirewallBackend,
) -> Option<FirewallMatch> {
    let sent = frames
        .iter()
        .map(|frame| {
            let mut frame = frame.clone();
            super::super::drop_choice_logprobs(&mut frame);
            if mask {
                super::super::mask_sse_payload_text(&mut frame);
            }
            frame
        })
        .collect();
    super::super::sse_sanitize_survivor(&Value::Array(sent), scanner)
}

impl StreamingDlp {
    /// Release the first `count` held frames. Content deltas are redacted at
    /// text level ([`redact::split_transformed`]), so a value split across
    /// deltas is replaced once and the surrounding text survives. Frames that
    /// cannot be split exactly (other lanes, or a match reaching back into
    /// text already released) get per-string redaction and, if a protected
    /// value still crosses strings, are masked as before. Text-level release
    /// stops before a frame that ends inside a replaced value; those frames
    /// wait until the cut passes the value.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn release(
        &mut self,
        count: usize,
        text_level: bool,
        final_step: bool,
        safe_end: usize,
        lanes: &BTreeMap<String, String>,
        scanner: &dyn FirewallBackend,
        output: &mut DlpOutput,
    ) {
        // A refusal (`refuse_survivor`) ended the stream: nothing may follow
        // its notice, including a later release in the same step.
        if self.finished {
            return;
        }
        // The inputs of a release that released nothing, unchanged since (a
        // push that only split a line): it would release nothing again. The
        // region text is append-only while `scan_from` holds, `held` drains
        // only in a release that sends, and `recent`, `released_end` and
        // `carried_raw` change only with one or with `scan_from`. A zero-sized
        // scanner's address says nothing (`Transform::swap_memo`).
        let scanner_id = std::ptr::from_ref(scanner).cast::<()>() as usize;
        let key = (
            scanner_id,
            self.scan_from,
            safe_end,
            count,
            self.sanitize,
            text_level,
        );
        let memo_ok = !final_step && std::mem::size_of_val(scanner) != 0;
        let idle = memo_ok && self.memo.idle_release == Some(key);
        // Under test the skipped release is recomputed and checked below.
        #[cfg(not(test))]
        if idle {
            return;
        }
        let mut transform = redact::Transform::new(scanner, self.sanitize);
        // A carried keyword (drained before its value arrived) whose match now
        // reaches into the region: the value must not go out raw.
        // Only a keyword the raw text holds as written: the buffered transform
        // never replaces a value after a folded one (`ＢＥＡＲＥＲ`).
        let carried_open = self.carried_raw.as_deref().is_some_and(|carried| {
            let region = &self.text[self.scan_from - self.base..safe_end - self.base];
            !transform
                .apply(&format!("{carried}{region}"))
                .starts_with(carried)
        });
        let eligible = !carried_open
            && text_level
            && self
                .held
                .iter()
                .take(count)
                .all(|frame| redact::content_eligible(&frame.value));
        let segments = eligible
            .then(|| self.checked_split(count, safe_end, &transform))
            .flatten()
            // A field switch whose separator a replacement consumed (no
            // built-in pattern can match across it; this guards any that
            // could) cannot be applied: take the per-string path, as the
            // buffered path does.
            .filter(|segments| {
                self.held.iter().zip(segments).all(|(frame, segment)| {
                    !frame.separated || segment.starts_with(super::super::FIELD_SEPARATOR)
                })
            })
            // The last step must release everything it holds.
            .filter(|segments| !final_step || segments.len() == count);
        let count = segments.as_ref().map_or(count, Vec::len);
        debug_assert!(!idle || count == 0, "a skipped idle release would release");
        #[cfg(test)]
        {
            self.memo.idle_hits += usize::from(idle);
        }
        if count == 0 {
            if memo_ok {
                self.memo.idle_release = Some(key);
            }
            return;
        }
        self.memo.idle_release = None;
        let mask_legacy =
            carried_open || (segments.is_none() && self.legacy_mask(safe_end, lanes, scanner));

        let mut frames: Vec<Value> = Vec::with_capacity(count);
        let mut spans = Vec::with_capacity(count);
        let mut separated = Vec::with_capacity(count);
        let mut keys = Vec::with_capacity(count);
        let mut raw_texts = Vec::with_capacity(count);
        let mut originals = Vec::with_capacity(count);
        let mut end = self.released_end;
        // Envelope fields carrying a value split across frames are masked on
        // the raw frames, before any key or value is rewritten.
        let split_envelope = self.split_envelope(&transform);
        // A batch judges its token mirrors together: they can run ahead of
        // their own frame (vLLM's held-back stop text, an empty-text chunk
        // carrying part of a character), so one change drops them all.
        let batch_mirrors = self.held.iter().take(count).any(HeldFrame::mirrors);
        for mut frame in self.held.drain(..count) {
            // The answer half continues the reasoning half's provider frame.
            self.released_runs
                .feed(&frame.value, !self.released_half, false, None);
            self.released_half = frame.reasoning_half;
            self.held_wire_bytes -= frame.wire_bytes;
            spans.push((end, frame.end));
            separated.push(frame.separated);
            keys.push(frame.key);
            raw_texts.push(super::lanes::released_texts(&frame.value));
            end = frame.end;
            debug_assert_eq!(frame.mirrors, super::super::has_token_mirrors(&frame.value));
            envelope::EnvelopeLanes::mask(&mut frame.value, &split_envelope);
            // Masking rewrites strings only, so the frame's mirrors are
            // still counted in `batch_mirrors`.
            debug_assert!(batch_mirrors || !super::super::has_token_mirrors(&frame.value));
            originals.push(batch_mirrors.then(|| frame.value.clone()));
            frames.push(frame.value);
        }
        let text_split = segments.is_some();
        let mut mask = mask_legacy;
        if let Some(segments) = segments {
            transform.swap_memo(&mut self.envelope_memo);
            for frame in &mut frames {
                transform.envelope(frame);
            }
            transform.swap_memo(&mut self.envelope_memo);
            mask = !redact::apply_segments(&mut frames, segments, &separated);
        } else {
            // On the raw strings: sanitizing redacted text would let a
            // secret rule's placeholder split a PII value (`sanitize_text`).
            for frame in &mut frames {
                if self.sanitize {
                    super::super::sanitize_json_strings(frame, scanner);
                } else {
                    super::super::redact_json_strings(frame, scanner);
                }
            }
        }
        // Each field's and copy's released text, raw and as sent; a field
        // that resumed after another, or a broken copy, is checked as one
        // lane before the last release.
        for (frame, raw) in frames.iter().zip(raw_texts) {
            self.fields.record(raw, frame, final_step);
            self.record_fixed(frame);
        }
        if final_step && !mask && self.fields.checked_mismatch(&transform) {
            mask = true;
        }
        // Fail closed before sending: on the per-string or masked path a
        // value split in another field of these frames can survive Sanitize
        // (the mask rewrites only text fields). Text-level frames carry the
        // fail-closed transform of the whole region already.
        if self.sanitize && (mask || !text_split) {
            if let Some(found) = released_survivor(&frames, mask, scanner) {
                self.refuse_survivor(output, &found);
                return;
            }
        }
        let drop_all = batch_mirrors
            && (self.sanitize
                || mask
                || frames
                    .iter()
                    .zip(&originals)
                    .any(|(frame, original)| original.as_ref().is_some_and(|o| o != frame)));
        for ((((frame, (start, frame_end)), separated), key), original) in frames
            .iter_mut()
            .zip(spans)
            .zip(separated)
            .zip(keys)
            .zip(originals)
        {
            // Token mirrors (logprobs, token ids) of a frame whose text was
            // rewritten would carry what was rewritten.
            if drop_all || self.sanitize || original.is_some_and(|original| original != *frame) {
                super::super::drop_choice_logprobs(frame);
            }
            if mask {
                super::super::mask_sse_payload_text(frame);
            }
            // The scan text has `FIELD_SEPARATOR` before a field switch; so
            // does the record of what was sent, so the two stay aligned.
            let mut sent = if separated {
                super::super::FIELD_SEPARATOR.to_owned()
            } else {
                String::new()
            };
            // Choice 0's text, as `self.text` holds it.
            super::super::primary_scan_text(frame, &mut sent);
            let text_level = text_split && !mask;
            // Sent nothing: it continued a value redacted into an earlier
            // frame, or carried no text at all.
            let own = if separated {
                &sent[super::super::FIELD_SEPARATOR.len()..]
            } else {
                sent.as_str()
            };
            let continued = text_level && own.trim_start_matches('\n').is_empty();
            // A frame adding no text released at text level changes nothing
            // any later check reads; recording it would only grow `recent`.
            if !(text_level && start == frame_end) {
                self.recent.push_back(super::SentFrame {
                    start,
                    end: frame_end,
                    sent,
                    key,
                    separated,
                    text_level,
                    continued,
                });
            }
            if let Ok(encoded) = serde_json::to_string(frame) {
                output.bytes.push_str("data: ");
                output.bytes.push_str(&encoded);
                output.bytes.push_str("\n\n");
                self.released_any = true;
            }
        }
        self.released_end = end;
    }

    /// End the stream with a block notice for a match Sanitize cannot remove.
    fn refuse_survivor(&mut self, output: &mut DlpOutput, found: &FirewallMatch) {
        output.blocked = true;
        output.violation.get_or_insert_with(|| found.clone());
        self.finished = true;
        let notice = format!(
            "[Ryu firewall] Response blocked: {} could not be redacted.",
            found.pattern_name
        );
        let separator = if self.released_any { "\n\n" } else { "" };
        output
            .bytes
            .push_str(&super::super::sse_content_frames(&format!(
                "{separator}{notice}"
            )));
    }

    /// Move the scan start behind the last release. The text before it is
    /// never needed again.
    pub(super) fn move_scan_start(&mut self, scanner: &dyn FirewallBackend) {
        let (new_from, cut_short) = self.scan_start_checked(self.released_end, scanner);
        if cut_short {
            // No start the whole text would give within reach (a run of
            // stripped characters or a chain too long): hold the rest whole
            // and judge it from the current start at the end.
            self.buffer_remaining = true;
            return;
        }
        if new_from > self.scan_from {
            let drained = &self.text[..new_from - self.base];
            let raw = super::carried::raw_tail(drained, self.carried_raw.take());
            let tail =
                super::reach::keyword_tail(&self.text[..new_from - self.base], self.carried.take());
            // Carried only while its value is still to come: a value already
            // released was judged with the keyword in an earlier region.
            // Complete tokens only: a release can end inside a word (`nu` of
            // `number`) or inside the value, neither of which is judged yet.
            let released_to = self.released_end.max(new_from) - self.base;
            let at_edge = self.text[released_to..]
                .chars()
                .next()
                .is_some_and(|character| {
                    character.is_ascii_whitespace() || super::reach::is_script_boundary(character)
                });
            let released_to = if at_edge {
                released_to
            } else {
                self.token_start(released_to, new_from - self.base)
            };
            let released_after = &self.text[new_from - self.base..released_to];
            self.carried = tail.filter(|tail| {
                super::reach::keyword_tail(released_after, Some(tail.clone())).is_some()
            });
            self.carried_raw = raw.filter(|raw| {
                self.carried.is_some()
                    && super::carried::raw_tail(released_after, Some(raw.clone())).is_some()
            });
            self.scan_from = new_from;
            // Only ASCII bytes are boundaries, so this is a char boundary.
            self.text.drain(..new_from - self.base);
            self.base = new_from;
        }
        while self
            .recent
            .front()
            .is_some_and(|frame| frame.end <= self.scan_from)
        {
            self.recent.pop_front();
        }
    }

    /// The text-level split of the region for the first `count` held
    /// frames. Released frames wholly in the region must transform as they
    /// were sent: otherwise the region's start groups the text differently
    /// from the earlier releases (overlapping candidates in `\s`-joined
    /// groups) and the split cannot be trusted (`None`). The check starts at
    /// the first released frame no replaced value crosses into.
    fn checked_split(
        &self,
        count: usize,
        safe_end: usize,
        transform: &redact::Transform<'_>,
    ) -> Option<Vec<String>> {
        let region = &self.text[self.scan_from - self.base..safe_end - self.base];
        let mut bounds = vec![self.released_end];
        bounds.extend(self.held.iter().take(count).map(|frame| frame.end));
        // `T(region)` and the rest every split below shares: one region, one
        // transform.
        let whole = std::cell::OnceCell::new();
        let cache = redact::RegionCache::new(&whole);
        let segments =
            redact::split_transformed_cached(region, self.scan_from, &bounds, transform, &cache)?;
        // Compared from the first frame released at text level since the
        // last masked or per-string one (their sent text is not the
        // transform), that starts its own segment.
        let in_reach: Vec<&super::SentFrame> = self
            .recent
            .iter()
            .filter(|frame| frame.start >= self.scan_from)
            .collect();
        let from = in_reach
            .iter()
            .rposition(|frame| !frame.text_level)
            .map_or(0, |index| index + 1);
        let Some(index) = (from..in_reach.len()).find(|index| !in_reach[*index].continued) else {
            return Some(segments);
        };
        // A release that ended mid-word: split the check at the word's start
        // (a sentinel inside it would add a word boundary) and compare the
        // word's released part as it is.
        // When that fails, compare a split at the release itself.
        let released = self.released_end - self.scan_from;
        let sent: String = in_reach[index..]
            .iter()
            .map(|frame| frame.sent.as_str())
            .collect();
        let start = in_reach[index].start;
        let middle = (self.scan_from + redact::word_start(region, released)).max(start);
        let agrees = |middle: usize| {
            let tail = &region[middle - self.scan_from..released];
            redact::split_transformed_cached(
                region,
                self.scan_from,
                &[start, middle, safe_end],
                transform,
                &cache,
            )
            .and_then(|check| check.into_iter().next())
            .is_some_and(|head| {
                sent.len() == head.len() + tail.len()
                    && sent.starts_with(head.as_str())
                    && sent[head.len()..] == *tail
            })
        };
        (agrees(middle) || (middle < self.released_end && agrees(self.released_end)))
            .then_some(segments)
    }
}
