//! The zero-config built-in prefix→provider table.

/// The built-in prefix→provider rules so zero-config "just works". Returns
/// `(prefix, provider_id)` pairs where `provider_id` is the open registry string
/// (e.g. `"anthropic"`, `"openai"`, `"local"`) — the string form of the former
/// `ProviderKind`. This table *is* the zero-config routing brain; the gateway's
/// `ModelRouter::new` snapshots it once.
pub fn builtin_prefixes() -> Vec<(String, String)> {
    [
        ("zeroclaw", "core"),
        ("openclaw", "core"),
        ("claude-", "anthropic"),
        ("gpt-", "openai"),
        ("o1", "openai"),
        ("o3", "openai"),
        ("o4", "openai"),
        ("text-davinci", "openai"),
        // openrouter/ prefix: any model in the form "openrouter/<name>" is
        // dispatched to OpenRouter so the upstream provider's own routing
        // (e.g. openrouter/auto or openrouter/pareto-code) takes over AFTER
        // Ryu's guardrails run.
        ("openrouter/", "openrouter"),
        // modal/ prefix: any model in the form "modal/<name>" is dispatched
        // to the Ryu Cloud GPU node's Modal inference app (serverless GPU),
        // so a node can offload heavy local-model calls onto Modal's GPUs.
        ("modal/", "modal"),
        // Direct embedding families. Only prefixes that are actual upstream
        // model IDs are claimed; Together's shared open-model IDs need an
        // explicit model_map entry so Ryu does not steal a local model.
        ("voyage-", "voyage"),
        ("jina-", "jina"),
        ("mistral-embed", "mistral"),
        ("codestral-embed", "mistral"),
        ("nvidia/", "nvidia"),
        ("fireworks/", "fireworks"),
        ("embed-v", "cohere"),
        ("rerank-v", "cohere"),
        ("aura-", "deepgram"),
        ("nova-", "deepgram"),
        ("recraftv", "recraft"),
        ("stable-image-", "stability"),
        ("sd3.5-", "stability"),
        ("flux-", "bfl"),
        ("image-01", "minimax"),
        ("gen4.5", "runway"),
        ("gen4_turbo", "runway"),
        ("eleven_", "elevenlabs"),
        ("inworld-tts-", "inworld"),
        // gemini-: native Gemini (and other native-format providers) served
        // through the genai-backed provider, so they route here rather than
        // to the OpenAI-compatible passthroughs.
        ("gemini-", "genai"),
        // ── The SEGREGATED credit-pool supplies ───────────────────────────────
        // Without these rows the providers registered in
        // `apps/gateway/src/providers/mod.rs` are reachable ONLY through an
        // explicit operator `routing.model_map` or `default_provider`, so the
        // whole pool split (`apps/gateway/src/credit_pools.rs`) is inert on a
        // zero-config deploy: no id routes to the pool, so no request is ever
        // pool-tagged and no grant is ever drawn. (`vertex`, `openai-credits` and
        // `anthropic-credits` cannot have a row here — see the end of this block —
        // and are reached through [`POOL_NAMESPACES`] instead.)
        //
        // PLACEMENT IS LOAD-BEARING, for one row: `mistral.` MUST stay above the
        // `("mistral", "local")` row below. `route` takes the FIRST `starts_with`
        // hit top-down, not the longest, so beneath it every Bedrock Mistral id
        // (`mistral.mistral-large-2407-v1:0`,
        // `mistral.mixtral-8x7b-instruct-v0:1`) would be handed to the resident
        // local engine, which does not have them.
        // `builtin_prefix_order_puts_bedrock_mistral_before_local_mistral` fails
        // if anyone re-sorts. The other rows are collision-free by anchoring:
        // `@cf/meta/…` starts with `@`, not `meta.`; `anthropic.claude-…` starts
        // with `anthropic.`, not `claude-`.
        //
        // Cloudflare Workers AI namespaces every model under `@cf/<vendor>/<id>`,
        // so one prefix covers the catalog.
        ("@cf/", "cloudflare"),
        // Bedrock model ids are `<vendor>.<model>-v<n>:<n>`. This is the four
        // vendor namespaces the pool spec named, NOT Bedrock's full vendor list:
        // `cohere.`, `ai21.`, `writer.` and `deepseek.` ids stay unrouted here.
        // The sharpest of those to know about is `deepseek.r1-v1:0`, which the
        // `("deepseek", "local")` row below still claims for the resident local
        // engine — pre-existing behavior, not something these rows changed, and
        // fixable the same way `mistral.` was if that pool is ever stocked.
        //
        // Also deliberately absent: the `us.` / `eu.` / `apac.` cross-region
        // inference-profile forms of the same ids. Those are broad two-letter
        // prefixes to burn on a compile-time default (they would capture any
        // future model whose id happens to start with them), and an operator who
        // uses inference profiles can map them exactly in `routing.model_map`,
        // which outranks this table anyway.
        ("anthropic.", "bedrock"),
        ("amazon.", "bedrock"),
        ("meta.", "bedrock"),
        ("mistral.", "bedrock"),
        // Google Cloud Vertex AI. ONE row, and `google/…` is chosen because it is
        // a real id on the surface the provider actually speaks: step 3 hands the
        // provider the requested model VERBATIM (there is no rewrite slot — that
        // exists only in the user `model_map`), so a prefix that is not part of a
        // genuine upstream id routes perfectly and then 404s.
        //
        // `google/gemini-2.5-pro` is exactly how Vertex's OpenAI-compatible Chat
        // Completions surface names a model, which is the surface
        // `providers/mod.rs` registers this slot against.
        //
        // NOT `("publishers/", "vertex")`, tempting as it looks:
        // `publishers/google/models/<id>` is the NATIVE `generateContent` REST
        // path, not a `model` value the OpenAI-compatible endpoint accepts — so it
        // would route and 404, the exact failure this row's phrasing avoids. Same
        // reason there is no `anthropic/` row: Claude-on-Vertex is
        // Anthropic-Messages-shaped, which an `OpenAiProvider` alias cannot serve
        // (see the Bedrock registration comment for the identical argument). Other
        // Vertex publishers — `meta/`, `mistralai/` — are left to `routing.model_map`
        // for the same reason `cohere.`/`ai21.` are on the Bedrock side: they are
        // not what this pool was stocked for, and a compile-time default should not
        // claim ids nobody has confirmed the allowance serves.
        //
        // NOT `("gemini-", "vertex")` either, and this is the trap worth naming:
        // the `("gemini-", "genai")` row above already claims every bare `gemini-*`
        // id for the own-key Gemini API. A `vertex` row placed above it would
        // re-home ALL existing Gemini traffic onto donated credit; placed below it
        // would never fire, because step 3 takes the FIRST `starts_with` hit, not
        // the longest. Neither is what anyone wants, so bare `gemini-*` stays with
        // `genai`.
        //
        // AND NO `("google/", "vertex")` ROW EITHER — the reason is the one axis the
        // obvious check misses. Comparing a candidate prefix against the other
        // BUILTIN rows finds no collision for `google/`, but step 3 runs BEFORE step
        // 4, so the ids a new row really takes are the ones that used to fall
        // through to `default_provider`. `google/gemini-2.5-pro` is a valid
        // OPENROUTER id, `"openrouter"` is an exposed `default_provider` value, and
        // the composer lets a user free-type any gateway-routable id. So such a row
        // breaks a working id two different ways: with `vertex` unconfigured it
        // turns an OpenRouter-served request into `AllProvidersUnavailable`, and
        // with `vertex` configured it silently debits the DONATED allowance for
        // traffic the operator pointed at retail — while hard-402ing a wallet
        // holding only `openrouter` grant money.
        //
        // So Vertex is reached exactly as the donated OpenAI slot below is: through
        // its explicit `ryu-vision/` namespace ([`POOL_NAMESPACES`], which strips
        // the namespace and so CAN carry a non-upstream prefix), an operator
        // `routing.model_map` entry, or `default_provider`. No bare id is claimed:
        // a donated allowance must be aimed deliberately — by the user picking the
        // tier, or the operator — never by a compile-time prefix on a vendor id.
        // NO ROW FOR THE DONATED OPENAI POOL, deliberately — see
        // `config::OPENAI_CREDITS_PROVIDER_ID`. Real OpenAI ids carry no
        // namespace, and `gpt-`/`o1`/`o3`/`o4`/`text-davinci` above are already
        // claimed by the BYOK `openai` slot. Re-pointing any of them here would
        // convert every pass-through caller's own-key traffic into donated spend,
        // which is the one outcome the separate id exists to prevent, and an
        // invented `openai/…` prefix would only 404 (see the verbatim-model note
        // above). So the donated route is reachable through its explicit
        // `ryu-reasoning/` namespace ([`POOL_NAMESPACES`]), an operator
        // `routing.model_map` entry, or `default_provider` — never by a bare id.
        // `anthropic-credits` is the same case against `claude-` (`ryu-code/`).
        //
        // Consequence of routing these at all, stated so it is not a surprise:
        // every pool provider registers only when configured (`if let Some(c) =
        // config.cloudflare/bedrock/vertex`), so on an untagged deploy these ids
        // resolve to an ABSENT registry id instead of falling through to
        // `default_provider`. That is a clean miss, not a crash — the pipeline's
        // `state.providers.get(...)` sites either skip the candidate or return
        // `AllProvidersUnavailable`. Reaching the wrong provider's 404 was never
        // the better outcome.
        // llama.cpp reports a loaded filesystem-backed model with its absolute
        // path as the `/v1/models` id. Preserve that id when forwarding, but route
        // path-shaped ids to the local provider so discovery and completion agree.
        // User model-map entries still outrank this fallback, as with every other
        // builtin prefix.
        ("/", "local"),
        ("llama", "local"),
        ("mistral", "local"),
        ("mixtral", "local"),
        // ORDER IS LOAD-BEARING — `gemma-3-270m` MUST stay above `gemma`.
        // `RoutingTables::route` walks this table top-down and takes the FIRST
        // `starts_with` hit; it is not a longest-match. Sorting this table
        // alphabetically, or "tidying" the two gemma rows together, would send
        // the classify-tier classifier to the resident chat engine on `local`
        // and silently break the guardrail inspector + LLM-judge evaluators.
        // `builtin_prefix_order_puts_classify_gemma_before_local_gemma` fails if
        // anyone does. The classifier is the only gemma served by the dedicated
        // classify sidecar; every other gemma is a normal local chat model.
        //
        // …AND THIS WHOLE TABLE IS OUTRANKED. The intra-table order above only
        // decides between builtin rows; steps 1-2 of [`RoutingTables::route`] (the
        // user `model_map`, exact then longest-prefix) run BEFORE any of it. So a
        // pre-existing operator mapping of `gemma` → `openrouter` captures the
        // guardrail classifier and bills it to a paid hosted provider — this row
        // never gets a look-in. That is intentional precedence (an operator's
        // explicit config must win over a compile-time default), and it is why
        // `apps/gateway`'s `Config::load` seeds an EXACT `model_map` entry for the
        // resolved classifier id (`config.rs::seed_classify_route`): exact-match is
        // step 1, so it beats the prefix scan the operator's row would win.
        // `user_model_map_outranks_the_builtin_table` pins the precedence.
        ("gemma-3-270m", "classify"),
        ("gemma", "local"),
        ("phi", "local"),
        ("qwen", "local"),
        ("deepseek", "local"),
        // Apple Foundation Models, served on-device by the `apfel` local
        // engine (Core makes it the resident local engine, so LOCAL_LLM_URL
        // points at apfel's :11434). apfel validates this exact id.
        ("apple-foundationmodel", "local"),
    ]
    .into_iter()
    .map(|(prefix, provider)| (prefix.to_string(), provider.to_string()))
    .collect()
}

