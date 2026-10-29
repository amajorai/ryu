use super::*;

// ── Ryu flagship agent (U042) ─────────────────────────────────────────────

#[test]
fn patrol_runs_on_the_managed_ryu_engine_not_the_users_pi() {
    let _pi_guard = crate::pi_config::lock_pi_config_test_env();
    // Patrol's row is bound to `acp:pi` like Ryu's, but it must take Ryu's
    // managed Pi (isolated config dir + Gateway), never the user's own Pi
    // registry entry that the same engine id would otherwise select.
    let patrol = crate::agents::patrol::AGENT_ID;
    let route = agent_route(
        Some(patrol),
        Some("acp:pi"),
        None,
        &acp_reg(),
        &provider_reg(),
    )
    .expect("Patrol route");
    let AgentRoute::Acp { spawn_cmd } = route else {
        panic!("expected an ACP route for Patrol (managed Pi + Gateway)");
    };
    assert!(
        spawn_cmd.contains("PI_CODING_AGENT_DIR"),
        "Patrol must run Ryu's isolated Pi config, got: {spawn_cmd}"
    );
    // The user's own Pi launch settings (keyed on `acp:pi`) never apply to it.
    assert!(acp_agent_settings_for(patrol, Some("acp:pi"), &acp_reg(), None).is_none());
    assert!(acp_agent_kind_for(patrol, Some("acp:pi"), &acp_reg(), None).is_none());
}

