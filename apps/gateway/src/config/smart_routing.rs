//! Smart (classifier-driven) routing config and its defaults.

use super::*;

/// How a routing decision is reached. Shared vocabulary across both routing
/// planes (Gateway model routing here, and Core agent routing) so a route is
/// always resolved by one of a small, swappable set of strategies — never a
/// hardcoded classifier. Every strategy fails open (see [`SmartRoutingConfig`]).
///
/// - `Llm`: a cheap classifier model reads the message and picks a rule. Most
///   capable, one extra LLM round-trip per (uncached) decision.
/// - `Embedding` (RAG): embed each rule's description once and embed the query,
///   then route to the nearest rule by cosine similarity above a threshold. No
///   LLM call — cheap and local when the embedder is local.
/// - `Keyword`: case-insensitive substring match of a rule's description terms
///   against the message. Zero cost, zero network; the crude fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RouteStrategy {
    #[default]
    Llm,
    Embedding,
    Keyword,
}

/// Top-level model-router algorithm used by Gateway Plane A.
///
/// `passthrough` keeps the requested model, while `llm_classifier` is the
/// existing rule-based router whose `strategy` field selects whether rules are
/// matched by an LLM, embeddings, or keywords. The other variants mirror the
/// useful runtime families in NeMo Switchyard.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ModelRouterType {
    #[default]
    LlmClassifier,
    Passthrough,
    Random,
    StageRouter,
    Escalation,
}

/// Default tier when stage signals are too weak to clear the confidence gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum StagePicker {
    #[default]
    CapableFirst,
    EfficientFirst,
}

