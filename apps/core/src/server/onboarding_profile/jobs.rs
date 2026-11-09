//! The process-global profile job table, its bounds, and the node onboarding
//! snapshot a build is pinned to.

use super::*;

pub(super) fn profile_onboarding_snapshot(
    state: &NodeOnboardingState,
) -> ProfileOnboardingSnapshot {
    let setup_kind = state.setup_kind.unwrap_or(NodeSetupKind::Personal);
    let team = setup_kind == NodeSetupKind::Team;
    ProfileOnboardingSnapshot {
        company_context: if team {
            state.personalization.company_context.clone()
        } else {
            String::new()
        },
        company_knowledge_enabled: team && state.personalization.company_knowledge_enabled,
        setup_kind,
    }
}

pub(super) fn profile_onboarding_snapshot_matches(
    state: &NodeOnboardingState,
    expected: &ProfileOnboardingSnapshot,
) -> bool {
    profile_onboarding_snapshot(state) == *expected
}

pub(super) fn jobs() -> &'static Arc<Mutex<HashMap<String, ProfileJob>>> {
    static JOBS: OnceLock<Arc<Mutex<HashMap<String, ProfileJob>>>> = OnceLock::new();
    JOBS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

pub(super) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub(super) fn profile_job_is_terminal(job: &ProfileJob) -> bool {
    matches!(
        job.state,
        JobState::Completed | JobState::Failed | JobState::Cancelled
    )
}

/// Whether a job still counts against the per-owner and node caps. A cancelled
/// or expired job reports a terminal state at once, but its driver may still be
/// stopping the model turn; the slot is released only when the driver returns.
pub(super) fn profile_job_holds_slot(job: &ProfileJob) -> bool {
    !profile_job_is_terminal(job) || job.driver_active
}

/// Bound the process-global job table and withdraw work that a disconnected
/// client left behind. Terminal rows remain briefly so the desktop can fetch a
/// final status, while old live rows are marked failed/cancelled instead of
/// being dropped while their detached task may still be running.
pub(super) fn prune_profile_jobs(guard: &mut HashMap<String, ProfileJob>, now: i64) {
    for job in guard.values_mut() {
        let age = now.saturating_sub(job.started_at_ms);
        if !profile_job_is_terminal(job) && age > PROFILE_JOB_MAX_AGE_MS {
            job.cancel_requested = true;
            job.cancel.cancel();
            job.state = JobState::Failed;
            job.error = Some("profile job expired; start onboarding again".to_owned());
        }
    }
    guard.retain(|_, job| {
        profile_job_holds_slot(job)
            || now.saturating_sub(job.started_at_ms) <= PROFILE_JOB_RETENTION_MS
    });
    if guard.len() <= MAX_PROFILE_JOBS {
        return;
    }
    let mut terminal_ids = guard
        .iter()
        .filter(|(_, job)| !profile_job_holds_slot(job))
        .map(|(id, job)| (id.clone(), job.started_at_ms))
        .collect::<Vec<_>>();
    terminal_ids.sort_by_key(|(_, started_at_ms)| *started_at_ms);
    for (id, _) in terminal_ids {
        if guard.len() <= MAX_PROFILE_JOBS {
            break;
        }
        guard.remove(&id);
    }
}

pub(super) async fn verify_profile_onboarding_snapshot(
    state: &ServerState,
    expected: &ProfileOnboardingSnapshot,
) -> anyhow::Result<()> {
    let current = crate::server::onboarding_state::read_state(&state.preferences)
        .await
        .context("node onboarding state became unavailable")?;
    if !profile_onboarding_snapshot_matches(&current, expected) {
        anyhow::bail!("node onboarding context changed; restart the profile build");
    }
    if expected.setup_kind == NodeSetupKind::Team && !expected.company_knowledge_enabled {
        anyhow::bail!("shared company knowledge is disabled for this node");
    }
    Ok(())
}

pub(super) fn view(id: &str, job: &ProfileJob) -> ProfileJobView {
    ProfileJobView {
        agent_suggestions: job.agent_suggestions.clone(),
        background: job.background,
        conversation_id: job.conversation_id.clone(),
        error: job.error.clone(),
        id: id.to_owned(),
        // Older desktops show "Continue setup" (and hide "Run in background")
        // only once this is true, and older nodes set it as soon as the user
        // chose the background. Keep that meaning on the wire.
        materialized: job.materialized || job.background,
        state: job.state.as_str(),
        started_at_ms: job.started_at_ms,
    }
}

pub(super) fn bounded_ids(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .take(MAX_ID_COUNT)
        .collect()
}

pub(super) fn job_belongs_to(
    job: &ProfileJob,
    caller: &crate::identity_verify::VerifiedCaller,
) -> bool {
    job.inputs.owner_user_id == caller.user_id
        && job.inputs.org_id == caller.org_id.as_deref().unwrap_or_default()
}

/// Withdraw a build that has not started writing durable state. Returns whether
/// the job was cancelled; a terminal or materialising job is left unchanged.
pub(super) fn request_cancel(job: &mut ProfileJob) -> bool {
    if job.materialized || profile_job_is_terminal(job) {
        return false;
    }
    job.cancel_requested = true;
    job.state = JobState::Cancelled;
    job.cancel.cancel();
    true
}
