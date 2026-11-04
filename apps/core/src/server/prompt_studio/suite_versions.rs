//! Promptfoo-compatible Prompt Studio suites: `list_prompt_suite_versions` through `rename_prompt_run`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[utoipa::path(
    get,
    path = "/api/prompt-suites/{id}/versions",
    tag = "Prompt Evals",
    summary = "List evaluation suite versions",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_prompt_suite_versions(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
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
    match store.list_versions(&id).await {
        Ok(versions) => Json(json!({ "versions": versions })).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/prompt-suites/{id}/versions",
    tag = "Prompt Evals",
    summary = "Snapshot an evaluation suite version",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn create_prompt_suite_version(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
    body: Option<Json<PromptSuiteVersionBody>>,
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
    let label = body
        .map(|Json(value)| value)
        .unwrap_or_default()
        .label
        .and_then(|label| {
            let trimmed = label.trim().to_owned();
            (!trimmed.is_empty()).then_some(trimmed)
        });
    match store.snapshot_suite(&id, label.as_deref()).await {
        Ok(Some(version)) => Json(json!({ "version": version })).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "prompt suite not found".to_owned()),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[utoipa::path(
    get,
    path = "/api/prompt-suites/{id}/versions/{version_id}",
    tag = "Prompt Evals",
    summary = "Get an evaluation suite version",
    params(("id" = String, Path), ("version_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_prompt_suite_version(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((id, version_id)): Path<(String, String)>,
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
    match store.get_version(&id, &version_id).await {
        Ok(Some(version)) => Json(json!({ "version": version })).into_response(),
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            "prompt suite version not found".to_owned(),
        ),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/prompt-suites/{id}/versions/{version_id}/restore",
    tag = "Prompt Evals",
    summary = "Restore an evaluation suite version",
    params(("id" = String, Path), ("version_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn restore_prompt_suite_version(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((id, version_id)): Path<(String, String)>,
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
    match store.restore_version(&id, &version_id).await {
        Ok(Some(suite)) => Json(json!({ "success": true, "suite": suite })).into_response(),
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            "prompt suite version not found".to_owned(),
        ),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/prompt-suites/{id}/traces",
    tag = "Prompt Evals",
    summary = "Add a completed conversation trace to an evaluation suite",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn import_prompt_trace(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
    Json(body): Json<ImportPromptTraceBody>,
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
    let run_id = body.run_id.trim();
    if run_id.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "run_id is required".to_owned());
    }
    if let Err(response) =
        require_conversation_access_if_known(&state, &caller, run_id, false).await
    {
        return response;
    }
    let detail = match state.conversations.get_conversation_detail(run_id).await {
        Ok(Some(detail)) => detail,
        Ok(None) => {
            return json_error(StatusCode::NOT_FOUND, "conversation not found".to_owned());
        }
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    if detail.agent_id.as_deref() != Some(suite.agent_id.as_str()) {
        return json_error(
            StatusCode::CONFLICT,
            "trace belongs to a different agent".to_owned(),
        );
    }
    let case = match prompt_case_from_trace(&detail) {
        Ok(case) => case,
        Err(reason) => return json_error(StatusCode::BAD_REQUEST, reason),
    };
    let (updated, added) = match store.append_case_if_absent(&id, &case).await {
        Ok(Some(result)) => result,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "prompt suite not found".to_owned()),
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error.to_string()),
    };
    if !added {
        return Json(json!({
            "added": false,
            "case": case,
            "source_run_id": run_id,
            "suite": updated,
            "version": Value::Null,
        }))
        .into_response();
    }
    let version = match store.snapshot_suite(&id, Some("Trace import")).await {
        Ok(version) => version,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    Json(json!({
        "added": true,
        "case": case,
        "source_run_id": run_id,
        "suite": updated,
        "version": version,
    }))
    .into_response()
}

#[utoipa::path(
    get,
    path = "/api/prompt-suites/{id}/runs",
    tag = "Prompt Evals",
    summary = "List evaluation runs",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_prompt_runs(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
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
    match store.list_runs(&id).await {
        Ok(runs) => Json(json!({ "runs": runs })).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/prompt-suites/{id}/runs",
    tag = "Prompt Evals",
    summary = "Save an evaluation run",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 201, description = "Created", body = serde_json::Value))
)]
pub(in crate::server) async fn save_prompt_run(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
    Json(body): Json<PromptRunBody>,
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
    match store
        .save_run(&id, &body.name, &body.request, &body.result)
        .await
    {
        Ok(Some(run)) => (StatusCode::CREATED, Json(json!({ "run": run }))).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "prompt suite not found".to_owned()),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[utoipa::path(
    get,
    path = "/api/prompt-suites/{id}/runs/{run_id}",
    tag = "Prompt Evals",
    summary = "Get an evaluation run",
    params(("id" = String, Path), ("run_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_prompt_run(
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
        Ok(Some(run)) => Json(json!({ "run": run })).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "prompt run not found".to_owned()),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[utoipa::path(
    put,
    path = "/api/prompt-suites/{id}/runs/{run_id}",
    tag = "Prompt Evals",
    summary = "Rename an evaluation run",
    params(("id" = String, Path), ("run_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn rename_prompt_run(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((id, run_id)): Path<(String, String)>,
    Json(body): Json<PromptRunNameBody>,
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
    match store.rename_run(&id, &run_id, &body.name).await {
        Ok(Some(run)) => Json(json!({ "run": run })).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, "prompt run not found".to_owned()),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error.to_string()),
    }
}
