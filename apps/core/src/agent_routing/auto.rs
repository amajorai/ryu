//! Plane B — agent-auto router: pick *which agent* serves a turn.
//!
//! The universal picker exposes an **"Auto"** entry whose id is the sentinel
//! [`AUTO_AGENT_ID`]. When a chat request selects it, Core resolves the real
//! agent per-turn via one of the same swappable strategies the Gateway's model
//! router uses (`llm` | `embedding` | `keyword`), then continues dispatch exactly
//! as if the user had picked the resolved agent.
//!
//! This mirrors the Gateway's `SmartRoutingConfig`/`SmartRouter` shape
//! (`apps/gateway/src/router/smart.rs`) but its rule targets are **agent ids**,
//! not model ids. Everything **fails open**: an inactive/unparseable config, a
//! classifier error, or a timeout all resolve to `default_agent_id` (or the
//! flagship [`DEFAULT_FALLBACK_AGENT`] `ryu`), so a misconfiguration can never
//! break chat. The classifier is called *directly* against the local gateway
//! (never the agent-dispatch path), so routing can never recurse into routing.
//!
//! Config lives in the Core preference [`AGENT_AUTO_ROUTING_PREF_KEY`]
//! (`agent-auto-routing`), seeded into an in-process snapshot at startup and on
//! change — the same pattern the sibling per-agent gateway-routing map uses,
//! because the (async) chat path has no preferences-store handle.

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tracing::{debug, warn};

use crate::server::retrieval::Embedder;

/// Sentinel agent id selecting Plane B agent-auto routing. When a chat request's
/// agent id equals this, Core resolves a concrete agent per-turn.
pub const AUTO_AGENT_ID: &str = "auto";

/// Preference key holding the agent-auto-routing config (JSON). The desktop
/// writes it; Core seeds an in-process snapshot from it at startup and on change.
pub const AGENT_AUTO_ROUTING_PREF_KEY: &str = "agent-auto-routing";

/// The flagship agent every fail-open path lands on when the config provides no
/// usable `default_agent_id`. Always installed by default, so it is always valid.
pub const DEFAULT_FALLBACK_AGENT: &str = "ryu";

/// Fallback embedding model for the `Embedding` strategy when the config leaves
/// `embedding_model` empty (matches the local nomic-embed sidecar default).
const DEFAULT_EMBED_MODEL: &str = "nomic-embed-text-v1.5";

/// Cap the user message fed to the classifier / embedder so a huge paste stays
/// cheap (mirrors the Gateway smart router's cap).
const MAX_CLASSIFIER_INPUT_CHARS: usize = 2000;

/// Default classifier timeout when the config omits it.
const fn default_timeout_ms() -> u64 {
    5000
}

/// Default minimum cosine for the `Embedding` strategy to accept a rule (mirrors
/// the Gateway smart router default).
const fn default_similarity_threshold() -> f32 {
    0.35
}

/// How the matching rule is chosen. Same vocabulary as the Gateway's
/// `RouteStrategy` (kept Core-local so the two crates stay decoupled).
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RouteStrategy {
    /// A cheap classifier model reads the message and picks a rule (1 round-trip).
    #[default]
    Llm,
    /// RAG: embed rule descriptions + the query, cosine-nearest above a threshold.
    Embedding,
    /// Case-insensitive significant-word match; zero cost, zero network.
    Keyword,
}

/// One natural-language routing rule whose target is an **agent id**.
#[derive(Debug, Clone, Deserialize)]
pub struct AutoRule {
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub agent_id: String,
}

