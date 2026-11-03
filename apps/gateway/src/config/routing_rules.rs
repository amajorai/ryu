//! Route pools, smart-routing rule evaluation and model mappings.

use super::*;

/// Which targets automatic model routing may choose: a model-pattern list and a
/// provider-id list, both of which a target must satisfy. An empty list does not
/// constrain its dimension, so the default pool allows everything.
///
/// The pool narrows *routing decisions only*. A model the caller requested
/// explicitly — and the original model a fail-open router keeps — is governed
/// by the ordinary model allowlists, not by this pool.
///
/// Pools compose by intersection: the global `routing.smart_routing` pool is the
/// ceiling, and a per-agent pool (`routing.smart_routing.agent_pools`) can only
/// narrow it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct RoutePool {
    /// Case-insensitive model-id globs; `*` matches any run of characters.
    #[serde(default)]
    pub allowed_models: Vec<String>,
    /// Case-insensitive provider ids.
    #[serde(default)]
    pub allowed_providers: Vec<String>,
}

impl RoutePool {
    /// Maximum entries per list accepted from a request-scoped override.
    pub const MAX_ENTRIES: usize = 64;
    /// Maximum length of one entry accepted from a request-scoped override.
    pub const MAX_ENTRY_LEN: usize = 256;

    pub(super) fn entries(list: &[String]) -> impl Iterator<Item = &str> {
        list.iter()
            .map(|entry| entry.trim())
            .filter(|entry| !entry.is_empty())
    }

    /// Whether this pool constrains nothing (every list is empty or blank).
    pub fn is_unrestricted(&self) -> bool {
        Self::entries(&self.allowed_models).next().is_none()
            && Self::entries(&self.allowed_providers).next().is_none()
    }

    /// Whether a target `model`, resolved to `provider`, is inside the pool.
    pub fn allows(&self, model: &str, provider: &str) -> bool {
        let mut models = Self::entries(&self.allowed_models).peekable();
        let model_ok =
            models.peek().is_none() || models.any(|pattern| glob_matches(pattern, model));
        let mut providers = Self::entries(&self.allowed_providers).peekable();
        let provider_ok = providers.peek().is_none()
            || providers.any(|id| id.eq_ignore_ascii_case(provider.trim()));
        model_ok && provider_ok
    }

    /// Whether the pool fits the request-scoped override size limits.
    pub fn within_limits(&self) -> bool {
        [&self.allowed_models, &self.allowed_providers]
            .iter()
            .all(|list| {
                list.len() <= Self::MAX_ENTRIES
                    && list.iter().all(|entry| entry.len() <= Self::MAX_ENTRY_LEN)
            })
    }
}

