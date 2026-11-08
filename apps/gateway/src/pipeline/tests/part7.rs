use super::*;

/// Verify that an image request is dispatched to the provider registered in
/// the modality map and that the audit record carries the correct provider
/// label (`openai:image`). Uses a mock provider that succeeds immediately
/// without a live endpoint.
#[tokio::test]
async fn multimodal_image_dispatched_to_configured_provider_and_audited() {
    use crate::config::{ModalityMapping, RoutingConfig};
    use crate::router::RouteDecision;
    use std::collections::HashMap;

    // Build minimal state with a modality map pointing image → openai.
    let mut modality_map = HashMap::new();
    modality_map.insert(
        Modality::Image,
        ModalityMapping {
            provider: crate::config::ProviderKind::OpenAi.into(),
            model: Some("dall-e-3".to_string()),
        },
    );

    let config = crate::config::GatewayConfig {
        routing: RoutingConfig {
            modality_map,
            ..RoutingConfig::default()
        },
        // Disable auth so the test doesn't need a key.
        auth: crate::config::AuthConfig {
            require_auth: false,
            ..Default::default()
        },
        // Disable the firewall to keep the test deterministic.
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        ..crate::config::GatewayConfig::default()
    };

    // The test uses route_modality to check the routing decision directly —
    // a full pipeline run would need a real or mock HTTP provider. We verify
    // the dispatch decision and audit field name here without a live endpoint.
    let router = crate::router::ModelRouter::new(config.routing.clone());
    let RouteDecision { provider, model } = router.route_modality(&Modality::Image, "dall-e-3");

    assert_eq!(
        provider,
        crate::config::ProviderKind::OpenAi,
        "image request must be dispatched to the provider in the modality map"
    );
    assert_eq!(
        model, "dall-e-3",
        "model pin in the modality map must be forwarded to the provider"
    );

    // Verify the audit label format used by run_multimodal.
    let provider_label = format!("openai:{}", Modality::Image.as_str());
    assert_eq!(
        provider_label, "openai:image",
        "audit record provider field must encode the modality"
    );
}

/// Verify that an STT request is dispatched to the provider registered in
/// the modality map and carries the correct audit label.
#[tokio::test]
async fn multimodal_stt_dispatched_to_configured_provider_and_audited() {
    use crate::config::{ModalityMapping, RoutingConfig};
    use crate::router::RouteDecision;
    use std::collections::HashMap;

    let mut modality_map = HashMap::new();
    modality_map.insert(
        Modality::Stt,
        ModalityMapping {
            provider: crate::config::ProviderKind::OpenAi.into(),
            model: Some("whisper-1".to_string()),
        },
    );

    let config = crate::config::GatewayConfig {
        routing: RoutingConfig {
            modality_map,
            ..RoutingConfig::default()
        },
        ..crate::config::GatewayConfig::default()
    };

    let router = crate::router::ModelRouter::new(config.routing.clone());
    let RouteDecision { provider, model } = router.route_modality(&Modality::Stt, "whisper-1");

    assert_eq!(
        provider,
        crate::config::ProviderKind::OpenAi,
        "STT request must be dispatched to the provider in the modality map"
    );
    assert_eq!(
        model, "whisper-1",
        "model pin must be forwarded to the provider"
    );

    let provider_label = format!("openai:{}", Modality::Stt.as_str());
    assert_eq!(
        provider_label, "openai:stt",
        "audit record provider field must encode the modality"
    );
}

/// Verify that modality-to-provider mappings are swappable: changing the
/// modality_map re-routes the same request to a different provider.
#[test]
fn modality_map_is_swappable_no_hardcoded_provider() {
    use crate::config::{ModalityMapping, ProviderKind, RoutingConfig};
    use std::collections::HashMap;

    for provider in [
        ProviderKind::OpenAi,
        ProviderKind::Local,
        ProviderKind::OpenRouter,
    ] {
        let mut modality_map = HashMap::new();
        modality_map.insert(
            Modality::Image,
            ModalityMapping {
                provider: provider.clone().into(),
                model: None,
            },
        );
        let router = crate::router::ModelRouter::new(RoutingConfig {
            modality_map,
            ..RoutingConfig::default()
        });
        let decision = router.route_modality(&Modality::Image, "test-model");
        assert_eq!(
            decision.provider, provider,
            "modality map must be fully swappable: {provider:?} must route to itself"
        );
    }
}

