//! Versioned, durable agent-harness API.
//!
//! The existing conversation, ACP, approval, worktree, and trace paths remain
//! the execution owners. This module composes them behind one public session/run
//! contract so Desktop, Web, CLI, channels, and external SDKs can start a run,
//! reconnect by cursor, and inspect the same lifecycle.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{LazyLock, Mutex};

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Extension, Json, Router,
};
use futures_util::StreamExt;
use ryu_agent_contracts::{
    ApprovalMode, ApprovalOption, ExecutionProfile, ExecutionProfileKind, HarnessRun,
    HarnessSession, MultitaskStrategy, NetworkMode, RunEvent, RunEventEnvelope, RunStatus,
    SandboxMode, StartRunRequest, PROTOCOL_VERSION,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::conversations::Session;
use super::ServerState;
use crate::runnable::RunnableKind;
use crate::sidecar::adapters::{ChatStreamRequest, UiContent, UiMessage};

/// Mount the stable `/api/harness/*` projection. All mutating operations still
/// pass through the same protected Core router and resource ACL middleware as
/// the legacy chat/session endpoints.
pub(crate) fn routes() -> Router<ServerState> {
    Router::new()
        .route(
            "/api/harness/sessions",
            post(create_harness_session_handler),
        )
        .route(
            "/api/harness/sessions/:id",
            get(get_harness_session_handler),
        )
        .route(
            "/api/harness/sessions/:id/children",
            get(list_child_harness_sessions_handler),
        )
        .route(
            "/api/harness/sessions/:id/native",
            put(bind_native_session_handler),
        )
        .route(
            "/api/harness/sessions/:id/runs",
            get(list_harness_runs_handler).post(start_harness_run_handler),
        )
        .route("/api/harness/runs/:id", get(get_harness_run_handler))
        .route(
            "/api/harness/runs/:id/events",
            get(harness_run_events_handler),
        )
        .route(
            "/api/harness/runs/:id/cancel",
            post(cancel_harness_run_handler),
        )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateHarnessSessionBody {
    runnable_id: String,
    runnable_kind: String,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    execution_profile: Option<ExecutionProfile>,
    #[serde(default)]
    parent_session_id: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub(crate) struct HarnessEventsQuery {
    #[serde(default)]
    after: Option<u64>,
}

fn parse_runnable_kind(raw: &str) -> Option<RunnableKind> {
    match raw.trim() {
        "agent" => Some(RunnableKind::Agent),
        "workflow" => Some(RunnableKind::Workflow),
        "tool" => Some(RunnableKind::Tool),
        "skill" => Some(RunnableKind::Skill),
        _ => None,
    }
}

fn required_permission(kind: RunnableKind) -> &'static str {
    match kind {
        RunnableKind::Workflow => crate::identity_verify::permissions::WORKFLOW_RUN,
        RunnableKind::Agent | RunnableKind::Tool | RunnableKind::Skill => {
            crate::identity_verify::permissions::AGENT_RUN
        }
        RunnableKind::Companion
        | RunnableKind::Channel
        | RunnableKind::Engine
        | RunnableKind::Policy => crate::identity_verify::permissions::AGENT_RUN,
    }
}

fn profile_supported(profile: &ExecutionProfile) -> Result<(), &'static str> {
    match profile.kind {
        ExecutionProfileKind::Local | ExecutionProfileKind::Worktree => {}
        ExecutionProfileKind::Remote => {
            return Err("remote execution is not available on this Core node");
        }
        ExecutionProfileKind::Cloud => {
            return Err("cloud execution is not available on this Core node");
        }
    }
    if let Some(cwd) = profile.cwd.as_deref() {
        let path = std::path::Path::new(cwd);
        if !path.is_dir() {
            return Err("the execution profile requires an existing directory for cwd");
        }
        if profile.kind == ExecutionProfileKind::Worktree
            && !ryu_workspace::worktree::is_git_repo(path)
        {
            return Err("the worktree execution profile requires a Git repository");
        }
    }
    if profile.kind == ExecutionProfileKind::Worktree && profile.cwd.is_none() {
        return Err("the worktree execution profile requires cwd");
    }
    if profile.network != NetworkMode::Inherit {
        return Err("this node requires the Gateway's inherited network policy");
    }
    if profile.sandbox != SandboxMode::Inherit {
        return Err("this node requires the runtime's inherited sandbox policy");
    }
    if profile.approval != ApprovalMode::Inherit {
        return Err("this node requires the runtime's inherited approval policy");
    }
    Ok(())
}

fn json_error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

#[utoipa::path(
    post,
    path = "/api/harness/sessions",
    tag = "Harness",
    summary = "Create a durable harness session",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(crate) async fn create_harness_session_handler(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<CreateHarnessSessionBody>,
) -> Response {
    let runnable_id = body.runnable_id.trim();
    if runnable_id.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "runnableId is required");
    }
    let Some(kind) = parse_runnable_kind(&body.runnable_kind) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "runnableKind must be agent, workflow, tool, or skill",
        );
    };
    if super::enforce_permission(&state, &caller, required_permission(kind))
        .await
        .is_err()
    {
        return json_error(StatusCode::FORBIDDEN, "insufficient run permission");
    }
    if let Some(parent_id) = body.parent_session_id.as_deref() {
        match state.conversations.get_session(parent_id).await {
            Ok(Some(parent)) => {
                if let Err(response) = super::require_resource_write(
                    state
                        .conversations
                        .get_access_meta(&parent.conversation_id)
                        .await,
                    caller.as_ref(),
                    "parent session not found",
                ) {
                    return response;
                }
            }
            Ok(None) => return json_error(StatusCode::NOT_FOUND, "parent session not found"),
            Err(error) => {
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("parent session lookup failed: {error}"),
                );
            }
        }
    }

    let profile = body.execution_profile.unwrap_or_default();
    if let Err(message) = profile_supported(&profile) {
        return json_error(StatusCode::NOT_IMPLEMENTED, message);
    }
    let agent_id = body
        .agent_id
        .as_deref()
        .or_else(|| (kind == RunnableKind::Agent).then_some(runnable_id));
    let session = match state
        .conversations
        .create_session(
            runnable_id,
            kind,
            agent_id,
            body.title.as_deref(),
            super::caller_tenancy(&caller),
        )
        .await
    {
        Ok(session) => session,
        Err(error) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to create harness session: {error}"),
            );
        }
    };
    if let Err(error) = state
        .conversations
        .set_session_execution_profile(&session.id, &profile, body.parent_session_id.as_deref())
        .await
    {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to save execution profile: {error}"),
        );
    }
    match state.conversations.get_harness_session(&session.id).await {
        Ok(Some(session)) => Json(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "session": session,
        }))
        .into_response(),
        Ok(None) => json_error(StatusCode::INTERNAL_SERVER_ERROR, "session disappeared"),
        Err(error) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to load created session: {error}"),
        ),
    }
}

