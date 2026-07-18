//! Ryu Gateway model-routing core (Plane A) — the pure decision logic.
//!
//! **Decomposition (W6): the routing algorithm moved out.** This crate owns the
//! model→provider *resolution*, keyed on provider **strings** (the
//! `ProviderKind`→string opening): the full [`RoutingTables::route`] order
//! (exact map → longest user prefix → built-in prefix table → default), the
//! zero-config [`builtin_prefixes`] table, the modality-slot resolution
//! ([`RoutingTables::route_modality`]), the cost-tier [`RoutingTables::fallback_chain`]
//! sort, the eval-driven A/B [`RoutingTables::eval_route`] explore/exploit picker,
//! and the classifier ("smart routing") text helpers ([`build_prompt`],
//! [`parse_choice`], [`last_user_message`], [`keyword_match`], [`truncate`]).
//! Everything here is pure — it operates over `&str` / `String` /
//! `serde_json::Value` / `usize` with no gateway config-types, no async, and no
//! process/network state.
//!
//! What stays in `apps/gateway` (`src/router/`) — "engine moves, wiring stays":
//! the `ModelRouter` / `SmartRouter` structs that hold the config snapshot and
//! build these tables once, the `RouterRegistry` / `SmartRouterBackend` traits +
//! registration, the `RouteDecision` + config value-types, the `AtomicU64` A/B
//! counter (passed in via a closure so its increment timing is preserved), and
//! SmartRouter's async provider/embedding orchestration (bound to the gateway's
//! `ProviderRegistry` + `semantic_cache`). The gateway wrappers resolve config →
//! these string tables and map the returned provider strings back to
//! `ProviderId` / `RouteDecision`, so every call site is behavior-identical.

use std::collections::HashMap;

use serde_json::Value;
use tracing::debug;

/// Cap the user message sent to the classifier so a huge paste stays cheap.
pub const MAX_CLASSIFIER_INPUT_CHARS: usize = 2000;

