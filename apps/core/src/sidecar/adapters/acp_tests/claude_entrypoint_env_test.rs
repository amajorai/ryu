//! `CLAUDE_CODE_ENTRYPOINT` labeling for Claude Code ACP spawns.

use super::*;

fn spawned_entrypoint(env: Vec<EnvVariable>) -> Option<String> {
    let serialized = serde_json::to_string(&McpServer::Stdio(
        McpServerStdio::new("claude-agent-acp", "node")
            .args(vec!["dist/index.js".to_owned()])
            .env(env),
    ))
    .expect("structured ACP config serializes");
    let agent = acp_spawn_from_spawn(&serialized).expect("structured ACP parses");
    let McpServer::Stdio(stdio) = agent.into_server() else {
        panic!("expected stdio ACP process")
    };
    stdio
        .env
        .iter()
        .find(|entry| entry.name == crate::claude_config::CLAUDE_CODE_ENTRYPOINT_ENV)
        .map(|entry| entry.value.clone())
}

#[test]
fn claude_acp_spawn_applies_ryu_entrypoint_by_default() {
    assert_eq!(
        spawned_entrypoint(Vec::new()).as_deref(),
        Some(crate::claude_config::DEFAULT_CLAUDE_CODE_ENTRYPOINT)
    );
}

#[test]
fn claude_acp_spawn_honors_explicit_ryu_env_override() {
    assert_eq!(
        spawned_entrypoint(vec![EnvVariable::new(
            crate::claude_config::CLAUDE_CODE_ENTRYPOINT_ENV,
            "team-label".to_owned(),
        )])
        .as_deref(),
        Some("team-label")
    );
}

#[test]
fn claude_acp_spawn_replaces_inherited_sdk_cli_in_agent_env() {
    assert_eq!(
        spawned_entrypoint(vec![EnvVariable::new(
            crate::claude_config::CLAUDE_CODE_ENTRYPOINT_ENV,
            "sdk-cli".to_owned(),
        )])
        .as_deref(),
        Some(crate::claude_config::DEFAULT_CLAUDE_CODE_ENTRYPOINT)
    );
}

fn entrypoint_after(mut env: Vec<EnvVariable>) -> Option<String> {
    apply_claude_code_entrypoint(&mut env);
    env.iter()
        .find(|entry| entry.name == crate::claude_config::CLAUDE_CODE_ENTRYPOINT_ENV)
        .map(|entry| entry.value.clone())
}

#[test]
fn claude_entrypoint_reads_settings_json_under_the_home_folder() {
    let home = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir(home.path().join(".claude")).expect("create .claude");
    std::fs::write(
        home.path().join(".claude").join("settings.json"),
        r#"{"env":{"CLAUDE_CODE_ENTRYPOINT":"from-settings"}}"#,
    )
    .expect("write settings");
    let home_key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    // The masked (blank) inherited CLAUDE_CONFIG_DIR must count as unset.
    let env = vec![
        EnvVariable::new("CLAUDE_CONFIG_DIR", ""),
        EnvVariable::new(home_key, home.path().to_string_lossy().into_owned()),
        EnvVariable::new(crate::claude_config::CLAUDE_CODE_ENTRYPOINT_ENV, "sdk-cli"),
    ];
    assert_eq!(entrypoint_after(env).as_deref(), Some("from-settings"));
}

#[test]
fn claude_entrypoint_ignores_a_blank_config_dir_without_settings() {
    let empty = tempfile::tempdir().expect("tempdir");
    let home_key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let env = vec![
        EnvVariable::new("CLAUDE_CONFIG_DIR", ""),
        EnvVariable::new(home_key, empty.path().to_string_lossy().into_owned()),
        EnvVariable::new(
            crate::claude_config::CLAUDE_CODE_ENTRYPOINT_ENV,
            "claude-desktop",
        ),
    ];
    assert_eq!(
        entrypoint_after(env).as_deref(),
        Some(crate::claude_config::DEFAULT_CLAUDE_CODE_ENTRYPOINT)
    );
}
