//! Ryu's own-supply pool aliases, namespaces and credential-free slots.

use super::*;

/// Ryu-branded model aliases for the managed credit-pool tiers:
/// `(alias id, gateway provider slot, upstream model id)`.
///
/// Ryu sells managed inference as TIERS ("Ryu Fast", "Ryu Frontier", "Ryu
/// Vision", "Ryu Reasoning", "Ryu Code") and never names the supplier behind
/// one. A vendor's model id names the vendor, so the ids Core offers for a
/// managed tier are these aliases instead: `ryu-<tier>/<size>`, with `<size>`
/// from `lite` (smallest/cheapest) → `standard` → `max` (most capable), using
/// only as many sizes as the tier has models.
///
/// [`RoutingTables::route`] resolves an alias (ASCII-case-insensitive, EXACT
/// match only) to its slot and upstream id at the pool-namespace step, and the
/// gateway rewrites the upstream id back to the alias in responses and in the
/// user-visible usage/ledger attribution ([`pool_model_alias_for`]). Core's
/// `managed-<pool>` rows in `apps/core/src/pi_config/mod.rs` offer exactly these
/// ids; `the_model_ids_core_offers_for_each_pool_still_route_to_that_pool`
/// mirrors them.
///
/// Every alias id lives inside a [`POOL_NAMESPACES`] namespace or a namespace no
/// vendor uses (`ryu-fast/`), so no alias captures an id that
/// routes anywhere today. The pre-alias raw forms (`ryu-code/claude-sonnet-4-5`,
/// `@cf/…`, `anthropic.…`) still route exactly as before — saved configs keep
/// working — but are no longer advertised.
pub const POOL_MODEL_ALIASES: &[(&str, &str, &str)] = &[
    // Ryu Fast — Cloudflare Workers AI.
    (
        "ryu-fast/lite",
        "cloudflare",
        "@cf/mistral/mistral-7b-instruct-v0.2",
    ),
    (
        "ryu-fast/standard",
        "cloudflare",
        "@cf/meta/llama-3.1-8b-instruct",
    ),
    (
        "ryu-fast/max",
        "cloudflare",
        "@cf/qwen/qwen1.5-14b-chat-awq",
    ),
    // Ryu Frontier (`ryu-frontier/*`, AWS Bedrock) is retired: Ryu's AWS credit
    // pays for its own VMs, not free inference, so no alias reaches Bedrock.
    // Ryu Vision — Google Cloud Vertex AI (OpenAI-compatible surface ids).
    ("ryu-vision/lite", "vertex", "google/gemini-2.5-flash"),
    ("ryu-vision/max", "vertex", "google/gemini-2.5-pro"),
    // Ryu Reasoning — donated OpenAI credit.
    ("ryu-reasoning/lite", "openai-credits", "o4-mini"),
    ("ryu-reasoning/standard", "openai-credits", "o3"),
    ("ryu-reasoning/max", "openai-credits", "gpt-5"),
    // Ryu Code — Ryu's own Anthropic account.
    ("ryu-code/lite", "anthropic-credits", "claude-haiku-4-5"),
    (
        "ryu-code/standard",
        "anthropic-credits",
        "claude-sonnet-4-5",
    ),
    ("ryu-code/max", "anthropic-credits", "claude-opus-4-5"),
];

/// Resolve a Ryu model alias (see [`POOL_MODEL_ALIASES`]) to `(gateway provider
/// slot, upstream model id)`. Exact, ASCII-case-insensitive match; `None` for
/// anything that is not an alias id.
pub fn pool_model_alias_route(requested_model: &str) -> Option<(&'static str, &'static str)> {
    POOL_MODEL_ALIASES
        .iter()
        .find(|(alias, _, _)| alias.eq_ignore_ascii_case(requested_model))
        .map(|(_, provider, upstream)| (*provider, *upstream))
}

/// The canonical (lower-case) alias id for a requested model, when it is one.
pub fn pool_model_alias_id(requested_model: &str) -> Option<&'static str> {
    POOL_MODEL_ALIASES
        .iter()
        .find(|(alias, _, _)| alias.eq_ignore_ascii_case(requested_model))
        .map(|(alias, _, _)| *alias)
}

