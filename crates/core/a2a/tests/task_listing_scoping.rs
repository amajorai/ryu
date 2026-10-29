//! Caller-owned scoping for A2A `tasks/list` and push-notification config
//! list/delete. Protocol handlers rely on these store queries never returning
//! another principal's or tenant's tasks, so every filter is asserted against a
//! store that also holds foreign rows that would match the same filter.

use chrono::{SecondsFormat, Utc};
use ryu_a2a::{
    A2aStore, A2aTaskRecord, EndpointPolicy, PushConfigInput, StoreError, TaskCreate,
    TaskDirection, TaskState,
};
use ryu_crypto::FieldCipher;
use serde_json::json;

const MAX_PAGE_SIZE: usize = 200;

fn store() -> A2aStore {
    A2aStore::open_in_memory(FieldCipher::new(&[9_u8; 32])).expect("open A2A store")
}

fn create(store: &A2aStore, tenant: &str, owner: &str, task: &str, context: &str) -> A2aTaskRecord {
    store
        .create_task(TaskCreate {
            id: task.to_owned(),
            context_id: context.to_owned(),
            tenant_id: tenant.to_owned(),
            owner_id: owner.to_owned(),
            peer_id: None,
            local_agent_id: Some("agent-1".to_owned()),
            direction: TaskDirection::Inbound,
            state: TaskState::Submitted,
            protocol_task: json!({"id": task, "status": {"state": "submitted"}}),
        })
        .expect("create task")
}

/// Busy-waits (no sleep) until the store's millisecond clock has moved past
/// `after`, so the next write gets a strictly later `updated_at`.
fn wait_past(after: &str) {
    while Utc::now()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
        .as_str()
        <= after
    {
        std::hint::spin_loop();
    }
}

fn ids(tasks: &[A2aTaskRecord]) -> Vec<String> {
    let mut ids: Vec<String> = tasks.iter().map(|task| task.id.clone()).collect();
    ids.sort();
    ids
}

fn push_input(id: &str) -> PushConfigInput {
    PushConfigInput {
        id: id.to_owned(),
        callback_url: "https://example.com/a2a/events".to_owned(),
        token: Some("push-secret".to_owned()),
        authentication: None,
    }
}

/// Owner A in tenant A has three tasks; the same owner ID in tenant B and a
/// second owner in tenant A each have tasks in the same context.
fn seeded() -> A2aStore {
    let store = store();
    create(&store, "tenant-a", "owner-a", "a-1", "ctx-1");
    create(&store, "tenant-a", "owner-a", "a-2", "ctx-1");
    create(&store, "tenant-a", "owner-a", "a-3", "ctx-2");
    create(&store, "tenant-a", "owner-b", "b-1", "ctx-1");
    create(&store, "tenant-b", "owner-a", "x-1", "ctx-1");
    store
}

#[test]
fn list_and_count_return_only_the_callers_tasks() {
    let store = seeded();
    let listed = store
        .list_tasks_owned("tenant-a", "owner-a", None, None, None, 50, 0)
        .expect("list tasks");
    assert_eq!(ids(&listed), ["a-1", "a-2", "a-3"]);
    assert!(listed
        .iter()
        .all(|task| task.tenant_id == "tenant-a" && task.owner_id == "owner-a"));
    assert_eq!(
        store
            .count_tasks_owned("tenant-a", "owner-a", None, None, None)
            .expect("count tasks"),
        3
    );

    let other_owner = store
        .list_tasks_owned("tenant-a", "owner-b", None, None, None, 50, 0)
        .expect("list owner-b tasks");
    assert_eq!(ids(&other_owner), ["b-1"]);
    let other_tenant = store
        .list_tasks_owned("tenant-b", "owner-a", None, None, None, 50, 0)
        .expect("list tenant-b tasks");
    assert_eq!(ids(&other_tenant), ["x-1"]);
    assert_eq!(
        store
            .count_tasks_owned("tenant-c", "owner-a", None, None, None)
            .expect("count unknown tenant"),
        0
    );
}

