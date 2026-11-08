//! The Ryu Router own-supply table: which Ryu Router (OpenRouter-catalog) model
//! ids Ryu can serve from one of its OWN provider slots, under which upstream
//! id, at what price.
//!
//! The authority is the control plane (admin-edited, published to fleet
//! gateways with a version). [`OwnSupplyTable::seed`] builds the same shape from
//! the compiled [`crate::SEED_OWN_SUPPLY_EQUIVALENTS`] for gateways that never
//! fetch (self-hosted / non-fleet). Lookups are ASCII-case-insensitive on ids;
//! the reverse lookup is keyed on the SLOT, so BYOK traffic with the same bare
//! upstream id never takes a Ryu Router name.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// A one-hour prompt-cache write costs this many times the prompt price
/// (Anthropic's published rate, which OpenRouter passes through). The
/// OpenRouter catalog lists only the five-minute write rate.
pub const ONE_HOUR_CACHE_WRITE_PROMPT_MULTIPLE: u64 = 2;

/// The prompt-cache legs of one call, all inside its `prompt_tokens`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheTokens {
    /// Prompt tokens served from the provider's prompt cache.
    pub read: u64,
    /// Prompt tokens written to the provider's prompt cache, any TTL.
    pub write: u64,
    /// The part of `write` written with a one-hour TTL (Anthropic's
    /// `cache_creation.ephemeral_1h_input_tokens`).
    pub write_1h: u64,
}

/// A per-1,000-token price in micro-USD.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnSupplyPrice {
    pub in_per_1k_micro_usd: u64,
    pub out_per_1k_micro_usd: u64,
    /// Prompt tokens read from the provider's prompt cache (OpenRouter's
    /// `input_cache_read`). `None` ⇒ billed at the prompt price.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_per_1k_micro_usd: Option<u64>,
    /// Prompt tokens written to the provider's prompt cache (OpenRouter's
    /// `input_cache_write`). `None` ⇒ billed at the prompt price.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_per_1k_micro_usd: Option<u64>,
}

impl OwnSupplyPrice {
    /// A price with no cache legs: every prompt token at `in_per_1k`.
    pub const fn flat(in_per_1k_micro_usd: u64, out_per_1k_micro_usd: u64) -> Self {
        Self {
            in_per_1k_micro_usd,
            out_per_1k_micro_usd,
            cache_read_per_1k_micro_usd: None,
            cache_write_per_1k_micro_usd: None,
        }
    }

    /// Cost of one call at this price, every prompt token at the prompt price.
    pub fn cost(&self, input_tokens: u64, output_tokens: u64) -> u64 {
        self.cost_with_cache(input_tokens, output_tokens, CacheTokens::default())
    }

    /// Cost of one call whose `input_tokens` (the OpenAI-shaped
    /// `prompt_tokens`, which INCLUDES the cache legs) contain `cache.read`
    /// tokens served from and `cache.write` tokens written to the provider's
    /// prompt cache. Each leg is priced at its own rate when the price carries
    /// one, else at the prompt price, so the debit follows what the same call
    /// costs on OpenRouter (whose `usage.cost` prices the legs the same way).
    ///
    /// The catalog's cache-write rate is the default (five-minute) TTL's. A
    /// ONE-HOUR write (`cache.write_1h`, part of `cache.write`) is billed by
    /// Anthropic and OpenRouter at [`ONE_HOUR_CACHE_WRITE_PROMPT_MULTIPLE`]×
    /// the prompt price, never below the five-minute rate. Cache counts larger
    /// than the prompt are clamped to it.
    pub fn cost_with_cache(
        &self,
        input_tokens: u64,
        output_tokens: u64,
        cache: CacheTokens,
    ) -> u64 {
        let read = cache.read.min(input_tokens);
        let write = cache.write.min(input_tokens - read);
        let write_1h = cache.write_1h.min(write);
        let write_5m = write - write_1h;
        let fresh = input_tokens - read - write;
        let leg = |tokens: u64, per_1k: u64| tokens.saturating_mul(per_1k) / 1000;
        let write_5m_per_1k = self
            .cache_write_per_1k_micro_usd
            .unwrap_or(self.in_per_1k_micro_usd);
        let write_1h_per_1k = self
            .in_per_1k_micro_usd
            .saturating_mul(ONE_HOUR_CACHE_WRITE_PROMPT_MULTIPLE)
            .max(write_5m_per_1k);
        leg(fresh, self.in_per_1k_micro_usd)
            .saturating_add(leg(
                read,
                self.cache_read_per_1k_micro_usd
                    .unwrap_or(self.in_per_1k_micro_usd),
            ))
            .saturating_add(leg(write_5m, write_5m_per_1k))
            .saturating_add(leg(write_1h, write_1h_per_1k))
            .saturating_add(leg(output_tokens, self.out_per_1k_micro_usd))
    }

