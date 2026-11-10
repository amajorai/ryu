//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;
use crate::sidecar::mcp::tests::{lock_mcp_env, uuid_simple};

#[test]
fn stdio_target_carries_the_runtime_cwd() {
    let dir = std::path::PathBuf::from("/plugins/@ryu+pomodoro");
    let cfg = McpServerConfig {
        command: Some("node".to_owned()),
        args: vec!["server.mjs".to_owned()],
        cwd: Some(dir.clone()),
        ..McpServerConfig::default()
    };
    let McpTarget::Stdio(cmd) = cfg.to_target().expect("stdio target") else {
        panic!("a command entry lowers to a stdio target");
    };
    assert_eq!(cmd.cwd, Some(dir));
    assert!(
        !serde_json::to_string(&cfg)
            .expect("serialize")
            .contains("cwd"),
        "the runtime cwd is never written to mcp.json"
    );
}

// ── plugin-declared mcp_servers registration ───────────────────────────────

/// `command_env`, when set to a non-empty value, overrides the bare `command`.
#[test]
fn command_env_overrides_command_when_set() {
    std::env::set_var("RYU_TEST_MCP_BIN", "/opt/ryu/bin/thing");
    let decl = crate::plugin_manifest::McpServerDecl {
        command: Some("thing".to_owned()),
        command_env: Some("RYU_TEST_MCP_BIN".to_owned()),
        args: Vec::new(),
        env: BTreeMap::new(),
        description: None,
        enabled: true,
        ..Default::default()
    };
    let cfg = mcp_server_config_from_decl(&decl);
    assert_eq!(cfg.command.as_deref(), Some("/opt/ryu/bin/thing"));
    std::env::remove_var("RYU_TEST_MCP_BIN");

    // Unset env var ⇒ fall back to the bare command.
    let cfg2 = mcp_server_config_from_decl(&decl);
    assert_eq!(cfg2.command.as_deref(), Some("thing"));
}

#[test]
fn load_survives_missing_config() {
    let _lock = lock_mcp_env();
    // Point at a path that cannot exist so `load()` takes the NotFound arm.
    let missing = std::env::temp_dir().join("ryu-mcp-does-not-exist-u14.json");
    let _ = std::fs::remove_file(&missing);
    std::env::set_var("RYU_MCP_CONFIG", &missing);
    let reg = McpRegistry::load();
    std::env::remove_var("RYU_MCP_CONFIG");
    // `builtin_servers()` is now empty — ghost/agentbrowser moved to their
    // plugin manifests and are added later by the activation seam — so a
    // missing config yields no hardcoded stdio servers. The always-present
    // built-in providers (web_fetch, …) still resolve.
    assert!(
        reg.servers.read().expect("lock").is_empty(),
        "no hardcoded built-in stdio servers remain"
    );
    assert!(reg.contains_server(web_fetch::SERVER_NAME));
}

#[test]
fn availability_probes_paths_only() {
    // A bare command (PATH-resolved) is unknown.
    assert_eq!(command_availability("npx"), None);
    // A path-like command is probed; a guaranteed-missing path is false.
    let missing = if cfg!(windows) {
        "C:\\ryu-u14-nope\\ghost.exe"
    } else {
        "/ryu-u14-nope/ghost"
    };
    assert_eq!(command_availability(missing), Some(false));
}

#[test]
fn config_parses_mcp_servers_map() {
    let json = r#"{
            "mcpServers": {
                "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
                "git": { "command": "uvx", "args": ["mcp-server-git"], "enabled": false }
            }
        }"#;
    let file: McpConfigFile = serde_json::from_str(json).unwrap();
    let servers = file.servers(Path::new("mcp.json"));
    assert_eq!(servers.len(), 2);
    assert!(servers["fs"].enabled);
    assert!(!servers["git"].enabled);
    let reg = McpRegistry::from_servers(servers);
    assert_eq!(reg.len(), 2);
    // Every authored server survives the built-in projection exactly once,
    // without freezing an unrelated catalog size as new built-ins ship.
    let summaries = reg.server_summaries();
    let builtins = McpRegistry::empty().server_summaries();
    assert_eq!(summaries.len(), builtins.len() + 2);
    let unique = summaries
        .iter()
        .map(|summary| &summary.name)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(unique.len(), summaries.len(), "duplicate server projection");
    let fs = summaries
        .iter()
        .find(|summary| summary.name == "fs")
        .unwrap();
    assert_eq!(fs.command, "npx");
    assert_eq!(
        fs.args,
        ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    );
    assert!(fs.enabled);
    let git = summaries
        .iter()
        .find(|summary| summary.name == "git")
        .unwrap();
    assert_eq!(git.command, "uvx");
    assert_eq!(git.args, ["mcp-server-git"]);
    assert!(!git.enabled);
    assert!(summaries.iter().any(|s| s.name == cloud::SERVER_NAME));
    assert!(reg.contains_server(cloud::SERVER_NAME));
    assert!(summaries
        .iter()
        .any(|s| s.name == workspace_tool::SERVER_NAME));
    assert!(summaries
        .iter()
        .any(|s| s.name == routines_tool::SERVER_NAME));
    assert!(summaries
        .iter()
        .any(|s| s.name == challenges_tool::SERVER_NAME));
    assert!(reg.contains_server(challenges_tool::SERVER_NAME));
    assert!(
        !summaries.iter().any(|s| s.name == "research"),
        "`research` is no longer a hardcoded built-in — it registers (or does \
         not) through the generic plugin-server path"
    );
    for facade in capability_tools::SERVERS {
        assert!(
            summaries.iter().any(|s| &s.name == facade),
            "facade server '{facade}' must be listed"
        );
    }
    assert!(!summaries.iter().any(|s| s.name == "@ryu/shadow"));
    assert!(summaries.iter().any(|s| s.name == sandbox::SERVER_NAME));
    assert!(summaries
        .iter()
        .any(|s| s.name == search_conversations::SERVER_NAME));
}

