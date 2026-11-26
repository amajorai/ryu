use super::*;

fn grants(items: &[&str]) -> HashSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn pool_provider() -> crate::subscriptions::SubscriptionProvider {
    use crate::server::oauth_pool_policy::Strategy;
    use crate::subscriptions::{
        AccountPinning, AccountState, PoolPolicySummary, ProviderCapabilities, ProviderKind,
        SubscriptionAccount, SubscriptionProvider,
    };
    let account = |account_id: &str, state: AccountState, needs_reauth: bool| SubscriptionAccount {
        account_id: account_id.to_owned(),
        label: Some(format!("{account_id}@example.test")),
        kind: "oauth".to_owned(),
        active: account_id == "acct_ok",
        gateway_active: false,
        needs_reauth,
        updated_at: 1,
        connection_state: None,
        pool_enabled: state != AccountState::PoolDisabled,
        pool_priority: Some(0),
        state,
        usage: None,
    };
    SubscriptionProvider {
        provider_id: "claude-pro-max".to_owned(),
        label: "Claude Pro/Max".to_owned(),
        kind: ProviderKind::Subscription,
        managed: false,
        capabilities: ProviderCapabilities {
            account_usage: true,
            account_ping: true,
            account_pinning: AccountPinning::None,
            pool_strategies: vec![Strategy::QuotaFirst],
            quota_observations: true,
        },
        policy: Some(PoolPolicySummary {
            strategy: Strategy::QuotaFirst,
            drain_threshold_percent: 80,
        }),
        active_account_id: Some("acct_ok".to_owned()),
        accounts: vec![
            account("acct_ok", AccountState::Ok, false),
            account("acct_expired", AccountState::Ok, false),
            account("acct_reauth", AccountState::NeedsReauth, true),
            account("acct_off", AccountState::PoolDisabled, false),
        ],
    }
}

fn cached_ok(provider_id: &str, account_id: &str) -> Option<(ryu_usage::UsageSnapshot, String)> {
    (account_id == "acct_ok").then(|| {
        (
            ryu_usage::UsageSnapshot {
                agent_id: provider_id.to_owned(),
                engine: "claude".to_owned(),
                available: true,
                provider_id: Some(provider_id.to_owned()),
                account_id: Some(account_id.to_owned()),
                ..Default::default()
            },
            "2026-10-14T00:00:00+00:00".to_owned(),
        )
    })
}

#[test]
fn provider_usage_form_is_label_free_and_cache_only() {
    let provider = pool_provider();
    let out = provider_usage_projection(Some(&provider), "claude-pro-max", None, cached_ok);
    assert_eq!(out["provider_id"], "claude-pro-max");
    assert_eq!(out["usage_supported"], true);
    assert_eq!(out["pool_strategy"], "quota_first");
    assert!(out.get("error").is_none());
    let accounts = out["accounts"].as_array().expect("accounts");
    assert_eq!(accounts.len(), 4);
    for account in accounts {
        let object = account.as_object().expect("account object");
        assert!(!object.contains_key("label"));
        assert!(!object.contains_key("account_label"));
    }
    assert!(!out.to_string().contains("@example.test"));

    assert_eq!(accounts[0]["state"], "ok");
    assert_eq!(accounts[0]["eligible"], true);
    assert_eq!(accounts[0]["usage"]["account_id"], "acct_ok");
    assert_eq!(accounts[0]["observed_at"], "2026-10-14T00:00:00+00:00");
    // A listed reading that expired before the raw lookup reads as pending.
    assert_eq!(accounts[1]["state"], "pending");
    assert!(accounts[1]["usage"].is_null());
    assert!(accounts[1].get("observed_at").is_none());
    assert_eq!(accounts[2]["state"], "needs_reauth");
    assert_eq!(accounts[2]["eligible"], false);
    assert_eq!(accounts[3]["state"], "pool_disabled");
    assert_eq!(accounts[3]["eligible"], false);
}

#[test]
fn provider_usage_form_reports_unknown_account_and_unknown_provider() {
    let provider = pool_provider();
    let out = provider_usage_projection(
        Some(&provider),
        "claude-pro-max",
        Some("acct_missing"),
        cached_ok,
    );
    assert_eq!(out["accounts"], json!([]));
    assert_eq!(out["error"], "account_not_found");

    let one = provider_usage_projection(
        Some(&provider),
        "claude-pro-max",
        Some("acct_ok"),
        cached_ok,
    );
    assert_eq!(one["accounts"].as_array().map(Vec::len), Some(1));

    let unknown = provider_usage_projection(None, "nope", None, cached_ok);
    assert_eq!(unknown["usage_supported"], false);
    assert!(unknown["pool_strategy"].is_null());
    assert_eq!(unknown["accounts"], json!([]));
    assert!(unknown.get("error").is_none());
}

