#[test]
fn direct_speech_readback_exposes_multiple_accounts_without_auth_material() {
    let config: ProvidersConfig = toml::from_str(
        "[google_tts]\naccounts=[{access_token='ya29.first-token',quota_project='ryu-demo-123'},{access_token='ya29.second-token',quota_project='ryu-demo-123'}]\n[polly]\nregion='us-east-1'\naccounts=[{access_key_id='ABCDEFGHIJKLMNOPQRST',secret_access_key='abcdefghijklmnopqrstuvwxyz0123456789ABCD'}]",
    )
    .unwrap();
    let view = serde_json::to_value(super::redact_providers(&config)).unwrap();
    assert_eq!(view["google_tts"]["mode"], "supplied_oauth_token");
    assert_eq!(view["google_tts"]["account_count"], 2);
    assert_eq!(view["accounts"]["google-tts"].as_array().unwrap().len(), 2);
    assert_eq!(view["polly"]["mode"], "explicit_sigv4");
    assert_eq!(view["polly"]["region"], "us-east-1");
    assert_eq!(view["polly"]["account_count"], 1);
    assert_eq!(view["accounts"]["polly"].as_array().unwrap().len(), 1);
    let redacted = view.to_string();
    for secret in [
        "ya29.first-token",
        "ya29.second-token",
        "ABCDEFGHIJKLMNOPQRST",
        "abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    ] {
        assert!(!redacted.contains(secret));
    }
}

#[test]
fn edge_consumer_readback_is_anonymous_without_account_controls() {
    let mut providers = ProvidersConfig::default();
    providers.edge_tts = Some(crate::config::EdgeTtsConfig {
        anonymous_consumer_opt_in: true,
    });
    let view = serde_json::to_value(super::redact_providers(&providers)).unwrap();
    let edge = &view["edge_tts"];
    assert_eq!(edge["classification"], "unofficial_anonymous_consumer");
    assert_eq!(edge["mode"], "anonymous");
    assert_eq!(edge["anonymous_consumer_opt_in"], true);
    assert!(edge.get("api_key").is_none());
    assert!(edge.get("accounts").is_none());
}

#[test]
fn google_translate_consumer_readback_has_no_credentials_or_cloud_accounts() {
    let config = ProvidersConfig {
        google_translate_tts: Some(crate::config::GoogleTranslateTtsConfig {
            anonymous_consumer_opt_in: true,
        }),
        ..Default::default()
    };
    let view = serde_json::to_value(super::redact_providers(&config)).unwrap();
    assert_eq!(
        view["googleTranslateTts"]["anonymous_consumer_opt_in"],
        true
    );
    assert_eq!(
        view["googleTranslateTts"]["classification"],
        "unofficial_anonymous_consumer"
    );
    assert_eq!(view["googleTranslateTts"]["mode"], "anonymous");
    assert!(view["google_tts"].is_null());
    assert!(view["accounts"].get("google-translate-tts").is_none());
}
#[test]
fn runway_readback_masks_credentials_and_exposes_named_accounts() {
    let config: ProvidersConfig =
        toml::from_str("[runway]\napi_key='private-first'\napi_keys=['private-second']").unwrap();
    let view = serde_json::to_value(super::redact_providers(&config)).unwrap();
    assert_eq!(view["runway"]["api_key_count"], 2);
    assert_eq!(view["accounts"]["runway"].as_array().unwrap().len(), 2);
    assert!(!view.to_string().contains("private-first"));
    assert!(!view.to_string().contains("private-second"));
    let registry = crate::providers::ProviderRegistry::new(
        &config,
        std::sync::Arc::new(crate::quota::ProviderQuotas::new()),
    );
    assert_eq!(registry.get("runway").unwrap().name(), "runway");
}

#[test]
fn topaz_readback_masks_credentials_and_registers_direct_video_provider() {
    let config: ProvidersConfig =
        toml::from_str("[topaz]\napi_key='private-first'\napi_keys=['private-second']").unwrap();
    let view = serde_json::to_value(super::redact_providers(&config)).unwrap();
    assert_eq!(view["topaz"]["api_key_count"], 2);
    assert_eq!(view["accounts"]["topaz"].as_array().unwrap().len(), 2);
    assert!(!view.to_string().contains("private-first"));
    assert!(!view.to_string().contains("private-second"));
    let registry = crate::providers::ProviderRegistry::new(
        &config,
        std::sync::Arc::new(crate::quota::ProviderQuotas::new()),
    );
    assert_eq!(registry.get("topaz").unwrap().name(), "topaz");
}

#[test]
fn minimax_readback_masks_credentials_and_exposes_named_accounts() {
    let config: ProvidersConfig =
        toml::from_str("[minimax]\napi_key='private-first'\napi_keys=['private-second']").unwrap();
    let view = serde_json::to_value(super::redact_providers(&config)).unwrap();
    assert_eq!(view["minimax"]["api_key_count"], 2);
    assert_eq!(view["accounts"]["minimax"].as_array().unwrap().len(), 2);
    assert!(!view.to_string().contains("private-first"));
    assert!(!view.to_string().contains("private-second"));
    let registry = crate::providers::ProviderRegistry::new(
        &config,
        std::sync::Arc::new(crate::quota::ProviderQuotas::new()),
    );
    assert_eq!(registry.get("minimax").unwrap().name(), "minimax");
}

#[test]
fn bfl_readback_masks_credentials_and_exposes_named_accounts() {
    let config: ProvidersConfig =
        toml::from_str("[bfl]\napi_key='private-first'\napi_keys=['private-second']").unwrap();
    let view = serde_json::to_value(super::redact_providers(&config)).unwrap();
    assert_eq!(view["bfl"]["api_key_count"], 2);
    assert_eq!(view["accounts"]["bfl"].as_array().unwrap().len(), 2);
    assert!(!view.to_string().contains("private-first"));
    assert!(!view.to_string().contains("private-second"));
    let registry = crate::providers::ProviderRegistry::new(
        &config,
        std::sync::Arc::new(crate::quota::ProviderQuotas::new()),
    );
    assert_eq!(registry.get("bfl").unwrap().name(), "bfl");
}

#[test]
fn stability_readback_masks_credentials_and_registers_native_image_provider() {
    let config: ProvidersConfig =
        toml::from_str("[stability]\napi_key='private-first'\napi_keys=['private-second']")
            .unwrap();
    let view = serde_json::to_value(super::redact_providers(&config)).unwrap();
    assert_eq!(view["stability"]["api_key_count"], 2);
    assert_eq!(view["accounts"]["stability"].as_array().unwrap().len(), 2);
    assert!(!view.to_string().contains("private-first"));
    assert!(!view.to_string().contains("private-second"));
    let registry = crate::providers::ProviderRegistry::new(
        &config,
        std::sync::Arc::new(crate::quota::ProviderQuotas::new()),
    );
    assert_eq!(registry.get("stability").unwrap().name(), "stability");
}