/// Case-insensitive glob match where `*` matches any (possibly empty) run of
/// characters and every other character matches itself. Linear-time two-pointer
/// matcher, so a hostile pattern cannot trigger backtracking blowups.
pub(super) fn glob_matches(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().flat_map(char::to_lowercase).collect();
    let text: Vec<char> = text.trim().chars().flat_map(char::to_lowercase).collect();
    let (mut p, mut t) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pattern.len() && pattern[p] == '*' {
            star = Some((p, t));
            p += 1;
        } else if p < pattern.len() && pattern[p] == text[t] {
            p += 1;
            t += 1;
        } else if let Some((star_p, star_t)) = star {
            p = star_p + 1;
            t = star_t + 1;
            star = Some((star_p, star_t + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|c| *c == '*')
}

impl SmartRoutingConfig {
    /// This config's own model/provider pool.
    pub fn pool(&self) -> RoutePool {
        RoutePool {
            allowed_models: self.allowed_models.clone(),
            allowed_providers: self.allowed_providers.clone(),
        }
    }

    /// A copy of this config whose routing targets are limited to those `allows`
    /// accepts, so a router built from it can only choose inside the pool.
    ///
    /// - Classifier and weighted-random rules outside the pool are dropped, so
    ///   the classifier never sees them and the weights renormalize.
    /// - A `default_model` outside the pool is cleared (keep the requested model).
    /// - A two-tier router (`stage_router`, `escalation`) with one tier outside
    ///   the pool collapses onto the allowed tier; with both outside it has no
    ///   targets and goes inactive. The escalation *judge* and the classifier are
    ///   auxiliary calls, not routing targets, so the pool leaves them alone.
    ///
    /// A router left with too few targets simply reports inactive, which keeps
    /// the requested model — the module's usual fail-open outcome.
    pub fn restricted_to(&self, allows: impl Fn(&str) -> bool) -> Self {
        let mut next = self.clone();
        // Already applied by the caller; dropping them keeps the restricted
        // router's cache key independent of other agents' pools.
        next.agent_pools.clear();
        next.agent_routes.clear();
        next.rules.retain(|rule| allows(rule.model.trim()));
        if next
            .default_model
            .as_deref()
            .is_some_and(|model| !model.trim().is_empty() && !allows(model.trim()))
        {
            next.default_model = None;
        }
        restrict_tiers(
            &mut next.stage_capable_model,
            &mut next.stage_efficient_model,
            &allows,
        );
        restrict_tiers(
            &mut next.escalation_strong_model,
            &mut next.escalation_weak_model,
            &allows,
        );
        next
    }
    /// Whether smart routing should actually run: enabled, with at least one rule
    /// and whatever the chosen strategy needs to reach a decision. Anything short
    /// of this is a no-op (fail-open).
    ///
    /// - `Llm` needs a non-empty `classifier_model`. [`de_classifier_model`]
    ///   resolves a blank one to the classify tier as it comes off the wire, so
    ///   in practice this arm only trips on a config built in Rust — the check
    ///   stays as the last line of defence, not as the thing an operator hits.
    /// - `Embedding` needs an embedder (its own `embedding_model` or the semantic
    ///   cache's), validated at call time; here we only require rules.
    /// - `Keyword` needs nothing beyond rules.
    pub fn is_active(&self) -> bool {
        if !self.enabled {
            return false;
        }
        match self.router_type {
            ModelRouterType::Passthrough => true,
            ModelRouterType::LlmClassifier => {
                if self.rules.is_empty() {
                    return false;
                }
                match self.strategy {
                    RouteStrategy::Llm => !self.classifier_model.trim().is_empty(),
                    RouteStrategy::Embedding | RouteStrategy::Keyword => true,
                }
            }
            ModelRouterType::Random => {
                self.rules
                    .iter()
                    .filter(|rule| {
                        !rule.model.trim().is_empty()
                            && rule.weight.is_finite()
                            && rule.weight > 0.0
                    })
                    .count()
                    >= 2
            }
            ModelRouterType::StageRouter => {
                !self.stage_capable_model.trim().is_empty()
                    && !self.stage_efficient_model.trim().is_empty()
            }
            ModelRouterType::Escalation => {
                !self.escalation_weak_model.trim().is_empty()
                    && !self.escalation_strong_model.trim().is_empty()
                    && !self.escalation_judge_model.trim().is_empty()
            }
        }
    }
}

/// Collapse a two-tier pair onto whichever tier the pool allows: a tier outside
/// the pool takes the other tier's model when that one is configured and
/// allowed, and is cleared otherwise. A blank tier stays blank, so a router that
/// was missing a tier does not become active by restriction.
pub(super) fn restrict_tiers(
    first: &mut String,
    second: &mut String,
    allows: &impl Fn(&str) -> bool,
) {
    let usable = |model: &str| !model.trim().is_empty() && allows(model.trim());
    let outside = |model: &str| !model.trim().is_empty() && !allows(model.trim());
    let (first_outside, second_outside) = (outside(first), outside(second));
    let (first_usable, second_usable) = (usable(first), usable(second));
    if first_outside {
        if second_usable {
            first.clone_from(second);
        } else {
            first.clear();
        }
    }
    if second_outside {
        if first_usable {
            second.clone_from(first);
        } else {
            second.clear();
        }
    }
}

/// A single smart-routing rule: a natural-language condition plus the model to
/// route matching requests to.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SmartRule {
    /// Plain-language condition, e.g. `"writing or refactoring code"`.
    pub description: String,
    /// Target model id for matching requests, resolved via the model router
    /// (e.g. `"claude-sonnet-4-5"`, `"gpt-4o-mini"`, `"openrouter/google/gemini-2.5-flash"`).
    pub model: String,
    /// Relative traffic weight for the `random` router. Other router types ignore it.
    #[serde(default = "default_smart_rule_weight")]
    pub weight: f32,
}

pub(super) fn default_smart_rule_weight() -> f32 {
    1.0
}

/// A single modality-to-provider mapping entry. The `provider` field names
/// which backend handles this modality; the optional `model` field lets you
/// pin a specific model id (e.g. `"dall-e-3"` for image-gen) without changing
/// the provider config.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModalityMapping {
    pub provider: ProviderId,
    /// Model id to send to the provider. When absent the caller's `model`
    /// field is forwarded unchanged.
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EvalRoutingConfig {
    /// When true, eligible requests are routed by eval score across `candidates`.
    #[serde(default)]
    pub enabled: bool,

    /// Candidate providers to split traffic across. The router compares their
    /// rolling eval scores and sends most traffic to the leader, reserving
    /// `explore_ratio` for the others so scores stay fresh.
    #[serde(default)]
    pub candidates: Vec<ProviderId>,

    /// Fraction of eligible traffic reserved for exploration (non-leader
    /// candidates), in `[0.0, 1.0]`. Default: 0.2.
    #[serde(default = "default_explore_ratio")]
    pub explore_ratio: f32,
}

pub(super) fn default_explore_ratio() -> f32 {
    0.2
}

impl Default for EvalRoutingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            candidates: Vec::new(),
            explore_ratio: default_explore_ratio(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModelMapping {
    pub provider: ProviderId,
    /// If set, rewrite the model name before forwarding (e.g. "gpt-4" → "gpt-4o")
    pub provider_model: Option<String>,
}
