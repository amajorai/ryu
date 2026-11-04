//! Scheduled-job handlers and agent schedules: `create_job` through `validate_agent_schedules`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[utoipa::path(
    post,
    path = "/heartbeat/jobs",
    tag = "Core",
    summary = "Create a scheduled job",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn create_job(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<CreateJobBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "success": false, "error": "insufficient permissions: agent.edit" })),
        );
    }

    let conversation_supplied = body.target.get("conversation_id").is_some();
    let target = match serde_json::from_value::<crate::scheduler::store::JobTarget>(body.target) {
        Ok(target) => target,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"success":false,"error":error.to_string()})),
            )
        }
    };
    if body.quick_routine && !matches!(&target, crate::scheduler::store::JobTarget::Agent { .. }) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"success":false,"error":"quick routine requires an agent target"})),
        );
    }
    if let Err(error) = validate_scheduled_job_input(
        &state,
        &caller,
        &body.name,
        &body.schedule,
        &target,
        body.enabled,
        None,
    )
    .await
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": error })),
        );
    }

    let now = chrono::Utc::now().to_rfc3339();
    let job = crate::scheduler::store::ScheduledJob {
        id: format!("job_{}", uuid::Uuid::new_v4().simple()),
        name: body.name.trim().to_owned(),
        schedule: body.schedule,
        target,
        enabled: body.enabled,
        require_approval: body.require_approval,
        owner_app: body.owner_app.filter(|s| !s.trim().is_empty()),
        owner_user_id: node_org_id()
            .and_then(|_| caller.as_ref().map(|caller| caller.user_id.clone())),
        org_id: node_org_id(),
        created_at: now.clone(),
        updated_at: now,
        last_run_at: None,
        last_outcome: None,
        history: Vec::new(),
    };

    let saved = if body.quick_routine {
        match crate::scheduler::store::quick_routine_snapshot(&job).await {
            Err(error) => Err(error),
            Ok(snapshot) => {
                if !conversation_supplied {
                    if let Some(destination) = &snapshot.destination {
                        let mut retained_target = job.target.clone();
                        if let crate::scheduler::store::JobTarget::Agent {
                            conversation_id, ..
                        } = &mut retained_target
                        {
                            *conversation_id = Some(destination.clone());
                        }
                        if let Err(error) = validate_scheduled_target(
                            &state,
                            &caller,
                            &retained_target,
                            job.enabled,
                            None,
                        )
                        .await
                        {
                            return (
                                StatusCode::BAD_REQUEST,
                                Json(json!({"success":false,"error":error})),
                            );
                        }
                    }
                }
                crate::scheduler::store::upsert_quick_routine(job, conversation_supplied, snapshot)
                    .await
            }
        }
    } else {
        crate::scheduler::store::save_job(&job).map(|()| job)
    };
    match saved {
        Ok(job) => (StatusCode::OK, Json(json!({ "success": true, "job": job }))),
        Err(e) => (
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            },
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    get,
    path = "/heartbeat/jobs/{id}",
    tag = "Core",
    summary = "Get one scheduled job",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_job(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "success": false, "error": "insufficient permissions: agent.view" })),
        );
    }
    match crate::scheduler::store::load_job(&id) {
        Ok(job) if scheduled_job_visible(&job, &caller) => {
            (StatusCode::OK, Json(json!({ "job": job })))
        }
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "job not found" })),
        ),
        Ok(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "job not found" })),
        ),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct UpdateJobBody {
    #[serde(default)]
    pub(in crate::server) name: Option<String>,
    #[serde(default)]
    pub(in crate::server) schedule: Option<crate::scheduler::store::Schedule>,
    #[serde(default)]
    pub(in crate::server) target: Option<crate::scheduler::store::JobTarget>,
    #[serde(default)]
    pub(in crate::server) enabled: Option<bool>,
    #[serde(default)]
    pub(in crate::server) require_approval: Option<bool>,
}

