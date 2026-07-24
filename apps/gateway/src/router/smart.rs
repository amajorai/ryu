//! Classifier-driven ("smart") model routing.
//!
//! When [`crate::config::SmartRoutingConfig`] is active, a cheap "router" model
//! reads the user's latest message and picks the best-matching natural-language
//! rule. The request's model is then rewritten to that rule's target model and
//! handed to the ordinary [`crate::router::ModelRouter`], which resolves the
//! target's provider exactly as a hand-picked model would be. Nothing about
//! providers is decided here — only *which model* the request should use.
//!
//! Everything fails open: an inactive config, an unparseable reply, a classifier
//! error, or a timeout all leave the originally requested model untouched, so a
//! misconfiguration can never break chat. The classifier is called via
//! `Provider::complete` directly (never the pipeline), so it cannot recurse back
//! into smart routing.

use std::time::Duration;

use dashmap::DashMap;
use reqwest::Client;
use serde_json::{json, Value};
use tokio::sync::OnceCell;
use tracing::{debug, warn};

use ryu_gw_router::{
    build_prompt, keyword_match, last_user_message, parse_choice, truncate,
    MAX_CLASSIFIER_INPUT_CHARS,
};

use crate::{
    config::{OpenAiProviderConfig, RouteStrategy, SmartRoutingConfig},
    providers::ProviderRegistry,
    router::RouterBackend,
    semantic_cache::{cosine_similarity, embed_text},
};

/// Fallback embedding model for the `Embedding` strategy when the config leaves
/// `embedding_model` empty (matches the semantic cache's default local sidecar).
const DEFAULT_EMBED_MODEL: &str = "nomic-embed-text-v1.5";

/// Holds the smart-routing config snapshot plus a per-session decision cache.
///
/// Like [`ModelRouter`], the config is a startup snapshot; changes take effect
/// when the gateway is refreshed/restarted (the same constraint that applies to
/// all routing config — see `api/config.rs`).
pub struct SmartRouter {
    config: SmartRoutingConfig,
    /// `x-ryu-session-id` → chosen target model. Only used when
    /// `config.cache_by_session` is set.
    decisions: DashMap<String, String>,
    /// Lazily-computed embeddings for each rule's description, in rule order.
    /// Computed once on the first `Embedding`-strategy request. A `None` entry is
    /// a rule whose description could not be embedded (skipped when matching).
    rule_embeddings: OnceCell<Vec<Option<Vec<f32>>>>,
}

impl SmartRouter {
    pub fn new(config: SmartRoutingConfig) -> Self {
        Self {
            config,
            decisions: DashMap::new(),
            rule_embeddings: OnceCell::new(),
        }
    }

    /// Whether smart routing should run for this gateway at all.
    pub fn is_active(&self) -> bool {
        self.config.is_active()
    }

    /// Resolve the target model for a chat request, or `None` to keep the
    /// originally requested model (fail-open).
    ///
    /// `messages` is the request's `messages` array; `session_id` is the
    /// forwarded `x-ryu-session-id` used for the per-session decision cache.
    pub async fn resolve(
        &self,
        messages: &Value,
        session_id: Option<&str>,
        providers: &ProviderRegistry,
        router: &dyn RouterBackend,
        http: &Client,
        embed_provider: Option<&OpenAiProviderConfig>,
    ) -> Option<String> {
        if !self.is_active() {
            return None;
        }

        // 1. Per-session cache: classify once per conversation, reuse afterwards.
        if self.config.cache_by_session {
            if let Some(sid) = session_id {
                if let Some(hit) = self.decisions.get(sid) {
                    debug!(session = sid, model = %*hit, "smart routing: session cache hit");
                    return Some(hit.clone());
                }
            }
        }

        // 2. Dispatch to the configured strategy. Each fails open (→ None).
        let chosen = match self.config.strategy {
            RouteStrategy::Llm => self.classify_llm(messages, providers, router).await,
            RouteStrategy::Embedding => {
                self.classify_embedding(messages, http, embed_provider)
                    .await
            }
            RouteStrategy::Keyword => self.classify_keyword(messages),
        }?;

        if self.config.cache_by_session {
            if let Some(sid) = session_id {
                self.decisions.insert(sid.to_string(), chosen.clone());
            }
        }
        Some(chosen)
    }

    /// Map a rule index (0-based) or the no-match case to a target model, sharing
    /// the fail-open `default_model` fallback across strategies.
    fn model_for_match(&self, matched: Option<usize>) -> Option<String> {
        match matched {
            Some(idx) => {
                let rule = &self.config.rules[idx];
                debug!(rule = idx, model = %rule.model, "smart routing: matched rule");
                Some(rule.model.clone())
            }
            None => {
                let fallback = self
                    .config
                    .default_model
                    .as_ref()
                    .map(|m| m.trim())
                    .filter(|m| !m.is_empty())
                    .map(str::to_owned);
                debug!(
                    default = ?fallback,
                    "smart routing: no rule matched; using default_model fallback"
                );
                fallback
            }
        }
    }

