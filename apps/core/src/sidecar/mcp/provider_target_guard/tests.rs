//! Provider-target guard tests: Core-reserved targets and target ownership.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::plugin_manifest::{CapabilityAdapter, PluginManifest, ProvidesEntry};
use crate::plugins::binding::BindingConfig;
use crate::sidecar::mcp::capability_tools::{resolve_verbs, CAP_VERIFY};

#[test]
fn every_core_built_in_server_is_reserved() {
    for server in [
        "plans",
        crate::self_api::SERVER_NAME,
        crate::ext_api::SERVER_NAME,
        crate::agent_control::SERVER_NAME,
        crate::runnable::self_build::SERVER_NAME,
        crate::runnable::agent_builder::SERVER_NAME,
        crate::runnable::workflow_builder::SERVER_NAME,
        crate::runnable::dashboard_builder::SERVER_NAME,
        super::super::agent_inbox_tool::SERVER_NAME,
        super::super::artifact_tool::SERVER_NAME,
        super::super::challenges_tool::SERVER_NAME,
        super::super::channel_tool::SERVER_NAME,
        super::super::cloud::SERVER_NAME,
        super::super::consent_tool::SERVER_NAME,
        super::super::delegate::SERVER_NAME,
        super::super::device_tool::SERVER_NAME,
        super::super::marketplace_tool::SERVER_NAME,
        super::super::notify_tool::SERVER_NAME,
        super::super::orchestrator::SERVER_NAME,
        super::super::routines_tool::SERVER_NAME,
        super::super::sandbox::SERVER_NAME,
        super::super::search_conversations::SERVER_NAME,
        super::super::skills_tool::SERVER_NAME,
        super::super::spaces_tool::SERVER_NAME,
        super::super::tasks_tool::SERVER_NAME,
        super::super::threads::SERVER_NAME,
        super::super::treg_tool::SERVER_NAME,
        super::super::ui_tool::SERVER_NAME,
        super::super::usage_tool::SERVER_NAME,
        super::super::web_fetch::SERVER_NAME,
        super::super::working_memory_tool::SERVER_NAME,
        super::super::workspace_tool::SERVER_NAME,
    ]
    .into_iter()
    .chain(super::super::capability_tools::SERVERS.iter().copied())
    {
        assert!(
            is_core_reserved_target(&format!("{server}.any_tool")),
            "Core server '{server}' must be in RESERVED_TOOL_SERVERS"
        );
    }
    assert!(!is_core_reserved_target("app.claim_check"));
    assert!(!is_core_reserved_target("mem0.search"));
}

#[test]
fn an_app_tool_slug_in_a_core_namespace_is_reserved() {
    for target in [
        "app.ryu_api.put_api_gateway_config",
        "app__ryu_api__put_api_gateway_config",
        "app.routines.create",
        "app.app.spaces.delete_space",
    ] {
        assert!(is_core_reserved_target(target), "{target}");
        assert!(
            served_verbs(verify_provider(target, &[])).is_empty(),
            "{target} must not be served"
        );
    }
    let verbs = served_verbs(verify_provider(
        "verifier.claim",
        &["app.ryu_api.put_api_gateway_config"],
    ));
    assert!(verbs.is_empty(), "adapter target via app alias: {verbs:?}");
    assert!(!is_core_reserved_target("app.mem0.search"));
    assert!(!is_core_reserved_target("app.ryu_api"));
}

fn verify_provider(tool: &str, adapter_tools: &[&str]) -> PluginManifest {
    let binding = CapabilityToolBinding {
        tool: tool.to_owned(),
        adapter: (!adapter_tools.is_empty()).then(|| CapabilityAdapter {
            code: "return input;".to_owned(),
            tools: adapter_tools.iter().map(|t| (*t).to_owned()).collect(),
            ..Default::default()
        }),
        ..Default::default()
    };
    let mut tools = BTreeMap::new();
    tools.insert("verify.claim".to_owned(), binding);
    // Built directly, without manifest validation, as a manifest loaded before
    // the reservation existed would be.
    PluginManifest {
        id: "com.example.verifier".to_owned(),
        name: "Verifier".to_owned(),
        version: "1.0.0".to_owned(),
        provides: vec![ProvidesEntry {
            capability: CAP_VERIFY.to_owned(),
            version: "1.0.0".to_owned(),
            selectable: true,
            default_provider: true,
            tools,
            ..Default::default()
        }],
        ..Default::default()
    }
}

fn served_verbs(provider: PluginManifest) -> Vec<String> {
    resolve_verbs(&[provider], &BindingConfig::default())
        .into_iter()
        .map(|resolved| resolved.verb.id.to_owned())
        .collect()
}

#[test]
fn a_verb_bound_to_a_core_tool_is_never_served() {
    for target in [
        "ryu_api.put_api_gateway_config",
        "ryu_api__put_api_gateway_config",
        "routines.create",
        "spaces.delete_space",
        "channel.send",
    ] {
        let verbs = served_verbs(verify_provider(target, &[]));
        assert!(verbs.is_empty(), "{target} must not be served: {verbs:?}");
    }
    let verbs = served_verbs(verify_provider("verifier.claim", &["ryu_api.post_x"]));
    assert!(
        verbs.is_empty(),
        "an adapter target into ryu_api: {verbs:?}"
    );
}

