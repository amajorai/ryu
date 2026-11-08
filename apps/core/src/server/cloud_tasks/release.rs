//! Stopping, releasing and sweeping tasks.

use super::leases::{lease_directory, read_lease, recover_leases, recover_leases_matching};
use super::*;

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
pub(super) fn slot_is_live(slot: &TaskSlot) -> bool {
    slot.try_lock().map_or(true, |state| {
        matches!(&*state, TaskState::Preparing | TaskState::Ready(_))
    })
}

/// Conversations that still hold a resource lease. Unreadable lease files are
/// skipped here; [`recover_leases`] reports them.
pub(super) fn leased_keys() -> HashSet<TaskKey> {
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
        crate::server::session_box::release_deleted_conversation(&released).await;
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
pub(super) async fn release_deleted(owner: &str, conversation_id: &str) -> bool {
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
pub(super) async fn prune_terminal_slots() {
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
pub(super) async fn sweep_retention() {
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

pub(in crate::server) fn start_recovery() {
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
