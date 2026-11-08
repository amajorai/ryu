//! Conversation-bound governed workspaces. Model arguments never select a host
//! path, provider handle, credential, or network policy.
#[path = "cloud_tasks/api.rs"]
mod api;
#[path = "cloud_tasks/binding.rs"]
mod binding;
#[path = "cloud_tasks/box_arm.rs"]
mod box_arm;
#[path = "cloud_tasks/leases.rs"]
mod leases;
#[path = "cloud_tasks/live_task.rs"]
mod live_task;
#[path = "cloud_tasks/records.rs"]
mod records;
#[path = "cloud_tasks/release.rs"]
mod release;
#[cfg(test)]
#[path = "cloud_tasks/route_gate_tests.rs"]
mod route_gate_tests;
#[path = "cloud_tasks/routes.rs"]
mod routes;
#[path = "cloud_tasks/workspace.rs"]
mod workspace;

/// Tests that point the process-wide Box endpoint (`RYU_SANDBOX_BOX_*`) at a
/// stand-in take this for writing; tests whose outcome depends on that
/// endpoint (the route gate harness) hold it for reading, so they never see
/// another test's temporary endpoint.
#[cfg(test)]
static BOX_ENV: std::sync::RwLock<()> = std::sync::RwLock::new(());
use super::{cloud_environments as environments, ResolvedAuthorization};
use anyhow::{anyhow, bail, ensure, Result};
use axum::{http::StatusCode, Json};
use ryu_sandbox::{ExecOutput, ExecSpec, Sandbox, SandboxCapabilities, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

const LIFETIME_SECONDS: u64 = 1800;
const MAX_TASKS: usize = 16;
type TaskKey = (String, String);
type TaskSlot = Arc<Mutex<TaskState>>;
type ApiError = (StatusCode, Json<Value>);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudTaskContext {
    pub environment_id: String,
    pub environment_name: String,
    pub revision: u64,
    pub working_directory: String,
    pub repository_directories: Vec<String>,
    pub start_instructions: String,
    /// `ryu` or a managed CLI (`claude-code`, `codex`, `opencode`, `cursor`).
    #[serde(default)]
    pub executor: String,
    /// `docker`, `opensandbox`, `vpn` or `box`.
    #[serde(default)]
    pub backend: String,
}

enum TaskState {
    Preparing,
    Ready(Box<LiveTask>),
    Failed,
    Stopped,
}
struct LiveTask {
    context: CloudTaskContext,
    profile: environments::PreparedEnvironment,
    workspace: TaskWorkspace,
    expires_at: u64,
    lease_id: String,
    conversation_id: String,
    authority: ResolvedAuthorization,
    /// Box arm: the repository commit and branch setup checked out.
    base_sha: Option<String>,
    base_branch: Option<String>,
    /// Box arm: whether heartbeat metering registered this task.
    metered: bool,
    /// Box arm: billing attribution captured at registration.
    metering: Option<super::session_box::BoxMetering>,
    active_run: Option<box_arm::ActiveRun>,
    last_run: Option<box_arm::LastRun>,
    finish: Option<box_arm::FinishSummary>,
    finishing: bool,
}
enum TaskWorkspace {
    Docker(WorkspaceId),
    Governed(ryu_sandbox::governed::GovernedWorkspace),
    Vpn(ryu_sandbox::governed_vpn::GovernedVpnWorkspace),
    Box(WorkspaceId),
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskLease {
    schema_version: u8,
    id: String,
    owner: String,
    conversation_id: String,
    expires_at: u64,
    backend: String,
    handle: Value,
}
fn tasks() -> &'static Mutex<HashMap<TaskKey, TaskSlot>> {
    static TASKS: OnceLock<Mutex<HashMap<TaskKey, TaskSlot>>> = OnceLock::new();
    TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn preparation_changes() -> &'static tokio::sync::watch::Sender<u64> {
    static CHANGES: OnceLock<tokio::sync::watch::Sender<u64>> = OnceLock::new();
    CHANGES.get_or_init(|| tokio::sync::watch::channel(0).0)
}
fn preparation_finished() {
    preparation_changes().send_modify(|revision| *revision = revision.wrapping_add(1));
}
fn now() -> Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}
/// `503 cloud_task_capacity`: every Box placement tier is full right now.
/// `retryAfter` is in seconds; routes also send it as `Retry-After`.
pub(super) fn capacity_error(retry_after: u64) -> ApiError {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"error":{
            "code":"cloud_task_capacity",
            "message":"No cloud box capacity is available right now. Try again shortly.",
            "retryAfter": retry_after,
        }})),
    )
}
fn api_error(status: StatusCode, message: &str) -> ApiError {
    api_error_code(status, "cloud_task_unavailable", message)
}
fn api_error_code(status: StatusCode, code: &str, message: &str) -> ApiError {
    (
        status,
        Json(json!({"error":{"code":code,"message":message}})),
    )
}
/// How long a task waiter may wait for setup, including waiting for the slot
/// lock that setup holds while it prepares the workspace.
const SETUP_WAIT: Duration = Duration::from_secs(300);

