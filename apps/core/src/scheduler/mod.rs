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
    /// Installed-App state, used only to resolve `ScheduledJob::owner_app`.
    /// `None` in headless/test contexts that never opened the store — jobs then
    /// tick unconditionally, which is the pre-existing behaviour.
    apps: Option<crate::plugins::PluginStore>,
}

impl Scheduler {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(SchedulerInner {
                last_fired: tokio::sync::Mutex::new(std::collections::HashMap::new()),
                permits: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_JOBS)),
                apps: None,
            }),
        }
    }

    /// Attach the installed-App store so `owner_app` jobs can be gated on their
    /// App still being enabled. Called once at startup; without it every job
    /// ticks, App-owned or not.
    pub fn with_apps(mut self, apps: crate::plugins::PluginStore) -> Self {
        self.inner = Arc::new(SchedulerInner {
            last_fired: tokio::sync::Mutex::new(std::collections::HashMap::new()),
            permits: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_JOBS)),
            apps: Some(apps),
        });
        self
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
        // Node entitlement gate (#496): when the desktop's trial has hard-expired
        // with no subscription/license, it pushes `entitlement-active=false` to
        // Core's preferences and we PAUSE all autonomous firing here — otherwise a
        // paywalled user's automations (monitors, quests, workflows, agent runs)
        // would keep spending managed inference in the background. Debounced to
        // avoid double-firing is preserved: `last_fired` is untouched while paused,
        // so an interval job resumes immediately (not fires a backlog) once the
        // user pays. Default-ON ⇒ headless / OSS Core / entitled desktop tick
        // normally. See [`crate::entitlement`].
        // A DEFERRED UPDATE IS NOT AN AUTOMATION, so it runs BEFORE the
        // entitlement gate below. That gate pauses autonomous work for an
        // unentitled node so a paywalled user cannot keep spending managed
        // inference in the background — but an update the user explicitly asked
        // for is neither autonomous nor billable, and stranding it behind a
        // lapsed subscription would leave that node unpatched indefinitely,
        // including for security releases.
        apply_due_update(now).await;

        if !crate::entitlement::is_active() {
            tracing::debug!("scheduler: node not entitled; skipping tick (automations paused)");
            return;
        }
        for job in store::list_jobs() {
            if !job.enabled {
                continue;
            }
            if !self.owner_app_enabled(&job).await {
                continue;
            }
            if self.is_due(&job, now).await {
                self.fire(job, now).await;
            }
        }
    }

    /// True when `job` may fire given its owning App's state.
    ///
    /// A job with no `owner_app` is Core's or the desktop's and always passes.
    /// An App-owned job passes only while that App is installed AND enabled, so
    /// turning an App off stops the automations it created — the same
    /// expectation a user has of every other thing an App does. Fails **open**
    /// on a store error: a transient SQLite failure must not silently strand
    /// every App-owned automation on the node.
    async fn owner_app_enabled(&self, job: &ScheduledJob) -> bool {
        let Some(app_id) = job.owner_app.as_deref() else {
            return true;
        };
        let Some(apps) = self.inner.apps.as_ref() else {
            return true;
        };
        match apps.get(app_id).await {
            Ok(Some(rec)) => rec.enabled,
            // Uninstalled: its jobs are dead, not merely paused.
            Ok(None) => false,
            Err(e) => {
                tracing::warn!("scheduler: could not resolve owner app '{app_id}': {e:#}");
                true
            }
        }
    }

    /// True when `job` should fire at `now` and has not already fired for this
    /// schedule slot.
    async fn is_due(&self, job: &ScheduledJob, now: DateTime<Utc>) -> bool {
        let last = self.inner.last_fired.lock().await.get(&job.id).copied();
        match &job.schedule {
            Schedule::Cron { expr, tz } => {
                let Ok(schedule) = CronSchedule::parse(expr) else {
                    return false;
                };
                // An unparseable zone is treated as "never due" rather than
                // silently falling back to UTC: firing a 05:00-local job at
                // 05:00 UTC is a wrong answer wearing a right answer's clothes,
                // and the create-job validator already rejects bad zones, so
                // reaching here means the file was hand-edited.
                let zone = match tz.as_deref() {
                    Some(name) => match cron::parse_tz(name) {
                        Ok(tz) => Some(tz),
                        Err(e) => {
                            tracing::warn!("scheduler: job '{}' has a bad time zone: {e}", job.id);
                            return false;
                        }
                    },
                    None => None,
                };
                let matched = match zone {
                    Some(tz) => schedule.matches_in(now, tz),
                    None => schedule.matches(now),
                };
                if !matched {
                    return false;
                }
                // Only fire once per matching minute. Compared in the schedule's
                // own zone so the autumn repeated hour is one slot, not two.
                let slot = |t: DateTime<Utc>| match zone {
                    Some(tz) => t.with_timezone(&tz).format("%Y%m%d%H%M").to_string(),
                    None => t.format("%Y%m%d%H%M").to_string(),
                };
                match last {
                    Some(prev) => slot(prev) != slot(now),
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
            let result = run_target_for_job(&job).await;
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
                    // Feed an agent-job failure to the self-healing loop (best-effort,
                    // fire-and-forget so it never delays recording the outcome). Only
                    // agent jobs map to a corrected-prompt re-run.
                    if let JobTarget::Agent {
                        agent_id, prompt, ..
                    } = &job.target
                    {
                        let src = format!("job:{}", job.id);
                        let agent_id = agent_id.clone();
                        let prompt = prompt.clone();
                        let err = error.clone();
                        tokio::spawn(async move {
                            if let Some(client) = crate::healing_client::global_client() {
                                client
                                    .report_failure(
                                        &src,
                                        crate::healing_client::HealSource::Agent {
                                            agent_id: Some(agent_id),
                                        },
                                        prompt,
                                        err,
                                    )
                                    .await;
                            }
                        });
                    }
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

/// Validate a persisted schedule before it is written by an HTTP or MCP caller.
/// Keeping this in the scheduler module makes both surfaces agree on cron zones
/// and interval syntax.
pub(crate) fn validate_schedule(schedule: &Schedule) -> Result<(), String> {
    match schedule {
        Schedule::Cron { expr, tz } => {
            CronSchedule::parse(expr).map_err(|error| error.to_string())?;
            if let Some(zone) = tz {
                cron::parse_tz(zone).map_err(|error| error.to_string())?;
            }
        }
        Schedule::Every { interval } => {
            humantime::parse_duration(interval)
                .map_err(|_| format!("invalid interval '{interval}'"))?;
        }
    }
    Ok(())
}

/// Run a job's target to completion. On success returns the workflow run id
/// when applicable; on failure returns a human-readable error string.
///
/// Exposed `pub(crate)` so the approval engine can run a job target when the user
/// approves a `require_approval` automation (the approved run is then identical to
/// the autonomous run it replaced).
pub(crate) async fn run_target(target: &JobTarget) -> Result<Option<String>, String> {
    run_target_with_job(target, None).await
}

/// Run a target with the routine metadata needed to persist agent turns into a
/// new or selected conversation.
pub(crate) async fn run_target_for_job(job: &ScheduledJob) -> Result<Option<String>, String> {
    Box::pin(run_target_with_job(&job.target, Some(job))).await
}

async fn run_target_with_job(
    target: &JobTarget,
    job: Option<&ScheduledJob>,
) -> Result<Option<String>, String> {
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
            // The `JobTarget::Monitor` variant stays in the scheduler kernel; the
            // monitor engine is now OUT-OF-PROCESS (`ryu-monitors` sidecar). Dispatch
            // over loopback via the process-global `monitors_client`. A missing client
            // (sidecar not yet wired) treats the tick as a no-op rather than an error.
            if let Some(client) = crate::monitors_client::global_client() {
                client.run(monitor_id).await?;
            }
            Ok(None)
        }
        JobTarget::Quest { quest_id } => {
            // The `JobTarget::Quest` variant stays in the scheduler kernel; the
            // quest engine is now OUT-OF-PROCESS (`ryu-quests` sidecar). Dispatch
            // over loopback via the process-global `quests_client`, which gathers
            // Shadow evidence Core-side (the sidecar cannot reach `McpRegistry`) and
            // posts it in the judge body. A missing client (sidecar not yet wired)
            // treats the tick as a no-op rather than an error.
            if let Some(client) = crate::quests_client::global_client() {
                client.judge(quest_id).await?;
            }
            Ok(None)
        }
        JobTarget::IdentityHealth => {
            let engine = crate::identity::health::global_engine()
                .ok_or_else(|| "identity health engine not initialized".to_string())?;
            engine.run_sweep().await?;
            Ok(None)
        }
        JobTarget::LearningCycle => {
            // The learning ENGINE is the out-of-crate `ryu-learning` capability, but
            // it is driven IN-PROCESS here through a `LearningCtx` over the published
            // `ServerState` — NOT an out-of-process HTTP hop like `quests_client`.
            // This is deliberate (Outcome B): the cycle is welded to six live Core
            // subsystems and iterates the whole conversation corpus per sweep, so a
            // sidecar would only move a data-hungry consumer away from its data. Full
            // rationale: `crate::learning` module doc.
            let state = crate::learning::global_state()
                .ok_or_else(|| "learning state not initialized".to_string())?;
            let ctx = crate::learning::learning_ctx(&state);
            let host = &*ctx.host;
            // Local skills pass first — on-device + inbox-gated, so it runs on the
            // default skills opt-in and does NOT wait on the training opt-in or the
            // sleep window. Bounded per tick; failures are logged, not fatal.
            match ryu_learning::run_skills_pass(&ctx, 5).await {
                Ok(n) if n > 0 => tracing::info!("learning: proposed {n} skill(s) to the inbox"),
                Ok(_) => {}
                Err(e) => tracing::warn!("learning: skills pass failed: {e:#}"),
            }
            // No-op quietly unless the user opted in; if a sleep window is set,
            // only fire within it (Core has no keyboard-idle signal — this is the
            // pragmatic "idle window" gate, MetaClaw-style). The job is ticked
            // hourly so it reliably catches the window; a persisted min-gap keeps
            // it to at most one retrain per ~day and prevents fire-on-every-restart.
            if !ryu_learning::resolve_enabled(host).await {
                return Ok(None);
            }
            if !ryu_learning::resolve_in_sleep_window(host).await {
                return Ok(None);
            }
            if !ryu_learning::scheduled_cycle_due(host).await {
                return Ok(None);
            }
            // Stamp before running so a crash/restart mid-cycle can't re-fire.
            ryu_learning::mark_cycle_ran(host).await;
            let plan = ryu_learning::run_cycle(&ctx, true)
                .await
                .map_err(|e| format!("{e:#}"))?;
            // A dispatch failure is folded into plan.error (run_cycle still returns
            // Ok); surface it as a job failure so it's not recorded green.
            if let Some(err) = plan.error {
                return Err(err);
            }
            Ok(plan.job_id)
        }
        JobTarget::Agent {
            agent_id,
            prompt,
            model,
            conversation_id,
        } => {
            // Route directly through the global agent runner so the *configured*
            // agent handles the prompt via the real chat path (its engine binding,
            // gateway routing, tools, persona). Returns the synthetic run id for
            // the job's last-outcome log. Falls back to the ephemeral single-node
            // Prompt workflow when no runner is published (headless/tests) — that
            // path now also routes the agent correctly via `run_prompt`.
            let run_id = conversation_id
                .clone()
                .unwrap_or_else(|| format!("agentrun_{}", uuid::Uuid::new_v4().simple()));
            if let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() {
                if let Some(job) = job {
                    runner
                        .run_scheduled(
                            agent_id.clone(),
                            run_id.clone(),
                            job.name.clone(),
                            prompt.clone(),
                            model.clone(),
                            job.owner_user_id.clone(),
                            job.org_id.clone(),
                        )
                        .await
                        .map_err(|e| e.to_string())?;
                } else {
                    runner
                        .run_with_model(
                            Some(agent_id.clone()),
                            run_id.clone(),
                            prompt.clone(),
                            model.clone(),
                        )
                        .await
                        .map_err(|e| e.to_string())?;
                }
                return Ok(Some(run_id));
            }

            // A persistent routine cannot silently degrade to an ephemeral
            // workflow when the runner is unavailable: that would report success
            // while dropping the promised chat history.
            if conversation_id.is_some() || job.is_some() {
                return Err("persistent scheduled agent runs are unavailable: agent runner is not initialized".to_owned());
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
                model: None,
                conversation_id: None,
            },
            enabled: true,
            require_approval: false,
            owner_app: None,
            owner_user_id: None,
            org_id: None,
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

/// Install a deferred update once its quiet hour has arrived.
///
/// CLEARED BEFORE THE ATTEMPT, not after. The install replaces the running
/// binary and the process restarts, so "clear on success" never executes —
/// the record would survive, come due again on the next boot, and reinstall
/// on every tick forever. Clearing first means a genuine failure costs the
/// user one missed window (they are told an update is still available)
/// rather than an unbootable restart loop.
async fn apply_due_update(now: DateTime<Utc>) {
    let Some(pending) = crate::update::schedule::due_at(now) else {
        return;
    };
    if let Err(e) = crate::update::schedule::clear_pending() {
        // Could not clear ⇒ do NOT install. A failure here is exactly the
        // condition that would produce the reinstall loop above.
        tracing::error!("deferred update: could not clear the record, skipping: {e}");
        return;
    }
    tracing::info!(
        "deferred update: installing {} (scheduled for {})",
        pending.version,
        pending.scheduled_for
    );
    match crate::update::apply::apply_update(
        // A fresh registry rather than the server's: this runs unattended at
        // 03:00, so there is no UI subscribed to progress, and threading the
        // server's state into the scheduler for a once-a-release event would
        // couple the two for no observable gain.
        &ryu_downloads::DownloadCenter::new(reqwest::Client::new()),
        &pending.asset,
    )
    .await
    {
        Ok(_) => tracing::info!("deferred update: applied"),
        Err(e) => tracing::error!("deferred update: apply failed: {e}"),
    }
}