async fn load_harness_session(
    state: &ServerState,
    session_id: &str,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    write: bool,
) -> Result<HarnessSession, Response> {
    let legacy = state
        .conversations
        .get_session(session_id)
        .await
        .map_err(|error| json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "session not found"))?;
    let access = state
        .conversations
        .get_access_meta(&legacy.conversation_id)
        .await;
    let access_result = if write {
        super::require_resource_write(access, caller.as_ref(), "session not found")
    } else {
        super::require_resource_read(access, caller.as_ref(), "session not found")
    };
    if let Err(response) = access_result {
        return Err(response);
    }
    state
        .conversations
        .get_harness_session(session_id)
        .await
        .map_err(|error| json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "session not found"))
}

#[utoipa::path(
    get,
    path = "/api/harness/sessions/{id}",
    tag = "Harness",
    summary = "Get a durable harness session",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(crate) async fn get_harness_session_handler(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(session_id): Path<String>,
) -> Response {
    match load_harness_session(&state, &session_id, &caller, false).await {
        Ok(session) => Json(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "session": session,
        }))
        .into_response(),
        Err(response) => response,
    }
}

#[utoipa::path(
    get,
    path = "/api/harness/sessions/{id}/children",
    tag = "Harness",
    summary = "List a session's child sessions",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(crate) async fn list_child_harness_sessions_handler(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(session_id): Path<String>,
) -> Response {
    if let Err(response) = load_harness_session(&state, &session_id, &caller, false).await {
        return response;
    }
    match state
        .conversations
        .list_child_harness_sessions(&session_id)
        .await
    {
        Ok(sessions) => Json(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "sessions": sessions,
        }))
        .into_response(),
        Err(error) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to list child sessions: {error}"),
        ),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BindNativeSessionBody {
    native_session_id: String,
}

#[utoipa::path(
    put,
    path = "/api/harness/sessions/{id}/native",
    tag = "Harness",
    summary = "Bind an external runtime session id",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(crate) async fn bind_native_session_handler(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(session_id): Path<String>,
    Json(body): Json<BindNativeSessionBody>,
) -> Response {
    if let Err(response) = load_harness_session(&state, &session_id, &caller, true).await {
        return response;
    }
    let native_session_id = body.native_session_id.trim();
    if native_session_id.is_empty() || native_session_id.len() > 512 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "nativeSessionId must be 1..=512 bytes",
        );
    }
    match state
        .conversations
        .set_session_native_id(&session_id, native_session_id)
        .await
    {
        Ok(true) => match state.conversations.get_harness_session(&session_id).await {
            Ok(Some(session)) => Json(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "session": session,
            }))
            .into_response(),
            Ok(None) => json_error(StatusCode::NOT_FOUND, "session not found"),
            Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        },
        Ok(false) => json_error(StatusCode::NOT_FOUND, "session not found"),
        Err(error) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to bind native session: {error}"),
        ),
    }
}

#[utoipa::path(
    get,
    path = "/api/harness/sessions/{id}/runs",
    tag = "Harness",
    summary = "List runs in a harness session",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(crate) async fn list_harness_runs_handler(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(session_id): Path<String>,
) -> Response {
    if let Err(response) = load_harness_session(&state, &session_id, &caller, false).await {
        return response;
    }
    match state.conversations.list_harness_runs(&session_id).await {
        Ok(runs) => Json(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "runs": runs,
        }))
        .into_response(),
        Err(error) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to list harness runs: {error}"),
        ),
    }
}

