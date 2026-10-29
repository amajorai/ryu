use super::*;

#[test]
fn structured_acp_spawn_drops_unscoped_bridge_credentials() {
    let serialized = serde_json::to_string(&McpServer::Stdio(
        McpServerStdio::new("test", "sh")
            .args(vec!["-c".to_owned(), "true".to_owned()])
            .env(vec![
                EnvVariable::new("RYU_MCP_CORE_TOKEN", "node-secret"),
                EnvVariable::new("RYU_MCP_USER_JWT", "user-secret"),
                EnvVariable::new("GATEWAY_ADMIN_KEY", "admin-secret"),
                EnvVariable::new("RYU_GATEWAY_CORE_TOKEN", "core-secret"),
                EnvVariable::new("RYU_GATEWAY_CORE_PROOF_KEY", "proof-secret"),
                EnvVariable::new("ryu_gateway_core_token", "case-variant-secret"),
                EnvVariable::new("RYU_MCP_HOST_CONVERSATION_ID", "conversation-1"),
            ]),
    ))
    .expect("structured ACP config serializes");
    let agent = acp_spawn_from_spawn(&serialized).expect("structured ACP parses");
    let McpServer::Stdio(stdio) = agent.into_server() else {
        panic!("expected stdio ACP process")
    };

    for key in [
        "RYU_MCP_CORE_TOKEN",
        "RYU_MCP_USER_JWT",
        "RYU_TOKEN",
        "RYU_GATEWAY_TOKEN",
        "RYU_NODE_TOKEN",
        "RYU_USER_JWT",
        "X_RYU_USER_JWT",
        "GATEWAY_ADMIN_KEY",
        "GATEWAY_MASTER_KEY",
        "GATEWAY_CORE_RELAY_KEY",
        "GATEWAY_CORE_PROOF_KEY",
        "GATEWAY_RELAY_KEY",
        "RYU_GATEWAY_KEY",
        "RYU_GATEWAY_CORE_TOKEN",
        "RYU_GATEWAY_CORE_PROOF_KEY",
    ] {
        assert!(
            stdio
                .env
                .iter()
                .any(|entry| entry.name == key && entry.value.is_empty()),
            "{key} must be present as a blank mask"
        );
    }
    assert!(
        stdio
            .env
            .iter()
            .all(|entry| !entry.value.contains("secret")),
        "no configured bridge credential value may reach the child"
    );
    // Configured unscoped credentials are refused under every spelling: no
    // declared secret reaches the child, and no credential name, in any
    // case, carries a value. (A configured-only case variant is dropped; it
    // is not in Core's environment, so the child cannot inherit it.)
    for secret in [
        "node-secret",
        "user-secret",
        "admin-secret",
        "core-secret",
        "proof-secret",
        "case-variant-secret",
    ] {
        assert!(
            stdio.env.iter().all(|entry| entry.value != secret),
            "{secret} reached the ACP child environment"
        );
    }
    assert!(stdio
        .env
        .iter()
        .filter(|entry| is_unscoped_acp_bridge_credential(&entry.name))
        .all(|entry| entry.value.is_empty()));
    assert!(stdio.env.iter().any(|entry| {
        entry.name == "RYU_MCP_HOST_CONVERSATION_ID" && entry.value == "conversation-1"
    }));

    // An inherited case variant is the one the child could otherwise
    // receive: it keeps a blank mask under its own spelling.
    let env = isolated_acp_child_env(
        [
            ("PATH".to_owned(), "/usr/bin".to_owned()),
            (
                "ryu_gateway_core_token".to_owned(),
                "inherited-variant-secret".to_owned(),
            ),
        ],
        vec![EnvVariable::new(
            "ryu_gateway_core_token",
            "case-variant-secret",
        )],
    );
    assert!(env
        .iter()
        .any(|entry| entry.name == "ryu_gateway_core_token" && entry.value.is_empty()));
    assert!(env.iter().all(|entry| {
        entry.value != "inherited-variant-secret" && entry.value != "case-variant-secret"
    }));
}