/// Model routing ("custom routing instructions") for Gateway Plane A.
///
/// The default `llm_classifier` router uses plain-language rules — e.g.
/// *"coding or debugging questions → claude-sonnet-4-5"* — and picks how the
/// sorting happens via [`RouteStrategy`]. `random` uses the same rules as a
/// weighted target list, `stage_router` chooses capable/efficient tiers from
/// recent request signals, and `escalation` asks a judge before a weak/strong
/// tier decision. `passthrough` is an explicit no-op. Every selected model then
/// flows through the ordinary [`crate::router::ModelRouter`] so the target's
/// provider is resolved exactly as a hand-picked model would — nothing about
/// providers is hardcoded here.
///
/// Everything fails open: an empty classifier/embedder, no rules, a classifier
/// error, or a timeout all leave the originally requested model untouched, so a
/// misconfiguration can never break chat. This is a Gateway concern (it decides
/// *what is allowed / where a call goes*), not Core.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SmartRoutingConfig {
    /// The top-level model router algorithm. Defaults to the existing
    /// `llm_classifier` behavior for backward-compatible configs.
    #[serde(default)]
    pub router_type: ModelRouterType,

    /// How the matching rule is chosen. Default `Llm` preserves the original
    /// classifier behaviour; `Embedding` and `Keyword` are opt-in and swappable.
    #[serde(default)]
    pub strategy: RouteStrategy,

    /// Embedding model used by the `Embedding` (RAG) strategy, resolved through
    /// the gateway's OpenAI-compatible embeddings endpoint (the local
    /// `nomic-embed` sidecar by default). Empty ⇒ falls back to the semantic
    /// cache's configured embedding model. Ignored by other strategies.
    #[serde(default)]
    pub embedding_model: String,

    /// Minimum cosine similarity for the `Embedding` strategy to accept a rule as
    /// a match. Below this, the request falls back to `default_model` (or keeps
    /// its original model). Default 0.35. Ignored by other strategies.
    #[serde(default = "default_route_similarity_threshold")]
    pub similarity_threshold: f32,

    /// Optional seed for reproducible weighted-random sequences. Omit for a
    /// process-local seed. Used only by the `random` router.
    #[serde(default)]
    pub random_seed: Option<u64>,

    /// Capable tier used by the `stage_router` algorithm.
    #[serde(default)]
    pub stage_capable_model: String,
    /// Efficient tier used by the `stage_router` algorithm.
    #[serde(default)]
    pub stage_efficient_model: String,
    /// Default tier when stage signals are ambiguous.
    #[serde(default)]
    pub stage_picker: StagePicker,
    /// Minimum stage-signal confidence before the signal can override the picker.
    #[serde(default = "default_stage_confidence_threshold")]
    pub stage_confidence_threshold: f32,
    /// Number of recent request messages inspected by the stage scorer.
    #[serde(default = "default_stage_recent_message_window")]
    pub stage_recent_message_window: usize,

    /// Weak tier used by the `escalation` algorithm.
    #[serde(default)]
    pub escalation_weak_model: String,
    /// Strong tier used after the escalation streak is confirmed.
    #[serde(default)]
    pub escalation_strong_model: String,
    /// Judge model used to inspect the current trajectory before routing.
    #[serde(default)]
    pub escalation_judge_model: String,
    /// Consecutive escalation verdicts required to latch a session to strong.
    #[serde(default = "default_escalation_confirmations")]
    pub escalation_confirmations: u32,
    /// Number of recent messages included in the escalation judge prompt.
    #[serde(default = "default_escalation_recent_message_window")]
    pub escalation_recent_message_window: usize,
    /// Per-message character cap in the escalation judge prompt.
    #[serde(default = "default_escalation_message_chars")]
    pub escalation_message_chars: usize,

    /// Master switch. Default: false (the classifier call adds a round-trip to
    /// every request, so it is strictly opt-in).
    #[serde(default)]
    pub enabled: bool,

    /// The cheap model used to classify each request. Resolved to a provider via
    /// the normal model router, so it can be a local model (e.g. `"gemma-…"`), a
    /// hosted mini model, or an `openrouter/…` slug. Nothing hardcoded.
    ///
    /// Defaults to [`classify_model_id`] — the same classify-tier id the
    /// inspector takes — and an **empty value is resolved to that default at
    /// deserialization** (see [`de_classifier_model`]), so this field is never
    /// blank in practice.
    ///
    /// It used to default to `""` with a doc comment claiming "empty ⇒ smart
    /// routing is inert (fail-open)". Inert is the charitable reading; the real
    /// behaviour was worse. [`Self::is_active`] returns false on a blank
    /// classifier, and `pipeline::apply_smart_routing` treats a per-agent
    /// override as *present* the moment the agent has one — so an agent saved
    /// with routing switched on and the model box left empty did not fall back to
    /// the global smart router, it took the early return and DISABLED routing
    /// that would otherwise have worked. Resolving the blank here — the one
    /// construction seam every reader flows through — is what makes "enabled"
    /// mean "working", exactly as [`de_inspector_model`] does for the inspector.
    ///
    /// The behavioural shift is small and stays inside the module's fail-open
    /// contract: enabled + rules + blank was previously a silent no-op, and is
    /// now an attempt against the local classify tier whose failure lands on the
    /// same untouched-model outcome — minus the silence.
    #[serde(
        default = "default_classifier_model",
        deserialize_with = "de_classifier_model"
    )]
    pub classifier_model: String,

    /// Ordered natural-language rules. The classifier returns the index of the
    /// first matching rule; the request is then re-routed to that rule's `model`.
    #[serde(default)]
    pub rules: Vec<SmartRule>,

    /// Model to route to when the classifier matches no rule. `None`/empty ⇒
    /// keep the originally requested model (the fail-open default).
    #[serde(default)]
    pub default_model: Option<String>,

    /// Classify once per Core session (`x-ryu-session-id`) and reuse the decision
    /// for that session's later turns. Avoids a per-turn classifier call and
    /// mid-conversation model flapping. Default: true.
    #[serde(default = "default_true")]
    pub cache_by_session: bool,

    /// Per-classification timeout in milliseconds. On timeout the request keeps
    /// its original model. Default: 4000.
    #[serde(default = "default_smart_routing_timeout_ms")]
    pub timeout_ms: u64,

    /// The auto-routing **model pool**: case-insensitive glob patterns (`*`
    /// matches any run of characters) that a routed target model must match,
    /// e.g. `["*claude*", "gpt-*"]`. Empty ⇒ any model. See [`RoutePool`].
    #[serde(default)]
    pub allowed_models: Vec<String>,

    /// The auto-routing **provider pool**: provider ids (as resolved by the model
    /// router — `anthropic`, `openrouter`, a `[providers.compatible.<id>]`
    /// endpoint, `core` for Core-hosted agents, …) a routed target may resolve
    /// to. Empty ⇒ any provider. See [`RoutePool`].
    #[serde(default)]
    pub allowed_providers: Vec<String>,

    /// Per-agent pools, keyed by agent id: each narrows this node's pool for
    /// requests attributed to that agent (`x-ryu-agent-id` from a trusted
    /// forwarder, or a Core-proven `/v1/agents/<id>` route), so it covers ACP
    /// agents routed through the gateway as well as OpenAI-compatible ones.
    /// Read from the global config only; an agent's `ryu_smart_route` override
    /// cannot carry pools for other agents. An agent without an entry routes
    /// inside the global pool.
    #[serde(default)]
    pub agent_pools: std::collections::BTreeMap<String, RoutePool>,

    /// Per-agent routing overrides, keyed by agent id: a whole config that
    /// replaces this one for requests attributed to that agent (same identity
    /// as [`Self::agent_pools`]), so it reaches ACP agents routed through the
    /// gateway as well as OpenAI-compatible ones. Core's request-scoped
    /// `ryu_smart_route` field, when present, still wins. Read from the global
    /// config only; an override's own `agent_pools` / `agent_routes` are ignored.
    #[serde(default)]
    pub agent_routes: std::collections::BTreeMap<String, SmartRoutingConfig>,
}

