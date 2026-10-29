//! Conversation-bound governed workspaces. Model arguments never select a host
//! path, provider handle, credential, or network policy.
#[path = "cloud_tasks/api.rs"]
mod api;
#[path = "cloud_tasks/box_arm.rs"]
mod box_arm;
#[path = "cloud_tasks/records.rs"]
mod records;
#[cfg(test)]
#[path = "cloud_tasks/route_gate_tests.rs"]
mod route_gate_tests;

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
fn lease_directory() -> std::path::PathBuf {
    crate::paths::state_path("cloud-task-leases")
}
fn remove_lease(lease_id: &str) -> Result<()> {
    let path = lease_directory().join(format!("{lease_id}.json"));
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
fn persist_lease(task: &LiveTask) -> Result<()> {
    let (backend, handle) = match &task.workspace {
        TaskWorkspace::Docker(_) => ("docker", json!(task.lease_id)),
        TaskWorkspace::Governed(handle) => ("governed", serde_json::to_value(handle)?),
        TaskWorkspace::Vpn(handle) => ("vpn", serde_json::to_value(handle)?),
        TaskWorkspace::Box(id) => ("box", box_arm::lease_handle(&task.lease_id, Some(id))),
    };
    let lease = TaskLease {
        schema_version: 1,
        id: task.lease_id.clone(),
        owner: task.profile.owner.clone(),
        conversation_id: task.conversation_id.clone(),
        expires_at: task.expires_at,
        backend: backend.into(),
        handle,
    };
    if backend == "box" {
        persist_record_replace(&lease)
    } else {
        persist_record(&lease)
    }
}
fn persist_record(lease: &TaskLease) -> Result<()> {
    write_record(lease, false)
}
/// Like [`persist_record`], but overwrites the lease (the Box arm records its
/// box id after the name-only lease written before create).
fn persist_record_replace(lease: &TaskLease) -> Result<()> {
    write_record(lease, true)
}
fn write_record(lease: &TaskLease, overwrite: bool) -> Result<()> {
    use std::io::Write;
    let directory = lease_directory();
    std::fs::create_dir_all(&directory)?;
    ensure!(
        !std::fs::symlink_metadata(&directory)?
            .file_type()
            .is_symlink(),
        "Cloud task lease directory must not be a symlink"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
    }
    let mut file = tempfile::NamedTempFile::new_in(&directory)?;
    file.write_all(&serde_json::to_vec(&lease)?)?;
    file.as_file().sync_all()?;
    let path = directory.join(format!("{}.json", lease.id));
    if overwrite {
        file.persist(path)
            .map_err(|_| anyhow!("Cloud task lease persistence failed"))?;
    } else {
        file.persist_noclobber(path)
            .map_err(|_| anyhow!("Cloud task lease persistence failed"))?;
    }
    Ok(())
}
/// Read and validate one lease file. `Ok(None)` skips an entry that is not a
/// lease file or lies outside `scope`.
fn read_lease(
    entry: std::io::Result<std::fs::DirEntry>,
    scope: Option<(&str, &str)>,
) -> Result<Option<(TaskLease, std::path::PathBuf)>> {
    let entry = entry?;
    let meta = std::fs::symlink_metadata(entry.path())?;
    if !meta.is_file()
        || meta.file_type().is_symlink()
        || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
    {
        return Ok(None);
    }
    ensure!(meta.len() <= 16384, "Cloud task lease exceeded limit");
    let lease: TaskLease = serde_json::from_slice(&std::fs::read(entry.path())?)?;
    if scope.is_some_and(|(owner, conversation)| {
        lease.owner != owner || lease.conversation_id != conversation
    }) {
        return Ok(None);
    }
    ensure!(
        lease.schema_version == 1
            && uuid::Uuid::parse_str(&lease.id)?.to_string() == lease.id
            && entry.file_name().to_str() == Some(&format!("{}.json", lease.id)),
        "Invalid cloud task resource lease"
    );
    Ok(Some((lease, entry.path())))
}
async fn recover_leases() -> Result<()> {
    recover_leases_matching(None).await
}
async fn recover_leases_matching(scope: Option<(&str, &str)>) -> Result<()> {
    let directory = lease_directory();
    if !directory.exists() {
        return Ok(());
    }
    ensure!(
        !std::fs::symlink_metadata(&directory)?
            .file_type()
            .is_symlink(),
        "Cloud task lease directory must not be a symlink"
    );
    let mut failure: Option<anyhow::Error> = None;
    for (index, entry) in std::fs::read_dir(directory)?.enumerate() {
        ensure!(index < 1000, "Cloud task lease inventory exceeded limit");
        // A malformed lease file is reported and skipped, like a failed cleanup,
        // so it cannot strand every other lease in the sweep.
        let (lease, path) = match read_lease(entry, scope) {
            Ok(Some(found)) => found,
            Ok(None) => continue,
            Err(error) => {
                tracing::warn!(error = %error, "Cloud task lease is unreadable; skipping it");
                failure.get_or_insert(error);
                continue;
            }
        };
        // Runtime state is process-local. Any lease absent from that registry
        // belongs to an interrupted prior process and is cleaned, never resumed
        // with missing policy/credential custody.
        let slots: Vec<_> = tasks().lock().await.values().cloned().collect();
        let mut live = false;
        for slot in slots {
            if let TaskState::Ready(task) = &*slot.lock().await {
                if task.lease_id == lease.id {
                    live = true;
                    break;
                }
            }
        }
        if live {
            continue;
        }
        // One lease's failure (a Box API outage, a removed Box token) must not
        // strand every other backend's leases: record it and keep cleaning.
        let cleaned: Result<()> = async {
            match lease.backend.as_str() {
                "docker" => {
                    ensure!(
                        lease.handle.as_str() == Some(&lease.id),
                        "Invalid cloud Docker lease identity"
                    );
                    ryu_sandbox::docker::DockerSandbox::new()
                        .destroy_leased_workspace(&lease.id, lease.expires_at)
                        .await?;
                }
                "governed" => {
                    let handle: ryu_sandbox::governed::GovernedWorkspace =
                        serde_json::from_value(lease.handle)?;
                    ryu_sandbox::opensandbox::OpenSandboxSandbox::governed()
                        .destroy(&handle)
                        .await?;
                }
                "vpn" => {
                    let handle: ryu_sandbox::governed_vpn::GovernedVpnWorkspace =
                        serde_json::from_value(lease.handle)?;
                    environments::vpn_runtime()?
                        .destroy_workspace(&handle)
                        .await?;
                }
                "box" if scope.is_none() && lease.expires_at > now()? => {
                    // A Core restart parks the Box instead of destroying it
                    // (design §7.3): its work is saved, and the lease stays
                    // until the task's lifetime ends or its conversation is
                    // stopped or deleted (scoped sweeps destroy).
                    if !box_arm::lease_is_parked(&lease.handle) {
                        let handle = box_arm::park_lease(&lease.id, &lease.handle).await?;
                        persist_record_replace(&TaskLease {
                            schema_version: lease.schema_version,
                            id: lease.id.clone(),
                            owner: lease.owner.clone(),
                            conversation_id: lease.conversation_id.clone(),
                            expires_at: lease.expires_at,
                            backend: lease.backend.clone(),
                            handle,
                        })?;
                    }
                    return Ok(());
                }
                "box" => box_arm::recover_lease(&lease.id, &lease.handle).await?,
                _ => bail!("Unknown cloud task lease backend"),
            }
            std::fs::remove_file(&path)?;
            Ok(())
        }
        .await;
        if let Err(error) = cleaned {
            tracing::warn!(lease = %lease.id, error = %error, "Cloud task lease cleanup failed; retrying later");
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
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

pub(crate) async fn validate_requested_binding(
    auth: &ResolvedAuthorization,
    conversation_id: &str,
    requested: Option<&str>,
) -> Result<Option<String>, ApiError> {
    let bound = records::contains_conversation(conversation_id).map_err(|_| {
        api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Cloud task bindings are unavailable.",
        )
    })?;
    if !bound {
        if requested.is_some() {
            require_execution(auth)?;
            let _ = environments::owner(auth)?;
        }
        return Ok(requested.map(str::to_owned));
    }
    require_execution(auth)?;
    let owner = environments::owner(auth)?;
    let (environment, status) = records::lookup(&owner, conversation_id)
        .map_err(|_| {
            api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Cloud task bindings are unavailable.",
            )
        })?
        .ok_or_else(|| {
            api_error(
                StatusCode::FORBIDDEN,
                "This cloud task belongs to a different caller.",
            )
        })?;
    if requested.is_some_and(|requested| requested != environment) {
        return Err(api_error(
            StatusCode::CONFLICT,
            "A cloud conversation cannot switch environments. Start a new conversation.",
        ));
    }
    let slot = tasks()
        .lock()
        .await
        .get(&(owner, conversation_id.to_owned()))
        .cloned();
    let stopped = || {
        api_error(
            StatusCode::CONFLICT,
            "This cloud task was stopped, failed, or expired. Start a new conversation.",
        )
    };
    // Terminal slots are dropped from memory once their leases are gone; the
    // persisted marker still answers for them.
    let Some(slot) = slot else {
        return Err(if matches!(status.as_str(), "ready" | "preparing") {
            api_error(
                StatusCode::CONFLICT,
                "This cloud task was interrupted. Start a new conversation.",
            )
        } else {
            stopped()
        });
    };
    // Setup or a tool call holds the slot: answer from the persisted lifecycle
    // rather than waiting. `ensure_task_workspace` re-checks the environment and
    // expiry under its bounded wait before anything runs.
    let Ok(state) = slot.try_lock() else {
        return if matches!(status.as_str(), "ready" | "preparing") {
            Ok(Some(environment))
        } else {
            Err(stopped())
        };
    };
    match &*state {
        TaskState::Ready(task)
            if matches!(status.as_str(), "ready" | "preparing")
                && task.context.environment_id == environment
                && task.expires_at > now().unwrap_or(u64::MAX) =>
        {
            Ok(Some(environment))
        }
        TaskState::Preparing if status == "preparing" => Ok(Some(environment)),
        _ => Err(stopped()),
    }
}
pub(super) async fn binding_metadata(
    auth: &ResolvedAuthorization,
    conversation_id: &str,
) -> Result<Value, ApiError> {
    require_capabilities(auth, false)?;
    let identity = environments::owner(auth)?;
    if !crate::sidecar::adapters::acp::is_safe_host_conversation_id(conversation_id) {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "A valid conversation ID is required.",
        ));
    }
    let record = records::lookup(&identity, conversation_id).map_err(|_| {
        api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Cloud task bindings are unavailable.",
        )
    })?;
    let Some((environment, status)) = record else {
        if records::contains_conversation(conversation_id).map_err(|_| {
            api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Cloud task bindings are unavailable.",
            )
        })? {
            return Err(api_error(
                StatusCode::FORBIDDEN,
                "This cloud task belongs to a different caller.",
            ));
        }
        return Ok(json!({"cloudEnvironmentId":null,"state":null,"backend":null,"executor":null}));
    };
    let slot = tasks()
        .lock()
        .await
        .get(&(identity.clone(), conversation_id.to_owned()))
        .cloned();
    let mut live_runtime = None;
    let state = if let Some(slot) = slot {
        // A held slot answers from the persisted lifecycle (`observed_state`);
        // the live runtime labels are read only when the slot is free.
        if let Ok(state) = slot.try_lock() {
            if let TaskState::Ready(task) = &*state {
                live_runtime = Some((task.context.backend.clone(), task.context.executor.clone()));
            }
        }
        observed_state(&slot, &status)
    } else if matches!(status.as_str(), "preparing" | "ready") {
        "interrupted".to_owned()
    } else {
        status.clone()
    };
    let (backend, executor) =
        live_runtime.unwrap_or_else(|| saved_runtime_labels(&identity, &environment));
    Ok(
        json!({"cloudEnvironmentId":environment,"state":state,"backend":backend,"executor":executor}),
    )
}

