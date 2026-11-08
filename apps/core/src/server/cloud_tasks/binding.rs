//! Conversation bindings: validating a requested binding and reading it back.

use super::*;

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
pub(in crate::server) async fn binding_metadata(
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
pub(super) fn saved_runtime_labels(owner: &str, environment_id: &str) -> (String, String) {
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
pub(super) fn bound_boxes(
) -> &'static std::sync::Mutex<HashMap<TaskKey, crate::server::session_box::BoxTarget>> {
    static BOUND: OnceLock<
        std::sync::Mutex<HashMap<TaskKey, crate::server::session_box::BoxTarget>>,
    > = OnceLock::new();
    BOUND.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

pub(super) fn lock_bound_boxes(
) -> std::sync::MutexGuard<'static, HashMap<TaskKey, crate::server::session_box::BoxTarget>> {
    bound_boxes()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Record the live Box of a cloud task.
pub(in crate::server) fn bind_box(
    owner: &str,
    conversation_id: &str,
    target: crate::server::session_box::BoxTarget,
) {
    lock_bound_boxes().insert((owner.to_owned(), conversation_id.to_owned()), target);
}

/// Forget a cloud task's Box (destroyed or parked). Only the named lease is
/// removed, so a later task's Box is never dropped by an older teardown.
pub(in crate::server) fn unbind_box(owner: &str, conversation_id: &str, lease_id: &str) {
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
) -> Option<crate::server::session_box::BoxTarget> {
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
                        Some(box_error) => crate::server::session_box::box_api_error(box_error),
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