/// The regression this file's per-entry parse exists for: a Claude-Desktop
/// remote entry (`{"type":"http","url":…}`, no `command`) pasted next to a
/// normal stdio server used to fail the whole-map deserialize, and every
/// caller's error arm is a `warn!` + fall through — so the user's entire
/// server list silently disappeared.
#[test]
fn mcp_config_with_one_bad_entry_keeps_the_others() {
    // The bad entry is a genuinely malformed one (`args` must be an array).
    // It used to be `{"type":"http","url":…}` — the shape that motivated the
    // per-entry split — but that entry now PARSES, so keeping it here would
    // have quietly turned this test into a tautology asserting nothing. The
    // invariant under test is unchanged and independent of which dialects we
    // understand: an entry we cannot parse costs the user that ONE entry,
    // never the file.
    let json = r#"{
            "mcpServers": {
                "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
                "broken": { "command": "npx", "args": "not-an-array" }
            }
        }"#;
    let file: McpConfigFile = serde_json::from_str(json).expect("file itself must still parse");
    assert_eq!(
        file.raw_servers.len(),
        2,
        "both entries survive the raw file-level parse"
    );

    let servers = file.servers(Path::new("mcp.json"));
    assert_eq!(
        servers.len(),
        1,
        "the unparseable entry costs itself, not the file"
    );
    assert_eq!(servers["fs"].command.as_deref(), Some("npx"));
    assert!(
        !servers.contains_key("broken"),
        "the unparseable entry is the one that is dropped"
    );
}

/// The entry shape a user pastes out of Claude Desktop / Cursor now parses
/// AND lowers to a live HTTP target — `command` optional, `type`/`url`/
/// `headers` understood, auth carried as a request header rather than being
/// silently dropped into `env`.
///
/// This is the other half of [`mcp_config_with_one_bad_entry_keeps_the_others`]:
/// that test proves an entry we do not understand is survivable; this one
/// proves this particular entry is no longer in that category.
#[test]
fn remote_entry_parses_from_claude_desktop_shape() {
    let json = r#"{
            "mcpServers": {
                "hosted": {
                    "type": "http",
                    "url": "https://mcp.example.com/mcp",
                    "headers": { "Authorization": "Bearer sk-test" }
                }
            }
        }"#;
    let file: McpConfigFile = serde_json::from_str(json).expect("file must parse");
    let servers = file.servers(Path::new("mcp.json"));

    let cfg = servers.get("hosted").expect("the remote entry must parse");
    assert!(cfg.command.is_none(), "a remote entry declares no command");
    assert_eq!(cfg.url.as_deref(), Some("https://mcp.example.com/mcp"));
    assert_eq!(
        cfg.headers.get("Authorization").map(String::as_str),
        Some("Bearer sk-test"),
        "auth must land in `headers`, not be dropped or rerouted to `env`"
    );
    assert_eq!(cfg.transport_kind(), McpTransportKind::Http);
    assert!(cfg.enabled, "`enabled` still defaults to true");

    // It must also be *reachable*, not merely parseable: the presence probe
    // and the availability report are what decide whether registration keeps
    // it, and both used to answer "absent" for a server with no command.
    assert!(
        mcp_server_is_present(cfg),
        "a remote entry with a url must probe as present"
    );
    assert_eq!(config_availability(cfg), Some(true));

    let McpTarget::Http(endpoint) = cfg.to_target().expect("lowers to a target") else {
        panic!("a `type: http` entry must lower to the HTTP transport");
    };
    assert_eq!(endpoint.url, "https://mcp.example.com/mcp");
    assert_eq!(
        endpoint.headers.get("Authorization").map(String::as_str),
        Some("Bearer sk-test"),
        "the headers must reach the transport, or the call is unauthenticated"
    );
}

