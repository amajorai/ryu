use super::*;

#[test]
fn non_codex_stdio_is_not_rewritten() {
    let stdio = McpServerStdio::new("safe-agent", "/usr/bin/echo");
    let confined = confine_codex_stdio(stdio.clone()).expect("non-Codex agent unchanged");
    assert_eq!(confined.command, stdio.command);
    assert_eq!(confined.args, stdio.args);
}

#[test]
fn unrelated_node_under_codex_directory_is_not_confined() {
    let stdio = McpServerStdio::new("native-discovery", "/opt/codex/runtime/node/bin/node")
        .args(vec!["/work/native-discovery.js".to_owned()]);
    let confined = confine_codex_stdio(stdio.clone()).expect("unrelated Node remains executable");
    assert_eq!(confined.command, stdio.command);
    assert_eq!(confined.args, stdio.args);
    assert!(is_codex_stdio(&McpServerStdio::new(
        "codex",
        "/opt/tools/codex-acp"
    )));
    assert!(is_codex_stdio(
        &McpServerStdio::new("codex", "/opt/node/bin/node").args(vec![
            "/work/node_modules/@zed-industries/codex-acp/dist/index.js".to_owned()
        ])
    ));
}

#[test]
fn classifier_uses_vendor_execution_identity_and_ignores_agent_input() {
    for package in [
        "@zed-industries/codex-acp",
        "@agentclientprotocol/codex-acp",
    ] {
        assert!(is_codex_stdio(
            &McpServerStdio::new("codex", "npx")
                .args(vec!["-y".into(), format!("{package}@latest")])
        ));
        assert!(is_codex_stdio(&McpServerStdio::new("codex", "node").args(
            vec![format!("/cache/node_modules/{package}/dist/index.js")]
        )));
    }
    for stdio in [
        McpServerStdio::new("other", "node").args(vec![
            "/cache/codex-acp-host/node_modules/@fixture/native-acp/index.js".into(),
            "--description=codex-acp".into(),
        ]),
        McpServerStdio::new("other", "npx").args(vec![
            "-y".into(),
            "@fixture/native-acp".into(),
            "--description=codex-acp".into(),
        ]),
    ] {
        assert!(!is_codex_stdio(&stdio));
    }
    assert!(is_codex_stdio(&McpServerStdio::new("codex", "cmd").args(
        vec![
            "/c".into(),
            "set CODEX_HOME=C:/Accounts/A&& npx -y @zed-industries/codex-acp".into()
        ]
    )));
    assert!(is_codex_stdio(&McpServerStdio::new("codex", "codex.exe")));
}