/// The task's live state for status reads. Preparation and tool calls hold the
/// slot for minutes, so a held slot reports the persisted lifecycle marker
/// (`preparing` / `ready`, kept current by `records::create` and `records::mark`)
/// instead of waiting behind that work.
fn observed_state(slot: &TaskSlot, recorded: &str) -> String {
    let Ok(state) = slot.try_lock() else {
        return recorded.to_owned();
    };
    match &*state {
        TaskState::Preparing => "preparing",
        TaskState::Ready(task) if task.expires_at > now().unwrap_or(u64::MAX) => "ready",
        TaskState::Ready(_) => "expired",
        TaskState::Stopped => "stopped",
        TaskState::Failed => "failed",
    }
    .to_owned()
}

/// Lock `slot` by `deadline`, or fail with the same 503 a waiter gets when
/// setup outlasts it, so a waiter never blocks unbounded behind preparation.
async fn lock_slot_until(
    slot: &TaskSlot,
    deadline: tokio::time::Instant,
) -> Result<tokio::sync::MutexGuard<'_, TaskState>, ApiError> {
    tokio::time::timeout_at(deadline, slot.lock())
        .await
        .map_err(|_| setup_in_progress())
}

fn setup_in_progress() -> ApiError {
    api_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "Cloud setup is still in progress.",
    )
}

/// Rollout gate for using a task that already exists. A box task needs the
/// `cloud_tasks.box_backend` flag (see
/// [`environments::require_box_backend_feature`]) whatever its environment's
/// stored runtime says now, so revoking the flag or the kill switch reaches a
/// prepared box within one token lifetime. Other workspaces are not gated.
/// Callers keep `stop` ungated so a revoked user can still tear a box down.
async fn require_workspace_feature(
    auth: &ResolvedAuthorization,
    workspace: &TaskWorkspace,
) -> Result<(), ApiError> {
    if matches!(workspace, TaskWorkspace::Box(_)) {
        environments::require_box_backend_feature(auth).await
    } else {
        Ok(())
    }
}
fn require_execution(auth: &ResolvedAuthorization) -> Result<(), ApiError> {
    require_capabilities(auth, true)
}
fn require_capabilities(auth: &ResolvedAuthorization, execution: bool) -> Result<(), ApiError> {
    use crate::authorization::{AuthorizationDecision, Capability, RoutePolicy};
    let policy = if execution {
        RoutePolicy::requires([Capability::GatewayRoute, Capability::ToolsExec])
    } else {
        RoutePolicy::requires([Capability::GatewayRoute])
    };
    if !matches!(
        auth.context
            .authorize(&policy, &auth.bindings, now().unwrap_or(u64::MAX)),
        AuthorizationDecision::Allow
    ) {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "Cloud tasks require current execution authority.",
        ));
    }
    Ok(())
}

use self::binding::saved_runtime_labels;
pub(super) use self::binding::{bind_box, binding_metadata, unbind_box};
pub(crate) use self::binding::{
    bound_box, bound_box_owner, has_bound_task, live_box_count, park_bound_box,
    validate_requested_binding,
};
#[cfg(test)]
use self::leases::{lease_directory, persist_lease, read_lease, recover_leases_matching};
use self::leases::{persist_record, persist_record_replace, remove_lease};
pub(crate) use self::live_task::execute_bound_tool;
pub(super) use self::live_task::run_box_setup_check;
#[cfg(test)]
use self::live_task::{route_preamble, tool_script};
pub(crate) use self::release::release_deleted_conversation;
pub(super) use self::release::start_recovery;
#[cfg(test)]
use self::release::{prune_terminal_slots, release_deleted};
pub(super) use self::routes::{openapi, routes};
pub(crate) use self::workspace::ensure_task_workspace;

#[cfg(test)]
#[path = "cloud_tasks/tests.rs"]
mod tests;