/// Backend and executor labels from the saved environment, for tasks with no
/// live context (still preparing, or from an earlier Core process).
fn saved_runtime_labels(owner: &str, environment_id: &str) -> (String, String) {
    let runtime = environments::runtime_for(owner, environment_id).unwrap_or_default();
    let backend = if runtime.backend == "box" {
        "box"
    } else {
        "docker"
    };
    (backend.to_owned(), runtime.executor)
}

/// Cloud task Boxes by `(owner, conversation_id)`, kept outside the task slot
/// so session Box routing never waits on a tool call that holds the slot.
fn bound_boxes() -> &'static std::sync::Mutex<HashMap<TaskKey, super::session_box::BoxTarget>> {
    static BOUND: OnceLock<std::sync::Mutex<HashMap<TaskKey, super::session_box::BoxTarget>>> =
        OnceLock::new();
    BOUND.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn lock_bound_boxes(
) -> std::sync::MutexGuard<'static, HashMap<TaskKey, super::session_box::BoxTarget>> {
    bound_boxes()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Record the live Box of a cloud task.
pub(super) fn bind_box(owner: &str, conversation_id: &str, target: super::session_box::BoxTarget) {
    lock_bound_boxes().insert((owner.to_owned(), conversation_id.to_owned()), target);
}

/// Forget a cloud task's Box (destroyed or parked). Only the named lease is
/// removed, so a later task's Box is never dropped by an older teardown.
pub(super) fn unbind_box(owner: &str, conversation_id: &str, lease_id: &str) {
    let mut bound = lock_bound_boxes();
    let key = (owner.to_owned(), conversation_id.to_owned());
    if bound
        .get(&key)
        .is_some_and(|target| target.lease_id == lease_id)
    {
        bound.remove(&key);
    }
}

/// The live Box of the conversation's cloud task, which a session Box
/// attaches to instead of creating a second one (design §7.1).
pub(crate) async fn bound_box(
    owner: &str,
    conversation_id: &str,
) -> Option<super::session_box::BoxTarget> {
    lock_bound_boxes()
        .get(&(owner.to_owned(), conversation_id.to_owned()))
        .cloned()
}

/// The owner of a conversation's live cloud task Box, if any.
pub(crate) async fn bound_box_owner(conversation_id: &str) -> Option<String> {
    lock_bound_boxes()
        .keys()
        .find(|(_, id)| id == conversation_id)
        .map(|(owner, _)| owner.clone())
}

/// Live cloud task Boxes of one owner (they count against the running cap).
pub(crate) fn live_box_count(owner: &str) -> u32 {
    let count = lock_bound_boxes()
        .keys()
        .filter(|(holder, _)| holder == owner)
        .count();
    u32::try_from(count).unwrap_or(u32::MAX)
}

/// Park the cloud task Box of a conversation (the session Stop button): its
/// state is saved, its compute released, and the task stops with `reason`.
pub(crate) async fn park_bound_box(
    owner: &str,
    conversation_id: &str,
    reason: ryu_sandbox::box_types::ParkReason,
) -> Result<(), ApiError> {
    let slot = tasks()
        .lock()
        .await
        .get(&(owner.to_owned(), conversation_id.to_owned()))
        .cloned()
        .ok_or_else(|| {
            api_error_code(
                StatusCode::NOT_FOUND,
                "session_box_not_found",
                "This conversation has no session Box.",
            )
        })?;
    let mut state = lock_slot_until(&slot, tokio::time::Instant::now() + SETUP_WAIT).await?;
    if let TaskState::Ready(task) = &*state {
        if let TaskWorkspace::Box(workspace) = &task.workspace {
            box_arm::park(task, workspace, reason)
                .await
                .map_err(|error| {
                    match error.downcast_ref::<ryu_sandbox::box_types::BoxApiError>() {
                        Some(box_error) => super::session_box::box_api_error(box_error),
                        None => api_error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "The cloud box could not be parked; retry.",
                        ),
                    }
                })?;
            let _ = records::mark_stopped(owner, conversation_id, reason.as_str());
            *state = TaskState::Stopped;
        }
    }
    Ok(())
}

pub(crate) async fn has_bound_task(conversation_id: &str) -> bool {
    let active = tasks()
        .lock()
        .await
        .keys()
        .any(|(_, id)| id == conversation_id);
    active || records::contains_conversation(conversation_id).unwrap_or(true)
}