pub(super) fn default_smart_routing_timeout_ms() -> u64 {
    4000
}

/// The classify tier, same id the inspector defaults to. Cheap, local, and
/// already resolvable through the model router, so "enabled" needs no second
/// decision from the operator.
pub(super) fn default_classifier_model() -> String {
    classify_model_id()
}

/// Resolve a blank `smart_routing.classifier_model` to [`classify_model_id`] as
/// the value is read off the wire — the sibling of [`de_inspector_model`], and
/// for the same reason: `#[serde(default = …)]` alone only covers an *absent*
/// field, while the desktop editor and the `PUT /v1/config` overlay both send an
/// explicit `""` when an operator clears the box.
///
/// It matters more here than for the inspector, because the per-agent override
/// map is keyed on *presence*: a blank model does not degrade to the global
/// router, it shadows it.
pub(super) fn de_classifier_model<'de, D>(deserializer: D) -> Result<String, D::Error>
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

pub(super) fn default_route_similarity_threshold() -> f32 {
    0.35
}

pub(super) fn default_stage_confidence_threshold() -> f32 {
    0.5
}

pub(super) fn default_stage_recent_message_window() -> usize {
    3
}

pub(super) fn default_escalation_confirmations() -> u32 {
    2
}

pub(super) fn default_escalation_recent_message_window() -> usize {
    28
}

pub(super) fn default_escalation_message_chars() -> usize {
    500
}

impl Default for SmartRoutingConfig {
    fn default() -> Self {
        Self {
            router_type: ModelRouterType::default(),
            strategy: RouteStrategy::default(),
            embedding_model: String::new(),
            similarity_threshold: default_route_similarity_threshold(),
            random_seed: None,
            stage_capable_model: String::new(),
            stage_efficient_model: String::new(),
            stage_picker: StagePicker::default(),
            stage_confidence_threshold: default_stage_confidence_threshold(),
            stage_recent_message_window: default_stage_recent_message_window(),
            escalation_weak_model: String::new(),
            escalation_strong_model: String::new(),
            escalation_judge_model: String::new(),
            escalation_confirmations: default_escalation_confirmations(),
            escalation_recent_message_window: default_escalation_recent_message_window(),
            escalation_message_chars: default_escalation_message_chars(),
            enabled: false,
            classifier_model: default_classifier_model(),
            rules: Vec::new(),
            default_model: None,
            cache_by_session: true,
            timeout_ms: default_smart_routing_timeout_ms(),
            allowed_models: Vec::new(),
            allowed_providers: Vec::new(),
            agent_pools: std::collections::BTreeMap::new(),
            agent_routes: std::collections::BTreeMap::new(),
        }
    }
}
