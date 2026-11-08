//! Ryu's own-supply credit-pool slots (Cloudflare, Bedrock, Vertex, the donated
//! OpenAI allowance, Ryu's Anthropic account and Ryu's Azure account).

use super::*;

pub(super) fn register(registry: &mut ProviderRegistry, build: &RegistryBuild<'_>) {
    let RegistryBuild {
        config,
        egress,
        quota,
        client,
        ..
    } = *build;
    // The SEGREGATED credit-pool supplies (see [`crate::credit_pools`]).
    // Registered AFTER `classify` for the same reason `classify` is last:
    // `available_providers()` order drives the /v1/models discovery-merge
    // precedence, so appending leaves every existing provider's precedence
    // byte-identical. Both are absent-when-unconfigured like every other
    // built-in â€” an untagged deploy simply lacks the id.
    //
    // KNOWN, DELIBERATE ALIAS DEFECT: `AliasedProvider` overrides `name()`
    // for the pipeline's keying (metrics, admission slots, circuit breaker),
    // but the quota sink is written from a literal INSIDE each impl
    // (`openai.rs` records `"openai"`, `anthropic.rs` records `"anthropic"`).
    // So an aliased Cloudflare 429 books against `openai` and an aliased
    // Bedrock 429 against `anthropic` in `/metrics.provider_quota`. Nothing
    // routes on that snapshot today, so this is observability, not
    // correctness â€” but "which pool is rate-limited" is exactly the signal a
    // segregated-pool operator will eventually want, and closing it means
    // threading a label parameter through `ryu-gw-providers`.
    if let Some(c) = config.cloudflare.as_ref() {
        // Cloudflare Workers AI exposes an OpenAI-compatible surface at
        // `{account}/ai/v1/chat/completions` with bearer auth â€” byte-for-byte
        // what `OpenAiProvider` already sends, so it needs no impl.
        registry.register_as(
            CLOUDFLARE_PROVIDER_ID,
            Arc::new(OpenAiProvider::new_named_with_egress(
                CLOUDFLARE_PROVIDER_ID,
                client.clone(),
                egress.and_then(|pool| pool.assigned(CLOUDFLARE_PROVIDER_ID)),
                c.all_keys(),
                c.base_url.clone(),
                Arc::clone(&quota),
            )),
        );
    }

    if let Some(c) = config.bedrock.as_ref() {
        // Bedrock rides ANTHROPIC MESSAGES, not the OpenAI dialect, and this
        // is not a style preference: Bedrock does serve
        // `/v1/chat/completions`, but its per-model compatibility matrix
        // marks Chat Completions unsupported for EVERY Claude model (that
        // surface exists for `openai.gpt-oss-*`). Claude there is
        // Invoke/Converse/Messages only. `AnthropicProvider` already sends
        // `{base}/v1/messages` with `anthropic-version: 2023-06-01` and the
        // model id in the body, which is exactly Bedrock's Messages contract.
        // Do NOT "simplify" both pools onto one OpenAI-compatible alias.
        registry.register_as(
            BEDROCK_PROVIDER_ID,
            Arc::new(AnthropicProvider::new_named_with_egress(
                BEDROCK_PROVIDER_ID,
                client.clone(),
                egress.and_then(|pool| pool.assigned(BEDROCK_PROVIDER_ID)),
                c.all_keys(),
                c.base_url.clone(),
                Arc::clone(&quota),
            )),
        );
    }

    if let Some(c) = config.vertex.as_ref() {
        // Vertex AI serves an OpenAI-compatible Chat Completions surface at
        // `{project/location endpoint}/openapi/chat/completions` with bearer
        // auth, so â€” unlike Bedrock â€” it genuinely needs no impl of its own.
        // The base URL stops at `/endpoints/openapi`; `OpenAiProvider`
        // appends `/chat/completions`.
        registry.register_as(
            VERTEX_PROVIDER_ID,
            Arc::new(OpenAiProvider::new_named_with_egress(
                VERTEX_PROVIDER_ID,
                client.clone(),
                egress.and_then(|pool| pool.assigned(VERTEX_PROVIDER_ID)),
                c.all_keys(),
                c.base_url.clone(),
                Arc::clone(&quota),
            )),
        );
    }

    if let Some(c) = config.openai_credits.as_ref() {
        // Same impl and the same endpoint as the `openai` slot above â€” the
        // ONLY thing that differs is whose key it holds, and that is precisely
        // why it must be its own registry id. `AliasedProvider` is what keeps
        // them apart. The named adapter also keeps account quota/error
        // attribution separate from the BYOK OpenAI slot.
        registry.register_as(
            OPENAI_CREDITS_PROVIDER_ID,
            Arc::new(OpenAiProvider::new_named_with_egress(
                OPENAI_CREDITS_PROVIDER_ID,
                client.clone(),
                egress.and_then(|pool| pool.assigned(OPENAI_CREDITS_PROVIDER_ID)),
                c.all_keys(),
                c.base_url.clone(),
                Arc::clone(&quota),
            )),
        );
    }

    if let Some(c) = config.anthropic_credits.as_ref() {
        // Ryu's own Anthropic account: same impl and endpoint as the BYOK
        // `anthropic` slot, registered under its own id so the debit site can
        // attribute its spend to the `anthropic-credits` pool.
        registry.register_as(
            ANTHROPIC_CREDITS_PROVIDER_ID,
            Arc::new(AnthropicProvider::new_named_with_egress(
                ANTHROPIC_CREDITS_PROVIDER_ID,
                client.clone(),
                egress.and_then(|pool| pool.assigned(ANTHROPIC_CREDITS_PROVIDER_ID)),
                c.all_keys(),
                c.base_url.clone(),
                Arc::clone(&quota),
            )),
        );
    }

    if let Some(c) = config.azure_credits.as_ref() {
        // Ryu's Azure account (Azure OpenAI / AI Foundry). The v1 surface at
        // `https://<resource>.openai.azure.com/openai/v1` is OpenAI-compatible
        // and takes the resource key as a bearer token, so `OpenAiProvider`
        // appends `/chat/completions` and needs no Azure impl. Upstream model
        // ids are the resource's deployment names.
        registry.register_as(
            AZURE_CREDITS_PROVIDER_ID,
            Arc::new(OpenAiProvider::new_named_with_egress(
                AZURE_CREDITS_PROVIDER_ID,
                client.clone(),
                egress.and_then(|pool| pool.assigned(AZURE_CREDITS_PROVIDER_ID)),
                c.all_keys(),
                c.base_url.clone(),
                Arc::clone(&quota),
            )),
        );
    }
}
