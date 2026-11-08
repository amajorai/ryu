/// Classify audit rows for the usage surface without treating every token
/// count as a credit debit. The provider id is the durable signal for the
/// donated managed slots; untagged vendor slots are the operator's own key.
pub(super) fn usage_source_for_provider(
    provider: &str,
    managed_inference: bool,
    managed_node: bool,
) -> &'static str {
    let base_provider = provider.split(':').next().unwrap_or(provider);
    if let Some(descriptor) = ryu_gw_credentials::sdk_provider_by_id(base_provider) {
        return if descriptor.auth_kind == ryu_gw_credentials::SdkAuthKind::NoAuth {
            "self_hosted"
        } else {
            "byok"
        };
    }
    match base_provider {
        "local" | "ollama" | "llamacpp" | "lmstudio" | "vllm" => "local",
        "openrouter" => {
            if managed_inference {
                "managed"
            } else {
                "byok"
            }
        }
        "openai" | "anthropic" | "genai" => "byok",
        "cloudflare" | "bedrock" | "vertex" | "openai-credits" | "anthropic-credits"
            if managed_inference || managed_node =>
        {
            "managed"
        }
        _ if managed_inference => "managed",
        _ => "self_hosted",
    }
}

/// Estimated spend in micro-USD for the given token totals at the configured
/// per-1k-token rate. Mirrors `pipeline::request_cost_micro_usd` so the audit's
/// surfaced cost matches the wallet debit + control-plane report exactly. Pure so
/// the rounding (`/ 1000`) is unit-testable.
pub(super) fn estimate_cost_micro_usd(
    input_tokens: u64,
    output_tokens: u64,
    per_1k_micro_usd: u64,
) -> u64 {
    input_tokens
        .saturating_add(output_tokens)
        .saturating_mul(per_1k_micro_usd)
        / 1000
}
