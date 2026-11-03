//! `gateway.toml` parsing and the derived values `load()` adds on top of it.
use super::{GatewayConfig, ModelMapping, ProviderId, CLASSIFY_PROVIDER_ID};

#[test]
fn authored_plaintext_parses_without_a_seal_key() {
    let config = GatewayConfig::from_authored_str("bind = \"127.0.0.1:1234\"\n").unwrap();
    assert_eq!(config.bind, "127.0.0.1:1234");
}

#[test]
fn authored_text_that_is_not_toml_is_an_error() {
    assert!(GatewayConfig::from_authored_str("bind = [unterminated").is_err());
}

#[test]
fn an_untouched_classify_seed_is_stripped_and_a_rewritten_one_is_kept() {
    let seeded = |provider_model: Option<&str>| {
        let mut config = GatewayConfig::default();
        config.routing.model_map.insert(
            "judge".to_owned(),
            ModelMapping {
                provider: ProviderId::from(CLASSIFY_PROVIDER_ID),
                provider_model: provider_model.map(str::to_owned),
            },
        );
        config.seeded_classify_model = Some("judge".to_owned());
        config
    };

    let clean = seeded(None).without_derived_values();
    assert!(!clean.routing.model_map.contains_key("judge"));
    assert!(clean.seeded_classify_model.is_none());

    let mut rewritten = seeded(Some("operator-choice"));
    rewritten.strip_seeded_classify_route();
    assert!(rewritten.routing.model_map.contains_key("judge"));
}

#[test]
fn the_flat_rate_warning_needs_active_credits_and_an_empty_price_table() {
    let config = GatewayConfig::default();
    assert!(!config.credits.is_active());
    assert_eq!(config.flat_rate_metering_warning(), None);
}