#[utoipa::path(
    post,
    path = "/api/harness/sessions/{id}/runs",
    tag = "Harness",
    summary = "Start a durable harness run",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 202, description = "Accepted", body = serde_json::Value))
)]
pub(crate) async fn start_harness_run_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Extension(super::VerifiedUserJwt(user_jwt)): Extension<super::VerifiedUserJwt>,
    authorization: Option<Extension<super::ResolvedAuthorization>>,
    Path(session_id): Path<String>,
    Json(body): Json<StartRunRequest>,
) -> Response {
    let Some(legacy_session) = (match state.conversations.get_session(&session_id).await {
        Ok(session) => session,
        Err(error) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("session lookup failed: {error}"),
            );
        }
    }) else {
        return json_error(StatusCode::NOT_FOUND, "session not found");
    };
    if super::enforce_permission(
        &state,
        &caller,
        required_permission(legacy_session.runnable_kind),
    )
    .await
    .is_err()
    {
        return json_error(StatusCode::FORBIDDEN, "insufficient run permission");
    }
    if let Err(response) = super::require_resource_write(
        state
            .conversations
            .get_access_meta(&legacy_session.conversation_id)
            .await,
        caller.as_ref(),
        "session not found",
    ) {
        return response;
    }
    let profile = body
        .execution_profile
        .clone()
        .unwrap_or_else(|| legacy_session.execution_profile.clone());
    if let Err(message) = profile_supported(&profile) {
        return json_error(StatusCode::NOT_IMPLEMENTED, message);
    }
    if !matches!(
        legacy_session.runnable_kind,
        RunnableKind::Agent | RunnableKind::Workflow
    ) {
        return json_error(
            StatusCode::NOT_IMPLEMENTED,
            "this runnable kind has no harness chat adapter on this node",
        );
    }
    // Validate the input shape up front for every strategy so a queued run
    // cannot be accepted now and fail only when it is promoted.
    let messages = match input_messages(&body.input) {
        Ok(messages) => messages,
        Err(message) => return json_error(StatusCode::BAD_REQUEST, message),
    };
    let started = match state
        .conversations
        .start_harness_run(&session_id, &body)
        .await
    {
        Ok(started) => started,
        Err(error) => {
            let error_text = error.to_string();
            let status = if error_text.contains("resume_run_id")
                || error_text.contains("idempotency_key")
                || error_text.contains("active run")
                || error_text.contains("queued run")
            {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            };
            return json_error(status, error_text);
        }
    };
    let context = DispatchContext {
        caller,
        user_jwt,
        headers,
        authorization,
    };
    if started.created {
        if started.run.status == RunStatus::Running {
            spawn_dispatch(
                state.clone(),
                started.run.id.clone(),
                legacy_session.clone(),
                messages,
                profile,
                context,
            );
        } else {
            remember_queued_context(&started.run.id, context);
            if let Some(displaced) = started.displaced_run_id.as_deref() {
                let strategy = body.multitask_strategy.unwrap_or_default();
                stop_displaced_run(
                    &state,
                    displaced,
                    &legacy_session,
                    &started.run.id,
                    strategy,
                )
                .await;
            }
            drive_session_queue(state.clone(), session_id.clone()).await;
        }
    }
    let created = started.created;
    let status = if created {
        StatusCode::ACCEPTED
    } else {
        StatusCode::OK
    };
    let events_url = format!("/api/harness/runs/{}/events", started.run.id);
    let queued = started.run.status == RunStatus::Pending;
    let run = match state.conversations.get_harness_run(&started.run.id).await {
        Ok(Some(run)) => run,
        _ => started.run,
    };
    (
        status,
        Json(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "created": created,
            "queued": queued,
            "displacedRunId": started.displaced_run_id,
            "run": run,
            "eventsUrl": events_url,
        })),
    )
        .into_response()
}

/// The verified request context a run is dispatched with. A queued run keeps
/// its submitter's context in memory until it is promoted, so it runs with the
/// author's permissions rather than node authority.
#[derive(Clone)]
struct DispatchContext {
    caller: Option<crate::identity_verify::VerifiedCaller>,
    user_jwt: Option<String>,
    headers: HeaderMap,
    authorization: Option<Extension<super::ResolvedAuthorization>>,
}

impl DispatchContext {
    /// A detached context for a node-owned session whose queued run outlived
    /// the process that accepted it. Mirrors boot auto-resume, which also runs
    /// only untenanted conversations without a caller.
    fn detached() -> Self {
        Self {
            caller: None,
            user_jwt: None,
            headers: HeaderMap::new(),
            authorization: None,
        }
    }
}

/// Runs whose dispatch task is still draining a stream, per session. The queue
/// is only advanced once every task of the session has ended, so a canceled
/// run whose turn is still unwinding never overlaps the run that replaces it.
/// Keyed by run (not only session) so a task that ends without dispatching
/// (its run was closed before it started) cannot clear the marker of the run
/// that replaced it.
static LIVE_DISPATCH: LazyLock<Mutex<HashMap<String, HashSet<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Request contexts of runs accepted into a session queue by this process.
static QUEUED_CONTEXTS: LazyLock<Mutex<HashMap<String, DispatchContext>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn session_has_live_dispatch(session_id: &str) -> bool {
    LIVE_DISPATCH
        .lock()
        .map(|live| live.get(session_id).is_some_and(|runs| !runs.is_empty()))
        .unwrap_or(false)
}

