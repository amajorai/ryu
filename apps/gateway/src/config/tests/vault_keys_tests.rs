//! Fleet vault-key overlay: every provider slot it fills, in a stable order.
use super::{GatewayConfig, ProviderEnvironment};
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

/// The order the overlay reports applied providers in. `keys` is a hash map,
/// so this order comes from the overlay itself and must not depend on it.
const OVERLAY_ORDER: [&str; 19] = [
    "openai",
    "anthropic",
    "openrouter",
    "replicate",
    "bfl",
    "stability",
    "runway",
    "topaz",
    "minimax",
    "recraft",
    "fal",
    "cloudflare",
    "bedrock",
    "vertex",
    "openai_credits",
    "anthropic_credits",
    "composio",
    "treg",
    "modal",
];

#[test]
fn every_vault_key_applies_in_the_overlay_order() {
    let environment = environment(&[
        ("CLOUDFLARE_ACCOUNT_ID", "acct"),
        ("AWS_REGION", "us-east-1"),
        ("VERTEX_PROJECT_ID", "proj"),
        ("VERTEX_LOCATION", "europe-west4"),
        ("MODAL_BASE_URL", "https://modal.example/v1"),
    ]);
    let mut config = GatewayConfig::default();
    let applied =
        config.apply_provider_vault_keys_with_environment(&keys(&OVERLAY_ORDER), &environment);
    assert_eq!(applied, OVERLAY_ORDER);
    let openai = config.providers.openai.as_ref().expect("openai slot");
    assert_eq!(openai.api_key, "vault-openai");
    assert!(openai.api_keys.is_empty());
    let fal = config.providers.fal.as_ref().expect("fal slot");
    assert_eq!(fal.api_key, "vault-fal");
    assert_eq!(config.treg.token.as_deref(), Some("vault-treg"));
    assert!(config.composio.enabled);
}

#[test]
fn a_vault_openrouter_key_gets_the_managed_privacy_default() {
    let mut config = GatewayConfig::default();
    config.apply_provider_vault_keys_with_environment(&keys(&["openrouter"]), &environment(&[]));
    let openrouter = config.providers.openrouter.expect("openrouter slot");
    assert_eq!(openrouter.api_key, "vault-openrouter");
    if std::env::var_os("OPENROUTER_DATA_COLLECTION").is_none() {
        assert_eq!(openrouter.data_collection, "deny");
    }
}

#[test]
fn blank_and_unknown_vault_keys_apply_nothing() {
    let mut config = GatewayConfig::default();
    let blank = HashMap::from([
        ("openai".to_owned(), "  ".to_owned()),
        ("not-a-provider".to_owned(), "key".to_owned()),
    ]);
    let applied = config.apply_provider_vault_keys_with_environment(&blank, &environment(&[]));
    assert!(applied.is_empty());
    assert!(config.providers.openai.is_none());
}