#[utoipa::path(
    put,
    path = "/heartbeat/jobs/{id}",
    tag = "Core",
    summary = "Update a scheduled job",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn update_job(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<UpdateJobBody>,
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
    let Ok(mut job) = crate::scheduler::store::load_job(&id) else {
        return json_error(StatusCode::NOT_FOUND, "job not found".to_owned());
    };
    if !scheduled_job_visible(&job, &caller) {
        return json_error(StatusCode::NOT_FOUND, "job not found".to_owned());
    }
    let expected = job.clone();
    let name = body.name.unwrap_or_else(|| job.name.clone());
    let schedule = body.schedule.unwrap_or_else(|| job.schedule.clone());
    let target = body.target.unwrap_or_else(|| job.target.clone());
    let enabled = body.enabled.unwrap_or(job.enabled);
    if let Err(error) = validate_scheduled_job_input(
        &state,
        &caller,
        &name,
        &schedule,
        &target,
        enabled,
        Some(&job.target),
    )
    .await
    {
        return json_error(StatusCode::BAD_REQUEST, error);
    }
    // A reconciled job never raises approval rows: its app owns when it runs.
    if body.require_approval == Some(true) && is_reconciled_target(&target) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "app-owned jobs cannot require approval".to_owned(),
        );
    }
    // Its name, schedule and enabled state follow the app on every reconcile pass,
    // so a change here would be silently undone: refuse it and point at the app.
    if is_reconciled_target(&job.target)
        && (name.trim() != job.name || schedule != job.schedule || enabled != job.enabled)
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "an app-owned job's name, schedule and enabled state follow the app that owns it; change them in that app (for example, pause the monitor)"
                .to_owned(),
        );
    }
    job.name = name.trim().to_owned();
    job.schedule = schedule;
    job.target = target;
    job.enabled = enabled;
    if let Some(require_approval) = body.require_approval {
        job.require_approval = require_approval;
    }
    job.updated_at = chrono::Utc::now().to_rfc3339();
    match crate::scheduler::store::update_job_if_current(expected, job).await {
        Ok(job) => Json(json!({ "success": true, "job": job })).into_response(),
        Err(error) => json_error(
            match error.kind() {
                std::io::ErrorKind::AlreadyExists => StatusCode::CONFLICT,
                std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            },
            error.to_string(),
        ),
    }
}

#[utoipa::path(
    delete,
    path = "/heartbeat/jobs/{id}",
    tag = "Core",
    summary = "Delete a scheduled job",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn delete_job(
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
    let Ok(job) = crate::scheduler::store::load_job_for_delete(&id) else {
        return json_error(StatusCode::NOT_FOUND, "job not found".to_owned());
    };
    if !scheduled_job_visible(&job, &caller) {
        return json_error(StatusCode::NOT_FOUND, "job not found".to_owned());
    }
    if reconciled_job_still_managed(&state, &job.target).await {
        return json_error(
            StatusCode::CONFLICT,
            "this job is managed by its app; remove it in the app (or uninstall the app) instead"
                .to_owned(),
        );
    }
    match crate::scheduler::store::delete_job_async(id).await {
        Ok(true) => Json(json!({ "success": true })).into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "job not found".to_owned()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// Validate a portable agent schedule with the same rules as the public job
/// endpoint. Templates must never be able to write a job that the scheduler
/// would silently skip after import.
pub(in crate::server) fn validate_agent_schedule(
    schedule: &crate::scheduler::store::Schedule,
) -> Result<(), String> {
    crate::scheduler::validate_schedule(schedule)
}

pub(in crate::server) fn validate_agent_schedules(
    schedules: &[crate::agents::AgentScheduleTemplate],
) -> Result<(), String> {
    for (index, schedule) in schedules.iter().enumerate() {
        validate_agent_schedule(&schedule.schedule)
            .map_err(|error| format!("schedule {}: {error}", index + 1))?;
        if schedule.instructions.trim().is_empty() {
            return Err(format!(
                "schedule {}: custom instructions are required",
                index + 1
            ));
        }
    }
    Ok(())
}