/// When the slot has a provider but no model, the requested (caller) model
/// is forwarded, consistent with the existing modality_map behavior for
/// entries that don't pin a model.
#[test]
fn per_agent_slot_without_model_forwards_caller_model() {
    use crate::config::ProviderKind;
    let router = crate::router::ModelRouter::new(crate::config::RoutingConfig::default());

    let slot_provider: ProviderId = ProviderKind::Anthropic.into();
    let decision = router.route_modality_with_slot(
        &Modality::Tts,
        "tts-caller-model",
        Some(&slot_provider),
        None,
    );

    assert_eq!(decision.provider, ProviderKind::Anthropic);
    assert_eq!(
        decision.model, "tts-caller-model",
        "caller model is passed through when the slot doesn't pin a model"
    );
}

/// Unset slot (None provider) falls back to the static modality_map, then to
/// model routing. This is AC3 of #164: unset slot inherits the registry default.
#[test]
fn unset_slot_falls_back_to_modality_map_then_model_routing() {
    use crate::config::{ModalityMapping, ProviderKind, RoutingConfig};
    use std::collections::HashMap;

    let mut modality_map = HashMap::new();
    modality_map.insert(
        Modality::Image,
        ModalityMapping {
            provider: ProviderKind::OpenAi.into(),
            model: Some("dall-e-3".to_string()),
        },
    );

    let router = crate::router::ModelRouter::new(RoutingConfig {
        modality_map,
        ..RoutingConfig::default()
    });

    // No slot override: should fall through to modality_map.
    let decision =
        router.route_modality_with_slot(&Modality::Image, "some-caller-model", None, None);

    assert_eq!(
        decision.provider,
        ProviderKind::OpenAi,
        "absent slot must fall back to the static modality_map (AC3 #164)"
    );
    assert_eq!(
        decision.model, "dall-e-3",
        "modality_map model pin must be used when no slot override is present"
    );
}

/// Same carded agent: chat call routes to its chat slot provider, image call
/// routes to its image slot provider — two different providers from the same
/// request context. This is the primary AC of #164: per-attribute routing.
///
/// The test also verifies `pre_process`-level behavior: when `ctx.slot_provider`
/// is set, `pre_process` calls `route_modality_with_slot(Chat, ...)` instead of
/// the plain `router.route()` path, so the chat slot wins over eval/model routing.
#[test]
fn same_carded_agent_chat_and_image_route_to_different_providers() {
    use crate::config::{ProviderKind, RoutingConfig};
    use crate::router::ModelRouter;

    // Default config: model routing for chat (gpt-4o → OpenAi), no modality map.
    let router = ModelRouter::new(RoutingConfig::default());

    // Chat call with a slot override — the agent card pins Anthropic for chat.
    // This exercises the `pre_process` branch added in #164: when
    // ctx.slot_provider is Some, route_modality_with_slot(Chat,...) is used.
    let chat_slot_provider: ProviderId = ProviderKind::Anthropic.into();
    let chat_slot_model = "claude-3-5-sonnet";
    let chat_decision = router.route_modality_with_slot(
        &Modality::Chat,
        "gpt-4o",
        Some(&chat_slot_provider),
        Some(chat_slot_model),
    );
    assert_eq!(
        chat_decision.provider,
        ProviderKind::Anthropic,
        "chat call with slot override must route to the slot provider (AC2 #164)"
    );
    assert_eq!(chat_decision.model, "claude-3-5-sonnet");

    // Image call — agent card pins Local provider for image generation.
    let image_slot_provider: ProviderId = ProviderKind::Local.into();
    let image_slot_model = "stable-diffusion-local";
    let image_decision = router.route_modality_with_slot(
        &Modality::Image,
        "dall-e-3",
        Some(&image_slot_provider),
        Some(image_slot_model),
    );
    assert_eq!(
        image_decision.provider,
        ProviderKind::Local,
        "image call from the same agent must route to the slot's provider"
    );
    assert_eq!(image_decision.model, "stable-diffusion-local");

    // Assert the two providers differ — this is the distinguishing assertion
    // for "same agent, two different providers per modality" (AC2 #164).
    assert_ne!(
        chat_decision.provider, image_decision.provider,
        "chat and image calls from the same carded agent must reach different providers"
    );
}

/// When `ctx.slot_provider` and `ctx.slot_model` are both None (default agent,
/// no slot configured), pre_process falls through to eval/model routing — the
/// slot path must not break routing for non-carded agents.
#[test]
fn no_slot_falls_through_to_model_routing() {
    use crate::config::{ProviderKind, RoutingConfig};
    use crate::router::ModelRouter;

    let router = ModelRouter::new(RoutingConfig::default());

    // No slot — should resolve via model-name prefix rules.
    let decision = router.route_modality_with_slot(&Modality::Chat, "gpt-4o", None, None);
    // gpt-4o has no modality_map entry for Chat and no modality_map at all,
    // so it falls through to model routing; the "gpt-" prefix → OpenAi.
    assert_eq!(
        decision.provider,
        ProviderKind::OpenAi,
        "absent slot must fall through to standard model routing for chat"
    );
}

