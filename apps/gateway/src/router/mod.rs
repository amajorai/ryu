use std::sync::atomic::{AtomicU64, Ordering};

use crate::config::{Modality, ProviderId, RoutingConfig};

pub mod smart;

/// The result of a routing decision.
#[derive(Debug, Clone)]
pub struct RouteDecision {
    /// Which provider to use — an open registry id (see [`ProviderId`]), no
    /// longer pinned to the closed `ProviderKind` enum.
    pub provider: ProviderId,
    /// The model name to send to the provider (may differ from the requested model)
    pub model: String,
}

pub struct ModelRouter {
    /// The pure routing tables, built once from `config` (a startup snapshot) and
    /// consulted on every route. The zero-config built-in prefix table, the
    /// resolution order, the tier sort, and the eval A/B math all live in the
    /// [`ryu_gw_router`] crate; this struct is the config-holding wrapper that
    /// maps the crate's provider *strings* back to [`ProviderId`]/[`RouteDecision`].
    tables: ryu_gw_router::RoutingTables,
    /// Whether the config enabled eval-driven (A/B) routing (the candidate-count
    /// half of the check lives in the tables).
    eval_enabled: bool,
    /// Monotonic counter for deterministic explore/exploit splitting in
    /// eval-driven routing (avoids pulling in an RNG dependency). Kept here (not
    /// in the crate) so the process-state stays gateway-side; passed into the
    /// crate via a closure so its increment timing is byte-identical.
    ab_counter: AtomicU64,
}

impl ModelRouter {
    pub fn new(config: RoutingConfig) -> Self {
        // Lower the config value-types to the crate's string-keyed views once.
        // The built-in prefix table is owned by the crate (zero-config brain).
        let model_map = config
            .model_map
            .iter()
            .map(|(k, m)| {
                (
                    k.clone(),
                    (m.provider.as_str().to_string(), m.provider_model.clone()),
                )
            })
            .collect();
        let modality_map = config
            .modality_map
            .iter()
            .map(|(modality, m)| {
                (
                    modality.as_str().to_string(),
                    (m.provider.as_str().to_string(), m.model.clone()),
                )
            })
            .collect();
        let tables = ryu_gw_router::RoutingTables {
            model_map,
            builtin_prefixes: ryu_gw_router::builtin_prefixes(),
            default_provider: config.default_provider.as_str().to_string(),
            modality_map,
            fallback_chain: config
                .fallback_chain
                .iter()
                .map(|p| p.as_str().to_string())
                .collect(),
            provider_tiers: config
                .provider_tiers
                .iter()
                .map(|(p, t)| (p.as_str().to_string(), *t))
                .collect(),
            eval_candidates: config
                .eval_routing
                .candidates
                .iter()
                .map(|p| p.as_str().to_string())
                .collect(),
            explore_ratio: config.eval_routing.explore_ratio,
        };

        Self {
            eval_enabled: config.eval_routing.enabled,
            tables,
            ab_counter: AtomicU64::new(0),
        }
    }

    /// Whether eval-driven (A/B) routing is enabled with at least two candidates.
    pub fn eval_routing_enabled(&self) -> bool {
        self.eval_enabled && self.tables.eval_candidates.len() >= 2
    }

    /// Pick a provider from the configured A/B candidates, biased toward whichever
    /// candidate has the best rolling eval score.
    ///
    /// `score_of` returns the current eval score for a provider, or `None` if it
    /// has not been scored yet. Unscored candidates are always explored first so
    /// every candidate earns a baseline score before exploitation kicks in.
    ///
    /// Returns `None` when eval-driven routing is not applicable, so the caller
    /// falls back to ordinary model-map routing.
    pub fn eval_route(
        &self,
        requested_model: &str,
        score_of: impl Fn(&ProviderId) -> Option<f32>,
    ) -> Option<RouteDecision> {
        if !self.eval_routing_enabled() {
            return None;
        }
        // The explore/exploit math lives in the crate; it scores by provider
        // *string* and pulls the A/B counter only on the explore-ratio path (via
        // the closure below) so the counter advances with the original timing.
        let provider = self.tables.eval_route(
            requested_model,
            &|p: &str| score_of(&ProviderId::from(p)),
            &|| self.ab_counter.fetch_add(1, Ordering::Relaxed),
        )?;
        Some(RouteDecision {
            provider: ProviderId::from(provider),
            model: requested_model.to_string(),
        })
    }

