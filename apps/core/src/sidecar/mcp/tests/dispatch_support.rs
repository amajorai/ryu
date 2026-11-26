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

/// A Community-tier plugin (not a compiled or verified official manifest) with
/// one `inline_js` tool, the given approved grants, and a manifest `permissions`
/// block that asks for child processes and names host programs in `run`.
async fn community_plugin_with_run(grants: &[&str], run: &[&str]) -> McpRegistry {
    let plugin_id = "com.test.vg4-runner";
    let store = std::sync::Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    store.insert(plugin_id, "1.0.0").await.unwrap();
    let approved: Vec<String> = grants.iter().map(|s| s.to_string()).collect();
    store.set_enabled(plugin_id, &approved).await.unwrap();
    let manifest = crate::plugin_manifest::PluginManifest {
        id: plugin_id.to_owned(),
        name: "Runner".to_owned(),
        version: "1.0.0".to_owned(),
        runnables: vec![crate::sidecar::mcp::tests::tool_entry(
            "runner",
            json!({
                "slug": "runner",
                "backend": "inline_js",
                "code": "return await ((input, host) => ({ ok: true }))(input, host);",
            }),
        )],
        permission_grants: approved,
        permissions: Some(crate::plugin_manifest::PermissionSet {
            child_process: true,
            run: run.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }),
        companion: None,
        ..Default::default()
    };
    let manifests = std::sync::Arc::new(tokio::sync::RwLock::new(vec![manifest]));
    McpRegistry::empty().with_self_build(manifests, store)
}

/// Security sweep VG-4: holding only the allowlisted `tool:execute` grant must
/// not let a Community manifest's `permissions.run` reach the sandbox's
/// `childProcess.run` allow-list.
#[tokio::test]
async fn community_manifest_run_names_need_an_approved_command_grant() {
    let reg = community_plugin_with_run(&["tool:execute"], &["powershell", "echo"]).await;
    let resolved = reg
        .resolve_app_tool_backend("app.runner")
        .await
        .expect("enabled plugin owns app.runner");
    let permissions = resolved
        .permissions
        .expect("the permissions block itself is kept");
    assert!(
        permissions.child_process,
        "child_process stays on, so capability shims still work"
    );
    assert!(
        permissions.run.is_empty(),
        "no tool:command grant, so no host program may be allow-listed, got {:?}",
        permissions.run
    );
}

#[tokio::test]
async fn community_manifest_run_name_with_its_exact_command_grant_is_kept() {
    let reg = community_plugin_with_run(
        &["tool:execute", "tool:command:echo"],
        &["powershell", "echo"],
    )
    .await;
    let resolved = reg
        .resolve_app_tool_backend("app.runner")
        .await
        .expect("enabled plugin owns app.runner");
    let permissions = resolved.permissions.expect("permissions block kept");
    assert_eq!(
        permissions.run,
        vec!["echo".to_owned()],
        "only the name with an approved tool:command grant survives"
    );
}
