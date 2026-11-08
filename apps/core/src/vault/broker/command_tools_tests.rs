use super::*;
use crate::vault::broker::services::test_service;

fn grants(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

fn leaked_store() -> &'static PluginSecretStore {
    Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()))
}

async fn add_service(store: &PluginSecretStore, name: &str, host: &str, enabled: bool) {
    let mut input = test_service(name, host, None, "/").normalize().unwrap();
    input.enabled = enabled;
    let conn = store.conn.lock().await;
    services::insert(&conn, input).unwrap();
}

fn ca_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ryu-command-broker-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn the_scope_is_the_named_services_in_the_grants_and_never_a_wildcard() {
    let declared = declared_services(&grants(&[
        "tool:command:gh",
        "vault:broker:github",
        "vault:broker:*",
        "vault:broker:",
        "vault:broker:Bad Name",
        "vault:broker:linear",
        "vault:broker:github",
        "net:api.github.com",
    ]));
    assert_eq!(declared, vec!["github".to_owned(), "linear".to_owned()]);
    assert!(declared_services(&grants(&["tool:command:*"])).is_empty());
}

#[tokio::test]
async fn an_invocation_gets_a_session_over_only_its_enabled_declared_services() {
    let store = leaked_store();
    add_service(store, "github", "api.github.com", true).await;
    add_service(store, "linear", "api.linear.app", false).await;
    add_service(store, "openai", "api.openai.com", true).await;
    let dir = ca_dir();
    let declared = vec!["github".to_owned(), "linear".to_owned()];
    let lease = lease(store, 8123, &dir, "@ryu/gh", &declared, 30)
        .await
        .unwrap()
        .expect("leased");
    let proxy = &lease.env()["HTTPS_PROXY"];
    assert!(proxy.starts_with("http://rvb:rvb_"), "{proxy}");
    assert!(proxy.ends_with("@127.0.0.1:8123"), "{proxy}");
    // The token never appears in Debug output.
    assert!(!format!("{lease:?}").contains("rvb_"));
    let id = lease.session_id().to_owned();
    let session = {
        let conn = store.conn.lock().await;
        sessions::live(&conn, &id).unwrap().expect("live")
    };
    // Not the undeclared `openai`, nor the disabled `linear`.
    assert_eq!(session.services, vec!["github".to_owned()]);
    assert!(session.minted_by.starts_with("runtime:command:"));
    assert!(session.minter_scope.is_none());
    assert_eq!(session.label, "@ryu/gh command");
    // Short-lived: clamped up to the minimum session TTL.
    assert!(session.expires_at - session.created_at <= (sessions::MIN_TTL_SECS + 5) * 1000);

    drop(lease);
    for _ in 0..100 {
        let live = {
            let conn = store.conn.lock().await;
            sessions::live(&conn, &id).unwrap()
        };
        if live.is_none() {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the command session was not revoked on drop");
}

#[tokio::test]
async fn a_scope_with_no_enabled_service_is_refused_and_mints_nothing() {
    let store = leaked_store();
    add_service(store, "linear", "api.linear.app", false).await;
    let dir = ca_dir();
    let refused = lease(store, 8123, &dir, "@ryu/x", &["linear".to_owned()], 30)
        .await
        .unwrap()
        .expect_err("refused");
    assert!(refused.0.contains("linear"), "{refused}");
    let conn = store.conn.lock().await;
    assert!(sessions::list(&conn).unwrap().is_empty());
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_declared_scope_fails_closed_before_any_session() {
    // No scope: nothing to do.
    assert!(lease_for_command("@ryu/x", &[], false, false, 30)
        .await
        .unwrap()
        .is_none());
    let declared = vec!["github".to_owned()];
    let both = lease_for_command("@ryu/x", &declared, false, true, 30)
        .await
        .unwrap_err();
    assert!(both.0.contains("egress_url_arg"), "{both}");
    let confined = lease_for_command("@ryu/x", &declared, true, false, 30)
        .await
        .unwrap_err();
    assert!(confined.0.contains("account access"), "{confined}");
}
