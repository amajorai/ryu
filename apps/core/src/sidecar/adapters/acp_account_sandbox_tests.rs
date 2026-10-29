use super::*;
use crate::agent_access::AccountConfinement;

fn stdio(command: &str, env: &[(&str, &str)]) -> McpServerStdio {
    McpServerStdio::new("agent", command).env(
        env.iter()
            .map(|(name, value)| agent_client_protocol::schema::v1::EnvVariable::new(*name, *value))
            .collect(),
    )
}

#[test]
fn only_a_pi_on_brokered_tools_may_run_unsandboxed() {
    let brokered = RYU_MCP_PI_TOOLS.join(",");
    assert!(pi_runs_brokered_tools_only(&stdio(
        "pi",
        &[(PI_ACTIVE_TOOLS_ENV, brokered.as_str())]
    )));
    assert!(!pi_runs_brokered_tools_only(&stdio(
        "pi",
        &[(PI_ACTIVE_TOOLS_ENV, "ryu_call_tool,bash")]
    )));
    assert!(!pi_runs_brokered_tools_only(&stdio("pi", &[])));
}

/// A user's own Pi (any config dir Core does not manage) must never take the
/// no-sandbox fallback: it does not load the extension that narrows its tools.
#[test]
fn only_a_core_managed_pi_config_dir_may_take_the_unsandboxed_fallback() {
    crate::pi_config::tests::with_temp_dir(|| {
        let own = crate::pi_config::limited_agent_dir(Some("agent-a"));
        let own = own.to_str().unwrap();
        assert!(pi_config_dir_is_managed(&stdio(
            "pi-acp",
            &[("PI_CODING_AGENT_DIR", own)]
        )));
        assert!(!pi_config_dir_is_managed(&stdio(
            "pi-acp",
            &[("PI_CODING_AGENT_DIR", "/home/user/.pi/agent")]
        )));
        assert!(!pi_config_dir_is_managed(&stdio(
            "pi-acp",
            &[
                ("PI_CODING_AGENT_DIR", own),
                ("PI_CODING_AGENT_DIR", "/home/user/.pi/agent"),
            ]
        )));
        assert!(!pi_config_dir_is_managed(&stdio("pi-acp", &[])));
    });
}

#[test]
fn keep_paths_hold_the_harness_home_but_never_core_secrets() {
    let ryu = crate::paths::ryu_dir();
    let custody = ryu.join("secrets/native-accounts/kiro/ns1");
    let forged = ryu.join("secrets");
    let codex_home = std::env::temp_dir().join("ryu-keep-codex-home");
    let cwd = std::env::temp_dir().join("ryu-keep-work");
    // An absolute program path on every platform (`/opt/...` is not one on Windows).
    let kiro_cli = std::env::temp_dir().join("agents").join("kiro-cli");
    let keep = sandbox_keep_paths(
        &stdio(
            kiro_cli.to_str().unwrap(),
            &[
                ("HOME", custody.to_str().unwrap()),
                ("CODEX_HOME", codex_home.to_str().unwrap()),
                ("CLAUDE_CONFIG_DIR", forged.to_str().unwrap()),
            ],
        ),
        &cwd,
        &[],
        false,
    );
    assert!(keep.contains(&cwd));
    assert!(keep.contains(&kiro_cli));
    assert!(keep.contains(&custody), "Kiro custody home is kept");
    assert!(keep.contains(&codex_home));
    assert!(
        !keep.contains(&forged),
        "a launch setting cannot un-hide Core's secrets"
    );

    // Nor another hidden store: Core's logs or app data, the managed Pi
    // config, or another engine's sign-in. A working folder inside Core's
    // secrets is not kept either.
    let logs = ryu.join("logs");
    let pi_config = crate::pi_config::config_dir();
    let in_secrets = ryu.join("secrets").join("work");
    let mut forged_homes = vec![
        ("PI_CODING_AGENT_DIR", logs.clone()),
        ("KIRO_HOME", ryu.join("plugin-data").join("x")),
        ("GEMINI_CLI_HOME", pi_config.clone()),
    ];
    let user_codex = crate::codex_config::user_codex_home();
    forged_homes.push(("CODEX_HOME", user_codex.clone()));
    let envs: Vec<(&str, String)> = forged_homes
        .iter()
        .map(|(name, path)| (*name, path.to_string_lossy().into_owned()))
        .collect();
    let env_refs: Vec<(&str, &str)> = envs
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    let forged_keep = sandbox_keep_paths(
        &stdio("/opt/agents/goose", &env_refs),
        &in_secrets,
        std::slice::from_ref(&cwd),
        false,
    );
    for (name, path) in &forged_homes {
        assert!(!forged_keep.contains(path), "{name} {}", path.display());
    }
    assert!(!forged_keep.contains(&in_secrets));
    assert!(forged_keep.contains(&cwd));
    // Codex keeps its own home.
    let codex_keep = sandbox_keep_paths(
        &stdio("codex-acp", &[("CODEX_HOME", user_codex.to_str().unwrap())]),
        &cwd,
        &[],
        false,
    );
    assert!(codex_keep.contains(&user_codex));

    let claude = sandbox_keep_paths(&stdio("claude-agent-acp", &[]), &cwd, &[], true);
    if let Some(home) = dirs::home_dir() {
        assert!(claude.contains(&home.join(".claude")));
        assert!(claude.contains(&home.join(".claude.json")));
        assert!(!claude.contains(&home.join(".codex")));
        let gemini = sandbox_keep_paths(
            &stdio("npx", &[]).args(vec!["-y".into(), "@google/gemini-cli@latest".into()]),
            &cwd,
            &[],
            false,
        );
        assert!(gemini.contains(&home.join(".gemini")));
        let lookalike = sandbox_keep_paths(&stdio("/opt/my-gemini-wrapper", &[]), &cwd, &[], false);
        assert!(
            !lookalike.contains(&home.join(".gemini")),
            "only Gemini CLI itself keeps its sign-in"
        );
    }
}

