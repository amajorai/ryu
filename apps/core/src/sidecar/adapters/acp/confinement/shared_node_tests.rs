//! The engine sandbox on a shared node (finding CE-35). A turn the node bounds
//! is never started without the sandbox, and folder trust does not lift it. A
//! personal node keeps what it had. The probe's answer is handed in, so every
//! test runs on any host; where a test depends on whether this host can really
//! wrap an engine, it accepts both outcomes and says which is which.

use super::*;
use crate::agent_access::AccountConfinement;

fn engine(command: &str, args: &[&str], env: &[(&str, &str)]) -> McpServerStdio {
    McpServerStdio::new("agent", command)
        .args(args.iter().map(|arg| (*arg).to_owned()).collect())
        .env(
            env.iter()
                .map(|(name, value)| {
                    agent_client_protocol::schema::v1::EnvVariable::new(*name, *value)
                })
                .collect(),
        )
}

fn no_sandbox() -> Result<(), String> {
    Err("no sandbox on this test host".to_owned())
}

/// One launch decision. `Err` carries the refusal's Debug text, which starts
/// with its variant name.
async fn launch(
    stdio: McpServerStdio,
    is_managed_pi: bool,
    trusted: bool,
    account: AccountConfinement,
    bounded: bool,
    support: Result<(), String>,
) -> Result<(McpServerStdio, Option<String>), String> {
    let cwd = std::env::temp_dir().join("ryu-shared-node-work");
    confine_for_agent(
        stdio,
        is_managed_pi,
        false,
        trusted,
        account,
        &cwd,
        &[],
        bounded,
        move || support,
    )
    .await
    .map_err(|refusal| format!("{refusal:?}"))
}

fn as_it_was(launched: &McpServerStdio, original: &McpServerStdio) -> bool {
    launched.command == original.command && launched.args == original.args
}

#[tokio::test]
async fn a_personal_node_runs_an_untrusted_folder_with_the_notice_when_the_host_cannot_sandbox() {
    let original = engine("claude-agent-acp", &[], &[]);
    let (launched, notice) = launch(
        original.clone(),
        false,
        false,
        AccountConfinement::None,
        false,
        no_sandbox(),
    )
    .await
    .expect("a personal node still starts the engine");
    assert!(as_it_was(&launched, &original));
    let notice = notice.expect("the notice says the agent is not sandboxed");
    assert!(
        notice.contains("could not sandbox the agent on this computer"),
        "{notice}"
    );
    assert!(notice.contains("no sandbox on this test host"), "{notice}");
}

/// The probe says yes, the wrap itself decides. A host that cannot wrap runs
/// the engine with the notice; a host that can wraps it. Never a refusal.
#[tokio::test]
async fn a_personal_node_runs_an_untrusted_folder_when_the_wrap_fails() {
    let original = engine("claude-agent-acp", &[], &[]);
    let (launched, notice) = launch(
        original.clone(),
        false,
        false,
        AccountConfinement::None,
        false,
        Ok(()),
    )
    .await
    .expect("a personal node still starts the engine");
    let notice = notice.expect("an untrusted folder always has a notice");
    if as_it_was(&launched, &original) {
        assert!(notice.contains("so it runs without one"), "{notice}");
    } else {
        assert!(notice.contains("runs in a sandbox"), "{notice}");
        assert!(notice.contains("Trust the folder"), "{notice}");
    }
}

#[test]
fn a_personal_node_keeps_the_keychain_rule_of_the_account() {
    assert!(!turn_denies_keychain(AccountConfinement::None, true, false));
    assert!(!turn_denies_keychain(
        AccountConfinement::None,
        false,
        false
    ));
    assert!(turn_denies_keychain(
        AccountConfinement::CoreState,
        false,
        false
    ));
    assert!(!turn_denies_keychain(
        AccountConfinement::CoreState,
        true,
        false
    ));
}

#[test]
fn a_personal_node_profile_does_not_add_the_keychain_files() {
    let home = std::env::temp_dir().join("ryu-shared-node-home");
    let masks = untrusted_profile_masks(Some(&home), None, &[], false);
    assert!(
        !masks.contains(&home.join("Library").join("Keychains")),
        "{masks:?}"
    );
    assert!(masks.contains(&home.join(".ssh")), "{masks:?}");
}

