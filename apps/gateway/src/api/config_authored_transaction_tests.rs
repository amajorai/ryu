use super::*;

#[tokio::test]
async fn provider_receipt_does_not_acknowledge_unrelated_config_or_classifier_state() {
    let file = crate::config::test_config_path::ConfigPathGuard::isolated("provider-scope-receipt");
    let mut original = GatewayConfig::default();
    original.firewall.enabled = false;
    let state = std::sync::Arc::new(crate::state::AppState::new_for_test(
        original.clone(),
        AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap(),
        crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default()),
    ));
    state
        .provider_runtime
        .set_environment_for_test(crate::config::ProviderEnvironment::default());
    let old_auth = state.with_auth(Clone::clone);
    let old_classifier = state.smart_router.active();
    let old_wallet = std::sync::Arc::clone(&state.wallet);
    let mut pending = original;
    pending.firewall.enabled = true;
    pending.auth.master_key = Some("unrelated-pending-master".to_owned());
    pending.routing.smart_routing.enabled = true;
    pending.providers.openai = Some(crate::config::OpenAiProviderConfig {
        api_key: "new-provider-key".to_owned(),
        api_keys: vec![],
        base_url: "https://api.openai.com/v1".to_owned(),
    });
    pending
        .providers
        .environment_imports
        .insert("openai".to_owned(), false);
    pending.save().unwrap();
    let transaction = ryu_gw_credentials::ConfigFileTransaction::acquire(file.path()).unwrap();
    let revision = transaction.snapshot().revision().clone();
    drop(transaction);
    let receipt = state
        .provider_runtime
        .apply_revision(file.path().to_owned(), revision)
        .await;
    assert!(matches!(
        receipt,
        ryu_gw_credentials::ProviderApplyOutcome::Applied { .. }
    ));
    assert!(state
        .provider_runtime
        .snapshot()
        .providers
        .get("openai")
        .is_some());
    assert!(!state.with_firewall(|firewall| firewall.config().enabled));
    assert_eq!(
        state.with_auth(|auth| auth.master_key.clone()),
        old_auth.master_key
    );
    assert!(std::sync::Arc::ptr_eq(
        &state.smart_router.active(),
        &old_classifier
    ));
    assert!(std::sync::Arc::ptr_eq(&state.wallet, &old_wallet));
    let view = serde_json::to_value(receipt).unwrap();
    assert!(view.get("live").is_none());
    assert!(view.get("applied").is_none());
}

#[tokio::test]
async fn policy_targets_guarded_authored_accounts_including_pending_credential_edits() {
    let file =
        crate::config::test_config_path::ConfigPathGuard::isolated("policy-authored-accounts");
    let mut original = GatewayConfig::default();
    original.auth.require_auth = false;
    original.providers.openai = Some(crate::config::OpenAiProviderConfig {
        api_key: "account-old".to_owned(),
        api_keys: vec![],
        base_url: "https://api.openai.com/v1".to_owned(),
    });
    original
        .providers
        .environment_imports
        .insert("openai".to_owned(), false);
    original.save().unwrap();
    let state = std::sync::Arc::new(crate::state::AppState::new_for_test(
        original.clone(),
        AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap(),
        crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default()),
    ));
    state
        .provider_runtime
        .set_environment_for_test(crate::config::ProviderEnvironment::default());
    let old_snapshot = state.provider_runtime.snapshot();
    let mut pending = original;
    pending.providers.openai.as_mut().unwrap().api_key = "account-new".to_owned();
    pending.save().unwrap();
    let before = std::fs::read(file.path()).unwrap();
    let old_id = ryu_gw_credentials::provider_account_id("openai", "account-old");
    let peer = ConnectInfo("127.0.0.1:5".parse::<SocketAddr>().unwrap());
    let stale: ConfigPatch = serde_json::from_value(
        json!({"providerAccountPolicies":{"openai":{(old_id):{"name":"Stale rename"}}}}),
    )
    .unwrap();
    assert!(matches!(
        put_config(State(state.clone()), peer, HeaderMap::new(), Json(stale)).await,
        Err(GatewayError::ConfigConflict(_))
    ));
    assert_eq!(std::fs::read(file.path()).unwrap(), before);
    assert!(std::sync::Arc::ptr_eq(
        &old_snapshot,
        &state.provider_runtime.snapshot()
    ));
    let new_id = ryu_gw_credentials::provider_account_id("openai", "account-new");
    let fresh:ConfigPatch=serde_json::from_value(json!({"providerAccountPolicies":{"openai":{(new_id.clone()):{"name":"New authored account","priority":2}}}})).unwrap();
    let Json(response) = put_config(State(state.clone()), peer, HeaderMap::new(), Json(fresh))
        .await
        .unwrap();
    assert_eq!(response["providerAccountsApplied"], true);
    assert_eq!(response["providerApplication"]["status"], "applied");
    assert_eq!(
        response["providerApplication"]["appliedRevision"],
        response["configRevision"]
    );
    let applied = state.provider_runtime.snapshot();
    assert_eq!(
        applied.config.openai.as_ref().unwrap().api_key,
        "account-new"
    );
    assert_eq!(
        applied.config.account_policies["openai"][&new_id].name,
        "New authored account"
    );
    assert!(old_snapshot.config.account_policies.is_empty());
}