/// A confined agent's managed Pi keeps its own limited Pi config visible
/// and loses every other agent's: Pi loads code from that folder.
#[test]
fn a_limited_agent_sees_only_its_own_limited_pi_config() {
    crate::pi_config::tests::with_temp_dir(|| {
        let root = crate::pi_config::limited_agents_root();
        let own = crate::pi_config::limited_agent_dir(Some("agent-a"));
        let other = crate::pi_config::limited_agent_dir(Some("agent-b"));
        std::fs::create_dir_all(&own).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let cwd = std::env::temp_dir().join("ryu-keep-work");
        let keep = sandbox_keep_paths(
            &stdio(
                "/opt/ryu/pi",
                &[("PI_CODING_AGENT_DIR", own.to_str().unwrap())],
            ),
            &cwd,
            &[],
            false,
        );
        assert!(keep.contains(&own));
        let masks = crate::agent_sandbox::keep_visible(vec![root.clone()], &keep);
        assert!(masks.contains(&other), "{masks:?}");
        assert!(!masks.iter().any(|mask| own.starts_with(mask)), "{masks:?}");
        // An engine with no limited Pi config of its own sees none of them.
        let claude = sandbox_keep_paths(&stdio("claude-agent-acp", &[]), &cwd, &[], true);
        assert_eq!(
            crate::agent_sandbox::keep_visible(vec![root.clone()], &claude),
            vec![root.clone()]
        );
        let _ = std::fs::remove_dir_all(&root);
    });
}

#[tokio::test]
async fn an_unrestricted_agent_in_a_trusted_folder_is_not_wrapped() {
    let original = stdio("claude-agent-acp", &[]);
    let (launched, notice) = confine_for_agent(
        original.clone(),
        false,
        true,
        true,
        AccountConfinement::None,
        Path::new("/work"),
        &[],
    )
    .await
    .expect("no confinement");
    assert_eq!(launched.command, original.command);
    assert_eq!(launched.args, original.args);
    assert!(notice.is_none());
}

