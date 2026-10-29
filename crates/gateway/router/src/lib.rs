//! Ryu Gateway model-routing core (Plane A) — the pure decision logic.
//!
//! **Decomposition (W6): the routing algorithm moved out.** This crate owns the
//! model→provider *resolution*, keyed on provider **strings** (the
//! `ProviderKind`→string opening): the full [`RoutingTables::route`] order
//! (exact map → longest user prefix → built-in prefix table → default), the
//! zero-config [`builtin_prefixes`] table, the modality-slot resolution
//! ([`RoutingTables::route_modality`]), the cost-tier [`RoutingTables::fallback_chain`]
//! sort, the eval-driven A/B [`RoutingTables::eval_route`] explore/exploit picker,
//! and the classifier ("smart routing") text helpers ([`build_prompt`],
//! [`parse_choice`], [`last_user_message`], [`keyword_match`], [`truncate`]).
//! Everything here is pure — it operates over `&str` / `String` /
//! `serde_json::Value` / `usize` with no gateway config-types, no async, and no
//! process/network state.
//!
//! What stays in `apps/gateway` (`src/router/`) — "engine moves, wiring stays":
//! the `ModelRouter` / `SmartRouter` structs that hold the config snapshot and
//! build these tables once, the `RouterRegistry` / `SmartRouterBackend` traits +
//! registration, the `RouteDecision` + config value-types, the `AtomicU64` A/B
//! counter (passed in via a closure so its increment timing is preserved), and
//! SmartRouter's async provider/embedding orchestration (bound to the gateway's
//! `ProviderRegistry` + `semantic_cache`). The gateway wrappers resolve config →
//! these string tables and map the returned provider strings back to
//! `ProviderId` / `RouteDecision`, so every call site is behavior-identical.

pub mod own_supply;
pub mod pool;

use std::collections::HashMap;

use serde_json::Value;
use tracing::debug;

/// Cap the user message sent to the classifier so a huge paste stays cheap.
pub const MAX_CLASSIFIER_INPUT_CHARS: usize = 2000;

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
/// vendor uses (`ryu-fast/`, `ryu-frontier/`), so no alias captures an id that
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
    // Ryu Frontier — Amazon Bedrock.
    (
        "ryu-frontier/lite",
        "bedrock",
        "meta.llama3-1-70b-instruct-v1:0",
    ),
    ("ryu-frontier/standard", "bedrock", "amazon.nova-pro-v1:0"),
    (
        "ryu-frontier/max",
        "bedrock",
        "anthropic.claude-3-5-sonnet-20241022-v2:0",
    ),
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
/// `anthropic/claude-3.5-sonnet` (Bedrock) was dropped: OpenRouter no longer
/// lists it.
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
    ("amazon/nova-pro-v1", "bedrock", "amazon.nova-pro-v1:0"),
    (
        "meta-llama/llama-3.1-70b-instruct",
        "bedrock",
        "meta.llama3-1-70b-instruct-v1:0",
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
/// route or carry the Free tag: the Bedrock slot speaks Anthropic Messages, so
/// its non-Claude rows are expected to be unservable until proven otherwise.
pub const SEED_CANARY_REQUIRED: &[(&str, &str)] = &[
    ("bedrock", "amazon.nova-pro-v1:0"),
    ("bedrock", "meta.llama3-1-70b-instruct-v1:0"),
];

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
    "cloudflare",
    "bedrock",
    "vertex",
    "openai-credits",
    "anthropic-credits",
];

/// Whether a Gateway provider slot uses none of the user's own credentials:
/// the keyless local engine, the classify tier, or Ryu's own supply. An
/// agent's model provider access never limits these. (The Gateway also exempts
/// keyless SDK routes, which it checks against its credential catalog.)
pub fn slot_uses_no_user_credential(provider: &str) -> bool {
    provider == LOCAL_SLOT || provider == CLASSIFY_SLOT || OWN_SUPPLY_SLOTS.contains(&provider)
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
            "cloudflare",
            "bedrock",
            "vertex",
            "openai-credits",
            "anthropic-credits",
        ] {
            assert!(slot_uses_no_user_credential(free), "{free}");
        }
        for user in ["openai", "anthropic", "genai", "openrouter", "core", ""] {
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

/// Which [`RoutingTables::route`] precedence step produced a decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteSource {
    /// Step 1 or 2: an operator `model_map` entry (exact or longest prefix).
    ModelMap,
    /// Step 3: a Ryu model alias ([`POOL_MODEL_ALIASES`]) or an explicit
    /// credit-pool namespace ([`POOL_NAMESPACES`]). An explicit target, like a
    /// builtin vendor prefix.
    CreditPool,
    /// Step 4: a zero-config [`builtin_prefixes`] row.
    BuiltinPrefix,
    /// Step 5: nothing matched, so `default_provider` took the model.
    DefaultProvider,
}

/// The router-neutral model namespace owned by the routing layer.
///
/// `router/<model>` always targets whichever upstream router is active, so a
/// caller can name an aggregator model without naming the aggregator. Swapping
/// OpenRouter for LiteLLM re-points these ids without changing a prompt, agent,
/// or allowlist — the same contract a Toolkit verb has.
pub const UPSTREAM_ROUTER_PREFIX: &str = "router/";

/// Upstream routers the routing layer can bind. Each is an ordinary provider
/// registry id; the routing layer only decides which one receives the
/// router-neutral and catch-all traffic.
pub const UPSTREAM_ROUTER_IDS: &[&str] = &["openrouter", "litellm", "local"];

/// The model segment after [`UPSTREAM_ROUTER_PREFIX`], matched
/// case-insensitively, or `None` when the id is not router-neutral.
pub fn strip_upstream_router_prefix(requested_model: &str) -> Option<&str> {
    let prefix_len = UPSTREAM_ROUTER_PREFIX.len();
    let head = requested_model.get(..prefix_len)?;
    if !head.eq_ignore_ascii_case(UPSTREAM_ROUTER_PREFIX) {
        return None;
    }
    let model = &requested_model[prefix_len..];
    (!model.trim().is_empty()).then_some(model)
}

/// The model id an upstream router expects for a router-neutral model.
///
/// Vendor-qualified ids (`anthropic/claude-sonnet-4`) are already the native id
/// on every aggregator. OpenRouter alone names its own meta-routers inside its
/// namespace (`openrouter/auto`, `openrouter/pareto-code`), so an unqualified
/// router-neutral id becomes `openrouter/<id>` there. Every other router serves
/// the id exactly as its operator configured it.
pub fn upstream_router_wire_model(router_id: &str, model: &str) -> String {
    if router_id == "openrouter" && !model.contains('/') {
        return format!("openrouter/{model}");
    }
    model.to_string()
}

/// A once-built, string-keyed snapshot of the routing config the gateway's
/// `ModelRouter` resolves against. Built once in `ModelRouter::new` (config is a
/// startup snapshot), then borrowed into the pure resolution methods so the hot
/// path never rebuilds a lookup structure. All ids are open provider strings.
pub struct RoutingTables {
    /// requested-model → (provider_id, optional rewritten model). Used for both
    /// the exact lookup and the longest-prefix scan.
    pub model_map: HashMap<String, (String, Option<String>)>,
    /// Built-in prefix rules evaluated before the default (see [`builtin_prefixes`]).
    pub builtin_prefixes: Vec<(String, String)>,
    /// Provider used when nothing else matches.
    pub default_provider: String,
    /// modality-key (e.g. `"image"`/`"tts"`/`"stt"`) → (provider_id, optional model).
    pub modality_map: HashMap<String, (String, Option<String>)>,
    /// Configured fallback chain (provider ids), demoted by tier after the primary.
    pub fallback_chain: Vec<String>,
    /// provider_id → cost tier (0 subscription → 1 cheap → 2 free).
    pub provider_tiers: HashMap<String, u8>,
    /// Eval-driven (A/B) candidate provider ids.
    pub eval_candidates: Vec<String>,
    /// Fraction of eval traffic reserved for exploring non-leader candidates.
    pub explore_ratio: f32,
}

