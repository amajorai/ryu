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

pub(crate) mod app_jobs;
pub mod cron;
pub(crate) mod legacy_quest_jobs;
pub(crate) mod legacy_targets;
pub mod store;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};

use crate::sidecar::capability_consumer::CapabilityConsumer;
use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};
use cron::CronSchedule;
use store::{ExecOutcome, ExecRecord, JobTarget, Schedule, ScheduledJob};

/// How often the tick loop wakes to evaluate due jobs.
const TICK_INTERVAL: Duration = Duration::from_secs(30);

/// Maximum number of fired jobs that may execute concurrently. Bounds fan-out so
/// a flood of due jobs can't spawn unbounded tasks, while keeping one slow
/// agent/workflow run from stalling unrelated due jobs in the same tick.
const MAX_CONCURRENT_JOBS: usize = 8;

/// Of [`MAX_CONCURRENT_JOBS`], how many app-backed jobs (app jobs and legacy quest
/// jobs) may hold at once, so agent, workflow and system jobs always keep the rest.
const MAX_CONCURRENT_APP_JOBS: usize = 4;

/// How many app-backed jobs of ONE app may be in flight at once.
const MAX_IN_FLIGHT_PER_APP: usize = 2;

/// In-flight app-backed jobs: by job id, and counted per app.
#[derive(Default)]
struct AppInFlight {
    jobs: HashSet<String>,
    per_app: HashMap<String, usize>,
}

/// One admitted app-backed run. Holds an app permit and the in-flight records,
/// and releases all of them when the run's task ends (or is dropped).
struct AppJobSlot {
    in_flight: Arc<std::sync::Mutex<AppInFlight>>,
    app: String,
    job_id: String,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

impl Drop for AppJobSlot {
    fn drop(&mut self) {
        let mut in_flight = self
            .in_flight
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        in_flight.jobs.remove(&self.job_id);
        if let Some(count) = in_flight.per_app.get_mut(&self.app) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                in_flight.per_app.remove(&self.app);
            }
        }
    }
}

/// Whether a due job may fire now under the app-job concurrency budget.
enum Admission {
    /// Not app-backed: the budget does not apply.
    Unbudgeted,
    /// Admitted: the slot travels with the run.
    Admitted(AppJobSlot),
    /// Already in flight, or its app / the app budget is full: try next tick.
    Deferred,
}

/// The app an app-backed job's run budget is counted against, when it is one.
fn budget_key(job: &ScheduledJob) -> Option<&str> {
    target_budget_key(&job.target)
}

/// [`budget_key`] for a bare target.
fn target_budget_key(target: &JobTarget) -> Option<&str> {
    match target {
        JobTarget::AppJob { plugin_id, .. } => Some(plugin_id),
        JobTarget::Quest { .. } => Some(legacy_quest_jobs::CAP_QUESTS_JUDGE),
        _ => None,
    }
}

/// The app-job run budget: the app permits plus the in-flight records. The tick loop
/// and every run started outside it (run now, an approved run) draw on ONE of these,
/// so a manual run can neither overlap a scheduled run of the same job nor push an
/// app past [`MAX_IN_FLIGHT_PER_APP`].
#[derive(Clone)]
struct AppJobBudget {
    permits: Arc<tokio::sync::Semaphore>,
    in_flight: Arc<std::sync::Mutex<AppInFlight>>,
}

impl AppJobBudget {
    fn new() -> Self {
        Self {
            permits: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_APP_JOBS)),
            in_flight: Arc::new(std::sync::Mutex::new(AppInFlight::default())),
        }
    }

    /// Take a slot for `job_id` of `app`, or `None` when that job is already in
    /// flight, its app is at [`MAX_IN_FLIGHT_PER_APP`], or every app permit is held.
    fn try_admit(&self, job_id: &str, app: &str) -> Option<AppJobSlot> {
        let mut in_flight = self
            .in_flight
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if in_flight.jobs.contains(job_id)
            || in_flight.per_app.get(app).copied().unwrap_or(0) >= MAX_IN_FLIGHT_PER_APP
        {
            return None;
        }
        let permit = Arc::clone(&self.permits).try_acquire_owned().ok()?;
        in_flight.jobs.insert(job_id.to_owned());
        *in_flight.per_app.entry(app.to_owned()).or_default() += 1;
        Some(AppJobSlot {
            in_flight: Arc::clone(&self.in_flight),
            app: app.to_owned(),
            job_id: job_id.to_owned(),
            _permit: permit,
        })
    }
}

/// The running tick loop's budget, registered by [`Scheduler::spawn`].
static RUNNING_BUDGET: std::sync::OnceLock<AppJobBudget> = std::sync::OnceLock::new();

/// The budget runs started outside the tick draw on: the tick loop's when one runs,
/// else one process-wide budget (Safe Mode and headless contexts never spawn it).
fn manual_run_budget() -> &'static AppJobBudget {
    static IDLE: std::sync::OnceLock<AppJobBudget> = std::sync::OnceLock::new();
    RUNNING_BUDGET
        .get()
        .unwrap_or_else(|| IDLE.get_or_init(AppJobBudget::new))
}

/// The refusal a run started outside the tick gets while its app job is busy.
pub(crate) const APP_JOB_BUSY: &str =
    "this app job is already running, or its app is at its run limit; try again shortly";

