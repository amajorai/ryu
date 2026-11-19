//! Deleting session Boxes and recovering leases after a restart.
// test-exempt: moved verbatim out of server/session_box.rs; covered by session_box/tests.rs and broker_relay_tests.rs.

use super::*;

pub(super) async fn destroy_named(client: &BoxSessionClient, name: &str) -> Result<()> {
    if let Some(workspace) = client.find_by_name(name).await? {
        destroy_box(client, &workspace).await?;
    }
    Ok(())
}

/// Delete a Box; one that is already gone counts as deleted.
pub(super) async fn destroy_box(client: &BoxSessionClient, box_id: &WorkspaceId) -> Result<()> {
    match client.destroy(box_id).await {
        Ok(()) => Ok(()),
        Err(error)
            if error
                .downcast_ref::<BoxApiError>()
                .is_some_and(|error| *error == BoxApiError::NotFound) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

/// Delete one lease's Box (by id, or by its deterministic name) and the lease.
pub(super) async fn destroy_lease(client: &BoxSessionClient, lease: &SessionLease) -> Result<()> {
    match &lease.box_id {
        Some(id) => destroy_box(client, &WorkspaceId(id.clone())).await?,
        None => destroy_named(client, &lease.name()).await?,
    }
    broker_relay::revoke_relay(&lease.id).await;
    remove_lease(&lease.id)
}

/// The conversation was deleted: delete its Box and every child Box, for
/// `owner`. A Box that cannot be deleted yet keeps a `deleted` lease, which
/// the idle sweep retries.
pub(crate) async fn release_conversation(owner: &str, conversation_id: &str) {
    // First, so no acquisition waiting on one of these slots (or starting
    // after this point) creates a Box for the deleted conversation.
    tombstone(conversation_id);
    let keys: Vec<SessionBoxKey> = conversation_keys(conversation_id)
        .into_iter()
        .filter(|key| key.owner == owner)
        .collect();
    let client = box_client().await.ok();
    for key in keys {
        let Some(slot) = existing_slot(&key) else {
            continue;
        };
        let mut guard = slot.lock().await;
        if let Some(entry) = guard.as_mut() {
            entry.stop_refresher();
            finish_metering(&entry.run_id(), entry.metering.as_ref()).await;
            entry.metering = None;
            let mut lease = lease_of(entry);
            lease.deleted = true;
            let _ = write_lease(&lease);
        }
        *guard = None;
        drop(guard);
        let mut registry = lock_registry();
        if registry
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &slot))
        {
            registry.remove(&key);
        }
    }
    lock_shared().retain(|key| !(key.owner == owner && key.conversation_id == conversation_id));
    lock_child_counters().remove(&(owner.to_owned(), conversation_id.to_owned()));
    for mut lease in leases()
        .into_iter()
        .filter(|lease| lease.owner == owner && lease.conversation_id == conversation_id)
    {
        let destroyed = match &client {
            Some(client) => destroy_lease(client, &lease).await,
            None => Err(anyhow!("Ryu Box is not configured on this node")),
        };
        if let Err(error) = destroyed {
            tracing::warn!(lease = %lease.id, error = %error, "Session Box of a deleted conversation could not be deleted yet; retrying later");
            if !lease.deleted {
                lease.deleted = true;
                let _ = write_lease(&lease);
            }
        }
    }
}

/// [`release_conversation`] for every owner holding a Box in the deleted
/// conversation. The delete route already checked the caller's write access.
pub(crate) async fn release_deleted_conversation(conversation_id: &str) {
    tombstone(conversation_id);
    crate::sidecar::mcp::box_desktop::forget_children_of(conversation_id);
    // Ryu's record of a run on the user's plan; the run itself lives on the provider.
    crate::server::subscription_cloud::store::forget_conversation(conversation_id);
    let mut owners: Vec<String> = conversation_keys(conversation_id)
        .into_iter()
        .map(|key| key.owner)
        .chain(
            leases()
                .into_iter()
                .filter(|lease| lease.conversation_id == conversation_id)
                .map(|lease| lease.owner),
        )
        .collect();
    owners.sort();
    owners.dedup();
    for owner in owners {
        release_conversation(&owner, conversation_id).await;
    }
}

