use super::{
    apply_credits_activation_env, parse_bool_env, CreditsConfig, FirewallPolicy, Modality,
    ModelRouterType, ProviderId, ProviderKind, RouteStrategy, SmartRoutingConfig, SmartRule,
    StagePicker,
};
use std::str::FromStr;

#[test]
fn provider_kind_as_str_covers_every_variant() {
    assert_eq!(ProviderKind::OpenAi.as_str(), "openai");
    assert_eq!(ProviderKind::Anthropic.as_str(), "anthropic");
    assert_eq!(ProviderKind::Local.as_str(), "local");
    assert_eq!(ProviderKind::OpenRouter.as_str(), "openrouter");
    assert_eq!(ProviderKind::Core.as_str(), "core");
    assert_eq!(ProviderKind::Modal.as_str(), "modal");
    assert_eq!(ProviderKind::GenAi.as_str(), "genai");
    assert_eq!(ProviderKind::Replicate.as_str(), "replicate");
    assert_eq!(ProviderKind::Fal.as_str(), "fal");
}

#[test]
fn provider_kind_from_str_roundtrips_and_is_case_insensitive() {
    for kind in [
        ProviderKind::OpenAi,
        ProviderKind::Anthropic,
        ProviderKind::Local,
        ProviderKind::OpenRouter,
        ProviderKind::Core,
        ProviderKind::Modal,
        ProviderKind::GenAi,
        ProviderKind::Replicate,
        ProviderKind::Fal,
    ] {
        assert_eq!(ProviderKind::from_str(kind.as_str()).unwrap(), kind);
    }
    // Case-insensitive.
    assert_eq!(
        ProviderKind::from_str("OpenAI").unwrap(),
        ProviderKind::OpenAi
    );
    // Unknown ids are a typed error naming the bad value.
    let err = ProviderKind::from_str("acme").unwrap_err();
    assert!(err.contains("acme"));
}

#[test]
fn provider_id_display_default_and_as_str() {
    assert_eq!(ProviderId::default().as_str(), "openai");
    let id = ProviderId::from("acme");
    assert_eq!(id.as_str(), "acme");
    assert_eq!(id.to_string(), "acme");
}

#[test]
fn modality_as_str_covers_every_variant() {
    assert_eq!(Modality::Chat.as_str(), "chat");
    assert_eq!(Modality::Image.as_str(), "image");
    assert_eq!(Modality::Tts.as_str(), "tts");
    assert_eq!(Modality::Stt.as_str(), "stt");
    assert_eq!(Modality::Video.as_str(), "video");
    assert_eq!(Modality::Audio.as_str(), "audio");
}

#[test]
fn smart_routing_is_active_gates_on_enabled_rules_and_strategy() {
    let rule = SmartRule {
        description: "code".to_string(),
        model: "claude".to_string(),
        weight: 1.0,
    };

    // Disabled ⇒ inert regardless of rules.
    let mut cfg = SmartRoutingConfig {
        enabled: false,
        rules: vec![rule.clone()],
        classifier_model: "gemma".to_string(),
        ..Default::default()
    };
    assert!(!cfg.is_active());

    // Enabled but no rules ⇒ inert.
    cfg.enabled = true;
    cfg.rules = vec![];
    assert!(!cfg.is_active());

    // Llm strategy needs a non-empty classifier model.
    cfg.rules = vec![rule.clone()];
    cfg.strategy = RouteStrategy::Llm;
    cfg.classifier_model = "  ".to_string();
    assert!(!cfg.is_active(), "blank classifier ⇒ Llm inert");
    cfg.classifier_model = "gemma".to_string();
    assert!(cfg.is_active());

    // Keyword / Embedding only need rules (no classifier).
    cfg.classifier_model = String::new();
    cfg.strategy = RouteStrategy::Keyword;
    assert!(cfg.is_active());
    cfg.strategy = RouteStrategy::Embedding;
    assert!(cfg.is_active());
}

