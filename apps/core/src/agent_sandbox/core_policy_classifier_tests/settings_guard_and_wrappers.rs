use super::*;

/// The settings guard and the spawn-time classifier must agree: a custom Codex
/// command the guard admits is classified at the ACP spawn seam (classify the
/// declaration, resolve direct spawn, then confine) and launched by the runner.
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn custom_codex_commands_admitted_by_the_settings_guard_take_the_runner() {
    use crate::acp_agent_settings::{launch_overrides, AcpAgentKind, AcpAgentSettings};
    use agent_client_protocol::schema::v1::McpServer;
    use std::str::FromStr;

    let declared_spawn = "npx -y @agentclientprotocol/codex-acp@latest";
    assert_eq!(AcpAgentKind::of_spawn(declared_spawn), AcpAgentKind::Codex);
    for command in [
        "/opt/bin/codex-acp.sh",
        "/opt/bin/codex-wrapper",
        "/opt/bin/codex-acp-0.16.0-x86_64-unknown-linux-gnu",
    ] {
        let settings: AcpAgentSettings = serde_json::from_value(serde_json::json!({
            "command": command,
            "args": ["--acp"],
        }))
        .unwrap();
        let launch = launch_overrides(&settings, AcpAgentKind::Codex)
            .unwrap_or_else(|error| panic!("the guard admits {command}: {error}"));
        let spawn = crate::sidecar::adapters::acp::acp_spawn_with_overrides(
            declared_spawn,
            &launch,
            Some("codex-acp"),
        )
        .unwrap();
        // Parse the stored declaration the way the ACP spawn path does.
        let agent = crate::sidecar::adapters::acp_spawn::AcpSpawn::from_str(&spawn).unwrap();
        let McpServer::Stdio(stdio) = agent.into_server() else {
            panic!("custom Codex command must stay a stdio launch");
        };
        let codex = is_codex_stdio(&stdio);
        let stdio = crate::sidecar::adapters::acp_direct_spawn::resolve_direct_stdio(stdio);
        let confined = confine_classified_codex_stdio(stdio, codex).unwrap();
        assert_eq!(
            confined.command,
            std::env::current_exe().unwrap(),
            "{command} escaped the runner"
        );
        assert_eq!(
            confined.args,
            [AGENT_SANDBOX_RUNNER_ARG, ARG_SEPARATOR, command, "--acp"],
            "{command}"
        );
    }
    // A renamed program is still refused by the guard, before any launch.
    let renamed: AcpAgentSettings =
        serde_json::from_value(serde_json::json!({ "command": "/opt/bin/agent.sh" })).unwrap();
    assert!(launch_overrides(&renamed, AcpAgentKind::Codex).is_err());
}

#[test]
fn launch_wrappers_loops_and_inline_interpreters_cannot_hide_codex() {
    for (command, args) in [
        // Launchers that run their command operand.
        ("stdbuf", &["-oL", "codex-acp", "--acp"][..]),
        ("stdbuf", &["-o", "L", "codex-acp", "--acp"]),
        ("timeout", &["30", "codex-acp", "--acp"]),
        ("timeout", &["-k", "5", "30s", "codex-acp", "--acp"]),
        // PowerShell process launch, loop bodies and try/catch/finally bodies.
        (
            "pwsh",
            &["-Command", "Start-Process codex-acp -NoNewWindow -Wait"],
        ),
        (
            "pwsh",
            &["-Command", "Start-Process -FilePath codex-acp -NoNewWindow"],
        ),
        (
            "pwsh",
            &["-Command", "foreach ($x in 1) { codex-acp --acp }"],
        ),
        ("pwsh", &["-Command", "try { codex-acp --acp } finally { }"]),
        (
            "pwsh",
            &["-Command", "try { echo } catch { codex-acp --acp }"],
        ),
        // Inline interpreter programs are not read, so they count as Codex.
        (
            "node",
            &[
                "-e",
                "require('node:child_process').spawnSync('codex-acp',{stdio:'inherit'})",
            ],
        ),
        ("ruby", &["-e", r#"exec "codex-acp", "--acp""#]),
        ("ruby", &["-w", "-rjson", "-e", "exec 'codex-acp'"]),
        ("ruby", &["-I", "lib", "-e", "exec 'codex-acp'"]),
        ("ruby3.3", &["-we", "exec 'codex-acp'"]),
        ("ruby", &["-"]),
        ("ruby", &[]),
        ("perl", &["-e", "exec 'codex-acp'"]),
        ("perl", &["-E", "exec 'codex-acp'"]),
        ("perl", &["-lne", "exec 'codex-acp'"]),
        ("/usr/bin/perl", &["-Mstrict", "-e", "exec 'codex-acp'"]),
        ("perl", &["-0777", "-ne", "exec 'codex-acp'"]),
    ] {
        assert_confined(declared(command, args));
    }
    for (command, args) in [
        ("ruby", &["server.rb", "-e", "codex-acp"][..]),
        ("ruby", &["-w", "-rjson", "/srv/agent/server.rb"]),
        ("ruby", &["-I", "lib", "server.rb"]),
        ("ruby", &["--version"]),
        ("perl", &["-I", "lib", "server.pl"]),
        ("perl", &["-Ilib", "-w", "server.pl", "-e"]),
        ("perl", &["-v"]),
        ("timeout", &["30", "native-acp", "--acp"]),
        ("stdbuf", &["-oL", "native-acp"]),
    ] {
        assert_unconfined(declared(command, args));
    }
}