#[test]
fn recraft_account_readback_is_masked_and_registered_as_image_only() {
    let providers: ProvidersConfig =
        toml::from_str("[recraft]\napi_key='secret-one'\napi_keys=['secret-two']").unwrap();
    let view = serde_json::to_value(super::redact_providers(&providers)).unwrap();
    assert_eq!(view["recraft"]["api_key_count"], 2);
    assert_eq!(view["accounts"]["recraft"].as_array().unwrap().len(), 2);
    assert!(!view.to_string().contains("secret-one"));
    assert!(!view.to_string().contains("secret-two"));
    let registry = crate::providers::ProviderRegistry::new(
        &providers,
        std::sync::Arc::new(crate::quota::ProviderQuotas::new()),
    );
    assert_eq!(registry.get("recraft").unwrap().name(), "recraft");
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn live_account_policy_patch_persists_and_preserves_session_affinity() {
    use crate::{
        audit::AuditLogger,
        config::{AuditConfig, AuthConfig, EvalsConfig, GatewayConfig},
        evals::EvalsRunner,
        state::AppState,
    };
    use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
    use serde_json::json;
    let _path =
        crate::config::test_config_path::ConfigPathGuard::isolated("live-provider-accounts");
    let captured = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let capture = captured.clone();
    let app = Router::new().route(
        "/chat/completions",
        post(move |headers: HeaderMap| {
            let capture = capture.clone();
            async move {
                capture
                    .lock()
                    .unwrap()
                    .push(headers["authorization"].to_str().unwrap().to_owned());
                Json(json!({"choices":[]}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut config = GatewayConfig::default();
    config.providers = serde_json::from_value(
        json!({"modal":{"api_key":"first", "api_keys":["second"], "base_url":base}}),
    )
    .unwrap();
    config.auth = AuthConfig {
        require_auth: true,
        master_key: Some("test-master".to_owned()),
        api_keys: vec![],
    };
    config.save().unwrap();
    let state = std::sync::Arc::new(AppState::new_for_test(
        config,
        AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap(),
        EvalsRunner::new(EvalsConfig::default()),
    ));
    let original_snapshot = state.provider_runtime.snapshot();
    let provider = original_snapshot.providers.get_owned("modal").unwrap();
    let request = json!({"messages":[]});
    provider
        .complete_for_session("test", &request, Some("existing"))
        .await
        .unwrap();
    let first = ryu_gw_credentials::provider_account_id("modal", "first");
    let second = ryu_gw_credentials::provider_account_id("modal", "second");
    let updates = json!({"providerAccountPolicies":{"modal":{
        (first.clone()):{"name":"Primary","enabled":true,"priority":10},
        (second.clone()):{"name":"Backup","enabled":true,"priority":0}
    }}});
    let peer = axum::extract::ConnectInfo("127.0.0.1:5".parse::<std::net::SocketAddr>().unwrap());
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("authorization", "Bearer test-master".parse().unwrap());
    let Json(applied) = super::put_config(
        State(state.clone()),
        peer,
        headers.clone(),
        Json(serde_json::from_value(updates).unwrap()),
    )
    .await
    .unwrap();
    assert_eq!(applied["providerAccountsApplied"], true);
    let replacement_snapshot = state.provider_runtime.snapshot();
    assert_ne!(original_snapshot.epoch, replacement_snapshot.epoch);
    assert!(original_snapshot
        .providers
        .account_policy_snapshot()
        .is_empty());
    let replacement_provider = replacement_snapshot.providers.get_owned("modal").unwrap();
    assert!(!std::sync::Arc::ptr_eq(&provider, &replacement_provider));
    provider
        .complete_for_session("test", &request, Some("existing"))
        .await
        .unwrap();
    replacement_provider
        .complete_for_session("test", &request, Some("fresh"))
        .await
        .unwrap();
    assert_eq!(
        *captured.lock().unwrap(),
        vec!["Bearer first", "Bearer first", "Bearer second"]
    );
    let Json(view) = super::get_config(State(state.clone()), peer, headers.clone())
        .await
        .unwrap();
    assert_eq!(view["providers"]["accounts"]["modal"][0]["name"], "Primary");
    assert_eq!(view["providers"]["accounts"]["modal"][0]["priority"], 10);
    let reloaded = super::persisted_config(&state);
    assert_eq!(
        reloaded.providers.account_policies["modal"][&first].priority,
        10
    );
    let before = state
        .provider_runtime
        .snapshot()
        .providers
        .account_policy_snapshot();
    let invalid: super::ConfigPatch = serde_json::from_value(
        json!({"providerAccountPolicies":{"modal":{"missing":{"name":"Unknown"}}}}),
    )
    .unwrap();
    assert!(
        super::put_config(State(state.clone()), peer, headers, Json(invalid))
            .await
            .is_err()
    );
    assert_eq!(
        state
            .provider_runtime
            .snapshot()
            .providers
            .account_policy_snapshot(),
        before
    );
    let unauthorized: super::ConfigPatch = serde_json::from_value(
        json!({"providerAccountPolicies":{"modal":{(first):{"name":"Unauthorized"}}}}),
    )
    .unwrap();
    assert!(super::put_config(
        State(state.clone()),
        peer,
        axum::http::HeaderMap::new(),
        Json(unauthorized)
    )
    .await
    .is_err());
    assert_eq!(
        state
            .provider_runtime
            .snapshot()
            .providers
            .account_policy_snapshot(),
        before
    );
    server.abort();
}

#[test]
fn named_account_readback_keeps_identity_after_key_reordering() {
    let mut providers: ProvidersConfig =
        toml::from_str("[fal]\napi_key='hidden-first'\napi_keys=['hidden-second']").unwrap();
    let id = ryu_gw_credentials::provider_account_id("fal", "hidden-second");
    providers.account_policies.insert(
        "fal".to_owned(),
        HashMap::from([(
            id.clone(),
            ryu_gw_credentials::ProviderAccountPolicy {
                drain_threshold_percent: None,
                name: "Backup".to_owned(),
                enabled: false,
                priority: 10,
            },
        )]),
    );
    let first = serde_json::to_value(super::redact_providers(&providers)).unwrap();
    assert_eq!(first["accounts"]["fal"][1]["id"], id);
    assert_eq!(first["accounts"]["fal"][1]["enabled"], false);
    providers.fal.as_mut().unwrap().api_key = "hidden-second".to_owned();
    providers.fal.as_mut().unwrap().api_keys = vec!["hidden-first".to_owned()];
    let second = serde_json::to_value(super::redact_providers(&providers)).unwrap();
    assert_eq!(second["accounts"]["fal"][0]["id"], id);
    assert_eq!(second["accounts"]["fal"][0]["name"], "Backup");
    assert!(!second.to_string().contains("hidden-first"));
    assert!(!second.to_string().contains("hidden-second"));
}

#[test]
fn account_override_toml_and_masked_readback_preserve_zero_and_restore_inheritance() {
    let id = ryu_gw_credentials::provider_account_id("openai", "hidden-account");
    let mut providers: ProvidersConfig = toml::from_str(&format!(
        "[openai]\napi_key='hidden-account'\n[accountPolicies.openai.'{id}']\nname='Work'\ndrain_threshold_percent=0"
    )).unwrap();
    let view = serde_json::to_value(super::redact_providers(&providers)).unwrap();
    assert_eq!(view["accounts"]["openai"][0]["drainThresholdPercent"], 0);
    assert!(!view.to_string().contains("hidden-account"));
    let policy = providers
        .account_policies
        .get_mut("openai")
        .unwrap()
        .get_mut(&id)
        .unwrap();
    let encoded = toml::to_string(policy).unwrap();
    assert_eq!(
        toml::from_str::<ryu_gw_credentials::ProviderAccountPolicy>(&encoded)
            .unwrap()
            .drain_threshold_percent,
        Some(0)
    );
    policy.drain_threshold_percent = None;
    assert!(!toml::to_string(policy)
        .unwrap()
        .contains("drain_threshold_percent"));
    let view = serde_json::to_value(super::redact_providers(&providers)).unwrap();
    assert!(view["accounts"]["openai"][0]
        .get("drainThresholdPercent")
        .is_none());
    assert!(toml::from_str::<ryu_gw_credentials::ProviderAccountPolicy>(
        "name='Work'\ndrain_threshold_percent=101"
    )
    .is_err());
}

#[test]
fn fal_readback_masks_multiple_accounts() {
    let providers: crate::config::ProvidersConfig =
        toml::from_str("[fal]\napi_key='hidden-first'\napi_keys=['hidden-first','hidden-second']")
            .unwrap();
    let view = serde_json::to_value(super::redact_providers(&providers)).unwrap();
    assert_eq!(view["fal"]["api_key_count"], 2);
    assert_eq!(view["fal"]["api_key"], "***");
    assert!(!view.to_string().contains("hidden-"));
}
#[test]
fn replicate_readback_masks_multiple_account_keys() {
    let providers: crate::config::ProvidersConfig = toml::from_str(
        "[replicate]\napi_key='private-first'\napi_keys=['private-first','private-second']",
    )
    .unwrap();
    let view = serde_json::to_value(super::redact_providers(&providers)).unwrap();
    assert_eq!(view["replicate"]["api_key_count"], 2);
    assert_eq!(view["replicate"]["api_key"], "***");
    assert!(!view.to_string().contains("private-"));
}
#[test]
fn modal_readback_counts_multiple_accounts_without_returning_keys() {
    let providers = crate::config::ProvidersConfig {
        modal: Some(crate::config::ModalProviderConfig {
            api_key: "secret-primary".to_owned(),
            api_keys: vec!["secret-primary".to_owned(), "secret-extra".to_owned()],
            base_url: "https://deployment.modal.run/v1".to_owned(),
        }),
        ..Default::default()
    };
    let value = serde_json::to_value(super::redact_providers(&providers)).unwrap();
    assert_eq!(value["modal"]["api_key_count"], 2);
    assert_eq!(value["modal"]["api_key"], "***");
    assert!(!value.to_string().contains("secret-"));
}
#[test]
fn inworld_readback_masks_credentials_and_preserves_account_count() {
    let providers = crate::config::ProvidersConfig {
        inworld: Some(crate::config::InworldProviderConfig {
            api_key: "secret-primary".to_owned(),
            api_keys: vec!["secret-extra".to_owned()],
            base_url: "https://api.inworld.ai".to_owned(),
        }),
        ..Default::default()
    };
    let value = serde_json::to_value(super::redact_providers(&providers)).unwrap();
    assert_eq!(value["inworld"]["api_key"], "***");
    assert_eq!(value["inworld"]["api_key_count"], 2);
    assert!(!value.to_string().contains("secret-"));
}
use super::{admin_loopback_allowed, get_config, put_config};

#[test]
fn loopback_no_auth_no_mesh_is_allowed() {
    // The classic local-dev case: loopback peer, no base auth, mesh off,
    // fleet off, and no master key provisioned. This is the zero-config
    // Core-proxy path and MUST stay open.
    assert!(admin_loopback_allowed(true, false, false, false, false));
}

#[test]
fn mesh_neutralizes_loopback_trust() {
    // #478 B-9: under mesh a tailnet peer appears as 127.0.0.1, so loopback
    // trust must be neutralized â€” admin requires the master key.
    assert!(!admin_loopback_allowed(true, false, true, false, false));
}

#[test]
fn fleet_neutralizes_loopback_trust() {
    // WS2: behind a co-located fleet LB an external caller appears as
    // 127.0.0.1, so fleet mode drops loopback trust â€” admin requires the
    // master key even for a loopback peer.
    assert!(!admin_loopback_allowed(true, false, false, true, false));
}

#[test]
fn provisioned_master_key_neutralizes_loopback_trust() {
    // P2 #2: a master key set in gateway.toml with require_auth=false must
    // still gate these control-plane reads â€” loopback trust is neutralized
    // once an admin key exists, so config/audit require it.
    assert!(!admin_loopback_allowed(true, false, false, false, true));
}

#[test]
fn remote_peer_never_loopback_allowed() {
    assert!(!admin_loopback_allowed(false, false, false, false, false));
    assert!(!admin_loopback_allowed(false, false, true, false, false));
}

#[test]
fn require_auth_forces_master_key() {
    assert!(!admin_loopback_allowed(true, true, false, false, false));
}

// â”€â”€ Â§6 gateway-local firewall overlay stores (org/agent scopes) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// These cover the two things THIS leaf changes on top of the resolver (which
// resolve.rs already unit-tests): the loosened empty-patch guard + the JSON
// shape of the overlay fields, and end-to-end that authoring an overlay via
// the same replace helper the PUT handler uses changes the resolved scanner
// for a request carrying that org/agent, while other scopes stay on the base.

use std::collections::HashMap;

use super::{patch_is_empty, replace_overlay_store, ConfigPatch, PhoneCallsView};
use crate::{
    audit::AuditLogger,
    config::{
        AcpConfig, AlertTier, AuditConfig, AuthConfig, BudgetAction, BudgetConfig, BudgetRule,
        CustomPattern, CustomPatternKind, EvalRoutingConfig, EvalsConfig, FirewallConfig,
        FirewallOverlay, FirewallPolicy, GatewayConfig, Modality, ModalityMapping,
        PhoneCallsConfig, ProviderId, ProvidersConfig, RoutingConfig, ToolsConfig,
    },
    evals::EvalsRunner,
    pipeline::RequestContext,
    state::AppState,
};
use serde_json::json;

/// A minimal, disk-free `AppState` (audit disabled, default config).
fn test_state() -> AppState {
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = EvalsRunner::new(EvalsConfig::default());
    AppState::new_for_test(GatewayConfig::default(), audit, evals)
}

/// A minimal `RequestContext` carrying only an org/agent id, on the standalone
/// path (`resolved_policy: None` â‡’ empty control-plane bundle â‡’ the resolver
/// consults its gateway-local overlay stores).
fn ctx_for(org: Option<&str>, agent: Option<&str>) -> RequestContext {
    RequestContext {
        org_limits: None,
        identity: None,
        standing: None,
        enforcement: None,
        host_conversation: None,
        authorized_operation: crate::config::ApiKeyOperation::Inference,
        provider_snapshot: None,
        request_id: "t".into(),
        api_key: "k".into(),
        owner_binding: ryu_gw_credentials::fingerprint("k"),
        is_master_key: false,
        org_id: org.map(str::to_string),
        team_id: None,
        project_id: None,
        user_name: None,
        user_id: None,
        agent_id: agent.map(str::to_string),
        agent_provider_access: None,
        key_config: None,
        skill_ids: None,
        tool_actions: None,
        tools_header_present: false,
        capability_hints: None,
        slot_provider: None,
        slot_model: None,
        own_supply_route: None,
        violation_attempt: Default::default(),
        session_id: None,
        feature: None,
        purpose: None,
        companion_source: false,
        tool_search_requested: false,
        untrusted_caller: false,
        priority: crate::concurrency::Priority::Interactive,
        tool_profile: None,
        raw_tools: false,
        managed_inference: false,
        openrouter_routing_enabled: false,
        remaining_budget_micro_usd: None,
        unrestricted_budget_micro_usd: None,
        pool_budgets_micro_usd: std::collections::HashMap::new(),
        credit_accounting_unavailable: false,
        budget_resolved_at: None,
        resolved_policy: None,
        prompt_cache_mode: None,
        prompt_cache_ttl: None,
        node_routing: None,
    }
}

/// Author (full-replacement) the resolver's local org overlay store, exactly
/// as `put_config` does.
fn put_org_overlays(state: &AppState, next: HashMap<String, FirewallOverlay>) {
    replace_overlay_store(
        state.resolver.org_overlays().into_keys().collect(),
        next,
        |id| state.resolver.remove_org_overlay(id),
        |id, ov| state.resolver.set_org_overlay(id, ov),
    );
}

fn put_agent_overlays(state: &AppState, next: HashMap<String, FirewallOverlay>) {
    replace_overlay_store(
        state.resolver.agent_overlays().into_keys().collect(),
        next,
        |id| state.resolver.remove_agent_overlay(id),
        |id, ov| state.resolver.set_agent_overlay(id, ov),
    );
}

#[test]
fn patch_is_empty_true_only_when_every_field_absent() {
    // The all-none case is the only rejection.
    assert!(patch_is_empty(&ConfigPatch::default()));
    // Regression guard for the loosened check: an OVERLAY-ONLY patch (the
    // standalone-desktop authoring case) must NOT be rejected as empty.
    assert!(!patch_is_empty(&ConfigPatch {
        firewall_org_overlays: Some(HashMap::new()),
        ..ConfigPatch::default()
    }));
    assert!(!patch_is_empty(&ConfigPatch {
        firewall_agent_overlays: Some(HashMap::new()),
        ..ConfigPatch::default()
    }));
    assert!(!patch_is_empty(&ConfigPatch {
        phone_calls: Some(PhoneCallsView::default()),
        ..ConfigPatch::default()
    }));
    assert!(!patch_is_empty(&ConfigPatch {
        screening: Some(crate::config::ScreeningConfig::default()),
        ..ConfigPatch::default()
    }));
}

#[test]
fn phone_calls_patch_uses_camel_case_and_persists_gateway_toml_names() {
    let patch: ConfigPatch = serde_json::from_value(json!({
        "phoneCalls": {
            "enabled": true,
            "lines": [{
                "id": "personal",
                "label": "Personal",
                "twilioNumber": "+14155550123",
                "callerId": "+14155550100",
                "agentId": "assistant.main",
                "ttsEngine": "pocket",
                "ttsVoice": "voice-1",
                "transferTo": "+14155550101",
                "greeting": "Keep it concise"
            }]
        }
    }))
    .unwrap();
    let phone_calls: PhoneCallsConfig = patch.phone_calls.unwrap().into();
    phone_calls.validate().unwrap();
    let toml = toml::to_string(&phone_calls).unwrap();
    assert!(toml.contains("twilio_number"));
    assert!(toml.contains("caller_id"));
    assert!(!toml.contains("twilioNumber"));

    let view = PhoneCallsView::from(phone_calls);
    let json = serde_json::to_value(view).unwrap();
    assert_eq!(json["lines"][0]["callerId"], "+14155550100");
    assert_eq!(json["lines"][0]["ttsEngine"], "pocket");
}

#[test]
fn acp_defaults_and_validation_protect_resource_bounds() {
    let defaults = AcpConfig::default();
    assert_eq!(defaults.idle_timeout_minutes, 5);
    assert_eq!(defaults.max_parallel_agents, None);
    assert!(defaults.keep_computer_awake);
    assert!(defaults.validate().is_ok());

    let mut invalid = defaults.clone();
    invalid.idle_timeout_minutes = 0;
    assert!(invalid.validate().is_err());
    invalid.idle_timeout_minutes = defaults.idle_timeout_minutes;
    invalid.max_parallel_agents = Some(0);
    assert!(invalid.validate().is_err());

    let serialized = toml::to_string(&defaults).expect("Auto should be TOML-safe");
    assert!(!serialized.contains("max_parallel_agents"));
    let round_trip: AcpConfig = toml::from_str(&serialized).expect("ACP TOML round-trip");
    assert_eq!(round_trip, defaults);
}

/// The PUT path validates every requested stage backend against the live
/// registries: the default (all-`"builtin"`) selection is accepted; a
/// registered non-builtin (here a stub registered into the budget registry) is
/// accepted; an unknown id is refused with a `BadRequest` that names the stage.
#[test]
fn put_config_validates_stage_backends() {
    use super::validate_stage_backends;
    use crate::budget::{BudgetBackend, BudgetDecision};
    use crate::config::{BudgetConfig, StageBackendsConfig};
    use crate::error::GatewayError;
    use std::sync::Arc;

    struct StubBudget(BudgetConfig);
    impl BudgetBackend for StubBudget {
        fn config(&self) -> &BudgetConfig {
            &self.0
        }
        fn evaluate(&self, _u: Option<&str>, _a: Option<&str>) -> Option<BudgetDecision> {
            None
        }
        fn evaluate_session(&self, _s: Option<&str>) -> Option<BudgetDecision> {
            None
        }
        fn record(&self, _u: Option<&str>, _a: Option<&str>, _t: u64) {}
        fn record_session(&self, _s: Option<&str>, _t: u64) {}
    }

    let state = Arc::new(test_state());

    // Default (all "builtin") selection validates cleanly.
    assert!(validate_stage_backends(&state, &StageBackendsConfig::default()).is_ok());

    // An unknown id for any stage is refused, naming the stage.
    let mut bad = StageBackendsConfig::default();
    bad.cache = "ghost".to_string();
    match validate_stage_backends(&state, &bad) {
        Err(GatewayError::BadRequest(msg)) => {
            assert!(
                msg.contains("backends.cache") && msg.contains("ghost"),
                "{msg}"
            );
        }
        other => panic!("expected BadRequest, got {other:?}"),
    }

    // A registered non-builtin backend validates â€” and the live budget registry
    // then swaps to it (the &self hot-swap the PUT handler performs).
    state
        .budget
        .register("stub", Arc::new(StubBudget(BudgetConfig::default())));
    let mut good = StageBackendsConfig::default();
    good.budget = "stub".to_string();
    assert!(validate_stage_backends(&state, &good).is_ok());
    assert!(state.budget.set_active("stub"));
    assert_eq!(state.budget.active_id().as_str(), "stub");
}

#[test]
fn config_patch_deserializes_overlay_fields() {
    // Confirms the wire shape the desktop read-modify-writes: snake_case
    // overlay keys under two top-level maps keyed by org/agent id.
    let json = serde_json::json!({
        "firewall_org_overlays": {
            "o1": { "policy": "block", "redact_pii": false, "custom_patterns": [] }
        },
        "firewall_agent_overlays": {
            "a1": { "enabled": false }
        }
    });
    let patch: ConfigPatch = serde_json::from_value(json).expect("deserialize overlay patch");

    let org = patch.firewall_org_overlays.expect("org overlays present");
    assert_eq!(org["o1"].policy, Some(FirewallPolicy::Block));
    assert_eq!(org["o1"].redact_pii, Some(false));
    let agent = patch
        .firewall_agent_overlays
        .expect("agent overlays present");
    assert_eq!(agent["a1"].enabled, Some(false));
}

/// The `GET`-shape â†’ `PUT`-shape loop for `alert`, on all three surfaces that can
/// carry one: the node firewall, a budget rule, and a firewall overlay.
///
/// This matters because `alert` is the ONLY trigger for alert delivery
/// (`pipeline/mod.rs::firewall_policy_alert` gates on `>= AlertTier::Warn`, and the
/// budget paths gate identically) and it defaults to `Silent`. A field a view omits
/// is a field the desktop's read-modify-write cannot see â€” and therefore erases on
/// its next save, exactly as happened to `routing.modality_map` â€” so an omission
/// here would look like "alerts keep switching themselves off".
///
/// The whole `ConfigView` is serialized and fed back into `ConfigPatch`, rather than
/// each section checked in isolation, so this also proves the two shapes are
/// mutually compatible as wholes.
#[test]
fn alert_tiers_survive_the_config_view_to_patch_round_trip() {
    let firewall = FirewallConfig {
        alert: AlertTier::Fanout,
        ..FirewallConfig::default()
    };
    let mut budgets = BudgetConfig::default();
    budgets.users.insert(
        "u1".to_string(),
        BudgetRule {
            limit: 1_000,
            window: Default::default(),
            action: BudgetAction::Notify,
            downgrade_to: None,
            restrict_max_tokens: 256,
            alert: AlertTier::Email,
            include: crate::config::BudgetChargeInclusion::default(),
        },
    );
    budgets.session.limit = 5_000;
    budgets.session.alert = AlertTier::Warn;

    let mut org_overlays = HashMap::new();
    org_overlays.insert(
        "o1".to_string(),
        FirewallOverlay {
            alert: Some(AlertTier::Email),
            locked_fields: vec!["alert".into()],
            ..Default::default()
        },
    );

    let view = config_view(firewall, budgets, org_overlays);
    let wire = serde_json::to_value(&view).expect("the view serializes");

    // Sanity: the keys are actually present on the wire, not merely reconstructible.
    assert_eq!(wire["firewall"]["alert"], "fanout");
    assert_eq!(wire["budgets"]["users"]["u1"]["alert"], "email");
    assert_eq!(wire["budgets"]["session"]["alert"], "warn");
    assert_eq!(wire["firewall_org_overlays"]["o1"]["alert"], "email");

    // â€¦and the PUT shape accepts what the GET shape emitted, tiers intact.
    let patch: ConfigPatch = serde_json::from_value(wire).expect("the view parses as a patch");
    assert_eq!(
        patch.firewall.expect("firewall echoed").alert,
        AlertTier::Fanout,
        "a client that reads and writes the config back must not silence the firewall"
    );
    let budgets = patch.budgets.expect("budgets echoed");
    assert_eq!(budgets.users["u1"].alert, AlertTier::Email);
    assert_eq!(budgets.session.alert, AlertTier::Warn);
    let overlays = patch
        .firewall_org_overlays
        .expect("overlay store echoed as a full replacement");
    assert_eq!(overlays["o1"].alert, Some(AlertTier::Email));
    assert_eq!(
        overlays["o1"].locked_fields,
        vec!["alert".to_string()],
        "the lock has to round-trip too, or a save unlocks the tier it just wrote"
    );
}

#[test]
fn computer_use_policy_survives_the_config_view_to_patch_round_trip() {
    let mut view = config_view(
        FirewallConfig::default(),
        BudgetConfig::default(),
        HashMap::new(),
    );
    view.computer_use = super::ComputerUseConfig {
        locked_use: true,
        security_key: true,
    };
    let wire = serde_json::to_value(&view).expect("the view serializes");

    assert_eq!(wire["computer_use"]["locked_use"], true);
    assert_eq!(wire["computer_use"]["security_key"], true);

    let patch: ConfigPatch = serde_json::from_value(wire).expect("the view parses as a patch");
    let echoed = patch.computer_use.expect("computer-use policy echoed");
    assert!(
        echoed.locked_use,
        "a desktop save must not silently turn locked use off"
    );
    assert!(
        echoed.security_key,
        "a desktop save must not silently turn security-key use off"
    );
}

#[allow(clippy::await_holding_lock)]
// These persistence/browser-defense cases exercise the explicit development
// opt-out, not the authenticated production default.
fn explicit_local_development_config() -> GatewayConfig {
    let mut config = GatewayConfig::default();
    config.auth.require_auth = false;
    config
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn composio_billing_round_trips_and_requires_restart_without_changing_credentials() {
    use axum::{
        extract::{ConnectInfo, State},
        http::HeaderMap,
        Json,
    };
    use std::sync::Arc;
    let guard = crate::config::test_config_path::ConfigPathGuard::isolated("composio-billing-put");
    let mut config = explicit_local_development_config();
    config.composio.api_key = Some("provider-test-key".to_owned());
    config.save().unwrap();
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let state = Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));
    let patch: ConfigPatch = serde_json::from_value(serde_json::json!({"composioBilling":{"zeroDataRetention":true,"baa":false,"ipAllowlist":true}})).unwrap();
    let mut headers = HeaderMap::new();
    headers.insert("host", "127.0.0.1:7981".parse().unwrap());
    let Json(result) = super::put_config(
        State(Arc::clone(&state)),
        ConnectInfo("127.0.0.1:5".parse().unwrap()),
        headers,
        Json(patch),
    )
    .await
    .unwrap();
    assert_eq!(result["applied"]["restartRequired"], true);
    let disk = std::fs::read_to_string(guard.path()).unwrap();
    assert!(
        !disk.contains("provider-test-key"),
        "composio key sealed on disk"
    );
    let saved = GatewayConfig::from_authored_str(&disk).unwrap();
    assert!(saved.composio.billing.zero_data_retention);
    assert!(saved.composio.billing.ip_allowlist);
    assert_eq!(saved.composio.api_key.as_deref(), Some("provider-test-key"));
    assert!(!state.config.composio.billing.zero_data_retention);
    let mut headers = HeaderMap::new();
    headers.insert("host", "127.0.0.1:7981".parse().unwrap());
    let Json(view) = super::get_config(
        State(state),
        ConnectInfo("127.0.0.1:5".parse().unwrap()),
        headers,
    )
    .await
    .unwrap();
    assert_eq!(view["composioBilling"]["zeroDataRetention"], true);
    assert_eq!(view["composioBillingActive"]["zeroDataRetention"], false);
}

/// Custom evaluators swap live, later PUTs validate against that live set
/// (not the startup snapshot), and a change that would orphan an
/// `[evals.online]` reference is refused before anything is persisted.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn custom_evaluator_updates_apply_live_and_guard_online_references() {
    use crate::evaluators::{
        Capabilities, CodeLang, Evaluator, EvaluatorBinding, EvaluatorCategory, EvaluatorImpl,
        EvaluatorTarget,
    };
    use axum::{
        extract::{ConnectInfo, State},
        http::HeaderMap,
        Json,
    };
    use std::sync::Arc;
    let guard =
        crate::config::test_config_path::ConfigPathGuard::isolated("custom-evaluators-live");
    let custom = |id: &str, impl_: EvaluatorImpl| Evaluator {
        id: id.to_owned(),
        name: id.to_owned(),
        description: String::new(),
        category: EvaluatorCategory::Custom,
        target: EvaluatorTarget::Output,
        capabilities: Capabilities {
            inline: false,
            offline: true,
        },
        impl_,
        inline: None,
        offline: None,
        builtin: false,
        enforced: false,
        higher_is_better: true,
    };
    let mut config = explicit_local_development_config();
    // The startup snapshot still holds a code evaluator the live set drops.
    config.custom_evaluators = vec![custom(
        "legacy_code",
        EvaluatorImpl::Code {
            lang: CodeLang::Js,
            source: "return true".to_owned(),
        },
    )];
    config.evals.online.evaluators = vec!["house_style".to_owned()];
    config.save().unwrap();
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let state = Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));
    let put = |patch: ConfigPatch| {
        let state = Arc::clone(&state);
        async move {
            let mut headers = HeaderMap::new();
            headers.insert("host", "127.0.0.1:7981".parse().unwrap());
            super::put_config(
                State(state),
                ConnectInfo("127.0.0.1:5".parse().unwrap()),
                headers,
                Json(patch),
            )
            .await
        }
    };

    let house_style = custom(
        "house_style",
        EvaluatorImpl::Regex {
            patterns: vec!["forbidden".to_owned()],
        },
    );
    let Json(applied) = put(ConfigPatch {
        custom_evaluators: Some(vec![house_style.clone()]),
        ..ConfigPatch::default()
    })
    .await
    .expect("custom evaluator save");
    assert_eq!(applied["applied"]["restartRequired"], false);
    let registry = state.evaluator_registry();
    assert!(registry.get("house_style").is_some());
    assert!(registry.get("legacy_code").is_none());

    // A firewall-only save validates bindings against the live set, so the
    // dropped code evaluator no longer blocks it.
    put(ConfigPatch {
        firewall: Some(FirewallConfig {
            evaluators: vec![EvaluatorBinding {
                id: "legacy_code".to_owned(),
                enabled: true,
                inline_action: Some(FirewallPolicy::Block),
                offline: None,
                locked: false,
            }],
            ..FirewallConfig::default()
        }),
        ..ConfigPatch::default()
    })
    .await
    .expect("firewall save validates against the live custom set");

    // Dropping an evaluator `[evals.online]` scores with is refused.
    let before = std::fs::read_to_string(guard.path()).unwrap();
    let refused = put(ConfigPatch {
        custom_evaluators: Some(Vec::new()),
        ..ConfigPatch::default()
    })
    .await;
    assert!(
        matches!(&refused, Err(crate::error::GatewayError::BadRequest(reason)) if reason.contains("house_style")),
        "online reference must block the removal"
    );
    assert_eq!(std::fs::read_to_string(guard.path()).unwrap(), before);
    assert!(state.evaluator_registry().get("house_style").is_some());
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn invalid_pool_route_is_rejected_before_config_is_persisted() {
    use axum::extract::{ConnectInfo, State};
    use axum::http::HeaderMap;
    use axum::Json;
    use std::sync::Arc;

    let guard = crate::config::test_config_path::ConfigPathGuard::isolated("invalid-pool-put");
    let config = explicit_local_development_config();
    config.save().unwrap();
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let state = Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));
    let mut routing = RoutingConfig::default();
    routing.model_map.insert(
        "client-alias".to_owned(),
        crate::config::ModelMapping {
            provider: ProviderId::from("pool:missing"),
            provider_model: None,
        },
    );
    let patch: ConfigPatch =
        serde_json::from_value(serde_json::json!({ "routing": routing })).unwrap();
    let mut headers = HeaderMap::new();
    headers.insert("host", "127.0.0.1:7981".parse().unwrap());
    let result = super::put_config(
        State(state),
        ConnectInfo("127.0.0.1:5".parse().unwrap()),
        headers,
        Json(patch),
    )
    .await;
    assert!(matches!(
        result,
        Err(crate::error::GatewayError::BadRequest(_))
    ));
    let saved = std::fs::read_to_string(guard.path()).unwrap();
    assert!(!saved.contains("client-alias"));
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn valid_pool_round_trips_through_config_put_and_get() {
    use axum::extract::{ConnectInfo, State};
    use axum::http::HeaderMap;
    use axum::Json;
    use std::sync::Arc;

    let guard = crate::config::test_config_path::ConfigPathGuard::isolated("valid-pool-put");
    let mut config = explicit_local_development_config();
    config.providers.openai = Some(crate::config::OpenAiProviderConfig {
        api_key: "openai-test".to_owned(),
        api_keys: Vec::new(),
        base_url: "https://api.openai.com/v1".to_owned(),
    });
    config.save().unwrap();
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let state = Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));
    let mut routing = RoutingConfig::default();
    routing.model_map.insert(
        "balanced-chat".to_owned(),
        crate::config::ModelMapping {
            provider: ProviderId::from("pool:balanced"),
            provider_model: None,
        },
    );
    routing.provider_pools.insert(
        "balanced".to_owned(),
        crate::config::ProviderPoolConfig {
            strategy: crate::config::ProviderPoolStrategy::RoundRobin,
            sticky_limit: 1,
            wait_for_cooldown_ms: 0,
            members: vec![crate::config::ProviderPoolMemberConfig {
                provider: ProviderId::from("openai"),
                model: "gpt-4o-mini".to_owned(),
                priority: 0,
                weight: 1,
                enabled: true,
                last_resort: false,
                context_tokens: None,
            }],
            execution: Default::default(),
            judge: None,
            auto_weights: None,
        },
    );
    let patch: ConfigPatch =
        serde_json::from_value(serde_json::json!({ "routing": routing })).unwrap();
    let mut headers = HeaderMap::new();
    headers.insert("host", "127.0.0.1:7981".parse().unwrap());
    super::put_config(
        State(Arc::clone(&state)),
        ConnectInfo("127.0.0.1:5".parse().unwrap()),
        headers.clone(),
        Json(patch),
    )
    .await
    .unwrap();
    let Json(view) = super::get_config(
        State(state),
        ConnectInfo("127.0.0.1:5".parse().unwrap()),
        headers,
    )
    .await
    .unwrap();
    assert_eq!(
        view["routing"]["provider_pools"]["balanced"]["members"][0]["model"],
        "gpt-4o-mini"
    );
    assert_eq!(
        view["routing"]["model_map"]["balanced-chat"]["provider"],
        "pool:balanced"
    );
    let saved: GatewayConfig =
        toml::from_str(&std::fs::read_to_string(guard.path()).unwrap()).unwrap();
    assert!(saved.routing.provider_pools.contains_key("balanced"));
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn egress_pool_round_trips_and_survives_an_unrelated_patch() {
    use axum::extract::{ConnectInfo, State};
    use axum::http::HeaderMap;
    use axum::Json;
    use std::sync::Arc;

    let guard = crate::config::test_config_path::ConfigPathGuard::isolated("egress-pool-put");
    let config = explicit_local_development_config();
    config.save().unwrap();
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let state = Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));
    let mut headers = HeaderMap::new();
    headers.insert("host", "127.0.0.1:7981".parse().unwrap());
    let peer = || ConnectInfo("127.0.0.1:5".parse().unwrap());
    let egress = serde_json::json!({
        "pools": {
            "private": {
                "include_direct": true,
                "endpoints": [{
                    "id": "edge-one",
                    "url": "http://127.0.0.1:8080",
                    "enabled": true,
                    "username_env": null,
                    "password_env": null
                }]
            }
        },
        "assignments": { "openai": "private" }
    });
    let patch: ConfigPatch = serde_json::from_value(serde_json::json!({
        "egress": egress
    }))
    .unwrap();
    let _ = super::put_config(
        State(Arc::clone(&state)),
        peer(),
        headers.clone(),
        Json(patch),
    )
    .await
    .unwrap();
    let unrelated: ConfigPatch = serde_json::from_value(serde_json::json!({
        "computer_use": { "locked_use": true }
    }))
    .unwrap();
    let _ = super::put_config(
        State(Arc::clone(&state)),
        peer(),
        headers.clone(),
        Json(unrelated),
    )
    .await
    .unwrap();
    let Json(view) = super::get_config(State(state), peer(), headers)
        .await
        .unwrap();
    assert_eq!(view["egress"]["assignments"]["openai"], "private");
    assert_eq!(
        view["egress"]["pools"]["private"]["endpoints"][0]["url"],
        "http://127.0.0.1:8080"
    );
    let saved: GatewayConfig =
        toml::from_str(&std::fs::read_to_string(guard.path()).unwrap()).unwrap();
    assert_eq!(saved.egress.assignments["openai"], "private");
}

