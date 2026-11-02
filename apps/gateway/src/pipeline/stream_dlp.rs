//! Incremental outbound DLP for streaming responses.
//!
//! [`super::rewrite_sse_for_dlp`] buffers the whole provider stream, scans the
//! concatenated JSON string text once, and replays redacted frames. That is
//! exact, but the client sees nothing until generation finishes. This state
//! machine produces the same frames incrementally.
//!
//! Redaction and sanitization are per JSON string, so each frame's output does
//! not depend on later frames. Only the violation decision spans frames. That
//! decision is made over a sliding region of the concatenated text, and a frame
//! is released only when every match that could involve its text has been
//! scanned:
//!
//! - The scanned region always ends just after whitespace, and a frame is
//!   released only when it ends at least [`BOUNDED_MATCH_LEN`] bytes of the
//!   scan view (invisible characters count for nothing) before that point. Unbounded patterns (API keys, emails, connection strings)
//!   contain no whitespace, so any run they could match is complete and already
//!   scanned. Patterns that span whitespace are bounded, except for
//!   keyword-padding forms (`Bearer`, `api_key =`, `passport no.`) whose
//!   whitespace sits before the secret.
//! - The scan region reaches back at least [`SCAN_BACK`] bytes from the last
//!   release, then over [`SCAN_BACK_TOKENS`] more whitespace-separated tokens,
//!   so a keyword released ahead of a long run of padding is still in view
//!   when the secret after it arrives.
//! - Only ASCII whitespace counts as a boundary: `normalize_for_scan` strips
//!   zero-width characters and folds other spaces, which would otherwise join
//!   a run the raw text shows as split.
//!
//! Under `Block`, a violation ends the stream with the usual block notice.
//! Text released before the violation stays with the client, but no character
//! of the matched text is ever released. Streaming is used only with the
//! built-in pattern sets: custom patterns may span unbounded whitespace, so a
//! resolved scanner with custom patterns from any scope keeps the buffered
//! path. Both paths scan with the tenant-resolved scanner for the request.

use std::collections::VecDeque;

use serde_json::Value;

use crate::config::FirewallPolicy;
use crate::firewall::{FirewallBackend, FirewallMatch};

/// Longest built-in match that can contain whitespace without being one of the
/// keyword-padding forms (card numbers, IBANs, phones, the AWS secret form).
const BOUNDED_MATCH_LEN: usize = 192;
/// Minimum back-context, in bytes, kept in the scan region before the last
/// released position.
const SCAN_BACK: usize = 256;
/// Whitespace-separated tokens the scan region additionally reaches back over,
/// so `passport no. # AB123456` style keyword forms stay together.
const SCAN_BACK_TOKENS: usize = 4;
/// Held (unreleased) text above this fails closed, like the buffered path's
/// response cap.
const MAX_HELD_BYTES: usize = 8 * 1024 * 1024;

/// Error text for held text over [`MAX_HELD_BYTES`]; the driver answers it with
/// the same notice the buffered path gives when its response cap is exceeded.
const OVERSIZED: &str = "provider stream exceeded the scan buffer";

fn is_boundary_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r')
}

struct HeldFrame {
    value: Value,
    wire_bytes: usize,
    /// Absolute end offset of this frame's text in the concatenated text.
    end: usize,
}

/// What one step produced: SSE bytes to send, and whether the stream is over.
#[derive(Default)]
pub(super) struct DlpOutput {
    pub(super) bytes: String,
    /// A violation first seen in this step (for logging and metrics).
    pub(super) violation: Option<FirewallMatch>,
    /// The stream was ended by a `Block` violation; `bytes` ends with the notice.
    pub(super) blocked: bool,
}

pub(super) struct StreamingDlp {
    policy: FirewallPolicy,
    /// Whether `Block` / `Sanitize` are enforced (outbound on and not warn-only).
    enforce: bool,
    line: Vec<u8>,
    held: VecDeque<HeldFrame>,
    held_wire_bytes: usize,
    frame_violation: Option<FirewallMatch>,
    buffer_remaining: bool,
    /// Concatenated JSON string text from absolute offset `base` onward.
    text: String,
    base: usize,
    released_end: usize,
    scan_from: usize,
    scanned_to: usize,
    saw_done: bool,
    released_any: bool,
    violation: Option<FirewallMatch>,
    sanitize: bool,
    finished: bool,
}