#[tokio::test]
async fn account_strategy_patch_applies_live_and_appears_in_redacted_readback() {
    let _file = crate::config::test_config_path::ConfigPathGuard::isolated("account-strategy-live");
    let mut config = GatewayConfig::default();
    config.auth.require_auth = false;
    config.providers.openai = Some(crate::config::OpenAiProviderConfig {
        api_key: "key-a".to_owned(),
        api_keys: vec!["key-b".to_owned()],
        base_url: "https://api.openai.com/v1".to_owned(),
    });
    config.save().unwrap();
    let state = std::sync::Arc::new(crate::state::AppState::new_for_test(
        config,
        AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap(),
        crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default()),
    ));
    state
        .provider_runtime
        .set_environment_for_test(crate::config::ProviderEnvironment::default());
    let patch: ConfigPatch = serde_json::from_value(json!({
        "providerAccountStrategies": {"openai":"quota_first"}
    }))
    .unwrap();
    let Json(response) = put_config(
        State(state.clone()),
        ConnectInfo("127.0.0.1:5".parse().unwrap()),
        HeaderMap::new(),
        Json(patch),
    )
    .await
    .unwrap();
    assert_eq!(response["providerAccountsApplied"], true);
    assert_eq!(response["providerApplication"]["status"], "applied");
    let snapshot = state.provider_runtime.snapshot();
    assert_eq!(
        snapshot.config.account_strategies["openai"],
        ryu_gw_providers::AccountSelectionStrategy::QuotaFirst
    );
    let view = serde_json::to_value(redact_providers(&snapshot.config)).unwrap();
    assert_eq!(view["accountStrategies"]["openai"], "quota_first");
}

#[tokio::test]
async fn private_revision_handler_requires_local_admin_and_rejects_extra_fields() {
    let file = crate::config::test_config_path::ConfigPathGuard::isolated("private-provider-apply");
    let mut config = GatewayConfig::default();
    config.auth.require_auth = true;
    config.auth.master_key = Some("apply-admin-test".to_owned());
    config.save().unwrap();
    let transaction = ryu_gw_credentials::ConfigFileTransaction::acquire(file.path()).unwrap();
    let revision = transaction.snapshot().revision().clone();
    drop(transaction);
    let state = std::sync::Arc::new(crate::state::AppState::new_for_test(
        config,
        AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap(),
        crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default()),
    ));
    state
        .provider_runtime
        .set_environment_for_test(crate::config::ProviderEnvironment::default());
    let mut headers = HeaderMap::new();
    headers.insert("authorization", "Bearer apply-admin-test".parse().unwrap());
    let request = || {
        Json(ProviderApplyRequest {
            revision: revision.clone(),
        })
    };
    assert!(matches!(
        apply_provider_revision(
            State(state.clone()),
            ConnectInfo("192.0.2.1:5".parse().unwrap()),
            headers.clone(),
            request()
        )
        .await,
        Err(GatewayError::Unauthorized(_))
    ));
    assert!(apply_provider_revision(
        State(state.clone()),
        ConnectInfo("127.0.0.1:5".parse().unwrap()),
        HeaderMap::new(),
        request()
    )
    .await
    .is_err());
    assert!(serde_json::from_value::<ProviderApplyRequest>(
        json!({"revision":revision,"apiKey":"never-needed"})
    )
    .is_err());
    let Json(outcome) = apply_provider_revision(
        State(state),
        ConnectInfo("127.0.0.1:5".parse().unwrap()),
        headers,
        request(),
    )
    .await
    .unwrap();
    assert!(matches!(
        outcome,
        ryu_gw_credentials::ProviderApplyOutcome::Applied { .. }
    ));
}