    /// Determine which provider and model name to use for a given request model string.
    pub fn route(&self, requested_model: &str) -> RouteDecision {
        // The full resolution order (exact map → longest user prefix → built-in
        // prefix table → default) lives in the crate, keyed on provider strings.
        let (provider, model) = self.tables.route(requested_model);
        RouteDecision {
            provider: ProviderId::from(provider),
            model,
        }
    }

    /// Resolve the provider and model for a non-chat modality request.
    ///
    /// Checks the `modality_map` first; if no explicit mapping exists the
    /// request falls back to normal model-based routing so zero-config installs
    /// always have a path.
    // Slot-free convenience wrapper. Production always routes via
    // `route_modality_with_slot` (per-agent slot overrides, #164/d6950fbf);
    // retained as the simplest public entry point and used by the router tests.
    #[allow(dead_code)]
    pub fn route_modality(&self, modality: &Modality, requested_model: &str) -> RouteDecision {
        self.route_modality_with_slot(modality, requested_model, None, None)
    }

    /// Resolve the provider and model for a modality request, honoring an
    /// optional per-agent slot override forwarded by Core.
    ///
    /// Resolution order (first match wins):
    ///   1. Explicit slot override from the request (`slot_provider` / `slot_model`).
    ///   2. Static `modality_map` entry in the gateway config.
    ///   3. Standard model-based routing.
    ///
    /// An unset slot (`None`) falls through to the next level, so an agent that
    /// has only a chat slot set will still use the config's `modality_map` for
    /// image/TTS/STT calls. Governance (firewall, budgets, policy) always runs
    /// after routing and is not bypassed by slot overrides.
    pub fn route_modality_with_slot(
        &self,
        modality: &Modality,
        requested_model: &str,
        slot_provider: Option<&crate::config::ProviderId>,
        slot_model: Option<&str>,
    ) -> RouteDecision {
        // Resolution order (slot override → modality_map → model routing) lives in
        // the crate, keyed on the modality/provider strings.
        let (provider, model) = self.tables.route_modality(
            modality.as_str(),
            requested_model,
            slot_provider.map(ProviderId::as_str),
            slot_model,
        );
        RouteDecision {
            provider: ProviderId::from(provider),
            model,
        }
    }

    /// Returns an ordered fallback chain for a given provider.
    /// The primary provider is first, followed by the configured fallback chain
    /// (with the primary removed to avoid duplicates).
    pub fn fallback_chain(&self, primary: &ProviderId) -> Vec<ProviderId> {
        // Cost-tier demotion order lives in the crate, over provider strings.
        self.tables
            .fallback_chain(primary.as_str())
            .into_iter()
            .map(ProviderId::from)
            .collect()
    }
}

