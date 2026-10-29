//! Provider-facing video-job value types.
//!
//! Job-based (async) generation — cloud video runs for minutes — returns a
//! [`VideoJob`] snapshot from [`crate::Provider::submit_video_bound`] or
//! [`crate::VideoPollOrigin::poll`]
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
/// [`crate::Provider::submit_video_bound`] or [`crate::VideoPollOrigin::poll`].
/// The private polling origin retains `provider_ref`, while the gateway surfaces `output`/`error`
/// in a stable OpenAI-ish shape.
#[derive(Clone)]
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

impl std::fmt::Debug for VideoJob {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("VideoJob")
            .field("status", &self.status)
            .field("has_output", &self.output.is_some())
            .field("has_error", &self.error.is_some())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn debug_omits_private_poll_references_and_payloads() {
        let job = VideoJob {
            provider_ref: "private-poll-reference".into(),
            status: JobStatus::Queued,
            output: Some(json!({"private":"private-output"})),
            error: Some("private-error".into()),
        };
        let debug = format!("{job:?}");
        for value in ["private-poll-reference", "private-output", "private-error"] {
            assert!(!debug.contains(value));
        }
    }

    #[test]
    fn as_str_covers_every_variant() {
        assert_eq!(JobStatus::Queued.as_str(), "queued");
        assert_eq!(JobStatus::Running.as_str(), "running");
        assert_eq!(JobStatus::Succeeded.as_str(), "succeeded");
        assert_eq!(JobStatus::Failed.as_str(), "failed");
    }

    #[test]
    fn is_terminal_only_for_succeeded_and_failed() {
        assert!(!JobStatus::Queued.is_terminal());
        assert!(!JobStatus::Running.is_terminal());
        assert!(JobStatus::Succeeded.is_terminal());
        assert!(JobStatus::Failed.is_terminal());
    }

    #[test]
    fn serde_uses_lowercase_rename() {
        assert_eq!(
            serde_json::to_value(JobStatus::Running).unwrap(),
            json!("running")
        );
        let s: JobStatus = serde_json::from_value(json!("succeeded")).unwrap();
        assert_eq!(s, JobStatus::Succeeded);
        // A capitalized value must NOT parse (rename_all = lowercase is strict).
        assert!(serde_json::from_value::<JobStatus>(json!("Succeeded")).is_err());
    }

    #[test]
    fn video_job_holds_provider_ref_and_output() {
        let job = VideoJob {
            provider_ref: "pred_123".to_string(),
            status: JobStatus::Succeeded,
            output: Some(json!({ "data": [{ "url": "https://x/v.mp4" }] })),
            error: None,
        };
        assert_eq!(job.provider_ref, "pred_123");
        assert!(job.status.is_terminal());
        assert_eq!(
            job.output.unwrap()["data"][0]["url"],
            json!("https://x/v.mp4")
        );
    }
}
