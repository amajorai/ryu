//! Delegated sessions, per-session logs, response caps, and the remote
//! listener, end to end.

use super::*;
use crate::vault::broker::delegation::{self, Member, SessionAttrs};
use crate::vault::broker::remote::RemoteConfig;
use crate::vault::policy;

async fn http_service(store: &PluginSecretStore, upstream: u16) {
    let mut service = test_service("svc", "127.0.0.1", Some(upstream), "/");
    service.allow_insecure_http = true;
    add_service(store, service).await;
}

async fn set_attrs(store: &PluginSecretStore, session: &BrokerSession, attrs: SessionAttrs) {
    let conn = store.conn.lock().await;
    delegation::insert(&conn, &session.id, &attrs).unwrap();
}

fn alice() -> Member {
    Member {
        user_id: "alice".into(),
        subjects: vec!["user:alice".into(), "role:member".into()],
    }
}

fn post_json(upstream: u16, token: &str, body: &str) -> String {
    format!(
        "POST http://127.0.0.1:{upstream}/mcp HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[tokio::test]
async fn a_delegated_session_uses_the_members_value_and_policies() {
    let store = leak_store();
    put_secret(store, "API_TOKEN", "node-token").await;
    store
        .set_vault_secret(SecretScope::User, "alice", None, "API_TOKEN", "alice-token")
        .await
        .unwrap();
    let (upstream, mut seen) = fake_http_upstream().await;
    http_service(store, upstream).await;
    let port = start(store, loopback_config()).await;
    let url = format!("http://127.0.0.1:{upstream}/v1");

    let (plain, _) = mint(store, &["svc"]).await;
    let (delegated, session) = mint(store, &["svc"]).await;
    set_attrs(
        store,
        &session,
        SessionAttrs {
            on_behalf_of: Some(alice()),
            remote: false,
        },
    )
    .await;

    send_raw(port, get_via_proxy(&url, Some(&plain), "")).await;
    let request = seen.recv().await.unwrap().to_ascii_lowercase();
    assert!(
        request.contains("authorization: bearer node-token"),
        "{request}"
    );

    let response = send_raw(port, get_via_proxy(&url, Some(&delegated), "")).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let request = seen.recv().await.unwrap().to_ascii_lowercase();
    assert!(
        request.contains("authorization: bearer alice-token"),
        "{request}"
    );

    // The use is audited as the member, tagged with the session.
    {
        let conn = store.conn.lock().await;
        let tagged: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM vault_audit WHERE action = 'secret.use' AND outcome = 'ok'
                   AND actor_kind = 'user' AND actor_id = 'alice' AND details LIKE ?1",
                [format!("%broker:{}%", session.id)],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tagged, 1);
        // The member's own deny binds the delegated session.
        policy::put_policy(
            &conn,
            &policy::Policy {
                name: "no-default".into(),
                description: String::new(),
                rules: vec![policy::PolicyRule {
                    path: "default/**".into(),
                    capabilities: vec![Capability::Use],
                    deny: true,
                    ..Default::default()
                }],
            },
        )
        .unwrap();
        policy::bind(&conn, "no-default", "role:member", None, None).unwrap();
    }
    let response = send_raw(port, get_via_proxy(&url, Some(&delegated), "")).await;
    assert!(!response.starts_with("HTTP/1.1 200"), "{response}");
    // The minter (the operator, no member subjects) is not bound by it.
    let response = send_raw(port, get_via_proxy(&url, Some(&plain), "")).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");

    let entries = crate::vault::broker::session_log::read(store, &session.id, 10)
        .await
        .unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries
        .iter()
        .all(|entry| entry.on_behalf_of.as_deref() == Some("user:alice")));
}

#[tokio::test]
async fn mcp_tool_calls_are_logged_per_session_without_arguments() {
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    let (upstream, mut seen) = fake_http_upstream().await;
    http_service(store, upstream).await;
    let (token, session) = mint(store, &["svc"]).await;
    let port = start(store, loopback_config()).await;
    let body = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_issue","arguments":{"title":"__SECRET_TITLE__"}}}"#;
    let response = send_raw(port, post_json(upstream, &token, body)).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(seen.recv().await.unwrap().contains("create_issue"));

    let entries = crate::vault::broker::session_log::read(store, &session.id, 10)
        .await
        .unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].rpc[0].tool.as_deref(), Some("create_issue"));
    assert_eq!(entries[0].rpc[0].id.as_deref(), Some("3"));
    let serialized = serde_json::to_string(&entries).unwrap();
    assert!(!serialized.contains("__SECRET_TITLE__"));
    assert!(!serialized.contains(TOKEN_VALUE));
    // The plaintext request log keeps its value-free row.
    assert_eq!(log_rows(store).await.len(), 1);
}

#[tokio::test]
async fn oversized_responses_are_refused() {
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    let (upstream, _seen) = fake_http_upstream().await;
    http_service(store, upstream).await;
    let (token, _) = mint(store, &["svc"]).await;
    let url = format!("http://127.0.0.1:{upstream}/");
    // The fake upstream answers a 2-byte body.
    let capped = start(
        store,
        BrokerConfig {
            max_response_bytes: 1,
            ..loopback_config()
        },
    )
    .await;
    let response = send_raw(capped, get_via_proxy(&url, Some(&token), "")).await;
    assert!(response.starts_with("HTTP/1.1 502"), "{response}");
    assert!(response.contains("response_too_large"), "{response}");
    let fits = start(
        store,
        BrokerConfig {
            max_response_bytes: 2,
            ..loopback_config()
        },
    )
    .await;
    let response = send_raw(fits, get_via_proxy(&url, Some(&token), "")).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(log_rows(store)
        .await
        .iter()
        .any(|row| row.outcome == "response_too_large"));
}

async fn start_remote(store: &'static PluginSecretStore, allowed: &str) -> u16 {
    let (broker, loopback) = Broker::bind(store, loopback_config()).await.unwrap();
    tokio::spawn(broker.clone().serve(loopback));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = RemoteConfig {
        listen: listener.local_addr().unwrap(),
        allowed: vec![Cidr::parse(allowed).unwrap()],
        url: None,
        tls: false,
    };
    tokio::spawn(broker.serve_remote(listener, config));
    port
}

#[tokio::test]
async fn the_remote_listener_admits_only_remote_sessions_from_allowed_peers() {
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    let (upstream, _seen) = fake_http_upstream().await;
    http_service(store, upstream).await;
    let url = format!("http://127.0.0.1:{upstream}/");
    let (local_only, _) = mint(store, &["svc"]).await;
    let (remote, session) = mint(store, &["svc"]).await;
    set_attrs(
        store,
        &session,
        SessionAttrs {
            on_behalf_of: None,
            remote: true,
        },
    )
    .await;

    let port = start_remote(store, "127.0.0.0/8").await;
    let response = send_raw(port, get_via_proxy(&url, Some(&local_only), "")).await;
    assert!(response.starts_with("HTTP/1.1 407"), "{response}");
    let response = send_raw(port, get_via_proxy(&url, Some(&remote), "")).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");

    // A peer outside the allowed networks is dropped before any reply.
    let closed = start_remote(store, "10.0.0.0/8").await;
    let mut stream = TcpStream::connect(("127.0.0.1", closed)).await.unwrap();
    let _ = stream
        .write_all(get_via_proxy(&url, Some(&remote), "").as_bytes())
        .await;
    let mut reply = Vec::new();
    let _ = stream.read_to_end(&mut reply).await;
    assert!(reply.is_empty(), "{}", String::from_utf8_lossy(&reply));
}