fn run_has_live_dispatch(session_id: &str, run_id: &str) -> bool {
    LIVE_DISPATCH
        .lock()
        .map(|live| {
            live.get(session_id)
                .is_some_and(|runs| runs.contains(run_id))
        })
        .unwrap_or(false)
}

fn mark_live_dispatch(session_id: &str, run_id: &str) {
    if let Ok(mut live) = LIVE_DISPATCH.lock() {
        live.entry(session_id.to_owned())
            .or_default()
            .insert(run_id.to_owned());
    }
}

fn clear_live_dispatch(session_id: &str, run_id: &str) {
    if let Ok(mut live) = LIVE_DISPATCH.lock() {
        if let Some(runs) = live.get_mut(session_id) {
            runs.remove(run_id);
            if runs.is_empty() {
                live.remove(session_id);
            }
        }
    }
}

fn remember_queued_context(run_id: &str, context: DispatchContext) {
    if let Ok(mut contexts) = QUEUED_CONTEXTS.lock() {
        contexts.insert(run_id.to_owned(), context);
    }
}

fn take_queued_context(run_id: &str) -> Option<DispatchContext> {
    QUEUED_CONTEXTS
        .lock()
        .ok()
        .and_then(|mut contexts| contexts.remove(run_id))
}

/// Mark the session live, dispatch the run, then advance the session queue
/// when the run's stream has fully drained.
fn spawn_dispatch(
    state: ServerState,
    run_id: String,
    session: Session,
    messages: Vec<UiMessage>,
    profile: ExecutionProfile,
    context: DispatchContext,
) {
    mark_live_dispatch(&session.id, &run_id);
    tokio::spawn(async move {
        let session_id = session.id.clone();
        let live_run_id = run_id.clone();
        // A cancel can close the run between its creation and this task; a
        // closed run is never dispatched.
        let still_open = matches!(
            state.conversations.get_harness_run(&run_id).await,
            Ok(Some(ref run)) if !run.status.is_terminal()
        );
        if still_open {
            dispatch_harness_run(
                state.clone(),
                run_id,
                session,
                messages,
                profile,
                context.caller,
                context.user_jwt,
                context.headers,
                context.authorization,
            )
            .await;
        }
        clear_live_dispatch(&session_id, &live_run_id);
        drive_session_queue(state, session_id).await;
    });
}

/// Start the session's next queued run when nothing is live. Safe to call
/// from any path: the store promotes at most one run while none is active, and
/// a session with a draining dispatch task is left for that task to advance.
fn drive_session_queue(
    state: ServerState,
    session_id: String,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(async move {
        loop {
            if session_has_live_dispatch(&session_id) {
                return;
            }
            let promoted = match state
                .conversations
                .promote_next_harness_run(&session_id)
                .await
            {
                Ok(Some(promoted)) => promoted,
                Ok(None) => return,
                Err(error) => {
                    tracing::warn!(session_id, "harness queue promotion failed: {error:#}");
                    return;
                }
            };
            let run_id = promoted.run.id.clone();
            if promoted.removed_messages > 0 {
                tracing::info!(
                    run_id,
                    removed = promoted.removed_messages,
                    "harness rollback removed the displaced run's turns"
                );
            }
            match prepare_promoted_dispatch(&state, &session_id, &promoted).await {
                Ok((session, messages, context)) => {
                    spawn_dispatch(
                        state.clone(),
                        run_id,
                        session,
                        messages,
                        promoted.run.execution_profile.clone(),
                        context,
                    );
                    return;
                }
                Err(reason) => {
                    let _ = state
                        .conversations
                        .finish_harness_run(&run_id, RunStatus::Failed, Some(&reason), None)
                        .await;
                    // Keep draining: the next queued run may still be runnable.
                }
            }
        }
    })
}

async fn prepare_promoted_dispatch(
    state: &ServerState,
    session_id: &str,
    promoted: &super::conversations::PromotedHarnessRun,
) -> Result<(Session, Vec<UiMessage>, DispatchContext), String> {
    let context = take_queued_context(&promoted.run.id);
    let session = state
        .conversations
        .get_session(session_id)
        .await
        .map_err(|error| format!("session lookup failed: {error}"))?
        .ok_or_else(|| "session not found".to_owned())?;
    let context = match context {
        Some(context) => context,
        None => {
            if conversation_is_attributed(state, &promoted.conversation_id).await {
                return Err(QUEUED_AUTHOR_LOST.to_owned());
            }
            DispatchContext::detached()
        }
    };
    let messages = input_messages(&promoted.input).map_err(str::to_owned)?;
    Ok((session, messages, context))
}

/// Failure recorded on a queued run of a person's or org's session that a
/// restart separated from its author's verified credentials.
const QUEUED_AUTHOR_LOST: &str =
    "queued run lost its author's credentials when Core restarted; submit it again";