#[test]
fn parse_preset_defaults_to_code_read() {
    assert_eq!(parse_preset(None), PermissionPreset::CodeRead);
    assert_eq!(parse_preset(Some("")), PermissionPreset::CodeRead);
    assert_eq!(parse_preset(Some("nonsense")), PermissionPreset::CodeRead);
    assert_eq!(parse_preset(Some("research")), PermissionPreset::Research);
    assert_eq!(
        parse_preset(Some("code_write")),
        PermissionPreset::CodeWrite
    );
    assert_eq!(parse_preset(Some("summarize")), PermissionPreset::Summarise);
}

#[test]
fn plain_run_agent_grant_only_allows_read_only_presets() {
    let read = grants(&["hook:run-agent"]);
    for preset in [
        PermissionPreset::CodeRead,
        PermissionPreset::Research,
        PermissionPreset::Summarise,
    ] {
        assert!(check_preset_grant(&read, "p", preset).is_ok());
    }
    let denied = check_preset_grant(&read, "p", PermissionPreset::CodeWrite)
        .expect_err("code_write must need the write grant");
    assert!(denied.contains("hook:run-agent:write"));
    assert!(denied.contains("not granted"));

    let write = grants(&["hook:run-agent", "hook:run-agent:write"]);
    assert!(check_preset_grant(&write, "p", PermissionPreset::CodeWrite).is_ok());
}

fn refusal_of(outcome: InvokeOutcome) -> Option<String> {
    match outcome {
        InvokeOutcome::Result(result) if result.is_error => result.error,
        _ => None,
    }
}

