use super::*;
use crate::vault::broker::services::test_service;

fn launch() -> RuntimeLaunch {
    RuntimeLaunch {
        kind: "pi",
        trusted_workspace: true,
        account_confined: false,
        model_via_loopback: true,
        upstream_proxy: false,
    }
}

fn env_settings(
    policy: UnmatchedHostPolicy,
    broker_runs_under_deny: bool,
) -> settings::EnvironmentSettings {
    settings::EnvironmentSettings {
        environment: "default".into(),
        unmatched_host_policy: policy,
        broker_runs_under_deny,
        skills: String::new(),
        updated_at: 0,
    }
}

fn set_policy(store: &PluginSecretStore, policy: UnmatchedHostPolicy) {
    let conn = store.conn.try_lock().unwrap();
    settings::put(&conn, &crate::vault::active_environment(), policy, "").unwrap();
}

/// A store whose active environment brokers trusted runs (`passthrough`).
fn leaked_store() -> &'static PluginSecretStore {
    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    set_policy(store, UnmatchedHostPolicy::Passthrough);
    store
}

async fn add_service(store: &PluginSecretStore, name: &str, host: &str, enabled: bool) {
    let mut input = test_service(name, host, None, "/").normalize().unwrap();
    input.enabled = enabled;
    let conn = store.conn.lock().await;
    services::insert(&conn, input).unwrap();
}

fn ca_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ryu-runtime-broker-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn decide_brokers_only_runs_it_cannot_break_or_widen() {
    use RuntimeDecision::{Broker, Skip};
    let pass = &env_settings(UnmatchedHostPolicy::Passthrough, false);
    let brokered = Broker;
    assert_eq!(decide(&launch(), pass, 1), brokered);
    assert_eq!(decide(&launch(), pass, 0), Skip("no_services"));
    let confined = RuntimeLaunch {
        account_confined: true,
        ..launch()
    };
    assert_eq!(decide(&confined, pass, 3), Skip("account_confined"));
    let proxied = RuntimeLaunch {
        upstream_proxy: true,
        ..launch()
    };
    assert_eq!(decide(&proxied, pass, 3), Skip("upstream_proxy"));
    let direct = RuntimeLaunch {
        model_via_loopback: false,
        ..launch()
    };
    assert_eq!(decide(&direct, pass, 1), brokered);
}

#[test]
fn deny_never_brokers_a_trusted_run_even_through_loopback() {
    // `deny` (the default) would 403 every host no service covers, cutting
    // the agent and the tools it spawns off from the network it has today.
    let deny = &env_settings(UnmatchedHostPolicy::Deny, false);
    for model_via_loopback in [true, false] {
        let trusted = RuntimeLaunch {
            model_via_loopback,
            ..launch()
        };
        assert_eq!(
            decide(&trusted, deny, 1),
            RuntimeDecision::Skip("deny_would_cut_trusted_network")
        );
    }
}

#[test]
fn the_deny_opt_in_brokers_trusted_runs_whose_model_stays_on_loopback() {
    let opted_in = &env_settings(UnmatchedHostPolicy::Deny, true);
    assert_eq!(decide(&launch(), opted_in, 1), RuntimeDecision::Broker);
    // An agent that reaches its provider directly would lose its model.
    let direct = RuntimeLaunch {
        model_via_loopback: false,
        ..launch()
    };
    assert_eq!(
        decide(&direct, opted_in, 1),
        RuntimeDecision::Skip("deny_would_cut_model_traffic")
    );
    // The opt-in never widens the other refusals.
    assert_eq!(
        decide(&launch(), opted_in, 0),
        RuntimeDecision::Skip("no_services")
    );
    let confined = RuntimeLaunch {
        account_confined: true,
        ..launch()
    };
    assert_eq!(
        decide(&confined, opted_in, 1),
        RuntimeDecision::Skip("account_confined")
    );
    // Passthrough ignores it.
    let pass = &env_settings(UnmatchedHostPolicy::Passthrough, true);
    assert_eq!(decide(&direct, pass, 1), RuntimeDecision::Broker);
}

#[test]
fn untrusted_workspaces_are_never_brokered_or_relayed() {
    // Relaying the broker into a network cut would give a sandboxed agent
    // every enabled service with the operator's credentials.
    let untrusted = RuntimeLaunch {
        trusted_workspace: false,
        ..launch()
    };
    for policy in [UnmatchedHostPolicy::Deny, UnmatchedHostPolicy::Passthrough] {
        for opt_in in [false, true] {
            assert_eq!(
                decide(&untrusted, &env_settings(policy, opt_in), 1),
                RuntimeDecision::Skip("untrusted_workspace")
            );
        }
    }
}