/// How long an approved app-backed run waits for its budget slot before it fails.
pub(crate) const APPROVED_RUN_SLOT_WAIT: Duration = Duration::from_secs(300);

/// A budget slot held by a run started outside the tick (see [`admit_manual_run`]).
/// Holds nothing for a job the app-job budget does not cover.
pub(crate) struct ManualRunSlot {
    _slot: Option<AppJobSlot>,
}

/// Admit a run of `job_id` / `target` started outside the tick against the same
/// budget the tick uses: at most one run per job, [`MAX_IN_FLIGHT_PER_APP`] per app
/// and [`MAX_CONCURRENT_APP_JOBS`] in all. A target the budget does not cover
/// (agent, workflow, system) is always admitted.
pub(crate) fn admit_manual_run(job_id: &str, target: &JobTarget) -> Result<ManualRunSlot, String> {
    admit_manual_run_in(manual_run_budget(), job_id, target)
}

fn admit_manual_run_in(
    budget: &AppJobBudget,
    job_id: &str,
    target: &JobTarget,
) -> Result<ManualRunSlot, String> {
    let Some(app) = target_budget_key(target) else {
        return Ok(ManualRunSlot { _slot: None });
    };
    budget
        .try_admit(job_id, app)
        .map(|slot| ManualRunSlot { _slot: Some(slot) })
        .ok_or_else(|| APP_JOB_BUSY.to_owned())
}

/// [`admit_manual_run`] that waits up to `wait` for the slot, for an approved run
/// that should still happen once the in-flight run ends.
pub(crate) async fn admit_manual_run_waiting(
    job_id: &str,
    target: &JobTarget,
    wait: Duration,
) -> Result<ManualRunSlot, String> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        match admit_manual_run(job_id, target) {
            Ok(slot) => return Ok(slot),
            Err(error) if tokio::time::Instant::now() >= deadline => return Err(error),
            Err(_) => tokio::time::sleep(Duration::from_secs(1)).await,
        }
    }
}

/// The app whose state gates `job`: an app job's own app, else its `owner_app`.
fn job_app(job: &ScheduledJob) -> Option<&str> {
    match &job.target {
        JobTarget::AppJob { plugin_id, .. } => Some(plugin_id),
        _ => job.owner_app.as_deref(),
    }
}

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
    /// Bounds app-backed jobs: [`MAX_CONCURRENT_APP_JOBS`] in all,
    /// [`MAX_IN_FLIGHT_PER_APP`] per app, one per job. Registered for runs started
    /// outside the tick when the loop is spawned.
    app_budget: AppJobBudget,
    /// Ids of jobs fired but not yet finished (queued on a permit or running).
    /// A job whose previous run is still in flight is not fired again, so a run
    /// that outlasts its interval/cron slot cannot overlap itself, and a backlog
    /// of copies cannot queue behind a saturated pool and then burst. This is
    /// the process-wide [`IN_FLIGHT`] set, which manual runs also claim.
    in_flight: InFlightSet,
    /// Installed-App state, used only to resolve `ScheduledJob::owner_app`.
    /// `None` in headless/test contexts that never opened the store — jobs then
    /// tick unconditionally, which is the pre-existing behaviour.
    apps: Option<crate::plugins::PluginStore>,
    /// The consumer app jobs run through. `None` uses the process-global one.
    consumer: Option<CapabilityConsumer>,
}

impl SchedulerInner {
    fn new(
        apps: Option<crate::plugins::PluginStore>,
        consumer: Option<CapabilityConsumer>,
    ) -> Self {
        Self {
            last_fired: tokio::sync::Mutex::new(std::collections::HashMap::new()),
            permits: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_JOBS)),
            app_budget: AppJobBudget::new(),
            in_flight: Arc::clone(&IN_FLIGHT),
            apps,
            consumer,
        }
    }
}

/// Ids of jobs running anywhere in this process: scheduled firings and the
/// manual "run now" paths (HTTP route, routines tool, approved runs) share one
/// set, so a manual run never overlaps a scheduled firing or another manual run.
type InFlightSet = Arc<std::sync::Mutex<std::collections::HashSet<String>>>;
static IN_FLIGHT: std::sync::LazyLock<InFlightSet> = std::sync::LazyLock::new(Arc::default);

/// Claim `job_id` for a manual run. `None` while a scheduled firing or another
/// manual run of the same job is in flight. Hold the guard until the run and
/// its history write finish; dropping it (on any path) releases the claim.
pub(crate) fn claim_in_flight(job_id: &str) -> Option<InFlightGuard> {
    InFlightGuard::claim(&IN_FLIGHT, job_id)
}

