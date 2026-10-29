//! Model routing for Gateway Plane A.
//!
//! When [`crate::config::SmartRoutingConfig`] is active, the configured algorithm
//! keeps the requested model, selects a weighted target, reads recent signals,
//! or asks a judge for a weak/strong tier. Any selected model is then rewritten
//! into the request and handed to the ordinary [`crate::router::ModelRouter`],
//! which resolves its provider exactly as a hand-picked model would. Nothing
//! about providers is decided here — only *which model* the request should use.
//!
//! Provider failures or an unparseable reply preserve the originally requested
//! model. Governance denials propagate to the caller. Every classifier, judge
//! and embedding call uses the pipeline's nonrecursive `InferenceClient`
//! capability, so auxiliary work is inspected and accounted before routing continues.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[path = "smart_cache.rs"]
pub(crate) mod bounded;
use bounded::BoundedCache;
use serde_json::{json, Value};
use tokio::sync::OnceCell;
use tracing::debug;

use ryu_gw_router::{
    build_prompt, keyword_match, last_user_message, parse_choice, stage_target, truncate,
    weighted_index, StageTarget, MAX_CLASSIFIER_INPUT_CHARS,
};

use crate::{
    config::{ModelRouterType, RouteStrategy, SmartRoutingConfig, StagePicker},
    error::GatewayError,
    semantic_cache::cosine_similarity,
};

use crate::pipeline::inference_governance::InferenceClient;

/// Fallback embedding model for the `Embedding` strategy when the config leaves
/// `embedding_model` empty (matches the semantic cache's default local sidecar).
const DEFAULT_EMBED_MODEL: &str = "nomic-embed-text-v1.5";

fn process_seed() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0x9e37_79b9_7f4a_7c15)
}

