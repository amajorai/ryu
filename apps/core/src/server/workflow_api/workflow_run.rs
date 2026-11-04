//! Workflow handlers and sub-agent delegation: `run_workflow` through `workflow_run_history`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /workflows/:id/run` — execute a persisted workflow end-to-end, or
/// evaluate it as a read-only dry run when `dryRun` is true.
///
/// Routes through the durable engine selected by `durable::select_engine()` —
/// the in-process petgraph topological executor with file-backed resumable
/// state, crash-recoverable at the node checkpoint level. Re-POST with the same
/// `run_id` to resume a run after a Core restart (already-Completed nodes are
/// skipped and their output reused).
///
/// Set `dryRun: true` to evaluate the graph as a transient read-only projection:
/// no run file, lifecycle hook, approval, timer checkpoint, or effectful node
/// execution is created. Pure nodes and classified read-only MCP tools may run;
/// other effectful nodes are returned as skipped with reasons.
///
/// Returns 503 when the gateway is unreachable and fail-closed is in effect.
#[utoipa::path(
    post,
    path = "/workflows/{id}/run",
    tag = "Workflows",
    summary = "Run a workflow",
    description = "Execute a workflow durably, or set dryRun to true for a transient read-only projection. Normal runs use file-backed resumable checkpoints; dry runs create no run history, lifecycle hook, approval, timer checkpoint, or effectful node execution. Pure nodes and classified read-only MCP tools may run, while other effectful nodes are returned as skipped with reasons. A caller-provided runId is ignored in dry-run mode.",
    params(("id" = String, Path)),
    request_body = RunWorkflowBody,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn run_workflow(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    body: Option<Json<RunWorkflowBody>>,
) -> (StatusCode, Json<serde_json::Value>) {
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::WORKFLOW_RUN,
        crate::acl::KIND_WORKFLOW,
        &id,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: workflow.run" })),
        );
    }
    let body = body.map(|b| b.0).unwrap_or_default();

    let workflow = match crate::workflow::store::load_workflow(&id) {
        Ok(wf) => wf,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "success": false, "error": "workflow not found" })),
            );
        }
    };

    let run_id = if body.dry_run {
        // Dry runs are transient projections. Never accept a caller-provided
        // id here: a fresh id avoids accidental durable-run lookup and makes
        // the no-history contract explicit.
        format!("dryrun_{}", uuid::Uuid::new_v4().simple())
    } else {
        body.run_id
            .unwrap_or_else(|| format!("run_{}", uuid::Uuid::new_v4().simple()))
    };

    tracing::debug!(
        workflow_id = %id,
        run_id = %run_id,
        dry_run = body.dry_run,
        "workflow: starting run"
    );

    let outcome = if body.dry_run {
        crate::workflow::executor::dry_run_workflow(&workflow, body.input, run_id).await
    } else {
        let engine = crate::workflow::durable::select_engine();
        engine.execute(&workflow, body.input, run_id).await
    };

    match outcome {
        Ok(run) => (StatusCode::OK, Json(json!({ "success": true, "run": run }))),
        Err(e) => {
            // Fail-closed: a gateway-unreachable error (from run_prompt) maps to 503.
            let status = if e.contains("gateway unreachable") || e.contains("gateway returned HTTP")
            {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(json!({ "success": false, "error": e })))
        }
    }
}

/// `GET /workflows/runs/live` — how much work a restart would destroy.
///
/// The input to the "restart now or tonight?" decision. Answered by the NODE
/// because the node is the only party that knows what is running on it — the
/// control plane cannot reach in, and a number it guessed would be worse than
/// none: it would read as a promise that nothing will be lost.
///
/// `awaiting_input` is reported separately and deliberately not added to
/// `running`: those runs are parked at durable gates and survive a restart, so
/// counting them as losses would overstate the damage and teach people to
/// ignore the warning.
#[utoipa::path(
    get,
    path = "/workflows/runs/live",
    tag = "Workflows",
    summary = "Count the runs a restart would interrupt",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn live_workflow_runs() -> axum::response::Response {
    let counts = crate::workflow::store::live_run_counts();
    (StatusCode::OK, Json(json!(counts))).into_response()
}

#[utoipa::path(
    get,
    path = "/workflows/runs/{run_id}",
    tag = "Workflows",
    summary = "Get a workflow run",
    params(("run_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_workflow_run(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(run_id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match crate::workflow::store::load_run(&run_id) {
        Ok(run) => {
            if enforce_permission_on(
                &state,
                &caller,
                crate::identity_verify::permissions::WORKFLOW_VIEW,
                crate::acl::KIND_WORKFLOW,
                &run.workflow_id,
            )
            .await
            .is_err()
            {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({ "error": "insufficient permissions: workflow.view" })),
                );
            }
            (StatusCode::OK, Json(json!({ "run": run })))
        }
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "run not found" })),
        ),
    }
}