/// Reverse lookup: the alias that names `upstream_model` when it was served by
/// the managed pool slot `provider`, or `None`. Keyed on the SLOT as well as the
/// id because the bare upstream ids are shared with BYOK slots
/// (`claude-sonnet-4-5` on the own-key `anthropic` slot is the user's own
/// traffic and must keep its real name).
pub fn pool_model_alias_for(provider: &str, upstream_model: &str) -> Option<&'static str> {
    POOL_MODEL_ALIASES
        .iter()
        .find(|(_, slot, upstream)| {
            *slot == provider && upstream.eq_ignore_ascii_case(upstream_model)
        })
        .map(|(alias, _, _)| *alias)
}

/// The COMPILED SEED of the Ryu Router own-supply table: Ryu Router models that
/// Ryu can also serve from ITS OWN donated supply, as
/// `(Ryu Router model id, gateway pool slot, upstream model id)`.
///
/// The live table is control-plane data (admin "Ryu Router models" page, no
/// deploy), published to fleet gateways as an [`own_supply::OwnSupplyTable`].
/// This constant is only the fallback: what a self-hosted / non-fleet gateway
/// routes on, what Core's legacy-tier migration reads, and what the control
/// plane inserts into an empty table (`packages/auth/src/lib/own-supply-seed.ts`,
/// pinned to this list by `own-supply-seed.test.ts`).
///
/// The user picks models by their real Ryu Router (OpenRouter-catalog) id; the
/// serving supplier is never shown. When a managed caller holds free credit and
/// the picked id has a row whose slot is configured, the gateway serves it from
/// that slot (so the free grant pays for it) and rewrites the response back to
/// the id the user picked; otherwise the request goes to OpenRouter.
///
/// Rules for a row: the two ids must name the SAME model (no "close enough"
/// substitutes), the upstream must already be a [`POOL_MODEL_ALIASES`] upstream
/// (priced, aliased, routable), and the left id must route to `openrouter` by
/// default — `pool_model_equivalents_are_exact_routable_and_openrouter_ids`
/// pins all three. Rows in [`SEED_CANARY_REQUIRED`] never route until a
/// gateway canary has proven them callable.
///
/// AWS Bedrock rows were dropped when Bedrock stopped being own supply (Ryu's
/// AWS credit pays for its own VMs).
pub const SEED_OWN_SUPPLY_EQUIVALENTS: &[(&str, &str, &str)] = &[
    (
        "anthropic/claude-opus-4.5",
        "anthropic-credits",
        "claude-opus-4-5",
    ),
    (
        "anthropic/claude-sonnet-4.5",
        "anthropic-credits",
        "claude-sonnet-4-5",
    ),
    (
        "anthropic/claude-haiku-4.5",
        "anthropic-credits",
        "claude-haiku-4-5",
    ),
    ("openai/gpt-5", "openai-credits", "gpt-5"),
    ("openai/o3", "openai-credits", "o3"),
    ("openai/o4-mini", "openai-credits", "o4-mini"),
    ("google/gemini-2.5-pro", "vertex", "google/gemini-2.5-pro"),
    (
        "google/gemini-2.5-flash",
        "vertex",
        "google/gemini-2.5-flash",
    ),
    (
        "meta-llama/llama-3.1-8b-instruct",
        "cloudflare",
        "@cf/meta/llama-3.1-8b-instruct",
    ),
];

/// Seed rows `(slot, upstream)` that must pass a gateway canary before they
/// route or carry the Free tag. Empty since the Bedrock rows (the only
/// canary-gated seed rows) were dropped with the retired Bedrock pool.
pub const SEED_CANARY_REQUIRED: &[(&str, &str)] = &[];

/// The SEED own-supply candidates for a Ryu Router model id, in preference
/// order (exact, ASCII-case-insensitive). Empty when the seed has none. Routing
/// reads the live [`own_supply::OwnSupplyTable`] instead.
pub fn pool_model_equivalents(
    requested_model: &str,
) -> impl Iterator<Item = (&'static str, &'static str)> + '_ {
    SEED_OWN_SUPPLY_EQUIVALENTS
        .iter()
        .filter(move |(id, _, _)| id.eq_ignore_ascii_case(requested_model))
        .map(|(_, slot, upstream)| (*slot, *upstream))
}