impl StreamingDlp {
    pub(super) fn new(policy: FirewallPolicy, enforce: bool) -> Self {
        Self {
            policy,
            enforce,
            line: Vec::new(),
            held: VecDeque::new(),
            held_wire_bytes: 0,
            frame_violation: None,
            buffer_remaining: false,
            text: String::new(),
            base: 0,
            released_end: 0,
            scan_from: 0,
            scanned_to: 0,
            saw_done: false,
            released_any: false,
            violation: None,
            sanitize: false,
            finished: false,
        }
    }

    fn len(&self) -> usize {
        self.base + self.text.len()
    }

    /// Feed provider bytes. Complete lines are parsed; frames are released once
    /// safe. An `Err` means the stream cannot be scanned and must be refused.
    pub(super) fn push(
        &mut self,
        chunk: &[u8],
        scanner: &dyn FirewallBackend,
    ) -> Result<DlpOutput, String> {
        if self.finished {
            return Ok(DlpOutput::default());
        }
        let mut start = 0;
        for (index, byte) in chunk.iter().enumerate() {
            if *byte == b'\n' {
                self.line.extend_from_slice(&chunk[start..index]);
                let line = std::mem::take(&mut self.line);
                self.take_line(&line, scanner)?;
                start = index + 1;
            }
        }
        self.line.extend_from_slice(&chunk[start..]);
        if self.held_wire_bytes.max(self.text.len()) + self.line.len() > MAX_HELD_BYTES {
            return Err(OVERSIZED.to_owned());
        }
        Ok(self.advance(false, scanner))
    }

    /// End of the provider stream: release everything that is safe and close
    /// with `[DONE]` exactly as the buffered path does.
    pub(super) fn finish(&mut self, scanner: &dyn FirewallBackend) -> Result<DlpOutput, String> {
        if self.finished {
            return Ok(DlpOutput::default());
        }
        let line = std::mem::take(&mut self.line);
        if !line.is_empty() {
            self.take_line(&line, scanner)?;
        }
        let mut output = self.advance(true, scanner);
        if !output.blocked && (self.saw_done || self.released_any) {
            output.bytes.push_str("data: [DONE]\n\n");
        }
        self.finished = true;
        Ok(output)
    }

    /// One line, with the same rules as `rewrite_sse_for_dlp` (which splits with
    /// `str::lines`, so a trailing `\r` is dropped).
    fn take_line(&mut self, raw: &[u8], scanner: &dyn FirewallBackend) -> Result<(), String> {
        let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
        let line = String::from_utf8_lossy(raw);
        if line.trim().is_empty() {
            return Ok(());
        }
        let Some(data) = line.strip_prefix("data:") else {
            return Err("provider stream contained an unscannable event frame".to_owned());
        };
        let data = data.trim();
        if data.is_empty() {
            return Ok(());
        }
        if data == "[DONE]" {
            self.saw_done = true;
            return Ok(());
        }
        let value = serde_json::from_str::<Value>(data)
            .map_err(|error| format!("provider stream frame is not valid JSON: {error}"))?;
        self.buffer_remaining |= !super::simple_content_delta(&value);
        if self.frame_violation.is_none() {
            self.frame_violation = scanner.scan_outbound(&super::json_string_projection(&value));
        }
        super::collect_sse_payload_text(&value, &mut self.text);
        let end = self.len();
        self.held_wire_bytes += raw.len();
        self.held.push_back(HeldFrame {
            value,
            end,
            wire_bytes: raw.len(),
        });
        Ok(())
    }

