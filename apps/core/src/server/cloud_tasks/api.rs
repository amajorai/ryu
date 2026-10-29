//! HTTP handlers for cloud task status, managed prompts, change review and
//! finish. Every route is owner-scoped: another owner's task reads as absent.
use super::{
    api_error, api_error_code, box_arm, environments, now, records, require_capabilities,
    require_execution, tasks, ApiError, LiveTask, TaskSlot, TaskState, TaskWorkspace,
};
use crate::server::{ResolvedAuthorization, ServerState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::{Deserialize, Serialize};

const MAX_PROMPT_CHARS: usize = 32_000;
const MAX_COMMIT_MESSAGE_CHARS: usize = 4096;
const DEFAULT_COMMIT_MESSAGE: &str = "Ryu cloud task changes";
const MAX_PULL_REQUEST_TITLE_CHARS: usize = 256;
const MAX_PULL_REQUEST_BODY_CHARS: usize = 65_536;
const DEFAULT_PULL_REQUEST_BODY: &str = "Opened from a Ryu cloud task.";

/// A managed prompt run in flight.
#[derive(Serialize, utoipa::ToSchema)]
#[schema(as = CloudTaskActiveRun)]
#[serde(rename_all = "camelCase")]
pub(super) struct ActiveRunView {
    id: String,
    /// `queued` or `running`.
    status: String,
    started_at: String,
    /// Redacted, at most 16384 characters.
    output_tail: String,
}

/// The most recent finished managed prompt run.
#[derive(Serialize, utoipa::ToSchema)]
#[schema(as = CloudTaskLastRun)]
#[serde(rename_all = "camelCase")]
pub(super) struct LastRunView {
    id: String,
    /// `completed` or `failed`.
    status: String,
    exit_code: Option<i32>,
    summary: Option<String>,
    /// `canceled`, `box_destroyed`, `service_restarted`, `timeout` or null.
    reason: Option<String>,
    completed_at: Option<String>,
}

/// One owner's cloud task.
#[derive(Serialize, utoipa::ToSchema)]
#[schema(as = CloudTaskStatus)]
#[serde(rename_all = "camelCase")]
pub(super) struct CloudTaskStatus {
    conversation_id: String,
    environment_id: String,
    /// `docker`, `opensandbox`, `vpn` or `box`.
    backend: String,
    /// `ryu`, `claude-code`, `codex`, `opencode` or `cursor`.
    executor: String,
    /// `preparing`, `ready`, `running`, `finishing`, `failed`, `stopped`,
    /// `expired` or `interrupted`.
    state: String,
    expires_at: Option<String>,
    base_sha: Option<String>,
    base_branch: Option<String>,
    active_run: Option<ActiveRunView>,
    last_run: Option<LastRunView>,
    finish: Option<box_arm::FinishSummary>,
    /// The task's Box (box backend only): state, placement, screen, running
    /// time, cost so far, hourly rate, low-credit warning and `stopReason`.
    #[serde(rename = "box", skip_serializing_if = "Option::is_none")]
    #[schema(rename = "box")]
    box_view: Option<crate::server::session_box::SessionBoxView>,
    /// The caller's running Boxes and cap, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    caps: Option<crate::server::session_box::BoxCaps>,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[schema(as = CloudTaskPromptRequest)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PromptRequest {
    /// Published environment ID, 1-128 characters.
    environment_id: String,
    /// Prompt text, 1-32000 characters.
    text: String,
    /// Run this session on one backend: `ryu-box`, `anthropic-subscription-cli` (the
    /// node owner's Claude plan, through their signed-in Claude Code CLI),
    /// `openai-subscription-cli` (their ChatGPT plan, through the Codex CLI), or
    /// `anthropic-subscription-sdk` / `openai-subscription-sdk` (the same plans, run on
    /// the node itself by `claude -p` / `codex exec`). Omitted:
    /// the agent's order, then the owner's default order, then the Ryu Box.
    #[serde(default)]
    backend: Option<crate::server::subscription_cloud::CloudTaskBackend>,
    /// With `backend`, whether another backend may take the task when that one cannot.
    /// Default `true`; `false` makes the choice strict.
    #[serde(default)]
    fallback: Option<bool>,
    /// The Ryu agent this session belongs to, for its per-agent backend order.
    #[serde(default)]
    agent_id: Option<String>,
    /// Run this session on one of the owner's linked accounts, as `<provider>:<id>`
    /// (`anthropic:3fa2c1d0e9b8`, or `openai:default` for the CLI's own sign-in).
    /// Omitted: the agent's account, then the owner's default. A conversation keeps the
    /// account it started on.
    #[serde(default)]
    account: Option<String>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[schema(as = CloudTaskPromptRun)]
pub(super) struct PromptRunAccepted {
    id: String,
    /// `queued` or `running`.
    status: String,
}

#[derive(Serialize, utoipa::ToSchema)]
#[schema(as = CloudTaskPromptAccepted)]
#[serde(rename_all = "camelCase")]
pub(super) struct PromptAccepted {
    run: PromptRunAccepted,
    /// Where the task runs. Absent on older nodes, which run every task on the Box.
    backend: crate::server::subscription_cloud::CloudTaskBackend,
    /// The run on the node owner's plan, when it runs there.
    #[serde(skip_serializing_if = "Option::is_none")]
    subscription: Option<crate::server::subscription_cloud::api::RunView>,
    /// Why a preferred plan was skipped (for example `subscription_quota_fallback` when
    /// the plan hit its usage limit and the task went to the Ryu Box instead).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    notices: Vec<crate::server::subscription_cloud::routing::Notice>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[schema(as = CloudTaskDiff)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiffResponse {
    base_sha: String,
    /// At most 1000 files.
    files: Vec<box_arm::DiffFile>,
    /// At most 786432 bytes.
    patch: String,
    truncated: bool,
}

#[derive(Deserialize, utoipa::ToSchema)]
#[schema(as = CloudTaskFinishRequest)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FinishRequest {
    push: bool,
    #[serde(default)]
    branch: Option<String>,
    /// 1-4096 characters.
    #[serde(default)]
    commit_message: Option<String>,
    /// `destroy` or `keep`.
    teardown: String,
    /// After a successful push, open a GitHub pull request from the pushed
    /// branch into the starting branch. Requires push. Defaults to false.
    #[serde(default)]
    open_pull_request: bool,
    /// 1-256 characters. Defaults to the commit message's first line.
    #[serde(default)]
    pull_request_title: Option<String>,
    /// At most 65536 characters.
    #[serde(default)]
    pull_request_body: Option<String>,
    /// Open the pull request as a draft. Defaults to false.
    #[serde(default)]
    draft: Option<bool>,
}

#[derive(Serialize, utoipa::ToSchema)]
#[schema(as = CloudTaskFinishResponse)]
pub(super) struct FinishResponse {
    finish: box_arm::FinishSummary,
}

fn bad_request(message: &str) -> ApiError {
    api_error_code(StatusCode::BAD_REQUEST, "invalid_request", message)
}
fn not_found() -> ApiError {
    api_error_code(
        StatusCode::NOT_FOUND,
        "cloud_task_not_found",
        "No cloud task exists for this conversation.",
    )
}
fn not_ready(message: &str) -> ApiError {
    api_error_code(StatusCode::CONFLICT, "cloud_task_not_ready", message)
}
/// How long a diff or finish request waits for a slot that a tool call or
/// setup holds before answering busy instead of hanging behind it.
const SLOT_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

async fn lock_briefly(slot: &TaskSlot) -> Result<tokio::sync::MutexGuard<'_, TaskState>, ApiError> {
    tokio::time::timeout(SLOT_WAIT, slot.lock())
        .await
        .map_err(|_| box_arm::busy())
}