/// The agent-auto-routing config (Plane B). Mirrors the Gateway's
/// `SmartRoutingConfig` but rule targets are agent ids and the no-match fallback
/// is `default_agent_id`.
#[derive(Debug, Clone, Deserialize)]
pub struct AgentAutoConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub strategy: RouteStrategy,
    /// Model id for the `Llm` strategy (resolved via Core's gateway chat path).
    #[serde(default)]
    pub classifier_model: String,
    /// Embedder id for the `Embedding` strategy; empty → the default local embedder.
    #[serde(default)]
    pub embedding_model: String,
    #[serde(default = "default_similarity_threshold")]
    pub similarity_threshold: f32,
    #[serde(default)]
    pub rules: Vec<AutoRule>,
    /// The agent id chosen when no rule matches. Empty → [`DEFAULT_FALLBACK_AGENT`].
    #[serde(default)]
    pub default_agent_id: String,
    /// When true, resolve once per conversation/session id and reuse the decision
    /// (prevents per-turn harness flapping).
    #[serde(default)]
    pub cache_by_session: bool,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

impl AgentAutoConfig {
    /// Whether agent-auto routing should run at all: enabled, has rules, and (for
    /// `Llm`) a non-empty classifier model. `Embedding`/`Keyword` need only rules.
    pub fn is_active(&self) -> bool {
        if !self.enabled || self.rules.is_empty() {
            return false;
        }
        match self.strategy {
            RouteStrategy::Llm => !self.classifier_model.trim().is_empty(),
            RouteStrategy::Embedding | RouteStrategy::Keyword => true,
        }
    }

    /// The fail-open target: `default_agent_id` when set, else the flagship `ryu`.
    fn fallback_agent(&self) -> String {
        let d = self.default_agent_id.trim();
        if d.is_empty() {
            DEFAULT_FALLBACK_AGENT.to_owned()
        } else {
            d.to_owned()
        }
    }

    /// Resolve a matched rule index (or the no-match case) to a concrete agent id,
    /// sharing the fail-open `default_agent_id` fallback across strategies.
    fn agent_for_match(&self, matched: Option<usize>) -> String {
        match matched {
            Some(idx) => {
                let id = self.rules[idx].agent_id.trim();
                if id.is_empty() {
                    self.fallback_agent()
                } else {
                    id.to_owned()
                }
            }
            None => self.fallback_agent(),
        }
    }
}

/// In-process snapshot of the parsed config (`None` when unset/unparseable).
fn config_cell() -> &'static RwLock<Option<AgentAutoConfig>> {
    static CELL: OnceLock<RwLock<Option<AgentAutoConfig>>> = OnceLock::new();
    CELL.get_or_init(|| RwLock::new(None))
}

/// Per-session decision cache: conversation/session id → resolved agent id. Only
/// consulted/written when `cache_by_session` is set.
fn decisions() -> &'static RwLock<HashMap<String, String>> {
    static MAP: OnceLock<RwLock<HashMap<String, String>>> = OnceLock::new();
    MAP.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Replace the in-process config snapshot from the persisted preference value. A
/// blank or unparseable value clears it (agent-auto reverts to fail-open), never
/// errors — the chat path must not panic on bad config.
pub fn set_auto_config_from_json(value: &str) {
    let trimmed = value.trim();
    let parsed = if trimmed.is_empty() {
        None
    } else {
        match serde_json::from_str::<AgentAutoConfig>(trimmed) {
            Ok(cfg) => Some(cfg),
            Err(e) => {
                warn!(error = %e, "agent-auto: ignoring unparseable config; failing open");
                None
            }
        }
    };
    if let Ok(mut guard) = config_cell().write() {
        *guard = parsed;
    }
}

/// Clone the current config snapshot (if any).
fn auto_config() -> Option<AgentAutoConfig> {
    config_cell().read().ok().and_then(|g| g.clone())
}

fn cached_decision(session_id: &str) -> Option<String> {
    decisions().read().ok().and_then(|m| m.get(session_id).cloned())
}

fn cache_decision(session_id: &str, agent_id: &str) {
    if let Ok(mut m) = decisions().write() {
        m.insert(session_id.to_owned(), agent_id.to_owned());
    }
}

