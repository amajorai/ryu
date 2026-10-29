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
        let mut model_map: std::collections::HashMap<String, (String, Option<String>)> = config
            .model_map
            .iter()
            .map(|(k, m)| {
                (
                    k.clone(),
                    (m.provider.as_str().to_string(), m.provider_model.clone()),
                )
            })
            .collect();
        model_map
            .entry("edge-tts".to_owned())
            .or_insert_with(|| ("edge-tts".to_owned(), None));
        for id in ["google-tts", "google-translate-tts", "polly"] {
            model_map
                .entry(id.to_owned())
                .or_insert_with(|| (id.to_owned(), None));
        }
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
        let mut builtin_prefixes: Vec<_> = ryu_gw_credentials::SDK_PROVIDERS
            .iter()
            .map(|descriptor| {
                (
                    format!("{}::", descriptor.kind),
                    descriptor.provider_id.to_owned(),
                )
            })
            .collect();
        for (namespace, id) in [
            ("zai_coding", "genai-zai"),
            ("baidu-coding-openai", "genai-baidu"),
            ("baidu-coding-anthropic", "genai-baidu"),
        ] {
            builtin_prefixes.push((format!("{namespace}::"), id.to_owned()));
        }
        builtin_prefixes.push(("edge-tts::".to_owned(), "edge-tts".to_owned()));
        builtin_prefixes.push(("google-tts::".to_owned(), "google-tts".to_owned()));
        builtin_prefixes.push((
            "google-translate-tts::".to_owned(),
            "google-translate-tts".to_owned(),
        ));
        builtin_prefixes.push(("polly::".to_owned(), "polly".to_owned()));
        builtin_prefixes.extend(ryu_gw_router::builtin_prefixes());
        let tables = ryu_gw_router::RoutingTables {
            model_map,
            builtin_prefixes,
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

    /// [`Self::route`] plus the precedence step that produced it, so the routing
    /// layer can tell an explicit target from the default-provider catch-all.
    pub fn route_with_source(
        &self,
        requested_model: &str,
    ) -> (RouteDecision, ryu_gw_router::RouteSource) {
        let (provider, model, source) = self.tables.route_with_source(requested_model);
        (
            RouteDecision {
                provider: ProviderId::from(provider),
                model,
            },
            source,
        )
    }

    /// Whether a per-agent slot or a static `modality_map` entry answers this
    /// modality before ordinary model routing does.
    fn modality_is_pinned(&self, modality: &Modality, slot_provider: Option<&ProviderId>) -> bool {
        slot_provider.is_some() || self.tables.modality_map.contains_key(modality.as_str())
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
        // OpenRouter — these upstream routers select a model AFTER Ryu's own
        // guardrails/budgets have already run. Use any openrouter/<model-slug>
        // pattern to target a specific model via OpenRouter.
        json!({"id": "openrouter/auto", "object": "model", "created": now, "owned_by": "openrouter"}),
        json!({"id": "openrouter/pareto-code", "object": "model", "created": now, "owned_by": "openrouter"}),
        // Gemini's native image models are served through the `genai` image
        // adapter. They appear only when that provider is configured.
        json!({"id": "gemini-2.5-flash-image", "object": "model", "created": now, "owned_by": "genai", "modality": "image"}),
        json!({"id": "gemini-3.1-flash-image", "object": "model", "created": now, "owned_by": "genai", "modality": "image"}),
        // AssemblyAI prerecorded transcription is a separate STT route.
        json!({"id": "universal-3-pro", "object": "model", "created": now, "owned_by": "assemblyai", "modality": "stt"}),
        json!({"id": "universal-2", "object": "model", "created": now, "owned_by": "assemblyai", "modality": "stt"}),
        json!({"id": "qwen-plus", "object": "model", "created": now, "owned_by": "qwen", "modality": "chat"}),
        json!({"id": "qwen3-asr-flash", "object": "model", "created": now, "owned_by": "qwen", "modality": "stt"}),
        json!({"id": "inworld-tts-2", "object": "model", "created": now, "owned_by": "inworld", "modality": "tts"}),
        json!({"id": "inworld-tts-2-flash", "object": "model", "created": now, "owned_by": "inworld", "modality": "tts"}),
        // Anonymous consumer TTS, exposed only when explicitly registered.
        json!({"id":"edge-tts","object":"model","created":now,"owned_by":"edge-tts","modality":"tts"}),
        json!({"id":"google-tts","object":"model","created":now,"owned_by":"google-tts","modality":"tts"}),
        json!({"id":"google-translate-tts","object":"model","created":now,"owned_by":"google-translate-tts","modality":"tts"}),
        json!({"id":"polly","object":"model","created":now,"owned_by":"polly","modality":"tts"}),
        // Local
        json!({"id": "llama3.2:latest", "object": "model", "created": now, "owned_by": "local"}),
        json!({"id": "mistral:latest", "object": "model", "created": now, "owned_by": "local"}),
        json!({"id": "phi4:latest", "object": "model", "created": now, "owned_by": "local"}),
        json!({"id": "deepseek-r1:latest", "object": "model", "created": now, "owned_by": "local"}),
    ]
}