/// `include_direct` keeps a pool whose only endpoint is disabled valid.
fn credentialed_egress(endpoints: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "pools": { "chosen": { "include_direct": true, "endpoints": endpoints } },
        "assignments": { "openai": "chosen" }
    })
}

fn credentialed_endpoint(id: &str, enabled: bool, env_name: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "url": "http://127.0.0.1:8080",
        "enabled": enabled,
        "username_env": env_name,
        "password_env": env_name
    })
}

const PROXY_CREDENTIAL_NAME_REFUSAL: &str =
    "proxy credential environment names must start with RYU_PROXY_";

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn egress_put_refuses_unreserved_credential_names_whether_or_not_they_exist() {
    use crate::error::GatewayError;
    use axum::extract::{ConnectInfo, State};
    use axum::http::HeaderMap;
    use axum::Json;
    use std::sync::Arc;

    let _guard =
        crate::config::test_config_path::ConfigPathGuard::isolated("egress-credential-names");
    let config = explicit_local_development_config();
    config.save().unwrap();
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let state = Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));
    let mut headers = HeaderMap::new();
    headers.insert("host", "127.0.0.1:7981".parse().unwrap());
    let peer = || ConnectInfo("127.0.0.1:5".parse().unwrap());
    let put = |endpoint: serde_json::Value| {
        let patch: ConfigPatch = serde_json::from_value(serde_json::json!({
            "egress": credentialed_egress(serde_json::json!([endpoint]))
        }))
        .unwrap();
        super::put_config(
            State(Arc::clone(&state)),
            peer(),
            headers.clone(),
            Json(patch),
        )
    };

    // `PATH` stands in for a set Gateway secret such as `CORE_TOKEN`.
    assert!(std::env::var_os("PATH").is_some());
    assert!(std::env::var_os("GATEWAY_TEST_UNSET_SECRET").is_none());
    let mut refusals = Vec::new();
    for name in ["PATH", "GATEWAY_TEST_UNSET_SECRET"] {
        for enabled in [true, false] {
            match put(credentialed_endpoint("e", enabled, name)).await {
                Err(GatewayError::BadRequest(message)) => refusals.push(message),
                other => panic!("{name} must be refused, got {other:?}"),
            }
        }
    }
    assert!(refusals[0].starts_with(PROXY_CREDENTIAL_NAME_REFUSAL));
    assert!(refusals.windows(2).all(|pair| pair[0] == pair[1]));
    assert!(put(credentialed_endpoint("e", false, "RYU_PROXY_USER"))
        .await
        .is_ok());

    // A malformed name is never read as a credential, so it keeps the existing
    // endpoint validation: accepted when disabled, refused as invalid when enabled.
    assert!(put(credentialed_endpoint("e", false, "proxy_user"))
        .await
        .is_ok());
    match put(credentialed_endpoint("e", true, "proxy_user")).await {
        Err(GatewayError::BadRequest(message)) => {
            assert_eq!(message, "proxy credential environment name is invalid");
        }
        other => panic!("proxy_user must keep the invalid-name refusal, got {other:?}"),
    }
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn egress_put_keeps_persisted_credential_names_and_refuses_new_ones() {
    use crate::error::GatewayError;
    use axum::extract::{ConnectInfo, State};
    use axum::http::HeaderMap;
    use axum::Json;
    use std::sync::Arc;

    let guard = crate::config::test_config_path::ConfigPathGuard::isolated(
        "egress-persisted-credential-names",
    );
    // An operator-authored, non-`RYU_PROXY_` name that is set in the environment.
    assert!(std::env::var_os("PATH").is_some());
    let mut config = explicit_local_development_config();
    config.egress = serde_json::from_value(credentialed_egress(serde_json::json!([
        credentialed_endpoint("corp", true, "PATH")
    ])))
    .unwrap();
    config.save().unwrap();
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let state = Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));
    let mut headers = HeaderMap::new();
    headers.insert("host", "127.0.0.1:7981".parse().unwrap());
    let peer = || ConnectInfo("127.0.0.1:5".parse().unwrap());

    // The desktop editor's read-modify-write sends the persisted names back.
    let Json(view) = super::get_config(State(Arc::clone(&state)), peer(), headers.clone())
        .await
        .unwrap();
    let round_trip: ConfigPatch =
        serde_json::from_value(serde_json::json!({ "egress": view["egress"] })).unwrap();
    let _ = super::put_config(
        State(Arc::clone(&state)),
        peer(),
        headers.clone(),
        Json(round_trip),
    )
    .await
    .unwrap();

    // A new non-reserved name is refused, even on a disabled endpoint.
    let added: ConfigPatch = serde_json::from_value(serde_json::json!({
        "egress": credentialed_egress(serde_json::json!([
            credentialed_endpoint("corp", true, "PATH"),
            credentialed_endpoint("later", false, "CORE_TOKEN")
        ]))
    }))
    .unwrap();
    match super::put_config(State(state), peer(), headers, Json(added)).await {
        Err(GatewayError::BadRequest(message)) => {
            assert!(
                message.starts_with(PROXY_CREDENTIAL_NAME_REFUSAL),
                "{message}"
            );
        }
        other => panic!("CORE_TOKEN must be refused, got {other:?}"),
    }
    let saved: GatewayConfig =
        toml::from_str(&std::fs::read_to_string(guard.path()).unwrap()).unwrap();
    let endpoints = &saved.egress.pools["chosen"].endpoints;
    assert_eq!(endpoints.len(), 1);
    assert_eq!(endpoints[0].username_env.as_deref(), Some("PATH"));
}

