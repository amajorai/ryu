use super::*;

#[test]
fn agent_provider_access_rides_only_the_gateway_hop() {
    let limited = Some("anthropic".to_owned());
    // The Gateway hop carries the list (or `none`) and nothing else changes.
    assert_eq!(
        provider_access_for_hop(true, limited.clone(), Some("gw-token")),
        Ok(limited.clone())
    );
    assert_eq!(
        provider_access_for_hop(true, Some("none".into()), Some("gw-token")),
        Ok(Some("none".into()))
    );
    assert_eq!(
        provider_access_for_hop(true, None, Some("gw-token")),
        Ok(None)
    );
    // A direct hop never carries it; with a provider key a limited agent is
    // refused, while a keyless endpoint or an unrestricted agent goes ahead.
    assert!(provider_access_for_hop(false, limited.clone(), Some("sk-direct")).is_err());
    assert!(provider_access_for_hop(false, Some("none".into()), Some("sk-direct")).is_err());
    assert_eq!(provider_access_for_hop(false, limited, None), Ok(None));
    assert_eq!(
        provider_access_for_hop(false, None, Some("sk-direct")),
        Ok(None)
    );
}

#[tokio::test]
async fn agent_provider_access_is_read_from_the_current_record() {
    let store = AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap();
    let id = store
        .create(crate::agents::CreateAgent {
            name: "Limited".into(),
            ..Default::default()
        })
        .await
        .unwrap()
        .id;
    assert_eq!(
        crate::agent_access::provider_access_for_agent(&store, &id).await,
        None
    );
    store
        .update(
            &id,
            crate::agents::UpdateAgent {
                account_access: Some(Some(vec!["provider:openai".into(), "composio:ca_1".into()])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        crate::agent_access::provider_access_for_agent(&store, &id).await,
        Some(vec!["openai".to_owned()])
    );
    store
        .update(
            &id,
            crate::agents::UpdateAgent {
                identity_mode: Some(crate::agents::AgentIdentityMode::Individual),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        crate::agent_access::provider_access_for_agent(&store, &id).await,
        Some(Vec::new())
    );
    // No record: nothing limits it, as everywhere else in Core.
    assert_eq!(
        crate::agent_access::provider_access_for_agent(&store, "missing").await,
        None
    );
}

#[tokio::test]
async fn acp_turn_identity_is_captured_before_late_preparation_and_cannot_be_client_supplied() {
    let conversations = ConversationStore::open_in_memory().unwrap();
    let old = conversations
        .ensure_conversation_with_generation("chat", None, None, Tenancy::Unattributed)
        .await
        .unwrap();
    let mut request: ChatStreamRequest = serde_json::from_value(serde_json::json!({ "conversation_id": "chat", "persist": false, "acp_conversation_generation": "attacker" })).unwrap();
    assert!(request.acp_conversation_generation.is_none());
    capture_acp_conversation_generation(&mut request, &conversations)
        .await
        .unwrap();
    assert_eq!(request.acp_conversation_generation, Some(Some(old.clone())));
    conversations.delete_conversation("chat").await.unwrap();
    let new = conversations
        .ensure_conversation_with_generation("chat", None, None, Tenancy::Unattributed)
        .await
        .unwrap();
    assert_ne!(old, new);
    capture_acp_conversation_generation(&mut request, &conversations)
        .await
        .unwrap();
    assert_eq!(request.acp_conversation_generation, Some(Some(old)));
    let mut fresh = ChatStreamRequest {
        conversation_id: Some("chat".to_owned()),
        persist: false,
        ..Default::default()
    };
    capture_acp_conversation_generation(&mut fresh, &conversations)
        .await
        .unwrap();
    assert_eq!(fresh.acp_conversation_generation, Some(Some(new)));
}

#[test]
fn acp_session_defaults_respect_the_model_allowlist() {
    let settings: crate::acp_agent_settings::AcpAgentSettings =
        serde_json::from_value(serde_json::json!({
            "allowedModels": ["sonnet"],
            "defaultModel": "opus",
            "defaultMode": "plan",
            "defaultConfigOptions": {"model": "opus", "effort": "high"},
        }))
        .expect("settings");
    let mut req = ChatStreamRequest::default();
    apply_acp_session_defaults(&mut req, &settings, true);
    assert_eq!(
        req.acp_model, None,
        "an excluded default model is not applied"
    );
    assert_eq!(req.acp_mode.as_deref(), Some("plan"));
    let config = req.acp_config.expect("config defaults");
    assert_eq!(config.get("effort").map(String::as_str), Some("high"));
    assert!(
        !config.contains_key("model"),
        "an excluded default model option is not applied"
    );

    let allowed: crate::acp_agent_settings::AcpAgentSettings =
        serde_json::from_value(serde_json::json!({
            "allowedModels": ["opus"],
            "defaultModel": "opus",
        }))
        .expect("settings");
    let mut req = ChatStreamRequest::default();
    apply_acp_session_defaults(&mut req, &allowed, true);
    assert_eq!(req.acp_model.as_deref(), Some("opus"));
}

#[test]
fn sdk_turn_selection_pins_configured_model_and_preserves_unknown_model() {
    let mut config = crate::pi_config::PiConfigView {
        provider: "xai".to_owned(),
        model: None,
        thinking_level: None,
        routing: "direct".to_owned(),
        provider_routing: serde_json::Map::new(),
        config_dir: String::new(),
    };
    let account = crate::pi_config::session_accounts::SessionAccount {
        provider_id: "xai".to_owned(),
        account_id: "selected-account".to_owned(),
        session_key: "bound-conversation".to_owned(),
        credential_kind: "api-key".to_owned(),
    };
    for (configured, expected) in [
        (None, None),
        (Some(" "), None),
        (Some("fixture-sdk-route"), Some("fixture-sdk-route")),
        (
            Some(" xai/fixture-sdk-route "),
            Some("xai/fixture-sdk-route"),
        ),
        (Some("org/model"), Some("org/model")),
        (Some("xai/"), Some("xai/")),
    ] {
        config.model = configured.map(str::to_owned);
        let selection = SdkTurnSelection::from_config(account.clone(), &config);
        assert_eq!(selection.model.as_deref(), expected);
        let mut request = ChatStreamRequest {
            lane_default: true,
            acp_model: Some("Gemma-lane-default".to_owned()),
            acp_config: Some(std::collections::HashMap::from([
                ("model".to_owned(), "rejected-model".to_owned()),
                ("effort".to_owned(), "high".to_owned()),
            ])),
            ..Default::default()
        };
        selection.pin_request_model(&mut request);
        let dispatch = expected.map(|model| format!("xai/{model}"));
        assert_eq!(request.acp_model, dispatch);
        assert_eq!(
            request.acp_config.as_ref().unwrap().get("model"),
            dispatch.as_ref()
        );
        assert_eq!(request.acp_config.as_ref().unwrap()["effort"], "high");
    }

    config.provider = "openrouter".to_owned();
    config.model = Some("openrouter/auto".to_owned());
    let mut namespaced_account = account.clone();
    namespaced_account.provider_id = config.provider.clone();
    let namespaced = SdkTurnSelection::from_config(namespaced_account, &config);
    let mut request = ChatStreamRequest::default();
    namespaced.pin_request_model(&mut request);
    assert_eq!(namespaced.model.as_deref(), Some("openrouter/auto"));
    assert_eq!(
        request.acp_model.as_deref(),
        Some("openrouter/openrouter/auto")
    );

    config.provider = "xai".to_owned();
    config.model = Some("fixture-sdk-route".to_owned());
    let selection = SdkTurnSelection::from_config(account, &config);
    config.provider = "another-provider".to_owned();
    config.model = Some("another-model".to_owned());
    let mut request = ChatStreamRequest::default();
    selection.pin_request_model(&mut request);
    assert_eq!(selection.account.provider_id, "xai");
    assert_eq!(selection.model.as_deref(), Some("fixture-sdk-route"));
    assert_eq!(request.acp_model.as_deref(), Some("xai/fixture-sdk-route"));
}

#[test]
fn managed_pi_guard_requires_exact_direct_sdk_model_and_captured_account() {
    let mut config = crate::pi_config::PiConfigView {
        provider: "openai".to_owned(),
        model: Some("gpt-4o-mini".to_owned()),
        thinking_level: None,
        routing: "direct".to_owned(),
        provider_routing: serde_json::Map::new(),
        config_dir: String::new(),
    };
    let mut account = crate::pi_config::session_accounts::SessionAccount {
        provider_id: "openai".to_owned(),
        account_id: "connected-account".to_owned(),
        session_key: "conversation-binding".to_owned(),
        credential_kind: "api-key".to_owned(),
    };
    assert!(direct_managed_pi_configured(true, &config, Some(&account)));
    assert!(!direct_managed_pi_configured(
        false,
        &config,
        Some(&account)
    ));
    assert!(!direct_managed_pi_configured(true, &config, None));
    account.provider_id = "anthropic".to_owned();
    assert!(!direct_managed_pi_configured(true, &config, Some(&account)));
    account.provider_id = config.provider.clone();
    config.routing = "gateway".to_owned();
    assert!(!direct_managed_pi_configured(true, &config, Some(&account)));
    config.routing = "direct".to_owned();
    for model in [None, Some(String::new()), Some("  ".to_owned())] {
        config.model = model;
        assert!(!direct_managed_pi_configured(true, &config, Some(&account)));
    }
    config.model = Some("gpt-4o-mini".to_owned());
    config.provider = crate::pi_config::GATEWAY_PROVIDER_ID.to_owned();
    account.provider_id = config.provider.clone();
    assert!(!direct_managed_pi_configured(true, &config, Some(&account)));
}

/// The prompt-cache preference is forwarded verbatim as a header, so an
/// unvalidated value would reach the gateway (and the provider) mid-turn.
/// Both validators are closed sets for that reason.
#[test]
fn prompt_cache_preference_values_are_a_closed_set() {
    for ok in ["off", "auto", "explicit"] {
        assert!(is_prompt_cache_mode(ok), "{ok}");
    }
    for bad in ["", "on", "true", "ON", "atuo", "explicit "] {
        assert!(!is_prompt_cache_mode(bad), "{bad}");
    }

    for ok in ["5m", "1h"] {
        assert!(is_prompt_cache_ttl(ok), "{ok}");
    }
    for bad in ["", "1H", "10m", "forever", "3600"] {
        assert!(!is_prompt_cache_ttl(bad), "{bad}");
    }
}

#[test]
fn project_environment_rejects_host_shell_scripts() {
    let mut environment = ProjectEnvironmentRequest::default();
    assert!(!environment.contains_scripts());
    environment.setup.linux = "echo unsafe".to_owned();
    assert!(environment.contains_scripts());
    environment.setup.linux.clear();
    environment.cleanup.windows = "Write-Output unsafe".to_owned();
    assert!(environment.contains_scripts());
}

#[test]
fn project_environment_rejects_reserved_core_keys() {
    for key in [
        "RYU_TOKEN",
        "RYU_MCP_CORE_TOKEN",
        "OPENAI_API_KEY",
        "ANTHROPIC_BASE_URL",
        "PI_CODING_AGENT_DIR",
        "RYU_PI_ACTIVE_TOOLS",
        "ryu_pi_host_conversation_id",
    ] {
        assert!(reserved_environment_key(key), "{key} must stay Core-owned");
    }
    assert!(!reserved_environment_key("RUST_LOG"));
}

/// A hook-handled turn is framed exactly like a streamed one. Getting this
/// wrong is not cosmetic: a missing `start`/`finish` leaves the client
/// rendering a turn that never opens or never closes, and a stray `[DONE]`
/// here would truncate a multi-turn response — so the sequence, the shared
/// text id, and the ABSENCE of a terminal frame are all pinned.
#[test]
fn synthetic_assistant_frames_are_a_complete_well_formed_turn() {
    let frames = synthetic_assistant_frames("answered from cache");
    let parsed: Vec<serde_json::Value> = frames
        .iter()
        .map(|f| {
            let text = std::str::from_utf8(f).expect("utf8");
            assert!(text.starts_with("data: "), "each frame is an SSE data line");
            assert!(text.ends_with("\n\n"), "each frame is terminated");
            serde_json::from_str(text.trim_start_matches("data: ").trim_end_matches("\n\n"))
                .expect("frame carries JSON")
        })
        .collect();

    let kinds: Vec<&str> = parsed.iter().map(|v| v["type"].as_str().unwrap()).collect();
    assert_eq!(
        kinds,
        vec!["start", "text-start", "text-delta", "text-end", "finish"],
        "the client's expected open → text → close sequence"
    );
    assert_eq!(parsed[2]["delta"], "answered from cache");

    // The three text parts must share one id or the client cannot assemble them.
    let id = parsed[1]["id"].as_str().expect("text-start carries an id");
    assert!(!id.is_empty());
    assert_eq!(parsed[2]["id"], id);
    assert_eq!(parsed[3]["id"], id);

    // The caller owns [DONE]: one response may carry several turns but only
    // ever one terminal frame.
    assert!(
        !frames.iter().any(|f| is_done_frame(f)),
        "synthetic frames must not include the terminal [DONE]"
    );
}
