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

use crate::{
    config::{OpenAiProviderConfig, RouteStrategy, SmartRoutingConfig, SmartRule},
    providers::ProviderRegistry,
    router::ModelRouter,
    semantic_cache::{cosine_similarity, embed_text},
};

/// Cap the user message sent to the classifier so a huge paste stays cheap.
const MAX_CLASSIFIER_INPUT_CHARS: usize = 2000;

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
        router: &ModelRouter,
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
                self.classify_embedding(messages, http, embed_provider).await
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
                    match embed_text(&rule.description, http, openai, model).await {
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
            openai,
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
        debug!(?best_idx, best_score, "smart routing: embedding nearest match");
        self.model_for_match(best_idx)
    }

    /// `Keyword` strategy: first rule whose description shares a significant word
    /// (case-insensitive, length > 2) with the message wins. Zero cost.
    fn classify_keyword(&self, messages: &Value) -> Option<String> {
        let user_msg = last_user_message(messages)?.to_lowercase();
        for (idx, rule) in self.config.rules.iter().enumerate() {
            let hit = rule
                .description
                .split(|c: char| !c.is_alphanumeric())
                .filter(|w| w.len() > 2)
                .any(|w| user_msg.contains(&w.to_lowercase()));
            if hit {
                return self.model_for_match(Some(idx));
            }
        }
        self.model_for_match(None)
    }

    /// `Llm` strategy: run the cheap classifier model once and map its reply to a
    /// target model.
    async fn classify_llm(
        &self,
        messages: &Value,
        providers: &ProviderRegistry,
        router: &ModelRouter,
    ) -> Option<String> {
        let user_msg = last_user_message(messages)?;

        // Resolve the (cheap) classifier model to a concrete provider + model
        // through the normal router, so the classifier itself is swappable and
        // can be local, hosted, or an openrouter/ slug.
        let decision = router.route(&self.config.classifier_model);
        let Some(provider) = providers.get(&decision.provider) else {
            warn!(
                provider = decision.provider.as_str(),
                model = %decision.model,
                "smart routing: classifier provider not configured; keeping requested model"
            );
            return None;
        };

        let prompt = build_prompt(&self.config.rules, &user_msg);
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

/// Build the classifier prompt: enumerate rules and ask for a single number.
fn build_prompt(rules: &[SmartRule], user_msg: &str) -> String {
    let mut s = String::from(
        "You are a request router. Read the user's message and choose the ONE rule \
that best matches it. Reply with ONLY the rule number (a single integer). \
Reply 0 if no rule applies. Do not explain.\n\nRules:\n",
    );
    for (i, rule) in rules.iter().enumerate() {
        s.push_str(&format!("{}. {}\n", i + 1, rule.description));
    }
    s.push_str("\nUser message:\n");
    s.push_str(truncate(user_msg, MAX_CLASSIFIER_INPUT_CHARS));
    s.push_str("\n\nRule number:");
    s
}

/// Parse the classifier's reply into a choice in `0..=num_rules`.
///
/// Returns `Some(0)` for "no rule", `Some(n)` for rule `n`, and `None` when the
/// reply has no integer in range (the caller then fails open). Reads the first
/// run of digits anywhere in the text so it tolerates stray prose.
fn parse_choice(text: &str, num_rules: usize) -> Option<usize> {
    let digits: String = text
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect();
    let n: usize = digits.parse().ok()?;
    if n <= num_rules {
        Some(n)
    } else {
        None
    }
}

/// Extract the most recent user message text. Handles both plain-string content
/// and the OpenAI multimodal content-array shape (joining its text parts).
fn last_user_message(messages: &Value) -> Option<String> {
    let arr = messages.as_array()?;
    for m in arr.iter().rev() {
        if m["role"].as_str() != Some("user") {
            continue;
        }
        if let Some(s) = m["content"].as_str() {
            if !s.trim().is_empty() {
                return Some(s.to_string());
            }
        } else if let Some(parts) = m["content"].as_array() {
            let text = parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join(" ");
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
    }
    None
}

/// Truncate `s` to at most `max` chars on a char boundary.
fn truncate(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    match s.char_indices().nth(max) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn parse_choice_reads_plain_number() {
        assert_eq!(parse_choice("1", 2), Some(1));
        assert_eq!(parse_choice("2", 2), Some(2));
        assert_eq!(parse_choice("0", 2), Some(0));
    }

    #[test]
    fn parse_choice_tolerates_surrounding_text() {
        assert_eq!(parse_choice("Rule 2 best fits.", 2), Some(2));
        assert_eq!(parse_choice("  1\n", 2), Some(1));
    }

    #[test]
    fn parse_choice_rejects_out_of_range_or_garbage() {
        assert_eq!(parse_choice("5", 2), None);
        assert_eq!(parse_choice("none", 2), None);
        assert_eq!(parse_choice("", 2), None);
    }

    #[test]
    fn build_prompt_enumerates_one_based() {
        let p = build_prompt(&rules(), "fix my rust code");
        assert!(p.contains("1. coding"));
        assert!(p.contains("2. chit-chat"));
        assert!(p.contains("fix my rust code"));
    }

    #[test]
    fn last_user_message_picks_latest_string() {
        let msgs = json!([
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "reply"},
            {"role": "user", "content": "second"}
        ]);
        assert_eq!(last_user_message(&msgs).as_deref(), Some("second"));
    }

    #[test]
    fn last_user_message_joins_multimodal_parts() {
        let msgs = json!([
            {"role": "user", "content": [
                {"type": "text", "text": "describe"},
                {"type": "image_url", "image_url": {"url": "data:..."}},
                {"type": "text", "text": "this"}
            ]}
        ]);
        assert_eq!(last_user_message(&msgs).as_deref(), Some("describe this"));
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
}
