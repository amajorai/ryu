//! Scheduled-job handlers and agent schedules: `build_agent_schedule_jobs` through `run_job_now`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Builds the scheduled jobs for an agent's portable schedules.
///
/// `caller` is the user installing the agent. On an org-bound node their jobs
/// are stamped with the same owner/org `create_job` uses, so they can see and
/// manage them under `/heartbeat/jobs` and runs are attributed to them. `None`
/// is a node-level install (the patrol system agent, portable packages) and
/// keeps the unowned shape.
pub(crate) fn build_agent_schedule_jobs(
    agent_id: &str,
    agent_name: &str,
    schedules: &[crate::agents::AgentScheduleTemplate],
    caller: Option<&crate::identity_verify::VerifiedCaller>,
) -> Result<Vec<crate::scheduler::store::ScheduledJob>, String> {
    validate_agent_schedules(schedules)?;
    let now = chrono::Utc::now().to_rfc3339();
    let node_org = caller.and_then(|_| node_org_id());
    let owner_user_id = node_org
        .as_ref()
        .and_then(|_| caller.map(|caller| caller.user_id.clone()));
    schedules
        .iter()
        .enumerate()
        .map(|(index, schedule)| {
            let name = if schedule.name.trim().is_empty() {
                format!("{agent_name} schedule {}", index + 1)
            } else {
                schedule.name.trim().to_owned()
            };
            Ok(crate::scheduler::store::ScheduledJob {
                id: format!("job_{}", uuid::Uuid::new_v4().simple()),
                name,
                schedule: schedule.schedule.clone(),
                target: crate::scheduler::store::JobTarget::Agent {
                    agent_id: agent_id.to_owned(),
                    prompt: schedule.instructions.trim().to_owned(),
                    model: None,
                    conversation_id: schedule.conversation_id.clone(),
                },
                enabled: schedule.enabled,
                require_approval: schedule.require_approval,
                owner_app: None,
                owner_user_id: owner_user_id.clone(),
                org_id: node_org.clone(),
                created_at: now.clone(),
                updated_at: now.clone(),
                last_run_at: None,
                last_outcome: None,
                history: Vec::new(),
            })
        })
        .collect()
}

/// A template schedule may name the conversation it appends to. On an
/// org-bound node, keep that binding only when the importing caller owns the
/// conversation (the rule `validate_scheduled_target` applies to `create_job`);
/// otherwise the schedule runs in its own fresh conversation instead of reading
/// and appending to another member's thread.
pub(in crate::server) async fn retain_caller_owned_schedule_conversations(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    schedules: &mut [crate::agents::AgentScheduleTemplate],
) {
    let Some(node_org) = node_org_id() else {
        return;
    };
    for schedule in schedules {
        let Some(conversation_id) = schedule
            .conversation_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            schedule.conversation_id = None;
            continue;
        };
        let owned_by_caller = match (
            caller.as_ref(),
            state.conversations.get_access_meta(conversation_id).await,
        ) {
            (Some(caller), Ok(Some(meta))) => {
                meta.owner_user_id.as_deref() == Some(caller.user_id.as_str())
                    && meta.org_id.as_deref() == Some(node_org.as_str())
            }
            _ => false,
        };
        if !owned_by_caller {
            schedule.conversation_id = None;
        }
    }
}

/// Materialize portable schedules only after the agent exists. If one file
/// cannot be written, remove the files written by this operation so a partial
/// import cannot leave a misleading half-configured agent behind.
pub(crate) fn persist_agent_schedules(
    agent_id: &str,
    agent_name: &str,
    schedules: &[crate::agents::AgentScheduleTemplate],
    caller: Option<&crate::identity_verify::VerifiedCaller>,
) -> Result<(), String> {
    let jobs = build_agent_schedule_jobs(agent_id, agent_name, schedules, caller)?;
    let mut saved_ids: Vec<String> = Vec::new();
    for job in jobs {
        if let Err(error) = crate::scheduler::store::save_job(&job) {
            for id in saved_ids {
                let _ = crate::scheduler::store::delete_job(&id);
            }
            return Err(error.to_string());
        }
        saved_ids.push(job.id);
    }
    Ok(())
}

pub(in crate::server) fn agent_schedule_templates(
    agent_id: &str,
) -> Vec<crate::agents::AgentScheduleTemplate> {
    crate::scheduler::store::list_jobs()
        .into_iter()
        .filter_map(|job| {
            let crate::scheduler::store::JobTarget::Agent {
                agent_id: target_agent_id,
                prompt,
                conversation_id,
                ..
            } = job.target
            else {
                return None;
            };
            if target_agent_id != agent_id {
                return None;
            }
            Some(crate::agents::AgentScheduleTemplate {
                name: job.name,
                schedule: job.schedule,
                instructions: prompt,
                enabled: job.enabled,
                require_approval: job.require_approval,
                conversation_id,
            })
        })
        .collect()
}

pub(in crate::server) fn delete_agent_schedules(agent_id: &str) -> std::io::Result<()> {
    for job in crate::scheduler::store::list_jobs() {
        let is_agent_job = matches!(
            &job.target,
            crate::scheduler::store::JobTarget::Agent { agent_id: target_id, .. }
                if target_id == agent_id
        );
        if is_agent_job {
            crate::scheduler::store::delete_job(&job.id)?;
        }
    }
    Ok(())
}

