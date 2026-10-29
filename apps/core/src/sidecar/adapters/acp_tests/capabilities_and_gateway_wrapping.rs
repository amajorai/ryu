use super::*;

// ── Agent capability round-trip ─────────────────────────────────────────

#[test]
fn read_agent_caps_and_json_reflect_initialize_response() {
    let init: InitializeResponse = serde_json::from_value(serde_json::json!({
        "protocolVersion": 1,
        "agentCapabilities": {
            "loadSession": true,
            "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
            "mcpCapabilities": { "http": true, "sse": false },
        }
    }))
    .expect("valid InitializeResponse");
    let caps = read_agent_caps(&init);
    assert!(caps.load_session);
    assert!(caps.prompt_image);
    assert!(!caps.prompt_audio);
    assert!(caps.prompt_embedded_context);
    assert!(caps.mcp_http);
    assert!(!caps.mcp_sse);

    let json = agent_caps_json(&caps);
    assert_eq!(json["loadSession"], serde_json::json!(true));
    assert_eq!(json["promptCapabilities"]["image"], serde_json::json!(true));
    assert_eq!(
        json["promptCapabilities"]["audio"],
        serde_json::json!(false)
    );
    assert_eq!(json["mcpCapabilities"]["http"], serde_json::json!(true));
    assert_eq!(json["mcpCapabilities"]["sse"], serde_json::json!(false));
}

#[test]
fn session_capabilities_are_read_from_a_real_claude_initialize() {
    // Verbatim from a captured claude-acp 0.66.0 `initialize` response. The
    // agent advertises MORE than the pinned schema models — `fork`,
    // `additionalDirectories` (features off in Core) and `delete` (no field
    // at all) — so this also pins that the unknown keys are dropped without
    // breaking the parse.
    let init: InitializeResponse = serde_json::from_value(serde_json::json!({
        "protocolVersion": 1,
        "agentCapabilities": {
            "loadSession": true,
            "sessionCapabilities": {
                "additionalDirectories": {},
                "close": {},
                "delete": {},
                "fork": {},
                "list": {},
                "resume": {},
            },
        }
    }))
    .expect("valid InitializeResponse");
    let caps = read_agent_caps(&init);
    assert!(caps.session_list);
    assert!(caps.session_resume);
    assert!(caps.session_close);

    let json = agent_caps_json(&caps);
    assert_eq!(
        json["sessionCapabilities"]["close"],
        serde_json::json!(true)
    );
}

#[test]
fn an_agent_without_close_is_reported_as_unable_to_delete() {
    // Verbatim from captured pi-acp 0.0.33: it advertises `delete` and
    // `list`, and NO `close`. `delete` is not a field in the pinned schema,
    // so it must NOT be mistaken for close support — that confusion is what
    // made the desktop show a Delete button whose request the agent rejects.
    let init: InitializeResponse = serde_json::from_value(serde_json::json!({
        "protocolVersion": 1,
        "agentCapabilities": {
            "sessionCapabilities": { "delete": {}, "list": {} },
        }
    }))
    .expect("valid InitializeResponse");
    let caps = read_agent_caps(&init);
    assert!(caps.session_list);
    assert!(
        !caps.session_close,
        "`delete` is not `close`; treating it as one is the original bug"
    );
    assert!(!caps.session_resume);

    let json = agent_caps_json(&caps);
    assert_eq!(
        json["sessionCapabilities"]["close"],
        serde_json::json!(false)
    );
}

#[test]
fn session_capabilities_absent_entirely_reads_as_unsupported() {
    // An agent that sends no `sessionCapabilities` at all (older builds) must
    // read as false rather than panicking or defaulting to true.
    let init: InitializeResponse = serde_json::from_value(serde_json::json!({
        "protocolVersion": 1,
        "agentCapabilities": { "loadSession": false }
    }))
    .expect("valid InitializeResponse");
    let caps = read_agent_caps(&init);
    assert!(!(caps.session_list || caps.session_resume || caps.session_close));
}

#[test]
fn read_agent_caps_defaults_to_all_false() {
    // A minimal initialize response (no agentCapabilities) advertises nothing.
    let init: InitializeResponse =
        serde_json::from_value(serde_json::json!({ "protocolVersion": 1 })).unwrap();
    let caps = read_agent_caps(&init);
    assert!(!caps.load_session);
    assert!(!caps.prompt_image);
    assert!(!caps.mcp_http);
}

// ── CLI version parsing ─────────────────────────────────────────────────