#[tokio::test]
async fn a_calling_agent_with_limited_model_providers_cannot_fan_out_on_all_of_them() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let limited = state
        .agent_store
        .create(crate::agents::CreateAgent {
            name: "Limited".into(),
            ..Default::default()
        })
        .await
        .unwrap()
        .id;
    state
        .agent_store
        .update(
            &limited,
            crate::agents::UpdateAgent {
                account_access: Some(Some(vec!["provider:openai".into()])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let open = state
        .agent_store
        .create(crate::agents::CreateAgent {
            name: "Open".into(),
            ..Default::default()
        })
        .await
        .unwrap()
        .id;
    let bridge_for = |agent: &str| {
        PluginHookBridge::new_for_agent_tool(
            "@test/app".to_owned(),
            grants(&["hook:run-agent", "hook:side-model"]),
            state.clone(),
            Some(agent),
            Some("conv-1"),
        )
    };

    let bridge = bridge_for(&limited);
    assert_eq!(
        bridge.calling_agent_provider_access().await.as_deref(),
        Some("openai")
    );
    let delegates = json!({ "delegates": [{ "id": "a", "task": "x" }] });
    for (verb, outcome) in [
        (
            "host.runAgent",
            bridge.run_agent(json!({ "task": "x" })).await,
        ),
        ("host.runFanout", bridge.run_fanout(delegates).await),
    ] {
        let error = refusal_of(outcome).expect("a limited agent is refused");
        assert!(error.starts_with(verb), "{error}");
        assert!(error.contains("model providers"), "{error}");
    }

    // An unrestricted agent, and a bridge with no calling agent, carry no limit.
    assert_eq!(
        bridge_for(&open).calling_agent_provider_access().await,
        None
    );
    let no_agent = PluginHookBridge::new_for_agent_tool(
        "@test/app".to_owned(),
        grants(&["hook:run-agent"]),
        state.clone(),
        None,
        None,
    );
    assert_eq!(no_agent.calling_agent_provider_access().await, None);
}

#[test]
fn run_agent_gate_requires_grant() {
    let g = grants(&["hook:side-model"]);
    assert!(!g.contains(GRANT_RUN_AGENT));
    let g = grants(&["hook:run-agent"]);
    assert!(g.contains(GRANT_RUN_AGENT));
}

#[test]
fn agent_run_permission_is_skipped_only_for_an_identified_parent_agent() {
    assert!(requires_user_agent_run_permission(false, false));
    assert!(!requires_user_agent_run_permission(false, true));
    assert!(requires_user_agent_run_permission(true, false));
    assert!(requires_user_agent_run_permission(true, true));
}

#[test]
fn grant_set_membership_gates_capabilities() {
    let g = grants(&["hook:side-model"]);
    assert!(g.contains(GRANT_SIDE_MODEL));
    assert!(!g.contains(GRANT_STORAGE));
}

#[test]
fn notification_text_is_control_free_and_bounded() {
    assert_eq!(
        bounded_notification_text(Some(" \u{0000}ready\n "), 20),
        "ready"
    );
    assert_eq!(bounded_notification_text(Some("abcdef"), 3), "abc");
    assert_eq!(bounded_notification_text(Some("\u{0001}\u{0002}"), 20), "");
}

#[test]
fn notification_grants_keep_active_and_targeted_paths_separate() {
    let g = grants(&["hook:run-agent"]);
    assert!(!g.contains(GRANT_NOTIFY));
    let g = grants(&[GRANT_NOTIFY]);
    assert!(g.contains(GRANT_NOTIFY));
    assert!(!g.contains(GRANT_NOTIFY_TARGET));
    let g = grants(&[GRANT_NOTIFY_TARGET]);
    assert!(g.contains(GRANT_NOTIFY_TARGET));
    assert!(!g.contains(GRANT_NOTIFY));
    assert_eq!(
        dispatch_path_for("notifications.send"),
        Some("host.notifications_send")
    );
}

#[test]
fn targeted_notification_has_a_dedicated_dispatch_path() {
    assert_eq!(
        dispatch_path_for("notifications.send"),
        Some("host.notifications_send")
    );
}

/// The sealing key is derived from the CANONICAL plugin id, so canonicalization
/// must be total and idempotent. If it ever stopped being either, the subkey
/// would change and every value the plugin had already sealed would become
/// permanently unopenable — with no error louder than an AEAD tag failure.
/// This pins the exact composition `crypto()` performs.
#[test]
fn crypto_derives_from_a_stable_canonical_id() {
    use crate::plugin_manifest::canonical_plugin_id;

    // Idempotent: canonicalizing an already-canonical id is a no-op, so a
    // double-canonicalized call site cannot drift from a single one.
    for id in ["@ryu/goal", "@acme/thing", "unscoped-third-party"] {
        assert_eq!(
            canonical_plugin_id(canonical_plugin_id(id)),
            canonical_plugin_id(id)
        );
    }

    // A legacy (pre-scoping) id and its canonical form must land on the SAME
    // key, or upgrading a built-in orphans its sealed data.
    let legacy = canonical_plugin_id("goal");
    let scoped = canonical_plugin_id("@ryu/goal");
    assert_eq!(
        legacy, scoped,
        "legacy id must canonicalize onto the scoped id"
    );
}

/// End-to-end through the real primitive with the real canonicalization: seal
/// round-trips, a DIFFERENT plugin cannot open it, and a master-key envelope is
/// refused rather than decrypted (no decryption oracle behind the grant).
#[test]
fn crypto_seals_round_trips_and_isolates_by_plugin() {
    use crate::plugin_manifest::canonical_plugin_id;

    // A unit test has no booted Core, so the crypto host seam is empty and every
    // key lookup fails. Install a throwaway one and pin the key via the env
    // rung of the custody ladder, so the test never touches the real keychain
    // or `~/.ryu`. Both installs are idempotent `OnceLock`s: if the full-suite
    // run already initialised them, the existing key is used instead — which is
    // fine, because nothing below asserts on the key's VALUE, only on the
    // seal/open algebra.
    struct TestCryptoHost(std::path::PathBuf);
    impl ryu_crypto::CryptoHost for TestCryptoHost {
        fn keyring_account_suffix(&self) -> String {
            "-bridge-test".to_string()
        }
        fn ryu_dir(&self) -> std::path::PathBuf {
            self.0.clone()
        }
    }
    // BASE64 of 32 zero bytes. It must be base64, not hex: a value that fails
    // to decode is WARNED AND IGNORED, and the ladder falls through to the real
    // OS keychain — which is both a slow test and one that touches the
    // developer's actual keychain. (This test did exactly that until the key
    // was fixed; the tell was a 46-second unit test.)
    std::env::set_var(
        "RYU_MASTER_KEY",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
    ryu_crypto::set_global_host(std::sync::Arc::new(TestCryptoHost(
        std::env::temp_dir().join("ryu-bridge-crypto-test"),
    )));

    // No skip branch: an error here is a real failure, not an environment
    // quirk. An earlier version returned early and the test passed while
    // asserting nothing.
    let mine = ryu_crypto::plugin_cipher(canonical_plugin_id("@ryu/goal"))
        .expect("plugin cipher for @ryu/goal");
    let sealed = mine.seal("hunter2").expect("seal");
    assert!(
        sealed.starts_with("encp:v1:"),
        "own envelope, not the master one"
    );
    assert_eq!(mine.open(&sealed).expect("open"), "hunter2");

    let theirs = ryu_crypto::plugin_cipher(canonical_plugin_id("@acme/other")).expect("cipher");
    assert!(
        theirs.open(&sealed).is_err(),
        "another app must not open it"
    );

    // Master-key ciphertext is REFUSED, not decrypted. This is what keeps the
    // grant from being a general decryption oracle over anything the app can read.
    assert!(
        mine.open("enc:v1:AAAA").is_err(),
        "master envelope must be refused"
    );

    // Never-sealed values pass through so a store can migrate in place.
    assert_eq!(mine.open("plain").expect("legacy passthrough"), "plain");
}