#[test]
fn an_adapter_cannot_call_a_core_tool_by_name() {
    let bridge = super::super::CapabilityAdapterBridge {
        registry: std::sync::Arc::new(super::super::McpRegistry::default()),
        target: "verifier.claim".to_owned(),
        allowed: ["ryu_api.put_api_gateway_config", "verifier.scopes"]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        provider_id: "com.example.verifier".to_owned(),
        agent_id: None,
        user_id: None,
        profile_ids: Vec::new(),
        session_id: None,
        host_conversation_id: None,
    };
    let path = crate::tool_exec::CAPABILITY_ADAPTER_NAMED_PATH;
    let denied = bridge
        .resolve_target(
            path,
            &serde_json::json!({ "tool": "ryu_api.put_api_gateway_config" }),
        )
        .expect_err("a declared Core tool must still be refused");
    assert!(denied.contains("Core tool"), "{denied}");
    assert_eq!(
        bridge
            .resolve_target(path, &serde_json::json!({ "tool": "verifier.scopes" }))
            .expect("the provider's own tool stays callable"),
        "verifier.scopes"
    );
}

#[test]
fn a_verb_bound_to_the_providers_own_tool_is_still_served() {
    assert_eq!(
        served_verbs(verify_provider("verifier.claim", &["verifier.scopes"])),
        ["verify.claim"]
    );
    assert_eq!(
        served_verbs(verify_provider("app.claim_check", &[])),
        ["verify.claim"]
    );
}
fn server(owner: Option<&str>) -> super::super::McpServerConfig {
    let mut cfg = super::super::McpServerConfig {
        command: Some("x".to_owned()),
        ..Default::default()
    };
    cfg.owner_plugin_id = owner.map(str::to_owned);
    cfg
}

/// A user `mcp.json` `gmail` plus a server owned by another plugin and one
/// owned by the provider itself.
fn registry_with_foreign_servers() -> Arc<McpRegistry> {
    let mut servers = BTreeMap::new();
    servers.insert("gmail".to_owned(), server(None));
    servers.insert("sites".to_owned(), server(Some("@ryu/sites")));
    servers.insert("evil".to_owned(), server(Some("com.example.evil")));
    Arc::new(McpRegistry::from_servers(servers))
}

#[tokio::test]
async fn a_provider_target_on_a_server_it_does_not_own_is_refused() {
    let registry = registry_with_foreign_servers();
    for target in ["gmail.send_email", "gmail__send_email", "sites.delete_site"] {
        let denied = registry
            .provider_target_ownership("com.example.evil", target)
            .await
            .expect_err("a foreign server must be refused");
        assert!(denied.contains("not owned by this provider"), "{denied}");
    }
    for (provider, target) in [
        ("com.example.evil", "evil.search"),
        ("@ryu/sites", "sites.delete_site"),
        ("com.example.evil", "app.search"),
    ] {
        assert!(
            registry
                .provider_target_ownership(provider, target)
                .await
                .is_ok(),
            "{provider} -> {target}"
        );
    }
}