#[tokio::test]
async fn backends_patches_merge_so_one_layer_never_resets_another() {
    use axum::extract::{ConnectInfo, State};
    use axum::http::HeaderMap;
    use axum::Json;
    use std::net::SocketAddr;

    let _guard = crate::config::test_config_path::ConfigPathGuard::isolated("backends-merge");
    let mut seeded = explicit_local_development_config();
    seeded.backends.cache = "builtin".to_string();
    seeded.save().expect("seed the persisted config");

    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let state = std::sync::Arc::new(AppState::new_for_test(
        explicit_local_development_config(),
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));
    let peer = ConnectInfo("127.0.0.1:5".parse::<SocketAddr>().unwrap());
    let put = |body: serde_json::Value| {
        let state = std::sync::Arc::clone(&state);
        let patch: ConfigPatch = serde_json::from_value(body).expect("patch shape");
        async move { put_config(State(state), peer, HeaderMap::new(), Json(patch)).await }
    };

    let Json(first) = put(serde_json::json!({ "backends": { "connections": "composio" } }))
        .await
        .expect("connections PUT succeeds");
    assert_eq!(first["applied"]["restartRequired"], false);
    let Json(second) = put(serde_json::json!({ "backends": { "router": "litellm" } }))
        .await
        .expect("router PUT succeeds");
    assert_eq!(second["applied"]["restartRequired"], false);

    // Both live selections survive the second, router-only patch.
    assert_eq!(state.connections.selected(), "composio");
    assert_eq!(
        state.provider_runtime.snapshot().router.active_id(),
        "litellm"
    );

    let text = std::fs::read_to_string(
        crate::config::GatewayConfig::config_path().expect("isolated config path"),
    )
    .expect("gateway.toml written");
    let on_disk: GatewayConfig = toml::from_str(&text).expect("re-parse persisted config");
    assert_eq!(on_disk.backends.connections, "composio");
    assert_eq!(on_disk.backends.router, "litellm");

    // An unknown id is refused before anything changes.
    assert!(
        put(serde_json::json!({ "backends": { "router": "portkey" } }))
            .await
            .is_err()
    );
    assert_eq!(
        state.provider_runtime.snapshot().router.active_id(),
        "litellm"
    );

    // Re-sending restart-only stages at their running values needs no restart.
    let Json(third) = put(serde_json::json!({ "backends": { "evals": "builtin", "cache": "builtin", "audit": "builtin" } }))
        .await
        .expect("no-op stage PUT succeeds");
    assert_eq!(third["applied"]["restartRequired"], false);
}