#[tokio::test]
async fn a_run_gets_its_own_session_over_enabled_services_and_drop_revokes_it() {
    let store = leaked_store();
    add_service(store, "openai", "api.openai.com", true).await;
    add_service(store, "github", "api.github.com", false).await;
    let dir = ca_dir();
    let lease = lease(store, 8123, &dir, launch())
        .await
        .unwrap()
        .expect("brokered");
    let proxy = &lease.env()["HTTPS_PROXY"];
    assert!(proxy.starts_with("http://rvb:rvb_"), "{proxy}");
    assert!(proxy.ends_with("@127.0.0.1:8123"), "{proxy}");
    assert_eq!(lease.env()["NODE_USE_ENV_PROXY"], "1");
    let ca_path = std::path::PathBuf::from(&lease.env()["DENO_CERT"]);
    assert!(ca_path.starts_with(&dir));
    assert!(std::fs::read_to_string(&ca_path)
        .unwrap()
        .contains("BEGIN CERTIFICATE"));
    // The token never appears in Debug output.
    assert!(!format!("{lease:?}").contains("rvb_"));

    let id = lease.session_id().to_owned();
    let session = {
        let conn = store.conn.lock().await;
        sessions::live(&conn, &id).unwrap().expect("live")
    };
    assert_eq!(session.services, vec!["openai".to_owned()]);
    assert!(session.minted_by.starts_with("runtime:pi:"));
    assert!(session.minter_scope.is_none());
    assert_eq!(session.user_id(), None);

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
    panic!("dropping the lease did not revoke the session");
}