async fn conversation_is_attributed(state: &ServerState, conversation_id: &str) -> bool {
    // Fail closed: an unreadable tenancy is treated as attributed so a queued
    // run never falls back to node authority by accident.
    match state.conversations.get_access_meta(conversation_id).await {
        Ok(Some(meta)) => meta.owner_user_id.is_some() || meta.org_id.is_some(),
        Ok(None) => false,
        Err(_) => true,
    }
}

/// Stop the run an `interrupt`/`rollback` request displaces. The stop uses the
/// same cancellation seam as `POST /api/harness/runs/:id/cancel`; the turn
/// ends at its next cancellation point and its partial transcript stays (a
/// rollback removes it when the replacement run is promoted).
async fn stop_displaced_run(
    state: &ServerState,
    displaced_run_id: &str,
    session: &Session,
    replacement_run_id: &str,
    strategy: MultitaskStrategy,
) {
    let reason = format!(
        "{} by run {replacement_run_id}",
        match strategy {
            MultitaskStrategy::Rollback => "rolled back",
            _ => "interrupted",
        }
    );
    if !run_has_live_dispatch(&session.id, displaced_run_id) {
        // Nothing is draining this run (it outlived its task, or its task has
        // not started yet and will skip a closed run), so close it now and let
        // the queue advance immediately.
        let _ = state
            .conversations
            .finish_harness_run(displaced_run_id, RunStatus::Canceled, Some(&reason), None)
            .await;
        return;
    }
    let durable = crate::sidecar::adapters::live_turn::is_cancellable(&session.conversation_id);
    if durable {
        let _ = state
            .conversations
            .finish_harness_run(displaced_run_id, RunStatus::Canceled, Some(&reason), None)
            .await;
    }
    let cancelled = super::cancel_conversation_turn(&session.conversation_id);
    if cancelled && !durable {
        let _ = state
            .conversations
            .finish_harness_run(displaced_run_id, RunStatus::Canceled, Some(&reason), None)
            .await;
    }
}

/// Drain the queues a restart left behind. Runs of node-owned sessions are
/// dispatched without a caller (as boot auto-resume does); runs of a person's
/// or org's session fail with [`QUEUED_AUTHOR_LOST`] because their verified
/// credentials did not survive the restart.
pub(crate) async fn resume_queued_harness_runs(state: ServerState) {
    let sessions = match state
        .conversations
        .list_sessions_with_queued_harness_runs()
        .await
    {
        Ok(sessions) => sessions,
        Err(error) => {
            tracing::warn!("harness queue resume: listing queued sessions failed: {error:#}");
            return;
        }
    };
    for queued in sessions {
        drive_session_queue(state.clone(), queued.session_id).await;
    }
}