#[test]
fn switchyard_router_types_are_active_only_with_their_required_targets() {
    let mut cfg = SmartRoutingConfig {
        enabled: true,
        router_type: ModelRouterType::Random,
        rules: vec![
            SmartRule {
                description: String::new(),
                model: "strong".into(),
                weight: 1.0,
            },
            SmartRule {
                description: String::new(),
                model: "weak".into(),
                weight: 3.0,
            },
        ],
        ..Default::default()
    };
    assert!(cfg.is_active());

    cfg.rules.pop();
    assert!(!cfg.is_active());
    cfg.rules.push(SmartRule {
        description: String::new(),
        model: "weak".into(),
        weight: 3.0,
    });
    assert!(cfg.is_active());

    cfg.router_type = ModelRouterType::Passthrough;
    assert!(cfg.is_active());

    cfg.router_type = ModelRouterType::StageRouter;
    cfg.stage_capable_model = "strong".into();
    cfg.stage_efficient_model = "weak".into();
    cfg.stage_picker = StagePicker::EfficientFirst;
    assert!(cfg.is_active());

    cfg.router_type = ModelRouterType::Escalation;
    cfg.escalation_weak_model = "weak".into();
    cfg.escalation_strong_model = "strong".into();
    cfg.escalation_judge_model = "judge".into();
    assert!(cfg.is_active());

    cfg.escalation_judge_model.clear();
    assert!(!cfg.is_active());
}

#[test]
fn old_smart_routing_json_defaults_to_llm_classifier_and_unit_weights() {
    let cfg: SmartRoutingConfig = serde_json::from_value(serde_json::json!({
        "enabled": true,
        "strategy": "keyword",
        "rules": [{"description": "code", "model": "strong"}]
    }))
    .expect("legacy smart routing JSON must parse");
    assert_eq!(cfg.router_type, ModelRouterType::LlmClassifier);
    assert_eq!(cfg.rules[0].weight, 1.0);
    assert_eq!(cfg.stage_picker, StagePicker::CapableFirst);
}

/// REGRESSION: a per-agent smart-routing override saved with the classifier
/// box left empty used to save as "on" and be inert — and worse than inert,
/// because `pipeline::apply_smart_routing` treats a per-agent override as
/// present the moment the agent has one, takes its early return, and skips
/// the GLOBAL smart router that would otherwise have run. Turning the feature
/// on actively DISABLED routing.
///
/// This must go through serde, not field assignment. The sibling test above
/// sets `classifier_model` in Rust, which bypasses `de_classifier_model`
/// entirely — it would keep passing after the fix while proving nothing about
/// any wire path, the same structural blindness the credits round-trip test
/// has. The desktop editor and `PUT /v1/config` both send an explicit `""`.
#[test]
fn smart_routing_saved_with_a_blank_classifier_deserializes_to_a_working_one() {
    // The wire shape an operator produces by clearing the model box.
    let from_wire: SmartRoutingConfig = serde_json::from_value(serde_json::json!({
        "enabled": true,
        "strategy": "llm",
        "classifier_model": "",
        "rules": [{ "description": "code", "model": "claude" }],
    }))
    .expect("an explicit empty classifier must still parse");
    assert!(
        !from_wire.classifier_model.trim().is_empty(),
        "a blank classifier must resolve to the classify tier, not stay blank"
    );
    assert_eq!(from_wire.classifier_model, super::classify_model_id());
    assert!(
        from_wire.is_active(),
        "enabled + rules must mean routing actually runs"
    );

    // An ABSENT key takes the same value — the `default = \"fn\"` half of the
    // pair. One without the other leaves half the hole open.
    let absent: SmartRoutingConfig = serde_json::from_value(serde_json::json!({
        "enabled": true,
        "rules": [{ "description": "code", "model": "claude" }],
    }))
    .expect("an absent classifier must parse");
    assert_eq!(absent.classifier_model, from_wire.classifier_model);

    // And `Default` agrees, so a config built in Rust cannot drift from one
    // read off the wire.
    assert_eq!(
        SmartRoutingConfig::default().classifier_model,
        from_wire.classifier_model
    );

    // An operator's own pick is still honored untouched.
    let explicit: SmartRoutingConfig = serde_json::from_value(serde_json::json!({
        "enabled": true,
        "classifier_model": "openrouter/google/gemini-2.5-flash",
        "rules": [{ "description": "code", "model": "claude" }],
    }))
    .expect("parses");
    assert_eq!(
        explicit.classifier_model,
        "openrouter/google/gemini-2.5-flash"
    );
}