fn mix_u64(mut value: u64) -> u64 {
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

/// Holds the smart-routing config snapshot plus a per-session decision cache.
///
/// Like [`ModelRouter`], the config is a startup snapshot; changes take effect
/// when the gateway is refreshed/restarted (the same constraint that applies to
/// all routing config — see `api/config.rs`).
pub struct SmartRouter {
    config: SmartRoutingConfig,
    /// Caller-policy scope + hashed session id → chosen target model. Only used when
    /// `config.cache_by_session` is set.
    decisions: BoundedCache<String, String>,
    /// Lazily-computed embeddings for each rule's description, in rule order.
    /// Computed once per retained caller-policy scope. A `None` entry is
    /// a rule whose description could not be embedded (skipped when matching).
    rule_embeddings: BoundedCache<String, Arc<OnceCell<Vec<Option<Vec<f32>>>>>>,
    /// Whether the configured classifier can actually discriminate between rules,
    /// probed once per retained caller-policy scope. See
    /// [`SmartRouter::classifier_discriminates`].
    classifier_sane: BoundedCache<String, Arc<OnceCell<bool>>>,
    /// Process-local pseudo-random state for the `random` router. A configured
    /// seed makes the sequence reproducible for the same request order; it is
    /// deliberately not a session-affinity mechanism.
    random_seed: u64,
    random_counter: AtomicU64,
    /// Consecutive escalation verdicts by session. A missing session id cannot
    /// accumulate a streak, which keeps escalation fail-open on one-shot calls.
    escalation_streaks: BoundedCache<String, Arc<std::sync::atomic::AtomicU32>>,
}

impl SmartRouter {
    pub fn new(config: SmartRoutingConfig) -> Self {
        let random_seed = config.random_seed.unwrap_or_else(process_seed);
        Self {
            config,
            decisions: BoundedCache::new(256),
            rule_embeddings: BoundedCache::new(4),
            classifier_sane: BoundedCache::new(64),
            random_seed,
            random_counter: AtomicU64::new(0),
            escalation_streaks: BoundedCache::new(256),
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
        inference: &dyn InferenceClient,
    ) -> Result<Option<String>, GatewayError> {
        if !self.is_active() {
            return Ok(None);
        }
        let session_key = session_id.map(|sid| {
            use sha2::{Digest, Sha256};
            format!("{}:{:x}", inference.scope(), Sha256::digest(sid.as_bytes()))
        });
        if self.config.router_type == ModelRouterType::LlmClassifier && self.config.cache_by_session
        {
            if let Some(sid) = &session_key {
                if let Some(hit) = self.decisions.get(sid) {
                    return Ok(Some(hit));
                }
            }
        }
        let chosen = match self.config.router_type {
            ModelRouterType::Passthrough => None,
            ModelRouterType::LlmClassifier => match self.config.strategy {
                RouteStrategy::Llm => self.classify_llm(messages, inference).await?,
                RouteStrategy::Embedding => self.classify_embedding(messages, inference).await?,
                RouteStrategy::Keyword => self.classify_keyword(messages),
            },
            ModelRouterType::Random => self.classify_random(),
            ModelRouterType::StageRouter => self.classify_stage(messages),
            ModelRouterType::Escalation => {
                self.classify_escalation(messages, session_key.as_deref(), inference)
                    .await?
            }
        };
        if self.config.router_type == ModelRouterType::LlmClassifier && self.config.cache_by_session
        {
            if let (Some(sid), Some(model)) = (session_key, &chosen) {
                self.decisions.insert(sid, model.clone());
            }
        }
        Ok(chosen)
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

    fn next_random_ticket(&self) -> u64 {
        let sequence = self.random_counter.fetch_add(1, Ordering::Relaxed);
        mix_u64(self.random_seed.wrapping_add(sequence))
    }

    /// Weighted random routing. Rules are the target list; descriptions are
    /// intentionally ignored. Selection is independent for each request and a
    /// seed reproduces the sequence for the same request order.
    fn classify_random(&self) -> Option<String> {
        let weights: Vec<f32> = self
            .config
            .rules
            .iter()
            .map(|rule| {
                if rule.model.trim().is_empty() {
                    0.0
                } else {
                    rule.weight
                }
            })
            .collect();
        let index = weighted_index(&weights, self.next_random_ticket())?;
        let model = self.config.rules[index].model.trim();
        if model.is_empty() {
            None
        } else {
            debug!(rule = index, model, "smart routing: random target selected");
            Some(model.to_owned())
        }
    }

    /// Signal-driven stage routing. The pure scorer reads recent tool/result
    /// history and chooses the configured capable/efficient tier; no extra model
    /// call is made for this Ryu adaptation.
    fn classify_stage(&self, messages: &Value) -> Option<String> {
        let target = stage_target(
            messages,
            self.config.stage_recent_message_window,
            self.config.stage_confidence_threshold,
            matches!(self.config.stage_picker, StagePicker::CapableFirst),
        );
        let model = match target {
            StageTarget::Capable => self.config.stage_capable_model.trim(),
            StageTarget::Efficient => self.config.stage_efficient_model.trim(),
        };
        if model.is_empty() {
            return None;
        }
        debug!(?target, model, "smart routing: stage target selected");
        Some(model.to_owned())
    }

    /// Trajectory-aware escalation preflight.
    ///
    /// Ryu's current pipeline chooses the model before it calls the provider, so
    /// this route asks the judge to assess the accumulated transcript before the
    /// weak call rather than buffering a completed weak response and replaying it
    /// through a strong model. The session streak/latch and fail-open behavior are
    /// retained; the deliberate boundary is documented in Fumadocs.
    async fn classify_escalation(
        &self,
        messages: &Value,
        session_id: Option<&str>,
        inference: &dyn InferenceClient,
    ) -> Result<Option<String>, GatewayError> {
        let weak = self.config.escalation_weak_model.trim();
        let strong = self.config.escalation_strong_model.trim();
        let judge = self.config.escalation_judge_model.trim();
        if weak.is_empty() || strong.is_empty() || judge.is_empty() {
            return Ok(None);
        }
        let confirmations = self.config.escalation_confirmations.max(1);
        let sid = session_id.map(str::to_owned);
        if let Some(sid) = &sid {
            if self
                .escalation_streaks
                .get(sid)
                .is_some_and(|s| s.load(Ordering::Relaxed) >= confirmations)
            {
                return Ok(Some(strong.to_owned()));
            }
        }
        let body = json!({"model": judge, "messages": [{"role":"user", "content": self.escalation_prompt(messages)}], "temperature":0, "max_tokens":4, "stream":false});
        let Some(response) = inference
            .complete(judge, body, self.config.timeout_ms)
            .await?
        else {
            return Ok(Some(weak.to_owned()));
        };
        let escalate = response["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
            .starts_with("escalate");
        if !escalate {
            if let Some(sid) = &sid {
                self.escalation_streaks.remove(sid);
            }
            return Ok(Some(weak.to_owned()));
        }
        let streak = if let Some(sid) = &sid {
            let count = self.escalation_streaks.get_or_insert_with(sid.clone(), || {
                Arc::new(std::sync::atomic::AtomicU32::new(0))
            });
            count
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                    Some(n.saturating_add(1))
                })
                .unwrap_or(0)
                .saturating_add(1)
        } else {
            1
        };
        Ok(Some(
            if streak >= confirmations && (sid.is_some() || confirmations == 1) {
                strong
            } else {
                weak
            }
            .to_owned(),
        ))
    }

    fn escalation_prompt(&self, messages: &Value) -> String {
        let mut prompt = String::from(
            "You are a trajectory judge. Decide whether the current agent run is stuck, failing, or needs a stronger model. Reply with exactly ESCALATE or DECLINE.\n\nRecent transcript:\n",
        );
        if let Some(history) = messages.as_array() {
            let start = history
                .len()
                .saturating_sub(self.config.escalation_recent_message_window);
            for message in &history[start..] {
                if let Ok(serialized) = serde_json::to_string(message) {
                    prompt.push_str(truncate(&serialized, self.config.escalation_message_chars));
                    prompt.push('\n');
                }
            }
        }
        prompt.push_str("\nVerdict:");
        prompt
    }

    /// `Embedding` (RAG) strategy: embed the query and each rule description, then
    /// route to the nearest rule above `similarity_threshold`. No LLM call.
    async fn classify_embedding(
        &self,
        messages: &Value,
        inference: &dyn InferenceClient,
    ) -> Result<Option<String>, GatewayError> {
        let Some(user_msg) = last_user_message(messages) else {
            return Ok(None);
        };
        let model = if self.config.embedding_model.trim().is_empty() {
            DEFAULT_EMBED_MODEL
        } else {
            self.config.embedding_model.trim()
        };
        let cell = self
            .rule_embeddings
            .get_or_insert_with(inference.scope(), || Arc::new(OnceCell::new()));
        let rule_embs = cell
            .get_or_try_init(|| async {
                let mut out = Vec::with_capacity(self.config.rules.len());
                for rule in &self.config.rules {
                    out.push(
                        inference
                            .embed(model, &rule.description, self.config.timeout_ms)
                            .await?,
                    );
                }
                Ok::<_, GatewayError>(out)
            })
            .await?;
        let Some(query_emb) = inference
            .embed(
                model,
                truncate(&user_msg, MAX_CLASSIFIER_INPUT_CHARS),
                self.config.timeout_ms,
            )
            .await?
        else {
            return Ok(None);
        };
        let mut best_idx = None;
        let mut best_score = self.config.similarity_threshold;
        for (idx, emb) in rule_embs.iter().enumerate() {
            let Some(emb) = emb else {
                continue;
            };
            let score = cosine_similarity(&query_emb, emb);
            if score >= best_score {
                best_score = score;
                best_idx = Some(idx);
            }
        }
        Ok(self.model_for_match(best_idx))
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

    /// One-time probe: can the configured classifier distinguish rules by their
    /// *content*, or is it just picking a position?
    ///
    /// ## Why this exists
    ///
    /// A too-small classifier does not fail loudly — it answers confidently and
    /// identically forever. Gemma 3 270M, the shipped `classify` tier default,
    /// replies `"1"` to every message for every rule set: measured 6/6 including
    /// the message `"hello"` against a `code`-vs-`chat` rule pair, and the answer
    /// did not move when the rules were reversed. Four prompt variants (numbered,
    /// no-completion-cue, few-shot, copy-the-name) were tried; none recovered it
    /// — few-shot merely locked onto whichever example came last. The failure is
    /// the model's, not the prompt's.
    ///
    /// Left unguarded that is worse than not routing: every request silently
    /// takes rule #1's model, and nothing anywhere reports an error. The other
    /// failure paths here (no provider, timeout, unparseable) all fail *open* and
    /// keep the requested model; a classifier that always says `1` is the one
    /// path that fails into a confident wrong answer.
    ///
    /// ## The probe
    ///
    /// Ask the same question twice with the rule list **reversed**. A classifier
    /// reading the descriptions must move its answer with them (position `i`
    /// becomes `n+1-i`); one reading only position returns the same index both
    /// times. Two calls, once per config, at `temperature: 0`.
    ///
    /// Deliberately conservative — it only rejects on a *positive* demonstration
    /// of position-locking. An inconclusive probe (either call errors, times out,
    /// is unparseable, or answers `0` = "no rule") is treated as usable, so a
    /// slow or terse classifier is never disabled by mistake. Fewer than two
    /// rules cannot be reversed, so the probe is skipped.
    async fn classifier_discriminates(
        &self,
        descriptions: &[String],
        inference: &dyn InferenceClient,
    ) -> Result<bool, GatewayError> {
        let cell = self
            .classifier_sane
            .get_or_insert_with(inference.scope(), || Arc::new(OnceCell::new()));
        let sane = cell.get_or_try_init(|| async {
            if descriptions.len() < 2 { return Ok(true); }
            let forward = self.probe_choice(descriptions, "hello", inference).await?;
            let mut reversed = descriptions.to_vec(); reversed.reverse();
            let backward = self.probe_choice(&reversed, "hello", inference).await?;
            Ok::<_, GatewayError>(!matches!((forward, backward), (Some(a), Some(b)) if a >= 1 && b >= 1 && b != descriptions.len() + 1 - a))
        }).await?;
        Ok(*sane)
    }

    async fn probe_choice(
        &self,
        descriptions: &[String],
        msg: &str,
        inference: &dyn InferenceClient,
    ) -> Result<Option<usize>, GatewayError> {
        let model = &self.config.classifier_model;
        let body = json!({"model":model, "messages":[{"role":"user", "content":build_prompt(descriptions, msg)}], "temperature":0, "max_tokens":8, "stream":false});
        let Some(response) = inference
            .complete(model, body, self.config.timeout_ms)
            .await?
        else {
            return Ok(None);
        };
        Ok(response["choices"][0]["message"]["content"]
            .as_str()
            .and_then(|text| parse_choice(text, descriptions.len())))
    }

    async fn classify_llm(
        &self,
        messages: &Value,
        inference: &dyn InferenceClient,
    ) -> Result<Option<String>, GatewayError> {
        let Some(user_msg) = last_user_message(messages) else {
            return Ok(None);
        };
        let descriptions: Vec<_> = self
            .config
            .rules
            .iter()
            .map(|r| r.description.clone())
            .collect();
        if !self
            .classifier_discriminates(&descriptions, inference)
            .await?
        {
            return Ok(None);
        }
        let choice = self
            .probe_choice(&descriptions, &user_msg, inference)
            .await?;
        Ok(self.model_for_match(choice.and_then(|n| n.checked_sub(1))))
    }
}

// The classifier text helpers (build_prompt, parse_choice, last_user_message,
// keyword_match, truncate) + MAX_CLASSIFIER_INPUT_CHARS moved to the
// `ryu_gw_router` crate (pure `&str`/`Value` logic) and are imported at the top;
// the async provider/embedding orchestration above stays here (it is bound to
// the gateway's governed auxiliary-inference capability).

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SmartRule;

    fn rules() -> Vec<SmartRule> {
        vec![
            SmartRule {
                description: "coding".into(),
                model: "claude-sonnet-4-5".into(),
                weight: 1.0,
            },
            SmartRule {
                description: "chit-chat".into(),
                model: "gemma-local".into(),
                weight: 1.0,
            },
        ]
    }

    // parse_choice / build_prompt / last_user_message unit tests moved with their
    // functions to the `ryu_gw_router` crate.

    /// The position-lock verdict table, over the same rule-reversal rule the
    /// live probe applies. `n = 2`, so a content-reading classifier that says
    /// `1` forward must say `2` reversed.
    ///
    /// This mirrors [`SmartRouter::classifier_discriminates`]'s decision without
    /// standing up a provider; the network half is covered by the live pass in
    /// `docs/tool-skill-gateway-e2e-verification.md`.
    #[test]
    fn position_lock_is_detected_only_on_proof() {
        // (forward, backward, n) → is the classifier considered usable?
        let cases = [
            // Gemma 3 270M: "1" both ways. Position-locked.
            ((Some(1usize), Some(1usize)), false),
            ((Some(2), Some(2)), false),
            // A classifier that follows the reversal: usable.
            ((Some(1), Some(2)), true),
            ((Some(2), Some(1)), true),
            // "no rule matched" is a real answer, not proof of locking.
            ((Some(0), Some(0)), true),
            ((Some(1), Some(0)), true),
            // Inconclusive (error / timeout / unparseable) never disables.
            ((None, Some(1)), true),
            ((Some(1), None), true),
            ((None, None), true),
        ];
        let n = 2usize;
        for ((forward, backward), want_usable) in cases {
            let usable = !matches!(
                (forward, backward),
                (Some(a), Some(b)) if a >= 1 && b >= 1 && b != n + 1 - a
            );
            assert_eq!(
                usable, want_usable,
                "forward={forward:?} backward={backward:?} should be usable={want_usable}"
            );
        }
    }

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

    #[test]
    fn random_router_is_weighted_and_seeded_sequences_replay() {
        use crate::config::ModelRouterType;

        let config = SmartRoutingConfig {
            enabled: true,
            router_type: ModelRouterType::Random,
            random_seed: Some(42),
            rules: vec![
                SmartRule {
                    description: "strong".into(),
                    model: "strong-model".into(),
                    weight: 1.0,
                },
                SmartRule {
                    description: "weak".into(),
                    model: "weak-model".into(),
                    weight: 3.0,
                },
            ],
            ..Default::default()
        };
        let first = SmartRouter::new(config.clone());
        let second = SmartRouter::new(config);
        assert!(first.is_active());

        let first_sequence: Vec<_> = (0..256).map(|_| first.classify_random()).collect();
        let second_sequence: Vec<_> = (0..256).map(|_| second.classify_random()).collect();
        assert_eq!(first_sequence, second_sequence);
        assert!(first_sequence
            .iter()
            .any(|model| model == &Some("strong-model".into())));
        assert!(first_sequence
            .iter()
            .any(|model| model == &Some("weak-model".into())));
    }

    #[test]
    fn stage_router_uses_recent_error_and_progress_signals() {
        use crate::config::{ModelRouterType, StagePicker};

        let router = SmartRouter::new(SmartRoutingConfig {
            enabled: true,
            router_type: ModelRouterType::StageRouter,
            stage_capable_model: "capable-model".into(),
            stage_efficient_model: "efficient-model".into(),
            stage_picker: StagePicker::EfficientFirst,
            ..Default::default()
        });
        assert_eq!(
            router.classify_stage(&serde_json::json!([
                {"role": "tool", "content": "command failed with error"}
            ])),
            Some("capable-model".into())
        );
        assert_eq!(
            router.classify_stage(&serde_json::json!([
                {"role": "assistant", "content": "applied patch; tests passed"}
            ])),
            Some("efficient-model".into())
        );
    }

    #[test]
    fn escalation_prompt_honors_message_window_and_character_cap() {
        use crate::config::ModelRouterType;

        let router = SmartRouter::new(SmartRoutingConfig {
            enabled: true,
            router_type: ModelRouterType::Escalation,
            escalation_weak_model: "weak-model".into(),
            escalation_strong_model: "strong-model".into(),
            escalation_judge_model: "judge-model".into(),
            escalation_recent_message_window: 1,
            escalation_message_chars: 48,
            ..Default::default()
        });
        let prompt = router.escalation_prompt(&serde_json::json!([
            {"role": "user", "content": "old context"},
            {"role": "tool", "content": "recent failure that must be cut, followed by a long tail that cannot fit"}
        ]));
        assert!(!prompt.contains("old context"));
        assert!(prompt.contains("recent failure"));
        assert!(!prompt.contains("long tail that cannot fit"));
        assert!(prompt.ends_with("\nVerdict:"));
    }
}

// ─── Swappable smart-routing backend (W6c decomposition) ─────────────────────

/// Model routing (the "smart routing" sub-plane of Plane A) as a swappable
/// capability. The built-in [`SmartRouter`] (classifier, weighted random, stage,
/// and escalation algorithms) is the default; an alternative can register
/// without touching the pipeline, mirroring the [`crate::budget::BudgetRegistry`]
/// inversion. Async because [`SmartRouter::resolve`] may run a classifier or
/// judge over the network, so it follows the [`crate::providers`] async-trait
/// shape and the registry hands out an `Arc` (held across the `.await`) rather
/// than a borrowing closure.
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
        inference: &dyn InferenceClient,
    ) -> Result<Option<String>, GatewayError>;
    /// The config this backend routes with, when it has one. The pipeline uses
    /// it to build a pool-restricted copy (see
    /// [`SmartRoutingConfig::restricted_to`]); a backend without one is still
    /// pool-checked on its final choice.
    fn config(&self) -> Option<&SmartRoutingConfig> {
        None
    }
}

#[async_trait::async_trait]
impl SmartRouterBackend for SmartRouter {
    fn is_active(&self) -> bool {
        SmartRouter::is_active(self)
    }
    fn config(&self) -> Option<&SmartRoutingConfig> {
        Some(&self.config)
    }
    async fn resolve(
        &self,
        messages: &Value,
        session_id: Option<&str>,
        inference: &dyn InferenceClient,
    ) -> Result<Option<String>, GatewayError> {
        SmartRouter::resolve(self, messages, session_id, inference).await
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
            _inference: &dyn InferenceClient,
        ) -> Result<Option<String>, GatewayError> {
            Ok(Some("stub-model".to_string()))
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
                weight: 1.0,
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
