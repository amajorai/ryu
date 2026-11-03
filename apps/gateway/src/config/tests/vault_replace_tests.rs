//! Replacing every provider credential from a successful fleet vault read.
use super::{GatewayConfig, OpenAiProviderConfig, ProviderEnvironment};
use std::collections::{BTreeMap, HashMap};

fn environment(pairs: &[(&str, &str)]) -> ProviderEnvironment {
    ProviderEnvironment::from_values(
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect::<BTreeMap<_, _>>(),
    )
}

fn keys(names: &[&str]) -> HashMap<String, String> {
    names
        .iter()
        .map(|name| ((*name).to_owned(), format!("vault-{name}")))
        .collect()
}

#[test]
fn a_provider_the_vault_omits_loses_its_stale_credential() {
    let mut config = GatewayConfig::default();
    config.providers.openai = Some(OpenAiProviderConfig {
        api_key: "stale-openai".to_owned(), // Test vector, not a credential. gitleaks:allow skipcq
        api_keys: vec!["stale-extra".to_owned()],
        base_url: "https://openai.example/v1".to_owned(),
    });
    config.composio.api_key = Some("stale-composio".to_owned());
    config.composio.enabled = true;
    config.treg.token = Some("stale-treg".to_owned());
    config.treg.enabled = true;

    let applied = config
        .replace_provider_vault_keys_with_environment(&keys(&["anthropic"]), &environment(&[]));

    assert_eq!(applied, ["anthropic"]);
    assert!(config.providers.openai.is_none());
    assert_eq!(
        config.providers.anthropic.unwrap().api_key,
        "vault-anthropic"
    );
    assert!(config.composio.api_key.is_none() && !config.composio.enabled);
    assert!(config.treg.token.is_none() && !config.treg.enabled);
}

#[test]
fn a_provider_the_vault_supplies_keeps_its_base_url() {
    let mut config = GatewayConfig::default();
    config.providers.openai = Some(OpenAiProviderConfig {
        api_key: "stale-openai".to_owned(),
        api_keys: Vec::new(),
        base_url: "https://openai.example/v1".to_owned(),
    });
    config.replace_provider_vault_keys_with_environment(&keys(&["openai"]), &environment(&[]));
    let openai = config.providers.openai.unwrap();
    assert_eq!(openai.api_key, "vault-openai");
    assert_eq!(openai.base_url, "https://openai.example/v1");
}
