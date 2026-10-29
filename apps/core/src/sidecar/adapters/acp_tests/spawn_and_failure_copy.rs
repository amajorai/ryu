use super::*;

#[test]
fn only_the_gateway_codex_home_records_explicit_auth_changes() {
    let home = crate::codex_config::codex_home();
    let gateway = format!(
        "CODEX_HOME='{}' npx -y @zed-industries/codex-acp",
        home.display()
    );
    assert!(super::spawn_uses_codex_gateway_home(&gateway));
    for command in [
        "CODEX_HOME='/home/user/.codex' npx -y @zed-industries/codex-acp",
        "npx -y @zed-industries/codex-acp",
        "invalid 'spawn",
    ] {
        assert!(!super::spawn_uses_codex_gateway_home(command), "{command}");
    }
}

#[test]
fn acp_frame_summary_never_logs_frame_content() {
    let frame = r#"{"jsonrpc":"2.0","id":7,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"secret-prompt-marker"}]}}"#;
    let summary = super::acp_frame_summary(frame);
    assert_eq!(
        summary,
        format!("request method=session/prompt id=7 bytes={}", frame.len())
    );
    let reply = r#"{"jsonrpc":"2.0","id":7,"result":{"text":"secret-reply-marker"}}"#;
    assert!(!super::acp_frame_summary(reply).contains("secret"));
    assert!(super::acp_frame_summary("not json secret-marker").starts_with("unparsed"));
    assert!(!super::acp_frame_summary("not json secret-marker").contains("secret"));
}

#[test]
fn pi_account_custody_requires_exact_managed_direct_spawn() {
    let directory = std::path::Path::new("fixture-managed-pi");
    let binary = std::path::Path::new("fixture-managed-pi-binary");
    let build = |directory: &str, binary: &str, gateway: bool| {
        let mut environment = vec![
            ("PI_CODING_AGENT_DIR".into(), directory.into()),
            ("PI_ACP_PI_COMMAND".into(), binary.into()),
        ];
        if gateway {
            environment.push((
                "OPENAI_BASE_URL".into(),
                "http://localhost.invalid/v1".into(),
            ));
        }
        super::acp_stdio_spawn_json(
            "ryu-pi",
            std::path::PathBuf::from("fixture-pi-acp"),
            vec![],
            environment,
        )
        .unwrap()
    };
    let managed = build("fixture-managed-pi", "fixture-managed-pi-binary", false);
    assert!(super::direct_managed_pi_account_spawn(
        &managed, false, directory, binary
    ));
    assert!(!super::direct_managed_pi_account_spawn(
        &managed, true, directory, binary
    ));
    for command in [
        build("user-pi-directory", "fixture-managed-pi-binary", false),
        build("fixture-managed-pi", "user-pi-binary", false),
        build("fixture-managed-pi", "fixture-managed-pi-binary", true),
        "invalid spawn".to_owned(),
    ] {
        assert!(!super::direct_managed_pi_account_spawn(
            &command, false, directory, binary
        ));
    }
}
/// A limited custom agent on the "Ryu" engine counts as the managed Pi only
/// when its spawn reads the credential-free limited config dir, never the
/// managed dir that holds the user's sign-ins or the user's own Pi.
#[test]
fn a_limited_managed_pi_spawn_reads_only_the_limited_config_dir() {
    let limited = std::path::Path::new("fixture-pi-agent-limited");
    let build = |directory: Option<&str>| {
        super::acp_stdio_spawn_json(
            "ryu-pi",
            std::path::PathBuf::from("fixture-pi-acp"),
            vec![],
            directory
                .map(|directory| vec![("PI_CODING_AGENT_DIR".into(), directory.into())])
                .unwrap_or_default(),
        )
        .unwrap()
    };
    assert!(super::limited_managed_pi_spawn(
        &build(Some("fixture-pi-agent-limited")),
        limited
    ));
    for command in [
        build(Some("fixture-pi-agent")),
        build(None),
        "invalid spawn".to_owned(),
    ] {
        assert!(
            !super::limited_managed_pi_spawn(&command, limited),
            "{command}"
        );
    }
}

#[test]
fn terminal_create_fails_closed_and_terminal_is_not_advertised() {
    let error = terminal_create().unwrap_err().to_string();
    assert!(error.contains("terminal/create is disabled"));
    assert!(!ryu_client_capabilities().terminal);
}

