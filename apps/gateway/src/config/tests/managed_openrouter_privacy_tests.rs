use super::{
    apply_managed_openrouter_privacy_default, openrouter_base_url, GatewayConfig,
    OpenRouterProviderConfig,
};

fn config_with_openrouter(data_collection: &str, managed: bool) -> GatewayConfig {
    let mut config = GatewayConfig::default();
    config.credits.internal_secret = managed.then(|| "managed-secret".to_owned());
    config.providers.openrouter = Some(OpenRouterProviderConfig {
        api_key: "sk-or-test".to_owned(),
        api_keys: Vec::new(),
        base_url: openrouter_base_url(),
        site_url: String::new(),
        site_name: String::new(),
        data_collection: data_collection.to_owned(),
        zdr: false,
        sort: String::new(),
        response_healing: false,
        usage_accounting: true,
        org_api_keys: std::collections::HashMap::new(),
    });
    config
}

fn data_collection(config: &GatewayConfig) -> &str {
    &config
        .providers
        .openrouter
        .as_ref()
        .unwrap()
        .data_collection
}

#[test]
fn managed_node_denies_data_collection_by_default() {
    let mut config = config_with_openrouter("", true);
    apply_managed_openrouter_privacy_default(&mut config, false);
    assert_eq!(data_collection(&config), "deny");
}

#[test]
fn self_hosted_node_keeps_upstream_default() {
    let mut config = config_with_openrouter("", false);
    apply_managed_openrouter_privacy_default(&mut config, false);
    assert_eq!(data_collection(&config), "");
}

#[test]
fn explicit_operator_policy_wins_on_managed_nodes() {
    let mut from_env = config_with_openrouter("", true);
    apply_managed_openrouter_privacy_default(&mut from_env, true);
    assert_eq!(data_collection(&from_env), "");

    let mut from_toml = config_with_openrouter("allow", true);
    apply_managed_openrouter_privacy_default(&mut from_toml, false);
    assert_eq!(data_collection(&from_toml), "allow");
}
