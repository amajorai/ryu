//! Clips: agent-native Loom/Jam for Ryu (the Core→Shadow capture proxy).
//!
//! Shadow owns the sensor half of clips (screen + audio capture, ffmpeg mux, the
//! agent-context.json bundle). Core owns *what runs* — the clip session the
//! desktop drives — so this crate exposes a stable `/api/clips/*` surface (built
//! in [`api`]) and proxies each call to the Shadow sidecar over loopback.
//!
//! Placement (CLAUDE.md §1): capture + bundle is "what runs" (Core/Shadow).
//! Redacting diagnostics on egress is "what is shared" (a Gateway concern); v1
//! redacts client-side in the extension, so nothing here enforces policy.
//!
//! Fail-soft: when Shadow is down these handlers return `{ available: false,
//! reason }` (the same shape as the Shadow MCP provider) rather than a 5xx, so a
//! stopped sidecar degrades gracefully in the UI instead of erroring.
//!
//! ## Host inversion
//! This crate has ZERO dependency on `apps/core`. The two kernel couplings the
//! moved code needs are inverted through the [`ClipsHost`] trait, which
//! `apps/core` implements in its `clips_host` shim and injects into [`ClipsCtx`]:
//! - **yt-dlp ingest** — resolving a watched URL to a local video (over Core's
//!   `DownloadCenter`) is kernel binary management.
//! - **auto-file into the `Clips` Space** — a finished clip's mp4 + summary are
//!   stored in the `Clips` system Space (a Core store).
//! Everything else — the Shadow HTTP proxying, `framesEndpoint` rewriting, the
//! ingest orchestration (URL vs local-file resolution), and the summary render —
//! lives in the crate.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;

pub mod api;

pub use api::{routes, ClipsCtx};

/// Resolve the Shadow base URL: `RYU_SHADOW_URL` if set, else loopback Shadow.
/// Mirrors `sidecar/mcp/shadow.rs` so the address stays in one convention.
pub(crate) fn shadow_base() -> String {
    std::env::var("RYU_SHADOW_URL").unwrap_or_else(|_| "http://127.0.0.1:3030".into())
}

/// The default, undeletable system Space that finished clips are auto-filed into.
/// Seeded eagerly in Core's `main.rs` (same pattern as "Artifacts") and re-resolved
/// idempotently at file-time by the host's [`ClipsHost::store_clip`].
pub const CLIPS_SPACE_NAME: &str = "Clips";
pub const CLIPS_SPACE_DESC: &str = "Screen recordings and clips captured by Ryu";

// ── Host inversion (the kernel couplings live in apps/core) ───────────────────

/// One timed caption cue parsed from a downloaded video's subtitles. Mirrors the
/// host's yt-dlp `CaptionCue` so the crate never imports Core.
#[derive(Debug, Clone)]
pub struct CaptionCue {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// A downloaded video (from a watched URL) plus any captions yt-dlp pulled
/// alongside it — the result of [`ClipsHost::download_video`].
#[derive(Debug, Clone)]
pub struct DownloadedClip {
    /// Local path to the downloaded video file.
    pub video: PathBuf,
    /// Plain-text captions (deduped, tags stripped) for the transcript body.
    pub captions: Option<String>,
    /// Timed caption cues parsed from the same subtitles, for transcript segments.
    pub caption_segments: Vec<CaptionCue>,
}

/// The narrow seam this crate needs from `apps/core`'s kernel machinery. It carries
/// ONLY the two couplings the moved clips code uses: the yt-dlp downloader (over
/// Core's `DownloadCenter`) for URL ingest, and filing a finished clip into the
/// `Clips` system Space. `apps/core` implements this in its `clips_host` shim.
#[async_trait]
pub trait ClipsHost: Send + Sync {
    /// The base directory under which ingest work dirs are created
    /// (`ryu_dir()/tmp`). The crate appends a unique `clip-ingest-<uuid>` segment.
    fn tmp_dir(&self) -> PathBuf;

    /// Ensure the yt-dlp downloader is installed (a URL ingest needs it). The
    /// `Err` string is the display of the underlying install error.
    async fn ensure_ytdlp(&self) -> Result<(), String>;

    /// Download a watched video URL into `work_dir` (+ optional captions/segments),
    /// trimming to `[start, end)` (ms) when both are set. The `Err` string is the
    /// display of the underlying download error.
    async fn download_video(
        &self,
        url: &str,
        work_dir: &Path,
        start: Option<u64>,
        end: Option<u64>,
    ) -> Result<DownloadedClip, String>;

    /// File a finished clip into the `Clips` system Space (idempotent get-or-create
    /// of the space, then the mp4 blob when present + a short markdown summary).
    /// Fail-soft: the host logs and continues on any step's error — this NEVER
    /// affects the clip HTTP response (the crate spawns it, doesn't await it).
    async fn store_clip(&self, title: &str, mp4: Option<Vec<u8>>, summary_md: &str);
}

/// A shared handle to the injected host.
pub type SharedClipsHost = Arc<dyn ClipsHost>;
