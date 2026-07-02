//! In-memory media-job store for job-based (async) generation.
//!
//! Cloud video generation runs for minutes, so it does NOT block a gateway
//! request the way image/TTS/STT do. Instead a submit creates a [`MediaJob`],
//! returns its gateway-minted id, and the client polls the gateway (never the
//! provider directly) so auth, governance, and attribution stay centralized. On
//! each poll the gateway asks the provider for the job's current state via
//! [`crate::providers::Provider::poll_video`] and caches the terminal result.
//!
//! The store is intentionally in-memory and best-effort: a gateway restart loses
//! in-flight jobs (the client re-submits). Terminal jobs older than [`JOB_TTL`]
//! are pruned on insert so the map cannot grow without bound.

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::ProviderKind;

/// How long a terminal job is retained before it is pruned.
const JOB_TTL_SECS: u64 = 3600;

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
/// [`crate::providers::Provider::submit_video`] / `poll_video`. The gateway
/// stores `provider_ref` so it can re-poll, and surfaces `output`/`error` to the
/// client in a stable OpenAI-ish shape.
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

/// A gateway-tracked media job. The gateway mints `id` (the request id) and the
/// client polls `GET /v1/videos/generations/{id}`.
#[derive(Debug, Clone)]
pub struct MediaJob {
    pub id: String,
    pub provider: ProviderKind,
    pub provider_ref: String,
    pub model: String,
    pub status: JobStatus,
    pub output: Option<Value>,
    pub error: Option<String>,
    pub created_ms: u64,
    /// Org the job is attributed to (for the completion debit + isolation).
    pub org_id: Option<String>,
    /// API key that submitted the job — a poll must present the same key so one
    /// tenant cannot read another's job by guessing an id.
    pub api_key: String,
}

impl MediaJob {
    /// The client-facing JSON for this job. `output` fields are flattened in on
    /// success so a completed poll looks like a normal generation response plus
    /// the `id`/`status` envelope.
    pub fn to_response(&self) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert("id".into(), Value::String(self.id.clone()));
        obj.insert("status".into(), Value::String(self.status.as_str().into()));
        obj.insert("model".into(), Value::String(self.model.clone()));
        if let Some(output) = &self.output {
            if let Some(map) = output.as_object() {
                for (k, v) in map {
                    obj.insert(k.clone(), v.clone());
                }
            } else {
                obj.insert("output".into(), output.clone());
            }
        }
        if let Some(err) = &self.error {
            obj.insert("error".into(), Value::String(err.clone()));
        }
        Value::Object(obj)
    }
}

/// Milliseconds since the Unix epoch (best-effort; 0 if the clock is before it).
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Thread-safe in-memory job store.
#[derive(Default)]
pub struct MediaJobStore {
    jobs: RwLock<HashMap<String, MediaJob>>,
}

impl MediaJobStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert (or replace) a job, pruning stale terminal jobs first.
    pub fn insert(&self, job: MediaJob) {
        if let Ok(mut map) = self.jobs.write() {
            let cutoff = now_ms().saturating_sub(JOB_TTL_SECS * 1000);
            map.retain(|_, j| !(j.status.is_terminal() && j.created_ms < cutoff));
            map.insert(job.id.clone(), job);
        }
    }

    /// Fetch a snapshot of a job by id.
    pub fn get(&self, id: &str) -> Option<MediaJob> {
        self.jobs.read().ok().and_then(|m| m.get(id).cloned())
    }

    /// Mutate a stored job in place (used to cache a terminal poll result).
    pub fn update<F: FnOnce(&mut MediaJob)>(&self, id: &str, f: F) {
        if let Ok(mut map) = self.jobs.write() {
            if let Some(job) = map.get_mut(id) {
                f(job);
            }
        }
    }
}
