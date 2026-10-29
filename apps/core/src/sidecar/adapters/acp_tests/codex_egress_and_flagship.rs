use super::*;

// ── Codex gateway egress injection (U28) ─────────────────────────────────

#[test]
fn codex_spawn_cmd_injects_gateway_base_url() {
    let _env_guard = crate::sidecar::gateway::lock_gateway_env();
    // codex_acp_cmd() must embed the gateway /v1 URL so that Codex routes
    // every outbound provider call through ryu-gateway, not directly to
    // OpenAI.  The test validates the URL is present regardless of whether
    // RYU_GATEWAY_URL is set (uses the default when absent).
    let cmd = codex_acp_cmd();
    let gateway_base = crate::sidecar::gateway::configured_gateway_url();
    let expected_v1 = format!("{}/v1", gateway_base.trim_end_matches('/'));
    assert!(
        cmd.contains(&expected_v1),
        "codex spawn cmd should contain the gateway /v1 URL, got: {cmd}"
    );
}

#[test]
fn agent_scoped_gateway_url_encodes_the_agent_segment() {
    let _env_guard = crate::sidecar::gateway::lock_gateway_env();
    let base = crate::sidecar::gateway::configured_gateway_url();
    let expected = format!("{}/v1/agents/agent%2Fone", base.trim_end_matches('/'));
    assert_eq!(openai_gateway_v1(Some("agent/one")).unwrap(), expected);
    assert_eq!(
        openai_gateway_v1(None).unwrap(),
        format!("{}/v1", base.trim_end_matches('/'))
    );
}

