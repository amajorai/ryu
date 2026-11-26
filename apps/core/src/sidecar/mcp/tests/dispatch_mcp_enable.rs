//! An agent's self-API call may not switch on an MCP server from a registry.

use super::*;
use crate::approvals::chat_grants;
use crate::plugin_manifest::{AppDependency, PluginManifest, Requires};
use serde_json::json;
use std::sync::Arc;

const ENABLE: &str = "ryu_api.post_api_plugins_id_enable";
const REFUSAL: &str = "would switch on the MCP server";
// Ids no real install uses.
const SERVER: &str = "ce17-test-registry-server";
const PLAIN_APP: &str = "ce17-test-plain-app";
const REQUIRING_APP: &str = "ce17-test-app-requiring-the-server";

fn manifest(id: &str, category: Option<&str>, requires: &[&str]) -> PluginManifest {
    PluginManifest {
        id: id.to_owned(),
        name: id.to_owned(),
        version: "1.0.0".to_owned(),
        category: category.map(str::to_owned),
        requires: (!requires.is_empty()).then(|| Requires {
            apps: requires
                .iter()
                .map(|dependency| AppDependency {
                    id: (*dependency).to_owned(),
                    min_version: None,
                })
                .collect(),
            ..Default::default()
        }),
        ..Default::default()
    }
}

/// A registry that knows three installed, switched-off apps: the record of an
/// MCP server from a registry, a plain app, and an app that requires the server.
async fn registry_with_installed_apps() -> (McpRegistry, Arc<crate::plugins::PluginStore>) {
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    for id in [SERVER, PLAIN_APP, REQUIRING_APP] {
        store.insert(id, "1.0.0").await.unwrap();
    }
    let manifests = Arc::new(tokio::sync::RwLock::new(vec![
        manifest(SERVER, Some(crate::sidecar::mcp::MCP_SERVER_CATEGORY), &[]),
        manifest(PLAIN_APP, None, &[]),
        manifest(REQUIRING_APP, None, &[SERVER]),
    ]));
    let registry = McpRegistry::empty().with_self_build(manifests, Arc::clone(&store));
    (registry, store)
}

/// The dispatch core, which is what runs once the approval gate let a call
/// through (here: because the person allowed the tool for the chat).
async fn dispatch_enable(registry: &McpRegistry, id: &str) -> anyhow::Result<serde_json::Value> {
    registry
        .call_tool_with_identity_no_gate_scoped(
            None,
            ENABLE,
            json!({ "id": id }),
            None,
            None,
            &[],
            None,
            None,
            None,
            None,
            false,
        )
        .await
}

#[tokio::test]
async fn a_chat_wide_grant_for_the_enable_tool_does_not_switch_on_an_mcp_server() {
    let (registry, store) = registry_with_installed_apps().await;
    const CONVERSATION: &str = "conv-ce17-enable";

    // The person chose "Allow for this chat" while a harmless app was enabled.
    // The grant is kept per tool, so the approval gate lets every later enable
    // through, whatever id it names.
    chat_grants::grant_for_conversation(CONVERSATION, ENABLE);
    assert!(chat_grants::take(
        CONVERSATION,
        ENABLE,
        &json!({ "id": PLAIN_APP })
    ));
    assert!(chat_grants::take(
        CONVERSATION,
        ENABLE,
        &json!({ "id": SERVER })
    ));

    // The call for the MCP server record is refused all the same, before the
    // loopback request is made.
    let error = dispatch_enable(&registry, SERVER)
        .await
        .expect_err("an agent may not switch an MCP server record on");
    assert!(error.to_string().contains(REFUSAL), "{error}");
    assert!(error.to_string().contains(SERVER), "{error}");
    let record = store.get_record(SERVER).await.unwrap().unwrap();
    assert!(!record.enabled, "the record stays switched off");
}

#[tokio::test]
async fn enabling_an_app_that_requires_an_mcp_server_is_refused_too() {
    let (registry, store) = registry_with_installed_apps().await;
    let error = dispatch_enable(&registry, REQUIRING_APP)
        .await
        .expect_err("the enable order would switch the required server on");
    assert!(error.to_string().contains(REFUSAL), "{error}");
    assert!(error.to_string().contains(SERVER), "{error}");
    for id in [SERVER, REQUIRING_APP] {
        let record = store.get_record(id).await.unwrap().unwrap();
        assert!(!record.enabled, "{id} stays switched off");
    }
}

/// These call the guard itself, so no loopback request is made for an app the
/// guard lets through.
#[tokio::test]
async fn a_plain_app_is_let_through_and_an_unreadable_install_set_is_not() {
    let (registry, store) = registry_with_installed_apps().await;
    let plain = json!({ "id": PLAIN_APP });
    assert_eq!(
        registry.agent_mcp_enable_refusal(ENABLE, &plain).await,
        None
    );

    // Once the person switched the server on, an app that requires it enables
    // as before: the call would start nothing new.
    store.set_enabled(SERVER, &[]).await.unwrap();
    let requiring = json!({ "id": REQUIRING_APP });
    assert_eq!(
        registry.agent_mcp_enable_refusal(ENABLE, &requiring).await,
        None
    );
    // The server record itself stays refused, switched on or not.
    let server = json!({ "id": SERVER });
    assert!(registry
        .agent_mcp_enable_refusal(ENABLE, &server)
        .await
        .is_some_and(|reason| reason.contains(REFUSAL)));

    // Other tools are never looked at.
    assert_eq!(
        registry
            .agent_mcp_enable_refusal("ryu_api.post_api_plugins_id_disable", &server)
            .await,
        None
    );

    // No app store wired: the guard cannot tell what the call would switch on.
    let unwired = McpRegistry::empty();
    let reason = unwired
        .agent_mcp_enable_refusal(ENABLE, &plain)
        .await
        .expect("fails closed");
    assert!(reason.contains("cannot check"), "{reason}");
    assert_eq!(
        unwired
            .agent_mcp_enable_refusal("ryu_api.get_api_plugins", &json!({}))
            .await,
        None
    );
}
