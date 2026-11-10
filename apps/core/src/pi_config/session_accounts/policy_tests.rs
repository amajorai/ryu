use super::capture_tests::{save, vault};
use super::*;

#[test]
fn round_robin_selects_new_conversations_without_rebinding_existing_or_picker() {
    let vault = vault();
    save(&vault, "first");
    save(&vault, "second");
    let mut chooser = AccountChooser::default();
    let policy = Policy {
        strategy: Strategy::RoundRobin,
        ..Policy::default()
    };
    let capture = |chat: &str, policy: &Policy, chooser: &mut AccountChooser| {
        capture_with_vault_and_policy(
            &vault,
            "github-copilot",
            "github-copilot",
            Some(chat),
            "ryu",
            None,
            policy,
            chooser,
        )
        .unwrap()
        .unwrap()
    };
    let first = capture("chat-one", &policy, &mut chooser);
    let second = capture("chat-two", &policy, &mut chooser);
    assert_eq!(first.account_id, "first");
    assert_eq!(second.account_id, "second");
    let mut changed = Policy {
        strategy: Strategy::FillFirst,
        ..Policy::default()
    };
    changed.accounts.insert(
        "first".into(),
        crate::server::oauth_pool_policy::AccountRule {
            drain_threshold_percent: None,
            enabled: true,
            priority: 100,
        },
    );
    assert_eq!(capture("chat-one", &changed, &mut chooser), first);
    changed.accounts.get_mut("first").unwrap().enabled = false;
    let error = capture_with_vault_and_policy(
        &vault,
        "github-copilot",
        "github-copilot",
        Some("chat-one"),
        "ryu",
        None,
        &changed,
        &mut chooser,
    )
    .unwrap_err();
    assert!(error.to_string().contains("disabled"));
    assert_eq!(
        capture("chat-three", &changed, &mut chooser).account_id,
        "second"
    );
    assert_eq!(
        vault
            .active_info(&super::super::accounts::provider_scope("github-copilot"))
            .unwrap()
            .unwrap()
            .account_id,
        "second"
    );
}

#[test]
fn automatic_api_key_fill_excludes_unusable_credentials_and_uses_priority() {
    let vault = vault();
    let scope = super::super::accounts::provider_scope("openrouter");
    for (account, credential) in [
        ("empty", ""),
        ("fallback", "fixture-fallback"),
        ("preferred", "fixture-preferred"),
    ] {
        vault
            .upsert(
                &scope,
                account,
                account,
                super::super::accounts::KIND_API_KEY,
                Some(json!(credential)),
            )
            .unwrap();
    }
    vault
        .upsert(
            &scope,
            "expired",
            "Expired",
            super::super::accounts::KIND_OAUTH,
            Some(json!({"type":"oauth", "access":"fixture-expired", "refresh":"", "expires":1})),
        )
        .unwrap();
    let mut policy = Policy {
        strategy: Strategy::FillFirst,
        ..Policy::default()
    };
    policy.accounts.insert(
        "fallback".into(),
        crate::server::oauth_pool_policy::AccountRule {
            drain_threshold_percent: None,
            enabled: true,
            priority: 10,
        },
    );
    let mut chooser = AccountChooser::default();
    for chat in ["one", "two"] {
        let selected = capture_with_vault_and_policy(
            &vault,
            "openrouter",
            "openrouter",
            Some(chat),
            "ryu",
            None,
            &policy,
            &mut chooser,
        )
        .unwrap()
        .unwrap();
        assert_eq!(selected.account_id, "preferred");
        assert_eq!(
            selected.credential_kind,
            super::super::accounts::KIND_API_KEY
        );
    }
    policy.accounts.insert(
        "preferred".into(),
        crate::server::oauth_pool_policy::AccountRule {
            drain_threshold_percent: None,
            enabled: false,
            priority: 0,
        },
    );
    let next = capture_with_vault_and_policy(
        &vault,
        "openrouter",
        "openrouter",
        Some("three"),
        "ryu",
        None,
        &policy,
        &mut chooser,
    )
    .unwrap()
    .unwrap();
    assert_eq!(next.account_id, "fallback");
}

