//! File-backed persistence for scheduled jobs.
//!
//! Jobs live under `~/.ryu/scheduled-jobs/<id>.json`. Because they are written
//! to disk, scheduled jobs survive a Core restart: the scheduler reloads every
//! file on boot and resumes ticking. Each job also carries a bounded history of
//! its recent executions so failures are recorded and surfaced.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Max execution-history entries kept per job (newest last).
const MAX_HISTORY: usize = 50;

fn ryu_dir() -> PathBuf {
    crate::paths::ryu_dir()
}

fn jobs_dir() -> PathBuf {
    ryu_dir().join("scheduled-jobs")
}

/// What a scheduled job runs when it fires.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum JobTarget {
    /// Run a persisted workflow by id, with an optional initial input map.
    Workflow {
        workflow_id: String,
        #[serde(default)]
        input: std::collections::HashMap<String, String>,
    },
    /// Run an agent: a single chat turn against the given agent id.
    Agent { agent_id: String, prompt: String },
    /// Run one website-monitor check (fetch → compare → alert). Backed by the
    /// monitor engine ([`crate::monitors`]); created automatically for every
    /// monitor so they ride the same tick loop as workflows and agents.
    Monitor { monitor_id: String },
    /// Run one quest detection pass (gather Shadow context → judge → suggest or
    /// auto-complete). Backed by the quest engine ([`crate::quests`]); created
    /// automatically for every open quest so it rides the same tick loop.
    Quest { quest_id: String },
    /// Re-validate every `AUTHENTICATED` Identity Vault connection and flip the
    /// stale ones to `NEEDS_AUTH`. Backed by the health engine
    /// ([`crate::identity::health`]); a single fixed-id job ensured at startup
    /// (there is no per-connection CRUD hook), so it rides the same tick loop.
    IdentityHealth,
}

/// The schedule on which a job fires.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Schedule {
    /// Classic 5-field cron expression, evaluated in UTC.
    Cron { expr: String },
    /// Fixed interval, e.g. `30s`, `5m`, `1h` (parsed by `humantime`).
    Every { interval: String },
}

/// Outcome of a single job execution.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecOutcome {
    Success,
    Failure,
}

/// One recorded execution of a job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecRecord {
    pub started_at: String,
    pub finished_at: String,
    pub outcome: ExecOutcome,
    /// Workflow run id when the target was a workflow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// Error message when the outcome was a failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A persisted scheduled job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledJob {
    pub id: String,
    pub name: String,
    pub schedule: Schedule,
    pub target: JobTarget,
    /// When false, the scheduler skips this job without removing it.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// When true, a due firing does not run the target directly — it raises a
    /// human-in-the-loop approval request ([`crate::approvals`]) and runs only
    /// once the user approves. Off by default (autonomous), so existing jobs are
    /// unchanged.
    #[serde(default)]
    pub require_approval: bool,
    pub created_at: String,
    pub updated_at: String,
    /// ISO timestamp of the last time this job fired (success or failure).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    /// Outcome of the most recent execution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_outcome: Option<ExecOutcome>,
    /// Bounded execution history, oldest first.
    #[serde(default)]
    pub history: Vec<ExecRecord>,
}

fn default_true() -> bool {
    true
}

impl ScheduledJob {
    /// Append an execution record, updating the rollup fields and trimming the
    /// history to its bound.
    pub fn record_execution(&mut self, record: ExecRecord) {
        self.last_run_at = Some(record.finished_at.clone());
        self.last_outcome = Some(record.outcome);
        self.history.push(record);
        if self.history.len() > MAX_HISTORY {
            let overflow = self.history.len() - MAX_HISTORY;
            self.history.drain(0..overflow);
        }
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}

/// Persist (create or overwrite) a scheduled job.
pub fn save_job(job: &ScheduledJob) -> std::io::Result<()> {
    let dir = jobs_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.json", job.id));
    let json = serde_json::to_string_pretty(job)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, json)
}

/// Load a scheduled job by id.
pub fn load_job(id: &str) -> std::io::Result<ScheduledJob> {
    let path = jobs_dir().join(format!("{id}.json"));
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// List all persisted scheduled jobs.
pub fn list_jobs() -> Vec<ScheduledJob> {
    let dir = jobs_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(job) = serde_json::from_slice::<ScheduledJob>(&bytes) {
                out.push(job);
            }
        }
    }
    out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    out
}

/// Delete a scheduled job by id. Returns `true` when a file was removed.
pub fn delete_job(id: &str) -> std::io::Result<bool> {
    let path = jobs_dir().join(format!("{id}.json"));
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}
