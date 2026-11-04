//! Regression tests for delegate-written role screening.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use ryu_egress::target::TargetAuthority;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;
use crate::plugin_secrets::{PluginSecretStore, SecretCoords, SecretScope};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use crate::vault::audit::AuditActor;
use crate::vault::dynamic::redis::tests::fake_server;
use crate::vault::dynamic::static_roles::StaticRoleInput;

fn provider(value: serde_json::Value) -> ProviderConfig {
    serde_json::from_value(value).expect("valid provider config")
}

fn bound_node() -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: "org-1".to_owned(),
            name: "Acme".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}

async fn set_writer(store: &PluginSecretStore, table: &str, name: &str, writer: Option<&str>) {
    let conn = store.conn.lock().await;
    conn.execute(
        &format!("UPDATE {table} SET writer = ?1 WHERE name = ?2"),
        rusqlite::params![writer, name],
    )
    .unwrap();
}

async fn stored_writer(store: &PluginSecretStore, table: &str, name: &str) -> Option<String> {
    let conn = store.conn.lock().await;
    conn.query_row(
        &format!("SELECT writer FROM {table} WHERE name = ?1"),
        rusqlite::params![name],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn writers_map_to_egress() {
    assert_eq!(RoleWriter::Manager.egress(), TargetEgress::Trusted);
    assert_eq!(RoleWriter::Delegate.egress(), TargetEgress::Screened);
    assert_eq!(RoleWriter::Manager.label(), "manager");
    assert_eq!(RoleWriter::Delegate.label(), "delegate");
    assert_eq!(TargetEgress::default(), TargetEgress::Screened);
    assert_eq!(
        TargetEgress::resolve(TargetAuthority::Unrecorded, false),
        TargetEgress::Trusted
    );
    assert_eq!(
        TargetEgress::resolve(TargetAuthority::Unrecorded, true),
        TargetEgress::Screened
    );
    assert!(screens_existing_role(Some("manager"), RoleWriter::Delegate));
    assert!(!screens_existing_role(
        Some("delegate"),
        RoleWriter::Manager
    ));
    assert!(!screens_existing_role(Some("manager"), RoleWriter::Manager));
}

#[test]
fn delegate_targets_must_be_public_at_write_time() {
    let secret = "x".repeat(16);
    for bad in [
        json!({ "kind": "postgres", "connectionUrl": "postgres://u:p@127.0.0.1/db",
                "creationStatements": ["CREATE ROLE \"{{name}}\""] }),
        json!({ "kind": "postgres", "connectionUrl": "postgres://u@db.example.com/db?host=/tmp",
                "creationStatements": ["CREATE ROLE \"{{name}}\""] }),
        json!({ "kind": "postgres", "connectionUrl": "postgres://u@db.example.com/db?hostaddr=10.0.0.1",
                "creationStatements": ["CREATE ROLE \"{{name}}\""] }),
        json!({ "kind": "postgres", "connectionUrl": "postgres://u@10.1.2.3/db",
                "creationStatements": ["CREATE ROLE \"{{name}}\""] }),
        json!({ "kind": "redis", "connectionUrl": "redis://127.0.0.1:6379" }),
        json!({ "kind": "redis", "connectionUrl": "redis://localhost:6379" }),
        json!({ "kind": "redis", "connectionUrl": "redis://[::ffff:192.168.1.5]:6379" }),
        json!({ "kind": "webhook", "url": "http://127.0.0.1:9000/hook", "signingSecret": secret }),
        json!({ "kind": "webhook", "url": "https://169.254.169.254/hook", "signingSecret": secret }),
        json!({ "kind": "aws-sts", "accessKeyId": "A", "secretAccessKey": "S",
                "roleArn": "arn:aws:iam::1:role/r", "region": "us-east-1",
                "endpoint": "http://127.0.0.1:9000" }),
    ] {
        assert!(precheck_provider(&provider(bad.clone())).is_err(), "{bad}");
    }
    for good in [
        json!({ "kind": "postgres", "connectionUrl": "postgres://u:p@db.example.com:6543/db",
                "creationStatements": ["CREATE ROLE \"{{name}}\""] }),
        json!({ "kind": "redis", "connectionUrl": "rediss://cache.example.com:6380" }),
        json!({ "kind": "webhook", "url": "https://creds.example.com/hook", "signingSecret": secret }),
        json!({ "kind": "random", "length": 16, "charset": "hex" }),
    ] {
        assert!(precheck_provider(&provider(good.clone())).is_ok(), "{good}");
    }
}

#[tokio::test]
async fn screened_postgres_connections_are_pinned_or_refused() {
    let parse = |url: &str| url.parse::<tokio_postgres::Config>().unwrap();
    for refused in [
        "postgres://u@127.0.0.1/db",
        "postgres://u@10.0.0.4/db",
        "postgres://u@localhost/db",
        "postgres://u@db.example.com/db?host=/tmp",
        "postgres://u@db.example.com/db?hostaddr=127.0.0.1",
        "postgres://u@/db?host=/var/run/postgresql",
    ] {
        let mut pg = parse(refused);
        assert!(
            pin_postgres(&mut pg, TargetEgress::Screened).await.is_err(),
            "{refused}"
        );
    }
    let mut public = parse("postgres://u@8.8.8.8:6543/db");
    pin_postgres(&mut public, TargetEgress::Screened)
        .await
        .unwrap();
    assert_eq!(
        public.get_hostaddrs(),
        ["8.8.8.8".parse::<std::net::IpAddr>().unwrap()]
    );
    let mut trusted = parse("postgres://u@127.0.0.1/db");
    pin_postgres(&mut trusted, TargetEgress::Trusted)
        .await
        .unwrap();
    assert!(trusted.get_hostaddrs().is_empty());
}

#[tokio::test]
async fn a_delegate_cannot_write_a_loopback_dynamic_role() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let config = provider(json!({ "kind": "redis", "connectionUrl": "redis://127.0.0.1:6379" }));
    let refused = store
        .dynamic_put_role_as("cache", &config, (None, None), RoleWriter::Delegate, &actor)
        .await;
    assert!(refused.is_err());
    assert!(store.dynamic_list_roles().await.unwrap().is_empty());
}

/// A manager's role keeps loopback targets; once the stored writer is a
/// delegate (for example a hostname that rebinds to loopback after the
/// write), every connect is screened and nothing reaches the server.
#[tokio::test]
async fn delegate_roles_are_screened_at_connect_and_manager_roles_are_not() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let (url, log) = fake_server(false).await;
    let config = provider(json!({ "kind": "redis", "connectionUrl": url }));
    store
        .dynamic_put_role("cache", &config, Some(600), Some(600), &actor)
        .await
        .unwrap();
    assert_eq!(
        stored_writer(&store, "vault_dynamic_roles", "cache")
            .await
            .as_deref(),
        Some("manager")
    );
    let issued = store
        .dynamic_issue("cache", None, Some("user:a"), &actor)
        .await
        .unwrap();
    let before = log.lock().unwrap().len();
    assert!(before > 0, "a manager role reaches its loopback target");

    set_writer(&store, "vault_dynamic_roles", "cache", Some("delegate")).await;
    let refused = store
        .dynamic_issue("cache", None, Some("user:a"), &actor)
        .await
        .unwrap_err();
    // The screen's reason is the cause under the connect context; callers see
    // the whole chain (`vault_error` renders `{:#}`).
    assert!(
        format!("{refused:#}").contains("public hosts"),
        "{refused:#}"
    );
    assert!(store
        .dynamic_revoke(&issued.lease.id, &actor)
        .await
        .is_err());
    assert_eq!(log.lock().unwrap().len(), before, "no command was sent");
}

