//! Scheduled-job handlers (heartbeat).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Scheduled-job handlers (heartbeat) ──────────────────────────────────────

pub(in crate::server) fn scheduled_job_visible_at(
    job: &crate::scheduler::store::ScheduledJob,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    node_org: Option<&str>,
) -> bool {
    let Some(node_org) = node_org else {
        return true;
    };
    caller.as_ref().is_some_and(|caller| {
        job.owner_user_id.as_deref() == Some(caller.user_id.as_str())
            && job.org_id.as_deref() == Some(node_org)
    })
}

pub(in crate::server) fn scheduled_job_visible(
    job: &crate::scheduler::store::ScheduledJob,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> bool {
    let node_org = node_org_id();
    scheduled_job_visible_at(job, caller, node_org.as_deref())
}

/// Whether `target` is owned by Core's app-job reconcile (an app job, or a legacy
/// quest job): never created or retargeted through `/heartbeat/jobs`.
pub(in crate::server) fn is_reconciled_target(target: &crate::scheduler::store::JobTarget) -> bool {
    matches!(
        target,
        crate::scheduler::store::JobTarget::AppJob { .. }
            | crate::scheduler::store::JobTarget::Quest { .. }
    )
}

/// Whether a reconciled job (see [`is_reconciled_target`]) still has an app that
/// will re-list it. Deleting such a job only tombstones it until the next
/// reconcile recreates it under a fresh id with no history, so `DELETE
/// /heartbeat/jobs/:id` refuses it. An app job stays managed while its app is
/// installed (enabled or not: a disabled app keeps its jobs); a legacy quest job
/// while any enabled app provides the quest list. Once the app is gone the job is
/// an orphan and may be deleted, so a partly failed uninstall can be cleaned up.
/// A store error counts as managed: a wrong refusal is recoverable, lost history
/// is not.
pub(in crate::server) async fn reconciled_job_still_managed(
    state: &ServerState,
    target: &crate::scheduler::store::JobTarget,
) -> bool {
    match target {
        crate::scheduler::store::JobTarget::AppJob { plugin_id, .. } => {
            !matches!(state.app_store.get(plugin_id).await, Ok(None))
        }
        crate::scheduler::store::JobTarget::Quest { .. } => {
            crate::sidecar::capability_consumer::CapabilityConsumer::from_state(state)
                .providers_of(crate::scheduler::legacy_quest_jobs::CAP_QUESTS_LIST)
                .await
                .map_or(true, |providers| !providers.is_empty())
        }
        _ => false,
    }
}

/// `current` is the job's persisted target on an update (`None` on a create): a
/// reconciled target may be kept, never introduced.
pub(in crate::server) async fn validate_scheduled_target(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    target: &crate::scheduler::store::JobTarget,
    enabled: bool,
    current: Option<&crate::scheduler::store::JobTarget>,
) -> Result<(), String> {
    // Refused both ways: onto a reconciled target, and away from one (which would
    // orphan the job and make the next reconcile mint a duplicate with no history).
    if (is_reconciled_target(target) || current.is_some_and(is_reconciled_target))
        && current != Some(target)
    {
        return Err(
            "app-owned job targets are reconciled by Core from the owning app; they cannot be created or retargeted"
                .to_owned(),
        );
    }
    if let crate::scheduler::store::JobTarget::Agent {
        agent_id,
        conversation_id,
        ..
    } = target
    {
        match state.agent_store.get(agent_id).await {
            Ok(Some(agent))
                if !enabled
                    || agent.lifecycle_status == crate::agents::AgentLifecycleStatus::Active => {}
            Ok(Some(agent)) => {
                return Err(format!(
                    "agent '{}' is in {} mode and cannot have an enabled automation",
                    agent.name,
                    agent.lifecycle_status.as_str()
                ));
            }
            Ok(None) => return Err(format!("agent '{agent_id}' not found")),
            Err(error) => return Err(error.to_string()),
        }

        if let Some(conversation_id) = conversation_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            let meta = state
                .conversations
                .get_access_meta(conversation_id)
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("conversation '{conversation_id}' not found"))?;
            if let Some(node_org) = node_org_id() {
                let owned_by_caller = caller.as_ref().is_some_and(|caller| {
                    meta.owner_user_id.as_deref() == Some(caller.user_id.as_str())
                        && meta.org_id.as_deref() == Some(node_org.as_str())
                });
                if !owned_by_caller {
                    return Err(format!(
                        "conversation '{conversation_id}' is not owned by this user"
                    ));
                }
            }
        }
    }
    if let crate::scheduler::store::JobTarget::ProviderAccount {
        provider_id,
        account_id,
        model,
        ..
    } = target
    {
        // A ping spends that saved login's quota: only the node owner (or an
        // org owner/admin) may schedule one, not every `agent.edit` holder.
        if !account_warmup::caller_may_ping_accounts(caller) {
            return Err(
                "only the node owner can schedule a ping on a saved subscription account"
                    .to_owned(),
            );
        }
        account_warmup::validate(provider_id, account_id, model.as_deref())?;
    }
    workflow_access::authorize_scheduled_workflow_target(state, caller, target, enabled, current)
        .await
}