#[test]
fn context_and_state_filters_apply_within_the_callers_scope() {
    let store = seeded();
    store
        .transition_task(
            "tenant-a",
            "owner-a",
            "a-2",
            TaskState::Working,
            &json!({"id": "a-2", "status": {"state": "working"}}),
        )
        .expect("advance a-2");
    store
        .transition_task(
            "tenant-a",
            "owner-b",
            "b-1",
            TaskState::Working,
            &json!({"id": "b-1", "status": {"state": "working"}}),
        )
        .expect("advance b-1");

    let by_context = store
        .list_tasks_owned("tenant-a", "owner-a", Some("ctx-1"), None, None, 50, 0)
        .expect("filter by context");
    assert_eq!(ids(&by_context), ["a-1", "a-2"]);
    assert_eq!(
        store
            .count_tasks_owned("tenant-a", "owner-a", Some("ctx-1"), None, None)
            .expect("count by context"),
        2
    );

    let working = store
        .list_tasks_owned(
            "tenant-a",
            "owner-a",
            None,
            Some(TaskState::Working),
            None,
            50,
            0,
        )
        .expect("filter by state");
    assert_eq!(ids(&working), ["a-2"]);

    let combined = store
        .list_tasks_owned(
            "tenant-a",
            "owner-a",
            Some("ctx-2"),
            Some(TaskState::Submitted),
            None,
            50,
            0,
        )
        .expect("combined filter");
    assert_eq!(ids(&combined), ["a-3"]);
    assert_eq!(
        store
            .count_tasks_owned(
                "tenant-a",
                "owner-a",
                Some("ctx-1"),
                Some(TaskState::Working),
                None
            )
            .expect("combined count"),
        1
    );
    assert_eq!(
        store
            .count_tasks_owned("tenant-a", "owner-a", Some("missing"), None, None)
            .expect("count unknown context"),
        0
    );
}

#[test]
fn updated_after_returns_only_strictly_newer_tasks() {
    let store = store();
    let first = create(&store, "tenant-a", "owner-a", "old", "ctx-1");
    wait_past(&first.updated_at);
    create(&store, "tenant-a", "owner-a", "new", "ctx-1");
    create(&store, "tenant-b", "owner-a", "foreign-new", "ctx-1");

    let newer = store
        .list_tasks_owned(
            "tenant-a",
            "owner-a",
            None,
            None,
            Some(&first.updated_at),
            50,
            0,
        )
        .expect("updated_after filter");
    assert_eq!(ids(&newer), ["new"]);
    assert_eq!(
        store
            .count_tasks_owned("tenant-a", "owner-a", None, None, Some(&first.updated_at))
            .expect("updated_after count"),
        1
    );
    assert!(store
        .list_tasks_owned(
            "tenant-a",
            "owner-a",
            None,
            None,
            Some("9999-01-01T00:00:00.000Z"),
            50,
            0
        )
        .expect("future cutoff")
        .is_empty());
}

#[test]
fn limit_is_clamped_and_offset_pages_without_overlap() {
    let store = store();
    for index in 0..(MAX_PAGE_SIZE + 5) {
        create(
            &store,
            "tenant-a",
            "owner-a",
            &format!("task-{index:03}"),
            "ctx-1",
        );
    }
    create(&store, "tenant-a", "owner-b", "foreign", "ctx-1");

    let zero_limit = store
        .list_tasks_owned("tenant-a", "owner-a", None, None, None, 0, 0)
        .expect("zero limit");
    assert_eq!(zero_limit.len(), 1, "a zero limit is raised to one row");

    let huge = store
        .list_tasks_owned("tenant-a", "owner-a", None, None, None, u32::MAX, 0)
        .expect("huge limit");
    assert_eq!(
        huge.len(),
        MAX_PAGE_SIZE,
        "limit is capped at MAX_PAGE_SIZE"
    );
    let rest = store
        .list_tasks_owned(
            "tenant-a",
            "owner-a",
            None,
            None,
            None,
            u32::MAX,
            u32::try_from(MAX_PAGE_SIZE).expect("page size fits u32"),
        )
        .expect("second page");
    assert_eq!(rest.len(), 5);
    let mut all = ids(&huge);
    all.extend(ids(&rest));
    all.sort();
    all.dedup();
    assert_eq!(all.len(), MAX_PAGE_SIZE + 5, "pages do not overlap");
    assert!(!all.iter().any(|id| id == "foreign"));
    assert_eq!(
        store
            .count_tasks_owned("tenant-a", "owner-a", None, None, None)
            .expect("count all"),
        u32::try_from(MAX_PAGE_SIZE + 5).expect("count fits u32"),
        "count reports the full filtered total, not one page"
    );

    let page_one = store
        .list_tasks_owned("tenant-a", "owner-a", None, None, None, 2, 0)
        .expect("page one");
    let page_two = store
        .list_tasks_owned("tenant-a", "owner-a", None, None, None, 2, 2)
        .expect("page two");
    assert_eq!(page_one.len(), 2);
    assert_eq!(page_two.len(), 2);
    assert!(ids(&page_one).iter().all(|id| !ids(&page_two).contains(id)));
}

