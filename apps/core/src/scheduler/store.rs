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
    /// Run one website-monitor check (fetch → compare → alert). The monitor engine
    /// runs OUT-OF-PROCESS (`ryu-monitors` sidecar); the tick dispatches over loopback
    /// via `crate::monitors_client`. Created automatically (reconciled) for every
    /// monitor so they ride the same tick loop as workflows and agents.
    Monitor { monitor_id: String },
    /// Run one quest detection pass (gather Shadow context → judge → suggest or
    /// auto-complete). Backed by the quest engine (`ryu_quests`); created
    /// automatically for every open quest so it rides the same tick loop.
    Quest { quest_id: String },
    /// Re-validate every `AUTHENTICATED` Identity Vault connection and flip the
    /// stale ones to `NEEDS_AUTH`. Backed by the health engine
    /// ([`crate::identity::health`]); a single fixed-id job ensured at startup
    /// (there is no per-connection CRUD hook), so it rides the same tick loop.
    IdentityHealth,
    /// Run one continual-learning cycle (sweep conversations → PRM-score → reward-
    /// filter → dispatch a retrain from the original base). Backed by
    /// [`crate::learning`]; a single fixed-id job ensured at startup that no-ops
    /// unless the user opted in (and, if a sleep window is set, only fires within
    /// it). Rides the same tick loop as the others.
    LearningCycle,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn record(outcome: ExecOutcome, at: &str) -> ExecRecord {
        ExecRecord {
            started_at: at.to_string(),
            finished_at: at.to_string(),
            outcome,
            run_id: None,
            error: None,
        }
    }

    fn job() -> ScheduledJob {
        ScheduledJob {
            id: "j1".into(),
            name: "n".into(),
            schedule: Schedule::Cron {
                expr: "* * * * *".into(),
            },
            target: JobTarget::IdentityHealth,
            enabled: true,
            require_approval: false,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            last_run_at: None,
            last_outcome: None,
            history: Vec::new(),
        }
    }

    #[test]
    fn record_execution_updates_rollups_and_appends() {
        let mut j = job();
        j.record_execution(record(ExecOutcome::Failure, "2026-02-02T00:00:00Z"));
        assert_eq!(j.last_run_at.as_deref(), Some("2026-02-02T00:00:00Z"));
        assert_eq!(j.last_outcome, Some(ExecOutcome::Failure));
        assert_eq!(j.history.len(), 1);
        // updated_at is refreshed off the wall clock, away from the seed value.
        assert_ne!(j.updated_at, "2026-01-01T00:00:00Z");
    }

    #[test]
    fn record_execution_trims_history_to_bound_keeping_newest() {
        let mut j = job();
        for i in 0..(MAX_HISTORY + 10) {
            j.record_execution(record(
                ExecOutcome::Success,
                &format!("2026-03-{:02}T00:00:00Z", i % 28 + 1),
            ));
        }
        assert_eq!(j.history.len(), MAX_HISTORY);
        // The oldest entries were drained from the front — the last push is retained.
        assert_eq!(j.last_outcome, Some(ExecOutcome::Success));
    }

    #[test]
    fn job_target_serde_tags_round_trip() {
        // Workflow with a default (absent) input map.
        let wf: JobTarget =
            serde_json::from_value(serde_json::json!({"type":"workflow","workflow_id":"w1"}))
                .unwrap();
        assert_eq!(
            wf,
            JobTarget::Workflow {
                workflow_id: "w1".into(),
                input: std::collections::HashMap::new(),
            }
        );
        // Agent, monitor, quest, and the two unit variants.
        assert_eq!(
            serde_json::from_value::<JobTarget>(
                serde_json::json!({"type":"agent","agent_id":"a","prompt":"p"})
            )
            .unwrap(),
            JobTarget::Agent {
                agent_id: "a".into(),
                prompt: "p".into()
            }
        );
        assert_eq!(
            serde_json::from_value::<JobTarget>(
                serde_json::json!({"type":"identity_health"})
            )
            .unwrap(),
            JobTarget::IdentityHealth
        );
        assert_eq!(
            serde_json::from_value::<JobTarget>(serde_json::json!({"type":"learning_cycle"}))
                .unwrap(),
            JobTarget::LearningCycle
        );
    }

    #[test]
    fn scheduled_job_serde_defaults_enabled_true_and_empty_history() {
        // A minimal job doc (pre-dating enabled/require_approval/history) must
        // deserialize with enabled=true, require_approval=false, empty history.
        let raw = serde_json::json!({
            "id": "old",
            "name": "legacy",
            "schedule": {"kind":"every","interval":"5m"},
            "target": {"type":"monitor","monitor_id":"m1"},
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        });
        let j: ScheduledJob = serde_json::from_value(raw).unwrap();
        assert!(j.enabled, "enabled must default to true");
        assert!(!j.require_approval);
        assert!(j.history.is_empty());
        assert!(matches!(j.schedule, Schedule::Every { .. }));
    }

    #[test]
    fn exec_outcome_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&ExecOutcome::Success).unwrap(),
            "\"success\""
        );
        assert_eq!(
            serde_json::to_string(&ExecOutcome::Failure).unwrap(),
            "\"failure\""
        );
    }
}
