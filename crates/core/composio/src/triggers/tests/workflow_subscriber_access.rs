//! Regression tests: a legacy workflow trigger records who subscribed it, the
//! store can check that a user owns the account before subscribing, and
//! delivery asks the host whether that user may still receive the account's
//! events into the workflow before starting a run.

use super::*;

#[tokio::test]
async fn subscribe_workflow_as_records_the_subscriber_and_survives_a_reopen() {
    let _lock = crate::auth::test_env_lock();
    let prev = base_url_snapshot();
    let base = spawn_mock("200 OK", r#"{"trigger_id":"trig_wf_sub"}"#.to_string());
    crate::auth::set_key("comp_key");
    std::env::set_var("COMPOSIO_BASE_URL", &base);

    let (store, dir) = temp_store().await;
    let sub = store
        .subscribe_workflow_as("user-b", "wf-1", "gmail", "GMAIL_NEW", "ca_b", json!({}))
        .await
        .unwrap();
    assert_eq!(sub.subscriber_user_id, "user-b");
    assert_eq!(sub.workflow_id.as_deref(), Some("wf-1"));
    drop(store);

    let reopened =
        ComposioTriggerStore::open(Client::new(), dir.path().join("composio-triggers.db")).unwrap();
    let rows = reopened.list().await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].subscriber_user_id, "user-b");
    assert_eq!(rows[0].target_kind, "workflow");
    restore_env(prev);
}

#[tokio::test]
async fn user_owns_account_never_matches_blank_input_and_fails_closed() {
    let _lock = crate::auth::test_env_lock();
    let prev = base_url_snapshot();
    let (base, requests) = spawn_mock_sequence(vec![(
        "200 OK",
        r#"{"items":[{"id":"ca_b","status":"ACTIVE"}]}"#.to_string(),
    )]);
    crate::auth::set_key("comp_key");
    std::env::set_var("COMPOSIO_BASE_URL", &base);

    let (store, _dir) = temp_store().await;
    // Blank inputs are never an owned account, and list nothing.
    assert!(!store.user_owns_account("", "ca_b").await.unwrap());
    assert!(!store.user_owns_account("user-b", " ").await.unwrap());
    // A listing that cannot be made is an error (callers refuse), never `true`.
    assert!(store.user_owns_account("user-b", "ca_b").await.is_err());
    assert!(requests.lock().unwrap().is_empty());
    restore_env(prev);
}

#[tokio::test]
async fn a_refused_workflow_subscriber_no_longer_starts_workflow_runs() {
    let _lock = crate::auth::test_env_lock();
    let prev = base_url_snapshot();
    let (base, _requests) = spawn_mock_sequence(vec![
        ("200 OK", r#"{"trigger_id":"trig_wf_revoked"}"#.to_string()),
        ("200 OK", r#"{"trigger_id":"trig_wf_allowed"}"#.to_string()),
    ]);
    crate::auth::set_key("comp_key");
    std::env::set_var("COMPOSIO_BASE_URL", &base);
    crate::host::set_global_host(std::sync::Arc::new(RecordingHost));

    let (store, _dir) = temp_store().await;
    store
        .subscribe_workflow_as(
            "revoked-user",
            "wf-exfil",
            "gmail",
            "GMAIL_NEW",
            "ca_victim",
            json!({}),
        )
        .await
        .unwrap();
    store
        .subscribe_workflow_as("u1", "wf-own", "gmail", "GMAIL_NEW", "ca_u", json!({}))
        .await
        .unwrap();

    clear_host_calls();
    let fired = store
        .handle_webhook(&json!({
            "metadata": { "trigger_id": "trig_wf_revoked", "connected_account_id": "ca_victim" },
            "data": { "body": "private mail" },
        }))
        .await;
    assert_eq!(fired, 0);
    assert!(host_calls().is_empty(), "{:?}", host_calls());

    let fired = store
        .handle_webhook(&json!({
            "metadata": { "trigger_id": "trig_wf_allowed", "connected_account_id": "ca_u" },
        }))
        .await;
    assert_eq!(fired, 1);
    assert_eq!(host_calls()[0].0, "workflow:wf-own");
    restore_env(prev);
}
