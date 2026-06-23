use std::sync::atomic::{AtomicU64, Ordering};

use tracing::debug;

use crate::config::{Modality, ModelMapping, ProviderKind, RoutingConfig};

pub mod smart;

/// The result of a routing decision.
#[derive(Debug, Clone)]
pub struct RouteDecision {
    /// Which provider to use
    pub provider: ProviderKind,
    /// The model name to send to the provider (may differ from the requested model)
    pub model: String,
}

pub struct ModelRouter {
    config: RoutingConfig,
    /// Built-in prefix-based rules evaluated before the user's model_map
    builtin_prefixes: Vec<(String, ProviderKind)>,
    /// Monotonic counter for deterministic explore/exploit splitting in
    /// eval-driven routing (avoids pulling in an RNG dependency).
    ab_counter: AtomicU64,
}

impl ModelRouter {
    pub fn new(config: RoutingConfig) -> Self {
        // Sensible built-in prefix rules so zero-config "just works"
        let builtin_prefixes = vec![
            ("zeroclaw".to_string(), ProviderKind::Core),
            ("openclaw".to_string(), ProviderKind::Core),
            ("claude-".to_string(), ProviderKind::Anthropic),
            ("gpt-".to_string(), ProviderKind::OpenAi),
            ("o1".to_string(), ProviderKind::OpenAi),
            ("o3".to_string(), ProviderKind::OpenAi),
            ("o4".to_string(), ProviderKind::OpenAi),
            ("text-davinci".to_string(), ProviderKind::OpenAi),
            // openrouter/ prefix: any model in the form "openrouter/<name>" is
            // dispatched to OpenRouter so the upstream provider's own routing
            // (e.g. openrouter/auto) takes over AFTER Ryu's guardrails run.
            ("openrouter/".to_string(), ProviderKind::OpenRouter),
            // modal/ prefix: any model in the form "modal/<name>" is dispatched
            // to the Ryu Cloud GPU node's Modal inference app (serverless GPU),
            // so a node can offload heavy local-model calls onto Modal's GPUs.
            ("modal/".to_string(), ProviderKind::Modal),
            // gemini-: native Gemini (and other native-format providers) served
            // through the genai-backed provider, so they route here rather than
            // to the OpenAI-compatible passthroughs.
            ("gemini-".to_string(), ProviderKind::GenAi),
            ("llama".to_string(), ProviderKind::Local),
            ("mistral".to_string(), ProviderKind::Local),
            ("mixtral".to_string(), ProviderKind::Local),
            ("gemma".to_string(), ProviderKind::Local),
            ("phi".to_string(), ProviderKind::Local),
            ("qwen".to_string(), ProviderKind::Local),
            ("deepseek".to_string(), ProviderKind::Local),
        ];

        Self {
            config,
            builtin_prefixes,
            ab_counter: AtomicU64::new(0),
        }
    }