    fn advance(&mut self, final_step: bool, scanner: &dyn FirewallBackend) -> DlpOutput {
        let mut output = DlpOutput::default();
        let len = self.len();
        // Scan through the last whitespace boundary (or everything at the end),
        // so a token still being generated is never judged on a partial form.
        let safe_end = if final_step {
            len
        } else {
            self.last_boundary_at_or_before(len)
        };
        let region = &self.text[self.scan_from - self.base..safe_end - self.base];
        let mut lanes = std::collections::BTreeMap::new();
        if final_step && self.buffer_remaining {
            lanes.insert(
                "/choices/0/delta/content".to_owned(),
                self.text[self.scan_from - self.base..self.released_end - self.base].to_owned(),
            );
            for frame in &self.held {
                super::collect_sse_payload_lanes(&frame.value, "", &mut lanes);
            }
        }
        let pending = self
            .frame_violation
            .take()
            .or_else(|| {
                (safe_end > self.scanned_to && safe_end > self.scan_from)
                    .then(|| scanner.scan_outbound(region))
                    .flatten()
            })
            .or_else(|| lanes.values().find_map(|text| scanner.scan_outbound(text)));
        if self.violation.is_none() {
            if let Some(found) = pending {
                output.violation = Some(found.clone());
                self.violation = Some(found.clone());
                if self.enforce {
                    match self.policy {
                        FirewallPolicy::Block => {
                            output.blocked = true;
                            self.finished = true;
                            let notice = format!(
                                "[Ryu firewall] Response blocked by policy: {} ({:?}).",
                                found.pattern_name, found.kind
                            );
                            if self.released_any {
                                output
                                    .bytes
                                    .push_str(&super::sse_content_frames(&format!("\n\n{notice}")));
                            } else {
                                output.bytes.push_str(&super::sse_content_frames(&notice));
                            }
                            return output;
                        }
                        FirewallPolicy::Sanitize => self.sanitize = true,
                        FirewallPolicy::WarnAndContinue => {}
                    }
                }
            }
        }
        self.scanned_to = self.scanned_to.max(safe_end);
        // `sanitize_pending` reads the normalized view too, so a match only the
        // fold reveals (split across deltas by a zero-width character, or in
        // fullwidth) masks the held payload rather than passing unchanged.
        let needs_redaction = scanner.redact_outbound(region).0 != region
            || (self.sanitize && super::sanitize_pending(region, scanner))
            || lanes.values().any(|text| {
                scanner.redact_outbound(text).0 != *text
                    || (self.sanitize && super::sanitize_pending(text, scanner))
            });
        let mask_payload = if needs_redaction {
            let mut remaining =
                self.text[self.scan_from - self.base..self.released_end - self.base].to_owned();
            let mut remaining_lanes = std::collections::BTreeMap::new();
            remaining_lanes.insert(
                "/choices/0/delta/content".to_owned(),
                self.text[self.scan_from - self.base..self.released_end - self.base].to_owned(),
            );
            for frame in &self.held {
                let mut value = frame.value.clone();
                if self.sanitize {
                    super::sanitize_json_strings(&mut value, scanner);
                } else {
                    super::redact_json_strings(&mut value, scanner);
                }
                super::collect_sse_payload_text(&value, &mut remaining);
                super::collect_sse_payload_lanes(&value, "", &mut remaining_lanes);
            }
            scanner.redact_outbound(&remaining).0 != remaining
                || (self.sanitize && super::sanitize_pending(&remaining, scanner))
                || remaining_lanes.values().any(|text| {
                    scanner.redact_outbound(text).0 != *text
                        || (self.sanitize && super::sanitize_pending(text, scanner))
                })
        } else {
            false
        };
        // Fail closed before releasing: the mask rewrites only choice text, so
        // a split in another field of the held frames can survive Sanitize.
        // Nothing is released while every frame is held, so check only then.
        if self.sanitize && mask_payload && (final_step || !self.buffer_remaining) {
            if let Some(found) = self.held_sanitize_survivor(scanner) {
                return self.refuse_survivor(output, &found);
            }
        }

        // Release every held frame that ends at least BOUNDED_MATCH_LEN
        // scan-view bytes before `safe_end` (see `bounded_cut`). `safe_end`
        // follows whitespace, so the whitespace-free run around any earlier
        // position is complete and was inside the region just scanned, and
        // any bounded match crossing it ends inside it too.
        let cut = if final_step {
            len
        } else if self.buffer_remaining {
            0
        } else {
            self.bounded_cut(safe_end)
        };
        let mut release = 0;
        for (index, frame) in self.held.iter().enumerate() {
            if (self.buffer_remaining && !final_step) || frame.end > cut {
                break;
            }
            release = index + 1;
        }
        for _ in 0..release {
            let Some(mut frame) = self.held.pop_front() else {
                break;
            };
            self.held_wire_bytes -= frame.wire_bytes;
            if self.sanitize {
                super::sanitize_json_strings(&mut frame.value, scanner);
                super::drop_choice_logprobs(&mut frame.value);
            } else {
                super::redact_json_strings(&mut frame.value, scanner);
            }
            if mask_payload {
                super::mask_sse_payload_text(&mut frame.value);
            }
            if let Ok(encoded) = serde_json::to_string(&frame.value) {
                output.bytes.push_str("data: ");
                output.bytes.push_str(&encoded);
                output.bytes.push_str("\n\n");
                self.released_any = true;
            }
            self.released_end = frame.end;
        }
        if release > 0 && !final_step {
            self.move_scan_start();
        }
        output
    }