/// The HTTP caller already validated and created the conversation's tenancy.
/// One lock serializes preparation, subsequent tools, and cleanup for this task.
pub(crate) async fn ensure_task_workspace(
    auth: &ResolvedAuthorization,
    conversation_id: &str,
    environment_id: &str,
) -> Result<CloudTaskContext, ApiError> {
    require_execution(auth)?;
    let owner = environments::owner(auth)?;
    // A conversation that ran on the user's own plan never gets a workspace here, so it
    // can never pick up a Box charge (docs/subscription-cloud-sessions.md §4).
    if super::subscription_cloud::fences_box(conversation_id) {
        return Err(api_error_code(
            StatusCode::CONFLICT,
            "cloud_task_on_subscription",
            "This conversation runs on your own Claude or ChatGPT plan. Start a new conversation to use a Ryu Box.",
        ));
    }
    if environment_id.is_empty() || environment_id.len() > 128 {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "A valid published environment ID is required.",
        ));
    }
    // Early refusal while the environment still selects box. The authoritative
    // checks are inside `prepare_environment` (first bind) and on the reused
    // task's actual workspace below, so editing the environment away from box
    // cannot keep an already prepared box task usable without the flag.
    if environments::runtime_for(&owner, environment_id)
        .is_some_and(|runtime| runtime.backend == "box")
    {
        environments::require_box_backend_feature(auth).await?;
    }
    if !crate::sidecar::adapters::acp::is_safe_host_conversation_id(conversation_id) {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "A valid conversation is required for a cloud task.",
        ));
    }
    let key = (owner.clone(), conversation_id.to_owned());
    let (slot, created, live) = {
        let mut inventory = tasks().lock().await;
        if let Some(slot) = inventory.get(&key) {
            (slot.clone(), false, HashSet::new())
        } else {
            let live: HashSet<TaskKey> = inventory
                .iter()
                .filter(|(_, slot)| slot_is_live(slot))
                .map(|(key, _)| key.clone())
                .collect();
            if live.len() >= MAX_TASKS || inventory.len() >= 10000 {
                return Err(api_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "The cloud task admission limit is reached. Stop an existing task first.",
                ));
            }
            let slot = Arc::new(Mutex::new(TaskState::Preparing));
            inventory.insert(key, slot.clone());
            (slot, true, live)
        }
    };
    if created {
        // Only consulted at the binding cap: retirement skips live slots and
        // leased conversations.
        let protected = move || {
            let mut protected = live;
            protected.extend(leased_keys());
            protected
        };
        match records::create(&owner, conversation_id, environment_id, protected) {
            Ok(records::Created::New) => {}
            Ok(records::Created::Exists) => {
                *slot.lock().await = TaskState::Failed;
                return Err(api_error(
                    StatusCode::CONFLICT,
                    "This cloud task was stopped or interrupted. Start a new conversation.",
                ));
            }
            Ok(records::Created::LimitReached) => {
                // Nothing was bound, so the conversation stays unbound and can
                // retry once markers retire.
                *slot.lock().await = TaskState::Failed;
                let mut inventory = tasks().lock().await;
                if inventory
                    .get(&(owner.clone(), conversation_id.to_owned()))
                    .is_some_and(|current| Arc::ptr_eq(current, &slot))
                {
                    inventory.remove(&(owner.clone(), conversation_id.to_owned()));
                }
                drop(inventory);
                preparation_finished();
                return Err(api_error_code(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "cloud_task_binding_limit",
                    "This node has reached its limit of active cloud task bindings. Delete old cloud conversations or try again later.",
                ));
            }
            Err(_) => {
                *slot.lock().await = TaskState::Failed;
                return Err(api_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Cloud task binding persistence is unavailable.",
                ));
            }
        }
        let owned_auth = auth.clone();
        let environment_id = environment_id.to_owned();
        let init_slot = slot.clone();
        let init_owner = owner.clone();
        let conversation_id = conversation_id.to_owned();
        return tokio::spawn(async move {
            let mut state = init_slot.lock().await;
            let profile = match environments::prepare_environment(&owned_auth, &environment_id).await {
                Ok(profile) => profile,
                Err(error) => { let _=records::mark(&init_owner,&conversation_id,"failed",None); *state = TaskState::Failed; preparation_finished(); return Err(error); }
            };
            match prepare_task(profile, conversation_id.to_owned(), owned_auth).await {
                Ok(task) => {
                    if records::mark(&init_owner,&conversation_id,"ready",Some(task.context.revision)).is_err() {
                        let _=task.destroy().await;
                        *state=TaskState::Failed;
                        preparation_finished();
                        return Err(api_error(StatusCode::SERVICE_UNAVAILABLE,"Cloud task lifecycle persistence failed."));
                    }
                    let context = task.context.clone(); *state = TaskState::Ready(Box::new(task)); preparation_finished(); Ok(context)
                }
                Err(error) => {
                    if let Some(refusal) =
                        error.downcast_ref::<super::session_box::AdmissionRefusal>()
                    {
                        // Over the plan's running cap or short of credit: the
                        // conversation stays unbound and can retry.
                        let refusal = refusal.0.clone();
                        let _ = records::unbind_preparing(&init_owner, &conversation_id);
                        *state = TaskState::Failed;
                        drop(state);
                        let key = (init_owner.clone(), conversation_id.clone());
                        let mut inventory = tasks().lock().await;
                        if inventory.get(&key).is_some_and(|current| Arc::ptr_eq(current, &init_slot)) {
                            inventory.remove(&key);
                        }
                        drop(inventory);
                        preparation_finished();
                        return Err(refusal);
                    }
                    if let Some(ryu_sandbox::box_types::BoxApiError::Capacity { retry_after }) =
                        error.downcast_ref::<ryu_sandbox::box_types::BoxApiError>()
                    {
                        // No capacity is not the task's fault: the conversation
                        // stays unbound and can retry.
                        let retry_after = *retry_after;
                        let _ = records::unbind_preparing(&init_owner, &conversation_id);
                        *state = TaskState::Failed;
                        drop(state);
                        let key = (init_owner.clone(), conversation_id.clone());
                        let mut inventory = tasks().lock().await;
                        if inventory.get(&key).is_some_and(|current| Arc::ptr_eq(current, &init_slot)) {
                            inventory.remove(&key);
                        }
                        drop(inventory);
                        preparation_finished();
                        return Err(capacity_error(retry_after));
                    }
                    let _=records::mark(&init_owner,&conversation_id,"failed",None); *state = TaskState::Failed; preparation_finished(); Err(api_error(StatusCode::SERVICE_UNAVAILABLE, "Cloud setup failed or cleanup could not be confirmed. Check the configured runtime."))
                }
            }
        }).await.map_err(|_| api_error(StatusCode::SERVICE_UNAVAILABLE, "Cloud setup operation failed."))?;
    }
    let mut changes = preparation_changes().subscribe();
    // One deadline bounds both the wait for the slot (setup holds it while it
    // prepares) and the wait for setup to finish.
    let deadline = tokio::time::Instant::now() + SETUP_WAIT;
    loop {
        let mut state = lock_slot_until(&slot, deadline).await?;
        if matches!(&*state, TaskState::Preparing) {
            drop(state);
            tokio::time::timeout_at(deadline, changes.changed())
                .await
                .map_err(|_| setup_in_progress())?
                .map_err(|_| {
                    api_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Cloud setup status is unavailable.",
                    )
                })?;
            continue;
        }
        return match &mut *state {
        TaskState::Ready(task) if task.context.environment_id == environment_id && task.expires_at > now().unwrap_or(u64::MAX) => {
            require_workspace_feature(auth, &task.workspace).await?;
            task.authority = auth.clone();
            Ok(task.context.clone())
        }
        TaskState::Ready(_) => Err(api_error(StatusCode::CONFLICT, "This conversation is bound to a different or expired cloud environment. Start a new conversation.")),
        _ => Err(api_error(StatusCode::CONFLICT, "Cloud task preparation failed or the task was stopped. Start a new conversation to run setup again.")),
    };
    }
}

pub(super) fn routes() -> axum::Router<super::ServerState> {
    use axum::routing::{get, post};
    axum::Router::new()
        .route("/api/cloud-tasks/:conversation_id", get(api::status))
        .route(
            "/api/cloud-tasks/:conversation_id/prompt",
            post(api::prompt),
        )
        .route("/api/cloud-tasks/:conversation_id/diff", get(api::diff))
        .route(
            "/api/cloud-tasks/:conversation_id/finish",
            post(api::finish),
        )
        .route("/api/cloud-tasks/:conversation_id/stop", post(stop))
        .layer(axum::extract::DefaultBodyLimit::max(262_144))
}
#[utoipa::path(post,path="/api/cloud-tasks/{conversation_id}/stop",tag="Cloud environments",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation bound to a personally owned cloud task")),description="Stop the caller's retained cloud task workspace and remove its owned resource lease after successful cleanup. Requires GatewayRoute with current personal identity; revoked execution permission does not prevent stopping an owned task. Idempotent for already stopped or absent caller-owned tasks. A stopped conversation cannot rerun installation automatically; start a new conversation. Failed cleanup preserves the lease for retry.",responses((status=200,body=Value),(status=403,description="Execution authority or identity denied"),(status=503,description="Cleanup failed; retry stop")))]
async fn stop(
    axum::Extension(auth): axum::Extension<ResolvedAuthorization>,
    axum::extract::Path(conversation_id): axum::extract::Path<String>,
) -> Result<Json<Value>, ApiError> {
    stop_owned_task(&auth, &conversation_id).await?;
    Ok(Json(
        json!({"conversationId":conversation_id,"status":"stopped"}),
    ))
}
#[derive(utoipa::OpenApi)]
#[openapi(
    paths(api::status, api::prompt, api::diff, api::finish, stop),
    components(schemas(
        api::CloudTaskStatus,
        api::ActiveRunView,
        api::LastRunView,
        box_arm::FinishSummary,
        api::PromptRequest,
        api::PromptAccepted,
        api::PromptRunAccepted,
        api::DiffResponse,
        box_arm::DiffFile,
        api::FinishRequest,
        api::FinishResponse,
        super::session_box::SessionBoxView,
        super::session_box::BoxCaps
    ))
)]
struct CloudTaskApiDoc;
pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    use utoipa::OpenApi;
    let mut doc = CloudTaskApiDoc::openapi();
    doc.merge(super::session_box::openapi());
    doc
}

