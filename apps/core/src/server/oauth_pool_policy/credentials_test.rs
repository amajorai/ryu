use super::*;
use crate::pi_config::accounts::KIND_OAUTH;

// Made-up values. They do not have the shape of any provider's real key.
const KEY_WORK: &str = "test-key-work-00000000000001";
const KEY_SPARE: &str = "test-key-spare-0000000000002";
const SCOPE: &str = "provider:anthropic";

fn account(id: &str, label: &str, kind: &str) -> AccountInfo {
    serde_json::from_value(json!({
        "accountId": id,
        "label": label,
        "kind": kind,
        "active": false,
        "gatewayActive": false,
        "updatedAt": 0,
    }))
    .expect("account info")
}

fn policy(value: Value) -> Policy {
    serde_json::from_value(value).expect("policy")
}

fn ids(accounts: &[AccountInfo]) -> Vec<&str> {
    accounts
        .iter()
        .map(|account| account.account_id.as_str())
        .collect()
}

#[test]
fn the_fallback_setting_is_off_unless_the_record_says_on() {
    assert!(!Settings::default().api_key_fallback);
    let empty: Settings = serde_json::from_str("{}").unwrap();
    assert!(!empty.api_key_fallback);
    let on: Settings = serde_json::from_str(r#"{"apiKeyFallback":true}"#).unwrap();
    assert!(on.api_key_fallback);
    // A record written by a newer build still reads.
    let newer: Settings = serde_json::from_str(r#"{"apiKeyFallback":true,"later":1}"#).unwrap();
    assert!(newer.api_key_fallback);
    assert_eq!(
        serde_json::to_string(&on).unwrap(),
        r#"{"apiKeyFallback":true}"#
    );
}

#[test]
fn only_claude_subscription_accounts_have_a_key_provider_to_fall_back_to() {
    assert_eq!(fallback_key_provider("claude-pro-max"), Some("anthropic"));
    for provider in [
        "anthropic",
        "chatgpt",
        "chatgpt-plan",
        "openrouter",
        "xai",
        "",
    ] {
        assert_eq!(fallback_key_provider(provider), None, "{provider}");
    }
}

#[tokio::test]
async fn the_saved_setting_is_read_back_and_never_applies_to_other_providers() {
    let directory = tempfile::tempdir().unwrap();
    let preferences = PreferencesStore::open(directory.path().join("preferences.db")).unwrap();
    assert!(
        !load_settings(&preferences, "claude-pro-max")
            .await
            .api_key_fallback
    );
    preferences
        .set(
            &settings_key("claude-pro-max"),
            r#"{"apiKeyFallback":true}"#,
        )
        .await
        .unwrap();
    assert!(
        load_settings(&preferences, "claude-pro-max")
            .await
            .api_key_fallback
    );
    // A record for a provider Core cannot switch to a key is ignored.
    preferences
        .set(&settings_key("chatgpt"), r#"{"apiKeyFallback":true}"#)
        .await
        .unwrap();
    assert!(
        !load_settings(&preferences, "chatgpt")
            .await
            .api_key_fallback
    );
    // A damaged record reads as off.
    preferences
        .set(&settings_key("claude-pro-max"), "not json")
        .await
        .unwrap();
    assert!(
        !load_settings(&preferences, "claude-pro-max")
            .await
            .api_key_fallback
    );
}

#[test]
fn accounts_are_listed_by_priority_and_equal_priorities_keep_their_order() {
    let accounts = vec![
        account("first", "First", KIND_API_KEY),
        account("second", "Second", KIND_API_KEY),
        account("third", "Third", KIND_API_KEY),
    ];
    assert_eq!(
        ids(&in_order(accounts.clone(), &Policy::default())),
        vec!["first", "second", "third"]
    );
    let dragged = policy(json!({
        "accounts": {
            "third": { "priority": 0 },
            "first": { "priority": 1 },
            "second": { "priority": 2 },
        }
    }));
    assert_eq!(
        ids(&in_order(accounts.clone(), &dragged)),
        vec!["third", "first", "second"]
    );
    // An account added after the order was saved has priority 0 and joins the top group.
    let partly = policy(json!({ "accounts": { "first": { "priority": 2 } } }));
    assert_eq!(
        ids(&in_order(accounts, &partly)),
        vec!["second", "third", "first"]
    );
}

#[tokio::test]
async fn the_order_is_kept_across_a_restart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("preferences.db");
    let accounts = vec![
        account("key-work", "Work", KIND_API_KEY),
        account("key-spare", "Spare", KIND_API_KEY),
    ];
    {
        let preferences = PreferencesStore::open(path.clone()).unwrap();
        let saved = json!({
            "strategy": "fill_first",
            "accounts": {
                "key-spare": { "enabled": true, "priority": 0 },
                "key-work": { "enabled": true, "priority": 1 },
            }
        });
        preferences
            .set("oauth-account-pool:anthropic", &saved.to_string())
            .await
            .unwrap();
    }
    // A new store on the same file stands in for Core starting again.
    let reopened = PreferencesStore::open(path).unwrap();
    let policy = super::super::load(&reopened, "anthropic").await;
    assert_eq!(
        ids(&in_order(accounts, &policy)),
        vec!["key-spare", "key-work"]
    );
}

#[test]
fn a_hint_is_the_last_four_characters_of_a_long_enough_key() {
    assert_eq!(
        key_hint(&json!({ "type": "api_key", "key": KEY_WORK })).as_deref(),
        Some("0001")
    );
    // Custom providers store the bare string.
    assert_eq!(key_hint(&json!(KEY_SPARE)).as_deref(), Some("0002"));
    assert_eq!(
        key_hint(&json!(format!("  {KEY_WORK}\n"))).as_deref(),
        Some("0001")
    );
    // Four characters of a short key would give too much of it away.
    assert_eq!(key_hint(&json!("short-key-00001")), None);
    assert_eq!(
        key_hint(&json!("sixteen-chars-01")).as_deref(),
        Some("s-01")
    );
    // A sign-in has no key to hint at.
    assert_eq!(
        key_hint(&json!({ "type": "oauth", "access": "test-access-value-000001" })),
        None
    );
    assert_eq!(key_hint(&json!("test-key-ending-in-tab-0\t0")), None);
    assert_eq!(key_hint(&json!(null)), None);
}

#[test]
fn a_single_saved_key_is_a_list_of_one_that_is_on_and_first() {
    // The shape and label a key saved before this change has in the vault
    // (the boot import and "save key" both write it). No policy was ever saved.
    let vault = AccountVault::in_memory().unwrap();
    vault
        .upsert(
            SCOPE,
            "acct_only",
            "API key",
            KIND_API_KEY,
            Some(json!({ "type": "api_key", "key": KEY_WORK })),
        )
        .unwrap();
    let rows = views(
        &vault,
        SCOPE,
        vault.list(SCOPE).unwrap(),
        &Policy::default(),
        |_| None,
    );
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].account_id, "acct_only");
    assert_eq!(rows[0].label, "API key");
    assert_eq!(rows[0].kind, KIND_API_KEY);
    assert!(rows[0].enabled);
    assert_eq!(rows[0].hint.as_deref(), Some("0001"));
}