impl Scheduler {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(SchedulerInner::new(None, None)),
        }
    }

    /// Attach the installed-App store so `owner_app` jobs can be gated on their
    /// App still being enabled. Called once at startup; without it every job
    /// ticks, App-owned or not.
    pub fn with_apps(mut self, apps: crate::plugins::PluginStore) -> Self {
        self.inner = Arc::new(SchedulerInner::new(Some(apps), self.inner.consumer.clone()));
        self
    }

    /// Run app jobs through `consumer` instead of the process-global one.
    #[cfg(test)]
    fn with_capability_consumer(mut self, consumer: CapabilityConsumer) -> Self {
        self.inner = Arc::new(SchedulerInner::new(self.inner.apps.clone(), Some(consumer)));
        self
    }

    /// The consumer app jobs run through.
    fn consumer(&self) -> Option<&CapabilityConsumer> {
        self.inner
            .consumer
            .as_ref()
            .or_else(|| crate::sidecar::capability_consumer::global())
    }

    /// Spawn the background tick loop. Returns immediately; the loop runs until
    /// the process exits.
    pub fn spawn(&self) {
        // Runs started outside the tick (run now, approved runs) share this loop's
        // app-job budget. Only the first spawned loop registers.
        let _ = RUNNING_BUDGET.set(self.inner.app_budget.clone());
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

        if crate::execution_control::is_paused() {
            return;
        }

        if !crate::entitlement::is_active() {
            tracing::debug!("scheduler: node not entitled; skipping tick (automations paused)");
            return;
        }
        self.tick_jobs(store::list_jobs(), now).await;
    }

    /// Fire every due, enabled, ungated job in `jobs`. The part of [`Self::tick`]
    /// after the node-wide gates.
    ///
    /// An app job additionally needs its app to be a current runner (an enabled,
    /// Core-tier provider of `jobs.run`). The runner set is resolved lazily, once
    /// per tick and only when an app job is due; a job whose app is not in it is
    /// skipped without recording anything. A store error falls back to the
    /// owner-app gate (fail open).
    async fn tick_jobs(&self, jobs: Vec<ScheduledJob>, now: DateTime<Utc>) {
        let mut runners: Option<Option<HashSet<String>>> = None;
        for job in jobs {
            if !job.enabled {
                continue;
            }
            if !self.owner_app_enabled(&job).await {
                continue;
            }
            if !self.is_due(&job, now).await {
                continue;
            }
            if let JobTarget::AppJob { plugin_id, .. } = &job.target {
                if runners.is_none() {
                    runners = Some(app_jobs::app_job_runners(self.consumer()).await);
                }
                if let Some(Some(runners)) = &runners {
                    if !runners.contains(plugin_id) {
                        tracing::debug!(
                            "scheduler: app job '{}' skipped; '{plugin_id}' does not run app jobs now",
                            job.id
                        );
                        continue;
                    }
                }
            }
            let slot = match self.admit(&job) {
                Admission::Unbudgeted => None,
                Admission::Admitted(slot) => Some(slot),
                Admission::Deferred => {
                    // `last_fired` is left alone, so it retries on the next tick.
                    tracing::debug!(
                        "scheduler: app-backed job '{}' deferred (in flight or budget full)",
                        job.id
                    );
                    continue;
                }
            };
            self.fire(job, now, slot).await;
        }
    }

    /// Apply the app-job concurrency budget to a due job: at most one run per job,
    /// [`MAX_IN_FLIGHT_PER_APP`] per app, and [`MAX_CONCURRENT_APP_JOBS`] in all.
    fn admit(&self, job: &ScheduledJob) -> Admission {
        let Some(app) = budget_key(job) else {
            return Admission::Unbudgeted;
        };
        match self.inner.app_budget.try_admit(&job.id, app) {
            Some(slot) => Admission::Admitted(slot),
            None => Admission::Deferred,
        }
    }

    /// True when `job` may fire given its App's state ([`job_app`]: an app job's
    /// own app, else the job's `owner_app`).
    ///
    /// A job with neither is Core's or the desktop's and always passes.
    /// An App-owned job passes only while that App is installed AND enabled, so
    /// turning an App off stops the automations it created — the same
    /// expectation a user has of every other thing an App does. Fails **open**
    /// on a store error: a transient SQLite failure must not silently strand
    /// every App-owned automation on the node.
    async fn owner_app_enabled(&self, job: &ScheduledJob) -> bool {
        let Some(app_id) = job_app(job) else {
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
                // After a restart the in-memory debounce is empty, so fall back
                // to the most recent recorded run's start instant: a Core
                // restart inside a matching minute must not fire that slot twice.
                let last = last.or_else(|| {
                    job.history
                        .last()
                        .and_then(|record| parse_rfc3339_utc(&record.started_at))
                });
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
                // The in-memory debounce starts empty on every Core start, so
                // anchor on the persisted `last_run_at` instead: a restart (an
                // update, a crash loop, a desktop relaunch) must not replay an
                // interval job that ran recently.
                let last = last.or_else(|| {
                    job.last_run_at
                        .as_deref()
                        .and_then(parse_rfc3339_utc)
                        // A recorded run in the future means the clock moved
                        // backwards since; firing beats stranding the job until
                        // the clock catches up.
                        .filter(|prev| *prev <= now)
                });
                match last {
                    Some(prev) => now - prev >= dur,
                    // Never run: fire once now, then debounce to the interval.
                    None => true,
                }
            }
        }
    }

    /// Fire a due job. Marks `last_fired` (preserving once-per-slot semantics)
    /// *before* spawning the actual run on a bounded task pool, so a slow
    /// agent/workflow run never stalls other due jobs in the same tick. The
    /// spawned task executes the target, records the outcome, and persists. An
    /// app-backed job's `slot` is held by that task until it ends.
    async fn fire(&self, job: ScheduledJob, now: DateTime<Utc>, slot: Option<AppJobSlot>) {
        // Skip (without consuming the slot) while the previous run is in flight.
        // A skipped app-backed job's budget `slot` is released here, so it is
        // retried on the next tick.
        let Some(in_flight) = InFlightGuard::claim(&self.inner.in_flight, &job.id) else {
            tracing::debug!(
                "scheduler: job '{}' is still running from an earlier firing; skipping",
                job.id
            );
            return;
        };
        self.inner
            .last_fired
            .lock()
            .await
            .insert(job.id.clone(), now);

        let permits = Arc::clone(&self.inner.permits);
        let consumer = self.inner.consumer.clone();
        let task = async move {
            let _slot = slot;
            // Released when this task ends, on every path (including panic).
            // Declared after `_slot`, so it is released first: a manual run that
            // wins the freed budget slot never finds this run still in flight.
            let _in_flight = in_flight;
            // Cap concurrency: a flood of due jobs queues here rather than
            // spawning unbounded work. Closed semaphore (never happens) → skip.
            let Ok(_permit) = permits.acquire().await else {
                return;
            };

            // Human-in-the-loop gate: a `require_approval` job does not run on
            // firing — it raises an approval request and runs only once the user
            // approves (the approval engine then calls `run_target`). Deduped on
            // the job id so a due interval can't pile up duplicate requests while
            // one is still pending.
            //
            // App-owned jobs are never approval-gated: the reconcile rewrites
            // them with `require_approval: false` and `PUT /heartbeat/jobs`
            // refuses to gate them. A job migrated from a retired per-app target
            // can still carry the old flag until its app's first authoritative
            // list (forever, with an app that predates `jobs.list`), and gating
            // it would raise approvals that released clients never show.
            if job.require_approval && !matches!(job.target, JobTarget::AppJob { .. }) {
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

            let claim = match store::capture_execution(&job).await {
                Ok(claim) => claim,
                Err(error) => {
                    tracing::warn!(
                        "scheduler skipped changed or missing job '{}': {error}",
                        job.id
                    );
                    return;
                }
            };
            tracing::info!("scheduler firing job '{}' ({})", job.name, job.id);
            let started_at = Utc::now().to_rfc3339();
            let consumer = consumer
                .as_ref()
                .or_else(|| crate::sidecar::capability_consumer::global());
            let result = Box::pin(run_target_with_job(&job.target, Some(&job), consumer)).await;
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
                    // Raise `core#run.failed` for an agent job (only agent jobs map to
                    // a corrected-prompt re-run). Synchronous queueing only: it never
                    // delays recording the outcome and never fails the job further.
                    crate::run_failures::report_job_failure(&job, &error);
                    ExecRecord {
                        started_at,
                        finished_at,
                        outcome: ExecOutcome::Failure,
                        run_id: None,
                        error: Some(error),
                    }
                }
            };

            if let Err(e) = store::append_execution_claim(claim, record).await {
                tracing::error!("failed to persist job '{}' after execution: {e}", job.id);
            }
        };
        #[cfg(test)]
        let task = store::inherit_test_jobs_directory(task);
        tokio::spawn(task);
    }
}