/// Resolve the [`AUTO_AGENT_ID`] sentinel to a concrete agent id for this turn.
///
/// `user_text` is the latest user message; `session_id` is the conversation id
/// used for the per-session decision cache. Always returns a concrete agent id
/// (fails open to `default_agent_id`, else [`DEFAULT_FALLBACK_AGENT`]).
pub async fn resolve_auto_agent(user_text: &str, session_id: Option<&str>) -> String {
    let Some(config) = auto_config() else {
        return DEFAULT_FALLBACK_AGENT.to_owned();
    };
    if !config.is_active() {
        return config.fallback_agent();
    }

    // Per-session stickiness: resolve once per conversation, reuse afterwards.
    // This is the primary guard against mid-conversation harness flapping.
    if config.cache_by_session {
        if let Some(sid) = session_id {
            if let Some(hit) = cached_decision(sid) {
                debug!(session = sid, agent = %hit, "agent-auto: session cache hit");
                return hit;
            }
        }
    }

    let matched = match config.strategy {
        RouteStrategy::Llm => classify_llm(&config, user_text).await,
        RouteStrategy::Embedding => classify_embedding(&config, user_text).await,
        RouteStrategy::Keyword => classify_keyword(&config, user_text),
    };
    let agent = config.agent_for_match(matched);

    if config.cache_by_session {
        if let Some(sid) = session_id {
            cache_decision(sid, &agent);
        }
    }
    debug!(agent = %agent, ?matched, "agent-auto: resolved");
    agent
}

/// `Keyword` strategy: first rule whose description shares a significant word
/// (case-insensitive, length > 2) with the message wins. Zero cost.
fn classify_keyword(config: &AgentAutoConfig, user_text: &str) -> Option<usize> {
    let msg = user_text.to_lowercase();
    for (idx, rule) in config.rules.iter().enumerate() {
        let hit = rule
            .description
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() > 2)
            .any(|w| msg.contains(&w.to_lowercase()));
        if hit {
            return Some(idx);
        }
    }
    None
}

/// `Embedding` (RAG) strategy: embed the query and each rule description, then
/// pick the nearest rule above `similarity_threshold`. Reuses Core's registry
/// embedder (the local nomic-embed sidecar by default) + a brute-force cosine.
async fn classify_embedding(config: &AgentAutoConfig, user_text: &str) -> Option<usize> {
    let query = truncate(user_text.trim(), MAX_CLASSIFIER_INPUT_CHARS);
    if query.is_empty() || config.rules.is_empty() {
        return None;
    }
    let embedder = build_embedder(config);
    let query_emb = match embedder.embed(query).await {
        Ok(v) => v,
        Err(e) => {
            warn!(error = %e, "agent-auto: failed to embed query; failing open");
            return None;
        }
    };

    let mut best_idx: Option<usize> = None;
    let mut best_score = config.similarity_threshold;
    for (idx, rule) in config.rules.iter().enumerate() {
        let Ok(emb) = embedder.embed(&rule.description).await else {
            warn!(rule = %rule.description, "agent-auto: failed to embed rule description; skipping");
            continue;
        };
        let score = cosine(&query_emb, &emb);
        if score >= best_score {
            best_score = score;
            best_idx = Some(idx);
        }
    }
    debug!(?best_idx, best_score, "agent-auto: embedding nearest match");
    best_idx
}

/// Build the embedder for the `Embedding` strategy, honouring the config's
/// `embedding_model` override when set (against the registry's embed endpoint),
/// else the registry default.
fn build_embedder(config: &AgentAutoConfig) -> Embedder {
    let registry = crate::registry::ModelRegistry::load();
    let model = config.embedding_model.trim();
    let base_url = registry.embed_base_url.trim();
    if !model.is_empty() && !base_url.is_empty() {
        let api_key = std::env::var("RYU_EMBED_API_KEY")
            .ok()
            .or_else(|| std::env::var("OPENAI_API_KEY").ok())
            .filter(|s| !s.is_empty());
        let model = if model.eq_ignore_ascii_case("default") {
            DEFAULT_EMBED_MODEL.to_owned()
        } else {
            model.to_owned()
        };
        Embedder::Remote {
            base_url: base_url.to_owned(),
            model,
            dims: registry.embedder.dims,
            api_key,
        }
    } else {
        Embedder::from_registry(&registry)
    }
}

