//! A command tool's declared broker service scope (`vault:broker:<service>`
//! grants) in the governed command runner.

use super::*;
use crate::plugin_manifest::schema::CommandOutput;

fn grants(items: &[&str]) -> std::collections::HashSet<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

async fn run(
    bin: &str,
    egress_url_arg: Option<&str>,
    granted: &std::collections::HashSet<String>,
) -> Result<Value, String> {
    let version = crate::plugin_manifest::schema::CommandBinVersion {
        args: None,
        pattern: "spider {version}".into(),
        requirement: ">=1".into(),
        install_hint: None,
    };
    run_command_tool_with_agent_and_workspace(
        bin,
        &[],
        None,
        &BTreeMap::new(),
        None,
        10,
        CommandOutput::Stdout,
        egress_url_arg,
        &BTreeMap::new(),
        serde_json::json!({}),
        granted,
        "@ryu/broker-scope-test",
        None,
        None,
        None,
        &[],
        egress_url_arg.map(|_| &version),
    )
    .await
}

#[tokio::test]
async fn a_scope_and_an_egress_url_arg_are_refused_before_any_io() {
    let error = run(
        "spider",
        Some("url"),
        &grants(&["tool:command:spider", "vault:broker:github"]),
    )
    .await
    .expect_err("refused");
    // Refused before the binary is resolved, probed or spawned.
    assert!(error.contains("broker service scope"), "{error}");
}

#[cfg(unix)]
#[tokio::test]
async fn a_scope_the_broker_cannot_honour_never_spawns_the_child() {
    use std::os::unix::fs::PermissionsExt;
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let saved: Vec<(&str, Option<String>)> = [
        "RYU_GATEWAY_URL",
        "RYU_ALLOW_GATEWAY_FALLBACK",
        "RYU_EXEC_APPROVAL_MODE",
        ENV_COMMAND_TOOL_ALLOWLIST,
    ]
    .into_iter()
    .map(|name| (name, std::env::var(name).ok()))
    .collect();
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("ran");
    let script = temp.path().join("probe.sh");
    std::fs::write(
        &script,
        format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", "1");
    std::env::set_var("RYU_EXEC_APPROVAL_MODE", "off");
    std::env::set_var(
        ENV_COMMAND_TOOL_ALLOWLIST,
        format!("probe={}", script.display()),
    );

    // Without a scope the probe runs, so the setup is sound.
    let plain = run("probe", None, &grants(&["tool:command:probe"])).await;
    let ran_plain = marker.exists();
    let _ = std::fs::remove_file(&marker);
    // With a scope and no broker listener in this process, it must not.
    let scoped = run(
        "probe",
        None,
        &grants(&["tool:command:probe", "vault:broker:github"]),
    )
    .await;
    let ran_scoped = marker.exists();
    for (name, value) in saved {
        match value {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }

    assert!(plain.is_ok(), "{plain:?}");
    assert!(ran_plain, "the unscoped probe should run");
    let scoped = scoped.expect("degrades, not errors");
    assert_eq!(scoped["available"], false, "{scoped}");
    let reason = scoped["reason"].as_str().unwrap_or_default();
    assert!(reason.contains("broker"), "{reason}");
    assert!(
        !ran_scoped,
        "a scope the broker cannot honour must not spawn"
    );
}

#[test]
fn the_broker_proxy_env_replaces_every_case_variant() {
    let mut child: BTreeMap<String, String> = [
        ("Https_Proxy", "http://elsewhere:1"),
        ("no_proxy", "*"),
        ("KEEP", "me"),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_owned(), value.to_owned()))
    .collect();
    let broker: BTreeMap<String, String> = [
        ("HTTPS_PROXY", "http://rvb:rvb_x@127.0.0.1:9"),
        ("https_proxy", "http://rvb:rvb_x@127.0.0.1:9"),
        ("NO_PROXY", "localhost,127.0.0.1,::1"),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_owned(), value.to_owned()))
    .collect();
    apply_proxy_env(&mut child, &broker);
    assert!(!child.contains_key("Https_Proxy"));
    assert!(!child.contains_key("no_proxy"));
    assert_eq!(child["HTTPS_PROXY"], "http://rvb:rvb_x@127.0.0.1:9");
    assert_eq!(child["https_proxy"], "http://rvb:rvb_x@127.0.0.1:9");
    assert_eq!(child["NO_PROXY"], "localhost,127.0.0.1,::1");
    assert_eq!(child["KEEP"], "me");
}

#[tokio::test]
async fn an_agent_whose_access_cannot_be_read_gets_no_broker_session() {
    let scope = vec!["github".to_owned()];
    let refusal = broker_session("@ryu/broker-scope-test", &scope, Some("agent-x"), 10)
        .await
        .expect_err("fails closed");
    if crate::agents::global().is_none() {
        assert!(refusal.contains("limited"), "{refusal}");
    }
    // No scope: nothing to lease, whoever calls.
    assert!(
        broker_session("@ryu/broker-scope-test", &[], Some("agent-x"), 10)
            .await
            .unwrap()
            .is_none()
    );
}