/// Clears `finishing` if the finish request is dropped before it records its
/// outcome (the client disconnected or timed out during a long push).
struct FinishingReset(Option<TaskSlot>);

impl Drop for FinishingReset {
    fn drop(&mut self) {
        let Some(slot) = self.0.take() else {
            return;
        };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                if let TaskState::Ready(task) = &mut *slot.lock().await {
                    task.finishing = false;
                }
            });
        }
    }
}

fn unsupported(message: &str) -> ApiError {
    api_error_code(
        StatusCode::UNPROCESSABLE_ENTITY,
        "cloud_task_finish_unsupported",
        message,
    )
}
fn bindings_unavailable() -> ApiError {
    api_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "Cloud task bindings are unavailable.",
    )
}

fn require_conversation_id(conversation_id: &str) -> Result<(), ApiError> {
    if crate::sidecar::adapters::acp::is_safe_host_conversation_id(conversation_id) {
        Ok(())
    } else {
        Err(bad_request("A valid conversation ID is required."))
    }
}

fn parse_body<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<T, ApiError> {
    serde_json::from_slice(body).map_err(|_| bad_request("The request body is invalid."))
}

async fn owned_slot(owner: &str, conversation_id: &str) -> Option<TaskSlot> {
    tasks()
        .lock()
        .await
        .get(&(owner.to_owned(), conversation_id.to_owned()))
        .cloned()
}

