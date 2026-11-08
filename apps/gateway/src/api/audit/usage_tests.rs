//! Pure usage-cost helpers behind the audit usage surface.

use super::usage_cost::{estimate_cost_micro_usd, usage_source_for_provider};

#[test]
fn cost_estimate_matches_pipeline_rounding() {
    // 1000 in + 0 out at $0.002/1k = 2000 micro-USD.
    assert_eq!(estimate_cost_micro_usd(1000, 0, 2000), 2000);
    // Split across input/output is the same as the combined total.
    assert_eq!(estimate_cost_micro_usd(500, 500, 2000), 2000);
    // Multiply-then-divide matches the wallet debit: 1 token * 2000 / 1000 = 2.
    assert_eq!(estimate_cost_micro_usd(1, 0, 2000), 2);
    assert_eq!(estimate_cost_micro_usd(1500, 0, 2000), 3000);
    // Tiny token counts can round to 0 when the rate is sub-1k per token.
    assert_eq!(estimate_cost_micro_usd(1, 0, 1), 0);
    // A zero rate (cost attribution disabled) yields zero here; the endpoint
    // maps a zero RATE to `null`, not this function.
    assert_eq!(estimate_cost_micro_usd(1000, 1000, 0), 0);
}

#[test]
fn usage_source_keeps_non_credit_traffic_distinct() {
    assert_eq!(usage_source_for_provider("genai-groq", false, true), "byok");
    assert_eq!(
        usage_source_for_provider("genai-vertex", false, true),
        "byok"
    );
    assert_eq!(
        usage_source_for_provider("genai-ollama", false, true),
        "self_hosted"
    );
    assert_eq!(
        usage_source_for_provider("genai-unknown", false, false),
        "self_hosted"
    );
    assert_eq!(usage_source_for_provider("local", false, true), "local");
    assert_eq!(usage_source_for_provider("ollama", false, true), "local");
    assert_eq!(usage_source_for_provider("openai", false, true), "byok");
    assert_eq!(
        usage_source_for_provider("openai-credits", false, true),
        "managed"
    );
    assert_eq!(
        usage_source_for_provider("openrouter", true, true),
        "managed"
    );
    assert_eq!(usage_source_for_provider("openrouter", false, true), "byok");
    assert_eq!(
        usage_source_for_provider("openrouter:embedding", true, true),
        "managed"
    );
    assert_eq!(
        usage_source_for_provider("custom-provider", false, false),
        "self_hosted"
    );
}