fn input_messages(input: &Value) -> Result<Vec<UiMessage>, &'static str> {
    if let Some(messages) = input.get("messages") {
        return serde_json::from_value(messages.clone())
            .map_err(|_| "input.messages must be an array of chat messages");
    }
    if input.is_array() {
        return serde_json::from_value(input.clone())
            .map_err(|_| "input must be an array of chat messages");
    }
    if let Some(prompt) = input.get("prompt").and_then(Value::as_str) {
        if prompt.trim().is_empty() {
            return Err("input.prompt must not be empty");
        }
        return Ok(vec![UiMessage {
            metadata: None,
            role: "user".to_owned(),
            content: UiContent::Text(prompt.to_owned()),
            parts: Vec::new(),
        }]);
    }
    Err("input must contain messages or prompt")
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_harness_run(
    state: ServerState,
    run_id: String,
    session: Session,
    messages: Vec<UiMessage>,
    profile: ExecutionProfile,
    caller: Option<crate::identity_verify::VerifiedCaller>,
    user_jwt: Option<String>,
    headers: HeaderMap,
    authorization: Option<Extension<super::ResolvedAuthorization>>,
) {
    let mut request = ChatStreamRequest {
        messages,
        conversation_id: Some(session.conversation_id.clone()),
        session_id: Some(session.id.clone()),
        agent_id: (session.runnable_kind == RunnableKind::Agent)
            .then_some(session.runnable_id.clone()),
        workflow_id: (session.runnable_kind == RunnableKind::Workflow)
            .then_some(session.runnable_id.clone()),
        cwd: profile.cwd.clone(),
        workspace_folders: profile.cwd.clone().into_iter().collect(),
        worktree_isolation: profile.kind == ExecutionProfileKind::Worktree,
        worktree_branch: profile.worktree_branch.clone(),
        persist: true,
        ..Default::default()
    };
    // The internal chat handler stamps the verified caller/JWT itself. The
    // explicit values here are intentionally not deserialized from the public
    // harness body.
    request.author_user_id = caller.as_ref().map(|value| value.user_id.clone());
    request.verified_caller = caller.clone();
    request.user_jwt = user_jwt.clone();

    let response = super::chat_stream(
        State(state.clone()),
        headers,
        Extension(caller),
        Extension(super::VerifiedUserJwt(user_jwt)),
        authorization,
        Json(request),
    )
    .await;
    if !response.status().is_success() {
        let _ = state
            .conversations
            .finish_harness_run(
                &run_id,
                RunStatus::Failed,
                Some("chat dispatch was rejected"),
                None,
            )
            .await;
        return;
    }

    let mut stream = response.into_body().into_data_stream();
    let mut buffer = String::new();
    let mut output = String::new();
    let mut tool_names = std::collections::HashMap::new();
    let mut failure: Option<String> = None;
    let mut saw_done = false;
    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(bytes) => bytes,
            Err(error) => {
                failure = Some(error.to_string());
                break;
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        while let Some((payload, remaining)) = take_sse_payload(&buffer) {
            buffer = remaining;
            if payload == "[DONE]" {
                saw_done = true;
                continue;
            }
            let Ok(frame) = serde_json::from_str::<Value>(&payload) else {
                continue;
            };
            if let Some(delta) = frame.get("delta").and_then(Value::as_str) {
                output.push_str(delta);
            }
            if frame.get("type").and_then(Value::as_str) == Some("error") {
                failure = frame
                    .get("errorText")
                    .or_else(|| frame.get("error"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| Some("chat stream failed".to_owned()));
            }
            if let Some(event) = harness_event_from_ui_frame(&frame, &mut output, &mut tool_names) {
                let waiting = matches!(event, RunEvent::ApprovalRequested { .. });
                if let Err(error) = state
                    .conversations
                    .append_harness_event(&run_id, event)
                    .await
                {
                    tracing::warn!(run_id, "failed to append harness event: {error:#}");
                } else if waiting {
                    let _ = state
                        .conversations
                        .set_harness_run_status(&run_id, RunStatus::AwaitingApproval)
                        .await;
                } else {
                    let _ = state
                        .conversations
                        .set_harness_run_status(&run_id, RunStatus::Running)
                        .await;
                }
            }
        }
    }

    let (status, interruption) = classify_stream_end(failure.is_some(), saw_done);
    let output_value = (!output.is_empty()).then(|| Value::String(output));
    let _ = state
        .conversations
        .finish_harness_run(
            &run_id,
            status,
            failure.as_deref().or(interruption),
            output_value.as_ref(),
        )
        .await;
}

fn classify_stream_end(failed: bool, saw_done: bool) -> (RunStatus, Option<&'static str>) {
    if failed {
        (RunStatus::Failed, None)
    } else if saw_done {
        (RunStatus::Completed, None)
    } else {
        (
            RunStatus::Interrupted,
            Some("chat stream ended before completion"),
        )
    }
}

fn take_sse_payload(buffer: &str) -> Option<(String, String)> {
    let end = buffer.find("\n\n")?;
    let frame = &buffer[..end];
    let remaining = buffer[end + 2..].to_owned();
    let data = frame
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .collect::<Vec<_>>()
        .join("\n");
    Some((data, remaining))
}

fn harness_event_from_ui_frame(
    frame: &Value,
    output: &mut String,
    tool_names: &mut std::collections::HashMap<String, String>,
) -> Option<RunEvent> {
    match frame.get("type").and_then(Value::as_str) {
        Some("text-delta") => frame.get("delta").and_then(Value::as_str).map(|delta| {
            if output.len() > 10_000_000 {
                output.truncate(10_000_000);
            }
            RunEvent::TextDelta {
                delta: delta.to_owned(),
            }
        }),
        Some("tool-input-available") => {
            let id = frame.get("toolCallId")?.as_str()?.to_owned();
            let name = frame.get("toolName")?.as_str()?.to_owned();
            tool_names.insert(id.clone(), name.clone());
            let input_hash = frame.get("input").map(ryu_tracing::hash_args);
            Some(RunEvent::ToolCallStarted {
                tool_call_id: id,
                name,
                input_hash,
            })
        }
        Some("tool-output-available") => {
            let id = frame.get("toolCallId")?.as_str()?.to_owned();
            let name = tool_names
                .get(&id)
                .cloned()
                .unwrap_or_else(|| "tool".to_owned());
            let duration_ms = frame
                .pointer("/providerMetadata/ryu/durationMs")
                .and_then(Value::as_u64);
            let ok = frame.get("isError").and_then(Value::as_bool) != Some(true)
                && frame.get("error").is_none()
                && frame.get("errorText").is_none();
            Some(RunEvent::ToolCallCompleted {
                tool_call_id: id,
                name,
                ok,
                duration_ms,
                result_hash: frame_result_hash(frame),
            })
        }
        Some("data-ryu-permission") => {
            let data = frame.get("data")?;
            let approval_id = data.get("requestId")?.as_str()?.to_owned();
            let tool = data
                .pointer("/toolCall/title")
                .and_then(Value::as_str)
                .or_else(|| data.pointer("/toolCall/name").and_then(Value::as_str))
                .unwrap_or("a tool");
            Some(RunEvent::ApprovalRequested {
                approval_id,
                summary: format!("Permission is required to run {tool}"),
                options: parse_approval_options(data.get("options")),
            })
        }
        Some("data-ryu-assistant-message-id") => Some(RunEvent::Checkpoint {
            message_id: frame
                .pointer("/data/messageId")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }),
        _ => None,
    }
}

/// Hash a tool result without copying its content into the cross-surface event
/// projection. The full result remains owned by the provider/conversation
/// boundary; the harness stream only needs a stable correlation fingerprint.
fn frame_result_hash(frame: &Value) -> Option<String> {
    ["output", "result", "error", "errorText"]
        .into_iter()
        .find_map(|key| frame.get(key))
        .map(ryu_tracing::hash_args)
}

fn parse_approval_options(value: Option<&Value>) -> Vec<ApprovalOption> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(32)
        .filter_map(|option| {
            let option_id = option.get("optionId")?.as_str()?.trim();
            let name = option.get("name")?.as_str()?.trim();
            let kind = option.get("kind")?.as_str()?.trim();
            if option_id.is_empty() || name.is_empty() || kind.is_empty() {
                return None;
            }
            Some(ApprovalOption {
                kind: kind.chars().take(128).collect(),
                name: name.chars().take(256).collect(),
                option_id: option_id.chars().take(256).collect(),
            })
        })
        .collect()
}

