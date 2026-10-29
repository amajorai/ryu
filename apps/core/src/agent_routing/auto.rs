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

use std::collections::{HashMap, VecDeque};
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tracing::{debug, warn};

use ryu_rag::Embedder;

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

/// Fallback classifier model for the `Llm` strategy. Kept in lockstep with
/// [`crate::registry::DEFAULT_LOCAL_CLASSIFIER_MODEL_ID`] — the id the classify
/// tier actually serves — the same way the Gateway documents its
/// `DEFAULT_INSPECTOR_MODEL`. Cheap and local, so a default classifier never
/// leaks a turn to a hosted provider or spends a cent.
///
/// Unlike [`DEFAULT_EMBED_MODEL`], which is applied at call time, this one is
/// applied at DESERIALIZATION (see [`de_classifier_model`]): a blank classifier
/// makes [`AgentAutoConfig::is_active`] return false, so a call-time fallback
/// would never be reached.
fn default_classifier_model() -> String {
    crate::registry::DEFAULT_LOCAL_CLASSIFIER_MODEL_ID.to_owned()
}

/// Resolve a blank `classifier_model` to [`default_classifier_model`] as the
/// value is read off the wire.
///
/// Mirrors the Gateway's `de_classifier_model`, and exists for the same reason:
/// `#[serde(default = …)]` alone only covers an *absent* field, but the desktop
/// writes an explicit `""` into the [`AGENT_AUTO_ROUTING_PREF_KEY`] preference
/// whenever an operator clears the model box. A config saved that way parsed as
/// "enabled" while [`AgentAutoConfig::is_active`] read false and
/// [`classify_llm`] bailed on the empty id — a feature switched on that silently
/// did nothing. Normalizing at this single construction seam is what makes
/// "enabled" mean "working".
fn de_classifier_model<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    Ok(if raw.trim().is_empty() {
        default_classifier_model()
    } else {
        raw
    })
}

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
    /// Blank or absent resolves to [`default_classifier_model`] at
    /// deserialization (see [`de_classifier_model`]), so this is never empty in
    /// practice and "enabled" cannot mean "silently inert".
    #[serde(
        default = "default_classifier_model",
        deserialize_with = "de_classifier_model"
    )]
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
    ///
    /// The classifier check is the last line of defence, not a gate an operator
    /// hits: [`de_classifier_model`] resolves a blank one as it comes off the
    /// wire, so only a config built in Rust can still trip this arm.
    pub fn is_active(&self) -> bool {
        if !self.enabled || self.rules.is_empty() {
            return false;
        }
        match self.strategy {
            RouteStrategy::Llm => !self.classifier_model.trim().is_empty(),
            RouteStrategy::Embedding | RouteStrategy::Keyword => true,
        }
    }

    /// The fail-open target: this config's own `default_agent_id`, else the
    /// node-wide default selection's agent, else the flagship `ryu`.
    fn fallback_agent(&self) -> String {
        self.fallback_agent_with(crate::agent_selection::default_agent_id())
    }

    /// [`fallback_agent`](Self::fallback_agent) with the node-wide default passed
    /// in, so the precedence is testable without touching process-global state.
    fn fallback_agent_with(&self, node_default: Option<String>) -> String {
        let d = self.default_agent_id.trim();
        if !d.is_empty() {
            return d.to_owned();
        }
        node_default
            .filter(|a| !a.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_FALLBACK_AGENT.to_owned())
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

/// Cap on the number of sticky per-session decisions kept in-process. One entry
/// per live-ish conversation; a long-running node otherwise leaks one entry per
/// conversation forever. Eviction only re-triggers a routing decision for the
/// evicted session's next turn, which is cheap and still correct — just not
/// sticky past the cap.
const DECISION_CACHE_CAPACITY: usize = 1024;

/// A bounded, insertion-order FIFO map: on inserting a NEW key past capacity,
/// evicts the oldest key. Re-inserting an existing key updates its value in
/// place without moving it in eviction order. Mirrors `SeenDeliveries`
/// (`crates/core/webhook-ingress/src/ryu_relay.rs`) but keeps a value per key.
#[derive(Debug, Default)]
struct BoundedDecisionCache {
    order: VecDeque<String>,
    map: HashMap<String, String>,
}

impl BoundedDecisionCache {
    fn get(&self, key: &str) -> Option<String> {
        self.map.get(key).cloned()
    }

    fn insert(&mut self, key: String, value: String) {
        if self.map.insert(key.clone(), value).is_none() {
            // Newly-inserted key: track it for eviction order.
            self.order.push_back(key);
            while self.order.len() > DECISION_CACHE_CAPACITY {
                if let Some(oldest) = self.order.pop_front() {
                    self.map.remove(&oldest);
                }
            }
        }
    }

    fn clear(&mut self) {
        self.order.clear();
        self.map.clear();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.map.len()
    }
}

/// Per-session decision cache: conversation/session id → resolved agent id. Only
/// consulted/written when `cache_by_session` is set.
fn decisions() -> &'static RwLock<BoundedDecisionCache> {
    static MAP: OnceLock<RwLock<BoundedDecisionCache>> = OnceLock::new();
    MAP.get_or_init(|| RwLock::new(BoundedDecisionCache::default()))
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
    // New rules ⇒ old sticky decisions are stale. Clear so live conversations
    // re-resolve under the new config instead of keeping the old agent forever.
    if let Ok(mut m) = decisions().write() {
        m.clear();
    }
}