// ---- the shared node rule: every test below fails on the commit before the fix ----

/// The probe said no. The refusal carries the probe's own reason, the one
/// text of the host a member of a shared node is shown.
fn assert_shared_node_refusal(refusal: &str, reason: &str) {
    assert_eq!(refusal, format!("SharedNode(Some({reason:?}))"));
}

/// A step after the probe failed (the wrap here; on Unix also the loopback
/// relay, through the same closure). The refusal carries nothing of that
/// step's error chain, which can name paths of the host: the member is shown
/// a fixed sentence and the chain stays in the log.
fn assert_shared_node_refusal_without_host_text(refusal: &str) {
    assert_eq!(refusal, "SharedNode(None)");
}

#[tokio::test]
async fn a_bounded_turn_is_refused_when_the_host_cannot_sandbox() {
    let refusal = match launch(
        engine("claude-agent-acp", &[], &[]),
        false,
        false,
        AccountConfinement::None,
        true,
        no_sandbox(),
    )
    .await
    {
        Ok((_, notice)) => panic!("the engine was started unsandboxed, notice {notice:?}"),
        Err(refusal) => refusal,
    };
    assert_shared_node_refusal(&refusal, "no sandbox on this test host");
}

#[tokio::test]
async fn a_bounded_turn_in_a_trusted_folder_is_refused_when_the_host_cannot_sandbox() {
    let refusal = match launch(
        engine("claude-agent-acp", &[], &[]),
        false,
        true,
        AccountConfinement::None,
        true,
        no_sandbox(),
    )
    .await
    {
        Ok((_, notice)) => panic!("folder trust lifted the sandbox, notice {notice:?}"),
        Err(refusal) => refusal,
    };
    assert_shared_node_refusal(&refusal, "no sandbox on this test host");
}

/// The probe says yes. On a host that can wrap, the engine is wrapped and the
/// notice is the shared node's; on a host that cannot, the launch is refused.
/// In neither case is the engine returned as it was, and the refusal carries
/// nothing of the wrap's error.
#[tokio::test]
async fn a_bounded_turn_in_a_trusted_folder_gets_the_untrusted_profile() {
    let original = engine("claude-agent-acp", &[], &[]);
    match launch(
        original.clone(),
        false,
        true,
        AccountConfinement::None,
        true,
        Ok(()),
    )
    .await
    {
        Ok((launched, notice)) => {
            assert!(
                !as_it_was(&launched, &original),
                "the engine is not wrapped"
            );
            let notice = notice.expect("a bounded turn always has a notice");
            assert!(notice.contains("This node is shared"), "{notice}");
            assert!(!notice.contains("Trust the folder"), "{notice}");
        }
        Err(refusal) => assert_shared_node_refusal_without_host_text(&refusal),
    }
}

#[tokio::test]
async fn a_bounded_turn_in_a_trusted_folder_refuses_a_package_runner() {
    let refusal = match launch(
        engine("npx", &["-y", "some-agent-acp"], &[]),
        false,
        true,
        AccountConfinement::None,
        true,
        Ok(()),
    )
    .await
    {
        Ok((_, notice)) => panic!("a package runner was started, notice {notice:?}"),
        Err(refusal) => refusal,
    };
    assert!(refusal.starts_with("Untrusted("), "{refusal}");
}

/// The wrap itself fails (or works) after the probe said yes, in a folder that
/// is not trusted. A bounded turn is refused or wrapped, never run as it was.
/// The refusal carries nothing of the wrap's error.
#[tokio::test]
async fn a_wrap_failure_refuses_a_bounded_turn() {
    let original = engine("claude-agent-acp", &[], &[]);
    match launch(
        original.clone(),
        false,
        false,
        AccountConfinement::None,
        true,
        Ok(()),
    )
    .await
    {
        Ok((launched, notice)) => {
            assert!(
                !as_it_was(&launched, &original),
                "the engine is not wrapped"
            );
            let notice = notice.expect("a bounded turn always has a notice");
            assert!(notice.contains("This node is shared"), "{notice}");
        }
        Err(refusal) => assert_shared_node_refusal_without_host_text(&refusal),
    }
}