    /// `Embedding` (RAG) strategy: embed the query and each rule description, then
    /// route to the nearest rule above `similarity_threshold`. No LLM call.
    async fn classify_embedding(
        &self,
        messages: &Value,
        http: &Client,
        embed_provider: Option<&OpenAiProviderConfig>,
    ) -> Option<String> {
        let user_msg = last_user_message(messages)?;
        let Some(openai) = embed_provider else {
            warn!("smart routing: embedding strategy but no embedder configured; keeping requested model");
            return None;
        };
        let model = if self.config.embedding_model.trim().is_empty() {
            DEFAULT_EMBED_MODEL
        } else {
            self.config.embedding_model.trim()
        };

        // Rule embeddings are computed once and reused (config is a snapshot).
        let rule_embs = self
            .rule_embeddings
            .get_or_init(|| async {
                let mut out = Vec::with_capacity(self.config.rules.len());
                for rule in &self.config.rules {
                    match embed_text(&rule.description, http, &openai.base_url, &openai.api_key, model).await {
                        Ok(v) => out.push(Some(v)),
                        Err(e) => {
                            warn!(rule = %rule.description, error = %e, "smart routing: failed to embed rule description; rule disabled");
                            out.push(None);
                        }
                    }
                }
                out
            })
            .await;

        let query_emb = match embed_text(
            truncate(&user_msg, MAX_CLASSIFIER_INPUT_CHARS),
            http,
            &openai.base_url,
            &openai.api_key,
            model,
        )
        .await
        {
            Ok(v) => v,
            Err(e) => {
                warn!(error = %e, "smart routing: failed to embed query; keeping requested model");
                return None;
            }
        };

        let mut best_idx: Option<usize> = None;
        let mut best_score = self.config.similarity_threshold;
        for (idx, emb) in rule_embs.iter().enumerate() {
            let Some(emb) = emb else { continue };
            let score = cosine_similarity(&query_emb, emb);
            if score >= best_score {
                best_score = score;
                best_idx = Some(idx);
            }
        }
        debug!(
            ?best_idx,
            best_score, "smart routing: embedding nearest match"
        );
        self.model_for_match(best_idx)
    }

    /// `Keyword` strategy: first rule whose description shares a significant word
    /// (case-insensitive, length > 2) with the message wins. Zero cost.
    fn classify_keyword(&self, messages: &Value) -> Option<String> {
        let user_msg = last_user_message(messages)?;
        let descriptions: Vec<String> = self
            .config
            .rules
            .iter()
            .map(|r| r.description.clone())
            .collect();
        self.model_for_match(keyword_match(&descriptions, &user_msg))
    }

    /// `Llm` strategy: run the cheap classifier model once and map its reply to a
    /// target model.
    async fn classify_llm(
        &self,
        messages: &Value,
        providers: &ProviderRegistry,
        router: &dyn RouterBackend,
    ) -> Option<String> {
        let user_msg = last_user_message(messages)?;

        // Resolve the (cheap) classifier model to a concrete provider + model
        // through the normal router, so the classifier itself is swappable and
        // can be local, hosted, or an openrouter/ slug.
        let decision = router.route(&self.config.classifier_model);
        let Some(provider) = providers.get(decision.provider.as_str()) else {
            warn!(
                provider = decision.provider.as_str(),
                model = %decision.model,
                "smart routing: classifier provider not configured; keeping requested model"
            );
            return None;
        };

        let descriptions: Vec<String> = self
            .config
            .rules
            .iter()
            .map(|r| r.description.clone())
            .collect();
        let prompt = build_prompt(&descriptions, &user_msg);
        let body = json!({
            "model": decision.model,
            "messages": [{ "role": "user", "content": prompt }],
            "temperature": 0,
            "max_tokens": 8,
            "stream": false,
        });

        let fut = provider.complete(&decision.model, &body);
        let resp = match tokio::time::timeout(Duration::from_millis(self.config.timeout_ms), fut)
            .await
        {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                warn!(error = %e, "smart routing: classifier call failed; keeping requested model");
                return None;
            }
            Err(_) => {
                warn!(
                    timeout_ms = self.config.timeout_ms,
                    "smart routing: classifier timed out; keeping requested model"
                );
                return None;
            }
        };

