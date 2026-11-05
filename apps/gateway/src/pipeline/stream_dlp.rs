//! Incremental outbound DLP for streaming responses.
//!
//! [`super::rewrite_sse_for_dlp`] buffers the whole provider stream, scans the
//! concatenated JSON string text once, and replays redacted frames. That is
//! exact, but the client sees nothing until generation finishes. This state
//! machine produces the same frames incrementally.
//!
//! Content deltas are redacted at text level over the joined text (see
//! `stream_dlp/redact.rs`); the violation decision is made over a sliding
//! region of that text, and a frame is released only when every match that
//! could involve its text has been scanned:
//!
//! - The scanned region always ends just after whitespace. Unbounded patterns
//!   (API keys, emails, connection strings) contain no whitespace, so any run
//!   they could match before that point is complete and already scanned.
//!   Patterns that span whitespace are at most [`BOUNDED_MATCH_LEN`] long and
//!   start at a recognisable token (digits, `aws`, `-----`, a padding keyword),
//!   so a frame is released only up to the earliest such token in that window
//!   (`release_cut`); plain prose streams word by word. Keyword-padding forms
//!   (`Bearer`, `api_key =`, `passport no.`) can pad past the window; their
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

use std::collections::{BTreeMap, VecDeque};

use crate::config::FirewallPolicy;
use crate::firewall::{FirewallBackend, FirewallMatch};

/// Longest built-in match that can contain whitespace without being one of the
/// keyword-padding forms (card numbers, IBANs, phones, the AWS secret form),
/// in bytes of the scan view (zero-width, combining and TAG characters count
/// for nothing and a fullwidth one for its fold, see [`reach::scan_width`]).
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

use records::{DlpOutput, HeldFrame, SentFrame};

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
    /// The standing guard's refusal frames (`ingest::take_line`).
    refusals: Vec<serde_json::Value>,
    /// Wire bytes of `refusals`, counted towards the held limit.
    refusal_bytes: usize,
    released_any: bool,
    violation: Option<FirewallMatch>,
    sanitize: bool,
    finished: bool,
    /// Provider envelope values per field (see `envelope.rs`).
    envelope: envelope::EnvelopeLanes,
    /// Released frames still behind `scan_from`'s reach: raw start and end
    /// offsets and the text actually sent, so the per-string fallback compares
    /// against what the client received rather than the raw text.
    recent: VecDeque<SentFrame>,
    /// An open keyword-padding form whose keyword was drained before its value
    /// arrived (`reach::keyword_tail`); prepended to detection scans.
    carried: Option<String>,
    /// `carried` as the raw text holds it, if it does (`carried::raw_tail`).
    carried_raw: Option<String>,
    /// Absolute offset just after the last ASCII whitespace received.
    last_space: usize,
    /// `(base, safe_end, cut)` of the last `release_cut`, reused while the scan end holds.
    cut_memo: Option<(usize, usize, usize, bool)>,
    /// `(token end, frames over it sent raw)` for a long-token scan start.
    long_token: Option<(usize, bool)>,
    /// The text lane (`TextLane`) the last frame that carried text ended in.
    text_key: Option<super::TextLane>,
    /// An SSE comment arrived since the last output.
    keep_alive: bool,
    /// The current ASCII-whitespace-free run and digit-group run (`reach.rs`).
    run: reach::Run,
    /// Delta text fields seen, resumed, and their released text (`lanes.rs`).
    fields: lanes::Fields,
    /// Released tails of fixed protocol fields (`fixed.rs`).
    released_fixed: BTreeMap<String, String>,
    /// Envelope runs of the released frames (`EnvelopeRuns`), and whether
    /// the last released frame was a reasoning half.
    released_runs: super::EnvelopeRuns,
    released_half: bool,
    /// Envelope string memo across releases (`redact::EnvelopeMemo`).
    envelope_memo: redact::EnvelopeMemo,
    memo: records::StepMemo,
}

impl StreamingDlp {
    fn len(&self) -> usize {
        self.base + self.text.len()
    }

