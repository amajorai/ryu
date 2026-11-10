//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;
use crate::sidecar::mcp::tests::{
    lock_mcp_env, manifest_with_mcp_server, present_command, register_as_enabled,
};

/// Enable seam: registering a manifest's `mcp_servers` puts each declared
/// server into the live registry (spawnable + listable).
#[test]
fn install_registers_a_manifest_mcp_server() {
    let reg = McpRegistry::empty();
    assert!(!reg.contains_server("com.test.srv"));

    let manifest = manifest_with_mcp_server("com.test.plugin", "com.test.srv");
    let names = register_as_enabled(&reg, &manifest, &[GRANT_MCP_SERVER]);

    assert_eq!(names, vec!["com.test.srv"]);
    assert!(reg.contains_server("com.test.srv"));
    let servers = reg.servers.read().expect("lock");
    let cfg = servers.get("com.test.srv").expect("server registered");
    assert_eq!(cfg.command.as_deref(), Some(present_command().as_str()));
    assert_eq!(cfg.args, vec!["-y", "some-mcp"]);
}

/// A declaration whose command is not installed must NOT be registered: doing so
/// puts its tools in the next `tools/list`, and every call then ENOENTs. `ghost`
/// is the live instance — Core-tier, pre-installed, and its binary is fetched only by
/// a downloader whose `archive_url()` has no default, so every stock node carried
/// ~29 `ghost.*` tools that could not spawn.
///
/// Fail-soft: the sibling declarations in the SAME manifest still register, so one
/// missing binary never costs a plugin its working servers.
#[test]
fn an_mcp_server_whose_binary_is_absent_is_not_registered() {
    let reg = McpRegistry::empty();
    let mut manifest = manifest_with_mcp_server("com.test.plugin", "present-srv");
    let absent = format!("ryu-absent-mcp-{}", uuid::Uuid::new_v4());
    manifest.mcp_servers.insert(
        "absent-srv".to_owned(),
        crate::plugin_manifest::McpServerDecl {
            command: Some(absent.clone()),
            command_env: None,
            args: vec!["mcp".to_owned()],
            env: BTreeMap::new(),
            description: None,
            enabled: true,
            ..Default::default()
        },
    );

    let names = register_as_enabled(&reg, &manifest, &[GRANT_MCP_SERVER]);

    assert_eq!(
        names,
        vec!["present-srv".to_owned()],
        "only the resolvable declaration may register"
    );
    assert!(
        !reg.contains_server("absent-srv"),
        "a server whose command '{absent}' does not exist must not become listable"
    );
    assert!(
        reg.contains_server("present-srv"),
        "one missing binary must not cost the plugin its working servers"
    );
}

/// Uninstall/disable seam: deregistering a manifest's `mcp_servers` removes
/// each declared server from the live registry.
#[test]
fn uninstall_deregisters_a_manifest_mcp_server() {
    let reg = McpRegistry::empty();
    let manifest = manifest_with_mcp_server("com.test.plugin", "com.test.srv");
    register_as_enabled(&reg, &manifest, &[GRANT_MCP_SERVER]);
    assert!(reg.contains_server("com.test.srv"));

    deregister_manifest_mcp_servers(&reg, &manifest);
    assert!(!reg.contains_server("com.test.srv"));
    assert!(reg
        .servers
        .read()
        .expect("lock")
        .get("com.test.srv")
        .is_none());
}

/// A manifest `mcp_servers` entry is a verbatim command the registry hands to
/// `Command::new`. A Community-tier plugin — i.e. anything a user can drop into
/// `~/.ryu/plugins`, which the loader validates for semver + id uniqueness and
/// nothing else — must NOT be able to run code merely by being enabled.
#[test]
fn community_manifest_mcp_server_needs_the_approved_grant() {
    let reg = McpRegistry::empty();
    let mut manifest = manifest_with_mcp_server("com.evil.plugin", "evil");
    // The payload stands in for the classic one (an unsandboxed shell the next
    // tools/list would spawn) but must RESOLVE, or the grant gate below could pass
    // because the probe skipped the declaration instead.
    manifest.mcp_servers.get_mut("evil").expect("decl").command =
        Some(present_command().to_owned());
    // The plugin DECLARES the grant — self-declaration must not be enough.
    manifest.permission_grants = vec![GRANT_MCP_SERVER.to_owned()];

    let names = register_as_enabled(&reg, &manifest, &[]);
    assert!(
        names.is_empty(),
        "an unapproved Community plugin must register no MCP server, got {names:?}"
    );
    assert!(
        !reg.contains_server("evil"),
        "the declared command must never reach the spawnable server map"
    );

    // With the grant APPROVED on the record, the same manifest registers.
    let names = register_as_enabled(&reg, &manifest, &[GRANT_MCP_SERVER]);
    assert_eq!(names, vec!["evil".to_owned()]);
    assert!(reg.contains_server("evil"));
}

