use super::*;

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[test]
fn legacy_codex_runner_arguments_keep_deletion_denial() {
    let plan = parse_runner_args(&args(&["--", "codex-acp", "--x"])).unwrap();
    assert!(plan.deny_delete);
    assert!(plan.masks.is_empty());
    assert!(!plan.isolate_network);
    assert_eq!(plan.command, "codex-acp");
    assert_eq!(plan.args, ["--x"]);
}

#[test]
fn untrusted_runner_arguments_round_trip() {
    let plan = parse_runner_args(&args(&[
        "--allow-delete",
        "--mask",
        "/home/u/.ssh",
        "--isolate-network",
        "--loopback-port",
        "7981",
        "--relay-dir",
        "/tmp/r",
        "--",
        "claude-agent-acp",
    ]))
    .unwrap();
    assert!(!plan.deny_delete);
    assert_eq!(plan.masks, [PathBuf::from("/home/u/.ssh")]);
    assert!(plan.isolate_network);
    assert_eq!(plan.loopback_ports, [7981]);
    assert_eq!(plan.relay_dir.as_deref(), Some(Path::new("/tmp/r")));
    assert_eq!(plan.command, "claude-agent-acp");
}

#[test]
fn malformed_runner_arguments_are_refused() {
    assert!(parse_runner_args(&args(&["codex"])).is_err());
    assert!(parse_runner_args(&args(&["--mask"])).is_err());
    assert!(parse_runner_args(&args(&["--bogus", "--", "x"])).is_err());
    assert!(parse_runner_args(&args(&["--loopback-port", "1", "--", "x"])).is_err());
    assert!(parse_runner_args(&args(&["--loopback-port", "nope", "--", "x"])).is_err());
    assert!(parse_runner_args(&args(&["--"])).is_err());
}

#[test]
fn seatbelt_profile_denies_masks_and_non_local_network() {
    let root = tempfile::tempdir().unwrap();
    let plan = RunnerPlan {
        deny_delete: false,
        masks: vec![root.path().to_path_buf(), PathBuf::from("/x/a\"b")],
        isolate_network: true,
        ..RunnerPlan::default()
    };
    let profile = seatbelt_profile(&plan);
    assert!(!profile.contains("file-write-unlink"));
    assert!(profile.contains(&format!("(subpath {})", seatbelt_string(root.path()))));
    assert!(profile.contains(r#"(literal "/x/a\"b")"#));
    assert!(profile.contains("(deny network-outbound)"));
    assert!(profile.contains("localhost:*"));
    let codex = seatbelt_profile(&RunnerPlan {
        deny_delete: true,
        ..RunnerPlan::default()
    });
    assert_eq!(
        codex,
        "(version 1) (allow default) (deny file-write-unlink)"
    );
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn untrusted_profile_wraps_agents_and_extends_codex_runner() {
    if untrusted_support().is_err() {
        return;
    }
    let profile = UntrustedProfile {
        masks: vec![PathBuf::from("/home/u/.ssh")],
        loopback_ports: Some(vec![7981]),
        deny_keychain: true,
    };
    let claude = McpServerStdio::new("claude", "claude-agent-acp").args(vec!["--v".into()]);
    let wrapped = confine_stdio(claude, &profile, Some(Path::new("/tmp/r"))).unwrap();
    let plan = parse_runner_args(&wrapped.args[1..]).unwrap();
    assert_eq!(wrapped.args[0], AGENT_SANDBOX_RUNNER_ARG);
    assert!(!plan.deny_delete, "non-Codex agents keep deletion");
    assert_eq!(plan.masks, profile.masks);
    assert_eq!(plan.loopback_ports, [7981]);
    assert!(plan.deny_keychain);
    assert_eq!(plan.command, "claude-agent-acp");

    let codex = confine_codex_stdio(McpServerStdio::new("codex", "codex-acp")).unwrap();
    let wrapped = confine_stdio(codex, &profile, Some(Path::new("/tmp/r"))).unwrap();
    let plan = parse_runner_args(&wrapped.args[1..]).unwrap();
    assert!(plan.deny_delete, "Codex keeps its deletion boundary");
    assert!(plan.isolate_network);
    assert!(plan.deny_keychain);
    assert_eq!(plan.command, "codex-acp");
}

#[test]
fn seatbelt_profile_denies_the_keychain_only_when_asked() {
    let home = tempfile::tempdir().unwrap();
    let keychains = home.path().join("Library").join("Keychains");
    std::fs::create_dir_all(&keychains).unwrap();
    assert_eq!(keychain_masks(Some(home.path())), vec![keychains.clone()]);
    assert!(keychain_masks(None).is_empty());

    let plan = parse_runner_args(&args(&[
        "--allow-delete",
        "--deny-keychain",
        "--mask",
        keychains.to_str().unwrap(),
        "--",
        "claude",
    ]))
    .unwrap();
    assert!(plan.deny_keychain);
    let profile = seatbelt_profile(&plan);
    assert!(profile.contains(&format!("(subpath {})", seatbelt_string(&keychains))));
    assert!(profile.contains(
        r#"(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc"))"#
    ));
    assert!(
        !profile.contains("trustd"),
        "certificate trust stays reachable"
    );

    // Without the option (an engine whose sign-in is in the Keychain, or
    // an unconfined agent) the Keychain daemons stay reachable.
    let kept = parse_runner_args(&args(&["--allow-delete", "--", "claude"])).unwrap();
    assert!(!kept.deny_keychain);
    assert!(!seatbelt_profile(&kept).contains("mach-lookup"));
    assert_eq!(
        seatbelt_profile(&kept),
        "(version 1) (allow default)",
        "nothing else is denied"
    );
}

#[test]
fn seatbelt_profile_hides_provider_store_folders_as_subpaths() {
    let root = tempfile::tempdir().unwrap();
    let pi_agent = root.path().join("pi-agent");
    std::fs::create_dir_all(&pi_agent).unwrap();
    let profile = seatbelt_profile(&RunnerPlan {
        masks: vec![pi_agent.clone()],
        ..RunnerPlan::default()
    });
    assert!(profile.contains(&format!("(subpath {})", seatbelt_string(&pi_agent))));
}