/// Ryu's own engine on its brokered tools only is the one engine a personal
/// node runs without the sandbox for a limited agent. A bounded turn gets no
/// such exception, with or without an account limit.
#[test]
fn ryus_own_engine_gets_no_exception_on_a_bounded_turn() {
    // The outcomes are collected inside and judged outside: a panic inside
    // would leave the Pi config dir of the test set for the tests after it.
    let mut outcomes = Vec::new();
    crate::pi_config::tests::with_temp_dir(|| {
        let own = crate::pi_config::limited_agent_dir(Some("agent-a"));
        let brokered = RYU_MCP_PI_TOOLS.join(",");
        let pi = engine(
            "pi-acp",
            &[],
            &[
                ("PI_CODING_AGENT_DIR", own.to_str().unwrap()),
                (PI_ACTIVE_TOOLS_ENV, brokered.as_str()),
            ],
        );
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for account in [
            AccountConfinement::None,
            AccountConfinement::CoreStateAndProviders,
        ] {
            let outcome =
                runtime.block_on(launch(pi.clone(), true, false, account, true, no_sandbox()));
            outcomes.push((account, outcome));
        }
    });
    assert_eq!(outcomes.len(), 2);
    for (account, outcome) in outcomes {
        let refusal = match outcome {
            Ok((_, notice)) => {
                panic!("{account:?}: Ryu's engine ran unsandboxed, notice {notice:?}")
            }
            Err(refusal) => refusal,
        };
        assert_shared_node_refusal(&refusal, "no sandbox on this test host");
    }
}

#[test]
fn a_bounded_turn_is_denied_the_keychain_claude_code_included() {
    assert!(turn_denies_keychain(AccountConfinement::None, true, true));
    assert!(turn_denies_keychain(AccountConfinement::None, false, true));
    assert!(turn_denies_keychain(
        AccountConfinement::CoreState,
        true,
        true
    ));
}

#[test]
fn a_bounded_turn_hides_the_keychain_files() {
    let home = std::env::temp_dir().join("ryu-shared-node-home");
    let masks = untrusted_profile_masks(Some(&home), None, &[], true);
    assert!(
        masks.contains(&home.join("Library").join("Keychains")),
        "{masks:?}"
    );
}

/// An agent whose spawn text declares a server that is not stdio starts no
/// program, so there is nothing Ryu could sandbox. A personal node passes it
/// on as before (its one consumer answers it with an error). A node that
/// bounds its turns (here a managed node that is not registered yet) refuses
/// it at the launch, by rule: no server comes back.
#[tokio::test]
async fn a_server_that_is_not_stdio_is_refused_on_a_shared_node() {
    let declared = McpServer::Http(agent_client_protocol::schema::v1::McpServerHttp::new(
        "remote",
        "http://127.0.0.1:9/acp",
    ));
    let spawn = serde_json::to_string(&declared).unwrap();
    let cwd = std::env::temp_dir().join("ryu-shared-node-work");
    let autonomy = WorkspaceAutonomy {
        trusted: true,
        is_claude_code: false,
    };
    let mut servers = Vec::new();
    for managed in [false, true] {
        // Never dropped: its Drop starts a thread that looks through the
        // processes of the computer for this instance's, and none was started.
        let tree = std::mem::ManuallyDrop::new(crate::acp_runtime::AcpProcessTree::new());
        // No turn is queued and the sender is gone, so the refusal has no
        // turn to wait for.
        let (turns, mut turns_rx) = mpsc::unbounded_channel::<AcpTurn>();
        drop(turns);
        let launched = crate::sidecar::control_plane::with_test_node_binding(
            managed,
            None,
            launch_agent_server(
                &spawn,
                Vec::new(),
                &tree,
                false,
                &None,
                &None,
                &None,
                &mut turns_rx,
                AccountConfinement::None,
                false,
                &autonomy,
                &cwd,
                &Vec::new(),
                "agent-a",
            ),
        )
        .await
        .expect("a server that is not stdio is not a launch error");
        servers.push(launched.map(|launched| launched.server));
    }
    assert!(
        matches!(servers[0], Some(McpServer::Http(_))),
        "a personal node passes the server on: {:?}",
        servers[0]
    );
    assert_eq!(
        servers[1], None,
        "a shared node passed on a server Ryu cannot sandbox"
    );
}