/// Body for `POST /workflows/runs/:run_id/resume`.
#[derive(serde::Deserialize, Default)]
pub(in crate::server) struct ResumeWorkflowBody {
    /// Value to inject as the suspended Awakeable gate's output. Becomes the
    /// input to downstream nodes. Defaults to empty string when absent.
    #[serde(default)]
    pub(in crate::server) payload: String,
}

/// `POST /workflows/runs/:run_id/resume` — resume a run suspended at an
/// Awakeable gate.
///
/// Acceptance criteria:
/// - 404 when the run does not exist.
/// - 409 when the run is not in `awaiting_input` status.
/// - Completes the Awakeable gate with the caller-supplied `payload`, persists,
///   re-invokes the executor (which skips all already-Completed nodes and
///   continues from the gate's successor), and returns the final run state.
#[utoipa::path(
    post,
    path = "/workflows/runs/{run_id}/resume",
    tag = "Workflows",
    summary = "Resume a workflow run (HITL)",
    params(("run_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn resume_workflow_run(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(run_id): axum::extract::Path<String>,
    body: Option<Json<ResumeWorkflowBody>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let run = match crate::workflow::store::load_run(&run_id) {
        Ok(run) => run,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "success": false, "error": "run not found" })),
            );
        }
    };
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::WORKFLOW_RUN,
        crate::acl::KIND_WORKFLOW,
        &run.workflow_id,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: workflow.run" })),
        );
    }
    let body = body.map(|b| b.0).unwrap_or_default();

    // Delegate to the reusable resume core (shared with the approval engine, so a
    // manual resume and an approved workflow-gate resume are identical). Map its
    // error string onto the right status code.
    match crate::workflow::resume_run(&run_id, body.payload).await {
        Ok(completed_run) => (
            StatusCode::OK,
            Json(json!({ "success": true, "run": completed_run })),
        ),
        Err(e) => {
            let status = if e.contains("not found") {
                StatusCode::NOT_FOUND
            } else if e.contains("not awaiting input") {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(json!({ "success": false, "error": e })))
        }
    }
}

/// `POST /workflows/runs/:run_id/continue` — continue an interrupted (`running`
/// with no live executor) or limit-parked (`waiting`) run from its last
/// checkpoint now, in the background. This is the manual form of
/// [`crate::workflow::auto_resume`]: it works when automatic resumption is off
/// or held, and lets a person skip a limit wait they know has cleared.
///
/// - 404 when the run does not exist.
/// - 409 when the run is not resumable or is already executing.
/// - 202 with `{ run_id }` once the run is continuing.
#[utoipa::path(
    post,
    path = "/workflows/runs/{run_id}/continue",
    tag = "Workflows",
    summary = "Continue an interrupted or limit-paused workflow run",
    params(("run_id" = String, Path)),
    responses((status = 202, description = "Accepted", body = serde_json::Value))
)]
pub(in crate::server) async fn continue_workflow_run(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(run_id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Ok(run) = crate::workflow::store::load_run(&run_id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "run not found" })),
        );
    };
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::WORKFLOW_RUN,
        crate::acl::KIND_WORKFLOW,
        &run.workflow_id,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: workflow.run" })),
        );
    }
    match crate::workflow::auto_resume::continue_now(&run_id) {
        Ok(true) => (
            StatusCode::ACCEPTED,
            Json(json!({ "success": true, "run_id": run_id })),
        ),
        Ok(false) => (
            StatusCode::CONFLICT,
            Json(json!({
                "success": false,
                "error": "run is not interrupted or waiting, or is already executing"
            })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

/// `GET /workflows/runs/:run_id/history` — every recorded checkpoint of a run
/// (time travel): node id, iteration, timestamp, and the run's state, node
/// statuses, and outputs at that point, oldest first.
///
/// - 404 when the run does not exist.
/// - 200 with `{ run_id, checkpoints: [...] }` (empty for a run that predates
///   history).
#[utoipa::path(
    get,
    path = "/workflows/runs/{run_id}/history",
    tag = "Workflows",
    summary = "List a workflow run's checkpoint history",
    params(("run_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn workflow_run_history(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(run_id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Ok(run) = crate::workflow::store::load_run(&run_id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "success": false, "error": "run not found" })),
        );
    };
    if enforce_permission_on(
        &state,
        &caller,
        crate::identity_verify::permissions::WORKFLOW_VIEW,
        crate::acl::KIND_WORKFLOW,
        &run.workflow_id,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: workflow.view" })),
        );
    }
    match crate::workflow::history::list(&run_id) {
        Ok(checkpoints) => (
            StatusCode::OK,
            Json(json!({ "success": true, "run_id": run_id, "checkpoints": checkpoints })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}
