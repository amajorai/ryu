use super::*;

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn cached_codex_launcher_retains_confinement_and_selected_environment() {
    // The entry basename comes from package.json, so it may be launcher.mjs;
    // the real direct-spawn resolver keeps its vendor package ancestry.
    let root = tempfile::tempdir().unwrap();
    for package in [
        "@agentclientprotocol/codex-acp",
        "@zed-industries/codex-acp",
    ] {
        let spec = format!("{package}@latest");
        fake_install(
            root.path(),
            &spec,
            100,
            serde_json::json!({"codex-acp":"dist/launcher.mjs"}),
            "dist/launcher.mjs",
        );
        let install = installed_bin(root.path(), &spec).expect("resolve the cached manifest entry");
        let mut original = from_spawn(&format!("npx -y {spec} --session proof"));
        original
            .env
            .push(EnvVariable::new("CODEX_HOME", "/selected/account-profile"));
        original.env.push(EnvVariable::new(
            "OPENAI_API_KEY",
            "fixture-scoped-inference-token",
        ));
        let invocation = parse_npx_invocation(&original).unwrap();
        let rewritten = rewrite(original, &invocation, Path::new("node"), &install);
        let confined = crate::agent_sandbox::confine_codex_stdio(rewritten)
            .expect("cached vendor launcher must retain the production OS boundary");
        assert_eq!(
            confined.args[0],
            crate::agent_sandbox::AGENT_SANDBOX_RUNNER_ARG
        );
        assert_eq!(confined.args[2], "node");
        assert_eq!(confined.args[3], process_path_argument(&install.bin));
        assert_eq!(&confined.args[4..], ["--session", "proof"]);
        assert!(confined
            .env
            .iter()
            .any(|entry| entry.name == "CODEX_HOME" && entry.value == "/selected/account-profile"));
        assert!(confined
            .env
            .iter()
            .any(|entry| entry.name == "OPENAI_API_KEY"
                && entry.value == "fixture-scoped-inference-token"));
    }
}

#[test]
fn codex_identity_does_not_depend_on_the_npx_confirmation_flag() {
    for spec in [
        "@zed-industries/codex-acp",
        "@agentclientprotocol/codex-acp@latest",
        "codex-acp",
    ] {
        let unconfirmed = McpServerStdio::new("agent", "npx").args(vec![spec.to_owned()]);
        assert!(crate::agent_sandbox::is_codex_stdio(&unconfirmed), "{spec}");
        // Launch rewriting still only accepts the declared `-y` shape.
        assert!(parse_npx_invocation(&unconfirmed).is_none(), "{spec}");
        let windows = McpServerStdio::new("agent", "cmd")
            .args(vec!["/c".to_owned(), format!("npx {spec} --acp")]);
        assert!(crate::agent_sandbox::is_codex_stdio(&windows), "{spec}");
        let confirmed =
            McpServerStdio::new("agent", "npx").args(vec!["--yes".to_owned(), spec.to_owned()]);
        assert!(crate::agent_sandbox::is_codex_stdio(&confirmed), "{spec}");
        assert!(parse_npx_invocation(&confirmed).is_some(), "{spec}");
    }
    for stdio in [
        McpServerStdio::new("agent", "npx").args(vec!["@fixture/native-acp".to_owned()]),
        McpServerStdio::new("agent", "npx").args(vec![
            "@fixture/native-acp".to_owned(),
            "codex-acp".to_owned(),
        ]),
    ] {
        assert!(!crate::agent_sandbox::is_codex_stdio(&stdio));
    }
}

#[test]
fn launch_rewrite_refusals_never_unclassify_codex() {
    // Each shape still starts Codex, but launch rewriting refuses it:
    // options it does not model, other runners or shells, and shell
    // operators after the spec. Refusing the rewrite must not skip the runner.
    for refused in [
        stdio("npx", &["--prefer-offline", "@zed-industries/codex-acp"]),
        stdio("npx", &["-p", "@zed-industries/codex-acp", "codex-acp"]),
        stdio("npx", &["--no", "codex-acp"]),
        stdio(
            "cmd",
            &["/c", "npx -y @zed-industries/codex-acp --acp & echo"],
        ),
        stdio(
            "cmd",
            &["/c", "npx -y @zed-industries/codex-acp --acp | more"],
        ),
        stdio(
            "cmd",
            &["/c", "npx -y @zed-industries/codex-acp > codex.log"],
        ),
        stdio("sh", &["-c", "npx -y @zed-industries/codex-acp"]),
        stdio("bunx", &["@zed-industries/codex-acp"]),
        stdio("pnpm", &["dlx", "@zed-industries/codex-acp"]),
    ] {
        assert_eq!(parse_npx_invocation(&refused), None, "{refused:?}");
        assert!(
            crate::agent_sandbox::is_codex_stdio(&refused),
            "{refused:?} starts Codex"
        );
    }
    // The declared shape is both rewritten and classified.
    let declared = stdio("cmd", &["/c", "npx -y @zed-industries/codex-acp --acp"]);
    assert!(parse_npx_invocation(&declared).is_some());
    assert!(crate::agent_sandbox::is_codex_stdio(&declared));
    // A refused non-Codex shape stays unclassified.
    let other = stdio(
        "cmd",
        &["/c", "npx -y @fixture/native-acp codex-acp & echo done"],
    );
    assert_eq!(parse_npx_invocation(&other), None);
    assert!(!crate::agent_sandbox::is_codex_stdio(&other));
}
