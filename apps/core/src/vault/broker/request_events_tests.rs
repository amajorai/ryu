use super::*;
use crate::vault::audit_devices::{self, AuditDevice, DeviceKind};
use crate::vault::broker::delegation::{self, Member};

fn row(session: &str, outcome: &str) -> LogRow {
    LogRow {
        at: 1,
        session_id: Some(session.into()),
        environment: "default".into(),
        method: "POST".into(),
        scheme: "https".into(),
        host: "mcp.example.com".into(),
        port: 443,
        path: "/mcp".into(),
        service: Some("mcp".into()),
        status: 200,
        latency_ms: 4,
        outcome: outcome.into(),
        ..LogRow::default()
    }
}

fn tool_call() -> Vec<RpcCall> {
    vec![RpcCall {
        method: "tools/call".into(),
        id: Some("9".into()),
        tool: Some("search".into()),
    }]
}

async fn request_audits(store: &PluginSecretStore) -> Vec<(String, String)> {
    let conn = store.conn.lock().await;
    let mut stmt = conn
        .prepare("SELECT outcome, details FROM vault_audit WHERE action = 'broker.request'")
        .unwrap();
    let rows = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap();
    rows.collect::<rusqlite::Result<_>>().unwrap()
}

#[test]
fn audit_modes_parse_with_auto_as_the_default() {
    assert_eq!(AuditMode::parse(None), AuditMode::Auto);
    assert_eq!(AuditMode::parse(Some("auto")), AuditMode::Auto);
    assert_eq!(AuditMode::parse(Some("typo")), AuditMode::Auto);
    assert_eq!(AuditMode::parse(Some(" ON ")), AuditMode::On);
    assert_eq!(AuditMode::parse(Some("off")), AuditMode::Off);
}

#[test]
fn audit_rows_name_both_principals_and_the_tool() {
    let attrs = SessionAttrs {
        on_behalf_of: Some(Member {
            user_id: "alice".into(),
            subjects: vec!["user:alice".into()],
        }),
        remote: false,
    };
    let entry = audit_entry(&row("bvs_1", "forwarded"), &tool_call(), &attrs);
    assert_eq!(entry.action, "broker.request");
    assert_eq!(entry.outcome, "ok");
    assert_eq!(entry.actor_kind, "broker_session");
    assert_eq!(entry.actor_id.as_deref(), Some("bvs_1"));
    assert_eq!(entry.environment.as_deref(), Some("default"));
    assert_eq!(entry.details["onBehalfOf"], "user:alice");
    assert_eq!(entry.details["rpc"][0]["tool"], "search");
    let refused = audit_entry(&row("bvs_1", "forbidden"), &[], &SessionAttrs::default());
    assert_eq!(refused.outcome, "refused");
    assert!(refused.details["onBehalfOf"].is_null());
}

#[tokio::test]
async fn requests_reach_the_session_log_and_audit_only_as_configured() {
    let store = PluginSecretStore::in_memory().unwrap();
    {
        let conn = store.conn.lock().await;
        delegation::insert(
            &conn,
            "bvs_1",
            &SessionAttrs {
                on_behalf_of: Some(Member {
                    user_id: "alice".into(),
                    subjects: vec!["user:alice".into()],
                }),
                remote: false,
            },
        )
        .unwrap();
    }
    observe(
        &store,
        &row("bvs_1", "forwarded"),
        tool_call(),
        AuditMode::Off,
    )
    .await;
    // Auto without an enabled device stays out of the chain.
    observe(
        &store,
        &row("bvs_1", "forwarded"),
        Vec::new(),
        AuditMode::Auto,
    )
    .await;
    assert!(request_audits(&store).await.is_empty());
    let entries = session_log::read(&store, "bvs_1", 10).await.unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[1].rpc, tool_call());
    assert_eq!(entries[1].on_behalf_of.as_deref(), Some("user:alice"));

    observe(
        &store,
        &row("bvs_1", "forwarded"),
        tool_call(),
        AuditMode::On,
    )
    .await;
    let audits = request_audits(&store).await;
    assert_eq!(audits.len(), 1);
    assert_eq!(audits[0].0, "ok");
    assert!(audits[0].1.contains("search"));
    // A row without a session (none today) records nothing.
    let mut sessionless = row("bvs_1", "forwarded");
    sessionless.session_id = None;
    observe(&store, &sessionless, Vec::new(), AuditMode::On).await;
    assert_eq!(request_audits(&store).await.len(), 1);
}

#[tokio::test]
async fn auto_mode_fans_out_to_an_enabled_audit_device() {
    let store = PluginSecretStore::in_memory().unwrap();
    let dir = tempfile::tempdir().unwrap();
    audit_devices::allow_audit_dir_for_test(dir.path());
    let file = dir.path().join("audit.jsonl");
    {
        let conn = store.conn.lock().await;
        audit_devices::put(
            &conn,
            &AuditDevice {
                id: "siem".into(),
                kind: DeviceKind::File,
                enabled: true,
                description: String::new(),
                hmac_fields: true,
                options: serde_json::json!({ "path": file.to_string_lossy() }),
                source: "api".into(),
            },
        )
        .unwrap();
    }
    observe(
        &store,
        &row("bvs_2", "forwarded"),
        tool_call(),
        AuditMode::Auto,
    )
    .await;
    assert_eq!(request_audits(&store).await.len(), 1);
    let written = std::fs::read_to_string(&file).unwrap();
    assert!(written.contains("broker.request"), "{written}");
    assert!(written.contains("search"), "{written}");
}
