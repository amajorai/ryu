//! Global download state manager (the "DownloadCenter").
//!
//! One process-wide registry that owns the lifecycle of *every* artifact Ryu
//! pulls over the network — chat/embedding GGUFs, engine binaries (llama.cpp,
//! whisper, sd-server), agent binaries, the parakeet bundle, skills, and so on.
//! Each download is a [`DownloadTask`] moving through a small state machine
//! (queued → active → paused → completed/failed/cancelled). Progress, pause,
//! resume, and cancel are first-class.
//!
//! Why this exists: before this module every downloader streamed the whole file
//! into a `Vec<u8>` (multi-GB into RAM) with no progress, cancel, or resume, and
//! coarse install state lived in a separate polling store. The center replaces
//! the RAM path with stream-to-disk `.part` files (HTTP Range + `If-Range`
//! resume), exposes live progress over a broadcast channel (SSE), and is the
//! single source of truth that `/api/setup/status` is derived from.
//!
//! Placement (Core vs Gateway): downloading artifacts is "what runs" → Core.

mod center;

pub use center::DownloadCenter;

use serde::{Deserialize, Serialize};

/// What kind of artifact a download fetches. Drives the desktop overlay's
/// grouping/iconography and lets `/api/setup/status` map a task back to a
/// sidecar/model name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadKind {
    Model,
    Engine,
    Agent,
    Tool,
    Skill,
    Embedding,
    Voice,
    Media,
    Other,
}

/// The lifecycle state of a single download. Unit variants only — the human
/// error string and retryability live on [`DownloadTask`] so the SSE/JSON shape
/// stays flat for the desktop store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadState {
    /// Registered, waiting for a concurrency slot.
    Queued,
    /// Actively streaming bytes to the `.part` file.
    Active,
    /// Stopped by the user; the `.part` is kept so resume continues from offset.
    Paused,
    /// Download finished; re-hashing the file from disk before the atomic rename.
    Verifying,
    /// Installed: file verified and renamed into place.
    Completed,
    /// Errored. See `error`; `retryable` says whether a Retry can resume.
    Failed,
    /// Cancelled by the user; the `.part` was deleted.
    Cancelled,
}

impl DownloadState {
    /// Terminal states are never persisted across restart and free their slot.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled)
    }

    /// States that should be reloaded + reconciled against orphan `.part` files
    /// on startup (an interrupted `Active` becomes `Paused`).
    pub fn is_persistable(self) -> bool {
        matches!(
            self,
            Self::Queued | Self::Active | Self::Paused | Self::Failed
        )
    }
}

/// One download's full, serializable state. This is exactly what a client sees
/// over `GET /api/downloads` and the SSE stream, and what is persisted (for the
/// persistable states) to `~/.ryu/downloads.json` for restart resume.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadTask {
    /// Stable id derived from the destination path so re-enqueueing the same
    /// artifact dedups onto the in-flight task instead of starting a second.
    pub id: String,
    pub kind: DownloadKind,
    /// Human-facing label, e.g. "Gemma 4 E2B (Q4_K_M)".
    pub label: String,
    pub url: Option<String>,
    pub dest_path: Option<String>,
    /// `None` until known (no `Content-Length`) — indeterminate progress.
    pub total_bytes: Option<u64>,
    pub received_bytes: u64,
    pub state: DownloadState,
    pub error: Option<String>,
    /// Whether a `Failed` task can be retried/resumed from its `.part`.
    pub retryable: bool,
    /// Sampled instantaneous throughput, bytes/sec (only while `Active`).
    pub speed_bps: Option<u64>,
    /// `ETag`/`Last-Modified` validator captured on the first response. Sent as
    /// `If-Range` on resume so a changed remote file restarts cleanly (HTTP 200)
    /// instead of silently concatenating two versions. Persisted for restart resume.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    /// Epoch-ms created / last-updated, for stable ordering + UI freshness.
    pub created_at: i64,
    pub updated_at: i64,
}

impl DownloadTask {
    pub fn percent(&self) -> Option<f64> {
        match self.total_bytes {
            Some(total) if total > 0 => {
                Some((self.received_bytes as f64 / total as f64).clamp(0.0, 1.0) * 100.0)
            }
            _ => None,
        }
    }
}

/// A request to start (or resume) a download. `version_record`, when present, is
/// written to `versions.json` on completion so the existing fast-path
/// checksum-skip in the downloaders keeps working.
#[derive(Debug, Clone)]
pub struct DownloadSpec {
    pub kind: DownloadKind,
    pub label: String,
    pub url: String,
    /// Final on-disk path. The in-flight file is `<dest>.part`.
    pub dest: std::path::PathBuf,
    /// Expected SHA-256 (hex). Empty/None ⇒ no verification.
    pub sha256: Option<String>,
    /// `(store_key, version)` to record in `versions.json` on completion.
    pub version_record: Option<VersionRecord>,
}

#[derive(Debug, Clone)]
pub struct VersionRecord {
    pub store_key: String,
    pub version: String,
}

/// A delta pushed to SSE subscribers. The stream sends one [`DownloadEvent::Snapshot`]
/// on connect (so a late/lagged client self-heals) then [`DownloadEvent::Update`] /
/// [`DownloadEvent::Removed`] deltas.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DownloadEvent {
    Snapshot { tasks: Vec<DownloadTask> },
    Update { task: DownloadTask },
    Removed { id: String },
}
