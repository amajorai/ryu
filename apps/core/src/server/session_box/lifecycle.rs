//! Creating, resuming, parking and touching session Boxes.
// test-exempt: moved out of server/session_box.rs (plus the broker relay wiring); covered by session_box/tests.rs and broker_relay_tests.rs.

use super::*;
use crate::vault::broker::box_relay::BoxRelayOwner;

/// Drop a slot that never got an entry.
pub(super) fn forget_empty(key: &SessionBoxKey, slot: &Slot) {
    let mut registry = lock_registry();
    if registry.get(key).is_some_and(|current| {
        Arc::ptr_eq(current, slot) && current.try_lock().is_ok_and(|entry| entry.is_none())
    }) {
        registry.remove(key);
    }
}

/// Create a new session Box for `key`: the broker relay of `relay_owner`
/// (fails closed, [`broker_relay`]), lease first, then create with its own
/// desktop, then meter and deliver its inference credential.
pub(super) async fn create_entry(
    key: &SessionBoxKey,
    relay_owner: &BoxRelayOwner,
) -> Result<Entry, ApiError> {
    let credential = box_credential()
        .await
        .map_err(|_| unavailable("Ryu Box is not configured on this node."))?;
    let client = BoxSessionClient::from_credential(&credential);
    let lease_id = uuid::Uuid::new_v4().to_string();
    let _creating = CreatingLease::new(&lease_id);
    let name = box_name(&lease_id);
    let size = BoxSize::default();
    let now = unix_now();
    let mut lease = SessionLease {
        schema_version: 1,
        id: lease_id.clone(),
        owner: key.owner.clone(),
        conversation_id: key.conversation_id.clone(),
        child: key.child,
        box_id: None,
        size,
        parked: false,
        deleted: false,
        box_expires_at: now + BOX_TTL_SECONDS,
        lease_epoch: 1,
    };
    // The broker relay's session reaches only the Box's egress sidecar.
    let relay = broker_relay::plan_for_box(&lease_id, relay_owner, &client).await?;
    if write_lease(&lease).is_err() {
        broker_relay::revoke_relay(&lease_id).await;
        return Err(unavailable("Session Box lease persistence failed."));
    }
    let mut labels = BTreeMap::new();
    labels.insert(
        "ryu-kind".to_owned(),
        if key.child.is_some() {
            "sub-agent"
        } else {
            "session"
        }
        .to_owned(),
    );
    labels.insert("ryu-lease".to_owned(), lease_id.clone());
    let spec = DisposableBoxSpec {
        name: name.clone(),
        image: None,
        network: BoxNetwork::Egress,
        ttl_seconds: BOX_TTL_SECONDS,
        setup: Vec::new(),
        size,
        desktop: true,
        labels,
    };
    let created = client
        .create_disposable_with_egress(&spec, &name, &[], relay.as_ref())
        .await;
    let box_id = match created {
        Ok(box_id) => box_id,
        Err(error) => {
            broker_relay::revoke_relay(&lease_id).await;
            // An idempotent create can leave a Box behind; keep the lease
            // unless cleanup is confirmed.
            if destroy_named(&client, &name).await.is_ok() {
                let _ = remove_lease(&lease_id);
            }
            return Err(box_api_error(&error));
        }
    };
    lease.box_id = Some(box_id.0.clone());
    if write_lease(&lease).is_err() {
        broker_relay::revoke_relay(&lease_id).await;
        let _ = client.destroy(&box_id).await;
        let _ = remove_lease(&lease_id);
        return Err(unavailable("Session Box lease persistence failed."));
    }
    let mut entry = Entry {
        key: key.clone(),
        lease_id,
        box_id,
        size,
        phase: Phase::Live,
        lease_epoch: 1,
        last_activity: Instant::now(),
        run_until: now + RUN_LIFETIME_SECONDS,
        box_expires_at: lease.box_expires_at,
        metering: None,
        stop_reason: None,
        refresher: None,
    };
    // A created Box always pays its per-start minimum.
    go_live(&mut entry, credential.billing_owner, None).await;
    Ok(entry)
}

/// Metering and the inference credential of a Box that just became live.
/// `minimum_waiver` is the Box service's signed verdict for this start.
pub(super) async fn go_live(
    entry: &mut Entry,
    billing_owner: BillingOwner,
    minimum_waiver: Option<String>,
) {
    entry.metering = start_metering(
        &entry.run_id(),
        &entry.box_id,
        entry.size,
        billing_owner,
        session_kill_action(entry.key.clone(), entry.box_id.clone(), entry.lease_epoch),
        minimum_waiver,
    )
    .await;
    entry.refresher =
        inference::start_refresher(entry.key.clone(), entry.box_id.clone(), entry.lease_epoch);
}