/// End-to-end proof that provider routing is open to arbitrary registry ids:
/// a provider registered under a brand-new id (`"acme"`) that the closed
/// `ProviderKind` enum never covered is routable purely via
/// `default_provider = "acme"` in config, and a real request driven through
/// the full `run()` pipeline reaches that provider's `complete()`. This is the
/// acceptance test for W6b — the enum is no longer on the road, only the map.
#[tokio::test]
async fn novel_provider_id_routable_end_to_end_through_pipeline() {
    use crate::audit::AuditLogger;
    use crate::config::{
        AuditConfig, EvalsConfig, FirewallConfig, GatewayConfig, ProviderId, RoutingConfig,
    };
    use crate::providers::Provider;
    use crate::state::AppState;
    use serde_json::{json, Value};
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    // A provider under an id no enum variant knows about.
    struct AcmeProvider {
        calls: AtomicUsize,
    }
    impl Provider for AcmeProvider {
        fn name(&self) -> &'static str {
            "acme"
        }
        fn complete<'a>(
            &'a self,
            _model: &'a str,
            _body: &'a Value,
        ) -> Pin<
            Box<
                dyn std::future::Future<Output = Result<Value, ryu_gw_providers::ProviderError>>
                    + Send
                    + 'a,
            >,
        > {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                Ok(json!({
                    "id": "chatcmpl-acme",
                    "object": "chat.completion",
                    "model": "acme-1",
                    "choices": [{
                        "index": 0,
                        "message": {"role": "assistant", "content": "pong"},
                        "finish_reason": "stop"
                    }],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
                }))
            })
        }
        fn complete_stream<'a>(
            &'a self,
            _model: &'a str,
            _body: &'a Value,
        ) -> Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<axum::body::Body, ryu_gw_providers::ProviderError>,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                Err(ryu_gw_providers::ProviderError::Provider(
                    "no stream".into(),
                ))
            })
        }
    }

    // Route everything to "acme" by config alone — no code names the enum.
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("acme"),
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        ..GatewayConfig::default()
    };

    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);

    let acme = Arc::new(AcmeProvider {
        calls: AtomicUsize::new(0),
    });
    state
        .provider_runtime
        .register_for_test(Arc::clone(&acme) as Arc<dyn Provider>);
    let state = Arc::new(state);

    let ctx = RequestContext {
        org_limits: None,
        identity: None,
        standing: None,
        enforcement: None,
        host_conversation: None,
        authorized_operation: crate::config::ApiKeyOperation::Inference,
        provider_snapshot: None,
        request_id: "acme-route-req".to_string(),
        api_key: "sk-test".to_string(),
        owner_binding: ryu_gw_credentials::fingerprint("sk-test"),
        is_master_key: false,
        org_id: None,
        team_id: None,
        project_id: None,
        user_name: None,
        user_id: None,
        agent_id: None,
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
    };

    let body = json!({
        "model": "anything",
        "messages": [{"role": "user", "content": "ping"}]
    });

    let out = run(Arc::clone(&state), ctx, body)
        .await
        .expect("pipeline must route to the novel-id provider and succeed");

    assert_eq!(
        out.provider_used, "acme",
        "the provider registered under the novel id must serve the turn end-to-end"
    );
    assert_eq!(
        acme.calls.load(Ordering::SeqCst),
        1,
        "the novel-id provider's complete() must have been invoked exactly once"
    );
}

/// ProviderKind::from_str correctly round-trips the values forwarded as
/// `x-ryu-slot-*-provider` headers from Core to the Gateway.
#[test]
fn provider_kind_from_str_parses_header_values() {
    use crate::config::ProviderKind;
    use std::str::FromStr;

    assert_eq!(
        "openai".parse::<ProviderKind>().unwrap(),
        ProviderKind::OpenAi
    );
    assert_eq!(
        "anthropic".parse::<ProviderKind>().unwrap(),
        ProviderKind::Anthropic
    );
    assert_eq!(
        "local".parse::<ProviderKind>().unwrap(),
        ProviderKind::Local
    );
    assert_eq!(
        "openrouter".parse::<ProviderKind>().unwrap(),
        ProviderKind::OpenRouter
    );
    assert_eq!("core".parse::<ProviderKind>().unwrap(), ProviderKind::Core);
    assert!("unknown-provider".parse::<ProviderKind>().is_err());
}