async fn get_harness_run_for_caller(
    state: &ServerState,
    run_id: &str,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    write: bool,
) -> Result<HarnessRun, Response> {
    let run = state
        .conversations
        .get_harness_run(run_id)
        .await
        .map_err(|error| json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "run not found"))?;
    let session = state
        .conversations
        .get_session(&run.session_id)
        .await
        .map_err(|error| json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or_else(|| json_error(StatusCode::NOT_FOUND, "run session not found"))?;
    let access = state
        .conversations
        .get_access_meta(&session.conversation_id)
        .await;
    let access_result = if write {
        super::require_resource_write(access, caller.as_ref(), "run not found")
    } else {
        super::require_resource_read(access, caller.as_ref(), "run not found")
    };
    if let Err(response) = access_result {
        return Err(response);
    }
    Ok(run)
}

#[utoipa::path(
    get,
    path = "/api/harness/runs/{id}",
    tag = "Harness",
    summary = "Get a durable harness run",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(crate) async fn get_harness_run_handler(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(run_id): Path<String>,
) -> Response {
    match get_harness_run_for_caller(&state, &run_id, &caller, false).await {
        Ok(run) => Json(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "run": run,
        }))
        .into_response(),
        Err(response) => response,
    }
}

fn is_terminal_event(event: &RunEvent) -> bool {
    matches!(
        event,
        RunEvent::RunCompleted { .. }
            | RunEvent::RunFailed { .. }
            | RunEvent::RunCanceled
            | RunEvent::RunInterrupted
    )
}

fn harness_event_sse(event: &RunEventEnvelope) -> axum::response::sse::Event {
    axum::response::sse::Event::default()
        .event("run")
        .id(event.seq.to_string())
        .data(serde_json::to_string(event).unwrap_or_else(|_| "{}".to_owned()))
}

#[utoipa::path(
    get,
    path = "/api/harness/runs/{id}/events",
    tag = "Harness",
    summary = "Stream durable harness run events",
    params(("id" = String, Path), ("after" = Option<u64>, Query)),
    responses((status = 200, description = "Server-Sent Events stream"))
)]
pub(crate) async fn harness_run_events_handler(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(run_id): Path<String>,
    Query(query): Query<HarnessEventsQuery>,
) -> Response {
    let run = match get_harness_run_for_caller(&state, &run_id, &caller, false).await {
        Ok(run) => run,
        Err(response) => return response,
    };
    // Subscribe before reading the durable page. This closes the snapshot/delta
    // race: events written between the two are either in the page or in the bus,
    // and the cursor de-duplicates them.
    let mut rx = super::conversations::subscribe_harness_events();
    let after = query.after.unwrap_or(0);
    let initial = match state
        .conversations
        .list_harness_events(&run_id, after, 500)
        .await
    {
        Ok(events) => events,
        Err(error) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read harness events: {error}"),
            );
        }
    };
    let terminal_without_new_events = run.status.is_terminal() && initial.is_empty();
    let stream = async_stream::stream! {
        use tokio::sync::broadcast::error::RecvError;
        if terminal_without_new_events {
            return;
        }
        let mut pending = VecDeque::from(initial);
        let mut cursor = after;
        loop {
            if let Some(event) = pending.pop_front() {
                if event.seq <= cursor {
                    continue;
                }
                cursor = event.seq;
                let terminal = is_terminal_event(&event.event);
                yield Ok::<_, std::convert::Infallible>(harness_event_sse(&event));
                if terminal {
                    break;
                }
                continue;
            }
            match rx.recv().await {
                Ok(event) if event.run_id == run_id && event.seq > cursor => {
                    cursor = event.seq;
                    let terminal = is_terminal_event(&event.event);
                    yield Ok::<_, std::convert::Infallible>(harness_event_sse(&event));
                    if terminal {
                        break;
                    }
                }
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => {
                    if let Ok(events) = state.conversations.list_harness_events(&run_id, cursor, 500).await {
                        pending.extend(events);
                    }
                }
                Err(RecvError::Closed) => break,
            }
        }
    };
    axum::response::sse::Sse::new(stream)
        .keep_alive(axum::response::sse::KeepAlive::default())
        .into_response()
}