        let text = resp["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("");

        match parse_choice(text, self.config.rules.len()) {
            // A valid rule number (1..=N) → route to that rule's model.
            Some(n) if n >= 1 => self.model_for_match(Some(n - 1)),
            // "0" = explicitly no rule matched → default_model fallback.
            Some(_) => self.model_for_match(None),
            // Unparseable reply → fail open (keep the requested model).
            None => {
                warn!(reply = %text, "smart routing: unparseable classifier reply; keeping requested model");
                None
            }
        }
    }
}

// The classifier text helpers (build_prompt, parse_choice, last_user_message,
// keyword_match, truncate) + MAX_CLASSIFIER_INPUT_CHARS moved to the
// `ryu_gw_router` crate (pure `&str`/`Value` logic) and are imported at the top;
// the async provider/embedding orchestration above stays here (it is bound to
// the gateway's ProviderRegistry + semantic_cache).

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SmartRule;

    fn rules() -> Vec<SmartRule> {
        vec![
            SmartRule {
                description: "coding".into(),
                model: "claude-sonnet-4-5".into(),
            },
            SmartRule {
                description: "chit-chat".into(),
                model: "gemma-local".into(),
            },
        ]
    }

    // parse_choice / build_prompt / last_user_message unit tests moved with their
    // functions to the `ryu_gw_router` crate.

    #[test]
    fn inactive_config_is_not_active() {
        let sr = SmartRouter::new(SmartRoutingConfig::default());
        assert!(!sr.is_active());

        let sr = SmartRouter::new(SmartRoutingConfig {
            enabled: true,
            classifier_model: "gpt-4o-mini".into(),
            rules: rules(),
            ..Default::default()
        });
        assert!(sr.is_active());

        // Enabled but no rules ⇒ inert.
        let sr = SmartRouter::new(SmartRoutingConfig {
            enabled: true,
            classifier_model: "gpt-4o-mini".into(),
            ..Default::default()
        });
        assert!(!sr.is_active());
    }
}

// ─── Swappable smart-routing backend (W6c decomposition) ─────────────────────

/// Classifier-driven model routing (the "smart routing" sub-plane of Plane A) as
/// a swappable capability. The built-in [`SmartRouter`] (LLM/embedding classifier
/// + per-session cache) is the default; an alternative can register without
/// touching the pipeline, mirroring the [`crate::budget::BudgetRegistry`]
/// inversion. Async because [`SmartRouter::resolve`] runs the classifier over the
/// network, so it follows the [`crate::providers`] async-trait shape and the
/// registry hands out an `Arc` (held across the `.await`) rather than a borrowing
/// closure.
#[async_trait::async_trait]
pub trait SmartRouterBackend: Send + Sync {
    /// Whether smart routing should run for this gateway at all.
    fn is_active(&self) -> bool;
    /// Resolve the target model for a chat request, or `None` to keep the
    /// originally requested model (fail-open).
    async fn resolve(
        &self,
        messages: &Value,
        session_id: Option<&str>,
        providers: &ProviderRegistry,
        router: &dyn RouterBackend,
        http: &Client,
        embed_provider: Option<&OpenAiProviderConfig>,
    ) -> Option<String>;
}

#[async_trait::async_trait]
impl SmartRouterBackend for SmartRouter {
    fn is_active(&self) -> bool {
        SmartRouter::is_active(self)
    }
    async fn resolve(
        &self,
        messages: &Value,
        session_id: Option<&str>,
        providers: &ProviderRegistry,
        router: &dyn RouterBackend,
        http: &Client,
        embed_provider: Option<&OpenAiProviderConfig>,
    ) -> Option<String> {
        SmartRouter::resolve(
            self,
            messages,
            session_id,
            providers,
            router,
            http,
            embed_provider,
        )
        .await
    }
}

/// Id-keyed registry over [`SmartRouterBackend`] implementations with a live-swap
/// discipline, matching [`crate::budget::BudgetRegistry`] but yielding an
/// `Arc<dyn SmartRouterBackend>` (the async smart-router shape) so the active
/// backend survives the classifier `.await`. The built-in [`SmartRouter`] is
/// registered under [`SmartRouterRegistry::BUILTIN`] and active by default.
/// `PUT /v1/config { routing }` hot-swaps the built-in via
/// [`SmartRouterRegistry::update_config`] — the same live-swap the old
/// `RwLock<Arc<SmartRouter>>` field provided.
pub struct SmartRouterRegistry {
    inner: std::sync::RwLock<SmartRouterRegistryInner>,
}

struct SmartRouterRegistryInner {
    backends: std::collections::HashMap<String, std::sync::Arc<dyn SmartRouterBackend>>,
    order: Vec<String>,
    active_id: String,
    active: std::sync::Arc<dyn SmartRouterBackend>,
}

impl SmartRouterRegistry {
    /// Stable id of the built-in in-process smart router.
    pub const BUILTIN: &'static str = "builtin";

