//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;
use serde_json::json;

#[tokio::test]
async fn saved_key_servers_and_ghost_follow_the_agent_account_policy() {
    use crate::agents::{AgentIdentityMode, AgentStore, CreateAgent};
    use crate::sidecar::adapters::AcpAgentRegistry;

    let store = AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap();
    let create = |name: &str, mode: AgentIdentityMode, access: Option<Vec<&str>>| {
        let store = &store;
        let input = CreateAgent {
            name: name.to_owned(),
            tools: vec!["*".to_owned()],
            identity_mode: mode,
            account_access: access.map(|keys| keys.into_iter().map(str::to_owned).collect()),
            ..Default::default()
        };
        async move {
            let id = store.create(input).await.unwrap().id;
            // A new agent starts in trial, which is read-only, and a
            // read-only agent is refused `treg.call` (an external effect)
            // before its account switch is reached. This test is about the
            // switches, so the agents are active and may take external
            // effects.
            store
                .update(
                    &id,
                    crate::agents::UpdateAgent {
                        lifecycle_status: Some(crate::agents::AgentLifecycleStatus::Active),
                        safety_profile: Some(crate::agents::AgentSafetyProfile::ApprovalRequired),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            id
        }
    };
    let individual = create(
        "Own identity",
        AgentIdentityMode::Individual,
        Some(vec!["mcp-secret:keyed", "platform:desktop"]),
    )
    .await;
    let limited = create("Limited", AgentIdentityMode::Managed, Some(vec![])).await;
    let listed = create(
        "Listed",
        AgentIdentityMode::Managed,
        Some(vec!["mcp-secret:keyed", "platform:desktop"]),
    )
    .await;
    let legacy = create("Legacy", AgentIdentityMode::Managed, None).await;
    let treg_allowed = create(
        "Treg allowed",
        AgentIdentityMode::Managed,
        Some(vec!["platform:treg"]),
    )
    .await;

    // A server the user added whose header names a saved key, and one
    // that carries none. Nothing listens on either endpoint.
    let remote = |headers: BTreeMap<String, String>| McpServerConfig {
        enabled: true,
        transport: Some("streamable-http".to_owned()),
        url: Some("http://127.0.0.1:9/mcp".to_owned()),
        headers,
        ..Default::default()
    };
    let ghost = McpServerConfig {
        enabled: true,
        command: Some("does-not-exist-ghost-sentinel".to_owned()),
        owner_plugin_id: Some("@ryu/ghost".to_owned()),
        ..Default::default()
    };
    assert!(is_ghost_server(GHOST_SERVER, &ghost));
    let registry = McpRegistry::from_servers(BTreeMap::from([
        (
            "keyed".to_owned(),
            remote(BTreeMap::from([(
                "Authorization".to_owned(),
                "Bearer secret:MY_KEY".to_owned(),
            )])),
        ),
        ("plain".to_owned(), remote(BTreeMap::new())),
        (GHOST_SERVER.to_owned(), ghost),
    ]))
    .with_agent_store(store);
    let runtime = crate::plugins::runtime::PluginRuntime::new();
    registry.set_plugin_runtime(runtime.clone());
    runtime.begin_activation("@ryu/ghost").await.commit();

    let call = |agent: &str, tool: &'static str| {
        let registry = &registry;
        let agent = agent.to_owned();
        async move {
            tokio::time::timeout(
                std::time::Duration::from_secs(20),
                registry.call_tool_with_identity_no_gate_scoped(
                    Some(&agent),
                    tool,
                    json!({}),
                    None,
                    None,
                    &[],
                    None,
                    None,
                    None,
                    None,
                    false,
                ),
            )
            .await
            .expect("the call settles")
            .expect_err("nothing listens, so every call fails")
            .to_string()
        }
    };
    const SAVED_KEY_REFUSAL: &str = "uses one of your saved keys";
    const DESKTOP_REFUSAL: &str = "your desktop";

    // Its own identity never uses the user's keys or desktop, even when
    // the allowlist names them; a limited agent only when they are listed.
    let error = call(&individual, "keyed.search").await;
    assert!(error.contains(SAVED_KEY_REFUSAL), "{error}");
    assert!(error.contains("its own identity"), "{error}");
    let error = call(&limited, "keyed.search").await;
    assert!(error.contains(SAVED_KEY_REFUSAL), "{error}");
    for agent in [&individual, &limited] {
        // Ghost's tools are unannotated here (nothing serves them), so a
        // name the effect check reads as a read reaches the account gate.
        let error = call(agent, "ghost.ghost_read_screen").await;
        assert!(error.contains(DESKTOP_REFUSAL), "{error}");
    }
    // Allowed when listed, and for an unrestricted agent: the call goes on
    // to the (absent) server instead of being refused.
    for agent in [&listed, &legacy] {
        let error = call(agent, "keyed.search").await;
        assert!(!error.contains(SAVED_KEY_REFUSAL), "{error}");
        let error = call(agent, "ghost.ghost_read_screen").await;
        assert!(!error.contains(DESKTOP_REFUSAL), "{error}");
    }
    // A server that names no saved key is not one of the user's accounts.
    let error = call(&individual, "plain.search").await;
    assert!(!error.contains(SAVED_KEY_REFUSAL), "{error}");

    // Paired Ryu devices are the user's own hardware, so `device.*` follows
    // the desktop switch: refused for its own identity and for a limited
    // agent that does not list it, and let through when listed.
    let error = call(&limited, "device.device_status").await;
    assert!(error.contains(DESKTOP_REFUSAL), "{error}");
    let error = call(&individual, "device.device_status").await;
    assert!(error.contains("its own identity"), "{error}");
    let error = call(&listed, "device.device_status").await;
    assert!(!error.contains(DESKTOP_REFUSAL), "{error}");

    // `treg.call` is metered, so it follows the agent's Treg switch before
    // any Gateway call; `treg.describe` is a free catalog read.
    const TREG_REFUSAL: &str = "not allowed to use Treg";
    for agent in [&individual, &limited, &listed] {
        let error = call(agent, "treg.call").await;
        assert!(error.contains(TREG_REFUSAL), "{error}");
        let error = call(agent, "treg.describe").await;
        assert!(!error.contains(TREG_REFUSAL), "{error}");
    }
    for agent in [&treg_allowed, &legacy] {
        let error = call(agent, "treg.call").await;
        assert!(!error.contains(TREG_REFUSAL), "{error}");
    }

    // The listing names the account key for the account-access settings,
    // never the value.
    let summaries = registry.server_summaries();
    let saved_key = |name: &str| {
        summaries
            .iter()
            .find(|summary| summary.name == name)
            .and_then(|summary| summary.saved_key_account.clone())
    };
    assert_eq!(saved_key("keyed").as_deref(), Some("keyed"));
    assert_eq!(saved_key("plain"), None);
    assert_eq!(saved_key(GHOST_SERVER), None);
    let listing = serde_json::to_string(&summaries).unwrap();
    assert!(!listing.contains("MY_KEY"), "{listing}");
}

#[tokio::test]
async fn agent_account_policy_gates_mcp_oauth_profiles() {
    use crate::agent_access::AgentAccountPolicy;
    use crate::agents::AgentIdentityMode;

    let cfg = McpServerConfig {
        owner_plugin_id: Some("@ryu/notion".to_owned()),
        owner_server_name: Some("notion".to_owned()),
        ..Default::default()
    };
    let default_profile = crate::mcp_oauth::default_profile_id();
    let individual = AgentAccountPolicy::from_parts(AgentIdentityMode::Individual, None);
    let error = oauth_profile_for("local", &cfg, &[], Some("a1"), Some(&individual))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("own identity"), "{error}");

    let none = AgentAccountPolicy::from_parts(AgentIdentityMode::Managed, Some(&[]));
    let error = oauth_profile_for("local", &cfg, &[], Some("a1"), Some(&none))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("not allowed"), "{error}");

    let key = format!("mcp:{default_profile}:@ryu/notion:notion");
    let allowed = AgentAccountPolicy::from_parts(AgentIdentityMode::Mixed, Some(&[key][..]));
    let legacy = AgentAccountPolicy::from_parts(AgentIdentityMode::Managed, None);
    for policy in [None, Some(&legacy), Some(&allowed)] {
        assert_eq!(
            oauth_profile_for("local", &cfg, &[], Some("a1"), policy)
                .await
                .unwrap(),
            default_profile
        );
    }
}