/// A custom agent saved on the "Ryu" engine (`acp:pi`) with limited model
/// provider access, including an "Its own identity" agent with an empty
/// list, runs on Ryu's managed, Gateway-routed Pi under its own id with the
/// credential-free limited config. An unrestricted one keeps the user's own
/// Pi exactly as before.
#[test]
fn limited_custom_agents_on_the_ryu_engine_run_managed_pi_not_the_users_pi() {
    crate::pi_config::tests::with_temp_dir(|| {
        let _env_guard = crate::sidecar::gateway::lock_gateway_env();
        let managed = crate::pi_config::config_dir();
        std::fs::create_dir_all(&managed).unwrap();
        std::fs::write(
            managed.join("auth.json"),
            r#"{"anthropic":{"type":"api_key","key":"sk-user-anthropic"}}"#,
        )
        .unwrap();
        let limited_dir = crate::pi_config::limited_agent_dir(Some("agent-a"));
        let route = |id: &str, access: Option<&[String]>| {
            agent_route_with_user_jwt(
                Some(id),
                Some("acp:pi"),
                None,
                &acp_reg(),
                &provider_reg(),
                None,
                None,
                None,
                None,
                access,
            )
        };
        let env_value = |spawn: &str, name: &str| -> Option<String> {
            let value: serde_json::Value = serde_json::from_str(spawn).ok()?;
            value["env"]
                .as_array()?
                .iter()
                .find(|entry| entry["name"] == name)
                .and_then(|entry| entry["value"].as_str())
                .map(str::to_owned)
        };
        let signer = crate::sidecar::gateway::required_gateway_core_token().unwrap();

        for access in [Vec::new(), vec!["openai".to_owned()]] {
            let Some(AgentRoute::Acp { spawn_cmd }) = route("agent-a", Some(&access)) else {
                panic!("a limited agent on the Ryu engine starts on the managed Pi")
            };
            assert_eq!(
                env_value(&spawn_cmd, "PI_CODING_AGENT_DIR").map(std::path::PathBuf::from),
                Some(limited_dir.clone()),
                "{spawn_cmd}"
            );
            assert!(env_value(&spawn_cmd, "OPENAI_BASE_URL")
                .is_some_and(|url| url.contains("/v1/agents/agent-a")));
            let token = env_value(&spawn_cmd, "OPENAI_API_KEY").expect("scoped bearer");
            let scope = ryu_gw_credentials::InferenceScope::verify(&token, &signer)
                .expect("the bearer is an agent-scoped inference credential");
            assert_eq!(scope.agent_id, "agent-a");
            assert_eq!(scope.provider_access, Some(access.clone()));
            // The user's Pi sign-ins never reach the limited config dir.
            assert!(!limited_dir.join("auth.json").exists());
            let models = std::fs::read_to_string(limited_dir.join("models.json")).unwrap();
            assert!(!models.contains("sk-user"), "{models}");
            assert!(crate::agent_access::user_provider_stores().contains(&managed));
            // It runs as the managed Pi: brokered tools on its own allowlist.
            assert!(acp::is_managed_pi_extension(&spawn_cmd, "agent-a"));
            // The chat path explains a refusal with the routing reason.
            assert!(
                limited_route_refusal("agent-a", "acp:pi", &acp_reg(), Some(&access)).is_none()
            );
            // The user's own Pi launch settings never apply to it; the
            // settings saved under its own id still do.
            {
                let _settings_guard = crate::acp_agent_settings::TEST_LOCK
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                crate::acp_agent_settings::set_from_json(
                    r#"{"acp:pi": {"defaultModel": "user-pi-model", "env": {"X": "1"}}}"#,
                );
                assert!(acp_agent_settings_for(
                    "agent-a",
                    Some("acp:pi"),
                    &acp_reg(),
                    Some(&access)
                )
                .is_none());
                crate::acp_agent_settings::set_from_json(
                    r#"{"acp:pi": {"defaultModel": "user-pi-model"},
                            "agent-a": {"allowedModels": ["local-model"]}}"#,
                );
                let (source, own) = acp_agent_settings_with_source(
                    "agent-a",
                    Some("acp:pi"),
                    &acp_reg(),
                    Some(&access),
                )
                .expect("the agent's own settings apply");
                assert_eq!(source, "agent-a");
                assert_eq!(own.allowed_models, vec!["local-model".to_owned()]);
                assert!(!own.allows_model("user-pi-model"));
                crate::acp_agent_settings::set_from_json("{}");
            }
            assert!(
                acp_agent_kind_for("agent-a", Some("acp:pi"), &acp_reg(), Some(&access)).is_none()
            );
        }

        // Unrestricted, the custom agent keeps the user's own Pi unchanged.
        let Some(AgentRoute::Acp { spawn_cmd }) = route("agent-a", None) else {
            panic!("an unrestricted agent keeps the user's own Pi")
        };
        assert!(!spawn_cmd.contains("PI_CODING_AGENT_DIR"), "{spawn_cmd}");
        assert!(!acp::is_managed_pi_extension(&spawn_cmd, "agent-a"));
        assert!(acp_agent_kind_for("agent-a", Some("acp:pi"), &acp_reg(), None).is_some());

        // The user's own Pi row itself is still refused when limited.
        assert!(route("acp:pi", Some(&[])).is_none());
        assert!(limited_route_refusal("acp:pi", "acp:pi", &acp_reg(), Some(&[])).is_some());

        // Without Pi's Gateway routing the limited agent does not start.
        let mut settings: serde_json::Value =
            std::fs::read_to_string(managed.join("settings.json"))
                .ok()
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or_else(|| serde_json::json!({}));
        settings["x-ryu-routing"] = serde_json::json!("direct");
        std::fs::write(managed.join("settings.json"), settings.to_string()).unwrap();
        assert!(!crate::pi_config::is_gateway_routing());
        assert!(route("agent-a", Some(&[])).is_none());
        let _ = std::fs::remove_dir_all(&limited_dir);
    });
}

#[test]
fn ryu_agent_routes_to_pi_acp_with_gateway() {
    let _pi_guard = crate::pi_config::lock_pi_config_test_env();
    // AC1: agent_id="ryu" must resolve to an ACP route (Pi engine) and
    // inject the gateway URL into the spawn command so every outbound
    // model call is governed by the Gateway (via env injection like Codex).
    let route =
        agent_route(Some("ryu"), None, None, &acp_reg(), &provider_reg()).expect("ryu route");
    match route {
        AgentRoute::Acp { ref spawn_cmd } => {
            // The spawn command must embed the gateway base URL so Pi's
            // outbound model calls route through ryu-gateway.
            let gateway_base = crate::sidecar::gateway::gateway_url();
            let expected_v1 = format!("{}/v1", gateway_base.trim_end_matches('/'));
            assert!(
                spawn_cmd.contains(&expected_v1) || spawn_cmd.contains("OPENAI_BASE_URL"),
                "ryu spawn cmd must inject gateway URL or OPENAI_BASE_URL, got: {spawn_cmd}"
            );
        }
        _ => panic!("expected ACP route for ryu agent (Pi + Gateway)"),
    }
}