/// ACP 3.x agents withhold boolean config options from a client that does not
/// advertise them, and must not be offered terminal auth or elicitation Core
/// does not implement through the stable schema.
#[test]
fn client_capabilities_advertise_boolean_config_options_only() {
    let wire = serde_json::to_value(ryu_client_capabilities()).unwrap();
    assert_eq!(
        wire["session"]["configOptions"]["boolean"],
        serde_json::json!({})
    );
    assert!(wire.get("elicitation").is_none(), "{wire}");
    assert_ne!(wire["auth"]["terminal"], serde_json::json!(true), "{wire}");
    assert_eq!(wire["fs"]["readTextFile"], true);
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn codex_acp_spawns_through_the_os_runner() {
    // Hermetic direct-vendor descriptor: npm cache warmth cannot change it.
    // The npm parser and actual cached launcher are covered separately by
    // cached_codex_launcher_retains_confinement_and_selected_environment.
    let spawn = acp_stdio_spawn_json(
        "codex",
        PathBuf::from("codex-acp"),
        vec!["--session".into(), "proof".into()],
        vec![("CODEX_HOME".into(), "/selected/account-profile".into())],
    )
    .unwrap();
    let agent = acp_spawn_from_spawn(&spawn).expect("Codex must have a supported OS runner");
    match agent.server() {
        agent_client_protocol::schema::v1::McpServer::Stdio(stdio) => {
            assert_eq!(
                stdio.command,
                std::env::current_exe().expect("current executable")
            );
            assert_eq!(
                stdio.args.first().map(String::as_str),
                Some(crate::agent_sandbox::AGENT_SANDBOX_RUNNER_ARG)
            );
            assert_eq!(stdio.args.get(1).map(String::as_str), Some("--"));
            assert_eq!(stdio.args.get(2).map(String::as_str), Some("codex-acp"));
            assert_eq!(&stdio.args[3..], ["--session", "proof"]);
            assert!(stdio
                .env
                .iter()
                .any(|entry| entry.name == "CODEX_HOME"
                    && entry.value == "/selected/account-profile"));
        }
        _ => panic!("Codex ACP must use stdio transport"),
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn flagged_runner_and_shell_wrapped_codex_spawns_take_the_os_runner() {
    // Launch rewriting refuses every one of these shapes, so the spawn
    // keeps the declared command; confinement must still wrap it.
    let runner = std::env::current_exe().expect("current executable");
    for (program, args) in [
        (
            "npx",
            &["--prefer-offline", "@zed-industries/codex-acp"][..],
        ),
        ("npx", &["-p", "@zed-industries/codex-acp", "codex-acp"]),
        ("bunx", &["@agentclientprotocol/codex-acp@latest"]),
        (
            "sh",
            &["-c", "npx -y @zed-industries/codex-acp --acp & wait"],
        ),
        (
            "cmd",
            &["/c", "npx -y @zed-industries/codex-acp --acp & echo"],
        ),
    ] {
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
        let spawn = acp_stdio_spawn_json(
            "codex",
            PathBuf::from(program),
            args.clone(),
            vec![("CODEX_HOME".into(), "/selected/account-profile".into())],
        )
        .unwrap();
        let agent = acp_spawn_from_spawn(&spawn)
            .unwrap_or_else(|error| panic!("{program} {args:?}: {error}"));
        let agent_client_protocol::schema::v1::McpServer::Stdio(stdio) = agent.server() else {
            panic!("Codex ACP must use stdio transport");
        };
        assert_eq!(
            stdio.command, runner,
            "{program} {args:?} escaped the runner"
        );
        assert_eq!(
            stdio.args.first().map(String::as_str),
            Some(crate::agent_sandbox::AGENT_SANDBOX_RUNNER_ARG)
        );
        assert_eq!(stdio.args.get(1).map(String::as_str), Some("--"));
        assert_eq!(stdio.args.get(2).map(String::as_str), Some(program));
        assert_eq!(&stdio.args[3..], args.as_slice());
        assert!(stdio
            .env
            .iter()
            .any(|entry| entry.name == "CODEX_HOME" && entry.value == "/selected/account-profile"));
    }
    // A shell-wrapped agent that only names Codex in its input keeps its command.
    let other_args = vec![
        "-c".to_owned(),
        "npx -y @fixture/native-acp --description codex-acp".to_owned(),
    ];
    let spawn =
        acp_stdio_spawn_json("other", PathBuf::from("sh"), other_args.clone(), vec![]).unwrap();
    let agent = acp_spawn_from_spawn(&spawn).expect("non-Codex shell agent");
    let agent_client_protocol::schema::v1::McpServer::Stdio(stdio) = agent.server() else {
        panic!("ACP must use stdio transport");
    };
    assert_eq!(stdio.command, PathBuf::from("sh"));
    assert_eq!(stdio.args, other_args);
}

#[test]
fn managed_openrouter_credit_failure_has_managed_recovery_copy() {
    let failure = classify_prompt_failure(
        Some(crate::pi_config::MANAGED_OPENROUTER_ID),
        "HTTP 402: organization credit balance exhausted (insufficient_credits)",
    );
    assert_eq!(failure.code, "insufficient_credits");
    assert_eq!(failure.title, "Ryu credits exhausted");
    assert!(failure.message.contains("Settings > Credits"));
    assert!(failure.message.contains("BYOK or local model"));
}

#[test]
fn openrouter_byok_credit_failure_has_provider_recovery_copy() {
    let failure = classify_prompt_failure(
        Some("openrouter"),
        "OpenRouter API error 402: no credits (provider_payment_required)",
    );
    assert_eq!(failure.code, "provider_payment_required");
    assert_eq!(failure.title, "OpenRouter credits exhausted");
    assert!(failure.message.contains("OpenRouter account"));
    assert!(failure.message.contains("another provider"));
}

#[test]
fn openrouter_transport_failure_is_not_mislabeled_as_credit_exhaustion() {
    let failure = classify_prompt_failure(Some("openrouter"), "connection refused");
    assert_eq!(failure.code, "agent_error");
    assert_eq!(failure.title, "Request failed");
    assert!(!failure.message.to_lowercase().contains("credits exhausted"));
}

#[test]
fn claude_extra_usage_rejection_is_not_mislabeled_as_a_login_failure() {
    let failure = classify_prompt_failure(
        Some("anthropic"),
        "HTTP 400: Third-party apps now draw from your extra usage, not your plan limits",
    );
    assert_eq!(failure.code, "provider_usage_unavailable");
    assert_eq!(failure.title, "Claude usage unavailable");
    assert!(failure.message.contains("account is connected"));
    assert!(failure.message.contains("Claude Usage settings"));

    let unrelated = classify_prompt_failure(
        Some("openrouter"),
        "HTTP 400: Third-party apps now draw from your extra usage",
    );
    assert_eq!(unrelated.code, "agent_error");
}
