use super::{
    launch_downloads_agent, refuse_untrusted_turns, untrusted_launch_refusal, AcpEvent, AcpTurn,
    AcpTurnConfig, WORKSPACE_TRUST_WARNING_FIELD,
};
use agent_client_protocol::schema::v1::McpServerStdio;
use tokio::sync::mpsc;

fn stdio(command: &str, args: &[&str]) -> McpServerStdio {
    McpServerStdio::new("agent", command).args(args.iter().map(|arg| (*arg).to_owned()).collect())
}

#[test]
fn package_runner_launches_are_refused_in_untrusted_folders() {
    for (command, args) in [
        (
            "npx",
            &["-y", "@agentclientprotocol/claude-agent-acp@latest"][..],
        ),
        ("/usr/local/bin/npx", &["-y", "pi-acp"][..]),
        ("bunx", &["codex-acp"][..]),
        ("pnpm", &["dlx", "some-acp"][..]),
        ("yarn", &["dlx", "some-acp"][..]),
        ("npm", &["exec", "--yes", "some-acp"][..]),
        ("uvx", &["some-acp"][..]),
        ("pipx", &["run", "some-acp"][..]),
        ("bun", &["x", "some-acp"][..]),
        ("uv", &["tool", "run", "some-acp"][..]),
        ("npx.cmd", &["-y", "some-acp"][..]),
    ] {
        let launch = stdio(command, args);
        assert!(launch_downloads_agent(&launch), "{command} {args:?}");
        let refusal = untrusted_launch_refusal(&launch)
            .unwrap_or_else(|| panic!("{command} {args:?} must be refused"));
        assert!(refusal.contains("trust this folder"), "{refusal}");
    }
}

#[test]
fn wrapped_and_renamed_package_runners_are_refused() {
    for (command, args) in [
        // Windows launcher names are case-insensitive.
        ("C:\\nodejs\\NPX.CMD", &["-y", "some-acp"][..]),
        ("Bunx.Exe", &["some-acp"][..]),
        ("npx.ps1", &["-y", "some-acp"][..]),
        ("npx.bat", &["-y", "some-acp"][..]),
        // env wrappers, with options and assignments.
        ("/usr/bin/env", &["npx", "-y", "some-acp"][..]),
        ("env", &["-i", "FOO=1", "npx", "-y", "some-acp"][..]),
        ("env", &["-u", "HOME", "--", "bunx", "some-acp"][..]),
        ("env", &["-S", "npx -y some-acp"][..]),
        // Shell command lines.
        ("sh", &["-c", "npx -y some-acp"][..]),
        (
            "/bin/bash",
            &["-lc", "cd x && FOO=1 exec npx -y some-acp"][..],
        ),
        ("zsh", &["-c", "true; /usr/local/bin/bunx some-acp"][..]),
        ("cmd", &["/c", "npx", "-y", "some-acp"][..]),
        ("cmd", &["/d", "/s", "/c", "set A=b&& npx -y some-acp"][..]),
        ("pwsh", &["-Command", "npx -y some-acp"][..]),
        // Other runners and runner subcommands.
        ("corepack", &["pnpm", "dlx", "some-acp"][..]),
        ("npm", &["x", "some-acp"][..]),
        ("pnpm", &["exec", "some-acp"][..]),
        ("deno", &["run", "-A", "npm:some-acp"][..]),
        ("deno", &["run", "jsr:@scope/some-acp"][..]),
        ("deno", &["run", "https://example.com/acp.ts"][..]),
        ("bun", &["--silent", "x", "some-acp"][..]),
        ("uv", &["--quiet", "tool", "run", "some-acp"][..]),
        ("nohup", &["npx", "-y", "some-acp"][..]),
    ] {
        let launch = stdio(command, args);
        assert!(
            untrusted_launch_refusal(&launch).is_some(),
            "{command} {args:?} must be refused"
        );
    }
}

#[test]
fn wrapped_installed_agents_still_start_sandboxed() {
    for (command, args) in [
        ("env", &["FOO=1", "node", "/home/u/agent.js"][..]),
        ("sh", &["-c", "exec node /home/u/agent.js --acp"][..]),
        ("cmd", &["/c", "hermes", "acp"][..]),
        ("deno", &["run", "-A", "agent.ts"][..]),
        ("sh", &["agent.sh"][..]),
    ] {
        assert!(
            untrusted_launch_refusal(&stdio(command, args)).is_none(),
            "{command} {args:?}"
        );
    }
}

#[test]
fn package_runner_is_seen_through_the_sandbox_runner() {
    let wrapped = stdio(
        "/opt/ryu/ryu-core",
        &[
            crate::agent_sandbox::AGENT_SANDBOX_RUNNER_ARG,
            "--",
            "npx",
            "-y",
            "@zed-industries/codex-acp",
        ],
    );
    assert!(untrusted_launch_refusal(&wrapped).is_some());
}

#[test]
fn installed_and_native_agents_still_start_sandboxed() {
    for (command, args) in [
        (
            "/usr/bin/node",
            &["/home/u/.ryu/runtime/acp-npm/x/bin.js"][..],
        ),
        ("claude", &["--acp"][..]),
        ("bun", &["run", "agent.ts"][..]),
        ("uv", &["run", "agent.py"][..]),
    ] {
        assert!(
            untrusted_launch_refusal(&stdio(command, args)).is_none(),
            "{command} {args:?}"
        );
    }
}

fn turn(events: mpsc::UnboundedSender<AcpEvent>) -> AcpTurn {
    AcpTurn {
        admission: Err("test"),
        prompt: String::new(),
        delta_prompt: String::new(),
        images: Vec::new(),
        turn: AcpTurnConfig::default(),
        mcp: None,
        allowlist: None,
        composio_actions: Vec::new(),
        agent_id: "acp:test".to_owned(),
        provider_account_identity: None,
        identity_profile_ids: Vec::new(),
        composio_connection_scope: None,
        conversation_scope: None,
        permission_scope_id: None,
        conversation_generation: None,
        events,
    }
}

#[tokio::test]
async fn a_refused_launch_answers_every_queued_turn() {
    let (turns_tx, turns_rx) = mpsc::unbounded_channel();
    let (first_tx, mut first_rx) = mpsc::unbounded_channel();
    let (second_tx, mut second_rx) = mpsc::unbounded_channel();
    turns_tx.send(turn(first_tx)).unwrap();
    turns_tx.send(turn(second_tx)).unwrap();
    let mut turns_rx = turns_rx;
    refuse_untrusted_turns(&mut turns_rx, "refused".to_owned()).await;
    drop(turns_rx);
    for events in [&mut first_rx, &mut second_rx] {
        match events.recv().await {
            Some(AcpEvent::ConfigWarning { field, message, .. }) => {
                assert_eq!(field, WORKSPACE_TRUST_WARNING_FIELD);
                assert_eq!(message, "refused");
            }
            other => panic!("expected the trust warning, got {other:?}"),
        }
        match events.recv().await {
            Some(AcpEvent::Error(failure)) => {
                assert_eq!(failure.code, "workspace_untrusted_launch");
                assert_eq!(failure.message, "refused");
            }
            other => panic!("expected the refusal, got {other:?}"),
        }
    }
    // The instance is gone: the pool sees a closed queue and respawns.
    assert!(turns_tx.is_closed());
}