/// The predecessor spellings resolve to the same transport, and an entry with
/// a `url` but no `type` is inferred rather than treated as stdio (which would
/// try to spawn a process named after nothing).
#[test]
fn remote_transport_aliases_and_inference() {
    for declared in [
        Some("http"),
        Some("streamable-http"),
        // The legacy transport stays distinct so the client can open its GET
        // event stream and use the announced POST endpoint.
        Some("sse"),
        // Unrecognized: falls through to shape inference, which sees the url.
        Some("htp"),
        None,
    ] {
        let cfg = McpServerConfig {
            transport: declared.map(str::to_owned),
            url: Some("https://mcp.example.com/mcp".to_owned()),
            ..Default::default()
        };
        let expected = if declared == Some("sse") {
            McpTransportKind::Sse
        } else {
            McpTransportKind::Http
        };
        assert_eq!(cfg.transport_kind(), expected);
    }

    // An explicit `stdio` wins over an incidental url, and a bare command is
    // still stdio.
    let stdio = McpServerConfig {
        command: Some("npx".to_owned()),
        ..Default::default()
    };
    assert_eq!(stdio.transport_kind(), McpTransportKind::Stdio);

    // Neither half filled in is a stdio entry with nothing to spawn: it must
    // fail at lowering, not silently produce an empty-program spawn.
    let empty = McpServerConfig::default();
    assert!(empty.to_target().is_err());
}

#[test]
fn lowers_streamable_http_and_legacy_sse_to_distinct_targets() {
    let streamable = McpServerConfig {
        transport: Some("streamable-http".to_owned()),
        url: Some("https://mcp.example.com/mcp".to_owned()),
        ..Default::default()
    };
    assert!(matches!(
        streamable.to_target().expect("streamable target"),
        McpTarget::Http(_)
    ));

    let legacy = McpServerConfig {
        transport: Some("sse".to_owned()),
        url: Some("https://mcp.example.com/sse".to_owned()),
        ..Default::default()
    };
    assert!(matches!(
        legacy.to_target().expect("legacy SSE target"),
        McpTarget::Sse(_)
    ));
}

/// Happy-path guard: the per-entry loop must not become a filter that quietly
/// drops fields (or entries) a single deserialize used to carry through.
#[test]
fn mcp_config_all_valid_entries_still_parse() {
    let json = r#"{
            "mcpServers": {
                "fs": { "command": "npx", "args": ["-y", "server-filesystem"], "description": "files" },
                "git": { "command": "uvx", "args": ["mcp-server-git"], "enabled": false, "catalog_id": "io.github.git" }
            }
        }"#;
    let file: McpConfigFile = serde_json::from_str(json).expect("file itself must still parse");
    let servers = file.servers(Path::new("mcp.json"));

    assert_eq!(servers.len(), 2);
    assert_eq!(servers["fs"].args, vec!["-y", "server-filesystem"]);
    assert_eq!(servers["fs"].description.as_deref(), Some("files"));
    assert!(servers["fs"].enabled, "`enabled` still defaults to true");
    assert!(!servers["git"].enabled);
    assert_eq!(servers["git"].catalog_id.as_deref(), Some("io.github.git"));
}

#[test]
fn reload_picks_up_written_entry() {
    use std::io::Write as _;

    let _lock = lock_mcp_env();
    // Write a temp mcp.json with one user server.
    let dir = std::env::temp_dir().join(format!("ryu-mcp-reload-test-{}", uuid_simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let cfg_path = dir.join("mcp.json");
    let json = r#"{"mcpServers":{"testserver":{"command":"npx","args":[]}}}"#;
    let mut f = std::fs::File::create(&cfg_path).unwrap();
    f.write_all(json.as_bytes()).unwrap();

    std::env::set_var("RYU_MCP_CONFIG", &cfg_path);
    let reg = McpRegistry::load();
    std::env::remove_var("RYU_MCP_CONFIG");

    assert!(
        reg.servers.read().expect("lock").contains_key("testserver"),
        "initial load must include testserver"
    );

    // Now update the file with a second entry and reload.
    let json2 = r#"{"mcpServers":{"testserver":{"command":"npx","args":[]},"testserver2":{"command":"uvx","args":[]}}}"#;
    std::fs::write(&cfg_path, json2).unwrap();

    std::env::set_var("RYU_MCP_CONFIG", &cfg_path);
    reg.reload();
    std::env::remove_var("RYU_MCP_CONFIG");

    assert!(
        reg.servers
            .read()
            .expect("lock")
            .contains_key("testserver2"),
        "reload must pick up new testserver2 entry"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
