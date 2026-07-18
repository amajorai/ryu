//! The meeting *ingest* seam: the minimal contract the hardware ambient-audio
//! path needs from the meeting-notes capability, inverted so this kernel crate has
//! ZERO compile-time dependency on `ryu_meetings`.
//!
//! ## Why this exists
//!
//! An ambient-capable device (necklace / desk) opens a long-running "ambient"
//! meeting and streams ~1 s WAV chunks into it: [`session::HardwareSession`] buffers
//! decoded Opus uplink and, once a second of PCM has accumulated, feeds one WAV
//! segment to the meeting transcript. That transcription + persistence is a
//! *meetings* concern that had been welded into this crate as a direct
//! `ryu_meetings::MeetingEngine` field (a compile-time `ryu_hardware -> ryu_meetings`
//! edge welding the kernel hardware crate to a swappable app). Meetings is now a
//! swappable, out-of-process app; a kernel crate cannot hard-link it.
//!
//! [`MeetingIngest`] is the inversion. It exposes ONLY what the ambient path needs
//! (open/resume the ambient meeting, append a captured audio segment), in terms of
//! plain owned types — never a `ryu_meetings` type. Core provides the impl:
//!
//! - in-process (`meetings_ingest::in_proc`) — wraps the in-process engine;
//! - out-of-process (`meetings_client::MeetingsClient`) — proxies to the
//!   `ryu-meetings` sidecar over loopback (`POST /api/meetings/:id/chunk`).
//!
//! ## Hot-path note
//!
//! [`MeetingIngest::append_segment`] is called at *segment rate*, not frame rate:
//! [`session::HardwareSession::on_audio`] only accumulates each ~20 ms Opus frame,
//! and the append fires once per ~1 s of buffered PCM (`AMBIENT_FLUSH_SAMPLES`). So
//! the sidecar-backed impl's HTTP hop is ~1 POST/s/device carrying a ~32 KB WAV
//! (transcription happens on the sidecar side) — acceptable at segment rate.
//!
//! ## What is deliberately absent: `finalize`
//!
//! There is no `finalize` on this seam. The device link never ends the ambient
//! meeting — it is a continuous 24/7 transcript that a device *resumes* on each
//! reconnect. Finalizing a meeting (stop capture → generate notes → save) is a
//! user-driven action through the meetings API/UI, never the hardware path, so the
//! seam only needs open/resume + append.

use async_trait::async_trait;

/// The meeting-notes capability, seen through the narrow hole the hardware ambient
/// path needs. Implemented by Core (in-process or sidecar-backed).
#[async_trait]
pub trait MeetingIngest: Send + Sync {
    /// Whether a meeting with this id still exists — the ambient *resume* check
    /// (a device's saved `ambient_meeting_id` may have been deleted).
    async fn meeting_exists(&self, meeting_id: &str) -> bool;

    /// Open a new long-running ambient meeting for a device, returning its id. The
    /// impl bakes in the ambient provenance (app label + auto source); the caller
    /// supplies only the title.
    async fn start_meeting(&self, title: String) -> Result<String, String>;

    /// Append one captured WAV audio segment to a meeting's live transcript,
    /// returning the created segment id on success. A silence/empty chunk is
    /// surfaced as an `Err` whose message contains `"silence"` or `"empty"` (the
    /// caller maps that to an `ambient_skip`, not a failure).
    async fn append_segment(
        &self,
        meeting_id: &str,
        wav: Vec<u8>,
        filename: String,
    ) -> Result<String, String>;
}
