use super::*;

#[test]
fn limited_agents_never_spawn_self_called_engines() {
    let _guard = crate::agent_routing::TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let _env_guard = crate::sidecar::gateway::lock_gateway_env();
    crate::agent_routing::set_from_json("{}");
    crate::claude_config::set_enabled("true");
    crate::codex_config::set_enabled("true");
    let anthropic = vec!["anthropic".to_owned()];
    let openai = vec!["openai".to_owned()];
    let every = vec![
        "anthropic".to_owned(),
        "openai".to_owned(),
        "genai".to_owned(),
        "kiro".to_owned(),
        "core".to_owned(),
    ];
    let is_acp = |route: Option<AgentRoute>| matches!(route, Some(AgentRoute::Acp { .. }));

    // Claude Code, through the passthrough or directly.
    for claude in ["true", "false"] {
        crate::claude_config::set_enabled(claude);
        assert!(limited_route("agent-a", "acp:claude", Some(&[])).is_none());
        assert!(limited_route("agent-a", "acp:claude", Some(&openai)).is_none());
        assert!(is_acp(limited_route(
            "agent-a",
            "acp:claude",
            Some(&anthropic)
        )));
        assert!(is_acp(limited_route("agent-a", "acp:claude", None)));
    }
    crate::claude_config::set_enabled("true");

    // Codex on the ChatGPT-subscription passthrough, from a Ryu-owned
    // gateway home and an empty user Codex home, both in a temp dir, so the
    // machine's own Codex state never decides the outcome. That home
    // carries Ryu's recoverable-delete rules, so on a host without a
    // Trash command the route fails closed instead.
    let codex_root = std::env::temp_dir().join(format!("ryu-limited-codex-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&codex_root);
    let previous_codex_homes = ["RYU_CODEX_HOME", "CODEX_HOME"].map(|name| {
        let previous = std::env::var_os(name);
        std::env::set_var(name, codex_root.join(name));
        (name, previous)
    });
    assert!(limited_route("agent-a", "acp:codex", Some(&anthropic)).is_none());
    assert_eq!(
        is_acp(limited_route("agent-a", "acp:codex", Some(&openai))),
        crate::codex_config::verified_trash_command().is_ok(),
        "Codex starts on the passthrough exactly when its safety home can be written"
    );
    for (name, previous) in previous_codex_homes {
        match previous {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }
    let _ = std::fs::remove_dir_all(&codex_root);

    // Gemini CLI, Kiro, the user's own Pi and bypass entries.
    assert!(limited_route("agent-a", "acp:gemini", Some(&anthropic)).is_none());
    // A custom agent on `acp:pi` runs Ryu's managed Pi instead (see
    // `limited_custom_agents_on_the_ryu_engine_run_managed_pi_not_the_users_pi`).
    assert!(limited_route("acp:pi", "acp:pi", Some(&every)).is_none());
    assert!(limited_route("agent-a", "openclaw", Some(&every)).is_none());
    assert!(limited_route("agent-a", "hermes", Some(&every)).is_none());
    assert!(is_acp(limited_route("agent-a", "openclaw", None)));

    // SDK apps share one unscoped process.
    assert!(limited_route("agent-a", "sdk:@acme/agent", Some(&every)).is_none());

    // A BYO Claude Code command is no way around the vendor check.
    assert!(limited_route(
        "agent-a",
        "acp-exec:npx -y @agentclientprotocol/claude-agent-acp",
        Some(&openai)
    )
    .is_none());
    // Nor is a BYO Gemini CLI or Kiro CLI command, with routing on.
    for gemini in [
        "acp-exec:gemini --experimental-acp",
        "acp-exec:npx -y @google/gemini-cli --experimental-acp",
    ] {
        assert!(
            limited_route("agent-a", gemini, Some(&[])).is_none(),
            "{gemini}"
        );
        assert!(
            limited_route("agent-a", gemini, Some(&anthropic)).is_none(),
            "{gemini}"
        );
    }
    assert!(limited_route("agent-a", "acp-exec:kiro-cli acp", Some(&anthropic)).is_none());
    // A BYO command with its Gateway routing off is refused; on, it is
    // scoped by Gateway.
    crate::agent_routing::set_from_json(r#"{"agent-a": false}"#);
    assert!(limited_route("agent-a", "acp-exec:goose acp", Some(&every)).is_none());
    assert!(is_acp(limited_route("agent-a", "acp-exec:goose acp", None)));
    crate::agent_routing::set_from_json("{}");
    assert!(is_acp(limited_route(
        "agent-a",
        "acp-exec:goose acp",
        Some(&[])
    )));

    // The chat path names the engine's own reason, not the routing one.
    let reason = limited_route_refusal("agent-a", "acp:claude", &acp_reg(), Some(&[])).unwrap();
    assert!(reason.contains("Anthropic"), "{reason}");
    assert!(!reason.contains("Turn Gateway routing on"), "{reason}");
    assert_eq!(
        limited_route_refusal("agent-a", "acp:claude", &acp_reg(), Some(&anthropic)),
        None
    );
    assert_eq!(
        limited_route_refusal("agent-a", "acp:claude", &acp_reg(), None),
        None
    );
    // Ryu's engine keeps its own Gateway-routing explanation.
    assert_eq!(
        limited_route_refusal("ryu", "acp:pi", &acp_reg(), Some(&[])),
        None
    );

    crate::claude_config::set_enabled("");
    crate::codex_config::set_enabled("");
}

#[test]
fn limited_direct_codex_gets_a_scoped_bearer() {
    let _guard = crate::agent_routing::TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let _env_guard = crate::sidecar::gateway::lock_gateway_env();
    crate::codex_config::set_enabled("false");
    crate::agent_routing::set_from_json(r#"{"agent-a": false}"#);
    let limited = vec!["openai".to_owned()];
    let route = limited_route("agent-a", "acp:codex", Some(&limited));
    let unlimited = limited_route("agent-a", "acp:codex", None);
    crate::agent_routing::set_from_json("{}");
    crate::codex_config::set_enabled("");

    let env_value = |spawn: &str, name: &str| -> Option<String> {
        let value: serde_json::Value = serde_json::from_str(spawn).ok()?;
        value["env"]
            .as_array()?
            .iter()
            .find(|entry| entry["name"] == name)
            .and_then(|entry| entry["value"].as_str())
            .map(str::to_owned)
    };
    let Some(AgentRoute::Acp { spawn_cmd }) = route else {
        panic!("a limited agent may run Codex through Gateway")
    };
    let token = env_value(&spawn_cmd, "OPENAI_API_KEY").expect("scoped bearer");
    let signer = crate::sidecar::gateway::required_gateway_core_token().unwrap();
    let scope = ryu_gw_credentials::InferenceScope::verify(&token, &signer)
        .expect("the bearer is an agent-scoped inference credential");
    assert_eq!(scope.provider_access, Some(limited));
    assert!(env_value(&spawn_cmd, "OPENAI_BASE_URL")
        .is_some_and(|url| url.contains("/v1/agents/agent-a")));
    // Codex still runs from the sign-in-free safety home.
    assert!(env_value(&spawn_cmd, "CODEX_HOME").is_some());
    // An unrestricted agent keeps the registry command unchanged.
    assert!(matches!(unlimited, Some(AgentRoute::Acp { .. })));
}
