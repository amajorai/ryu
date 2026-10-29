//! Actual governed HostBridge storage calls with isolated SQLite, never a Map
//! permission facsimile. Transport identity verification itself is out of scope.
use super::*;
use crate::tool_exec::{InvokeOutcome, SandboxBridge};
use serde_json::{json, Value};
use std::collections::HashSet;

async fn result(
    bridge: &bridge::PluginHookBridge,
    method: &str,
    input: Value,
) -> crate::tool_exec::ToolInvokeResult {
    match bridge.handle(format!("host.{method}"), input).await {
        InvokeOutcome::Result(result) => result,
        other => panic!("unexpected storage outcome: {other:?}"),
    }
}

async fn successful(bridge: &bridge::PluginHookBridge, method: &str, input: Value) -> Value {
    let response = result(bridge, method, input).await;
    assert!(
        !response.is_error,
        "unexpected {method} refusal: {:?}",
        response.error
    );
    assert!(response.error.is_none());
    response.value
}

#[tokio::test]
async fn agent_comms_actual_storage_bridge_grants_tenants_plugins_and_sql_refusal() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("storage.db");
    let store = crate::plugin_storage::PluginStorage::open(database.clone()).unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let canonical = crate::plugin_manifest::PluginManifestLoader::load()
        .into_iter()
        .find(|manifest| manifest.id == "@ryu/agent-comms")
        .expect("canonical Agent Comms manifest");
    assert!(canonical
        .permission_grants
        .iter()
        .any(|grant| grant == "storage:kv"));
    let denied = bridge::PluginHookBridge::new_with_tenant(
        "@ryu/agent-comms".into(),
        HashSet::new(),
        state.clone(),
        Some("user-a".into()),
    )
    .with_test_storage(store.clone());
    for method in ["storage_get", "storage_set", "storage_compare_and_set"] {
        let refusal = result(
            &denied,
            method,
            json!({ "key": "inbox:scout", "value": "forbidden", "expected": null }),
        )
        .await;
        assert!(refusal.is_error);
        assert!(refusal.error.as_deref().unwrap().contains("storage:kv"));
    }
    assert!(store
        .keys("@ryu/agent-comms", "tenant:user-a:default")
        .await
        .unwrap()
        .is_empty());
    let grants = HashSet::from(["storage:kv".to_owned()]);
    let a = bridge::PluginHookBridge::new_with_tenant(
        "@ryu/agent-comms".into(),
        grants.clone(),
        state.clone(),
        Some("user-a".into()),
    )
    .with_test_storage(store.clone());
    let b = bridge::PluginHookBridge::new_with_tenant(
        "@ryu/agent-comms".into(),
        grants.clone(),
        state.clone(),
        Some("user-b".into()),
    )
    .with_test_storage(store.clone());
    let other = bridge::PluginHookBridge::new_with_tenant(
        "@ryu/chat-title".into(),
        grants.clone(),
        state.clone(),
        Some("user-a".into()),
    )
    .with_test_storage(store.clone());
    assert!(!result(&a, "storage_set", json!({ "key": "inbox:scout", "value": "original-a", "plugin_id": "@ryu/chat-title", "user_id": "user-b" })).await.is_error);
    assert_eq!(
        successful(&b, "storage_get", json!({ "key": "inbox:scout" })).await,
        Value::Null
    );
    assert_eq!(
        successful(&other, "storage_get", json!({ "key": "inbox:scout" })).await,
        Value::Null
    );
    assert_eq!(
        successful(
            &b,
            "storage_compare_and_set",
            json!({ "key": "inbox:scout", "expected": "original-a", "value": "stolen" })
        )
        .await,
        json!(false)
    );
    assert_eq!(
        successful(
            &other,
            "storage_compare_and_set",
            json!({ "key": "inbox:scout", "expected": "original-a", "value": "stolen" })
        )
        .await,
        json!(false)
    );
    assert_eq!(
        successful(&a, "storage_get", json!({ "key": "inbox:scout" })).await,
        json!("original-a")
    );
    let verified = crate::identity_verify::VerifiedCaller {
        user_id: "user-b".into(),
        email: None,
        email_verified: false,
        org_id: None,
        role: crate::identity_verify::OrgRole::Viewer,
        teams: vec![],
    };
    let principal = bridge::PluginHookBridge::new_for_request(
        "@ryu/agent-comms".into(),
        grants,
        state,
        Some(verified),
        None,
    )
    .with_test_storage(store.clone());
    assert!(
        !result(
            &principal,
            "storage_set",
            json!({ "key": "inbox:scout", "value": "original-b" })
        )
        .await
        .is_error
    );
    assert_eq!(
        successful(&b, "storage_get", json!({ "key": "inbox:scout" })).await,
        json!("original-b")
    );
    assert_eq!(
        successful(
            &a,
            "storage_get",
            json!({ "key": "inbox:scout", "namespace": "tenant:user-b:default" })
        )
        .await,
        Value::Null
    );
    let sql = rusqlite::Connection::open(&database).unwrap();
    sql.execute_batch("CREATE TRIGGER refuse_write BEFORE INSERT ON plugin_kv BEGIN SELECT RAISE(ABORT, 'bridge write refused'); END;").unwrap();
    for method in ["storage_set", "storage_compare_and_set"] {
        let refusal = result(
            &a,
            method,
            json!({ "key": "inbox:scout", "expected": "original-a", "value": "refused" }),
        )
        .await;
        assert!(refusal.is_error);
        assert_eq!(
            refusal.error.as_deref(),
            Some(if method == "storage_set" {
                "writing plugin_kv"
            } else {
                "bridge write refused"
            })
        );
    }
    assert_eq!(
        successful(&a, "storage_get", json!({ "key": "inbox:scout" })).await,
        json!("original-a")
    );
    sql.execute_batch("DROP TRIGGER refuse_write;").unwrap();
    assert_eq!(
        successful(
            &a,
            "storage_compare_and_set",
            json!({ "key": "inbox:scout", "expected": "original-a", "value": "accepted" })
        )
        .await,
        json!(true)
    );
    let reopened = crate::plugin_storage::PluginStorage::open(database).unwrap();
    assert_eq!(
        reopened
            .get("@ryu/agent-comms", "tenant:user-a:default", "inbox:scout")
            .await
            .unwrap(),
        Some("accepted".into())
    );
    assert_eq!(
        reopened
            .get("@ryu/agent-comms", "tenant:user-b:default", "inbox:scout")
            .await
            .unwrap(),
        Some("original-b".into())
    );
    assert!(reopened
        .keys("@ryu/chat-title", "tenant:user-a:default")
        .await
        .unwrap()
        .is_empty());
}