async fn prepare_task(
    profile: environments::PreparedEnvironment,
    conversation_id: String,
    authority: ResolvedAuthorization,
) -> Result<LiveTask> {
    let lease_id = uuid::Uuid::new_v4().to_string();
    if profile.backend == environments::TaskBackend::Box {
        return prepare_box_task(profile, lease_id, conversation_id, authority).await;
    }
    let expires_at = now()? + LIFETIME_SECONDS;
    let workspace = if let (Some(backend), Some(key)) = (&profile.vpn_backend, &profile.vpn_key) {
        TaskWorkspace::Vpn(
            backend
                .create_workspace(&profile.governed_spec, key, LIFETIME_SECONDS)
                .await?,
        )
    } else if profile.governed {
        TaskWorkspace::Governed(
            ryu_sandbox::opensandbox::OpenSandboxSandbox::governed()
                .create(&profile.governed_spec)
                .await?,
        )
    } else {
        persist_record(&TaskLease {
            schema_version: 1,
            id: lease_id.clone(),
            owner: profile.owner.clone(),
            conversation_id: conversation_id.clone(),
            expires_at,
            backend: "docker".into(),
            handle: json!(lease_id),
        })?;
        TaskWorkspace::Docker(
            ryu_sandbox::docker::DockerSandbox::new()
                .create_leased_workspace(
                    &lease_id,
                    expires_at,
                    SandboxCapabilities {
                        network: profile.network,
                        ..Default::default()
                    },
                )
                .await?,
        )
    };
    let context = CloudTaskContext {
        environment_id: profile.environment_id.clone(),
        environment_name: profile.environment_name.clone(),
        revision: profile.revision,
        working_directory: profile.working_directory.clone(),
        repository_directories: profile.repository_directories.clone(),
        start_instructions: profile.start_instructions.clone(),
        executor: profile.executor.clone(),
        backend: profile.backend.label().to_owned(),
    };
    let task = LiveTask::new(
        context,
        profile,
        workspace,
        expires_at,
        lease_id,
        conversation_id,
        authority,
    );
    if !matches!(&task.workspace, TaskWorkspace::Docker(_)) && persist_lease(&task).is_err() {
        task.destroy().await?;
        bail!("Cloud task lease could not be persisted");
    }
    match task.run(&task.profile.script, 120).await {
        Ok(output) if output.exit_code == 0 => Ok(task),
        _ => {
            task.destroy().await?;
            bail!("Cloud environment installation failed");
        }
    }
}
/// Box arm of [`prepare_task`]: lease first, then create, meter, and run setup.
async fn prepare_box_task(
    profile: environments::PreparedEnvironment,
    lease_id: String,
    conversation_id: String,
    authority: ResolvedAuthorization,
) -> Result<LiveTask> {
    let expires_at = now()? + profile.lifetime_seconds;
    // The same admission as a session Box (signed running cap, credit
    // pre-flight at the size's rate, Box limits) before anything is created.
    super::session_box::admit_cloud_task(&authority, &profile.owner, box_arm::task_box_size())
        .await?;
    let created = box_arm::create(&profile, &lease_id, &conversation_id, expires_at).await?;
    let context = CloudTaskContext {
        environment_id: profile.environment_id.clone(),
        environment_name: profile.environment_name.clone(),
        revision: profile.revision,
        working_directory: profile.working_directory.clone(),
        repository_directories: profile.repository_directories.clone(),
        start_instructions: profile.start_instructions.clone(),
        executor: profile.executor.clone(),
        backend: profile.backend.label().to_owned(),
    };
    let mut task = LiveTask::new(
        context,
        profile,
        TaskWorkspace::Box(created.workspace),
        expires_at,
        lease_id,
        conversation_id,
        authority,
    );
    task.metered = created.metering.is_some();
    task.metering = created.metering;
    match task.run(&task.profile.script, 600).await {
        Ok(output) if output.exit_code == 0 => {}
        _ => {
            task.destroy().await?;
            bail!("Cloud environment installation failed");
        }
    }
    if !task.context.repository_directories.is_empty() {
        match box_arm::base_revision(&task).await {
            Ok((sha, branch)) => {
                task.base_sha = Some(sha);
                task.base_branch = branch;
            }
            Err(_) => {
                task.destroy().await?;
                bail!("Cloud task repository revision could not be read");
            }
        }
    }
    Ok(task)
}
impl LiveTask {
    fn new(
        context: CloudTaskContext,
        profile: environments::PreparedEnvironment,
        workspace: TaskWorkspace,
        expires_at: u64,
        lease_id: String,
        conversation_id: String,
        authority: ResolvedAuthorization,
    ) -> Self {
        Self {
            context,
            profile,
            workspace,
            expires_at,
            lease_id,
            conversation_id,
            authority,
            base_sha: None,
            base_branch: None,
            metered: false,
            metering: None,
            active_run: None,
            last_run: None,
            finish: None,
            finishing: false,
        }
    }
    async fn run(&self, script: &str, seconds: u64) -> Result<ExecOutput> {
        let routed;
        let script = match self.desktop_route_preamble().await? {
            Some(preamble) => {
                routed = format!("{preamble}{script}");
                routed.as_str()
            }
            None => script,
        };
        match &self.workspace {
            TaskWorkspace::Box(workspace) => {
                super::session_box::box_client()
                    .await?
                    .exec_script(
                        workspace,
                        script,
                        &self.profile.box_env,
                        ryu_sandbox::box_session::BoxUser::Box,
                        seconds,
                    )
                    .await
            }
            TaskWorkspace::Vpn(workspace) => {
                self.profile
                    .vpn_backend
                    .as_ref()
                    .ok_or_else(|| anyhow!("VPN runtime unavailable"))?
                    .execute_script(workspace, script, seconds)
                    .await
            }
            TaskWorkspace::Governed(workspace) => {
                ryu_sandbox::opensandbox::OpenSandboxSandbox::governed()
                    .execute_script(workspace, script, seconds)
                    .await
            }
            TaskWorkspace::Docker(workspace) => {
                ryu_sandbox::docker::DockerSandbox::new()
                    .exec_in_workspace(
                        workspace,
                        ExecSpec {
                            env: Vec::new(),
                            command: "sh".into(),
                            args: vec!["-s".into()],
                            stdin: Some(script.as_bytes().to_vec()),
                            timeout_secs: Some(seconds),
                            capabilities: SandboxCapabilities {
                                network: self.profile.network,
                                ..Default::default()
                            },
                        },
                    )
                    .await
            }
        }
    }
    /// Proxy exports that send this task's web traffic through the user's
    /// desktop while "Route traffic through this computer" is on. Fails closed:
    /// a routed node never runs a networked task that cannot reach the route.
    async fn desktop_route_preamble(&self) -> Result<Option<String>> {
        if !self.profile.network {
            return Ok(None);
        }
        route_preamble(
            true,
            crate::local_egress::entry::routing_active().await,
            matches!(self.workspace, TaskWorkspace::Docker(_)),
            crate::local_egress::entry::container_proxy_env,
        )
    }
    async fn destroy(&self) -> Result<()> {
        match &self.workspace {
            TaskWorkspace::Vpn(workspace) => {
                self.profile
                    .vpn_backend
                    .as_ref()
                    .ok_or_else(|| anyhow!("VPN runtime unavailable"))?
                    .destroy_workspace(workspace)
                    .await
            }
            TaskWorkspace::Governed(workspace) => {
                ryu_sandbox::opensandbox::OpenSandboxSandbox::governed()
                    .destroy(workspace)
                    .await
            }
            TaskWorkspace::Docker(_) => {
                ryu_sandbox::docker::DockerSandbox::new()
                    .destroy_leased_workspace(&self.lease_id, self.expires_at)
                    .await
            }
            // Billing, prompt cancel and lease removal are Box-specific.
            TaskWorkspace::Box(workspace) => return box_arm::destroy(self, workspace).await,
        }?;
        remove_lease(&self.lease_id)
    }
    fn output(&self, output: ExecOutput) -> Value {
        let redact = |bytes: Vec<u8>| {
            let mut text = String::from_utf8_lossy(&bytes).into_owned();
            for secret in &self.profile.task_redactions {
                if !secret.is_empty() {
                    text = text.replace(secret, "[redacted]");
                }
            }
            text.chars().take(65536).collect::<String>()
        };
        json!({"exitCode":output.exit_code,"stdout":redact(output.stdout),"stderr":redact(output.stderr)})
    }
}

/// One disposable Box setup check for `POST /api/cloud-environments/{id}/launch`.
pub(super) async fn run_box_setup_check(
    script: &str,
    env: &[(String, String)],
    network: ryu_sandbox::box_session::BoxNetwork,
) -> Result<ExecOutput> {
    box_arm::setup_check(script, env, network).await
}

