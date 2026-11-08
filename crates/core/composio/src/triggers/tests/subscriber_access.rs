//! Regression tests: a legacy agent trigger records who subscribed it, and
//! delivery asks the host whether that user may still run the agent before
//! starting a run, so revoking the subscriber stops the trigger.

use super::*;

#[tokio::test]
async fn subscribe_records_the_subscriber_and_survives_a_reopen() {
    let _lock = crate::auth::test_env_lock();
    let prev = base_url_snapshot();
    let base = spawn_mock("200 OK", r#"{"trigger_id":"trig_sub"}"#.to_string());
    crate::auth::set_key("comp_key");
    std::env::set_var("COMPOSIO_BASE_URL", &base);

    let (store, dir) = temp_store().await;
    let sub = store
        .subscribe("u1", "agent-1", "gmail", "GMAIL_NEW", "ca_1", json!({}))
        .await
        .unwrap();
    assert_eq!(sub.subscriber_user_id, "u1");
    let serialized = serde_json::to_value(&sub).unwrap();
    assert!(serialized.get("subscriber_user_id").is_none());
    drop(store);

    let reopened =
        ComposioTriggerStore::open(Client::new(), dir.path().join("composio-triggers.db")).unwrap();
    let rows = reopened.list().await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].subscriber_user_id, "u1");
    restore_env(prev);
}

#[tokio::test]
async fn a_revoked_subscriber_no_longer_starts_agent_runs() {
    let _lock = crate::auth::test_env_lock();
    let prev = base_url_snapshot();
    let (base, _requests) = spawn_mock_sequence(vec![
        ("200 OK", r#"{"trigger_id":"trig_revoked"}"#.to_string()),
        ("200 OK", r#"{"trigger_id":"trig_allowed"}"#.to_string()),
    ]);
    crate::auth::set_key("comp_key");
    std::env::set_var("COMPOSIO_BASE_URL", &base);
    crate::host::set_global_host(std::sync::Arc::new(RecordingHost));

    let (store, _dir) = temp_store().await;
    store
        .subscribe(
            "revoked-user",
            "agent-x",
            "gmail",
            "GMAIL_NEW",
            "ca_m",
            json!({}),
        )
        .await
        .unwrap();
    store
        .subscribe("u1", "agent-y", "gmail", "GMAIL_NEW", "ca_u", json!({}))
        .await
        .unwrap();

    clear_host_calls();
    let fired = store
        .handle_webhook(&json!({
            "metadata": { "trigger_id": "trig_revoked", "connected_account_id": "ca_m" },
            "data": { "subject": "run the agent" },
        }))
        .await;
    assert_eq!(fired, 0);
    assert!(host_calls().is_empty(), "{:?}", host_calls());

    let fired = store
        .handle_webhook(&json!({
            "metadata": { "trigger_id": "trig_allowed", "connected_account_id": "ca_u" },
        }))
        .await;
    assert_eq!(fired, 1);
    assert_eq!(host_calls()[0].0, "agent:agent-y");
    restore_env(prev);
}