/// Reverse SEED lookup: the Ryu Router id a user knows for `upstream_model`
/// served by the own-supply slot `provider`, or `None`. Keyed on the slot, so
/// BYOK traffic with the same bare id keeps its own name.
pub fn pool_model_equivalent_id(provider: &str, upstream_model: &str) -> Option<&'static str> {
    SEED_OWN_SUPPLY_EQUIVALENTS
        .iter()
        .find(|(_, slot, upstream)| {
            *slot == provider && upstream.eq_ignore_ascii_case(upstream_model)
        })
        .map(|(id, _, _)| *id)
}

/// The alias a managed tier is offered under when nobody picked a size: the
/// slot's `…/standard` alias, else its first (smallest) alias. `None` when the
/// slot sells no tier.
pub fn pool_default_alias_for(provider: &str) -> Option<&'static str> {
    let mut aliases = POOL_MODEL_ALIASES
        .iter()
        .filter(|(_, slot, _)| *slot == provider)
        .map(|(alias, _, _)| *alias);
    let first = aliases.next()?;
    if first.ends_with("/standard") {
        return Some(first);
    }
    Some(
        aliases
            .find(|alias| alias.ends_with("/standard"))
            .unwrap_or(first),
    )
}

/// Explicit credit-pool namespaces: `<namespace><upstream model id>` selects a
/// donated pool's gateway slot by NAME and strips the namespace before the id
/// goes upstream, e.g. `ryu-code/claude-sonnet-4-5` → (`anthropic-credits`,
/// `claude-sonnet-4-5`).
///
/// This exists for the three pools whose vendors' real ids are already claimed
/// by a BYOK slot or by OpenRouter, so no bare prefix can reach them without
/// stealing someone else's traffic (see the long notes in [`builtin_prefixes`]):
/// `claude-*` is the BYOK `anthropic` slot, `gpt-`/`o3`/`o4` the BYOK `openai`
/// slot, and `google/gemini-*` a live OpenRouter id. A namespace that no vendor
/// uses is the one way to ask for the donated supply without capturing any id
/// that routes somewhere today — the bare ids keep routing exactly as before.
///
/// The namespaces are the pools' public tier names (`packages/auth/src/lib/
/// credit-pools.ts`: "Ryu Code", "Ryu Reasoning", "Ryu Vision"), never the
/// supplier's, so the wire id a user sees names the tier they were sold. Core's
/// `managed-<pool>` rows in `apps/core/src/pi_config/mod.rs` offer ids in this
/// form; `the_model_ids_core_offers_for_each_pool_still_route_to_that_pool`
/// mirrors them.
///
/// Matching is ASCII-case-insensitive on the namespace only; the remainder is
/// forwarded byte-for-byte. A bare namespace with nothing after it is not a
/// model and is left to the normal routing order.
pub const POOL_NAMESPACES: &[(&str, &str)] = &[
    ("ryu-code/", "anthropic-credits"),
    ("ryu-reasoning/", "openai-credits"),
    ("ryu-vision/", "vertex"),
];

/// Resolve an explicitly pool-namespaced model id (see [`POOL_NAMESPACES`]) to
/// `(gateway provider id, upstream model id)`, or `None` when the id carries no
/// pool namespace.
pub fn pool_namespace_route(requested_model: &str) -> Option<(&'static str, &str)> {
    POOL_NAMESPACES.iter().find_map(|(namespace, provider)| {
        let head = requested_model.get(..namespace.len())?;
        if !head.eq_ignore_ascii_case(namespace) {
            return None;
        }
        let upstream = &requested_model[namespace.len()..];
        (!upstream.is_empty()).then_some((*provider, upstream))
    })
}

/// The Gateway's keyless local engine slot (llama.cpp).
pub const LOCAL_SLOT: &str = "local";

/// The Gateway's classify tier slot (a small resident local model).
pub const CLASSIFY_SLOT: &str = "classify";

/// The Gateway slots that serve from Ryu's OWN (donated) supply: every pool in
/// the Gateway's `credit_pools` table except the retail OpenRouter
/// pass-through. Shared so Core can tell, before a turn, which models an agent
/// with limited model providers can still use. The Gateway's
/// `own_supply_slots_match_the_router_crate` test pins this list to its pool
/// table.
pub const OWN_SUPPLY_SLOTS: &[&str] = &[
    "azure-credits",
    "cloudflare",
    "vertex",
    "openai-credits",
    "anthropic-credits",
];

