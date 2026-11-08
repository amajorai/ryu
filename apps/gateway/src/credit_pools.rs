//! Credit-pool attribution: which SEGREGATED supply of donated inference credit
//! a metered request bills against.
//!
//! **This table is a MIRROR, not a source of truth.** The catalog lives in
//! `packages/auth/src/lib/credit-pools.ts` (`CREDIT_POOLS[*].gatewayProviders`),
//! beside the plan catalog, because "what a granted dollar may be spent on" is a
//! control-plane decision. The gateway keeps a copy only because it must tag a
//! debit at the moment the response is served, with no round-trip. The two must
//! be edited together.
//!
//! WHY POOLS EXIST (the invariant this file serves): Ryu runs on donated provider
//! credit — allowances at Microsoft Azure, Cloudflare Workers AI, Google Cloud
//! Vertex AI, OpenAI and Anthropic, each with its own ceiling and its own donor accounting. A
//! dollar of Cloudflare buys roughly 10–20× the tokens a frontier dollar does.
//! So a grant carries a pool and a debit carries the pool that SERVED it, which
//! keeps per-supplier burn-down exact.
//!
//! What a grant may PAY for is broader than its pool (see
//! [`is_own_supply_pool`]): free credit of any pool pays for any request Ryu
//! serves from its own supply, and for nothing served by OpenRouter or a BYOK
//! key. Issuance is still capped per pool by the donated-allowance ceilings and
//! campaign budgets on the control plane.
//!
//! TWO ROWS ARE NOT NAMED AFTER THEIR VENDOR, and that is deliberate: donated
//! OpenAI supply is `openai-credits`, not `openai`, because `openai` is already
//! the BYOK pass-through slot. Same story for `vertex` vs `genai`. Merging either
//! pair would make a caller's own-key traffic debit the donation.
//!
//! The strings below are DURABLE DATABASE VALUES, not internal identifiers: they
//! are written into `CreditGrant.pool` / `CreditLedger.pool` rows and they travel
//! to and from the control plane verbatim as JSON map KEYS (serde's
//! `rename_all = "camelCase"` renames struct fields, NOT map keys). Renaming one
//! is a data migration, not an edit here.
//!
//! A near-miss provider string fails SILENTLY in the money-losing direction:
//! [`pool_for_gateway_provider`] returns `None`, the request draws no grant, and
//! it never appears in per-pool burn. `pool_ids_all_resolve_in_the_registry`
//! below is what turns that into a compile-time-ish failure instead.

/// Gateway registry id → pool id. The left column is exactly what
/// `Provider::name()` returns in [`crate::providers`]; the right column is a
/// `CreditPoolId` from `credit-pools.ts`.
///
/// A provider id may belong to at most one pool — two pools claiming the same
/// provider would make burn-down attribution ambiguous, and the ambiguity would
/// only ever surface as money in the wrong bucket. `no_provider_is_claimed_twice`
/// asserts it.
///
/// ROW ORDER IS THE TIE-BREAK: `openrouter/auto` with free credit picks the
/// pool the caller holds the most of, ties going to the earliest row
/// ([`own_supply_slots`]). Azure is first because it is Ryu's default free pool.
const POOL_BY_GATEWAY_PROVIDER: &[(&str, &str)] = &[
    // Microsoft Azure (Azure OpenAI / AI Foundry) — Ryu's $100,000 Azure
    // startup credit and the DEFAULT free pool. Suffixed for the same reason
    // as `openai-credits`, so a future BYOK `azure` slot stays untagged.
    (crate::config::AZURE_CREDITS_PROVIDER_ID, "azure-credits"),
    // Cloudflare Workers AI — the cheap open-model supply ("Ryu Fast"). Free-tier,
    // business-card and referral grants land here.
    (crate::config::CLOUDFLARE_PROVIDER_ID, "cloudflare"),
    // AWS Bedrock is deliberately ABSENT: Ryu's AWS credit pays for its own
    // VMs, not free inference, so the `bedrock` slot is no longer own supply.
    // Its traffic is unattributed (paid credit only) and the control plane keeps
    // `bedrock` only as a retired pool id on existing grants.
    // OpenRouter pass-through — no donated allowance behind it, so it is present
    // purely so retail traffic is still ATTRIBUTABLE in burn dashboards. We never
    // advertise grants against supply we buy at retail, but a debit that carries
    // this tag still costs nothing extra: with no `openrouter` grant on the
    // wallet, the spend falls through to the subscription/top-up buckets exactly
    // as it did before pools existed.
    ("openrouter", "openrouter"),
    // Google Cloud Vertex AI — donated frontier multimodal supply ("Ryu Vision").
    // Distinct from `genai`, which is the AI Studio / Gemini API surface an
    // operator points at their OWN key. Same model family, different endpoint,
    // different account to burn down — so `genai` stays UNTAGGED and only the
    // `vertex` slot draws this grant.
    (crate::config::VERTEX_PROVIDER_ID, "vertex"),
    // OpenAI — donated frontier reasoning supply ("Ryu Reasoning"). READ THE
    // LEFT COLUMN: it is `openai-credits`, NOT `openai`, and the difference is
    // the whole point. `openai` is the BYOK / pass-through slot serving whatever
    // key the node operator configured; tagging it would make every one of those
    // requests debit this donation for spend it never funded. The two are
    // separate registry ids precisely so this table can tell them apart —
    // `byok_openai_is_never_attributed_to_the_donated_pool` pins it.
    (crate::config::OPENAI_CREDITS_PROVIDER_ID, "openai-credits"),
    // Anthropic — Ryu's own first-party account ("Ryu Frontier Direct"). As with
    // OpenAI, the suffixed id is the pool; BYOK `anthropic` stays untagged.
    (
        crate::config::ANTHROPIC_CREDITS_PROVIDER_ID,
        "anthropic-credits",
    ),
];