impl RoutingTables {
    /// Determine which provider and model name to use for a given request model
    /// string. Returns `(provider_id, model)`.
    ///
    /// **Precedence, outermost first** — steps 1-2 (the operator's `model_map`)
    /// outrank the whole builtin table, so no builtin row is a guarantee:
    /// 1. exact `model_map` hit,
    /// 2. longest `model_map` prefix hit,
    /// 3. a Ryu model alias ([`POOL_MODEL_ALIASES`], exact) or an explicit pool
    ///    namespace ([`POOL_NAMESPACES`], namespace stripped),
    /// 4. [`builtin_prefixes`] (first `starts_with` hit, top-down),
    /// 5. `default_provider`.
    ///
    /// The consequence worth stating: a broad user prefix (`gemma`, `gpt-`) silently
    /// re-homes every builtin route beneath it, including infrastructure routes like
    /// `gemma-3-270m` → `classify`. Anything that must survive an operator's prefix
    /// map has to be seeded as an EXACT entry (step 1) — see
    /// `apps/gateway/src/config.rs::seed_classify_route`.
    pub fn route(&self, requested_model: &str) -> (String, String) {
        let (provider, model, _) = self.route_with_source(requested_model);
        (provider, model)
    }

    /// [`Self::route`] plus which precedence step produced the decision. The
    /// routing layer uses the step to tell an explicit target (an operator pin or
    /// a builtin vendor prefix) from the catch-all an upstream router replaces.
    pub fn route_with_source(&self, requested_model: &str) -> (String, String, RouteSource) {
        let model_lower = requested_model.to_lowercase();

        // 1. Exact match in user's model_map
        if let Some((provider, provider_model)) = self.model_map.get(requested_model) {
            let model = provider_model
                .clone()
                .unwrap_or_else(|| requested_model.to_string());
            debug!(requested = requested_model, provider = %provider, routed_model = %model, "route: exact model map hit");
            return (provider.clone(), model, RouteSource::ModelMap);
        }

        // 2. Prefix match in user's model_map (longest prefix wins)
        if let Some((provider, model)) = self.prefix_match_user_map(requested_model) {
            debug!(requested = requested_model, provider = %provider, "route: user prefix map hit");
            return (provider, model, RouteSource::ModelMap);
        }

        // 3. Explicit credit-pool namespace. The ONLY builtin step with a rewrite
        // slot: the namespace names Ryu's tier, not an upstream id, so it must be
        // stripped or the vendor 404s. Ahead of the builtin table so no future
        // builtin row can shadow an explicit pool choice; behind the operator's
        // `model_map` like everything else compiled in.
        // Ryu model aliases come first: `ryu-code/max` is also inside the
        // `ryu-code/` namespace, and must resolve to its upstream id rather than
        // forwarding the literal `max`.
        if let Some((provider, upstream)) = pool_model_alias_route(requested_model) {
            debug!(requested = requested_model, provider = %provider, "route: pool model alias hit");
            return (
                provider.to_string(),
                upstream.to_string(),
                RouteSource::CreditPool,
            );
        }
        if let Some((provider, upstream)) = pool_namespace_route(requested_model) {
            debug!(requested = requested_model, provider = %provider, routed_model = %upstream, "route: pool namespace hit");
            return (
                provider.to_string(),
                upstream.to_string(),
                RouteSource::CreditPool,
            );
        }

        // 4. Built-in prefix rules
        for (prefix, provider) in &self.builtin_prefixes {
            if model_lower.starts_with(prefix.as_str()) {
                debug!(requested = requested_model, provider = %provider, "route: builtin prefix hit");
                return (
                    provider.clone(),
                    requested_model.to_string(),
                    RouteSource::BuiltinPrefix,
                );
            }
        }

        // 5. Fall back to configured default provider
        debug!(requested = requested_model, provider = %self.default_provider, "route: default provider");
        (
            self.default_provider.clone(),
            requested_model.to_string(),
            RouteSource::DefaultProvider,
        )
    }

    /// Resolve the provider and model for a modality request, honoring an
    /// optional per-agent slot override forwarded by Core.
    ///
    /// Resolution order (first match wins): explicit slot override → static
    /// `modality_map` entry → standard model-based routing. An unset slot falls
    /// through to the next level.
    pub fn route_modality(
        &self,
        modality: &str,
        requested_model: &str,
        slot_provider: Option<&str>,
        slot_model: Option<&str>,
    ) -> (String, String) {
        // 1. Per-agent slot override wins over the static modality map.
        if let Some(provider) = slot_provider {
            let chosen = slot_model.unwrap_or(requested_model);
            // A Ryu alias is never a model id any upstream knows: on its own
            // slot it resolves to the upstream id it names (the same resolution
            // `route` applies), so a slot override cannot send `ryu-code/max`
            // to Anthropic verbatim. On any other slot it is left alone and the
            // upstream rejects it, rather than silently re-homing the request.
            let model = match pool_model_alias_route(chosen) {
                Some((alias_slot, upstream)) if alias_slot == provider => upstream.to_owned(),
                _ => chosen.to_owned(),
            };
            debug!(
                modality = modality,
                requested = requested_model,
                provider = %provider,
                routed_model = %model,
                "route_modality_with_slot: per-agent slot override"
            );
            return (provider.to_string(), model);
        }

        // 2. Static modality_map entry.
        if let Some((provider, mapping_model)) = self.modality_map.get(modality) {
            let model = mapping_model
                .clone()
                .unwrap_or_else(|| requested_model.to_string());
            debug!(
                modality = modality,
                requested = requested_model,
                provider = %provider,
                routed_model = %model,
                "route_modality_with_slot: modality map hit"
            );
            return (provider.clone(), model);
        }

        // 3. No explicit modality mapping — fall back to standard model routing.
        debug!(
            modality = modality,
            requested = requested_model,
            "route_modality_with_slot: no modality map entry, falling back to model routing"
        );
        self.route(requested_model)
    }

    /// Returns an ordered fallback chain for a given provider. The primary
    /// provider is first, followed by the configured fallback chain (with the
    /// primary removed to avoid duplicates), then cost-tier demoted.
    pub fn fallback_chain(&self, primary: &str) -> Vec<String> {
        let mut chain = vec![primary.to_string()];
        for p in &self.fallback_chain {
            if p != primary {
                chain.push(p.clone());
            }
        }
        // Cost-tier ordering (#2): after the primary, demote providers by their
        // configured tier (subscription 0 → cheap 1 → free 2). Stable sort keeps
        // the operator's `fallback_chain` order within a tier. The primary stays
        // pinned first regardless of its own tier. Empty map ⇒ no reordering.
        if !self.provider_tiers.is_empty() && chain.len() > 2 {
            let primary_first = chain.remove(0);
            chain.sort_by_key(|p| self.provider_tiers.get(p).copied().unwrap_or(0));
            chain.insert(0, primary_first);
        }
        chain
    }

