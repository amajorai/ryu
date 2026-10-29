use super::*;

// ── Pi as default-installed+enabled agent (U041) ──────────────────────────

#[test]
fn default_agent_enabled_flag_set_for_configured_id() {
    // AC2: list_infos_with_default must mark the configured agent as
    // `enabled: Some(true)` and leave all others as `None`.
    let reg = AcpAgentRegistry::new();

    // With default "acp:pi" — the Pi entry is enabled.
    let infos = reg.list_infos_with_default("acp:pi");
    let pi = infos
        .iter()
        .find(|a| a.id == "acp:pi")
        .expect("acp:pi present");
    assert_eq!(
        pi.enabled,
        Some(true),
        "acp:pi should be enabled when it is the default"
    );

    // Every other agent must NOT have enabled set.
    for info in infos.iter().filter(|a| a.id != "acp:pi") {
        assert!(
            info.enabled.is_none(),
            "agent {} should not have enabled set when acp:pi is the default",
            info.id
        );
    }
}

#[test]
fn default_agent_enabled_is_overridable_via_registry() {
    // AC4: changing the default_agent_id changes which agent is `enabled`.
    let reg = AcpAgentRegistry::new();

    // Set a different default (e.g. "acp:claude") — claude should be enabled.
    let infos = reg.list_infos_with_default("acp:claude");
    let claude = infos
        .iter()
        .find(|a| a.id == "acp:claude")
        .expect("acp:claude present");
    assert_eq!(
        claude.enabled,
        Some(true),
        "acp:claude should be enabled when it is the default"
    );

    // acp:pi must not be enabled in this configuration.
    let pi = infos
        .iter()
        .find(|a| a.id == "acp:pi")
        .expect("acp:pi present");
    assert!(
        pi.enabled.is_none(),
        "acp:pi should not be enabled when acp:claude is the default"
    );
}

#[test]
fn only_one_agent_has_enabled_set_at_a_time() {
    // Invariant: at most one agent carries `enabled: Some(true)` in a given
    // list_infos response — the one that matches the default_agent_id.
    let reg = AcpAgentRegistry::new();
    let infos = reg.list_infos_with_default("acp:pi");
    let enabled_count = infos.iter().filter(|a| a.enabled == Some(true)).count();
    assert_eq!(
        enabled_count, 1,
        "exactly one agent should have enabled: true"
    );
}

// ── Gateway bypass detection (AC3 of #214) ───────────────────────────────

#[test]
fn bypass_agents_carry_gateway_bypass_true_in_metadata() {
    // Claude Code and Gemini CLI cannot be redirected via OPENAI_BASE_URL;
    // they must surface gateway_bypass: Some(true) so clients can warn users.
    let infos = AcpAgentRegistry::new().list_infos();
    let claude = infos
        .iter()
        .find(|a| a.id == "acp:claude")
        .expect("acp:claude present");
    assert_eq!(
        claude.gateway_bypass,
        Some(true),
        "Claude Code should carry gateway_bypass: true — it uses Anthropic format"
    );
    let gemini = infos
        .iter()
        .find(|a| a.id == "acp:gemini")
        .expect("acp:gemini present");
    assert_eq!(
        gemini.gateway_bypass,
        Some(true),
        "Gemini CLI should carry gateway_bypass: true — it uses Google format"
    );
}

#[test]
fn injectable_agents_do_not_carry_gateway_bypass() {
    // Codex, Pi, and the Ryu flagship honour OPENAI_BASE_URL; they must NOT
    // carry gateway_bypass so clients don't mislead users with a false warning.
    let infos = AcpAgentRegistry::new().list_infos();
    for id in &["acp:codex", "acp:pi", "ryu"] {
        let info = infos
            .iter()
            .find(|a| &a.id.as_str() == id)
            .expect("agent present");
        assert!(
            info.gateway_bypass.is_none(),
            "agent {id} should not carry gateway_bypass — it supports OPENAI_BASE_URL injection"
        );
    }
}

// ── ACP gateway injection opt-out (AC2 of #214) ──────────────────────────

#[test]
fn pi_spawn_cmd_is_bare_by_default() {
    let _env_guard = crate::sidecar::gateway::lock_gateway_env();
    // acp:pi runs the user's own Pi. Gateway routing is explicit through the
    // generic OpenAI-compatible wrapper or through the managed `ryu` agent.
    let cmd = pi_acp_cmd_gated();

    assert!(
        cmd.contains("pi-acp"),
        "pi spawn cmd should contain pi-acp, got: {cmd}"
    );
    assert!(
        !cmd.contains("OPENAI_BASE_URL") && !cmd.contains("OPENAI_API_KEY"),
        "bare pi spawn cmd should not inject gateway env, got: {cmd}"
    );
}