/// Resume a parked entry (admission already ran).
pub(super) async fn resume_entry(entry: &mut Entry) -> Result<(), ApiError> {
    if entry.phase == Phase::Live {
        entry.last_activity = Instant::now();
        return Ok(());
    }
    let credential = box_credential()
        .await
        .map_err(|_| unavailable("Ryu Box is not configured on this node."))?;
    let client = BoxSessionClient::from_credential(&credential);
    let resumed = client
        .resume(&entry.box_id)
        .await
        .map_err(|error| box_api_error(&error))?;
    entry.phase = Phase::Live;
    entry.lease_epoch = entry.lease_epoch.saturating_add(1);
    entry.last_activity = Instant::now();
    entry.run_until = unix_now() + RUN_LIFETIME_SECONDS;
    entry.stop_reason = None;
    if let Err(error) = write_lease(&lease_of(entry)) {
        tracing::warn!(error = %error, "Session Box lease could not record the resume");
    }
    // The Box service decides whether this resume owes a new minimum (only a
    // resume onto the Box's own parked VM inside the hour already paid for)
    // and signs that for the Gateway, which verifies it.
    go_live(entry, credential.billing_owner, resumed.minimum_waiver()).await;
    Ok(())
}

/// Park one live entry: save state and release compute, then stop metering
/// and the credential refresher.
pub(super) async fn park_entry(entry: &mut Entry, reason: ParkReason) -> Result<(), ApiError> {
    if entry.phase != Phase::Live {
        return Ok(());
    }
    let client = box_client()
        .await
        .map_err(|_| unavailable("Ryu Box is not configured on this node."))?;
    match client.park(&entry.box_id, reason).await {
        Ok(()) | Err(BoxApiError::NotFound) => {}
        Err(error) => return Err(box_api_error(&error)),
    }
    entry.stop_refresher();
    finish_metering(&entry.run_id(), entry.metering.as_ref()).await;
    entry.metering = None;
    entry.phase = Phase::Parked;
    entry.stop_reason = Some(reason.as_str().to_owned());
    if let Err(error) = write_lease(&lease_of(entry)) {
        tracing::warn!(error = %error, "Session Box lease could not record the park");
    }
    Ok(())
}

/// Mark a session Box active (a tool call ran on it).
pub(crate) async fn touch(key: &SessionBoxKey) {
    let key = if key.child.is_some() && lock_shared().contains(key) {
        key.parent()
    } else {
        key.clone()
    };
    if let Some(slot) = existing_slot(&key) {
        if let Some(entry) = slot.lock().await.as_mut() {
            entry.last_activity = Instant::now();
        }
    }
}

/// Park the Box of `key`; parking a conversation's own Box parks its
/// children too.
pub(crate) async fn park(key: &SessionBoxKey, reason: ParkReason) -> Result<(), ApiError> {
    let mut keys = vec![key.clone()];
    if key.child.is_none() {
        keys.extend(
            conversation_keys(&key.conversation_id)
                .into_iter()
                .filter(|other| other.owner == key.owner && other.child.is_some()),
        );
    }
    let mut first_error = None;
    for key in keys {
        let Some(slot) = existing_slot(&key) else {
            continue;
        };
        let mut guard = slot.lock().await;
        if let Some(entry) = guard.as_mut() {
            if let Err(error) = park_entry(entry, reason).await {
                first_error.get_or_insert(error);
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// Whether the machine verbs of `key` go to a Box: the conversation has a
/// cloud task Box or a session Box (live or parked), or, for a sub-agent
/// child, the child has its own Box.
pub(crate) async fn routes_to_box(key: &SessionBoxKey) -> bool {
    if cloud_tasks::bound_box(&key.owner, &key.conversation_id)
        .await
        .is_some()
    {
        return true;
    }
    let mut keys = vec![key.parent()];
    if key.child.is_some() {
        keys.push(key.clone());
    }
    keys.iter().any(|key| {
        existing_slot(key).is_some_and(|slot| {
            // An entry being created holds the lock; it routes to the Box it
            // will be.
            slot.try_lock().map_or(true, |entry| entry.is_some())
        })
    })
}

/// The lowest free sub-agent child number of a conversation (1, 2, …), or
/// `None` when all [`MAX_CHILDREN`] are held by sub-agents still running.
/// A finished sub-agent returns its number with [`release_child`].
pub(crate) fn next_child_index(owner: &str, conversation_id: &str) -> Option<u32> {
    let mut counters = lock_child_counters();
    let used = counters
        .entry((owner.to_owned(), conversation_id.to_owned()))
        .or_default();
    let index = (1..=MAX_CHILDREN).find(|index| !used.contains(index))?;
    used.insert(index);
    Some(index)
}

/// A sub-agent finished: park its child Box (state kept for the next child
/// that takes the number) and free its number.
pub(crate) async fn release_child(key: &SessionBoxKey) {
    let Some(index) = key.child else {
        return;
    };
    lock_shared().remove(key);
    if let Err(error) = park(key, ParkReason::Idle).await {
        tracing::warn!(error = ?error.1 .0, "Finished sub-agent's Box could not be parked; the idle sweep retries");
    }
    let mut counters = lock_child_counters();
    let conversation = (key.owner.clone(), key.conversation_id.clone());
    if let Some(used) = counters.get_mut(&conversation) {
        used.remove(&index);
        if used.is_empty() {
            counters.remove(&conversation);
        }
    }
}