#[tokio::test]
async fn legacy_roles_are_trusted_unbound_and_screened_on_a_bound_node() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let (url, log) = fake_server(false).await;
    let config = provider(json!({ "kind": "redis", "connectionUrl": url }));
    store
        .dynamic_put_role("cache", &config, None, None, &actor)
        .await
        .unwrap();
    set_writer(&store, "vault_dynamic_roles", "cache", None).await;
    store
        .dynamic_issue("cache", None, Some("user:a"), &actor)
        .await
        .unwrap();
    let before = log.lock().unwrap().len();
    let bound = with_test_node_binding(true, Some(bound_node()), async {
        store
            .dynamic_issue("cache", None, Some("user:a"), &actor)
            .await
    })
    .await;
    assert!(bound.is_err());
    assert_eq!(log.lock().unwrap().len(), before);
    // Used once on a bound node, it stays screened if the node is unbound.
    assert_eq!(
        stored_writer(&store, "vault_dynamic_roles", "cache")
            .await
            .as_deref(),
        Some("delegate")
    );
    let unbound = with_test_node_binding(true, None, async {
        store
            .dynamic_issue("cache", None, Some("user:a"), &actor)
            .await
    })
    .await;
    assert!(unbound.is_err());
    assert_eq!(log.lock().unwrap().len(), before);
    // A manager's re-save adopts it, and it works on the bound node again.
    with_test_node_binding(true, Some(bound_node()), async {
        store
            .dynamic_put_role_as("cache", &config, (None, None), RoleWriter::Manager, &actor)
            .await
            .unwrap();
        store
            .dynamic_issue("cache", None, Some("user:a"), &actor)
            .await
            .unwrap();
    })
    .await;
}