fn bridge(registry: Arc<McpRegistry>, provider: &str, target: &str) -> CapabilityAdapterBridge {
    CapabilityAdapterBridge {
        registry,
        target: target.to_owned(),
        allowed: [
            "gmail.send_email",
            "sites.delete_site",
            "evil.search",
            "chromium.open_tab",
            "brave.search",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect(),
        provider_id: provider.to_owned(),
        agent_id: None,
        user_id: None,
        profile_ids: Vec::new(),
        session_id: None,
        host_conversation_id: None,
    }
}

#[tokio::test]
async fn an_adapter_cannot_reach_another_owners_server() {
    let bridge = bridge(
        registry_with_foreign_servers(),
        "com.example.evil",
        "gmail.send_email",
    );
    let named = crate::tool_exec::CAPABILITY_ADAPTER_NAMED_PATH;
    for tool in ["gmail.send_email", "sites.delete_site"] {
        let denied = bridge
            .resolve_owned_target(named, &json!({ "tool": tool }))
            .await
            .expect_err("a declared foreign tool must still be refused");
        assert!(denied.contains("not owned by this provider"), "{denied}");
    }
    let call = crate::tool_exec::CAPABILITY_ADAPTER_CALL_PATH;
    assert!(bridge.resolve_owned_target(call, &json!({})).await.is_err());
    assert_eq!(
        bridge
            .resolve_owned_target(named, &json!({ "tool": "evil.search" }))
            .await
            .expect("the provider's own server stays callable"),
        "evil.search"
    );
}

/// An enabled plugin whose only runnable is the native dotted http tool `slug`.
fn native_tool_plugin(id: &str, slug: &str) -> PluginManifest {
    let runnable: crate::plugin_manifest::schema::RunnableEntry = serde_json::from_value(json!({
        "id": "tool",
        "name": "Tool",
        "kind": "tool",
        "config": { "slug": slug, "backend": "http", "url": "https://fixture.invalid/t" },
    }))
    .expect("tool runnable");
    PluginManifest {
        id: id.to_owned(),
        name: id.to_owned(),
        version: "1.0.0".to_owned(),
        runnables: vec![runnable],
        ..Default::default()
    }
}

/// `@ryu/brave` owns native `brave.search`, `@ryu/browser` owns native
/// `chromium.open_tab`, and the user's `mcp.json` also has a `brave` server.
async fn registry_with_native_tools() -> Arc<McpRegistry> {
    let plugins = [
        native_tool_plugin("@ryu/brave", "brave.search"),
        native_tool_plugin("@ryu/browser", "chromium.open_tab"),
        native_tool_plugin("com.example.evil", "evil.search"),
    ];
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    for plugin in &plugins {
        store.insert(&plugin.id, &plugin.version).await.unwrap();
        store.set_enabled(&plugin.id, &[]).await.unwrap();
    }
    let mut servers = BTreeMap::new();
    servers.insert("brave".to_owned(), server(None));
    let registry = McpRegistry::from_servers(servers)
        .with_self_build(Arc::new(tokio::sync::RwLock::new(plugins.to_vec())), store);
    for id in [
        "brave.search",
        "chromium.open_tab",
        "evil.search",
        "app.orphan",
    ] {
        registry.register_app_tool(id.to_owned(), id.to_owned(), None);
    }
    Arc::new(registry)
}

#[tokio::test]
async fn a_native_app_tool_is_owned_by_its_plugin_unless_a_foreign_server_holds_the_name() {
    let registry = registry_with_native_tools().await;
    // No `chromium` server exists, so the native tool is its plugin's target.
    let browser = bridge(Arc::clone(&registry), "@ryu/browser", "chromium.open_tab");
    let call = crate::tool_exec::CAPABILITY_ADAPTER_CALL_PATH;
    assert_eq!(
        browser
            .resolve_owned_target(call, &json!({}))
            .await
            .unwrap(),
        "chromium.open_tab"
    );
    // The user's `brave` server holds that namespace. A plugin that does not
    // own it (here, not the exact compiled manifest) yields to the server at
    // dispatch, so the guard judges the target on the server lane too.
    let denied = registry
        .provider_target_ownership("@ryu/brave", "brave.search")
        .await
        .expect_err("dispatch would reach the user's brave server");
    assert!(denied.contains("not owned by this provider"), "{denied}");
    let denied = registry
        .provider_target_ownership("@ryu/brave", "brave.other")
        .await
        .expect_err("the user's brave server is not the provider's");
    assert!(denied.contains("not owned by this provider"), "{denied}");
}

#[tokio::test]
async fn a_provider_cannot_target_another_plugins_native_app_tool() {
    let registry = registry_with_native_tools().await;
    for (provider, target) in [
        ("com.example.evil", "chromium.open_tab"),
        ("com.example.evil", "brave.search"),
        ("com.example.evil", "app.orphan"),
    ] {
        let denied = registry
            .provider_target_ownership(provider, target)
            .await
            .expect_err("another owner's app tool must be refused");
        assert!(denied.contains("may not call"), "{denied}");
    }
    let evil = bridge(Arc::clone(&registry), "com.example.evil", "evil.search");
    let named = crate::tool_exec::CAPABILITY_ADAPTER_NAMED_PATH;
    let denied = evil
        .resolve_owned_target(named, &json!({ "tool": "chromium.open_tab" }))
        .await
        .expect_err("callNamed into another plugin's tool");
    assert!(denied.contains("owned by '@ryu/browser'"), "{denied}");
    assert_eq!(
        evil.resolve_owned_target(named, &json!({ "tool": "evil.search" }))
            .await
            .unwrap(),
        "evil.search"
    );
}

/// `composio.<ACTION>` is dispatched by prefix with the user's connections and no
/// `composio` server is registered, so a provider declaring a `composio`
/// `mcp_servers` key must not reach it through a facade verb or callNamed.
#[tokio::test]
async fn a_provider_cannot_target_an_unregistered_prefix_lane() {
    let registry = registry_with_native_tools().await;
    let target = "composio.GMAIL_SEND_EMAIL";
    let denied = registry
        .provider_target_ownership("com.example.evil", target)
        .await
        .expect_err("a prefix-dispatched lane nobody registered must be refused");
    assert!(denied.contains("no app tool or MCP server"), "{denied}");

    let facade = bridge(Arc::clone(&registry), "com.example.evil", target);
    let call = crate::tool_exec::CAPABILITY_ADAPTER_CALL_PATH;
    assert!(facade.resolve_owned_target(call, &json!({})).await.is_err());

    let mut named_bridge = bridge(Arc::clone(&registry), "com.example.evil", "evil.search");
    named_bridge.allowed.insert(target.to_owned());
    let named = crate::tool_exec::CAPABILITY_ADAPTER_NAMED_PATH;
    let denied = named_bridge
        .resolve_owned_target(named, &json!({ "tool": target }))
        .await
        .expect_err("callNamed into composio must be refused");
    assert!(denied.contains("may not call"), "{denied}");
}
