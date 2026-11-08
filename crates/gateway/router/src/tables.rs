//! [`RoutingTables`]: the model→provider resolution order and its helpers.

use super::*;

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