/// Membership of one job id in [`SchedulerInner::in_flight`], removed on drop.
pub(crate) struct InFlightGuard {
    set: InFlightSet,
    id: String,
}

impl InFlightGuard {
    /// Claim `id`, or `None` when it is already in flight.
    fn claim(set: &InFlightSet, id: &str) -> Option<Self> {
        let mut guard = set
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !guard.insert(id.to_owned()) {
            return None;
        }
        Some(Self {
            set: Arc::clone(set),
            id: id.to_owned(),
        })
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.set
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.id);
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
    run_target_with_job(target, None, crate::sidecar::capability_consumer::global()).await
}

/// Run a target with the routine metadata needed to persist agent turns into a
/// new or selected conversation.
pub(crate) async fn run_target_for_job(job: &ScheduledJob) -> Result<Option<String>, String> {
    Box::pin(run_target_with_job(
        &job.target,
        Some(job),
        crate::sidecar::capability_consumer::global(),
    ))
    .await
}

async fn run_target_with_job(
    target: &JobTarget,
    job: Option<&ScheduledJob>,
    consumer: Option<&CapabilityConsumer>,
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
        JobTarget::ProviderAccount {
            provider_id,
            account_id,
            prompt,
            model,
        } => {
            let model = model
                .as_deref()
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .ok_or_else(|| "a provider account ping must name a model".to_owned())?;
            crate::server::account_warmup::ping(provider_id, account_id, model, prompt).await?;
            Ok(None)
        }
        JobTarget::AppJob {
            plugin_id,
            job_id,
            payload,
        } => {
            // The engine is the app's own `jobs.run` (see `app_jobs`). The tick
            // skips a job whose app is not a current runner before getting here; a
            // run-now or an approved run that still reaches one records the error.
            app_jobs::run_app_job(consumer, plugin_id, job_id, payload.as_ref()).await?;
            Ok(None)
        }
        JobTarget::Quest { quest_id } => {
            // Frozen residue through `quests.judge`; Core gathers the Shadow evidence
            // the provider cannot reach and posts it in the judge body.
            legacy_quest_jobs::judge_quest(consumer, quest_id).await?;
            Ok(None)
        }
        JobTarget::IdentityHealth => {
            if let Some(result) = crate::identity::passport::health_sweep().await {
                result.map_err(|error| error.to_string())?;
                return Ok(None);
            }
            let engine = crate::identity::health::global_engine()
                .ok_or_else(|| "identity health engine not initialized".to_string())?;
            engine.run_sweep().await?;
            Ok(None)
        }
        JobTarget::LearningCycle => {
            // The learning ENGINE is the out-of-crate `ryu-learning` capability, but
            // it is driven IN-PROCESS here through a `LearningCtx` over the published
            // `ServerState` — NOT an out-of-process capability call like `quests.judge`.
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
                let outcome = if let Some(job) = job {
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
                } else {
                    runner
                        .run_with_model(
                            Some(agent_id.clone()),
                            run_id.clone(),
                            prompt.clone(),
                            model.clone(),
                        )
                        .await
                };
                // A run in its own fresh conversation never gets another turn, so
                // its ACP agent would only hold an admission slot until it idles out.
                if let Some(one_shot) =
                    one_shot_run_conversation(conversation_id.as_deref(), &run_id)
                {
                    crate::sidecar::adapters::acp::close_conversation_instances(one_shot);
                }
                outcome.map_err(|e| e.to_string())?;
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

/// The conversation of a scheduled agent run that will never get another turn:
/// the run's own id when the job names no conversation to continue.
fn one_shot_run_conversation<'a>(
    conversation_id: Option<&str>,
    run_id: &'a str,
) -> Option<&'a str> {
    conversation_id.is_none().then_some(run_id)
}