#[test]
fn acp_child_inherits_only_safe_runtime_values_and_explicit_configuration() {
    let env = isolated_acp_child_env(
        [
            ("PATH".to_owned(), "/usr/bin".to_owned()),
            ("HOME".to_owned(), "/home/user".to_owned()),
            ("RYU_DIR".to_owned(), "/home/user/.ryu-dev".to_owned()),
            ("RYU_TOKEN".to_owned(), "core-owner-token".to_owned()),
            (
                "DATABASE_URL".to_owned(),
                "postgres://core:secret@db/ryu".to_owned(),
            ),
            (
                "ANTHROPIC_API_KEY".to_owned(),
                "ambient-provider-secret".to_owned(),
            ),
        ],
        vec![
            EnvVariable::new("OPENAI_API_KEY", "agent-scoped-token"),
            EnvVariable::new("RYU_MCP_SESSION_CAPABILITY", "session-capability"),
            EnvVariable::new("RYU_TOKEN", "configured-owner-token"),
        ],
    );

    let value = |name: &str| {
        env.iter()
            .find(|entry| entry.name.eq_ignore_ascii_case(name))
            .map(|entry| entry.value.as_str())
    };
    assert_eq!(value("PATH"), Some("/usr/bin"));
    assert_eq!(value("HOME"), Some("/home/user"));
    assert_eq!(value("RYU_DIR"), Some("/home/user/.ryu-dev"));
    assert_eq!(value("RYU_TOKEN"), Some(""));
    assert_eq!(value("DATABASE_URL"), Some(""));
    assert_eq!(value("ANTHROPIC_API_KEY"), Some(""));
    assert_eq!(value("OPENAI_API_KEY"), Some("agent-scoped-token"));
    assert_eq!(
        value("RYU_MCP_SESSION_CAPABILITY"),
        Some("session-capability")
    );
}

#[test]
fn structured_acp_env_keeps_metacharacters_out_of_process_arguments() {
    let serialized = acp_spawn_with_env(
        "sh -c true",
        vec![(
            "RYU_MCP_HOST_CONVERSATION_ID".to_owned(),
            "x&whoami>%TEMP%/ryu-pwned&rem".to_owned(),
        )],
    )
    .expect("structured ACP environment serializes");
    let agent = AcpSpawn::from_str(&serialized).expect("structured ACP parses");
    let McpServer::Stdio(stdio) = agent.into_server() else {
        panic!("expected stdio ACP process")
    };
    assert_eq!(stdio.command, PathBuf::from("sh"));
    assert_eq!(stdio.args, vec!["-c", "true"]);
    assert_eq!(
        stdio
            .env
            .iter()
            .find(|entry| entry.name == "RYU_MCP_HOST_CONVERSATION_ID")
            .map(|entry| entry.value.as_str()),
        Some("x&whoami>%TEMP%/ryu-pwned&rem")
    );
}

fn parsed_stdio(spawn_cmd: &str) -> McpServerStdio {
    let McpServer::Stdio(stdio) = AcpSpawn::from_str(spawn_cmd)
        .expect("ACP spawn parses")
        .into_server()
    else {
        panic!("expected stdio ACP process")
    };
    stdio
}

fn env_value<'a>(stdio: &'a McpServerStdio, name: &str) -> Option<&'a str> {
    stdio
        .env
        .iter()
        .find(|entry| entry.name == name)
        .map(|entry| entry.value.as_str())
}