/// Default model list exposed via /v1/models
pub fn builtin_model_list() -> Vec<serde_json::Value> {
    use serde_json::json;

    let now = chrono::Utc::now().timestamp();

    vec![
        // OpenAI
        json!({"id": "gpt-4o", "object": "model", "created": now, "owned_by": "openai"}),
        json!({"id": "gpt-4o-mini", "object": "model", "created": now, "owned_by": "openai"}),
        json!({"id": "gpt-4-turbo", "object": "model", "created": now, "owned_by": "openai"}),
        json!({"id": "o1", "object": "model", "created": now, "owned_by": "openai"}),
        json!({"id": "o3-mini", "object": "model", "created": now, "owned_by": "openai"}),
        // Anthropic
        json!({"id": "claude-opus-4-5", "object": "model", "created": now, "owned_by": "anthropic"}),
        json!({"id": "claude-sonnet-4-5", "object": "model", "created": now, "owned_by": "anthropic"}),
        json!({"id": "claude-haiku-4-5", "object": "model", "created": now, "owned_by": "anthropic"}),
        json!({"id": "claude-3-5-sonnet-20241022", "object": "model", "created": now, "owned_by": "anthropic"}),
        json!({"id": "claude-3-5-haiku-20241022", "object": "model", "created": now, "owned_by": "anthropic"}),
        // Core agents
        json!({"id": "zeroclaw", "object": "model", "created": now, "owned_by": "core"}),
        json!({"id": "openclaw", "object": "model", "created": now, "owned_by": "core"}),
        // OpenRouter — openrouter/auto lets OpenRouter pick the best model on its
        // side AFTER Ryu's own guardrails/budgets have already run. Use any
        // openrouter/<model-slug> pattern to target a specific model via OpenRouter.
        json!({"id": "openrouter/auto", "object": "model", "created": now, "owned_by": "openrouter"}),
        // Local
        json!({"id": "llama3.2:latest", "object": "model", "created": now, "owned_by": "local"}),
        json!({"id": "mistral:latest", "object": "model", "created": now, "owned_by": "local"}),
        json!({"id": "phi4:latest", "object": "model", "created": now, "owned_by": "local"}),
        json!({"id": "deepseek-r1:latest", "object": "model", "created": now, "owned_by": "local"}),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{EvalRoutingConfig, ModalityMapping, ProviderKind};
    use std::collections::HashMap;

    fn tiered_router(chain: Vec<ProviderKind>, tiers: &[(ProviderKind, u8)]) -> ModelRouter {
        ModelRouter::new(RoutingConfig {
            fallback_chain: chain.into_iter().map(ProviderId::from).collect(),
            provider_tiers: tiers
                .iter()
                .map(|(p, t)| (ProviderId::from(p.clone()), *t))
                .collect(),
            ..Default::default()
        })
    }

    #[test]
    fn fallback_chain_pins_primary_then_sorts_by_tier() {
        // Configured chain lists cheap(1) BEFORE sub(0); tier sort must reorder
        // them behind the pinned primary. Primary is OpenRouter (free, tier 2).
        let r = tiered_router(
            vec![
                ProviderKind::OpenRouter,
                ProviderKind::Local,
                ProviderKind::OpenAi,
            ],
            &[
                (ProviderKind::OpenAi, 0),
                (ProviderKind::Local, 1),
                (ProviderKind::OpenRouter, 2),
            ],
        );
        let chain = r.fallback_chain(&ProviderId::from(ProviderKind::OpenRouter));
        // Primary stays first even though it is the most expensive tier; the rest
        // demote sub(0) → cheap(1).
        assert_eq!(
            chain,
            vec![
                ProviderKind::OpenRouter,
                ProviderKind::OpenAi,
                ProviderKind::Local
            ]
        );
    }

    #[test]
    fn fallback_chain_empty_tiers_preserves_order() {
        let r = tiered_router(
            vec![ProviderKind::Local, ProviderKind::OpenAi],
            &[], // no tiers configured
        );
        let chain = r.fallback_chain(&ProviderId::from(ProviderKind::Anthropic));
        assert_eq!(
            chain,
            vec![
                ProviderKind::Anthropic,
                ProviderKind::Local,
                ProviderKind::OpenAi
            ]
        );
    }

    fn ab_router(explore_ratio: f32) -> ModelRouter {
        let config = RoutingConfig {
            default_provider: ProviderKind::OpenAi.into(),
            model_map: HashMap::new(),
            fallback_chain: Vec::new(),
            provider_tiers: HashMap::new(),
            eval_routing: EvalRoutingConfig {
                enabled: true,
                candidates: vec![ProviderKind::OpenAi.into(), ProviderKind::Anthropic.into()],
                explore_ratio,
            },
            modality_map: HashMap::new(),
            smart_routing: Default::default(),
        };
        ModelRouter::new(config)
    }

    #[test]
    fn eval_route_disabled_returns_none() {
        let router = ModelRouter::new(RoutingConfig::default());
        assert!(router.eval_route("gpt-4o", |_| Some(0.5)).is_none());
    }

    #[test]
    fn apple_foundationmodel_routes_to_local() {
        // Apple Foundation Models are served on-device by Core's `apfel` local
        // engine, so the built-in prefix must send this exact id to the Local
        // provider (which forwards to LOCAL_LLM_URL → apfel:11434).
        let router = ModelRouter::new(RoutingConfig::default());
        let decision = router.route("apple-foundationmodel");
        assert_eq!(decision.provider, ProviderKind::Local);
        assert_eq!(decision.model, "apple-foundationmodel");
    }

    #[test]
    fn eval_route_explores_unscored_candidate_first() {
        let router = ab_router(0.0);
        // Anthropic has no score yet, so it must be explored before exploiting.
        let decision = router
            .eval_route("gpt-4o", |p| match p.as_str() {
                "openai" => Some(0.9),
                _ => None,
            })
            .expect("eval routing active");
        assert_eq!(decision.provider, ProviderKind::Anthropic);
    }

    #[test]
    fn eval_route_exploits_leader_when_all_scored() {
        // explore_ratio 0 => always exploit the highest-scoring candidate.
        let router = ab_router(0.0);
        for _ in 0..20 {
            let decision = router
                .eval_route("gpt-4o", |p| match p.as_str() {
                    "openai" => Some(0.3),
                    "anthropic" => Some(0.8),
                    _ => None,
                })
                .expect("eval routing active");
            assert_eq!(decision.provider, ProviderKind::Anthropic);
        }
    }

    #[test]
    fn eval_route_reserves_traffic_for_exploration() {
        let router = ab_router(0.25);
        let mut leader_hits = 0;
        let mut explore_hits = 0;
        for _ in 0..100 {
            let decision = router
                .eval_route("gpt-4o", |p| match p.as_str() {
                    "openai" => Some(0.3),
                    "anthropic" => Some(0.8),
                    _ => None,
                })
                .expect("eval routing active");
            if decision.provider == ProviderKind::Anthropic {
                leader_hits += 1;
            } else {
                explore_hits += 1;
            }
        }
        // Roughly a quarter of traffic explores the non-leader candidate.
        assert!(explore_hits > 0, "expected some exploration traffic");
        assert!(leader_hits > explore_hits, "leader should win most traffic");
    }

    #[test]
    fn openrouter_prefix_routes_to_openrouter_provider() {
        let router = ModelRouter::new(RoutingConfig::default());
        // "openrouter/auto" should route to OpenRouter so its own auto-selection
        // runs AFTER Ryu's guardrails have already evaluated the request.
        let decision = router.route("openrouter/auto");
        assert_eq!(decision.provider, ProviderKind::OpenRouter);
        assert_eq!(decision.model, "openrouter/auto");
    }

    #[test]
    fn openrouter_prefix_routes_any_slug() {
        let router = ModelRouter::new(RoutingConfig::default());
        let decision = router.route("openrouter/mistralai/mistral-7b-instruct");
        assert_eq!(decision.provider, ProviderKind::OpenRouter);
        assert_eq!(decision.model, "openrouter/mistralai/mistral-7b-instruct");
    }

    #[test]
    fn gemini_prefix_routes_to_genai_provider() {
        let router = ModelRouter::new(RoutingConfig::default());
        // Native Gemini models go through the genai-backed provider, with the
        // model name passed through unchanged for genai to resolve.
        let decision = router.route("gemini-2.5-pro");
        assert_eq!(decision.provider, ProviderKind::GenAi);
        assert_eq!(decision.model, "gemini-2.5-pro");
    }

    // ─── Modality routing tests ───────────────────────────────────────────────

    fn router_with_modality_map() -> ModelRouter {
        let mut modality_map = HashMap::new();
        modality_map.insert(
            Modality::Image,
            ModalityMapping {
                provider: ProviderKind::OpenAi.into(),
                model: Some("dall-e-3".to_string()),
            },
        );
        modality_map.insert(
            Modality::Tts,
            ModalityMapping {
                provider: ProviderKind::OpenAi.into(),
                model: Some("tts-1".to_string()),
            },
        );
        modality_map.insert(
            Modality::Stt,
            ModalityMapping {
                provider: ProviderKind::OpenAi.into(),
                model: Some("whisper-1".to_string()),
            },
        );
        let config = RoutingConfig {
            default_provider: ProviderKind::Local.into(),
            model_map: HashMap::new(),
            fallback_chain: Vec::new(),
            provider_tiers: HashMap::new(),
            eval_routing: EvalRoutingConfig::default(),
            modality_map,
            smart_routing: Default::default(),
        };
        ModelRouter::new(config)
    }

    #[test]
    fn route_modality_image_uses_configured_provider_and_model() {
        let router = router_with_modality_map();
        let decision = router.route_modality(&Modality::Image, "dall-e-3");
        assert_eq!(decision.provider, ProviderKind::OpenAi);
        assert_eq!(decision.model, "dall-e-3");
    }

    #[test]
    fn route_modality_stt_uses_configured_provider_and_model() {
        let router = router_with_modality_map();
        let decision = router.route_modality(&Modality::Stt, "whisper-1");
        assert_eq!(decision.provider, ProviderKind::OpenAi);
        assert_eq!(decision.model, "whisper-1");
    }

    #[test]
    fn route_modality_tts_uses_configured_provider_and_model() {
        let router = router_with_modality_map();
        let decision = router.route_modality(&Modality::Tts, "tts-1");
        assert_eq!(decision.provider, ProviderKind::OpenAi);
        assert_eq!(decision.model, "tts-1");
    }

    #[test]
    fn route_modality_falls_back_to_model_routing_when_no_entry() {
        // A router with no modality_map falls back to model-based routing.
        let router = ModelRouter::new(RoutingConfig::default());
        let decision = router.route_modality(&Modality::Image, "gpt-4o");
        // The default provider is OpenAi and gpt-4o routes there.
        assert_eq!(decision.provider, ProviderKind::OpenAi);
    }

    #[test]
    fn route_modality_model_override_wins_over_caller_model() {
        // When the mapping pins a model, that model is used regardless of what
        // the caller passed in.
        let router = router_with_modality_map();
        let decision = router.route_modality(&Modality::Image, "some-other-model");
        assert_eq!(decision.model, "dall-e-3");
    }

    #[test]
    fn route_modality_no_model_override_passes_caller_model() {
        // When the mapping has no model pin, the caller's model is forwarded.
        let mut modality_map = HashMap::new();
        modality_map.insert(
            Modality::Image,
            ModalityMapping {
                provider: ProviderKind::OpenAi.into(),
                model: None,
            },
        );
        let router = ModelRouter::new(RoutingConfig {
            default_provider: ProviderKind::Local.into(),
            model_map: HashMap::new(),
            fallback_chain: Vec::new(),
            provider_tiers: HashMap::new(),
            eval_routing: EvalRoutingConfig::default(),
            modality_map,
            smart_routing: Default::default(),
        });
        let decision = router.route_modality(&Modality::Image, "my-custom-image-model");
        assert_eq!(decision.provider, ProviderKind::OpenAi);
        assert_eq!(decision.model, "my-custom-image-model");
    }
}

// ─── Swappable model-routing backend (W6c decomposition) ─────────────────────

/// Model routing (Plane A) as a swappable capability. The built-in
/// [`ModelRouter`] (model-map + prefix rules + eval/AB + fallback tiers) is the
/// default; an alternative router can register without touching the pipeline,
/// mirroring the [`crate::budget::BudgetRegistry`] inversion. The trait carries
/// exactly the surface the pipeline drives through `state.router`. `RouteDecision`
/// is returned by value (a cheap clone), so a sync borrowing accessor is fine —
/// no need for the async smart-router shape.
pub trait RouterBackend: Send + Sync {
    /// Resolve provider + model for a chat request model string.
    fn route(&self, requested_model: &str) -> RouteDecision;
    /// Resolve provider + model for a modality request, honoring a per-agent slot.
    fn route_modality_with_slot(
        &self,
        modality: &Modality,
        requested_model: &str,
        slot_provider: Option<&ProviderId>,
        slot_model: Option<&str>,
    ) -> RouteDecision;
    /// Ordered fallback chain for a primary provider (primary pinned first).
    fn fallback_chain(&self, primary: &ProviderId) -> Vec<ProviderId>;
    /// Eval-driven (A/B) route, or `None` when eval routing is inapplicable.
    /// `score_of` is a trait object (not `impl Fn`) so the method stays
    /// object-safe; the registry's inherent wrapper keeps the generic ergonomics.
    fn eval_route(
        &self,
        requested_model: &str,
        score_of: &dyn Fn(&ProviderId) -> Option<f32>,
    ) -> Option<RouteDecision>;
}

impl RouterBackend for ModelRouter {
    fn route(&self, requested_model: &str) -> RouteDecision {
        ModelRouter::route(self, requested_model)
    }
    fn route_modality_with_slot(
        &self,
        modality: &Modality,
        requested_model: &str,
        slot_provider: Option<&ProviderId>,
        slot_model: Option<&str>,
    ) -> RouteDecision {
        ModelRouter::route_modality_with_slot(
            self,
            modality,
            requested_model,
            slot_provider,
            slot_model,
        )
    }
    fn fallback_chain(&self, primary: &ProviderId) -> Vec<ProviderId> {
        ModelRouter::fallback_chain(self, primary)
    }
    fn eval_route(
        &self,
        requested_model: &str,
        score_of: &dyn Fn(&ProviderId) -> Option<f32>,
    ) -> Option<RouteDecision> {
        ModelRouter::eval_route(self, requested_model, score_of)
    }
}

/// Id-keyed registry over [`RouterBackend`] implementations with a live-swap
/// discipline, matching [`crate::budget::BudgetRegistry`]. The built-in
/// [`ModelRouter`] is registered under [`RouterRegistry::BUILTIN`] and active by
/// default, so behavior is byte-identical with no config change. The inherent
/// `route` / `route_modality_with_slot` / `fallback_chain` / `eval_route` methods
/// delegate to the active backend, so existing `state.router.route(…)` call sites
/// are untouched; by-ref consumers take [`RouterRegistry::active`].
///
/// The model-map / fallback / tiers remain a startup snapshot (restart-only, as
/// before) — there is no `update_config` hot-swap here, matching the pre-inversion
/// `ModelRouter` field.
pub struct RouterRegistry {
    inner: std::sync::RwLock<RouterRegistryInner>,
}

struct RouterRegistryInner {
    backends: std::collections::HashMap<String, std::sync::Arc<dyn RouterBackend>>,
    order: Vec<String>,
    active_id: String,
    active: std::sync::Arc<dyn RouterBackend>,
}

impl RouterRegistry {
    /// Stable id of the built-in in-process model router.
    pub const BUILTIN: &'static str = "builtin";

    /// Build the registry from config, registering a fresh built-in
    /// [`ModelRouter`] as the default active backend.
    pub fn new(config: RoutingConfig) -> Self {
        let builtin: std::sync::Arc<dyn RouterBackend> =
            std::sync::Arc::new(ModelRouter::new(config));
        let mut backends = std::collections::HashMap::new();
        backends.insert(Self::BUILTIN.to_string(), std::sync::Arc::clone(&builtin));
        Self {
            inner: std::sync::RwLock::new(RouterRegistryInner {
                backends,
                order: vec![Self::BUILTIN.to_string()],
                active_id: Self::BUILTIN.to_string(),
                active: builtin,
            }),
        }
    }

    /// Clone the active backend out under a brief read lock (recovering from a
    /// poisoned lock). The returned `Arc` holds no lock, so by-ref consumers
    /// (smart router, inspector) can keep it across an `.await`.
    pub fn active(&self) -> std::sync::Arc<dyn RouterBackend> {
        match self.inner.read() {
            Ok(guard) => std::sync::Arc::clone(&guard.active),
            Err(poisoned) => std::sync::Arc::clone(&poisoned.into_inner().active),
        }
    }

    /// Resolve provider + model for a chat request (delegates to the active backend).
    pub fn route(&self, requested_model: &str) -> RouteDecision {
        self.active().route(requested_model)
    }

    /// Resolve provider + model for a modality request (delegates to active backend).
    pub fn route_modality_with_slot(
        &self,
        modality: &Modality,
        requested_model: &str,
        slot_provider: Option<&ProviderId>,
        slot_model: Option<&str>,
    ) -> RouteDecision {
        self.active()
            .route_modality_with_slot(modality, requested_model, slot_provider, slot_model)
    }

    /// Ordered fallback chain for a primary provider (delegates to active backend).
    pub fn fallback_chain(&self, primary: &ProviderId) -> Vec<ProviderId> {
        self.active().fallback_chain(primary)
    }

    /// Eval-driven route (delegates to active backend). Kept generic over the
    /// scorer so `state.router.eval_route(m, |p| …)` call sites are unchanged.
    pub fn eval_route(
        &self,
        requested_model: &str,
        score_of: impl Fn(&ProviderId) -> Option<f32>,
    ) -> Option<RouteDecision> {
        self.active().eval_route(requested_model, &score_of)
    }

    /// Register a backend under a stable id (open extension point). Re-registering
    /// replaces in place; refreshes the live handle if it is the active id.
    #[allow(dead_code)]
    pub fn register(&self, id: impl Into<String>, backend: std::sync::Arc<dyn RouterBackend>) {
        let id = id.into();
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if !guard.backends.contains_key(&id) {
            guard.order.push(id.clone());
        }
        let is_active = id == guard.active_id;
        guard.backends.insert(id, std::sync::Arc::clone(&backend));
        if is_active {
            guard.active = backend;
        }
    }

    /// Select the active backend by id. `false` (unchanged) if `id` is unknown.
    pub fn set_active(&self, id: &str) -> bool {
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        match guard.backends.get(id).map(std::sync::Arc::clone) {
            Some(backend) => {
                guard.active = backend;
                guard.active_id = id.to_string();
                true
            }
            None => false,
        }
    }

    /// The id of the currently active backend.
    #[allow(dead_code)]
    pub fn active_id(&self) -> String {
        match self.inner.read() {
            Ok(g) => g.active_id.clone(),
            Err(p) => p.into_inner().active_id.clone(),
        }
    }

    /// The registered backend ids in registration order.
    pub fn available(&self) -> Vec<String> {
        match self.inner.read() {
            Ok(g) => g.order.clone(),
            Err(p) => p.into_inner().order.clone(),
        }
    }
}

#[cfg(test)]
mod router_registry_tests {
    use super::*;
    use crate::config::{ProviderKind, RoutingConfig};

    /// A stub backend answering every route with a fixed sentinel — proof the
    /// registry dispatches to a swapped-in impl.
    struct StubRouter;
    impl RouterBackend for StubRouter {
        fn route(&self, _requested_model: &str) -> RouteDecision {
            RouteDecision {
                provider: ProviderId::from("stub"),
                model: "stub-model".to_string(),
            }
        }
        fn route_modality_with_slot(
            &self,
            _modality: &Modality,
            _requested_model: &str,
            _slot_provider: Option<&ProviderId>,
            _slot_model: Option<&str>,
        ) -> RouteDecision {
            RouteDecision {
                provider: ProviderId::from("stub"),
                model: "stub-model".to_string(),
            }
        }
        fn fallback_chain(&self, _primary: &ProviderId) -> Vec<ProviderId> {
            vec![ProviderId::from("stub")]
        }
        fn eval_route(
            &self,
            _requested_model: &str,
            _score_of: &dyn Fn(&ProviderId) -> Option<f32>,
        ) -> Option<RouteDecision> {
            None
        }
    }

    #[test]
    fn builtin_is_the_default_active_backend() {
        let reg = RouterRegistry::new(RoutingConfig::default());
        assert_eq!(reg.active_id(), RouterRegistry::BUILTIN);
        assert_eq!(reg.available(), vec![RouterRegistry::BUILTIN.to_string()]);
        // The built-in routes a claude- model to Anthropic via the inherent method.
        assert_eq!(reg.route("claude-sonnet-4-5").provider, ProviderKind::Anthropic);
    }

    #[test]
    fn register_then_set_active_swaps_the_live_backend() {
        let reg = RouterRegistry::new(RoutingConfig::default());
        reg.register(
            "stub",
            std::sync::Arc::new(StubRouter) as std::sync::Arc<dyn RouterBackend>,
        );
        // Registered but not active: the built-in still answers.
        assert_eq!(reg.route("claude-sonnet-4-5").provider, ProviderKind::Anthropic);

        assert!(reg.set_active("stub"));
        assert_eq!(reg.active_id(), "stub");
        // The stub's sentinel now answers — the swap is live.
        assert_eq!(reg.route("claude-sonnet-4-5").model, "stub-model");

        // Unknown id is a no-op keeping the current active backend.
        assert!(!reg.set_active("nope"));
        assert_eq!(reg.active_id(), "stub");
    }
}
