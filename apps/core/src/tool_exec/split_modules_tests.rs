//! Direct tests for the modules split out of `tool_exec/mod.rs`. The broad
//! runtime suites live in `tests/`; these pin each module's own contract.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::json;

use super::{
    command_allowlist, command_tool, env_secrets, http_tool, secret_headers, workspace_paths,
};
use crate::plugin_manifest::schema::CommandOutput;

#[test]
fn the_command_allowlist_keeps_only_absolute_named_entries() {
    // Absolute on the host: a drive-less "/usr/bin/rg" is relative on Windows.
    let (rg, jq) = if cfg!(windows) {
        (r"C:\tools\rg.exe", r"C:\tools\jq.exe")
    } else {
        ("/usr/bin/rg", "/usr/bin/jq")
    };
    let map = command_allowlist::parse_command_allowlist(&format!(
        "rg={rg}; bad ;=/no/name, rel=bin/rel ,jq = {jq}"
    ));
    assert_eq!(
        map,
        BTreeMap::from([
            ("jq".to_string(), PathBuf::from(jq)),
            ("rg".to_string(), PathBuf::from(rg)),
        ])
    );
}

#[test]
fn a_command_argument_may_not_start_an_option() {
    let args = json!({ "q": "alpha", "flag": "-rf" });
    assert_eq!(
        command_allowlist::render_command_arg("--query={q}", &args).unwrap(),
        "--query=alpha"
    );
    let refused = command_allowlist::render_command_arg("{flag}", &args).unwrap_err();
    assert!(refused.contains("option-injection guard"), "{refused}");
    let missing = command_allowlist::render_command_arg("{absent}", &args).unwrap_err();
    assert!(missing.contains("missing argument 'absent'"), "{missing}");
}

#[tokio::test]
async fn an_ungranted_command_is_refused_before_anything_runs() {
    let refused = command_tool::run_command_tool_with_agent_and_workspace(
        "rg",
        &["{q}".to_string()],
        None,
        &BTreeMap::new(),
        None,
        5,
        CommandOutput::Stdout,
        None,
        &BTreeMap::new(),
        json!({ "q": "alpha" }),
        &HashSet::new(),
        "@ryu/ripgrep",
        None,
        None,
        None,
        &[],
        None,
    )
    .await
    .unwrap_err();
    assert!(refused.contains("is not granted"), "{refused}");
}

#[tokio::test]
async fn secret_headers_never_travel_over_plain_http() {
    let headers = BTreeMap::from([("Authorization".to_string(), "secret:API_KEY".to_string())]);
    let refused = http_tool::run_http_tool_with_secret_context(
        "http://example.test/search",
        "GET",
        json!({}),
        &[],
        &headers,
        false,
        false,
        &serde_json::Value::Null,
        &HashSet::new(),
        &[],
        "agent",
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert!(
        refused.contains("require an HTTPS destination"),
        "{refused}"
    );
}

#[test]
fn plugin_env_prefixes_escape_every_non_alphanumeric_byte() {
    assert_eq!(
        env_secrets::plugin_env_prefix("@ryu/web"),
        "RYU_PLUGIN__X40_RYU_X2F_WEB_"
    );
}

#[test]
fn core_urls_expand_against_the_loopback_origin_and_bind_port() {
    assert_eq!(
        secret_headers::resolve_core_url_with("core:/api/health", "http://127.0.0.1:7990"),
        "http://127.0.0.1:7990/api/health"
    );
    assert_eq!(
        secret_headers::resolve_core_url_with("https://example.test/a", "http://127.0.0.1:1"),
        "https://example.test/a"
    );
    assert_eq!(
        secret_headers::core_port_from_bind(Some("0.0.0.0:8123")),
        8123
    );
}

#[test]
fn a_path_is_within_its_root_but_not_a_sibling_prefix() {
    let root = Path::new("/work/app");
    assert!(workspace_paths::path_is_within(
        Path::new("/work/app"),
        root
    ));
    assert!(workspace_paths::path_is_within(
        Path::new("/work/app/src/a.rs"),
        root
    ));
    assert!(!workspace_paths::path_is_within(
        Path::new("/work/application"),
        root
    ));
}
