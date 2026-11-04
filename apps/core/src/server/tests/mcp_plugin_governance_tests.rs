use crate::server::*;

fn stdio_plan(server_name: &str) -> crate::mcp_catalog::InstallPlan {
    crate::mcp_catalog::InstallPlan {
        server_name: server_name.to_owned(),
        entry: crate::mcp_catalog::McpEntryPlan::Stdio {
            command: "npx".to_owned(),
            args: vec!["-y".to_owned(), "some-mcp".to_owned()],
        },
        description: Some("A test MCP server".to_owned()),
        version: None,
        catalog_id: "some-mcp".to_owned(),
    }
}

#[test]
fn catalog_remote_plans_use_native_http_without_a_package_runner() {
    let resolved = resolved_mcp_entry(&crate::mcp_catalog::McpEntryPlan::Remote {
        url: "https://mcp.example.com/mcp".to_owned(),
    });
    assert_eq!(resolved.command, None);
    assert!(resolved.args.is_empty());
    assert_eq!(resolved.transport.as_deref(), Some("streamable-http"));
    assert_eq!(resolved.url.as_deref(), Some("https://mcp.example.com/mcp"));
}

#[test]
fn catalog_stdio_plans_keep_the_verified_runner() {
    let resolved = resolved_mcp_entry(&crate::mcp_catalog::McpEntryPlan::Stdio {
        command: "npx".to_owned(),
        args: vec!["-y".to_owned(), "@acme/server@1.2.3".to_owned()],
    });
    assert_eq!(resolved.command.as_deref(), Some("npx"));
    assert_eq!(resolved.args, vec!["-y", "@acme/server@1.2.3"]);
    assert_eq!(resolved.transport.as_deref(), Some("stdio"));
    assert_eq!(resolved.url, None);
}

#[test]
fn synthesize_mcp_manifest_is_governance_only_and_grants_widget_render() {
    let m = synthesize_mcp_manifest(&stdio_plan("brave-search")).expect("valid id");
    assert_eq!(m.id, "brave-search");
    // The plugin id == the server name (external tools are `server.tool`).
    assert_eq!(m.version, "0.0.0", "absent/non-semver version falls back");
    assert!(
        m.runnables.is_empty(),
        "record is governance-only — declaring runnables would double-list the server's tools"
    );
    assert!(
        m.permission_grants
            .iter()
            .any(|g| g == crate::sidecar::mcp::WIDGET_RENDER_GRANT),
        "the MCP record must hold widget:render so its widgets can promote once recorded"
    );
}

#[test]
fn synthesize_mcp_manifest_rejects_invalid_plugin_id() {
    // A server name that is not a valid plugin id yields no record (the caller
    // then skips it, best-effort; the mcp.json entry still works).
    assert!(synthesize_mcp_manifest(&stdio_plan("bad/name@x")).is_none());
}

#[tokio::test]
async fn installed_mcp_server_gets_a_disabled_record_that_uninstall_governs() {
    // Piece 2: the synthesized manifest flows through the SAME plugin lifecycle
    // as any plugin — install (DISABLED), then uninstall removes it.
    let manifest = synthesize_mcp_manifest(&stdio_plan("brave-search")).expect("valid id");
    let store = crate::plugins::PluginStore::open_in_memory().expect("store");

    crate::plugins::lifecycle::install_app(&store, &manifest)
        .await
        .expect("install record");
    let rec = store
        .get("brave-search")
        .await
        .expect("get")
        .expect("record exists");
    assert!(!rec.enabled, "an installed MCP server record is DISABLED");

    // The plugin lifecycle governs it: uninstall removes the record.
    crate::plugins::lifecycle::uninstall_app(&store, "brave-search", &[manifest.clone()], false)
        .await
        .expect("uninstall");
    assert!(
        store.get("brave-search").await.expect("get").is_none(),
        "uninstall (a plugin-lifecycle op) removed the MCP server's record"
    );
}

fn mcp_json_with(entries: &[(&str, bool)]) -> String {
    let map: serde_json::Map<String, serde_json::Value> = entries
        .iter()
        .map(|(name, enabled)| {
            (
                (*name).to_owned(),
                serde_json::json!({
                    "command": "npx",
                    "args": ["-y", "some-mcp"],
                    "enabled": enabled,
                }),
            )
        })
        .collect();
    serde_json::to_string_pretty(&serde_json::json!({ "mcpServers": map })).unwrap()
}

fn read_mcp_enabled(path: &std::path::Path) -> std::collections::BTreeMap<String, bool> {
    let raw = std::fs::read_to_string(path).unwrap();
    let val: serde_json::Value = serde_json::from_str(&raw).unwrap();
    val.get("mcpServers")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        v.get("enabled")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(true),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn mutate_mcp_entry_set_enabled_flips_only_the_target() {
    // Fix 1 / enable-disable sync: flipping one entry's `enabled` flag (the flag
    // that actually gates spawn) leaves every other entry untouched.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mcp.json");
    std::fs::write(
        &path,
        mcp_json_with(&[("brave-search", false), ("other", true)]),
    )
    .unwrap();

    let changed = mutate_mcp_entry(
        path.clone(),
        "brave-search",
        McpEntryMutation::SetEnabled(true),
    )
    .await
    .unwrap();
    assert!(
        changed,
        "flipping a disabled entry to enabled changes the file"
    );

    let state = read_mcp_enabled(&path);
    assert_eq!(state.get("brave-search"), Some(&true), "target now enabled");
    assert_eq!(state.get("other"), Some(&true), "sibling untouched");

    // Idempotent: a second SetEnabled(true) is a no-op.
    let again = mutate_mcp_entry(
        path.clone(),
        "brave-search",
        McpEntryMutation::SetEnabled(true),
    )
    .await
    .unwrap();
    assert!(!again, "setting to the current state is a no-op");
}

#[tokio::test]
async fn mutate_mcp_entry_remove_drops_only_the_target() {
    // Fix 1 / uninstall sync: removing a synth MCP-server record drops its
    // mcp.json entry (so the server actually stops) while siblings survive.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mcp.json");
    std::fs::write(
        &path,
        mcp_json_with(&[("brave-search", true), ("other", true)]),
    )
    .unwrap();

    let changed = mutate_mcp_entry(path.clone(), "brave-search", McpEntryMutation::Remove)
        .await
        .unwrap();
    assert!(changed, "removing a present entry changes the file");

    let state = read_mcp_enabled(&path);
    assert!(!state.contains_key("brave-search"), "target entry removed");
    assert!(state.contains_key("other"), "sibling survives the removal");
}

#[tokio::test]
async fn mutate_mcp_entry_absent_target_is_noop() {
    // A missing entry (or missing file) is a benign no-op, never an error —
    // so the best-effort lifecycle sync never fails an enable/disable/uninstall.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mcp.json");
    std::fs::write(&path, mcp_json_with(&[("other", true)])).unwrap();
    assert!(
        !mutate_mcp_entry(path.clone(), "ghost-server", McpEntryMutation::Remove)
            .await
            .unwrap()
    );

    let missing = dir.path().join("does-not-exist.json");
    assert!(
        !mutate_mcp_entry(missing, "x", McpEntryMutation::SetEnabled(false))
            .await
            .unwrap(),
        "a missing mcp.json is a no-op, not an error"
    );
}