#[test]
fn parse_cli_version_extracts_semver_forms() {
    assert_eq!(parse_cli_version("v1.2.3"), Some("1.2.3".to_owned()));
    assert_eq!(
        parse_cli_version("mytool 0.10.4"),
        Some("0.10.4".to_owned())
    );
    assert_eq!(
        parse_cli_version("codex-acp version 2.0.0-beta.1"),
        Some("2.0.0-beta.1".to_owned())
    );
    assert_eq!(
        parse_cli_version("build 1.0.0+abc123"),
        Some("1.0.0+abc123".to_owned())
    );
}

#[test]
fn parse_cli_version_none_without_semver() {
    assert_eq!(parse_cli_version(""), None);
    assert_eq!(parse_cli_version("no version here"), None);
    // A two-part "1.2" is not a full semver and must not match.
    assert_eq!(parse_cli_version("version 1.2"), None);
}

// ── Observed-tool registry (per-agent, process-global) ──────────────────

#[test]
fn record_observed_tool_dedups_by_title_and_maps_kind() {
    // Use a process-unique agent id so the global registry cannot collide with
    // any other test running in the same process.
    let agent = format!("obs-test-{}-{}", std::process::id(), line!());
    assert!(observed_tools_for(&agent).is_empty());

    record_observed_tool(&agent, "Search files", "search");
    record_observed_tool(&agent, "Run command", "other"); // "other" → no description
    record_observed_tool(&agent, "Search files", "search"); // dup title → no growth
    record_observed_tool(&agent, "", "read"); // empty title → ignored

    let mut tools = observed_tools_for(&agent);
    tools.sort_by(|a, b| a.name.cmp(&b.name));
    assert_eq!(tools.len(), 2, "empty title ignored, dup title collapsed");
    let search = tools.iter().find(|t| t.name == "Search files").unwrap();
    assert_eq!(search.description.as_deref(), Some("search"));
    let run = tools.iter().find(|t| t.name == "Run command").unwrap();
    assert!(
        run.description.is_none(),
        "the 'other' kind is not surfaced as a description"
    );
}

// ── Permission back-channel ─────────────────────────────────────────────

#[test]
fn resolve_permission_is_false_for_unknown_request() {
    // No waiter was ever registered for this id → nothing to resolve.
    let unknown = format!("perm-unknown-{}", std::process::id());
    assert!(!resolve_permission(&unknown, Some("allow".to_owned())));
    assert!(peek_permission_scope(&unknown).is_none());
}

#[tokio::test]
async fn question_waiter_round_trips_structured_answers_by_stable_tool_id() {
    let conversation_id = format!("question-conv-{}", line!());
    let tool_call_id = format!("question-tool-{}", line!());
    let rx = register_question(conversation_id.clone(), tool_call_id.clone());
    assert_eq!(
        peek_question_scope(&conversation_id, &tool_call_id).as_deref(),
        Some(conversation_id.as_str())
    );

    let answers = serde_json::json!([{
        "question_id": "q-0",
        "kind": "single",
        "selected_ids": ["option-a"]
    }]);
    assert!(resolve_question(
        &conversation_id,
        &tool_call_id,
        answers.clone()
    ));
    assert_eq!(
        rx.await.expect("question answer sender remains alive"),
        answers
    );
    assert!(peek_question_scope(&conversation_id, &tool_call_id).is_none());
    assert!(!resolve_question(
        &conversation_id,
        &tool_call_id,
        serde_json::json!([])
    ));
}

// ── Gateway command wrapping ────────────────────────────────────────────

#[test]
fn claude_gateway_cmd_injects_only_base_url_not_api_key() {
    // Subscription-preservation: inject ANTHROPIC_BASE_URL but NEVER an API key
    // (an API key would flip Claude Code off the user's Pro/Max OAuth billing).
    let cmd = claude_gateway_cmd("npx -y @zed-industries/claude-code-acp");
    assert!(cmd.contains("ANTHROPIC_BASE_URL="));
    assert!(cmd.contains("/passthrough/anthropic"));
    assert!(
        !cmd.contains("ANTHROPIC_API_KEY") && !cmd.contains("ANTHROPIC_AUTH_TOKEN"),
        "must not inject an API key or auth token: {cmd}"
    );
    assert!(cmd.contains("claude-code-acp"), "base command is preserved");
}

#[test]
fn fresh_session_disables_pool_reuse_but_keeps_conversation_scope() {
    assert!(should_reuse_acp_session("conv-1", false));
    assert!(!should_reuse_acp_session("conv-1", true));
    assert!(!should_reuse_acp_session("", false));
    assert!(!should_reuse_acp_session("", true));
}

