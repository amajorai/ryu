//! Repository integration gate: requires Bun and installed Connect dependencies.
//! Exercises production Rust handoff -> production Connect HTTP router; only the
//! external Composio API is a fixture. No live provider account is used.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

struct ConnectProcess(Child);
impl Drop for ConnectProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
        std::env::remove_var("RYU_CONNECT_URL");
        std::env::remove_var("RYU_CONNECT_USER_TOKENS");
        std::env::remove_var("RYU_CONNECT_USER_MANAGEMENT_TOKENS");
    }
}

#[tokio::test]
async fn rust_dispatch_reaches_native_connect_and_preserves_authorization() {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../apps/connect/src/core-handoff.fixture.ts");
    let mut process = ConnectProcess(Command::new("bun")
        .arg(fixture)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn().expect("Bun and installed Connect dependencies are required for this repository integration test"));
    let stdout = process.0.stdout.take().unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
        let _ = send.send(result);
    });
    let ready = receive
        .recv_timeout(Duration::from_secs(15))
        .expect("Connect fixture did not report readiness")
        .unwrap();
    reader.join().unwrap();
    let ready: Value = serde_json::from_str(&ready).unwrap();
    let base = ready["url"].as_str().unwrap();
    std::env::set_var("RYU_CONNECT_URL", base);
    std::env::set_var(
        "RYU_CONNECT_USER_TOKENS",
        r#"{"user-a":"runtime-a","user-b":"runtime-b"}"#,
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    assert_eq!(
        client
            .get(format!("{base}health"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );

    let legacy_root = tempfile::tempdir().unwrap();
    let legacy_store = ryu_composio::ComposioTriggerStore::open(
        client.clone(),
        legacy_root.path().join("legacy.db"),
    )
    .unwrap();
    let rejected = legacy_store
        .subscribe_workflow(
            "workflow-a",
            "gmail",
            "GMAIL_NEW_GMAIL_MESSAGE",
            "account-a",
            json!({}),
        )
        .await
        .unwrap_err();
    assert!(rejected
        .to_string()
        .contains("Connect owns provider triggers"));
    let rejected = legacy_store
        .reconcile_webhook_subscription("https://core.example/webhook")
        .await
        .unwrap_err();
    assert!(rejected
        .to_string()
        .contains("Connect owns provider webhook subscriptions"));
    assert!(legacy_store.list().await.unwrap().is_empty());
    let proof: Value = client
        .get(format!("{base}proof"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(proof["providerCalls"], 0);

    let catalog = ryu_composio::service::catalog(Some("user-a"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        catalog["data"],
        json!([{"name":"GMAIL_GET_PROFILE","type":"composio"}])
    );
    let other = ryu_composio::service::catalog(Some("user-b"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(other["data"], json!([]));
    assert!(ryu_composio::service::catalog(Some("unmapped"))
        .await
        .unwrap()
        .is_err());
    assert!(ryu_composio::service::catalog(None).await.unwrap().is_err());

    let status = ryu_composio::service::connection_status("account-a", Some("user-a"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        status,
        json!({"id":"account-a", "status":"ACTIVE", "active":true, "toolkit":""})
    );
    for (id, user) in [
        ("account-a", "user-b"),
        ("other-account", "user-a"),
        ("account-a", "unmapped"),
    ] {
        assert!(ryu_composio::service::connection_status(id, Some(user))
            .await
            .unwrap()
            .is_err());
    }
    let accounts = ryu_composio::connect::list_connections(&client, "gmail", Some("user-a"))
        .await
        .unwrap();
    assert_eq!(
        accounts["data"],
        json!([{"id":"account-a", "toolkit":"gmail", "status":"ACTIVE", "active":true}])
    );
    let filtered = ryu_composio::service::list_connections("slack", Some("user-a"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(filtered["data"], json!([]));
    let other_accounts = ryu_composio::service::list_connections("", Some("user-b"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        other_accounts,
        json!({"object":"list", "configured":false, "data":[]})
    );
    assert!(
        ryu_composio::service::list_connections("", Some("unmapped"))
            .await
            .unwrap()
            .is_err()
    );

    let result = ryu_composio::service::dispatch(
        "GMAIL_GET_PROFILE",
        &json!({"query":"fixture"}),
        Some("user-a"),
        Some("account-a"),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        result,
        json!({"account":"account-a", "user":"provider-user-a", "version":"20251027_00", "arguments":{"query":"fixture"}})
    );
    assert!(!result.to_string().contains("private-provider-state"));
    for (user, tool, account) in [
        ("user-b", "GMAIL_GET_PROFILE", "account-a"),
        ("unmapped", "GMAIL_GET_PROFILE", "account-a"),
        ("user-a", "GMAIL_GET_PROFILE", "another-account"),
        ("user-a", "GMAIL_DELETE_EMAIL", "account-a"),
    ] {
        assert!(
            ryu_composio::service::dispatch(tool, &json!({}), Some(user), Some(account))
                .await
                .unwrap()
                .is_err()
        );
    }
    let proof: Value = client
        .get(format!("{base}proof"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        proof["providerCalls"], 4,
        "rejected calls must not reach the provider"
    );

    assert!(
        ryu_composio::connect::initiate(&client, "gmail", Some("user-c"))
            .await
            .is_err()
    );
    std::env::set_var(
        "RYU_CONNECT_USER_MANAGEMENT_TOKENS",
        r#"{"user-c":"runtime-c"}"#,
    );
    assert!(
        ryu_composio::connect::initiate(&client, "gmail", Some("user-c"))
            .await
            .is_err()
    );
    std::env::set_var(
        "RYU_CONNECT_USER_MANAGEMENT_TOKENS",
        r#"{"user-c":"manager-c"}"#,
    );
    assert!(
        ryu_composio::connect::initiate(&client, "slack", Some("user-c"))
            .await
            .is_err()
    );
    let initiated = ryu_composio::connect::initiate(&client, "gmail", Some("user-c"))
        .await
        .unwrap();
    assert_eq!(
        initiated,
        json!({"connection_id":"account-c", "redirect_url":"https://connect.composio.dev/fixture-login", "status":"INITIATED"})
    );
    assert!(
        ryu_composio::connect::initiate(&client, "gmail", Some("user-c"))
            .await
            .is_err()
    );

    assert!(
        ryu_composio::service::complete("fixture-session", Some("unmapped"))
            .await
            .unwrap()
            .is_err()
    );
    assert!(ryu_composio::service::complete("", Some("user-c"))
        .await
        .unwrap()
        .is_err());
    assert!(
        ryu_composio::service::complete("wrong-session", Some("user-c"))
            .await
            .unwrap()
            .is_err()
    );
    let completed = ryu_composio::service::complete("fixture-session", Some("user-c"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        completed,
        json!({"id":"account-c", "toolkit":"gmail", "status":"ACTIVE", "active":true})
    );
    assert!(
        ryu_composio::service::complete("fixture-session", Some("user-c"))
            .await
            .unwrap()
            .is_err()
    );

    std::env::set_var(
        "RYU_CONNECT_USER_TOKENS",
        r#"{"user-a":"runtime-a","user-b":"runtime-b","user-c":"runtime-c"}"#,
    );
    let executed = ryu_composio::service::dispatch(
        "GMAIL_GET_PROFILE",
        &json!({}),
        Some("user-c"),
        Some("account-c"),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        executed,
        json!({"account":"account-c","user":"provider-user-c","version":"latest","arguments":{}})
    );
    assert!(ryu_composio::service::create_trigger(
        "GMAIL_NEW_GMAIL_MESSAGE",
        "wrong-account",
        &json!({"label":"fixture"}),
        Some("user-c")
    )
    .await
    .unwrap()
    .is_err());
    let trigger = ryu_composio::service::create_trigger(
        "GMAIL_NEW_GMAIL_MESSAGE",
        "account-c",
        &json!({"label":"fixture"}),
        Some("user-c"),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(trigger.trigger_id.as_deref(), Some("ti_c"));
    assert_eq!(trigger.user_id, "provider-user-c");
    assert_eq!(trigger.auth_config_id, "auth-c");
    assert_eq!(trigger.status, "active");
    let triggers = ryu_composio::service::list_triggers(Some("user-c"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(triggers.len(), 1);
    assert_eq!(triggers[0].id, trigger.id);
    assert!(ryu_composio::service::list_triggers(Some("user-b"))
        .await
        .unwrap()
        .is_err());
    assert_eq!(
        ryu_composio::service::delete_trigger(&trigger.id, Some("user-c"))
            .await
            .unwrap()
            .unwrap()
            .status,
        "deleted"
    );
    let revoked = client
        .post(format!("{base}v1/composio/revoke"))
        .bearer_auth("manager-c")
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), 200);
    assert_eq!(
        revoked.json::<Value>().await.unwrap(),
        json!({"status":"revoked", "active":false,"connectedAccountId":"account-c"})
    );
    let before: Value = client
        .get(format!("{base}proof"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(ryu_composio::service::dispatch(
        "GMAIL_GET_PROFILE",
        &json!({}),
        Some("user-c"),
        Some("account-c")
    )
    .await
    .unwrap()
    .is_err());
    let after: Value = client
        .get(format!("{base}proof"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        before, after,
        "revoked execution must not contact the provider"
    );

    assert_eq!(
        ryu_composio::service::toolkits(Some("user-a"))
            .await
            .unwrap()
            .unwrap()["data"],
        json!([{"slug":"gmail","name":"gmail","description":null,"logo":null}])
    );
    assert_eq!(
        ryu_composio::service::toolkits(Some("user-b"))
            .await
            .unwrap()
            .unwrap()["data"],
        json!([])
    );
    assert!(ryu_composio::service::toolkits(Some("unmapped"))
        .await
        .unwrap()
        .is_err());
    let schema = ryu_composio::service::describe("GMAIL_GET_PROFILE", Some("user-a"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        schema,
        json!({"name":"GMAIL_GET_PROFILE","description":"Read profile","input_schema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}})
    );
    assert!(
        ryu_composio::service::describe("GMAIL_DELETE_EMAIL", Some("user-a"))
            .await
            .unwrap()
            .is_err()
    );
    assert!(
        ryu_composio::service::describe("GMAIL_GET_PROFILE", Some("user-b"))
            .await
            .unwrap()
            .is_err()
    );
    let actions = ryu_composio::service::actions("gmail", "profile", 1, &["read"], Some("user-a"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(actions["data"].as_array().unwrap().len(), 1);
    assert_eq!(actions["data"][0]["name"], "GMAIL_GET_PROFILE");
    assert_eq!(
        ryu_composio::service::actions("gmail", "", 50, &["write"], Some("user-a"))
            .await
            .unwrap()
            .unwrap()["data"],
        json!([])
    );
    assert_eq!(
        ryu_composio::service::actions("", "", 50, &[], Some("user-b"))
            .await
            .unwrap()
            .unwrap()["data"],
        json!([])
    );
    assert!(ryu_composio::service::claim_event(Some("user-b"))
        .await
        .unwrap()
        .unwrap()
        .is_none());
    assert!(ryu_composio::service::claim_event(Some("unmapped"))
        .await
        .unwrap()
        .is_err());
    let lease = ryu_composio::service::claim_event(Some("user-a"))
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(lease.delivery_id, "event-a");
    assert_eq!(lease.payload, json!({"data":{"fixture":"trigger"}}));
    assert!(!ryu_composio::service::renew_event(&lease, Some("user-b"))
        .await
        .unwrap()
        .unwrap());
    assert!(ryu_composio::service::renew_event(&lease, Some("user-a"))
        .await
        .unwrap()
        .unwrap());
    assert!(
        !ryu_composio::service::acknowledge_event(&lease, Some("user-b"))
            .await
            .unwrap()
            .unwrap()
    );
    assert!(
        ryu_composio::service::acknowledge_event(&lease, Some("user-a"))
            .await
            .unwrap()
            .unwrap()
    );
    assert!(!ryu_composio::service::renew_event(&lease, Some("user-a"))
        .await
        .unwrap()
        .unwrap());
    assert!(ryu_composio::service::claim_event(Some("user-a"))
        .await
        .unwrap()
        .unwrap()
        .is_none());

    // An agent's own account in tenant-d: the owner's credentials select the
    // tenant, and the agent is named explicitly; Connect derives its user.
    use ryu_composio::connect::Subject;
    std::env::set_var(
        "RYU_CONNECT_USER_TOKENS",
        r#"{"user-a":"runtime-a","user-b":"runtime-b","user-c":"runtime-c","user-d":"runtime-d"}"#,
    );
    std::env::set_var(
        "RYU_CONNECT_USER_MANAGEMENT_TOKENS",
        r#"{"user-c":"manager-c","user-d":"manager-d"}"#,
    );
    let agent = Subject::Agent {
        owner: "user-d",
        agent_id: "agent_1",
    };
    // tenant-c's binding enables no agent accounts.
    let unsupported = ryu_composio::connect::initiate_for(
        &client,
        "gmail",
        Subject::Agent {
            owner: "user-c",
            agent_id: "agent_1",
        },
    )
    .await
    .unwrap_err();
    assert!(ryu_composio::service::is_subject_unsupported(&unsupported));
    let initiated = ryu_composio::connect::initiate_for(&client, "gmail", agent)
        .await
        .unwrap();
    assert_eq!(
        initiated,
        json!({"connection_id":"account-d1", "redirect_url":"https://connect.composio.dev/fixture-agent-login", "status":"INITIATED"})
    );
    assert_eq!(
        ryu_composio::connect::list_connections_for(&client, "", agent)
            .await
            .unwrap()["data"],
        json!([{"id":"account-d1", "toolkit":"", "status":"pending", "active":false}])
    );
    // The tenant's own listing never shows its agent's account.
    assert_eq!(
        ryu_composio::connect::list_connections(&client, "", Some("user-d"))
            .await
            .unwrap()["data"],
        json!([])
    );
    let no_arguments = json!({});
    let run_as_agent = || {
        ryu_composio::service::dispatch_as(
            "GMAIL_GET_PROFILE",
            &no_arguments,
            Some("user-d"),
            Some("agent_1"),
            Some("account-d1"),
        )
    };
    assert!(run_as_agent().await.unwrap().is_err(), "not completed yet");
    let completed =
        ryu_composio::service::complete_as("agent-session", Some("user-d"), Some("agent_1"))
            .await
            .unwrap()
            .unwrap();
    assert_eq!(completed["id"], "account-d1");
    assert_eq!(
        run_as_agent().await.unwrap().unwrap(),
        json!({"account":"account-d1", "user":"provider-user-d:agent:agent_1", "version":"latest", "arguments":{}})
    );
    // The tenant's own lane cannot run on the agent's account.
    assert!(ryu_composio::service::dispatch(
        "GMAIL_GET_PROFILE",
        &json!({}),
        Some("user-d"),
        Some("account-d1")
    )
    .await
    .unwrap()
    .is_err());
    assert!(
        ryu_composio::connect::owned_connection_for(&client, "account-d1", agent)
            .await
            .unwrap()
            .is_some()
    );
    ryu_composio::connect::delete_connection_for(&client, "account-d1", agent)
        .await
        .unwrap();
    assert!(run_as_agent().await.unwrap().is_err(), "revoked");

    process.0.kill().unwrap();
    process.0.wait().unwrap();
    assert!(ryu_composio::service::claim_event(Some("user-a"))
        .await
        .unwrap()
        .is_err());
    assert!(
        ryu_composio::service::dispatch("GMAIL_GET_PROFILE", &json!({}), Some("user-a"), None)
            .await
            .unwrap()
            .is_err(),
        "stopped Connect must not select embedded execution"
    );
}
