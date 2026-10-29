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
//!   released only when it ends at least [`BOUNDED_MATCH_LEN`] bytes before
//!   that point. Unbounded patterns (API keys, emails, connection strings)
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
        let needs_redaction = scanner.redact_outbound(region).0 != region
            || (self.sanitize && scanner.sanitize(region) != region)
            || lanes.values().any(|text| {
                scanner.redact_outbound(text).0 != *text
                    || (self.sanitize && scanner.sanitize(text) != *text)
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
                || (self.sanitize && scanner.sanitize(&remaining) != remaining)
                || remaining_lanes.values().any(|text| {
                    scanner.redact_outbound(text).0 != *text
                        || (self.sanitize && scanner.sanitize(text) != *text)
                })
        } else {
            false
        };

        // Release every held frame that ends at least BOUNDED_MATCH_LEN before
        // `safe_end`. `safe_end` follows whitespace, so the whitespace-free run
        // around any earlier position is complete and was inside the region
        // just scanned, and any bounded match crossing it ends inside it too.
        let cut = if final_step {
            len
        } else if self.buffer_remaining {
            0
        } else {
            safe_end.saturating_sub(BOUNDED_MATCH_LEN)
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

/// Stream `upstream` to the client through [`StreamingDlp`], logging, counting
/// and auditing violations the way the buffered path does. `scanner` is the
/// tenant-resolved scanner for `ctx` (`AppState::resolved_scanner`), never the
/// node base, and `policy` / `enforce` / `outbound_enabled` are read from it:
/// `enforce` is whether `Block` / `Sanitize` apply; `outbound_enabled` gates the
/// warn-only log.
pub(super) fn dlp_body(
    upstream: axum::body::Body,
    state: std::sync::Arc<crate::state::AppState>,
    ctx: super::RequestContext,
    scanner: std::sync::Arc<crate::firewall::FirewallScanner>,
    policy: FirewallPolicy,
    enforce: bool,
    outbound_enabled: bool,
) -> axum::body::Body {
    use futures_util::StreamExt;

    struct Driver {
        upstream: axum::body::BodyDataStream,
        dlp: StreamingDlp,
        state: std::sync::Arc<crate::state::AppState>,
        ctx: super::RequestContext,
        scanner: std::sync::Arc<crate::firewall::FirewallScanner>,
        request_id: String,
        policy: FirewallPolicy,
        enforce: bool,
        outbound_enabled: bool,
        done: bool,
        /// The upstream returned `None`. It is an `Unfold` (the usage
        /// observer), which panics if polled again, so it is never drained
        /// after this.
        upstream_ended: bool,
    }

    impl Driver {
        fn report(&self, output: &DlpOutput) {
            let Some(found) = output.violation.as_ref() else {
                return;
            };
            let pattern = &found.pattern_name;
            match self.policy {
                FirewallPolicy::Block if self.enforce => {
                    tracing::warn!(request_id = %self.request_id, pattern = %pattern, "firewall: blocked outbound response (streaming)");
                    self.state.metrics.inc_firewall_blocked();
                    if output.blocked {
                        super::audit_stream_dlp_block(
                            &self.state,
                            &self.ctx,
                            pattern,
                            &format!("{:?}", found.kind),
                        );
                    }
                }
                FirewallPolicy::Sanitize if self.enforce => {
                    tracing::warn!(request_id = %self.request_id, pattern = %pattern, "firewall: sanitized outbound response (streaming)");
                }
                FirewallPolicy::WarnAndContinue if self.outbound_enabled => {
                    tracing::warn!(request_id = %self.request_id, pattern = %pattern, "firewall: outbound violation (warn-and-continue, streaming)");
                }
                _ => {}
            }
        }

        fn refuse(&mut self, message: &str) -> bytes::Bytes {
            self.done = true;
            self.state.metrics.inc_firewall_blocked();
            bytes::Bytes::from(super::sse_content_frames(message))
        }
    }

    let driver = Driver {
        upstream: upstream.into_data_stream(),
        dlp: StreamingDlp::new(policy.clone(), enforce),
        state,
        request_id: ctx.request_id.clone(),
        ctx,
        scanner,
        policy,
        enforce,
        outbound_enabled,
        done: false,
        upstream_ended: false,
    };

    let stream = futures_util::stream::unfold(driver, |mut driver| async move {
        // Loop until there is something to send: an empty chunk is never yielded.
        while !driver.done {
            let step = match driver.upstream.next().await {
                Some(Ok(chunk)) => driver.dlp.push(&chunk, driver.scanner.as_ref()),
                Some(Err(error)) => {
                    tracing::warn!(request_id = %driver.request_id, %error, "firewall: provider stream failed during outbound scan");
                    let refused = driver.refuse(
                        "[Ryu firewall] Unable to scan the response stream; request aborted.",
                    );
                    return Some((Ok::<_, std::io::Error>(refused), driver));
                }
                None => {
                    driver.done = true;
                    driver.upstream_ended = true;
                    driver.dlp.finish(driver.scanner.as_ref())
                }
            };
            match step {
                Ok(output) => {
                    driver.report(&output);
                    if output.blocked && !driver.upstream_ended {
                        // The usage observer wraps the original provider body.
                        // Drain it without releasing bytes so its final usage
                        // frame still settles the request once. The caller's
                        // admission permit remains held until this completes.
                        // A block decided in `finish` has nothing left to drain:
                        // the upstream already ended and settled its usage.
                        let drain = async {
                            let mut bytes = 0usize;
                            while let Some(chunk) = driver.upstream.next().await {
                                match chunk {
                                    Ok(chunk) => bytes += chunk.len(),
                                    Err(_) => break,
                                }
                                if bytes > MAX_HELD_BYTES {
                                    break;
                                }
                            }
                        };
                        if tokio::time::timeout(std::time::Duration::from_secs(300), drain)
                            .await
                            .is_err()
                        {
                            tracing::warn!(request_id = %driver.request_id, "firewall: timed out draining blocked provider stream for usage");
                        }
                        driver.done = true;
                    }
                    if !output.bytes.is_empty() {
                        return Some((Ok(bytes::Bytes::from(output.bytes)), driver));
                    }
                }
                Err(error) if error == OVERSIZED => {
                    tracing::warn!(request_id = %driver.request_id, %error, "firewall: failed to buffer stream for outbound scan");
                    let refused = driver.refuse(
                        "[Ryu firewall] Unable to scan the response stream; request aborted.",
                    );
                    return Some((Ok(refused), driver));
                }
                Err(error) => {
                    tracing::warn!(request_id = %driver.request_id, %error, "firewall: unscannable response stream");
                    let refused = driver.refuse(
                        "[Ryu firewall] Response blocked because the provider stream could not be scanned.",
                    );
                    return Some((Ok(refused), driver));
                }
            }
        }
        None
    });
    axum::body::Body::from_stream(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::FirewallConfig;
    use crate::firewall::FirewallScanner;

    fn scanner() -> FirewallScanner {
        FirewallScanner::new_scoped(FirewallConfig::default())
    }

    fn content_frame(id: &str, text: &str) -> String {
        let frame = serde_json::json!({
            "id": id,
            "object": "chat.completion.chunk",
            "choices": [{ "index": 0, "delta": { "content": text } }]
        });
        format!("data: {frame}\n\n")
    }

    fn stream_of(words: &[&str]) -> String {
        let mut raw = String::new();
        for (index, word) in words.iter().enumerate() {
            raw.push_str(&content_frame(&format!("c{index}"), word));
        }
        raw.push_str("data: [DONE]\n\n");
        raw
    }

    /// Content-only frames for testing token boundaries without envelope fields.
    fn bare_stream(parts: &[&str]) -> String {
        let mut raw = String::new();
        for part in parts {
            let frame = serde_json::json!({ "choices": [{ "delta": { "content": part } }] });
            raw.push_str(&format!(
                "data: {frame}

"
            ));
        }
        raw.push_str(
            "data: [DONE]

",
        );
        raw
    }

    /// `fragment` as it would appear inside a JSON string in the output.
    fn json_fragment(fragment: &str) -> String {
        let encoded = serde_json::to_string(fragment).unwrap();
        encoded[1..encoded.len() - 1].to_owned()
    }

    /// Feed `raw` split at the given byte offsets.
    fn run_streaming(
        raw: &str,
        splits: &[usize],
        policy: FirewallPolicy,
        scanner: &FirewallScanner,
    ) -> Result<(String, bool), String> {
        let enforce = !matches!(policy, FirewallPolicy::WarnAndContinue);
        let mut dlp = StreamingDlp::new(policy, enforce);
        let bytes = raw.as_bytes();
        let mut out = String::new();
        let mut last = 0;
        let mut offsets: Vec<usize> = splits
            .iter()
            .copied()
            .filter(|s| *s < bytes.len())
            .collect();
        offsets.sort_unstable();
        offsets.push(bytes.len());
        for offset in offsets {
            if offset < last {
                continue;
            }
            let step = dlp.push(&bytes[last..offset], scanner)?;
            out.push_str(&step.bytes);
            last = offset;
            if step.blocked {
                return Ok((out, true));
            }
        }
        let step = dlp.finish(scanner)?;
        out.push_str(&step.bytes);
        Ok((out, step.blocked))
    }

    /// Deterministic pseudo-random split points.
    fn splits(raw: &str, seed: u64, count: usize) -> Vec<usize> {
        let mut state = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (0..count)
            .map(|_| {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                (state >> 33) as usize % raw.len().max(1)
            })
            .collect()
    }

    const WORDS: &[&str] = &[
        "The ",
        "quick ",
        "brown ",
        "fox ",
        "jumps ",
        "over ",
        "the ",
        "lazy ",
        "dog. ",
        "Streaming ",
        "keeps ",
        "responses ",
        "responsive ",
        "while ",
        "the ",
        "firewall ",
        "still ",
        "reads ",
        "every ",
        "frame.\n",
        "Überprüfung ",
        "läuft ",
        "weiter ",
        "🙂 ",
        "code: ",
        "fn ",
        "main() ",
        "{}\n",
        "tab\tseparated ",
        "line\r\n",
    ];

    fn long_clean_stream(seed: u64, frames: usize) -> String {
        let mut state = seed;
        let words: Vec<&str> = (0..frames)
            .map(|_| {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
                WORDS[(state >> 33) as usize % WORDS.len()]
            })
            .collect();
        stream_of(&words)
    }

    #[test]
    fn clean_streams_match_the_buffered_rewrite_byte_for_byte() {
        let scanner = scanner();
        for seed in 0..40u64 {
            let raw = long_clean_stream(seed, 300);
            let (buffered, _, violation) =
                super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
            assert!(violation.is_none());
            for split_seed in 0..5u64 {
                let (streamed, blocked) = run_streaming(
                    &raw,
                    &splits(&raw, seed * 31 + split_seed, 60),
                    FirewallPolicy::Block,
                    &scanner,
                )
                .unwrap();
                assert!(!blocked);
                assert_eq!(streamed, buffered, "seed {seed}/{split_seed}");
            }
        }
    }

    #[test]
    fn clean_output_is_released_before_the_stream_ends() {
        let scanner = scanner();
        let raw = long_clean_stream(7, 400);
        let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
        let half = raw.len() / 2;
        let early = dlp.push(&raw.as_bytes()[..half], &scanner).unwrap();
        assert!(
            early.bytes.starts_with("data: "),
            "nothing streamed before the end"
        );
    }

    /// OpenAI-shaped chunk with the boilerplate strings real providers send.
    fn provider_frame(index: usize, text: &str) -> String {
        let frame = serde_json::json!({
            "id": "chatcmpl-9x7Yq2LmN4pQ",
            "object": "chat.completion.chunk",
            "created": 1_727_000_000 + index,
            "model": "gpt-4o-mini-2024-07-18",
            "system_fingerprint": "fp_0ba0d124f1",
            "choices": [{ "index": 0, "delta": { "content": text }, "finish_reason": null }]
        });
        format!(
            "data: {frame}

"
        )
    }

    #[test]
    fn realistic_frames_stream_early_and_still_block_a_secret() {
        let scanner = scanner();
        let words = [
            "Here ", "is ", "a ", "short ", "answer ", "that ", "keeps ", "going. ",
        ];
        let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
        let mut first_release = None;
        for index in 0..200 {
            let frame = provider_frame(index, words[index % words.len()]);
            let output = dlp.push(frame.as_bytes(), &scanner).unwrap();
            if first_release.is_none() && !output.bytes.is_empty() {
                first_release = Some(index);
            }
        }
        // Text reaches the client after a handful of frames, not at the end.
        let first_release = first_release.expect("nothing released");
        assert!(
            first_release < 100,
            "first release after {first_release} frames"
        );

        let mut raw = String::new();
        for index in 0..60 {
            raw.push_str(&provider_frame(index, words[index % words.len()]));
        }
        raw.push_str(&provider_frame(
            60,
            "the key is sk-abcdefghijklmnopqrstuvwxyz0123 ok ",
        ));
        for index in 61..120 {
            raw.push_str(&provider_frame(index, words[index % words.len()]));
        }
        raw.push_str(
            "data: [DONE]

",
        );
        for split_seed in 0..6u64 {
            let (streamed, blocked) = run_streaming(
                &raw,
                &splits(&raw, split_seed, 50),
                FirewallPolicy::Block,
                &scanner,
            )
            .unwrap();
            assert!(blocked);
            assert!(!streamed.contains("sk-abcdefghij"));
        }
    }

    /// (name, fragments of one match). Every fragment is part of the match.
    fn secret_cases() -> Vec<(&'static str, Vec<&'static str>)> {
        vec![
            (
                "openai key",
                vec!["sk-abcdefghij", "klmnopqrstuvwxyz", "0123"],
            ),
            (
                "github pat",
                vec!["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"],
            ),
            (
                "email",
                vec!["someone.with.a.long.local.part", "@example", ".com"],
            ),
            ("pem", vec!["-----BEGIN ", "PRIVATE ", "KEY-----"]),
            (
                "db url",
                vec!["postgres://", "admin:hunter2", "@db.internal"],
            ),
            ("ssn", vec!["123-", "45-", "6789"]),
        ]
    }

    #[test]
    fn provider_metadata_does_not_hide_secrets_split_across_content_deltas() {
        let scanner = scanner();
        for (name, fragments) in secret_cases() {
            let mut raw = String::new();
            for index in 0..80 {
                raw.push_str(&provider_frame(index, "clean context before the answer "));
            }
            for (index, fragment) in fragments.iter().enumerate() {
                raw.push_str(&provider_frame(80 + index, fragment));
            }
            raw.push_str(&provider_frame(100, " trailing text "));
            raw.push_str("data: [DONE]\n\n");
            let (streamed, blocked) =
                run_streaming(&raw, &splits(&raw, 17, 80), FirewallPolicy::Block, &scanner)
                    .unwrap();
            assert!(blocked, "{name}: provider metadata hid a split secret");
            let released = streamed.split("Response blocked by policy").next().unwrap();
            for fragment in fragments {
                assert!(
                    !released.contains(&format!("\"{}\"", json_fragment(fragment))),
                    "{name}: secret fragment escaped"
                );
            }
        }
    }

    #[test]
    fn split_external_tokens_are_redacted_under_warn_and_sanitize() {
        let scanner = scanner();
        let fragments = ["gho_", "abcdefghijklmnopqrstuvwxyz", "0123456789"];
        let mut raw = String::new();
        for (index, fragment) in fragments.iter().enumerate() {
            raw.push_str(&provider_frame(index, fragment));
        }
        raw.push_str(&provider_frame(3, " trailing context "));
        raw.push_str("data: [DONE]\n\n");
        for policy in [FirewallPolicy::WarnAndContinue, FirewallPolicy::Sanitize] {
            let (streamed, blocked) =
                run_streaming(&raw, &splits(&raw, 13, 20), policy.clone(), &scanner).unwrap();
            let (buffered, _, _) =
                super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
            assert!(!blocked);
            for fragment in fragments {
                assert!(
                    !streamed.contains(fragment),
                    "streamed a split token fragment"
                );
                assert!(
                    !buffered.contains(fragment),
                    "buffered a split token fragment"
                );
            }
            assert!(streamed.contains("[REDACTED]"));
        }
    }

    #[test]
    fn interleaved_tool_argument_lanes_cannot_hide_split_tokens() {
        let scanner = scanner();
        let mut raw = String::new();
        for arguments in ["ghp_", "abcdefghijklmnopqrstuvwxyz", "0123456789"] {
            let frame = serde_json::json!({ "choices": [{ "index": 0, "delta": {
                "tool_calls": [
                    { "index": 0, "function": { "arguments": arguments } },
                    { "index": 1, "function": { "arguments": "unrelated text " } }
                ]
            }}] });
            raw.push_str(&format!("data: {frame}\n\n"));
        }
        raw.push_str("data: [DONE]\n\n");
        let (streamed, blocked) =
            run_streaming(&raw, &splits(&raw, 13, 20), FirewallPolicy::Block, &scanner).unwrap();
        assert!(blocked);
        assert!(!streamed.contains("ghp_"));
        let (streamed, _) = run_streaming(
            &raw,
            &splits(&raw, 13, 20),
            FirewallPolicy::WarnAndContinue,
            &scanner,
        )
        .unwrap();
        assert!(!streamed.contains("ghp_"));
        assert!(streamed.contains("[REDACTED]"));
    }

    #[test]
    fn tool_name_fragments_without_content_are_held_and_redacted() {
        let scanner = scanner();
        let mut raw = String::new();
        for name in ["ghp_", "abcdefghijklmnopqrstuvwxyz", "0123456789"] {
            let frame = serde_json::json!({ "choices": [{ "index": 0, "delta": {
                "tool_calls": [{ "index": 0, "type": "function", "function": { "name": name } }]
            }}] });
            raw.push_str(&format!("data: {frame}\n\n"));
        }
        let mut dlp = StreamingDlp::new(FirewallPolicy::WarnAndContinue, true);
        assert!(dlp.push(raw.as_bytes(), &scanner).unwrap().bytes.is_empty());
        let finished = dlp.finish(&scanner).unwrap();
        assert!(!finished.bytes.contains("ghp_"));
        assert!(finished.bytes.contains("[REDACTED]"));
        assert!(finished.bytes.contains("\"type\":\"function\""));
        let (buffered, _, _) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::WarnAndContinue)
                .unwrap();
        assert!(!buffered.contains("ghp_"));
    }

    #[test]
    fn no_fragment_of_a_secret_is_released_and_the_stream_is_blocked() {
        let scanner = scanner();
        for (name, fragments) in secret_cases() {
            let mut parts: Vec<&str> = Vec::new();
            for _ in 0..40 {
                parts.extend_from_slice(&["filler ", "words ", "before ", "it "]);
            }
            parts.extend(fragments.iter().copied());
            parts.push(" ");
            for _ in 0..40 {
                parts.extend_from_slice(&["and ", "after "]);
            }
            let raw = bare_stream(&parts);
            let (_, _, oracle) =
                super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
            assert!(oracle.is_some(), "{name}: oracle must flag it");
            for split_seed in 0..8u64 {
                let (streamed, blocked) = run_streaming(
                    &raw,
                    &splits(&raw, split_seed, 40),
                    FirewallPolicy::Block,
                    &scanner,
                )
                .unwrap();
                assert!(blocked, "{name}/{split_seed}: not blocked");
                let released = streamed.split("Response blocked by policy").next().unwrap();
                for fragment in &fragments {
                    assert!(
                        !released.contains(&format!("\"{}\"", json_fragment(fragment))),
                        "{name}/{split_seed}: fragment {fragment:?} released"
                    );
                }
            }
        }
    }

    #[test]
    fn keyword_padding_cannot_push_the_keyword_out_of_view() {
        let scanner = scanner();
        let padding = " ".repeat(3000);
        let cases: Vec<Vec<String>> = vec![
            vec![
                "Authorization: Bearer".into(),
                padding.clone(),
                "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH".into(),
            ],
            vec![
                "api_key".into(),
                padding.clone(),
                "=".into(),
                padding.clone(),
                "abcdefghijklmnopqrstuvwxyz0123".into(),
            ],
            vec![
                "passport".into(),
                padding.clone(),
                "no.".into(),
                padding.clone(),
                "AB1234567".into(),
            ],
        ];
        for parts in cases {
            let secret = parts.last().unwrap().clone();
            let mut words: Vec<String> = vec!["intro ".into(); 50];
            words.extend(parts);
            words.push(" trailing".into());
            let refs: Vec<&str> = words.iter().map(String::as_str).collect();
            let raw = bare_stream(&refs);
            let (_, _, oracle) =
                super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
            assert!(oracle.is_some());
            for split_seed in 0..6u64 {
                let (streamed, blocked) = run_streaming(
                    &raw,
                    &splits(&raw, split_seed, 80),
                    FirewallPolicy::Block,
                    &scanner,
                )
                .unwrap();
                assert!(blocked, "padded secret not blocked");
                assert!(!streamed.contains(&secret));
            }
        }
    }

    #[test]
    fn obfuscated_secrets_are_still_caught() {
        let scanner = scanner();
        // Zero-width split and fullwidth letters are normalized before matching.
        let zero_width = "sk-abcdefghij\u{200B}klmnopqrstuvwxyz";
        let fullwidth = "ｓｋ-abcdefghijklmnopqrstuvwxyz0123";
        for secret in [zero_width, fullwidth] {
            let mut words = vec!["lead "; 60];
            words.push(secret);
            words.push(" tail");
            let raw = bare_stream(&words);
            let (_, _, oracle) =
                super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
            let (streamed, blocked) =
                run_streaming(&raw, &splits(&raw, 11, 30), FirewallPolicy::Block, &scanner)
                    .unwrap();
            assert!(oracle.is_some());
            assert!(blocked);
            assert!(!streamed.contains(&json_fragment(secret)));
        }
    }

    #[test]
    fn tool_call_arguments_are_redacted_per_frame() {
        let scanner = scanner();
        let secret = "gho_abcdefghijklmnopqrstuvwxyz0123456789";
        let frame = serde_json::json!({
            "choices": [{ "delta": { "tool_calls": [{ "function": { "arguments": secret } }] } }]
        });
        let raw = format!("data: {frame}\n\ndata: [DONE]\n\n");
        let (buffered, _, _) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::WarnAndContinue)
                .unwrap();
        let (streamed, _) = run_streaming(
            &raw,
            &[5, 17, 40],
            FirewallPolicy::WarnAndContinue,
            &scanner,
        )
        .unwrap();
        assert_eq!(streamed, buffered);
        assert!(!streamed.contains(secret));
    }

    #[test]
    fn sanitize_redacts_the_violation_and_keeps_streaming() {
        let scanner = scanner();
        let mut words = vec!["lead "; 80];
        words.push("reach me at someone@example.com please ");
        words.extend(vec!["tail "; 80]);
        let raw = stream_of(&words);
        let (streamed, blocked) = run_streaming(
            &raw,
            &splits(&raw, 5, 50),
            FirewallPolicy::Sanitize,
            &scanner,
        )
        .unwrap();
        assert!(!blocked);
        assert!(!streamed.contains("someone@example.com"));
        assert!(streamed.ends_with("data: [DONE]\n\n"));
    }

    #[test]
    fn malformed_frames_and_crlf_follow_the_buffered_rules() {
        let scanner = scanner();
        let crlf =
            content_frame("a", "hello ").replace("\n\n", "\r\n\r\n") + "data: [DONE]\r\n\r\n";
        let (buffered, _, _) =
            super::super::rewrite_sse_for_dlp(&crlf, &scanner, &FirewallPolicy::Block).unwrap();
        let (streamed, _) =
            run_streaming(&crlf, &[3, 9, 30], FirewallPolicy::Block, &scanner).unwrap();
        assert_eq!(streamed, buffered);

        assert!(run_streaming(
            "data: {not-json}\n\n",
            &[4],
            FirewallPolicy::Block,
            &scanner
        )
        .is_err());
        assert!(run_streaming("event: ping\n\n", &[], FirewallPolicy::Block, &scanner).is_err());
    }
}
