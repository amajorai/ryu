//! Captured provider environment: credit-pool imports and closed native imports.
use super::provider_environment::ProviderEnvironment;
use super::{CompatibleProviderConfig, GatewayConfig};
use std::collections::BTreeMap;

fn environment(pairs: &[(&str, &str)]) -> ProviderEnvironment {
    ProviderEnvironment::from_values(
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect::<BTreeMap<_, _>>(),
    )
}

fn applied(pairs: &[(&str, &str)]) -> GatewayConfig {
    let mut config = GatewayConfig::default();
    environment(pairs)
        .apply(&mut config)
        .expect("apply captured environment");
    config
}

#[test]
fn cloudflare_token_and_account_build_the_workers_ai_url() {
    let config = applied(&[
        ("CLOUDFLARE_API_TOKEN", "cf-token"),
        ("CLOUDFLARE_ACCOUNT_ID", " acct-123 "),
        ("CLOUDFLARE_API_TOKENS", "cf-a, ,cf-b"),
    ]);
    let cloudflare = config.providers.cloudflare.expect("cloudflare slot");
    assert_eq!(cloudflare.api_key, "cf-token");
    assert_eq!(
        cloudflare.base_url,
        "https://api.cloudflare.com/client/v4/accounts/acct-123/ai/v1"
    );
    assert_eq!(cloudflare.api_keys, ["cf-a", "cf-b"]);
}

#[test]
fn cloudflare_without_account_or_base_url_stays_off() {
    let config = applied(&[("CLOUDFLARE_API_TOKEN", "cf-token")]);
    assert!(config.providers.cloudflare.is_none());
    let blank_account = applied(&[
        ("CLOUDFLARE_API_TOKEN", "cf-token"),
        ("CLOUDFLARE_ACCOUNT_ID", "  "),
    ]);
    assert!(blank_account.providers.cloudflare.is_none());
    let pinned = applied(&[
        ("CLOUDFLARE_API_TOKEN", "cf-token"),
        ("CLOUDFLARE_BASE_URL", "https://proxy.example/ai/v1"),
    ]);
    assert_eq!(
        pinned.providers.cloudflare.expect("pinned slot").base_url,
        "https://proxy.example/ai/v1"
    );
    let blank_token = applied(&[
        ("CLOUDFLARE_API_TOKEN", " "),
        ("CLOUDFLARE_ACCOUNT_ID", "acct-123"),
    ]);
    assert!(blank_token.providers.cloudflare.is_none());
}

#[test]
fn bedrock_token_and_region_build_the_mantle_url() {
    let config = applied(&[
        ("AWS_BEARER_TOKEN_BEDROCK", "bedrock-token"),
        ("AWS_REGION", "us-west-2"),
    ]);
    let bedrock = config.providers.bedrock.expect("bedrock slot");
    assert_eq!(bedrock.api_key, "bedrock-token");
    assert_eq!(
        bedrock.base_url,
        "https://bedrock-mantle.us-west-2.api.aws/anthropic"
    );
    assert!(applied(&[("AWS_BEARER_TOKEN_BEDROCK", "bedrock-token")])
        .providers
        .bedrock
        .is_none());
    let pinned = applied(&[
        ("AWS_BEARER_TOKEN_BEDROCK", "bedrock-token"),
        (
            "BEDROCK_BASE_URL",
            "https://bedrock.proxy.example/anthropic",
        ),
    ]);
    assert_eq!(
        pinned.providers.bedrock.expect("pinned slot").base_url,
        "https://bedrock.proxy.example/anthropic"
    );
}

#[test]
fn vertex_needs_project_and_location_unless_base_url_is_pinned() {
    let config = applied(&[
        ("VERTEX_API_KEY", "vertex-key"),
        ("VERTEX_PROJECT_ID", "proj-1"),
        ("VERTEX_LOCATION", "europe-west4"),
    ]);
    assert_eq!(
        config.providers.vertex.expect("vertex slot").base_url,
        "https://europe-west4-aiplatform.googleapis.com/v1/projects/proj-1/locations/europe-west4/endpoints/openapi"
    );
    for partial in [
        [
            ("VERTEX_API_KEY", "vertex-key"),
            ("VERTEX_PROJECT_ID", "proj-1"),
        ],
        [
            ("VERTEX_API_KEY", "vertex-key"),
            ("VERTEX_LOCATION", "europe-west4"),
        ],
    ] {
        assert!(applied(&partial).providers.vertex.is_none(), "{partial:?}");
    }
    let pinned = applied(&[
        ("VERTEX_API_KEY", "vertex-key"),
        (
            "VERTEX_BASE_URL",
            "https://aiplatform.googleapis.com/v1/openapi",
        ),
    ]);
    assert_eq!(
        pinned.providers.vertex.expect("pinned slot").base_url,
        "https://aiplatform.googleapis.com/v1/openapi"
    );
}