#[test]
fn host_conversation_ids_are_bounded_and_shell_safe() {
    for valid in [
        "550e8400-e29b-41d4-a716-446655440000",
        "island-550e8400-e29b-41d4-a716-446655440000",
        "conv_550e8400e29b41d4a716446655440000",
        "conversation.v2",
    ] {
        assert!(is_safe_host_conversation_id(valid), "{valid}");
        assert_eq!(pi_session_env(Some(valid)).1, valid);
        let env = pi_mcp_extension_env(None, None, None, Some(valid));
        assert!(!env
            .iter()
            .any(|(name, _)| name == "RYU_MCP_HOST_CONVERSATION_ID"));
    }

    for invalid in [
        "",
        "with space",
        "x&whoami",
        "x;whoami",
        "$(whoami)",
        "x\nwhoami",
    ] {
        assert!(
            !is_safe_host_conversation_id(invalid),
            "accepted {invalid:?}"
        );
        let env = pi_mcp_extension_env(None, None, None, Some(invalid));
        assert!(!env
            .iter()
            .any(|(name, _)| name == "RYU_MCP_HOST_CONVERSATION_ID"));
    }
    assert!(!is_safe_host_conversation_id(&"a".repeat(129)));
    assert!(is_safe_host_conversation_id(&pi_session_env(None).1));
}

#[test]
fn pi_extension_env_exports_only_core_location_metadata() {
    let env = pi_mcp_extension_env(
        Some("user-jwt-must-not-cross-acp"),
        Some(&[crate::sidecar::adapters::ComposioConnectionBinding {
            id: "connection-1".to_owned(),
            toolkit: "example".to_owned(),
        }]),
        Some(&["conversation-1".to_owned()]),
        Some("conversation-1"),
    );

    assert!(env.iter().any(|(name, _)| name == "RYU_MCP_CORE_URL"));
    for forbidden_name in [
        "RYU_MCP_CORE_TOKEN",
        "RYU_MCP_USER_JWT",
        "RYU_TOKEN",
        "RYU_MCP_AGENT_ID",
        "RYU_MCP_HOST_CONVERSATION_ID",
        "RYU_MCP_PROFILE_SCOPE",
    ] {
        assert!(
            !env.iter().any(|(name, _)| name == forbidden_name),
            "{forbidden_name} must not be agent-readable"
        );
    }
    assert_eq!(env.len(), 1);
    assert!(env
        .iter()
        .all(|(_, value)| value != "user-jwt-must-not-cross-acp"));
}

#[test]
fn session_capability_and_id_stay_in_structured_stdio_environment() {
    let serialized = acp_stdio_spawn_json(
        "ryu-pi",
        PathBuf::from("npx"),
        vec!["-y".to_owned(), "pi-acp".to_owned()],
        vec![],
    )
    .expect("base ACP config serializes");
    let with_capability = acp_spawn_with_env(
        &serialized,
        vec![
            (
                "RYU_MCP_SESSION_CAPABILITY".to_owned(),
                "opaque-session-capability".to_owned(),
            ),
            (
                "RYU_MCP_ACP_SESSION_ID".to_owned(),
                "550e8400-e29b-41d4-a716-446655440000".to_owned(),
            ),
        ],
    )
    .expect("capability is added through ACP structured env");
    let agent = acp_spawn_from_spawn(&with_capability).expect("structured config parses");
    let McpServer::Stdio(stdio) = agent.into_server() else {
        panic!("expected stdio ACP config")
    };
    assert!(stdio.env.iter().any(|entry| {
        entry.name == "RYU_MCP_SESSION_CAPABILITY" && entry.value == "opaque-session-capability"
    }));
    assert!(stdio
        .args
        .iter()
        .all(|arg| !arg.contains("opaque-session-capability")));
    let extension = include_str!("../../../../../core/assets/pi-extensions/ryu-mcp.ts");
    assert!(extension.contains("getSessionId"));
    assert!(extension.contains("x-ryu-acp-native-session-id"));
}