#[test]
fn tenant_admin_list_spans_owners_but_never_tenants() {
    let store = seeded();
    let tenant_a = store
        .list_tasks_for_tenant("tenant-a", 50, 0)
        .expect("tenant-a admin list");
    assert_eq!(ids(&tenant_a), ["a-1", "a-2", "a-3", "b-1"]);
    let tenant_b = store
        .list_tasks_for_tenant("tenant-b", 50, 0)
        .expect("tenant-b admin list");
    assert_eq!(ids(&tenant_b), ["x-1"]);
    assert!(store
        .list_tasks_for_tenant("tenant-c", 50, 0)
        .expect("unknown tenant")
        .is_empty());
    assert_eq!(
        store
            .list_tasks_for_tenant("tenant-a", 0, 0)
            .expect("zero limit")
            .len(),
        1
    );
}

#[test]
fn push_config_list_and_delete_reject_foreign_callers() {
    let store = seeded();
    store
        .upsert_push_config(
            "tenant-a",
            "owner-a",
            "a-1",
            push_input("push-1"),
            EndpointPolicy::default(),
        )
        .expect("save push config");

    let listed = store
        .list_push_configs("tenant-a", "owner-a", "a-1")
        .expect("owner lists configs");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, "push-1");

    assert!(matches!(
        store.list_push_configs("tenant-a", "owner-b", "a-1"),
        Err(StoreError::NotFound)
    ));
    assert!(matches!(
        store.list_push_configs("tenant-b", "owner-a", "a-1"),
        Err(StoreError::NotFound)
    ));
    assert!(matches!(
        store.delete_push_config("tenant-a", "owner-b", "a-1", "push-1"),
        Err(StoreError::NotFound)
    ));
    assert!(matches!(
        store.delete_push_config("tenant-b", "owner-a", "a-1", "push-1"),
        Err(StoreError::NotFound)
    ));
    assert_eq!(
        store
            .list_push_configs("tenant-a", "owner-a", "a-1")
            .expect("config survives foreign deletes")
            .len(),
        1
    );
}

#[test]
fn push_config_delete_of_unknown_id_is_not_found_and_delete_takes_effect() {
    let store = seeded();
    for id in ["push-1", "push-2"] {
        store
            .upsert_push_config(
                "tenant-a",
                "owner-a",
                "a-1",
                push_input(id),
                EndpointPolicy::default(),
            )
            .expect("save push config");
    }
    assert!(matches!(
        store.delete_push_config("tenant-a", "owner-a", "a-1", "push-missing"),
        Err(StoreError::NotFound)
    ));
    assert!(
        matches!(
            store.delete_push_config("tenant-a", "owner-a", "a-2", "push-1"),
            Err(StoreError::NotFound)
        ),
        "a config ID is scoped to its own task"
    );
    assert_eq!(
        store
            .list_push_configs("tenant-a", "owner-a", "a-1")
            .expect("list")
            .len(),
        2
    );

    store
        .delete_push_config("tenant-a", "owner-a", "a-1", "push-1")
        .expect("owner deletes config");
    let remaining = store
        .list_push_configs("tenant-a", "owner-a", "a-1")
        .expect("list after delete");
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, "push-2");
    assert!(matches!(
        store.resolve_push_config("tenant-a", "owner-a", "a-1", "push-1"),
        Err(StoreError::NotFound)
    ));
    assert!(
        matches!(
            store.delete_push_config("tenant-a", "owner-a", "a-1", "push-1"),
            Err(StoreError::NotFound)
        ),
        "a second delete is not a silent success"
    );
    assert!(matches!(
        store.list_push_configs("tenant-a", "owner-a", "missing-task"),
        Err(StoreError::NotFound)
    ));
}
