//! Workflow handlers and sub-agent delegation: `ForkWorkflowRunBody` through `persist_delegate_children`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Body for `POST /workflows/runs/:run_id/fork`.
#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(in crate::server) struct ForkWorkflowRunBody {
    /// The history checkpoint to fork from (`checkpoint_id` from the history
    /// listing).
    #[serde(alias = "checkpointId")]
    pub(in crate::server) checkpoint_id: String,
    /// Optional values merged into the checkpoint's state map before the fork
    /// resumes. Strings are stored verbatim; other JSON values as JSON text.
    #[serde(default, alias = "statePatch")]
    #[schema(value_type = Option<Object>)]
    pub(in crate::server) state_patch: Option<serde_json::Map<String, serde_json::Value>>,
}

/// `POST /workflows/runs/:run_id/fork` — replay a run from one of its history
/// checkpoints as a NEW run linked to its parent (`forked_from`), optionally
/// patching the checkpoint's state first. Nodes completed at the checkpoint are
/// reused; the rest run again under the fork's own run id (fresh idempotency
/// keys). The parent run is not modified.
///
/// - 404 when the run or checkpoint does not exist.
/// - 400 for an invalid state patch, a dry run, a nested child run, or an
///   ad-hoc script run (those stay scoped to the caller that started them).
/// - 200 with the fork's run once it settles (completed, awaiting input, or
///   waiting on a provider limit); a failed fork returns its error.
#[utoipa::path(
    post,
    path = "/workflows/runs/{run_id}/fork",
    tag = "Workflows",
    summary = "Fork a workflow run from a checkpoint",
    params(("run_id" = String, Path)),
    request_body = ForkWorkflowRunBody,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn fork_workflow_run(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(run_id): axum::extract::Path<String>,
    Json(body): Json<ForkWorkflowRunBody>,
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
    let patch = body
        .state_patch
        .unwrap_or_default()
        .into_iter()
        .map(|(key, value)| {
            let value = match value {
                serde_json::Value::String(text) => text,
                other => other.to_string(),
            };
            (key, value)
        })
        .collect();
    match crate::workflow::fork_run(&run_id, &body.checkpoint_id, patch).await {
        Ok(forked) => (
            StatusCode::OK,
            Json(json!({ "success": true, "run": forked })),
        ),
        Err(e) => {
            let status = if e.contains("not found") {
                StatusCode::NOT_FOUND
            } else if e.contains("state_patch")
                || e.contains("nested child run")
                || e.contains("dry runs")
                || e.contains("cannot be forked")
            {
                StatusCode::BAD_REQUEST
            } else if e.contains("gateway unreachable") || e.contains("gateway returned HTTP") {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(json!({ "success": false, "error": e })))
        }
    }
}

// ── Sub-agent delegation ──────────────────────────────────────────────────────

/// Body for `POST /api/delegate/stream`: a parent hands one or more tasks to
/// sub-agents that run with a clean context under a permission preset and caps.
#[derive(serde::Deserialize, Default)]
pub(in crate::server) struct DelegateBody {
    /// The sibling delegates to fan out (run concurrently, bounded by caps).
    #[serde(default)]
    pub(in crate::server) delegates: Vec<crate::workflow::delegation::DelegateSpec>,
    /// Parent conversation to list completed subagent children under.
    #[serde(default)]
    pub(in crate::server) conversation_id: Option<String>,
    /// Optional caps override; concurrency is clamped to the hard maximum.
    #[serde(default)]
    pub(in crate::server) caps: Option<crate::workflow::delegation::DelegationCaps>,
    /// Depth of these delegates (a top-level parent delegating is depth 1).
    #[serde(default = "default_delegate_depth")]
    pub(in crate::server) depth: usize,
}

pub(in crate::server) fn default_delegate_depth() -> usize {
    1
}

/// `POST /api/delegate/stream` — run a delegation fan-out and stream progress.
///
/// Each delegate's `started`/`finished` event is emitted as an SSE line as it
/// happens, so the client sees same-depth delegates progress concurrently. A
/// terminal `done` event carries the ordered result array.
#[utoipa::path(
    post,
    path = "/api/delegate/stream",
    tag = "Chat",
    summary = "Stream a sub-agent delegation (SSE)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Server-Sent Events stream"))
)]
pub(in crate::server) async fn delegate_stream(
    State(state): State<ServerState>,
    body: Option<Json<DelegateBody>>,
) -> axum::response::Response {
    use crate::sidecar::adapters::sse_response;
    use crate::workflow::delegation;

    let body = body.map(|b| b.0).unwrap_or_default();
    let caps = body.caps.unwrap_or_default();
    let depth = body.depth;
    let parent_conversation_id = body.conversation_id.filter(|s| !s.is_empty());
    let delegates = body.delegates;
    let delegates_for_persist = delegates.clone();
    let conversations = state.conversations.clone();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<delegation::DelegateProgress>();

    // Spawn the fan-out; progress events arrive on `rx` while it runs.
    let fanout =
        tokio::spawn(async move { delegation::run_fanout(delegates, caps, depth, Some(tx)).await });

    let stream = async_stream::stream! {
        while let Some(ev) = rx.recv().await {
            let line = match serde_json::to_string(&ev) {
                Ok(json) => format!("data: {json}\n\n"),
                Err(_) => continue,
            };
            yield Ok::<_, std::convert::Infallible>(line.into_bytes());
        }

        let terminal = match fanout.await {
            Ok(Ok(results)) => {
                if !results.is_empty() {
                    let completed = results.iter().filter(|result| result.error.is_none()).count();
                    let failed = results.len() - completed;
                    crate::events::publish_system_notification(
                        if failed == 0 {
                            "Other agents finished"
                        } else {
                            "Other agents finished with issues"
                        },
                        format!("{completed} of {} delegated tasks completed.", results.len()),
                        if failed == 0 { "success" } else { "warning" },
                    );
                }
                if let Some(parent_id) = parent_conversation_id.as_deref() {
                    persist_delegate_children(
                        &conversations,
                        parent_id,
                        &delegates_for_persist,
                        &results,
                    )
                    .await;
                }
                json!({ "event": "done", "results": results })
            },
            Ok(Err(e)) => json!({ "event": "error", "error": e.to_string() }),
            Err(e) => json!({ "event": "error", "error": format!("delegation task failed: {e}") }),
        };
        yield Ok::<_, std::convert::Infallible>(
            format!("data: {terminal}\n\n").into_bytes(),
        );
    };

    sse_response(axum::body::Body::from_stream(stream))
}

pub(in crate::server) async fn persist_delegate_children(
    conversations: &ConversationStore,
    parent_conversation_id: &str,
    delegates: &[crate::workflow::delegation::DelegateSpec],
    results: &[crate::workflow::delegation::DelegateResult],
) {
    let specs_by_id: std::collections::HashMap<&str, &crate::workflow::delegation::DelegateSpec> =
        delegates
            .iter()
            .map(|spec| (spec.id.as_str(), spec))
            .collect();
    for result in results {
        let Some(spec) = specs_by_id.get(result.id.as_str()) else {
            continue;
        };
        let answer = result
            .output
            .as_deref()
            .or(result.error.as_deref())
            .unwrap_or("");
        let preset = serde_json::to_value(result.preset)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned));
        if let Err(e) = conversations
            .append_subagent_child(
                parent_conversation_id,
                &spec.task,
                answer,
                spec.agent_id.as_deref(),
                preset.as_deref(),
                result.child_conversation_id.as_deref(),
            )
            .await
        {
            tracing::warn!("failed to persist subagent child entry: {e:#}");
        }
    }
}