    /// Pick a provider from the configured A/B candidates, biased toward
    /// whichever candidate has the best rolling eval score. Returns the chosen
    /// provider id, or `None` when eval-driven routing is not applicable (fewer
    /// than two candidates).
    ///
    /// `score_of` returns the current eval score for a provider id, or `None` if
    /// it has not been scored yet. Unscored candidates are always explored first.
    /// `next_counter` yields the monotonic explore/exploit counter; it is called
    /// exactly once, and only on the explore-ratio path, so the caller's counter
    /// advances with the same timing as before the extraction.
    pub fn eval_route(
        &self,
        requested_model: &str,
        score_of: &dyn Fn(&str) -> Option<f32>,
        next_counter: &dyn Fn() -> u64,
    ) -> Option<String> {
        let candidates = &self.eval_candidates;
        if candidates.len() < 2 {
            return None;
        }
        // An explicit pool namespace is a billing choice, not a routing hint: A/B
        // exploration would hand `ryu-code/…` to another candidate verbatim,
        // which both 404s (the namespace is not an upstream id) and debits a pool
        // the user did not pick. Leave it to `route`.
        if pool_namespace_route(requested_model).is_some()
            || pool_model_alias_route(requested_model).is_some()
        {
            return None;
        }

        // 1. Explore any candidate that has no score yet.
        for candidate in candidates {
            if score_of(candidate).is_none() {
                debug!(requested = requested_model, provider = %candidate, "eval_route: exploring unscored candidate");
                return Some(candidate.clone());
            }
        }

        // 2. Identify the current leader (highest rolling score).
        let leader = candidates
            .iter()
            .max_by(|a, b| {
                let sa = score_of(a).unwrap_or(0.0);
                let sb = score_of(b).unwrap_or(0.0);
                sa.partial_cmp(&sb).unwrap_or(std::cmp::Ordering::Equal)
            })
            .cloned()?;

        // 3. Reserve `explore_ratio` of traffic for non-leaders so scores stay
        //    fresh; otherwise exploit the leader.
        let explore_ratio = self.explore_ratio.clamp(0.0, 1.0);
        let provider = if explore_ratio > 0.0 {
            let n = next_counter();
            let period = (1.0 / explore_ratio).round().max(1.0) as u64;
            if n % period == 0 {
                // Exploration slot: round-robin over the non-leader candidates.
                let others: Vec<&String> = candidates.iter().filter(|c| **c != leader).collect();
                if others.is_empty() {
                    leader.clone()
                } else {
                    let idx = (n / period) as usize % others.len();
                    others[idx].clone()
                }
            } else {
                leader.clone()
            }
        } else {
            leader.clone()
        };

        debug!(
            requested = requested_model,
            provider = %provider,
            leader = %leader,
            "eval_route: eval-driven routing decision"
        );
        Some(provider)
    }

    fn prefix_match_user_map(&self, requested_model: &str) -> Option<(String, String)> {
        let mut best: Option<(&str, &(String, Option<String>))> = None;

        for (key, mapping) in &self.model_map {
            if requested_model.starts_with(key.as_str()) {
                let is_longer = best.map_or(true, |(prev, _)| key.len() > prev.len());
                if is_longer {
                    best = Some((key.as_str(), mapping));
                }
            }
        }

        best.map(|(_, (provider, provider_model))| {
            let model = provider_model
                .clone()
                .unwrap_or_else(|| requested_model.to_string());
            (provider.clone(), model)
        })
    }
}

// ─── Classifier ("smart routing") text helpers ───────────────────────────────

/// Build the classifier prompt: enumerate rule descriptions and ask for a single
/// number.
pub fn build_prompt(rule_descriptions: &[String], user_msg: &str) -> String {
    let mut s = String::from(
        "You are a request router. Read the user's message and choose the ONE rule \
that best matches it. Reply with ONLY the rule number (a single integer). \
Reply 0 if no rule applies. Do not explain.\n\nRules:\n",
    );
    for (i, desc) in rule_descriptions.iter().enumerate() {
        s.push_str(&format!("{}. {}\n", i + 1, desc));
    }
    s.push_str("\nUser message:\n");
    s.push_str(truncate(user_msg, MAX_CLASSIFIER_INPUT_CHARS));
    s.push_str("\n\nRule number:");
    s
}

/// Parse the classifier's reply into a choice in `0..=num_rules`.
///
/// Returns `Some(0)` for "no rule", `Some(n)` for rule `n`, and `None` when the
/// reply has no integer in range (the caller then fails open). Reads the first
/// run of digits anywhere in the text so it tolerates stray prose.
pub fn parse_choice(text: &str, num_rules: usize) -> Option<usize> {
    let digits: String = text
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect();
    let n: usize = digits.parse().ok()?;
    if n <= num_rules {
        Some(n)
    } else {
        None
    }
}

/// `Keyword` strategy core: the index of the first rule whose description shares
/// a significant word (case-insensitive, length > 2) with the message, or `None`
/// if none match. Zero cost — no LLM, no embedding.
pub fn keyword_match(rule_descriptions: &[String], user_msg: &str) -> Option<usize> {
    let user_msg = user_msg.to_lowercase();
    for (idx, desc) in rule_descriptions.iter().enumerate() {
        let hit = desc
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() > 2)
            .any(|w| user_msg.contains(&w.to_lowercase()));
        if hit {
            return Some(idx);
        }
    }
    None
}

