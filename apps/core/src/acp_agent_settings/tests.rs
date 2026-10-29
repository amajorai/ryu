use std::path::{Path, PathBuf};

use super::*;

#[test]
fn only_the_claude_code_adapter_itself_counts_as_claude_code() {
    let launches = |program: &str, args: &[&str]| {
        launches_claude_code_acp(Path::new(program), args.iter().copied())
    };
    assert!(launches(
        "npx",
        &["-y", "@agentclientprotocol/claude-agent-acp@latest"]
    ));
    assert!(launches("npx", &["@zed-industries/claude-code-acp"]));
    assert!(launches(
        "cmd",
        &[
            "/c",
            "set",
            "A=b&&",
            "npx",
            "-y",
            "@agentclientprotocol/claude-agent-acp"
        ]
    ));
    assert!(launches(
        "/usr/bin/node",
        &["/r/acp-npm/x/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"]
    ));
    assert!(launches("/opt/bin/claude-agent-acp", &["--verbose"]));
    assert!(launches("C:/tools/Claude-Agent-ACP.exe", &[]));

    // Programs that only mention the adapter do not get its exception.
    assert!(!launches("sh", &["-c", "exec claude-agent-acp"]));
    assert!(!launches("/home/me/claude-agent-acp-wrapper.sh", &[]));
    assert!(!launches("bash", &["/home/me/run.sh", "claude-agent-acp"]));
    assert!(!launches(
        "npx",
        &["-y", "evil", "@agentclientprotocol/claude-agent-acp"]
    ));
    assert!(!launches(
        "npx",
        &["@agentclientprotocol/claude-agent-acp-evil"]
    ));
    assert!(!launches("node", &["/tmp/claude-agent-acp/index.js"]));
    assert!(!launches("python3", &["@zed-industries/claude-code-acp"]));
}

fn settings(value: Value) -> AcpAgentSettings {
    serde_json::from_value::<AcpAgentSettings>(value)
        .expect("settings parse")
        .normalized()
}

#[test]
fn map_is_keyed_per_agent_and_lookup_prefers_the_most_specific_key() {
    let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    set_from_json(
        r#"{"acp:claude": {"args": ["--verbose"]},
            "my-claude": {"defaultModel": "opus"},
            "empty": {},
            "broken": {"args": "not-a-list"}}"#,
    );
    let specific = lookup(["my-claude", "acp:claude"]).expect("agent settings");
    assert_eq!(specific.default_model.as_deref(), Some("opus"));
    let engine = lookup(["other-agent", "acp:claude"]).expect("engine settings");
    assert_eq!(engine.args, vec!["--verbose"]);
    assert!(lookup(["empty"]).is_none(), "empty settings are not stored");
    assert!(
        lookup(["broken"]).is_none(),
        "an unreadable entry is skipped"
    );
    set_from_json("not json");
    assert!(
        lookup(["acp:claude"]).is_none(),
        "garbage clears every override"
    );
}

#[test]
fn normalization_drops_blank_and_invalid_values() {
    let value = settings(serde_json::json!({
        "command": "  ",
        "env": {"GOOD_NAME": "1", "1BAD": "x", "has space": "y"},
        "allowedModels": [" sonnet ", ""],
        "defaultConfigOptions": {"effort": "", "": "x", "thought": "high"},
    }));
    assert_eq!(value.command, None);
    assert_eq!(value.env.keys().collect::<Vec<_>>(), vec!["GOOD_NAME"]);
    assert_eq!(value.allowed_models, vec!["sonnet"]);
    assert_eq!(
        value.default_config_options.into_iter().collect::<Vec<_>>(),
        vec![("thought".to_owned(), "high".to_owned())]
    );
}

#[test]
fn agent_kind_is_read_from_the_default_spawn() {
    assert_eq!(
        AcpAgentKind::of_spawn(
            "ANTHROPIC_BASE_URL=x npx -y @agentclientprotocol/claude-agent-acp@latest"
        ),
        AcpAgentKind::ClaudeCode
    );
    assert_eq!(
        AcpAgentKind::of_spawn(
            r#"{"name":"codex","command":"npx","args":["-y","@zed-industries/codex-acp"],"env":[]}"#
        ),
        AcpAgentKind::Codex
    );
    assert_eq!(AcpAgentKind::of_spawn("goose acp"), AcpAgentKind::Other);
}