#[cfg(test)]
mod direct_embedding_route_tests {
    use super::*;

    #[test]
    fn direct_embedding_prefixes_do_not_claim_unrelated_local_models() {
        let prefixes = builtin_prefixes();
        for (model, expected) in [
            ("voyage-4", "voyage"),
            ("jina-embeddings-v5-text-small", "jina"),
            ("mistral-embed", "mistral"),
            ("codestral-embed", "mistral"),
            ("nvidia/llama-nemotron-embed-vl-1b-v2", "nvidia"),
            ("fireworks/qwen3-embedding-8b", "fireworks"),
            ("embed-v4.0", "cohere"),
            ("rerank-v4.0-fast", "cohere"),
            ("aura-2-thalia-en", "deepgram"),
            ("nova-3", "deepgram"),
            ("recraftv4_1", "recraft"),
            ("stable-image-ultra", "stability"),
            ("sd3.5-large", "stability"),
            ("flux-2-pro", "bfl"),
            ("image-01", "minimax"),
            ("gen4.5", "runway"),
            ("gen4_turbo", "runway"),
            ("flux-3-video", "bfl"),
            ("eleven_multilingual_v2", "elevenlabs"),
            ("inworld-tts-2", "inworld"),
            ("inworld-tts-2", "inworld"),
        ] {
            let routed = prefixes
                .iter()
                .find(|(prefix, _)| model.starts_with(prefix))
                .map(|(_, provider)| provider.as_str());
            assert_eq!(routed, Some(expected), "{model}");
        }
        assert_eq!(
            prefixes
                .iter()
                .find(|(prefix, _)| "BAAI/bge-base-en-v1.5".starts_with(prefix))
                .map(|(_, provider)| provider.as_str()),
            None,
        );
    }
}