/// In a trusted folder too, a confined agent loses the home credential
/// stores and the Ryu Desktop's and Browser's data; an unconfined one
/// keeps the trusted-folder behaviour (nothing hidden).
#[test]
fn a_confined_agent_loses_home_credentials_even_in_a_trusted_folder() {
    let home = std::env::temp_dir().join(format!(
        "ryu-confine-home-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(home.join(".aws").join("sso")).unwrap();
    std::fs::write(home.join(".aws").join("credentials"), "[default]").unwrap();
    assert!(account_confinement_masks(AccountConfinement::None, Some(&home), false).is_none());

    let masks = account_confinement_masks(AccountConfinement::CoreState, Some(&home), false)
        .expect("a limited agent is confined");
    for store in crate::agent_sandbox::home_credential_masks(Some(&home)) {
        assert!(masks.contains(&store), "{}", store.display());
    }
    for path in [
        ".ssh",
        ".aws",
        ".config/gh",
        ".git-credentials",
        ".config/google-chrome",
    ] {
        assert!(masks.contains(&home.join(path)), "{path}");
    }
    assert!(masks.contains(&crate::pi_config::limited_agents_root()));
    if let Some(config) = dirs::config_dir() {
        assert!(masks.contains(&config.join(crate::agent_sandbox::RYU_BROWSER_PROFILE_DIR)));
    }
    assert!(
        !masks.contains(&crate::pi_config::config_dir()),
        "provider sign-ins stay while its providers are not limited"
    );
    let providers = account_confinement_masks(
        AccountConfinement::CoreStateAndProviders,
        Some(&home),
        false,
    )
    .unwrap();
    for store in crate::agent_access::user_provider_stores() {
        assert!(providers.contains(&store), "{}", store.display());
    }

    // The engine's own sign-in inside a credential store stays visible;
    // the rest of that store does not.
    let sso = home.join(".aws").join("sso");
    let narrowed = crate::agent_sandbox::keep_visible(masks, std::slice::from_ref(&sso));
    assert!(!narrowed.contains(&home.join(".aws")));
    assert!(
        !narrowed.iter().any(|mask| sso.starts_with(mask)),
        "{narrowed:?}"
    );
    assert!(narrowed.contains(&home.join(".aws").join("credentials")));
    assert!(narrowed.contains(&home.join(".ssh")));
    let _ = std::fs::remove_dir_all(&home);
}

/// Kiro CLI signed in from the user's home keeps that sign-in; one in a
/// Ryu custody home does not, and no launch keeps a working folder inside
/// a home credential store.
#[test]
fn kiro_keeps_its_own_sign_in_and_no_launch_keeps_a_credential_store() {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let cwd = std::env::temp_dir().join("ryu-keep-work");
    let kiro = sandbox_keep_paths(&stdio("/opt/agents/kiro-cli", &[]), &cwd, &[], false);
    for own in crate::agent_access::user_kiro_sign_in_paths() {
        assert!(kiro.contains(&own), "{}", own.display());
    }
    let custody = crate::paths::ryu_dir().join("secrets/native-accounts/kiro/ns1");
    let custody_kiro = sandbox_keep_paths(
        &stdio(
            "/opt/agents/kiro-cli",
            &[
                ("HOME", custody.to_str().unwrap()),
                ("KIRO_HOME", custody.join(".kiro").to_str().unwrap()),
            ],
        ),
        &cwd,
        &[],
        false,
    );
    assert!(!custody_kiro.contains(&home.join(".kiro")));
    assert!(!custody_kiro.contains(&home.join(".aws").join("sso")));
    let claude = sandbox_keep_paths(&stdio("claude-agent-acp", &[]), &cwd, &[], true);
    assert!(!claude.contains(&home.join(".kiro")));

    let in_ssh = home.join(".ssh").join("work");
    let forged = home.join(".config").join("gh");
    let keep = sandbox_keep_paths(
        &stdio("/opt/agents/goose", &[("HOME", forged.to_str().unwrap())]),
        &in_ssh,
        std::slice::from_ref(&cwd),
        false,
    );
    assert!(!keep.contains(&in_ssh));
    assert!(!keep.contains(&forged));
    assert!(keep.contains(&cwd));
}

#[test]
fn a_limited_agent_is_refused_without_the_sandbox_unless_pi_is_brokered_only() {
    let claude = stdio("claude-agent-acp", &[]);
    let masks = vec![crate::paths::ryu_dir().join("secrets")];
    let refusal = confine_account_access(
        claude.clone(),
        masks.clone(),
        false,
        Err("no user namespaces".to_owned()),
        false,
    )
    .expect_err("an unconfinable engine must not start");
    let LaunchRefusal::AccountAccess(reason) = refusal else {
        panic!("account refusal expected");
    };
    let failure = account_sandbox_failure(
        &reason,
        crate::agent_access::AccountConfinement::CoreStateAndProviders,
    );
    assert_eq!(failure.code, "account_access_sandbox_unavailable");
    assert!(failure.message.contains("no user namespaces"));
    assert!(failure
        .message
        .contains("Ryu's own engine can still run it here"));
    // Both with no limit has its model providers open, so Ryu's own engine
    // cannot run it without the sandbox either; the advice says what would.
    let both = account_sandbox_failure(&reason, crate::agent_access::AccountConfinement::CoreState);
    assert!(
        !both.message.contains("can still run it here"),
        "{}",
        both.message
    );
    assert!(both.message.contains("turn on Limit to selected accounts"));

    let pi = stdio("pi", &[(PI_ACTIVE_TOOLS_ENV, &RYU_MCP_PI_TOOLS.join(","))]);
    let launched = confine_account_access(
        pi.clone(),
        masks.clone(),
        true,
        Err("none".to_owned()),
        true,
    )
    .expect("Ryu's engine on brokered tools may run");
    assert_eq!(launched.command, pi.command);

    if crate::agent_sandbox::untrusted_support().is_ok() {
        let wrapped = confine_account_access(claude.clone(), masks.clone(), false, Ok(()), false)
            .expect("supported host confines");
        assert_eq!(
            wrapped.args[0],
            crate::agent_sandbox::AGENT_SANDBOX_RUNNER_ARG
        );
        let mask = masks[0].to_string_lossy().into_owned();
        assert!(wrapped
            .args
            .windows(2)
            .any(|pair| pair[0] == "--mask" && pair[1] == mask));
        assert!(
            !wrapped.args.iter().any(|arg| arg == "--isolate-network"),
            "a trusted folder keeps its network"
        );
        assert!(
            !wrapped.args.iter().any(|arg| arg == "--deny-keychain"),
            "Claude Code keeps the Keychain its sign-in is in"
        );
        let goose = confine_account_access(
            stdio("/opt/agents/goose", &[]),
            masks.clone(),
            true,
            Ok(()),
            false,
        )
        .expect("supported host confines");
        assert!(goose.args.iter().any(|arg| arg == "--deny-keychain"));
    }
}

/// A confined engine loses the user's Keychain (its Mach services and
/// `~/Library/Keychains`), except Claude Code, whose own macOS sign-in is
/// a Keychain item; an unconfined agent keeps it.
#[test]
fn confined_engines_lose_the_keychain_except_claude_code() {
    for account in [
        AccountConfinement::CoreState,
        AccountConfinement::CoreStateAndProviders,
    ] {
        assert!(account_denies_keychain(account, false), "{account:?}");
        assert!(!account_denies_keychain(account, true), "{account:?}");
    }
    assert!(!account_denies_keychain(AccountConfinement::None, false));

    let home = std::env::temp_dir().join(format!(
        "ryu-confine-keychain-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let keychains = home.join("Library").join("Keychains");
    std::fs::create_dir_all(&keychains).unwrap();
    let denied = account_confinement_masks(AccountConfinement::CoreState, Some(&home), true)
        .expect("confined");
    assert!(denied.contains(&keychains), "{denied:?}");
    let kept = account_confinement_masks(AccountConfinement::CoreState, Some(&home), false)
        .expect("confined");
    assert!(
        !kept.iter().any(|mask| keychains.starts_with(mask)),
        "{kept:?}"
    );

    let _ = std::fs::remove_dir_all(&home);
}

/// In a real home, a working folder inside `~/Library/Keychains` is
/// refused as a keep path, so it cannot narrow the Keychain mask.
#[test]
fn a_working_folder_inside_the_keychain_is_not_kept() {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let inside = home.join("Library").join("Keychains").join("work");
    let cwd = std::env::temp_dir().join("ryu-keep-keychain-work");
    let keep = sandbox_keep_paths(
        &stdio("/opt/agents/goose", &[]),
        &inside,
        std::slice::from_ref(&cwd),
        false,
    );
    assert!(!keep.contains(&inside));
    assert!(keep.contains(&cwd));
}