#[cfg(test)]
mod tests {
    #[test]
    fn edge_tts_exact_and_qualified_voice_routes_preserve_native_voice() {
        let router = super::ModelRouter::new(crate::config::RoutingConfig::default());
        for model in ["edge-tts", "edge-tts::en-US-AriaNeural"] {
            let route = router.route_modality(&crate::config::Modality::Tts, model);
            assert_eq!(route.provider.as_str(), "edge-tts");
            assert_eq!(route.model, model);
        }
    }
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
            web: Default::default(),
            web_pools: Default::default(),
            default_provider: ProviderKind::OpenAi.into(),
            model_map: HashMap::new(),
            fallback_chain: Vec::new(),
            provider_tiers: HashMap::new(),
            provider_pools: HashMap::new(),
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
        // provider (which forwards to LOCAL_LLM_URL → apfel's own loopback port).
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
    fn builtin_models_include_openrouter_pareto_code() {
        assert!(builtin_model_list()
            .iter()
            .any(|model| model["id"] == "openrouter/pareto-code"));
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

    #[test]
    fn sdk_namespaces_and_coding_aliases_keep_native_routes_distinct() {
        let router = ModelRouter::new(RoutingConfig::default());
        for (model, owner) in [
            ("openai::gpt-4o", "genai-openai"),
            ("groq::llama-3.3-70b-versatile", "genai-groq"),
            ("zai_coding::glm-4.7", "genai-zai"),
            ("baidu-coding-openai::ernie-4.5", "genai-baidu"),
            ("baidu-coding-anthropic::ernie-4.5", "genai-baidu"),
        ] {
            let decision = router.route(model);
            assert_eq!(decision.provider.as_str(), owner);
            assert_eq!(decision.model, model);
        }
        assert_eq!(router.route("gpt-4o").provider.as_str(), "openai");
        assert_eq!(
            router.route("claude-sonnet-4-5").provider.as_str(),
            "anthropic"
        );
        assert_eq!(router.route("gemini-2.5-pro").provider.as_str(), "genai");
    }

    #[test]
    fn sdk_namespace_operator_mappings_win() {
        for pattern in ["groq::llama-3.3-70b-versatile", "groq::"] {
            let mut config = RoutingConfig::default();
            config.model_map.insert(
                pattern.to_owned(),
                crate::config::ModelMapping {
                    provider: crate::config::ProviderId::from("custom-owner"),
                    provider_model: None,
                },
            );
            assert_eq!(
                ModelRouter::new(config)
                    .route("groq::llama-3.3-70b-versatile")
                    .provider
                    .as_str(),
                "custom-owner"
            );
        }
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
            web: Default::default(),
            web_pools: Default::default(),
            default_provider: ProviderKind::Local.into(),
            model_map: HashMap::new(),
            fallback_chain: Vec::new(),
            provider_tiers: HashMap::new(),
            provider_pools: HashMap::new(),
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
            web: Default::default(),
            web_pools: Default::default(),
            default_provider: ProviderKind::Local.into(),
            model_map: HashMap::new(),
            fallback_chain: Vec::new(),
            provider_tiers: HashMap::new(),
            provider_pools: HashMap::new(),
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

/// Provider ids the current provider generation registered, shared by every
/// [`UpstreamRouter`] of one registry. `None` until the provider runtime
/// publishes its set (unit-built registries), which keeps builtin prefixes on
/// their vendor exactly as the built-in router does.
pub type RegisteredProviders =
    std::sync::Arc<std::sync::RwLock<Option<std::collections::HashSet<String>>>>;

/// The routing layer bound to one upstream router (OpenRouter, LiteLLM, or the
/// node's local engine).
///
/// It is the built-in [`ModelRouter`] with the upstream taking what nothing
/// more specific claims. Resolution, first match wins:
///
/// 1. An operator `model_map` entry (exact or prefix) — including entries keyed
///    under `router/`.
/// 2. `router/<model>` — the router-neutral namespace — goes to this upstream,
///    with the model rewritten to the id the upstream expects
///    ([`ryu_gw_router::upstream_router_wire_model`]).
/// 3. A builtin prefix (`claude-` → Anthropic, `openrouter/` → OpenRouter,
///    `llama` → local) keeps its provider when that provider is registered;
///    when it is not, this upstream serves the id verbatim, so a router's own
///    aliases such as `gpt-4o` reach it on a node without an OpenAI key.
/// 4. Anything else — the step that would fall through to `default_provider`,
///    e.g. `anthropic/claude-sonnet-4` — goes to this upstream verbatim.
///
/// Modality slots, fallback tiers and eval routing are answered by the shared
/// built-in router, except that `router/` ids never enter eval A/B routing.
/// Selecting the layer is a live swap (`backends.router`); no provider is
/// rebuilt.
pub struct UpstreamRouter {
    upstream: ProviderId,
    builtin: std::sync::Arc<ModelRouter>,
    registered: RegisteredProviders,
}

impl UpstreamRouter {
    pub fn new(
        upstream: impl Into<ProviderId>,
        builtin: std::sync::Arc<ModelRouter>,
        registered: RegisteredProviders,
    ) -> Self {
        Self {
            upstream: upstream.into(),
            builtin,
            registered,
        }
    }

    /// `false` only when the published provider set is known and lacks `id`.
    fn provider_may_serve(&self, id: &ProviderId) -> bool {
        let guard = match self.registered.read() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard
            .as_ref()
            .is_none_or(|registered| registered.contains(id.as_str()))
    }

    fn upstream_decision(&self, model: String) -> RouteDecision {
        RouteDecision {
            provider: self.upstream.clone(),
            model,
        }
    }
}

impl RouterBackend for UpstreamRouter {
    fn route(&self, requested_model: &str) -> RouteDecision {
        let (decision, source) = self.builtin.route_with_source(requested_model);
        if source == ryu_gw_router::RouteSource::ModelMap {
            return decision;
        }
        if let Some(model) = ryu_gw_router::strip_upstream_router_prefix(requested_model) {
            return self.upstream_decision(ryu_gw_router::upstream_router_wire_model(
                self.upstream.as_str(),
                model,
            ));
        }
        match source {
            ryu_gw_router::RouteSource::BuiltinPrefix | ryu_gw_router::RouteSource::CreditPool
                if self.provider_may_serve(&decision.provider) =>
            {
                decision
            }
            _ => self.upstream_decision(decision.model),
        }
    }

    fn route_modality_with_slot(
        &self,
        modality: &Modality,
        requested_model: &str,
        slot_provider: Option<&ProviderId>,
        slot_model: Option<&str>,
    ) -> RouteDecision {
        if self.builtin.modality_is_pinned(modality, slot_provider) {
            return self.builtin.route_modality_with_slot(
                modality,
                requested_model,
                slot_provider,
                slot_model,
            );
        }
        RouterBackend::route(self, requested_model)
    }

    fn fallback_chain(&self, primary: &ProviderId) -> Vec<ProviderId> {
        self.builtin.fallback_chain(primary)
    }

    fn eval_route(
        &self,
        requested_model: &str,
        score_of: &dyn Fn(&ProviderId) -> Option<f32>,
    ) -> Option<RouteDecision> {
        // A router-neutral id names this layer's upstream; an A/B candidate
        // would receive the literal `router/` id and reject it.
        if ryu_gw_router::strip_upstream_router_prefix(requested_model).is_some() {
            return None;
        }
        self.builtin.eval_route(requested_model, score_of)
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
    registered: RegisteredProviders,
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
    ///
    /// Every upstream router in [`ryu_gw_router::UPSTREAM_ROUTER_IDS`] is also
    /// registered, sharing the same built-in tables, so the routing layer can be
    /// swapped live with `backends.router`. Registration does not require the
    /// upstream's credentials: a selected router whose provider is not configured
    /// misses the provider registry and takes the ordinary provider-unavailable
    /// path, exactly like a `default_provider` naming an absent provider.
    pub fn new(config: RoutingConfig) -> Self {
        let model_router = std::sync::Arc::new(ModelRouter::new(config));
        let registered: RegisteredProviders = Default::default();
        let builtin: std::sync::Arc<dyn RouterBackend> = model_router.clone();
        let mut backends = std::collections::HashMap::new();
        let mut order = vec![Self::BUILTIN.to_string()];
        backends.insert(Self::BUILTIN.to_string(), std::sync::Arc::clone(&builtin));
        for upstream in ryu_gw_router::UPSTREAM_ROUTER_IDS {
            let backend: std::sync::Arc<dyn RouterBackend> =
                std::sync::Arc::new(UpstreamRouter::new(
                    *upstream,
                    std::sync::Arc::clone(&model_router),
                    std::sync::Arc::clone(&registered),
                ));
            backends.insert((*upstream).to_string(), backend);
            order.push((*upstream).to_string());
        }
        Self {
            inner: std::sync::RwLock::new(RouterRegistryInner {
                backends,
                order,
                active_id: Self::BUILTIN.to_string(),
                active: builtin,
            }),
            registered,
        }
    }

    /// Publish the provider ids the current provider generation registered, so
    /// an upstream routing layer can take builtin-prefix ids whose vendor is
    /// absent. Called by the provider runtime whenever it publishes.
    pub fn set_registered_providers(&self, providers: impl IntoIterator<Item = String>) {
        let mut guard = match self.registered.write() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        *guard = Some(providers.into_iter().collect());
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
        assert_eq!(
            reg.available(),
            vec![
                RouterRegistry::BUILTIN.to_string(),
                "openrouter".to_string(),
                "litellm".to_string(),
                "local".to_string(),
            ]
        );
        // The built-in routes a claude- model to Anthropic via the inherent method.
        assert_eq!(
            reg.route("claude-sonnet-4-5").provider,
            ProviderKind::Anthropic
        );
    }

    #[test]
    fn register_then_set_active_swaps_the_live_backend() {
        let reg = RouterRegistry::new(RoutingConfig::default());
        reg.register(
            "stub",
            std::sync::Arc::new(StubRouter) as std::sync::Arc<dyn RouterBackend>,
        );
        // Registered but not active: the built-in still answers.
        assert_eq!(
            reg.route("claude-sonnet-4-5").provider,
            ProviderKind::Anthropic
        );

        assert!(reg.set_active("stub"));
        assert_eq!(reg.active_id(), "stub");
        // The stub's sentinel now answers — the swap is live.
        assert_eq!(reg.route("claude-sonnet-4-5").model, "stub-model");

        // Unknown id is a no-op keeping the current active backend.
        assert!(!reg.set_active("nope"));
        assert_eq!(reg.active_id(), "stub");
    }

    fn routing_with_pin() -> RoutingConfig {
        let mut config = RoutingConfig::default();
        config.model_map.insert(
            "house-model".to_string(),
            crate::config::ModelMapping {
                provider: ProviderId::from("anthropic"),
                provider_model: Some("claude-sonnet-4-5".to_string()),
            },
        );
        config
    }

    #[test]
    fn builtin_layer_keeps_router_neutral_ids_on_the_default_provider() {
        let reg = RouterRegistry::new(RoutingConfig::default());
        let decision = reg.route("anthropic/claude-sonnet-4");
        assert_eq!(decision.provider.as_str(), "openai");
        assert_eq!(decision.model, "anthropic/claude-sonnet-4");
    }

    #[test]
    fn swapping_the_routing_layer_repoints_router_neutral_and_catch_all_ids() {
        let reg = RouterRegistry::new(routing_with_pin());

        assert!(reg.set_active("openrouter"));
        let auto = reg.route("router/auto");
        assert_eq!(
            (auto.provider.as_str(), auto.model.as_str()),
            ("openrouter", "openrouter/auto")
        );
        let unmatched = reg.route("anthropic/claude-sonnet-4");
        assert_eq!(
            (unmatched.provider.as_str(), unmatched.model.as_str()),
            ("openrouter", "anthropic/claude-sonnet-4")
        );

        // A live swap to LiteLLM re-points the same ids with no rebuild.
        assert!(reg.set_active("litellm"));
        let auto = reg.route("router/auto");
        assert_eq!(
            (auto.provider.as_str(), auto.model.as_str()),
            ("litellm", "auto")
        );
        let routed = reg.route("router/anthropic/claude-sonnet-4");
        assert_eq!(
            (routed.provider.as_str(), routed.model.as_str()),
            ("litellm", "anthropic/claude-sonnet-4")
        );
        assert_eq!(
            reg.route("anthropic/claude-sonnet-4").provider.as_str(),
            "litellm"
        );

        assert!(reg.set_active("local"));
        assert_eq!(reg.route("router/qwen3:8b").provider.as_str(), "local");
        assert_eq!(reg.route("router/qwen3:8b").model, "qwen3:8b");
    }

    #[test]
    fn upstream_layer_preserves_pins_vendor_prefixes_and_other_routers() {
        let reg = RouterRegistry::new(routing_with_pin());
        assert!(reg.set_active("litellm"));

        let pinned = reg.route("house-model");
        assert_eq!(
            (pinned.provider.as_str(), pinned.model.as_str()),
            ("anthropic", "claude-sonnet-4-5")
        );
        assert_eq!(
            reg.route("claude-sonnet-4-5").provider.as_str(),
            "anthropic"
        );
        assert_eq!(reg.route("llama3.2").provider.as_str(), "local");
        // Naming another router explicitly still reaches that router.
        let explicit = reg.route("openrouter/auto");
        assert_eq!(
            (explicit.provider.as_str(), explicit.model.as_str()),
            ("openrouter", "openrouter/auto")
        );
    }

    #[test]
    fn model_map_entries_under_the_router_namespace_outrank_the_upstream() {
        let mut config = RoutingConfig::default();
        config.model_map.insert(
            "router/fast".to_string(),
            crate::config::ModelMapping {
                provider: ProviderId::from("anthropic"),
                provider_model: Some("claude-haiku-4-5".to_string()),
            },
        );
        let reg = RouterRegistry::new(config);
        assert!(reg.set_active("litellm"));
        let pinned = reg.route("router/fast");
        assert_eq!(
            (pinned.provider.as_str(), pinned.model.as_str()),
            ("anthropic", "claude-haiku-4-5")
        );
        assert_eq!(reg.route("router/slow").provider.as_str(), "litellm");
    }

    #[test]
    fn builtin_prefixes_fall_to_the_upstream_when_their_vendor_is_unregistered() {
        let reg = RouterRegistry::new(RoutingConfig::default());
        reg.set_registered_providers(["litellm".to_string(), "anthropic".to_string()]);
        assert!(reg.set_active("litellm"));

        // LiteLLM serves its own `gpt-4o` alias on a node without an OpenAI key…
        let alias = reg.route("gpt-4o");
        assert_eq!(
            (alias.provider.as_str(), alias.model.as_str()),
            ("litellm", "gpt-4o")
        );
        // …while a configured vendor keeps its prefix.
        assert_eq!(
            reg.route("claude-sonnet-4-5").provider.as_str(),
            "anthropic"
        );

        // The built-in layer is unaffected by the published set.
        assert!(reg.set_active(RouterRegistry::BUILTIN));
        assert_eq!(reg.route("gpt-4o").provider.as_str(), "openai");
    }

    #[test]
    fn router_neutral_ids_never_enter_eval_routing() {
        let mut config = RoutingConfig::default();
        config.eval_routing = crate::config::EvalRoutingConfig {
            enabled: true,
            candidates: vec![ProviderId::from("openai"), ProviderId::from("anthropic")],
            explore_ratio: 0.0,
        };
        let reg = RouterRegistry::new(config);
        assert!(reg.set_active("openrouter"));
        assert!(reg.eval_route("router/auto", |_| None).is_none());
        assert!(reg.eval_route("gpt-4o", |_| None).is_some());
    }

    #[test]
    fn upstream_layer_honours_modality_pins_before_delegating() {
        let mut config = RoutingConfig::default();
        config.modality_map.insert(
            Modality::Image,
            crate::config::ModalityMapping {
                provider: ProviderId::from("fal"),
                model: None,
            },
        );
        let reg = RouterRegistry::new(config);
        assert!(reg.set_active("litellm"));

        let image = reg.route_modality_with_slot(&Modality::Image, "router/flux", None, None);
        assert_eq!(image.provider.as_str(), "fal");
        let slot = reg.route_modality_with_slot(
            &Modality::Tts,
            "tts-1",
            Some(&ProviderId::from("openai")),
            None,
        );
        assert_eq!(slot.provider.as_str(), "openai");
        let stt = reg.route_modality_with_slot(&Modality::Stt, "router/whisper-large", None, None);
        assert_eq!(
            (stt.provider.as_str(), stt.model.as_str()),
            ("litellm", "whisper-large")
        );
    }
}