/// The built-in prefix→provider rules so zero-config "just works". Returns
/// `(prefix, provider_id)` pairs where `provider_id` is the open registry string
/// (e.g. `"anthropic"`, `"openai"`, `"local"`) — the string form of the former
/// `ProviderKind`. This table *is* the zero-config routing brain; the gateway's
/// `ModelRouter::new` snapshots it once.
pub fn builtin_prefixes() -> Vec<(String, String)> {
    [
        ("zeroclaw", "core"),
        ("openclaw", "core"),
        ("claude-", "anthropic"),
        ("gpt-", "openai"),
        ("o1", "openai"),
        ("o3", "openai"),
        ("o4", "openai"),
        ("text-davinci", "openai"),
        // openrouter/ prefix: any model in the form "openrouter/<name>" is
        // dispatched to OpenRouter so the upstream provider's own routing
        // (e.g. openrouter/auto) takes over AFTER Ryu's guardrails run.
        ("openrouter/", "openrouter"),
        // modal/ prefix: any model in the form "modal/<name>" is dispatched
        // to the Ryu Cloud GPU node's Modal inference app (serverless GPU),
        // so a node can offload heavy local-model calls onto Modal's GPUs.
        ("modal/", "modal"),
        // gemini-: native Gemini (and other native-format providers) served
        // through the genai-backed provider, so they route here rather than
        // to the OpenAI-compatible passthroughs.
        ("gemini-", "genai"),
        ("llama", "local"),
        ("mistral", "local"),
        ("mixtral", "local"),
        ("gemma", "local"),
        ("phi", "local"),
        ("qwen", "local"),
        ("deepseek", "local"),
        // Apple Foundation Models, served on-device by the `apfel` local
        // engine (Core makes it the resident local engine, so LOCAL_LLM_URL
        // points at apfel's :11434). apfel validates this exact id.
        ("apple-foundationmodel", "local"),
    ]
    .into_iter()
    .map(|(prefix, provider)| (prefix.to_string(), provider.to_string()))
    .collect()
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
    pub fn route(&self, requested_model: &str) -> (String, String) {
        let model_lower = requested_model.to_lowercase();

        // 1. Exact match in user's model_map
        if let Some((provider, provider_model)) = self.model_map.get(requested_model) {
            let model = provider_model
                .clone()
                .unwrap_or_else(|| requested_model.to_string());
            debug!(requested = requested_model, provider = %provider, routed_model = %model, "route: exact model map hit");
            return (provider.clone(), model);
        }

        // 2. Prefix match in user's model_map (longest prefix wins)
        if let Some(decision) = self.prefix_match_user_map(requested_model) {
            debug!(requested = requested_model, provider = %decision.0, "route: user prefix map hit");
            return decision;
        }

        // 3. Built-in prefix rules
        for (prefix, provider) in &self.builtin_prefixes {
            if model_lower.starts_with(prefix.as_str()) {
                debug!(requested = requested_model, provider = %provider, "route: builtin prefix hit");
                return (provider.clone(), requested_model.to_string());
            }
        }

        // 4. Fall back to configured default provider
        debug!(requested = requested_model, provider = %self.default_provider, "route: default provider");
        (self.default_provider.clone(), requested_model.to_string())
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
            let model = slot_model
                .map(str::to_owned)
                .unwrap_or_else(|| requested_model.to_string());
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
                let others: Vec<&String> =
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

// ─── Classifier ("smart routing") text helpers ───────────────────────────────

/// Build the classifier prompt: enumerate rule descriptions and ask for a single
/// number.
pub fn build_prompt(rule_descriptions: &[String], user_msg: &str) -> String {
    let mut s = String::from(
        "You are a request router. Read the user's message and choose the ONE rule \
that best matches it. Reply with ONLY the rule number (a single integer). \
Reply 0 if no rule applies. Do not explain.\n\nRules:\n",
    );
    for (i, desc) in rule_descriptions.iter().enumerate() {
        s.push_str(&format!("{}. {}\n", i + 1, desc));
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
pub fn parse_choice(text: &str, num_rules: usize) -> Option<usize> {
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

/// `Keyword` strategy core: the index of the first rule whose description shares
/// a significant word (case-insensitive, length > 2) with the message, or `None`
/// if none match. Zero cost — no LLM, no embedding.
pub fn keyword_match(rule_descriptions: &[String], user_msg: &str) -> Option<usize> {
    let user_msg = user_msg.to_lowercase();
    for (idx, desc) in rule_descriptions.iter().enumerate() {
        let hit = desc
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() > 2)
            .any(|w| user_msg.contains(&w.to_lowercase()));
        if hit {
            return Some(idx);
        }
    }
    None
}

/// Extract the most recent user message text. Handles both plain-string content
/// and the OpenAI multimodal content-array shape (joining its text parts).
pub fn last_user_message(messages: &Value) -> Option<String> {
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
pub fn truncate(s: &str, max: usize) -> &str {
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
    use serde_json::json;

    fn descriptions() -> Vec<String> {
        vec!["coding".to_string(), "chit-chat".to_string()]
    }

    // ── Model routing ─────────────────────────────────────────────────────────

    fn tables(
        model_map: HashMap<String, (String, Option<String>)>,
        modality_map: HashMap<String, (String, Option<String>)>,
        fallback_chain: Vec<String>,
        provider_tiers: HashMap<String, u8>,
        eval_candidates: Vec<String>,
        explore_ratio: f32,
        default_provider: &str,
    ) -> RoutingTables {
        RoutingTables {
            model_map,
            builtin_prefixes: builtin_prefixes(),
            default_provider: default_provider.to_string(),
            modality_map,
            fallback_chain,
            provider_tiers,
            eval_candidates,
            explore_ratio,
        }
    }

    fn bare(default_provider: &str) -> RoutingTables {
        tables(
            HashMap::new(),
            HashMap::new(),
            Vec::new(),
            HashMap::new(),
            Vec::new(),
            0.0,
            default_provider,
        )
    }

    #[test]
    fn builtin_prefix_routes_claude_to_anthropic() {
        let t = bare("openai");
        let (provider, model) = t.route("claude-sonnet-4-5");
        assert_eq!(provider, "anthropic");
        assert_eq!(model, "claude-sonnet-4-5");
    }

    #[test]
    fn apple_foundationmodel_routes_to_local() {
        let t = bare("openai");
        assert_eq!(t.route("apple-foundationmodel").0, "local");
    }

    #[test]
    fn openrouter_prefix_routes_any_slug() {
        let t = bare("openai");
        assert_eq!(t.route("openrouter/mistralai/mistral-7b-instruct").0, "openrouter");
        assert_eq!(t.route("gemini-2.5-pro").0, "genai");
    }

    #[test]
    fn exact_map_and_longest_prefix_win_over_builtin() {
        let mut model_map = HashMap::new();
        model_map.insert("gpt-4o".to_string(), ("local".to_string(), Some("gemma".to_string())));
        model_map.insert("gpt-".to_string(), ("openrouter".to_string(), None));
        let t = tables(
            model_map,
            HashMap::new(),
            Vec::new(),
            HashMap::new(),
            Vec::new(),
            0.0,
            "openai",
        );
        // Exact hit rewrites the model and wins over the builtin gpt-→openai.
        assert_eq!(t.route("gpt-4o"), ("local".to_string(), "gemma".to_string()));
        // Longest user prefix ("gpt-") wins over builtin for a non-exact model.
        assert_eq!(t.route("gpt-4-turbo"), ("openrouter".to_string(), "gpt-4-turbo".to_string()));
    }

    #[test]
    fn default_provider_when_nothing_matches() {
        let t = bare("local");
        assert_eq!(t.route("some-unknown-model"), ("local".to_string(), "some-unknown-model".to_string()));
    }

    #[test]
    fn route_modality_slot_then_map_then_fallback() {
        let mut modality_map = HashMap::new();
        modality_map.insert("image".to_string(), ("openai".to_string(), Some("dall-e-3".to_string())));
        let t = tables(
            HashMap::new(),
            modality_map,
            Vec::new(),
            HashMap::new(),
            Vec::new(),
            0.0,
            "local",
        );
        // Slot override wins.
        assert_eq!(
            t.route_modality("image", "x", Some("fal"), Some("flux")),
            ("fal".to_string(), "flux".to_string())
        );
        // Then the modality map (pinned model wins over caller model).
        assert_eq!(
            t.route_modality("image", "whatever", None, None),
            ("openai".to_string(), "dall-e-3".to_string())
        );
        // No entry ⇒ fall through to model routing (gpt-→openai builtin).
        assert_eq!(t.route_modality("tts", "gpt-4o", None, None).0, "openai");
    }

    #[test]
    fn fallback_chain_pins_primary_then_sorts_by_tier() {
        let mut tiers = HashMap::new();
        tiers.insert("openai".to_string(), 0u8);
        tiers.insert("local".to_string(), 1u8);
        tiers.insert("openrouter".to_string(), 2u8);
        let t = tables(
            HashMap::new(),
            HashMap::new(),
            vec!["openrouter".to_string(), "local".to_string(), "openai".to_string()],
            tiers,
            Vec::new(),
            0.0,
            "openai",
        );
        // Primary stays first even though it is the most expensive tier.
        assert_eq!(
            t.fallback_chain("openrouter"),
            vec!["openrouter".to_string(), "openai".to_string(), "local".to_string()]
        );
    }

    #[test]
    fn fallback_chain_empty_tiers_preserves_order() {
        let t = tables(
            HashMap::new(),
            HashMap::new(),
            vec!["local".to_string(), "openai".to_string()],
            HashMap::new(),
            Vec::new(),
            0.0,
            "openai",
        );
        assert_eq!(
            t.fallback_chain("anthropic"),
            vec!["anthropic".to_string(), "local".to_string(), "openai".to_string()]
        );
    }

    fn ab_tables(explore_ratio: f32) -> RoutingTables {
        tables(
            HashMap::new(),
            HashMap::new(),
            Vec::new(),
            HashMap::new(),
            vec!["openai".to_string(), "anthropic".to_string()],
            explore_ratio,
            "openai",
        )
    }

    #[test]
    fn eval_route_none_when_under_two_candidates() {
        let t = bare("openai");
        assert!(t.eval_route("gpt-4o", &|_| Some(0.5), &|| 0).is_none());
    }

    #[test]
    fn eval_route_explores_unscored_candidate_first() {
        let t = ab_tables(0.0);
        let provider = t
            .eval_route("gpt-4o", &|p| if p == "openai" { Some(0.9) } else { None }, &|| 0)
            .expect("eval routing active");
        assert_eq!(provider, "anthropic");
    }

    #[test]
    fn eval_route_exploits_leader_when_all_scored() {
        let t = ab_tables(0.0);
        for _ in 0..20 {
            let provider = t
                .eval_route(
                    "gpt-4o",
                    &|p| match p {
                        "openai" => Some(0.3),
                        "anthropic" => Some(0.8),
                        _ => None,
                    },
                    &|| 0,
                )
                .expect("eval routing active");
            assert_eq!(provider, "anthropic");
        }
    }

    #[test]
    fn eval_route_reserves_traffic_for_exploration() {
        let t = ab_tables(0.25);
        let counter = std::sync::atomic::AtomicU64::new(0);
        let mut leader_hits = 0;
        let mut explore_hits = 0;
        for _ in 0..100 {
            let provider = t
                .eval_route(
                    "gpt-4o",
                    &|p| match p {
                        "openai" => Some(0.3),
                        "anthropic" => Some(0.8),
                        _ => None,
                    },
                    &|| counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                )
                .expect("eval routing active");
            if provider == "anthropic" {
                leader_hits += 1;
            } else {
                explore_hits += 1;
            }
        }
        assert!(explore_hits > 0, "expected some exploration traffic");
        assert!(leader_hits > explore_hits, "leader should win most traffic");
    }

    // ── Classifier helpers ────────────────────────────────────────────────────

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
        let p = build_prompt(&descriptions(), "fix my rust code");
        assert!(p.contains("1. coding"));
        assert!(p.contains("2. chit-chat"));
        assert!(p.contains("fix my rust code"));
    }

    #[test]
    fn keyword_match_finds_significant_word() {
        assert_eq!(keyword_match(&descriptions(), "help me with coding please"), Some(0));
        assert_eq!(keyword_match(&descriptions(), "nothing relevant here"), None);
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
}