#[tokio::test]
async fn config_handler_conflict_preserves_live_state_and_fresh_revision_applies() {
    use axum::response::IntoResponse;
    let path =
        crate::config::test_config_path::ConfigPathGuard::isolated("handler-transaction-conflict");
    let mut config = GatewayConfig::default();
    config.auth.require_auth = false;
    config.save().unwrap();
    let enabled = config.firewall.enabled;
    let state = std::sync::Arc::new(crate::state::AppState::new_for_test(
        config,
        AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap(),
        crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default()),
    ));
    let peer = ConnectInfo("127.0.0.1:5".parse().unwrap());
    let Json(view) = get_config(State(state.clone()), peer, HeaderMap::new())
        .await
        .unwrap();
    let stale = view["configRevision"].as_str().unwrap().to_owned();
    let mut external = ryu_gw_credentials::ConfigFileTransaction::acquire(path.path()).unwrap();
    let old = external.snapshot().revision().clone();
    let bytes = format!(
        "future_root = 'preserved'\n{}",
        std::str::from_utf8(external.snapshot().bytes()).unwrap()
    );
    let current = external.commit(&old, bytes.as_bytes()).unwrap();
    drop(external);
    let patch =
        serde_json::from_value(json!({"expectedRevision":stale,"firewall":{"enabled":!enabled}}))
            .unwrap();
    let error = put_config(State(state.clone()), peer, HeaderMap::new(), Json(patch))
        .await
        .unwrap_err();
    let response = error.into_response();
    assert_eq!(response.status(), axum::http::StatusCode::CONFLICT);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["currentRevision"], current.as_str());
    assert_eq!(body["error"]["code"], "config_revision_conflict");
    assert_eq!(
        state.with_firewall(|firewall| firewall.config().enabled),
        enabled
    );
    let patch =
        serde_json::from_value(json!({"expectedRevision":current,"firewall":{"enabled":!enabled}}))
            .unwrap();
    let Json(applied) = put_config(State(state.clone()), peer, HeaderMap::new(), Json(patch))
        .await
        .unwrap();
    assert_eq!(applied["persisted"], true);
    assert_eq!(applied["applied"]["live"], true);
    assert_eq!(applied["applied"]["restartRequired"], false);
    assert_eq!(
        state.with_firewall(|firewall| firewall.config().enabled),
        !enabled
    );
    let saved: toml::Value =
        toml::from_str(&std::fs::read_to_string(path.path()).unwrap()).unwrap();
    assert_eq!(saved["future_root"].as_str(), Some("preserved"));
}

