use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::Mutex;

use super::meeting::{MeetingResolver, MeetingSummarizer, MeetingSummary, SummaryStore};
use crate::llm::orchestrator::LlmOrchestrator;
use crate::utils::wall_micros;

/// A pending summarization job.
#[derive(Debug, Clone)]
pub struct SummaryJob {
    pub id: String,
    /// SHA-256 of the transcript/context for dedup.
    pub input_hash: String,
    pub start_us: u64,
    pub end_us: u64,
    pub app_name: String,
}

/// Errors from enqueuing jobs.
#[derive(Debug, Clone)]
pub enum QueueError {
    Full,
}

impl std::fmt::Display for QueueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "queue full (max pending reached)")
    }
}

impl std::error::Error for QueueError {}

/// Result of a coordinator poll.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CoordinatorResult {
    /// Summarization was enqueued.
    Enqueued { job_id: String },
    /// Multiple candidate meetings found — caller must disambiguate.
    Disambiguation { candidates: Vec<serde_json::Value> },
    /// No meeting window detected.
    NoMeetingFound,
    /// LLM not available.
    Unavailable,
}

const MAX_PENDING: usize = 3;

/// Single-flight sequential queue for meeting summarization jobs.
pub struct SummaryQueue {
    pending: VecDeque<SummaryJob>,
}

impl SummaryQueue {
    pub fn new() -> Self {
        Self {
            pending: VecDeque::new(),
        }
    }

    /// Enqueue a job, coalescing by `input_hash`. Rejects when >MAX_PENDING.
    pub fn enqueue(&mut self, job: SummaryJob) -> Result<(), QueueError> {
        // Coalesce duplicates
        if self.pending.iter().any(|j| j.input_hash == job.input_hash) {
            return Ok(());
        }
        if self.pending.len() >= MAX_PENDING {
            return Err(QueueError::Full);
        }
        self.pending.push_back(job);
        Ok(())
    }

    /// Pop the next pending job.
    pub fn pop(&mut self) -> Option<SummaryJob> {
        self.pending.pop_front()
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

impl Default for SummaryQueue {
    fn default() -> Self {
        Self::new()
    }
}

/// Orchestrates meeting detection → summarization → storage.
pub struct SummaryCoordinator;

impl SummaryCoordinator {
    /// Detect meetings in the given time range, enqueue summarization, and return the result.
    pub async fn coordinate(
        orchestrator: &Arc<LlmOrchestrator>,
        store: &std::sync::Mutex<SummaryStore>,
        queue: &Mutex<SummaryQueue>,
        start_us: u64,
        end_us: u64,
    ) -> CoordinatorResult {
        let resolver = MeetingResolver;
        let meetings = match resolver.find_meetings(start_us, end_us) {
            Ok(m) => m,
            Err(_) => return CoordinatorResult::NoMeetingFound,
        };

        match meetings.len() {
            0 => CoordinatorResult::NoMeetingFound,
            1 => {
                let window = &meetings[0];
                let hash = input_hash(window.start_us, window.end_us, &window.app_name);
                let job_id = uuid::Uuid::new_v4().to_string();

                let job = SummaryJob {
                    id: job_id.clone(),
                    input_hash: hash,
                    start_us: window.start_us,
                    end_us: window.end_us,
                    app_name: window.app_name.clone(),
                };

                match queue.lock().await.enqueue(job) {
                    Ok(_) => {
                        let orch = Arc::clone(orchestrator);
                        let window_clone = window.clone();

                        // Inline execution (non-blocking)
                        let summarizer = MeetingSummarizer::new(orch);
                        if let Ok(summary) = summarizer.summarize(&window_clone).await {
                            if let Ok(s) = store.lock() {
                                let _ = s.store(&summary);
                            }
                            queue.lock().await.pop();
                        }

                        CoordinatorResult::Enqueued { job_id }
                    }
                    Err(QueueError::Full) => CoordinatorResult::Enqueued {
                        job_id: "queued_full".to_string(),
                    },
                }
            }
            _ => {
                // Multiple candidates — return disambiguation list
                let candidates = meetings
                    .iter()
                    .map(|m| {
                        serde_json::json!({
                            "app": m.app_name,
                            "start_us": m.start_us,
                            "end_us": m.end_us,
                            "confidence": m.confidence,
                        })
                    })
                    .collect();
                CoordinatorResult::Disambiguation { candidates }
            }
        }
    }
}

fn input_hash(start_us: u64, end_us: u64, app_name: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(start_us.to_le_bytes());
    hasher.update(end_us.to_le_bytes());
    hasher.update(app_name.as_bytes());
    format!("{:x}", hasher.finalize())[..16].to_string()
}