#[test]
fn credit_pool_keys_never_cross_into_byok_slots() {
    let credits_only = applied(&[
        ("OPENAI_CREDITS_API_KEY", "openai-donated"),
        ("ANTHROPIC_CREDITS_API_KEY", "anthropic-ryu"),
    ]);
    assert!(credits_only.providers.openai.is_none());
    assert!(credits_only.providers.anthropic.is_none());
    let openai_credits = credits_only.providers.openai_credits.expect("openai pool");
    assert_eq!(openai_credits.api_key, "openai-donated");
    assert_eq!(openai_credits.base_url, "https://api.openai.com/v1");
    let anthropic_credits = credits_only
        .providers
        .anthropic_credits
        .expect("anthropic pool");
    assert_eq!(anthropic_credits.api_key, "anthropic-ryu");
    assert_eq!(anthropic_credits.base_url, "https://api.anthropic.com");

    let byok_only = applied(&[
        ("OPENAI_API_KEY", "openai-byok"),
        ("ANTHROPIC_API_KEY", "anthropic-byok"),
    ]);
    assert!(byok_only.providers.openai_credits.is_none());
    assert!(byok_only.providers.anthropic_credits.is_none());
    assert_eq!(
        byok_only.providers.openai.expect("openai").api_key,
        "openai-byok"
    );
    assert_eq!(
        byok_only.providers.anthropic.expect("anthropic").api_key,
        "anthropic-byok"
    );
}

#[test]
fn runway_reads_only_its_canonical_key() {
    let config = applied(&[("RUNWAY_API_KEY", "runway-key")]);
    assert_eq!(
        config.providers.runway.expect("runway slot").api_key,
        "runway-key"
    );
    let legacy = applied(&[("RUNWAYML_API_SECRET", "runwayml-secret")]);
    assert!(legacy.providers.runway.is_none());
}

#[test]
fn env_openrouter_key_keeps_the_built_in_routing_defaults() {
    let config = applied(&[
        ("OPENROUTER_API_KEY", "or-key"),
        // Moved to gateway.toml: the env names are no longer read.
        ("OPENROUTER_SORT", "price"),
        ("OPENROUTER_SITE_NAME", "Env Name"),
        ("OPENROUTER_ZDR", "1"),
        ("OPENROUTER_USAGE_ACCOUNTING", "0"),
    ]);
    let openrouter = config.providers.openrouter.expect("openrouter slot");
    assert_eq!(openrouter.api_key, "or-key");
    assert_eq!(openrouter.site_url, "https://ryuhq.com");
    assert_eq!(openrouter.site_name, "Ryu");
    assert_eq!(openrouter.data_collection, "");
    assert!(!openrouter.zdr);
    assert_eq!(openrouter.sort, "");
    assert!(!openrouter.response_healing);
    assert!(openrouter.usage_accounting);
}

#[test]
fn env_openrouter_key_keeps_the_authored_toml_routing_settings() {
    let mut config: GatewayConfig = toml::from_str(
        r#"
[providers.openrouter]
api_key = ""
site_url = "https://example.com"
site_name = "Example"
data_collection = "deny"
zdr = true
sort = "throughput"
response_healing = true
usage_accounting = false
"#,
    )
    .expect("parse authored openrouter block");
    environment(&[("OPENROUTER_API_KEY", "or-key")])
        .apply(&mut config)
        .expect("apply captured environment");
    let openrouter = config.providers.openrouter.expect("openrouter slot");
    assert_eq!(openrouter.api_key, "or-key");
    assert_eq!(openrouter.site_url, "https://example.com");
    assert_eq!(openrouter.site_name, "Example");
    assert_eq!(openrouter.data_collection, "deny");
    assert!(openrouter.zdr);
    assert_eq!(openrouter.sort, "throughput");
    assert!(openrouter.response_healing);
    assert!(!openrouter.usage_accounting);
}

