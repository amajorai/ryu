//! A service's MCP tool policy, end to end through the loopback listener.

use super::*;
use crate::vault::broker::services::McpToolPolicy;

fn post_json(upstream: u16, token: &str, body: &str, extra: &str) -> String {
    format!(
        "POST http://127.0.0.1:{upstream}/mcp HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Bearer {token}\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

async fn denied_audit_rows(store: &PluginSecretStore) -> Vec<String> {
    let conn = store.conn.lock().await;
    let mut stmt = conn
        .prepare(
            "SELECT details FROM vault_audit WHERE action = 'broker.mcp.tool_denied' ORDER BY rowid",
        )
        .unwrap();
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).unwrap();
    rows.collect::<rusqlite::Result<_>>().unwrap()
}

#[tokio::test]
async fn denied_tools_never_reach_the_upstream_or_get_a_credential() {
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    let (upstream, mut seen) = fake_http_upstream().await;
    let mut service = test_service("mcp", "127.0.0.1", Some(upstream), "/");
    service.allow_insecure_http = true;
    service.mcp_tools = Some(McpToolPolicy {
        allow: Some(vec!["search".into(), "get_*".into()]),
        deny: vec!["get_secret".into()],
    });
    add_service(store, service).await;
    let (token, _) = mint(store, &["mcp"]).await;
    let port = start(store, loopback_config()).await;

    let allowed = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_issue"}}"#;
    let response = send_raw(port, post_json(upstream, &token, allowed, "")).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let forwarded = seen.recv().await.unwrap();
    assert!(
        forwarded.contains(&format!("Bearer {TOKEN_VALUE}")),
        "{forwarded}"
    );

    let denied = r#"{"jsonrpc":"2.0","id":"x9","method":"tools/call","params":{"name":"get_secret","arguments":{"k":"__A__"}}}"#;
    let response = send_raw(port, post_json(upstream, &token, denied, "")).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(
        response.contains("x-ryu-broker-error: mcp_tool_denied"),
        "{response}"
    );
    assert!(response.contains(r#""id":"x9""#), "{response}");
    assert!(response.contains("-32001"), "{response}");

    // Compressed bodies cannot be read, so they are refused under a policy.
    let response = send_raw(
        port,
        post_json(upstream, &token, allowed, "Content-Encoding: gzip\r\n"),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 403"), "{response}");

    // Only the permitted call was forwarded.
    assert!(seen.try_recv().is_err());
    let rows = log_rows(store).await;
    assert_eq!(
        rows.iter()
            .filter(|row| row.outcome == "mcp_tool_denied")
            .count(),
        2
    );
    let audited = denied_audit_rows(store).await;
    assert_eq!(audited.len(), 2);
    assert!(audited[0].contains("get_secret"), "{}", audited[0]);
    assert!(audited[0].contains("tool_not_permitted"));
    assert!(audited[1].contains("encoded_body"));
    assert!(audited.iter().all(|row| !row.contains("__A__")));
    // No credential was resolved for a refused call.
    let conn = store.conn.lock().await;
    let uses: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vault_audit WHERE action = 'secret.use' AND outcome = 'ok'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(uses, 1);
}

#[tokio::test]
async fn services_without_a_policy_still_forward_every_tool() {
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    let (upstream, mut seen) = fake_http_upstream().await;
    let mut service = test_service("open", "127.0.0.1", Some(upstream), "/");
    service.allow_insecure_http = true;
    add_service(store, service).await;
    let (token, _) = mint(store, &["open"]).await;
    let port = start(store, loopback_config()).await;
    let body =
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"delete_everything"}}"#;
    let response = send_raw(
        port,
        post_json(upstream, &token, body, "Content-Encoding: identity\r\n"),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(seen.recv().await.unwrap().contains("delete_everything"));
}