pub(crate) async fn execute_bound_tool(
    owner: &str,
    conversation_id: &str,
    tool: &str,
    arguments: Value,
) -> Result<Value> {
    let slot = tasks()
        .lock()
        .await
        .get(&(owner.to_owned(), conversation_id.to_owned()))
        .cloned()
        .ok_or_else(|| anyhow!("No cloud task is bound to this verified conversation"))?;
    let mut state = slot.lock().await;
    let TaskState::Ready(task) = &*state else {
        bail!("Cloud task is not ready");
    };
    require_execution(&task.authority)
        .map_err(|_| anyhow!("Cloud task execution authority expired or was denied"))?;
    if task.context.executor != "ryu" {
        bail!("This cloud task runs a managed agent");
    }
    if task.expires_at <= now()? {
        task.destroy().await?;
        *state = TaskState::Stopped;
        bail!("Cloud task expired");
    }
    environments::approve_network_policy(
        &task.profile.governed_spec,
        task.profile.vpn_key.is_some(),
    )
    .await
    .map_err(|_| anyhow!("Gateway denied cloud task egress"))?;
    environments::approve_setup_budget(task.profile.backend_label)
        .await
        .map_err(|_| anyhow!("Gateway denied cloud task execution"))?;
    let script = tool_script(&task.context.working_directory, tool, &arguments)?;
    let script = format!("{}\n{script}", task.profile.task_preamble);
    let remaining = task.expires_at.saturating_sub(now()?);
    ensure!(remaining > 0, "Cloud task expired before execution");
    let output = task.run(&script, 120.min(remaining)).await?;
    Ok(task.output(output))
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
/// Builds the proxy exports prepended to a networked task's script while desktop
/// routing is on. Fails closed for sandboxes that cannot reach the route; the
/// proxy variables are only resolved once the Docker check has passed.
fn route_preamble(
    network: bool,
    routing: bool,
    docker: bool,
    proxy_env: impl FnOnce() -> Option<Vec<(&'static str, String)>>,
) -> Result<Option<String>> {
    if !network || !routing {
        return Ok(None);
    }
    ensure!(
        docker,
        "This environment's sandbox cannot route through your desktop. Turn off \"Route traffic through this computer\" to run it from the cloud."
    );
    let variables = proxy_env().ok_or_else(|| {
        anyhow!("Desktop routing is on, but task containers cannot reach the route on this node")
    })?;
    Ok(Some(
        variables
            .into_iter()
            .map(|(key, value)| format!("export {key}={}\n", quote(&value)))
            .collect(),
    ))
}
fn relative_path(arguments: &Value) -> Result<&str> {
    let path = arguments["path"]
        .as_str()
        .ok_or_else(|| anyhow!("A relative workspace path is required"))?;
    ensure!(
        !path.is_empty()
            && path.len() <= 4096
            && !path.contains(['\0', '\\', '\n', '\r'])
            && !path.starts_with('/')
            && !path.split('/').any(|part| part == ".."),
        "Path must stay inside the cloud working directory"
    );
    Ok(path)
}
fn tool_script(root: &str, tool: &str, arguments: &Value) -> Result<String> {
    let object = arguments
        .as_object()
        .ok_or_else(|| anyhow!("Cloud tool arguments must be an object"))?;
    let fields: &[&str] = match tool {
        "exec" => &["command"],
        "read_file" | "list_files" => &["path"],
        "write_file" => &["path", "content"],
        _ => bail!("Unsupported cloud task tool"),
    };
    ensure!(
        object.keys().all(|field| fields.contains(&field.as_str())),
        "Cloud tools do not accept workspace or policy overrides"
    );
    if tool == "exec" {
        let command = arguments["command"]
            .as_str()
            .ok_or_else(|| anyhow!("A command is required"))?;
        ensure!(
            command.len() <= 65536 && !command.contains('\0'),
            "Command exceeds limits"
        );
        return Ok(format!("sh -c {}\n", quote(command)));
    }
    let path = relative_path(arguments)?;
    // realpath follows symlinks inside the container; no host path is ever read.
    let guard = format!("root={}\npath=$(realpath -m -- {})\ncase \"$path\" in \"$root\"|\"$root\"/*) ;; *) exit 65;; esac\n", quote(root), quote(path));
    let body = match tool {
        "read_file" => "head -c 65536 -- \"$path\"\n".to_owned(),
        "list_files" => "find \"$path\" -maxdepth 2 -type f -print | head -n 1000\n".to_owned(),
        "write_file" => {
            let content = arguments["content"]
                .as_str()
                .ok_or_else(|| anyhow!("Text content is required"))?;
            ensure!(
                content.len() <= 65536 && !content.contains('\0'),
                "Content exceeds limits"
            );
            format!(
                "mkdir -p -- \"$(dirname -- \"$path\")\"\nprintf '%s' {} > \"$path\"\n",
                quote(content)
            )
        }
        _ => bail!("Unsupported cloud task tool"),
    };
    Ok(guard + &body)
}

pub(crate) async fn stop_owned_task(
    auth: &ResolvedAuthorization,
    conversation_id: &str,
) -> Result<(), ApiError> {
    require_capabilities(auth, false)?;
    let owner = environments::owner(auth)?;
    let slot = tasks()
        .lock()
        .await
        .get(&(owner.clone(), conversation_id.to_owned()))
        .cloned();
    if let Some(slot) = slot {
        let mut state = slot.lock().await;
        if let TaskState::Ready(task) = &*state {
            task.destroy().await.map_err(|_| {
                api_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Cloud task cleanup failed; retry stop.",
                )
            })?;
        }
        *state = TaskState::Stopped;
    }
    recover_leases_matching(Some((&owner, conversation_id)))
        .await
        .map_err(|_| {
            api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Cloud task resource cleanup failed; leases remain for retry.",
            )
        })?;
    records::mark(&owner, conversation_id, "stopped", None).map_err(|_| {
        api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Cloud task lifecycle persistence failed.",
        )
    })?;
    Ok(())
}

/// A slot that is preparing, ready, or busy (a held lock is treated as live).
fn slot_is_live(slot: &TaskSlot) -> bool {
    slot.try_lock().map_or(true, |state| {
        matches!(&*state, TaskState::Preparing | TaskState::Ready(_))
    })
}

/// Conversations that still hold a resource lease. Unreadable lease files are
/// skipped here; [`recover_leases`] reports them.
fn leased_keys() -> HashSet<TaskKey> {
    let directory = lease_directory();
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return HashSet::new();
    };
    entries
        .take(1000)
        .filter_map(|entry| read_lease(entry, None).ok().flatten())
        .map(|(lease, _)| (lease.owner, lease.conversation_id))
        .collect()
}

/// The conversation was deleted. Its markers become `deleted` at once, so the
/// conversation stays fail-closed (bound, unusable, never set up again) until
/// its workspace and leases are gone; then the markers are removed so a
/// recreated conversation with the same id starts fresh. Teardown runs
/// detached; the recovery sweep retries whatever cannot be released yet.
pub(crate) async fn release_deleted_conversation(conversation_id: &str) {
    // Session and sub-agent Boxes are released whether or not the
    // conversation ever had a cloud task.
    let released = conversation_id.to_owned();
    tokio::spawn(async move {
        super::session_box::release_deleted_conversation(&released).await;
    });
    let owners = match records::mark_deleted(conversation_id) {
        Ok(owners) => owners,
        Err(error) => {
            tracing::warn!(error = %error, "Cloud task bindings for a deleted conversation could not be updated");
            return;
        }
    };
    if owners.is_empty() {
        return;
    }
    let conversation_id = conversation_id.to_owned();
    tokio::spawn(async move {
        for owner in owners {
            release_deleted(&owner, &conversation_id).await;
        }
    });
}

/// Tear down and forget one owner's deleted conversation. Returns whether the
/// marker was removed; `false` leaves it `deleted` for the next sweep.
async fn release_deleted(owner: &str, conversation_id: &str) -> bool {
    let key = (owner.to_owned(), conversation_id.to_owned());
    let slot = tasks().lock().await.get(&key).cloned();
    if let Some(slot) = &slot {
        // Setup or a tool call holds the slot; try again on the next sweep.
        let Ok(mut state) = slot.try_lock() else {
            return false;
        };
        match &*state {
            TaskState::Preparing => return false,
            TaskState::Ready(task) => {
                if task.destroy().await.is_err() {
                    tracing::warn!(
                        "Cloud task cleanup for a deleted conversation failed; retained for retry"
                    );
                    return false;
                }
                *state = TaskState::Stopped;
            }
            TaskState::Failed | TaskState::Stopped => {}
        }
    }
    if recover_leases_matching(Some((owner, conversation_id)))
        .await
        .is_err()
        || leased_keys().contains(&key)
    {
        return false;
    }
    if let Some(slot) = slot {
        let mut inventory = tasks().lock().await;
        if inventory
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &slot))
        {
            inventory.remove(&key);
        }
    }
    match records::remove_deleted(owner, conversation_id) {
        Ok(()) => true,
        Err(error) => {
            tracing::warn!(error = %error, "Cloud task binding for a deleted conversation could not be removed");
            false
        }
    }
}

