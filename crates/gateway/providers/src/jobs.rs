//! Provider-facing video-job value types.
//!
//! Job-based (async) generation — cloud video runs for minutes — returns a
//! [`VideoJob`] handle from [`crate::Provider::submit_video`] / `poll_video`
//! instead of blocking the request. The gateway-side `MediaJob`/`MediaJobStore`
//! (the request-scoped tracking + polling loop + tenant isolation) stay in
//! `apps/gateway/src/jobs.rs`; only the provider-produced value types live here
//! so the provider crate can name them.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The lifecycle state of a media job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    /// Submitted, not yet started by the provider.
    Queued,
    /// The provider is actively working on it.
    Running,
    /// Finished successfully; `output` is populated.
    Succeeded,
    /// Failed; `error` is populated.
    Failed,
}

impl JobStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            JobStatus::Queued => "queued",
            JobStatus::Running => "running",
            JobStatus::Succeeded => "succeeded",
            JobStatus::Failed => "failed",
        }
    }

    /// Whether the job has reached a terminal state (no further polling needed).
    pub fn is_terminal(&self) -> bool {
        matches!(self, JobStatus::Succeeded | JobStatus::Failed)
    }
}

/// A provider-normalized snapshot of a video job, returned by
/// [`crate::Provider::submit_video`] / `poll_video`. The gateway stores
/// `provider_ref` so it can re-poll, and surfaces `output`/`error` to the client
/// in a stable OpenAI-ish shape.
#[derive(Debug, Clone)]
pub struct VideoJob {
    /// The provider's own id / poll handle (Replicate prediction id, Fal
    /// status URL, …). Opaque to the gateway; used only to re-poll.
    pub provider_ref: String,
    pub status: JobStatus,
    /// Normalized success output, e.g. `{ "data": [{ "url": "..." }] }`. `None`
    /// until the job succeeds.
    pub output: Option<Value>,
    /// Failure detail. `None` unless the job failed.
    pub error: Option<String>,
}