#[test]
fn saved_affinity_survives_reopened_vault_and_fresh_rotation_cursor() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("accounts.db");
    let policy = Policy {
        strategy: Strategy::RoundRobin,
        ..Policy::default()
    };
    let bound = {
        let vault = super::super::accounts::AccountVault::open_test(path.clone()).unwrap();
        save(&vault, "first");
        save(&vault, "second");
        capture_with_vault_and_policy(
            &vault,
            "github-copilot",
            "github-copilot",
            Some("persisted-chat"),
            "ryu",
            None,
            &policy,
            &mut AccountChooser::default(),
        )
        .unwrap()
        .unwrap()
    };
    let vault = super::super::accounts::AccountVault::open_test(path).unwrap();
    let reopened = capture_with_vault_and_policy(
        &vault,
        "github-copilot",
        "github-copilot",
        Some("persisted-chat"),
        "ryu",
        None,
        &policy,
        &mut AccountChooser::default(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(reopened, bound);
    vault
        .remove(
            &super::super::accounts::provider_scope("github-copilot"),
            &bound.account_id,
        )
        .unwrap();
    assert!(capture_with_vault_and_policy(
        &vault,
        "github-copilot",
        "github-copilot",
        Some("persisted-chat"),
        "ryu",
        None,
        &policy,
        &mut AccountChooser::default()
    )
    .is_err());
}

#[test]
fn sdk_routing_projection_comes_from_the_selected_sealed_account() {
    let vault = vault();
    let scope = super::super::accounts::provider_scope("xai");
    for account in ["first", "second"] {
        vault
            .upsert(
                &scope,
                account,
                account,
                super::super::accounts::KIND_API_KEY,
                Some(json!(format!("fixture-sdk-{account}"))),
            )
            .unwrap();
    }
    let policy = Policy {
        strategy: Strategy::RoundRobin,
        ..Policy::default()
    };
    let mut chooser = AccountChooser::default();
    let directory = tempfile::tempdir().unwrap();
    let mut captures = Vec::new();
    for (index, expected) in ["first", "second", "first"].into_iter().enumerate() {
        let captured = capture_with_vault_and_policy(
            &vault,
            "xai",
            "xai",
            Some(&format!("sdk-route-{index}")),
            "ryu",
            None,
            &policy,
            &mut chooser,
        )
        .unwrap()
        .unwrap();
        assert_eq!(captured.account_id, expected);
        let credential = vault
            .credential(&scope, &captured.account_id)
            .unwrap()
            .unwrap();
        publish_api_key(directory.path(), "xai", &credential).unwrap();
        let auth: Value = serde_json::from_str(
            &std::fs::read_to_string(directory.path().join("auth.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(auth["xai"]["key"], "${RYU_PI_SESSION_KEY}");
        assert_eq!(credential, json!(format!("fixture-sdk-{expected}")));
        captures.push(
            json!({"providerId":captured.provider_id,"accountId":captured.account_id,"auth":auth}),
        );
    }
    assert_eq!(
        vault.active_info(&scope).unwrap().unwrap().account_id,
        "second"
    );
    if let Ok(path) = std::env::var("RYU_SDK_ROUTING_PROOF") {
        let proof = json!({"activeAccount":"second", "captures":captures, "models":{"providers":{"xai":{
            "api":"openai-completions", "baseUrl":"https://fixture.example.test/v1", "headers":{"X-Client":"fixture-client"},
            "models":[{"id":"fixture-sdk-route", "name":"Fixture SDK route", "contextWindow":8192, "maxTokens":1024}]
        }}}});
        std::fs::write(path, serde_json::to_string_pretty(&proof).unwrap()).unwrap();
    }
}

#[test]
fn enabled_subscription_tracking_attributes_the_bound_sdk_account_after_picker_change() {
    use crate::server::subscription_costs::{SubscriptionCostAttribution, SubscriptionCostStore};
    let vault = vault();
    save(&vault, "first");
    save(&vault, "second");
    let policy = Policy {
        strategy: Strategy::RoundRobin,
        ..Policy::default()
    };
    let mut chooser = AccountChooser::default();
    let bound = capture_with_vault_and_policy(
        &vault,
        "github-copilot",
        "github-copilot",
        Some("tracked-chat"),
        "actual-bridge-agent",
        None,
        &policy,
        &mut chooser,
    )
    .unwrap()
    .unwrap();
    assert_eq!(bound.account_id, "first");
    let scope = super::super::accounts::provider_scope("github-copilot");
    vault.set_active(&scope, "first").unwrap();
    vault.set_active(&scope, "second").unwrap();
    let directory = tempfile::tempdir().unwrap();
    let store = SubscriptionCostStore::open(&directory.path().join("costs.db")).unwrap();
    store.set_enabled(true).unwrap();
    assert!(store.is_enabled().unwrap());
    // The tracking caller captures without forcing the current pick. Dispatch
    // receives the resulting exact identity and must accept the same binding.
    let cost_account = capture_with_vault_and_policy(
        &vault,
        "github-copilot",
        "github-copilot",
        Some("tracked-chat"),
        "actual-bridge-agent",
        None,
        &policy,
        &mut chooser,
    )
    .unwrap()
    .unwrap();
    let dispatched = capture_with_vault(
        &vault,
        "github-copilot",
        "github-copilot",
        Some("tracked-chat"),
        "actual-bridge-agent",
        Some(&cost_account.process_identity()),
    )
    .unwrap()
    .unwrap();
    assert_eq!(dispatched, bound);
    let attribution = SubscriptionCostAttribution {
        store: store.clone(),
        turn_id: uuid::Uuid::new_v4(),
        provider_id: cost_account.provider_id,
        account_id: cost_account.account_id,
        model_id: Some("fixture-model".into()),
    };
    let now = chrono::Utc::now();
    assert!(store
        .record_completed_turn(&attribution, now, Some(101), Some(23))
        .unwrap());
    let records = store.current_month_by_model(now).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].account_id, "first");
    assert_eq!(records[0].input_tokens, 101);
    assert_eq!(records[0].output_tokens, 23);
    assert_eq!(
        vault
            .active_info(&super::super::accounts::provider_scope("github-copilot"))
            .unwrap()
            .unwrap()
            .account_id,
        "second"
    );
}
