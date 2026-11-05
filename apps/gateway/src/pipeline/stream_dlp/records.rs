//! What the stream keeps per frame: held frames waiting for release, and
//! released frames still within the scan reach.

use serde_json::Value;

use crate::firewall::FirewallMatch;

pub(in crate::pipeline::stream_dlp) struct HeldFrame {
    pub(in crate::pipeline::stream_dlp) value: Value,
    pub(in crate::pipeline::stream_dlp) wire_bytes: usize,
    /// Absolute end offset of this frame's text in the concatenated text.
    pub(in crate::pipeline::stream_dlp) end: usize,
    /// It introduced an envelope value; it waits for the next frame (see
    /// `EnvelopeLanes::take_fresh`).
    pub(in crate::pipeline::stream_dlp) fresh: bool,
    /// `FIELD_SEPARATOR` was put in the scan text before its text (a switch
    /// of text lane, `TextLane`).
    pub(in crate::pipeline::stream_dlp) separated: bool,
    /// The delta text field its text is in, if any: for a delta with both
    /// reasoning and answer text (`primary_text_keys`), the one it ends in.
    pub(in crate::pipeline::stream_dlp) key: Option<&'static str>,
    /// The reasoning half of a split provider frame (`split_boundary`): the
    /// answer half that follows is the same provider frame for envelope runs.
    pub(in crate::pipeline::stream_dlp) reasoning_half: bool,
    /// `has_token_mirrors(&value)`, taken once when the frame came in (the
    /// value is not changed while held). Read it through `mirrors()`.
    pub(in crate::pipeline::stream_dlp) mirrors: bool,
}

impl HeldFrame {
    /// Whether the frame carries per-token mirrors of its text.
    pub(in crate::pipeline::stream_dlp) fn mirrors(&self) -> bool {
        debug_assert_eq!(
            self.mirrors,
            crate::pipeline::has_token_mirrors(&self.value)
        );
        self.mirrors
    }
}

/// Buffers and values one step keeps for the next.
#[derive(Default)]
pub(in crate::pipeline::stream_dlp) struct StepMemo {
    /// The scratch outbound projection of a frame (`take_value`).
    pub(in crate::pipeline::stream_dlp) projection: String,
    /// The inputs of the last `release` when it released nothing; cleared by
    /// any release that drains frames (`release`).
    pub(in crate::pipeline::stream_dlp) idle_release: Option<IdleRelease>,
    /// Releases a matching `idle_release` would have skipped (tests).
    #[cfg(test)]
    pub(in crate::pipeline::stream_dlp) idle_hits: usize,
}

/// `(scanner address, scan_from, safe_end, count, sanitize, text_level)` of a
/// `release` that released nothing.
pub(in crate::pipeline::stream_dlp) type IdleRelease = (usize, usize, usize, usize, bool, bool);

/// A released frame still within the scan reach (see `StreamingDlp::recent`).
pub(in crate::pipeline::stream_dlp) struct SentFrame {
    pub(in crate::pipeline::stream_dlp) start: usize,
    pub(in crate::pipeline::stream_dlp) end: usize,
    /// The text actually sent, as it appears in the scan text.
    pub(in crate::pipeline::stream_dlp) sent: String,
    pub(in crate::pipeline::stream_dlp) key: Option<&'static str>,
    pub(in crate::pipeline::stream_dlp) separated: bool,
    /// Released by the text-level split (not masked, not per string).
    pub(in crate::pipeline::stream_dlp) text_level: bool,
    /// Sent no text: it continued a value redacted into an earlier frame, or
    /// had none.
    pub(in crate::pipeline::stream_dlp) continued: bool,
}

/// What one step produced: SSE bytes to send, and whether the stream is over.
#[derive(Default)]
pub(in crate::pipeline) struct DlpOutput {
    pub(in crate::pipeline) bytes: String,
    /// A violation first seen in this step (for logging and metrics).
    pub(in crate::pipeline) violation: Option<FirewallMatch>,
    /// The stream was ended by a `Block` violation; `bytes` ends with the notice.
    pub(in crate::pipeline) blocked: bool,
}