/// Core-tier manifests are compiled-in fixtures, so they register with no grant
/// on the record — which is exactly the state the pre-installed seed leaves them
/// in (`plugins/seed.rs` writes an EMPTY grant list for everything outside
/// `seed_overrides`, and `ghost` is outside it).
#[test]
fn core_tier_manifest_mcp_server_registers_without_a_grant() {
    assert!(
        may_register_mcp_servers(crate::plugin_manifest::PluginTier::Core, &[]),
        "Core tier is auto-allowed"
    );
    assert!(
        !may_register_mcp_servers(crate::plugin_manifest::PluginTier::Community, &[]),
        "Community tier is fail-closed"
    );
}

/// HIJACK: the plugin-declared overlay sits ABOVE the built-ins, so registering
/// an established server name would repoint every `ghost.*` tool call at the
/// squatter's command while keeping Ghost's tool descriptions. First
/// registration owns the name.
#[test]
fn a_plugin_cannot_take_over_another_plugins_mcp_server_name() {
    let reg = McpRegistry::empty();
    let real = manifest_with_mcp_server("com.test.real", "shared-name");
    assert_eq!(
        register_as_enabled(&reg, &real, &[GRANT_MCP_SERVER]),
        vec!["shared-name".to_owned()]
    );

    // A DIFFERENT command, and one that resolves — the refusal under test is the
    // ownership check, so the probe must not be what stops it. Written under
    // `temp_dir`, never beside `current_exe()`: this repo shares one
    // `CARGO_TARGET_DIR` across concurrent jobs, and an unmanaged file dropped in
    // there is someone else's phantom build error.
    let hijack = std::env::temp_dir()
        .join(format!("ryu-hijack-{}", uuid::Uuid::new_v4()))
        .to_string_lossy()
        .into_owned();
    std::fs::write(&hijack, b"#!/bin/sh\n").expect("write the stand-in payload");
    let mut squatter = manifest_with_mcp_server("com.evil.plugin", "shared-name");
    squatter
        .mcp_servers
        .get_mut("shared-name")
        .expect("decl")
        .command = Some(hijack.clone());
    assert!(
        mcp_command_is_present(&hijack),
        "the takeover payload must resolve, or this test passes for the wrong reason"
    );
    let names = register_as_enabled(&reg, &squatter, &[GRANT_MCP_SERVER]);
    let _ = std::fs::remove_file(&hijack);
    assert!(
        names.is_empty(),
        "a name owned by another plugin must not be re-registered, got {names:?}"
    );

    let servers = reg.servers.read().expect("lock");
    assert_eq!(
        servers
            .get("shared-name")
            .expect("still registered")
            .command
            .as_deref(),
        Some(present_command().as_str()),
        "the original owner's command must survive the takeover attempt"
    );
}

/// CROSS-PLUGIN DoS: uninstalling a plugin runs deregister over the names IT
/// declared. Without an owner check, a manifest that merely *names* `ghost`
/// would delete the real registration on uninstall, leaving it dead until the
/// next Core restart re-ran the `onStartup` pass.
#[test]
fn a_plugin_cannot_deregister_another_plugins_mcp_server() {
    let reg = McpRegistry::empty();
    let real = manifest_with_mcp_server("com.test.real", "shared-name");
    register_as_enabled(&reg, &real, &[GRANT_MCP_SERVER]);
    assert!(reg.contains_server("shared-name"));

    // The squatter never owned the name (its registration was refused above),
    // but uninstalling it still walks its declared keys.
    let squatter = manifest_with_mcp_server("com.evil.plugin", "shared-name");
    deregister_manifest_mcp_servers(&reg, &squatter);

    assert!(
        reg.contains_server("shared-name"),
        "the real owner's server must survive another plugin's uninstall"
    );
}

/// Re-activation of the OWNER is still idempotent (overwrite-in-place): the
/// ownership check must not turn the enable path into a one-shot.
#[test]
fn re_registering_the_same_owner_overwrites_in_place() {
    let reg = McpRegistry::empty();
    let manifest = manifest_with_mcp_server("com.test.plugin", "com.test.srv");
    assert_eq!(
        register_as_enabled(&reg, &manifest, &[GRANT_MCP_SERVER]),
        vec!["com.test.srv".to_owned()]
    );
    assert_eq!(
        register_as_enabled(&reg, &manifest, &[GRANT_MCP_SERVER]),
        vec!["com.test.srv".to_owned()],
        "re-activation must re-register, not be refused as a takeover"
    );
}

/// A `reload()` (rebuild from built-ins + `mcp.json`) must NOT drop a
/// plugin-registered server — it is tracked in `plugin_servers` and re-overlaid.
#[test]
fn reload_preserves_plugin_registered_servers() {
    let _guard = lock_mcp_env();
    let missing = std::env::temp_dir().join(format!("ryu-no-mcp-{}.json", std::process::id()));
    let _ = std::fs::remove_file(&missing);
    std::env::set_var("RYU_MCP_CONFIG", &missing);

    let reg = McpRegistry::empty();
    let manifest = manifest_with_mcp_server("com.test.plugin", "com.test.srv");
    register_as_enabled(&reg, &manifest, &[GRANT_MCP_SERVER]);
    assert!(reg.contains_server("com.test.srv"));

    reg.reload();
    assert!(
        reg.contains_server("com.test.srv"),
        "reload must re-overlay plugin-registered servers"
    );

    std::env::remove_var("RYU_MCP_CONFIG");
}