/// Ryu-held slots that are no longer own supply: AWS Bedrock holds Ryu's AWS
/// account (whose credit now pays for Ryu's own VMs). It serves no free credit,
/// but it is still not a user's credential. Mirrors the Gateway's
/// `credit_pools::RETIRED_RYU_SLOTS`.
pub const RETIRED_RYU_SLOTS: &[&str] = &["bedrock"];

/// Whether a Gateway provider slot uses none of the user's own credentials:
/// the keyless local engine, the classify tier, or Ryu's own supply. An
/// agent's model provider access never limits these. (The Gateway also exempts
/// keyless SDK routes, which it checks against its credential catalog.)
pub fn slot_uses_no_user_credential(provider: &str) -> bool {
    provider == LOCAL_SLOT
        || provider == CLASSIFY_SLOT
        || OWN_SUPPLY_SLOTS.contains(&provider)
        || RETIRED_RYU_SLOTS.contains(&provider)
}

/// The slot a model id routes to by the compiled-in rules alone: a Ryu model
/// alias, an explicit pool namespace, then the first [`builtin_prefixes`] hit
/// (steps 3 and 4 of [`RoutingTables::route`]). `None` when only an operator's
/// `model_map` or the configured default provider would decide it, which a
/// caller without the Gateway's config cannot know.
pub fn builtin_route(requested_model: &str) -> Option<String> {
    if let Some((provider, _)) = pool_model_alias_route(requested_model) {
        return Some(provider.to_owned());
    }
    if let Some((provider, _)) = pool_namespace_route(requested_model) {
        return Some(provider.to_owned());
    }
    let model_lower = requested_model.to_lowercase();
    builtin_prefixes()
        .into_iter()
        .find(|(prefix, _)| model_lower.starts_with(prefix.as_str()))
        .map(|(_, provider)| provider)
}

#[cfg(test)]
mod credential_free_route_tests {
    use super::*;

    #[test]
    fn builtin_route_matches_the_tables_without_an_operator_map() {
        let tables = RoutingTables {
            model_map: HashMap::new(),
            builtin_prefixes: builtin_prefixes(),
            default_provider: "configured-default".to_owned(),
            modality_map: HashMap::new(),
            fallback_chain: Vec::new(),
            provider_tiers: HashMap::new(),
            eval_candidates: Vec::new(),
            explore_ratio: 0.0,
        };
        for model in [
            "ryu-code/standard",
            "ryu-vision/google/gemini-2.5-pro",
            "@cf/meta/llama-3.1-8b-instruct",
            "claude-sonnet-4-5",
            "gpt-5",
            "gemini-2.5-pro",
            "openrouter/auto",
            "gemma-3-4b-it",
            "gemma-3-270m",
        ] {
            assert_eq!(
                builtin_route(model).as_deref(),
                Some(tables.route(model).0.as_str()),
                "{model}"
            );
        }
        assert_eq!(builtin_route("anthropic/claude-sonnet-4"), None);
        assert_eq!(
            tables.route("anthropic/claude-sonnet-4").0,
            "configured-default"
        );
    }

    #[test]
    fn only_local_classify_and_own_supply_slots_need_no_user_credential() {
        for free in [
            LOCAL_SLOT,
            CLASSIFY_SLOT,
            "azure-credits",
            "cloudflare",
            "vertex",
            "openai-credits",
            "anthropic-credits",
        ] {
            assert!(slot_uses_no_user_credential(free), "{free}");
        }
        // `bedrock` is no longer own supply, but it is Ryu's AWS account, not a
        // user credential.
        assert!(slot_uses_no_user_credential("bedrock"));
        assert!(!OWN_SUPPLY_SLOTS.contains(&"bedrock"));
        for user in [
            "openai",
            "anthropic",
            "azure",
            "genai",
            "openrouter",
            "core",
            "",
        ] {
            assert!(!slot_uses_no_user_credential(user), "{user}");
        }
        // Every pool alias and namespace lands on an own-supply slot.
        for (_, slot, _) in POOL_MODEL_ALIASES {
            assert!(OWN_SUPPLY_SLOTS.contains(slot), "{slot}");
        }
        for (_, slot) in POOL_NAMESPACES {
            assert!(OWN_SUPPLY_SLOTS.contains(slot), "{slot}");
        }
    }
}