fn rfc3339(seconds: u64) -> Option<String> {
    chrono::DateTime::from_timestamp(i64::try_from(seconds).ok()?, 0)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

fn live_status(task: &LiveTask, conversation_id: &str, owner: &str) -> CloudTaskStatus {
    let state = if task.expires_at <= now().unwrap_or(u64::MAX) {
        "expired"
    } else if task.finishing {
        "finishing"
    } else if task.active_run.is_some() {
        "running"
    } else {
        "ready"
    };
    CloudTaskStatus {
        conversation_id: conversation_id.to_owned(),
        environment_id: task.context.environment_id.clone(),
        backend: task.context.backend.clone(),
        executor: task.context.executor.clone(),
        state: state.to_owned(),
        expires_at: rfc3339(task.expires_at),
        base_sha: task.base_sha.clone(),
        base_branch: task.base_branch.clone(),
        active_run: task.active_run.as_ref().map(|run| ActiveRunView {
            id: run.id.clone(),
            status: run.status.clone(),
            started_at: run.started_at.clone(),
            output_tail: run.output_tail.clone(),
        }),
        last_run: task.last_run.clone().map(|run| LastRunView {
            id: run.id,
            status: run.status,
            exit_code: run.exit_code,
            summary: run.summary,
            reason: run.reason,
            completed_at: run.completed_at,
        }),
        finish: task
            .finish
            .clone()
            .or_else(|| box_arm::remembered_finish(owner, conversation_id)),
        box_view: None,
        caps: None,
    }
}

/// Add the Box view and caps to a box task's status: the live Box while the
/// task holds one, otherwise the recorded stop reason.
async fn attach_box(
    status: &mut CloudTaskStatus,
    auth: &ResolvedAuthorization,
    owner: &str,
    expires_at: Option<u64>,
) {
    if status.backend != "box" {
        return;
    }
    let conversation_id = status.conversation_id.clone();
    if let Some(target) = super::bound_box(owner, &conversation_id).await {
        status.box_view =
            Some(crate::server::session_box::box_view(&target, true, None, expires_at, None).await);
    } else if matches!(status.state.as_str(), "stopped" | "expired" | "interrupted") {
        let stop_reason = records::stop_reason(owner, &conversation_id).ok().flatten();
        status.box_view = Some(crate::server::session_box::SessionBoxView {
            state: "stopped".to_owned(),
            source: Some("cloud_task".to_owned()),
            warning: "none".to_owned(),
            stop_reason,
            ..Default::default()
        });
    }
    status.caps = crate::server::session_box::owner_caps(auth, owner).await;
}

/// The status projection; 404 when this owner has no record.
pub(super) async fn status_for(
    auth: &ResolvedAuthorization,
    conversation_id: &str,
) -> Result<CloudTaskStatus, ApiError> {
    require_capabilities(auth, false)?;
    let owner = environments::owner(auth)?;
    require_conversation_id(conversation_id)?;
    let (environment_id, recorded) = records::lookup(&owner, conversation_id)
        .map_err(|_| bindings_unavailable())?
        .ok_or_else(not_found)?;
    if let Some(slot) = owned_slot(&owner, conversation_id).await {
        // Preparation (Box create, ready wait, setup) and tool calls hold the
        // slot lock for minutes, so a contended slot reports its persisted
        // lifecycle marker (kept current by `records::create`/`records::mark`)
        // instead of waiting on the lock.
        let Ok(state) = slot.try_lock() else {
            return Ok(record_status(
                &owner,
                conversation_id,
                environment_id,
                &recorded,
            ));
        };
        let label = match &*state {
            TaskState::Ready(task) => {
                let mut status = live_status(task, conversation_id, &owner);
                let expires_at = task.expires_at;
                drop(state);
                attach_box(&mut status, auth, &owner, Some(expires_at)).await;
                return Ok(status);
            }
            TaskState::Preparing => "preparing",
            TaskState::Failed => "failed",
            TaskState::Stopped => "stopped",
        };
        let mut status = record_status(&owner, conversation_id, environment_id, label);
        attach_box(&mut status, auth, &owner, None).await;
        return Ok(status);
    }
    let label = if matches!(recorded.as_str(), "preparing" | "ready") {
        "interrupted"
    } else {
        recorded.as_str()
    };
    let mut status = record_status(&owner, conversation_id, environment_id, label);
    attach_box(&mut status, auth, &owner, None).await;
    Ok(status)
}

fn record_status(
    owner: &str,
    conversation_id: &str,
    environment_id: String,
    state: &str,
) -> CloudTaskStatus {
    let (backend, executor) = super::saved_runtime_labels(owner, &environment_id);
    CloudTaskStatus {
        conversation_id: conversation_id.to_owned(),
        environment_id,
        backend,
        executor,
        state: state.to_owned(),
        expires_at: None,
        base_sha: None,
        base_branch: None,
        active_run: None,
        last_run: None,
        finish: box_arm::remembered_finish(owner, conversation_id),
        box_view: None,
        caps: None,
    }
}

#[utoipa::path(get,path="/api/cloud-tasks/{conversation_id}",operation_id="get_cloud_task",tag="Cloud environments",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation bound to a personally owned cloud task")),description="Read the caller's cloud task: environment, backend (docker, opensandbox, vpn or box), executor (ryu or a managed CLI agent), lifecycle state (preparing, ready, running, finishing, failed, stopped, expired or interrupted), expiry, the repository commit and branch setup checked out, the active managed run with a redacted output tail of at most 16384 characters, the last finished run, the last finish result, and for a box task its Box (state, placement, screen, running time, cost so far and hourly rate from the Gateway's sandbox ticks, low-credit warning, and why it stopped) and the caller's running-Box cap. Requires GatewayRoute and current personal identity. A task owned by another caller reads as not found.",responses((status=200,body=CloudTaskStatus),(status=400,description="Invalid conversation ID"),(status=403,description="Identity denied"),(status=404,description="cloud_task_not_found: no task for this caller"),(status=503,description="Lifecycle store unavailable")))]
pub(super) async fn status(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(conversation_id): Path<String>,
) -> Response {
    match status_for(&auth, &conversation_id).await {
        Ok(status) => Json(status).into_response(),
        Err(error) => error.into_response(),
    }
}

#[utoipa::path(post,path="/api/cloud-tasks/{conversation_id}/prompt",operation_id="prompt_cloud_task",tag="Cloud environments",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation to bind to, or already bound to, a fresh cloud box")),request_body=PromptRequest,description="Send a prompt to the managed CLI agent (Claude Code, Codex, OpenCode or Cursor) of a fresh cloud box environment. Requires GatewayRoute, ToolsExec and current personal identity. Binds and prepares the task exactly as chat does on first use, creates the conversation if missing, and appends the user message. Each prompt is a fresh CLI invocation in the same Box; the agent receives the environment's variables except the GitHub credential. On completion one assistant message with the redacted summary is appended. Unknown body fields are rejected.",responses((status=202,body=PromptAccepted),(status=400,description="Invalid body or conversation ID"),(status=403,description="Execution authority or identity denied; cloud_environment_feature_unavailable: the signed-in account lacks the Fresh cloud box rollout"),(status=404,description="Environment not found"),(status=409,description="cloud_task_busy: a run is active; cloud_task_desktop_routing: a networked box cannot run while Route traffic through this computer is on; or a binding conflict"),(status=422,description="cloud_task_executor_mismatch: the environment runs Ryu; use chat"),(status=503,description="cloud_environment_backend_unavailable, or cloud_task_capacity (with Retry-After): no Box capacity right now; the conversation stays unbound and can retry")))]
pub(super) async fn prompt(
    State(state): State<ServerState>,
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(conversation_id): Path<String>,
    body: axum::body::Bytes,
) -> Response {
    match prompt_inner(&state, &auth, &conversation_id, &body).await {
        Ok(accepted) => (StatusCode::ACCEPTED, Json(accepted)).into_response(),
        Err(response) => response,
    }
}

async fn prompt_inner(
    state: &ServerState,
    auth: &ResolvedAuthorization,
    conversation_id: &str,
    body: &[u8],
) -> Result<PromptAccepted, Response> {
    require_execution(auth).map_err(IntoResponse::into_response)?;
    require_conversation_id(conversation_id).map_err(IntoResponse::into_response)?;
    let request: PromptRequest = parse_body(body).map_err(IntoResponse::into_response)?;
    let text_chars = request.text.chars().count();
    if request.environment_id.is_empty()
        || request.environment_id.len() > 128
        || request.text.trim().is_empty()
        || text_chars > MAX_PROMPT_CHARS
    {
        return Err(bad_request(
            "An environment ID (1-128 characters) and prompt text (1-32000 characters) are required.",
        )
        .into_response());
    }
    let owner = environments::owner(auth).map_err(IntoResponse::into_response)?;
    let runtime = environments::runtime_for(&owner, &request.environment_id).ok_or_else(|| {
        api_error_code(
            StatusCode::NOT_FOUND,
            "cloud_environment_not_found",
            "Publish the environment before sending prompts.",
        )
        .into_response()
    })?;
    if runtime.executor == "ryu" {
        return Err(executor_mismatch().into_response());
    }
    // Refuse before binding so neither a caller without the rollout flag nor an
    // unconfigured node ever burns the conversation. A task that may run on the node
    // owner's own plan is checked after routing, and only if it falls back to the Box.
    let may_try_plan = crate::server::subscription_cloud::api::may_try_plan(
        auth,
        &owner,
        conversation_id,
        &runtime.executor,
        request.backend,
    )
    .await;
    let mut box_gates_passed = false;
    if runtime.backend == "box" && !may_try_plan {
        require_box_gates(auth).await?;
        box_gates_passed = true;
    }
    let agent_id = format!("cloud:{}", runtime.executor);
    let tenancy = crate::server::caller_tenancy(&auth.caller);
    match state.conversations.get_access_meta(conversation_id).await {
        Ok(None) => {
            let title: String = request.text.trim().chars().take(60).collect();
            state
                .conversations
                .ensure_conversation(
                    conversation_id,
                    Some(&agent_id),
                    Some(&title),
                    tenancy.clone(),
                )
                .await
                .map_err(|_| {
                    api_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "The conversation could not be created.",
                    )
                    .into_response()
                })?;
        }
        Ok(Some(meta)) => {
            // Binding a box and appending messages mutate the conversation, so
            // a read-only grant is refused, as for chat.
            crate::server::require_resource_write(
                Ok(Some(meta)),
                auth.caller.as_ref(),
                &format!("conversation '{conversation_id}' not found"),
            )?;
        }
        Err(_) => {
            return Err(api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "The conversation could not be read.",
            )
            .into_response());
        }
    }
    // The node owner's own plan first, when routing picks it: the provider's CLI starts
    // the task in the provider's cloud, so no Box is admitted, created, metered or
    // announced (docs/subscription-cloud-sessions.md §4). A conversation already bound
    // to a Box keeps its Box.
    let mut notices = Vec::new();
    // One prompt at a time per conversation from routing until its Box binding is
    // recorded, so concurrent prompts never start two runs or a run and a Box.
    let routing_guard = crate::server::subscription_cloud::lock_conversation(conversation_id).await;
    let box_bound = super::has_bound_task(conversation_id).await;
    let strict_plan_pin = request.backend.is_some_and(|backend| {
        backend != crate::server::subscription_cloud::CloudTaskBackend::RyuBox
    }) && request.fallback == Some(false);
    if strict_plan_pin && (box_bound || !may_try_plan) {
        return Err(api_error_code(
            StatusCode::CONFLICT,
            "subscription_backend_unavailable",
            "This session asked to run only on your own plan, which cannot take it: the conversation already runs on a Ryu Box, plans are off, or this agent has no plan backend.",
        )
        .into_response());
    }
    let account_pin = match request.account.as_deref() {
        None => None,
        Some(raw) => Some(
            crate::server::subscription_cloud::accounts::parse_pin(raw).ok_or_else(|| {
                api_error_code(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "account must be <provider>:<account id>.",
                )
                .into_response()
            })?,
        ),
    };
    if may_try_plan && !box_bound {
        use crate::server::subscription_cloud::{self as plans, routing::SessionPin};
        let outcome = plans::start_or_fall_back(
            auth,
            plans::RouteRequest {
                owner: &owner,
                conversation_id,
                environment_id: &request.environment_id,
                executor: &runtime.executor,
                agent_id: request.agent_id.as_deref(),
                pin: SessionPin {
                    backend: request.backend,
                    fallback: request.fallback.unwrap_or(true),
                },
                account: account_pin,
                text: &request.text,
            },
        )
        .await
        .map_err(IntoResponse::into_response)?;
        match outcome {
            plans::RouteOutcome::Started { record, notices } => {
                let author = auth.caller.as_ref().map(|caller| caller.user_id.as_str());
                let reply = match (&record.workspace, &record.branch) {
                    (Some(_), Some(branch)) => format!(
                        "Running in {} on your {} plan, on branch {branch}. Follow it in the task panel. This task does not use Ryu credits.",
                        record.backend.cli_name(),
                        record.backend.plan_name(),
                    ),
                    _ => format!(
                        "Sent to {} on your {} plan. Follow it at {}. This task does not use Ryu credits.",
                        record.backend.cli_name(),
                        record.backend.plan_name(),
                        record.url.as_deref().unwrap_or("the provider's site"),
                    ),
                };
                for (role, text, by) in [
                    ("user", request.text.as_str(), author),
                    ("assistant", reply.as_str(), None),
                ] {
                    if state
                        .conversations
                        .append_message_as(
                            conversation_id,
                            role,
                            text,
                            None,
                            by,
                            None,
                            tenancy.clone(),
                        )
                        .await
                        .is_err()
                    {
                        tracing::warn!("Cloud task prompt could not be saved to the conversation");
                    }
                }
                return Ok(PromptAccepted {
                    run: PromptRunAccepted {
                        id: record.external_id.clone().unwrap_or_default(),
                        status: record.status.clone(),
                    },
                    backend: record.backend,
                    subscription: Some(plans::api::run_view(record)),
                    notices,
                });
            }
            plans::RouteOutcome::UseBox { notices: skipped } => notices = skipped,
        }
    }
    if runtime.backend == "box" && !box_gates_passed {
        require_box_gates(auth).await?;
    }
    let environment_id =
        super::validate_requested_binding(auth, conversation_id, Some(&request.environment_id))
            .await
            .map_err(IntoResponse::into_response)?
            .unwrap_or(request.environment_id);
    let context = super::ensure_task_workspace(auth, conversation_id, &environment_id)
        .await
        .map_err(with_retry_after)?;
    drop(routing_guard);
    if context.executor == "ryu" {
        return Err(executor_mismatch().into_response());
    }
    let slot = owned_slot(&owner, conversation_id)
        .await
        .ok_or_else(|| not_ready("The cloud task is not ready.").into_response())?;
    let chatgpt_plan_allowed = context.executor == "codex"
        && crate::server::subscription_cloud::hosted_openai_allowed(auth).await;
    let (id, status) = box_arm::start_managed_run(
        slot,
        state.conversations.clone(),
        tenancy.clone(),
        context.executor,
        &request.text,
        chatgpt_plan_allowed,
    )
    .await
    .map_err(IntoResponse::into_response)?;
    let author = auth.caller.as_ref().map(|caller| caller.user_id.as_str());
    if state
        .conversations
        .append_message_as(
            conversation_id,
            "user",
            &request.text,
            None,
            author,
            None,
            tenancy,
        )
        .await
        .is_err()
    {
        tracing::warn!("Cloud task prompt could not be saved to the conversation");
    }
    Ok(PromptAccepted {
        run: PromptRunAccepted { id, status },
        backend: crate::server::subscription_cloud::CloudTaskBackend::RyuBox,
        subscription: None,
        notices,
    })
}

