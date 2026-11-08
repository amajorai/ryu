//! Preparing or reusing a conversation's task workspace.

use super::release::{leased_keys, slot_is_live};
use super::routes::prepare_task;
use super::*;

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
    if crate::server::subscription_cloud::fences_box(conversation_id) {
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
                        error.downcast_ref::<crate::server::session_box::AdmissionRefusal>()
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
