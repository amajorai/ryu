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
//! credit — allowances at AWS Bedrock, Cloudflare Workers AI, Google Cloud Vertex
//! AI and OpenAI, each with its own ceiling and its own donor accounting. A
//! dollar of Cloudflare buys roughly 10–20× the tokens a dollar of Bedrock does.
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
const POOL_BY_GATEWAY_PROVIDER: &[(&str, &str)] = &[
    // Cloudflare Workers AI — the cheap open-model supply ("Ryu Fast"). Free-tier,
    // business-card and referral grants land here.
    (crate::config::CLOUDFLARE_PROVIDER_ID, "cloudflare"),
    // AWS Bedrock — the expensive frontier supply ("Ryu Frontier"). The
    // seat-limited campaign ladder grants against this pool and nothing else.
    (crate::config::BEDROCK_PROVIDER_ID, "bedrock"),
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

/// Whether `provider_name` is a Ryu-operated slot (own supply or the managed
/// OpenRouter pass-through) whose id a user must never see: user-facing
/// surfaces say "Ryu Router" instead.
pub fn is_ryu_router_slot(provider_name: &str) -> bool {
    pool_for_gateway_provider(provider_name).is_some()
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
mod tests {
    use super::*;

    #[test]
    fn pool_allowances_gate_on_remaining_and_expiry_and_default_open() {
        let now = chrono::Utc::now();
        let store = PoolAllowances::default();
        // Nothing observed: slot configured is the only condition.
        assert!(store.has_room("bedrock", now));
        store.observe(&std::collections::HashMap::from([
            (
                "bedrock".to_owned(),
                PoolAllowance {
                    remaining_micro_usd: Some(0),
                    expires_at: None,
                },
            ),
            (
                "vertex".to_owned(),
                PoolAllowance {
                    remaining_micro_usd: Some(5),
                    expires_at: Some(now - chrono::Duration::days(1)),
                },
            ),
            (
                "cloudflare".to_owned(),
                PoolAllowance {
                    remaining_micro_usd: Some(5),
                    expires_at: Some(now + chrono::Duration::days(1)),
                },
            ),
        ]));
        assert!(!store.has_room("bedrock", now), "exhausted");
        assert!(!store.has_room("vertex", now), "expired");
        assert!(store.has_room("cloudflare", now));
        assert!(store.has_room("anthropic-credits", now), "not reported");
        // An empty report never wipes the snapshot.
        store.observe(&std::collections::HashMap::new());
        assert!(!store.has_room("bedrock", now));
        // Wire shape: camelCase, ISO expiry, both optional.
        let wire: PoolAllowance = serde_json::from_value(serde_json::json!({
            "remainingMicroUsd": 7,
            "expiresAt": "2030-01-01T00:00:00.000Z"
        }))
        .unwrap();
        assert_eq!(wire.remaining_micro_usd, Some(7));
        assert!(wire.expires_at.is_some());
        let bare: PoolAllowance = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(bare, PoolAllowance::default());
    }

    #[test]
    fn paid_traffic_is_admitted_only_by_an_uncapped_live_pool() {
        let now = chrono::Utc::now();
        // No ceiling (`remainingMicroUsd: null` on the wire), no expiry.
        let uncapped: PoolAllowance = serde_json::from_value(serde_json::json!({
            "remainingMicroUsd": null, "expiresAt": null
        }))
        .unwrap();
        assert!(uncapped.admits_paid(now));
        // Any ceiling, however much is left, is a donated allowance.
        let capped = PoolAllowance {
            remaining_micro_usd: Some(1_000_000_000),
            expires_at: None,
        };
        assert!(capped.has_room(now));
        assert!(!capped.admits_paid(now));
        // A lapsed uncapped pool serves nobody; one lapsing later still does.
        let lapsed = PoolAllowance {
            remaining_micro_usd: None,
            expires_at: Some(now - chrono::Duration::days(1)),
        };
        assert!(!lapsed.admits_paid(now));
        let lapsing = PoolAllowance {
            remaining_micro_usd: None,
            expires_at: Some(now + chrono::Duration::days(1)),
        };
        assert!(lapsing.admits_paid(now));
    }

    #[test]
    fn own_supply_is_every_pool_but_the_retail_pass_through() {
        let slots: Vec<_> = own_supply_slots().map(|(slot, _)| slot).collect();
        assert_eq!(
            slots,
            [
                "cloudflare",
                "bedrock",
                "vertex",
                "openai-credits",
                "anthropic-credits"
            ]
        );
        assert!(!is_own_supply_pool("openrouter"));
        assert!(!is_own_supply_pool("not-a-pool"));
        assert!(is_ryu_router_slot("openrouter"));
        assert!(!is_ryu_router_slot("anthropic"));
    }

    /// Core decides a limited agent's default model with the router crate's
    /// list of credential-free slots, and the agent provider check here uses
    /// it too, so it must name exactly this table's own-supply slots.
    #[test]
    fn own_supply_slots_match_the_router_crate() {
        let mut ours: Vec<&str> = own_supply_slots().map(|(slot, _)| slot).collect();
        let mut shared = ryu_gw_router::OWN_SUPPLY_SLOTS.to_vec();
        ours.sort_unstable();
        shared.sort_unstable();
        assert_eq!(ours, shared);
        assert_eq!(
            ryu_gw_router::CLASSIFY_SLOT,
            crate::config::CLASSIFY_PROVIDER_ID
        );
    }

    #[test]
    fn no_provider_is_claimed_twice() {
        // Two pools claiming one provider makes attribution ambiguous, and the
        // ambiguity only ever shows up as money in the wrong donor account.
        for (index, (provider, _)) in POOL_BY_GATEWAY_PROVIDER.iter().enumerate() {
            let duplicate = POOL_BY_GATEWAY_PROVIDER
                .iter()
                .skip(index + 1)
                .any(|(other, _)| other == provider);
            assert!(!duplicate, "gateway provider '{provider}' claimed twice");
        }
    }

    #[test]
    fn untagged_providers_are_not_pool_attributed() {
        // The pre-pools billing path, preserved: `openai`/`anthropic`/`local`
        // traffic draws no grant and is attributed to no pool.
        assert_eq!(pool_for_gateway_provider("openai"), None);
        assert_eq!(pool_for_gateway_provider("anthropic"), None);
        assert_eq!(pool_for_gateway_provider("local"), None);
        assert_eq!(pool_for_gateway_provider(""), None);
    }

    #[test]
    fn byok_anthropic_is_never_attributed_to_ryus_own_pool() {
        // Same rule as OpenAI: `anthropic` serves callers' own keys; only the
        // `anthropic-credits` slot (Ryu's first-party account) draws the pool.
        assert_eq!(pool_for_gateway_provider("anthropic"), None);
        assert_eq!(
            pool_for_gateway_provider("anthropic-credits"),
            Some("anthropic-credits")
        );
    }

    #[test]
    fn byok_openai_is_never_attributed_to_the_donated_pool() {
        // `untagged_providers_are_not_pool_attributed` covers the same `openai`
        // string, but for a weaker reason (nobody has tagged it yet). Since the
        // donated OpenAI allowance landed, that assertion carries real money:
        // `openai` is the slot serving callers' OWN keys, so tagging it would
        // start debiting the donation for spend the donor never funded. Only the
        // separate `openai-credits` slot draws it, and the two must never merge.
        assert_eq!(pool_for_gateway_provider("openai"), None);
        assert_eq!(
            pool_for_gateway_provider("openai-credits"),
            Some("openai-credits")
        );
        // The same shape one level over: `genai` is the own-key Gemini surface,
        // `vertex` is the donated one. Same models, different account.
        assert_eq!(pool_for_gateway_provider("genai"), None);
        assert_eq!(pool_for_gateway_provider("vertex"), Some("vertex"));
    }

    #[test]
    fn pooled_providers_resolve_to_their_pool() {
        assert_eq!(pool_for_gateway_provider("cloudflare"), Some("cloudflare"));
        assert_eq!(pool_for_gateway_provider("bedrock"), Some("bedrock"));
        assert_eq!(pool_for_gateway_provider("openrouter"), Some("openrouter"));
        assert_eq!(pool_for_gateway_provider("vertex"), Some("vertex"));
        assert_eq!(
            pool_for_gateway_provider("openai-credits"),
            Some("openai-credits")
        );
    }

    #[test]
    fn pool_ids_all_resolve_in_the_registry() {
        // The failure mode this guards: a tagged provider that no longer
        // registers stops drawing grant money SILENTLY instead of erroring.
        //
        // Scope it honestly. Every row but `openrouter` is const-backed
        // (`config::{CLOUDFLARE,BEDROCK,VERTEX,OPENAI_CREDITS,ANTHROPIC_CREDITS}_PROVIDER_ID`), so a
        // typo there is already a compile error and this test adds nothing for
        // them. What it actually catches is (a) the bare `"openrouter"` literal
        // and (b) any id's registry SLOT being deleted or renamed out from under
        // the table — which the consts cannot catch, because they would still
        // agree with each other.
        let config: crate::config::ProvidersConfig = serde_json::from_value(serde_json::json!({
            "openai": { "api_key": "sk-o" },
            "anthropic": { "api_key": "sk-a" },
            "local": { "base_url": "http://127.0.0.1:1234" },
            "openrouter": { "api_key": "sk-or" },
            "core": { "base_url": "http://127.0.0.1:7979", "token": "t" },
            "modal": { "api_key": "sk-m", "base_url": "https://modal.example" },
            "genai": { "keys": { "gemini": "sk-g" } },
            "replicate": { "api_key": "sk-r" },
            "fal": { "api_key": "sk-f" },
            "classify": { "base_url": "http://127.0.0.1:8083/v1" },
            "cloudflare": { "api_key": "cf", "base_url": "https://cf.example/ai/v1" },
            "bedrock": { "api_key": "aws", "base_url": "https://bedrock.example/anthropic" },
            "vertex": { "api_key": "gcp", "base_url": "https://vertex.example/endpoints/openapi" },
            "openai_credits": { "api_key": "sk-donated" },
            "anthropic_credits": { "api_key": "sk-ant-ryu" }
        }))
        .expect("full providers config parses");
        let registry = crate::providers::ProviderRegistry::new(
            &config,
            std::sync::Arc::new(crate::quota::ProviderQuotas::default()),
        );
        for (provider, pool) in POOL_BY_GATEWAY_PROVIDER {
            assert!(
                registry.get(provider).is_some(),
                "credit pool '{pool}' bills gateway provider '{provider}', which no longer registers"
            );
        }
    }
}