/// `Llm` strategy: run the cheap classifier model once (a direct, non-streaming
/// completion against the local gateway — never the agent-dispatch path, so it
/// cannot recurse) and map its reply to a rule index.
async fn classify_llm(config: &AgentAutoConfig, user_text: &str) -> Option<usize> {
    let model = config.classifier_model.trim();
    if model.is_empty() {
        return None;
    }
    let prompt = build_prompt(&config.rules, user_text);
    let base = crate::sidecar::gateway::gateway_url();
    let base = base.trim_end_matches('/');
    let url = format!("{base}/v1/chat/completions");
    let payload = json!({
        "model": model,
        "stream": false,
        "temperature": 0,
        "max_tokens": 8,
        "messages": [{ "role": "user", "content": prompt }],
    });

    let mut builder = http_client()
        .post(&url)
        .timeout(Duration::from_millis(config.timeout_ms))
        // De-prioritize on the shared local engine so a routing decision never
        // starves an interactive reply.
        .header("x-ryu-priority", "background")
        .json(&payload);
    if let Some(token) = crate::sidecar::gateway::gateway_token() {
        builder = builder.bearer_auth(token);
    }

    let resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            warn!(error = %e, "agent-auto: classifier call failed; failing open");
            return None;
        }
    };
    if !resp.status().is_success() {
        warn!(status = %resp.status(), "agent-auto: classifier returned error; failing open");
        return None;
    }
    let body: Value = resp.json().await.ok()?;
    let text = body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    match parse_choice(text, config.rules.len()) {
        // A valid rule number (1..=N) → that rule's index.
        Some(n) if n >= 1 => Some(n - 1),
        // "0" (explicit no-match) or unparseable → fail open to default.
        _ => None,
    }
}

/// Shared reqwest client for the classifier call.
fn http_client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new).clone()
}