    fn advance(&mut self, final_step: bool, scanner: &dyn FirewallBackend) -> DlpOutput {
        let mut output = DlpOutput::default();
        let len = self.len();
        // Scan through the last whitespace boundary (or everything at the end),
        // so a token still being generated is never judged on a partial form.
        let safe_end = if final_step {
            len
        } else {
            // The last position that follows ASCII whitespace (tracked as text
            // arrives, so a long token is not rescanned on every push).
            self.last_space.max(self.scan_from)
        };
        let (lanes, held_pieces) = if final_step && self.buffer_remaining {
            self.final_lanes()
        } else {
            (BTreeMap::new(), BTreeMap::new())
        };
        // Detection covers the held text plus the reach `scan_from` keeps behind
        // the last release. While the stream is held whole (`buffer_remaining`)
        // nothing is released before the final step, so earlier steps scan only
        // the new text (with that reach) to let `Block` fire early without
        // rescanning everything, and the final step rescans all of it.
        let narrow = self.buffer_remaining && !final_step;
        // Nothing new to judge while held whole: skip the reach walk.
        let detect_from = if narrow && safe_end <= self.scanned_to {
            safe_end
        } else if narrow {
            // A start inside a chain too long to reach back over would group
            // it differently from the whole text: leave it to the final scan.
            match self.scan_start_checked(self.scanned_to, scanner) {
                (_, true) => safe_end,
                (from, false) => from.max(self.scan_from),
            }
        } else {
            self.scan_from
        };
        let rescan_all = final_step && self.buffer_remaining;
        // Release every held frame that ends at or before the cut. `safe_end`
        // follows whitespace, so the whitespace-free run around any earlier
        // position is complete and was inside the region just scanned; the cut
        // stays behind any token that could open a bounded match still running
        // past `safe_end` (see `release_cut`).
        let cut = if final_step {
            len
        } else if self.buffer_remaining {
            0
        } else {
            // Keyed on the candidate cut: past it `release_cut` reads nothing,
            // so a cut pinned by an unbounded form is computed once per pin.
            let candidate = if self.run.open_form && self.run.form_start < safe_end {
                self.run.form_start.max(self.base)
            } else {
                safe_end
            };
            let (cut, capped) = match self.cut_memo {
                Some((base, key, cut, capped)) if base == self.base && key == candidate => {
                    (cut, capped)
                }
                _ => {
                    let (cut, capped) = self.release_cut_checked(safe_end);
                    self.cut_memo = Some((self.base, candidate, cut, capped));
                    (cut, capped)
                }
            };
            // Mostly stripped characters behind the cut: hold the rest whole
            // (judged once at the end) rather than rescanning it every push.
            self.buffer_remaining |= capped;
            cut
        };
        // While an unbounded form holds its run (`release_cut`), nothing past
        // the cut goes out: judge only up to it, so a long held run is scanned
        // once when it closes rather than again on every step. The scan stops
        // at the form's token start (a token edge); a cut held earlier, at a
        // bounded-match opener, keeps that opener and anything it could run
        // into unreleased until the run closes and is scanned whole.
        let form_start = self.run.form_start.max(self.base);
        let scan_end = if !final_step
            && !self.buffer_remaining
            && self.run.open_form
            && self.run.form_start < safe_end
            && cut <= form_start
        {
            form_start.max(detect_from).min(safe_end)
        } else {
            safe_end
        };
        // A group chain still growing at the scan end (`digits.rs`): its
        // last candidate could be cut short. Neither judge nor release into
        // it until it closes; then it is scanned whole from its start.
        let (cut, scan_end) =
            self.before_open_chain(final_step, safe_end, detect_from, cut, scan_end);
        // Once a violation is recorded (Sanitize or Warn: Block ends the
        // stream) a later match changes nothing: skip detection, so it is
        // neither rescanned nor logged again.
        let recorded = self.violation.is_some();
        let pending = self
            .frame_violation
            .take()
            .filter(|_| !recorded)
            .or_else(|| {
                if recorded {
                    return None;
                }
                ((scan_end > self.scanned_to || rescan_all) && scan_end > detect_from)
                    .then(|| self.scan_region(detect_from, scan_end, scanner))
                    .flatten()
            })
            .or_else(|| {
                (!recorded)
                    .then(|| lanes.values().find_map(|text| scanner.scan_outbound(text)))
                    .flatten()
            })
            .or_else(|| {
                (!recorded && final_step && self.envelope.varying())
                    .then(|| self.envelope.scan(scanner))
                    .flatten()
            });
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
        self.scanned_to = self.scanned_to.max(scan_end);

        let mut release = 0;
        for (index, frame) in self.held.iter().enumerate() {
            // Only the newest provider frame is still fresh (`take_line`).
            let awaits_next = frame.fresh && !final_step;
            if (self.buffer_remaining && !final_step) || frame.end > cut || awaits_next {
                break;
            }
            release = index + 1;
        }
        // Nothing to release: redaction is decided per release, so skip it.
        if release == 0 {
            return output;
        }
        if final_step && self.buffer_remaining && self.envelope.unmatched() {
            let transform = redact::Transform::new(scanner, self.sanitize);
            self.envelope.judge_pieces(&held_pieces, &transform);
        }
        let mut text_level = !self.buffer_remaining;
        if final_step && self.buffer_remaining {
            // A held-whole stream still releases its leading plain-content
            // frames at text level when that is safe (`final_head`).
            let (head, split) = self.final_head(release, scanner);
            text_level = head == release;
            if split {
                let before = self.held.len();
                self.release(
                    head,
                    true,
                    final_step,
                    safe_end,
                    &lanes,
                    scanner,
                    &mut output,
                );
                release -= before - self.held.len();
            }
        }
        self.release(
            release,
            text_level,
            final_step,
            safe_end,
            &lanes,
            scanner,
            &mut output,
        );
        if !final_step {
            self.move_scan_start(scanner);
        }
        output
    }
}