/// Extract the most recent user message text. Handles both plain-string content
/// and the OpenAI multimodal content-array shape (joining its text parts).
pub fn last_user_message(messages: &Value) -> Option<String> {
    let arr = messages.as_array()?;
    for m in arr.iter().rev() {
        if m["role"].as_str() != Some("user") {
            continue;
        }
        if let Some(s) = m["content"].as_str() {
            if !s.trim().is_empty() {
                return Some(s.to_string());
            }
        } else if let Some(parts) = m["content"].as_array() {
            let text = parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join(" ");
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
    }
    None
}

/// Truncate `s` to at most `max` chars on a char boundary.
pub fn truncate(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    match s.char_indices().nth(max) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

/// Pick an index from relative non-negative weights using a reproducible ticket.
///
/// The caller owns the random source; keeping this function pure makes weighted
/// routing testable without an RNG dependency and lets the Gateway provide either
/// a configured seed or a process-local seed. Invalid weights are treated as zero,
/// and `None` is returned when no usable weight remains.
pub fn weighted_index(weights: &[f32], ticket: u64) -> Option<usize> {
    let total: f64 = weights
        .iter()
        .copied()
        .filter(|weight| weight.is_finite() && *weight > 0.0)
        .map(f64::from)
        .sum();
    if total <= 0.0 {
        return None;
    }

    let unit = ticket as f64 / u64::MAX as f64;
    let mut cursor = unit * total;
    let mut last_positive = None;
    for (index, weight) in weights.iter().copied().enumerate() {
        if !weight.is_finite() || weight <= 0.0 {
            continue;
        }
        last_positive = Some(index);
        let weight = f64::from(weight);
        if cursor < weight {
            return Some(index);
        }
        cursor -= weight;
    }
    // Protect the upper-bound ticket (`u64::MAX`) from floating-point rounding.
    last_positive
}

/// The model tier selected by the signal-driven stage router.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageTarget {
    Capable,
    Efficient,
}

/// Choose a stage-router tier from recent tool/result history.
///
/// This is intentionally a small, provider-neutral heuristic. It treats errors,
/// recovery, and exploration as evidence for the capable tier, while recent writes
/// and successful tests are evidence for the efficient tier. An ambiguous or empty
/// history returns the configured default. The confidence gate prevents one weak
/// token hit from flipping a quality-first route.
pub fn stage_target(
    messages: &Value,
    recent_message_window: usize,
    confidence_threshold: f32,
    capable_first: bool,
) -> StageTarget {
    let default_target = if capable_first {
        StageTarget::Capable
    } else {
        StageTarget::Efficient
    };
    let Some(history) = messages.as_array() else {
        return default_target;
    };
    if history.is_empty() || recent_message_window == 0 {
        return default_target;
    }

    let start = history
        .len()
        .saturating_sub(recent_message_window.saturating_mul(4).max(1));
    let mut text = String::new();
    for message in &history[start..] {
        if let Ok(serialized) = serde_json::to_string(message) {
            text.push_str(&serialized.to_ascii_lowercase());
            text.push('\n');
        }
    }

    let errors = count_signal_hits(
        &text,
        &[
            "error",
            "failed",
            "failure",
            "panic",
            "traceback",
            "timed out",
            "timeout",
            "invalid",
        ],
    );
    let exploration = count_signal_hits(
        &text,
        &[
            "read", "search", "grep", "find", "list", "inspect", "explore",
        ],
    );
    let production = count_signal_hits(
        &text,
        &[
            "apply_patch",
            "write",
            "wrote",
            "edit",
            "edited",
            "created",
            "test passed",
            "tests passed",
            "success",
        ],
    );

    let signed_score =
        errors.saturating_mul(3) as i32 + exploration as i32 - production.saturating_mul(2) as i32;
    if signed_score == 0 {
        return default_target;
    }

    let confidence = (signed_score.unsigned_abs() as f32 / 3.0).tanh();
    if confidence < confidence_threshold.clamp(0.0, 1.0) {
        return default_target;
    }
    if signed_score > 0 {
        StageTarget::Capable
    } else {
        StageTarget::Efficient
    }
}

fn count_signal_hits(text: &str, signals: &[&str]) -> usize {
    signals
        .iter()
        .map(|signal| text.match_indices(signal).count())
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn descriptions() -> Vec<String> {
        vec!["coding".to_string(), "chit-chat".to_string()]
    }

    // ── Model routing ─────────────────────────────────────────────────────────

    fn tables(
        model_map: HashMap<String, (String, Option<String>)>,
        modality_map: HashMap<String, (String, Option<String>)>,
        fallback_chain: Vec<String>,
        provider_tiers: HashMap<String, u8>,
        eval_candidates: Vec<String>,
        explore_ratio: f32,
        default_provider: &str,
    ) -> RoutingTables {
        RoutingTables {
            model_map,
            builtin_prefixes: builtin_prefixes(),
            default_provider: default_provider.to_string(),
            modality_map,
            fallback_chain,
            provider_tiers,
            eval_candidates,
            explore_ratio,
        }
    }

    fn bare(default_provider: &str) -> RoutingTables {
        tables(
            HashMap::new(),
            HashMap::new(),
            Vec::new(),
            HashMap::new(),
            Vec::new(),
            0.0,
            default_provider,
        )
    }

    #[test]
    fn builtin_prefix_routes_claude_to_anthropic() {
        let t = bare("openai");
        let (provider, model) = t.route("claude-sonnet-4-5");
        assert_eq!(provider, "anthropic");
        assert_eq!(model, "claude-sonnet-4-5");
    }

    #[test]
    fn route_with_source_names_the_precedence_step() {
        let mut model_map = HashMap::new();
        model_map.insert("pinned".to_owned(), ("anthropic".to_owned(), None));
        let t = tables(
            model_map,
            HashMap::new(),
            Vec::new(),
            HashMap::new(),
            Vec::new(),
            0.0,
            "openai",
        );
        assert_eq!(t.route_with_source("pinned").2, RouteSource::ModelMap);
        assert_eq!(
            t.route_with_source("claude-sonnet-4-5").2,
            RouteSource::BuiltinPrefix
        );
        assert_eq!(
            t.route_with_source("anthropic/claude-sonnet-4"),
            (
                "openai".to_owned(),
                "anthropic/claude-sonnet-4".to_owned(),
                RouteSource::DefaultProvider
            )
        );
    }

    #[test]
    fn router_neutral_prefix_is_stripped_case_insensitively() {
        assert_eq!(
            strip_upstream_router_prefix("router/anthropic/claude-sonnet-4"),
            Some("anthropic/claude-sonnet-4")
        );
        assert_eq!(strip_upstream_router_prefix("Router/auto"), Some("auto"));
        assert_eq!(strip_upstream_router_prefix("router/"), None);
        assert_eq!(strip_upstream_router_prefix("router/  "), None);
        assert_eq!(strip_upstream_router_prefix("openrouter/auto"), None);
        assert_eq!(strip_upstream_router_prefix("rout"), None);
    }

    #[test]
    fn upstream_wire_model_keeps_openrouter_meta_routers_in_its_namespace() {
        assert_eq!(
            upstream_router_wire_model("openrouter", "auto"),
            "openrouter/auto"
        );
        assert_eq!(
            upstream_router_wire_model("openrouter", "anthropic/claude-sonnet-4"),
            "anthropic/claude-sonnet-4"
        );
        assert_eq!(upstream_router_wire_model("litellm", "auto"), "auto");
        assert_eq!(upstream_router_wire_model("local", "llama3.2"), "llama3.2");
    }

    #[test]
    fn apple_foundationmodel_routes_to_local() {
        let t = bare("openai");
        assert_eq!(t.route("apple-foundationmodel").0, "local");
    }

    #[test]
    fn absolute_local_model_paths_route_to_local() {
        let t = bare("openai");
        let requested = "/Users/ryu/models/gemma-4-E2B-it-Q4_K_M.gguf";
        assert_eq!(
            t.route(requested),
            ("local".to_owned(), requested.to_owned())
        );
    }

    #[test]
    fn builtin_prefix_order_puts_classify_gemma_before_local_gemma() {
        let t = bare("openai");
        // The classify-tier classifier reaches its own dedicated sidecar…
        assert_eq!(t.route("gemma-3-270m-it-qat-Q4_0").0, "classify");
        // …while every other gemma still reaches the resident chat engine.
        assert_eq!(t.route("gemma-3-12b-it").0, "local");
        assert_eq!(t.route("gemma2:9b").0, "local");

        // `route` takes the FIRST prefix hit, not the longest, so this is an
        // ORDERING assertion, not a matching one: a future alphabetical tidy-up
        // of `builtin_prefixes` would put "gemma" above "gemma-3-270m" and send
        // the classifier to `local` while every assertion above still *looked*
        // reasonable. Pin the positions directly so that edit fails here.
        let prefixes = builtin_prefixes();
        let idx = |p: &str| {
            prefixes
                .iter()
                .position(|(prefix, _)| prefix == p)
                .unwrap_or_else(|| panic!("builtin prefix {p} missing"))
        };
        assert!(
            idx("gemma-3-270m") < idx("gemma"),
            "gemma-3-270m→classify must precede gemma→local; route() is first-match, not longest-match"
        );
    }

    /// Pins the precedence the builtin table's own ORDER-IS-LOAD-BEARING comment
    /// does NOT cover: steps 1-2 outrank the entire builtin table. A broad operator
    /// prefix silently re-homes infrastructure routes underneath it — most sharply
    /// `gemma-3-270m` → `classify`, whose capture sends the guardrail classifier to
    /// a paid hosted provider. The exact-entry seed is the only defense, so both
    /// halves are asserted here.
    #[test]
    fn user_model_map_outranks_the_builtin_table() {
        let mut model_map = HashMap::new();
        model_map.insert("gemma".to_string(), ("openrouter".to_string(), None));
        let captured = tables(
            model_map.clone(),
            HashMap::new(),
            Vec::new(),
            HashMap::new(),
            Vec::new(),
            0.0,
            "openai",
        );
        // Step 2 (longest user prefix) beats the builtin `gemma-3-270m`→`classify`
        // row entirely — the builtin table is never consulted.
        assert_eq!(captured.route("gemma-3-270m-it-qat-Q4_0").0, "openrouter");

        // An EXACT entry (step 1) is what survives that: it is evaluated before the
        // prefix scan, so seeding one restores the classify route.
        model_map.insert(
            "gemma-3-270m-it-qat-Q4_0".to_string(),
            ("classify".to_string(), None),
        );
        let seeded = tables(
            model_map,
            HashMap::new(),
            Vec::new(),
            HashMap::new(),
            Vec::new(),
            0.0,
            "openai",
        );
        assert_eq!(seeded.route("gemma-3-270m-it-qat-Q4_0").0, "classify");
        // …while the operator's own broad mapping still applies to everything else.
        assert_eq!(seeded.route("gemma-3-12b-it").0, "openrouter");
    }

    #[test]
    fn openrouter_prefix_routes_any_slug() {
        let t = bare("openai");
        assert_eq!(
            t.route("openrouter/mistralai/mistral-7b-instruct").0,
            "openrouter"
        );
        assert_eq!(t.route("gemini-2.5-pro").0, "genai");
    }

    #[test]
    fn openrouter_pareto_code_routes_to_openrouter() {
        let t = bare("openai");
        assert_eq!(t.route("openrouter/pareto-code").0, "openrouter");
    }

    #[test]
    fn cloudflare_workers_ai_ids_route_to_the_cloudflare_pool() {
        let t = bare("openai");
        // Workers AI namespaces its whole catalog under `@cf/<vendor>/<id>`.
        assert_eq!(
            t.route("@cf/meta/llama-3.1-8b-instruct"),
            (
                "cloudflare".to_string(),
                "@cf/meta/llama-3.1-8b-instruct".to_string()
            )
        );
        assert_eq!(
            t.route("@cf/mistral/mistral-7b-instruct-v0.2").0,
            "cloudflare"
        );
        assert_eq!(t.route("@cf/qwen/qwen1.5-14b-chat-awq").0, "cloudflare");
    }

    /// The exact model ids Core puts in front of users for the pool-backed
    /// managed providers still route to the pool those rows claim.
    ///
    /// The alias list is a literal COPY of `suggested_models` on the five
    /// `managed-<pool>` rows in `apps/core/src/pi_config/mod.rs`. Core is a
    /// separate crate that cannot import this table, and the failure mode of a
    /// disagreement is silent and financial: an id this table stops claiming
    /// falls through to `default_provider` — the retail pool — while the picker
    /// still calls it "Ryu Fast" and the user's Fast grant goes untouched.
    ///
    /// So the duplication is the point. If a row here has to change to keep this
    /// test green, the corresponding Core row is wrong and must change with it.
    #[test]
    fn the_model_ids_core_offers_for_each_pool_still_route_to_that_pool() {
        let t = bare("openai");
        for (model, pool, upstream) in [
            // managed-cloudflare → "Ryu Fast"
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
            // managed-bedrock → "Ryu Frontier"
            (
                "ryu-frontier/lite",
                "bedrock",
                "meta.llama3-1-70b-instruct-v1:0",
            ),
            ("ryu-frontier/standard", "bedrock", "amazon.nova-pro-v1:0"),
            (
                "ryu-frontier/max",
                "bedrock",
                "anthropic.claude-3-5-sonnet-20241022-v2:0",
            ),
            // managed-vertex → "Ryu Vision"
            ("ryu-vision/lite", "vertex", "google/gemini-2.5-flash"),
            ("ryu-vision/max", "vertex", "google/gemini-2.5-pro"),
            // managed-openai-credits → "Ryu Reasoning"
            ("ryu-reasoning/lite", "openai-credits", "o4-mini"),
            ("ryu-reasoning/standard", "openai-credits", "o3"),
            ("ryu-reasoning/max", "openai-credits", "gpt-5"),
            // managed-anthropic-credits → "Ryu Code"
            ("ryu-code/lite", "anthropic-credits", "claude-haiku-4-5"),
            (
                "ryu-code/standard",
                "anthropic-credits",
                "claude-sonnet-4-5",
            ),
            ("ryu-code/max", "anthropic-credits", "claude-opus-4-5"),
        ] {
            assert_eq!(
                t.route(model),
                (pool.to_string(), upstream.to_string()),
                "Core offers `{model}` as {pool} supply"
            );
            // The usage/ledger attribution maps the served id back to the alias.
            assert_eq!(pool_model_alias_for(pool, upstream), Some(model));
        }
        // And the table holds nothing Core does not offer.
        assert_eq!(POOL_MODEL_ALIASES.len(), 14);
    }

    /// The pre-alias forms Core used to offer still route to the same pool and
    /// upstream id (saved configs and free-typed ids keep working), even though
    /// they are no longer advertised.
    #[test]
    fn pre_alias_pool_model_ids_still_route_for_back_compat() {
        let t = bare("openai");
        for (model, pool) in [
            ("@cf/meta/llama-3.1-8b-instruct", "cloudflare"),
            ("@cf/mistral/mistral-7b-instruct-v0.2", "cloudflare"),
            ("@cf/qwen/qwen1.5-14b-chat-awq", "cloudflare"),
            ("anthropic.claude-3-5-sonnet-20241022-v2:0", "bedrock"),
            ("amazon.nova-pro-v1:0", "bedrock"),
            ("meta.llama3-1-70b-instruct-v1:0", "bedrock"),
        ] {
            assert_eq!(t.route(model), (pool.to_string(), model.to_string()));
        }
        for (model, pool, upstream) in [
            (
                "ryu-code/claude-sonnet-4-5",
                "anthropic-credits",
                "claude-sonnet-4-5",
            ),
            (
                "ryu-code/claude-opus-4-5",
                "anthropic-credits",
                "claude-opus-4-5",
            ),
            (
                "ryu-code/claude-haiku-4-5",
                "anthropic-credits",
                "claude-haiku-4-5",
            ),
            ("ryu-reasoning/o3", "openai-credits", "o3"),
            ("ryu-reasoning/o4-mini", "openai-credits", "o4-mini"),
            ("ryu-reasoning/gpt-5", "openai-credits", "gpt-5"),
            (
                "ryu-vision/google/gemini-2.5-pro",
                "vertex",
                "google/gemini-2.5-pro",
            ),
            (
                "ryu-vision/google/gemini-2.5-flash",
                "vertex",
                "google/gemini-2.5-flash",
            ),
        ] {
            assert_eq!(t.route(model), (pool.to_string(), upstream.to_string()));
        }
    }

    #[test]
    fn pool_model_aliases_are_exact_case_insensitive_and_slot_keyed() {
        let t = bare("openai");
        assert_eq!(
            t.route("RYU-Code/Max"),
            (
                "anthropic-credits".to_string(),
                "claude-opus-4-5".to_string()
            )
        );
        assert_eq!(pool_model_alias_id("RYU-Code/Max"), Some("ryu-code/max"));
        // Exact only: a suffix or a missing size is not an alias.
        assert_eq!(pool_model_alias_route("ryu-fast/lite-2"), None);
        assert_eq!(pool_model_alias_route("ryu-fast/"), None);
        assert_eq!(t.route("ryu-fast/lite-2").0, "openai");
        // An unknown size in a namespaced tier keeps the old namespace behavior.
        assert_eq!(
            t.route("ryu-code/ultra"),
            ("anthropic-credits".to_string(), "ultra".to_string())
        );
        // The reverse map is keyed on the managed SLOT: the same upstream id on
        // a BYOK slot is the user's own traffic and keeps its real name.
        assert_eq!(pool_model_alias_for("anthropic", "claude-opus-4-5"), None);
        assert_eq!(pool_model_alias_for("openai", "o3"), None);
        assert_eq!(
            pool_model_alias_for("openrouter", "google/gemini-2.5-pro"),
            None
        );
        // Aliases sit in namespaces no vendor uses: none is a builtin-prefix id.
        for (alias, _, _) in POOL_MODEL_ALIASES {
            assert!(alias.starts_with("ryu-"));
            assert!(!builtin_prefixes()
                .iter()
                .any(|(prefix, _)| alias.starts_with(prefix.as_str())));
        }
    }

    #[test]
    fn pool_model_equivalents_are_exact_routable_and_openrouter_ids() {
        let t = bare("openrouter");
        for (id, slot, upstream) in SEED_OWN_SUPPLY_EQUIVALENTS {
            // The left id is Ryu Router traffic today.
            assert_eq!(t.route(id).0, "openrouter", "{id}");
            // The upstream is an aliased (priced, routable) own-supply id, and
            // the alias routes to exactly this slot + upstream.
            let alias = pool_model_alias_for(slot, upstream)
                .unwrap_or_else(|| panic!("{id}: {slot}/{upstream} has no alias"));
            assert_eq!(
                t.route(alias),
                ((*slot).to_string(), (*upstream).to_string()),
                "{id}"
            );
            // Both directions agree, and only for the own-supply slot.
            assert_eq!(
                pool_model_equivalents(id).next(),
                Some((*slot, *upstream)),
                "{id}"
            );
            assert_eq!(pool_model_equivalent_id(slot, upstream), Some(*id));
            assert_eq!(pool_model_equivalent_id("openrouter", upstream), None);
        }
        assert_eq!(
            pool_model_equivalents("Anthropic/Claude-Sonnet-4.5").next(),
            Some(("anthropic-credits", "claude-sonnet-4-5"))
        );
        assert_eq!(pool_model_equivalents("openrouter/auto").next(), None);
        assert_eq!(
            pool_model_equivalents("anthropic/claude-sonnet-4").next(),
            None
        );
        // A BYOK slot serving the same bare id keeps its name.
        assert_eq!(
            pool_model_equivalent_id("anthropic", "claude-sonnet-4-5"),
            None
        );
        assert_eq!(pool_model_equivalent_id("openai", "o3"), None);
    }

    #[test]
    fn a_slot_override_resolves_an_alias_on_its_own_slot_only() {
        let t = bare("openrouter");
        assert_eq!(
            t.route_modality(
                "chat",
                "anything",
                Some("anthropic-credits"),
                Some("ryu-code/max")
            ),
            (
                "anthropic-credits".to_string(),
                "claude-opus-4-5".to_string()
            )
        );
        assert_eq!(
            t.route_modality("chat", "ryu-code/max", Some("openai"), None),
            ("openai".to_string(), "ryu-code/max".to_string())
        );
    }

    #[test]
    fn pool_default_alias_prefers_standard_then_the_first_size() {
        assert_eq!(
            pool_default_alias_for("anthropic-credits"),
            Some("ryu-code/standard")
        );
        assert_eq!(
            pool_default_alias_for("cloudflare"),
            Some("ryu-fast/standard")
        );
        // Ryu Vision has no `standard` size: its first (lite) alias stands in.
        assert_eq!(pool_default_alias_for("vertex"), Some("ryu-vision/lite"));
        // BYOK / untiered slots sell no tier.
        assert_eq!(pool_default_alias_for("anthropic"), None);
        assert_eq!(pool_default_alias_for("openrouter"), None);
    }

    /// An operator `model_map` entry still outranks an alias.
    #[test]
    fn operator_model_map_outranks_a_pool_model_alias() {
        let mut model_map = HashMap::new();
        model_map.insert(
            "ryu-code/max".to_string(),
            ("anthropic".to_string(), Some("claude-opus-4-5".to_string())),
        );
        let t = tables(
            model_map,
            HashMap::new(),
            Vec::new(),
            HashMap::new(),
            Vec::new(),
            0.0,
            "openai",
        );
        assert_eq!(t.route("ryu-code/max").0, "anthropic");
        assert_eq!(t.route("ryu-code/lite").0, "anthropic-credits");
    }

    /// The namespaces reach the donated slots WITHOUT taking a single id that
    /// routes somewhere today. This is the whole reason they are namespaces and
    /// not prefixes: the bare vendor ids belong to BYOK slots and OpenRouter.
    #[test]
    fn pool_namespaces_do_not_capture_byok_or_openrouter_ids() {
        let t = bare("openrouter");
        assert_eq!(t.route("claude-sonnet-4-5").0, "anthropic");
        assert_eq!(t.route("gpt-5").0, "openai");
        assert_eq!(t.route("o3").0, "openai");
        assert_eq!(t.route("o4-mini").0, "openai");
        assert_eq!(t.route("google/gemini-2.5-pro").0, "openrouter");
        assert_eq!(t.route("gemini-2.5-pro").0, "genai");
        // No builtin prefix row points at a namespaced slot either; the
        // namespace step is the only compiled-in way in.
        assert!(!builtin_prefixes()
            .iter()
            .any(|(_, p)| p == "anthropic-credits" || p == "openai-credits" || p == "vertex"));
    }

    #[test]
    fn pool_namespace_matching_is_anchored_case_insensitive_and_non_empty() {
        let t = bare("openai");
        // Namespace case is forgiven; the upstream id's case is preserved.
        assert_eq!(
            t.route("Ryu-Code/Claude-X"),
            ("anthropic-credits".to_string(), "Claude-X".to_string())
        );
        // A bare namespace is not a model: it takes the normal order.
        assert_eq!(t.route("ryu-code/").0, "openai");
        // Anchored at position 0 — a namespace inside an id is just text.
        assert_eq!(
            t.route("openrouter/ryu-code/claude-sonnet-4-5").0,
            "openrouter"
        );
        // Multi-byte input around the boundary must not panic on slicing.
        assert_eq!(t.route("ryu-codé/x").0, "openai");
        assert_eq!(pool_namespace_route("ryu-co"), None);
    }

    /// An operator's `model_map` still outranks the compiled-in namespace, the
    /// same precedence every builtin route has.
    #[test]
    fn operator_model_map_outranks_a_pool_namespace() {
        let mut model_map = HashMap::new();
        model_map.insert(
            "ryu-code/claude-sonnet-4-5".to_string(),
            (
                "bedrock".to_string(),
                Some("anthropic.claude-3-5-sonnet-20241022-v2:0".to_string()),
            ),
        );
        let t = tables(
            model_map,
            HashMap::new(),
            Vec::new(),
            HashMap::new(),
            Vec::new(),
            0.0,
            "openai",
        );
        assert_eq!(t.route("ryu-code/claude-sonnet-4-5").0, "bedrock");
        assert_eq!(t.route("ryu-code/claude-opus-4-5").0, "anthropic-credits");
    }

    /// A/B eval routing must not reassign an explicit pool choice: it would send
    /// the namespaced id verbatim to another candidate and bill the wrong pool.
    #[test]
    fn eval_route_leaves_pool_namespaced_ids_to_route() {
        let t = tables(
            HashMap::new(),
            HashMap::new(),
            Vec::new(),
            HashMap::new(),
            vec!["openai".to_string(), "openrouter".to_string()],
            0.5,
            "openai",
        );
        assert_eq!(t.eval_route("ryu-reasoning/o3", &|_| None, &|| 0), None);
        assert_eq!(t.eval_route("ryu-fast/max", &|_| None, &|| 0), None);
        assert_eq!(t.eval_route("ryu-frontier/lite", &|_| None, &|| 0), None);
        assert!(t.eval_route("gpt-5", &|_| None, &|| 0).is_some());
    }

    #[test]
    fn bedrock_vendor_ids_route_to_the_bedrock_pool() {
        let t = bare("openai");
        // One representative id per served vendor family. The `anthropic.` case
        // is the one the pre-fix table missed most quietly: it does NOT start
        // with `claude-`, so it fell through to `default_provider`.
        assert_eq!(
            t.route("anthropic.claude-3-5-sonnet-20241022-v2:0"),
            (
                "bedrock".to_string(),
                "anthropic.claude-3-5-sonnet-20241022-v2:0".to_string()
            )
        );
        assert_eq!(t.route("amazon.nova-pro-v1:0").0, "bedrock");
        assert_eq!(t.route("meta.llama3-1-70b-instruct-v1:0").0, "bedrock");
        assert_eq!(t.route("mistral.mistral-large-2407-v1:0").0, "bedrock");
        assert_eq!(t.route("mistral.mixtral-8x7b-instruct-v0:1").0, "bedrock");
    }

    /// No builtin prefix routes to a donated pool by itself. The pools are aimed
    /// by an operator (`routing.model_map` / `default_provider`), never claimed at
    /// compile time.
    #[test]
    fn google_ids_still_fall_through_to_the_default_provider() {
        // A `("google/", "vertex")` row looked safe against the other BUILTIN rows
        // — and that is the wrong axis. Step 3 runs before step 4, so what such a
        // row actually takes is the ids that previously fell through to
        // `default_provider`. `google/gemini-2.5-pro` is a valid OpenRouter id, and
        // `openrouter` is an exposed `default_provider` value, so the row broke a
        // working id: unavailable when `vertex` was unconfigured, and silently
        // spending the DONATED allowance on retail-aimed traffic when it was.
        let t = bare("openrouter");
        assert_eq!(
            t.route("google/gemini-2.5-pro"),
            (
                "openrouter".to_string(),
                "google/gemini-2.5-pro".to_string()
            )
        );
        assert_eq!(t.route("google/gemini-2.5-flash").0, "openrouter");
        // The native `generateContent` path form is likewise unclaimed.
        assert_ne!(
            t.route("publishers/google/models/gemini-2.5-flash").0,
            "vertex"
        );
    }

    /// The bare `gemini-*` ids stay with `genai`. This is the money-shaped half of
    /// the Vertex wiring: `("gemini-", "vertex")` above the existing row would
    /// silently move every current Gemini request onto donated credit, and below
    /// it would never fire at all (first-match, not longest-match).
    #[test]
    fn bare_gemini_ids_stay_on_genai_not_the_vertex_pool() {
        let t = bare("openai");
        assert_eq!(t.route("gemini-1.5-pro").0, "genai");
        assert_eq!(t.route("gemini-2.5-flash").0, "genai");
        assert_eq!(
            provider_of(&builtin_prefixes(), "gemini-"),
            "genai",
            "the gemini- row must not be re-homed to the vertex pool"
        );
    }

    /// The donated OpenAI pool has NO builtin row, and that absence is the design
    /// (see `config::OPENAI_CREDITS_PROVIDER_ID`). Pinned as a test because the
    /// obvious "fix" — pointing `gpt-` at the pool — would convert every BYOK
    /// caller's own-key traffic into donated spend, which is exactly what the
    /// separate registry id exists to prevent.
    #[test]
    fn no_builtin_prefix_routes_to_the_donated_openai_pool() {
        let prefixes = builtin_prefixes();
        assert!(
            !prefixes
                .iter()
                .any(|(_, provider)| provider == "openai-credits"),
            "the donated OpenAI pool is reachable via its `ryu-reasoning/` namespace \
             or model_map/default_provider only"
        );
        let t = bare("openai");
        for model in ["gpt-4o", "gpt-5", "o1-preview", "o3-mini", "o4-mini"] {
            assert_eq!(
                t.route(model).0,
                "openai",
                "{model} must keep routing to the BYOK openai slot"
            );
        }
    }

    /// Resolve which provider a builtin prefix maps to, for the index/identity
    /// assertions that behavior alone cannot make.
    fn provider_of(prefixes: &[(String, String)], prefix: &str) -> String {
        prefixes
            .iter()
            .find(|(p, _)| p == prefix)
            .map(|(_, provider)| provider.clone())
            .unwrap_or_else(|| panic!("builtin prefix {prefix} missing"))
    }

    /// The positional twin of `builtin_prefix_order_puts_classify_gemma_before_local_gemma`,
    /// for the one new row that shares a prefix with an existing one. Asserted by
    /// INDEX, not just by behavior: an alphabetical tidy-up of the table would put
    /// `mistral` above `mistral.` while every behavioral assertion elsewhere still
    /// looked reasonable, and Bedrock's Mistral models would silently be asked of
    /// the resident local engine.
    #[test]
    fn builtin_prefix_order_puts_bedrock_mistral_before_local_mistral() {
        let prefixes = builtin_prefixes();
        let idx = |p: &str| {
            prefixes
                .iter()
                .position(|(prefix, _)| prefix == p)
                .unwrap_or_else(|| panic!("builtin prefix {p} missing"))
        };
        assert!(
            idx("mistral.") < idx("mistral"),
            "mistral.→bedrock must precede mistral→local; route() is first-match, not longest-match"
        );
    }

    /// Regression guard for the ids that already routed before the pool rows were
    /// added. The new prefixes are all anchored at position 0, so none of these
    /// can be captured — but "added a broad prefix, silently re-homed the local
    /// engine" is exactly the failure this table invites.
    #[test]
    fn pool_prefixes_do_not_capture_existing_routes() {
        let t = bare("openai");
        assert_eq!(t.route("llama3.2:latest").0, "local");
        assert_eq!(t.route("mistral:latest").0, "local");
        assert_eq!(t.route("mixtral-8x7b").0, "local");
        assert_eq!(t.route("claude-sonnet-4-5").0, "anthropic");
        assert_eq!(t.route("gpt-4o").0, "openai");
        assert_eq!(t.route("o3-mini").0, "openai");
        assert_eq!(t.route("gemini-1.5-pro").0, "genai");
        assert_eq!(t.route("mistral.mistral-large-2407-v1:0").0, "bedrock");
        assert_eq!(t.route("gemma-3-270m-it-qat-Q4_0").0, "classify");
        assert_eq!(
            t.route("openrouter/mistralai/mistral-7b-instruct").0,
            "openrouter"
        );
        // Still the default: nothing about the new rows makes an unknown id pooled.
        assert_eq!(t.route("some-unknown-model").0, "openai");
    }

    #[test]
    fn exact_map_and_longest_prefix_win_over_builtin() {
        let mut model_map = HashMap::new();
        model_map.insert(
            "gpt-4o".to_string(),
            ("local".to_string(), Some("gemma".to_string())),
        );
        model_map.insert("gpt-".to_string(), ("openrouter".to_string(), None));
        let t = tables(
            model_map,
            HashMap::new(),
            Vec::new(),
            HashMap::new(),
            Vec::new(),
            0.0,
            "openai",
        );
        // Exact hit rewrites the model and wins over the builtin gpt-→openai.
        assert_eq!(
            t.route("gpt-4o"),
            ("local".to_string(), "gemma".to_string())
        );
        // Longest user prefix ("gpt-") wins over builtin for a non-exact model.
        assert_eq!(
            t.route("gpt-4-turbo"),
            ("openrouter".to_string(), "gpt-4-turbo".to_string())
        );
    }

    #[test]
    fn default_provider_when_nothing_matches() {
        let t = bare("local");
        assert_eq!(
            t.route("some-unknown-model"),
            ("local".to_string(), "some-unknown-model".to_string())
        );
    }

    #[test]
    fn route_modality_slot_then_map_then_fallback() {
        let mut modality_map = HashMap::new();
        modality_map.insert(
            "image".to_string(),
            ("openai".to_string(), Some("dall-e-3".to_string())),
        );
        let t = tables(
            HashMap::new(),
            modality_map,
            Vec::new(),
            HashMap::new(),
            Vec::new(),
            0.0,
            "local",
        );
        // Slot override wins.
        assert_eq!(
            t.route_modality("image", "x", Some("fal"), Some("flux")),
            ("fal".to_string(), "flux".to_string())
        );
        // Then the modality map (pinned model wins over caller model).
        assert_eq!(
            t.route_modality("image", "whatever", None, None),
            ("openai".to_string(), "dall-e-3".to_string())
        );
        // No entry ⇒ fall through to model routing (gpt-→openai builtin).
        assert_eq!(t.route_modality("tts", "gpt-4o", None, None).0, "openai");
    }

    #[test]
    fn fallback_chain_pins_primary_then_sorts_by_tier() {
        let mut tiers = HashMap::new();
        tiers.insert("openai".to_string(), 0u8);
        tiers.insert("local".to_string(), 1u8);
        tiers.insert("openrouter".to_string(), 2u8);
        let t = tables(
            HashMap::new(),
            HashMap::new(),
            vec![
                "openrouter".to_string(),
                "local".to_string(),
                "openai".to_string(),
            ],
            tiers,
            Vec::new(),
            0.0,
            "openai",
        );
        // Primary stays first even though it is the most expensive tier.
        assert_eq!(
            t.fallback_chain("openrouter"),
            vec![
                "openrouter".to_string(),
                "openai".to_string(),
                "local".to_string()
            ]
        );
    }

    #[test]
    fn fallback_chain_empty_tiers_preserves_order() {
        let t = tables(
            HashMap::new(),
            HashMap::new(),
            vec!["local".to_string(), "openai".to_string()],
            HashMap::new(),
            Vec::new(),
            0.0,
            "openai",
        );
        assert_eq!(
            t.fallback_chain("anthropic"),
            vec![
                "anthropic".to_string(),
                "local".to_string(),
                "openai".to_string()
            ]
        );
    }

    fn ab_tables(explore_ratio: f32) -> RoutingTables {
        tables(
            HashMap::new(),
            HashMap::new(),
            Vec::new(),
            HashMap::new(),
            vec!["openai".to_string(), "anthropic".to_string()],
            explore_ratio,
            "openai",
        )
    }

    #[test]
    fn eval_route_none_when_under_two_candidates() {
        let t = bare("openai");
        assert!(t.eval_route("gpt-4o", &|_| Some(0.5), &|| 0).is_none());
    }

    #[test]
    fn eval_route_explores_unscored_candidate_first() {
        let t = ab_tables(0.0);
        let provider = t
            .eval_route(
                "gpt-4o",
                &|p| if p == "openai" { Some(0.9) } else { None },
                &|| 0,
            )
            .expect("eval routing active");
        assert_eq!(provider, "anthropic");
    }

    #[test]
    fn eval_route_exploits_leader_when_all_scored() {
        let t = ab_tables(0.0);
        for _ in 0..20 {
            let provider = t
                .eval_route(
                    "gpt-4o",
                    &|p| match p {
                        "openai" => Some(0.3),
                        "anthropic" => Some(0.8),
                        _ => None,
                    },
                    &|| 0,
                )
                .expect("eval routing active");
            assert_eq!(provider, "anthropic");
        }
    }

    #[test]
    fn eval_route_reserves_traffic_for_exploration() {
        let t = ab_tables(0.25);
        let counter = std::sync::atomic::AtomicU64::new(0);
        let mut leader_hits = 0;
        let mut explore_hits = 0;
        for _ in 0..100 {
            let provider = t
                .eval_route(
                    "gpt-4o",
                    &|p| match p {
                        "openai" => Some(0.3),
                        "anthropic" => Some(0.8),
                        _ => None,
                    },
                    &|| counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                )
                .expect("eval routing active");
            if provider == "anthropic" {
                leader_hits += 1;
            } else {
                explore_hits += 1;
            }
        }
        assert!(explore_hits > 0, "expected some exploration traffic");
        assert!(leader_hits > explore_hits, "leader should win most traffic");
    }

    // ── Classifier helpers ────────────────────────────────────────────────────

    #[test]
    fn parse_choice_reads_plain_number() {
        assert_eq!(parse_choice("1", 2), Some(1));
        assert_eq!(parse_choice("2", 2), Some(2));
        assert_eq!(parse_choice("0", 2), Some(0));
    }

    #[test]
    fn parse_choice_tolerates_surrounding_text() {
        assert_eq!(parse_choice("Rule 2 best fits.", 2), Some(2));
        assert_eq!(parse_choice("  1\n", 2), Some(1));
    }

    #[test]
    fn parse_choice_rejects_out_of_range_or_garbage() {
        assert_eq!(parse_choice("5", 2), None);
        assert_eq!(parse_choice("none", 2), None);
        assert_eq!(parse_choice("", 2), None);
    }

    #[test]
    fn build_prompt_enumerates_one_based() {
        let p = build_prompt(&descriptions(), "fix my rust code");
        assert!(p.contains("1. coding"));
        assert!(p.contains("2. chit-chat"));
        assert!(p.contains("fix my rust code"));
    }

    #[test]
    fn keyword_match_finds_significant_word() {
        assert_eq!(
            keyword_match(&descriptions(), "help me with coding please"),
            Some(0)
        );
        assert_eq!(
            keyword_match(&descriptions(), "nothing relevant here"),
            None
        );
    }

    #[test]
    fn last_user_message_picks_latest_string() {
        let msgs = json!([
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "reply"},
            {"role": "user", "content": "second"}
        ]);
        assert_eq!(last_user_message(&msgs).as_deref(), Some("second"));
    }

    #[test]
    fn last_user_message_joins_multimodal_parts() {
        let msgs = json!([
            {"role": "user", "content": [
                {"type": "text", "text": "describe"},
                {"type": "image_url", "image_url": {"url": "data:..."}},
                {"type": "text", "text": "this"}
            ]}
        ]);
        assert_eq!(last_user_message(&msgs).as_deref(), Some("describe this"));
    }

    #[test]
    fn weighted_index_respects_relative_weights_and_ignores_invalid_values() {
        assert_eq!(weighted_index(&[1.0, 0.0, f32::NAN, -1.0], 0), Some(0));
        assert_eq!(weighted_index(&[1.0, 3.0], 0), Some(0));
        assert_eq!(weighted_index(&[1.0, 3.0], u64::MAX), Some(1));
        assert_eq!(weighted_index(&[0.0, f32::INFINITY], 42), None);
    }

    #[test]
    fn stage_target_uses_errors_and_progress_with_a_default_for_ambiguous_history() {
        let error_history = json!([
            {"role": "tool", "content": "command failed with error"}
        ]);
        assert_eq!(
            stage_target(&error_history, 3, 0.5, false),
            StageTarget::Capable
        );

        let progress_history = json!([
            {"role": "assistant", "content": "applied patch; tests passed"}
        ]);
        assert_eq!(
            stage_target(&progress_history, 3, 0.5, true),
            StageTarget::Efficient
        );

        let ambiguous = json!([{"role": "user", "content": "hello"}]);
        assert_eq!(stage_target(&ambiguous, 3, 0.5, true), StageTarget::Capable);
        assert_eq!(
            stage_target(&ambiguous, 3, 0.5, false),
            StageTarget::Efficient
        );
    }
}
