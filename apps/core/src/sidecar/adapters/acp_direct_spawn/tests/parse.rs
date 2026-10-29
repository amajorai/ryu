use super::*;

#[test]
fn parses_every_declared_npx_shape() {
    let windows_claude = from_spawn(
        "cmd /c set ANTHROPIC_BASE_URL=http://127.0.0.1:7981/anthropic&& npx -y @agentclientprotocol/claude-agent-acp@latest",
    );
    assert_eq!(
        parse_npx_invocation(&windows_claude),
        Some(NpxInvocation {
            env: vec![(
                "ANTHROPIC_BASE_URL".to_owned(),
                "http://127.0.0.1:7981/anthropic".to_owned()
            )],
            spec: "@agentclientprotocol/claude-agent-acp@latest".to_owned(),
            args: vec![],
        })
    );

    let managed_pi = stdio("cmd", &["/d", "/s", "/c", "npx -y pi-acp"]);
    assert_eq!(parse_npx_invocation(&managed_pi).unwrap().spec, "pi-acp");

    let quoted_set = from_spawn(
        r#"cmd /c set "CODEX_HOME=C:/Users/A B/.ryu/codex"&& npx -y @zed-industries/codex-acp"#,
    );
    let parsed = parse_npx_invocation(&quoted_set).unwrap();
    assert_eq!(parsed.env[0].1, "C:/Users/A B/.ryu/codex");
    assert_eq!(parsed.spec, "@zed-industries/codex-acp");

    let gemini = from_spawn("npx -y -- @google/gemini-cli@latest --experimental-acp");
    let parsed = parse_npx_invocation(&gemini).unwrap();
    assert_eq!(parsed.spec, "@google/gemini-cli@latest");
    assert_eq!(parsed.args, vec!["--experimental-acp".to_owned()]);
}

#[test]
fn leaves_non_npx_and_shell_pipelines_alone() {
    assert_eq!(parse_npx_invocation(&stdio("claude", &["--acp"])), None);
    assert_eq!(
        parse_npx_invocation(&stdio("cmd", &["/c", "hermes", "acp"])),
        None
    );
    assert_eq!(
        parse_npx_invocation(&stdio("npx", &["pi-acp"])),
        None,
        "no -y"
    );
    assert_eq!(
        parse_npx_invocation(&stdio("npx", &["--package", "x", "-y", "y"])),
        None,
        "unknown npx flag"
    );
    assert_eq!(
        parse_npx_invocation(&stdio("cmd", &["/c", "npx -y a && del x"])),
        None,
        "chained command"
    );
}

#[test]
fn package_names_and_latest_specs() {
    assert_eq!(package_name("@scope/pkg@1.2.3"), Some("@scope/pkg"));
    assert_eq!(package_name("pkg@latest"), Some("pkg"));
    assert_eq!(package_name("pkg"), Some("pkg"));
    assert_eq!(package_name("@scope"), None);
    assert!(spec_follows_latest("pkg"));
    assert!(spec_follows_latest("@s/pkg@latest"));
    assert!(!spec_follows_latest("@s/pkg@1.0.0"));
}
