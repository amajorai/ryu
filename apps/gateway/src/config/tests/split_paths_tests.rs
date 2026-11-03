//! The config is split into responsibility modules under `config/`. Every item
//! must still be the one `crate::config::` exposes, so callers outside the
//! module never see the split. Each check names the owning submodule and the
//! root path and requires them to be the same item.
use super::*;

/// Compiles only when both arguments have the same type.
fn same<T>(_: &T, _: &T) {}

/// Channel env readers whose channel prefix is not set in any test process.
const UNSET_PLATFORM: &str = "RYU_SPLIT_PATHS_TEST_UNSET";

#[test]
fn root_and_submodule_paths_name_the_same_config_types() {
    let root = crate::config::GatewayConfig::default();
    same(&gateway::GatewayConfig::default(), &root);
    same(
        &prompt_cache::PromptCacheConfig::default(),
        &root.prompt_cache,
    );
    same(
        &prompt_cache::NodeRoutingConfig::default(),
        &root.node_routing,
    );
    same(
        &stage_backends::StageBackendsConfig::default(),
        &crate::config::StageBackendsConfig::default(),
    );
    same(&credits::CreditsConfig::default(), &root.credits);
    same(&tools::ToolsConfig::default(), &root.tools);
    same(&tools::CompressionConfig::default(), &root.compression);
    same(
        &control_plane::ControlPlaneConfig::default(),
        &root.control_plane,
    );
    same(&egress::EgressConfig::default(), &root.egress);
    same(&providers::ProvidersConfig::default(), &root.providers);
    same(&routing::RoutingConfig::default(), &root.routing);
    same(&firewall::FirewallConfig::default(), &root.firewall);
    same(&auth::AuthConfig::default(), &root.auth);
    same(&auth::RateLimitConfig::default(), &root.rate_limit);
    same(&integrations::ComposioConfig::default(), &root.composio);
    same(&integrations::TregConfig::default(), &root.treg);
    same(&phone_calls::ChannelsConfig::default(), &root.channels);
    same(&services::ConcurrencyConfig::default(), &root.concurrency);
}

#[test]
fn the_default_gateway_config_takes_each_submodule_default() {
    let root = crate::config::GatewayConfig::default();
    assert_eq!(
        root.prompt_cache,
        prompt_cache::PromptCacheConfig::default()
    );
    assert_eq!(
        root.firewall.inspector,
        inspector::InspectorConfig::default()
    );
    assert_eq!(
        root.routing.smart_routing.timeout_ms,
        smart_routing::SmartRoutingConfig::default().timeout_ms
    );
    assert_eq!(
        root.credits.sandbox_size_rates,
        sandbox::default_sandbox_size_rates()
    );
    assert_eq!(root.bind, gateway::default_bind());
}

#[test]
fn provider_slot_types_stay_reachable_from_the_root() {
    let providers = crate::config::ProvidersConfig::default();
    assert!(provider_llm::openai_base_url().starts_with("https://"));
    if let Some(openai) = providers.openai.as_ref() {
        same::<provider_llm::OpenAiProviderConfig>(openai, openai);
    }
    if let Some(runway) = providers.runway.as_ref() {
        same::<provider_media::RunwayProviderConfig>(runway, runway);
    }
    if let Some(openrouter) = providers.openrouter.as_ref() {
        same::<hosted_providers::OpenRouterProviderConfig>(openrouter, openrouter);
    }
    if let Some(local) = providers.local.as_ref() {
        same::<local_providers::LocalProviderConfig>(local, local);
    }
    assert_eq!(
        provider_id::ProviderId::from("openai"),
        crate::config::ProviderId::from(provider_id::ProviderKind::OpenAi)
    );
}

#[test]
fn moved_pure_helpers_keep_their_behaviour() {
    assert_eq!(env_vars::parse_bool_env(" Yes "), Some(true));
    assert_eq!(env_vars::parse_bool_env("off"), Some(false));
    assert_eq!(env_vars::parse_bool_env("maybe"), None);
    assert!(routing_rules::glob_matches("gpt-*", "GPT-4o"));
    assert!(!routing_rules::glob_matches("gpt-*", "claude"));
    assert_eq!(sandbox::box_billable_seconds(1, false), 60);
    assert_eq!(sandbox::box_billable_seconds(1, true), 300);
    assert!(phone_calls::valid_e164("+14155550123"));
    assert!(!phone_calls::valid_e164("14155550123"));
    assert_eq!(channels_env::channel_env(UNSET_PLATFORM, "TOKEN"), None);
    assert_eq!(
        channels::default_telegram_webhook_path(),
        default_telegram_webhook_path()
    );
    assert_eq!(
        channel_platforms::default_whatsapp_path(),
        default_whatsapp_path()
    );
}

#[test]
fn the_loader_steps_keep_one_signature() {
    let steps: [fn(&mut GatewayConfig); 4] = [
        load::load_service_env,
        load_channels::load_channel_env,
        load_runtime::load_runtime_env,
        load_runtime::load_credits_env,
    ];
    assert_eq!(steps.len(), 4);
    let auth: fn(&mut GatewayConfig) -> anyhow::Result<()> = load::load_auth_env;
    let _ = auth;
}