    /// Build the registry from config, registering a fresh built-in
    /// [`SmartRouter`] as the default active backend.
    pub fn new(config: SmartRoutingConfig) -> Self {
        let builtin: std::sync::Arc<dyn SmartRouterBackend> =
            std::sync::Arc::new(SmartRouter::new(config));
        let mut backends = std::collections::HashMap::new();
        backends.insert(Self::BUILTIN.to_string(), std::sync::Arc::clone(&builtin));
        Self {
            inner: std::sync::RwLock::new(SmartRouterRegistryInner {
                backends,
                order: vec![Self::BUILTIN.to_string()],
                active_id: Self::BUILTIN.to_string(),
                active: builtin,
            }),
        }
    }

    /// Clone the active backend out under a brief read lock (recovering from a
    /// poisoned lock). The returned `Arc` holds no lock, so the pipeline can keep
    /// it across the classifier `.await`.
    pub fn active(&self) -> std::sync::Arc<dyn SmartRouterBackend> {
        match self.inner.read() {
            Ok(guard) => std::sync::Arc::clone(&guard.active),
            Err(poisoned) => std::sync::Arc::clone(&poisoned.into_inner().active),
        }
    }

    /// Hot-swap the active built-in smart router with one built from a new config.
    /// Rebuilding drops the per-session decision cache (intentional and cheap).
    /// Only rebuilds the built-in; a non-built-in active backend is left in place.
    pub fn update_config(&self, config: SmartRoutingConfig) {
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let builtin: std::sync::Arc<dyn SmartRouterBackend> =
            std::sync::Arc::new(SmartRouter::new(config));
        guard
            .backends
            .insert(Self::BUILTIN.to_string(), std::sync::Arc::clone(&builtin));
        if guard.active_id == Self::BUILTIN {
            guard.active = builtin;
        }
    }

    /// Register a backend under a stable id (open extension point). Re-registering
    /// replaces in place; refreshes the live handle if it is the active id.
    #[allow(dead_code)]
    pub fn register(&self, id: impl Into<String>, backend: std::sync::Arc<dyn SmartRouterBackend>) {
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
mod smart_router_registry_tests {
    use super::*;

    /// A stub backend reporting active + a sentinel model — proof the registry
    /// dispatches to a swapped-in impl.
    struct StubSmartRouter;
    #[async_trait::async_trait]
    impl SmartRouterBackend for StubSmartRouter {
        fn is_active(&self) -> bool {
            true
        }
        async fn resolve(
            &self,
            _messages: &Value,
            _session_id: Option<&str>,
            _providers: &ProviderRegistry,
            _router: &dyn RouterBackend,
            _http: &Client,
            _embed_provider: Option<&OpenAiProviderConfig>,
        ) -> Option<String> {
            Some("stub-model".to_string())
        }
    }

    #[test]
    fn builtin_is_the_default_active_backend() {
        let reg = SmartRouterRegistry::new(SmartRoutingConfig::default());
        assert_eq!(reg.active_id(), SmartRouterRegistry::BUILTIN);
        assert_eq!(
            reg.available(),
            vec![SmartRouterRegistry::BUILTIN.to_string()]
        );
        // Default smart routing is inactive (fail-open).
        assert!(!reg.active().is_active());
    }

    #[test]
    fn update_config_hot_swaps_the_builtin_live() {
        use crate::config::{RouteStrategy, SmartRule};
        let reg = SmartRouterRegistry::new(SmartRoutingConfig::default());
        // Default is inactive (fail-open).
        assert!(!reg.active().is_active());
        // Push an active config → the live built-in reflects it with no restart.
        let cfg = SmartRoutingConfig {
            strategy: RouteStrategy::Llm,
            enabled: true,
            classifier_model: "gemma-classifier".to_string(),
            rules: vec![SmartRule {
                description: "writing code".to_string(),
                model: "claude-sonnet-4-5".to_string(),
            }],
            ..Default::default()
        };
        reg.update_config(cfg);
        assert!(reg.active().is_active());
    }

    #[test]
    fn register_then_set_active_swaps_the_live_backend() {
        let reg = SmartRouterRegistry::new(SmartRoutingConfig::default());
        reg.register(
            "stub",
            std::sync::Arc::new(StubSmartRouter) as std::sync::Arc<dyn SmartRouterBackend>,
        );
        // Registered but not active: the built-in (inactive default) still answers.
        assert!(!reg.active().is_active());

        assert!(reg.set_active("stub"));
        assert_eq!(reg.active_id(), "stub");
        // The stub reports active — the swap is live.
        assert!(reg.active().is_active());

        // Unknown id is a no-op keeping the current active backend.
        assert!(!reg.set_active("nope"));
        assert_eq!(reg.active_id(), "stub");
    }
}