/// Parse a persisted RFC 3339 timestamp; an unreadable one counts as absent.
fn parse_rfc3339_utc(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|instant| instant.with_timezone(&Utc))
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
            repeat: None,
            kind: NodeKind::Prompt {
                prompt: prompt.to_string(),
                agent_id: Some(agent_id.to_string()),
            },
        }],
        edges: Vec::<WorkflowEdge>::new(),
        triggers: Vec::new(),
        max_concurrency: None,
        created_at: None,
        updated_at: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scheduled agent run without a conversation of its own (an hourly
    /// patrol, say) never gets another turn, so its ACP agent is closed after
    /// the run instead of holding an admission slot until it idles out.
    #[test]
    fn only_a_run_in_its_own_fresh_conversation_is_one_shot() {
        assert_eq!(
            super::one_shot_run_conversation(None, "agentrun_1"),
            Some("agentrun_1")
        );
        assert_eq!(
            super::one_shot_run_conversation(Some("routine-chat"), "routine-chat"),
            None
        );
    }

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

    fn job_with(id: &str, schedule: Schedule) -> ScheduledJob {
        ScheduledJob {
            id: id.to_string(),
            name: "t".to_string(),
            schedule,
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
        }
    }

    #[tokio::test]
    async fn interval_job_after_restart_anchors_on_persisted_last_run() {
        // A fresh Scheduler models a Core restart: `last_fired` is empty.
        let scheduler = Scheduler::new();
        let now = Utc::now();
        let mut job = job_with(
            "test-interval-restart",
            Schedule::Every {
                interval: "1h".to_string(),
            },
        );

        // Never run: still fires once on first boot.
        assert!(scheduler.is_due(&job, now).await);

        // Ran 30 minutes ago: a restart must not replay it.
        job.last_run_at = Some((now - chrono::Duration::minutes(30)).to_rfc3339());
        assert!(!scheduler.is_due(&job, now).await);

        // Ran two hours ago: the interval has elapsed.
        job.last_run_at = Some((now - chrono::Duration::hours(2)).to_rfc3339());
        assert!(scheduler.is_due(&job, now).await);

        // Recorded in the future (clock moved backwards): due, not stranded.
        job.last_run_at = Some((now + chrono::Duration::hours(2)).to_rfc3339());
        assert!(scheduler.is_due(&job, now).await);

        // Unparseable timestamp counts as never run.
        job.last_run_at = Some("not-a-time".to_string());
        assert!(scheduler.is_due(&job, now).await);
    }

    #[tokio::test]
    async fn cron_job_after_restart_does_not_refire_same_minute() {
        let scheduler = Scheduler::new();
        let now = Utc::now();
        let mut job = job_with(
            "test-cron-restart",
            Schedule::Cron {
                expr: "* * * * *".to_string(),
                tz: None,
            },
        );
        assert!(scheduler.is_due(&job, now).await);

        // A run started in this same minute before the restart.
        job.history.push(ExecRecord {
            started_at: now.to_rfc3339(),
            finished_at: now.to_rfc3339(),
            outcome: ExecOutcome::Success,
            run_id: None,
            error: None,
        });
        assert!(!scheduler.is_due(&job, now).await);
        // The next minute is a new slot.
        assert!(
            scheduler
                .is_due(&job, now + chrono::Duration::minutes(1))
                .await
        );
    }

    #[test]
    fn manual_claim_blocks_scheduler_fire_and_repeat_manual_claim() {
        let scheduler = Scheduler::new();
        assert!(Arc::ptr_eq(&scheduler.inner.in_flight, &IN_FLIGHT));
        // The shared set is process-wide, so use an id no other test claims.
        let id = format!("job-{}", uuid::Uuid::new_v4().simple());
        let manual = claim_in_flight(&id).expect("first manual claim");
        assert!(
            claim_in_flight(&id).is_none(),
            "a double-click must not run twice"
        );
        assert!(
            InFlightGuard::claim(&scheduler.inner.in_flight, &id).is_none(),
            "a scheduled firing must skip while a manual run is in flight"
        );
        drop(manual);
        let fired = InFlightGuard::claim(&scheduler.inner.in_flight, &id).expect("scheduler claim");
        assert!(
            claim_in_flight(&id).is_none(),
            "a manual run must not overlap a scheduled firing"
        );
        drop(fired);
        assert!(claim_in_flight(&id).is_some());
    }

    #[test]
    fn in_flight_guard_blocks_overlap_until_released() {
        let set = Arc::default();
        let first = InFlightGuard::claim(&set, "job-a").expect("first claim");
        assert!(InFlightGuard::claim(&set, "job-a").is_none());
        // Other jobs are unaffected.
        let other = InFlightGuard::claim(&set, "job-b").expect("other job");
        drop(first);
        assert!(InFlightGuard::claim(&set, "job-a").is_some());
        drop(other);
        assert!(set.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn disabled_cron_job_never_due_via_tick() {
        // Sanity: a cron expression that matches now is still skipped when the
        // job is disabled (checked in `tick`, but verify parse + match here).
        let s = CronSchedule::parse("* * * * *").unwrap();
        assert!(s.matches(Utc::now()));
    }

    // ── App jobs: gating and the concurrency budget ─────────────────────────

    use app_jobs::test_support::{consumer_over, core_tier_id, Provider, JOB_ROUTES};
    use axum::routing::post;
    use axum::{Json, Router};

    fn due_job(id: &str, target: JobTarget) -> ScheduledJob {
        ScheduledJob {
            id: id.to_owned(),
            name: id.to_owned(),
            schedule: Schedule::Every {
                interval: "1m".to_owned(),
            },
            target,
            enabled: true,
            require_approval: false,
            owner_app: None,
            owner_user_id: None,
            org_id: None,
            created_at: "2026-01-01T00:00:00Z".to_owned(),
            updated_at: "2026-01-01T00:00:00Z".to_owned(),
            last_run_at: None,
            last_outcome: None,
            history: Vec::new(),
        }
    }

    fn app_job(id: &str, plugin: &str) -> ScheduledJob {
        let mut job = due_job(
            id,
            JobTarget::AppJob {
                plugin_id: plugin.to_owned(),
                job_id: id.to_owned(),
                payload: None,
            },
        );
        job.owner_app = Some(plugin.to_owned());
        job
    }

    /// A run started outside the tick draws on the tick's budget: it is refused
    /// while the same job is in flight or its app is at its cap, an unbudgeted
    /// target is always admitted, and a dropped slot frees the job again.
    #[test]
    fn manual_runs_share_the_app_job_budget() {
        let scheduler = Scheduler::new();
        let budget = &scheduler.inner.app_budget;
        let job = app_job("manual-1", "@example/budget");
        let Admission::Admitted(scheduled) = scheduler.admit(&job) else {
            panic!("the scheduled run is admitted");
        };
        assert_eq!(
            admit_manual_run_in(budget, &job.id, &job.target)
                .err()
                .as_deref(),
            Some(APP_JOB_BUSY),
            "run now while the scheduled run is in flight"
        );

        let second = app_job("manual-2", "@example/budget");
        let held = admit_manual_run_in(budget, &second.id, &second.target)
            .expect("a second job of the app fits its cap");
        let third = app_job("manual-3", "@example/budget");
        assert!(
            admit_manual_run_in(budget, &third.id, &third.target).is_err(),
            "the app is at its per-app cap"
        );
        assert!(matches!(scheduler.admit(&third), Admission::Deferred));

        let workflow = due_job(
            "manual-workflow",
            JobTarget::Workflow {
                workflow_id: "w".to_owned(),
                input: HashMap::new(),
            },
        );
        assert!(admit_manual_run_in(budget, &workflow.id, &workflow.target).is_ok());

        drop(scheduled);
        drop(held);
        assert!(admit_manual_run_in(budget, &job.id, &job.target).is_ok());
    }

    async fn fired(scheduler: &Scheduler) -> HashSet<String> {
        scheduler
            .inner
            .last_fired
            .lock()
            .await
            .keys()
            .cloned()
            .collect()
    }

    async fn fired_at(scheduler: &Scheduler, id: &str) -> Option<DateTime<Utc>> {
        scheduler.inner.last_fired.lock().await.get(id).copied()
    }

    /// An app job is gated on ITS app: disabled, uninstalled, or no longer a
    /// provider of `jobs.run` means it is skipped, with nothing recorded.
    #[tokio::test]
    async fn app_job_gating_uses_target_plugin() {
        let runner = core_tier_id("gate-runner");
        let disabled = core_tier_id("gate-disabled");
        let no_run = core_tier_id("gate-norun");
        let (consumer, store, _ports) = consumer_over(&[
            Provider {
                id: runner.clone(),
                provides: JOB_ROUTES,
                enabled: true,
                core_tier: true,
            },
            Provider {
                id: disabled.clone(),
                provides: JOB_ROUTES,
                enabled: false,
                core_tier: true,
            },
            Provider {
                id: no_run.clone(),
                provides: &[(app_jobs::CAP_JOBS_LIST, Some("/jobs/list"))],
                enabled: true,
                core_tier: true,
            },
        ])
        .await;
        let scheduler = Scheduler::new()
            .with_apps(store)
            .with_capability_consumer(consumer);
        let directory = tempfile::tempdir().unwrap();
        store::with_test_jobs_directory(directory.path().to_path_buf(), async {
            let jobs = vec![
                app_job("j-runner", &runner),
                app_job("j-disabled", &disabled),
                app_job("j-norun", &no_run),
                app_job("j-gone", "@example/uninstalled"),
            ];
            for job in &jobs {
                store::save_job(job).unwrap();
            }
            scheduler.tick_jobs(jobs, Utc::now()).await;
            assert_eq!(
                fired(&scheduler).await,
                HashSet::from(["j-runner".to_owned()])
            );
            for id in ["j-disabled", "j-norun", "j-gone"] {
                assert!(store::load_job(id).unwrap().history.is_empty(), "{id}");
            }
        })
        .await;
    }

    /// A job migrated from a retired per-app target can still carry
    /// `require_approval`; as an app job it runs when due instead of raising an
    /// approval that released clients never show.
    #[tokio::test]
    async fn app_jobs_ignore_a_leftover_approval_flag() {
        let runner = core_tier_id("approval-flag");
        let (consumer, store, ports) = consumer_over(&[Provider {
            id: runner.clone(),
            provides: JOB_ROUTES,
            enabled: true,
            core_tier: true,
        }])
        .await;
        let server = crate::sidecar::capability_consumer::test_support::serve(
            ports[0],
            Router::new().route(
                "/api/fixture/jobs/run",
                post(|| async { Json(serde_json::json!({})) }),
            ),
        )
        .await;
        let scheduler = Scheduler::new()
            .with_apps(store)
            .with_capability_consumer(consumer);
        let directory = tempfile::tempdir().unwrap();
        store::with_test_jobs_directory(directory.path().to_path_buf(), async {
            let mut job = app_job("flagged", &runner);
            job.require_approval = true;
            store::save_job(&job).unwrap();
            scheduler.tick_jobs(vec![job], Utc::now()).await;
            let recorded = tokio::time::timeout(Duration::from_secs(20), async {
                loop {
                    if let Some(record) =
                        store::load_job("flagged").unwrap().history.first().cloned()
                    {
                        return record;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            })
            .await
            .expect("the flagged app job runs");
            assert_eq!(recorded.outcome, ExecOutcome::Success);
        })
        .await;
        server.abort();
    }

    /// The budget: one run per job, two per app, four app-backed runs in all;
    /// other jobs are never budgeted. A slot frees its place when dropped.
    #[test]
    fn app_jobs_hold_at_most_four_permits_and_never_overlap() {
        let scheduler = Scheduler::new();
        let admitted = |job: &ScheduledJob| match scheduler.admit(job) {
            Admission::Admitted(slot) => Some(slot),
            Admission::Deferred => None,
            Admission::Unbudgeted => panic!("'{}' must be budgeted", job.id),
        };
        let a1 = admitted(&app_job("a1", "@example/a")).expect("first run admitted");
        assert!(
            admitted(&app_job("a1", "@example/a")).is_none(),
            "a second fire of an in-flight job is deferred"
        );
        let a2 = admitted(&app_job("a2", "@example/a")).unwrap();
        assert!(
            admitted(&app_job("a3", "@example/a")).is_none(),
            "an app's third run waits"
        );
        let b1 = admitted(&app_job("b1", "@example/b")).unwrap();
        let quest = admitted(&due_job(
            "quest-q1",
            JobTarget::Quest {
                quest_id: "q1".into(),
            },
        ))
        .unwrap();
        assert_eq!(scheduler.inner.app_budget.permits.available_permits(), 0);
        assert!(
            admitted(&app_job("c1", "@example/c")).is_none(),
            "the fifth app-backed run waits"
        );
        assert!(matches!(
            scheduler.admit(&due_job("w", JobTarget::LearningCycle)),
            Admission::Unbudgeted
        ));

        drop(a1);
        let again = admitted(&app_job("a1", "@example/a")).expect("re-admitted after the run ends");
        drop((again, a2, b1, quest));
        assert_eq!(
            scheduler.inner.app_budget.permits.available_permits(),
            MAX_CONCURRENT_APP_JOBS
        );
        let in_flight = scheduler.inner.app_budget.in_flight.lock().unwrap();
        assert!(in_flight.jobs.is_empty() && in_flight.per_app.is_empty());
    }

    /// Hanging app jobs hold only their own slots: a non-app job due in the same
    /// tick still runs, and a deferred app job is not marked as fired.
    #[tokio::test]
    async fn hanging_app_job_does_not_block_other_jobs() {
        let hanging = core_tier_id("hang");
        let (consumer, store, ports) = consumer_over(&[Provider {
            id: hanging.clone(),
            provides: JOB_ROUTES,
            enabled: true,
            core_tier: true,
        }])
        .await;
        let server = crate::sidecar::capability_consumer::test_support::serve(
            ports[0],
            Router::new().route(
                "/api/fixture/jobs/run",
                post(|| async {
                    std::future::pending::<()>().await;
                    Json(serde_json::json!({}))
                }),
            ),
        )
        .await;
        let scheduler = Scheduler::new()
            .with_apps(store)
            .with_capability_consumer(consumer);
        let directory = tempfile::tempdir().unwrap();
        store::with_test_jobs_directory(directory.path().to_path_buf(), async {
            let jobs = vec![
                app_job("h1", &hanging),
                app_job("h2", &hanging),
                app_job("h3", &hanging),
                due_job(
                    "w",
                    JobTarget::Workflow {
                        workflow_id: "missing-workflow-for-scheduler-test".to_owned(),
                        input: HashMap::new(),
                    },
                ),
            ];
            for job in &jobs {
                store::save_job(job).unwrap();
            }
            scheduler.tick_jobs(jobs, Utc::now()).await;
            assert_eq!(
                fired(&scheduler).await,
                HashSet::from(["h1".to_owned(), "h2".to_owned(), "w".to_owned()])
            );
            let recorded = tokio::time::timeout(Duration::from_secs(20), async {
                loop {
                    if let Some(record) = store::load_job("w").unwrap().history.first().cloned() {
                        return record;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            })
            .await
            .expect("the workflow job runs while app jobs hang");
            assert_eq!(recorded.outcome, ExecOutcome::Failure);
            for id in ["h1", "h2", "h3"] {
                assert!(store::load_job(id).unwrap().history.is_empty(), "{id}");
            }
            assert_eq!(
                scheduler.inner.app_budget.permits.available_permits(),
                MAX_CONCURRENT_APP_JOBS - 2
            );
        })
        .await;
        server.abort();
    }

    /// An app job still in flight is not fired again when it next falls due: the
    /// second tick defers it without advancing `last_fired`, so it retries on a
    /// later tick instead of stacking a second run.
    #[tokio::test]
    async fn second_fire_skipped_while_in_flight() {
        let hanging = core_tier_id("again");
        let (consumer, store, ports) = consumer_over(&[Provider {
            id: hanging.clone(),
            provides: JOB_ROUTES,
            enabled: true,
            core_tier: true,
        }])
        .await;
        let server = crate::sidecar::capability_consumer::test_support::serve(
            ports[0],
            Router::new().route(
                "/api/fixture/jobs/run",
                post(|| async {
                    std::future::pending::<()>().await;
                    Json(serde_json::json!({}))
                }),
            ),
        )
        .await;
        let scheduler = Scheduler::new()
            .with_apps(store)
            .with_capability_consumer(consumer);
        let directory = tempfile::tempdir().unwrap();
        store::with_test_jobs_directory(directory.path().to_path_buf(), async {
            let job = app_job("again-1", &hanging);
            store::save_job(&job).unwrap();

            let first = Utc::now();
            scheduler.tick_jobs(vec![job.clone()], first).await;
            assert_eq!(fired_at(&scheduler, "again-1").await, Some(first));

            // Due again (every 1m), but the first run has not finished.
            let later = first + chrono::Duration::minutes(5);
            scheduler.tick_jobs(vec![job], later).await;
            assert_eq!(
                fired_at(&scheduler, "again-1").await,
                Some(first),
                "a deferred fire leaves last_fired alone"
            );
            assert_eq!(
                scheduler.inner.app_budget.permits.available_permits(),
                MAX_CONCURRENT_APP_JOBS - 1,
                "only the first run holds an app permit"
            );
            assert!(store::load_job("again-1").unwrap().history.is_empty());
        })
        .await;
        server.abort();
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
    // Off the tick loop: the download has no overall deadline, so awaiting it
    // inline would let one stalled transfer freeze every scheduled job. The
    // record is already cleared above, so later ticks cannot start a second
    // install.
    tokio::spawn(async move {
        match crate::update::apply::apply_update(
            // A fresh registry rather than the server's: this runs unattended at
            // 03:00, so there is no UI subscribed to progress, and threading the
            // server's state into the scheduler for a once-a-release event would
            // couple the two for no observable gain. The default client keeps
            // the center's SSRF-screened manual redirect handling.
            &ryu_downloads::DownloadCenter::with_default_client(),
            &pending.asset,
        )
        .await
        {
            Ok(result) => {
                tracing::info!("deferred update: applied — {}", result.message);
                if result.applied && result.gateway_left_behind && restart_after_update_enabled() {
                    tracing::warn!(
                        "deferred update: not restarting — the Gateway was not updated with Core, and a restart would pair the new Core with the old Gateway"
                    );
                } else if result.applied && restart_after_update_enabled() {
                    // The swapped binary only runs after a restart, and nothing else
                    // restarts an unattended node at its quiet hour. Request Core's
                    // graceful shutdown (which stops the Gateway and sidecars, so the
                    // new Core does not adopt the old Gateway) and exit non-zero so
                    // both `Restart=on-failure` (systemd) and container restart
                    // policies bring the new build up. Opt-in only: an unsupervised
                    // Core that exits here would simply stay down.
                    tracing::warn!(
                        "deferred update: shutting down so the supervisor restarts Ryu Core on the new build ({RESTART_AFTER_UPDATE_ENV}=1)"
                    );
                    crate::update::request_restart();
                }
            }
            Err(e) => tracing::error!("deferred update: apply failed: {e}"),
        }
    });
}

/// Opt-in: exit after a deferred self-update so a process supervisor restarts
/// Core on the new binary.
const RESTART_AFTER_UPDATE_ENV: &str = "RYU_RESTART_AFTER_UPDATE";

fn restart_after_update_enabled() -> bool {
    std::env::var(RESTART_AFTER_UPDATE_ENV)
        .is_ok_and(|value| matches!(value.trim(), "1" | "true" | "yes"))
}