#[test]
fn only_a_pi_on_the_managed_config_dir_receives_the_secret_env() {
    let managed = crate::pi_config::config_dir()
        .to_string_lossy()
        .into_owned();
    let mut env = vec![EnvVariable::new("PI_CODING_AGENT_DIR", managed.as_str())];
    assert!(apply_managed_pi_secret_env(&mut env));
    assert!(env
        .iter()
        .any(|variable| variable.name == crate::pi_config::secret_env::NODE_TOKEN_ENV));

    let mut elsewhere = vec![EnvVariable::new("PI_CODING_AGENT_DIR", "/tmp/user-pi")];
    assert!(!apply_managed_pi_secret_env(&mut elsewhere));
    assert_eq!(elsewhere.len(), 1, "a user's own Pi gets no Ryu secrets");

    assert!(managed_pi_probe_context("npx -y opencode acp").is_empty());
    let context = managed_pi_probe_context(&format!("PI_CODING_AGENT_DIR={managed} pi-acp"));
    assert!(context.starts_with("\u{2}pi-secrets:"));
    assert!(!context.contains("ryu-local"), "a digest, never the values");
}

#[test]
fn a_finite_allowlist_confines_the_managed_pi_to_ryu_tools() {
    let spawn = acp_stdio_spawn_json(
        "ryu-pi",
        PathBuf::from("node"),
        vec!["/tmp/ryu-pi/node_modules/pi-acp/dist/ryu-index.js".to_owned()],
        vec![("PI_CODING_AGENT_DIR".to_owned(), "/tmp/ryu-pi".to_owned())],
    )
    .expect("base ACP config serializes");
    let scope_of = |command: &str| -> Option<String> {
        let agent = AcpSpawn::from_str(command).expect("structured config parses");
        let McpServer::Stdio(stdio) = agent.into_server() else {
            panic!("expected stdio ACP config")
        };
        stdio
            .env
            .into_iter()
            .find(|entry| entry.name == PI_ACTIVE_TOOLS_ENV)
            .map(|entry| entry.value)
    };

    let jay = crate::agents::jay_jr::AGENT_ID;
    let jay_jr_tools: Vec<String> = crate::agents::jay_jr::TOOLS
        .iter()
        .map(|tool| (*tool).to_owned())
        .collect();
    // The deny marker the least-privilege migration wrote into every legacy
    // `*` row, the flagship's included, resolves to an empty allowlist.
    let migrated_deny: Vec<String> = Vec::new();

    // A `*` grant (`None`) never confines, on any agent or turn.
    for (agent, public) in [("ryu", false), ("ryu", true), (jay, false)] {
        let unscoped = managed_pi_tool_scope(&spawn, agent, None, public).expect("unscoped spawn");
        assert_eq!(unscoped, spawn);
        assert_eq!(scope_of(&unscoped), None);
    }

    // The flagship keeps Pi's own tools on its owner's turns whatever its list
    // says, so an upgraded install's default agent can still work.
    for allowlist in [&jay_jr_tools, &migrated_deny] {
        let flagship = managed_pi_tool_scope(&spawn, "ryu", Some(allowlist.as_slice()), false)
            .expect("flagship spawn");
        assert_eq!(flagship, spawn);
        assert_eq!(scope_of(&flagship), None);
    }

    // Jay Jr.'s allowlist (and an explicitly empty one), and any public-agent
    // turn, confine Pi to the brokered Ryu proxy tools: no bash/read/write/edit,
    // no plugin tools.
    for (agent, allowlist, public) in [
        (jay, &jay_jr_tools, false),
        (jay, &migrated_deny, false),
        (jay, &jay_jr_tools, true),
        ("ryu", &jay_jr_tools, true),
        ("ryu", &migrated_deny, true),
    ] {
        assert!(confines_managed_pi_tools(
            agent,
            Some(allowlist.as_slice()),
            public
        ));
        let scoped = managed_pi_tool_scope(&spawn, agent, Some(allowlist.as_slice()), public)
            .expect("scoped spawn");
        assert_eq!(
            scope_of(&scoped).as_deref(),
            Some("ryu_call_tool,ryu_list_tools"),
            "{agent} public={public}"
        );
        // Still recognised as the managed Pi, so the broker grant applies.
        assert_eq!(ryu_tool_access(&scoped), RyuToolAccess::PiExtension);
    }

    // The extension that enforces the scope reads this exact variable and
    // these exact tool names.
    let plan = include_str!("../../../../../core/assets/pi-extensions/ryu-plan.ts");
    assert!(plan.contains(PI_ACTIVE_TOOLS_ENV));
    let mcp = include_str!("../../../../../core/assets/pi-extensions/ryu-mcp.ts");
    for tool in RYU_MCP_PI_TOOLS {
        assert!(
            mcp.contains(&format!("name: \"{tool}\"")),
            "ryu-mcp.ts no longer registers {tool}"
        );
    }
}