#[test]
fn remote_agent_route_proof_uses_core_only_signer() {
    // Same order as every other test (managed node, then Gateway): the
    // opposite order deadlocks against them under the parallel harness.
    let _managed_lock = crate::sidecar::gateway::lock_managed_node_env();
    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    struct Restore(Vec<(&'static str, Option<std::ffi::OsString>)>);
    impl Drop for Restore {
        fn drop(&mut self) {
            for (name, value) in self.0.drain(..) {
                unsafe {
                    if let Some(value) = value {
                        std::env::set_var(name, value);
                    } else {
                        std::env::remove_var(name);
                    }
                }
            }
        }
    }

    let names = [
        "RYU_GATEWAY_REMOTE",
        "RYU_MANAGED_NODE",
        "RYU_GATEWAY_MANAGED",
        "RYU_GATEWAY_URL",
        "RYU_GATEWAY_TOKEN",
        "RYU_GATEWAY_CORE_PROOF_KEY",
    ];
    let _restore = Restore(
        names
            .iter()
            .map(|name| (*name, std::env::var_os(name)))
            .collect(),
    );
    unsafe {
        std::env::set_var("RYU_GATEWAY_REMOTE", "1");
        std::env::set_var("RYU_MANAGED_NODE", "1");
        std::env::set_var("RYU_GATEWAY_MANAGED", "0");
        std::env::set_var("RYU_GATEWAY_URL", "https://gateway.example");
        std::env::set_var("RYU_GATEWAY_TOKEN", "rgw_org_relay_token_for_test");
        std::env::set_var("RYU_GATEWAY_CORE_PROOF_KEY", "gwproof_core_key_for_test");
    }

    let base = openai_gateway_v1(Some("agent-7")).unwrap();
    let proof = base.rsplit('/').next().expect("proof suffix");
    assert!(ryu_gw_credentials::verify_agent_route_proof(
        "gwproof_core_key_for_test",
        "rgw_org_relay_token_for_test",
        "agent-7",
        proof
    ));
    assert!(!ryu_gw_credentials::verify_agent_route_proof(
        "rgw_org_relay_token_for_test",
        "rgw_org_relay_token_for_test",
        "agent-7",
        proof
    ));
}

#[test]
fn remote_agent_gateway_url_fails_closed_without_the_core_proof_key() {
    // Same order as every other test (managed node, then Gateway): the
    // opposite order deadlocks against them under the parallel harness.
    let _managed_lock = crate::sidecar::gateway::lock_managed_node_env();
    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    struct Restore(Vec<(&'static str, Option<std::ffi::OsString>)>);
    impl Drop for Restore {
        fn drop(&mut self) {
            for (name, value) in self.0.drain(..) {
                unsafe {
                    if let Some(value) = value {
                        std::env::set_var(name, value);
                    } else {
                        std::env::remove_var(name);
                    }
                }
            }
        }
    }

    let names = [
        "RYU_GATEWAY_REMOTE",
        "RYU_MANAGED_NODE",
        "RYU_GATEWAY_MANAGED",
        "RYU_GATEWAY_URL",
        "RYU_GATEWAY_TOKEN",
        "RYU_GATEWAY_CORE_PROOF_KEY",
    ];
    let _restore = Restore(
        names
            .iter()
            .map(|name| (*name, std::env::var_os(name)))
            .collect(),
    );
    unsafe {
        std::env::set_var("RYU_GATEWAY_REMOTE", "1");
        std::env::set_var("RYU_MANAGED_NODE", "1");
        std::env::set_var("RYU_GATEWAY_MANAGED", "0");
        std::env::set_var("RYU_GATEWAY_URL", "https://gateway.example");
        std::env::set_var("RYU_GATEWAY_TOKEN", "rgw_org_relay_token_for_test");
        std::env::remove_var("RYU_GATEWAY_CORE_PROOF_KEY");
    }

    assert!(openai_gateway_v1(Some("agent-7")).is_err());
    assert_eq!(
        openai_gateway_v1(None).unwrap(),
        "https://gateway.example/v1"
    );
}

#[test]
fn codex_spawn_cmd_injects_api_key() {
    let _env_guard = crate::sidecar::gateway::lock_gateway_env();
    // The spawn cmd must set an OPENAI_API_KEY that the subprocess can
    // present to the gateway's auth layer (even if auth is disabled, the
    // key slot must be populated so the subprocess doesn't error out on
    // the missing-key guard).
    let cmd = codex_acp_cmd();
    assert!(
        cmd.contains("OPENAI_API_KEY"),
        "codex spawn cmd should set OPENAI_API_KEY for gateway auth, got: {cmd}"
    );
}

#[test]
fn codex_spawn_cmd_gateway_url_is_swappable() {
    let _env_guard = crate::sidecar::gateway::lock_gateway_env();
    // The injection must honour RYU_GATEWAY_URL — no hardcoded endpoint.
    let prev = std::env::var("RYU_GATEWAY_URL").ok();
    std::env::set_var("RYU_GATEWAY_URL", "http://test-gw.local:9999");
    let cmd = codex_acp_cmd();
    match prev {
        Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
        None => std::env::remove_var("RYU_GATEWAY_URL"),
    }
    assert!(
        cmd.contains("http://test-gw.local:9999/v1"),
        "codex spawn cmd should use RYU_GATEWAY_URL when set, got: {cmd}"
    );
}

#[test]
fn gateway_command_declarations_survive_startup_but_cannot_launch_before_readiness() {
    let _managed_lock = crate::sidecar::gateway::lock_managed_node_env();
    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    struct RestoreEnvironment(Vec<(&'static str, Option<std::ffi::OsString>)>);
    impl Drop for RestoreEnvironment {
        fn drop(&mut self) {
            for (name, previous) in &self.0 {
                match previous {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
    let _environment = RestoreEnvironment(
        [
            "RYU_GATEWAY_URL",
            "RYU_GATEWAY_MANAGED",
            "RYU_GATEWAY_REMOTE",
            "RYU_MANAGED_NODE",
            "RYU_ACP_DIRECT_SPAWN",
        ]
        .into_iter()
        .map(|name| (name, std::env::var_os(name)))
        .collect(),
    );
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:19871");
    std::env::set_var("RYU_GATEWAY_MANAGED", "1");
    std::env::set_var("RYU_GATEWAY_REMOTE", "0");
    std::env::set_var("RYU_MANAGED_NODE", "0");
    std::env::set_var("RYU_ACP_DIRECT_SPAWN", "0");
    let blocked = crate::sidecar::gateway::quarantine_for_test(true);
    let command = acp_stdio_spawn_json(
        "startup-fixture",
        PathBuf::from("security-no-executable"),
        vec![],
        vec![("OPENAI_BASE_URL".into(), openai_gateway_v1(None).unwrap())],
    )
    .unwrap();
    assert!(command.contains("http://127.0.0.1:19871/v1"));
    assert_eq!(crate::sidecar::gateway::gateway_url(), "http://127.0.0.1:0");
    let claude = claude_gateway_cmd(&npx_cmd("npx -y @zed-industries/claude-code-acp"));
    let codex = format!(
        "cmd /c set \"CODEX_HOME={}\"&& npx -y @zed-industries/codex-acp",
        crate::codex_config::codex_home().display()
    );
    for declaration in [&command, &claude, &codex] {
        let error = acp_agent_from_spawn(declaration)
            .err()
            .expect("quarantined process must not be prepared");
        assert!(
            error.to_string().contains("still verifying readiness"),
            "{error}"
        );
    }
    let cache_key = format!("gateway-startup-{}", uuid::Uuid::new_v4());
    let pending: anyhow::Result<serde_json::Value> = Err(GatewayStartupPending.into());
    store_probe_result(&cache_key, &pending);
    assert!(probe_cache::lookup(&cache_key).is_none());
    probe_cache::store(&cache_key, Ok(&serde_json::json!({"metadata":"retained"})));
    store_probe_result(&cache_key, &pending);
    assert_eq!(
        probe_cache::lookup(&cache_key).unwrap().outcome.unwrap()["metadata"],
        "retained"
    );
    let direct = acp_stdio_spawn_json(
        "direct-fixture",
        PathBuf::from("security-no-executable"),
        vec![],
        vec![(
            "OPENAI_BASE_URL".into(),
            "https://provider.example/v1".into(),
        )],
    )
    .unwrap();
    assert!(acp_agent_from_spawn(&direct).is_ok());
    drop(blocked);
    let _verified = crate::sidecar::gateway::quarantine_for_test(false);
    assert!(acp_agent_from_spawn(&command).is_ok(), "the declaration created during startup must work after readiness without retaining port zero");
}

// ── Ryu flagship agent (U042) ─────────────────────────────────────────────

#[test]
fn ryu_agent_is_present_in_registry() {
    let infos = AcpAgentRegistry::new().list_infos();
    let ryu = infos
        .iter()
        .find(|a| a.id == "ryu")
        .expect("ryu agent present");
    assert_eq!(ryu.transport.as_deref(), Some("acp"));
    // Ryu uses Pi as its engine; the id strip yields "ryu" (no "acp:" prefix).
    assert_eq!(ryu.engine.as_deref(), Some("ryu"));
}

#[test]
fn ryu_is_the_only_recommended_agent() {
    let infos = AcpAgentRegistry::new().list_infos();
    let recommended: Vec<&str> = infos
        .iter()
        .filter(|a| a.recommended == Some(true))
        .map(|a| a.id.as_str())
        .collect();
    assert_eq!(
        recommended,
        ["ryu"],
        "exactly one agent should be recommended: ryu"
    );
}

#[test]
fn ryu_pi_binding_is_read_from_registry_entry() {
    // AC4: the Ryu agent's engine binding must come from the Pi entry in the
    // AcpAgentRegistry, not be hardcoded. Finding acp:pi in the registry and
    // the ryu entry both present validates the swappable binding contract.
    let reg = AcpAgentRegistry::new();
    assert!(
        reg.find_by_prefix("acp:pi").is_some(),
        "Pi entry must exist in registry as the Ryu engine binding"
    );
    assert!(
        reg.find_by_prefix("ryu").is_some(),
        "Ryu entry must exist in registry"
    );
}

#[test]
fn headless_permission_routing_requires_a_clean_scan_and_a_trusted_workspace() {
    let shell = serde_json::json!({
        "kind": "execute",
        "rawInput": { "command": "./security.sh" }
    });
    let opaque_shell = serde_json::json!({ "kind": "execute", "rawInput": {} });
    let edit = serde_json::json!({ "kind": "edit", "rawInput": { "file_path": "/w/a.rs" } });
    let allow = ExecScanOutcome::Allow;
    let ask = ExecScanOutcome::ApprovalRequired("x".into());
    let deny = ExecScanOutcome::Deny("x".into());

    // Interactive: a person decides anything the scan does not deny.
    assert_eq!(
        route_permission(&allow, true, &shell, false),
        PermissionRoute::AskUser
    );
    assert_eq!(
        route_permission(&ask, true, &shell, true),
        PermissionRoute::AskUser
    );
    assert_eq!(
        route_permission(&deny, true, &shell, true),
        PermissionRoute::Reject
    );

    // Headless, trusted: only a readable, cleanly scanned command runs.
    assert_eq!(
        route_permission(&allow, false, &shell, true),
        PermissionRoute::AllowOnce
    );
    assert_eq!(
        route_permission(&ask, false, &shell, true),
        PermissionRoute::Reject
    );
    assert_eq!(
        route_permission(&allow, false, &opaque_shell, true),
        PermissionRoute::Reject,
        "a shell request Ryu could not read is not scanned clean"
    );
    assert_eq!(
        route_permission(&allow, false, &edit, true),
        PermissionRoute::AllowOnce
    );

    // Headless, untrusted: no shell request is auto-approved.
    assert_eq!(
        route_permission(&allow, false, &shell, false),
        PermissionRoute::Reject
    );
    assert_eq!(
        route_permission(&allow, false, &edit, false),
        PermissionRoute::AllowOnce
    );
}

#[test]
fn headless_choice_is_allow_once_never_allow_always() {
    let options = vec![
        PermissionOption::new("always", "Always allow", PermissionOptionKind::AllowAlways),
        PermissionOption::new("once", "Allow", PermissionOptionKind::AllowOnce),
        PermissionOption::new("reject", "Reject", PermissionOptionKind::RejectOnce),
    ];
    assert_eq!(
        headless_allow_once(&options),
        Some(PermissionOptionId::new("once"))
    );
    assert_eq!(headless_allow_once(&options[..1]), None);
}

#[test]
fn extract_exec_command_finds_command_shapes() {
    // Top-level command string.
    let tc = serde_json::json!({ "command": "rm -rf /tmp/x" });
    assert_eq!(extract_exec_command(&tc).as_deref(), Some("rm -rf /tmp/x"));
    // Nested under rawInput as an argv array.
    let tc = serde_json::json!({
        "kind": "execute",
        "rawInput": { "command": ["git", "push", "--force"] }
    });
    assert_eq!(
        extract_exec_command(&tc).as_deref(),
        Some("git push --force")
    );
    // Non-exec tool call (a file read) yields nothing to scan.
    let tc = serde_json::json!({ "kind": "read", "path": "/etc/hosts" });
    assert!(extract_exec_command(&tc).is_none());
    // Empty command string is treated as absent.
    let tc = serde_json::json!({ "command": "   " });
    assert!(extract_exec_command(&tc).is_none());
}

#[test]
fn extract_file_write_finds_write_shapes_not_reads() {
    // Write tool: file_path + content → synthesized "write <path>".
    let tc = serde_json::json!({ "file_path": "/home/u/.ssh/authorized_keys", "content": "x" });
    assert_eq!(
        extract_file_write(&tc).as_deref(),
        Some("write /home/u/.ssh/authorized_keys")
    );
    // Edit tool nested under rawInput: file_path + new_string.
    let tc = serde_json::json!({
        "kind": "edit",
        "rawInput": { "file_path": "/etc/hosts", "old_string": "a", "new_string": "b" }
    });
    assert_eq!(extract_file_write(&tc).as_deref(), Some("write /etc/hosts"));
    // A read (path but NO mutating payload) is NOT treated as a write.
    let tc = serde_json::json!({ "kind": "read", "path": "/etc/hosts" });
    assert!(extract_file_write(&tc).is_none());
    // A shell exec (has a command, no file payload) is out of scope here.
    let tc = serde_json::json!({ "command": "ls" });
    assert!(extract_file_write(&tc).is_none());
}

#[tokio::test]
async fn acp_patch_deletion_is_denied_before_gateway_scan() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let tool_call = serde_json::json!({
        "kind": "edit",
        "rawInput": { "command": "*** Delete File: src/old.ts\n" }
    });
    let outcome = acp_exec_scan_verdict(&tool_call, "acp:codex").await;
    assert!(
        matches!(&outcome, ExecScanOutcome::Deny(reason) if reason.contains("apply_patch")),
        "ACP file deletion must be denied before any gateway fallback: {outcome:?}"
    );

    let nested_patch = serde_json::json!({
        "kind": "edit",
        "rawInput": { "patch": "*** Delete File: src/nested-old.ts\n" }
    });
    let nested_outcome = acp_exec_scan_verdict(&nested_patch, "acp:codex").await;
    assert!(
        matches!(&nested_outcome, ExecScanOutcome::Deny(reason) if reason.contains("apply_patch")),
        "nested apply_patch deletion must be denied before any gateway fallback: {nested_outcome:?}"
    );
}