#[test]
fn stage_backends_patch_only_overwrites_named_stages() {
    let mut base = crate::config::StageBackendsConfig::default();
    base.cache = "redis".to_string();
    let patch: crate::config::StageBackendsPatch =
        serde_json::from_value(serde_json::json!({ "router": "openrouter" })).unwrap();
    let merged = patch.apply_to(base);
    assert_eq!(merged.router, "openrouter");
    assert_eq!(merged.cache, "redis");
    assert_eq!(merged.connections, "builtin");
}

#[tokio::test]
async fn computer_use_put_updates_the_persisted_config_and_view() {
    use axum::extract::{ConnectInfo, State};
    use axum::http::HeaderMap;
    use axum::Json;
    use std::net::SocketAddr;

    let _guard = crate::config::test_config_path::ConfigPathGuard::isolated("computer-use-put");
    explicit_local_development_config()
        .save()
        .expect("seed the persisted config");

    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let state = std::sync::Arc::new(AppState::new_for_test(
        explicit_local_development_config(),
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));
    let peer = ConnectInfo("127.0.0.1:5".parse::<SocketAddr>().unwrap());
    let patch = ConfigPatch {
        composio_billing: None,
        expected_revision: None,
        provider_account_policies: None,
        provider_account_strategies: None,
        provider_account_drain_thresholds: None,
        acp: None,
        computer_use: Some(super::ComputerUseConfig {
            locked_use: true,
            ..super::ComputerUseConfig::default()
        }),
        firewall: None,
        budgets: None,
        auth: None,
        routing: None,
        egress: None,
        tools: None,
        firewall_org_overlays: None,
        firewall_agent_overlays: None,
        custom_evaluators: None,
        backends: None,
        resolved_backends: None,
        screening: None,
        marketplace_recommendations: None,
        phone_calls: None,
    };

    let Json(saved) = put_config(
        State(std::sync::Arc::clone(&state)),
        peer,
        HeaderMap::new(),
        Json(patch),
    )
    .await
    .expect("computer-use PUT succeeds");
    assert_eq!(saved["ok"], true);

    let text = std::fs::read_to_string(
        crate::config::GatewayConfig::config_path().expect("isolated config path"),
    )
    .expect("gateway.toml written");
    let on_disk: GatewayConfig = toml::from_str(&text).expect("re-parse persisted config");
    assert!(on_disk.computer_use.locked_use);

    let Json(view) = get_config(
        State(state),
        ConnectInfo("127.0.0.1:5".parse::<SocketAddr>().unwrap()),
        HeaderMap::new(),
    )
    .await
    .expect("computer-use GET succeeds");
    assert_eq!(view["computer_use"]["locked_use"], true);
}

/// Build a [`ConfigView`] the way `get_config` does, with the three sections this
/// test cares about injected and everything else defaulted. Constructing the real
/// view type (rather than a hand-written JSON literal) is what makes the round-trip
/// test above fail if a field is ever dropped from the view.
fn config_view(
    firewall: FirewallConfig,
    budgets: BudgetConfig,
    firewall_org_overlays: HashMap<String, FirewallOverlay>,
) -> super::ConfigView {
    config_view_with_routing(
        firewall,
        budgets,
        firewall_org_overlays,
        &RoutingConfig::default(),
        &crate::pipeline::stages::StageOrder::default(),
    )
}

/// [`config_view`] with the routing section and the resolved stage order
/// supplied by the caller, so a test can prove a NON-default routing value
/// survives the GETâ†’PUT round-trip (a defaults-only view round-trips even
/// when the view drops the field, because the dropped value and the default
/// are the same) and that a disabled pipeline stage is visibly absent.
fn config_view_with_routing(
    firewall: FirewallConfig,
    budgets: BudgetConfig,
    firewall_org_overlays: HashMap<String, FirewallOverlay>,
    routing: &RoutingConfig,
    stage_order: &crate::pipeline::stages::StageOrder,
) -> super::ConfigView {
    let tools = ToolsConfig::default();
    super::ConfigView {
        strategy_capabilities: Default::default(),
        composio_billing: Default::default(),
        composio_billing_active: Default::default(),
        web_service_schema: 1,
        web_service_prices: Default::default(),
        config_revision: None,
        applied_provider_revision: None,
        provider_epoch: None,
        acp: AcpConfig::default(),
        computer_use: super::ComputerUseConfig::default(),
        phone_calls: PhoneCallsView::default(),
        backends: crate::config::StageBackendsConfig::default(),
        firewall,
        budgets,
        providers: super::redact_providers(&ProvidersConfig::default()),
        egress: super::EgressConfig::default(),
        auth: super::redact_auth(&AuthConfig::default()),
        routing: super::RoutingView {
            web: routing.web.clone(),
            web_pools: routing.web_pools.clone(),
            default_provider: routing.default_provider.clone(),
            model_map: routing
                .model_map
                .iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        super::ModelMappingView {
                            provider: v.provider.clone(),
                            provider_model: v.provider_model.clone(),
                        },
                    )
                })
                .collect(),
            fallback_chain: routing.fallback_chain.clone(),
            provider_tiers: routing.provider_tiers.clone(),
            provider_pools: routing.provider_pools.clone(),
            modality_map: routing.modality_map.clone(),
            eval_routing: routing.eval_routing.clone(),
            smart_routing: routing.smart_routing.clone(),
        },
        tools: super::ToolsConfigView {
            enabled: tools.enabled,
            always_on: tools.always_on.clone(),
            max_rounds: tools.max_rounds,
            describe_top_n: tools.describe_top_n,
            parallel_reads: tools.parallel_reads,
            profiles: tools.profiles.clone(),
        },
        marketplace_recommendations: super::MarketplaceRecommendationsConfig::default(),
        firewall_org_overlays,
        firewall_agent_overlays: HashMap::new(),
        pipeline_stages: stage_order.stages().iter().map(|s| s.as_str()).collect(),
        drift: Vec::new(),
    }
}

/// `routing.modality_map` and `routing.eval_routing` must appear on the wire
/// AND survive being parsed back as a [`ConfigPatch`].
///
/// Both are `#[serde(default)]` on [`RoutingConfig`] and `PUT /v1/config
/// { routing }` replaces the section wholesale, and three desktop paths save
/// by spreading the GET'd routing object (`{ ...cfg.routing, model_map }`).
/// A field the view omits is therefore not merely invisible â€” the client's
/// next unrelated routing save writes the section back without it and the
/// gateway persists the default over it. For these two that means every
/// image / video / TTS / STT request silently falls back to
/// `default_provider`, because the modality map is consulted FIRST in the
/// router's resolution order (`router/mod.rs`), and any A/B split collapses.
///
/// The values below are deliberately NON-default: a view that dropped the
/// field would still pass a defaults-only round-trip, since the value it
/// loses and the value serde reconstructs are identical.
#[test]
fn modality_map_and_eval_routing_survive_the_get_put_round_trip() {
    let mut routing = RoutingConfig::default();
    routing.modality_map.insert(
        Modality::Image,
        ModalityMapping {
            provider: ProviderId::from("fal"),
            model: Some("flux-pro".to_string()),
        },
    );
    routing.modality_map.insert(
        Modality::Tts,
        ModalityMapping {
            provider: ProviderId::from("replicate"),
            model: None,
        },
    );
    routing.eval_routing = EvalRoutingConfig {
        enabled: true,
        candidates: vec![ProviderId::from("openai"), ProviderId::from("anthropic")],
        explore_ratio: 0.35,
    };

    let view = config_view_with_routing(
        FirewallConfig::default(),
        BudgetConfig::default(),
        HashMap::new(),
        &routing,
        &crate::pipeline::stages::StageOrder::default(),
    );
    let wire = serde_json::to_value(&view).expect("the view serializes");

    // On the wire, with `Modality` as a plain string key â€” a non-string map
    // key would serialize to something a JS client cannot spread back.
    assert_eq!(wire["routing"]["modality_map"]["image"]["provider"], "fal");
    assert_eq!(
        wire["routing"]["modality_map"]["image"]["model"],
        "flux-pro"
    );
    assert_eq!(
        wire["routing"]["modality_map"]["tts"]["provider"],
        "replicate"
    );
    assert_eq!(wire["routing"]["eval_routing"]["enabled"], true);
    assert_eq!(wire["routing"]["eval_routing"]["candidates"][0], "openai");

    // â€¦and the PUT shape accepts what the GET shape emitted, unchanged.
    let patch: ConfigPatch = serde_json::from_value(wire).expect("the view parses as a patch");
    let echoed = patch.routing.expect("routing echoed");
    assert_eq!(
        echoed.modality_map[&Modality::Image].provider,
        ProviderId::from("fal"),
        "an unrelated routing save must not re-route image generation to the \
         default provider"
    );
    assert_eq!(
        echoed.modality_map[&Modality::Image].model.as_deref(),
        Some("flux-pro")
    );
    assert_eq!(
        echoed.modality_map[&Modality::Tts].provider,
        ProviderId::from("replicate")
    );
    assert!(
        echoed.eval_routing.enabled,
        "the A/B split must not collapse"
    );
    assert_eq!(
        echoed.eval_routing.candidates,
        vec![ProviderId::from("openai"), ProviderId::from("anthropic")]
    );
    assert!((echoed.eval_routing.explore_ratio - 0.35).abs() < f32::EPSILON);
}

/// A governance stage disabled in `[pipeline]` is absent from the view's
/// `pipeline_stages`, so a client can badge its (still-editable, still-saved)
/// settings card as not in the pipeline instead of rendering it as live.
///
/// The read half only: `pipeline` is deliberately not in [`ConfigPatch`], and
/// the assertion at the end pins that â€” dropping a governance stage stays a
/// reviewable `gateway.toml` edit, never a click.
#[test]
fn disabled_pipeline_stage_is_absent_from_the_view() {
    let order = crate::pipeline::stages::StageOrder::resolve(
        &crate::pipeline::stages::PipelineOrderConfig {
            order: Vec::new(),
            disabled: vec![crate::pipeline::stages::PipelineStage::Inspector],
        },
    )
    .expect("disabling a reorderable stage is a legal config");

    let view = config_view_with_routing(
        FirewallConfig::default(),
        BudgetConfig::default(),
        HashMap::new(),
        &RoutingConfig::default(),
        &order,
    );
    let wire = serde_json::to_value(&view).expect("the view serializes");
    let stages: Vec<String> = serde_json::from_value(wire["pipeline_stages"].clone())
        .expect("pipeline_stages is a list of stage ids");

    assert!(
        !stages.contains(&"inspector".to_string()),
        "the disabled stage must not be reported as running: {stages:?}"
    );
    // The rest of the default order is still there, so a client can tell
    // "this one stage is off" from "the field is broken/empty".
    for still_running in [
        "rate-limit",
        "firewall",
        "inline-input",
        "policy",
        "companion-dlp",
        "route",
        "audit",
    ] {
        assert!(
            stages.contains(&still_running.to_string()),
            "{still_running} should still be in the pipeline: {stages:?}"
        );
    }

    // A default gateway reports the full default order.
    let default_view = config_view(
        FirewallConfig::default(),
        BudgetConfig::default(),
        HashMap::new(),
    );
    let default_wire = serde_json::to_value(&default_view).expect("serializes");
    let default_stages: Vec<String> =
        serde_json::from_value(default_wire["pipeline_stages"].clone()).expect("list");
    assert_eq!(
        default_stages,
        crate::pipeline::stages::DEFAULT_ORDER
            .iter()
            .map(|s| s.as_str().to_string())
            .collect::<Vec<_>>()
    );

    // Read-only: the view's own output, fed back as a patch, carries no
    // pipeline field for the handler to apply.
    let patch: ConfigPatch =
        serde_json::from_value(default_wire).expect("the view parses as a patch");
    assert!(
        patch.routing.is_some(),
        "sanity: the patch really did parse the view"
    );
}

#[test]
fn replace_overlay_store_removes_absent_ids_and_updates_present() {
    let state = test_state();
    state
        .resolver
        .set_org_overlay("keep".into(), FirewallOverlay::default());
    state
        .resolver
        .set_org_overlay("drop".into(), FirewallOverlay::default());

    // A full-replacement PUT that lists only `keep` (with a change) drops
    // `drop` and updates `keep`.
    let mut next = HashMap::new();
    next.insert(
        "keep".to_string(),
        FirewallOverlay {
            policy: Some(FirewallPolicy::Block),
            ..Default::default()
        },
    );
    put_org_overlays(&state, next);

    let store = state.resolver.org_overlays();
    assert!(store.contains_key("keep"), "listed id retained");
    assert!(!store.contains_key("drop"), "absent id removed");
    assert_eq!(
        store["keep"].policy,
        Some(FirewallPolicy::Block),
        "listed id updated"
    );
}

