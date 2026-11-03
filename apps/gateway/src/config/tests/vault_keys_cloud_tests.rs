//! Vault keys for providers that also need a deployment base URL.
use super::{GatewayConfig, ProviderEnvironment, VercelProviderConfig};
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
fn a_cloud_key_without_a_base_url_leaves_the_provider_off() {
    let mut config = GatewayConfig::default();
    let applied = config.apply_provider_vault_keys_with_environment(
        &keys(&["cloudflare", "bedrock", "vertex", "modal"]),
        &environment(&[]),
    );
    assert!(applied.is_empty(), "{applied:?}");
    assert!(config.providers.cloudflare.is_none());
    assert!(config.providers.bedrock.is_none());
    assert!(config.providers.vertex.is_none());
    assert!(config.providers.modal.is_none());
}

#[test]
fn cloud_base_urls_come_from_the_captured_environment() {
    let mut config = GatewayConfig::default();
    config.apply_provider_vault_keys_with_environment(
        &keys(&["cloudflare", "bedrock", "vertex"]),
        &environment(&[
            ("CLOUDFLARE_ACCOUNT_ID", " acct "),
            ("AWS_REGION", "eu-west-1"),
            ("VERTEX_PROJECT_ID", "proj"),
            ("VERTEX_LOCATION", "us-central1"),
        ]),
    );
    assert_eq!(
        config.providers.cloudflare.unwrap().base_url,
        "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1"
    );
    assert_eq!(
        config.providers.bedrock.unwrap().base_url,
        "https://bedrock-mantle.eu-west-1.api.aws/anthropic"
    );
    assert_eq!(
        config.providers.vertex.unwrap().base_url,
        "https://us-central1-aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/endpoints/openapi"
    );
}

#[test]
fn a_vercel_key_fills_only_an_authored_lane() {
    let mut config = GatewayConfig::default();
    let applied =
        config.apply_provider_vault_keys_with_environment(&keys(&["vercel"]), &environment(&[]));
    assert!(applied.is_empty());
    assert!(config.providers.vercel.is_none());

    config.providers.vercel = Some(VercelProviderConfig {
        api_key: "stale".to_owned(), // Test vector, not a credential. gitleaks:allow skipcq
        api_keys: vec!["stale-extra".to_owned()],
        base_url: "https://vercel.example/v1".to_owned(),
        messages_base_url: "https://vercel.example/v1/messages".to_owned(),
        resale_permission: Some("recorded".to_owned()),
    });
    let applied =
        config.apply_provider_vault_keys_with_environment(&keys(&["vercel"]), &environment(&[]));
    assert_eq!(applied, ["vercel"]);
    let vercel = config.providers.vercel.unwrap();
    assert_eq!(vercel.api_key, "vault-vercel");
    assert!(vercel.api_keys.is_empty());
}