#[test]
fn jay_jr_runs_on_the_managed_ryu_engine_not_the_users_pi() {
    let _pi_guard = crate::pi_config::lock_pi_config_test_env();
    // Jay Jr.'s row is bound to `acp:pi` like Ryu's, but it must take Ryu's
    // managed Pi (isolated config dir + Gateway), never the user's own Pi
    // registry entry that the same engine id would otherwise select.
    let route = agent_route(
        Some(crate::agents::jay_jr::AGENT_ID),
        Some("acp:pi"),
        None,
        &acp_reg(),
        &provider_reg(),
    )
    .expect("Jay Jr. route");
    let AgentRoute::Acp { spawn_cmd } = route else {
        panic!("expected an ACP route for Jay Jr. (managed Pi + Gateway)");
    };
    assert!(
        spawn_cmd.contains("PI_CODING_AGENT_DIR"),
        "Jay Jr. must run Ryu's isolated Pi config, got: {spawn_cmd}"
    );
    // The user's own Pi launch settings (keyed on `acp:pi`) never apply to it.
    let jay = crate::agents::jay_jr::AGENT_ID;
    assert!(acp_agent_settings_for(jay, Some("acp:pi"), &acp_reg(), None).is_none());
    assert!(acp_agent_kind_for(jay, Some("acp:pi"), &acp_reg(), None).is_none());
}

#[test]
fn both_pi_roads_render_the_extension_env_from_one_source() {
    let _pi_guard = crate::pi_config::lock_pi_config_test_env();
    // Pi cannot take the in-process MCP bridge, so the managed extension still
    // needs the Core location. The session capability is added only after the
    // ACP pool selects the exact session. TWO spawn paths reach the same agent — the managed binary and
    // this PATH fallback — and only the managed one injected them, so the
    // fallback's Pi silently used the extension's compiled-in
    // `http://127.0.0.1:7980` (wrong under any non-release `RYU_PROFILE`).
    //
    // Asserting over a resolved spawn command CANNOT catch that: which of the two
    // roads `ryu_agent_route` takes depends on whether the managed binary happens
    // to exist on the machine running the test, so it silently exercised whichever
    // one was installed. A first version of this test passed unchanged after the
    // fallback's injection was deleted. So pin the property that removes the drift
    // instead: exactly one renderer, both roads calling it.
    let env = acp::pi_mcp_extension_env(
        Some("verified-user-jwt"),
        None,
        None,
        Some("profile-conversation"),
    );
    assert!(env.iter().any(|(name, value)| {
        name == "RYU_MCP_CORE_URL" && value == &crate::sidecar::gateway::core_self_url()
    }));
    assert!(!env.iter().any(|(name, _)| name == "RYU_MCP_CORE_TOKEN"));
    assert!(!env.iter().any(|(name, _)| name == "RYU_MCP_USER_JWT"));
    assert!(env.iter().all(|(_, value)| value != "verified-user-jwt"));
    assert!(!env
        .iter()
        .any(|(name, _)| name == "RYU_MCP_HOST_CONVERSATION_ID"));

    // Both platform launch shapes serialize the base metadata as structured
    // environment entries. The session capability is inserted later through
    // this same ACP structure, never into command text.
    let posix = acp::acp_stdio_spawn_json(
        "ryu-pi",
        PathBuf::from("npx"),
        vec!["-y".to_owned(), "pi-acp".to_owned()],
        env.clone(),
    )
    .expect("POSIX ACP config serializes");
    let windows = acp::acp_stdio_spawn_json(
        "ryu-pi",
        PathBuf::from("cmd"),
        vec![
            "/d".to_owned(),
            "/s".to_owned(),
            "/c".to_owned(),
            "npx -y pi-acp".to_owned(),
        ],
        env,
    )
    .expect("Windows ACP config serializes");
    for serialized in [posix, windows] {
        let parsed = AcpSpawn::from_str(&serialized).expect("structured ACP parses");
        let McpServer::Stdio(stdio) = parsed.into_server() else {
            panic!("expected stdio ACP config")
        };
        assert!(stdio.args.iter().all(|arg| !arg.contains("whoami")));
        assert!(stdio
            .env
            .iter()
            .any(|entry| entry.name == "RYU_MCP_CORE_URL"));
    }
    let extension = include_str!("../../../../../core/assets/pi-extensions/ryu-mcp.ts");
    assert!(extension.contains("/api/acp/tools"));
    assert!(!extension.contains("x-ryu-user-jwt"));
    assert!(!extension.contains("host_conversation_id"));
}