    /// Whether a call at this price can cost anything at all.
    pub fn is_chargeable(&self) -> bool {
        self.in_per_1k_micro_usd > 0 || self.out_per_1k_micro_usd > 0
    }
}

/// One published row (wire shape of `GET /api/own-supply/fleet/table`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnSupplyRow {
    /// The Ryu Router id the user picks.
    pub id: String,
    /// The own-supply gateway slot.
    pub slot: String,
    /// The id the slot is sent.
    pub upstream: String,
    /// Lower routes first among several slots for one id.
    #[serde(default)]
    pub priority: i64,
    /// A gateway canary must pass before this row routes, even where the
    /// gateway otherwise trusts the table without one.
    #[serde(default)]
    pub canary_required: bool,
    /// The user's debit price (OpenRouter's price for `id`, or an admin
    /// override). `None` only for compiled seed rows.
    #[serde(default)]
    pub user_price: Option<OwnSupplyPrice>,
    /// What the supplier charges Ryu, when the admin recorded it.
    #[serde(default)]
    pub supplier_cost: Option<OwnSupplyPrice>,
    /// Share of PAID traffic (callers holding no free credit) this row serves,
    /// in basis points: `0` never (the default, and every seed row), `10_000`
    /// all of it. This is the per-model cut-over dial from OpenRouter to Ryu's
    /// own supply; see [`OwnSupplyRow::admits_paid`].
    #[serde(default)]
    pub paid_rollout_bps: u16,
}

/// The largest meaningful [`OwnSupplyRow::paid_rollout_bps`].
pub const PAID_ROLLOUT_ALL_BPS: u16 = 10_000;

impl OwnSupplyRow {
    /// Whether this row serves a paid request whose cohort landed in `bucket`
    /// (from [`rollout_bucket`]). Only a row with a CHARGEABLE price admits
    /// paid traffic: a zero price would serve it for nothing while Ryu pays
    /// the supplier. The control plane publishes a dial only on rows priced
    /// from the OpenRouter catalog (never an admin override), cache legs
    /// included, so the debit follows what the same pick costs on OpenRouter.
    pub fn admits_paid(&self, bucket: u16) -> bool {
        self.user_price
            .as_ref()
            .is_some_and(OwnSupplyPrice::is_chargeable)
            && bucket < self.paid_rollout_bps.min(PAID_ROLLOUT_ALL_BPS)
    }
}

/// A stable bucket in `0..10_000` for a rollout cohort (`cohort`, usually the
/// org) and a Ryu Router id. Stable across processes and releases (FNV-1a, not
/// the std hasher), so one org sees one source per model on every gateway, and
/// raising a row's dial only ever adds cohorts: everyone below the old dial
/// stays on own supply. Case-insensitive on the model id like every lookup.
pub fn rollout_bucket(cohort: &str, model_id: &str) -> u16 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET;
    let bytes = cohort
        .bytes()
        .chain(std::iter::once(0))
        .chain(model_id.bytes().map(|b| b.to_ascii_lowercase()));
    for byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(PRIME);
    }
    u16::try_from(hash % u64::from(PAID_ROLLOUT_ALL_BPS)).unwrap_or(0)
}

/// The table, indexed for the request path.
#[derive(Debug, Clone, Default)]
pub struct OwnSupplyTable {
    version: u64,
    rows: Vec<OwnSupplyRow>,
    by_id: HashMap<String, Vec<usize>>,
    by_slot_upstream: HashMap<(String, String), usize>,
    pool_defaults: HashMap<String, String>,
}