#[test]
fn authored_overlays_change_resolved_scanner_per_scope() {
    let state = test_state();
    let ctx = ctx_for(Some("o1"), Some("a1"));
    // `WIDGET-\d+` is matched by no built-in PII pattern, so the node base
    // lets it through.
    assert!(
        state
            .resolved_scanner(&ctx)
            .scan_inbound("ship WIDGET-123 now")
            .is_none(),
        "node base does not know WIDGET ids"
    );

    // Author an org overlay adding a PII custom pattern.
    let mut org = HashMap::new();
    org.insert(
        "o1".to_string(),
        FirewallOverlay {
            custom_patterns: vec![CustomPattern {
                name: "widget".into(),
                regex: r"WIDGET-\d+".into(),
                kind: CustomPatternKind::Pii,
            }],
            ..Default::default()
        },
    );
    put_org_overlays(&state, org);

    // A request for org o1 now trips the org's custom pattern.
    assert!(
        state
            .resolved_scanner(&ctx)
            .scan_inbound("ship WIDGET-123 now")
            .is_some(),
        "org overlay pattern enforced for its org"
    );
    // A request for a DIFFERENT org is unaffected â€” empty overlay â‡’ node base.
    let other = ctx_for(Some("o2"), None);
    assert!(
        state
            .resolved_scanner(&other)
            .scan_inbound("ship WIDGET-123 now")
            .is_none(),
        "other org still on the node base"
    );

    // Author an agent overlay tightening the policy; the leaf wins.
    let mut agent = HashMap::new();
    agent.insert(
        "a1".to_string(),
        FirewallOverlay {
            policy: Some(FirewallPolicy::Block),
            ..Default::default()
        },
    );
    put_agent_overlays(&state, agent);

    let resolved = state.resolved_scanner(&ctx);
    assert_eq!(
        resolved.config().policy,
        FirewallPolicy::Block,
        "agent leaf overlay applied"
    );
    // The org pattern still applies alongside the agent policy (union).
    assert!(resolved.scan_inbound("ship WIDGET-123 now").is_some());
}

#[test]
fn empty_overlays_resolve_to_node_base() {
    // The preserved-behaviour invariant: with no overlays authored, a request
    // carrying org/agent ids resolves byte-for-byte to the node base.
    let state = test_state();
    let ctx = ctx_for(Some("o1"), Some("a1"));
    let resolved = state.resolved_scanner(&ctx).config().clone();
    let base = state.resolver.node_base();
    assert_eq!(resolved.enabled, base.enabled);
    assert_eq!(resolved.scan_inbound, base.scan_inbound);
    assert_eq!(resolved.policy, base.policy);
    assert_eq!(resolved.redact_pii, base.redact_pii);
    assert!(resolved.custom_patterns.is_empty());
    // The default lock set is already sorted, so the resolver's sorted
    // union reproduces the node base byte-for-byte.
    assert_eq!(resolved.locked_fields, base.locked_fields);
}

#[test]
fn custom_evaluators_round_trip_through_gateway_config_and_merge() {
    use crate::evaluators::{
        Capabilities, Evaluator, EvaluatorCategory, EvaluatorImpl, EvaluatorRegistry,
        EvaluatorTarget, OfflineConfig,
    };

    // A default (no custom evaluators) config must NOT emit the key, so an
    // existing gateway.toml stays byte-identical (skip_serializing_if =
    // Vec::is_empty) â€” back-compat: no field == today.
    let empty = toml::to_string(&GatewayConfig::default()).expect("serialize default");
    assert!(
        !empty.contains("custom_evaluators"),
        "empty custom-evaluator set is omitted from gateway.toml"
    );

    // Author one custom offline Regex evaluator with a NEW id + one that
    // OVERRIDES a builtin, then round-trip through TOML (the on-disk format).
    let mk = |id: &str| Evaluator {
        id: id.to_string(),
        name: format!("Custom {id}"),
        description: "round-trip".to_string(),
        category: EvaluatorCategory::Custom,
        target: EvaluatorTarget::Output,
        capabilities: Capabilities {
            inline: false,
            offline: true,
        },
        impl_: EvaluatorImpl::Regex {
            patterns: vec!["forbidden".to_string()],
        },
        inline: None,
        offline: Some(OfflineConfig {
            threshold: 0.5,
            judge_model: None,
        }),
        builtin: false,
        enforced: false,
        higher_is_better: true,
    };
    let mut config = GatewayConfig::default();
    config.custom_evaluators = vec![mk("my_custom_eval"), mk("toxicity")];

    // This is the exact serializer save() uses; it exercises the TOML
    // ValueAfterTable hazard for the Evaluator struct (scalars after tables).
    let toml_str = toml::to_string_pretty(&config).expect("serialize custom evaluators");
    let reloaded: GatewayConfig = toml::from_str(&toml_str).expect("deserialize (load path)");
    assert_eq!(
        reloaded.custom_evaluators.len(),
        2,
        "custom evaluators survive the config round-trip"
    );
    assert_eq!(reloaded.custom_evaluators[0].id, "my_custom_eval");

    // The merged registry from the reloaded config exposes the new id AND the
    // override (in-place, builtin forced false).
    let reg = EvaluatorRegistry::from_config(&reloaded);
    let new = reg.get("my_custom_eval").expect("new custom id present");
    assert!(!new.builtin);
    assert!(new.capabilities.offline);
    let ovr = reg.get("toxicity").expect("builtin override present");
    assert!(!ovr.builtin, "override reports as custom (builtin=false)");
    assert_eq!(ovr.category.as_str(), "custom");
}

#[test]
fn overlays_round_trip_through_gateway_config_and_reseed_resolver() {
    // FIX 4: overlays authored into GatewayConfig serialize + deserialize and
    // are reseeded into the resolver when AppState is built from the reloaded
    // config, so a standalone overlay survives a gateway restart.
    let mut config = GatewayConfig::default();
    let mut org = HashMap::new();
    org.insert(
        "o1".to_string(),
        FirewallOverlay {
            policy: Some(FirewallPolicy::Block),
            ..Default::default()
        },
    );
    config.firewall_org_overlays = org;

    // A default (no-overlay) config must NOT emit the keys, so an existing
    // gateway.toml stays byte-identical (skip_serializing_if = HashMap::is_empty).
    let empty = toml::to_string(&GatewayConfig::default()).expect("serialize default");
    assert!(
        !empty.contains("firewall_org_overlays"),
        "empty overlay stores are omitted from gateway.toml"
    );

    // Round-trip through TOML (the on-disk format save()/load() use).
    let toml_str = toml::to_string(&config).expect("serialize");
    let reloaded: GatewayConfig = toml::from_str(&toml_str).expect("deserialize");
    assert_eq!(
        reloaded.firewall_org_overlays["o1"].policy,
        Some(FirewallPolicy::Block),
        "org overlay survives the config round-trip"
    );

    // Build state from the reloaded config; the resolver reseeds at startup.
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = EvalsRunner::new(EvalsConfig::default());
    let state = AppState::new_for_test(reloaded, audit, evals);
    assert_eq!(
        state.resolver.org_overlays()["o1"].policy,
        Some(FirewallPolicy::Block),
        "resolver reseeded from persisted config"
    );
    // And it drives resolution for a request carrying that org.
    let ctx = ctx_for(Some("o1"), None);
    assert_eq!(
        state.resolved_scanner(&ctx).config().policy,
        FirewallPolicy::Block,
    );
}

#[test]
fn redact_providers_masks_keys_and_reports_counts() {
    use super::redact_providers;
    use crate::config::{
        AnthropicProviderConfig, CoreProviderConfig, OpenAiProviderConfig, ProvidersConfig,
    };

    let cfg = ProvidersConfig {
        openai: Some(OpenAiProviderConfig {
            api_key: "sk-secret".to_string(),
            api_keys: vec!["sk-a".to_string(), "sk-b".to_string()],
            base_url: "https://api.openai.com/v1".to_string(),
        }),
        anthropic: Some(AnthropicProviderConfig {
            api_key: "sk-anthropic".to_string(),
            api_keys: vec![],
            base_url: "https://api.anthropic.com".to_string(),
        }),
        core: Some(CoreProviderConfig {
            base_url: "http://127.0.0.1:7979".to_string(),
            token: Some("core-token".to_string()),
        }),
        genai: Some(serde_json::from_value(serde_json::json!({"accounts":{"gemini":{"api_key":"sk-gem","api_keys":["sk-gem-second"]}}})).unwrap()),
        ..ProvidersConfig::default()
    };

    let view = redact_providers(&cfg);
    let encoded = serde_json::to_string(&view).unwrap();
    assert!(!encoded.contains("sk-gem"));
    let openai = view.openai.unwrap();
    assert_eq!(openai.api_key, "***", "the raw key must never be returned");
    assert_eq!(openai.base_url, "https://api.openai.com/v1");
    // all_keys() = primary + 2 extras, none blank â‡’ 3 accounts.
    assert_eq!(openai.api_key_count, 3);
    assert_eq!(view.anthropic.unwrap().api_key_count, 1);
    // Core exposes only whether a token is present, never the token itself.
    assert!(view.core.unwrap().has_token);
    // GenAi exposes only the key NAMES (providers), not the secret values.
    let genai = view.genai.unwrap();
    assert_eq!(genai.keys, vec!["gemini".to_string()]);
    assert_eq!(genai.gemini_account_count, 2);
}

#[test]
fn redact_auth_masks_api_keys_but_keeps_metadata() {
    use super::redact_auth;
    use crate::config::{ApiKeyConfig, AuthConfig};

    let mut auth = AuthConfig {
        require_auth: true,
        master_key: Some("sk-master".to_string()),
        api_keys: vec![ApiKeyConfig {
            allowed_operations: vec![crate::config::ApiKeyOperation::Inference],
            key: "sk-client-secret".to_string(),
            name: "client-1".to_string(),
            org_id: Some("org-1".to_string()),
            team_id: Some("team-1".to_string()),
            channel_id: None,
            project_id: None,
            requests_per_minute: None,
            tokens_per_minute: None,
            token_budget_total: None,
            downgrade_to: None,
            trusted_forwarder: true,
        }],
    };
    let view = redact_auth(&auth);
    assert!(view.require_auth);
    assert_eq!(view.api_keys.len(), 1);
    let k = &view.api_keys[0];
    assert_eq!(k.key, "***", "the client key must be masked");
    assert_eq!(k.name, "client-1");
    assert_eq!(k.org_id.as_deref(), Some("org-1"));
    assert!(k.trusted_forwarder);
    assert!(!k.system_relay);
    assert_eq!(
        k.allowed_operations,
        vec![crate::config::ApiKeyOperation::Inference]
    );
    auth.api_keys[0].allowed_operations = vec![
        crate::config::ApiKeyOperation::WebSearch,
        crate::config::ApiKeyOperation::WebFetch,
    ];
    let scoped = serde_json::to_value(redact_auth(&auth)).unwrap();
    assert_eq!(
        scoped["api_keys"][0]["allowed_operations"],
        serde_json::json!(["web_search", "web_fetch"])
    );
    assert!(!scoped.to_string().contains("sk-client-secret"));
    auth.api_keys[0].allowed_operations = vec![crate::config::ApiKeyOperation::Inference];
    for name in ["local-core", "local-inference"] {
        auth.api_keys[0].name = name.to_owned();
        let view = redact_auth(&auth);
        assert!(view.api_keys[0].system_relay);
        assert_eq!(view.api_keys[0].key, "***");
    }
}

#[test]
fn admin_loopback_allowed_only_on_the_unlocked_local_case() {
    use super::admin_loopback_allowed;
    // The one green case: loopback peer, no auth required, no mesh/fleet, no
    // master key â‡’ the local unauthenticated admin path is allowed.
    assert!(admin_loopback_allowed(true, false, false, false, false));
    // Any single lock closes it.
    assert!(!admin_loopback_allowed(false, false, false, false, false)); // remote peer
    assert!(!admin_loopback_allowed(true, true, false, false, false)); // auth required
    assert!(!admin_loopback_allowed(true, false, true, false, false)); // mesh on
    assert!(!admin_loopback_allowed(true, false, false, true, false)); // fleet on
    assert!(!admin_loopback_allowed(true, false, false, false, true)); // master key set
}

#[tokio::test]
async fn require_local_admin_admits_master_key_and_rejects_remote_anon() {
    use super::require_local_admin;
    use crate::config::{AuthConfig, GatewayConfig};
    use axum::http::HeaderMap;
    use std::net::SocketAddr;
    use std::sync::Arc;

    // A gateway with a master key configured (auth required).
    let config = GatewayConfig {
        auth: AuthConfig {
            require_auth: true,
            master_key: Some("sk-master".to_string()),
            api_keys: vec![],
        },
        ..GatewayConfig::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let state = Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));

    let loopback: SocketAddr = "127.0.0.1:5".parse().unwrap();
    let remote: SocketAddr = "203.0.113.7:5".parse().unwrap();
    let no_headers = HeaderMap::new();

    // The master key admits from anywhere.
    assert!(require_local_admin(&state, &remote, true, &no_headers, "Config").is_ok());
    // A non-master, remote, auth-required caller is refused.
    let err = require_local_admin(&state, &remote, false, &no_headers, "Config").unwrap_err();
    assert!(matches!(err, crate::error::GatewayError::Unauthorized(_)));
    // A non-master loopback caller is ALSO refused here, because a master key is
    // configured (the unlocked-local exception requires no master key).
    assert!(require_local_admin(&state, &loopback, false, &no_headers, "Config").is_err());
}