/// Clone the current config snapshot (if any).
fn auto_config() -> Option<AgentAutoConfig> {
    config_cell().read().ok().and_then(|g| g.clone())
}

fn cached_decision(session_id: &str) -> Option<String> {
    decisions().read().ok().and_then(|m| m.get(session_id))
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

    let rule_embeddings = rule_description_embeddings(&embedder, config).await;
    let mut best_idx: Option<usize> = None;
    let mut best_score = config.similarity_threshold;
    for (idx, rule) in config.rules.iter().enumerate() {
        let Some(emb) = rule_embeddings.get(&rule.description) else {
            warn!(rule = %rule.description, "agent-auto: failed to embed rule description; skipping");
            continue;
        };
        let score = cosine(&query_emb, emb);
        if score >= best_score {
            best_score = score;
            best_idx = Some(idx);
        }
    }
    debug!(?best_idx, best_score, "agent-auto: embedding nearest match");
    best_idx
}

/// Upper bound on cached rule-description vectors. Rule sets are small; the cap
/// only stops an endlessly edited config from growing the map without limit.
const MAX_CACHED_RULE_EMBEDDINGS: usize = 512;

/// Cache key: the embedder's model and dims (a provider swap changes the vector
/// space) plus the rule description text.
type RuleEmbeddingKey = (String, usize, String);

fn rule_embedding_cache() -> &'static RwLock<HashMap<RuleEmbeddingKey, Vec<f32>>> {
    static CACHE: OnceLock<RwLock<HashMap<RuleEmbeddingKey, Vec<f32>>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Vectors for every rule description, keyed by description. Rule descriptions
/// change only when the config is edited, so they are embedded once per model and
/// reused; only the query is embedded per turn. Misses go out as one batched
/// request. A description that cannot be embedded is simply absent.
async fn rule_description_embeddings(
    embedder: &Embedder,
    config: &AgentAutoConfig,
) -> HashMap<String, Vec<f32>> {
    let model = embedder.model_id().to_owned();
    let dims = embedder.dims();
    let key = |description: &str| (model.clone(), dims, description.to_owned());

    let mut found = HashMap::new();
    let mut missing = Vec::new();
    {
        let cache = rule_embedding_cache()
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for rule in &config.rules {
            match cache.get(&key(&rule.description)) {
                Some(vector) => {
                    found.insert(rule.description.clone(), vector.clone());
                }
                None if !missing.contains(&rule.description) => {
                    missing.push(rule.description.clone());
                }
                None => {}
            }
        }
    }
    if missing.is_empty() {
        return found;
    }

    let vectors = match embedder.embed_batch(&missing).await {
        Ok(vectors) => vectors,
        Err(error) => {
            warn!(%error, "agent-auto: failed to embed rule descriptions");
            return found;
        }
    };
    let mut cache = rule_embedding_cache()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if cache.len() + missing.len() > MAX_CACHED_RULE_EMBEDDINGS {
        cache.clear();
    }
    for (description, vector) in missing.into_iter().zip(vectors) {
        cache.insert(key(&description), vector.clone());
        found.insert(description, vector);
    }
    found
}

