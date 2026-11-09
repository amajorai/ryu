//! The `/api/onboarding` profile routes and their handlers.

use super::*;

#[utoipa::path(
    get,
    path = "/api/onboarding/access",
    tag = "Preferences",
    summary = "Get node onboarding access",
    responses((status = 200, description = "Node onboarding access", body = serde_json::Value))
)]
pub(crate) async fn access(
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> impl IntoResponse {
    Json(gateway_onboarding_access(&caller))
}

#[utoipa::path(
    get,
    path = "/api/onboarding/profile/availability",
    tag = "Preferences",
    summary = "Get onboarding profile availability",
    responses((status = 200, description = "Onboarding profile availability", body = ProfileAvailability))
)]
pub(crate) async fn profile_availability(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> impl IntoResponse {
    let access = gateway_onboarding_access(&caller);
    let completed = access.allowed && profile_was_built(&state, &caller).await;
    let onboarding = match crate::server::onboarding_state::read_state(&state.preferences).await {
        Ok(onboarding) => onboarding,
        Err(error) => {
            tracing::warn!(%error, "profile availability could not read node onboarding state");
            return Json(ProfileAvailability {
                allowed: false,
                completed: false,
                reason: "onboarding_state_unavailable",
            });
        }
    };
    let onboarding_snapshot = profile_onboarding_snapshot(&onboarding);
    let company_knowledge_enabled = onboarding_snapshot.setup_kind != NodeSetupKind::Team
        || onboarding_snapshot.company_knowledge_enabled;
    let eligible = access.allowed
        && company_knowledge_enabled
        && caller.as_ref().is_some_and(|current| {
            current.org_id.is_some()
                && current
                    .role
                    .satisfies(crate::identity_verify::OrgRole::Admin)
                && crate::entitlement::managed_inference_entitled()
                && crate::entitlement::is_active()
        });
    let reason = if !access.allowed {
        access.reason
    } else if !company_knowledge_enabled {
        "company_knowledge_disabled"
    } else if !eligible {
        "profile_not_eligible"
    } else {
        "ready"
    };
    Json(ProfileAvailability {
        allowed: eligible,
        completed,
        reason,
    })
}

pub fn routes() -> Router<ServerState> {
    Router::new()
        .route("/api/onboarding/access", get(access))
        .route(
            "/api/onboarding/profile/availability",
            get(profile_availability),
        )
        .route("/api/onboarding/profile/start", post(start))
        .route("/api/onboarding/profile/status/:id", get(status))
        .route("/api/onboarding/profile/cancel/:id", post(cancel))
        .route("/api/onboarding/profile/background/:id", post(background))
}

#[utoipa::path(
    post,
    path = "/api/onboarding/profile/start",
    tag = "Preferences",
    summary = "Start onboarding profile build",
    request_body = StartBody,
    responses((status = 202, description = "Profile build started", body = ProfileJobView))
)]
pub(crate) async fn start(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(mut body): Json<StartBody>,
) -> axum::response::Response {
    let (owner_user_id, org_id, onboarding) =
        match eligible(&state, &caller, body.share_user_org).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    body.recent_days = body.recent_days.clamp(1, 90);
    body.source_ids = bounded_ids(body.source_ids);
    body.imported_conversation_ids = bounded_ids(body.imported_conversation_ids);
    let Some(caller) = caller.as_ref() else {
        return error(
            StatusCode::FORBIDDEN,
            "profile bootstrap requires a signed-in organization member",
        );
    };
    body.imported_conversation_ids =
        match profile_imported_conversations(&state, caller, &body.imported_conversation_ids).await
        {
            Ok(ids) => ids,
            Err(response) => return response,
        };
    let composio_connection_scope =
        match profile_connection_scope(&state, &owner_user_id, &body.source_ids).await {
            Ok(scope) => scope,
            Err(response) => return response,
        };

    let mut guard = jobs().lock().await;
    prune_profile_jobs(&mut guard, now_ms());
    let owner_job_count = guard
        .values()
        .filter(|job| {
            profile_job_holds_slot(job)
                && job.inputs.owner_user_id == owner_user_id
                && job.inputs.org_id == org_id
        })
        .count();
    if owner_job_count >= MAX_PROFILE_JOBS_PER_OWNER {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            "too many profile jobs are already running for this organization member",
        );
    }
    if guard.len() >= MAX_PROFILE_JOBS {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            "too many profile jobs are running on this node",
        );
    }

    let id = uuid::Uuid::new_v4().to_string();
    let job = ProfileJob {
        inputs: ProfileJobInputs {
            onboarding,
            composio_connection_scope,
            owner_user_id,
            org_id,
            input: body,
        },
        // The build starts immediately; there is no queue to wait in.
        state: JobState::Building,
        started_at_ms: now_ms(),
        materialized: false,
        background: false,
        cancel_requested: false,
        cancel: CancellationToken::new(),
        // `run_job` is spawned below and clears this when it returns.
        driver_active: true,
        conversation_id: None,
        error: None,
        agent_suggestions: Vec::new(),
    };
    guard.insert(id.clone(), job);
    drop(guard);

    let job_id = id.clone();
    tokio::spawn(async move {
        run_job(job_id, state).await;
    });

    let snapshot = jobs().lock().await.get(&id).map(|job| view(&id, job));
    match snapshot {
        Some(snapshot) => (StatusCode::ACCEPTED, Json(snapshot)).into_response(),
        None => error(StatusCode::INTERNAL_SERVER_ERROR, "profile job disappeared"),
    }
}