/// Keep automation definitions so promotion can restore the operator's intent,
/// but make every owned job inert as soon as an agent leaves `active`.
pub(in crate::server) fn disable_agent_schedules(agent_id: &str) -> std::io::Result<()> {
    for job in crate::scheduler::store::list_jobs() {
        let is_agent_job = matches!(
            &job.target,
            crate::scheduler::store::JobTarget::Agent { agent_id: target_id, .. }
                if target_id == agent_id
        );
        let is_workflow_job = matches!(
            &job.target,
            crate::scheduler::store::JobTarget::Workflow { workflow_id, .. }
                if crate::workflow::store::load_workflow(workflow_id)
                    .ok()
                    .map(|workflow| {
                        crate::workflow::referenced_agent_ids(&workflow)
                            .iter()
                            .any(|referenced| referenced == agent_id)
                    })
                    .unwrap_or(false)
        );
        if (is_agent_job || is_workflow_job) && job.enabled {
            crate::scheduler::store::disable_job_if_target(&job.id, &job.target)?;
        }
    }
    Ok(())
}

/// `POST /heartbeat/jobs/:id/run` — run a scheduled job now, off-schedule.
///
/// The "does this actually work" affordance every automation surface wants, and
/// the only honest one: it runs the *saved* job through the same
/// [`crate::scheduler::run_target_for_job`] the tick loop uses, so what it proves is what
/// will happen when the schedule fires — not an approximation assembled by the
/// caller. The outcome is recorded in the job's history exactly as a scheduled
/// run is, which is why a manual run shows up alongside the automatic ones.
///
/// Deliberately ignores `enabled` and `require_approval`: this IS the human
/// acting, so gating it on a schedule flag or on an approval the same human
/// would immediately grant would only be ceremony. It respects nothing about
/// *when* the job would have run, only *what* it runs. It does respect a run
/// already in flight: a double-click or a scheduled firing in progress gets 409
/// instead of a second concurrent run.
#[utoipa::path(
    post,
    path = "/heartbeat/jobs/{id}/run",
    tag = "Core",
    summary = "Run a scheduled job now",
    params(("id" = String, Path)),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 409, description = "Routine is already running")
    )
)]
pub(in crate::server) async fn run_job_now(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: agent.edit".to_owned(),
        );
    }
    let Ok(job) = crate::scheduler::store::load_job(&id) else {
        return json_error(StatusCode::NOT_FOUND, "job not found".to_owned());
    };
    if !scheduled_job_visible(&job, &caller) {
        return json_error(StatusCode::NOT_FOUND, "job not found".to_owned());
    };
    // Running a workflow routine runs that workflow: re-check workflow.run now,
    // since the caller's access may have changed after the routine was saved.
    if let Err(error) = workflow_access::authorize_scheduled_workflow_target(
        &state,
        &caller,
        &job.target,
        true,
        None,
    )
    .await
    {
        return json_error(StatusCode::FORBIDDEN, error);
    }
    // An app job runs under the scheduler's app-job budget here too, so a run-now
    // never overlaps a scheduled run of the same job or exceeds its app's cap.
    let _budget_slot = match crate::scheduler::admit_manual_run(&job.id, &job.target) {
        Ok(slot) => slot,
        Err(error) => return json_error(StatusCode::CONFLICT, error),
    };
    // Any routine (not only app-backed ones) never overlaps a scheduled firing or
    // another manual run. Held until the history write below, then released on
    // every path (before the budget slot, which is declared first).
    let Some(_in_flight) = crate::scheduler::claim_in_flight(&job.id) else {
        return json_error(
            StatusCode::CONFLICT,
            "routine is already running".to_owned(),
        );
    };

    let claim = match crate::scheduler::store::capture_execution(&job).await {
        Ok(claim) => claim,
        Err(error) => {
            let status = match error.kind() {
                std::io::ErrorKind::AlreadyExists => StatusCode::CONFLICT,
                std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            return json_error(status, format!("routine could not start: {error}"));
        }
    };
    let started_at = chrono::Utc::now().to_rfc3339();
    let result = crate::scheduler::run_target_for_job(&job).await;
    let finished_at = chrono::Utc::now().to_rfc3339();

    let (record, status, body) = match result {
        Ok(run_id) => {
            let record = crate::scheduler::store::ExecRecord {
                started_at,
                finished_at,
                outcome: crate::scheduler::store::ExecOutcome::Success,
                run_id: run_id.clone(),
                error: None,
            };
            (
                record,
                StatusCode::OK,
                Json(json!({ "success": true, "run_id": run_id })),
            )
        }
        Err(error) => {
            let record = crate::scheduler::store::ExecRecord {
                started_at,
                finished_at,
                outcome: crate::scheduler::store::ExecOutcome::Failure,
                run_id: None,
                error: Some(error.clone()),
            };
            // 200 with `success: false`, not a 5xx: the request was served
            // correctly and the *job* failed. The caller renders the message.
            (
                record,
                StatusCode::OK,
                Json(json!({ "success": false, "error": error })),
            )
        }
    };

    if let Err(e) = crate::scheduler::store::append_execution_claim(claim, record).await {
        tracing::error!("failed to persist job '{}' after a manual run: {e}", job.id);
    }
    (status, body).into_response()
}