#[test]
fn agent_settings_add_launch_values_but_never_replace_core_environment() {
    let overrides = crate::acp_agent_settings::LaunchOverrides {
        command: None,
        args: vec!["--verbose".to_owned()],
        env: vec![
            (
                "ANTHROPIC_BASE_URL".to_owned(),
                "https://elsewhere".to_owned(),
            ),
            (
                "CLAUDE_CONFIG_DIR".to_owned(),
                "/home/me/.claude-work".to_owned(),
            ),
            ("RYU_GATEWAY_TOKEN".to_owned(), "stolen".to_owned()),
        ],
    };
    let spawn = acp_spawn_with_overrides(
        "ANTHROPIC_BASE_URL=http://127.0.0.1:7981/passthrough/anthropic npx -y @agentclientprotocol/claude-agent-acp@latest",
        &overrides,
        Some("claude-agent-acp"),
    )
    .expect("overrides apply");
    let stdio = parsed_stdio(&spawn);
    assert_eq!(stdio.name, "claude-agent-acp");
    assert_eq!(stdio.command, PathBuf::from("npx"));
    assert_eq!(
        stdio.args,
        vec![
            "-y",
            "@agentclientprotocol/claude-agent-acp@latest",
            "--verbose"
        ]
    );
    assert_eq!(
        env_value(&stdio, "ANTHROPIC_BASE_URL"),
        Some("http://127.0.0.1:7981/passthrough/anthropic"),
        "Gateway routing declared by Core wins"
    );
    assert_eq!(
        env_value(&stdio, "CLAUDE_CONFIG_DIR"),
        Some("/home/me/.claude-work")
    );
    assert_eq!(env_value(&stdio, "RYU_GATEWAY_TOKEN"), Some(""));
    assert!(is_claude_code_spawn(&spawn));
}

#[test]
fn a_custom_command_replaces_the_launcher_and_keeps_inline_windows_environment() {
    let overrides = crate::acp_agent_settings::LaunchOverrides {
        command: Some(PathBuf::from("C:/tools/claude-agent-acp.exe")),
        args: vec!["--flag".to_owned()],
        env: vec![(
            "ANTHROPIC_BASE_URL".to_owned(),
            "https://elsewhere".to_owned(),
        )],
    };
    let spawn = acp_spawn_with_overrides(
        "cmd /c set ANTHROPIC_BASE_URL=http://127.0.0.1:7981/passthrough/anthropic&& npx -y @agentclientprotocol/claude-agent-acp@latest",
        &overrides,
        None,
    )
    .expect("overrides apply");
    let stdio = parsed_stdio(&spawn);
    assert_eq!(
        stdio.command,
        PathBuf::from("C:/tools/claude-agent-acp.exe")
    );
    assert_eq!(stdio.args, vec!["--flag"]);
    assert_eq!(
        env_value(&stdio, "ANTHROPIC_BASE_URL"),
        Some("http://127.0.0.1:7981/passthrough/anthropic")
    );
}

#[test]
fn scoped_gateway_spawn_replaces_embedded_bearer_without_exporting_signer() {
    let _env_guard = crate::sidecar::gateway::lock_gateway_env();
    let original = codex_acp_cmd();
    let scoped = openai_gateway_cmd_for_agent(&original, Some("agent-a"), None).unwrap();
    let value: serde_json::Value = serde_json::from_str(&scoped).unwrap();
    let token = value["env"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "OPENAI_API_KEY")
        .unwrap()["value"]
        .as_str()
        .unwrap();
    let signer = crate::sidecar::gateway::required_gateway_core_token().unwrap();
    let scope = ryu_gw_credentials::InferenceScope::verify(token, &signer).unwrap();
    assert_eq!(scope.agent_id, "agent-a");
    assert_eq!(scope.provider_access, None);
    assert!(!scoped.contains(&signer));
    assert_eq!(
        value["env"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["name"] == "OPENAI_API_KEY")
            .count(),
        1
    );
}

