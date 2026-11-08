//! Release, retention, kill and restart tests for cloud task Boxes.

use super::*;

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
    assert!(!binding::has_bound_task(&key.1).await);
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
    let harness = crate::server::session_box::tests::Harness::new().await;
    let box_id = WorkspaceId(format!("bx_{}", "f".repeat(32)));
    let mut task = ready_box_task("env-kill", crate::server::session_box::tests::local_owner());
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
        crate::server::session_box::BoxTarget {
            box_id: box_id.clone(),
            lease_id: lease_id.clone(),
            run_id: lease_id.clone(),
            size: ryu_sandbox::box_types::BoxSize::Small,
            desktop: true,
            source: crate::server::session_box::TargetSource::CloudTask,
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
    let harness = crate::server::session_box::tests::Harness::new().await;
    let lease =
        |id: &str, owner: &str, conversation: &str, box_id: &WorkspaceId, expires_at| TaskLease {
            schema_version: 1,
            id: id.to_owned(),
            owner: owner.to_owned(),
            conversation_id: conversation.to_owned(),
            expires_at,
            backend: "box".into(),
            handle: box_arm::lease_handle(id, Some(box_id)),
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