#[test]
fn openrouter_data_collection_env_still_overrides_the_toml_value() {
    let mut config: GatewayConfig =
        toml::from_str("[providers.openrouter]\napi_key = \"\"\ndata_collection = \"deny\"\n")
            .expect("parse authored openrouter block");
    environment(&[
        ("OPENROUTER_API_KEY", "or-key"),
        ("OPENROUTER_DATA_COLLECTION", "allow"),
    ])
    .apply(&mut config)
    .expect("apply captured environment");
    assert_eq!(
        config
            .providers
            .openrouter
            .expect("openrouter slot")
            .data_collection,
        "allow"
    );
}

fn compatible(key: &str) -> CompatibleProviderConfig {
    CompatibleProviderConfig {
        api_key: key.to_owned(),
        api_keys: Vec::new(),
        base_url: "https://authored.example/v1".to_owned(),
    }
}

#[test]
fn closed_direct_compatible_import_keeps_the_authored_entry() {
    let mut config = GatewayConfig::default();
    config
        .providers
        .compatible
        .insert("mistral".to_owned(), compatible("authored-mistral"));
    config
        .providers
        .environment_imports
        .insert("mistral".to_owned(), false);
    environment(&[
        ("MISTRAL_API_KEY", "env-mistral"),
        ("TOGETHER_API_KEY", "env-together"),
    ])
    .apply(&mut config)
    .expect("apply");
    let mistral = &config.providers.compatible["mistral"];
    assert_eq!(mistral.api_key, "authored-mistral");
    assert_eq!(mistral.base_url, "https://authored.example/v1");
    // An open scope still imports.
    assert_eq!(
        config.providers.compatible["together"].api_key,
        "env-together"
    );
}

#[test]
fn closed_direct_compatible_import_without_authored_entry_is_removed() {
    let mut config = GatewayConfig::default();
    config
        .providers
        .environment_imports
        .insert("mistral".to_owned(), false);
    environment(&[("MISTRAL_API_KEY", "env-mistral")])
        .apply(&mut config)
        .expect("apply");
    assert!(!config.providers.compatible.contains_key("mistral"));

    // An explicit `true` keeps the import open.
    let mut open = GatewayConfig::default();
    open.providers
        .environment_imports
        .insert("mistral".to_owned(), true);
    environment(&[("MISTRAL_API_KEY", "env-mistral")])
        .apply(&mut open)
        .expect("apply");
    assert_eq!(open.providers.compatible["mistral"].api_key, "env-mistral");
}

#[test]
fn closed_credit_pool_import_keeps_the_authored_slot() {
    let mut config = GatewayConfig::default();
    config
        .providers
        .environment_imports
        .insert("cloudflare".to_owned(), false);
    environment(&[
        ("CLOUDFLARE_API_TOKEN", "cf-token"),
        ("CLOUDFLARE_ACCOUNT_ID", "acct-123"),
    ])
    .apply(&mut config)
    .expect("apply");
    assert!(config.providers.cloudflare.is_none());
}

#[test]
fn unknown_environment_import_scope_is_rejected() {
    let mut config = GatewayConfig::default();
    config
        .providers
        .environment_imports
        .insert("not-a-provider".to_owned(), false);
    let error = environment(&[])
        .apply(&mut config)
        .expect_err("unknown scope must fail");
    assert_eq!(error, "Unknown native provider environment-import scope");
}

#[test]
fn native_sources_omit_closed_imports() {
    let captured = environment(&[
        ("MISTRAL_API_KEY", "env-mistral"),
        ("TOGETHER_API_KEY", "env-together"),
        ("RUNWAY_API_KEY", "runway-key"),
        ("CLOUDFLARE_API_TOKEN", "cf-token"),
    ]);
    let mut config = GatewayConfig::default();
    let open = captured.native_sources(&config.providers);
    for id in ["mistral", "together", "runway", "cloudflare"] {
        assert_eq!(open.get(id), Some(&"environment"), "{id}");
    }
    for id in ["mistral", "runway"] {
        config
            .providers
            .environment_imports
            .insert(id.to_owned(), false);
    }
    let closed = captured.native_sources(&config.providers);
    assert!(!closed.contains_key("mistral"));
    assert!(!closed.contains_key("runway"));
    assert_eq!(closed.get("together"), Some(&"environment"));
    assert_eq!(closed.get("cloudflare"), Some(&"environment"));
    assert!(!closed.contains_key("openai"));
}
