//! Working-memory storage: versioning, merging, isolation, refusals, and
//! encryption at rest.

use super::*;
use crate::MemoryStore;
use ryu_kernel_contracts::ResourceKey;
use serde_json::json;

fn alice() -> ResourceKey {
    ResourceKey::owned(Some("alice"), None)
}

fn bob() -> ResourceKey {
    ResourceKey::owned(Some("bob"), None)
}

#[tokio::test]
async fn template_mode_replaces_and_versions() {
    let store = MemoryStore::open_in_memory().unwrap();
    assert!(store
        .get_working_memory(&alice(), WorkingMemoryScope::Thread, "t1")
        .await
        .unwrap()
        .is_none());
    let first = store
        .put_working_memory(
            &alice(),
            WorkingMemoryScope::Thread,
            "t1",
            WorkingMemoryWrite {
                content: Some("# Notes\n- name: Ada".into()),
                template: Some("# Notes\n- name:".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(first.mode, WorkingMemoryMode::Template);
    assert_eq!(first.version, 1);
    let second = store
        .put_working_memory(
            &alice(),
            WorkingMemoryScope::Thread,
            "t1",
            WorkingMemoryWrite {
                content: Some("# Notes\n- name: Ada Lovelace".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(second.version, 2);
    assert_eq!(second.created_at, first.created_at);
    assert_eq!(
        second.content.as_deref(),
        Some("# Notes\n- name: Ada Lovelace")
    );
    // The template is retained across a content-only update.
    assert_eq!(second.template.as_deref(), Some("# Notes\n- name:"));
    let read = store
        .get_working_memory(&alice(), WorkingMemoryScope::Thread, " t1 ")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read, second);
}

#[tokio::test]
async fn schema_mode_merges_deletes_and_validates() {
    let store = MemoryStore::open_in_memory().unwrap();
    let schema = json!({
        "type": "object",
        "properties": {
            "name": { "type": "string" },
            "prefs": {
                "type": "object",
                "properties": { "theme": { "enum": ["light", "dark"] } }
            },
            "tags": { "type": "array", "items": { "type": "string" } }
        },
        "additionalProperties": false
    });
    let doc = store
        .put_working_memory(
            &alice(),
            WorkingMemoryScope::Resource,
            "alice",
            WorkingMemoryWrite {
                schema: Some(schema.clone()),
                data: Some(json!({ "name": "Ada", "prefs": { "theme": "dark" } })),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(doc.mode, WorkingMemoryMode::Schema);

    let merged = store
        .put_working_memory(
            &alice(),
            WorkingMemoryScope::Resource,
            "alice",
            WorkingMemoryWrite {
                data: Some(json!({ "name": null, "tags": ["math"] })),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        merged.data,
        Some(json!({ "prefs": { "theme": "dark" }, "tags": ["math"] }))
    );
    assert_eq!(merged.schema, Some(schema));

    let rejected = store
        .put_working_memory(
            &alice(),
            WorkingMemoryScope::Resource,
            "alice",
            WorkingMemoryWrite {
                data: Some(json!({ "prefs": { "theme": "blue" }, "extra": 1 })),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    let error = rejected.downcast_ref::<WorkingMemoryError>().unwrap();
    assert!(matches!(error, WorkingMemoryError::Invalid(message)
        if message.contains("$.prefs.theme") && message.contains("$.extra")));
    // A rejected write leaves the stored document untouched.
    let still = store
        .get_working_memory(&alice(), WorkingMemoryScope::Resource, "alice")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(still.version, 2);

    let replaced = store
        .put_working_memory(
            &alice(),
            WorkingMemoryScope::Resource,
            "alice",
            WorkingMemoryWrite {
                data: Some(json!({ "name": "Grace" })),
                replace: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(replaced.data, Some(json!({ "name": "Grace" })));
}

#[tokio::test]
async fn owners_are_isolated_and_scopes_are_distinct() {
    let store = MemoryStore::open_in_memory().unwrap();
    store
        .put_working_memory(
            &alice(),
            WorkingMemoryScope::Thread,
            "shared-id",
            WorkingMemoryWrite {
                content: Some("alice notes".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(store
        .get_working_memory(&bob(), WorkingMemoryScope::Thread, "shared-id")
        .await
        .unwrap()
        .is_none());
    assert!(store
        .get_working_memory(&alice(), WorkingMemoryScope::Resource, "shared-id")
        .await
        .unwrap()
        .is_none());
    // Bob writing the same id creates his own document.
    let bobs = store
        .put_working_memory(
            &bob(),
            WorkingMemoryScope::Thread,
            "shared-id",
            WorkingMemoryWrite {
                content: Some("bob notes".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(bobs.version, 1);
    assert!(!store
        .delete_working_memory(&bob(), WorkingMemoryScope::Resource, "shared-id")
        .await
        .unwrap());
    assert_eq!(
        store
            .delete_thread_working_memory("shared-id")
            .await
            .unwrap(),
        2
    );
}

#[tokio::test]
async fn rejects_bad_requests_and_stale_versions() {
    let store = MemoryStore::open_in_memory().unwrap();
    let key = alice();
    let bad_id = store
        .put_working_memory(
            &key,
            WorkingMemoryScope::Thread,
            "  ",
            WorkingMemoryWrite::default(),
        )
        .await
        .unwrap_err();
    assert!(bad_id.downcast_ref::<WorkingMemoryError>().is_some());

    let wrong_field = store
        .put_working_memory(
            &key,
            WorkingMemoryScope::Thread,
            "t",
            WorkingMemoryWrite {
                mode: Some(WorkingMemoryMode::Template),
                data: Some(json!({ "a": 1 })),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(wrong_field.to_string().contains("content"));

    let too_big = store
        .put_working_memory(
            &key,
            WorkingMemoryScope::Thread,
            "t",
            WorkingMemoryWrite {
                content: Some("x".repeat(MAX_WORKING_MEMORY_BYTES + 1)),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(too_big.to_string().contains("exceeds"));

    let non_object_schema = store
        .put_working_memory(
            &key,
            WorkingMemoryScope::Thread,
            "t",
            WorkingMemoryWrite {
                schema: Some(json!({ "type": "string" })),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(non_object_schema.to_string().contains("object"));

    store
        .put_working_memory(
            &key,
            WorkingMemoryScope::Thread,
            "t",
            WorkingMemoryWrite {
                content: Some("v1".into()),
                expected_version: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let stale = store
        .put_working_memory(
            &key,
            WorkingMemoryScope::Thread,
            "t",
            WorkingMemoryWrite {
                content: Some("v2".into()),
                expected_version: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert_eq!(
        stale.downcast_ref::<WorkingMemoryError>(),
        Some(&WorkingMemoryError::Conflict { current: 1 })
    );
}

#[tokio::test]
async fn content_is_encrypted_at_rest() {
    let store = MemoryStore::open_in_memory().unwrap();
    store
        .put_working_memory(
            &alice(),
            WorkingMemoryScope::Thread,
            "t",
            WorkingMemoryWrite {
                content: Some("secret plan: launch on friday".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let conn = store.conn.lock().await;
    let raw: Vec<u8> = conn
        .query_row("SELECT ciphertext FROM memory_working", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(!String::from_utf8_lossy(&raw).contains("secret plan"));
}

#[tokio::test]
async fn listing_reads_one_owner_and_scope_newest_first_within_the_limit() {
    let store = MemoryStore::open_in_memory().unwrap();
    let note = |text: &str| WorkingMemoryWrite {
        content: Some(text.into()),
        ..Default::default()
    };
    for (key, scope, id) in [
        (alice(), WorkingMemoryScope::Resource, "r-old"),
        (alice(), WorkingMemoryScope::Resource, "r-new"),
        (alice(), WorkingMemoryScope::Thread, "t1"),
        (bob(), WorkingMemoryScope::Resource, "r-bob"),
    ] {
        store
            .put_working_memory(&key, scope, id, note(id))
            .await
            .unwrap();
    }
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE memory_working SET updated_at = CASE scope_id
                 WHEN 'r-old' THEN 1 WHEN 'r-new' THEN 2 ELSE updated_at END",
            [],
        )
        .unwrap();
    }
    let ids = |docs: Vec<WorkingMemory>| docs.into_iter().map(|doc| doc.id).collect::<Vec<_>>();

    let alice_docs = store
        .list_working_memory(&alice(), WorkingMemoryScope::Resource, 10)
        .await
        .unwrap();
    assert_eq!(alice_docs[0].content.as_deref(), Some("r-new"));
    assert_eq!(alice_docs[0].updated_at, 2);
    assert_eq!(ids(alice_docs), ["r-new", "r-old"]);
    let newest = store
        .list_working_memory(&alice(), WorkingMemoryScope::Resource, 1)
        .await
        .unwrap();
    assert_eq!(ids(newest), ["r-new"]);
    let bob_docs = store
        .list_working_memory(&bob(), WorkingMemoryScope::Resource, 10)
        .await
        .unwrap();
    assert_eq!(ids(bob_docs), ["r-bob"]);
}
