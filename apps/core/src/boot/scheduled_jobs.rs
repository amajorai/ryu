/// Ensure the single Identity Vault health-check scheduled job exists (#524).
///
/// Unlike monitors (one backing job per monitor, created in the monitors CRUD
/// API), the health sweep validates *all* connections, so it is one fixed-id
/// job ensured at startup. Idempotent: re-running rewrites the same `id`,
/// re-baking the current [`crate::identity::health::interval_setting`] into the
/// schedule while preserving the existing execution history. The scheduler
/// re-reads jobs from disk every tick, so this needs no ordering relative to
/// the scheduler spawn.
pub(super) fn ensure_identity_health_job() -> Result<(), String> {
    use crate::scheduler::store::{self as job_store, JobTarget, Schedule, ScheduledJob};

    const JOB_ID: &str = "identity-health";

    let interval = crate::identity::health::interval_setting();
    let now = chrono::Utc::now().to_rfc3339();
    let existing = job_store::load_job(JOB_ID).ok();
    let job = ScheduledJob {
        id: JOB_ID.to_owned(),
        name: "identity vault health check".to_owned(),
        schedule: Schedule::Every {
            interval: interval.clone(),
        },
        target: JobTarget::IdentityHealth,
        enabled: true,
        require_approval: false,
        // Core-owned (reconciled by Core itself), not an App-created job.
        owner_app: None,
        owner_user_id: None,
        org_id: None,
        created_at: existing
            .as_ref()
            .map(|j| j.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
        last_run_at: existing.as_ref().and_then(|j| j.last_run_at.clone()),
        last_outcome: existing.as_ref().and_then(|j| j.last_outcome),
        history: existing.map(|j| j.history).unwrap_or_default(),
    };
    job_store::recreate_authoritative_job(&job).map_err(|e| e.to_string())
}

/// Ensure the single continual-learning cycle job exists (MetaClaw-style periodic
/// retrain). Ticks hourly (default; `RYU_LEARNING_INTERVAL` knob) so it reliably
/// catches the configured sleep window, but the job body no-ops unless the user
/// opted in, only fires inside the window, and a persisted min-gap keeps it to at
/// most one retrain per ~day (and prevents fire-on-every-restart). Mirrors
/// [`ensure_identity_health_job`].
pub(super) fn ensure_learning_cycle_job() -> Result<(), String> {
    use crate::scheduler::store::{self as job_store, JobTarget, Schedule, ScheduledJob};

    const JOB_ID: &str = "learning-cycle";

    let interval = std::env::var("RYU_LEARNING_INTERVAL").unwrap_or_else(|_| "1h".to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let existing = job_store::load_job(JOB_ID).ok();
    let job = ScheduledJob {
        id: JOB_ID.to_owned(),
        name: "continual-learning cycle".to_owned(),
        schedule: Schedule::Every { interval },
        target: JobTarget::LearningCycle,
        enabled: true,
        require_approval: false,
        // Core-owned (reconciled by Core itself), not an App-created job.
        owner_app: None,
        owner_user_id: None,
        org_id: None,
        created_at: existing
            .as_ref()
            .map(|j| j.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
        last_run_at: existing.as_ref().and_then(|j| j.last_run_at.clone()),
        last_outcome: existing.as_ref().and_then(|j| j.last_outcome),
        history: existing.map(|j| j.history).unwrap_or_default(),
    };
    job_store::recreate_authoritative_job(&job).map_err(|e| e.to_string())
}