/// Build the classifier prompt: enumerate rules and ask for a single number.
/// Mirrors `apps/gateway/src/router/smart.rs::build_prompt`.
fn build_prompt(rules: &[AutoRule], user_msg: &str) -> String {
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

/// Parse the classifier's reply into a choice in `0..=num_rules`. `Some(0)` = no
/// rule; `Some(n)` = rule n; `None` when no in-range integer is present (fail
/// open). Reads the first run of digits so it tolerates stray prose.
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

/// Cosine similarity of two equal-length vectors; `0.0` on length mismatch.
/// Same brute-force form Core uses elsewhere (`server/retrieval`, `mcp/catalog`).
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom > f32::EPSILON {
        dot / denom
    } else {
        0.0
    }
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

    fn rules() -> Vec<AutoRule> {
        vec![
            AutoRule {
                description: "writing, refactoring or debugging code".into(),
                agent_id: "claude-code".into(),
            },
            AutoRule {
                description: "quick web lookups and browsing".into(),
                agent_id: "ryu".into(),
            },
        ]
    }

    fn cfg(strategy: RouteStrategy) -> AgentAutoConfig {
        AgentAutoConfig {
            enabled: true,
            strategy,
            classifier_model: "gemma-local".into(),
            embedding_model: String::new(),
            similarity_threshold: default_similarity_threshold(),
            rules: rules(),
            default_agent_id: "ryu".into(),
            cache_by_session: true,
            timeout_ms: default_timeout_ms(),
        }
    }

    #[test]
    fn parse_choice_reads_plain_number() {
        assert_eq!(parse_choice("1", 2), Some(1));
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
        assert!(p.contains("1. writing, refactoring or debugging code"));
        assert!(p.contains("2. quick web lookups and browsing"));
        assert!(p.contains("fix my rust code"));
    }

    #[test]
    fn keyword_matches_significant_word() {
        let c = cfg(RouteStrategy::Keyword);
        // "debugging" (>2 chars) appears in rule 1's description.
        assert_eq!(classify_keyword(&c, "help me with debugging"), Some(0));
        // "browsing" appears in rule 2's description.
        assert_eq!(classify_keyword(&c, "browsing the web"), Some(1));
        // No significant overlap → no match.
        assert_eq!(classify_keyword(&c, "hello there"), None);
    }

    #[test]
    fn agent_for_match_maps_index_and_falls_back() {
        let c = cfg(RouteStrategy::Keyword);
        assert_eq!(c.agent_for_match(Some(0)), "claude-code");
        assert_eq!(c.agent_for_match(Some(1)), "ryu");
        // No match → default_agent_id.
        assert_eq!(c.agent_for_match(None), "ryu");
    }

    #[test]
    fn is_active_gates_on_enabled_rules_and_llm_model() {
        assert!(cfg(RouteStrategy::Keyword).is_active());
        assert!(cfg(RouteStrategy::Embedding).is_active());
        assert!(cfg(RouteStrategy::Llm).is_active());

        // Llm with no classifier model ⇒ inert.
        let mut c = cfg(RouteStrategy::Llm);
        c.classifier_model = String::new();
        assert!(!c.is_active());

        // Disabled ⇒ inert.
        let mut c = cfg(RouteStrategy::Keyword);
        c.enabled = false;
        assert!(!c.is_active());

        // No rules ⇒ inert.
        let mut c = cfg(RouteStrategy::Keyword);
        c.rules.clear();
        assert!(!c.is_active());
    }

    #[test]
    fn fallback_agent_defaults_to_ryu_when_unset() {
        let mut c = cfg(RouteStrategy::Keyword);
        c.default_agent_id = String::new();
        assert_eq!(c.fallback_agent(), DEFAULT_FALLBACK_AGENT);
        c.default_agent_id = "gemini".into();
        assert_eq!(c.fallback_agent(), "gemini");
    }

    #[test]
    fn config_snapshot_parses_and_clears() {
        let _guard = crate::agent_routing::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        set_auto_config_from_json(
            r#"{"enabled":true,"strategy":"keyword","rules":[{"description":"code","agent_id":"claude-code"}],"default_agent_id":"ryu"}"#,
        );
        let c = auto_config().expect("config parsed");
        assert!(c.is_active());
        assert_eq!(c.rules.len(), 1);
        // Blank clears back to fail-open (None).
        set_auto_config_from_json("");
        assert!(auto_config().is_none());
        // Garbage also clears rather than panicking.
        set_auto_config_from_json("not json");
        assert!(auto_config().is_none());
    }

    #[tokio::test]
    async fn resolve_falls_open_to_ryu_without_config() {
        let _guard = crate::agent_routing::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        set_auto_config_from_json("");
        assert_eq!(resolve_auto_agent("anything", None).await, "ryu");
    }

    #[tokio::test]
    async fn resolve_keyword_and_caches_by_session() {
        let _guard = crate::agent_routing::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        set_auto_config_from_json(
            r#"{"enabled":true,"strategy":"keyword","cache_by_session":true,
                "rules":[
                  {"description":"writing refactoring or debugging code","agent_id":"claude-code"},
                  {"description":"quick web lookups and browsing","agent_id":"ryu"}
                ],
                "default_agent_id":"ryu"}"#,
        );
        let sid = "conv-test-auto-1";
        assert_eq!(
            resolve_auto_agent("please help debugging this", Some(sid)).await,
            "claude-code"
        );
        // Cached: a message that would otherwise match rule 2 still returns the
        // first (sticky) decision for this session.
        assert_eq!(
            resolve_auto_agent("browsing the web now", Some(sid)).await,
            "claude-code"
        );
        set_auto_config_from_json("");
    }
}