#[tokio::test]
async fn a_delegate_edit_restamps_and_cannot_downgrade_a_role_with_live_leases() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let public = provider(json!({ "kind": "redis", "connectionUrl": "redis://cache.example.com" }));
    store
        .dynamic_put_role("public", &public, None, None, &actor)
        .await
        .unwrap();
    store
        .dynamic_put_role_as(
            "public",
            &public,
            (Some(60), None),
            RoleWriter::Delegate,
            &actor,
        )
        .await
        .unwrap();
    assert_eq!(
        stored_writer(&store, "vault_dynamic_roles", "public")
            .await
            .as_deref(),
        Some("delegate")
    );

    let random = provider(json!({ "kind": "random", "length": 16, "charset": "hex" }));
    store
        .dynamic_put_role("rnd", &random, None, None, &actor)
        .await
        .unwrap();
    store
        .dynamic_issue("rnd", None, Some("user:a"), &actor)
        .await
        .unwrap();
    let conflict = store
        .dynamic_put_role_as("rnd", &random, (None, None), RoleWriter::Delegate, &actor)
        .await;
    assert!(
        conflict.is_err(),
        "a re-stamp under live leases is a change"
    );
}

#[tokio::test]
async fn delegate_static_roles_are_screened_at_rotation() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let (url, log) = fake_server(false).await;
    let input: StaticRoleInput = serde_json::from_value(json!({
        "provider": { "kind": "redis", "connectionUrl": url, "username": "app" },
        "rotationPeriodSecs": 3600,
    }))
    .unwrap();
    let target = SecretCoords::root(SecretScope::Node, "local", None, "CACHE_PASSWORD");
    assert!(store
        .static_put_role_as(
            "cache",
            &input,
            target.clone(),
            RoleWriter::Delegate,
            &actor
        )
        .await
        .is_err());
    store
        .static_put_role("cache", &input, target, &actor)
        .await
        .unwrap();
    store.static_rotate("cache", &actor).await.unwrap();
    let before = log.lock().unwrap().len();
    set_writer(&store, "vault_static_roles", "cache", Some("delegate")).await;
    assert!(store.static_rotate("cache", &actor).await.is_err());
    assert_eq!(log.lock().unwrap().len(), before);
}

/// A tiny HTTP server that answers every request with `response` and counts
/// connections.
async fn http_server(response: String) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let seen = hits.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            seen.fetch_add(1, Ordering::SeqCst);
            let mut buffer = [0u8; 4096];
            let _ = socket.read(&mut buffer).await;
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    (format!("http://{address}"), hits)
}

#[tokio::test]
async fn manager_webhooks_are_unchanged_and_delegate_webhooks_are_screened() {
    let (inner, inner_hits) = http_server(
        "HTTP/1.1 200 OK\r\ncontent-length: 22\r\nconnection: close\r\n\r\n{\"data\":{\"k\":\"value\"}}"
            .to_owned(),
    )
    .await;
    let (outer, outer_hits) = http_server(format!(
        "HTTP/1.1 307 Temporary Redirect\r\nlocation: {inner}/hook\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
    ))
    .await;
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let secret = "x".repeat(16);
    let redirecting = provider(
        json!({ "kind": "webhook", "url": format!("{outer}/hook"), "signingSecret": secret }),
    );
    store
        .dynamic_put_role("hook", &redirecting, None, None, &actor)
        .await
        .unwrap();
    // A manager's webhook keeps today's client, redirects included.
    store
        .dynamic_issue("hook", None, Some("user:a"), &actor)
        .await
        .unwrap();
    assert_eq!(outer_hits.load(Ordering::SeqCst), 1);
    assert_eq!(inner_hits.load(Ordering::SeqCst), 1);
    // The same role stamped by a delegate makes no connection at all.
    set_writer(&store, "vault_dynamic_roles", "hook", Some("delegate")).await;
    assert!(store
        .dynamic_issue("hook", None, Some("user:a"), &actor)
        .await
        .is_err());
    assert_eq!(outer_hits.load(Ordering::SeqCst), 1);
    assert_eq!(inner_hits.load(Ordering::SeqCst), 1);

    let direct = provider(
        json!({ "kind": "webhook", "url": format!("{inner}/hook"), "signingSecret": secret }),
    );
    store
        .dynamic_put_role("direct", &direct, None, None, &actor)
        .await
        .unwrap();
    store
        .dynamic_issue("direct", None, Some("user:a"), &actor)
        .await
        .unwrap();
    let hits = inner_hits.load(Ordering::SeqCst);
    assert_eq!(hits, 2, "a manager webhook keeps loopback http");
    set_writer(&store, "vault_dynamic_roles", "direct", Some("delegate")).await;
    assert!(store
        .dynamic_issue("direct", None, Some("user:a"), &actor)
        .await
        .is_err());
    assert_eq!(inner_hits.load(Ordering::SeqCst), hits);
}