#[test]
fn gemini_account_routing_persists_only_supported_strategies() {
    let guard = crate::config::test_config_path::ConfigPathGuard::isolated(
        "gemini-account-strategy-transaction",
    );
    std::fs::create_dir_all(guard.path().parent().unwrap()).unwrap();
    std::fs::write(guard.path(), "bind = '127.0.0.1:7981'\n").unwrap();
    for strategy in [
        ryu_gw_providers::AccountSelectionStrategy::RoundRobin,
        ryu_gw_providers::AccountSelectionStrategy::FillFirst,
    ] {
        let (transaction, _) = commit_authored_config(
            guard.path(),
            None,
            Vec::new(),
            None,
            Some(HashMap::from([("gemini".to_owned(), strategy)])),
            None,
            crate::providers::ProviderInputs::default(),
        )
        .unwrap();
        drop(transaction);
        let saved: ProvidersConfig =
            toml::from_str::<toml::Value>(&std::fs::read_to_string(guard.path()).unwrap()).unwrap()
                ["providers"]
                .clone()
                .try_into()
                .unwrap();
        assert_eq!(saved.account_strategies["gemini"], strategy);
    }
    let original = std::fs::read(guard.path()).unwrap();
    for strategy in [
        ryu_gw_providers::AccountSelectionStrategy::QuotaFirst,
        ryu_gw_providers::AccountSelectionStrategy::ResetFirst,
    ] {
        let result = commit_authored_config(
            guard.path(),
            None,
            Vec::new(),
            None,
            Some(HashMap::from([("gemini".to_owned(), strategy)])),
            None,
            crate::providers::ProviderInputs::default(),
        );
        assert!(matches!(result, Err(GatewayError::BadRequest(_))));
        assert_eq!(std::fs::read(guard.path()).unwrap(), original);
    }
    let result = commit_authored_config(
        guard.path(),
        None,
        Vec::new(),
        None,
        None,
        Some(HashMap::from([("gemini".to_owned(), 60)])),
        crate::providers::ProviderInputs::default(),
    );
    assert!(matches!(result, Err(GatewayError::BadRequest(_))));
    assert_eq!(std::fs::read(guard.path()).unwrap(), original);
}

#[test]
fn account_strategy_patch_persists_and_rejects_unsupported_providers() {
    let guard =
        crate::config::test_config_path::ConfigPathGuard::isolated("account-strategy-transaction");
    std::fs::create_dir_all(guard.path().parent().unwrap()).unwrap();
    std::fs::write(guard.path(), "bind = '127.0.0.1:7981'\n").unwrap();
    let strategies = HashMap::from([
        (
            "huggingface".to_owned(),
            ryu_gw_providers::AccountSelectionStrategy::ResetFirst,
        ),
        (
            "openai".to_owned(),
            ryu_gw_providers::AccountSelectionStrategy::QuotaFirst,
        ),
        (
            "anthropic".to_owned(),
            ryu_gw_providers::AccountSelectionStrategy::FillFirst,
        ),
    ]);
    let (transaction, _) = commit_authored_config(
        guard.path(),
        None,
        Vec::new(),
        None,
        Some(strategies),
        Some(HashMap::from([
            ("openai".to_owned(), 65),
            ("huggingface".to_owned(), 70),
        ])),
        crate::providers::ProviderInputs::default(),
    )
    .unwrap();
    drop(transaction);
    let saved: toml::Value =
        toml::from_str(&std::fs::read_to_string(guard.path()).unwrap()).unwrap();
    assert_eq!(
        saved["providers"]["accountStrategies"]["openai"].as_str(),
        Some("quota_first")
    );
    assert_eq!(
        saved["providers"]["accountStrategies"]["anthropic"].as_str(),
        Some("fill_first")
    );
    assert_eq!(
        saved["providers"]["accountDrainThresholds"]["openai"].as_integer(),
        Some(65)
    );
    let providers: ProvidersConfig = saved["providers"].clone().try_into().unwrap();
    let view = serde_json::to_value(redact_providers(&providers)).unwrap();
    assert_eq!(view["accountDrainThresholds"]["openai"], 65);
    assert_eq!(view["accountStrategies"]["huggingface"], "reset_first");
    assert_eq!(view["accountDrainThresholds"]["huggingface"], 70);
    let invalid_percent = commit_authored_config(
        guard.path(),
        None,
        Vec::new(),
        None,
        None,
        Some(HashMap::from([("openai".to_owned(), 0)])),
        crate::providers::ProviderInputs::default(),
    );
    assert!(matches!(invalid_percent, Err(GatewayError::BadRequest(_))));
    let rejected = commit_authored_config(
        guard.path(),
        None,
        Vec::new(),
        None,
        Some(HashMap::from([(
            "modal".to_owned(),
            ryu_gw_providers::AccountSelectionStrategy::ResetFirst,
        )])),
        None,
        crate::providers::ProviderInputs::default(),
    );
    assert!(matches!(rejected, Err(GatewayError::BadRequest(_))));
}

