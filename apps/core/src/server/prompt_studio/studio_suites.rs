//! Promptfoo-compatible Prompt Studio suites.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Promptfoo-compatible Prompt Studio suites ──────────────────────────────

#[derive(Debug, Deserialize)]
pub(in crate::server) struct PromptSuiteListQuery {
    pub(in crate::server) agent_id: String,
}

#[derive(Debug, Deserialize)]
pub(in crate::server) struct CreatePromptSuiteBody {
    pub(in crate::server) agent_id: String,
    pub(in crate::server) name: String,
    #[serde(default)]
    pub(in crate::server) config: serde_json::Value,
    #[serde(default)]
    pub(in crate::server) label: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(in crate::server) struct UpdatePromptSuiteBody {
    #[serde(default)]
    pub(in crate::server) name: Option<String>,
    #[serde(default)]
    pub(in crate::server) config: Option<serde_json::Value>,
    #[serde(default)]
    pub(in crate::server) label: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub(in crate::server) struct PromptSuiteVersionBody {
    #[serde(default)]
    pub(in crate::server) label: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub(in crate::server) struct PromptRunBody {
    #[serde(default)]
    pub(in crate::server) name: String,
    #[serde(default)]
    pub(in crate::server) request: serde_json::Value,
    #[serde(default)]
    pub(in crate::server) result: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub(in crate::server) struct PromptRunNameBody {
    pub(in crate::server) name: String,
}

#[derive(Debug, Deserialize)]
pub(in crate::server) struct ImportPromptTraceBody {
    pub(in crate::server) run_id: String,
}

pub(in crate::server) const MAX_IMPORTED_TRACE_TEXT: usize = 20_000;

pub(in crate::server) fn truncate_prompt_trace_text(value: &str) -> String {
    value.chars().take(MAX_IMPORTED_TRACE_TEXT).collect()
}

pub(in crate::server) fn prompt_case_from_trace(
    detail: &crate::server::conversations::ConversationDetail,
) -> Result<serde_json::Value, String> {
    let Some(user_index) = detail
        .messages
        .iter()
        .rposition(|message| message.role == "user" && !message.content.trim().is_empty())
    else {
        return Err("trace has no non-empty user message".to_owned());
    };
    let Some(assistant) = detail.messages[user_index + 1..]
        .iter()
        .find(|message| message.role == "assistant" && !message.content.trim().is_empty())
    else {
        return Err("trace has no non-empty assistant response".to_owned());
    };
    Ok(json!({
        "id": format!("trace-{}", detail.id),
        "prompt": truncate_prompt_trace_text(&detail.messages[user_index].content),
        "expected": truncate_prompt_trace_text(&assistant.content),
        "metadata": {
            "source": "ryu-trace",
            "sourceRunId": detail.id,
            "capturedAt": chrono::Utc::now().to_rfc3339(),
        }
    }))
}

#[derive(Debug, Deserialize)]
pub(in crate::server) struct PromptReviewBody {
    pub(in crate::server) result_key: String,
    #[serde(default)]
    pub(in crate::server) pass: Option<bool>,
    #[serde(default)]
    pub(in crate::server) score: Option<f32>,
    #[serde(default)]
    pub(in crate::server) comment: Option<String>,
    #[serde(default)]
    pub(in crate::server) highlighted: bool,
}

pub(in crate::server) fn prompt_eval_store_or_error(
) -> Result<&'static crate::prompt_evals::PromptEvalStore, axum::response::Response> {
    crate::prompt_evals::PromptEvalStore::global().ok_or_else(|| {
        json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "prompt eval store is not initialized".to_owned(),
        )
    })
}

pub(in crate::server) fn prompt_eval_permission_error(
    status: StatusCode,
    permission: &str,
) -> axum::response::Response {
    json_error(status, format!("insufficient permissions: {permission}"))
}

pub(in crate::server) async fn prompt_suite_for_access(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    suite_id: &str,
    permission: &str,
) -> Result<
    (
        &'static crate::prompt_evals::PromptEvalStore,
        crate::prompt_evals::PromptSuiteRecord,
    ),
    axum::response::Response,
> {
    let store = prompt_eval_store_or_error()?;
    let suite = match store.get_suite(suite_id).await {
        Ok(Some(suite)) => suite,
        Ok(None) => {
            return Err(json_error(
                StatusCode::NOT_FOUND,
                "prompt suite not found".to_owned(),
            ));
        }
        Err(error) => {
            return Err(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                error.to_string(),
            ));
        }
    };
    if let Err(status) = enforce_permission_on(
        state,
        caller,
        permission,
        crate::acl::KIND_AGENT,
        &suite.agent_id,
    )
    .await
    {
        return Err(prompt_eval_permission_error(status, permission));
    }
    Ok((store, suite))
}

#[utoipa::path(
    get,
    path = "/api/prompt-suites",
    tag = "Prompt Evals",
    summary = "List Promptfoo-compatible evaluation suites",
    params(("agent_id" = String, Query)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_prompt_suites(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Query(query): Query<PromptSuiteListQuery>,
) -> axum::response::Response {
    if let Err(status) = enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
        crate::acl::KIND_AGENT,
        &query.agent_id,
    )
    .await
    {
        return prompt_eval_permission_error(
            status,
            crate::identity_verify::permissions::AGENT_VIEW,
        );
    }
    let store = match prompt_eval_store_or_error() {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store.list_suites(&query.agent_id).await {
        Ok(suites) => Json(json!({ "suites": suites })).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/prompt-suites",
    tag = "Prompt Evals",
    summary = "Create a Promptfoo-compatible evaluation suite",
    request_body = serde_json::Value,
    responses((status = 201, description = "Created", body = serde_json::Value))
)]
pub(in crate::server) async fn create_prompt_suite(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<CreatePromptSuiteBody>,
) -> axum::response::Response {
    if let Err(status) = enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
        crate::acl::KIND_AGENT,
        &body.agent_id,
    )
    .await
    {
        return prompt_eval_permission_error(
            status,
            crate::identity_verify::permissions::AGENT_EDIT,
        );
    }
    match state.agent_store.get(&body.agent_id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            return json_error(StatusCode::NOT_FOUND, "agent not found".to_owned());
        }
        Err(error) => {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    }
    let store = match prompt_eval_store_or_error() {
        Ok(store) => store,
        Err(response) => return response,
    };
    let suite = match store
        .create_suite(&body.agent_id, &body.name, &body.config)
        .await
    {
        Ok(suite) => suite,
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error.to_string()),
    };
    let version = match store.snapshot_suite(&suite.id, body.label.as_deref()).await {
        Ok(version) => version,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    (
        StatusCode::CREATED,
        Json(json!({ "suite": suite, "version": version })),
    )
        .into_response()
}

#[utoipa::path(
    get,
    path = "/api/prompt-suites/{id}",
    tag = "Prompt Evals",
    summary = "Get a Promptfoo-compatible evaluation suite",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_prompt_suite(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> axum::response::Response {
    match prompt_suite_for_access(
        &state,
        &caller,
        &id,
        crate::identity_verify::permissions::AGENT_VIEW,
    )
    .await
    {
        Ok((_store, suite)) => Json(json!({ "suite": suite })).into_response(),
        Err(response) => response,
    }
}

#[utoipa::path(
    put,
    path = "/api/prompt-suites/{id}",
    tag = "Prompt Evals",
    summary = "Update and version a Promptfoo-compatible evaluation suite",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn update_prompt_suite(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
    Json(body): Json<UpdatePromptSuiteBody>,
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
    let name = body.name.as_deref().unwrap_or(&suite.name);
    let config = body.config.as_ref().unwrap_or(&suite.config);
    let updated = match store.update_suite(&id, name, config).await {
        Ok(Some(suite)) => suite,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "prompt suite not found".to_owned()),
        Err(error) => return json_error(StatusCode::BAD_REQUEST, error.to_string()),
    };
    let version = match store.snapshot_suite(&id, body.label.as_deref()).await {
        Ok(version) => version,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    Json(json!({ "suite": updated, "version": version })).into_response()
}

#[utoipa::path(
    delete,
    path = "/api/prompt-suites/{id}",
    tag = "Prompt Evals",
    summary = "Delete a Promptfoo-compatible evaluation suite",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn delete_prompt_suite(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
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
    match store.delete_suite(&id).await {
        Ok(true) => Json(json!({ "success": true })).into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, "prompt suite not found".to_owned()),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}