/// Build the embedder for the `Embedding` strategy, honouring the config's
/// `embedding_model` override when set (against the registry's embed endpoint),
/// else the registry default.
fn build_embedder(config: &AgentAutoConfig) -> Embedder {
    let registry = crate::registry::ModelRegistry::load();
    let model = config.embedding_model.trim();
    let base_url = registry.embed_base_url.trim();
    if !model.is_empty() && !base_url.is_empty() {
        let model = if model.eq_ignore_ascii_case("default") {
            DEFAULT_EMBED_MODEL.to_owned()
        } else {
            model.to_owned()
        };
        // Funnel through the single RAG resolver so an embed-provider swap reaches
        // agent auto-routing too.
        crate::rag_host::embedder_from_config(base_url, &model, registry.embedder.dims)
    } else {
        crate::rag_host::embedder_from_registry(&registry)
    }
}

/// `Llm` strategy: run the cheap classifier model once (a direct, non-streaming
/// completion against the local gateway — never the agent-dispatch path, so it
/// cannot recurse) and map its reply to a rule index. It carries no session id:
/// the Gateway would otherwise cache this routing call's model decision for the
/// whole conversation.
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

    let request = http_client()
        .post(&url)
        .timeout(Duration::from_millis(config.timeout_ms))
        .json(&payload);
    // Tagged `agent_auto_route` and, like before, `background` priority on the
    // shared local engine so a routing decision never starves an interactive
    // reply (see `SidePurpose::is_background`).
    let mut builder = crate::sidecar::gateway::with_side_call_headers(
        request,
        &crate::sidecar::gateway::SidePurpose::AgentAutoRoute,
    );
    if let Some(token) = crate::sidecar::gateway::gateway_inference_token() {
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
    crate::sidecar::gateway::log_side_usage(
        &crate::sidecar::gateway::SidePurpose::AgentAutoRoute,
        model,
        &body,
    );
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

    #[tokio::test]
    async fn rule_description_embeddings_are_cached_per_model() {
        let config = cfg(RouteStrategy::Embedding);
        // Unusual dims keep this test's cache keys apart from any other test.
        let embedder = Embedder::Local { dims: 97 };

        let first = rule_description_embeddings(&embedder, &config).await;
        assert_eq!(first.len(), config.rules.len());
        for rule in &config.rules {
            assert_eq!(
                first.get(&rule.description),
                Some(&embedder.embed(&rule.description).await.unwrap())
            );
            let key = ("local-hashing".to_owned(), 97, rule.description.clone());
            assert!(rule_embedding_cache().read().unwrap().contains_key(&key));
        }

        let second = rule_description_embeddings(&embedder, &config).await;
        assert_eq!(first, second);
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

    /// REGRESSION: agent-auto routing saved as "on" with the classifier box
    /// cleared parsed fine, then did nothing — `is_active()` read false and
    /// [`classify_llm`] bailed on the empty id.
    ///
    /// This has to go through serde. The test above sets `classifier_model` in
    /// Rust, which bypasses `de_classifier_model` entirely; it keeps passing
    /// after the fix while proving nothing about the wire path the desktop
    /// actually writes into `agent-auto-routing`.
    #[test]
    fn a_blank_classifier_from_the_preference_resolves_to_a_working_model() {
        // The JSON the desktop stores when an operator clears the model box.
        let from_wire: AgentAutoConfig = serde_json::from_value(json!({
            "enabled": true,
            "strategy": "llm",
            "classifier_model": "",
            "rules": [{ "description": "code", "agent_id": "claude-code" }],
        }))
        .expect("an explicit empty classifier must still parse");
        assert_eq!(
            from_wire.classifier_model,
            crate::registry::DEFAULT_LOCAL_CLASSIFIER_MODEL_ID
        );
        assert!(
            from_wire.is_active(),
            "enabled + rules must mean agent-auto routing actually runs"
        );

        // An ABSENT key resolves the same way — the `default = \"fn\"` half of
        // the pair. One without the other leaves half the hole open.
        let absent: AgentAutoConfig = serde_json::from_value(json!({
            "enabled": true,
            "strategy": "llm",
            "rules": [{ "description": "code", "agent_id": "claude-code" }],
        }))
        .expect("an absent classifier must parse");
        assert_eq!(absent.classifier_model, from_wire.classifier_model);

        // An operator's own pick is untouched.
        let explicit: AgentAutoConfig = serde_json::from_value(json!({
            "enabled": true,
            "strategy": "llm",
            "classifier_model": "gemma-local",
            "rules": [{ "description": "code", "agent_id": "claude-code" }],
        }))
        .expect("parses");
        assert_eq!(explicit.classifier_model, "gemma-local");
    }

    #[test]
    fn fallback_agent_defaults_to_ryu_when_unset() {
        let mut c = cfg(RouteStrategy::Keyword);
        c.default_agent_id = String::new();
        assert_eq!(c.fallback_agent_with(None), DEFAULT_FALLBACK_AGENT);
        c.default_agent_id = "gemini".into();
        assert_eq!(c.fallback_agent_with(None), "gemini");
    }

    #[test]
    fn node_default_fills_in_only_when_this_config_names_none() {
        let mut c = cfg(RouteStrategy::Keyword);
        c.default_agent_id = String::new();
        // Node-wide default wins over the flagship…
        assert_eq!(c.fallback_agent_with(Some("claude".into())), "claude");
        // …but never over this config's own explicit choice.
        c.default_agent_id = "gemini".into();
        assert_eq!(c.fallback_agent_with(Some("claude".into())), "gemini");
        // A blank node default is no default.
        c.default_agent_id = String::new();
        assert_eq!(
            c.fallback_agent_with(Some("  ".into())),
            DEFAULT_FALLBACK_AGENT
        );
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

    #[tokio::test]
    async fn config_change_clears_cached_decisions() {
        let _guard = crate::agent_routing::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        set_auto_config_from_json(
            r#"{"enabled":true,"strategy":"keyword","cache_by_session":true,
                "rules":[
                  {"description":"writing refactoring or debugging code","agent_id":"claude-code"}
                ],
                "default_agent_id":"ryu"}"#,
        );
        let sid = "config-change-test-session";
        assert_eq!(
            resolve_auto_agent("please help debugging this", Some(sid)).await,
            "claude-code"
        );

        // New rules route the SAME text to a different agent.
        set_auto_config_from_json(
            r#"{"enabled":true,"strategy":"keyword","cache_by_session":true,
                "rules":[
                  {"description":"writing refactoring or debugging code","agent_id":"gemini"}
                ],
                "default_agent_id":"ryu"}"#,
        );
        // Without invalidation this would still return the stale "claude-code"
        // decision cached under the old config.
        assert_eq!(
            resolve_auto_agent("please help debugging this", Some(sid)).await,
            "gemini"
        );
        set_auto_config_from_json("");
    }

    #[test]
    fn decision_cache_is_bounded() {
        let _guard = crate::agent_routing::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Ok(mut m) = decisions().write() {
            m.clear();
        }
        for i in 0..(DECISION_CACHE_CAPACITY + 10) {
            cache_decision(&format!("bounded-test-session-{i}"), "agent-x");
        }
        let guard = decisions().read().unwrap_or_else(|e| e.into_inner());
        assert_eq!(guard.len(), DECISION_CACHE_CAPACITY);
        // Oldest entries evicted, newest retained.
        assert!(guard.get("bounded-test-session-0").is_none());
        let newest = DECISION_CACHE_CAPACITY + 9;
        assert!(guard
            .get(&format!("bounded-test-session-{newest}"))
            .is_some());
    }

    #[test]
    fn reinsert_updates_in_place() {
        let _guard = crate::agent_routing::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Ok(mut m) = decisions().write() {
            m.clear();
        }
        let sid = "reinsert-test-session";
        cache_decision(sid, "agent-a");
        cache_decision(sid, "agent-b");
        let guard = decisions().read().unwrap_or_else(|e| e.into_inner());
        assert_eq!(guard.get(sid), Some("agent-b".to_owned()));
        assert_eq!(guard.len(), 1);
    }
}
