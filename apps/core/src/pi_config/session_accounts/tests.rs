use super::*;

fn vault() -> super::super::accounts::AccountVault {
    super::super::accounts::AccountVault::in_memory().unwrap()
}

fn save(vault: &super::super::accounts::AccountVault, account: &str) {
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
fn projection_rejects_tokens_inside_actual_sdk_refresh_window() {
    let directory = tempfile::tempdir().unwrap();
    let credential = json!({"type":"oauth", "access":"fixture-access", "refresh":"must-stay-sealed",
        "expires":super::super::now_unix().saturating_mul(1000).saturating_add(60_000)});
    assert!(publish_credential(directory.path(), "github-copilot", &credential).is_err());
    assert!(!directory.path().join("auth.json").exists());
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
fn access_projection_retains_expiry_metadata_and_withholds_refresh() {
    let directory = tempfile::tempdir().unwrap();
    let credential = json!({"type":"oauth", "access":"fixture-access", "refresh":"must-stay-sealed", "expires":4_000_000_000_000_u64,
        "enterpriseDomain":"copilot.example.test", "accountId":"fixture-account"});
    publish_credential(directory.path(), "github-copilot", &credential).unwrap();
    let projected: Value =
        serde_json::from_str(&std::fs::read_to_string(directory.path().join("auth.json")).unwrap())
            .unwrap();
    assert_eq!(projected.as_object().unwrap().len(), 1);
    let projected = &projected["github-copilot"];
    assert_eq!(projected["expires"], credential["expires"]);
    assert_eq!(
        projected["enterpriseDomain"],
        credential["enterpriseDomain"]
    );
    assert_eq!(projected["accountId"], credential["accountId"]);
    assert_eq!(projected["refresh"], "");
    assert_eq!(credential["refresh"], "must-stay-sealed");
}

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
fn api_key_session_env_carries_the_sealed_key_and_projection_is_removed() {
    super::super::accounts::with_test_vault(|vault| {
        let scope = super::super::accounts::provider_scope("xai");
        vault
            .upsert(
                &scope,
                "only",
                "only",
                super::super::accounts::KIND_API_KEY,
                Some(json!("fixture-session-env-key")),
            )
            .unwrap();
        let captured = SessionAccount {
            provider_id: "xai".to_owned(),
            account_id: "only".to_owned(),
            session_key: "fixture-session".to_owned(),
            credential_kind: super::super::accounts::KIND_API_KEY.to_owned(),
        };
        assert_eq!(
            captured.secret_env().unwrap(),
            vec![(
                super::super::secret_env::SESSION_KEY_ENV.to_owned(),
                "fixture-session-env-key".to_owned()
            )]
        );
        let oauth = SessionAccount {
            credential_kind: super::super::accounts::KIND_OAUTH.to_owned(),
            ..captured.clone()
        };
        assert!(oauth.secret_env().unwrap().is_empty());
    });

    let root = tempfile::tempdir().unwrap();
    let session = root.path().join("fixture-session");
    publish_auth(
        &session,
        "github-copilot",
        json!({"type":"oauth", "access":"fixture-access", "refresh":"", "expires":1}),
    )
    .unwrap();
    std::fs::write(root.path().join("stray-file"), "keep").unwrap();
    assert!(session.join("auth.json").exists());
    assert_eq!(sweep_projections_in(root.path()), 1);
    assert!(!session.join("auth.json").exists());
    assert!(
        session.exists(),
        "only the credential projection is removed"
    );
    assert!(root.path().join("stray-file").exists());
    publish_auth(
        &session,
        "github-copilot",
        json!({"type":"api_key","key":"${RYU_PI_SESSION_KEY}"}),
    )
    .unwrap();
    remove_projection_in(&session);
    assert!(!session.join("auth.json").exists());
}

#[test]
fn boot_sweep_removes_legacy_provider_list_copies_with_plaintext_keys() {
    let root = tempfile::tempdir().unwrap();
    let session = root.path().join("legacy-session");
    std::fs::create_dir_all(&session).unwrap();
    // A verbatim copy an older build left: another provider's literal key and
    // the Core node bearer as a literal header.
    let legacy = json!({
        "providers": {
            "custom": { "apiKey": "fixture-legacy-custom-key" },
            "ryu-node": { "headers": { "x-ryu-node-token": "fixture-legacy-node-token" } }
        }
    });
    std::fs::write(session.join("models.json"), legacy.to_string()).unwrap();
    std::fs::write(
        session.join("models-store.json"),
        json!({"custom": {"models": [{"headers": {"Authorization": "Bearer fixture-legacy-custom-key"}}]}})
            .to_string(),
    )
    .unwrap();
    std::fs::write(session.join("settings.json"), "{}").unwrap();

    assert_eq!(sweep_projections_in(root.path()), 2);
    for entry in walk(&session) {
        let bytes = std::fs::read(&entry).unwrap();
        for secret in ["fixture-legacy-custom-key", "fixture-legacy-node-token"] {
            assert!(
                !bytes
                    .windows(secret.len())
                    .any(|window| window == secret.as_bytes()),
                "{} still holds {secret}",
                entry.display()
            );
        }
    }
    assert!(!session.join("models.json").exists());
    assert!(!session.join("models-store.json").exists());
    assert!(
        session.join("settings.json").exists(),
        "non-secret assets stay"
    );
    assert_eq!(sweep_projections_in(root.path()), 0);
}

fn walk(directory: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(directory).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            files.extend(walk(&path));
        } else {
            files.push(path);
        }
    }
    files
}

#[test]
fn projection_survives_until_the_last_instance_sharing_it_exits() {
    let root = tempfile::tempdir().unwrap();
    let session = root.path().join("shared-session");
    let key = format!("lease-{}", uuid::Uuid::new_v4().simple());
    let older = ProjectionLease::acquire(key.clone(), session.clone());
    publish_auth(
        &session,
        "xai",
        json!({"type":"api_key","key":"${RYU_PI_SESSION_KEY}"}),
    )
    .unwrap();
    // A replacement instance for the same conversation spawns while the older
    // one drains its in-flight turn.
    let newer = ProjectionLease::acquire(key.clone(), session.clone());
    drop(older);
    assert!(
        session.join("auth.json").exists(),
        "the live instance keeps its credential"
    );
    drop(newer);
    assert!(!session.join("auth.json").exists());

    // A later instance takes a fresh lease and its prepare_turn rewrites.
    let later = ProjectionLease::acquire(key, session.clone());
    publish_auth(
        &session,
        "xai",
        json!({"type":"api_key","key":"${RYU_PI_SESSION_KEY}"}),
    )
    .unwrap();
    assert!(session.join("auth.json").exists());
    drop(later);
    assert!(!session.join("auth.json").exists());
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