/// The pool a metered request bills against, from the registry id of the provider
/// that ACTUALLY served it (`provider.name()` at the debit sites).
///
/// `None` means "not pool-attributed", and it is the correct default for every
/// provider an operator has not tagged: the debit then behaves exactly as it did
/// before pools existed — no grant is reachable and the spend falls through to
/// the subscription and top-up buckets. That is why adding a pool can never
/// retroactively change how existing traffic is billed.
///
/// Linear scan over a handful of rows on purpose: a `HashMap` behind a `OnceLock`
/// would be slower for this size and would trade a `const` for lazy init.
pub fn pool_for_gateway_provider(provider_name: &str) -> Option<&'static str> {
    POOL_BY_GATEWAY_PROVIDER
        .iter()
        .find(|(provider, _)| *provider == provider_name)
        .map(|(_, pool)| *pool)
}

/// The one pool that is NOT Ryu's own supply: OpenRouter is retail
/// pass-through, tagged only so its traffic is attributable in burn dashboards.
const RETAIL_POOL: &str = "openrouter";

/// Whether `pool` is Ryu's OWN (donated) supply — every pool but the retail
/// OpenRouter pass-through.
///
/// THE FREE-CREDIT RULE hangs off this: a user's free credit (active grants of
/// ANY pool) is spendable on a request Ryu serves from its own supply, and only
/// there — never on OpenRouter-served traffic and never on BYOK (an untagged
/// provider has no pool at all). The ledger still records the pool that
/// actually SERVED the request, so per-supplier burn-down stays exact; what
/// changed is that a grant is no longer reachable only through its own pool.
/// Mirrors `isOwnSupplyPool` in `packages/auth/src/lib/credit-pools.ts`.
pub fn is_own_supply_pool(pool: &str) -> bool {
    pool != RETAIL_POOL && POOL_BY_GATEWAY_PROVIDER.iter().any(|(_, p)| *p == pool)
}

/// `(gateway provider slot, pool id)` for Ryu's own supply, in catalog order.
pub fn own_supply_slots() -> impl Iterator<Item = (&'static str, &'static str)> {
    POOL_BY_GATEWAY_PROVIDER
        .iter()
        .filter(|(_, pool)| is_own_supply_pool(pool))
        .copied()
}

/// Ryu-held slots that are NO LONGER own supply. AWS Bedrock holds Ryu's AWS
/// account, whose credit now pays for Ryu's own VMs rather than free
/// inference: it draws no grant ([`pool_for_gateway_provider`] is `None`), but
/// it is still Ryu's credential, so its id stays masked and it never joins a
/// BYOK fallback chain ([`is_ryu_held_slot`]).
pub const RETIRED_RYU_SLOTS: &[&str] = &[crate::config::BEDROCK_PROVIDER_ID];