    /// The position [`BOUNDED_MATCH_LEN`] bytes of the scan view before
    /// `safe_end`. Lengths are counted as `normalize_for_scan` reads them:
    /// invisible, combining and TAG characters count for nothing and a
    /// fullwidth or other folded character for its ASCII fold, so zero-width
    /// padding or 3-byte digits cannot stretch a bounded match past the window
    /// and release its start before the scan sees all of it.
    fn bounded_cut(&self, safe_end: usize) -> usize {
        let head = &self.text[..safe_end - self.base];
        let mut seen = 0;
        let mut buffer = [0u8; 4];
        for (index, c) in head.char_indices().rev() {
            seen += if c.is_ascii() {
                1
            } else if ('\u{E0000}'..='\u{E007F}').contains(&c) {
                0
            } else {
                ryu_gw_firewall::fold_for_redaction(c.encode_utf8(&mut buffer)).len()
            };
            if seen >= BOUNDED_MATCH_LEN {
                return self.base + index;
            }
        }
        self.base.min(safe_end.saturating_sub(BOUNDED_MATCH_LEN))
    }

    /// The redact-category match still on the held frames once they are
    /// sanitized and masked as they would be released.
    fn held_sanitize_survivor(&self, scanner: &dyn FirewallBackend) -> Option<FirewallMatch> {
        let held = self
            .held
            .iter()
            .map(|frame| {
                let mut value = frame.value.clone();
                super::sanitize_json_strings(&mut value, scanner);
                super::mask_sse_payload_text(&mut value);
                value
            })
            .collect();
        super::sse_sanitize_survivor(&Value::Array(held), scanner)
    }

    /// End the stream with a block notice for a match Sanitize cannot remove.
    fn refuse_survivor(&mut self, mut output: DlpOutput, found: &FirewallMatch) -> DlpOutput {
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
            .push_str(&super::sse_content_frames(&format!("{separator}{notice}")));
        output
    }

    /// The last position at or before `limit` that follows ASCII whitespace.
    fn last_boundary_at_or_before(&self, limit: usize) -> usize {
        let bytes = self.text.as_bytes();
        let end = limit.saturating_sub(self.base).min(bytes.len());
        bytes[..end]
            .iter()
            .rposition(|byte| is_boundary_space(*byte))
            .map_or(self.scan_from, |index| self.base + index + 1)
    }

    /// Move the scan start behind the last release: `SCAN_BACK` bytes, back to a
    /// token start, then over `SCAN_BACK_TOKENS` more tokens and the whitespace
    /// between them. The text before it is never needed again.
    fn move_scan_start(&mut self) {
        let bytes = self.text.as_bytes();
        let mut index = self.released_end.saturating_sub(SCAN_BACK).max(self.base) - self.base;
        // Back to the start of the token containing `index`.
        while index > 0 && !is_boundary_space(bytes[index - 1]) {
            index -= 1;
        }
        for _ in 0..SCAN_BACK_TOKENS {
            while index > 0 && is_boundary_space(bytes[index - 1]) {
                index -= 1;
            }
            while index > 0 && !is_boundary_space(bytes[index - 1]) {
                index -= 1;
            }
        }
        let new_from = self.base + index;
        if new_from > self.scan_from {
            self.scan_from = new_from;
            // Only ASCII bytes are boundaries, so this is a char boundary.
            self.text.drain(..new_from - self.base);
            self.base = new_from;
        }
    }
}

#[path = "stream_dlp_body.rs"]
mod body;
pub(super) use body::dlp_body;

#[cfg(test)]
#[path = "stream_dlp_test.rs"]
mod tests;
