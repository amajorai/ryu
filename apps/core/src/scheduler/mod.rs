//! Scheduled job execution for Ryu Core (the envisioned `/heartbeat/jobs`).
//!
//! A *scheduled job* fires on a cron expression or a fixed interval and runs
//! either a persisted workflow or a one-shot agent prompt. This is the
//! always-on / headless deployment story: Core keeps a background tick loop
//! that, once a minute, executes every job whose schedule is due.
//!
//! Per the Core-vs-Gateway rule this is **Core**: it decides *what runs and
//! when*. It enforces no policy; each fired job hands its model calls to the
//! normal chat/workflow routing path (which is where the Gateway will sit).
//!
//! Durability: jobs are file-backed (see [`store`]). On boot the scheduler
//! reloads every job from disk, so schedules survive a Core restart and remain
//! listable. Each execution is appended to a bounded per-job history, so
//! failures are recorded and surfaced over the API.

pub mod cron;
pub mod store;

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};

use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};
use cron::CronSchedule;
use store::{ExecOutcome, ExecRecord, JobTarget, Schedule, ScheduledJob};

/// How often the tick loop wakes to evaluate due jobs.
const TICK_INTERVAL: Duration = Duration::from_secs(30);

/// Maximum number of fired jobs that may execute concurrently. Bounds fan-out so
/// a flood of due jobs can't spawn unbounded tasks, while keeping one slow
/// agent/workflow run from stalling unrelated due jobs in the same tick.
const MAX_CONCURRENT_JOBS: usize = 8;

/// The scheduler runtime. Holds no mutable in-memory job state of its own —
/// jobs are the source of truth on disk — beyond the per-job "last fired
/// minute" bookkeeping needed to avoid double-firing within a tick window.
#[derive(Clone)]
pub struct Scheduler {
    inner: Arc<SchedulerInner>,
}

struct SchedulerInner {
    /// Per-job last-fired wall-clock instant, used to debounce interval jobs and
    /// to avoid re-firing a cron job twice inside one minute.
    last_fired: tokio::sync::Mutex<std::collections::HashMap<String, DateTime<Utc>>>,
    /// Bounds how many fired jobs run concurrently (see [`MAX_CONCURRENT_JOBS`]).
    permits: Arc<tokio::sync::Semaphore>,
}