mod carried;
mod digits;
mod driver;
pub(super) mod envelope;
mod fixed;
mod frames;
#[cfg(test)]
mod gap_test;
mod ingest;
mod junction;
mod lanes;
mod legacy;
mod long_cut;
mod mirror;
mod reach;
mod records;
pub(super) mod redact;
mod release;
#[cfg(test)]
mod review_test;
#[cfg(test)]
mod round10_test;
#[cfg(test)]
mod round11_test;
#[cfg(test)]
mod round12_test;
#[cfg(test)]
mod round13_test;
#[cfg(test)]
mod round14_test;
#[cfg(test)]
mod round15_test;
#[cfg(test)]
mod round16_test;
#[cfg(test)]
mod round17_test;
#[cfg(test)]
mod round18_test;
#[cfg(test)]
mod round19_test;
#[cfg(test)]
mod round20_test;
#[cfg(test)]
mod round21_test;
#[cfg(test)]
mod round23_test;
#[cfg(test)]
mod round24_test;
#[cfg(test)]
mod round25_test;
#[cfg(test)]
mod round26_test;
#[cfg(test)]
mod round27_test;
#[cfg(test)]
mod round30_test;
#[cfg(test)]
mod round31_test;
#[cfg(test)]
mod round32_test;
#[cfg(test)]
mod round33_test;
#[cfg(test)]
mod round34_test;
#[cfg(test)]
mod round35_test;
#[cfg(test)]
mod round36_test;
#[cfg(test)]
mod round37_test;
#[cfg(test)]
mod round38_test;
#[cfg(test)]
mod round39_test;
#[cfg(test)]
mod round41_test;
#[cfg(test)]
mod round42_test;
#[cfg(test)]
mod round43_test;
#[cfg(test)]
mod round44_test;
#[cfg(test)]
mod round45_test;
#[cfg(test)]
mod round46_test;
#[cfg(test)]
mod round47_test;
#[cfg(test)]
mod round48_test;
#[cfg(test)]
mod round49_test;
#[cfg(test)]
mod round4_test;
#[cfg(test)]
mod round50_test;
#[cfg(test)]
mod round51_test;
#[cfg(test)]
mod round52_test;
#[cfg(test)]
mod round53_test;
#[cfg(test)]
mod round54_test;
#[cfg(test)]
mod round55_test;
#[cfg(test)]
mod round56_test;
#[cfg(test)]
mod round57_test;
#[cfg(test)]
mod round58_test;
#[cfg(test)]
mod round59_test;
#[cfg(test)]
mod round5_test;
#[cfg(test)]
mod round60_test;
#[cfg(test)]
mod round61_test;
#[cfg(test)]
mod round62_test;
#[cfg(test)]
mod round63_test;
#[cfg(test)]
mod round64_test;
#[cfg(test)]
mod round65_test;
#[cfg(test)]
mod round68_test;
#[cfg(test)]
mod round69_test;
#[cfg(test)]
mod round6_test;
#[cfg(test)]
mod round70_test;
#[cfg(test)]
mod round71_test;
#[cfg(test)]
mod round72_test;
#[cfg(test)]
mod round73_test;
#[cfg(test)]
mod round74_test;
#[cfg(test)]
mod round75_test;
#[cfg(test)]
mod round76_test;
#[cfg(test)]
mod round77_test;
#[cfg(test)]
mod round78_test;
#[cfg(test)]
mod round79_test;
#[cfg(test)]
mod round7_test;
#[cfg(test)]
mod round8_test;
#[cfg(test)]
mod round9_test;
mod scan_start;
#[cfg(test)]
mod scan_test;
mod spans;
#[cfg(test)]
mod text_level_test;

pub(super) use driver::dlp_body;