#[test]
fn claude_knobs_map_to_its_documented_environment() {
    // Absolute on every platform: a literal `/home/...` is not absolute on
    // Windows, where the absolute-path check would refuse it.
    let base = std::env::temp_dir();
    let config_dir = base.join(".claude-work").to_string_lossy().into_owned();
    let cli_path = base.join("claude").to_string_lossy().into_owned();
    let value = settings(serde_json::json!({
        "env": {"CLAUDE_CONFIG_DIR": "/ignored", "FOO": "bar"},
        "configDir": config_dir,
        "cliPath": cli_path,
        "autoCompact": false,
        "autoCompactTokens": 5_000_000,
    }));
    let launch = launch_overrides(&value, AcpAgentKind::ClaudeCode).expect("launch");
    let env: BTreeMap<_, _> = launch.env.into_iter().collect();
    assert_eq!(env["CLAUDE_CONFIG_DIR"], config_dir);
    assert_eq!(env["CLAUDE_CODE_EXECUTABLE"], cli_path);
    assert_eq!(env["DISABLE_AUTO_COMPACT"], "1");
    assert_eq!(env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"], "1000000");
    assert_eq!(env["FOO"], "bar");
    assert!(launch.args.is_empty());
}

#[test]
fn relative_paths_are_refused() {
    let value = settings(serde_json::json!({"configDir": "~/.claude-work"}));
    assert!(launch_overrides(&value, AcpAgentKind::ClaudeCode).is_err());
}

#[test]
fn codex_compaction_is_a_config_override_flag() {
    let value = settings(serde_json::json!({
        "args": ["--verbose"],
        "autoCompact": false,
        "autoCompactTokens": 200_000,
    }));
    let launch = launch_overrides(&value, AcpAgentKind::Codex).expect("launch");
    assert_eq!(
        launch.args,
        vec!["--verbose", "-c", "model_auto_compact_token_limit=200000"]
    );
    assert!(
        launch.env.is_empty(),
        "Codex has no auto-compact off switch"
    );
}

#[test]
fn a_custom_codex_command_must_still_be_codex() {
    let renamed = settings(serde_json::json!({"command": "/opt/bin/agent"}));
    assert!(launch_overrides(&renamed, AcpAgentKind::Codex).is_err());
    let local = settings(serde_json::json!({"command": "/opt/bin/codex-acp"}));
    let launch = launch_overrides(&local, AcpAgentKind::Codex).expect("launch");
    assert_eq!(launch.command, Some(PathBuf::from("/opt/bin/codex-acp")));
}

#[test]
fn other_agents_only_get_generic_launch_settings() {
    let value = settings(serde_json::json!({
        "command": "goose",
        "args": ["acp"],
        "env": {"GOOSE_MODE": "auto"},
        "configDir": "/x",
        "autoCompact": false,
    }));
    let launch = launch_overrides(&value, AcpAgentKind::Other).expect("launch");
    assert_eq!(launch.command, Some(PathBuf::from("goose")));
    assert_eq!(launch.args, vec!["acp"]);
    assert_eq!(
        launch.env,
        vec![("GOOSE_MODE".to_owned(), "auto".to_owned())]
    );
}

#[test]
fn model_allowlist_filters_models_and_model_config_options() {
    let mut config = serde_json::json!({
        "models": {
            "currentModelId": "haiku",
            "availableModels": [
                {"modelId": "opus", "name": "Opus"},
                {"modelId": "sonnet", "name": "Sonnet"},
                {"modelId": "haiku", "name": "Haiku"},
            ],
        },
        "configOptions": [
            {"id": "model", "category": "model", "type": "select", "currentValue": "opus",
             "options": [{"value": "opus", "name": "Opus"}, {"value": "sonnet", "name": "Sonnet"}]},
            {"id": "grouped", "category": "model", "type": "select", "currentValue": "x",
             "options": [
                {"group": "a", "name": "A", "options": [{"value": "sonnet", "name": "S"}, {"value": "y", "name": "Y"}]},
                {"group": "b", "name": "B", "options": [{"value": "z", "name": "Z"}]},
             ]},
            {"id": "effort", "category": "thought_level", "type": "select", "currentValue": "low",
             "options": [{"value": "low", "name": "Low"}, {"value": "high", "name": "High"}]},
        ],
    });
    filter_models(&mut config, &["sonnet".to_owned()]);
    let ids = |list: &Value, key: &str| {
        list.as_array()
            .unwrap()
            .iter()
            .map(|v| v[key].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        ids(&config["models"]["availableModels"], "modelId"),
        vec!["sonnet", "haiku"],
        "the current model stays visible"
    );
    assert_eq!(
        ids(&config["configOptions"][0]["options"], "value"),
        vec!["opus", "sonnet"]
    );
    let grouped = &config["configOptions"][1]["options"];
    assert_eq!(
        grouped.as_array().unwrap().len(),
        1,
        "empty groups are removed"
    );
    assert_eq!(ids(&grouped[0]["options"], "value"), vec!["sonnet"]);
    assert_eq!(
        ids(&config["configOptions"][2]["options"], "value"),
        vec!["low", "high"],
        "non-model options are untouched"
    );
}

#[test]
fn wire_fields_are_camel_case() {
    let value = settings(serde_json::json!({
        "allowedModels": ["sonnet"],
        "autoCompactTokens": 300_000,
        "defaultConfigOptions": {"effort": "high"},
    }));
    assert_eq!(value.allowed_models, vec!["sonnet"]);
    assert_eq!(value.auto_compact_tokens, Some(300_000));
    let encoded = serde_json::to_value(&value).expect("serialize");
    assert!(encoded.get("allowedModels").is_some());
    assert!(encoded.get("allowed_models").is_none());
}

#[test]
fn merge_entry_replaces_one_agent_and_keeps_the_rest() {
    let raw = r#"{"a": {"args": ["-v"]}, "b": {"command": "/bin/b"}}"#;
    let next = merge_entry(
        Some(raw),
        "a",
        &settings(serde_json::json!({"defaultMode": "plan"})),
    )
    .expect("merge");
    let map: Value = serde_json::from_str(&next).expect("json");
    assert_eq!(map["a"]["defaultMode"], "plan");
    assert_eq!(
        map["a"]["args"],
        serde_json::json!([]),
        "the entry is replaced, not merged"
    );
    assert_eq!(map["b"]["command"], "/bin/b");
    let cleared =
        merge_entry(Some(next.as_str()), "a", &AcpAgentSettings::default()).expect("merge");
    let map: Value = serde_json::from_str(&cleared).expect("json");
    assert!(map.get("a").is_none(), "an empty entry is removed");
    assert_eq!(map["b"]["command"], "/bin/b");
    assert_eq!(
        merge_entry(Some("garbage"), "c", &AcpAgentSettings::default()).expect("merge"),
        "{}"
    );
}

#[test]
fn configured_defaults_are_projected_onto_the_probe_answer() {
    let mut config = serde_json::json!({
        "models": {"currentModelId": "haiku", "availableModels": [
            {"modelId": "opus", "name": "Opus"}, {"modelId": "haiku", "name": "Haiku"}]},
        "modes": {"currentModeId": "default", "availableModes": [
            {"id": "default", "name": "Default"}, {"id": "plan", "name": "Plan"}]},
        "configOptions": [
            {"id": "effort", "category": "thought_level", "type": "select", "currentValue": "low",
             "options": [{"value": "low", "name": "Low"}, {"value": "high", "name": "High"}]},
            {"id": "model", "category": "model", "type": "select", "currentValue": "haiku",
             "options": [{"value": "opus", "name": "Opus"}, {"value": "haiku", "name": "Haiku"}]},
        ],
    });
    let value = settings(serde_json::json!({
        "defaultModel": "opus",
        "defaultMode": "missing",
        "allowedModels": ["opus", "haiku"],
        "defaultConfigOptions": {"effort": "high", "model": "opus"},
    }));
    project_defaults(&mut config, &value);
    assert_eq!(config["models"]["currentModelId"], "opus");
    assert_eq!(
        config["modes"]["currentModeId"], "default",
        "an unadvertised default is ignored"
    );
    assert_eq!(config["configOptions"][0]["currentValue"], "high");
    assert_eq!(config["configOptions"][1]["currentValue"], "opus");

    let excluded = settings(serde_json::json!({
        "defaultModel": "haiku",
        "allowedModels": ["opus"],
        "defaultConfigOptions": {"model": "haiku"},
    }));
    project_defaults(&mut config, &excluded);
    assert_eq!(
        config["models"]["currentModelId"], "opus",
        "a default outside the allowlist is not projected"
    );
    assert_eq!(config["configOptions"][1]["currentValue"], "opus");
}