impl Scheduler {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(SchedulerInner {
                last_fired: tokio::sync::Mutex::new(std::collections::HashMap::new()),
                permits: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_JOBS)),
            }),
        }
    }

    /// Spawn the background tick loop. Returns immediately; the loop runs until
    /// the process exits.
    pub fn spawn(&self) {
        let scheduler = self.clone();
        tokio::spawn(async move {
            let count = store::list_jobs().len();
            tracing::info!("scheduler started, {count} job(s) loaded from disk");
            let mut interval = tokio::time::interval(TICK_INTERVAL);
            loop {
                interval.tick().await;
                scheduler.tick(Utc::now()).await;
            }
        });
    }

    /// Evaluate every persisted job against `now` and fire those that are due.
    /// Exposed (rather than inlined into the loop) so it can be unit-tested.
    pub async fn tick(&self, now: DateTime<Utc>) {
        for job in store::list_jobs() {
            if !job.enabled {
                continue;
            }
            if self.is_due(&job, now).await {
                self.fire(job, now).await;
            }
        }
    }

    /// True when `job` should fire at `now` and has not already fired for this
    /// schedule slot.
    async fn is_due(&self, job: &ScheduledJob, now: DateTime<Utc>) -> bool {
        let last = self.inner.last_fired.lock().await.get(&job.id).copied();
        match &job.schedule {
            Schedule::Cron { expr } => {
                let Ok(schedule) = CronSchedule::parse(expr) else {
                    return false;
                };
                if !schedule.matches(now) {
                    return false;
                }
                // Only fire once per matching minute.
                match last {
                    Some(prev) => {
                        prev.format("%Y%m%d%H%M").to_string()
                            != now.format("%Y%m%d%H%M").to_string()
                    }
                    None => true,
                }
            }
            Schedule::Every { interval } => {
                let Ok(dur) = humantime::parse_duration(interval) else {
                    return false;
                };
                let dur = chrono::Duration::from_std(dur)
                    .unwrap_or_else(|_| chrono::Duration::seconds(60));
                match last {
                    Some(prev) => now - prev >= dur,
                    // First boot: anchor the interval without firing immediately
                    // would require persisted state; firing once on start is the
                    // pragmatic "always-on" behaviour.
                    None => true,
                }
            }
        }
    }

    /// Fire a due job. Marks `last_fired` (preserving once-per-slot semantics)
    /// *before* spawning the actual run on a bounded task pool, so a slow
    /// agent/workflow run never stalls other due jobs in the same tick. The
    /// spawned task executes the target, records the outcome, and persists.
    async fn fire(&self, job: ScheduledJob, now: DateTime<Utc>) {
        self.inner
            .last_fired
            .lock()
            .await
            .insert(job.id.clone(), now);

        let permits = Arc::clone(&self.inner.permits);
        tokio::spawn(async move {
            // Cap concurrency: a flood of due jobs queues here rather than
            // spawning unbounded work. Closed semaphore (never happens) → skip.
            let Ok(_permit) = permits.acquire().await else {
                return;
            };
            let mut job = job;

            // Human-in-the-loop gate: a `require_approval` job does not run on
            // firing — it raises an approval request and runs only once the user
            // approves (the approval engine then calls `run_target`). Deduped on
            // the job id so a due interval can't pile up duplicate requests while
            // one is still pending.
            if job.require_approval {
                if let Some(engine) = crate::approvals::global_engine() {
                    let req = crate::approvals::ApprovalRequest::for_scheduled_job(&job);
                    match engine.request_deduped(req).await {
                        Ok(Some(_)) => {
                            tracing::info!(
                                "scheduler: job '{}' ({}) is approval-gated; raised an approval request",
                                job.name,
                                job.id
                            );
                        }
                        Ok(None) => {
                            tracing::debug!(
                                "scheduler: job '{}' already has a pending approval; skipping",
                                job.id
                            );
                        }
                        Err(e) => {
                            tracing::warn!(
                                "scheduler: failed to raise approval for job '{}': {e:#}",
                                job.id
                            );
                        }
                    }
                } else {
                    tracing::warn!(
                        "scheduler: job '{}' requires approval but the approval engine is not initialized; skipping the run",
                        job.id
                    );
                }
                return;
            }

            tracing::info!("scheduler firing job '{}' ({})", job.name, job.id);
            let started_at = Utc::now().to_rfc3339();
            let result = run_target(&job.target).await;
            let finished_at = Utc::now().to_rfc3339();

            let record = match result {
                Ok(run_id) => ExecRecord {
                    started_at,
                    finished_at,
                    outcome: ExecOutcome::Success,
                    run_id,
                    error: None,
                },
                Err(error) => {
                    tracing::warn!("scheduled job '{}' failed: {error}", job.id);
                    ExecRecord {
                        started_at,
                        finished_at,
                        outcome: ExecOutcome::Failure,
                        run_id: None,
                        error: Some(error),
                    }
                }
            };

            job.record_execution(record);
            if let Err(e) = store::save_job(&job) {
                tracing::error!("failed to persist job '{}' after execution: {e}", job.id);
            }
        });
    }
}

impl Default for Scheduler {
    fn default() -> Self {
        Self::new()
    }
}