#[test]
fn package_runner_codex_launches_are_contained_in_any_shape() {
    let launches: [(&str, &[&str]); 8] = [
        ("npx", &["@agentclientprotocol/codex-acp"]),
        (
            "/usr/local/bin/npx",
            &["--yes", "@zed-industries/codex-acp@1.2.3"],
        ),
        ("bunx", &["codex-acp"]),
        ("pnpx", &["@zed-industries/codex-acp"]),
        ("npm", &["exec", "--", "@zed-industries/codex-acp"]),
        ("npx", &["--package=@zed-industries/codex-acp", "codex-acp"]),
        ("pnpm", &["dlx", "@agentclientprotocol/codex-acp"]),
        ("cmd", &["/c", "npx @zed-industries/codex-acp"]),
    ];
    for (command, args) in launches {
        let stdio = McpServerStdio::new("agent", command)
            .args(args.iter().map(|arg| (*arg).to_owned()).collect());
        assert!(is_codex_stdio(&stdio), "{command} {args:?}");
    }
    let not_codex: [(&str, &[&str]); 3] = [
        ("npx", &["@fixture/native-acp", "codex-acp"]),
        ("npm", &["install", "@zed-industries/codex-acp"]),
        ("bunx", &["@fixture/native-acp", "--package", "codex-acp"]),
    ];
    for (command, args) in not_codex {
        let stdio = McpServerStdio::new("agent", command)
            .args(args.iter().map(|arg| (*arg).to_owned()).collect());
        assert!(!is_codex_stdio(&stdio), "{command} {args:?}");
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn codex_stdio_uses_the_runner_marker() {
    let stdio = McpServerStdio::new("codex", "codex-acp").args(vec!["--version".to_owned()]);
    let confined = confine_codex_stdio(stdio).expect("supported host runner");
    assert_eq!(
        confined.command,
        std::env::current_exe().expect("current executable")
    );
    assert_eq!(confined.args[0], AGENT_SANDBOX_RUNNER_ARG);
    assert_eq!(confined.args[1], ARG_SEPARATOR);
    assert_eq!(confined.args[2], "codex-acp");
    assert_eq!(confined.args[3], "--version");
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn codex_identity_survives_generic_cached_bin() {
    let original =
        McpServerStdio::new("agent", "npx").args(vec!["@agentclientprotocol/codex-acp".into()]);
    let codex = is_codex_stdio(&original);
    let rewritten = McpServerStdio::new("agent", "node").args(vec!["/tmp/generic.js".into()]);
    assert!(!is_codex_stdio(&rewritten));
    let confined = confine_classified_codex_stdio(rewritten, codex).unwrap();
    assert_eq!(confined.args[0], AGENT_SANDBOX_RUNNER_ARG);
    assert_eq!(confined.args[2], "node");
    assert_eq!(confined.args[3], "/tmp/generic.js");
}

fn declared(command: &str, args: &[&str]) -> McpServerStdio {
    McpServerStdio::new("agent", command)
        .args(args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>())
}

#[test]
fn package_runner_options_and_variants_cannot_hide_the_codex_package() {
    // npm treats options it does not know as switches and assumes `--yes`
    // without a TTY, so every one of these starts Codex.
    for (command, args) in [
        (
            "npx",
            &["--prefer-offline", "@zed-industries/codex-acp"][..],
        ),
        ("npx", &["--no", "codex-acp"]),
        (
            "npx",
            &["-p", "@zed-industries/codex-acp", "codex-acp", "--acp"],
        ),
        (
            "npx",
            &["--package=@agentclientprotocol/codex-acp", "codex-acp"],
        ),
        (
            "npx",
            &[
                "--registry",
                "https://registry.example",
                "@zed-industries/codex-acp",
            ],
        ),
        ("npx", &["-c", "codex-acp --acp"]),
        ("npx", &["-y", "github:zed-industries/codex-acp"]),
        ("npx", &["-y", "agent@npm:@zed-industries/codex-acp@0.16.0"]),
        ("npx", &["-y", "@openai/codex"]),
        (
            r"C:\nodejs\npx.cmd",
            &["@agentclientprotocol/codex-acp@latest"],
        ),
        ("npm", &["exec", "--yes", "--", "@zed-industries/codex-acp"]),
        ("npm", &["--prefix", "/srv/agents", "x", "codex-acp"]),
        ("pnpm", &["dlx", "@zed-industries/codex-acp"]),
        ("pnpx", &["codex-acp"]),
        (
            "yarn",
            &["dlx", "-p", "@zed-industries/codex-acp", "codex-acp"],
        ),
        ("bunx", &["--bun", "@zed-industries/codex-acp"]),
        ("bun", &["x", "@agentclientprotocol/codex-acp"]),
        (
            "node",
            &[
                "--enable-source-maps",
                "/cache/node_modules/@zed-industries/codex-acp/dist/index.js",
            ],
        ),
    ] {
        assert!(
            is_codex_stdio(&declared(command, args)),
            "{command} {args:?} starts Codex and must be confined"
        );
    }
    // Words after the package the runner resolved are agent input.
    for (command, args) in [
        (
            "npx",
            &["--prefer-offline", "@fixture/native-acp", "codex-acp"][..],
        ),
        (
            "npx",
            &[
                "-y",
                "-p",
                "@fixture/native-acp",
                "native-acp",
                "--model",
                "codex-acp",
            ],
        ),
        (
            "npm",
            &[
                "exec",
                "--",
                "@fixture/native-acp",
                "@zed-industries/codex-acp",
            ],
        ),
        ("npm", &["view", "@zed-industries/codex-acp"]),
        ("bunx", &["@fixture/native-acp", "codex-acp"]),
        (
            "node",
            &["--enable-source-maps", "/work/native.js", "codex-acp"],
        ),
    ] {
        assert!(
            !is_codex_stdio(&declared(command, args)),
            "{command} {args:?} does not start Codex"
        );
    }
}

#[test]
fn shell_wrapped_codex_launches_are_classified_by_what_the_shell_runs() {
    for (command, args) in [
        (
            "cmd",
            &["/c", "npx -y @zed-industries/codex-acp --acp & echo"][..],
        ),
        (
            "cmd",
            &["/c", "echo ready & npx -y @zed-industries/codex-acp"],
        ),
        (
            "cmd.exe",
            &[
                "/d",
                "/s",
                "/c",
                r#"set "CODEX_HOME=C:\Users\A B\.ryu\codex"&& npx --prefer-offline @zed-industries/codex-acp"#,
            ],
        ),
        ("cmd", &["/c", r"C:\tools\codex-acp.exe --acp 2>&1"]),
        (
            "cmd",
            &[
                "/c",
                "set",
                "CODEX_HOME=C:/A&&",
                "npx",
                "-p",
                "@zed-industries/codex-acp",
                "codex-acp",
            ],
        ),
        ("sh", &["-c", "npx -y @zed-industries/codex-acp"]),
        (
            "/bin/bash",
            &[
                "-lc",
                "CODEX_HOME=/accounts/a exec npx @agentclientprotocol/codex-acp@latest",
            ],
        ),
        ("sh", &["-c", "echo ok; codex-acp --acp > /tmp/codex.log"]),
        (
            "sh",
            &[
                "-c",
                "node '/cache/node_modules/@zed-industries/codex-acp/dist/index.js'",
            ],
        ),
        (
            "sh",
            &["-c", r#"echo "$(npx -y @zed-industries/codex-acp)""#],
        ),
        (
            "sh",
            &["-c", r#"bash -c "pnpm dlx @zed-industries/codex-acp""#],
        ),
        (
            "env",
            &["CODEX_HOME=/accounts/a", "npx", "@zed-industries/codex-acp"],
        ),
        // A package or program the shell expands at launch cannot be
        // identified here, so it fails closed.
        ("sh", &["-c", r#"npx -y "$CODEX_PACKAGE""#]),
        ("cmd", &["/c", "npx -y %CODEX_PACKAGE%"]),
    ] {
        assert!(
            is_codex_stdio(&declared(command, args)),
            "{command} {args:?} starts Codex and must be confined"
        );
    }
    // Quoted text and agent input are data, not commands the shell runs.
    for (command, args) in [
        (
            "cmd",
            &[
                "/c",
                "npx -y @fixture/native-acp --name codex-acp & echo done",
            ][..],
        ),
        ("cmd", &["/c", "echo npx -y @zed-industries/codex-acp"]),
        (
            "sh",
            &["-c", "echo 'npx -y @zed-industries/codex-acp; codex-acp'"],
        ),
        (
            "sh",
            &["-c", "npx -y @fixture/native-acp --description=codex-acp"],
        ),
    ] {
        assert!(
            !is_codex_stdio(&declared(command, args)),
            "{command} {args:?} does not start Codex"
        );
    }
    // The confinement consumer wraps the whole original shell command line.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let script = "npx -y @zed-industries/codex-acp --acp & echo";
        let confined =
            confine_codex_stdio(declared("cmd", &["/c", script])).expect("supported host runner");
        assert_eq!(confined.args[0], AGENT_SANDBOX_RUNNER_ARG);
        assert_eq!(&confined.args[1..], [ARG_SEPARATOR, "cmd", "/c", script]);
    }
}

#[cfg(target_os = "windows")]
#[test]
fn windows_codex_spawn_fails_closed_without_native_runner() {
    let stdio = McpServerStdio::new("codex", "codex-acp");
    let error = confine_codex_stdio(stdio).expect_err("Windows must fail closed");
    assert!(error.to_string().contains("AppContainer"));
}

#[cfg(target_os = "macos")]
#[test]
fn mac_runner_is_available_without_running_a_deletion_command() {
    ensure_runner_supported().expect("macOS Seatbelt runner");
}