#[tokio::test]
async fn require_local_admin_rejects_cross_origin_browser_requests() {
    use super::require_local_admin;
    use axum::http::HeaderMap;
    use std::net::SocketAddr;
    use std::sync::Arc;

    // Explicit local development posture: no auth, no master key â€” the loopback
    // exception would otherwise admit an anonymous local caller.
    let config = explicit_local_development_config();
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let state = Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));
    let loopback: SocketAddr = "127.0.0.1:5".parse().unwrap();

    // No Sec-Fetch-Site (curl, SDK, Core's server-side hop): admitted.
    assert!(require_local_admin(&state, &loopback, false, &HeaderMap::new(), "Config").is_ok());

    // A cross-site browser fetch (the CSRF attack) is refused even on loopback.
    let mut cross = HeaderMap::new();
    cross.insert("sec-fetch-site", "cross-site".parse().unwrap());
    assert!(
        require_local_admin(&state, &loopback, false, &cross, "Config").is_err(),
        "cross-site browser origin must be rejected"
    );

    // same-site is likewise not a legitimate admin caller.
    let mut same_site = HeaderMap::new();
    same_site.insert("sec-fetch-site", "same-site".parse().unwrap());
    assert!(require_local_admin(&state, &loopback, false, &same_site, "Config").is_err());

    // A direct navigation (`none`) is not a scripted cross-origin request.
    let mut none = HeaderMap::new();
    none.insert("sec-fetch-site", "none".parse().unwrap());
    assert!(require_local_admin(&state, &loopback, false, &none, "Config").is_ok());
}

#[tokio::test]
async fn require_local_admin_rejects_non_loopback_host_rebinding() {
    use super::require_local_admin;
    use axum::http::HeaderMap;
    use std::net::SocketAddr;
    use std::sync::Arc;

    // No-auth loopback posture (explicit local development): the peer is always
    // 127.0.0.1 in a DNS-rebinding attack, so peer posture alone can't tell the
    // browser from a legit server-side caller â€” the Host header does.
    let state = Arc::new(AppState::new_for_test(
        explicit_local_development_config(),
        AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap(),
        EvalsRunner::new(EvalsConfig::default()),
    ));
    let loopback: SocketAddr = "127.0.0.1:9999".parse().unwrap();

    // Rebinding shape: browser points evil.com at 127.0.0.1, so the request is
    // same-origin post-rebind but its (unforgeable) Host is the attacker domain.
    let mut rebinding = HeaderMap::new();
    rebinding.insert("host", "evil.com:7981".parse().unwrap());
    rebinding.insert("sec-fetch-site", "same-origin".parse().unwrap());
    assert!(
        matches!(
            require_local_admin(&state, &loopback, false, &rebinding, "Config").unwrap_err(),
            crate::error::GatewayError::Unauthorized(_)
        ),
        "a rebinding browser (non-loopback Host) must be rejected"
    );

    // Legitimate server-side caller (curl / SDK / Core's gateway hop): loopback
    // Host, no Sec-Fetch-Site. This is the load-bearing non-regression.
    let mut legit = HeaderMap::new();
    legit.insert("host", "127.0.0.1:7981".parse().unwrap());
    assert!(
        require_local_admin(&state, &loopback, false, &legit, "Config").is_ok(),
        "a server-side loopback caller must still pass"
    );

    // Even a loopback Host is refused if the browser stamped it same-origin: a
    // Sec-Fetch-Site tell on a privileged mutation is never a legit admin caller.
    let mut loopback_but_browser = HeaderMap::new();
    loopback_but_browser.insert("host", "127.0.0.1:7981".parse().unwrap());
    loopback_but_browser.insert("sec-fetch-site", "same-origin".parse().unwrap());
    assert!(
        require_local_admin(&state, &loopback, false, &loopback_but_browser, "Config").is_err(),
        "a same-origin browser fetch is rejected even on a loopback Host"
    );
}

/// Redaction is the subject, but the handler also calls [`persisted_config`]
/// unconditionally â€” so without a config-path window this test read the
/// developer's real `<config>/ryu/gateway.toml` and its `routing`/`tools`
/// assertions would depend on host state. It cannot *fail* on host state
/// (`persisted_config` falls back to the snapshot), which is exactly why the
/// dependency went unnoticed; the guard makes the isolation structural.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn get_config_returns_a_redacted_view_for_the_master_key() {
    use super::get_config;
    use crate::config::{AuthConfig, GatewayConfig, OpenAiProviderConfig, ProvidersConfig};
    use axum::extract::{ConnectInfo, State};
    use axum::http::HeaderMap;
    use axum::Json;
    use std::net::SocketAddr;
    use std::sync::Arc;

    let _config_path = crate::config::test_config_path::ConfigPathGuard::isolated("redacted");

    let config = GatewayConfig {
        auth: AuthConfig {
            require_auth: true,
            master_key: Some("sk-master".to_string()),
            api_keys: vec![],
        },
        providers: ProvidersConfig {
            openai: Some(OpenAiProviderConfig {
                api_key: "sk-openai-secret".to_string(),
                api_keys: vec![],
                base_url: "https://api.openai.com/v1".to_string(),
            }),
            ..ProvidersConfig::default()
        },
        ..GatewayConfig::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let state = Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));

    let mut headers = HeaderMap::new();
    headers.insert("authorization", "Bearer sk-master".parse().unwrap());
    let peer = ConnectInfo("127.0.0.1:5".parse::<SocketAddr>().unwrap());

    let Json(body) = get_config(State(state), peer, headers)
        .await
        .expect("master key may read config");

    // The provider key is redacted, and no raw secret appears anywhere.
    assert_eq!(body["providers"]["openai"]["api_key"], "***");
    let serialized = serde_json::to_string(&body).unwrap();
    assert!(
        !serialized.contains("sk-openai-secret"),
        "the raw provider key must never leave the gateway"
    );
    assert_eq!(body["auth"]["require_auth"], true);
}

/// End-to-end for the pipeline half: a `[pipeline]` table that disables a
/// governance stage must reach the wire through the REAL `get_config`, so a
/// client can badge that stage's (still-editable, still-persisted) settings
/// card as not in the pipeline.
///
/// The view-level test `disabled_pipeline_stage_is_absent_from_the_view` only
/// proves the `ConfigView` type serializes stage ids. This one covers the
/// whole chain â€” `config.pipeline` â†’ `StageOrder::resolve` in `AppState`
/// construction â†’ `state.stage_order` â†’ JSON â€” and is what pins the design
/// decision the field rests on: the handler reports the order the RUNNING
/// process resolved, not one re-derived from the persisted file (which would
/// describe the next boot, not this one).
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn get_config_reports_the_running_pipeline_order() {
    use super::get_config;
    use crate::config::{AuthConfig, GatewayConfig};
    use axum::extract::{ConnectInfo, State};
    use axum::http::HeaderMap;
    use axum::Json;
    use std::net::SocketAddr;
    use std::sync::Arc;

    let _config_path = crate::config::test_config_path::ConfigPathGuard::isolated("pipeline-order");

    let config = GatewayConfig {
        auth: AuthConfig {
            require_auth: true,
            master_key: Some("sk-master".to_string()),
            api_keys: vec![],
        },
        pipeline: crate::pipeline::stages::PipelineOrderConfig {
            order: Vec::new(),
            disabled: vec![crate::pipeline::stages::PipelineStage::Inspector],
        },
        ..GatewayConfig::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let state = Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));

    // Sanity: the config really did disable the stage in the running state,
    // so a missing id below means the VIEW dropped it, not that the fixture
    // never disabled anything.
    assert!(
        !state
            .stage_order
            .stages()
            .contains(&crate::pipeline::stages::PipelineStage::Inspector),
        "fixture precondition: the inspector should be out of the resolved order"
    );

    let mut headers = HeaderMap::new();
    headers.insert("authorization", "Bearer sk-master".parse().unwrap());
    let peer = ConnectInfo("127.0.0.1:5".parse::<SocketAddr>().unwrap());

    let Json(body) = get_config(State(state), peer, headers)
        .await
        .expect("master key may read config");

    let stages: Vec<String> = serde_json::from_value(body["pipeline_stages"].clone())
        .expect("the handler emits pipeline_stages as a list of stage ids");
    assert!(
        !stages.contains(&"inspector".to_string()),
        "a stage dropped by [pipeline] must not be reported as running: {stages:?}"
    );
    assert!(
        stages.contains(&"firewall".to_string()) && stages.last() == Some(&"audit".to_string()),
        "the pinned skeleton is still reported: {stages:?}"
    );
}