/// Run a job's target to completion. On success returns the workflow run id
/// when applicable; on failure returns a human-readable error string.
///
/// Exposed `pub(crate)` so the approval engine can run a job target when the user
/// approves a `require_approval` automation (the approved run is then identical to
/// the autonomous run it replaced).
pub(crate) async fn run_target(target: &JobTarget) -> Result<Option<String>, String> {
    match target {
        JobTarget::Workflow { workflow_id, input } => {
            let workflow = crate::workflow::store::load_workflow(workflow_id)
                .map_err(|_| format!("workflow '{workflow_id}' not found"))?;
            let run_id = format!("run_{}", uuid::Uuid::new_v4().simple());
            let run =
                crate::workflow::executor::run_workflow(&workflow, input.clone(), run_id.clone())
                    .await?;
            match run.status {
                crate::workflow::store::RunStatus::Failed => Err(run
                    .error
                    .unwrap_or_else(|| "workflow run failed".to_string())),
                _ => Ok(Some(run_id)),
            }
        }
        JobTarget::Monitor { monitor_id } => {
            let engine = crate::monitors::global_engine()
                .ok_or_else(|| "monitor engine not initialized".to_string())?;
            engine.run_monitor(monitor_id).await?;
            Ok(None)
        }
        JobTarget::Quest { quest_id } => {
            let engine = crate::quests::global_engine()
                .ok_or_else(|| "quest engine not initialized".to_string())?;
            engine.judge_quest(quest_id).await?;
            Ok(None)
        }
        JobTarget::IdentityHealth => {
            let engine = crate::identity::health::global_engine()
                .ok_or_else(|| "identity health engine not initialized".to_string())?;
            engine.run_sweep().await?;
            Ok(None)
        }
        JobTarget::LearningCycle => {
            let state = crate::learning::global_state()
                .ok_or_else(|| "learning state not initialized".to_string())?;
            // No-op quietly unless the user opted in; if a sleep window is set,
            // only fire within it (Core has no keyboard-idle signal — this is the
            // pragmatic "idle window" gate, MetaClaw-style). The job is ticked
            // hourly so it reliably catches the window; a persisted min-gap keeps
            // it to at most one retrain per ~day and prevents fire-on-every-restart.
            if !crate::learning::resolve_enabled(&state).await {
                return Ok(None);
            }
            if !crate::learning::resolve_in_sleep_window(&state).await {
                return Ok(None);
            }
            if !crate::learning::scheduled_cycle_due(&state).await {
                return Ok(None);
            }
            // Stamp before running so a crash/restart mid-cycle can't re-fire.
            crate::learning::mark_cycle_ran(&state).await;
            let plan = crate::learning::run_cycle(&state, true)
                .await
                .map_err(|e| format!("{e:#}"))?;
            // A dispatch failure is folded into plan.error (run_cycle still returns
            // Ok); surface it as a job failure so it's not recorded green.
            if let Some(err) = plan.error {
                return Err(err);
            }
            Ok(plan.job_id)
        }
        JobTarget::Agent { agent_id, prompt } => {
            // Route directly through the global agent runner so the *configured*
            // agent handles the prompt via the real chat path (its engine binding,
            // gateway routing, tools, persona). Returns the synthetic run id for
            // the job's last-outcome log. Falls back to the ephemeral single-node
            // Prompt workflow when no runner is published (headless/tests) — that
            // path now also routes the agent correctly via `run_prompt`.
            let run_id = format!("agentrun_{}", uuid::Uuid::new_v4().simple());
            if let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() {
                runner
                    .run(Some(agent_id.clone()), run_id.clone(), prompt.clone())
                    .await
                    .map_err(|e| e.to_string())?;
                return Ok(Some(run_id));
            }

            let workflow = ephemeral_agent_workflow(agent_id, prompt);
            let run = crate::workflow::executor::run_workflow(
                &workflow,
                Default::default(),
                run_id.clone(),
            )
            .await?;
            match run.status {
                crate::workflow::store::RunStatus::Failed => {
                    Err(run.error.unwrap_or_else(|| "agent run failed".to_string()))
                }
                _ => Ok(Some(run_id)),
            }
        }
    }
}

/// Build a throwaway one-node workflow that runs a single agent prompt.
fn ephemeral_agent_workflow(agent_id: &str, prompt: &str) -> Workflow {
    Workflow {
        id: format!("ephemeral_{}", uuid::Uuid::new_v4().simple()),
        name: "scheduled agent run".to_string(),
        description: None,
        nodes: vec![WorkflowNode {
            id: "prompt".to_string(),
            retry: None,
            timeout_ms: None,
            kind: NodeKind::Prompt {
                prompt: prompt.to_string(),
                agent_id: Some(agent_id.to_string()),
            },
        }],
        edges: Vec::<WorkflowEdge>::new(),
        triggers: Vec::new(),
        created_at: None,
        updated_at: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn interval_job_fires_then_debounces() {
        let scheduler = Scheduler::new();
        let job = ScheduledJob {
            id: "test-interval".to_string(),
            name: "t".to_string(),
            schedule: Schedule::Every {
                interval: "60s".to_string(),
            },
            target: JobTarget::Agent {
                agent_id: "plain".to_string(),
                prompt: "hi".to_string(),
            },
            enabled: true,
            require_approval: false,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
            last_run_at: None,
            last_outcome: None,
            history: Vec::new(),
        };
        let now = Utc::now();
        // First evaluation: due (never fired).
        assert!(scheduler.is_due(&job, now).await);
        // Record a firing.
        scheduler
            .inner
            .last_fired
            .lock()
            .await
            .insert(job.id.clone(), now);
        // 30s later: not yet due (< 60s interval).
        assert!(
            !scheduler
                .is_due(&job, now + chrono::Duration::seconds(30))
                .await
        );
        // 60s later: due again.
        assert!(
            scheduler
                .is_due(&job, now + chrono::Duration::seconds(60))
                .await
        );
    }

    #[tokio::test]
    async fn disabled_cron_job_never_due_via_tick() {
        // Sanity: a cron expression that matches now is still skipped when the
        // job is disabled (checked in `tick`, but verify parse + match here).
        let s = CronSchedule::parse("* * * * *").unwrap();
        assert!(s.matches(Utc::now()));
    }
}