#[test]
fn firewall_policy_from_env_accepts_aliases_and_rejects_junk() {
    assert_eq!(
        FirewallPolicy::from_env("block"),
        Some(FirewallPolicy::Block)
    );
    assert_eq!(
        FirewallPolicy::from_env(" WARN "),
        Some(FirewallPolicy::WarnAndContinue)
    );
    assert_eq!(
        FirewallPolicy::from_env("warn-and-continue"),
        Some(FirewallPolicy::WarnAndContinue)
    );
    assert_eq!(
        FirewallPolicy::from_env("redact"),
        Some(FirewallPolicy::Sanitize)
    );
    assert_eq!(FirewallPolicy::from_env("nonsense"), None);
}

#[test]
fn parse_bool_env_accepts_truthy_falsey_and_rejects_junk() {
    for t in ["1", "true", "YES", "on"] {
        assert_eq!(parse_bool_env(t), Some(true), "{t}");
    }
    for f in ["0", "false", "No", "off"] {
        assert_eq!(parse_bool_env(f), Some(false), "{f}");
    }
    assert_eq!(parse_bool_env("maybe"), None);
}

fn env_of<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
    move |name| {
        pairs
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| (*value).to_owned())
    }
}

#[test]
fn flat_rate_metering_warning_fires_only_for_an_unpriced_metering_node() {
    let mut config = super::GatewayConfig::default();
    assert_eq!(config.flat_rate_metering_warning(), None, "not metering");
    config.credits.enabled = true;
    config.credits.base_url = "https://control.example".into();
    config.credits.internal_secret = Some("secret".into());
    assert!(config
        .flat_rate_metering_warning()
        .is_some_and(|warning| warning.contains("2000 micro-USD per 1k")));
    config.control_plane.model_pricing.insert(
        "gpt-5".into(),
        super::ModelPrice {
            input_per_1k_micro_usd: 1_250,
            output_per_1k_micro_usd: 10_000,
        },
    );
    assert_eq!(config.flat_rate_metering_warning(), None, "priced");
}

/// A managed node whose internal secret arrives only through the
/// environment must auto-enable metering, exactly like a TOML secret.
#[test]
fn env_only_internal_secret_auto_enables_credits() {
    let mut credits = CreditsConfig::default();
    apply_credits_activation_env(
        &mut credits,
        env_of(&[
            ("RYU_CREDITS_INTERNAL_SECRET", "managed-secret"),
            ("GATEWAY_CREDITS_URL", "https://control.example"),
        ]),
    );
    assert!(credits.enabled);
    assert_eq!(credits.internal_secret.as_deref(), Some("managed-secret"));
    assert_eq!(credits.base_url, "https://control.example");
    assert!(credits.is_active());
}

#[test]
fn credits_activation_env_keeps_explicit_switch_and_self_hosted_default() {
    // An explicit GATEWAY_CREDITS_ENABLED=0 still un-meters a managed node.
    let mut opted_out = CreditsConfig::default();
    apply_credits_activation_env(
        &mut opted_out,
        env_of(&[
            ("RYU_CREDITS_INTERNAL_SECRET", "managed-secret"),
            ("GATEWAY_CREDITS_ENABLED", "0"),
        ]),
    );
    assert!(!opted_out.enabled);

    // No secret anywhere: a self-hosted node stays free.
    let mut self_hosted = CreditsConfig::default();
    apply_credits_activation_env(
        &mut self_hosted,
        env_of(&[("RYU_CREDITS_INTERNAL_SECRET", "   ")]),
    );
    assert!(!self_hosted.enabled);
    assert_eq!(self_hosted.internal_secret, None);

    // A TOML secret with no env still auto-enables.
    let mut toml_secret = CreditsConfig {
        internal_secret: Some("toml-secret".into()),
        ..CreditsConfig::default()
    };
    apply_credits_activation_env(&mut toml_secret, env_of(&[]));
    assert!(toml_secret.enabled);
}