/// A2/A7 regression. A firewall-only PUT must not revert sections an EARLIER
/// PUT already persisted, and `GET /v1/config` must report what is on disk.
///
/// `state.config` is the STARTUP snapshot and is never hot-swapped, so BOTH
/// halves of the handler have to consult the persisted file:
///   - the writer seeds the file it re-serializes from disk, else the stale
///     snapshot's all-`#[serde(default)]` `routing` / `tools` / `backends`
///     (empty on a fresh boot) are written over the live file â€” saving one
///     section silently reverts every other;
///   - the reader serves the persisted `routing` / `tools`, else the desktop's
///     read-modify-write (`{ ...cfg.routing, model_map }` in
///     `GatewayDialog.tsx`) spreads a stale routing object and the NEXT save
///     wipes the mapping added by the previous one â€” no restart needed.
///
/// `modality_map` / `eval_routing` / the tool tuning knobs are the fields that
/// were invisible in the GET views, so a client could not round-trip them even
/// in principle; they are asserted on both sides.
// Holding the config-path guard across the handler `.await` is the point: the
// window has to cover the disk reads the handler performs.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn firewall_only_put_and_get_preserve_sections_persisted_earlier() {
    use super::{get_config, put_config};
    use crate::config::{
        EvalRoutingConfig, FirewallConfig, Modality, ModalityMapping, ModelMapping, ToolProfile,
    };
    use crate::evaluators::{
        Capabilities, Evaluator, EvaluatorCategory, EvaluatorImpl, EvaluatorTarget,
    };
    use axum::extract::{ConnectInfo, State};
    use axum::http::HeaderMap;
    use axum::Json;
    use std::net::SocketAddr;
    use std::sync::Arc;

    // Point the persist path at a private temp file. `GATEWAY_CONFIG` is
    // process-global and the whole crate's unit tests share one process, so the
    // window is taken through the shared RAII guard: it holds the crate-wide lock
    // for its lifetime (no other config test can be inside a window at the same
    // time) and restores the prior value + deletes the temp dir on drop, including
    // on a panic. Hand-rolling it here leaked the var at a deleted directory
    // whenever an assertion below failed, silently redirecting every later test.
    let guard = crate::config::test_config_path::ConfigPathGuard::isolated("firewall-put");
    let path = guard.path().to_path_buf();

    // â”€â”€ Arrange: what an earlier PUT left on disk â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let mut persisted = explicit_local_development_config();
    persisted.routing.model_map.insert(
        "claude-3-5-sonnet".to_string(),
        ModelMapping {
            provider: "anthropic".into(),
            provider_model: Some("claude-3-5-sonnet-latest".to_string()),
        },
    );
    persisted.routing.modality_map.insert(
        Modality::Image,
        ModalityMapping {
            provider: "fal".into(),
            model: Some("flux".to_string()),
        },
    );
    persisted.routing.eval_routing = EvalRoutingConfig {
        enabled: true,
        candidates: vec!["openai".into(), "anthropic".into()],
        explore_ratio: 0.4,
    };
    persisted.tools.max_rounds = 9;
    persisted.tools.describe_top_n = 11;
    persisted.tools.parallel_reads = 2;
    // A real nested tool def, not an empty vec: `always_on` is
    // `Vec<serde_json::Value>`, so in `[tools]` it serializes as an
    // array-of-tables followed by the `max_rounds` / `describe_top_n` scalars â€”
    // the TOML `ValueAfterTable` shape. Exercising it here proves the section
    // the new view invites clients to round-trip can actually be re-persisted
    // by `save()` instead of 500ing the next PUT.
    persisted.tools.always_on = vec![serde_json::json!({
        "type": "function",
        "function": {
            "name": "ping",
            "parameters": { "type": "object" }
        }
    })];
    persisted.tools.profiles.insert(
        "locked".to_string(),
        ToolProfile {
            deny: vec!["shell.exec".to_string()],
            ..Default::default()
        },
    );
    // A non-budget stage selection: `budget` is the one registry that swaps
    // live, so the other seven only ever live in this file.
    persisted.backends.cache = "redis".to_string();
    persisted.custom_evaluators = vec![Evaluator {
        id: "house_style".to_string(),
        name: "House style".to_string(),
        description: "hand-authored".to_string(),
        category: EvaluatorCategory::Custom,
        target: EvaluatorTarget::Output,
        capabilities: Capabilities {
            inline: false,
            offline: true,
        },
        impl_: EvaluatorImpl::Regex {
            patterns: vec!["forbidden".to_string()],
        },
        inline: None,
        offline: None,
        builtin: false,
        enforced: false,
        higher_is_better: true,
    }];
    persisted.save().expect("seed the persisted config");

    // The gateway's own snapshot is the pre-PUT one: default routing/tools/
    // backends, i.e. exactly what a boot before those saves would hold.
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let state = Arc::new(AppState::new_for_test(
        explicit_local_development_config(),
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));
    // Loopback + no auth + no master key â‡’ the explicit local development admin path,
    // so no credential header is needed (and no env-provided key can skew it).
    let peer = ConnectInfo("127.0.0.1:5".parse::<SocketAddr>().unwrap());

    // â”€â”€ Act: a firewall-only save, the ordinary "tighten a guardrail" flow â”€â”€
    let patch = ConfigPatch {
        composio_billing: None,
        expected_revision: None,
        provider_account_policies: None,
        provider_account_strategies: None,
        provider_account_drain_thresholds: None,
        acp: None,
        computer_use: None,
        firewall: Some(FirewallConfig {
            policy: FirewallPolicy::Block,
            ..FirewallConfig::default()
        }),
        budgets: None,
        auth: None,
        routing: None,
        egress: None,
        tools: None,
        firewall_org_overlays: None,
        firewall_agent_overlays: None,
        custom_evaluators: None,
        backends: None,
        resolved_backends: None,
        screening: None,
        marketplace_recommendations: None,
        phone_calls: None,
    };
    let Json(saved) = put_config(
        State(Arc::clone(&state)),
        peer,
        HeaderMap::new(),
        Json(patch),
    )
    .await
    .expect("firewall-only PUT succeeds");
    assert_eq!(saved["ok"], true);

    // â”€â”€ Assert (write half): read the FILE TEXT, not `load()` â€” the env
    // overlay in `load()` would mask what was actually written.
    let text = std::fs::read_to_string(&path).expect("gateway.toml written");
    let on_disk: GatewayConfig = toml::from_str(&text).expect("re-parse persisted config");

    assert_eq!(
        on_disk.firewall.policy,
        FirewallPolicy::Block,
        "the patched section must land"
    );
    let mapping = on_disk
        .routing
        .model_map
        .get("claude-3-5-sonnet")
        .expect("routing.model_map survives an unrelated PUT");
    assert_eq!(mapping.provider.as_str(), "anthropic");
    let modality = on_disk
        .routing
        .modality_map
        .get(&Modality::Image)
        .expect("routing.modality_map survives an unrelated PUT");
    assert_eq!(modality.provider.as_str(), "fal");
    assert!(
        on_disk.routing.eval_routing.enabled,
        "routing.eval_routing survives an unrelated PUT"
    );
    assert_eq!(
        on_disk.tools.max_rounds, 9,
        "tools survive an unrelated PUT"
    );
    assert_eq!(on_disk.tools.describe_top_n, 11);
    assert_eq!(on_disk.tools.parallel_reads, 2);
    assert_eq!(
        on_disk.tools.always_on.len(),
        1,
        "always_on tool defs survive an unrelated PUT"
    );
    assert_eq!(on_disk.tools.always_on[0]["function"]["name"], "ping");
    assert!(on_disk.tools.profiles.contains_key("locked"));
    assert_eq!(
        on_disk.backends.cache, "redis",
        "non-budget backend selection survives an unrelated PUT"
    );
    assert_eq!(
        on_disk.custom_evaluators.len(),
        1,
        "hand-authored evaluators survive an unrelated PUT"
    );

    // â”€â”€ Assert (read half): GET reports the PERSISTED routing/tools, and the
    // two formerly-invisible routing fields plus the tool knobs are present so
    // a spread-and-PUT client round-trips them instead of erasing them.
    let mut headers = HeaderMap::new();
    headers.insert("host", "127.0.0.1:7981".parse().unwrap());
    let Json(body) = get_config(
        State(Arc::clone(&state)),
        ConnectInfo("127.0.0.1:5".parse::<SocketAddr>().unwrap()),
        headers,
    )
    .await
    .expect("loopback admin may read config");

    assert_eq!(
        body["routing"]["model_map"]["claude-3-5-sonnet"]["provider"], "anthropic",
        "GET must serve the persisted model_map, not the startup snapshot"
    );
    // Also proves the `Modality` enum map key serializes as a JSON object key
    // (`json!` would panic on a rejected key, taking the handler with it).
    assert_eq!(body["routing"]["modality_map"]["image"]["provider"], "fal");
    assert_eq!(body["routing"]["eval_routing"]["enabled"], true);
    assert_eq!(body["tools"]["max_rounds"], 9);
    assert_eq!(body["tools"]["describe_top_n"], 11);
    assert_eq!(body["tools"]["parallel_reads"], 2);
    assert_eq!(
        body["tools"]["always_on"][0]["function"]["name"], "ping",
        "always_on must be visible so a read-modify-write cannot zero it"
    );
    assert!(body["tools"]["profiles"]["locked"].is_object());

    // `guard` restores `GATEWAY_CONFIG` and removes the temp dir on drop.
    drop(guard);
}

/// The auth gate runs before [`persisted_config`], so today this refusal never
/// reaches disk â€” but that is an ordering detail inside the handler, not a
/// property of the test. The window makes the "reads no host state" claim hold
/// regardless of how the handler is later reordered.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn get_config_rejects_a_missing_or_wrong_key() {
    use super::get_config;
    use crate::config::{AuthConfig, GatewayConfig};
    use axum::extract::{ConnectInfo, State};
    use axum::http::HeaderMap;
    use std::net::SocketAddr;
    use std::sync::Arc;

    let _config_path = crate::config::test_config_path::ConfigPathGuard::isolated("reject");

    let config = GatewayConfig {
        auth: AuthConfig {
            require_auth: true,
            master_key: Some("sk-master".to_string()),
            api_keys: vec![],
        },
        ..GatewayConfig::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let state = Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));

    // A remote peer with no authorization header must not read config.
    let peer = ConnectInfo("203.0.113.7:5".parse::<SocketAddr>().unwrap());
    let res = get_config(State(state), peer, HeaderMap::new()).await;
    assert!(res.is_err(), "unauthenticated remote read must be refused");
}

// â”€â”€ The classify route seed must not surface as a "Model mapping" â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// `GatewayConfig::load` seeds `routing.model_map[<classify id>] â†’ classify` so the
// guardrail classifier is routable. `GatewayDialog.tsx` renders every `model_map`
// entry as an operator-authored row with a delete button, and `removeMapping`
// deletes the key and PUTs the whole `routing` â€” which persisted fine and then had
// the row re-seeded by the next read. A mapping nobody wrote, that comes back after
// a successful delete. These two tests pin both halves at the HTTP boundary; the
// in-memory routability half lives in `config.rs::classify_tier_tests`.

/// `model_map` keys whose mapping points at the `classify` provider. Keyed on the
/// PROVIDER, not on `classify_model_id()`: another test in this binary flips
/// `RYU_CLASSIFY_MODEL_ID`, so which id was seeded is not stable across a parallel
/// run, while "something routes to the classify tier" is â€” and is the stronger claim.
fn classify_rows(routing: &serde_json::Value) -> Vec<String> {
    let mut rows: Vec<String> = routing["model_map"]
        .as_object()
        .expect("model_map is an object")
        .iter()
        .filter(|(_, mapping)| mapping["provider"] == "classify")
        .map(|(model, _)| model.clone())
        .collect();
    rows.sort();
    rows
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn get_config_does_not_serve_the_seeded_classify_mapping() {
    use super::get_config;
    use axum::extract::{ConnectInfo, State};
    use axum::http::HeaderMap;
    use axum::Json;
    use std::net::SocketAddr;
    use std::sync::Arc;

    let guard = crate::config::test_config_path::ConfigPathGuard::isolated("seed-view");
    // An operator's own rows, one of which deliberately targets `classify` â€” the
    // inverse case. The view must drop only what `load()` derived.
    std::fs::write(
        guard.path(),
        "[routing.model_map.\"claude-3-5-sonnet\"]\nprovider = \"anthropic\"\n\n\
         [routing.model_map.\"my-own-classifier\"]\nprovider = \"classify\"\n",
    )
    .expect("seed gateway.toml");

    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let state = Arc::new(AppState::new_for_test(
        explicit_local_development_config(),
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));
    let mut headers = HeaderMap::new();
    headers.insert("host", "127.0.0.1:7981".parse().unwrap());
    let Json(body) = get_config(
        State(Arc::clone(&state)),
        ConnectInfo("127.0.0.1:5".parse::<SocketAddr>().unwrap()),
        headers,
    )
    .await
    .expect("loopback admin may read config");

    assert_eq!(
        classify_rows(&body["routing"]),
        vec!["my-own-classifier".to_string()],
        "only the operator's own classify mapping may be served â€” a seeded row here \
         reads as hand-authored and cannot be deleted"
    );
    assert_eq!(
        body["routing"]["model_map"]["claude-3-5-sonnet"]["provider"], "anthropic",
        "stripping the seed must not disturb the rest of the map"
    );
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn a_routing_put_neither_persists_nor_resurrects_the_seeded_classify_mapping() {
    use super::{get_config, put_config};
    use crate::config::RoutingConfig;
    use axum::extract::{ConnectInfo, State};
    use axum::http::HeaderMap;
    use axum::Json;
    use std::net::SocketAddr;
    use std::sync::Arc;

    let guard = crate::config::test_config_path::ConfigPathGuard::isolated("seed-put");
    // START from the migration case: this node's file ALREADY carries the row a
    // pre-fix gateway persisted, under the current classify id. Deleting it has to
    // stick now â€” that is the operator-visible bug.
    let stale_id = crate::config::classify_model_id();
    std::fs::write(
        guard.path(),
        format!("[routing.model_map.\"{stale_id}\"]\nprovider = \"classify\"\n"),
    )
    .expect("seed gateway.toml");

    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let state = Arc::new(AppState::new_for_test(
        explicit_local_development_config(),
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));
    let peer = || ConnectInfo("127.0.0.1:5".parse::<SocketAddr>().unwrap());
    let admin_headers = || {
        let mut h = HeaderMap::new();
        h.insert("host", "127.0.0.1:7981".parse().unwrap());
        h
    };

    // The file row is the operator's as far as we can tell, so it IS served.
    let Json(before) = get_config(State(Arc::clone(&state)), peer(), admin_headers())
        .await
        .expect("read config");
    assert_eq!(classify_rows(&before["routing"]), vec![stale_id.clone()]);

    // The desktop's delete: spread the served routing, drop the key, PUT it back.
    let mut routing: RoutingConfig =
        serde_json::from_value(before["routing"].clone()).expect("view round-trips to config");
    routing.model_map.remove(&stale_id);
    let Json(saved) = put_config(
        State(Arc::clone(&state)),
        peer(),
        admin_headers(),
        Json(ConfigPatch {
            composio_billing: None,
            expected_revision: None,
            provider_account_policies: None,
            provider_account_strategies: None,
            provider_account_drain_thresholds: None,
            acp: None,
            computer_use: None,
            firewall: None,
            budgets: None,
            auth: None,
            routing: Some(routing),
            egress: None,
            tools: None,
            firewall_org_overlays: None,
            firewall_agent_overlays: None,
            custom_evaluators: None,
            backends: None,
            resolved_backends: None,
            screening: None,
            marketplace_recommendations: None,
            phone_calls: None,
        }),
    )
    .await
    .expect("routing PUT succeeds");
    assert_eq!(saved["ok"], true);

    // The file no longer has it â€” and, the actual fix, the NEXT read does not
    // resurrect it even though `load()` re-seeds the row in memory for the router.
    let text = std::fs::read_to_string(guard.path()).expect("gateway.toml written");
    let on_disk: GatewayConfig = toml::from_str(&text).expect("re-parse persisted config");
    assert!(
        !on_disk.routing.model_map.contains_key(&stale_id),
        "the delete must land on disk"
    );
    let Json(after) = get_config(State(Arc::clone(&state)), peer(), admin_headers())
        .await
        .expect("read config again");
    assert!(
        classify_rows(&after["routing"]).is_empty(),
        "a deleted mapping must stay deleted; got {:?}",
        classify_rows(&after["routing"])
    );

    // Non-regression: routing itself is unaffected â€” a fresh `load()` (what the
    // next gateway boot hands `AppState::new` â†’ `RouterRegistry::new`) still has
    // the classifier id pointing at the tier. Read through the marker rather than
    // recomputing the id, so a parallel test flipping `RYU_CLASSIFY_MODEL_ID`
    // cannot make this look up the wrong key.
    let reloaded = GatewayConfig::load().expect("reload");
    let seeded_id = reloaded
        .seeded_classify_model
        .clone()
        .expect("load must re-seed the classify row for the router");
    assert_eq!(
        reloaded.routing.model_map[&seeded_id].provider.as_str(),
        "classify",
        "the seed must still make the classifier id routable in memory"
    );
}