pub(in crate::server) async fn validate_scheduled_job_input(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    name: &str,
    schedule: &crate::scheduler::store::Schedule,
    target: &crate::scheduler::store::JobTarget,
    enabled: bool,
    current: Option<&crate::scheduler::store::JobTarget>,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("routine name is required".to_owned());
    }
    crate::scheduler::validate_schedule(schedule)?;
    validate_scheduled_target(state, caller, target, enabled, current).await
}

/// `?include=` on the job and approval lists. Released clients parse job targets
/// with a strict union, so rows whose target is an app job are left out unless
/// the caller opts in with `include=app_jobs`, and rows pinned to one saved
/// subscription account unless it opts in with `include=provider_accounts`.
#[derive(Debug, Default, serde::Deserialize)]
pub(crate) struct IncludeQuery {
    #[serde(default)]
    pub(in crate::server) include: Option<String>,
}

impl IncludeQuery {
    /// An in-process query that opts in to the given comma-separated kinds.
    pub(crate) fn including(include: &str) -> Self {
        Self {
            include: Some(include.to_owned()),
        }
    }

    pub(in crate::server) fn includes(&self, kind: &str) -> bool {
        self.include
            .as_deref()
            .is_some_and(|include| include.split(',').any(|item| item.trim() == kind))
    }

    pub(crate) fn app_jobs(&self) -> bool {
        self.includes("app_jobs")
    }

    pub(crate) fn provider_accounts(&self) -> bool {
        self.includes("provider_accounts")
    }
}

#[utoipa::path(
    get,
    path = "/heartbeat/jobs",
    tag = "Core",
    summary = "List the scheduled jobs",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_jobs(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Query(query): Query<IncludeQuery>,
) -> axum::response::Response {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: agent.view".to_owned(),
        );
    }
    let include_app_jobs = query.app_jobs();
    let include_provider_accounts = query.provider_accounts();
    let jobs = crate::scheduler::store::list_jobs()
        .into_iter()
        .filter(|job| scheduled_job_visible(job, &caller))
        .filter(|job| match job.target {
            crate::scheduler::store::JobTarget::AppJob { .. } => include_app_jobs,
            crate::scheduler::store::JobTarget::ProviderAccount { .. } => include_provider_accounts,
            _ => true,
        })
        .collect::<Vec<_>>();
    Json(json!({ "jobs": jobs })).into_response()
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct CreateJobBody {
    pub(in crate::server) name: String,
    pub(in crate::server) schedule: crate::scheduler::store::Schedule,
    pub(in crate::server) target: serde_json::Value,
    /// Upsert the canonical quick routine slot for this authorized agent.
    #[serde(default)]
    pub(in crate::server) quick_routine: bool,
    #[serde(default = "default_enabled")]
    pub(in crate::server) enabled: bool,
    /// When true, each due firing waits for a human-in-the-loop approval before
    /// running (raises an inbox request). Off by default.
    #[serde(default)]
    pub(in crate::server) require_approval: bool,
    /// Manifest id of the App creating this job, when one is. Recorded so the
    /// tick loop can stop the job while its App is disabled — see
    /// [`crate::scheduler::store::ScheduledJob::owner_app`].
    #[serde(default)]
    pub(in crate::server) owner_app: Option<String>,
}

pub(in crate::server) fn default_enabled() -> bool {
    true
}
