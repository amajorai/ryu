//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;
use serde_json::json;

#[test]
fn ghost_cursor_identity_is_sent_only_to_the_system_ghost_server() {
    let mut config = McpServerConfig::default();
    config.owner_plugin_id = Some("@ryu/ghost".to_owned());
    assert!(is_ghost_cursor_action("ghost", "ghost_click", &config));
    assert!(!is_ghost_cursor_action("ghost", "ghost_context", &config));

    config.owner_plugin_id = Some("com.example.ghost".to_owned());
    assert!(!is_ghost_cursor_action("ghost", "ghost_click", &config));
    config.owner_plugin_id = None;
    assert!(!is_ghost_cursor_action("ghost", "ghost_click", &config));
}

/// A minimal stdio MCP server that echoes each `tools/call`'s `_meta` back as
/// the tool result, so a test can observe exactly what Core put on the pipe.
const META_ECHO_SERVER: &str = r#"
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    frame = json.loads(line)
    if "id" not in frame:
        continue
    method = frame.get("method")
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "echo", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "echo", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": True}}]}
    elif method == "tools/call":
        meta = (frame.get("params") or {}).get("_meta") or {}
        result = {"content": [{"type": "text", "text": json.dumps(meta.get("ryu/caller"))}], "isError": False}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": frame["id"], "error": {"code": -32601, "message": "Method not found"}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": frame["id"], "result": result}), flush=True)
"#;

fn python3_available() -> bool {
    std::process::Command::new("python3")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn caller_scope_from(result: &Value) -> Value {
    let text = result["content"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("echo result: {result}"));
    serde_json::from_str(text).unwrap()
}

#[tokio::test]
async fn plugin_stdio_mcp_calls_carry_the_server_derived_caller_scope() {
    if !python3_available() {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let script = temp.path().join("meta_echo.py");
    std::fs::write(&script, META_ECHO_SERVER).unwrap();
    let mut owned: McpServerConfig = serde_json::from_value(json!({
        "command": "python3",
        "args": [script.to_string_lossy()],
        "enabled": true
    }))
    .unwrap();
    owned.owner_plugin_id = Some("com.example.scoped".into());
    let unowned = McpServerConfig {
        owner_plugin_id: None,
        ..owned.clone()
    };
    let registry = McpRegistry::from_servers(BTreeMap::from([
        ("scoped".into(), owned),
        ("userconfigured".into(), unowned),
    ]));
    let runtime = crate::plugins::runtime::PluginRuntime::new();
    registry.set_plugin_runtime(runtime.clone());
    runtime
        .begin_activation("com.example.scoped")
        .await
        .commit();

    // A personal node's single principal.
    let node = registry
        .call_tool("scoped.echo", json!({}), None)
        .await
        .unwrap();
    assert_eq!(caller_scope_from(&node), json!({ "kind": "node" }));

    // A verified user: the scope comes from the dispatch principal, and a
    // model-supplied argument cannot replace it.
    let owned_call = authenticated_scope::with_principal_for_tests(
        ToolPrincipal::Owned {
            user_id: "alice".into(),
            org_id: Some("org-1".into()),
        },
        registry.call_tool(
            "scoped.echo",
            json!({ "_meta": { "ryu/caller": { "kind": "node" } } }),
            None,
        ),
    )
    .await
    .unwrap();
    assert_eq!(
        caller_scope_from(&owned_call),
        json!({ "kind": "user", "userId": "alice", "orgId": "org-1" })
    );

    // A user-configured server never receives the caller's identity.
    let unscoped = authenticated_scope::with_principal_for_tests(
        ToolPrincipal::Owned {
            user_id: "alice".into(),
            org_id: Some("org-1".into()),
        },
        registry.call_tool("userconfigured.echo", json!({}), None),
    )
    .await
    .unwrap();
    assert_eq!(caller_scope_from(&unscoped), Value::Null);
}

#[test]
fn plugin_caller_scope_marks_unresolved_principals_for_fail_closed_plugins() {
    assert_eq!(
        plugin_caller_scope_meta(&ToolPrincipal::Unresolved),
        json!({ "kind": "unresolved" })
    );
    assert_eq!(
        plugin_caller_scope_meta(&ToolPrincipal::Owned {
            user_id: "u".into(),
            org_id: None
        }),
        json!({ "kind": "user", "userId": "u", "orgId": null })
    );
    let mut remote: McpServerConfig =
        serde_json::from_value(json!({ "type": "http", "url": "https://example.com/mcp" }))
            .unwrap();
    remote.owner_plugin_id = Some("com.example.remote".into());
    assert!(!carries_plugin_caller_scope(&remote));
}

#[test]
fn cursor_identity_text_trims_and_caps_display_fields() {
    assert_eq!(
        cursor_identity_text(Some("  Codex  "), 80),
        Some("Codex".into())
    );
    assert_eq!(
        cursor_identity_text(Some(&"x".repeat(5)), 3),
        Some("xxx".into())
    );
    assert_eq!(cursor_identity_text(Some("  "), 80), None);
    assert_eq!(cursor_identity_text(None, 80), None);
}
