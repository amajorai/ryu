use super::*;

pub(super) fn vault() -> super::super::accounts::AccountVault {
    super::super::accounts::AccountVault::in_memory().unwrap()
}

pub(super) fn save(vault: &super::super::accounts::AccountVault, account: &str) {
    vault.upsert(&super::super::accounts::provider_scope("github-copilot"), account,
        account, super::super::accounts::KIND_OAUTH,
        Some(json!({"type":"oauth", "access":account, "refresh":"fixture-refresh", "expires":4_000_000_000_000_u64}))).unwrap();
}

#[test]
fn conversation_remains_bound_when_active_selection_changes() {
    let vault = vault();
    save(&vault, "first");
    let first = capture_with_vault(
        &vault,
        "github-copilot",
        "github-copilot",
        Some("chat"),
        "ryu",
        None,
    )
    .unwrap()
    .unwrap();
    save(&vault, "second");
    let same = capture_with_vault(
        &vault,
        "github-copilot",
        "github-copilot",
        Some("chat"),
        "ryu",
        None,
    )
    .unwrap()
    .unwrap();
    assert_eq!(first, same);
    let next = capture_with_vault(
        &vault,
        "github-copilot",
        "github-copilot",
        Some("next-chat"),
        "ryu",
        None,
    )
    .unwrap()
    .unwrap();
    assert_eq!(next.account_id, "second");
    assert_ne!(first.session_key, next.session_key);
    assert!(capture_with_vault(
        &vault,
        "github-copilot",
        "github-copilot",
        Some("chat"),
        "ryu",
        Some("github-copilot:second")
    )
    .is_err());
}

#[test]
fn removing_bound_account_cannot_fall_back_to_current_login() {
    let vault = vault();
    save(&vault, "first");
    capture_with_vault(
        &vault,
        "github-copilot",
        "github-copilot",
        Some("chat"),
        "ryu",
        None,
    )
    .unwrap();
    save(&vault, "second");
    vault
        .remove(
            &super::super::accounts::provider_scope("github-copilot"),
            "first",
        )
        .unwrap();
    assert!(capture_with_vault(
        &vault,
        "github-copilot",
        "github-copilot",
        Some("chat"),
        "ryu",
        None
    )
    .is_err());
}

#[test]
fn explicit_account_and_path_inputs_cannot_select_global_or_escape_directory() {
    let vault = vault();
    save(&vault, "first");
    save(&vault, "second");
    let capture = capture_with_vault(
        &vault,
        "github-copilot",
        "github-copilot",
        Some("../../chat"),
        "../ryu",
        Some("github-copilot:first"),
    )
    .unwrap()
    .unwrap();
    assert_eq!(capture.account_id, "first");
    assert_eq!(capture.session_key.len(), 64);
    assert!(capture
        .session_key
        .chars()
        .all(|character| character.is_ascii_hexdigit()));
    assert!(capture_with_vault(
        &vault,
        "github-copilot",
        "github-copilot",
        Some("new"),
        "ryu",
        Some("github-copilot:missing")
    )
    .is_err());
    assert!(capture_with_vault(
        &vault,
        "github-copilot",
        "github-copilot",
        Some("new"),
        "ryu",
        Some("radius:first")
    )
    .is_err());
}

#[test]
fn provider_support_uses_sdk_refresh_registry_and_retains_native_dispatchers() {
    for provider in [
        "openai-codex",
        "github-copilot",
        "kimi-coding",
        "radius",
        "openrouter",
        "xai",
    ] {
        assert!(sdk_oauth_key(provider).is_some(), "{provider}");
    }
    for provider in [
        "claude-pro-max",
        "chatgpt",
        "chatgpt-plan",
        "gateway",
        "unknown",
    ] {
        assert!(sdk_oauth_key(provider).is_none(), "{provider}");
    }
}

#[test]
fn api_key_conversation_keeps_its_account_after_picker_change_and_reload() {
    let vault = vault();
    let scope = super::super::accounts::provider_scope("openai");
    for (account, key) in [
        ("first", "fixture-first-key"),
        ("second", "fixture-second-key"),
    ] {
        vault
            .upsert(
                &scope,
                account,
                account,
                super::super::accounts::KIND_API_KEY,
                Some(json!(key)),
            )
            .unwrap();
    }
    let first = capture_with_vault(
        &vault,
        "openai",
        "openai",
        Some("key-chat"),
        "ryu",
        Some("openai:first"),
    )
    .unwrap()
    .unwrap();
    assert_eq!(first.credential_kind, super::super::accounts::KIND_API_KEY);
    let persisted: SessionAccount =
        serde_json::from_value(serde_json::to_value(&first).unwrap()).unwrap();
    let resumed = capture_with_vault(&vault, "openai", "openai", Some("key-chat"), "ryu", None)
        .unwrap()
        .unwrap();
    assert_eq!(resumed, persisted);
    let directory = tempfile::tempdir().unwrap();
    publish_api_key(
        directory.path(),
        "openai",
        &vault
            .credential(&scope, &resumed.account_id)
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    let auth: Value =
        serde_json::from_str(&std::fs::read_to_string(directory.path().join("auth.json")).unwrap())
            .unwrap();
    assert_eq!(auth["openai"]["type"], "api_key");
    // The key itself reaches Pi in its spawn environment, never this file.
    assert_eq!(auth["openai"]["key"], "${RYU_PI_SESSION_KEY}");
    assert!(!std::fs::read_to_string(directory.path().join("auth.json"))
        .unwrap()
        .contains("fixture-first-key"));
    assert!(auth["openai"].get("expires").is_none());
    assert_eq!(
        vault.active_info(&scope).unwrap().unwrap().account_id,
        "second"
    );
    vault.remove(&scope, "first").unwrap();
    assert!(capture_with_vault(&vault, "openai", "openai", Some("key-chat"), "ryu", None).is_err());
}

#[test]
fn existing_oauth_affinity_records_keep_their_kind_when_loaded() {
    let captured: SessionAccount = serde_json::from_value(
        json!({"providerId":"xai","accountId":"fixture", "sessionKey":"fixture"}),
    )
    .unwrap();
    assert_eq!(captured.credential_kind, super::super::accounts::KIND_OAUTH);
}

#[test]
fn unsupported_custom_oauth_cannot_fall_back_to_shared_active_auth() {
    let vault = vault();
    vault.upsert(&super::super::accounts::provider_scope("custom-radius"), "fixture", "fixture", super::super::accounts::KIND_OAUTH, Some(json!({"type":"oauth", "access":"fixture", "refresh":"fixture", "expires":4_000_000_000_000_u64}))).unwrap();
    assert!(capture_with_vault(
        &vault,
        "custom-radius",
        "custom-radius",
        Some("chat"),
        "ryu",
        None
    )
    .is_err());
}
