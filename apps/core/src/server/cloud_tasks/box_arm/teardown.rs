//! Kill verdicts, teardown, parking and lease recovery of a cloud task Box.
//! test-exempt: moved from box_arm.rs; release_tests.rs drives kill_action, parking and lease recovery against a fake Box, and box_arm/relay_tests.rs checks that recovery revokes the Box's broker relay.

use super::*;

/// The kill action of a cloud task Box: park it with the verdict's reason,
/// then stop the task with that `stopReason`. The heartbeat retries a failed
/// park until it is confirmed.
pub(in crate::server::cloud_tasks) fn kill_action(
    owner: String,
    conversation_id: String,
    lease_id: String,
    workspace: WorkspaceId,
) -> ParkFn {
    Arc::new(move |reason: KillReason| {
        let owner = owner.clone();
        let conversation_id = conversation_id.clone();
        let lease_id = lease_id.clone();
        let workspace = workspace.clone();
        Box::pin(async move {
            let client = session_box::box_client().await?;
            // A running foreground command must not keep an out-of-credit
            // Box running: interrupt it and park.
            session_box::park_for_billing(&client, &workspace, reason.park_reason())
                .await
                .map_err(anyhow::Error::new)?;
            tokio::spawn(mark_killed(
                owner,
                conversation_id,
                lease_id,
                workspace,
                reason.as_str(),
            ));
            Ok(())
        })
    })
}

/// After a kill verdict parked the Box: the task stops with its reason, the
/// lease records the park, and the Box no longer routes machine verbs.
pub(in crate::server::cloud_tasks) async fn mark_killed(
    owner: String,
    conversation_id: String,
    lease_id: String,
    workspace: WorkspaceId,
    reason: &'static str,
) {
    crate::vault::broker::box_relay::revoke_for_lease(&lease_id).await;
    unbind_box(&owner, &conversation_id, &lease_id);
    if let Err(error) = records::mark_stopped(&owner, &conversation_id, reason) {
        tracing::warn!(error = %error, "Cloud task stop reason could not be recorded");
    }
    let slot = tasks()
        .lock()
        .await
        .get(&(owner.clone(), conversation_id.clone()))
        .cloned();
    if let Some(slot) = slot {
        let mut state = slot.lock().await;
        if matches!(&*state, TaskState::Ready(task) if task.lease_id == lease_id) {
            if let TaskState::Ready(task) = &*state {
                let lease = TaskLease {
                    handle: parked_handle(&lease_id, &workspace),
                    ..box_lease(
                        &task.profile,
                        &lease_id,
                        &conversation_id,
                        task.expires_at,
                        Some(&workspace),
                    )
                };
                if let Err(error) = persist_record_replace(&lease) {
                    tracing::warn!(error = %error, "Cloud task lease could not record the park");
                }
            }
            *state = TaskState::Stopped;
        }
    }
}

pub(super) async fn destroy_named(client: &BoxSessionClient, name: &str) -> Result<()> {
    if let Some(workspace) = client.find_by_name(name).await? {
        client.destroy(&workspace).await?;
    }
    Ok(())
}

/// Destroy a live Box task: cancel its run, settle billing, destroy, unlease.
pub(in crate::server::cloud_tasks) async fn destroy(
    task: &LiveTask,
    workspace: &WorkspaceId,
) -> Result<()> {
    // The Box's broker relay ends first, whatever happens to the Box.
    crate::vault::broker::box_relay::revoke_for_lease(&task.lease_id).await;
    let client = session_box::box_client().await?;
    if let Some(run) = &task.active_run {
        // Best effort: destroying the Box also fails the run server-side.
        let _ = client.cancel_prompt(workspace, &run.id).await;
    }
    if task.metered {
        session_box::finish_metering(&task.lease_id, task.metering.as_ref()).await;
    }
    match client.destroy(workspace).await {
        Ok(()) => {}
        Err(error)
            if error
                .downcast_ref::<BoxApiError>()
                .is_some_and(|error| *error == BoxApiError::NotFound) => {}
        Err(error) => return Err(error),
    }
    unbind_box(&task.profile.owner, &task.conversation_id, &task.lease_id);
    remove_lease(&task.lease_id)
}

/// Park a live Box task (the session Stop button): cancel its run, save its
/// state and release compute, settle billing, and record the park on the
/// lease. The caller marks the task stopped.
pub(in crate::server::cloud_tasks) async fn park(
    task: &LiveTask,
    workspace: &WorkspaceId,
    reason: ParkReason,
) -> Result<()> {
    crate::vault::broker::box_relay::revoke_for_lease(&task.lease_id).await;
    let client = session_box::box_client().await?;
    if let Some(run) = &task.active_run {
        let _ = client.cancel_prompt(workspace, &run.id).await;
    }
    match client.park(workspace, reason).await {
        Ok(()) | Err(BoxApiError::NotFound) => {}
        Err(error) => return Err(error.into()),
    }
    if task.metered {
        session_box::finish_metering(&task.lease_id, task.metering.as_ref()).await;
    }
    unbind_box(&task.profile.owner, &task.conversation_id, &task.lease_id);
    let lease = TaskLease {
        handle: parked_handle(&task.lease_id, workspace),
        ..box_lease(
            &task.profile,
            &task.lease_id,
            &task.conversation_id,
            task.expires_at,
            Some(workspace),
        )
    };
    persist_record_replace(&lease)
}

/// Destroy the Box an orphaned lease names. Leases never resume.
pub(in crate::server::cloud_tasks) async fn recover_lease(
    lease_id: &str,
    handle: &Value,
) -> Result<()> {
    crate::vault::broker::box_relay::revoke_for_lease(lease_id).await;
    let name = handle
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Invalid cloud Box lease handle"))?;
    ensure!(
        name == box_name(lease_id),
        "Invalid cloud Box lease identity"
    );
    let client = session_box::box_client().await?;
    match handle.get("boxId") {
        Some(Value::String(id)) => match client.destroy(&WorkspaceId(id.clone())).await {
            Ok(()) => Ok(()),
            Err(error)
                if error
                    .downcast_ref::<BoxApiError>()
                    .is_some_and(|error| *error == BoxApiError::NotFound) =>
            {
                Ok(())
            }
            Err(error) => Err(error),
        },
        None | Some(Value::Null) => destroy_named(&client, name).await,
        Some(_) => bail!("Invalid cloud Box lease handle"),
    }
}

/// Park the Box an orphaned lease names (a Core restart, design §7.3) and
/// return the lease's parked handle. A lease written before its create
/// returned has no Box id: that Box is destroyed by name instead, and the
/// handle names no Box.
pub(in crate::server::cloud_tasks) async fn park_lease(
    lease_id: &str,
    handle: &Value,
) -> Result<Value> {
    crate::vault::broker::box_relay::revoke_for_lease(lease_id).await;
    let name = handle
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Invalid cloud Box lease handle"))?;
    ensure!(
        name == box_name(lease_id),
        "Invalid cloud Box lease identity"
    );
    let client = session_box::box_client().await?;
    match handle.get("boxId") {
        Some(Value::String(id)) => {
            let workspace = WorkspaceId(id.clone());
            match client.park(&workspace, ParkReason::User).await {
                Ok(()) | Err(BoxApiError::NotFound) => {}
                Err(error) => return Err(error.into()),
            }
            Ok(parked_handle(lease_id, &workspace))
        }
        None | Some(Value::Null) => {
            destroy_named(&client, name).await?;
            Ok(json!({"name": name, "boxId": null, "parked": true}))
        }
        Some(_) => bail!("Invalid cloud Box lease handle"),
    }
}