/// The Box rollout flag and the node's Box credential: env, or the control-plane source
/// a managed node installs (it has no `RYU_SANDBOX_BOX_TOKEN`).
async fn require_box_gates(auth: &ResolvedAuthorization) -> Result<(), Response> {
    environments::require_box_backend_feature(auth)
        .await
        .map_err(IntoResponse::into_response)?;
    if !crate::server::session_box::box_configured().await {
        return Err(api_error_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_backend_unavailable",
            "Ryu Box is not configured on this node.",
        )
        .into_response());
    }
    Ok(())
}

/// An error response; `cloud_task_capacity` also sends `Retry-After`.
fn with_retry_after(error: ApiError) -> Response {
    let retry_after = error.1 .0["error"]["retryAfter"].as_u64();
    let mut response = error.into_response();
    if let Some(seconds) = retry_after {
        if let Ok(value) = axum::http::HeaderValue::from_str(&seconds.to_string()) {
            response.headers_mut().insert("retry-after", value);
        }
    }
    response
}

fn executor_mismatch() -> ApiError {
    api_error_code(
        StatusCode::UNPROCESSABLE_ENTITY,
        "cloud_task_executor_mismatch",
        "This cloud environment runs Ryu. Send prompts from chat.",
    )
}

#[utoipa::path(get,path="/api/cloud-tasks/{conversation_id}/diff",operation_id="get_cloud_task_diff",tag="Cloud environments",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation bound to a personally owned cloud task")),description="Review the changes in a fresh cloud box since setup: per-file insertions and deletions (null for binary files, at most 1000 files) and a patch of at most 786432 bytes, with truncated set when either limit is reached. Saved values are redacted. Requires GatewayRoute and current personal identity; the task must be ready with no active run.",responses((status=200,body=DiffResponse),(status=400,description="Invalid conversation ID"),(status=403,description="Execution authority or identity denied, or cloud_environment_feature_unavailable: the Fresh cloud box preview is not enabled for this account"),(status=404,description="cloud_task_not_found"),(status=409,description="cloud_task_not_ready: not ready, or a run is active"),(status=422,description="cloud_task_no_repository"),(status=503,description="The Box could not read the changes")))]
pub(super) async fn diff(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(conversation_id): Path<String>,
) -> Response {
    match diff_inner(&auth, &conversation_id).await {
        Ok(diff) => Json(diff).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn diff_inner(
    auth: &ResolvedAuthorization,
    conversation_id: &str,
) -> Result<DiffResponse, ApiError> {
    require_capabilities(auth, false)?;
    let owner = environments::owner(auth)?;
    require_conversation_id(conversation_id)?;
    records::lookup(&owner, conversation_id)
        .map_err(|_| bindings_unavailable())?
        .ok_or_else(not_found)?;
    let slot = owned_slot(&owner, conversation_id)
        .await
        .ok_or_else(|| not_ready("The cloud task is not running."))?;
    let (workspace, repo_dir, base_sha, redactions) = {
        let state = lock_briefly(&slot).await?;
        let TaskState::Ready(task) = &*state else {
            return Err(not_ready("The cloud task is not ready."));
        };
        if task.active_run.is_some() || task.finishing {
            return Err(not_ready("Wait for the current run to finish."));
        }
        let (TaskWorkspace::Box(workspace), Some(base_sha), Some(repo_dir)) = (
            &task.workspace,
            &task.base_sha,
            task.context.repository_directories.first(),
        ) else {
            return Err(api_error_code(
                StatusCode::UNPROCESSABLE_ENTITY,
                "cloud_task_no_repository",
                "Change review needs a fresh cloud box with a repository.",
            ));
        };
        (
            workspace.clone(),
            repo_dir.clone(),
            base_sha.clone(),
            task.profile.task_redactions.clone(),
        )
    };
    // Only a box task gets here; reading its changes needs the rollout flag
    // like a bind does.
    environments::require_box_backend_feature(auth).await?;
    let (files, patch, truncated) = box_arm::diff(&workspace, &repo_dir, &base_sha, &redactions)
        .await
        .map_err(|_| {
            api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "The cloud box could not read the changes.",
            )
        })?;
    Ok(DiffResponse {
        base_sha,
        files,
        patch,
        truncated,
    })
}

#[utoipa::path(post,path="/api/cloud-tasks/{conversation_id}/finish",operation_id="finish_cloud_task",tag="Cloud environments",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation bound to a personally owned cloud task")),request_body=FinishRequest,description="Finish a cloud task. Requires GatewayRoute, ToolsExec and current personal identity. Interrupts the Box, commits all changes, and with push set pushes them to a new branch of the primary GitHub repository without force, returning a GitHub compare link. With openPullRequest (requires push) Core itself, not the Box, then opens a GitHub pull request from the pushed branch into the starting branch using the same GitHub credential (pullRequestTitle 1-256 characters, defaulting to the commit message's first line; pullRequestBody at most 65536 characters; draft optional) and returns pullRequest with its url and number; a failed pull request is not an HTTP error, never changes teardown, and returns pullRequest null with pullRequestError auth, already_exists, validation, network or unknown. The default branch is ryu/ followed by the first 8 characters of the conversation ID; a branch must start with a letter or digit, use only letters, digits, '.', '_', '/' and '-' (up to 100 characters), contain no '..', '@{' or '//', not end in '/' or '.lock', and differ from the starting branch. teardown destroy removes the Box after a successful push; a failed push is not an HTTP error and always keeps the Box (pushed false, pushError auth, non_fast_forward, network or unknown). An assistant message summarizing the result is appended. Unknown body fields are rejected.",responses((status=200,body=FinishResponse),(status=400,description="Invalid body or conversation ID"),(status=403,description="Execution authority or identity denied, or cloud_environment_feature_unavailable: push or openPullRequest on a box task when the Fresh cloud box preview is not enabled for this account; finishing without push stays available"),(status=404,description="cloud_task_not_found"),(status=409,description="cloud_task_busy, cloud_task_not_ready, or cloud_task_desktop_routing: push is refused while Route traffic through this computer is on"),(status=422,description="invalid_branch or cloud_task_finish_unsupported: push on a non-box backend, no repository, no GitHub credential, or a pull request requested for a task without a starting branch"),(status=503,description="The Box could not commit the changes")))]
pub(super) async fn finish(
    State(state): State<ServerState>,
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(conversation_id): Path<String>,
    body: axum::body::Bytes,
) -> Response {
    match finish_inner(&state, &auth, &conversation_id, &body).await {
        Ok(finish) => Json(FinishResponse { finish }).into_response(),
        Err(error) => error.into_response(),
    }
}

struct FinishOptions {
    push: bool,
    destroy: bool,
    branch: Option<String>,
    commit_message: String,
    pull_request: Option<box_arm::PullRequestPlan>,
}

fn pull_request_plan(
    request: &FinishRequest,
    commit_message: &str,
) -> Result<Option<box_arm::PullRequestPlan>, ApiError> {
    if !request.open_pull_request {
        if request.pull_request_title.is_some()
            || request.pull_request_body.is_some()
            || request.draft.is_some()
        {
            return Err(bad_request(
                "pullRequestTitle, pullRequestBody and draft require openPullRequest.",
            ));
        }
        return Ok(None);
    }
    if !request.push {
        return Err(bad_request("openPullRequest requires push."));
    }
    let title = match &request.pull_request_title {
        Some(title)
            if !title.trim().is_empty()
                && title.chars().count() <= MAX_PULL_REQUEST_TITLE_CHARS =>
        {
            title.clone()
        }
        Some(_) => return Err(bad_request("pullRequestTitle must be 1-256 characters.")),
        None => box_arm::default_pull_request_title(commit_message),
    };
    let body = match &request.pull_request_body {
        Some(body) if body.chars().count() > MAX_PULL_REQUEST_BODY_CHARS => {
            return Err(bad_request(
                "pullRequestBody must be at most 65536 characters.",
            ))
        }
        Some(body) => body.clone(),
        None => DEFAULT_PULL_REQUEST_BODY.to_owned(),
    };
    Ok(Some(box_arm::PullRequestPlan {
        title,
        body,
        draft: request.draft.unwrap_or(false),
    }))
}

fn finish_options(
    request: FinishRequest,
    conversation_id: &str,
    base_branch: Option<&str>,
) -> Result<FinishOptions, ApiError> {
    let destroy = match request.teardown.as_str() {
        "destroy" => true,
        "keep" => false,
        _ => return Err(bad_request("teardown must be destroy or keep.")),
    };
    let commit_message = match request.commit_message.clone() {
        Some(message)
            if !message.trim().is_empty()
                && message.chars().count() <= MAX_COMMIT_MESSAGE_CHARS =>
        {
            message
        }
        Some(_) => return Err(bad_request("commitMessage must be 1-4096 characters.")),
        None => DEFAULT_COMMIT_MESSAGE.to_owned(),
    };
    let pull_request = pull_request_plan(&request, &commit_message)?;
    let branch = if request.push || request.branch.is_some() {
        let requested = request
            .branch
            .unwrap_or_else(|| box_arm::default_branch(conversation_id));
        Some(
            box_arm::validate_branch(&requested, base_branch).map_err(|error| {
                api_error_code(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "invalid_branch",
                    &error.to_string(),
                )
            })?,
        )
    } else {
        None
    };
    Ok(FinishOptions {
        push: request.push,
        destroy,
        branch,
        commit_message,
        pull_request,
    })
}

async fn finish_inner(
    state: &ServerState,
    auth: &ResolvedAuthorization,
    conversation_id: &str,
    body: &[u8],
) -> Result<box_arm::FinishSummary, ApiError> {
    require_execution(auth)?;
    require_conversation_id(conversation_id)?;
    let request: FinishRequest = parse_body(body)?;
    let owner = environments::owner(auth)?;
    records::lookup(&owner, conversation_id)
        .map_err(|_| bindings_unavailable())?
        .ok_or_else(not_found)?;
    let slot = owned_slot(&owner, conversation_id)
        .await
        .ok_or_else(|| not_ready("The cloud task is not running."))?;
    let routing = crate::local_egress::entry::routing_active().await;
    let (plan, options, executor) = {
        let mut guard = lock_briefly(&slot).await?;
        let TaskState::Ready(task) = &mut *guard else {
            return Err(not_ready("The cloud task is not ready."));
        };
        if task.expires_at <= now().unwrap_or(u64::MAX) {
            return Err(not_ready("The cloud task expired."));
        }
        if task.active_run.is_some() || task.finishing {
            return Err(box_arm::busy());
        }
        let options = finish_options(request, conversation_id, task.base_branch.as_deref())?;
        let is_box = matches!(task.workspace, TaskWorkspace::Box(_));
        if options.push {
            if let Some(refusal) = box_arm::desktop_routing_refusal(true, routing) {
                return Err(refusal);
            }
            if !is_box {
                return Err(unsupported(
                    "Pushing a branch is available for fresh cloud box tasks.",
                ));
            }
            if task.base_sha.is_none() || task.profile.primary_repository.is_none() {
                return Err(unsupported("This cloud task has no repository to push."));
            }
            if task.profile.git_push_token.is_none() {
                return Err(unsupported(
                    "Bind a GitHub token (GITHUB_TOKEN or GH_TOKEN) to this environment to push.",
                ));
            }
            if options.pull_request.is_some() && task.base_branch.is_none() {
                return Err(unsupported(
                    "A pull request needs a starting branch; this task started from a detached commit.",
                ));
            }
            // Pushing (and opening a pull request) reaches GitHub with the
            // environment's credential, so it needs the rollout flag. Finishing
            // without push stays open so a revoked user can still tear down.
            super::require_workspace_feature(auth, &task.workspace).await?;
        }
        let plan = match &task.workspace {
            TaskWorkspace::Box(workspace) => Some(box_arm::FinishPlan {
                workspace: workspace.clone(),
                repo_dir: task.context.repository_directories.first().cloned(),
                base_sha: task.base_sha.clone(),
                base_branch: task.base_branch.clone(),
                branch: options.branch.clone(),
                commit_message: options.commit_message.clone(),
                push: options.push,
                token: task.profile.git_push_token.clone(),
                repository: task.profile.primary_repository.clone(),
                pull_request: options.pull_request.clone(),
            }),
            _ => None,
        };
        task.finishing = true;
        (plan, options, task.context.executor.clone())
    };
    // A dropped request (client gone mid-push) must not leave the task
    // `finishing` forever; disarmed once the outcome is recorded below.
    let mut finishing = FinishingReset(Some(slot.clone()));
    let outcome = match plan {
        Some(plan) => box_arm::finish(plan).await,
        None => Ok(box_arm::FinishSummary {
            branch: None,
            head_sha: None,
            pushed: false,
            push_error: None,
            compare_url: None,
            pull_request: None,
            pull_request_error: None,
            teardown: "kept".into(),
            files: 0,
            insertions: 0,
            deletions: 0,
        }),
    };
    let mut guard = slot.lock().await;
    let TaskState::Ready(task) = &mut *guard else {
        // Stopped or expired while finishing; the Box is already gone.
        return Err(not_ready("The cloud task stopped while finishing."));
    };
    task.finishing = false;
    finishing.0 = None;
    let mut summary = outcome.map_err(|_| {
        api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "The cloud box could not commit the changes. The box was kept.",
        )
    })?;
    // Unpushed work is never destroyed by a failed push.
    let destroy = options.destroy && (summary.pushed || !options.push);
    if destroy && task.destroy().await.is_ok() {
        summary.teardown = "destroyed".into();
        *guard = TaskState::Stopped;
        if records::mark(&owner, conversation_id, "stopped", None).is_err() {
            tracing::warn!("Cloud task lifecycle persistence failed after finish");
        }
    } else {
        task.finish = Some(summary.clone());
    }
    drop(guard);
    box_arm::remember_finish(&owner, conversation_id, &summary);
    if state
        .conversations
        .append_message_as(
            conversation_id,
            "assistant",
            &box_arm::finish_message(&summary),
            Some(&format!("cloud:{executor}")),
            None,
            None,
            crate::server::caller_tenancy(&auth.caller),
        )
        .await
        .is_err()
    {
        tracing::warn!("Cloud task finish summary could not be saved to the conversation");
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn owner_auth(user: &str) -> ResolvedAuthorization {
        use crate::authorization::*;
        ResolvedAuthorization {
            context: AuthorizationContext {
                credential: CredentialKind::ManagedUserJwt,
                principal: Principal::User {
                    subject_id: user.into(),
                },
                capabilities: CapabilitySet::new([Capability::GatewayRoute, Capability::ToolsExec]),
                constraints: GrantConstraints::default(),
                issued_at: 0,
                expires_at: None,
            },
            bindings: RequestBindings::default(),
            caller: None,
            verified_user_jwt: None,
        }
    }

    #[tokio::test]
    async fn cloud_task_status_is_not_found_for_an_unknown_owner_or_conversation() {
        let auth = owner_auth(&format!("cloud-status-{}", uuid::Uuid::new_v4().simple()));
        let error = status_for(&auth, "conversation-without-a-task")
            .await
            .err()
            .expect("unknown task must not be found");
        assert_eq!(error.0, StatusCode::NOT_FOUND);
        assert_eq!(error.1 .0["error"]["code"], "cloud_task_not_found");
    }

    #[test]
    fn cloud_task_finish_options_validate_branch_teardown_and_message() {
        let request = |body: Value| serde_json::from_value::<FinishRequest>(body).unwrap();
        let options = finish_options(
            request(serde_json::json!({"push":true,"teardown":"destroy"})),
            "abcdefgh1234",
            Some("main"),
        )
        .unwrap();
        assert_eq!(options.branch.as_deref(), Some("ryu/abcdefgh"));
        assert!(options.destroy && options.push);
        assert_eq!(options.commit_message, DEFAULT_COMMIT_MESSAGE);
        let error = finish_options(
            request(serde_json::json!({"push":true,"branch":"main","teardown":"keep"})),
            "abcdefgh",
            Some("main"),
        )
        .err()
        .unwrap();
        assert_eq!(error.1 .0["error"]["code"], "invalid_branch");
        assert!(finish_options(
            request(serde_json::json!({"push":false,"teardown":"later"})),
            "abcdefgh",
            None
        )
        .is_err());
        assert!(serde_json::from_value::<FinishRequest>(
            serde_json::json!({"push":false,"teardown":"keep","force":true})
        )
        .is_err());
        let options = finish_options(
            request(serde_json::json!({"push":true,"teardown":"keep","openPullRequest":true,"draft":true})),
            "abcdefgh",
            Some("main"),
        )
        .unwrap();
        let plan = options.pull_request.expect("pull request plan");
        assert_eq!(plan.title, DEFAULT_COMMIT_MESSAGE);
        assert_eq!(plan.body, DEFAULT_PULL_REQUEST_BODY);
        assert!(plan.draft);
        let options = finish_options(
            request(serde_json::json!({"push":true,"teardown":"keep","openPullRequest":true,"pullRequestTitle":"Fix it","pullRequestBody":""})),
            "abcdefgh",
            Some("main"),
        )
        .unwrap();
        let plan = options.pull_request.unwrap();
        assert_eq!(
            (plan.title.as_str(), plan.body.as_str(), plan.draft),
            ("Fix it", "", false)
        );
        assert!(finish_options(
            request(serde_json::json!({"push":true,"teardown":"keep"})),
            "abcdefgh",
            Some("main"),
        )
        .unwrap()
        .pull_request
        .is_none());
        for invalid in [
            serde_json::json!({"push":false,"teardown":"keep","openPullRequest":true}),
            serde_json::json!({"push":true,"teardown":"keep","openPullRequest":true,"pullRequestTitle":" "}),
            serde_json::json!({"push":true,"teardown":"keep","openPullRequest":true,"pullRequestTitle":"t".repeat(257)}),
            serde_json::json!({"push":true,"teardown":"keep","openPullRequest":true,"pullRequestBody":"b".repeat(65_537)}),
            serde_json::json!({"push":true,"teardown":"keep","draft":true}),
            serde_json::json!({"push":true,"teardown":"keep","pullRequestTitle":"t"}),
        ] {
            let error = finish_options(request(invalid.clone()), "abcdefgh", Some("main"))
                .err()
                .unwrap_or_else(|| panic!("{invalid} must be rejected"));
            assert_eq!(error.0, StatusCode::BAD_REQUEST);
        }
        assert!(finish_options(
            request(serde_json::json!({"push":true,"teardown":"keep","openPullRequest":true,"pullRequestTitle":"t".repeat(256),"pullRequestBody":"b".repeat(65_536)})),
            "abcdefgh",
            Some("main"),
        )
        .is_ok());
        assert!(serde_json::from_value::<PromptRequest>(
            serde_json::json!({"environmentId":"e","text":"t","cwd":"/"})
        )
        .is_err());
    }
}