#[test]
fn scoped_gateway_spawn_signs_the_agents_provider_access() {
    let _env_guard = crate::sidecar::gateway::lock_gateway_env();
    let scoped_token = |spawn: &str| {
        let value: serde_json::Value = serde_json::from_str(spawn).unwrap();
        value["env"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == "OPENAI_API_KEY")
            .unwrap()["value"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let signer = crate::sidecar::gateway::required_gateway_core_token().unwrap();
    let limited = vec!["anthropic".to_owned()];
    let spawn =
        openai_gateway_cmd_for_agent(&codex_acp_cmd(), Some("agent-a"), Some(&limited)).unwrap();
    let scope = ryu_gw_credentials::InferenceScope::verify(&scoped_token(&spawn), &signer).unwrap();
    assert_eq!(scope.provider_access, Some(limited.clone()));
    // An agent with its own identity gets an empty list, never "unlimited".
    let spawn = openai_gateway_cmd_for_agent(&codex_acp_cmd(), Some("agent-a"), Some(&[])).unwrap();
    let scope = ryu_gw_credentials::InferenceScope::verify(&scoped_token(&spawn), &signer).unwrap();
    assert_eq!(scope.provider_access, Some(Vec::new()));

    // A Gateway Core does not manage cannot verify the scope, so a limited
    // agent is refused a bearer instead of getting an unlimited one.
    let previous = std::env::var_os("RYU_GATEWAY_MANAGED");
    std::env::set_var("RYU_GATEWAY_MANAGED", "0");
    let unmanaged = crate::sidecar::gateway::gateway_bearer_for_agent(
        Some("agent-a"),
        None,
        None,
        Some(&limited),
    );
    match previous {
        Some(value) => std::env::set_var("RYU_GATEWAY_MANAGED", value),
        None => std::env::remove_var("RYU_GATEWAY_MANAGED"),
    }
    assert!(unmanaged.is_err());
}

#[test]
fn openai_gateway_cmd_wraps_pi_when_requested() {
    let _env_guard = crate::sidecar::gateway::lock_gateway_env();
    let cmd = openai_gateway_cmd(&pi_acp_cmd_gated()).expect("local bearer");
    let gateway_base = crate::sidecar::gateway::configured_gateway_url();
    let expected_v1 = format!("{}/v1", gateway_base.trim_end_matches('/'));

    assert!(
        cmd.contains(&expected_v1),
        "gateway-wrapped pi spawn cmd should contain gateway /v1 URL, got: {cmd}"
    );
    assert!(
        cmd.contains("OPENAI_API_KEY") && cmd.contains("pi-acp"),
        "gateway-wrapped pi spawn cmd should include auth env and original command, got: {cmd}"
    );
}

#[test]
fn openai_gateway_cmd_gateway_url_is_swappable_for_pi() {
    let _env_guard = crate::sidecar::gateway::lock_gateway_env();
    // The injection must honour RYU_GATEWAY_URL — no hardcoded endpoint.
    let prev_gw = std::env::var("RYU_GATEWAY_URL").ok();
    std::env::set_var("RYU_GATEWAY_URL", "http://custom-gw.local:7777");

    let cmd = openai_gateway_cmd(&pi_acp_cmd_gated()).expect("local bearer");

    match prev_gw {
        Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
        None => std::env::remove_var("RYU_GATEWAY_URL"),
    }

    assert!(
        cmd.contains("http://custom-gw.local:7777/v1"),
        "gateway-wrapped pi spawn cmd should use RYU_GATEWAY_URL when set, got: {cmd}"
    );
}

#[test]
fn should_inject_gateway_defaults_to_true() {
    let _env_guard = crate::sidecar::gateway::lock_gateway_env();
    let prev = std::env::var("RYU_ACP_GATEWAY_INJECT").ok();
    std::env::remove_var("RYU_ACP_GATEWAY_INJECT");
    let result = crate::sidecar::gateway::should_inject_gateway();
    match prev {
        Some(v) => std::env::set_var("RYU_ACP_GATEWAY_INJECT", v),
        None => std::env::remove_var("RYU_ACP_GATEWAY_INJECT"),
    }
    assert!(
        result,
        "should_inject_gateway() should default to true when env var is unset"
    );
}

#[test]
fn should_inject_gateway_respects_opt_out() {
    let _env_guard = crate::sidecar::gateway::lock_gateway_env();
    for val in &["0", "false", "no"] {
        let prev = std::env::var("RYU_ACP_GATEWAY_INJECT").ok();
        std::env::set_var("RYU_ACP_GATEWAY_INJECT", val);
        let result = crate::sidecar::gateway::should_inject_gateway();
        match prev {
            Some(v) => std::env::set_var("RYU_ACP_GATEWAY_INJECT", v),
            None => std::env::remove_var("RYU_ACP_GATEWAY_INJECT"),
        }
        assert!(
            !result,
            "should_inject_gateway() should return false when RYU_ACP_GATEWAY_INJECT={val}"
        );
    }
}