/// Drop in-memory slots of stopped or failed tasks whose leases are gone. The
/// persisted marker (brought to the slot's terminal state first) keeps the
/// conversation bound, so this only frees the admission inventory. A slot with
/// no marker (binding persistence failed) is kept and stays fail-closed.
async fn prune_terminal_slots() {
    let leased = leased_keys();
    let candidates: Vec<(TaskKey, TaskSlot, &'static str)> = tasks()
        .lock()
        .await
        .iter()
        .filter(|(key, _)| !leased.contains(*key))
        .filter_map(|(key, slot)| {
            let status = match &*slot.try_lock().ok()? {
                TaskState::Stopped => "stopped",
                TaskState::Failed => "failed",
                TaskState::Preparing | TaskState::Ready(_) => return None,
            };
            Some((key.clone(), slot.clone(), status))
        })
        .collect();
    for ((owner, conversation_id), slot, status) in candidates {
        let Ok(Some((_, recorded))) = records::lookup(&owner, &conversation_id) else {
            continue;
        };
        if matches!(recorded.as_str(), "preparing" | "ready")
            && records::mark(&owner, &conversation_id, status, None).is_err()
        {
            continue;
        }
        let key = (owner, conversation_id);
        let mut inventory = tasks().lock().await;
        if inventory.get(&key).is_some_and(|current| {
            Arc::ptr_eq(current, &slot)
                && current
                    .try_lock()
                    .is_ok_and(|state| matches!(&*state, TaskState::Stopped | TaskState::Failed))
        }) {
            inventory.remove(&key);
        }
    }
}

/// Retention work on the recovery tick: finish releasing deleted
/// conversations, retire aged markers that hold no live slot or lease, and
/// drop terminal slots.
async fn sweep_retention() {
    match records::deleted() {
        Ok(deleted) => {
            for (owner, conversation_id) in deleted {
                release_deleted(&owner, &conversation_id).await;
            }
        }
        Err(error) => {
            tracing::warn!(error = %error, "Cloud task bindings are unreadable; retention skipped")
        }
    }
    let mut protected: HashSet<TaskKey> = tasks()
        .lock()
        .await
        .iter()
        .filter(|(_, slot)| slot_is_live(slot))
        .map(|(key, _)| key.clone())
        .collect();
    protected.extend(leased_keys());
    if let Err(error) = records::retire_aged(&protected) {
        tracing::warn!(error = %error, "Cloud task binding retention failed; retrying later");
    }
    prune_terminal_slots().await;
}

pub(super) fn start_recovery() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    STARTED.call_once(|| {
        handle.spawn(async {
            let mut ticks = tokio::time::interval(Duration::from_secs(60));
            loop {
                ticks.tick().await;
                if recover_leases().await.is_err() {
                    tracing::warn!("Cloud task resource recovery failed; leases remain for retry");
                }
                let slots: Vec<_> = tasks().lock().await.values().cloned().collect();
                for slot in slots {
                    let mut state = slot.lock().await;
                    if let TaskState::Ready(task) = &*state {
                        if task.expires_at <= now().unwrap_or(u64::MAX) {
                            if task.destroy().await.is_ok() {
                                *state = TaskState::Stopped;
                            } else {
                                tracing::warn!("Cloud task cleanup failed; retained for retry");
                            }
                        }
                    }
                }
                sweep_retention().await;
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unreachable_proxy_env() -> Option<Vec<(&'static str, String)>> {
        panic!("proxy env must not be resolved")
    }

    #[test]
    fn route_preamble_is_skipped_without_network_or_routing() {
        for (network, routing) in [(false, false), (false, true), (true, false)] {
            for docker in [false, true] {
                assert!(
                    route_preamble(network, routing, docker, unreachable_proxy_env)
                        .unwrap()
                        .is_none()
                );
            }
        }
    }

    #[test]
    fn route_preamble_fails_closed_outside_docker() {
        let error = route_preamble(true, true, false, unreachable_proxy_env).unwrap_err();
        assert!(error
            .to_string()
            .contains("cannot route through your desktop"));
    }

    #[test]
    fn route_preamble_fails_when_containers_cannot_reach_route() {
        let error = route_preamble(true, true, true, || None).unwrap_err();
        assert!(error
            .to_string()
            .contains("task containers cannot reach the route"));
    }

    #[test]
    fn route_preamble_exports_quoted_proxy_vars_before_script() {
        let preamble = route_preamble(true, true, true, || {
            Some(vec![
                ("HTTP_PROXY", "http://ryu:p'a ss@10.0.0.1:1".to_owned()),
                ("NO_PROXY", "localhost".to_owned()),
            ])
        })
        .unwrap()
        .unwrap();
        assert_eq!(
            preamble,
            "export HTTP_PROXY='http://ryu:p'\\''a ss@10.0.0.1:1'\nexport NO_PROXY='localhost'\n"
        );
        let script = "curl https://example.com\n";
        let routed = format!("{preamble}{script}");
        assert!(routed.starts_with("export HTTP_PROXY="));
        assert!(routed.ends_with(script));
    }

    #[tokio::test]
    async fn held_task_slot_reports_persisted_state_without_waiting() {
        let slot: TaskSlot = Arc::new(Mutex::new(TaskState::Preparing));
        let held = slot.lock().await;
        assert_eq!(observed_state(&slot, "preparing"), "preparing");
        assert_eq!(observed_state(&slot, "ready"), "ready");
        drop(held);
        assert_eq!(observed_state(&slot, "ready"), "preparing");
        *slot.lock().await = TaskState::Failed;
        assert_eq!(observed_state(&slot, "ready"), "failed");
    }

    #[tokio::test(start_paused = true)]
    async fn task_waiters_honor_the_setup_deadline() {
        let slot: TaskSlot = Arc::new(Mutex::new(TaskState::Preparing));
        let _held = slot.clone().lock_owned().await;
        let deadline = tokio::time::Instant::now() + SETUP_WAIT;
        let Err((status, _)) = lock_slot_until(&slot, deadline).await else {
            panic!("a held slot must not be acquired before the deadline");
        };
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(tokio::time::Instant::now() >= deadline);
    }

    #[test]
    fn cloud_paths_cannot_select_host_paths_or_parent_directories() {
        for path in [
            "/etc/passwd",
            "../secret",
            "a/../../secret",
            "C:\\host",
            "bad\npath",
        ] {
            assert!(tool_script("/tmp/ryu-workspace", "read_file", &json!({"path":path})).is_err());
        }
        let script = tool_script(
            "/tmp/ryu-workspace",
            "write_file",
            &json!({"path":"src/main.rs","content":"literal '$HOME'"}),
        )
        .unwrap();
        assert!(script.contains("realpath -m"));
        assert!(script.contains("exit 65"));
        assert!(script.contains("printf '%s'"));
    }

    /// A one-connection-per-request fake Box API that lists one named Box and
    /// records every request line.
    async fn fake_box(
        box_id: String,
        name: String,
    ) -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let mut buffer = vec![0u8; 16384];
                let mut read = 0;
                while !buffer[..read]
                    .windows(4)
                    .any(|window| window == b"\r\n\r\n")
                {
                    match stream.read(&mut buffer[read..]).await {
                        Ok(0) | Err(_) => break,
                        Ok(count) => read += count,
                    }
                }
                let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
                let line = request.lines().next().unwrap_or_default().to_owned();
                recorded.lock().unwrap().push(line.clone());
                let body = if line.starts_with("GET /v1/boxes ") {
                    json!({"boxes":[{"id":box_id,"name":name,"status":"ready"}]}).to_string()
                } else {
                    json!({"ok":true}).to_string()
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (base, seen)
    }

    struct InstalledCredential;

    impl ryu_sandbox::box_credential::BoxCredentialSource for InstalledCredential {
        fn current(&self) -> ryu_sandbox::box_credential::CredentialFuture<'_> {
            Box::pin(async {
                Ok(ryu_sandbox::box_credential::BoxCredential {
                    base: reqwest::Url::parse("https://box.example/v1").unwrap(),
                    token: ryu_sandbox::box_types::SecretString::new("rbx1.control-plane"),
                    public_base: None,
                    billing_owner: ryu_sandbox::box_credential::BillingOwner::CoreTick,
                    expires_at: None,
                })
            })
        }
    }

    /// A managed node has no `RYU_SANDBOX_BOX_TOKEN`: its Box credential comes
    /// from the control-plane source it installs. The Box task and environment
    /// gates must accept it, as the Box arm that runs the task does.
    #[tokio::test]
    async fn cloud_box_gate_accepts_a_managed_nodes_control_plane_credential() {
        let _box_env = BOX_ENV
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous_token = std::env::var_os(ryu_sandbox::box_backend::ENV_BOX_TOKEN);
        std::env::remove_var(ryu_sandbox::box_backend::ENV_BOX_TOKEN);
        ryu_sandbox::box_credential::clear_source();
        let unconfigured = super::super::session_box::box_configured().await;
        ryu_sandbox::box_credential::install_source(std::sync::Arc::new(InstalledCredential));
        let managed = super::super::session_box::box_configured().await;
        ryu_sandbox::box_credential::clear_source();
        if let Some(value) = previous_token {
            std::env::set_var(ryu_sandbox::box_backend::ENV_BOX_TOKEN, value);
        }
        assert!(!unconfigured, "no env token and no installed source");
        assert!(managed, "the installed control-plane source configures Box");
    }

    #[tokio::test]
    async fn cloud_box_lease_without_box_id_is_destroyed_by_name_and_removed() {
        let lease_id = uuid::Uuid::new_v4().to_string();
        let box_id = format!("bx_{}", uuid::Uuid::new_v4().simple());
        let name = format!("ryu-ct-{lease_id}");
        let (base, seen) = fake_box(box_id.clone(), name).await;
        // No session Box test may point Box calls at its own fake meanwhile.
        let _overrides = super::super::session_box::tests::without_overrides().await;
        let _box_env = BOX_ENV
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous_url = std::env::var_os(ryu_sandbox::box_backend::ENV_BOX_URL);
        let previous_token = std::env::var_os(ryu_sandbox::box_backend::ENV_BOX_TOKEN);
        std::env::set_var(ryu_sandbox::box_backend::ENV_BOX_URL, &base);
        std::env::set_var(ryu_sandbox::box_backend::ENV_BOX_TOKEN, "box-test-token");
        let owner = format!("user:cloud-box-recovery-{}", uuid::Uuid::new_v4().simple());
        let conversation = format!("cloud-box-{}", uuid::Uuid::new_v4().simple());
        persist_record(&TaskLease {
            schema_version: 1,
            id: lease_id.clone(),
            owner: owner.clone(),
            conversation_id: conversation.clone(),
            expires_at: now().unwrap() + 60,
            backend: "box".into(),
            handle: box_arm::lease_handle(&lease_id, None),
        })
        .unwrap();
        let path = lease_directory().join(format!("{lease_id}.json"));
        assert!(path.exists());
        let result = recover_leases_matching(Some((&owner, &conversation))).await;
        match previous_url {
            Some(value) => std::env::set_var(ryu_sandbox::box_backend::ENV_BOX_URL, value),
            None => std::env::remove_var(ryu_sandbox::box_backend::ENV_BOX_URL),
        }
        match previous_token {
            Some(value) => std::env::set_var(ryu_sandbox::box_backend::ENV_BOX_TOKEN, value),
            None => std::env::remove_var(ryu_sandbox::box_backend::ENV_BOX_TOKEN),
        }
        result.unwrap();
        assert!(!path.exists(), "the recovered lease file is removed");
        let seen = seen.lock().unwrap().clone();
        assert!(
            seen.iter().any(|line| line.starts_with("GET /v1/boxes ")),
            "{seen:?}"
        );
        assert!(
            seen.iter()
                .any(|line| line.starts_with(&format!("DELETE /v1/boxes/{box_id} "))),
            "{seen:?}"
        );
    }

    /// The rebind, diff and push gate follows the task's actual workspace, not
    /// the environment's current runtime: a prepared box task whose environment
    /// was edited to `auto` is still refused without the signed flag.
    #[tokio::test]
    async fn box_gate_follows_the_task_workspace_not_the_environment() {
        use environments::tests::{cloud_auth, denial_code, signed_user_jwt};
        let boxed = TaskWorkspace::Box(WorkspaceId(format!("bx_{}", "b".repeat(32))));
        let docker = TaskWorkspace::Docker(WorkspaceId("ws-docker".into()));
        let without_flag = cloud_auth(signed_user_jwt(Some(json!([])), 600).await).await;
        let with_flag =
            cloud_auth(signed_user_jwt(Some(json!([environments::BOX_BACKEND_FLAG])), 600).await)
                .await;

        let error = require_workspace_feature(&without_flag, &boxed)
            .await
            .expect_err("a box task without the flag is refused");
        assert_eq!(
            denial_code(&error),
            (
                StatusCode::FORBIDDEN,
                "cloud_environment_feature_unavailable".to_owned()
            )
        );
        assert!(require_workspace_feature(&with_flag, &boxed).await.is_ok());
        assert!(require_workspace_feature(&without_flag, &docker)
            .await
            .is_ok());
    }

    fn ready_box_task(environment_id: &str, authority: ResolvedAuthorization) -> LiveTask {
        let profile = environments::PreparedEnvironment {
            owner: "user:user-box".into(),
            environment_id: environment_id.into(),
            environment_name: "Edited".into(),
            revision: 1,
            start_instructions: String::new(),
            working_directory: "/workspace".into(),
            repository_directories: Vec::new(),
            script: String::new(),
            task_preamble: String::new(),
            secrets: Vec::new(),
            task_redactions: Vec::new(),
            governed_spec: ryu_sandbox::governed::GovernedWorkspaceSpec {
                egress: ryu_sandbox::governed::EgressPolicy::Denied,
                credentials: Vec::new(),
            },
            vpn_backend: None,
            vpn_key: None,
            governed: false,
            network: false,
            backend_label: "box",
            backend: environments::TaskBackend::Box,
            executor: "ryu".into(),
            lifetime_seconds: 600,
            box_env: Vec::new(),
            box_network: None,
            git_push_token: None,
            primary_repository: None,
            git_env_keys: Vec::new(),
        };
        let context = CloudTaskContext {
            environment_id: environment_id.into(),
            environment_name: "Edited".into(),
            revision: 1,
            working_directory: "/workspace".into(),
            repository_directories: Vec::new(),
            start_instructions: String::new(),
            executor: "ryu".into(),
            backend: "box".into(),
        };
        LiveTask::new(
            context,
            profile,
            TaskWorkspace::Box(WorkspaceId(format!("bx_{}", "c".repeat(32)))),
            now().unwrap() + 600,
            uuid::Uuid::new_v4().to_string(),
            "unused".into(),
            authority,
        )
    }

    /// A prepared box task whose environment no longer selects box (edited to
    /// `auto` or removed) cannot be rebound without the signed flag.
    #[tokio::test]
    async fn box_gate_rebind_of_a_ready_box_task_after_leaving_box_needs_the_flag() {
        use environments::tests::{cloud_auth, denial_code, signed_user_jwt};
        let without_flag = cloud_auth(signed_user_jwt(Some(json!([])), 600).await).await;
        let with_flag =
            cloud_auth(signed_user_jwt(Some(json!([environments::BOX_BACKEND_FLAG])), 600).await)
                .await;
        let owner = environments::owner(&without_flag).unwrap();
        let environment_id = format!("env-left-box-{}", uuid::Uuid::new_v4().simple());
        // The environment is not stored as box, so the early check is skipped.
        assert!(environments::runtime_for(&owner, &environment_id)
            .is_none_or(|runtime| runtime.backend != "box"));
        let conversation = format!("cloud-box-{}", uuid::Uuid::new_v4().simple());
        let key = (owner.clone(), conversation.clone());
        let slot = Arc::new(Mutex::new(TaskState::Ready(Box::new(ready_box_task(
            &environment_id,
            with_flag.clone(),
        )))));
        tasks().lock().await.insert(key.clone(), slot);

        let refused = ensure_task_workspace(&without_flag, &conversation, &environment_id).await;
        let allowed = ensure_task_workspace(&with_flag, &conversation, &environment_id).await;
        tasks().lock().await.remove(&key);

        let error = refused.expect_err("rebind without the flag is refused");
        assert_eq!(
            denial_code(&error),
            (
                StatusCode::FORBIDDEN,
                "cloud_environment_feature_unavailable".to_owned()
            )
        );
        assert_eq!(
            allowed.expect("rebind with the flag").environment_id,
            environment_id
        );
    }

    fn retention_key(prefix: &str) -> TaskKey {
        (
            format!("user:{prefix}-{}", uuid::Uuid::new_v4().simple()),
            format!("{prefix}-{}", uuid::Uuid::new_v4().simple()),
        )
    }

    fn bind(key: &TaskKey, status: &str) {
        assert_eq!(
            records::create(&key.0, &key.1, "env-retention", Default::default).unwrap(),
            records::Created::New
        );
        records::mark(&key.0, &key.1, status, Some(1)).unwrap();
    }

    #[tokio::test]
    async fn deleting_a_conversation_releases_its_binding() {
        let key = retention_key("deleted-cloud");
        bind(&key, "stopped");
        let slot = Arc::new(Mutex::new(TaskState::Stopped));
        tasks().lock().await.insert(key.clone(), slot);

        release_deleted_conversation(&key.1).await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while records::contains_conversation(&key.1).unwrap() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the deleted conversation's binding is released"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!tasks().lock().await.contains_key(&key));
        assert!(!has_bound_task(&key.1).await);
        // The same id starts over as a new, unbound conversation.
        bind(&key, "stopped");
        assert!(records::contains_conversation(&key.1).unwrap());
    }

    #[tokio::test]
    async fn a_deleted_conversation_stays_bound_while_its_task_is_busy() {
        let key = retention_key("deleted-busy");
        bind(&key, "preparing");
        let slot: TaskSlot = Arc::new(Mutex::new(TaskState::Preparing));
        tasks().lock().await.insert(key.clone(), slot.clone());
        assert_eq!(records::mark_deleted(&key.1).unwrap(), vec![key.0.clone()]);

        let held = slot.lock().await;
        assert!(!release_deleted(&key.0, &key.1).await);
        drop(held);
        // An unlocked slot that is still preparing is not released either.
        assert!(!release_deleted(&key.0, &key.1).await);
        // Setup finishing later cannot revive the deleted marker.
        records::mark(&key.0, &key.1, "ready", Some(2)).unwrap();
        assert_eq!(
            records::lookup(&key.0, &key.1).unwrap().unwrap().1,
            records::DELETED
        );
        assert!(has_bound_task(&key.1).await);

        *slot.lock().await = TaskState::Failed;
        assert!(release_deleted(&key.0, &key.1).await);
        assert!(!records::contains_conversation(&key.1).unwrap());
        assert!(!tasks().lock().await.contains_key(&key));
    }

    #[tokio::test]
    async fn terminal_slots_are_dropped_but_their_binding_remains() {
        let stopped = retention_key("terminal-slot");
        let preparing = retention_key("live-slot");
        bind(&stopped, "ready");
        bind(&preparing, "preparing");
        {
            let mut inventory = tasks().lock().await;
            inventory.insert(stopped.clone(), Arc::new(Mutex::new(TaskState::Stopped)));
            inventory.insert(
                preparing.clone(),
                Arc::new(Mutex::new(TaskState::Preparing)),
            );
        }

        prune_terminal_slots().await;

        assert!(!tasks().lock().await.contains_key(&stopped));
        assert_eq!(
            records::lookup(&stopped.0, &stopped.1).unwrap(),
            Some(("env-retention".into(), "stopped".into()))
        );
        assert!(has_bound_task(&stopped.1).await, "the marker still binds");
        assert!(tasks().lock().await.contains_key(&preparing));
        assert_eq!(
            records::create(&stopped.0, &stopped.1, "other", Default::default).unwrap(),
            records::Created::Exists,
            "a dropped slot never permits setup again"
        );
        tasks().lock().await.remove(&preparing);
    }

    /// A `kill_balance` verdict parks the task's Box (never destroys it), and
    /// the task stops with `stopReason: "balance"`.
    #[tokio::test]
    async fn cloud_box_kill_balance_stops_the_task_with_its_reason() {
        use ryu_sandbox::heartbeat::KillReason;
        let harness = super::super::session_box::tests::Harness::new().await;
        let box_id = WorkspaceId(format!("bx_{}", "f".repeat(32)));
        let mut task = ready_box_task("env-kill", super::super::session_box::tests::local_owner());
        let conversation = format!("cloud-kill-{}", uuid::Uuid::new_v4().simple());
        task.workspace = TaskWorkspace::Box(box_id.clone());
        task.conversation_id = conversation.clone();
        let owner = task.profile.owner.clone();
        let lease_id = task.lease_id.clone();
        harness
            .fake
            .add_box(&box_id.0, &format!("ryu-ct-{lease_id}"));
        let key = (owner.clone(), conversation.clone());
        bind(&key, "ready");
        persist_lease(&task).unwrap();
        bind_box(
            &owner,
            &conversation,
            super::super::session_box::BoxTarget {
                box_id: box_id.clone(),
                lease_id: lease_id.clone(),
                run_id: lease_id.clone(),
                size: ryu_sandbox::box_types::BoxSize::Small,
                desktop: true,
                source: super::super::session_box::TargetSource::CloudTask,
            },
        );
        let slot = Arc::new(Mutex::new(TaskState::Ready(Box::new(task))));
        tasks().lock().await.insert(key.clone(), slot.clone());

        let park = box_arm::kill_action(
            owner.clone(),
            conversation.clone(),
            lease_id.clone(),
            box_id.clone(),
        );
        park(KillReason::Balance).await.expect("park confirmed");

        let stop = harness
            .fake
            .find("POST", &format!("/v1/boxes/{}/stop", box_id.0))
            .expect("the Box is parked");
        assert_eq!(stop.body["reason"], "balance");
        assert!(harness.fake.has_box(&box_id.0), "parked, not destroyed");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !matches!(&*slot.lock().await, TaskState::Stopped) {
            assert!(tokio::time::Instant::now() < deadline, "the task stops");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            records::stop_reason(&owner, &conversation)
                .unwrap()
                .as_deref(),
            Some("balance")
        );
        assert_eq!(
            records::lookup(&owner, &conversation).unwrap().unwrap().1,
            "stopped"
        );
        assert!(bound_box(&owner, &conversation).await.is_none());
        let lease = read_lease(
            std::fs::read_dir(lease_directory())
                .unwrap()
                .find(|entry| {
                    entry
                        .as_ref()
                        .is_ok_and(|entry| entry.file_name() == format!("{lease_id}.json").as_str())
                })
                .unwrap(),
            None,
        )
        .unwrap()
        .unwrap()
        .0;
        assert!(box_arm::lease_is_parked(&lease.handle));

        tasks().lock().await.remove(&key);
        remove_lease(&lease_id).unwrap();
        records::mark_deleted(&conversation).unwrap();
        records::remove_deleted(&owner, &conversation).unwrap();
    }

    /// The recovery sweep after a Core restart parks a box lease within its
    /// lifetime (once), destroys an expired one, and a scoped sweep (stop or
    /// delete) destroys a parked one.
    #[tokio::test]
    async fn cloud_box_restart_parks_recovered_leases() {
        let harness = super::super::session_box::tests::Harness::new().await;
        let lease =
            |id: &str, owner: &str, conversation: &str, box_id: &WorkspaceId, expires_at| {
                TaskLease {
                    schema_version: 1,
                    id: id.to_owned(),
                    owner: owner.to_owned(),
                    conversation_id: conversation.to_owned(),
                    expires_at,
                    backend: "box".into(),
                    handle: box_arm::lease_handle(id, Some(box_id)),
                }
            };
        let owner = format!("user:cloud-restart-{}", uuid::Uuid::new_v4().simple());
        let live_conversation = format!("cloud-restart-{}", uuid::Uuid::new_v4().simple());
        let live_lease = uuid::Uuid::new_v4().to_string();
        let live_box = WorkspaceId(format!("bx_{}", "1".repeat(32)));
        harness
            .fake
            .add_box(&live_box.0, &format!("ryu-ct-{live_lease}"));
        persist_record(&lease(
            &live_lease,
            &owner,
            &live_conversation,
            &live_box,
            now().unwrap() + 600,
        ))
        .unwrap();
        let expired_conversation = format!("cloud-expired-{}", uuid::Uuid::new_v4().simple());
        let expired_lease = uuid::Uuid::new_v4().to_string();
        let expired_box = WorkspaceId(format!("bx_{}", "2".repeat(32)));
        harness
            .fake
            .add_box(&expired_box.0, &format!("ryu-ct-{expired_lease}"));
        persist_record(&lease(
            &expired_lease,
            &owner,
            &expired_conversation,
            &expired_box,
            now().unwrap() - 1,
        ))
        .unwrap();

        recover_leases_matching(None).await.unwrap();
        recover_leases_matching(None).await.unwrap();

        let stops = harness
            .fake
            .matching("POST", &format!("/v1/boxes/{}/stop", live_box.0));
        assert_eq!(stops.len(), 1, "parked once, not on every sweep");
        assert_eq!(stops[0].body["reason"], "user");
        assert!(harness.fake.has_box(&live_box.0), "parked, not destroyed");
        assert!(lease_directory()
            .join(format!("{live_lease}.json"))
            .exists());
        assert!(
            !harness.fake.has_box(&expired_box.0),
            "an expired lease is destroyed"
        );
        assert!(!lease_directory()
            .join(format!("{expired_lease}.json"))
            .exists());

        recover_leases_matching(Some((&owner, &live_conversation)))
            .await
            .unwrap();
        assert!(
            !harness.fake.has_box(&live_box.0),
            "a scoped sweep destroys"
        );
        assert!(!lease_directory()
            .join(format!("{live_lease}.json"))
            .exists());
    }

    #[test]
    fn cloud_task_capacity_error_carries_retry_after() {
        let (status, body) = capacity_error(30);
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body.0["error"]["code"], "cloud_task_capacity");
        assert_eq!(body.0["error"]["retryAfter"], 30);
    }

    #[test]
    fn cloud_task_capacity_unbinds_only_a_preparing_marker() {
        let preparing = retention_key("capacity-preparing");
        bind(&preparing, "preparing");
        records::unbind_preparing(&preparing.0, &preparing.1).unwrap();
        assert!(!records::contains_conversation(&preparing.1).unwrap());
        let ready = retention_key("capacity-ready");
        bind(&ready, "ready");
        records::unbind_preparing(&ready.0, &ready.1).unwrap();
        assert_eq!(
            records::lookup(&ready.0, &ready.1).unwrap().unwrap().1,
            "ready"
        );
        records::mark_deleted(&ready.1).unwrap();
        records::remove_deleted(&ready.0, &ready.1).unwrap();
    }

    #[test]
    fn cloud_box_lease_handle_names_the_box_deterministically() {
        let id = WorkspaceId(format!("bx_{}", "a".repeat(32)));
        assert_eq!(
            box_arm::lease_handle("lease-1", Some(&id)),
            json!({"name":"ryu-ct-lease-1","boxId":id.0})
        );
        assert_eq!(
            box_arm::lease_handle("lease-1", None),
            json!({"name":"ryu-ct-lease-1","boxId":null})
        );
    }
}