#[tokio::test]
async fn concurrent_runs_do_not_share_a_session_cap() {
    let store = leaked_store();
    add_service(store, "openai", "api.openai.com", true).await;
    let dir = ca_dir();
    let mut leases = Vec::new();
    for _ in 0..(sessions::MAX_ACTIVE_PER_SUBJECT + 2) {
        leases.push(lease(store, 8123, &dir, launch()).await.unwrap().unwrap());
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn skipped_runs_mint_nothing() {
    let store = leaked_store();
    let dir = ca_dir();
    assert!(lease(store, 8123, &dir, launch()).await.unwrap().is_none());
    add_service(store, "openai", "api.openai.com", true).await;
    let untrusted = RuntimeLaunch {
        trusted_workspace: false,
        ..launch()
    };
    assert!(lease(store, 8123, &dir, untrusted).await.unwrap().is_none());
    let confined = RuntimeLaunch {
        account_confined: true,
        ..launch()
    };
    assert!(lease(store, 8123, &dir, confined).await.unwrap().is_none());
    let _trusted = lease(store, 8123, &dir, launch()).await.unwrap().unwrap();
    let live = {
        let conn = store.conn.lock().await;
        sessions::list(&conn).unwrap()
    };
    assert_eq!(live.len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_default_deny_policy_leaves_trusted_runs_unbrokered() {
    let store = leaked_store();
    set_policy(store, UnmatchedHostPolicy::Deny);
    add_service(store, "openai", "api.openai.com", true).await;
    let dir = ca_dir();
    assert!(lease(store, 8123, &dir, launch()).await.unwrap().is_none());
    let conn = store.conn.lock().await;
    assert!(sessions::list(&conn).unwrap().is_empty());
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn an_environment_that_opts_in_brokers_trusted_runs_under_deny() {
    let store = leaked_store();
    {
        let conn = store.conn.lock().await;
        let environment = crate::vault::active_environment();
        settings::save(&conn, &environment, UnmatchedHostPolicy::Deny, true, "").unwrap();
    }
    add_service(store, "openai", "api.openai.com", true).await;
    let dir = ca_dir();
    let brokered = lease(store, 8123, &dir, launch())
        .await
        .unwrap()
        .expect("opted in");
    assert!(brokered.env()["HTTPS_PROXY"].starts_with("http://rvb:rvb_"));
    let untrusted = RuntimeLaunch {
        trusted_workspace: false,
        ..launch()
    };
    assert!(lease(store, 8123, &dir, untrusted).await.unwrap().is_none());
    let conn = store.conn.lock().await;
    assert_eq!(sessions::list(&conn).unwrap().len(), 1);
    drop(conn);
    let _ = std::fs::remove_dir_all(&dir);
}

async fn bind_runtime(store: &PluginSecretStore, kind: &str, services: &[&str], disabled: bool) {
    use crate::vault::policy::{Capability, Policy, PolicyRule};
    {
        let conn = store.conn.lock().await;
        crate::vault::policy::put_policy(
            &conn,
            &Policy {
                name: "agent-services".into(),
                description: String::new(),
                rules: services
                    .iter()
                    .map(|service| PolicyRule {
                        path: format!("sys/broker/{service}"),
                        capabilities: vec![Capability::Use],
                        ..Default::default()
                    })
                    .collect(),
            },
        )
        .unwrap();
    }
    let identity = store.agent_identity(kind).await.unwrap();
    store
        .machine_update(
            &identity.id,
            Some(vec!["agent-services".into()]),
            None,
            Some(disabled),
            &AuditActor::system(),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn an_unbound_runtime_gets_an_identity_but_keeps_its_runtime_session() {
    let store = leaked_store();
    add_service(store, "openai", "api.openai.com", true).await;
    let dir = ca_dir();
    let lease = lease(store, 8123, &dir, launch()).await.unwrap().unwrap();
    let identity = store.machine_get("ryu-agent-pi").await.unwrap();
    assert!(identity.policies.is_empty());
    let session = {
        let conn = store.conn.lock().await;
        sessions::live(&conn, lease.session_id()).unwrap().unwrap()
    };
    assert!(session.minted_by.starts_with("runtime:pi:"));
    assert_eq!(session.minted_token, None);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_bound_runtime_runs_as_its_identity_over_permitted_services_only() {
    let store = leaked_store();
    add_service(store, "openai", "api.openai.com", true).await;
    add_service(store, "github", "api.github.com", true).await;
    bind_runtime(store, "pi", &["github"], false).await;
    let identity = store.machine_get("ryu-agent-pi").await.unwrap();
    let dir = ca_dir();
    let lease = lease(store, 8123, &dir, launch()).await.unwrap().unwrap();
    let id = lease.session_id().to_owned();
    let session = {
        let conn = store.conn.lock().await;
        sessions::live(&conn, &id).unwrap().unwrap()
    };
    assert_eq!(session.minted_by, format!("machine:{}", identity.id));
    assert_eq!(session.services, vec!["github".to_owned()]);
    let accessor = session.minted_token.clone().expect("identity token");
    {
        let conn = store.conn.lock().await;
        assert!(
            crate::vault::machine::principal_by_accessor_locked(&conn, &accessor)
                .unwrap()
                .is_some()
        );
    }

    drop(lease);
    for _ in 0..100 {
        let (session_live, token_live) = {
            let conn = store.conn.lock().await;
            (
                sessions::live(&conn, &id).unwrap().is_some(),
                crate::vault::machine::principal_by_accessor_locked(&conn, &accessor)
                    .unwrap()
                    .is_some(),
            )
        };
        if !session_live && !token_live {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("dropping the lease did not end the session and its identity token");
}

#[tokio::test]
async fn disabling_a_runtime_identity_ends_its_runs_and_brokers_no_new_ones() {
    let store = leaked_store();
    add_service(store, "github", "api.github.com", true).await;
    bind_runtime(store, "acp", &["github"], false).await;
    let dir = ca_dir();
    let running = RuntimeLaunch {
        kind: "acp",
        ..launch()
    };
    let lease_live = lease(store, 8123, &dir, running).await.unwrap().unwrap();
    store
        .machine_update(
            "ryu-agent-acp",
            None,
            None,
            Some(true),
            &AuditActor::system(),
        )
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        assert!(sessions::live(&conn, lease_live.session_id())
            .unwrap()
            .is_none());
    }
    assert!(lease(store, 8123, &dir, running).await.unwrap().is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_bound_runtime_without_use_on_any_service_is_not_brokered() {
    let store = leaked_store();
    add_service(store, "openai", "api.openai.com", true).await;
    bind_runtime(store, "claude-code", &["github"], false).await;
    let dir = ca_dir();
    let launch = RuntimeLaunch {
        kind: "claude-code",
        ..launch()
    };
    assert!(lease(store, 8123, &dir, launch).await.unwrap().is_none());
    let conn = store.conn.lock().await;
    assert!(sessions::list(&conn).unwrap().is_empty());
    let live_tokens: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vault_tokens WHERE revoked_at IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(live_tokens, 0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_bound_runtime_is_capped_per_identity_and_leaks_no_token_past_the_cap() {
    let store = leaked_store();
    add_service(store, "github", "api.github.com", true).await;
    bind_runtime(store, "pi", &["github"], false).await;
    let dir = ca_dir();
    let mut leases = Vec::new();
    for _ in 0..sessions::MAX_ACTIVE_PER_SUBJECT {
        leases.push(lease(store, 8123, &dir, launch()).await.unwrap().unwrap());
    }
    // Every bound run mints as the one identity, so the next concurrent run
    // is refused (`lease_for_launch` then starts it unbrokered) and the
    // internal token issued for it is revoked again.
    assert!(lease(store, 8123, &dir, launch()).await.is_err());
    let conn = store.conn.lock().await;
    assert_eq!(
        sessions::list(&conn).unwrap().len() as i64,
        sessions::MAX_ACTIVE_PER_SUBJECT
    );
    let live_tokens: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vault_tokens WHERE revoked_at IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(live_tokens, sessions::MAX_ACTIVE_PER_SUBJECT);
    drop(conn);
    drop(leases);
    let _ = std::fs::remove_dir_all(&dir);
}