#[test]
fn rows_follow_the_order_and_never_carry_a_key() {
    let vault = AccountVault::in_memory().unwrap();
    vault
        .upsert(
            SCOPE,
            "key-work",
            "Work",
            KIND_API_KEY,
            Some(json!({ "type": "api_key", "key": KEY_WORK })),
        )
        .unwrap();
    vault
        .upsert(
            SCOPE,
            "key-spare",
            "Spare",
            KIND_API_KEY,
            Some(json!(KEY_SPARE)),
        )
        .unwrap();
    vault
        .upsert(
            SCOPE,
            "login",
            "person@example.com",
            KIND_OAUTH,
            Some(json!({
                "type": "oauth",
                "access": "test-access-value-000001",
                "refresh": "test-refresh-value-00001",
            })),
        )
        .unwrap();
    let policy = policy(json!({
        "accounts": {
            "key-spare": { "priority": 0 },
            "key-work": { "priority": 1, "enabled": false },
            "login": { "priority": 2 },
        }
    }));
    let rows = views(
        &vault,
        SCOPE,
        vault.list(SCOPE).unwrap(),
        &policy,
        |account_id| (account_id == "key-work").then_some(Rest::Limited),
    );

    assert_eq!(
        rows.iter()
            .map(|row| row.account_id.as_str())
            .collect::<Vec<_>>(),
        vec!["key-spare", "key-work", "login"]
    );
    assert_eq!(rows[0].label, "Spare");
    assert_eq!(rows[0].hint.as_deref(), Some("0002"));
    assert!(rows[0].enabled);
    assert_eq!(rows[0].resting, None);
    assert_eq!(rows[1].hint.as_deref(), Some("0001"));
    assert!(!rows[1].enabled);
    assert_eq!(rows[1].resting, Some(Rest::Limited));
    assert_eq!(rows[2].kind, KIND_OAUTH);
    assert_eq!(rows[2].hint, None);

    // What reaches a client, a log line or a snapshot holds no credential.
    let sent = serde_json::to_string(&rows).unwrap();
    let printed = format!("{rows:?}");
    for text in [sent.as_str(), printed.as_str()] {
        for secret in [
            KEY_WORK,
            KEY_SPARE,
            &KEY_WORK[..KEY_WORK.len() - 4],
            "test-access-value",
            "test-refresh-value",
        ] {
            assert!(!text.contains(secret), "a credential leaked into {text}");
        }
    }
    assert_eq!(
        serde_json::to_value(&rows[1]).unwrap(),
        json!({
            "accountId": "key-work",
            "label": "Work",
            "kind": "api_key",
            "enabled": false,
            "needsReauth": false,
            "hint": "0001",
            "resting": "limited",
        })
    );
}
