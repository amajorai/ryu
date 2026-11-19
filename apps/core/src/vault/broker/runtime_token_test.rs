//! The lease keeps the run's own session token for its in-process broker
//! tools: exactly the token in the run's proxy URL, and none for a lease over
//! another caller's session.

use super::*;
use crate::vault::broker::services::test_service;

fn launch() -> RuntimeLaunch {
    RuntimeLaunch {
        kind: "claude-code",
        agent: None,
        trusted_workspace: true,
        account_confined: false,
        model_via_loopback: true,
        upstream_proxy: false,
    }
}

#[tokio::test]
async fn a_lease_hands_its_bridge_exactly_the_proxy_session() {
    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    {
        let conn = store.conn.lock().await;
        settings::put(
            &conn,
            &crate::vault::active_environment(),
            UnmatchedHostPolicy::Passthrough,
            "",
        )
        .unwrap();
        let input = test_service("openai", "api.openai.com", None, "/")
            .normalize()
            .unwrap();
        services::insert(&conn, input).unwrap();
    }
    let dir = std::env::temp_dir().join(format!("ryu-runtime-token-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let lease = lease(store, 8124, &dir, launch())
        .await
        .unwrap()
        .expect("brokered");

    let token = lease
        .session_token()
        .expect("a minted lease keeps its token")
        .to_owned();
    assert!(token.starts_with(sessions::TOKEN_PREFIX));
    let proxy = &lease.env()["HTTPS_PROXY"];
    assert!(proxy.contains(&format!("rvb:{token}@")));
    assert!(!format!("{lease:?}").contains(&token));
    {
        let conn = store.conn.lock().await;
        let session = sessions::lookup(&conn, &token, None)
            .unwrap()
            .expect("live");
        assert_eq!(session.id, lease.session_id());
    }

    // A lease over a session another caller minted exposes no token.
    let borrowed = RuntimeBrokerLease::for_session(store, String::new());
    assert_eq!(borrowed.session_token(), None);
    std::mem::forget(borrowed);

    // Dropping the run's lease revokes the session the bridge was given.
    drop(lease);
    for _ in 0..100 {
        let live = {
            let conn = store.conn.lock().await;
            sessions::lookup(&conn, &token, None).unwrap()
        };
        if live.is_none() {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("dropping the lease did not revoke the bridge's session");
}
