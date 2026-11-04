//! Promptfoo-compatible Prompt Studio suites: `delete_prompt_run` through `delete_agent`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[utoipa::path(
    delete,
    path = "/api/prompt-suites/{id}/runs/{run_id}",
    tag = "Prompt Evals",
    summary = "Delete an evaluation run",
    params(("id" = String, Path), ("run_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn delete_prompt_run(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((id, run_id)): Path<(String, String)>,
) -> axum::response::Response {
    let (store, _suite) = match prompt_suite_for_access(
        &state,
        &caller,
        &id,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    match store.delete_run(&id, &run_id).await {
        Ok(true) => Json(json!({ "success": true, "run_id": run_id })).into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "prompt run not found".to_owned()),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/prompt-suites/{id}/runs/{run_id}/duplicate",
    tag = "Prompt Evals",
    summary = "Duplicate an evaluation run",
    params(("id" = String, Path), ("run_id" = String, Path)),
    request_body = Option<serde_json::Value>,
    responses((status = 201, description = "Created", body = serde_json::Value))
)]
pub(in crate::server) async fn duplicate_prompt_run(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((id, run_id)): Path<(String, String)>,
    body: Option<Json<PromptRunNameBody>>,
) -> axum::response::Response {
    let (store, suite) = match prompt_suite_for_access(
        &state,
        &caller,
        &id,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    let default_name = format!("{} · copy", suite.name);
    let name = body
        .as_ref()
        .map(|Json(value)| value.name.as_str())
        .unwrap_or(default_name.as_str());
    match store.duplicate_run(&id, &run_id, Some(name)).await {
        Ok(Some(run)) => (StatusCode::CREATED, Json(json!({ "run": run }))).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "prompt run not found".to_owned()),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error.to_string()),
    }
}

#[utoipa::path(
    get,
    path = "/api/prompt-suites/{id}/runs/{run_id}/reviews",
    tag = "Prompt Evals",
    summary = "List human reviews for an evaluation run",
    params(("id" = String, Path), ("run_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_prompt_reviews(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((id, run_id)): Path<(String, String)>,
) -> axum::response::Response {
    let (store, _suite) = match prompt_suite_for_access(
        &state,
        &caller,
        &id,
        crate::identity_verify::permissions::AGENT_VIEW,
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    match store.get_run(&id, &run_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "prompt run not found".to_owned()),
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
    match store.list_reviews(&run_id).await {
        Ok(reviews) => Json(json!({ "reviews": reviews })).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/prompt-suites/{id}/runs/{run_id}/reviews",
    tag = "Prompt Evals",
    summary = "Save a human review for an evaluation result",
    params(("id" = String, Path), ("run_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn save_prompt_review(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((id, run_id)): Path<(String, String)>,
    Json(body): Json<PromptReviewBody>,
) -> axum::response::Response {
    let (store, _suite) = match prompt_suite_for_access(
        &state,
        &caller,
        &id,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    {
        Ok(value) => value,
        Err(response) => return response,
    };
    match store.get_run(&id, &run_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "prompt run not found".to_owned()),
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
    if body.result_key.trim().is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "result_key is required".to_owned());
    }
    let review = crate::prompt_evals::PromptReview {
        comment: body.comment,
        highlighted: body.highlighted,
        pass: body.pass,
        result_key: body.result_key,
        run_id,
        score: body.score.map(|score| score.clamp(0.0, 1.0)),
        updated_at: 0,
    };
    match store.save_review(&review).await {
        Ok(review) => Json(json!({ "review": review })).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[utoipa::path(
    delete,
    path = "/api/agents/{id}",
    tag = "Agents",
    summary = "Delete an agent",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn delete_agent(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_DELETE,
        crate::acl::KIND_AGENT,
        &id,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: agent.delete" })),
        );
    }
    match state.agent_store.delete(&id).await {
        Ok(true) => {
            // The agent is gone even if a later step fails, so its routing pool and
            // override are dropped first; a later agent reusing the id must not inherit them.
            agent_routing_cleanup::clear_deleted_agent_routing(&state.client, &id).await;
            // Its limited Pi config folder holds the agent's saved Pi sessions.
            if let Err(error) = crate::pi_config::remove_limited_agent_dir(&id) {
                tracing::warn!(
                    "limited Pi config folder of deleted agent '{id}' was not removed: {error}"
                );
            }
            if let Some(queues) = crate::annotation_queues::AnnotationQueueStore::global() {
                if let Err(error) = queues.delete_queues_for_agent(&id).await {
                    tracing::warn!(
                        "annotation queues of deleted agent '{id}' were not removed: {error:#}"
                    );
                }
            }
            match delete_agent_schedules(&id) {
                Ok(()) => (StatusCode::OK, Json(json!({ "success": true }))),
                Err(error) => {
                    tracing::warn!(
                        "agent '{id}' was deleted but its schedules could not be removed: {error}"
                    );
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(
                            json!({ "success": false, "error": format!("agent deleted, but schedules could not be removed: {error}") }),
                        ),
                    )
                }
            }
        }
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("agent '{id}' not found") })),
        ),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}