/// Retired POOL ids (control-plane `CreditPool.tier === "retired"`): no slot
/// serves them and nothing new is issued, but grants already issued on them
/// still pay for Ryu's own supply. Mirrors `RETIRED_POOL_IDS` in
/// `packages/auth/src/lib/credit-pools.ts`.
pub const RETIRED_POOLS: &[&str] = &["bedrock"];

/// Whether `provider_name` is a Ryu-operated slot (own supply, the managed
/// OpenRouter pass-through, or a retired Ryu-held slot) whose id a user must
/// never see: user-facing surfaces say "Ryu Router" instead.
pub fn is_ryu_router_slot(provider_name: &str) -> bool {
    pool_for_gateway_provider(provider_name).is_some() || RETIRED_RYU_SLOTS.contains(&provider_name)
}

/// Whether `provider_name` holds Ryu's own credential and so must stay in its
/// own fallback lane: an own-supply slot or a retired Ryu-held one.
pub fn is_ryu_held_slot(provider_name: &str) -> bool {
    pool_for_gateway_provider(provider_name).is_some_and(is_own_supply_pool)
        || RETIRED_RYU_SLOTS.contains(&provider_name)
}

/// One own-supply pool's donated allowance as the control plane reports it on
/// the resolve handshake (wire `poolAllowances[pool]`). Global supply facts,
/// not per-org money: they say whether Ryu may still SERVE from this pool.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolAllowance {
    /// Ceiling minus spend, in micro-USD. `None` ⇒ the pool has no ceiling set.
    #[serde(default)]
    pub remaining_micro_usd: Option<i64>,
    /// When the donated allowance lapses. `None` ⇒ no known expiry.
    #[serde(default)]
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl PoolAllowance {
    /// Whether Ryu may still serve from this pool at `now`.
    pub fn has_room(&self, now: chrono::DateTime<chrono::Utc>) -> bool {
        self.remaining_micro_usd.is_none_or(|left| left > 0)
            && self.expires_at.is_none_or(|at| at > now)
    }

    /// Whether PAID traffic may be served from this pool at `now`: only a pool
    /// with NO donation ceiling (an account Ryu pays for itself) that has not
    /// lapsed. A capped pool is a donated allowance free credit draws on, so
    /// paid traffic never touches it. Callers must also require the pool to
    /// have been REPORTED: an unknown pool is not cut over.
    pub fn admits_paid(&self, now: chrono::DateTime<chrono::Utc>) -> bool {
        self.remaining_micro_usd.is_none() && self.expires_at.is_none_or(|at| at > now)
    }
}

/// The latest own-supply allowances this gateway has seen, shared across
/// requests (the allowance is a property of Ryu's supply, not of a tenant).
///
/// EMPTY means "the control plane never told us" — an older plane, or a
/// single-org node — and then a configured slot is the only condition for
/// own-supply routing ([`PoolAllowances::has_room`] answers `true`).
#[derive(Debug, Default)]
pub struct PoolAllowances {
    inner: std::sync::RwLock<std::collections::HashMap<String, PoolAllowance>>,
}

impl PoolAllowances {
    /// Replace the snapshot with what the latest handshake reported. An empty
    /// map is ignored, so a plane that omits the field never wipes a snapshot.
    pub fn observe(&self, latest: &std::collections::HashMap<String, PoolAllowance>) {
        if latest.is_empty() {
            return;
        }
        if let Ok(mut guard) = self.inner.write() {
            guard.clone_from(latest);
        }
    }

    /// The pool's allowance when known.
    pub fn get(&self, pool: &str) -> Option<PoolAllowance> {
        self.inner.read().ok()?.get(pool).cloned()
    }

    /// Whether `pool` may still be served from. Unknown pool or no snapshot ⇒
    /// `true` (slot configured is then the only condition).
    pub fn has_room(&self, pool: &str, now: chrono::DateTime<chrono::Utc>) -> bool {
        self.get(pool)
            .is_none_or(|allowance| allowance.has_room(now))
    }
}

#[cfg(test)]
mod tests;