#[utoipa::path(
    get,
    path = "/api/onboarding/profile/status/{id}",
    tag = "Preferences",
    summary = "Get onboarding profile build status",
    params(("id" = String, Path)),
    responses((status = 200, description = "Profile build status", body = ProfileJobView))
)]
pub(crate) async fn status(
    Path(id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    let Some(caller) = caller else {
        return error(StatusCode::FORBIDDEN, "authentication required");
    };
    let mut guard = jobs().lock().await;
    prune_profile_jobs(&mut guard, now_ms());
    let Some(job) = guard.get(&id) else {
        return error(StatusCode::NOT_FOUND, "profile job not found");
    };
    if !job_belongs_to(job, &caller) {
        return error(StatusCode::NOT_FOUND, "profile job not found");
    }
    Json(view(&id, job)).into_response()
}

#[utoipa::path(
    post,
    path = "/api/onboarding/profile/cancel/{id}",
    tag = "Preferences",
    summary = "Cancel onboarding profile build",
    params(("id" = String, Path)),
    responses((status = 200, description = "Profile build status", body = ProfileJobView))
)]
pub(crate) async fn cancel(
    Path(id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    let Some(caller) = caller else {
        return error(StatusCode::FORBIDDEN, "authentication required");
    };
    let mut guard = jobs().lock().await;
    prune_profile_jobs(&mut guard, now_ms());
    let Some(job) = guard.get_mut(&id) else {
        return error(StatusCode::NOT_FOUND, "profile job not found");
    };
    if !job_belongs_to(job, &caller) {
        return error(StatusCode::NOT_FOUND, "profile job not found");
    }
    request_cancel(job);
    Json(view(&id, job)).into_response()
}

#[utoipa::path(
    post,
    path = "/api/onboarding/profile/background/{id}",
    tag = "Preferences",
    summary = "Continue onboarding profile build in background",
    params(("id" = String, Path)),
    responses((status = 200, description = "Profile build status", body = ProfileJobView))
)]
pub(crate) async fn background(
    Path(id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    let Some(caller) = caller else {
        return error(StatusCode::FORBIDDEN, "authentication required");
    };
    let mut guard = jobs().lock().await;
    prune_profile_jobs(&mut guard, now_ms());
    let Some(job) = guard.get_mut(&id) else {
        return error(StatusCode::NOT_FOUND, "profile job not found");
    };
    if !job_belongs_to(job, &caller) {
        return error(StatusCode::NOT_FOUND, "profile job not found");
    }
    // Purely a UI choice: the build is already running and keeps running
    // whether or not the user stays on the progress view.
    job.background = true;
    Json(view(&id, job)).into_response()
}