#[test]
fn acp_pool_key_ignores_the_managed_pi_generation() {
    let spawn = |generation: &str| {
        format!(
            r#"{{"command":"node","args":["/home/u/.ryu/pi/generations/{generation}/node_modules/pi-acp/dist/ryu-index.js"],"env":[{{"name":"PI_CODING_AGENT_DIR","value":"/home/u/.ryu/pi/agent"}},{{"name":"PI_ACP_PI_COMMAND","value":"C:\\Users\\u\\.ryu\\pi\\generations\\{generation}\\node_modules\\.bin\\pi.cmd"}}]}}"#
        )
    };
    let key =
        |spawn_cmd: &str| acp_pool_key("conv", "ryu", spawn_cmd, &PathBuf::from("/w"), "", "", "");
    assert_eq!(
        key(&spawn("generation-AbC123")),
        key(&spawn("generation-xyz9-0"))
    );
    assert_eq!(
        generation_neutral_spawn_cmd(&spawn("generation-AbC123")),
        spawn("generation-*")
    );
    // Anything else in the command still separates instances.
    assert_ne!(key("npx -y pi-acp"), key("npx -y other-acp"));
    // Other agents keep generation paths in the key, so a changed command
    // starts the newly configured process.
    let custom = |generation: &str| {
        acp_pool_key(
            "conv",
            "custom",
            &spawn(generation),
            &PathBuf::from("/w"),
            "",
            "",
            "",
        )
    };
    assert_ne!(custom("generation-1"), custom("generation-2"));
    assert_eq!(
        generation_neutral_spawn_cmd("generations-report generation-1"),
        "generations-report generation-1"
    );
}

/// The managed Pi spawn command carries a Core-signed bearer. Two turns of
/// one chat must resolve the same command and pool key, or every turn
/// spawns a fresh Pi and the previous one idles to its TTL.
#[test]
fn two_turns_of_one_conversation_reuse_one_pooled_process() {
    use crate::sidecar::gateway::{cached_inference_bearer, InferenceBearerCache};
    let signer = "gwcore_fixture_signing_1234567890";
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut cache = InferenceBearerCache::new();
    let mut spawn = |session: &str, at: u64| {
        let bearer =
            cached_inference_bearer(&mut cache, signer, "ryu", None, Some(session), None, at)
                .unwrap();
        let spawn_cmd = acp_stdio_spawn_json(
            "ryu-pi",
            PathBuf::from("node"),
            vec!["/home/u/.ryu/pi/generations/generation-1/ryu-index.js".into()],
            vec![
                ("OPENAI_BASE_URL".into(), "http://127.0.0.1:1/v1".into()),
                ("OPENAI_API_KEY".into(), bearer.clone()),
                ("PI_CODING_AGENT_DIR".into(), "/home/u/.ryu/pi/agent".into()),
            ],
        )
        .unwrap();
        assert!(spawn_cmd.contains(&bearer));
        spawn_cmd
    };
    let first_turn = spawn("conv", now);
    let second_turn = spawn("conv", now + 5);
    let other_session = spawn("conv-b", now + 5);
    let security = |allowlist: Option<Vec<String>>, account: Option<&str>| {
        acp_security_key(
            &None,
            &allowlist,
            &[],
            "ryu",
            &[],
            &None,
            &None,
            &Some("conv".into()),
            None,
            account,
        )
    };
    let base_security = security(None, None);
    let key = |conversation: &str,
               agent_key: &str,
               spawn_cmd: &str,
               cwd: &str,
               workspace_key: &str,
               security_key: &str| {
        acp_pool_key(
            conversation,
            agent_key,
            spawn_cmd,
            &PathBuf::from(cwd),
            workspace_key,
            "",
            security_key,
        )
    };
    let reused = key("conv", "ryu", &first_turn, "/w", "", &base_security);
    assert_eq!(
        reused,
        key("conv", "ryu", &second_turn, "/w", "", &base_security)
    );

    for separated in [
        key("conv-b", "ryu", &second_turn, "/w", "", &base_security),
        key("conv", "custom", &second_turn, "/w", "", &base_security),
        key("conv", "ryu", &other_session, "/w", "", &base_security),
        key("conv", "ryu", &second_turn, "/other", "", &base_security),
        key("conv", "ryu", &second_turn, "/w", "/extra", &base_security),
        key(
            "conv",
            "ryu",
            &second_turn,
            "/w",
            "",
            &security(Some(vec!["tool:read".into()]), None),
        ),
        key(
            "conv",
            "ryu",
            &second_turn,
            "/w",
            "",
            &security(None, Some("anthropic:account-b")),
        ),
    ] {
        assert_ne!(reused, separated);
    }
}
