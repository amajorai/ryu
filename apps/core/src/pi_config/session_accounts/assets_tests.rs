use super::*;

#[test]
fn isolated_assets_preserve_tools_without_shared_auth_or_sessions() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    std::fs::write(
        source.path().join("settings.json"),
        r#"{"defaultProvider":"radius","defaultModel":"fixture-model","enableSkills":false}"#,
    )
    .unwrap();
    std::fs::write(source.path().join("auth.json"), "never-copy").unwrap();
    std::fs::write(source.path().join("models-store.json"), serde_json::to_string(&json!({
        "github-copilot":{"models":[{"id":"cached-model","provider":"github-copilot","baseUrl":"https://fixture.test/v1", "headers":{"Authorization":"Bearer wrong-cache-account", "X-Client":"cached-client"}}]},
        "unrelated":{"models":[{"id":"other-model","headers":{"Authorization":"keep-other-account"}}]}
    })).unwrap()).unwrap();
    std::fs::create_dir(source.path().join("sessions")).unwrap();
    std::fs::create_dir(source.path().join("extensions")).unwrap();
    std::fs::write(source.path().join("extensions/ryu-mcp.ts"), "fixture-tools").unwrap();
    materialize_assets(source.path(), target.path(), "github-copilot").unwrap();
    assert_eq!(
        std::fs::read_to_string(target.path().join("extensions/ryu-mcp.ts")).unwrap(),
        "fixture-tools"
    );
    assert!(!target.path().join("auth.json").exists());
    assert!(!target.path().join("sessions").exists());
    let settings: Value = serde_json::from_str(
        &std::fs::read_to_string(target.path().join("settings.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(settings["defaultProvider"], "github-copilot");
    assert_eq!(settings["enableSkills"], false);
    let store: Value = serde_json::from_str(
        &std::fs::read_to_string(target.path().join("models-store.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        store["github-copilot"]["models"][0]["headers"],
        json!({"X-Client":"cached-client"})
    );
    assert_eq!(
        store["github-copilot"]["models"][0]["baseUrl"],
        "https://fixture.test/v1"
    );
    // Another provider's literal credential never reaches a session copy.
    assert!(store["unrelated"]["models"][0]["headers"]
        .get("Authorization")
        .is_none());
    assert!(
        !std::fs::read_to_string(target.path().join("models-store.json"))
            .unwrap()
            .contains("keep-other-account")
    );
}

#[test]
fn revoked_extensions_disappear_from_retained_sessions() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    std::fs::write(source.path().join("settings.json"), "{}").unwrap();
    std::fs::create_dir(source.path().join("extensions")).unwrap();
    let extension = source.path().join("extensions/ext-revoked.ts");
    std::fs::write(&extension, "previously-approved").unwrap();
    std::fs::write(source.path().join("extensions/ryu-mcp.ts"), "keep-tools").unwrap();
    materialize_assets(source.path(), target.path(), "radius").unwrap();
    std::fs::remove_file(extension).unwrap();
    materialize_assets(source.path(), target.path(), "radius").unwrap();
    assert!(!target.path().join("extensions/ext-revoked.ts").exists());
    assert_eq!(
        std::fs::read_to_string(target.path().join("extensions/ryu-mcp.ts")).unwrap(),
        "keep-tools"
    );
    std::fs::remove_dir_all(source.path().join("extensions")).unwrap();
    materialize_assets(source.path(), target.path(), "radius").unwrap();
    assert!(!target.path().join("extensions").exists());
}

#[test]
fn selected_model_auth_overrides_cannot_replace_captured_credentials() {
    let mut models = json!({"providers":{
        "xai":{"apiKey":"fixture-other-account", "baseUrl":"https://fixture.test/v1", "api":"openai-completions", "authHeader":true,
            "headers":{"AUTHORIZATION":"Bearer wrong-account", "X-Client":"fixture-client"},
            "models":[{"id":"fixture-model", "headers":{"x-Api-Key":"wrong", "X-Model":"fixture"}}],
            "modelOverrides":{"fixture-model":{"headers":{"Authorization":"Bearer wrong", "X-Override":"fixture"}}}},
        "unrelated":{"apiKey":"drop-unrelated-key", "baseUrl":"https://unrelated.test/v1", "headers":{"Authorization":"drop-unrelated-header", "X-Client":"keep"}},
        "proxied":{"apiKey":"ryu-local-proxy", "headers":{"x-ryu-node-token":"${RYU_PI_NODE_TOKEN}"}},
        "custom":{"apiKey":"${RYU_PI_KEY_414243}"}}});
    let proxied = models["providers"]["proxied"].clone();
    let custom = models["providers"]["custom"].clone();
    sanitize_selected_models(&mut models, "xai");
    let selected = &models["providers"]["xai"];
    assert!(selected.get("apiKey").is_none());
    assert_eq!(selected["baseUrl"], "https://fixture.test/v1");
    assert_eq!(selected["api"], "openai-completions");
    assert!(selected.get("authHeader").is_none());
    assert_eq!(selected["headers"], json!({"X-Client":"fixture-client"}));
    assert_eq!(
        selected["models"][0]["headers"],
        json!({"X-Model":"fixture"})
    );
    assert_eq!(
        selected["modelOverrides"]["fixture-model"]["headers"],
        json!({"X-Override":"fixture"})
    );
    // Other providers keep references, templates and sentinels, but lose
    // literal credentials.
    assert_eq!(
        models["providers"]["unrelated"],
        json!({"baseUrl":"https://unrelated.test/v1", "headers":{"X-Client":"keep"}})
    );
    assert_eq!(models["providers"]["proxied"], proxied);
    assert_eq!(models["providers"]["custom"], custom);
}

#[test]
fn models_projection_matches_the_fixture_used_by_actual_sdk_verification() {
    let mut models: Value = serde_json::from_str(include_str!("model-auth-input.json")).unwrap();
    sanitize_selected_models(&mut models, "xai");
    let expected: Value = serde_json::from_str(include_str!("model-auth-projection.json")).unwrap();
    assert_eq!(models, expected);
    let mut cache: Value = serde_json::from_str(include_str!("model-cache-input.json")).unwrap();
    sanitize_selected_cache(&mut cache, "xai");
    let expected: Value =
        serde_json::from_str(include_str!("model-cache-projection.json")).unwrap();
    assert_eq!(cache, expected);
}
