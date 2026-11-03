//! `gateway.toml` path resolution, derived-value stripping and parsing.

use super::*;

impl GatewayConfig {
    /// Resolve the gateway.toml path using the same logic as `load()`:
    /// `GATEWAY_CONFIG` env var first, then `$config_dir/ryu/gateway.toml`.
    pub fn config_path() -> Option<std::path::PathBuf> {
        std::env::var("GATEWAY_CONFIG")
            .ok()
            .map(std::path::PathBuf::from)
            // Profile-aware fallback (`<config>/ryu{suffix}/gateway.toml`) so a
            // standalone dev gateway reads its own config, not the release one.
            .or_else(crate::profile::default_config_path)
    }

    /// Remove the load-time classify seed from `routing.model_map`.
    ///
    /// Why the seeded row must not be served or saved: `GET /v1/config` renders
    /// `routing.model_map` as the desktop's hand-authored "Model mappings" list
    /// (`GatewayDialog.tsx`), each row with a delete button. A seeded row there reads
    /// as operator-authored, and deleting it *cannot work* — the delete is a
    /// read-modify-write `PUT` of the whole `routing`, so the row does leave the file,
    /// and then the next [`Self::load`] seeds it straight back. The operator sees a
    /// mapping they never wrote, deletes it successfully, and watches it return. Same
    /// reason it must not reach `gateway.toml`: there it looks operator-authored
    /// forever and outlives the id it was seeded for.
    ///
    /// Routing is unaffected because the seed is re-applied on every `load()`, which
    /// is upstream of every production router — see [`seed_classify_route`].
    ///
    /// The shape re-check guards the one case the marker cannot: something replaced
    /// the mapping in memory after the seed ran, in which case the current value is
    /// somebody's choice and not ours to delete. (The converse — `routing` replaced
    /// wholesale by a `PUT` body that happens to contain a byte-identical
    /// `<id> → classify` row while the marker is still set — is unreachable:
    /// `api::config::persisted_config` consumes the marker before `put_config`
    /// assigns `routing`, so the value the strip sees is always the one it seeded.)
    pub fn strip_seeded_classify_route(&mut self) {
        let Some(model_id) = self.seeded_classify_model.take() else {
            return;
        };
        let is_untouched_seed = self
            .routing
            .model_map
            .get(&model_id)
            .is_some_and(|mapping| {
                mapping.provider.as_str() == CLASSIFY_PROVIDER_ID
                    && mapping.provider_model.is_none()
            });
        if is_untouched_seed {
            self.routing.model_map.remove(&model_id);
        }
    }

    /// Undo the env overlay on `providers.classify`: restore whatever
    /// `gateway.toml` said ([`Self::file_classify_provider`] — `None` when it said
    /// nothing) if and only if [`Self::load`] overwrote the slot from Core's
    /// `RYU_CLASSIFY_LLM_URL`.
    ///
    /// RESTORE, not clear. The env wins the live slot, so on a node whose operator
    /// *did* author `[providers.classify]` the in-memory value is Core's; clearing
    /// would delete the operator's table from their own file on the next
    /// `PUT`-triggered save (`api::config::put_config` re-serializes this shape).
    /// A marker-less config — no env, or a standalone gateway — is untouched.
    ///
    /// Why `classify` is stripped when `openai` / `anthropic` / `local` are not,
    /// stated honestly: for all four the env wins the next `load()`, so a persisted
    /// copy is shadowed rather than obeyed while Core is the spawner. The difference
    /// is what gets frozen. The others persist an operator's own credential or an
    /// engine URL; `classify` would persist a **computed, profile-scoped loopback
    /// port** (`:8083` release, `:9083` dev) that Core recomputes on every spawn — so
    /// the copy is stale on the next profile or port change and becomes *live* as soon
    /// as something other than Core starts the gateway. The same argument does apply
    /// to `local` (also computed by Core, from the active-engine store) and simply is
    /// not implemented there; this is the narrower, safer slot, not a categorical
    /// distinction.
    pub fn strip_env_injected_classify_provider(&mut self) {
        if std::mem::take(&mut self.env_injected_classify_provider) {
            self.providers.classify = self.file_classify_provider.take();
        }
    }

    /// `self` minus every DERIVED value that [`Self::load`] adds on top of the file:
    /// the seeded classify route is removed, and an env-overwritten
    /// `[providers.classify]` is reverted to what the file said. This is the shape
    /// that may leave the process — written to `gateway.toml`, or read by
    /// `api::config::persisted_config`.
    ///
    /// Applied in exactly two places, which between them cover both directions:
    /// [`Self::save`] (so no `save()` caller can persist a derived value) and
    /// `api::config::persisted_config` (whose `routing` half genuinely reaches
    /// `GET /v1/config` and the read-modify-write clients that PUT it back).
    ///
    /// The two halves are NOT equally load-bearing at the `persisted_config` call —
    /// see that function's doc for which is which; they are applied together because
    /// this is the single "may leave the process" gate and splitting it would create a
    /// second rule to keep in sync. See [`Self::strip_seeded_classify_route`] and
    /// [`Self::strip_env_injected_classify_provider`].
    pub fn without_derived_values(&self) -> Self {
        let mut clean = self.clone();
        clean.strip_seeded_classify_route();
        clean.strip_env_injected_classify_provider();
        clean
    }

    /// Guarded fixture/bootstrap persistence. Production writers patch authored
    /// snapshots through the shared transaction instead of saving runtime config.
    #[cfg(test)]
    pub fn save(&self) -> anyhow::Result<()> {
        let path = Self::config_path()
            .ok_or_else(|| anyhow::anyhow!("Cannot determine gateway config path"))?;
        test_config_path::ensure_test_seal_key();
        let mut transaction = ryu_gw_credentials::ConfigFileTransaction::acquire(&path)?;
        let expected = transaction.snapshot().revision().clone();
        let bytes = toml::to_string_pretty(&self.without_derived_values())?;
        transaction.commit(&expected, bytes.as_bytes())?;
        Ok(())
    }

    /// A startup warning for a metering node with no per-model price table.
    ///
    /// Only providers that report `usage.cost` (OpenRouter) are billed their
    /// actual cost. Every other route is priced from `control_plane
    /// .model_pricing`, and an unpriced model falls back to the flat
    /// `cost_per_1k_micro_usd` for input and output alike, which under-charges
    /// frontier models and over-charges cheap ones. The ledger row marks such a
    /// charge `estimated`, but an operator should know the table is empty.
    pub fn flat_rate_metering_warning(&self) -> Option<String> {
        if !self.credits.is_active() || !self.control_plane.model_pricing.is_empty() {
            return None;
        }
        Some(format!(
            "credits are metering but [control_plane.model_pricing] is empty: every route \
whose provider does not report usage.cost (all except OpenRouter) is billed at the flat \
estimate of {} micro-USD per 1k tokens, input and output alike",
            self.control_plane.cost_per_1k_micro_usd
        ))
    }

    /// Parse authored `gateway.toml` text, opening every sealed secret leaf
    /// first (`encc:v1:`, the Gateway's component subkey). Legacy plaintext
    /// parses without a key; a sealed leaf without the key is an error, never an
    /// empty credential. No environment or fleet overlays are applied.
    pub fn from_authored_str(text: &str) -> anyhow::Result<Self> {
        let opened = ryu_gw_credentials::sealed_config::open_text(text)?;
        Ok(toml::from_str(&opened)?)
    }
}

#[cfg(test)]
#[path = "tests/config_file_tests.rs"]
mod tests;
