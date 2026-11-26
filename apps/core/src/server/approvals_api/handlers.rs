//! The approval inbox's request handlers: list, read, decide and the approval mode.
// test-exempt: moved verbatim out of server/approvals_api.rs by the module split; covered by approvals_api/tests.rs and server/approvals_decision_runtime_test.rs.

use super::*;

type Reply = (StatusCode, Json<serde_json::Value>);

fn error_reply(status: StatusCode, error: &str) -> Reply {
    (status, Json(json!({ "success": false, "error": error })))
}

/// The approval, a 404 for an unknown id, or a 500 on a store failure.
fn approval_reply(result: anyhow::Result<Option<crate::approvals::ApprovalRequest>>) -> Reply {
    match result {
        Ok(Some(req)) => (StatusCode::OK, Json(json!({ "approval": req }))),
        Ok(None) => error_reply(StatusCode::NOT_FOUND, "approval not found"),
        Err(e) => error_reply(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

fn parse_status(s: &str) -> Option<ApprovalStatus> {
    match s {
        "pending" => Some(ApprovalStatus::Pending),
        "approved" => Some(ApprovalStatus::Approved),
        "rejected" => Some(ApprovalStatus::Rejected),
        "expired" => Some(ApprovalStatus::Expired),
        "cancelled" => Some(ApprovalStatus::Cancelled),
        _ => None,
    }
}

/// `GET /api/approvals?status=pending` — list approval requests, newest first.
/// Approvals that run an app job are listed only with `include=app_jobs`.
#[utoipa::path(
    get,
    path = "/api/approvals",
    tag = "Approvals",
    summary = "list approval requests, newest first.",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_approvals(
    State(state): State<ServerState>,
    Query(q): Query<ListQuery>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    if let Err(status) = require_permission(&state, &caller, "approvals.view").await {
        return status.into_response();
    }
    let status = q.status.as_deref().and_then(parse_status);
    let include_app_jobs = q.include_app_jobs();
    match state.approvals.store.list(status).await {
        Ok(approvals) => {
            let approvals: Vec<_> = approvals
                .into_iter()
                .filter(|request| include_app_jobs || !runs_app_job(request))
                .collect();
            Json(json!({ "approvals": approvals })).into_response()
        }
        // A store failure is not an empty inbox: answer an error status so the
        // client shows that approvals are unavailable instead of "none pending".
        Err(e) => error_reply(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()).into_response(),
    }
}

/// `GET /api/approvals/:id` — fetch a single request.
#[utoipa::path(
    get,
    path = "/api/approvals/{id}",
    tag = "Approvals",
    summary = "fetch a single request.",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_approval(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(status) = require_permission(&state, &caller, "approvals.view").await {
        return error_reply(status, "forbidden");
    }
    approval_reply(state.approvals.store.get(&id).await)
}

#[derive(Debug, Deserialize, Default)]
pub struct DecideBody {
    /// Optional note the deciding user attaches (a reason for the decision).
    #[serde(default)]
    note: Option<String>,
}

/// Approve or reject `id` for a caller holding `approvals.decide`.
async fn decide(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    id: &str,
    approve: bool,
    body: Option<Json<DecideBody>>,
) -> Reply {
    if let Err(status) = require_permission(state, caller, "approvals.decide").await {
        return error_reply(status, "forbidden");
    }
    let note = body.and_then(|b| b.0.note);
    // The caller, checked above to be present and to hold
    // `approvals.decide`, is handed over as the approver.
    approval_reply(
        state
            .approvals
            .decide(id, approve, note, caller.clone())
            .await,
    )
}

/// `POST /api/approvals/:id/approve` — approve a request (runs its action).
#[utoipa::path(
    post,
    path = "/api/approvals/{id}/approve",
    tag = "Approvals",
    summary = "approve a request (runs its action).",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn approve_approval(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    body: Option<Json<DecideBody>>,
) -> (StatusCode, Json<serde_json::Value>) {
    decide(&state, &caller, &id, true, body).await
}

/// `POST /api/approvals/:id/reject` — reject a request (fails a workflow gate).
#[utoipa::path(
    post,
    path = "/api/approvals/{id}/reject",
    tag = "Approvals",
    summary = "reject a request (fails a workflow gate).",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn reject_approval(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    body: Option<Json<DecideBody>>,
) -> (StatusCode, Json<serde_json::Value>) {
    decide(&state, &caller, &id, false, body).await
}

/// `GET /api/approvals/mode` — the global approval mode (Layer B): `off` /
/// `smart` / `manual`. `off` is the default (gates nothing).
#[utoipa::path(
    get,
    path = "/api/approvals/mode",
    tag = "Approvals",
    summary = "the global approval mode (Layer B): `off` /",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_mode(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    if let Err(status) = require_permission(&state, &caller, "approvals.view").await {
        return status.into_response();
    }
    let mode = state.approvals.approval_mode().await;
    Json(json!({ "mode": mode.as_str() })).into_response()
}

#[derive(Debug, Deserialize)]
pub struct SetModeBody {
    /// `off` / `smart` / `manual` (anything else is treated as `off`).
    mode: String,
}

/// `PUT /api/approvals/mode` — set the global approval mode.
#[utoipa::path(
    put,
    path = "/api/approvals/mode",
    tag = "Approvals",
    summary = "set the global approval mode.",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn set_mode(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<SetModeBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(status) = require_permission(&state, &caller, "approvals.decide").await {
        return error_reply(status, "forbidden");
    }
    // Normalize through the enum so only a valid mode is ever stored.
    let mode = crate::approvals::policy::ApprovalMode::from_pref(&body.mode);
    match state
        .preferences
        .set(crate::approvals::policy::APPROVAL_MODE_PREF, mode.as_str())
        .await
    {
        Ok(()) => (StatusCode::OK, Json(json!({ "mode": mode.as_str() }))),
        Err(e) => error_reply(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}
