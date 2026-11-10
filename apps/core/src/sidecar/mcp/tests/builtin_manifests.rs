//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;
use crate::sidecar::mcp::tests::{lock_mcp_env, register_as_enabled, GhostBinPresent};

/// Ghost moved from a hardcoded `builtin_servers()` entry to its plugin
/// manifest's `mcp_servers` (fixtures/ghost.manifest.json). Installing/activating
/// the plugin registers the MCP server via `register_manifest_mcp_servers`, and
/// its `command_env` (RYU_GHOST_BIN) resolves the bare `ghost` command to the
/// absolute `~/.ryu/bin/ghost` path at lowering time. This is the task's
/// "installing the plugin registers the MCP" verification.
#[test]
fn ghost_manifest_registers_with_mcp_subcommand() {
    // RYU_GHOST_BIN (the profile-scoped path Core seeds in main.rs) overrides
    // the bare `ghost` command at lowering time. It has to point at a file that
    // EXISTS: registration probes the lowered command, so an override at a
    // made-up path is skipped — see [`GhostBinPresent`].
    let ghost = GhostBinPresent::new();
    let ghost_manifest = GhostBinPresent::manifest();

    let reg = McpRegistry::empty();
    let names = register_as_enabled(&reg, &ghost_manifest, &[]);

    assert_eq!(names, vec![GHOST_SERVER.to_owned()]);
    let servers = reg.servers.read().expect("lock");
    let entry = servers
        .get(GHOST_SERVER)
        .expect("ghost registered from manifest");
    assert_eq!(entry.args, vec!["mcp".to_owned()]);
    assert!(entry.enabled);
    assert_eq!(
        entry.command.as_deref(),
        Some(ghost.program().as_str()),
        "RYU_GHOST_BIN must override the bare `ghost` command"
    );
}

/// The other half of the same seam: with NO usable `ghost` binary — the state
/// every stock node is actually in — the declaration is skipped rather than
/// registered, so the model is never offered ~29 `ghost.*` tools that ENOENT.
#[test]
fn ghost_manifest_is_skipped_when_no_ghost_binary_exists() {
    let _lock = lock_mcp_env();
    let previous = std::env::var("RYU_GHOST_BIN").ok();
    // An override at a path that does not exist must NOT rescue it — the probe
    // asks the filesystem, not the env var.
    std::env::set_var(
        "RYU_GHOST_BIN",
        std::env::temp_dir().join(format!("ryu-absent-ghost-{}", uuid::Uuid::new_v4())),
    );

    let reg = McpRegistry::empty();
    let names = register_as_enabled(&reg, &GhostBinPresent::manifest(), &[]);

    match previous {
        Some(prev) => std::env::set_var("RYU_GHOST_BIN", prev),
        None => std::env::remove_var("RYU_GHOST_BIN"),
    }

    assert!(
        names.is_empty(),
        "ghost must not register without a binary, got {names:?}"
    );
    assert!(!reg.contains_server(GHOST_SERVER));
}

/// Agent Browser also moved from `builtin_servers()` to its plugin manifest's
/// `mcp_servers` (fixtures/agentbrowser.manifest.json). Activating the plugin
/// registers the `npx agent-browser mcp` stdio server.
///
/// The package name is asserted EXACTLY because it was wrong: the manifest
/// launched `agentbrowser`, which 404s on npm, so this provider could never
/// start and served zero verbs. The real package is `agent-browser` and its
/// MCP mode is the `mcp` subcommand.
#[test]
fn agentbrowser_manifest_registers_via_npx() {
    let manifest = crate::plugin_manifest::PluginManifestLoader::load_builtins()
        .into_iter()
        .find(|m| m.id == "@ryu/agentbrowser")
        .expect("agentbrowser built-in manifest present");
    // The lowering is asserted probe-free, so the shape is pinned on every host:
    // the command is the RUNNER (`npx`) and the package rides in the args. That is
    // exactly why registration's binary probe reads `command` verbatim — probing
    // `agent-browser`, which is fetched lazily on first spawn, would refuse every
    // lazy-package-runner declaration there is.
    let decl = manifest
        .mcp_servers
        .get(AGENTBROWSER_SERVER)
        .expect("agentbrowser declares its MCP server");
    let lowered = mcp_server_config_from_decl(decl);
    assert_eq!(lowered.command.as_deref(), Some("npx"));
    assert_eq!(
        lowered.args,
        vec![
            "-y".to_owned(),
            "agent-browser@0.34.0".to_owned(),
            "mcp".to_owned(),
            "--tools".to_owned(),
            "all".to_owned()
        ]
    );
    assert!(lowered.enabled);

    // And it registers wherever `npx` is actually installed. Asserted as an
    // implication rather than unconditionally: a host with no node toolchain
    // SHOULD skip it (an `npx` that is not there cannot fetch anything either),
    // and this test is about the manifest, not about the runner being present.
    let reg = McpRegistry::empty();
    let names = register_as_enabled(&reg, &manifest, &[]);
    if mcp_command_is_present("npx") {
        assert_eq!(names, vec![AGENTBROWSER_SERVER.to_owned()]);
        assert!(reg.contains_server(AGENTBROWSER_SERVER));
    } else {
        assert!(
            names.is_empty(),
            "with no `npx` on PATH the declaration must be skipped, got {names:?}"
        );
    }
}

#[test]
fn builtin_tools_are_always_listed_even_with_no_config() {
    let reg = McpRegistry::empty();
    // `list_all_tools` is async but built-in tools are produced synchronously
    // (no I/O for listing); verify each provider surface directly.
    let web_fetch_tools = web_fetch::tools();
    assert!(!web_fetch_tools.is_empty());
    assert!(web_fetch_tools
        .iter()
        .all(|t| t.server == web_fetch::SERVER_NAME));

    // The built-in servers are always summarized.
    let summaries = reg.server_summaries();
    assert!(summaries.iter().any(|s| s.name == web_fetch::SERVER_NAME));
    // web_fetch is recognized as a built-in server (allowlist/catalog).
    assert!(reg.contains_server(web_fetch::SERVER_NAME));
}

#[test]
fn contains_server_includes_builtin_and_ghost() {
    let reg = McpRegistry::empty();
    // `web_fetch` is a special built-in not in `servers` (reserved by name).
    assert!(reg.contains_server(web_fetch::SERVER_NAME));
    // empty() has no ghost, so it should not be found.
    assert!(!reg.contains_server(GHOST_SERVER));
    // Ghost now arrives via its plugin manifest's `mcp_servers` (the activation
    // seam), not `builtin_servers()`. The guard is what makes its declared
    // command resolvable — registration probes it.
    let _ghost = GhostBinPresent::new();
    register_as_enabled(&reg, &GhostBinPresent::manifest(), &[]);
    assert!(reg.contains_server(GHOST_SERVER));
    // The reserved `device` server (paired-hardware capabilities) is reserved by
    // name, so no plugin can shadow it, and it appears in the server summaries.
    assert!(reg.contains_server(device_tool::SERVER_NAME));
    assert!(reg
        .server_summaries()
        .iter()
        .any(|summary| summary.name == device_tool::SERVER_NAME));
}
