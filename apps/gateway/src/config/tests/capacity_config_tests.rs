use super::{ControlPlaneConfig, ModelPrice, OpenAiProviderConfig};
use std::collections::HashMap;

#[test]
fn all_keys_falls_back_to_single_key() {
    let c = OpenAiProviderConfig {
        api_key: "sk-primary".into(),
        api_keys: vec![],
        base_url: super::openai_base_url(),
    };
    assert_eq!(c.all_keys(), vec!["sk-primary".to_string()]);
}

#[test]
fn all_keys_merges_and_dedupes() {
    let c = OpenAiProviderConfig {
        api_key: "sk-a".into(),
        api_keys: vec!["sk-b".into(), "sk-a".into(), "".into()],
        base_url: super::openai_base_url(),
    };
    // Primary first, extras appended, dupes + blanks dropped.
    assert_eq!(c.all_keys(), vec!["sk-a".to_string(), "sk-b".to_string()]);
}

#[test]
fn cost_for_uses_flat_rate_without_a_price_table() {
    let cp = ControlPlaneConfig::default(); // 2000 micro-USD / 1k combined
                                            // 500 in + 500 out = 1000 tokens ⇒ 2000 micro-USD.
    assert_eq!(cp.cost_for("gpt-4o", 500, 500), 2000);
}

#[test]
fn cost_for_prefers_per_model_prefix_pricing() {
    let mut pricing = HashMap::new();
    pricing.insert(
        "claude-sonnet".to_string(),
        ModelPrice {
            input_per_1k_micro_usd: 3000,
            output_per_1k_micro_usd: 15000,
        },
    );
    let cp = ControlPlaneConfig {
        model_pricing: pricing,
        ..Default::default()
    };
    // Longest-prefix match on the versioned id: 1k in (3000) + 1k out (15000).
    assert_eq!(cp.cost_for("claude-sonnet-4-5-20250929", 1000, 1000), 18000);
    // An unpriced model falls back to the flat 2000/1k rate.
    assert_eq!(cp.cost_for("gpt-4o", 1000, 0), 2000);
}