    /// Whether eval-driven (A/B) routing is enabled with at least two candidates.
    pub fn eval_routing_enabled(&self) -> bool {
        self.config.eval_routing.enabled && self.config.eval_routing.candidates.len() >= 2
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
        score_of: impl Fn(&ProviderKind) -> Option<f32>,
    ) -> Option<RouteDecision> {
        if !self.eval_routing_enabled() {
            return None;
        }

        let candidates = &self.config.eval_routing.candidates;

        // 1. Explore any candidate that has no score yet.
        for candidate in candidates {
            if score_of(candidate).is_none() {
                debug!(requested = requested_model, provider = ?candidate, "eval_route: exploring unscored candidate");
                return Some(RouteDecision {
                    provider: candidate.clone(),
                    model: requested_model.to_string(),
                });
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
        let explore_ratio = self.config.eval_routing.explore_ratio.clamp(0.0, 1.0);
        let n = self.ab_counter.fetch_add(1, Ordering::Relaxed);
        let provider = if explore_ratio > 0.0 {
            let period = (1.0 / explore_ratio).round().max(1.0) as u64;
            if n % period == 0 {
                // Exploration slot: round-robin over the non-leader candidates.
                let others: Vec<&ProviderKind> =
                    candidates.iter().filter(|c| **c != leader).collect();
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
            provider = ?provider,
            leader = ?leader,
            "eval_route: eval-driven routing decision"
        );
        Some(RouteDecision {
            provider,
            model: requested_model.to_string(),
        })
    }

    /// Determine which provider and model name to use for a given request model string.
    pub fn route(&self, requested_model: &str) -> RouteDecision {
        let model_lower = requested_model.to_lowercase();

        // 1. Exact match in user's model_map
        if let Some(mapping) = self.config.model_map.get(requested_model) {
            let model = mapping
                .provider_model
                .clone()
                .unwrap_or_else(|| requested_model.to_string());
            debug!(requested = requested_model, provider = ?mapping.provider, routed_model = %model, "route: exact model map hit");
            return RouteDecision {
                provider: mapping.provider.clone(),
                model,
            };
        }

        // 2. Prefix match in user's model_map (longest prefix wins)
        if let Some(decision) = self.prefix_match_user_map(requested_model) {
            debug!(requested = requested_model, provider = ?decision.provider, "route: user prefix map hit");
            return decision;
        }

        // 3. Built-in prefix rules
        for (prefix, provider) in &self.builtin_prefixes {
            if model_lower.starts_with(prefix.as_str()) {
                debug!(requested = requested_model, provider = ?provider, "route: builtin prefix hit");
                return RouteDecision {
                    provider: provider.clone(),
                    model: requested_model.to_string(),
                };
            }
        }

        // 4. Fall back to configured default provider
        debug!(requested = requested_model, provider = ?self.config.default_provider, "route: default provider");
        RouteDecision {
            provider: self.config.default_provider.clone(),
            model: requested_model.to_string(),
        }
    }

    /// Resolve the provider and model for a non-chat modality request.
    ///
    /// Checks the `modality_map` first; if no explicit mapping exists the
    /// request falls back to normal model-based routing so zero-config installs
    /// always have a path.
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
        slot_provider: Option<&crate::config::ProviderKind>,
        slot_model: Option<&str>,
    ) -> RouteDecision {
        // 1. Per-agent slot override wins over the static modality map.
        if let Some(provider) = slot_provider {
            let model = slot_model
                .map(str::to_owned)
                .unwrap_or_else(|| requested_model.to_string());
            debug!(
                modality = modality.as_str(),
                requested = requested_model,
                provider = ?provider,
                routed_model = %model,
                "route_modality_with_slot: per-agent slot override"
            );
            return RouteDecision {
                provider: provider.clone(),
                model,
            };
        }

        // 2. Static modality_map entry.
        if let Some(mapping) = self.config.modality_map.get(modality) {
            let model = mapping
                .model
                .clone()
                .unwrap_or_else(|| requested_model.to_string());
            debug!(
                modality = modality.as_str(),
                requested = requested_model,
                provider = ?mapping.provider,
                routed_model = %model,
                "route_modality_with_slot: modality map hit"
            );
            return RouteDecision {
                provider: mapping.provider.clone(),
                model,
            };
        }

        // 3. No explicit modality mapping — fall back to standard model routing.
        debug!(
            modality = modality.as_str(),
            requested = requested_model,
            "route_modality_with_slot: no modality map entry, falling back to model routing"
        );
        self.route(requested_model)
    }

    /// Returns an ordered fallback chain for a given provider.
    /// The primary provider is first, followed by the configured fallback chain
    /// (with the primary removed to avoid duplicates).
    pub fn fallback_chain(&self, primary: &ProviderKind) -> Vec<ProviderKind> {
        let mut chain = vec![primary.clone()];
        for p in &self.config.fallback_chain {
            if p != primary {
                chain.push(p.clone());
            }
        }
        chain
    }

    fn prefix_match_user_map(&self, requested_model: &str) -> Option<RouteDecision> {
        let mut best: Option<(&str, &ModelMapping)> = None;

        for (key, mapping) in &self.config.model_map {
            if requested_model.starts_with(key.as_str()) {
                let is_longer = best.map_or(true, |(prev, _)| key.len() > prev.len());
                if is_longer {
                    best = Some((key.as_str(), mapping));
                }
            }
        }

        best.map(|(_, mapping)| {
            let model = mapping
                .provider_model
                .clone()
                .unwrap_or_else(|| requested_model.to_string());
            RouteDecision {
                provider: mapping.provider.clone(),
                model,
            }
        })
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
    use crate::config::{EvalRoutingConfig, ModalityMapping};
    use std::collections::HashMap;

    fn ab_router(explore_ratio: f32) -> ModelRouter {
        let config = RoutingConfig {
            default_provider: ProviderKind::OpenAi,
            model_map: HashMap::new(),
            fallback_chain: Vec::new(),
            eval_routing: EvalRoutingConfig {
                enabled: true,
                candidates: vec![ProviderKind::OpenAi, ProviderKind::Anthropic],
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
    fn eval_route_explores_unscored_candidate_first() {
        let router = ab_router(0.0);
        // Anthropic has no score yet, so it must be explored before exploiting.
        let decision = router
            .eval_route("gpt-4o", |p| match p {
                ProviderKind::OpenAi => Some(0.9),
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
                .eval_route("gpt-4o", |p| match p {
                    ProviderKind::OpenAi => Some(0.3),
                    ProviderKind::Anthropic => Some(0.8),
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
                .eval_route("gpt-4o", |p| match p {
                    ProviderKind::OpenAi => Some(0.3),
                    ProviderKind::Anthropic => Some(0.8),
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
                provider: ProviderKind::OpenAi,
                model: Some("dall-e-3".to_string()),
            },
        );
        modality_map.insert(
            Modality::Tts,
            ModalityMapping {
                provider: ProviderKind::OpenAi,
                model: Some("tts-1".to_string()),
            },
        );
        modality_map.insert(
            Modality::Stt,
            ModalityMapping {
                provider: ProviderKind::OpenAi,
                model: Some("whisper-1".to_string()),
            },
        );
        let config = RoutingConfig {
            default_provider: ProviderKind::Local,
            model_map: HashMap::new(),
            fallback_chain: Vec::new(),
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
                provider: ProviderKind::OpenAi,
                model: None,
            },
        );
        let router = ModelRouter::new(RoutingConfig {
            default_provider: ProviderKind::Local,
            model_map: HashMap::new(),
            fallback_chain: Vec::new(),
            eval_routing: EvalRoutingConfig::default(),
            modality_map,
            smart_routing: Default::default(),
        });
        let decision = router.route_modality(&Modality::Image, "my-custom-image-model");
        assert_eq!(decision.provider, ProviderKind::OpenAi);
        assert_eq!(decision.model, "my-custom-image-model");
    }
}