#[utoipa::path(
    post,
    path = "/api/harness/runs/{id}/cancel",
    tag = "Harness",
    summary = "Cancel a durable harness run",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(crate) async fn cancel_harness_run_handler(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(run_id): Path<String>,
) -> Response {
    let run = match get_harness_run_for_caller(&state, &run_id, &caller, true).await {
        Ok(run) => run,
        Err(response) => return response,
    };
    // A finished run has nothing left to stop. Signalling its session's
    // conversation would stop whatever turn runs there now instead.
    if run.status.is_terminal() {
        return Json(json!({
            "cancelled": false,
            "runId": run_id,
        }))
        .into_response();
    }
    // A queued run has no turn to signal: drop it from the queue directly.
    if run.status == RunStatus::Pending {
        let _ = take_queued_context(&run_id);
        let cancelled = matches!(
            state
                .conversations
                .finish_harness_run(&run_id, RunStatus::Canceled, None, None)
                .await,
            Ok(Some(ref finished)) if finished.status == RunStatus::Canceled
        );
        return Json(json!({
            "cancelled": cancelled,
            "runId": run_id,
        }))
        .into_response();
    }
    let Some(session) = (match state.conversations.get_session(&run.session_id).await {
        Ok(session) => session,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }) else {
        return json_error(StatusCode::NOT_FOUND, "run session not found");
    };
    if !run_has_live_dispatch(&session.id, &run_id) {
        // No task is draining this run (it outlived the process that started
        // it), so close it here and let any queued run start.
        let _ = state
            .conversations
            .finish_harness_run(&run_id, RunStatus::Canceled, None, None)
            .await;
        drive_session_queue(state.clone(), session.id.clone()).await;
        return Json(json!({
            "cancelled": true,
            "runId": run_id,
        }))
        .into_response();
    }
    // A durable driver ends its stream with a finish frame the moment it is
    // stopped, and the run's drain task would record that as a completed run.
    // Mark the run canceled first so the terminal status is the user's Cancel.
    let durable = crate::sidecar::adapters::live_turn::is_cancellable(&session.conversation_id);
    if durable {
        let _ = state
            .conversations
            .finish_harness_run(&run_id, RunStatus::Canceled, None, None)
            .await;
    }
    let cancelled = super::cancel_conversation_turn(&session.conversation_id);
    if cancelled && !durable {
        let _ = state
            .conversations
            .finish_harness_run(&run_id, RunStatus::Canceled, None, None)
            .await;
    }
    Json(json!({
        "cancelled": cancelled,
        "runId": run_id,
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_dispatch_is_tracked_per_run() {
        let session = format!("ses_live_{}", uuid::Uuid::new_v4().simple());
        assert!(!session_has_live_dispatch(&session));
        // A run closed before its task started (interrupted while its start
        // was still in flight) must not clear the marker of its replacement.
        mark_live_dispatch(&session, "run_replacement");
        mark_live_dispatch(&session, "run_displaced");
        clear_live_dispatch(&session, "run_displaced");
        assert!(session_has_live_dispatch(&session));
        assert!(run_has_live_dispatch(&session, "run_replacement"));
        assert!(!run_has_live_dispatch(&session, "run_displaced"));
        clear_live_dispatch(&session, "run_replacement");
        assert!(!session_has_live_dispatch(&session));
        // Clearing an unknown run is a no-op.
        clear_live_dispatch(&session, "run_unknown");
        assert!(!session_has_live_dispatch(&session));
    }

    #[test]
    fn incomplete_streams_are_terminally_interrupted() {
        assert_eq!(
            classify_stream_end(false, false),
            (
                RunStatus::Interrupted,
                Some("chat stream ended before completion")
            )
        );
        assert_eq!(
            classify_stream_end(false, true),
            (RunStatus::Completed, None)
        );
        assert_eq!(classify_stream_end(true, false), (RunStatus::Failed, None));
    }

    #[test]
    fn tool_result_projection_keeps_a_digest_and_error_state() {
        let mut names =
            std::collections::HashMap::from([("call-1".to_owned(), "read_file".to_owned())]);
        let frame = serde_json::json!({
            "type": "tool-output-available",
            "toolCallId": "call-1",
            "output": { "contents": "secret" },
        });
        let event = harness_event_from_ui_frame(&frame, &mut String::new(), &mut names)
            .expect("tool output maps to an event");
        let RunEvent::ToolCallCompleted {
            ok, result_hash, ..
        } = event
        else {
            panic!("expected a tool completion event");
        };
        assert!(ok);
        let expected_hash = ryu_tracing::hash_args(&frame["output"]);
        assert_eq!(result_hash.as_deref(), Some(expected_hash.as_str()));

        let error_frame = serde_json::json!({
            "type": "tool-output-available",
            "toolCallId": "call-1",
            "isError": true,
            "error": { "code": "denied" },
        });
        let event = harness_event_from_ui_frame(&error_frame, &mut String::new(), &mut names)
            .expect("tool error maps to an event");
        let RunEvent::ToolCallCompleted { ok, .. } = event else {
            panic!("expected a tool completion event");
        };
        assert!(!ok);
    }
}

#[cfg(test)]
#[path = "harness_routes_test.rs"]
mod routes_test;