#[test]
fn section_patch_preserves_unrequested_authored_and_future_values() {
    let guard =
        crate::config::test_config_path::ConfigPathGuard::isolated("raw-section-transaction");
    let text = "future_root = 'keep'\n[providers.openai]\napi_key = 'authored-secret'\nfuture_option = 'keep-provider'\n[providers.classify]\nbase_url = 'https://operator.example/v1'\n[firewall_org_overlays.org]\nlocked_fields = ['enabled']\n[auth]\nrequire_auth = false\nfuture_auth = 'keep-auth'\n";
    std::fs::create_dir_all(guard.path().parent().unwrap()).unwrap();
    std::fs::write(guard.path(), text).unwrap();
    let patch: ConfigPatch = serde_json::from_value(json!({"firewall":{"enabled":false}})).unwrap();
    let (transaction, revision) = commit_authored_config(
        guard.path(),
        None,
        authored_sections(&patch, &None, &None).unwrap(),
        None,
        None,
        None,
        crate::providers::ProviderInputs::default(),
    )
    .unwrap();
    assert_eq!(transaction.snapshot().revision(), &revision);
    drop(transaction);
    let disk = std::fs::read_to_string(guard.path()).unwrap();
    // The commit sealed the authored plaintext key on its way to disk.
    assert!(!disk.contains("authored-secret"));
    let saved: toml::Value = ryu_gw_credentials::sealed_config::open_document(&disk).unwrap();
    assert_eq!(saved["future_root"].as_str(), Some("keep"));
    assert_eq!(
        saved["providers"]["openai"]["api_key"].as_str(),
        Some("authored-secret")
    );
    assert_eq!(
        saved["providers"]["openai"]["future_option"].as_str(),
        Some("keep-provider")
    );
    assert_eq!(
        saved["providers"]["classify"]["base_url"].as_str(),
        Some("https://operator.example/v1")
    );
    assert!(saved["firewall_org_overlays"]["org"].is_table());
    assert_eq!(saved["auth"]["future_auth"].as_str(), Some("keep-auth"));
    assert!(saved.get("routing").is_none());
}

#[test]
fn malformed_authored_file_fails_closed_and_does_not_echo_contents() {
    let guard =
        crate::config::test_config_path::ConfigPathGuard::isolated("invalid-authored-transaction");
    std::fs::create_dir_all(guard.path().parent().unwrap()).unwrap();
    std::fs::write(guard.path(), "api_key = 'sensitive-material'\n[broken").unwrap();
    let error = commit_authored_config(
        guard.path(),
        None,
        Vec::new(),
        None,
        None,
        None,
        crate::providers::ProviderInputs::default(),
    )
    .unwrap_err();
    assert!(!format!("{error:?}").contains("sensitive-material"));
    assert_eq!(
        std::fs::read_to_string(guard.path()).unwrap(),
        "api_key = 'sensitive-material'\n[broken"
    );
}

#[test]
fn stale_revision_rejects_without_publishing_policy_or_section_updates() {
    let guard =
        crate::config::test_config_path::ConfigPathGuard::isolated("revision-conflict-transaction");
    let first = ryu_gw_credentials::ConfigFileTransaction::acquire(guard.path()).unwrap();
    let stale = first.snapshot().revision().clone();
    drop(first);
    std::fs::write(guard.path(), "bind = '127.0.0.1:7981'\n").unwrap();
    let patch: ConfigPatch = serde_json::from_value(json!({"firewall":{"enabled":false}})).unwrap();
    let error = commit_authored_config(
        guard.path(),
        Some(&stale),
        authored_sections(&patch, &None, &None).unwrap(),
        None,
        None,
        None,
        crate::providers::ProviderInputs::default(),
    )
    .unwrap_err();
    assert!(matches!(error, GatewayError::ConfigConflict(_)));
    assert_eq!(
        std::fs::read_to_string(guard.path()).unwrap(),
        "bind = '127.0.0.1:7981'\n"
    );
}