impl OwnSupplyTable {
    /// Build from published rows. Rows are ordered by `(id, priority, slot)`;
    /// a row that repeats an `(id, slot)` or `(slot, upstream)` already taken is
    /// dropped, so both lookups stay single-valued whatever the input.
    pub fn from_rows(
        version: u64,
        rows: Vec<OwnSupplyRow>,
        pool_defaults: HashMap<String, String>,
    ) -> Self {
        let mut rows = rows;
        rows.sort_by(|a, b| {
            a.id.to_ascii_lowercase()
                .cmp(&b.id.to_ascii_lowercase())
                .then(a.priority.cmp(&b.priority))
                .then(a.slot.cmp(&b.slot))
        });
        let mut table = Self {
            version,
            pool_defaults: pool_defaults
                .into_iter()
                .map(|(pool, id)| (pool, id.to_ascii_lowercase()))
                .collect(),
            ..Self::default()
        };
        let mut seen_id_slot = std::collections::HashSet::new();
        for row in rows {
            let id = row.id.to_ascii_lowercase();
            let key = (row.slot.clone(), row.upstream.to_ascii_lowercase());
            if table.by_slot_upstream.contains_key(&key)
                || !seen_id_slot.insert((id.clone(), row.slot.clone()))
            {
                continue;
            }
            let index = table.rows.len();
            table.by_slot_upstream.insert(key, index);
            table.by_id.entry(id).or_default().push(index);
            table.rows.push(row);
        }
        table
    }

    /// The compiled seed (version 0): what a gateway that never fetches routes on.
    pub fn seed() -> Self {
        let rows = crate::SEED_OWN_SUPPLY_EQUIVALENTS
            .iter()
            .map(|(id, slot, upstream)| OwnSupplyRow {
                id: (*id).to_owned(),
                slot: (*slot).to_owned(),
                upstream: (*upstream).to_owned(),
                priority: 0,
                canary_required: crate::SEED_CANARY_REQUIRED
                    .iter()
                    .any(|(s, u)| s == slot && u == upstream),
                user_price: None,
                supplier_cost: None,
                paid_rollout_bps: 0,
            })
            .collect();
        Self::from_rows(0, rows, seed_pool_defaults())
    }

    /// No rows at all (a fleet gateway that has never fetched the table).
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn rows(&self) -> &[OwnSupplyRow] {
        &self.rows
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    pub fn pool_defaults(&self) -> &HashMap<String, String> {
        &self.pool_defaults
    }

    /// The candidates for a Ryu Router id, in preference order.
    pub fn equivalents<'a>(&'a self, id: &str) -> impl Iterator<Item = &'a OwnSupplyRow> + 'a {
        self.by_id
            .get(&id.to_ascii_lowercase())
            .into_iter()
            .flatten()
            .filter_map(|index| self.rows.get(*index))
    }

    /// The row a slot serves `upstream` under, if any.
    pub fn row(&self, slot: &str, upstream: &str) -> Option<&OwnSupplyRow> {
        self.by_slot_upstream
            .get(&(slot.to_owned(), upstream.to_ascii_lowercase()))
            .and_then(|index| self.rows.get(*index))
    }

    /// Reverse lookup: the Ryu Router id for `upstream` served by `slot`.
    pub fn equivalent_id(&self, slot: &str, upstream: &str) -> Option<&str> {
        self.row(slot, upstream).map(|row| row.id.as_str())
    }

    /// The user price of `(slot, upstream)`, when published.
    pub fn price(&self, slot: &str, upstream: &str) -> Option<OwnSupplyPrice> {
        self.row(slot, upstream).and_then(|row| row.user_price)
    }

    /// The row a pool serves `openrouter/auto` with: the pool default's row on
    /// a slot of that pool (`slot_for_pool` maps pool → slots).
    pub fn pool_default<'a>(
        &'a self,
        pool: &str,
        slot_in_pool: impl Fn(&str) -> bool,
    ) -> Option<&'a OwnSupplyRow> {
        let id = self.pool_defaults.get(pool)?;
        self.equivalents(id).find(|row| slot_in_pool(&row.slot))
    }
}

/// The seed's `openrouter/auto` defaults: each slot's `…/standard` Ryu alias
/// (else its first), when that upstream has a seed Ryu Router id. Own-supply
/// pool ids equal their slot ids.
fn seed_pool_defaults() -> HashMap<String, String> {
    let mut defaults = HashMap::new();
    for (_, slot, _) in crate::SEED_OWN_SUPPLY_EQUIVALENTS {
        if defaults.contains_key(*slot) {
            continue;
        }
        let Some((_, upstream)) =
            crate::pool_default_alias_for(slot).and_then(crate::pool_model_alias_route)
        else {
            continue;
        };
        if let Some(id) = crate::pool_model_equivalent_id(slot, upstream) {
            defaults.insert((*slot).to_owned(), id.to_owned());
        }
    }
    defaults
}

#[cfg(test)]
mod tests;