/// Whether another owner holds a Box (session or cloud task) in this
/// conversation.
pub(super) async fn held_by_another_owner(owner: &str, conversation_id: &str) -> bool {
    conversation_keys(conversation_id)
        .iter()
        .any(|key| key.owner != owner)
        || leases()
            .iter()
            .any(|lease| lease.conversation_id == conversation_id && lease.owner != owner)
        || cloud_tasks::bound_box_owner(conversation_id)
            .await
            .is_some_and(|holder| holder != owner)
}

/// Recover leases left by an earlier Core process: park their Boxes and
/// register them as parked, so the next heavy call resumes them; delete the
/// ones whose conversation was deleted or whose Box the service has reaped.
pub(crate) async fn recover_leases() {
    let Ok(client) = box_client().await else {
        return;
    };
    let now = unix_now();
    for mut lease in leases() {
        let key = lease.key();
        if existing_slot(&key).is_some() || creating_leases().contains(&lease.id) {
            continue;
        }
        // A Box whose run is still metered here has no registry entry left
        // to park it (an earlier orphaned entry); end that metering first.
        stop_orphan_metering(&lease.id).await;
        if lease.deleted || lease.box_expires_at <= now || lease.box_id.is_none() {
            if let Err(error) = destroy_lease(&client, &lease).await {
                tracing::warn!(lease = %lease.id, error = %error, "Session Box lease cleanup failed; retrying later");
            }
            continue;
        }
        let Some(box_id) = lease.box_id.clone().map(WorkspaceId) else {
            continue;
        };
        if !lease.parked {
            match client.park(&box_id, ParkReason::User).await {
                Ok(()) => {}
                Err(BoxApiError::NotFound) => {
                    broker_relay::revoke_relay(&lease.id).await;
                    let _ = remove_lease(&lease.id);
                    continue;
                }
                Err(error) => {
                    tracing::warn!(lease = %lease.id, error = %error, "Recovered session Box could not be parked yet; retrying later");
                    continue;
                }
            }
            lease.parked = true;
        }
        // Continue above every epoch a key was signed for before the restart.
        lease.lease_epoch = lease.lease_epoch.saturating_add(1).max(1);
        let _ = write_lease(&lease);
        let entry = Entry {
            key: key.clone(),
            lease_id: lease.id.clone(),
            box_id,
            size: lease.size,
            phase: Phase::Parked,
            lease_epoch: lease.lease_epoch,
            last_activity: Instant::now(),
            run_until: now,
            box_expires_at: lease.box_expires_at,
            metering: None,
            stop_reason: Some("restart".to_owned()),
            refresher: None,
        };
        let slot = slot_for(&key);
        let mut guard = slot.lock().await;
        if guard.is_none() {
            *guard = Some(entry);
        }
    }
}

/// Deregister, with the final debit of its un-ticked tail, every heartbeat
/// run of `lease_id` (`<lease_id>-e<epoch>`).
pub(super) async fn stop_orphan_metering(lease_id: &str) {
    let prefix = format!("{lease_id}-e");
    for run in heartbeat::list_active_runs()
        .into_iter()
        .filter(|run| run.run_id.starts_with(&prefix))
    {
        tracing::warn!(run = %run.run_id, "Session Box run had no registry entry; ending its metering");
        let metering = BoxMetering {
            org_id: run.org_id.clone(),
            spec: run.spec.clone(),
            budget_micro_usd: run.per_run_budget_micro_usd,
            started: Instant::now()
                .checked_sub(Duration::from_secs(run.elapsed_seconds))
                .unwrap_or_else(Instant::now),
        };
        finish_metering(&run.run_id, Some(&metering)).await;
    }
}
