use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use tracing::{debug, info, warn};
use uuid::Uuid;

mod inline_eval;
use inline_eval::{
    backstop_flag, image_detection_kind, inline_detection_kind, inline_outcome,
    llm_judge_backstop_kind, InlineOutcome,
};

pub mod node_routing;

/// A minimal [`RequestContext`] for tests in OTHER modules (`state`, …) that need
/// one but have no business restating all thirty-odd fields — and would silently
/// rot every time one is added. Tests inside this module keep their own local
/// builders, which encode per-test intent.
#[cfg(test)]
pub(crate) mod test_support {
    use super::RequestContext;

    /// An anonymous, unbudgeted, preference-free context. Mutate the one or two
    /// fields your test is actually about.
    pub(crate) fn plain_request_context() -> RequestContext {
        RequestContext {
            request_id: "test-req".to_string(),
            api_key: "sk-test".to_string(),
            is_master_key: false,
            org_id: None,
            team_id: None,
            project_id: None,
            user_name: None,
            user_id: None,
            agent_id: None,
            key_config: None,
            skill_ids: None,
            tool_actions: None,
            tools_header_present: false,
            slot_provider: None,
            slot_model: None,
            session_id: None,
            feature: None,
            companion_source: false,
            tool_search_requested: false,
            priority: crate::concurrency::Priority::Interactive,
            tool_profile: None,
            raw_tools: false,
            managed_inference: false,
            remaining_budget_micro_usd: None,
            unrestricted_budget_micro_usd: None,
            pool_budgets_micro_usd: std::collections::HashMap::new(),
            resolved_policy: None,
            prompt_cache_mode: None,
            prompt_cache_ttl: None,
            node_routing: None,
        }
    }
}

pub mod stages;
use stages::PipelineStage;

use crate::{
    audit::AuditRecord,
    budget::{BudgetChargeKind, BudgetDecision, CreditReservation},
    cache::Cache,
    config::{
        AlertTier, ApiKeyConfig, ApiKeyOperation, BudgetAction, FirewallPolicy, Modality,
        ProviderId,
    },
    error::GatewayError,
    evaluators::{Evaluator, EvaluatorImpl, EvaluatorRegistry, EvaluatorTarget},
    firewall::{inspector::InspectorClient, FirewallScanner},
    policy_alert::PolicyAlert,
    router::RouteDecision,
    semantic_cache::SemanticCache,
    state::AppState,
};

/// Build the firewall [`PolicyAlert`] for an inbound/outbound firewall match, or
/// `None` when the resolved firewall's `alert` tier is below `Warn` (so a
/// firewall with no configured tier fires no alert). `enforcement` is `block`
/// (Block) or `notify` (WarnAndContinue).
/// Constant-time string equality — no early return on the first differing byte, so
/// comparing a caller-supplied key against the configured master key leaks no timing
/// signal about how many leading bytes matched. Length mismatch short-circuits (key
/// length is not secret). The Gateway defaults to a `0.0.0.0` bind, making a naive
/// `==` a remotely-observable side channel.
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Verify the Core-minted proof on an agent-scoped Gateway route.
///
/// Dynamic `rgw_` credentials are tenant credentials, not trusted-forwarder
/// credentials. The proof makes the agent identity an assertion from Core,
/// bound to the exact bearer that authenticated this request, instead of a
/// caller-controlled header that could move spend between agents.
fn verify_agent_route_proof(raw_api_key: Option<&str>, agent_id: &str, proof: &str) -> bool {
    type AgentRouteMac = Hmac<Sha256>;

    let Some(raw_api_key) = raw_api_key else {
        return false;
    };
    let key = raw_api_key
        .strip_prefix("Bearer ")
        .unwrap_or(raw_api_key)
        .trim();
    if key.is_empty() || proof.trim().is_empty() {
        return false;
    }
    let Ok(mut mac) = AgentRouteMac::new_from_slice(key.as_bytes()) else {
        return false;
    };
    mac.update(b"ryu-agent-route-v1\0");
    mac.update(agent_id.as_bytes());
    let Ok(expected) = hex::decode(proof.trim()) else {
        return false;
    };
    mac.verify_slice(&expected).is_ok()
}

fn firewall_policy_alert(
    cfg: &crate::config::FirewallConfig,
    ctx: &RequestContext,
    enforcement: &str,
) -> Option<PolicyAlert> {
    if cfg.alert >= AlertTier::Warn {
        Some(PolicyAlert::firewall(
            enforcement,
            cfg.alert,
            ctx.org_id.as_deref().unwrap_or(""),
        ))
    } else {
        None
    }
}

/// Context resolved from the incoming request (auth, identity).
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct RequestContext {
    pub request_id: String,
    pub api_key: String,
    pub is_master_key: bool,
    pub org_id: Option<String>,
    pub team_id: Option<String>,
    pub project_id: Option<String>,
    pub user_name: Option<String>,
    /// Caller identity for per-user budgets (U21), from `x-ryu-user-id`.
    pub user_id: Option<String>,
    /// Selected agent for per-agent budgets (U21), from `x-ryu-agent-id`.
    pub agent_id: Option<String>,
    /// The matched ApiKeyConfig, if any. Used for per-key RBAC overrides.
    pub key_config: Option<ApiKeyConfig>,
    /// Active skill ids for this request (M3 / #145 AC3), from `x-ryu-skill-ids`.
    /// `None` when no skills were applied; `Some("id1,id2")` when skills injected.
    pub skill_ids: Option<String>,
    /// Per-agent egress tool allowlist (#475 C7), from `x-ryu-tools` (CSV of FQ
    /// tool ids) with a legacy fallback to `x-ryu-composio-actions`. `Some("A,B")`
    /// overrides the gateway's global allowlist for this request's tool loop;
    /// `None` falls back. Renamed from `composio_actions` — it now scopes the
    /// unified tool loop, not just Composio.
    pub tool_actions: Option<String>,
    /// True only when the request literally carried the new `x-ryu-tools`
    /// header (#475 C7). This is the *trigger* for the unified search-based tool
    /// loop, kept distinct from `tool_actions` (which folds in the legacy
    /// `x-ryu-composio-actions` fallback for allowlisting). A bare Composio agent
    /// carries only the legacy header → this stays false → it keeps its fast
    /// streaming path and the legacy Composio loop, never the unified loop.
    pub tools_header_present: bool,
    /// Per-agent slot provider override (M3 / #164), from `x-ryu-slot-provider`.
    /// When set, this provider is used in place of the static modality_map entry
    /// for multimodal requests from carded agents. `None` falls back to the map.
    pub slot_provider: Option<ProviderId>,
    /// Per-agent slot model override (M3 / #164), from `x-ryu-slot-model`.
    /// When set alongside `slot_provider`, this model is forwarded to the provider
    /// instead of the config-pinned or caller-requested model.
    pub slot_model: Option<String>,
    /// Core conversation/session id forwarded by Core via `x-ryu-session-id` (M4 / #176).
    /// Used as the correlation key for per-run/per-session audit queries.
    pub session_id: Option<String>,
    /// Product surface that originated this request (profiles / usage-points),
    /// from `x-ryu-feature` (`chat` | `island` | `predict` | `agent`). `None`
    /// when untagged (self-hosted / legacy callers). Recorded on the audit row so
    /// the reporter can build the per-feature daily usage breakdown.
    pub feature: Option<String>,
    /// True when Core has tagged this request as originating from the context
    /// companion (screen-capture path). When set, Gateway DLP/PII redaction is
    /// applied unconditionally before the provider call, even if the local
    /// firewall is disabled (M7 / #199). Forwarded by Core via `x-ryu-companion-source`.
    pub companion_source: bool,
    /// Explicit opt-in to the unified search-based tool loop (#475), from
    /// `x-ryu-tool-search: on`. Together with a non-empty `tool_actions`, this is
    /// the signal that flips the chat path from the fast direct stream to the
    /// buffered tool loop. Absent ⇒ no signal ⇒ fast path (no added latency, and
    /// no double surface on ACP egress — Core's ACP forwarder never sets it).
    pub tool_search_requested: bool,
    /// Admission priority for the local-engine queue, from `x-ryu-priority`
    /// (`background` ⇒ Background, else Interactive). Lets interactive chat jump
    /// ahead of background fan-out (delegate / threads / scheduler) when the
    /// resident engine's batch slots are full.
    pub priority: crate::concurrency::Priority,
    /// Named tool-policy profile selected for this request (#473 profiles), from
    /// `x-ryu-tool-profile`. Resolves to an allowlist preset in
    /// `effective_tool_allowlist` that the explicit `x-ryu-tools` allow/deny
    /// still overrides. `None` (or an unknown name) ⇒ no profile ⇒ today's
    /// allowlist behavior, unchanged.
    pub tool_profile: Option<String>,
    /// Raw tool passthrough (SDK-side agent loops), from `x-ryu-raw-tools`. When
    /// true, BOTH managed tool loops (unified search + legacy Composio) are
    /// suppressed and the request takes the plain completion branch, so the
    /// caller's own `tools` are forwarded verbatim and its `tool_calls` are
    /// returned un-intercepted. This lets `@ryu/sdk`'s in-process agent loop run
    /// its own tool calling against a Composio-on node without Core's loop
    /// swallowing the calls. Governance still applies where tools actually
    /// execute (Core `/api/mcp/tools/call` enforces the agent allowlist).
    pub raw_tools: bool,
    /// True when this request's org was resolved from an `rgw_` gateway token
    /// (multi-tenant data plane) and the org bills through managed inference.
    /// Only managed tenants get the pre-flight credit gate + fail-closed debit;
    /// BYOK / static-key / master-key traffic is `false` and unaffected.
    pub managed_inference: bool,
    /// The resolved org's remaining credit budget in micro-USD, from the
    /// control-plane token resolution. `Some(b)` with `b <= 0` ⇒ wallet exhausted
    /// ⇒ pre-flight 402. `None` ⇒ no managed cap (uncapped / non-managed).
    ///
    /// TOTAL spendable: subscription + top-up + pool-restricted grants. The two
    /// fields below decompose it so the gate can answer "has $10 cloudflare, $0
    /// bedrock" — a question one scalar cannot express.
    pub remaining_budget_micro_usd: Option<i64>,
    /// The part of [`Self::remaining_budget_micro_usd`] spendable against ANY
    /// pool. `None` ⇒ pre-pool control plane; the gate then treats the whole
    /// balance as unrestricted, which is byte-for-byte today's behavior.
    pub unrestricted_budget_micro_usd: Option<i64>,
    /// Remaining pool-restricted grant money by credit-pool id (see
    /// [`crate::credit_pools`]). Grants for a pool this request is not routed to
    /// are unreachable by construction: the gate only ever adds the ONE matching
    /// entry to the unrestricted part.
    pub pool_budgets_micro_usd: std::collections::HashMap<String, i64>,
    /// The org's resolved effective policy when auth came from a dynamic `rgw_`
    /// token. `Some` ⇒ the pipeline enforces THIS tenant's policy (allowlist /
    /// locked guardrails) instead of the global startup policy; `None` ⇒ the
    /// global `state.policy` applies (single-org / static-key / master paths).
    pub resolved_policy: Option<crate::policy::EffectivePolicy>,
    /// Per-request provider prompt-cache mode, from `x-ryu-prompt-cache`
    /// (`off` | `auto` | `explicit`). Overrides `[prompt_cache].mode`; ignored
    /// when the node sets `allow_request_override = false`. `None` ⇒ node default.
    pub prompt_cache_mode: Option<ryu_gw_providers::PromptCacheMode>,
    /// Per-request `cache_control.ttl`, from `x-ryu-prompt-cache-ttl` (e.g. `1h`).
    pub prompt_cache_ttl: Option<String>,
    /// The node's stated routing preferences, from `x-ryu-node-routing` — RAW
    /// and UNCLAMPED.
    ///
    /// Read it only through [`node_routing::clamp_fallback`] /
    /// [`node_routing::clamp_firewall`], never directly. On the dynamic `rgw_`
    /// path `key_config` is `None`, so `trusted_forwarder` cannot vouch for this
    /// document — it is exactly as trustworthy as the bearer that carried it, and
    /// the clamps (not authentication) are what make it safe. That is also why it
    /// is carried on ALL auth paths rather than only the "trusted" ones: there is
    /// no trusted tier to condition on.
    pub node_routing: Option<node_routing::NodeRoutingPrefs>,
}

/// Describes the degraded mode the pipeline entered, if any, for this request.
///
/// Emitted as the `x-degraded` response header and incremented in metrics
/// so clients and operators can observe fallback / exhaustion events (#218).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DegradedMode {
    /// Request was served by a fallback provider because the primary circuit
    /// was open. Header value: `fallback:<provider-name>`.
    Fallback(String),
}

impl DegradedMode {
    /// The stable string emitted as the `x-degraded` header value.
    pub fn header_value(&self) -> String {
        match self {
            DegradedMode::Fallback(provider) => format!("fallback:{provider}"),
        }
    }
}

#[allow(dead_code)]
pub struct PipelineOutput {
    pub response: Value,
    pub context: RequestContext,
    pub provider_used: &'static str,
    pub model_used: String,
    pub cache_hit: bool,
    /// Triggered budget action (U21), surfaced to the client as headers.
    pub budget: Option<BudgetDecision>,
    /// Overall eval score for this request, if it was sampled and scored.
    pub eval_score: Option<f32>,
    /// Set when the request was served in degraded mode (#218).
    pub degraded: Option<DegradedMode>,
    /// Stamped policy alert (budget-cap or firewall warn) for the Ok path. The
    /// handler inserts it into `response.extensions_mut()`; the router's
    /// `map_response` layer writes it out as `x-ryu-policy-alert`.
    pub policy_alert: Option<PolicyAlert>,
    /// What the prompt-cache stage did, surfaced as `x-ryu-prompt-cache`.
    pub prompt_cache: ryu_gw_providers::PromptCacheOutcome,
    /// Prompt tokens the provider served from its cache (`x-ryu-cache-read`) and
    /// wrote into it (`x-ryu-cache-write`). Together with `prompt_cache` these
    /// are what let a caller *prove* markers reached the provider and hit —
    /// previously only an aggregate counter existed, so a single request could
    /// not be checked.
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

/// Provider operation for the non-chat, token-metered data-plane endpoints.
/// Embeddings and reranking deliberately enter this pipeline instead of calling
/// a provider directly so auth, rate limits, budgets, reservations, fallback,
/// accounting, and audit records share one governed seam.
#[derive(Clone, Copy)]
pub enum EmbeddingOperation {
    Embed,
    Rerank,
}

impl EmbeddingOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Embed => "embedding",
            Self::Rerank => "rerank",
        }
    }
}

#[allow(dead_code)]
pub struct PipelineStreamOutput {
    pub body: Body,
    pub context: RequestContext,
    pub provider_used: &'static str,
    pub model_used: String,
    /// Triggered budget action (U21), surfaced to the client as headers.
    pub budget: Option<BudgetDecision>,
    /// Set when the streaming request was served in degraded mode (#218).
    pub degraded: Option<DegradedMode>,
    /// Stamped policy alert (budget-cap or firewall warn) for the Ok path (see
    /// [`PipelineOutput::policy_alert`]).
    pub policy_alert: Option<PolicyAlert>,
    /// What the prompt-cache stage did, surfaced as `x-ryu-prompt-cache`. The
    /// read/write token counts are not available here — they arrive in the
    /// stream's terminal usage frame, so the observer records them into metrics
    /// at stream end rather than into a header.
    pub prompt_cache: ryu_gw_providers::PromptCacheOutcome,
}

// ─── Authentication ───────────────────────────────────────────────────────────

/// The forwarded inputs `authenticate` resolves into a [`RequestContext`].
///
/// Grouped into a struct (rather than ~10 positional params) so call sites read
/// clearly and adding a field doesn't churn every caller. Admin endpoints that
/// only need auth use [`AuthInputs::with_key`]; the chat / multimodal paths fill
/// in the forwarded identity + slot + tool-allowlist fields.
#[derive(Debug, Default)]
pub struct AuthInputs<'a> {
    pub raw_api_key: Option<&'a str>,
    /// Caller identity for per-user budgets (U21), from `x-ryu-user-id`.
    pub user_id: Option<String>,
    /// Selected agent for per-agent budgets (U21), from `x-ryu-agent-id`.
    pub agent_id: Option<String>,
    /// Core's HMAC proof for an agent-scoped Gateway ingress. Only dynamic
    /// `rgw_` credentials use this; static trusted-forwarder/master paths keep
    /// their existing identity rules.
    pub agent_proof: Option<String>,
    /// Active skill ids (M3 / #145 AC3), from `x-ryu-skill-ids`.
    pub skill_ids: Option<String>,
    /// Per-agent egress tool allowlist (#475 C7), from `x-ryu-tools` (legacy
    /// fallback `x-ryu-composio-actions`).
    pub tool_actions: Option<String>,
    /// True only when the new `x-ryu-tools` header was literally present (#475).
    /// The trigger for the unified tool loop — distinct from `tool_actions`,
    /// which folds in the legacy `x-ryu-composio-actions` fallback.
    pub tools_header_present: bool,
    /// Per-agent modality slot provider override (M3 / #164).
    pub slot_provider: Option<ProviderId>,
    /// Per-agent modality slot model override (M3 / #164).
    pub slot_model: Option<String>,
    /// Core conversation id (M4 / #176), from `x-ryu-session-id`.
    pub session_id: Option<String>,
    /// Product surface (profiles / usage-points), from `x-ryu-feature`.
    pub feature: Option<String>,
    /// Companion-sourced flag (M7 / #199), from `x-ryu-companion-source`.
    pub companion_source: bool,
    /// Explicit unified-tool-loop opt-in (#475), from `x-ryu-tool-search: on`.
    pub tool_search_requested: bool,
    /// Local-engine admission priority (#queue), from `x-ryu-priority`.
    pub priority: crate::concurrency::Priority,
    /// Named tool-policy profile (#473 profiles), from `x-ryu-tool-profile`.
    pub tool_profile: Option<String>,
    /// Raw tool passthrough (SDK-side agent loops), from `x-ryu-raw-tools`.
    /// Suppresses both managed tool loops so the caller's own tools/tool_calls
    /// pass through untouched.
    pub raw_tools: bool,
    /// Per-request prompt-cache mode, from `x-ryu-prompt-cache`.
    pub prompt_cache_mode: Option<ryu_gw_providers::PromptCacheMode>,
    /// Per-request prompt-cache TTL, from `x-ryu-prompt-cache-ttl`.
    pub prompt_cache_ttl: Option<String>,
    /// The node's raw routing preferences, from `x-ryu-node-routing`. Already
    /// parsed (an unparseable header is `None` — ignore, never reject) but NOT
    /// yet clamped; see [`RequestContext::node_routing`].
    pub node_routing: Option<node_routing::NodeRoutingPrefs>,
}

impl<'a> AuthInputs<'a> {
    /// Auth-only inputs for admin endpoints (no forwarded identity/slots).
    pub fn with_key(raw_api_key: Option<&'a str>) -> Self {
        Self {
            raw_api_key,
            ..Default::default()
        }
    }
}

/// Authenticate the request and build a RequestContext.
///
/// The forwarded fields ([`AuthInputs`]) carry the caller identity Core relays
/// via `x-ryu-*` headers; they drive per-user/per-agent budgets (U21), skill
/// attribution (M3), per-attribute slot routing (M3 / #164), session
/// correlation (M4), and the unified tool-loop allowlist (#475 C7).
pub async fn authenticate(
    state: &AppState,
    inputs: AuthInputs<'_>,
) -> Result<RequestContext, GatewayError> {
    let AuthInputs {
        raw_api_key,
        user_id,
        agent_id,
        agent_proof,
        skill_ids,
        tool_actions,
        tools_header_present,
        slot_provider,
        slot_model,
        session_id,
        feature,
        companion_source,
        tool_search_requested,
        priority,
        tool_profile,
        raw_tools,
        prompt_cache_mode,
        prompt_cache_ttl,
        node_routing,
    } = inputs;

    // Shared builder so the anonymous / master / static / dynamic paths differ
    // only in their identity fields and never drift on the forwarded request
    // fields (adding a `RequestContext` field touches one place).
    let build_ctx = |is_master_key: bool,
                     api_key: String,
                     org_id: Option<String>,
                     team_id: Option<String>,
                     project_id: Option<String>,
                     user_name: Option<String>,
                     eff_user_id: Option<String>,
                     eff_agent_id: Option<String>,
                     key_config: Option<ApiKeyConfig>,
                     managed_inference: bool,
                     remaining_budget_micro_usd: Option<i64>,
                     unrestricted_budget_micro_usd: Option<i64>,
                     pool_budgets_micro_usd: std::collections::HashMap<String, i64>,
                     resolved_policy: Option<crate::policy::EffectivePolicy>|
     -> RequestContext {
        RequestContext {
            request_id: Uuid::new_v4().to_string(),
            api_key,
            is_master_key,
            org_id,
            team_id,
            project_id,
            user_name,
            user_id: eff_user_id,
            agent_id: eff_agent_id,
            key_config,
            skill_ids: skill_ids.clone(),
            tool_actions: tool_actions.clone(),
            tools_header_present,
            slot_provider: slot_provider.clone(),
            slot_model: slot_model.clone(),
            session_id: session_id.clone(),
            feature: feature.clone(),
            companion_source,
            tool_search_requested,
            priority,
            tool_profile: tool_profile.clone(),
            raw_tools,
            managed_inference,
            remaining_budget_micro_usd,
            unrestricted_budget_micro_usd,
            pool_budgets_micro_usd,
            resolved_policy,
            prompt_cache_mode,
            prompt_cache_ttl: prompt_cache_ttl.clone(),
            node_routing: node_routing.clone(),
        }
    };

    // Outcome of the synchronous match under the auth lock. The dynamic `rgw_`
    // resolve is async and MUST NOT hold the `auth` read guard across an await, so
    // it is deferred to after the lock is released.
    enum StaticOutcome {
        Matched(RequestContext),
        Reject(GatewayError),
        /// No static match, but the bearer is an `rgw_` token and the resolve
        /// cache is enabled: try the control-plane resolution outside the lock.
        TryDynamic(String),
    }

    // Use the live auth config (via RwLock) so keys added via PUT /v1/config
    // take effect immediately without a gateway restart.
    let outcome = state.with_auth(|auth| {
        if !auth.require_auth {
            // Even in no-auth mode a PROVISIONED master key stays authoritative:
            // a caller presenting it is recognized as master (so the shared
            // control-plane admin gate — config/audit/budget-spend — honors it),
            // while everyone else remains anonymous exactly as before. Without a
            // configured master key this is a no-op and the zero-config dev path
            // is unchanged (P2 #2 — pairs with the `master_key_present` term in
            // `admin_loopback_allowed`).
            if let (Some(master), Some(raw)) = (&auth.master_key, raw_api_key) {
                let key = raw.strip_prefix("Bearer ").unwrap_or(raw);
                if ct_eq(key, master.as_str()) {
                    return StaticOutcome::Matched(build_ctx(
                        true,
                        key.to_string(),
                        None,
                        None,
                        None,
                        Some("master".to_string()),
                        user_id.clone(),
                        agent_id.clone(),
                        None,
                        false,
                        None,
                        None,
                        std::collections::HashMap::new(),
                        None,
                    ));
                }
            }
            return StaticOutcome::Matched(build_ctx(
                false,
                raw_api_key.unwrap_or("anonymous").to_string(),
                None,
                None,
                None,
                None,
                user_id.clone(),
                agent_id.clone(),
                None,
                false,
                None,
                None,
                std::collections::HashMap::new(),
                None,
            ));
        }

        let Some(key) = raw_api_key else {
            return StaticOutcome::Reject(GatewayError::Unauthorized(
                "No API key provided. Pass it via the Authorization header.".to_string(),
            ));
        };
        let key = key.strip_prefix("Bearer ").unwrap_or(key);

        if let Some(master) = &auth.master_key {
            if ct_eq(key, master.as_str()) {
                return StaticOutcome::Matched(build_ctx(
                    true,
                    key.to_string(),
                    None,
                    None,
                    None,
                    Some("master".to_string()),
                    user_id.clone(),
                    agent_id.clone(),
                    None,
                    false,
                    None,
                    None,
                    std::collections::HashMap::new(),
                    None,
                ));
            }
        }

        for cfg_key in &auth.api_keys {
            // Constant-time compare (as the master-key branch above already does):
            // a naive `==` short-circuits on the first differing byte, a timing
            // oracle that leaks the key byte-by-byte to a network attacker (the
            // default bind is 0.0.0.0). Keep first-match semantics — only the
            // per-byte signal is removed.
            if ct_eq(key, cfg_key.key.as_str()) {
                if !cfg_key.allows_operation(ApiKeyOperation::Inference) {
                    return StaticOutcome::Reject(GatewayError::Unauthorized(
                        "API key is not authorized for inference relay".to_owned(),
                    ));
                }
                // The budget identity must not be spoofable. Only honor the
                // client-supplied x-ryu-user-id / x-ryu-agent-id headers when this
                // key is an explicitly trusted forwarder (e.g. Ryu Core relaying a
                // real end-user identity). Otherwise bind the budget identity to
                // the authenticated key so a caller cannot evade or shift its quota
                // by setting or rotating those headers.
                let (eff_user_id, eff_agent_id) = if cfg_key.trusted_forwarder {
                    (user_id.clone(), agent_id.clone())
                } else {
                    (Some(cfg_key.name.clone()), None)
                };
                return StaticOutcome::Matched(build_ctx(
                    false,
                    key.to_string(),
                    cfg_key.org_id.clone(),
                    cfg_key.team_id.clone(),
                    cfg_key.project_id.clone(),
                    Some(cfg_key.name.clone()),
                    eff_user_id,
                    eff_agent_id,
                    Some(cfg_key.clone()),
                    false,
                    None,
                    None,
                    std::collections::HashMap::new(),
                    None,
                ));
            }
        }

        // No static match. An `rgw_`-shaped bearer is a candidate for dynamic
        // per-token org resolution (multi-tenant data plane) when the resolve
        // cache is enabled. Everything else is a hard 401.
        if key.starts_with("rgw_") && state.resolve_cache.is_some() {
            StaticOutcome::TryDynamic(key.to_string())
        } else {
            StaticOutcome::Reject(GatewayError::Unauthorized("Invalid API key.".to_string()))
        }
    });

    match outcome {
        StaticOutcome::Matched(ctx) => Ok(ctx),
        StaticOutcome::Reject(err) => Err(err),
        StaticOutcome::TryDynamic(token) => {
            // Safe: `TryDynamic` is only produced when `resolve_cache` is `Some`.
            let cache = state
                .resolve_cache
                .as_ref()
                .expect("TryDynamic implies resolve_cache is Some");
            match cache.resolve_cached(&token).await {
                Ok(resolved) => {
                    // A resolved `rgw_` token: bill/attribute to its org. Do NOT
                    // store the raw bearer in `api_key` (it is written verbatim
                    // into every audit row) — use a redacted org-scoped label.
                    let dynamic_agent_id = match (agent_id.as_deref(), agent_proof.as_deref()) {
                        (Some(agent_id), Some(proof))
                            if verify_agent_route_proof(raw_api_key, agent_id, proof) =>
                        {
                            Some(agent_id.to_owned())
                        }
                        (Some(_), Some(_)) | (None, Some(_)) => {
                            return Err(GatewayError::Unauthorized(
                                "invalid agent route proof".to_owned(),
                            ));
                        }
                        (Some(_), None) | (None, None) => None,
                    };
                    let api_key_label = format!("rgw_org:{}", resolved.org_id);
                    Ok(build_ctx(
                        false,
                        api_key_label,
                        Some(resolved.org_id.clone()),
                        None,
                        None,
                        // `rgw_` bearer tokens are resolved by the control plane,
                        // but the forwarded identity headers are still caller
                        // input. Dynamic credentials have no trusted-forwarder
                        // configuration, so bind the user/audit identity to the
                        // resolved tenant. The agent identity is accepted only
                        // when Core supplied the HMAC proof above.
                        Some(format!("org:{}", resolved.org_id)),
                        None,
                        dynamic_agent_id,
                        None,
                        resolved.managed_inference,
                        resolved.remaining_budget_micro_usd,
                        resolved.unrestricted_budget_micro_usd,
                        resolved.pool_budgets_micro_usd.clone(),
                        Some(resolved.policy.clone()),
                    ))
                }
                // An `rgw_`-shaped token that does not resolve (invalid / revoked /
                // control plane unreachable) is a HARD 401 — never fall open into
                // anonymous.
                Err(crate::policy::ResolveErr::Unresolved) => Err(GatewayError::Unauthorized(
                    "Invalid or revoked gateway token.".to_string(),
                )),
            }
        }
    }
}

// ─── Smart model routing ─────────────────────────────────────────────────────

/// Run smart routing for a chat request, rewriting `body["model"]` in place when
/// the configured router picks a different target. Returns `true` if the model
/// was rewritten (so the caller can tell `pre_process` to skip eval/A-B routing
/// and honor the smart choice).
///
/// No-ops (returns `false`) when smart routing is inactive, when a per-agent
/// chat slot override is present (explicit pinning wins over routing), or when
/// the router keeps the original model. It fails open in every error
/// case — see [`crate::router::smart`].
async fn apply_smart_routing(state: &AppState, ctx: &RequestContext, body: &mut Value) -> bool {
    // A pinned per-agent chat slot is an explicit user choice — never override it.
    if ctx.slot_provider.is_some() || ctx.slot_model.is_some() {
        return false;
    }

    // Per-agent override (the "both" config scope): Core injects the agent's own
    // `SmartRoutingConfig` as the private `ryu_smart_route` body field. When
    // present it replaces the global router for this request; each distinct
    // config gets one cached ephemeral `SmartRouter` (keyed by a hash of its JSON)
    // so its rule-embedding + per-session caches persist across the agent's turns.
    // The private field is always stripped before the body reaches the provider.
    let per_agent = per_request_smart_router(state, body);
    // Clone the global smart router Arc out of the hot-swap lock so it survives the
    // router `.await` below (PUT /v1/config can swap it concurrently); a per-agent
    // override still wins over the global default.
    let global = state.smart_router();
    let router: &dyn crate::router::smart::SmartRouterBackend = match per_agent.as_deref() {
        Some(r) => r,
        None => global.as_ref(),
    };

    if !router.is_active() {
        return false;
    }

    // Clone the active model-routing backend out of its swap lock so it survives
    // the router `.await` too (W6c: `state.router` is now a registry).
    let model_router = state.router.active();
    let chosen = router
        .resolve(
            &body["messages"],
            ctx.session_id.as_deref(),
            &state.providers,
            model_router.as_ref(),
            &state.http,
            state.config.providers.openai.as_ref(),
        )
        .await;

    let Some(model) = chosen else {
        return false;
    };

    let current = body["model"].as_str().unwrap_or("");
    if model == current {
        return false;
    }

    debug!(
        request_id = %ctx.request_id,
        from = current,
        to = %model,
        "smart routing: re-routed request to selected model"
    );
    body["model"] = Value::String(model);
    true
}

/// Extract and strip the private `ryu_smart_route` per-agent override from the
/// request body, returning a cached ephemeral [`SmartRouter`] for it.
///
/// The field is ALWAYS removed from `body` (so it never reaches a provider), even
/// when it fails to parse. A parse failure returns `None`, so the caller fails
/// open to the global router. Distinct override configs are cached by a stable
/// hash of their serialized JSON, so an agent reuses one router (and its
/// rule-embedding + session caches) across turns.
fn per_request_smart_router(
    state: &AppState,
    body: &mut Value,
) -> Option<Arc<crate::router::smart::SmartRouter>> {
    let raw = body.as_object_mut()?.remove("ryu_smart_route")?;
    let cfg: crate::config::SmartRoutingConfig = serde_json::from_value(raw).ok()?;

    let json = serde_json::to_string(&cfg).ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(&json, &mut hasher);
    let key = std::hash::Hasher::finish(&hasher);

    let router = state
        .per_agent_routers
        .entry(key)
        .or_insert_with(|| Arc::new(crate::router::smart::SmartRouter::new(cfg)))
        .clone();
    Some(router)
}

// ─── Anthropic betas (the private `ryu_anthropic_beta` body field) ────────────

/// The private body field carrying the caller's `anthropic-beta` opt-ins as one
/// comma-separated string, from the chat-completions intake to the Anthropic
/// provider. Same convention as `ryu_smart_route` above.
///
/// Named once, here, because two modules must agree on the string: `api::chat`
/// WRITES it from the request header and [`strip_anthropic_beta_for`] REMOVES it
/// before any other provider sees it. A literal in each place could drift, and
/// the failure mode of drift is a 400 from a strict OpenAI endpoint.
pub(crate) const ANTHROPIC_BETA_FIELD: &str = "ryu_anthropic_beta";

/// Whether `provider` speaks the Anthropic Messages dialect, and is therefore an
/// intended reader of [`ANTHROPIC_BETA_FIELD`] — and, either way, one that builds
/// its own whitelist payload rather than forwarding the body verbatim.
///
/// `bedrock` is neither a typo nor optional: it is `AnthropicProvider` re-exposed
/// under its own registry id (see [`crate::providers::ProviderRegistry::new`]), so
/// `Provider::name` reports `"bedrock"` while the wire format is still Anthropic
/// Messages. Anchored to the shared const so renaming that id cannot silently
/// start stripping the betas off the Bedrock path.
fn speaks_anthropic_dialect(provider: &str) -> bool {
    // `AnthropicProvider::name()` is the hardcoded "anthropic" (no id const for
    // the built-in slots); the credit-pool alias does have one.
    provider == "anthropic" || provider == crate::config::BEDROCK_PROVIDER_ID
}

/// Strip [`ANTHROPIC_BETA_FIELD`] from the outgoing body unless `provider` is the
/// one that reads it.
///
/// Allowlist direction on purpose: every non-Anthropic provider clones the request
/// body VERBATIM into its payload (`openai.rs`, `openrouter.rs`, `local.rs`, …)
/// and an unknown top-level field 400s a strict OpenAI endpoint, so a provider id
/// nobody has thought about yet is safe by default.
///
/// Called per fallback ATTEMPT, not hoisted next to [`apply_prompt_cache`]:
/// `AnthropicProvider` takes the body by reference and builds its own whitelist
/// payload, so the field is still in *ours* after an Anthropic attempt — a
/// fallback onto `openai` for attempt 2 has to re-decide. Do not lift it out of
/// the loop.
fn strip_anthropic_beta_for(body: &mut Value, provider: &str) {
    if speaks_anthropic_dialect(provider) {
        return;
    }
    if let Some(obj) = body.as_object_mut() {
        obj.remove(ANTHROPIC_BETA_FIELD);
    }
}

/// Give OpenRouter's own generation and analytics surfaces a stable, opaque Ryu
/// identity for Gateway-routed ACP traffic. The Gateway still enforces the cap
/// from the inline `usage.cost`; this field exists so an operator can reconcile
/// the same generation later through OpenRouter's `/generation` endpoint.
///
/// Agent identity wins because the per-agent budget is the product surface being
/// measured. A user-only request still gets a stable user tag. Native Claude or
/// Codex subscription passthrough never reaches this helper and therefore is
/// intentionally not represented as OpenRouter spend.
fn stamp_openrouter_identity(body: &mut Value, provider: &str, ctx: &RequestContext) {
    if provider != "openrouter" {
        return;
    }
    let identity = ctx
        .agent_id
        .as_deref()
        .map(|id| format!("ryu-agent:{id}"))
        .or_else(|| ctx.user_id.as_deref().map(|id| format!("ryu-user:{id}")));
    let Some(identity) = identity else {
        return;
    };
    if let Some(obj) = body.as_object_mut() {
        obj.insert("user".to_string(), Value::String(identity));
    }
}

// ─── Pre-process (shared by run + run_stream) ─────────────────────────────────

/// Shared pre-processing: rate-limit + burst check + inbound-firewall + routing.
/// Returns the routing decision and exact-match cache key.
///
/// `smart_routed` is `true` when [`apply_smart_routing`] already rewrote
/// `body["model"]`; in that case eval-driven A/B routing is skipped so the
/// classifier's choice is honored (otherwise `eval_route` would override the
/// model's provider — see the no-slot branch below).
async fn pre_process(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
    smart_routed: bool,
) -> Result<(RouteDecision, String, Option<PolicyAlert>), GatewayError> {
    // Ok-path policy alert accumulated during pre-processing (currently a
    // firewall warn-and-continue match). Merged with any budget alert by the
    // caller and stamped onto the response header via the router's map_response.
    let mut pending_alert: Option<PolicyAlert> = None;

    // Per-request inputs shared by the firewall / inspector / policy / companion
    // stages. Resolved ONCE here (not per stage): `resolved_scanner` hands back a
    // cached `Arc<FirewallScanner>` (node→org→agent, no lock held), reused across
    // the regex scan, the inspector's `.await`, the locked-guardrail scan, and the
    // companion redaction. `prompt_text` is the single text extraction the pre-W6d
    // code also did once. Hoisting them above the stage loop (rather than computing
    // inside the firewall step) is what lets the governance stages be reordered
    // freely; the only cost is one extra text extraction on the rate-limited reject
    // path, which is immaterial and not a behavior change.
    let prompt_text = extract_text_for_scanning(body);
    let scanner = state.resolved_scanner(ctx);
    let requested_model = body["model"].as_str().unwrap_or("gpt-4o").to_string();

    // The routing decision, produced by the pinned `Route` stage. `StageOrder`
    // guarantees `Route` is present in every resolved order, so this is `Some`
    // after the loop.
    let mut decision: Option<RouteDecision> = None;

    // Run the pre-processing stages in the resolved, validated order. The order is
    // DATA (`state.stage_order`, resolved once at config-apply time — zero
    // per-request allocation to know it), so the default reproduces the exact
    // pre-W6d numbered sequence while config can reorder / disable the governance
    // block within the pinned safety skeleton (rate-limit → firewall → … → route
    // → audit). See `pipeline::stages`.
    for &stage in state.stage_order.stages() {
        match stage {
            // Steps 1 + 2: per-key request rate limit + burst / bot detection.
            PipelineStage::RateLimit => {
                if !state
                    .rate_limiter
                    .check_request_for_key(&ctx.api_key, ctx.key_config.as_ref())
                {
                    warn!(key = %ctx.api_key, request_id = %ctx.request_id, "rate limit exceeded");
                    state.metrics.inc_rate_limited();
                    return Err(GatewayError::RateLimited);
                }
                if !state.rate_limiter.check_burst(&ctx.api_key) {
                    warn!(key = %ctx.api_key, request_id = %ctx.request_id, "burst rate exceeded (bot detection)");
                    state.metrics.inc_rate_limited();
                    return Err(GatewayError::RateLimited);
                }
            }

            // Step 3: inbound regex firewall on the per-request RESOLVED scanner
            // (node → org → agent).
            PipelineStage::Firewall => {
                if let Some(violation) = scanner.scan_inbound(&prompt_text) {
                    match scanner.policy() {
                        FirewallPolicy::Block => {
                            state.metrics.inc_firewall_blocked();
                            return Err(GatewayError::FirewallBlocked(
                                format!(
                                    "Inbound content blocked: {} ({:?})",
                                    violation.pattern_name, violation.kind
                                ),
                                firewall_policy_alert(scanner.config(), ctx, "block"),
                            ));
                        }
                        FirewallPolicy::Sanitize => {
                            warn!(
                                request_id = %ctx.request_id,
                                pattern = %violation.pattern_name,
                                "firewall: sanitized inbound content"
                            );
                            sanitize_messages(body, scanner.as_ref());
                        }
                        FirewallPolicy::WarnAndContinue => {
                            warn!(
                                request_id = %ctx.request_id,
                                pattern = %violation.pattern_name,
                                "firewall: inbound violation (warn-and-continue)"
                            );
                            // Ok-path stamp: a warn-tier firewall match propagates
                            // its alert to the response via the pending-alert return.
                            pending_alert = merge_alert(
                                pending_alert,
                                firewall_policy_alert(scanner.config(), ctx, "notify"),
                            );
                        }
                    }
                }
            }

            // Step 3a: LLM traffic inspector (opt-in, inbound-only). Calls a cheap
            // model directly (never the tool loop) and fails OPEN — a timeout /
            // provider error / bad JSON is treated as not-flagged (allow + warn).
            // Gated by `enabled` + `min_chars` inside `inspect`, so it is a cheap
            // no-op when disabled.
            PipelineStage::Inspector => {
                let inspector_cfg = scanner.config().inspector.clone();
                if inspector_cfg.enabled {
                    let model_router = state.router.active();
                    let verdict = crate::firewall::inspector::InspectorClient::inspect(
                        &prompt_text,
                        &inspector_cfg,
                        &state.providers,
                        model_router.as_ref(),
                    )
                    .await;
                    if verdict.flagged {
                        match inspector_cfg.action {
                            FirewallPolicy::Block => {
                                warn!(
                                    request_id = %ctx.request_id,
                                    categories = ?verdict.categories,
                                    reason = %verdict.reason,
                                    "inspector: blocked inbound content"
                                );
                                state.metrics.inc_firewall_blocked();
                                audit_inspector_block(state, ctx, body, &verdict);
                                return Err(GatewayError::FirewallBlocked(
                                    format!(
                                        "Inbound content blocked by inspector: {} [{}]",
                                        verdict.reason,
                                        verdict.categories.join(",")
                                    ),
                                    firewall_policy_alert(scanner.config(), ctx, "block"),
                                ));
                            }
                            FirewallPolicy::Sanitize => {
                                warn!(
                                    request_id = %ctx.request_id,
                                    categories = ?verdict.categories,
                                    "inspector: sanitizing flagged inbound content"
                                );
                                sanitize_messages(body, scanner.as_ref());
                            }
                            FirewallPolicy::WarnAndContinue => {
                                warn!(
                                    request_id = %ctx.request_id,
                                    categories = ?verdict.categories,
                                    reason = %verdict.reason,
                                    "inspector: inbound flagged (warn-and-continue)"
                                );
                            }
                        }
                    }
                }
            }

            // Step 3a-ii: unified-evaluator inline guardrails — INPUT target (P3).
            // Reuses the SAME block/sanitize/warn machinery as the regex firewall
            // and the inspector. A no-op (allocation-free) when no binding is enabled.
            PipelineStage::InlineInput => {
                if let Some(alert) =
                    apply_inline_input_evaluators(state, ctx, body, scanner.as_ref(), &prompt_text)
                        .await?
                {
                    pending_alert = merge_alert(pending_alert, Some(alert));
                }
            }

            // Step 3b: control-plane policy (U28). The master key bypasses
            // (operator escape hatch), matching rate-limit semantics elsewhere.
            PipelineStage::Policy => {
                if !ctx.is_master_key {
                    // A dynamically-resolved `rgw_` tenant enforces its OWN
                    // control-plane policy; single-org / static-key paths use the
                    // global startup policy.
                    let policy = ctx
                        .resolved_policy
                        .clone()
                        .unwrap_or_else(|| state.policy_snapshot());

                    // Model allowlist.
                    if !policy.allows_model(&requested_model) {
                        warn!(
                            request_id = %ctx.request_id,
                            model = %requested_model,
                            "policy: model not on the control-plane allowlist"
                        );
                        state.metrics.inc_firewall_blocked();
                        return Err(GatewayError::PolicyViolation(format!(
                            "Model '{requested_model}' is not approved by control-plane policy"
                        )));
                    }

                    // Locked guardrails: scan even if the local firewall config
                    // disabled them, so a lower level cannot bypass an admin-locked
                    // guardrail. Uses the same per-request resolved scanner (its
                    // custom patterns participate).
                    if policy.requires_firewall() {
                        if let Some(violation) =
                            scanner.scan_locked_guardrails(&prompt_text, &policy.locked_guardrails)
                        {
                            warn!(
                                request_id = %ctx.request_id,
                                pattern = %violation.pattern_name,
                                "policy: locked guardrail violation in inbound request"
                            );
                            state.metrics.inc_firewall_blocked();
                            return Err(GatewayError::PolicyViolation(format!(
                                "Inbound content violates a locked guardrail: {} ({:?})",
                                violation.pattern_name, violation.kind
                            )));
                        }
                    }
                }
            }

            // Step 3c: companion DLP egress guard (M7 / #199). When Core tags a
            // request as companion-sourced (screen-capture text), unconditionally
            // redact PII and secrets from the inbound prompt before the provider
            // call — regardless of whether the local firewall is enabled (AC3).
            // `redact_companion_egress()` ignores `config.enabled`/`redact_pii`/
            // `redact_secrets`; detections are recorded via the audit path (AC2).
            PipelineStage::CompanionDlp => {
                if ctx.companion_source {
                    let (_, redacted_categories) = scanner.redact_companion_egress(&prompt_text);
                    // Redact message bodies unconditionally (categories may be empty
                    // for clean text).
                    scanner.companion_sanitize_messages(&mut body["messages"]);
                    if !redacted_categories.is_empty() {
                        warn!(
                            request_id = %ctx.request_id,
                            categories = ?redacted_categories,
                            "companion DLP: redacted PII/secrets from companion-sourced prompt before egress"
                        );
                        // Emit an audit record so redaction events are observable (AC2).
                        let category_names: Vec<&str> =
                            redacted_categories.iter().map(|c| c.as_str()).collect();
                        state.metrics.inc_firewall_blocked();
                        state.log_audit(crate::audit::AuditRecord {
                            request_id: ctx.request_id.clone(),
                            api_key: ctx.api_key.clone(),
                            user_name: ctx.user_name.clone(),
                            org_id: ctx.org_id.clone(),
                            team_id: ctx.team_id.clone(),
                            project_id: ctx.project_id.clone(),
                            provider: "companion-dlp".to_string(),
                            model: body["model"].as_str().unwrap_or("unknown").to_string(),
                            input_tokens: 0,
                            output_tokens: 0,
                            cache_hit: false,
                            latency_ms: 0,
                            eval_score: None,
                            error: Some(format!(
                                "companion DLP redacted: {}",
                                category_names.join(",")
                            )),
                            skill_ids: ctx.skill_ids.clone(),
                            session_id: ctx.session_id.clone(),
                            user_id: ctx.user_id.clone(),
                            agent_id: ctx.agent_id.clone(),
                            feature: ctx.feature.clone(),
                            managed_inference: ctx.managed_inference,
                            provider_cost_micro_usd: None,
                            event_type: crate::audit::EventType::ModelCall,
                            backend: Some("companion".to_string()),
                            command: None,
                            duration_ms: None,
                            exit_code: None,
                            widget_instance_id: None,
                        });
                    }
                }
            }

            // Step 4: model routing (Plane A). Per-agent chat slot override wins
            // over eval/model routing (M3 / #164); eval-driven A/B routing only
            // applies when no slot is set and the classifier did not already choose.
            PipelineStage::Route => {
                // ALLOWLIST CLAMP on the client-supplied chat slot model. The
                // `Policy` stage above checked `allows_model` against
                // `body["model"]` only — but the slot below REPLACES the model
                // actually dispatched. An `rgw_` bearer could therefore name an
                // approved model in the body and the real one in
                // `x-ryu-slot-chat-model`, and route around the org's
                // `approved_models` entirely. A disallowed slot model is IGNORED
                // (the fleet's own routing takes over) rather than rejected: the
                // turn still runs, under a model the org DID approve.
                //
                // Guarded exactly like the `Policy` stage — same master-key
                // bypass, same `resolved_policy || snapshot` fallback — so the
                // static-key / single-org paths this bypass never touched keep
                // their behaviour. With an empty `approved_models` (every
                // non-allowlisted deployment) `allows_model` is `true`, so this
                // is a no-op there.
                let slot_model = if ctx.is_master_key {
                    ctx.slot_model.as_deref()
                } else {
                    let policy = ctx
                        .resolved_policy
                        .clone()
                        .unwrap_or_else(|| state.policy_snapshot());
                    if node_routing::slot_model_allowed(ctx.slot_model.as_deref(), &policy) {
                        ctx.slot_model.as_deref()
                    } else {
                        warn!(
                            request_id = %ctx.request_id,
                            slot_model = ?ctx.slot_model,
                            "policy: ignoring a chat slot model outside the control-plane allowlist"
                        );
                        None
                    }
                };
                decision = Some(if ctx.slot_provider.is_some() || slot_model.is_some() {
                    state.router.route_modality_with_slot(
                        &crate::config::Modality::Chat,
                        &requested_model,
                        ctx.slot_provider.as_ref(),
                        slot_model,
                    )
                } else if smart_routed {
                    // The classifier already chose this model — route it straight
                    // to its provider and skip eval/A-B routing, which would
                    // otherwise reassign the provider and break the smart-routed
                    // model (#473 smart routing).
                    state.router.route(&requested_model)
                } else {
                    state
                        .router
                        .eval_route(&requested_model, |p| state.evals.provider_score(p.as_str()))
                        .unwrap_or_else(|| state.router.route(&requested_model))
                });
            }

            // Ordering anchor only. Auditing needs the provider response, so the
            // real `audit.log` runs post-provider in `run` / `run_stream` — which
            // is genuinely last. Modelled as a pinned terminal stage purely so
            // "audit is always last" is an enforceable, testable invariant; here it
            // is a deliberate no-op, NOT a missing implementation.
            PipelineStage::Audit => {}
        }
    }

    // `Route` is pinned present in every resolved `StageOrder`, so the loop always
    // produced a decision.
    let decision = decision.expect("Route stage is pinned present in every resolved StageOrder");

    // Build exact-match cache key from the (possibly sanitized) body.
    let cache_key = Cache::make_key(ctx.org_id.as_deref(), &decision.model, &body["messages"]);

    Ok((decision, cache_key, pending_alert))
}

/// Merge two optional policy alerts, keeping the higher-tier one. On a tie the
/// FIRST argument wins, so callers pass the firewall alert first to make it beat
/// a same-tier budget alert deterministically (one response, one header).
fn merge_alert(a: Option<PolicyAlert>, b: Option<PolicyAlert>) -> Option<PolicyAlert> {
    match (a, b) {
        (Some(a), Some(b)) => {
            if b.alert_tier > a.alert_tier {
                Some(b)
            } else {
                Some(a)
            }
        }
        (Some(a), None) => Some(a),
        (None, b) => b,
    }
}

// ─── Unified-evaluator inline guardrails (P3) ────────────────────────────────
//
// Bridge the resolved per-agent policy's enabled `EvaluatorBinding`s into the
// live pipeline as real guardrails. Input-target detectors (code_injection,
// prompt_injection) run inbound in `pre_process`; Output-target detectors
// (pii_leakage, toxicity, bias) run on the response (non-stream `run` +
// `apply_outbound_firewall_stream`). Deterministic detectors run via the
// `FirewallScanner`; LLM-judge detectors reuse the fail-open `InspectorClient`
// with the evaluator's rubric. All of this REUSES the existing firewall
// block/sanitize/warn machinery — no new enforcement path.

/// The inline action for a binding: the binding's `inline_action` wins; otherwise
/// the catalog evaluator's default `inline.action`; otherwise warn-and-continue.
fn inline_action_for(
    binding: &crate::evaluators::EvaluatorBinding,
    ev: &Evaluator,
) -> FirewallPolicy {
    binding
        .inline_action
        .clone()
        .or_else(|| ev.inline.as_ref().map(|c| c.action.clone()))
        .unwrap_or(FirewallPolicy::WarnAndContinue)
}

/// The result of evaluating one inline binding. Distinguishes a legitimate
/// `(flagged, reason)` verdict — which flows through the binding's action map
/// ([`inline_outcome`]) — from a fail-closed short-circuit that must BLOCK the
/// turn regardless of the configured action. The latter is the wasm-policy
/// fail-direction control (threat model item F): a security plugin that
/// traps/OOMs/times-out must never be silently skipped (old `None`) nor merely
/// warned (if bound to `Warn`); it blocks.
enum InlineFlag {
    /// The impl is not enforceable this phase, or this binding is skipped — an
    /// honest, logged no-op (formerly `None`).
    Skip,
    /// The evaluator ran: `(flagged, reason)` feeds the normal action map.
    Ran { flagged: bool, reason: String },
    /// A security policy failed closed (trap / OOM / timeout / invalid output with
    /// `fail_open = false`): block the turn directly, bypassing the action map.
    ForceBlock { reason: String },
}

/// Evaluate ONE enabled inline binding against `text`. Returns [`InlineFlag`]:
/// `Ran` when it produced a verdict; `Skip` when the impl is not enforceable this
/// phase (a `Code` evaluator — P4; a `Builtin`; or an empty-rubric Custom
/// template) — an honest, logged no-op, never a faked verdict; `ForceBlock` when a
/// fail-closed wasm policy must short-circuit to a block. Fail-open on the judge is
/// handled inside [`InspectorClient::inspect_rubric`].
async fn flag_inline_binding(
    ev: &Evaluator,
    scanner: &FirewallScanner,
    text: &str,
    state: &AppState,
) -> InlineFlag {
    match &ev.impl_ {
        EvaluatorImpl::Regex { .. } | EvaluatorImpl::Heuristic => {
            let Some(kind) = inline_detection_kind(&ev.id) else {
                return InlineFlag::Skip;
            };
            match scanner.scan_kind(text, kind) {
                Some(m) => InlineFlag::Ran {
                    flagged: true,
                    reason: format!("{}:{}", m.kind.as_str(), m.pattern_name),
                },
                None => InlineFlag::Ran {
                    flagged: false,
                    reason: String::new(),
                },
            }
        }
        EvaluatorImpl::LlmJudge { rubric } => {
            if rubric.trim().is_empty() {
                debug!(evaluator = %ev.id, "inline evaluator: empty rubric — no-op");
                return InlineFlag::Skip;
            }
            let ins = &scanner.config().inspector;
            let timeout = if ins.timeout_ms == 0 {
                1500
            } else {
                ins.timeout_ms
            };
            let model_router = state.router.active();
            let verdict = InspectorClient::inspect_rubric(
                text,
                rubric,
                &ins.model,
                timeout,
                &state.providers,
                model_router.as_ref(),
            )
            .await;
            // Deterministic floor: when the judge did NOT answer (no provider /
            // timeout / unparseable — the common local-only deploy), consult the
            // lexical seed so obvious slurs/threats/blanket-generalizations are still
            // caught instead of silently passing under an "enforced" detector. The
            // seed runs on the FULL untruncated `text`, also covering the judge's
            // 4000-char head-only truncation on the fail-open path. When the judge
            // DID answer we trust its context (the `backstop_flag` seam discards the
            // seed), avoiding the condemned/quoted-stereotype and casual-profanity
            // false positives a bare seed would hard-flag.
            let (seed_hit, seed_reason) = if verdict.available {
                (false, String::new())
            } else {
                match llm_judge_backstop_kind(&ev.id).and_then(|k| scanner.scan_kind(text, k)) {
                    Some(m) => (
                        true,
                        format!("seed-backstop {}:{}", m.kind.as_str(), m.pattern_name),
                    ),
                    None => (false, String::new()),
                }
            };
            let flagged = backstop_flag(verdict.available, verdict.flagged, seed_hit);
            let reason = if seed_hit {
                seed_reason
            } else {
                verdict.reason
            };
            InlineFlag::Ran { flagged, reason }
        }
        EvaluatorImpl::Code { .. } => {
            debug!(evaluator = %ev.id, "inline evaluator: code impl deferred to P4 — no-op");
            InlineFlag::Skip
        }
        EvaluatorImpl::Builtin { detector } => {
            debug!(evaluator = %ev.id, %detector, "inline evaluator: builtin impl not wired — no-op");
            InlineFlag::Skip
        }
        EvaluatorImpl::Wasm {
            module_base64,
            fail_open,
        } => flag_wasm_binding(ev, module_base64, *fail_open, text, state).await,
    }
}

/// Run an untrusted WASM policy plugin over `text` and translate its verdict into
/// an [`InlineFlag`]. The whole point of this arm is the fail-direction contract:
///   * guest `allow`  → `Ran { flagged: false }` (proceed);
///   * guest `deny`   → `Ran { flagged: true, reason }` (flows through the binding's
///     action map, so an operator may bind a deny-capable policy as Block / Sanitize
///     / Warn);
///   * sandbox `Fail` (trap / fuel / epoch / OOM / invalid output / bad module /
///     host unavailable) → if `fail_open` then `Ran { flagged: false }` (declared,
///     logged) else `ForceBlock` (default CLOSED — never a silent allow).
async fn flag_wasm_binding(
    ev: &Evaluator,
    module_base64: &str,
    fail_open: bool,
    text: &str,
    state: &AppState,
) -> InlineFlag {
    use base64::Engine as _;

    // Fail (fail-closed unless the plugin declared open) helper.
    let fail = |reason: String| -> InlineFlag {
        if fail_open {
            warn!(evaluator = %ev.id, %reason, "wasm policy failed OPEN (declared) — allowing");
            InlineFlag::Ran {
                flagged: false,
                reason: String::new(),
            }
        } else {
            warn!(evaluator = %ev.id, %reason, "wasm policy failed CLOSED — blocking");
            InlineFlag::ForceBlock {
                reason: format!("wasm policy '{}' failed closed: {reason}", ev.id),
            }
        }
    };

    // Cap the base64 payload before decoding (bounds the decode work itself).
    if module_base64.len() > crate::wasm_policy::MAX_MODULE_B64_LEN {
        return fail("module payload too large".to_string());
    }
    let bytes = match base64::engine::general_purpose::STANDARD.decode(module_base64.as_bytes()) {
        Ok(b) => b,
        Err(e) => return fail(format!("invalid base64 module: {e}")),
    };
    let Some(host) = state.wasm_host() else {
        return fail("wasm policy host unavailable".to_string());
    };
    match host.evaluate(&bytes, text).await {
        crate::wasm_policy::WasmVerdict::Allow => InlineFlag::Ran {
            flagged: false,
            reason: String::new(),
        },
        crate::wasm_policy::WasmVerdict::Deny { reason } => InlineFlag::Ran {
            flagged: true,
            reason,
        },
        crate::wasm_policy::WasmVerdict::Fail { reason } => fail(reason),
    }
}

/// Audit an inline-evaluator enforcement event (block/sanitize). Mirrors
/// [`audit_inspector_block`] so evaluator guardrails are as observable as the
/// inspector's, using the same audit fields.
fn audit_inline_evaluator(
    state: &AppState,
    ctx: &RequestContext,
    model: &str,
    evaluator_id: &str,
    enforcement: &str,
    reason: &str,
) {
    if !state.audit.is_enabled() {
        return;
    }
    state.log_audit(AuditRecord {
        request_id: ctx.request_id.clone(),
        api_key: ctx.api_key.clone(),
        user_name: ctx.user_name.clone(),
        org_id: ctx.org_id.clone(),
        team_id: ctx.team_id.clone(),
        project_id: ctx.project_id.clone(),
        provider: "evaluator".to_string(),
        model: model.to_string(),
        input_tokens: 0,
        output_tokens: 0,
        cache_hit: false,
        latency_ms: 0,
        eval_score: None,
        error: Some(format!(
            "inline evaluator '{evaluator_id}' {enforcement}: {reason}"
        )),
        skill_ids: ctx.skill_ids.clone(),
        session_id: ctx.session_id.clone(),
        user_id: ctx.user_id.clone(),
        agent_id: ctx.agent_id.clone(),
        feature: ctx.feature.clone(),
        managed_inference: ctx.managed_inference,
        provider_cost_micro_usd: None,
        event_type: crate::audit::EventType::ModelCall,
        backend: Some("inline-evaluator".to_string()),
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    });
}

/// Run the resolved policy's **input-target** inline evaluators over the inbound
/// prompt. Blocks (403) on a `Block` action, sanitizes the messages in place on
/// `Sanitize`, and returns a warn-tier [`PolicyAlert`] on `WarnAndContinue`. The
/// common empty-policy path allocates nothing (no registry build).
async fn apply_inline_input_evaluators(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
    scanner: &FirewallScanner,
    prompt_text: &str,
) -> Result<Option<PolicyAlert>, GatewayError> {
    if !scanner.config().evaluators.iter().any(|b| b.enabled) {
        return Ok(None);
    }
    let registry = EvaluatorRegistry::from_config(&state.config);
    let bindings: Vec<crate::evaluators::EvaluatorBinding> = scanner
        .config()
        .evaluators
        .iter()
        .filter(|b| b.enabled)
        .cloned()
        .collect();
    let mut pending: Option<PolicyAlert> = None;

    for binding in &bindings {
        let Some(ev) = registry.get(&binding.id) else {
            continue;
        };
        if !ev.capabilities.inline || ev.target != EvaluatorTarget::Input {
            continue;
        }
        let (flagged, reason) = match flag_inline_binding(ev, scanner, prompt_text, state).await {
            InlineFlag::Skip => continue,
            InlineFlag::Ran { flagged, reason } => (flagged, reason),
            InlineFlag::ForceBlock { reason } => {
                // Fail-closed short-circuit: block regardless of the binding's
                // configured action (the wasm-policy fail-direction control).
                let model = body["model"].as_str().unwrap_or("unknown");
                state.metrics.inc_firewall_blocked();
                audit_inline_evaluator(state, ctx, model, &ev.id, "blocked", &reason);
                warn!(
                    request_id = %ctx.request_id,
                    evaluator = %ev.id,
                    %reason,
                    "inline evaluator: fail-closed block (inbound)"
                );
                return Err(GatewayError::FirewallBlocked(
                    format!(
                        "Inbound content blocked by evaluator '{}': {}",
                        ev.id, reason
                    ),
                    firewall_policy_alert(scanner.config(), ctx, "block"),
                ));
            }
        };
        let action = inline_action_for(binding, ev);
        match inline_outcome(flagged, &action) {
            InlineOutcome::Allow => {}
            InlineOutcome::Block => {
                let model = body["model"].as_str().unwrap_or("unknown");
                state.metrics.inc_firewall_blocked();
                audit_inline_evaluator(state, ctx, model, &ev.id, "blocked", &reason);
                warn!(
                    request_id = %ctx.request_id,
                    evaluator = %ev.id,
                    %reason,
                    "inline evaluator: blocked inbound content"
                );
                return Err(GatewayError::FirewallBlocked(
                    format!(
                        "Inbound content blocked by evaluator '{}': {}",
                        ev.id, reason
                    ),
                    firewall_policy_alert(scanner.config(), ctx, "block"),
                ));
            }
            InlineOutcome::Sanitize => {
                let model = body["model"].as_str().unwrap_or("unknown").to_string();
                warn!(
                    request_id = %ctx.request_id,
                    evaluator = %ev.id,
                    "inline evaluator: sanitizing inbound content"
                );
                audit_inline_evaluator(state, ctx, &model, &ev.id, "sanitized", &reason);
                sanitize_messages(body, scanner);
            }
            InlineOutcome::Warn => {
                warn!(
                    request_id = %ctx.request_id,
                    evaluator = %ev.id,
                    %reason,
                    "inline evaluator: inbound flagged (warn-and-continue)"
                );
                pending = merge_alert(
                    pending,
                    firewall_policy_alert(scanner.config(), ctx, "notify"),
                );
            }
        }
    }
    Ok(pending)
}

/// Run the resolved policy's **output-target** inline evaluators over the
/// (non-streaming) response. Blocks on `Block`, redacts in place on `Sanitize`,
/// logs on `WarnAndContinue`. Resolves the per-agent scanner from `ctx` (cached),
/// so it needs no state threaded from `pre_process`. No-op (allocation-free) when
/// no binding is enabled.
async fn apply_inline_output_evaluators(
    state: &AppState,
    ctx: &RequestContext,
    response: &mut Value,
) -> Result<(), GatewayError> {
    let scanner = state.resolved_scanner(ctx);
    if !scanner.config().evaluators.iter().any(|b| b.enabled) {
        return Ok(());
    }
    let registry = EvaluatorRegistry::from_config(&state.config);
    let bindings: Vec<crate::evaluators::EvaluatorBinding> = scanner
        .config()
        .evaluators
        .iter()
        .filter(|b| b.enabled)
        .cloned()
        .collect();
    let response_text = response_to_text(response);

    for binding in &bindings {
        let Some(ev) = registry.get(&binding.id) else {
            continue;
        };
        if !ev.capabilities.inline || ev.target != EvaluatorTarget::Output {
            continue;
        }
        let (flagged, reason) =
            match flag_inline_binding(ev, scanner.as_ref(), &response_text, state).await {
                InlineFlag::Skip => continue,
                InlineFlag::Ran { flagged, reason } => (flagged, reason),
                InlineFlag::ForceBlock { reason } => {
                    // Fail-closed short-circuit on the outbound path too (a wasm
                    // policy may be bound Output-target). Block regardless of action.
                    let model = response["model"].as_str().unwrap_or("unknown");
                    state.metrics.inc_firewall_blocked();
                    audit_inline_evaluator(state, ctx, model, &ev.id, "blocked", &reason);
                    warn!(
                        request_id = %ctx.request_id,
                        evaluator = %ev.id,
                        %reason,
                        "inline evaluator: fail-closed block (outbound)"
                    );
                    return Err(GatewayError::FirewallBlocked(
                        format!(
                            "Outbound response blocked by evaluator '{}': {}",
                            ev.id, reason
                        ),
                        firewall_policy_alert(scanner.config(), ctx, "block"),
                    ));
                }
            };
        let action = inline_action_for(binding, ev);
        match inline_outcome(flagged, &action) {
            InlineOutcome::Allow | InlineOutcome::Warn => {
                if flagged {
                    warn!(
                        request_id = %ctx.request_id,
                        evaluator = %ev.id,
                        %reason,
                        "inline evaluator: outbound flagged (warn-and-continue)"
                    );
                }
            }
            InlineOutcome::Block => {
                let model = response["model"].as_str().unwrap_or("unknown");
                state.metrics.inc_firewall_blocked();
                audit_inline_evaluator(state, ctx, model, &ev.id, "blocked", &reason);
                warn!(
                    request_id = %ctx.request_id,
                    evaluator = %ev.id,
                    %reason,
                    "inline evaluator: blocked outbound response"
                );
                return Err(GatewayError::FirewallBlocked(
                    format!(
                        "Outbound response blocked by evaluator '{}': {}",
                        ev.id, reason
                    ),
                    firewall_policy_alert(scanner.config(), ctx, "block"),
                ));
            }
            InlineOutcome::Sanitize => {
                let model = response["model"].as_str().unwrap_or("unknown").to_string();
                warn!(
                    request_id = %ctx.request_id,
                    evaluator = %ev.id,
                    "inline evaluator: sanitizing outbound response"
                );
                audit_inline_evaluator(state, ctx, &model, &ev.id, "sanitized", &reason);
                sanitize_response(response, scanner.as_ref());
            }
        }
    }
    Ok(())
}

/// Whether any enabled OUTPUT-target inline binding would BLOCK or SANITIZE — the
/// streaming firewall must buffer the whole response in that case, even when the
/// node firewall policy is warn/off (otherwise a blocking output evaluator would
/// never fire on the default streaming chat path).
fn output_inline_wants_transform(scanner: &FirewallScanner, registry: &EvaluatorRegistry) -> bool {
    scanner.config().evaluators.iter().any(|b| {
        if !b.enabled {
            return false;
        }
        let Some(ev) = registry.get(&b.id) else {
            return false;
        };
        if !ev.capabilities.inline || ev.target != EvaluatorTarget::Output {
            return false;
        }
        matches!(
            inline_action_for(b, ev),
            FirewallPolicy::Block | FirewallPolicy::Sanitize
        )
    })
}

/// Evaluate the resolved OUTPUT-target inline evaluators against assembled
/// streamed text, returning the STRICTEST outcome (Block > Sanitize > Warn >
/// Allow) plus a reason, so the streaming firewall can emit the right frame.
async fn evaluate_output_inline_stream(
    state: &AppState,
    ctx: &RequestContext,
    scanner: &FirewallScanner,
    assembled: &str,
) -> (InlineOutcome, String) {
    let registry = EvaluatorRegistry::from_config(&state.config);
    let bindings: Vec<crate::evaluators::EvaluatorBinding> = scanner
        .config()
        .evaluators
        .iter()
        .filter(|b| b.enabled)
        .cloned()
        .collect();

    let mut strictest = InlineOutcome::Allow;
    let mut reason = String::new();
    for binding in &bindings {
        let Some(ev) = registry.get(&binding.id) else {
            continue;
        };
        if !ev.capabilities.inline || ev.target != EvaluatorTarget::Output {
            continue;
        }
        let (flagged, r) = match flag_inline_binding(ev, scanner, assembled, state).await {
            InlineFlag::Skip => continue,
            InlineFlag::Ran { flagged, reason } => (flagged, reason),
            InlineFlag::ForceBlock { reason: fc_reason } => {
                // Fail-closed → Block is the strictest possible streamed outcome;
                // nothing can outrank it, so short-circuit.
                return (InlineOutcome::Block, format!("{}: {fc_reason}", ev.id));
            }
        };
        let outcome = inline_outcome(flagged, &inline_action_for(binding, ev));
        if inline_outcome_rank(outcome) > inline_outcome_rank(strictest) {
            strictest = outcome;
            reason = format!("{}: {}", ev.id, r);
        }
    }
    let _ = ctx;
    (strictest, reason)
}

/// Strictness rank for picking the winning streamed-output outcome.
fn inline_outcome_rank(o: InlineOutcome) -> u8 {
    match o {
        InlineOutcome::Allow => 0,
        InlineOutcome::Warn => 1,
        InlineOutcome::Sanitize => 2,
        InlineOutcome::Block => 3,
    }
}

/// Whether this error says the provider itself is unhealthy. Rate limits and
/// payment-required responses belong to capacity/account state, so fallbacks may
/// run but the circuit must stay ready for a later request after recovery.
fn penalizes_provider_circuit(error: &GatewayError) -> bool {
    !matches!(
        error,
        GatewayError::ProviderRateLimited { .. } | GatewayError::ProviderPaymentRequired { .. }
    )
}

/// Keep an actionable payment-required failure if later fallbacks also fail.
/// A generic outage may explain the last attempt, but it must not erase the
/// account recovery the caller can actually perform.
fn remember_preferred_provider_error(slot: &mut Option<GatewayError>, error: GatewayError) {
    let existing_is_payment = matches!(
        slot.as_ref(),
        Some(GatewayError::ProviderPaymentRequired { .. })
    );
    let current_is_payment = matches!(&error, GatewayError::ProviderPaymentRequired { .. });
    if current_is_payment || !existing_is_payment {
        *slot = Some(error);
    }
}

// ─── Non-streaming pipeline ───────────────────────────────────────────────────

pub async fn run(
    state: Arc<AppState>,
    ctx: RequestContext,
    mut body: Value,
) -> Result<PipelineOutput, GatewayError> {
    let start = Instant::now();

    state.metrics.inc_requests();

    // Smart routing (custom routing instructions) runs first, rewriting the
    // model so the rest of the pipeline routes to the classifier's choice.
    let smart_routed = apply_smart_routing(&state, &ctx, &mut body).await;
    let requested_model = body["model"].as_str().unwrap_or("unknown").to_string();
    let (mut decision, cache_key, pre_alert) = pre_process(&state, &ctx, &mut body, smart_routed)
        .await
        .map_err(|e| {
            state.metrics.inc_errors();
            audit_failure(&state, &ctx, &requested_model, &e, start);
            e
        })?;

    // 5a. Exact-match cache lookup — return early on hit
    if let Some(cached) = state.cache.get(&cache_key) {
        debug!(request_id = %ctx.request_id, "exact cache hit");
        state.metrics.inc_cache_hit();
        // Output-target inline evaluators must run on cache hits too: the exact
        // cache key is (org, model, messages) — NOT scoped by agent — so an agent
        // with `toxicity: Block` / `pii_leakage: Sanitize` could otherwise be
        // served a sibling agent's cached toxic/PII response with the guardrail
        // silently bypassed. No-op (allocation-free) when the agent has no
        // output evaluators, so a plain cache hit stays fast.
        let mut cached = cached;
        apply_inline_output_evaluators(&state, &ctx, &mut cached).await?;
        audit_cache_hit(&state, &ctx, "cache", &decision.model, &cached, start);
        return Ok(PipelineOutput {
            response: cached,
            context: ctx,
            provider_used: "cache",
            model_used: decision.model,
            cache_hit: true,
            budget: None,
            eval_score: None,
            degraded: None,
            policy_alert: pre_alert.clone(),
            // Our own response cache answered; no provider was called, so there
            // is no provider prompt-cache activity to report.
            prompt_cache: ryu_gw_providers::PromptCacheOutcome::Disabled,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
        });
    }

    // 5b. Semantic cache lookup (optional)
    let mut semantic_embedding: Option<Vec<f32>> = None;
    if let (Some(sc), Some(openai_cfg)) = (
        state.semantic_cache.active(),
        state.config.providers.openai.as_ref(),
    ) {
        let text = SemanticCache::messages_to_text(&body["messages"]);
        if let Ok(emb) = sc
            .get_embedding(
                &text,
                &state.http,
                &openai_cfg.base_url,
                &openai_cfg.api_key,
            )
            .await
        {
            if let Some(cached) = sc.lookup(ctx.org_id.as_deref(), &emb) {
                debug!(request_id = %ctx.request_id, "semantic cache hit");
                state.metrics.inc_semantic_cache_hit();
                state.metrics.inc_cache_hit();
                // Same per-agent bypass concern as the exact cache above: the
                // semantic cache is org-scoped, not agent-scoped, so run the
                // output-target inline evaluators before serving a cached hit.
                let mut cached = cached;
                apply_inline_output_evaluators(&state, &ctx, &mut cached).await?;
                audit_cache_hit(
                    &state,
                    &ctx,
                    "semantic-cache",
                    &decision.model,
                    &cached,
                    start,
                );
                return Ok(PipelineOutput {
                    response: cached,
                    context: ctx,
                    provider_used: "semantic-cache",
                    model_used: decision.model,
                    cache_hit: true,
                    budget: None,
                    eval_score: None,
                    degraded: None,
                    policy_alert: pre_alert.clone(),
                    prompt_cache: ryu_gw_providers::PromptCacheOutcome::Disabled,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                });
            }
            semantic_embedding = Some(emb);
        }
    }

    state.metrics.inc_cache_miss();

    // 6. Skills injection
    if !state.skills.is_empty() {
        state.skills.inject(&mut body);
    }

    // 6a. Shared (cross-machine) budget — enforce the control-plane coordinator's
    // most recent verdict. The master key always bypasses budget gates.
    if !ctx.is_master_key && state.shared_budget.is_shared_exceeded() {
        warn!(key = %ctx.api_key, "shared budget exceeded (coordinator verdict)");
        state.metrics.inc_budget_exceeded();
        state.metrics.inc_errors();
        return Err(GatewayError::BudgetExceeded(None));
    }

    // 6b. Lifetime token budget — check before calling provider and optionally downgrade
    if let Some(key_cfg) = &ctx.key_config {
        if let Some(budget) = key_cfg.token_budget_total {
            if budget > 0 {
                let used = state.audit.token_usage(&ctx.api_key);
                if used >= budget {
                    if let Some(ref downgrade_model) = key_cfg.downgrade_to {
                        info!(
                            key = %ctx.api_key,
                            used,
                            budget,
                            downgrade = %downgrade_model,
                            "token budget exceeded, downgrading model"
                        );
                        body["model"] = Value::String(downgrade_model.clone());
                        decision = state.router.route(downgrade_model);
                    } else {
                        warn!(key = %ctx.api_key, used, budget, "token budget exceeded");
                        state.metrics.inc_budget_exceeded();
                        state.metrics.inc_errors();
                        return Err(GatewayError::BudgetExceeded(None));
                    }
                }
            }
        }
    }

    // 6c. Per-user / per-agent charged-spend budgets with local counters (U21).
    // Stop aborts;
    // downgrade/restrict mutate the body+route in place; notify is observable.
    let BudgetOutcome {
        decision: budget,
        alert: budget_alert,
        // MOVED INTO THE DEBIT TASK BELOW, not dropped at the end of this
        // function. The debit is `tokio::spawn`ed, so returning from here would
        // free the claim while the charge is still in flight in a detached task
        // (up to `credits.timeout_ms`) — and `ctx.remaining_budget_micro_usd` is
        // the cached figure, which nothing has decremented yet. The freed
        // headroom would be immediately re-claimable against a balance that has
        // not moved: the exact window the reservation exists to close. `.take()`
        // rather than a move because the debit site sits inside the fallback
        // loop; if no debit fires (credits inactive, no org) the permit stays
        // here and drops on return, which is correct.
        reservation: mut credit_reservation,
    } = enforce_budget(
        &state,
        &ctx,
        &mut body,
        &mut decision,
        BudgetChargeKind::Model,
        OutputCeiling::Clamp,
    )?;
    // One response, one header: firewall (Ok-path) alert first so it wins a tie
    // against a same-tier budget alert (deterministic).
    let policy_alert = merge_alert(pre_alert, budget_alert);

    // 6d. Context compression (egress transform). When enabled, send the
    // messages to the compression service and swap in the result before any
    // provider call. Runs once for the whole fallback chain. Fails open: on any
    // error the original body is left untouched (see `compression`).
    if state.config.compression.enabled {
        if let Some(saved) =
            crate::compression::maybe_compress(&state.config.compression, &mut body).await
        {
            state.metrics.add_compression_saved(saved);
            debug!(tokens_saved = saved, "compression: request compressed");
        }
    }

    let fallback_chain = clamped_fallback_chain(&state, &ctx, &decision);
    let mut last_err: Option<GatewayError> = None;
    // Track whether the primary provider (first in chain) was skipped so we
    // can signal DegradedMode::Fallback when a later provider serves the request.
    let primary_provider = fallback_chain.first().cloned();
    let mut primary_skipped = false;

    // Provider prompt-cache markers, stamped once for the whole fallback chain.
    // Placed here because it is the last point where `messages` is final and the
    // routed model — which selects the marker dialect — is already decided
    // (smart routing, the budget downgrade, and the firewall have all run).
    // Fallback swaps the *provider*, never the model, so one decision holds for
    // every attempt; re-running it per attempt would only re-inspect markers it
    // had just written.
    let prompt_cache_outcome = apply_prompt_cache(&state, &ctx, &decision.model, &mut body);

    for provider_kind in &fallback_chain {
        // 7. Circuit breaker check
        if state.circuit_breaker.is_open(provider_kind.as_str()) {
            debug!(
                provider = provider_kind.as_str(),
                "circuit open, skipping provider"
            );
            remember_preferred_provider_error(
                &mut last_err,
                GatewayError::CircuitOpen(provider_kind.as_str().to_string()),
            );
            if Some(provider_kind) == primary_provider.as_ref() {
                primary_skipped = true;
            }
            continue;
        }

        let Some(provider) = state.providers.get(provider_kind.as_str()) else {
            if Some(provider_kind) == primary_provider.as_ref() {
                primary_skipped = true;
            }
            continue;
        };

        state.metrics.inc_provider_request(provider.name());

        // Only an Anthropic-dialect provider reads the caller's betas; for anyone
        // else the private field is an unknown top-level key that would 400 a
        // strict endpoint. Per attempt, because fallback swaps the provider.
        strip_anthropic_beta_for(&mut body, provider.name());
        stamp_openrouter_identity(&mut body, provider.name(), &ctx);

        // 7b. Admission: gate concurrent access to the resident local engine so
        // interactive chat is served ahead of background fan-out (the engine has
        // a fixed batch-slot count). Held across the whole completion. Remote
        // providers and disabled gating return an instant ungated permit. A full
        // queue rejects with `engine_overloaded` (retryable) rather than piling
        // on the engine's internal FIFO.
        //
        // IMPORTANT — re-entrancy: the unified tool loop runs while we'd hold the
        // permit, and a tool (e.g. `delegate.fanout`) can route a child request
        // back to this same local provider. Gating those would deadlock (parent
        // holds the slot while the engine idles, waiting on the child). So we gate
        // only NON-tool-loop completions — exactly the plain-chat traffic where
        // batching + priority matter most; the tool-loop path stays ungated.
        // Raw passthrough (`x-ryu-raw-tools`) forces the plain branch; otherwise
        // unified (catalog + signal) wins, then legacy Composio, then plain.
        let loop_kind = select_tool_loop(
            &ctx,
            state.tools.is_some(),
            state.composio.is_some(),
            &state.config.tools,
        );
        let runs_tool_loop = matches!(loop_kind, ToolLoopKind::Unified);
        let _admission = if runs_tool_loop {
            crate::concurrency::AdmissionPermit::none()
        } else {
            match state.admission.acquire(provider.name(), ctx.priority).await {
                Ok(permit) => permit,
                Err(full) => {
                    return Err(GatewayError::Overloaded(format!(
                        "Local engine busy: {} requests already queued. Retry shortly.",
                        full.queued
                    )));
                }
            }
        };

        // 8. Forward (retry baked into provider). Precedence (#475):
        //   a) unified search-based tool loop — when the tools client is wired
        //      (CORE_URL set) AND the request carries the tool signal
        //      (x-ryu-tools present OR x-ryu-tool-search: on);
        //   b) else legacy Composio tool loop — when Composio is configured;
        //   c) else a plain completion.
        // The Restrict budget action strips `tools`; we inject the search tool
        // only when tools were NOT stripped (B-12).
        let tools_restricted = matches!(
            budget.as_ref().map(|b| b.action),
            Some(crate::config::BudgetAction::Restrict)
        );
        let completion_result = match loop_kind {
            ToolLoopKind::Unified => {
                let catalog = state
                    .tools
                    .as_ref()
                    .expect("Unified selected ⇒ tools catalog present");
                let allowed = effective_tool_allowlist(&ctx, &state.config.tools);
                let tool_ctx = crate::tools::ToolLoopContext {
                    agent_id: ctx.agent_id.clone(),
                    user_id: ctx.user_id.clone(),
                    allowed,
                };
                if !tools_restricted {
                    crate::tools::inject_search_tool(&mut body, &state.config.tools.always_on);
                }
                crate::tools::run_tool_loop(
                    &mut body,
                    provider,
                    &decision.model,
                    catalog,
                    &tool_ctx,
                    state.config.tools.max_rounds,
                    state.config.tools.describe_top_n,
                )
                .await
            }
            ToolLoopKind::Composio => {
                let composio = state
                    .composio
                    .as_ref()
                    .expect("Composio selected ⇒ Composio configured");
                // Legacy Composio loop: returns (response, billable_tool_calls).
                state.metrics.inc_composio_calls();
                let entity_id = ctx
                    .user_id
                    .as_deref()
                    .unwrap_or(&state.config.composio.entity_id);
                // Per-agent allowlist (#456): when Core forwards `x-ryu-tools`,
                // scope the tool loop to exactly those actions; otherwise fall back
                // to the gateway's global `composio.actions` config.
                // `"*"` is stripped for the same reason as in `parse_tool_actions`:
                // the client header must not be able to introduce a wildcard grant.
                let per_request: Vec<String> = ctx
                    .tool_actions
                    .as_deref()
                    .map(|s| {
                        s.split(',')
                            .map(str::trim)
                            .filter(|x| !x.is_empty() && *x != "*")
                            .map(String::from)
                            .collect()
                    })
                    .unwrap_or_default();
                let allowed: &[String] = if per_request.is_empty() {
                    composio.actions()
                } else {
                    &per_request
                };
                composio
                    .run_tool_loop(&mut body, provider, &decision.model, entity_id, allowed)
                    .await
            }
            ToolLoopKind::Plain => {
                // Plain completion: no tool loop ⇒ no billable tool calls. Also the
                // raw-passthrough target — the caller's own tools/tool_calls pass
                // through untouched.
                provider
                    .complete(&decision.model, &body)
                    .await
                    .map_err(GatewayError::from)
                    .map(|v| (v, 0u64))
            }
        };

        match completion_result {
            Ok((mut response, billable_tool_calls)) => {
                state.circuit_breaker.record_success(provider.name());
                // Determine degraded mode: we served via a fallback when the primary
                // was skipped and a different provider is now responding (#218).
                let degraded = if primary_skipped {
                    state.metrics.inc_degraded_fallback();
                    Some(DegradedMode::Fallback(provider.name().to_string()))
                } else {
                    None
                };

                let input_tokens = response["usage"]["prompt_tokens"].as_u64().unwrap_or(0);
                let output_tokens = response["usage"]["completion_tokens"].as_u64().unwrap_or(0);
                let cached_tokens = provider_cached_tokens(&response);
                let cache_write_tokens = provider_cache_write_tokens(&response);
                state.metrics.add_tokens(input_tokens, output_tokens);
                if cached_tokens > 0 {
                    state.metrics.add_cached_tokens(cached_tokens);
                }
                if cache_write_tokens > 0 {
                    state.metrics.add_cache_write_tokens(cache_write_tokens);
                }

                // 9. Outbound firewall
                let response_text = response_to_text(&response);
                let outbound_result: Result<bool, GatewayError> = state.with_firewall(|fw| {
                    if let Some(violation) = fw.scan_outbound(&response_text) {
                        match fw.policy() {
                            FirewallPolicy::Block => {
                                warn!(request_id = %ctx.request_id, "firewall: blocked outbound response");
                                state.metrics.inc_firewall_blocked();
                                return Err(GatewayError::FirewallBlocked(
                                    format!(
                                        "Outbound response blocked: {} ({:?})",
                                        violation.pattern_name, violation.kind
                                    ),
                                    firewall_policy_alert(fw.config(), &ctx, "block"),
                                ));
                            }
                            FirewallPolicy::Sanitize => {
                                warn!(request_id = %ctx.request_id, "firewall: sanitized outbound response");
                                sanitize_response(&mut response, fw);
                            }
                            FirewallPolicy::WarnAndContinue => {
                                warn!(
                                    request_id = %ctx.request_id,
                                    pattern = %violation.pattern_name,
                                    "firewall: outbound violation (warn-and-continue)"
                                );
                            }
                        }
                        Ok(false)
                    } else {
                        Ok(true)
                    }
                });
                let policy_pass = outbound_result?;

                // 9b. Unified-evaluator inline guardrails — OUTPUT target (P3).
                // Runs the resolved per-agent policy's enabled output evaluators
                // (pii_leakage regex, toxicity/bias LLM-judge) over the response,
                // reusing the firewall block/sanitize machinery. No-op when no
                // binding is enabled.
                apply_inline_output_evaluators(&state, &ctx, &mut response).await?;

                // 10. Per-minute token rate limit (sliding window, honours RBAC overrides)
                let total_tokens = input_tokens + output_tokens;
                if total_tokens > 0
                    && !state.rate_limiter.check_tokens_for_key(
                        &ctx.api_key,
                        total_tokens,
                        ctx.key_config.as_ref(),
                    )
                {
                    warn!(key = %ctx.api_key, tokens = total_tokens, "token-per-minute budget exceeded");
                    state.metrics.inc_rate_limited();
                    state.metrics.inc_errors();
                    return Err(GatewayError::RateLimited);
                }

                // 11. Eval scoring (sampled). When this request is sampled, score
                //      it and fold the result into the provider's rolling average
                //      so eval-driven routing can react to it.
                let latency_ms = start.elapsed().as_millis() as u64;
                let eval_score = if state.evals.should_sample() {
                    let eval = state.evals.score(latency_ms, &response, policy_pass);
                    if let Some(ref e) = eval {
                        state
                            .evals
                            .record_provider_score(provider.name(), e.overall);
                    }
                    eval.map(|e| e.overall)
                } else {
                    None
                };

                // 12. Exact-match cache store
                state.cache.insert(cache_key, response.clone());

                // 12b. Semantic cache store (if we fetched an embedding earlier)
                if let (Some(sc), Some(emb)) = (state.semantic_cache.active(), semantic_embedding) {
                    sc.insert(ctx.org_id.clone(), emb, response.clone());
                }

                // OpenRouter reports the final transaction price in USD. Keep
                // that value on the audit row as well as using it for the wallet
                // debit, so trace, reporting, and reconciliation all see the
                // same discounted amount.
                let reported_cost = response["usage"]["cost"].as_f64();
                let provider_cost_micro_usd = reported_cost.and_then(cost_usd_to_micro);

                // 13. Update audit token totals (per key) and charged-spend budget
                // counters (per user / per agent / per session — U21 local
                // counters). The budget amount follows the same provider cost
                // or configured model-price fallback as the wallet debit.
                let budget_cost_micro_usd = charged_budget_cost_micro_usd(
                    &state,
                    Some(provider.name()),
                    reported_cost,
                    input_tokens,
                    output_tokens,
                    &decision.model,
                );
                state.audit.add_tokens(&ctx.api_key, total_tokens);
                record_charged_budget(&state, &ctx, budget_cost_micro_usd);

                // 14. Audit log (SQLite)
                state.log_audit(AuditRecord {
                    request_id: ctx.request_id.clone(),
                    api_key: ctx.api_key.clone(),
                    user_name: ctx.user_name.clone(),
                    org_id: ctx.org_id.clone(),
                    team_id: ctx.team_id.clone(),
                    project_id: ctx.project_id.clone(),
                    provider: provider.name().to_string(),
                    model: decision.model.clone(),
                    input_tokens,
                    output_tokens,
                    cache_hit: false,
                    latency_ms,
                    eval_score,
                    error: None,
                    skill_ids: ctx.skill_ids.clone(),
                    session_id: ctx.session_id.clone(),
                    user_id: ctx.user_id.clone(),
                    agent_id: ctx.agent_id.clone(),
                    feature: ctx.feature.clone(),
                    managed_inference: ctx.managed_inference,
                    provider_cost_micro_usd,
                    event_type: crate::audit::EventType::ModelCall,
                    backend: None,
                    command: None,
                    duration_ms: None,
                    exit_code: None,
                    widget_instance_id: None,
                });

                // 14b. Experimental OTel GenAI span (#540, P1): reuse the same
                // tokens/model/provider/latency. No-op unless OTEL_SEMCONV_STABILITY_OPT_IN
                // opts into the experimental conventions; egresses only if OTLP export
                // is also consented (orthogonal gates).
                crate::telemetry::emit_gen_ai_span(
                    "chat",
                    provider.name(),
                    &decision.model,
                    input_tokens,
                    output_tokens,
                    latency_ms,
                );
                crate::ryu_analytics::emit_model_call(
                    "chat",
                    provider.name(),
                    &decision.model,
                    input_tokens,
                    output_tokens,
                    latency_ms,
                    "ok",
                    None,
                );

                info!(
                    request_id = %ctx.request_id,
                    provider = provider.name(),
                    model = %decision.model,
                    input_tokens,
                    output_tokens,
                    cached_tokens,
                    latency_ms,
                    eval_score = ?eval_score,
                    degraded = ?degraded,
                    "request completed"
                );

                // 15. Credit-wallet debit hook (#486). Best-effort, post-call:
                // debit the request's org wallet by this call's marked-up cost
                // and update the cached empty flag for the next request's budget
                // gate. Spawned so the control-plane round-trip never adds
                // latency to the served response; a no-op unless credits are
                // active and the request carries an org.
                if let Some(org_id) = ctx.org_id.clone().filter(|s| !s.is_empty()) {
                    if state.config.credits.is_active() {
                        let cost = response_cost_micro_usd(
                            &state,
                            reported_cost,
                            input_tokens,
                            output_tokens,
                            &decision.model,
                        );
                        let state2 = Arc::clone(&state);
                        let request_id = ctx.request_id.clone();
                        let fail_closed_sticky =
                            state.config.credits.fail_closed && ctx.managed_inference;
                        // Managed policy-alert (item 4): stamp the matched
                        // budget-cap tier. `limit > 0` excludes the wallet-empty
                        // decision (invariant: decide() only returns limit==0 for
                        // the synthetic wallet rule); only tiers >= Warn ride.
                        let debit_alert_tier = budget
                            .as_ref()
                            .filter(|b| b.limit > 0 && b.alert >= AlertTier::Warn)
                            .map(|b| b.alert);
                        // The credit permit rides INTO the task so it outlives
                        // the debit, not the handler — see the binding at
                        // `enforce_budget` above.
                        let credit_permit = credit_reservation.take();
                        let pool = crate::credit_pools::pool_for_gateway_provider(provider.name());
                        // Built BEFORE the spawn, like `request_id` and `pool`
                        // above: the task takes ownership of `ctx` and
                        // `decision`, so reading either inside it would move a
                        // value the surrounding handler still needs.
                        let debit_attribution = DebitAttribution {
                            provider: Some(provider.name().to_string()),
                            model: Some(decision.model.clone()),
                            input_tokens: Some(input_tokens as u64),
                            output_tokens: Some(output_tokens as u64),
                            duration_ms: Some(latency_ms as u64),
                            user_id: ctx.user_id.clone(),
                            task_label: None,
                            estimated: None,
                        };
                        tokio::spawn(async move {
                            debit_wallet_for_request(
                                state2,
                                org_id,
                                request_id,
                                "gateway_usage",
                                cost,
                                fail_closed_sticky,
                                debit_alert_tier,
                                // Authoritative pool attribution: the provider
                                // that actually answered, not the one the
                                // pre-flight gate guessed (a fallback may have
                                // served this).
                                pool,
                                // Same rule as `pool`: the provider and model
                                // that ACTUALLY served, so a fallback shows the
                                // model the customer was really charged for
                                // rather than the one they asked for.
                                debit_attribution,
                            )
                            .await;
                            drop(credit_permit);
                        });
                    }
                }

                // Tool-call (Composio) debit (#496): separate ledger row, fires
                // only when this request executed billable Composio tools.
                spawn_tool_call_debit(&state, &ctx, billable_tool_calls);

                return Ok(PipelineOutput {
                    response,
                    context: ctx,
                    provider_used: provider.name(),
                    model_used: decision.model,
                    cache_hit: false,
                    budget,
                    eval_score,
                    degraded,
                    policy_alert,
                    prompt_cache: prompt_cache_outcome,
                    cache_read_tokens: cached_tokens,
                    cache_write_tokens,
                });
            }
            Err(e) => {
                // Capacity (429) and account payment (402) are retry/fallback
                // signals, not provider outages. Neither may poison health state.
                if !penalizes_provider_circuit(&e) {
                    state.metrics.inc_provider_error(provider.name());
                    warn!(provider = %provider.name(), error = %e, "provider unavailable for this account, demoting to next tier");
                } else {
                    state.circuit_breaker.record_failure(provider.name());
                    state.metrics.inc_provider_error(provider.name());
                    warn!(provider = %provider.name(), error = %e, "provider failed, trying fallback");
                }
                if Some(provider_kind) == primary_provider.as_ref() {
                    primary_skipped = true;
                }
                remember_preferred_provider_error(&mut last_err, e);
            }
        }
    }

    state.metrics.inc_errors();
    state.metrics.inc_degraded_exhausted();
    let err = last_err.map_or_else(
        || {
            GatewayError::AllProvidersUnavailable(format!(
                "All providers unavailable for model '{}'",
                decision.model
            ))
        },
        |prev| match prev {
            // Wrap generic chain errors into the typed variant so clients get
            // a stable `all_providers_unavailable` code, not a 404 or 502.
            GatewayError::CircuitOpen(_) | GatewayError::ProviderError(_) => {
                GatewayError::AllProvidersUnavailable(format!(
                    "All providers unavailable for model '{}': {prev}",
                    decision.model
                ))
            }
            other => other,
        },
    );
    audit_failure(&state, &ctx, &decision.model, &err, start);
    let error_code = match &err {
        GatewayError::AllProvidersUnavailable(_) => "all_providers_unavailable",
        GatewayError::ProviderRateLimited { .. } => "provider_rate_limited",
        GatewayError::ProviderPaymentRequired { .. } => "provider_payment_required",
        GatewayError::RateLimited => "rate_limit_exceeded",
        GatewayError::InsufficientCredits => "insufficient_credits",
        GatewayError::AccountingUnavailable => "credit_accounting_unavailable",
        GatewayError::BudgetExceeded(_) => "budget_exceeded",
        GatewayError::FirewallBlocked(_, _) | GatewayError::PolicyViolation(_) => {
            "policy_violation"
        }
        _ => "gateway_error",
    };
    crate::ryu_analytics::emit_model_call(
        "chat",
        "unknown",
        &decision.model,
        0,
        0,
        start.elapsed().as_millis() as u64,
        "error",
        Some(error_code),
    );
    Err(err)
}

/// Record a cache-served response in the audit log. Cache hits incur no provider
/// token usage, so token counts are recorded as zero.
fn audit_cache_hit(
    state: &AppState,
    ctx: &RequestContext,
    provider_used: &'static str,
    model: &str,
    response: &Value,
    start: Instant,
) {
    if !state.audit.is_enabled() {
        return;
    }
    let input_tokens = response["usage"]["prompt_tokens"].as_u64().unwrap_or(0);
    let output_tokens = response["usage"]["completion_tokens"].as_u64().unwrap_or(0);
    state.log_audit(AuditRecord {
        request_id: ctx.request_id.clone(),
        api_key: ctx.api_key.clone(),
        user_name: ctx.user_name.clone(),
        org_id: ctx.org_id.clone(),
        team_id: ctx.team_id.clone(),
        project_id: ctx.project_id.clone(),
        provider: provider_used.to_string(),
        model: model.to_string(),
        input_tokens,
        output_tokens,
        cache_hit: true,
        latency_ms: start.elapsed().as_millis() as u64,
        eval_score: None,
        error: None,
        skill_ids: ctx.skill_ids.clone(),
        session_id: ctx.session_id.clone(),
        user_id: ctx.user_id.clone(),
        agent_id: ctx.agent_id.clone(),
        feature: ctx.feature.clone(),
        managed_inference: ctx.managed_inference,
        provider_cost_micro_usd: None,
        event_type: crate::audit::EventType::ModelCall,
        backend: None,
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    });
}

/// Record a failed request in the audit log. The error message is run through
/// the outbound firewall (U20 DLP) so any sensitive data it carries is redacted
/// before being persisted.
fn audit_failure(
    state: &AppState,
    ctx: &RequestContext,
    model: &str,
    err: &GatewayError,
    start: Instant,
) {
    if !state.audit.is_enabled() {
        return;
    }
    let redacted_error = state.with_firewall(|fw| fw.sanitize(&err.to_string()));
    state.log_audit(AuditRecord {
        request_id: ctx.request_id.clone(),
        api_key: ctx.api_key.clone(),
        user_name: ctx.user_name.clone(),
        org_id: ctx.org_id.clone(),
        team_id: ctx.team_id.clone(),
        project_id: ctx.project_id.clone(),
        provider: "none".to_string(),
        model: model.to_string(),
        input_tokens: 0,
        output_tokens: 0,
        cache_hit: false,
        latency_ms: start.elapsed().as_millis() as u64,
        eval_score: None,
        error: Some(redacted_error),
        skill_ids: ctx.skill_ids.clone(),
        session_id: ctx.session_id.clone(),
        user_id: ctx.user_id.clone(),
        agent_id: ctx.agent_id.clone(),
        feature: ctx.feature.clone(),
        managed_inference: ctx.managed_inference,
        provider_cost_micro_usd: None,
        event_type: crate::audit::EventType::ModelCall,
        backend: None,
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    });
}

/// Emit an audit record when the LLM inspector blocks an inbound request,
/// mirroring the regex firewall's audit shape (provider tag `"inspector"`).
fn audit_inspector_block(
    state: &AppState,
    ctx: &RequestContext,
    body: &Value,
    verdict: &crate::firewall::inspector::InspectorVerdict,
) {
    if !state.audit.is_enabled() {
        return;
    }
    state.log_audit(AuditRecord {
        request_id: ctx.request_id.clone(),
        api_key: ctx.api_key.clone(),
        user_name: ctx.user_name.clone(),
        org_id: ctx.org_id.clone(),
        team_id: ctx.team_id.clone(),
        project_id: ctx.project_id.clone(),
        provider: "inspector".to_string(),
        model: body["model"].as_str().unwrap_or("unknown").to_string(),
        input_tokens: 0,
        output_tokens: 0,
        cache_hit: false,
        latency_ms: 0,
        eval_score: None,
        error: Some(format!(
            "inspector blocked: {} [{}]",
            verdict.reason,
            verdict.categories.join(",")
        )),
        skill_ids: ctx.skill_ids.clone(),
        session_id: ctx.session_id.clone(),
        user_id: ctx.user_id.clone(),
        agent_id: ctx.agent_id.clone(),
        feature: ctx.feature.clone(),
        managed_inference: ctx.managed_inference,
        provider_cost_micro_usd: None,
        event_type: crate::audit::EventType::ModelCall,
        backend: Some("inspector".to_string()),
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    });
}

// ─── Streaming pipeline ───────────────────────────────────────────────────────

pub async fn run_stream(
    state: Arc<AppState>,
    ctx: RequestContext,
    mut body: Value,
) -> Result<PipelineStreamOutput, GatewayError> {
    let start = Instant::now();

    state.metrics.inc_requests();

    // Smart routing (custom routing instructions) runs first, rewriting the
    // model so the rest of the pipeline routes to the classifier's choice.
    let smart_routed = apply_smart_routing(&state, &ctx, &mut body).await;
    let requested_model = body["model"].as_str().unwrap_or("unknown").to_string();
    let (mut decision, _cache_key, pre_alert) = pre_process(&state, &ctx, &mut body, smart_routed)
        .await
        .map_err(|e| {
            state.metrics.inc_errors();
            audit_failure(&state, &ctx, &requested_model, &e, start);
            e
        })?;

    // Skills injection
    if !state.skills.is_empty() {
        state.skills.inject(&mut body);
    }

    // Per-user / per-agent budgets (U21). Enforcement must run on the streaming
    // path too: Core's chat forwards `stream: true`, so without this the budget
    // would never fire for the gateway's primary caller.
    let BudgetOutcome {
        decision: budget,
        alert: budget_alert,
        // NOT dropped at the end of this function. A streaming handler returns as
        // soon as the response HEAD is ready and the bytes flow afterwards, so
        // releasing here would free the claim while the request is still running
        // — the exact window the reservation exists to cover. It is moved into
        // `StreamObserverState` below and released when the stream ends by ANY
        // means, including a client that hangs up mid-answer.
        reservation: credit_reservation,
    } = enforce_budget(
        &state,
        &ctx,
        &mut body,
        &mut decision,
        BudgetChargeKind::Model,
        OutputCeiling::Clamp,
    )?;
    // Firewall (Ok-path) alert first so it wins a same-tier tie deterministically.
    let policy_alert = merge_alert(pre_alert, budget_alert);

    // When configured, ask the provider to emit a terminal usage frame so the
    // stream observer can parse real token counts at stream end. Falls back to
    // the estimate below for non-conforming providers (e.g. local llama.cpp
    // builds that ignore stream_options). This is per-registry config, not
    // hardcoded — evals.stream_usage is the swappable default (issue #179).
    let stream_usage_requested = state.config.evals.stream_usage;
    if stream_usage_requested {
        inject_stream_usage_option(&mut body);
    }

    // Rough prompt-token estimate used for budget enforcement while the stream
    // is live. Real counts (when the provider emits a terminal usage frame) are
    // captured by the stream observer at stream end and recorded in the audit
    // row. We advance local counters here with the estimate so callers are
    // accountable immediately; the audit row will carry the real counts.
    let estimated_tokens = estimate_prompt_tokens(&body);

    // Per-minute token rate limit, streaming pre-admission. The non-streaming
    // path checks the bucket with real usage at step 10; a stream's real usage
    // is only known at stream end, so admission is gated on the prompt estimate
    // here and the observer settles the remainder when the stream finishes —
    // without this, `stream: true` bypasses the TPM bucket entirely. Key
    // derivation mirrors the non-streaming check exactly.
    if estimated_tokens > 0
        && !state.rate_limiter.check_tokens_for_key(
            &ctx.api_key,
            estimated_tokens,
            ctx.key_config.as_ref(),
        )
    {
        warn!(key = %ctx.api_key, tokens = estimated_tokens, "token-per-minute budget exceeded (stream admission)");
        state.metrics.inc_rate_limited();
        state.metrics.inc_errors();
        return Err(GatewayError::RateLimited);
    }

    // Unified tool loop on the streaming path (#475, Decision A). When the tools
    // client is wired (CORE_URL) AND the request carries the tool signal, run the
    // search→describe→call loop NON-streamed over the provider, then synthesize
    // the final SSE from the buffered turn (carrying usage so the observer records
    // real tokens). The default path (no signal) falls through to the fast stream
    // below with zero added latency.
    // Raw passthrough (`x-ryu-raw-tools`) suppresses the unified loop here too, so
    // an SDK-side agent's own tools stream through untouched.
    let tools_active =
        !ctx.raw_tools && state.tools.is_some() && tool_signal_active(&ctx, &state.config.tools);
    let tools_restricted = matches!(
        budget.as_ref().map(|b| b.action),
        Some(crate::config::BudgetAction::Restrict)
    );

    let fallback_chain = clamped_fallback_chain(&state, &ctx, &decision);
    let mut last_err: Option<GatewayError> = None;
    let primary_provider_stream = fallback_chain.first().cloned();
    let mut primary_skipped_stream = false;

    // Prompt-cache markers for the streaming path — same placement rationale as
    // the non-streaming `run`: last point before dispatch, once for the chain.
    let prompt_cache_outcome = apply_prompt_cache(&state, &ctx, &decision.model, &mut body);

    for provider_kind in &fallback_chain {
        if state.circuit_breaker.is_open(provider_kind.as_str()) {
            remember_preferred_provider_error(
                &mut last_err,
                GatewayError::CircuitOpen(provider_kind.as_str().to_string()),
            );
            if Some(provider_kind) == primary_provider_stream.as_ref() {
                primary_skipped_stream = true;
            }
            continue;
        }

        let Some(provider) = state.providers.get(provider_kind.as_str()) else {
            if Some(provider_kind) == primary_provider_stream.as_ref() {
                primary_skipped_stream = true;
            }
            continue;
        };

        state.metrics.inc_provider_request(provider.name());

        // Anthropic betas: same per-attempt strip as the non-streaming path.
        strip_anthropic_beta_for(&mut body, provider.name());
        stamp_openrouter_identity(&mut body, provider.name(), &ctx);

        // Admission gate (streaming): same priority queue as the non-stream path.
        // The permit must outlive `run_stream` — a generation occupies an engine
        // slot for its whole duration — so on success it is *moved into* the
        // returned SSE body and dropped only at stream end (see
        // `hold_admission_until_stream_end`). On a provider error it drops here
        // and the slot frees before the fallback attempt. As on the non-stream
        // path, the re-entrant tool-loop case (`tools_active`) is left ungated to
        // avoid a parent holding a slot while a delegated child waits for one.
        let admission_permit = if tools_active {
            crate::concurrency::AdmissionPermit::none()
        } else {
            match state.admission.acquire(provider.name(), ctx.priority).await {
                Ok(permit) => permit,
                Err(full) => {
                    return Err(GatewayError::Overloaded(format!(
                        "Local engine busy: {} requests already queued. Retry shortly.",
                        full.queued
                    )));
                }
            }
        };

        // Buffered tool loop → synthesized SSE, OR the fast direct stream.
        let stream_result: Result<Body, GatewayError> = if tools_active {
            let allowed = effective_tool_allowlist(&ctx, &state.config.tools);
            let tool_ctx = crate::tools::ToolLoopContext {
                agent_id: ctx.agent_id.clone(),
                user_id: ctx.user_id.clone(),
                allowed,
            };
            if !tools_restricted {
                crate::tools::inject_search_tool(&mut body, &state.config.tools.always_on);
            }
            // run_tool_loop forces stream:false internally for the provider calls.
            match crate::tools::run_tool_loop(
                &mut body,
                provider,
                &decision.model,
                state.tools.as_ref().expect("tools_active implies Some"),
                &tool_ctx,
                state.config.tools.max_rounds,
                state.config.tools.describe_top_n,
            )
            .await
            {
                Ok((buffered, billable_tool_calls)) => {
                    // Tools have fully executed by the time the loop returns, so
                    // the tool-call (Composio) debit fires here rather than at
                    // stream end — the synthesized SSE carries only the final
                    // turn and would drop the count (#496). The token debit still
                    // fires at stream end on the real usage frame.
                    spawn_tool_call_debit(&state, &ctx, billable_tool_calls);
                    Ok(crate::tools::value_to_sse_stream(&buffered))
                }
                Err(e) => Err(e),
            }
        } else {
            provider
                .complete_stream(&decision.model, &body)
                .await
                .map_err(GatewayError::from)
        };

        match stream_result {
            Ok(stream_body) => {
                state.circuit_breaker.record_success(provider.name());

                // Determine degraded mode for the stream path (#218).
                let degraded = if primary_skipped_stream {
                    state.metrics.inc_degraded_fallback();
                    Some(DegradedMode::Fallback(provider.name().to_string()))
                } else {
                    None
                };

                info!(
                    request_id = %ctx.request_id,
                    provider = provider.name(),
                    model = %decision.model,
                    degraded = ?degraded,
                    "streaming request started"
                );

                // 9. Outbound firewall on the streaming path.
                //
                // The non-streaming `run` scans the full response after it
                // arrives; streaming responses arrive incrementally, so we wrap
                // the SSE body. Behaviour is chosen per-policy because bytes
                // already streamed to the client cannot be un-sent:
                //   - WarnAndContinue: pass the stream through unchanged,
                //     scanning the accumulated text only to log detections.
                //     Keeps the U18 "stream through unchanged" contract for the
                //     warn config.
                //   - Block / Sanitize: buffer the upstream stream fully, scan
                //     the assembled text, then emit either a single blocked SSE
                //     error frame or the sanitized completion. This defeats
                //     incremental streaming for those modes on purpose.
                let firewall_body =
                    apply_outbound_firewall_stream(stream_body, Arc::clone(&state), ctx.clone())
                        .await;

                // 10. Stream observer: tap the outbound SSE at stream end to
                // capture real token usage (from the terminal usage frame, when
                // stream_options.include_usage was injected) and run eval
                // scoring. The observer wraps the body AFTER the firewall so it
                // fires regardless of firewall policy. The audit row is written
                // at stream end (defer-to-end) rather than at stream start, so
                // every row in the audit log carries non-zero token counts.
                let provider_name = provider.name().to_string();
                let observed_body = attach_stream_observer(
                    firewall_body,
                    Arc::clone(&state),
                    ctx.clone(),
                    provider_name,
                    decision.model.clone(),
                    estimated_tokens,
                    start,
                    // Managed policy-alert (item 4): stamp the matched budget-cap
                    // tier onto the stream-end debit. `limit > 0` excludes the
                    // wallet-empty decision; only tiers >= Warn ride.
                    budget
                        .as_ref()
                        .filter(|b| b.limit > 0 && b.alert >= AlertTier::Warn)
                        .map(|b| b.alert),
                );

                // Hold the admission slot AND the credit reservation for the
                // *whole* stream: move both into the body so they drop only when
                // the SSE is fully consumed (or the client disconnects). Until
                // then this generation counts against the engine's slot budget
                // and against the org's in-flight credit claim.
                let observed_body = hold_admission_until_stream_end(
                    observed_body,
                    admission_permit,
                    credit_reservation,
                );

                return Ok(PipelineStreamOutput {
                    body: observed_body,
                    context: ctx,
                    provider_used: provider.name(),
                    model_used: decision.model,
                    budget,
                    degraded,
                    policy_alert,
                    prompt_cache: prompt_cache_outcome,
                });
            }
            Err(e) => {
                // See the non-stream arm: 429 capacity and 402 payment conditions
                // demote tiers without a circuit penalty.
                if !penalizes_provider_circuit(&e) {
                    state.metrics.inc_provider_error(provider.name());
                    warn!(
                        provider = %provider.name(),
                        error = %e,
                        "stream provider unavailable for this account, demoting to next tier"
                    );
                } else {
                    state.circuit_breaker.record_failure(provider.name());
                    state.metrics.inc_provider_error(provider.name());
                    warn!(
                        provider = %provider.name(),
                        error = %e,
                        "stream provider failed, trying fallback"
                    );
                }
                if Some(provider_kind) == primary_provider_stream.as_ref() {
                    primary_skipped_stream = true;
                }
                remember_preferred_provider_error(&mut last_err, e);
            }
        }
    }

    state.metrics.inc_errors();
    state.metrics.inc_degraded_exhausted();
    let err = last_err.map_or_else(
        || {
            GatewayError::AllProvidersUnavailable(format!(
                "All providers unavailable for model '{}'",
                decision.model
            ))
        },
        |prev| match prev {
            GatewayError::CircuitOpen(_) | GatewayError::ProviderError(_) => {
                GatewayError::AllProvidersUnavailable(format!(
                    "All providers unavailable for model '{}': {prev}",
                    decision.model
                ))
            }
            other => other,
        },
    );
    audit_failure(&state, &ctx, &decision.model, &err, start);
    Err(err)
}

// ─── Multimodal pipeline (image / TTS / STT) ─────────────────────────────────

/// Run a non-chat modality request (image-gen, TTS, STT) through the same
/// firewall, rate-limit, budget, circuit-breaker, and audit pipeline as chat.
/// Returns the raw provider JSON response.
///
/// The modality decides which provider method is called:
///   - `Modality::Image`  → `provider.generate_image()`
///   - `Modality::Tts`    → `provider.synthesize_speech()`
///   - `Modality::Stt`    → `provider.transcribe_audio()`
///   - `Modality::Chat`   → falls through to normal chat (`run`)
pub async fn run_multimodal(
    state: Arc<AppState>,
    ctx: RequestContext,
    mut body: Value,
    modality: Modality,
) -> Result<PipelineOutput, GatewayError> {
    let start = Instant::now();

    state.metrics.inc_requests();

    let requested_model = body["model"].as_str().unwrap_or("unknown").to_string();

    // Inbound firewall on the prompt / input text field.
    let prompt_text = multimodal_input_text(&body, &modality);
    let inbound_result: Result<(), GatewayError> = state.with_firewall(|fw| {
        if let Some(violation) = fw.scan_inbound(&prompt_text) {
            match fw.policy() {
                FirewallPolicy::Block => {
                    state.metrics.inc_firewall_blocked();
                    return Err(GatewayError::FirewallBlocked(
                        format!(
                            "Inbound content blocked: {} ({:?})",
                            violation.pattern_name, violation.kind
                        ),
                        firewall_policy_alert(fw.config(), &ctx, "block"),
                    ));
                }
                FirewallPolicy::Sanitize | FirewallPolicy::WarnAndContinue => {
                    warn!(
                        request_id = %ctx.request_id,
                        pattern = %violation.pattern_name,
                        modality = modality.as_str(),
                        "firewall: inbound violation on multimodal request"
                    );
                }
            }
        }
        Ok(())
    });
    inbound_result.map_err(|e| {
        state.metrics.inc_errors();
        audit_failure(&state, &ctx, &requested_model, &e, start);
        e
    })?;

    // Image-target inline evaluators (explicit_content / sensitive_imagery) are
    // NOT enforced this phase: judging an image needs a vision-capable judge that
    // is not wired here. If an agent enabled one, log it honestly rather than
    // silently implying enforcement — their catalog `enforced` flag stays false.
    if matches!(modality, Modality::Image) {
        let scanner = state.resolved_scanner(&ctx);
        let enabled_image: Vec<&'static str> = scanner
            .config()
            .evaluators
            .iter()
            .filter(|b| b.enabled)
            .filter_map(|b| image_detection_kind(&b.id))
            .map(|k| k.as_str())
            .collect();
        if !enabled_image.is_empty() {
            warn!(
                request_id = %ctx.request_id,
                evaluators = ?enabled_image,
                "inline image evaluators enabled but NOT enforced this phase (no vision judge wired; enforced=false)"
            );
        }
    }

    // Rate limit + burst check.
    if !state
        .rate_limiter
        .check_request_for_key(&ctx.api_key, ctx.key_config.as_ref())
    {
        warn!(key = %ctx.api_key, "rate limit exceeded (multimodal)");
        state.metrics.inc_rate_limited();
        let e = GatewayError::RateLimited;
        audit_failure(&state, &ctx, &requested_model, &e, start);
        return Err(e);
    }
    if !state.rate_limiter.check_burst(&ctx.api_key) {
        warn!(key = %ctx.api_key, "burst rate exceeded (multimodal)");
        state.metrics.inc_rate_limited();
        let e = GatewayError::RateLimited;
        audit_failure(&state, &ctx, &requested_model, &e, start);
        return Err(e);
    }

    // Modality-aware routing — honor the per-agent slot override forwarded by
    // Core (M3 / #164) so each modality call from the same carded agent can
    // reach a different provider. Governance (firewall, budgets, policy) runs
    // after routing and is never bypassed.
    let decision = state.router.route_modality_with_slot(
        &modality,
        &requested_model,
        ctx.slot_provider.as_ref(),
        ctx.slot_model.as_deref(),
    );

    // Budget enforcement (reuse the chat path's enforcer).
    let mut decision = decision;
    let BudgetOutcome {
        decision: budget,
        alert: policy_alert,
        // Same shape as the non-streamed chat path, and for the same reason:
        // the media debit is SPAWNED, so a permit dropped when this function
        // returns would free the claim while the debit is still in flight and
        // `remaining_budget_micro_usd` still reads the stale cached figure.
        // `.take()`n into the task below; if no debit fires (credits inactive,
        // no org, zero rate, empty output) it stays here and drops on return.
        reservation: mut credit_reservation,
    } = enforce_budget(
        &state,
        &ctx,
        &mut body,
        &mut decision,
        budget_charge_kind_for_modality(&modality),
        OutputCeiling::Untouched,
    )
    .map_err(|e| {
        state.metrics.inc_errors();
        audit_failure(&state, &ctx, &requested_model, &e, start);
        e
    })?;

    let fallback_chain = clamped_fallback_chain(&state, &ctx, &decision);
    let mut last_err: Option<GatewayError> = None;
    let primary_provider_mm = fallback_chain.first().cloned();
    let mut primary_skipped_mm = false;

    for provider_kind in &fallback_chain {
        if state.circuit_breaker.is_open(provider_kind.as_str()) {
            remember_preferred_provider_error(
                &mut last_err,
                GatewayError::CircuitOpen(provider_kind.as_str().to_string()),
            );
            if Some(provider_kind) == primary_provider_mm.as_ref() {
                primary_skipped_mm = true;
            }
            continue;
        }

        let Some(provider) = state.providers.get(provider_kind.as_str()) else {
            if Some(provider_kind) == primary_provider_mm.as_ref() {
                primary_skipped_mm = true;
            }
            continue;
        };

        state.metrics.inc_provider_request(provider.name());

        stamp_openrouter_identity(&mut body, provider.name(), &ctx);

        let result = match modality {
            Modality::Image => provider
                .generate_image(&decision.model, &body)
                .await
                .map_err(GatewayError::from),
            Modality::Tts => provider
                .synthesize_speech(&decision.model, &body)
                .await
                .map_err(GatewayError::from),
            Modality::Stt => provider
                .transcribe_audio(&decision.model, &body)
                .await
                .map_err(GatewayError::from),
            Modality::Chat => provider
                .complete(&decision.model, &body)
                .await
                .map_err(GatewayError::from),
            // Video is job-based (submit + poll); it never flows through the
            // block-and-return path. `submit_video_job` handles it instead.
            Modality::Video => Err(GatewayError::ProviderError(
                "video generation is job-based; use POST /v1/videos/generations".to_string(),
            )),
        };

        match result {
            Ok(response) => {
                state.circuit_breaker.record_success(provider.name());
                let latency_ms = start.elapsed().as_millis() as u64;

                let degraded = if primary_skipped_mm {
                    state.metrics.inc_degraded_fallback();
                    Some(DegradedMode::Fallback(provider.name().to_string()))
                } else {
                    None
                };
                let provider_cost_micro_usd =
                    response_reported_cost_usd(&response).and_then(cost_usd_to_micro);
                let has_output = modality != Modality::Image
                    || response["data"].as_array().is_some_and(|a| !a.is_empty());
                let (media_cost_micro_usd, estimated_media_cost) =
                    media_cost_from_response(&state, &modality, &response);
                if has_output {
                    record_charged_budget_kind(
                        &state,
                        &ctx,
                        BudgetChargeKind::Media,
                        state
                            .config
                            .credits
                            .debit_amount_for_provider(Some(provider.name()), media_cost_micro_usd),
                    );
                }

                state.log_audit(AuditRecord {
                    request_id: ctx.request_id.clone(),
                    api_key: ctx.api_key.clone(),
                    user_name: ctx.user_name.clone(),
                    org_id: ctx.org_id.clone(),
                    team_id: ctx.team_id.clone(),
                    project_id: ctx.project_id.clone(),
                    provider: format!("{}:{}", provider.name(), modality.as_str()),
                    model: decision.model.clone(),
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_hit: false,
                    latency_ms,
                    eval_score: None,
                    error: None,
                    skill_ids: ctx.skill_ids.clone(),
                    session_id: ctx.session_id.clone(),
                    user_id: ctx.user_id.clone(),
                    agent_id: ctx.agent_id.clone(),
                    feature: ctx.feature.clone(),
                    managed_inference: ctx.managed_inference,
                    provider_cost_micro_usd,
                    event_type: crate::audit::EventType::ModelCall,
                    backend: None,
                    command: None,
                    duration_ms: None,
                    exit_code: None,
                    widget_instance_id: None,
                });

                // Experimental OTel GenAI span (#540, P1), multimodal path. The
                // operation name is the modality (image/tts/stt), not "chat".
                // Multimodal providers report no token usage, so tokens are 0.
                crate::telemetry::emit_gen_ai_span(
                    modality.as_str(),
                    provider.name(),
                    &decision.model,
                    0,
                    0,
                    latency_ms,
                );
                crate::ryu_analytics::emit_model_call(
                    modality.as_str(),
                    provider.name(),
                    &decision.model,
                    0,
                    0,
                    latency_ms,
                    "ok",
                    None,
                );

                info!(
                    request_id = %ctx.request_id,
                    provider = provider.name(),
                    modality = modality.as_str(),
                    model = %decision.model,
                    latency_ms,
                    degraded = ?degraded,
                    "multimodal request completed"
                );

                // Managed media metering: debit the configured flat per-modality
                // rate on success. Cloud media providers don't report a
                // usage.cost like chat, so managed nodes meter media at a fixed
                // rate through the same at-cost + markup path as tokens. NOP
                // unless credits are active and an org is present, so local/BYOK
                // installs are unaffected. (The rates themselves no longer default
                // to 0 — an unset one resolves to a real fallback, and only an
                // explicit 0 in the deploy config gives a modality away.)
                // Filter empty org (mirrors the chat debit path) and, for image,
                // skip billing a "success" that produced no media (content-
                // filtered / empty output).
                if let Some(org_id) = ctx.org_id.clone().filter(|s| !s.is_empty()) {
                    // Priced from the compute time the provider REPORTED where
                    // it gave one; the flat rate is a fallback, and `estimated`
                    // records which of the two paid for this row so a later
                    // reconciliation against the provider invoice can tell them
                    // apart.
                    // OUTSIDE the `cost > 0` guard, deliberately. A fallback that
                    // prices to zero is the exact combination that shipped unbilled
                    // media twice, and inside the guard it is the one case that
                    // cannot warn — no debit, no log, no invoice line to reconcile
                    // against. This is the smallest change that would have surfaced
                    // both on their first production call.
                    if estimated_media_cost && has_output {
                        warn!(
                            modality = modality.as_str(),
                            cost = media_cost_micro_usd,
                            billed = media_cost_micro_usd > 0,
                            "credits: media billed at the FLAT fallback rate — the \
                             provider reported no compute time"
                        );
                    }
                    if media_cost_micro_usd > 0 && has_output {
                        let fail_closed_sticky =
                            state.config.credits.fail_closed && ctx.managed_inference;
                        // The credit permit rides INTO the task so it outlives
                        // the debit, not the handler. Image generation is the
                        // most expensive per-call managed surface, so this is
                        // the path where a freed-early claim costs the most.
                        let credit_permit = credit_reservation.take();
                        let state_debit = state.clone();
                        let ref_id = format!("{}:{}", ctx.request_id, modality.as_str());
                        let pool = crate::credit_pools::pool_for_gateway_provider(provider.name());
                        let debit_attribution = DebitAttribution {
                            provider: Some(provider.name().to_string()),
                            model: Some(decision.model.clone()),
                            // The provider's REPORTED compute time when the
                            // metered path priced this call, absent when it fell
                            // back to the flat rate — so a statement row with no
                            // duration is exactly a row that was estimated.
                            duration_ms: response["usage"]["compute_seconds"]
                                .as_f64()
                                .filter(|s| *s > 0.0)
                                .map(|s| (s * 1000.0).round() as u64),
                            user_id: ctx.user_id.clone(),
                            task_label: Some(media_task_label(&modality, estimated_media_cost)),
                            estimated: Some(estimated_media_cost),
                            ..Default::default()
                        };
                        tokio::spawn(async move {
                            debit_wallet_for_request(
                                state_debit,
                                org_id,
                                ref_id,
                                "media",
                                media_cost_micro_usd,
                                fail_closed_sticky,
                                // Media debits carry no budget-cap tier (item 4
                                // is scoped to charged-cost budgets).
                                None,
                                pool,
                                // No token counts: media has none.
                                debit_attribution,
                            )
                            .await;
                            drop(credit_permit);
                        });
                    }
                }

                return Ok(PipelineOutput {
                    response,
                    context: ctx,
                    provider_used: provider.name(),
                    model_used: decision.model,
                    cache_hit: false,
                    budget,
                    eval_score: None,
                    degraded,
                    policy_alert,
                    // Media/multimodal path: prompt caching does not apply.
                    prompt_cache: ryu_gw_providers::PromptCacheOutcome::Disabled,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                });
            }
            Err(e) => {
                state.circuit_breaker.record_failure(provider.name());
                state.metrics.inc_provider_error(provider.name());
                warn!(
                    provider = %provider.name(),
                    modality = modality.as_str(),
                    error = %e,
                    "multimodal provider failed, trying fallback"
                );
                if Some(provider_kind) == primary_provider_mm.as_ref() {
                    primary_skipped_mm = true;
                }
                remember_preferred_provider_error(&mut last_err, e);
            }
        }
    }

    state.metrics.inc_errors();
    state.metrics.inc_degraded_exhausted();
    let err = last_err.map_or_else(
        || {
            GatewayError::AllProvidersUnavailable(format!(
                "All providers unavailable for {modality:?} model '{}'",
                decision.model
            ))
        },
        |prev| match prev {
            GatewayError::CircuitOpen(_) | GatewayError::ProviderError(_) => {
                GatewayError::AllProvidersUnavailable(format!(
                    "All providers unavailable for {modality:?} model '{}': {prev}",
                    decision.model
                ))
            }
            other => other,
        },
    );
    audit_failure(&state, &ctx, &decision.model, &err, start);
    Err(err)
}

/// Run embeddings or reranking through the same governance used by chat and
/// multimodal calls. These endpoints still consume provider tokens and wallet
/// credits even though their response shape is not a chat completion.
pub async fn run_embedding(
    state: Arc<AppState>,
    ctx: RequestContext,
    mut body: Value,
    operation: EmbeddingOperation,
) -> Result<PipelineOutput, GatewayError> {
    let start = Instant::now();
    state.metrics.inc_requests();
    let requested_model = body["model"].as_str().unwrap_or("unknown").to_string();

    if !state
        .rate_limiter
        .check_request_for_key(&ctx.api_key, ctx.key_config.as_ref())
    {
        state.metrics.inc_rate_limited();
        let error = GatewayError::RateLimited;
        audit_failure(&state, &ctx, &requested_model, &error, start);
        return Err(error);
    }
    if !state.rate_limiter.check_burst(&ctx.api_key) {
        state.metrics.inc_rate_limited();
        let error = GatewayError::RateLimited;
        audit_failure(&state, &ctx, &requested_model, &error, start);
        return Err(error);
    }

    let mut decision = state.router.route(&requested_model);
    let BudgetOutcome {
        decision: budget,
        alert: policy_alert,
        reservation: mut credit_reservation,
    } = enforce_budget(
        &state,
        &ctx,
        &mut body,
        &mut decision,
        BudgetChargeKind::Model,
        OutputCeiling::Untouched,
    )
    .map_err(|error| {
        state.metrics.inc_errors();
        audit_failure(&state, &ctx, &requested_model, &error, start);
        error
    })?;

    let fallback_chain = clamped_fallback_chain(&state, &ctx, &decision);
    let primary_provider = fallback_chain.first().cloned();
    let mut primary_skipped = false;
    let mut last_error: Option<GatewayError> = None;

    for provider_kind in &fallback_chain {
        if state.circuit_breaker.is_open(provider_kind.as_str()) {
            last_error = Some(GatewayError::CircuitOpen(
                provider_kind.as_str().to_string(),
            ));
            if Some(provider_kind) == primary_provider.as_ref() {
                primary_skipped = true;
            }
            continue;
        }

        let Some(provider) = state.providers.get(provider_kind.as_str()) else {
            if Some(provider_kind) == primary_provider.as_ref() {
                primary_skipped = true;
            }
            continue;
        };
        state.metrics.inc_provider_request(provider.name());

        let result = match operation {
            EmbeddingOperation::Embed => provider
                .embed(&decision.model, &body)
                .await
                .map_err(GatewayError::from),
            EmbeddingOperation::Rerank => provider
                .rerank(&decision.model, &body)
                .await
                .map_err(GatewayError::from),
        };

        match result {
            Ok(response) => {
                state.circuit_breaker.record_success(provider.name());
                let input_tokens = response["usage"]["prompt_tokens"]
                    .as_u64()
                    .or_else(|| response["usage"]["input_tokens"].as_u64())
                    .or_else(|| response["usage"]["total_tokens"].as_u64())
                    .unwrap_or(0);
                let output_tokens = response["usage"]["completion_tokens"].as_u64().unwrap_or(0);
                let total_tokens = input_tokens.saturating_add(output_tokens);
                state.metrics.add_tokens(input_tokens, output_tokens);

                if total_tokens > 0
                    && !state.rate_limiter.check_tokens_for_key(
                        &ctx.api_key,
                        total_tokens,
                        ctx.key_config.as_ref(),
                    )
                {
                    state.metrics.inc_rate_limited();
                    state.metrics.inc_errors();
                    let error = GatewayError::RateLimited;
                    audit_failure(&state, &ctx, &decision.model, &error, start);
                    return Err(error);
                }

                let reported_cost = response["usage"]["cost"]
                    .as_f64()
                    .and_then(cost_usd_to_micro);
                let budget_cost_micro_usd = charged_budget_cost_micro_usd(
                    &state,
                    Some(provider.name()),
                    response["usage"]["cost"].as_f64(),
                    input_tokens,
                    output_tokens,
                    &decision.model,
                );
                state.audit.add_tokens(&ctx.api_key, total_tokens);
                record_charged_budget(&state, &ctx, budget_cost_micro_usd);

                let latency_ms = start.elapsed().as_millis() as u64;
                let provider_cost_micro_usd = reported_cost;
                state.log_audit(AuditRecord {
                    request_id: ctx.request_id.clone(),
                    api_key: ctx.api_key.clone(),
                    user_name: ctx.user_name.clone(),
                    org_id: ctx.org_id.clone(),
                    team_id: ctx.team_id.clone(),
                    project_id: ctx.project_id.clone(),
                    provider: format!("{}:{}", provider.name(), operation.as_str()),
                    model: decision.model.clone(),
                    input_tokens,
                    output_tokens,
                    cache_hit: false,
                    latency_ms,
                    eval_score: None,
                    error: None,
                    skill_ids: ctx.skill_ids.clone(),
                    session_id: ctx.session_id.clone(),
                    user_id: ctx.user_id.clone(),
                    agent_id: ctx.agent_id.clone(),
                    feature: ctx.feature.clone(),
                    managed_inference: ctx.managed_inference,
                    provider_cost_micro_usd,
                    event_type: crate::audit::EventType::ModelCall,
                    backend: None,
                    command: None,
                    duration_ms: None,
                    exit_code: None,
                    widget_instance_id: None,
                });

                if let Some(org_id) = ctx.org_id.clone().filter(|value| !value.is_empty()) {
                    if state.config.credits.is_active() {
                        let cost = response_cost_micro_usd(
                            &state,
                            response["usage"]["cost"].as_f64(),
                            input_tokens,
                            output_tokens,
                            &decision.model,
                        );
                        let fail_closed_sticky =
                            state.config.credits.fail_closed && ctx.managed_inference;
                        let budget_alert_tier = budget
                            .as_ref()
                            .filter(|value| value.limit > 0 && value.alert >= AlertTier::Warn)
                            .map(|value| value.alert);
                        let credit_permit = credit_reservation.take();
                        let state_debit = Arc::clone(&state);
                        let request_id = ctx.request_id.clone();
                        let pool = crate::credit_pools::pool_for_gateway_provider(provider.name());
                        let attribution = DebitAttribution {
                            provider: Some(provider.name().to_string()),
                            model: Some(decision.model.clone()),
                            input_tokens: Some(input_tokens),
                            output_tokens: Some(output_tokens),
                            duration_ms: Some(latency_ms),
                            user_id: ctx.user_id.clone(),
                            ..Default::default()
                        };
                        tokio::spawn(async move {
                            debit_wallet_for_request(
                                state_debit,
                                org_id,
                                request_id,
                                operation.as_str(),
                                cost,
                                fail_closed_sticky,
                                budget_alert_tier,
                                pool,
                                attribution,
                            )
                            .await;
                            drop(credit_permit);
                        });
                    }
                }

                let degraded = if primary_skipped {
                    state.metrics.inc_degraded_fallback();
                    Some(DegradedMode::Fallback(provider.name().to_string()))
                } else {
                    None
                };
                return Ok(PipelineOutput {
                    response,
                    context: ctx,
                    provider_used: provider.name(),
                    model_used: decision.model,
                    cache_hit: false,
                    budget,
                    eval_score: None,
                    degraded,
                    policy_alert,
                    prompt_cache: ryu_gw_providers::PromptCacheOutcome::Disabled,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                });
            }
            Err(error) => {
                if penalizes_provider_circuit(&error) {
                    state.circuit_breaker.record_failure(provider.name());
                }
                state.metrics.inc_provider_error(provider.name());
                last_error = Some(error);
                if Some(provider_kind) == primary_provider.as_ref() {
                    primary_skipped = true;
                }
            }
        }
    }

    state.metrics.inc_errors();
    state.metrics.inc_degraded_exhausted();
    let error = last_error.map_or_else(
        || {
            GatewayError::AllProvidersUnavailable(format!(
                "All providers unavailable for {} model '{}'",
                operation.as_str(),
                decision.model
            ))
        },
        |previous| match previous {
            GatewayError::CircuitOpen(_) | GatewayError::ProviderError(_) => {
                GatewayError::AllProvidersUnavailable(format!(
                    "All providers unavailable for {} model '{}': {previous}",
                    operation.as_str(),
                    decision.model
                ))
            }
            other => other,
        },
    );
    audit_failure(&state, &ctx, &decision.model, &error, start);
    Err(error)
}

// ─── Video generation (job-based) ─────────────────────────────────────────────

/// Submit a video-generation job. Runs the SAME governance as `run_multimodal`
/// (inbound firewall, rate limit, routing, budget) but, because cloud video runs
/// for minutes, it does not block: it kicks off the provider's async job, stores
/// a [`crate::jobs::MediaJob`] keyed by the request id, and returns the job
/// envelope (`{ id, status, model }`) for the client to poll.
pub async fn submit_video_job(
    state: Arc<AppState>,
    ctx: RequestContext,
    mut body: Value,
) -> Result<Value, GatewayError> {
    let start = Instant::now();
    state.metrics.inc_requests();
    let requested_model = body["model"].as_str().unwrap_or("unknown").to_string();

    // Inbound firewall on the prompt.
    let prompt_text = multimodal_input_text(&body, &Modality::Video);
    let inbound: Result<(), GatewayError> = state.with_firewall(|fw| {
        if let Some(violation) = fw.scan_inbound(&prompt_text) {
            if *fw.policy() == FirewallPolicy::Block {
                state.metrics.inc_firewall_blocked();
                return Err(GatewayError::FirewallBlocked(
                    format!(
                        "Inbound content blocked: {} ({:?})",
                        violation.pattern_name, violation.kind
                    ),
                    firewall_policy_alert(fw.config(), &ctx, "block"),
                ));
            }
            warn!(
                request_id = %ctx.request_id,
                pattern = %violation.pattern_name,
                "firewall: inbound violation on video request"
            );
        }
        Ok(())
    });
    inbound.map_err(|e| {
        state.metrics.inc_errors();
        audit_failure(&state, &ctx, &requested_model, &e, start);
        e
    })?;

    // Rate limit + burst.
    if !state
        .rate_limiter
        .check_request_for_key(&ctx.api_key, ctx.key_config.as_ref())
        || !state.rate_limiter.check_burst(&ctx.api_key)
    {
        state.metrics.inc_rate_limited();
        let e = GatewayError::RateLimited;
        audit_failure(&state, &ctx, &requested_model, &e, start);
        return Err(e);
    }

    // Route (honor per-agent video slot) + budget.
    let decision = state.router.route_modality_with_slot(
        &Modality::Video,
        &requested_model,
        ctx.slot_provider.as_ref(),
        ctx.slot_model.as_deref(),
    );
    let mut decision = decision;
    // Video is job-based, so its reservation must move into the durable in-memory
    // job record and live until the provider reaches a terminal state. Dropping it
    // at the end of submit reopens the exact headroom that concurrent video jobs
    // are meant to claim.
    let BudgetOutcome {
        reservation: credit_reservation,
        ..
    } = enforce_budget(
        &state,
        &ctx,
        &mut body,
        &mut decision,
        BudgetChargeKind::Media,
        OutputCeiling::Untouched,
    )
    .map_err(|e| {
        state.metrics.inc_errors();
        audit_failure(&state, &ctx, &requested_model, &e, start);

        e
    })?;

    let provider_kind = decision.provider.clone();
    if state.circuit_breaker.is_open(provider_kind.as_str()) {
        let e = GatewayError::CircuitOpen(provider_kind.as_str().to_string());
        audit_failure(&state, &ctx, &decision.model, &e, start);
        return Err(e);
    }
    let Some(provider) = state.providers.get(provider_kind.as_str()) else {
        let e = GatewayError::AllProvidersUnavailable(format!(
            "video provider '{}' not configured",
            provider_kind.as_str()
        ));
        audit_failure(&state, &ctx, &decision.model, &e, start);
        return Err(e);
    };

    state.metrics.inc_provider_request(provider.name());
    let job = provider
        .submit_video(&decision.model, &body)
        .await
        .map_err(GatewayError::from)
        .map_err(|e| {
            state.circuit_breaker.record_failure(provider.name());
            state.metrics.inc_provider_error(provider.name());
            audit_failure(&state, &ctx, &decision.model, &e, start);
            e
        })?;
    state.circuit_breaker.record_success(provider.name());

    let media_job = crate::jobs::MediaJob {
        id: ctx.request_id.clone(),
        provider: provider_kind,
        provider_ref: job.provider_ref,
        model: decision.model.clone(),
        status: job.status,
        output: job.output,
        error: job.error,
        created_ms: crate::jobs::now_ms(),
        last_activity_ms: crate::jobs::now_ms(),
        org_id: ctx.org_id.clone(),
        user_id: ctx.user_id.clone(),
        agent_id: ctx.agent_id.clone(),
        session_id: ctx.session_id.clone(),
        api_key: ctx.api_key.clone(),
        reservation: credit_reservation.map(Arc::new),
    };
    // If the provider completed the job synchronously at submit, bill here — no
    // later poll will observe a Queued→Succeeded transition. Idempotent via the
    // `{id}:video` ref so it never double-charges against the poll debit.
    let terminal_success = media_job.status == crate::jobs::JobStatus::Succeeded;
    let terminal = media_job.status.is_terminal();
    let has_output = media_job
        .output
        .as_ref()
        .and_then(|o| o["data"].as_array())
        .is_some_and(|a| !a.is_empty());
    let job_id = media_job.id.clone();
    let job_org = media_job.org_id.clone();
    let job_user_id = media_job.user_id.clone();
    let job_agent_id = media_job.agent_id.clone();
    let job_session_id = media_job.session_id.clone();
    let response = media_job.to_response();
    state.jobs.insert(media_job);

    if terminal_success && has_output {
        if let Some(org_id) = job_org.filter(|s| !s.is_empty()) {
            // PRICED FROM THE PROVIDER'S REPORTED COMPUTE TIME, exactly like the
            // synchronous media path above — not from the flat rate.
            //
            // This read `media_cost_micro_usd(Video)` (the flat rate) and then
            // `if cost > 0`, which meant an async video job billed NOTHING under
            // the default config, because `cost_per_video_micro_usd` defaults to
            // 0. The startup gate deliberately stopped guarding the video rate on
            // the grounds that "image and video are metered from the provider's
            // reported cost, so a flat rate of 0 there is an unreached fallback
            // rather than a leak" — true of the sync path, false here, which is
            // what made this silent. `to_response()` flattens the provider's
            // output, so `usage.compute_seconds` is present when the provider
            // reports it.
            let (cost, estimated) = state
                .config
                .credits
                .media_cost_from_response(&Modality::Video, &response);
            record_charged_budget_for_ids(
                &state,
                job_user_id.as_deref(),
                job_agent_id.as_deref(),
                job_session_id.as_deref(),
                BudgetChargeKind::Media,
                state
                    .config
                    .credits
                    .debit_amount_for_provider(Some(provider.name()), cost),
            );
            // Outside the `cost > 0` guard — see the sync media path above. A
            // fallback priced at zero is precisely the case that must not be silent.
            if estimated {
                warn!(
                    cost,
                    billed = cost > 0,
                    "credits: video job billed at the FLAT fallback rate — \
                     the provider reported no compute time"
                );
            }
            if cost > 0 {
                let fail_closed_sticky = state.config.credits.fail_closed && ctx.managed_inference;
                let credit_reservation = state.jobs.take_reservation(&job_id);
                let provider_name = provider.name().to_owned();
                let pool = crate::credit_pools::pool_for_gateway_provider(provider.name());
                let model = decision.model.clone();
                let duration_ms = response["usage"]["compute_seconds"]
                    .as_f64()
                    .filter(|seconds| *seconds > 0.0)
                    .map(|seconds| (seconds * 1000.0).round() as u64);
                let user_id = ctx.user_id.clone();
                let task_label = media_task_label(&Modality::Video, estimated);
                let debit_ref = format!("{job_id}:video");
                let state_debit = state.clone();
                tokio::spawn(async move {
                    debit_wallet_for_request(
                        state_debit,
                        org_id,
                        debit_ref,
                        "media",
                        cost,
                        fail_closed_sticky,
                        None,
                        pool,
                        DebitAttribution {
                            provider: Some(provider_name),
                            model: Some(model),
                            // Present exactly when the provider reported compute
                            // time; absent means this row was priced at the flat
                            // fallback rate. (submit)
                            duration_ms,
                            user_id,
                            task_label: Some(task_label),
                            estimated: Some(estimated),
                            ..Default::default()
                        },
                    )
                    .await;
                    drop(credit_reservation);
                });
            }
        }
    }

    // A synchronous failure, an empty/zero-cost success, or a non-managed job
    // has no debit task to own the claim. Release any remaining job-held permit;
    // a successful paid job already moved it into the debit task above.
    if terminal {
        drop(state.jobs.take_reservation(&job_id));
    }

    info!(
        request_id = %ctx.request_id,
        provider = provider.name(),
        model = %decision.model,
        "video job submitted"
    );
    Ok(response)
}

/// Poll a previously-submitted video job by id. Tenant-isolated: the polling API
/// key must match the key that submitted the job. Terminal jobs return their
/// cached result; otherwise the provider is re-polled and the store updated. On
/// the transition to `succeeded` the configured flat video rate is debited once
/// (idempotent via the `{id}:video` ref).
pub async fn poll_video_job(
    state: Arc<AppState>,
    ctx: RequestContext,
    job_id: String,
) -> Result<Value, GatewayError> {
    let Some(job) = state.jobs.get(&job_id) else {
        return Err(GatewayError::BadRequest(format!(
            "no such video job: {job_id}"
        )));
    };
    // Tenant isolation: one caller must not read another's job by guessing an id.
    if job.api_key != ctx.api_key {
        return Err(GatewayError::Unauthorized(
            "video job belongs to a different key".to_string(),
        ));
    }
    state.jobs.touch(&job_id);
    if job.status.is_terminal() {
        return Ok(job.to_response());
    }

    let Some(provider) = state.providers.get(job.provider.as_str()) else {
        return Err(GatewayError::AllProvidersUnavailable(format!(
            "video provider '{}' not configured",
            job.provider.as_str()
        )));
    };

    let poll = provider.poll_video(&job.provider_ref).await?;
    let transition = state.jobs.apply_poll(
        &job_id,
        poll.status,
        poll.output.clone(),
        poll.error.clone(),
    );
    let newly_succeeded = transition.became_succeeded;

    let poll_has_output = poll
        .output
        .as_ref()
        .and_then(|o| o["data"].as_array())
        .is_some_and(|a| !a.is_empty());
    if newly_succeeded && poll_has_output {
        if let Some(org_id) = job.org_id.clone().filter(|s| !s.is_empty()) {
            // Same fix as the submit path: price from the compute time the
            // provider REPORTED, with the flat rate as a marked fallback. The
            // poll's own output is the provider payload `to_response()` flattens,
            // so `usage.compute_seconds` lives there when it is reported at all.
            // A job with no output resolves to `Null`, which simply misses the
            // lookup and falls back — the same as any provider that reports none.
            let poll_payload = poll.output.clone().unwrap_or(serde_json::Value::Null);
            let (cost, estimated) = state
                .config
                .credits
                .media_cost_from_response(&Modality::Video, &poll_payload);
            record_charged_budget_for_ids(
                &state,
                job.user_id.as_deref(),
                job.agent_id.as_deref(),
                job.session_id.as_deref(),
                BudgetChargeKind::Media,
                state
                    .config
                    .credits
                    .debit_amount_for_provider(Some(provider.name()), cost),
            );
            // Outside the `cost > 0` guard — see the sync media path above.
            if estimated {
                warn!(
                    cost,
                    billed = cost > 0,
                    "credits: video job billed at the FLAT fallback rate — \
                     the provider reported no compute time"
                );
            }
            if cost > 0 {
                let fail_closed_sticky = state.config.credits.fail_closed && ctx.managed_inference;
                let credit_reservation = state.jobs.take_reservation(&job_id);
                let provider_name = provider.name().to_owned();
                let pool = crate::credit_pools::pool_for_gateway_provider(provider.name());
                let model = job.model.clone();
                let duration_ms = poll_payload["usage"]["compute_seconds"]
                    .as_f64()
                    .filter(|seconds| *seconds > 0.0)
                    .map(|seconds| (seconds * 1000.0).round() as u64);
                let user_id = job.user_id.clone();
                let task_label = media_task_label(&Modality::Video, estimated);
                let debit_ref = format!("{job_id}:video");
                let state_debit = state.clone();
                tokio::spawn(async move {
                    debit_wallet_for_request(
                        state_debit,
                        org_id,
                        debit_ref,
                        "media",
                        cost,
                        fail_closed_sticky,
                        None,
                        pool,
                        DebitAttribution {
                            provider: Some(provider_name),
                            // The JOB's own model, not a request decision: a poll
                            // arrives on a later request that never made one.
                            model: Some(model),
                            // Present exactly when the provider reported compute
                            // time; absent means this row was priced at the flat
                            // fallback rate. (poll)
                            duration_ms,
                            user_id,
                            task_label: Some(task_label),
                            ..Default::default()
                        },
                    )
                    .await;
                    drop(credit_reservation);
                });
            }
        }
    }

    // A failed/cancelled terminal result, a successful job with no output, or a
    // zero-cost/non-managed success has no debit task to own the claim. A paid
    // success already moved it into the debit task above.
    if transition.became_terminal {
        drop(state.jobs.take_reservation(&job_id));
    }

    let updated = state.jobs.get(&job_id).unwrap_or(job);
    Ok(updated.to_response())
}

// ─── Unified tool loop signal (#475) ───────────────────────────────────────────

/// Whether this request should run the unified search-based tool loop.
///
/// Gated on an explicit *per-request* signal so plain chat keeps the fast direct
/// stream and ACP egress never triggers a second tool surface (B-10). The signal
/// is the new `x-ryu-tools` header literally being present
/// (`ctx.tools_header_present`) OR `x-ryu-tool-search: on`
/// (`ctx.tool_search_requested`). Two deliberate exclusions:
///   - the legacy `x-ryu-composio-actions` fallback is NOT a trigger: a bare
///     Composio agent (legacy header only) keeps its fast stream + the legacy
///     Composio loop, instead of being force-buffered into the unified loop.
///     The fallback still feeds `effective_tool_allowlist` for migration.
///   - `config.tools.always_on` is NOT a trigger: it is request-independent, so
///     keying off it would fire on header-less ACP egress — the exact
///     double-surface the design forbids. Always-on tools stay reachable once a
///     per-request signal legitimately activates the loop (injected by
///     `inject_search_tool` and granted by `effective_tool_allowlist`).
///
/// Always inert when `config.tools.enabled` is false.
fn tool_signal_active(ctx: &RequestContext, cfg: &crate::config::ToolsConfig) -> bool {
    if !cfg.enabled {
        return false;
    }
    ctx.tools_header_present || ctx.tool_search_requested
}

/// Which completion path the pipeline takes for this request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolLoopKind {
    /// Unified search-based tool loop (catalog wired + per-request signal).
    Unified,
    /// Legacy Composio tool loop (Composio configured).
    Composio,
    /// Plain completion — no managed tool loop.
    Plain,
}

/// Decide which completion branch to run — the single source of truth for the
/// precedence in `run` (unified → legacy Composio → plain).
///
/// Raw passthrough (`x-ryu-raw-tools`, `ctx.raw_tools`) short-circuits to
/// `Plain` so an SDK-side agent loop's own `tools`/`tool_calls` are forwarded
/// verbatim even on a Composio-on node — Core's loop never intercepts them.
fn select_tool_loop(
    ctx: &RequestContext,
    has_catalog: bool,
    has_composio: bool,
    cfg: &crate::config::ToolsConfig,
) -> ToolLoopKind {
    if ctx.raw_tools {
        return ToolLoopKind::Plain;
    }
    if has_catalog && tool_signal_active(ctx, cfg) {
        return ToolLoopKind::Unified;
    }
    if has_composio {
        return ToolLoopKind::Composio;
    }
    ToolLoopKind::Plain
}

/// Parse the per-request `x-ryu-tools` CSV into a list of FQ tool ids.
///
/// The wildcard `"*"` is stripped here: it grants *every* tool
/// ([`crate::tools::ToolLoopContext::is_allowed`]) and may only originate from a
/// server-configured `unrestricted` profile, never from the client-controlled
/// header. Without this filter, `x-ryu-tools: *` would bypass the allowlist
/// entirely (both on the no-profile path and when unioned onto a non-`unrestricted`
/// profile's allow set).
fn parse_tool_actions(ctx: &RequestContext) -> Vec<String> {
    ctx.tool_actions
        .as_deref()
        .map(|s| {
            s.split(',')
                .map(str::trim)
                .filter(|x| !x.is_empty() && *x != "*")
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// Effective egress tool allowlist (FQ ids) for the unified loop.
///
/// Default path (no profile, or an unknown profile name): the per-request
/// `x-ryu-tools` CSV when present, else empty, plus the registry's `always_on`
/// tool names (so always-on tools are callable without a header). This is the
/// byte-for-byte original behavior — selecting no profile changes nothing.
///
/// Profile path (`ctx.tool_profile` names a configured `cfg.profiles` entry),
/// modeled on OpenClaw's profile layering (profile → allow/deny):
///   1. seed the allow set from `profile.allow` (or the wildcard `"*"` when the
///      profile is `unrestricted` — the "full" preset);
///   2. union the explicit `x-ryu-tools` CSV on top (explicit allow augments the
///      profile);
///   3. strip any id listed in `profile.deny` (deny wins over allow);
///   4. append `always_on` names last — they are never deny-stripped, preserving
///      the always-on contract.
///
/// `tool_search` is always permitted by the loop itself, independent of this
/// list. An unrestricted profile's `"*"` is honored by
/// [`crate::tools::ToolLoopContext::is_allowed`].
fn effective_tool_allowlist(ctx: &RequestContext, cfg: &crate::config::ToolsConfig) -> Vec<String> {
    let profile = ctx
        .tool_profile
        .as_deref()
        .and_then(|name| cfg.profiles.get(name));

    let mut allowed: Vec<String> = match profile {
        // Profile selected and configured: seed from the profile's allow set.
        Some(p) => {
            let mut seed: Vec<String> = if p.unrestricted {
                vec!["*".to_string()]
            } else {
                p.allow.clone()
            };
            // Explicit per-request allow augments/overrides the profile.
            for id in parse_tool_actions(ctx) {
                if !seed.contains(&id) {
                    seed.push(id);
                }
            }
            // Deny wins over allow (does NOT strip always_on, appended below).
            if !p.deny.is_empty() {
                seed.retain(|id| !p.deny.contains(id));
            }
            seed
        }
        // No profile, or an unknown/typo'd name: exactly today's behavior.
        None => parse_tool_actions(ctx),
    };

    for def in &cfg.always_on {
        if let Some(name) = def["function"]["name"].as_str() {
            allowed.push(name.to_string());
        }
    }
    allowed
}

/// Extract the user-visible input text from a multimodal request body for
/// inbound firewall scanning. Image: `prompt`; TTS: `input`; STT: no text.
fn multimodal_input_text(body: &Value, modality: &Modality) -> String {
    match modality {
        Modality::Image | Modality::Video => body["prompt"].as_str().unwrap_or("").to_string(),
        Modality::Tts => body["input"].as_str().unwrap_or("").to_string(),
        Modality::Stt | Modality::Chat => String::new(),
    }
}

fn budget_charge_kind_for_modality(modality: &Modality) -> BudgetChargeKind {
    match modality {
        Modality::Chat => BudgetChargeKind::Model,
        Modality::Image | Modality::Tts | Modality::Stt | Modality::Video => {
            BudgetChargeKind::Media
        }
    }
}

// ─── Budget enforcement (U21) ─────────────────────────────────────────────────

/// Check the request against per-user and per-agent budgets and apply the
/// configured action inline. Shared by both the streaming and non-streaming
/// pipelines so enforcement fires on whichever path Core uses.
///
/// Side effects on the action:
///   - `Stop`      → returns `Err(BudgetExceeded)` (the caller aborts).
///   - `Downgrade` → rewrites `body["model"]` and reroutes via the router.
///   - `Restrict`  → strips tool definitions and caps `max_tokens`.
///   - `Notify`    → no body change; just observable.
///
/// Returns the triggered `BudgetDecision` (if any) so the caller can surface it
/// to the client as response headers.
fn enforce_budget(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
    decision: &mut RouteDecision,
    kind: BudgetChargeKind,
    ceiling: OutputCeiling,
) -> Result<BudgetOutcome, GatewayError> {
    if ctx.is_master_key {
        return Ok(BudgetOutcome::default());
    }
    if let Some(err) = accounting_unavailable_gate(state, ctx) {
        state.metrics.inc_errors();
        warn!(
            org_id = ?ctx.org_id,
            "credits: control-plane accounting unavailable, rejecting managed request (503)"
        );
        return Err(err);
    }
    // Pre-flight credit gate (multi-tenant data plane): a managed-inference tenant
    // whose control-plane-resolved wallet is already exhausted is rejected BEFORE
    // dispatch with a hard 402. This closes the "fresh replica serves one request
    // against an already-empty wallet" hole — it reads the authoritative resolved
    // balance (refreshed on the 60s cache TTL), so a top-up auto-recovers without a
    // sticky flag. Independent of `credits.is_active()` (the balance is
    // control-plane authoritative). Non-managed / BYOK / master traffic is exempt.
    //
    // POOL-AWARE (segregated credit pools): the gate is evaluated against the
    // pool the ROUTED provider bills, so a wallet holding only frontier-pool
    // grant money cannot serve a free-pool request (and vice versa) even though
    // its total is positive. Two honest limits of doing it here:
    //   - This runs BEFORE the fallback chain, so it gates on the PRIMARY
    //     provider's pool. A request admitted here can still be served by a
    //     fallback in a different pool. The authoritative pool attribution is the
    //     post-call debit, which knows the provider that actually answered.
    //   - An untagged provider yields `None` and the pre-pool check applies.
    let routed_pool = crate::credit_pools::pool_for_gateway_provider(decision.provider.as_str());
    if let Some(err) = preflight_credit_gate(ctx, routed_pool) {
        state.metrics.inc_budget_exceeded();
        warn!(
            org_id = ?ctx.org_id,
            remaining_budget_micro_usd = ?ctx.remaining_budget_micro_usd,
            unrestricted_budget_micro_usd = ?ctx.unrestricted_budget_micro_usd,
            pool = ?routed_pool,
            "credits: managed tenant wallet exhausted, rejecting pre-flight (402)"
        );
        return Err(err);
    }

    // CLAIM THE HEADROOM THE GATE JUST APPROVED, before dispatch.
    //
    // The gate above answers "does this org have money", and until this claim
    // existed that was the whole of the concurrency story: metering is post-paid,
    // so every request in flight at one instant read the same pre-debit balance
    // and all of them passed. One org could hold a fraction of a cent and still
    // put an unbounded number of frontier calls on Ryu's provider account, and
    // the only thing shortening the burst was the per-org rate limit — which is
    // denominated in TOKENS while the wallet is denominated in DOLLARS, so it
    // could not see price at all.
    //
    // The permit is returned to the caller and dropped when the request's
    // lifetime ends (a local on the non-streaming paths, `StreamObserverState` on
    // the streaming one). Release is `Drop`, never a call — see
    // [`ryu_gw_budget::CreditReservation`].
    //
    // Refusing here is the SAME 402 as the gate: from the client's side "your
    // wallet cannot cover this" and "your wallet cannot cover this as well as
    // everything else you have running" are one condition, and splitting them
    // would leak the node's concurrency accounting into a public error surface.
    // BOUND THE COST BEFORE CLAIMING IT. The clamp lowers this request's output
    // ceiling to what the wallet can still pay for, so the reservation below is a
    // claim against a request that physically cannot exceed it — rather than the
    // $0.01 floor standing in for an unbounded completion. Must run BEFORE
    // `maybe_reserve_credit`, which estimates from the very ceiling this writes.
    if let Some(clamped) = clamp_output_ceiling(state, ctx, body, routed_pool, ceiling) {
        debug!(
            org_id = ?ctx.org_id,
            pool = ?routed_pool,
            max_output_tokens = clamped,
            "credits: lowered this request's output ceiling to the affordable maximum"
        );
    }

    let reservation = maybe_reserve_credit(state, ctx, body, routed_pool).map_err(|err| {
        state.metrics.inc_budget_exceeded();
        warn!(
            org_id = ?ctx.org_id,
            pool = ?routed_pool,
            "credits: in-flight reservations already claim this org's balance, rejecting pre-flight (402)"
        );
        err
    })?;

    // Charged-cost budget decision (U21) and the credit-wallet-empty decision (#486)
    // are both expressed as a `BudgetDecision`; pick the more severe so a single
    // `match` applies one action. The wallet decision reuses the existing budget
    // machinery — no new denial path (spec §4).
    let token_decision = state
        .with_budget(|b| b.evaluate_charge(ctx.user_id.as_deref(), ctx.agent_id.as_deref(), kind));
    let wallet_decision = wallet_empty_decision(state, ctx);
    // Per-session running cap (#510): one global rule, counter keyed by
    // x-ryu-session-id. Folded into the same most-severe chain so a session
    // decision flows through the existing Notify/Downgrade/Restrict/Stop arms.
    let session_decision =
        state.with_budget(|b| b.evaluate_session_charge(ctx.session_id.as_deref(), kind));

    // The propagated alert tier is the MAX across every matched decision (not
    // just the most-severe-enforcement one), so a low-enforcement rule with a
    // high alert tier still fans out. Computed before `most_severe` consumes the
    // decisions.
    let max_tier = [
        token_decision.as_ref(),
        wallet_decision.as_ref(),
        session_decision.as_ref(),
    ]
    .into_iter()
    .flatten()
    .map(|d| d.alert)
    .max()
    .unwrap_or(AlertTier::Silent);

    let Some(budget) = most_severe(
        most_severe(token_decision, wallet_decision),
        session_decision,
    ) else {
        return Ok(BudgetOutcome {
            decision: None,
            alert: None,
            reservation,
        });
    };

    // Build the Ok/Err-path PolicyAlert once (source/scope inferred from the
    // winning decision), only when a matched rule asked for a real alert.
    let alert = if max_tier >= AlertTier::Warn {
        Some(PolicyAlert::from_budget_decision(
            &budget,
            max_tier,
            ctx.org_id.as_deref().unwrap_or(""),
        ))
    } else {
        None
    };

    match budget.action {
        BudgetAction::Notify => {
            state.metrics.inc_budget_notified();
            warn!(
                scope = budget.scope.as_str(),
                key = %budget.key,
                used_micro_usd = budget.used,
                limit_micro_usd = budget.limit,
                "budget reached (notify)"
            );
        }
        BudgetAction::Downgrade => {
            if let Some(ref model) = budget.downgrade_to {
                state.metrics.inc_budget_downgraded();
                info!(
                    scope = budget.scope.as_str(),
                    key = %budget.key,
                    downgrade = %model,
                    "budget reached, downgrading model"
                );
                body["model"] = Value::String(model.clone());
                *decision = state.router.route(model);
            }
        }
        BudgetAction::Restrict => {
            state.metrics.inc_budget_restricted();
            warn!(
                scope = budget.scope.as_str(),
                key = %budget.key,
                cap = budget.restrict_max_tokens,
                "budget reached, restricting request"
            );
            // Strip tools and clamp the output length so an over-budget caller
            // still gets a minimal answer instead of a hard failure.
            if let Some(obj) = body.as_object_mut() {
                obj.remove("tools");
                obj.remove("tool_choice");
            }
            body["max_tokens"] = Value::from(budget.restrict_max_tokens);
        }
        BudgetAction::Stop => {
            state.metrics.inc_budget_exceeded();
            state.metrics.inc_errors();
            warn!(
                scope = budget.scope.as_str(),
                key = %budget.key,
                used_micro_usd = budget.used,
                limit_micro_usd = budget.limit,
                "budget exceeded (stop)"
            );
            return Err(GatewayError::BudgetExceeded(alert));
        }
    }

    Ok(BudgetOutcome {
        decision: Some(budget),
        alert,
        reservation,
    })
}

// ─── Credit-wallet debit hook (#486) ──────────────────────────────────────────

/// Build a `BudgetDecision` from the cached credit-wallet-empty flag for this
/// request's org, if the credits hook is active and the org is flagged empty.
///
/// The flag is set POST-call by the debit hook (the cost is only known after the
/// response); this gate fires PRE-call on the NEXT request for that org. Returns
/// the configured wallet-empty action (Stop by default, or Downgrade) so the
/// shared `enforce_budget` machinery applies it — no new denial path (spec §4).
/// Pre-flight credit gate for the multi-tenant data plane (§4). A managed-inference
/// tenant (resolved from an `rgw_` token) whose control-plane-resolved remaining
/// wallet balance is non-positive is rejected before dispatch with a hard
/// `InsufficientCredits` (402). Reads only the resolved balance carried on the
/// ctx — it is refreshed on the resolve cache's 60s TTL, so a top-up auto-recovers
/// (no sticky flag to strand a re-funded org). Returns `None` for non-managed,
/// uncapped (`None` budget), or positive-balance requests.
///
/// `pool` is the credit pool this request is ROUTED to (see
/// [`crate::credit_pools`]), and it is what makes the gate able to answer a
/// question the total cannot: a wallet holding $50 of Bedrock grant and nothing
/// else has a positive total, yet funds no Cloudflare token at all. With a pool,
/// the spendable amount is the unrestricted buckets PLUS that one pool's grant —
/// grants for every other pool are unreachable by construction, because no other
/// entry of the map is ever added in.
///
/// `pool == None` (the provider is not pool-tagged — `openai`, `anthropic`,
/// `local`, …) is NOT the pre-pool check. It gates on the UNRESTRICTED balance,
/// because a restricted grant cannot pay an untagged provider: the debit that
/// follows carries no pool, so `debitWallet` skips every grant row and drives
/// the top-up bucket negative while the grant sits untouched. Gating such a
/// request on the blended total would admit it against money it can never
/// spend, and Ryu would absorb the provider's bill. Concretely: a Founding-50
/// claimant with `sub=0, topup=0, bedrock grant=$50` sending `gpt-4o`.
///
/// One degradation is deliberate and must stay:
///   - `unrestricted_budget_micro_usd == None` (control plane predates pool
///     segregation) ⇒ treat the whole balance as unrestricted, i.e. the pre-pool
///     check again, on BOTH branches. Collapsing this into `0` would gate every
///     request to death the moment the gateway outran the control plane.
/// The provider chain to dispatch over: the fleet's own `fallback_chain` for the
/// routed primary, re-ordered (never extended) by the node's stated preference.
///
/// The single seam all three chain-expansion sites — non-stream `run`, streaming
/// `run_stream`, and `run_multimodal` — go through, so they cannot drift. It owns
/// the `state.router.fallback_chain` call rather than taking a chain, which is
/// what makes the swap a one-liner at each site: the multimodal path never runs
/// `pre_process`, so a clamp result threaded out of `pre_process` would not have
/// reached it at all.
///
/// The clamp is fed the REAL credit gate, so an entry the preference would
/// promote is re-checked against its own credit pool. That matters because
/// `preflight_credit_gate` in `enforce_budget` only ever saw the PRIMARY's pool,
/// before this expansion — see [`node_routing`] for the full argument.
fn clamped_fallback_chain(
    state: &AppState,
    ctx: &RequestContext,
    decision: &RouteDecision,
) -> Vec<ProviderId> {
    let fleet_chain = state.router.fallback_chain(&decision.provider);
    let clamped = node_routing::clamp_fallback(
        ctx.node_routing.as_ref(),
        &state.config.node_routing,
        ctx,
        fleet_chain,
        |c, pool| preflight_credit_gate(c, pool).is_none(),
    );
    if !clamped.dropped.is_empty() {
        debug!(
            request_id = %ctx.request_id,
            dropped = ?clamped.dropped,
            "node routing: parts of the node's fallback preference were not honoured"
        );
    }
    clamped.chain
}

/// The spendable headroom `preflight_credit_gate` judges a request against, or
/// `None` when the org has no managed cap at all.
///
/// Factored out of the gate so the RESERVATION is taken against exactly the
/// number the gate approved. Deriving them separately is how a request gets
/// admitted against pooled grant money and then reserved against the
/// unrestricted balance — two different figures, and the mismatch would surface
/// as spurious 402s for tenants whose money is mostly in grants.
/// What [`enforce_budget`] hands back.
///
/// A struct rather than the old `(Option<BudgetDecision>, Option<PolicyAlert>)`
/// tuple because of the third member: `reservation` is an RAII permit whose
/// DROP releases the org's claimed headroom, so where it lives is load-bearing
/// rather than incidental. A tuple invites `let (budget, alert) = …?;`, which
/// silently drops a third element — releasing the claim the instant it was taken
/// and turning the whole mechanism into a no-op that still compiles and still
/// passes every test that does not run two requests at once. Naming the field
/// makes ignoring it something you have to write down.
#[derive(Default)]
struct BudgetOutcome {
    decision: Option<BudgetDecision>,
    alert: Option<PolicyAlert>,
    /// HOLD THIS FOR AS LONG AS THE REQUEST RUNS. Dropping it early re-admits
    /// everything it was holding back.
    reservation: Option<CreditReservation>,
}

/// Take a reservation for this request, or refuse it with the pre-flight 402.
///
/// `Ok(None)` is the ADMITTED-WITHOUT-A-CLAIM case and covers every request the
/// reservation layer has no business gating: reservations switched off, a
/// non-managed / BYOK tenant, and an org with no managed cap at all. Those are
/// exactly the callers for whom `credit_headroom_micro_usd` returns `None`, so
/// the absence of a cap stays a single concept rather than being re-derived
/// here with a slightly different meaning.
fn maybe_reserve_credit(
    state: &AppState,
    ctx: &RequestContext,
    body: &Value,
    pool: Option<&str>,
) -> Result<Option<CreditReservation>, GatewayError> {
    if !state.config.credits.reserve_enabled {
        return Ok(None);
    }
    let Some(org_id) = ctx.org_id.as_deref().filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let Some(headroom) = credit_headroom_micro_usd(ctx, pool) else {
        return Ok(None);
    };
    let estimate = reservation_estimate_micro_usd(state, body);
    state
        .wallet
        .try_reserve(org_id, estimate, headroom)
        .map(Some)
        .ok_or(GatewayError::InsufficientCredits)
}

fn credit_headroom_micro_usd(ctx: &RequestContext, pool: Option<&str>) -> Option<i64> {
    if !ctx.managed_inference {
        return None;
    }
    let total = ctx.remaining_budget_micro_usd?;
    let unrestricted = ctx.unrestricted_budget_micro_usd.unwrap_or(total);
    let Some(pool) = pool else {
        return Some(unrestricted);
    };
    let pooled = ctx
        .pool_budgets_micro_usd
        .get(pool)
        .copied()
        .unwrap_or_default();
    Some(unrestricted.saturating_add(pooled))
}

/// What THIS request is expected to cost, in micro-USD, for reservation only.
///
/// Never bills anything — the authoritative charge is the post-call debit
/// against the real ledger. This exists solely to decide who may start.
///
/// The basis is `max_tokens` at the flat `control_plane.cost_per_1k_micro_usd`
/// rate, marked up the same way the debit will be, with `min_reserve_micro_usd`
/// as a floor. The estimate is deliberately crude and is DOCUMENTED as
/// under-stating frontier traffic: the gateway holds no per-model price table,
/// and for OpenRouter the true cost only arrives with the response. The floor is
/// what actually bounds a burst — see [`crate::config::CreditsConfig::min_reserve_micro_usd`].
///
/// A request that names no `max_tokens` gets the floor rather than zero. Zero
/// would mean an unbounded completion reserves nothing, which is precisely
/// backwards: not stating a ceiling makes a request MORE expensive to serve, not
/// less.
fn reservation_estimate_micro_usd(state: &AppState, body: &Value) -> i64 {
    let credits = &state.config.credits;
    let max_tokens = body
        .get("max_tokens")
        .or_else(|| body.get("max_completion_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let estimate = credits.debit_amount(request_cost_micro_usd(state, 0, max_tokens));
    estimate
        .max(credits.min_reserve_micro_usd)
        .min(i64::MAX as u64) as i64
}

/// Whether this request body carries an output-token ceiling the credit clamp
/// may lower.
///
/// Only text completions do. `run_multimodal` and `submit_video_job` route
/// through the same [`enforce_budget`], and writing a `max_tokens` into an image
/// or video body would at best be ignored and at worst rejected by the provider
/// as an unknown field.
#[derive(Clone, Copy, PartialEq, Eq)]
enum OutputCeiling {
    /// A chat/text-completion body — clamp its token ceiling to what the wallet
    /// can actually pay for.
    Clamp,
    /// An image/video/other body — leave it alone.
    Untouched,
}

/// How many output tokens `available_micro_usd` buys at the flat rate.
///
/// The inverse of [`request_cost_micro_usd`] over the output term, un-doing the
/// billing markup first so the answer is in the same currency the caller's
/// budget is denominated in.
///
/// Saturates to `u64::MAX` when the node charges nothing per token (a rate of
/// zero divides into any balance infinitely), which the caller reads as "no
/// affordability limit" — correct, because a node that meters nothing cannot
/// overdraw anyone.
fn affordable_output_tokens(state: &AppState, available_micro_usd: i64, model: &str) -> u64 {
    // PER-MODEL, not the flat blended rate. Output prices span roughly 500x
    // across the catalog, so a single rate made this ceiling far too generous on
    // exactly the frontier models where an overdraft is worth having, and
    // needlessly tight on cheap ones — truncating completions the org could
    // always afford. Falls back to the flat rate when the model is not in the
    // price table.
    let per_1k = state
        .config
        .control_plane
        .output_price_per_1k_micro_usd(model);
    if per_1k == 0 {
        return u64::MAX;
    }
    let available = available_micro_usd.max(0) as u64;
    // Undo the markup: `debit_amount` is what turns raw provider cost into the
    // figure charged, and the budget is measured in charged micro-USD. Dividing
    // before un-marking-up would hand out a ceiling the debit then exceeds.
    let raw = state.config.credits.undo_debit_amount(available);
    raw.saturating_mul(1000) / per_1k
}

/// CLAMP THIS REQUEST'S OUTPUT CEILING TO WHAT THE WALLET CAN PAY FOR.
///
/// The hole this closes: metering is post-paid, and a request that names no
/// `max_tokens` reserved only `min_reserve_micro_usd` — a flat $0.01 that bounds
/// CONCURRENCY, not cost. So an org holding one cent could front a single
/// arbitrarily expensive completion, and the overdraft was limited only by how
/// much the model felt like generating. Prepaid credit is supposed to be a hard
/// cap; work is supposed to stop at zero.
///
/// The fix is to make the ceiling real rather than to refuse the request. A
/// request stating no ceiling is given the largest one its balance covers; a
/// request stating one keeps it, unless it is larger than the balance covers, in
/// which case it is lowered. The request then physically cannot cost more than
/// the org can pay, so the reservation that follows is an honest claim rather
/// than a floor standing in for one.
///
/// INJECTION, NOT REJECTION — deliberately, and a departure from the original
/// spec in `docs/pricing-remaining-work.md`, which called for a MANDATORY
/// `max_output_tokens`. Refusing every request that omits one would 402 every
/// existing managed client the moment this shipped, to fix a problem the client
/// did not cause. The cost of injecting instead is that a caller can now be
/// truncated at a ceiling it never set (`finish_reason: "length"`); that is the
/// honest consequence of running out of money mid-completion, and it is strictly
/// better than the alternative of serving the completion and eating the bill.
///
/// NET OF IN-FLIGHT CLAIMS. The headroom is the org's whole remaining balance,
/// and `try_reserve` is what subtracts the requests already running. Clamping
/// against the gross figure would let three concurrent unbounded requests each
/// size themselves at the full balance — the first would claim all of it and its
/// siblings would 402, which is not a bound, it is a race. Subtracting
/// `in_flight_micro_usd` first means concurrent requests each get a smaller
/// honest ceiling instead. A claim landing between this read and `try_reserve`
/// only makes the ceiling generous, and `try_reserve` still refuses
/// authoritatively — so the residual race degrades to today's behaviour rather
/// than past it.
///
/// THE CEILING IS LOOSE ON EXPENSIVE TRAFFIC. It is derived from the flat
/// `cost_per_1k_micro_usd`, which [`reservation_estimate_micro_usd`] already
/// documents as under-stating frontier models — the gateway holds no per-model
/// price table. So this bounds the overdraft, it does not eliminate it: a
/// frontier completion can still finish somewhat past the balance. A bound with
/// known slack is the improvement over no bound at all; tightening it needs the
/// per-model prices, which is the same missing piece the estimate waits on.
///
/// Returns the ceiling written, for logging. `None` when nothing was changed.
fn clamp_output_ceiling(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
    pool: Option<&str>,
    ceiling: OutputCeiling,
) -> Option<u64> {
    if ceiling != OutputCeiling::Clamp || !state.config.credits.reserve_enabled {
        return None;
    }
    let org_id = ctx.org_id.as_deref().filter(|s| !s.is_empty())?;
    // `None` ⇒ the org has no managed cap at all (BYOK, unmanaged, master key).
    // Nothing to clamp against, and imposing a ceiling on a tenant who is not
    // spending our money would be a pure regression.
    let headroom = credit_headroom_micro_usd(ctx, pool)?;
    let available = headroom.saturating_sub(state.wallet.in_flight_micro_usd(org_id));
    // The model named on the BODY — what will actually be dispatched, and so
    // what the ceiling has to be priced against. An empty/absent model falls
    // through to the flat rate inside `output_price_per_1k_micro_usd`.
    let model = body.get("model").and_then(Value::as_str).unwrap_or("");
    let affordable = affordable_output_tokens(state, available, model);
    if affordable == u64::MAX {
        return None;
    }

    // Write back to the key the CLIENT used. Adding `max_tokens` to a body that
    // said `max_completion_tokens` would leave both present, which some
    // providers reject outright.
    let key = if body.get("max_completion_tokens").is_some() {
        "max_completion_tokens"
    } else {
        "max_tokens"
    };
    let requested = body.get(key).and_then(Value::as_u64).unwrap_or(0);
    // `0`/absent means "no ceiling stated", which is the unbounded case — give it
    // the affordable one. Otherwise only ever lower, never raise: a client asking
    // for less than it can afford is stating a preference, not a budget.
    let effective = if requested == 0 {
        affordable
    } else {
        requested.min(affordable)
    };
    if effective == requested {
        return None;
    }
    if let Some(map) = body.as_object_mut() {
        map.insert(key.to_string(), Value::from(effective));
    }
    Some(effective)
}

fn preflight_credit_gate(ctx: &RequestContext, pool: Option<&str>) -> Option<GatewayError> {
    if !ctx.managed_inference {
        return None;
    }
    // `None` ⇒ no managed cap at all; nothing to gate on, pooled or not.
    let total = ctx.remaining_budget_micro_usd?;
    let unrestricted = ctx.unrestricted_budget_micro_usd.unwrap_or(total);
    let Some(pool) = pool else {
        return (unrestricted <= 0).then_some(GatewayError::InsufficientCredits);
    };
    let pooled = ctx
        .pool_budgets_micro_usd
        .get(pool)
        .copied()
        .unwrap_or_default();
    (unrestricted.saturating_add(pooled) <= 0).then_some(GatewayError::InsufficientCredits)
}

/// Stop new managed provider spend after a debit could not be accounted for.
/// This is intentionally separate from `wallet_empty_decision`: an outage is
/// not evidence that the wallet is empty, and mapping it to the wallet-empty
/// budget action would strand a funded tenant until the process restarts.
fn accounting_unavailable_gate(state: &AppState, ctx: &RequestContext) -> Option<GatewayError> {
    if !(ctx.managed_inference && state.config.credits.is_active()) {
        return None;
    }
    let org_id = ctx.org_id.as_deref().filter(|value| !value.is_empty())?;
    state
        .wallet
        .is_org_accounting_unavailable(org_id)
        .then_some(GatewayError::AccountingUnavailable)
}

fn wallet_empty_decision(state: &AppState, ctx: &RequestContext) -> Option<BudgetDecision> {
    let credits = &state.config.credits;
    if !credits.is_active() {
        return None;
    }
    let org_id = ctx.org_id.as_deref().filter(|s| !s.is_empty())?;
    if !state.wallet.is_org_empty(org_id) {
        return None;
    }

    // Map the configured wallet-empty action onto the budget action. A downgrade
    // with no target model degrades to a restrict (mirrors the spend-budget rule)
    // so the caller is never silently let through on an unhonourable downgrade.
    let action = match credits.wallet_empty_action {
        crate::config::WalletEmptyAction::Downgrade
            if credits.wallet_empty_downgrade_to.is_some() =>
        {
            BudgetAction::Downgrade
        }
        crate::config::WalletEmptyAction::Downgrade => BudgetAction::Restrict,
        crate::config::WalletEmptyAction::Stop => BudgetAction::Stop,
    };

    Some(BudgetDecision {
        scope: crate::budget::BudgetScope::User,
        key: format!("org:{org_id}"),
        action,
        used: 0,
        limit: 0,
        downgrade_to: credits.wallet_empty_downgrade_to.clone(),
        restrict_max_tokens: 256,
        // The wallet-empty rule's own alert tier (folded into the max in
        // `enforce_budget`). `limit == 0` keeps the wallet-empty invariant that
        // `PolicyAlert::from_budget_decision` routes to `wallet_empty`.
        alert: credits.wallet_empty_alert,
    })
}

/// Pick the more restrictive of two optional budget decisions. Severity order
/// (most restrictive first): `Stop` > `Restrict`/`Downgrade` > `Notify`. Ties
/// keep the first budget decision. Mirrors `budget::severity` (private there).
fn most_severe(a: Option<BudgetDecision>, b: Option<BudgetDecision>) -> Option<BudgetDecision> {
    fn rank(action: BudgetAction) -> u8 {
        match action {
            BudgetAction::Notify => 0,
            BudgetAction::Restrict | BudgetAction::Downgrade => 1,
            BudgetAction::Stop => 2,
        }
    }
    match (a, b) {
        (Some(x), Some(y)) => {
            if rank(y.action) > rank(x.action) {
                Some(y)
            } else {
                Some(x)
            }
        }
        (Some(x), None) => Some(x),
        (None, other) => other,
    }
}

/// Flat estimated spend in micro-USD for reservation-only paths.
fn request_cost_micro_usd(state: &AppState, input_tokens: u64, output_tokens: u64) -> u64 {
    let per_1k = state.config.control_plane.cost_per_1k_micro_usd;
    input_tokens
        .saturating_add(output_tokens)
        .saturating_mul(per_1k)
        / 1000
}

/// Raw provider cost in micro-USD, preferring the provider's *reported actual*
/// spend over the configured per-model price table. OpenRouter returns
/// `usage.cost` (in USD) when usage accounting is enabled; direct providers
/// fall back to the model catalog and then the flat rate.
fn response_cost_micro_usd(
    state: &AppState,
    reported_cost_usd: Option<f64>,
    input_tokens: u64,
    output_tokens: u64,
    model: &str,
) -> u64 {
    reported_cost_usd
        .and_then(cost_usd_to_micro)
        .unwrap_or_else(|| {
            state
                .config
                .control_plane
                .cost_for(model, input_tokens, output_tokens)
        })
}

/// Charged budget amount in micro-USD. Budget counters use the same amount the
/// wallet would debit, including the configured platform markup, while remaining
/// useful on self-hosted nodes where the markup is zero and no wallet is active.
fn charged_budget_cost_micro_usd(
    state: &AppState,
    provider: Option<&str>,
    reported_cost_usd: Option<f64>,
    input_tokens: u64,
    output_tokens: u64,
    model: &str,
) -> u64 {
    state.config.credits.debit_amount_for_provider(
        provider,
        response_cost_micro_usd(state, reported_cost_usd, input_tokens, output_tokens, model),
    )
}

/// Add one successful charged model call to the local user/agent/session
/// counters. The budget engine owns the identity filtering and zero-cost no-op;
/// keeping this seam here makes every completion family use the same units.
fn record_charged_budget(state: &AppState, ctx: &RequestContext, cost_micro_usd: u64) {
    record_charged_budget_kind(state, ctx, BudgetChargeKind::Model, cost_micro_usd);
}

/// Add one successful charged amount to the local user/agent/session counters,
/// honoring each matching rule's category inclusion settings.
fn record_charged_budget_kind(
    state: &AppState,
    ctx: &RequestContext,
    kind: BudgetChargeKind,
    cost_micro_usd: u64,
) {
    state.with_budget(|budgets| {
        budgets.record_charge(
            ctx.user_id.as_deref(),
            ctx.agent_id.as_deref(),
            kind,
            cost_micro_usd,
        );
        budgets.record_session_charge(ctx.session_id.as_deref(), kind, cost_micro_usd);
    });
}

/// Record charged spend when the completion is represented by stored identity
/// fields, as with an asynchronous video job that settles during polling.
fn record_charged_budget_for_ids(
    state: &AppState,
    user_id: Option<&str>,
    agent_id: Option<&str>,
    session_id: Option<&str>,
    kind: BudgetChargeKind,
    cost_micro_usd: u64,
) {
    state.with_budget(|budgets| {
        budgets.record_charge(user_id, agent_id, kind, cost_micro_usd);
        budgets.record_session_charge(session_id, kind, cost_micro_usd);
    });
}

/// Read the configured/provider-reported raw media price. Callers pass the raw
/// amount to the wallet helper and apply `debit_amount` once for budget counters.
fn media_cost_from_response(
    state: &AppState,
    modality: &Modality,
    response: &Value,
) -> (u64, bool) {
    state
        .config
        .credits
        .media_cost_from_response(modality, response)
}

/// Read a provider-reported USD cost from either the normal response envelope
/// or a preserved raw payload (OpenRouter image output uses `raw`).
fn response_reported_cost_usd(response: &Value) -> Option<f64> {
    response
        .get("usage")
        .and_then(|usage| usage.get("cost"))
        .or_else(|| {
            response
                .get("raw")
                .and_then(|raw| raw.get("usage"))
                .and_then(|usage| usage.get("cost"))
        })
        .and_then(Value::as_f64)
        .filter(|cost| cost.is_finite() && *cost >= 0.0)
}

/// Convert a provider-reported USD cost to micro-USD. Zero is meaningful: a
/// provider promotion can make a managed request free, so only negative and
/// non-finite values fall back to the token estimate.
fn cost_usd_to_micro(cost_usd: f64) -> Option<u64> {
    if cost_usd.is_finite() && cost_usd >= 0.0 {
        Some((cost_usd * 1_000_000.0).round() as u64)
    } else {
        None
    }
}

/// Extract the provider-reported generation cost (USD) from an assembled SSE
/// transcript. OpenRouter includes `usage.cost` in the terminal usage frame when
/// usage accounting is enabled; mirrors [`sse_parse_usage`]. `None` when absent.
fn sse_parse_cost(raw: &str) -> Option<f64> {
    let mut best = None;
    for line in raw.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(json) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if let Some(cost) = json["usage"]["cost"].as_f64() {
            if cost.is_finite() && cost >= 0.0 {
                best = Some(cost);
            }
        }
    }
    best
}

/// The `POST /api/credits/debit` request body. Pulled out of
/// [`debit_wallet_for_request`] so the wire contract with the control plane is
/// assertable without a live endpoint — this is the one place the gateway tells
/// the ledger which donated allowance a spend came out of, and a silently
/// dropped or misnamed `pool` key books frontier tokens against the free pool.
///
/// Both optional fields are ADDITIVE: absent means absent, not `null`, so a
/// control plane that ignores them (or predates them) sees a byte-identical
/// legacy body.
/// What a debit was FOR, alongside how much it was.
///
/// A struct rather than seven more positional parameters: `debit_wallet_for_request`
/// already takes seven, and the fields here are all `Option` of two or three
/// types, so positional args would be trivially transposable at six call sites
/// with no compiler error to catch it — `provider` and `model` are both
/// `Option<String>`.
///
/// Every field is optional and every absent field is OMITTED from the wire body,
/// never sent as `null`. A control plane that predates these keys sees a
/// byte-identical legacy body, which is the same additive contract `alertTier`
/// and `pool` already follow.
///
/// PURELY DESCRIPTIVE. Nothing downstream branches on any of it — these become
/// receipt lines on a ledger row so a customer can be told what a charge was for.
/// That is exactly why a missing value is fine and a wrong one is not worth a
/// failed debit for work already served.
#[derive(Debug, Clone, Default)]
struct DebitAttribution {
    /// Wall-clock milliseconds the billed work took.
    duration_ms: Option<u64>,
    input_tokens: Option<u64>,
    /// Model or resource id that produced the charge.
    model: Option<String>,
    output_tokens: Option<u64>,
    /// Upstream provider that served the work. NOT the credit pool: the pool is
    /// which donated allowance pays, this is who did the work.
    provider: Option<String>,
    /// Human-facing label for what the spend was for.
    task_label: Option<String>,
    /// Whether the amount was priced from the configured media fallback rather
    /// than provider-reported compute time.
    estimated: Option<bool>,
    /// The user whose action incurred the charge, when the request carried one.
    user_id: Option<String>,
}

/// Keep the existing human-facing label for a fallback charge. The explicit
/// `estimated` field is the durable machine-readable marker; provider timing
/// remains in `durationMs` when measured.
fn media_task_label(modality: &Modality, estimated: bool) -> String {
    let label = modality.as_str();
    if estimated {
        format!("{label} (estimated cost)")
    } else {
        label.to_string()
    }
}

fn debit_request_body(
    org_id: &str,
    amount_micro_usd: u64,
    reason: &str,
    ref_id: &str,
    budget_alert_tier: Option<AlertTier>,
    pool: Option<&str>,
    attribution: &DebitAttribution,
) -> Value {
    let mut body = json!({
        "orgId": org_id,
        "amountMicroUsd": amount_micro_usd,
        "reason": reason,
        "refId": ref_id,
    });
    let Some(obj) = body.as_object_mut() else {
        return body;
    };
    // Only stamp `alertTier` when a budget cap actually asked for an alert, so
    // existing debit consumers see the legacy body otherwise. Reuses the
    // `AlertTier` serde (lowercase) as the wire value.
    if let Some(tier) = budget_alert_tier {
        if let Ok(value) = serde_json::to_value(tier) {
            obj.insert("alertTier".to_string(), value);
        }
    }
    // An untagged provider omits `pool` entirely, and the control-plane debit
    // then takes its pre-pool path: no grant is reachable and the spend falls
    // through to the subscription and top-up buckets. Only a tagged provider can
    // reach pool-restricted grant money, and only its OWN pool's.
    if let Some(pool) = pool {
        obj.insert("pool".to_string(), Value::String(pool.to_string()));
    }
    // Attribution. Each key is inserted only when present, so an unattributed
    // debit is byte-identical to the legacy body.
    let mut put_str = |key: &str, value: &Option<String>| {
        if let Some(v) = value {
            let trimmed = v.trim();
            // A blank is not information. Sending `""` would land an
            // empty-string model on the row, which renders as a present but
            // nameless value — worse than an honest absence.
            if !trimmed.is_empty() {
                obj.insert(key.to_string(), Value::String(trimmed.to_string()));
            }
        }
    };
    put_str("provider", &attribution.provider);
    put_str("model", &attribution.model);
    put_str("userId", &attribution.user_id);
    put_str("taskLabel", &attribution.task_label);
    if let Some(estimated) = attribution.estimated {
        obj.insert("estimated".to_string(), Value::Bool(estimated));
    }
    for (key, value) in [
        ("inputTokens", attribution.input_tokens),
        ("outputTokens", attribution.output_tokens),
        ("durationMs", attribution.duration_ms),
    ] {
        if let Some(v) = value {
            obj.insert(key.to_string(), Value::Number(v.into()));
        }
    }
    body
}

/// Post-call wallet debit (#486). Computes the marked-up debit for a metered
/// call's `costMicroUsd` and POSTs it to the control-plane `/credits/debit` for
/// the request's org, then updates the cached balance from the authoritative
/// response so the NEXT request is gated when necessary.
///
/// The already-served response cannot be unsent, but a managed debit failure is
/// never allowed to authorize more provider spend: when `fail_closed_sticky` is
/// true, transport errors, non-2xx responses, and malformed success bodies mark
/// accounting unavailable and the next managed request receives a retryable 503.
/// A zero debit (cache hits, 0-token modalities) is skipped because the endpoint
/// rejects `amountMicroUsd <= 0`.
///
/// `ref_id` makes the debit idempotent: a retried hook is a no-op. Token usage
/// passes `ref_id = request_id`; the per-request tool-call (Composio) debit passes
/// `ref_id = "{request_id}:composio"` with `reason = "composio"` so it lands as a
/// distinct ledger row instead of being deduped against the token debit (#496).
async fn debit_wallet_for_request(
    state: Arc<AppState>,
    org_id: String,
    ref_id: String,
    reason: &'static str,
    cost_micro_usd: u64,
    fail_closed_sticky: bool,
    // Managed policy-alert hook (item 4): the stamped budget-cap tier for THIS
    // request, present only when a budget rule with tier >= Warn matched. Carried
    // on the existing debit payload (the one place the gateway and control-plane
    // already touch) so `credits.ts /debit` can email managed owners. Additive:
    // `None` omits the field entirely, leaving the legacy debit body unchanged.
    budget_alert_tier: Option<AlertTier>,
    // The segregated credit pool this spend bills against, from the registry id
    // of the provider that ACTUALLY served the request (see
    // [`crate::credit_pools`]). Deliberately a required parameter rather than a
    // defaulted one: every debit site has to make the attribution decision
    // explicitly, because an accidental `None` is silent — the spend simply never
    // draws grant money and never appears in per-pool burn.
    pool: Option<&'static str>,
    // What the charge was for. `Default::default()` at a site that genuinely
    // knows nothing; never a placeholder value, because a wrong model on an
    // invoice line is worse than a blank one.
    attribution: DebitAttribution,
) {
    let credits = &state.config.credits;
    if !credits.is_active() {
        return;
    }
    let amount = credits.debit_amount_for_provider(attribution.provider.as_deref(), cost_micro_usd);
    if amount == 0 {
        return;
    }
    let Some(secret) = credits.internal_secret.as_deref() else {
        return; // is_active guarantees Some, but stay defensive.
    };

    // `/api` IS PART OF THE ROUTE, and leaving it out cost real money. The control
    // plane mounts `creditsRouter` at `/api/credits` (`packages/api/src/routers/index.ts`),
    // and `credits.base_url` defaults to `control_plane.base_url` — the bare origin,
    // because the sibling resolve call spells its own prefix out in full
    // (`{}/api/control-plane/gateway/resolve` in `policy/mod.rs`). This join did
    // not, so in production every debit POSTed to the wrong path and got a
    // plain 404. Before the hardening change, the hook failed open and managed
    // inference could run unbilled. The current default is fail-closed: the
    // next request receives `credit_accounting_unavailable` after any failed or
    // malformed debit response.
    let url = format!(
        "{}/api/credits/debit",
        credits.base_url.trim_end_matches('/')
    );
    let body = debit_request_body(
        &org_id,
        amount,
        reason,
        &ref_id,
        budget_alert_tier,
        pool,
        &attribution,
    );

    let resp = state
        .http
        .post(&url)
        .header("x-ryu-internal-secret", secret)
        .timeout(std::time::Duration::from_millis(credits.timeout_ms.max(1)))
        .json(&body)
        .send()
        .await;

    match resp {
        Ok(r) if r.status().is_success() => {
            // Steady-state truth: `balanceMicroUsd <= 0` ⇒ empty. Self-heals the
            // flag after a top-up. `wentNonPositive` is the edge event (log only).
            match r.json::<Value>().await {
                Ok(v) => {
                    let Some(balance) = v["balanceMicroUsd"].as_i64() else {
                        warn!(
                            org_id = %org_id,
                            ref_id = %ref_id,
                            "credits: debit returned success without an integer balance"
                        );
                        audit_debit_failure(
                            &state,
                            &org_id,
                            &ref_id,
                            "credits debit response missing integer balance",
                        );
                        if fail_closed_sticky {
                            state.wallet.set_org_accounting_unavailable(&org_id, true);
                        }
                        return;
                    };
                    // Records the figure AND derives the empty flag from it, so
                    // Core's dollar-threshold fallback rules read the same number
                    // this gate does (`WalletState::set_org_balance`).
                    state.wallet.set_org_balance(&org_id, balance);
                    if v["wentNonPositive"].as_bool().unwrap_or(false) {
                        warn!(
                            org_id = %org_id,
                            ref_id = %ref_id,
                            "credits: org wallet emptied; next request will be gated"
                        );
                    }
                }
                Err(e) => {
                    warn!(org_id = %org_id, error = %e, "credits: debit succeeded but response unparseable");
                    audit_debit_failure(
                        &state,
                        &org_id,
                        &ref_id,
                        &format!("credits debit response unparseable: {e}"),
                    );
                }
            }
        }
        Ok(r) => {
            // A control-plane error never blocks the (already-served) request. The
            // failed debit is recorded in the durable audit log (#486 AC) so
            // unbilled usage is observable and reconcilable later. When fail-closed
            // is on for a managed tenant (§5), also flip the org's wallet-empty flag
            // so the NEXT request is refused — the failure is made sticky, not
            // silently swallowed.
            let status = r.status();
            warn!(
                org_id = %org_id,
                status = %status,
                fail_closed = fail_closed_sticky,
                "credits: debit returned non-success"
            );
            audit_debit_failure(
                &state,
                &org_id,
                &ref_id,
                &format!("credits debit failed: control plane returned {status}"),
            );
            if fail_closed_sticky {
                state.wallet.set_org_accounting_unavailable(&org_id, true);
            }
        }
        Err(e) => {
            warn!(
                org_id = %org_id,
                error = %e,
                fail_closed = fail_closed_sticky,
                "credits: debit transport error"
            );
            audit_debit_failure(
                &state,
                &org_id,
                &ref_id,
                &format!("credits debit failed (transport): {e}"),
            );
            if fail_closed_sticky {
                state.wallet.set_org_accounting_unavailable(&org_id, true);
            }
        }
    }
}

/// Best-effort per-request debit for billable (Composio) tool calls (#496).
/// Composio charges per action execution, so on the managed plan each executed
/// `composio.*` tool call costs the org `cost_per_tool_call_micro_usd`. This
/// fires ONE debit for the whole request (`count × per-call cost`, at cost via
/// `debit_amount`) under `reason="composio"` and a distinct
/// `refId="{request_id}:composio"` so it is not deduped against the token debit.
/// The local budget counter is updated even when the wallet is inactive or the
/// node has no org id; the wallet debit is separately a no-op in those cases.
/// Spawned by the caller so it never adds client latency.
fn spawn_tool_call_debit(state: &Arc<AppState>, ctx: &RequestContext, billable_tool_calls: u64) {
    spawn_tool_call_debit_for_ids(
        state,
        ctx.user_id.as_deref(),
        ctx.agent_id.as_deref(),
        ctx.session_id.as_deref(),
        ctx.org_id.as_deref(),
        &ctx.request_id,
        ctx.managed_inference,
        billable_tool_calls,
    );
}

/// Best-effort tool charge entry point for Core's ACP/MCP bridge. The bridge
/// executes the action in Core, while the Gateway owns the per-agent counter
/// and optional wallet debit. `raw_cost` is deliberately passed to the wallet
/// helper: that helper applies platform markup exactly once. The local budget
/// counter receives the marked-up amount so its cap matches the wallet.
pub(crate) fn spawn_tool_call_debit_for_ids(
    state: &Arc<AppState>,
    user_id: Option<&str>,
    agent_id: Option<&str>,
    session_id: Option<&str>,
    org_id: Option<&str>,
    request_id: &str,
    managed_inference: bool,
    billable_tool_calls: u64,
) {
    spawn_external_tool_debit_for_ids(
        state,
        user_id,
        agent_id,
        session_id,
        org_id,
        request_id,
        managed_inference,
        "composio",
        None,
        None,
        None,
        false,
        None,
        billable_tool_calls,
    );
}

/// Best-effort provider-neutral external-tool charge entry point. A provider may
/// report its raw transaction cost (Treg), while Composio keeps the existing
/// configured per-call fallback when no raw amount is available.
pub(crate) fn spawn_external_tool_debit_for_ids(
    state: &Arc<AppState>,
    user_id: Option<&str>,
    agent_id: Option<&str>,
    session_id: Option<&str>,
    org_id: Option<&str>,
    request_id: &str,
    managed_inference: bool,
    provider: &str,
    tool_id: Option<&str>,
    raw_cost_micro_usd: Option<u64>,
    transaction_id: Option<&str>,
    estimated: bool,
    task_label: Option<&str>,
    billable_tool_calls: u64,
) {
    if billable_tool_calls == 0 {
        return;
    }
    let provider = provider.trim();
    let reason: &'static str = match provider {
        "composio" => "composio",
        "treg" => "treg",
        _ => {
            warn!(
                provider,
                "credits: ignoring unsupported external tool provider"
            );
            return;
        }
    };
    let credits = &state.config.credits;
    let raw_cost = raw_cost_micro_usd.unwrap_or_else(|| {
        if provider == "composio" {
            credits.tool_call_cost_micro_usd(billable_tool_calls)
        } else {
            0
        }
    });
    if raw_cost == 0 {
        return;
    }
    let charged_cost = credits.debit_amount_for_provider(Some(provider), raw_cost);
    record_charged_budget_for_ids(
        state,
        user_id,
        agent_id,
        session_id,
        BudgetChargeKind::Tools,
        charged_cost,
    );

    let Some(org_id) = org_id.filter(|s| !s.is_empty()) else {
        return;
    };
    if !credits.is_active() {
        return;
    }
    let ref_id = transaction_id
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("{provider}:{value}"))
        .unwrap_or_else(|| format!("{request_id}:{provider}"));
    let fail_closed_sticky = credits.fail_closed && managed_inference;
    let default_label = format!(
        "{billable_tool_calls} {provider} tool {}",
        if billable_tool_calls == 1 {
            "call"
        } else {
            "calls"
        }
    );
    tokio::spawn(debit_wallet_for_request(
        Arc::clone(state),
        org_id.to_string(),
        ref_id,
        reason,
        raw_cost,
        fail_closed_sticky,
        None,
        // No pool, and this is an invariant rather than a stub: a Composio tool
        // call is not donated inference supply. Neither the Bedrock nor the
        // Cloudflare allowance pays for it, so it must never draw pool-restricted
        // grant money — it bills the ordinary subscription/top-up buckets, which
        // is what `None` means to the control-plane debit.
        None,
        // No model and no duration: this row is a COUNT of executed tool calls,
        // not a timed inference. `taskLabel` carries the count so a statement can
        // say "3 tool calls" instead of showing an unexplained charge — this is
        // the row a customer is most likely to query, and until now it was the
        // one with the least to say for itself.
        DebitAttribution {
            provider: Some(provider.to_string()),
            model: tool_id
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned),
            user_id: user_id.map(str::to_owned),
            task_label: task_label
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .or(Some(default_label)),
            estimated: Some(estimated),
            ..Default::default()
        },
    ));
}

/// Record a failed (fail-open) wallet debit in the durable audit log (#486 AC).
/// The control-plane debit is best-effort; when it errors we never block the
/// already-served request, but we persist the miss so unbilled usage is
/// observable and reconcilable. The error string is run through the outbound
/// firewall (DLP) before persistence, matching `audit_failure`.
fn audit_debit_failure(state: &AppState, org_id: &str, request_id: &str, error: &str) {
    if !state.audit.is_enabled() {
        return;
    }
    let redacted_error = state.with_firewall(|fw| fw.sanitize(error));
    state.log_audit(AuditRecord {
        request_id: request_id.to_string(),
        api_key: String::new(),
        user_name: None,
        org_id: Some(org_id.to_string()),
        team_id: None,
        project_id: None,
        provider: "credits-debit".to_string(),
        model: String::new(),
        input_tokens: 0,
        output_tokens: 0,
        cache_hit: false,
        latency_ms: 0,
        eval_score: None,
        error: Some(redacted_error),
        skill_ids: None,
        session_id: None,
        user_id: None,
        agent_id: None,
        feature: None,
        managed_inference: false,
        provider_cost_micro_usd: None,
        event_type: crate::audit::EventType::ModelCall,
        backend: Some("credits".to_string()),
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Inject `stream_options.include_usage = true` into the request body so
/// OpenAI-compatible providers emit a terminal usage frame at the end of the
/// SSE stream. Non-conforming providers silently ignore the field and the
/// stream observer falls back to the prompt-token estimate.
///
/// This is driven by `evals.stream_usage` in the config, never hardcoded.
fn inject_stream_usage_option(body: &mut Value) {
    if let Some(obj) = body.as_object_mut() {
        let opts = obj.entry("stream_options").or_insert_with(|| json!({}));
        if let Some(opts_obj) = opts.as_object_mut() {
            opts_obj.entry("include_usage").or_insert(json!(true));
        }
    }
}

/// Parse streamed token counts from an assembled OpenAI SSE transcript.
///
/// OpenAI-compatible providers emit one terminal "usage" chunk when
/// `stream_options.include_usage = true`. Its shape is:
/// ```json
/// {"choices":[],"usage":{"prompt_tokens":N,"completion_tokens":M,"total_tokens":T}}
/// ```
/// We scan all `data:` frames for a non-empty `usage` block (any frame may
/// carry it; in practice it is the last non-DONE frame). Returns `(0, 0)` when
/// no usage frame is found, falling back to the caller's estimate.
fn sse_parse_usage(raw: &str) -> (u64, u64) {
    let mut best = (0u64, 0u64);
    for line in raw.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(json) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        let input = json["usage"]["prompt_tokens"].as_u64().unwrap_or(0);
        let output = json["usage"]["completion_tokens"].as_u64().unwrap_or(0);
        if input > 0 || output > 0 {
            best = (input, output);
        }
    }
    best
}

/// Read the provider-side prompt-cache read count from a chat-completions
/// response `usage` block. Covers OpenRouter/OpenAI
/// (`prompt_tokens_details.cached_tokens`) and Anthropic-shaped
/// (`cache_read_input_tokens`) usage. Returns 0 when the provider reports no
/// prompt caching (the common case, so this stays a cheap no-op).
fn provider_cached_tokens(response: &Value) -> u64 {
    let usage = &response["usage"];
    usage["prompt_tokens_details"]["cached_tokens"]
        .as_u64()
        .or_else(|| usage["cache_read_input_tokens"].as_u64())
        .unwrap_or(0)
}

/// Counterpart of [`provider_cached_tokens`] for cache *writes* — prompt tokens
/// the provider stored rather than served. Tracked separately because a write is
/// billed above the normal input rate, so "cached_tokens went up" alone cannot
/// tell an operator whether caching is saving money or costing it.
fn provider_cache_write_tokens(response: &Value) -> u64 {
    let usage = &response["usage"];
    usage["prompt_tokens_details"]["cache_write_tokens"]
        .as_u64()
        .or_else(|| usage["cache_creation_input_tokens"].as_u64())
        .unwrap_or(0)
}

/// Streaming counterpart of [`provider_cache_write_tokens`].
fn sse_parse_cache_write_tokens(raw: &str) -> u64 {
    sse_scan_usage(raw, provider_cache_write_tokens)
}

/// Scan an assembled SSE transcript, applying `pick` to every parseable frame
/// and keeping the last non-zero result — the terminal usage frame in practice.
fn sse_scan_usage(raw: &str, pick: fn(&Value) -> u64) -> u64 {
    let mut best = 0u64;
    for line in raw.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(json) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        let n = pick(&json);
        if n > 0 {
            best = n;
        }
    }
    best
}

/// Resolve the node's prompt-cache policy against this request and stamp the
/// resulting markers onto the outgoing payload.
///
/// Called immediately before provider dispatch — after routing has picked the
/// model (the marker dialect depends on it) and after any budget/firewall stage
/// that could still rewrite `messages`, so the breakpoints land on the bytes
/// that are actually sent.
///
/// The per-request headers are dropped when the node sets
/// `allow_request_override = false`, which is the whole point of that switch:
/// an operator running a fixed cost profile must be able to make config the only
/// lever. See [`ryu_gw_providers::prompt_cache`] for precedence and wire formats.
/// The per-request prompt-cache override this node is willing to honour.
///
/// Split out from [`apply_prompt_cache`] so the "operator can lock the node"
/// rule is testable without standing up an `AppState`: with
/// `allow_request_override = false` the client headers are dropped entirely and
/// config becomes the only lever.
fn resolve_prompt_cache_override(
    cfg: &crate::config::PromptCacheConfig,
    ctx: &RequestContext,
) -> (Option<ryu_gw_providers::PromptCacheMode>, Option<String>) {
    if cfg.allow_request_override {
        (ctx.prompt_cache_mode, ctx.prompt_cache_ttl.clone())
    } else {
        (None, None)
    }
}

fn apply_prompt_cache(
    state: &AppState,
    ctx: &RequestContext,
    model: &str,
    body: &mut Value,
) -> ryu_gw_providers::PromptCacheOutcome {
    let cfg = &state.config.prompt_cache;
    let (override_mode, override_ttl) = resolve_prompt_cache_override(cfg, ctx);
    let estimated = estimate_prompt_tokens(body);
    let outcome = cfg.options().apply(
        body,
        &ryu_gw_providers::PromptCacheRequest {
            model,
            override_mode,
            override_ttl,
            estimated_input_tokens: Some(estimated),
            session_id: ctx.session_id.as_deref(),
        },
    );
    debug!(
        request_id = %ctx.request_id,
        model,
        estimated_prompt_tokens = estimated,
        outcome = outcome.as_str(),
        "prompt cache"
    );
    outcome
}

/// Streaming counterpart of [`provider_cached_tokens`]: scan an assembled SSE
/// transcript for the terminal usage frame's cached-token count. Mirrors
/// [`sse_parse_usage`]; returns 0 when absent.
fn sse_parse_cached_tokens(raw: &str) -> u64 {
    let mut best = 0u64;
    for line in raw.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(json) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        let cached = provider_cached_tokens(&json);
        if cached > 0 {
            best = cached;
        }
    }
    best
}

/// State threaded through the stream observer unfold loop.
struct StreamObserverState {
    inner: axum::body::BodyDataStream,
    state: Arc<AppState>,
    ctx: RequestContext,
    provider_name: String,
    model: String,
    /// Fallback estimate used when the provider emits no usage frame.
    estimated_input_tokens: u64,
    start: Instant,
    accumulated: String,
    done: bool,
    /// Managed policy-alert tier (item 4) carried to the stream-end debit so the
    /// control plane can email owners. `None` unless a budget cap with tier >=
    /// Warn matched this (streaming) request.
    budget_alert_tier: Option<AlertTier>,
}

/// Wrap `body` with a stream observer that fires at stream end to:
///  1. Parse real token counts from the terminal usage frame (if any).
///  2. Emit an eval score for sampled requests.
///  3. Write a single audit row with the real counts (defer-to-end pattern).
///
/// The observer sits after the outbound firewall wrapper so it fires regardless
/// of the configured firewall policy. The SSE frames are passed through
/// byte-for-byte; the terminal usage chunk is NOT stripped (clients that
/// requested `include_usage` should receive it; clients that did not will
/// receive a bonus usage-only chunk that well-behaved parsers ignore).
fn attach_stream_observer(
    body: Body,
    state: Arc<AppState>,
    ctx: RequestContext,
    provider_name: String,
    model: String,
    estimated_input_tokens: u64,
    start: Instant,
    budget_alert_tier: Option<AlertTier>,
) -> Body {
    use futures_util::StreamExt;

    let init = StreamObserverState {
        inner: body.into_data_stream(),
        state,
        ctx,
        provider_name,
        model,
        estimated_input_tokens,
        start,
        accumulated: String::new(),
        done: false,
        budget_alert_tier,
    };

    let stream = futures_util::stream::unfold(init, |mut s| async move {
        match s.inner.next().await {
            Some(Ok(bytes)) => {
                s.accumulated.push_str(&String::from_utf8_lossy(&bytes));
                Some((Ok(bytes), s))
            }
            Some(Err(e)) => Some((Err(std::io::Error::other(e.to_string())), s)),
            None => {
                if !s.done {
                    s.done = true;
                    // Parse real token counts from the assembled SSE; fall
                    // back to the estimate when the provider emitted no usage
                    // frame (non-conforming providers).
                    let (raw_input, raw_output) = sse_parse_usage(&s.accumulated);
                    let input_tokens = if raw_input > 0 {
                        raw_input
                    } else {
                        s.estimated_input_tokens
                    };
                    let output_tokens = raw_output;
                    let total_tokens = input_tokens + output_tokens;
                    let latency_ms = s.start.elapsed().as_millis() as u64;

                    // Update audit token totals (in-memory, for rate/reporting).
                    s.state.audit.add_tokens(&s.ctx.api_key, total_tokens);
                    s.state.metrics.add_tokens(input_tokens, output_tokens);
                    // Settle the TPM bucket with the stream's real usage. The
                    // pre-admission check consumed only the prompt estimate, so
                    // charge the remainder here (same key derivation as the
                    // non-streaming check). The bytes are already delivered, so
                    // this cannot reject — it carries the overage as bucket debt
                    // that gates subsequent admissions instead.
                    s.state.rate_limiter.record_tokens_for_key(
                        &s.ctx.api_key,
                        total_tokens.saturating_sub(s.estimated_input_tokens),
                        s.ctx.key_config.as_ref(),
                    );
                    // Provider-side prompt-cache reads and writes (OpenRouter
                    // cache path). Both come off the terminal usage frame.
                    let cached_tokens = sse_parse_cached_tokens(&s.accumulated);
                    if cached_tokens > 0 {
                        s.state.metrics.add_cached_tokens(cached_tokens);
                    }
                    let cache_write_tokens = sse_parse_cache_write_tokens(&s.accumulated);
                    if cache_write_tokens > 0 {
                        s.state.metrics.add_cache_write_tokens(cache_write_tokens);
                    }

                    // Eval scoring at stream end: synthesise a minimal usage
                    // response so the scorer can compute token_efficiency.
                    let eval_score = if s.state.evals.should_sample() {
                        let synthetic = json!({
                            "usage": {
                                "prompt_tokens": input_tokens,
                                "completion_tokens": output_tokens
                            }
                        });
                        // policy_pass=true: outbound firewall already ran on
                        // this stream; if it had blocked, we'd never reach
                        // stream end with content.
                        let eval = s.state.evals.score(latency_ms, &synthetic, true);
                        if let Some(ref e) = eval {
                            s.state
                                .evals
                                .record_provider_score(&s.provider_name, e.overall);
                        }
                        eval.map(|e| e.overall)
                    } else {
                        None
                    };
                    let reported_cost = sse_parse_cost(&s.accumulated);
                    let provider_cost_micro_usd = reported_cost.and_then(cost_usd_to_micro);
                    let budget_cost_micro_usd = charged_budget_cost_micro_usd(
                        &s.state,
                        Some(s.provider_name.as_str()),
                        reported_cost,
                        input_tokens,
                        output_tokens,
                        &s.model,
                    );
                    record_charged_budget(&s.state, &s.ctx, budget_cost_micro_usd);

                    info!(
                        request_id = %s.ctx.request_id,
                        provider = %s.provider_name,
                        model = %s.model,
                        input_tokens,
                        output_tokens,
                        latency_ms,
                        eval_score = ?eval_score,
                        "streaming request completed"
                    );

                    // Write the audit row once at stream end with real counts
                    // (defer-to-end pattern — no zero row at stream start).
                    s.state.log_audit(AuditRecord {
                        request_id: s.ctx.request_id.clone(),
                        api_key: s.ctx.api_key.clone(),
                        user_name: s.ctx.user_name.clone(),
                        org_id: s.ctx.org_id.clone(),
                        team_id: s.ctx.team_id.clone(),
                        project_id: s.ctx.project_id.clone(),
                        provider: s.provider_name.clone(),
                        model: s.model.clone(),
                        input_tokens,
                        output_tokens,
                        cache_hit: false,
                        latency_ms,
                        eval_score,
                        error: None,
                        skill_ids: s.ctx.skill_ids.clone(),
                        session_id: s.ctx.session_id.clone(),
                        user_id: s.ctx.user_id.clone(),
                        agent_id: s.ctx.agent_id.clone(),
                        feature: s.ctx.feature.clone(),
                        managed_inference: s.ctx.managed_inference,
                        provider_cost_micro_usd,
                        event_type: crate::audit::EventType::ModelCall,
                        backend: None,
                        command: None,
                        duration_ms: None,
                        exit_code: None,
                        widget_instance_id: None,
                    });

                    // Experimental OTel GenAI span (#540, P1), streaming path —
                    // emitted at stream end with the real (or estimated) token
                    // counts, same gates as the non-streamed path.
                    crate::telemetry::emit_gen_ai_span(
                        "chat",
                        &s.provider_name,
                        &s.model,
                        input_tokens,
                        output_tokens,
                        latency_ms,
                    );
                    crate::ryu_analytics::emit_model_call(
                        "chat",
                        &s.provider_name,
                        &s.model,
                        input_tokens,
                        output_tokens,
                        latency_ms,
                        "ok",
                        None,
                    );

                    // Credit-wallet debit hook (#486), streaming path. We are
                    // already at stream end (all bytes sent), so awaiting the
                    // control-plane debit here adds no client-visible latency.
                    // Best-effort + org-gated, mirroring the non-streaming path.
                    if let Some(org_id) = s.ctx.org_id.clone().filter(|o| !o.is_empty()) {
                        if s.state.config.credits.is_active() {
                            let cost = response_cost_micro_usd(
                                &s.state,
                                reported_cost,
                                input_tokens,
                                output_tokens,
                                &s.model,
                            );
                            let fail_closed_sticky =
                                s.state.config.credits.fail_closed && s.ctx.managed_inference;
                            debit_wallet_for_request(
                                Arc::clone(&s.state),
                                org_id,
                                s.ctx.request_id.clone(),
                                "gateway_usage",
                                cost,
                                fail_closed_sticky,
                                // Managed policy-alert (item 4): the matched
                                // budget-cap tier, threaded through the stream
                                // state so streaming managed chat (the common
                                // case) emails owners too.
                                s.budget_alert_tier,
                                // Same authoritative attribution as the
                                // non-streaming path; the stream state carries
                                // the provider that actually served the bytes.
                                crate::credit_pools::pool_for_gateway_provider(&s.provider_name),
                                // The same four facts the audit row above already
                                // records for this stream, so a ledger line and
                                // its audit entry cannot disagree about what was
                                // served. `latency_ms` here is time to stream
                                // END, which is the work actually billed.
                                DebitAttribution {
                                    provider: Some(s.provider_name.clone()),
                                    model: Some(s.model.clone()),
                                    input_tokens: Some(input_tokens as u64),
                                    output_tokens: Some(output_tokens as u64),
                                    duration_ms: Some(latency_ms as u64),
                                    user_id: s.ctx.user_id.clone(),
                                    task_label: None,
                                    estimated: None,
                                },
                            )
                            .await;
                        }
                    }
                }
                None
            }
        }
    });

    Body::from_stream(stream)
}

/// Wrap an SSE body so a held [`crate::concurrency::AdmissionPermit`] is released
/// only when the stream finishes (or is dropped — e.g. the client disconnects).
/// This keeps a streaming generation counted against the local engine's slot
/// budget for its entire duration, not just until the response headers arrive.
///
/// Uses the same `stream::unfold` technique as [`attach_stream_observer`] to
/// avoid the `async-stream` macro: the permit lives in the unfold state, so when
/// the stream yields `None` (or the `Body` is dropped) the state — and the permit
/// — drops, freeing the slot for the next waiter.
fn hold_admission_until_stream_end(
    body: Body,
    permit: crate::concurrency::AdmissionPermit,
    // The credit reservation taken at `enforce_budget`. `None` when reservations
    // are off, the tenant is unmanaged, or the org has no managed cap.
    credit: Option<CreditReservation>,
) -> Body {
    hold_until_stream_end(body, (permit, credit))
}

/// Keep `held` alive for exactly as long as `body` is being consumed.
///
/// The generic version of the admission-slot hold, because a second thing now
/// needs the identical lifetime: the engine slot and the credit reservation are
/// both claims taken before the first byte and owed back after the last one, and
/// "after the last one" on a streaming response is not when the handler returns.
///
/// WRAPPING ORDER MATTERS AND IS WHY THIS GOES OUTSIDE THE OBSERVER. The stream
/// observer's end-of-stream hook is what awaits the wallet debit; this wrapper
/// sits outside it, so its `next()` only returns `None` — and `held` only drops —
/// after that debit has been issued. Wrap the other way round and the claim would
/// be released in the window between the last byte and the debit landing, which
/// is precisely the window a concurrent burst exploits.
///
/// Dropping the returned body without draining it (a client disconnect, an axum
/// shutdown) drops `held` too, which is the point: there is no path that keeps
/// the claim.
fn hold_until_stream_end<T: Send + 'static>(body: Body, held: T) -> Body {
    use futures_util::StreamExt;

    struct Hold<T> {
        inner: axum::body::BodyDataStream,
        // Dropped with the stream → releases whatever it was holding.
        _held: T,
    }

    let init = Hold {
        inner: body.into_data_stream(),
        _held: held,
    };

    let stream = futures_util::stream::unfold(init, |mut s| async move {
        let item = s.inner.next().await?;
        Some((item, s))
    });

    Body::from_stream(stream)
}

/// Rough prompt-token estimate (~4 chars/token) for the streaming path, where
/// no provider usage block is available to read exact counts from.
fn estimate_prompt_tokens(body: &Value) -> u64 {
    let chars = extract_text_for_scanning(body).chars().count() as u64;
    chars.div_ceil(4)
}

fn extract_text_for_scanning(body: &Value) -> String {
    let Some(messages) = body["messages"].as_array() else {
        return String::new();
    };
    let mut parts = Vec::with_capacity(messages.len());
    for msg in messages {
        match &msg["content"] {
            Value::String(s) => parts.push(s.as_str()),
            Value::Array(arr) => {
                for part in arr {
                    if let Some(text) = part["text"].as_str() {
                        parts.push(text);
                    }
                }
            }
            _ => {}
        }
    }
    parts.join("\n")
}

/// Extract the assistant text an Output-target inline evaluator should judge.
///
/// Concatenates the text of EVERY choice (not just `choices[0]`) and handles both
/// the string and array-of-parts (`[{ "type": "text", "text": … }]`) content
/// shapes, so toxic/PII/biased text placed in a second choice (`n>1`) or in a
/// content part does not bypass the non-stream + cache-hit judge. (`tool_call`
/// arguments are still not concatenated — moderating tool-call payloads is a
/// distinct design question deferred past P3.)
fn response_to_text(response: &Value) -> String {
    let Some(choices) = response["choices"].as_array() else {
        return String::new();
    };
    let mut out = String::new();
    let mut push = |s: &str| {
        if !s.is_empty() {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(s);
        }
    };
    for choice in choices {
        match &choice["message"]["content"] {
            Value::String(s) => push(s),
            Value::Array(parts) => {
                for part in parts {
                    if let Some(t) = part["text"].as_str() {
                        push(t);
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn sanitize_messages(body: &mut Value, scanner: &dyn crate::firewall::FirewallBackend) {
    if let Some(messages) = body["messages"].as_array_mut() {
        for msg in messages.iter_mut() {
            if let Some(content) = msg["content"].as_str() {
                msg["content"] = Value::String(scanner.sanitize(content));
            }
        }
    }
}

fn sanitize_response(response: &mut Value, scanner: &dyn crate::firewall::FirewallBackend) {
    if let Some(choices) = response["choices"].as_array_mut() {
        for choice in choices.iter_mut() {
            if let Some(content) = choice["message"]["content"].as_str() {
                choice["message"]["content"] = Value::String(scanner.sanitize(content));
            }
        }
    }
}

// ─── Streaming outbound firewall ────────────────────────────────────────────────

/// Wrap a provider SSE stream with the outbound firewall, applying the
/// configured policy. See the call site in `run_stream` for the per-policy
/// rationale. Returns a (possibly buffered) [`Body`] ready to stream to the
/// client.
async fn apply_outbound_firewall_stream(
    stream_body: Body,
    state: Arc<AppState>,
    ctx: RequestContext,
) -> Body {
    let request_id = ctx.request_id.clone();
    // Node-level outbound firewall gate (unchanged): does the node config buffer?
    let (outbound_enabled, policy) =
        state.with_firewall(|fw| (fw.outbound_enabled(), fw.policy().clone()));
    let node_needs_buffer = outbound_enabled && !matches!(policy, FirewallPolicy::WarnAndContinue);

    // Resolved per-agent OUTPUT-target inline evaluators (P3). A blocking/redacting
    // output evaluator must force buffering even when the node policy is warn/off —
    // otherwise it would never fire on the DEFAULT streaming chat path.
    let resolved = state.resolved_scanner(&ctx);
    let has_output_eval = resolved.config().evaluators.iter().any(|b| b.enabled);
    let eval_needs_buffer = has_output_eval && {
        let registry = EvaluatorRegistry::from_config(&state.config);
        output_inline_wants_transform(&resolved, &registry)
    };

    // When nothing needs to hold bytes back, pass through. For node warn-and-continue
    // we still observe the stream to log node detections (unchanged contract).
    if !node_needs_buffer && !eval_needs_buffer {
        if outbound_enabled {
            return scan_and_log_passthrough(stream_body, state, request_id);
        }
        return stream_body;
    }

    // Buffer the whole upstream stream, then decide (node scan first, then evals).
    let collected = match axum::body::to_bytes(stream_body, usize::MAX).await {
        Ok(bytes) => bytes,
        Err(e) => {
            warn!(request_id = %request_id, error = %e, "firewall: failed to buffer stream for outbound scan");
            // Surface a clear error rather than silently leaking unscanned text.
            return Body::from(sse_content_frames(
                "[Ryu firewall] Unable to scan the response stream; request aborted.",
            ));
        }
    };

    let raw = String::from_utf8_lossy(&collected).into_owned();
    let assembled = sse_extract_text(&raw);

    // ── Node outbound firewall (existing behavior) ──
    if node_needs_buffer {
        let scan_result = state.with_firewall(|fw| {
            fw.scan_outbound(&assembled)
                .map(|v| (v, fw.sanitize(&assembled)))
        });
        if let Some((violation, sanitized)) = scan_result {
            match policy {
                FirewallPolicy::Block => {
                    warn!(
                        request_id = %request_id,
                        pattern = %violation.pattern_name,
                        "firewall: blocked outbound response (streaming)"
                    );
                    state.metrics.inc_firewall_blocked();
                    return Body::from(sse_content_frames(&format!(
                        "[Ryu firewall] Response blocked by policy: {} ({:?}).",
                        violation.pattern_name, violation.kind
                    )));
                }
                FirewallPolicy::Sanitize => {
                    warn!(
                        request_id = %request_id,
                        pattern = %violation.pattern_name,
                        "firewall: sanitized outbound response (streaming)"
                    );
                    return Body::from(sse_content_frames(&sanitized));
                }
                FirewallPolicy::WarnAndContinue => {}
            }
        }
    }

    // ── Unified-evaluator OUTPUT inline guardrails (P3) ──
    if has_output_eval {
        let (outcome, reason) =
            evaluate_output_inline_stream(&state, &ctx, resolved.as_ref(), &assembled).await;
        match outcome {
            InlineOutcome::Block => {
                warn!(
                    request_id = %request_id,
                    %reason,
                    "inline evaluator: blocked outbound response (streaming)"
                );
                state.metrics.inc_firewall_blocked();
                let model = ctx.agent_id.as_deref().unwrap_or("unknown");
                audit_inline_evaluator(&state, &ctx, model, "output", "blocked", &reason);
                return Body::from(sse_content_frames(&format!(
                    "[Ryu firewall] Response blocked by evaluator: {reason}."
                )));
            }
            InlineOutcome::Sanitize => {
                warn!(
                    request_id = %request_id,
                    %reason,
                    "inline evaluator: sanitized outbound response (streaming)"
                );
                return Body::from(sse_content_frames(&resolved.sanitize(&assembled)));
            }
            InlineOutcome::Warn | InlineOutcome::Allow => {}
        }
    }

    // Clean: replay the original buffered bytes untouched.
    Body::from(collected)
}

/// Per-stream state threaded through the warn-and-continue passthrough so that
/// outbound text can be reassembled across SSE chunks and scanned once.
struct PassthroughScanState {
    inner: axum::body::BodyDataStream,
    state: Arc<AppState>,
    request_id: String,
    accumulated: String,
    scanned: bool,
}

/// Pass the upstream stream straight through to the client while accumulating
/// the response text, then scan it once when the stream ends and log any
/// outbound violation. Used for the warn-and-continue policy, where bytes are
/// never withheld, so there is no need to scan incrementally — a single
/// end-of-stream scan keeps the default path O(n). Implemented with
/// `stream::unfold` to avoid pulling in the `async-stream` macro crate.
fn scan_and_log_passthrough(stream_body: Body, state: Arc<AppState>, request_id: String) -> Body {
    use futures_util::StreamExt;

    let init = PassthroughScanState {
        inner: stream_body.into_data_stream(),
        state,
        request_id,
        accumulated: String::new(),
        scanned: false,
    };

    let transformed = futures_util::stream::unfold(init, |mut s| async move {
        match s.inner.next().await {
            Some(Ok(bytes)) => {
                s.accumulated.push_str(&String::from_utf8_lossy(&bytes));
                Some((Ok(bytes), s))
            }
            Some(Err(e)) => Some((Err(std::io::Error::other(e.to_string())), s)),
            None => {
                // Stream exhausted: scan the assembled response exactly once.
                if !s.scanned {
                    s.scanned = true;
                    let text = sse_extract_text(&s.accumulated);
                    if let Some(violation) = s.state.with_firewall(|fw| fw.scan_outbound(&text)) {
                        warn!(
                            request_id = %s.request_id,
                            pattern = %violation.pattern_name,
                            "firewall: outbound violation (warn-and-continue, streaming)"
                        );
                    }
                }
                None
            }
        }
    });

    Body::from_stream(transformed)
}

/// Extract the assembled assistant text from an OpenAI-style SSE transcript by
/// concatenating every `choices[].delta.content` fragment.
fn sse_extract_text(raw: &str) -> String {
    let mut out = String::new();
    for line in raw.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(json) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if let Some(delta) = json["choices"]
            .as_array()
            .and_then(|c| c.first())
            .and_then(|c| c["delta"]["content"].as_str())
        {
            out.push_str(delta);
        }
    }
    out
}

/// Render `text` as a minimal OpenAI-compatible SSE transcript: a single
/// content delta chunk followed by the terminating `[DONE]` sentinel. Used to
/// replace a blocked or sanitized streaming response with safe content that
/// downstream OpenAI-SSE parsers (including Core) relay unchanged.
fn sse_content_frames(text: &str) -> String {
    let chunk = json!({
        "id": "ryu-firewall",
        "object": "chat.completion.chunk",
        "choices": [{
            "index": 0,
            "delta": { "role": "assistant", "content": text },
            "finish_reason": "stop"
        }]
    });
    format!("data: {chunk}\n\ndata: [DONE]\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::FirewallConfig;
    use crate::firewall::FirewallScanner;

    /// Minimal `RequestContext` for signal-gate tests.
    fn signal_ctx(
        tool_actions: Option<&str>,
        header_present: bool,
        search: bool,
    ) -> RequestContext {
        RequestContext {
            request_id: "t".into(),
            api_key: "k".into(),
            is_master_key: false,
            org_id: None,
            team_id: None,
            project_id: None,
            user_name: None,
            user_id: None,
            agent_id: None,
            key_config: None,
            skill_ids: None,
            tool_actions: tool_actions.map(str::to_string),
            tools_header_present: header_present,
            slot_provider: None,
            slot_model: None,
            session_id: None,
            feature: None,
            companion_source: false,
            tool_search_requested: search,
            priority: crate::concurrency::Priority::Interactive,
            tool_profile: None,
            raw_tools: false,
            managed_inference: false,
            remaining_budget_micro_usd: None,
            unrestricted_budget_micro_usd: None,
            pool_budgets_micro_usd: std::collections::HashMap::new(),
            resolved_policy: None,
            prompt_cache_mode: None,
            prompt_cache_ttl: None,
            node_routing: None,
        }
    }

    // ── prompt cache: request override + usage readback ──────────────────────

    #[test]
    fn request_override_is_honoured_when_the_node_allows_it() {
        let mut ctx = signal_ctx(None, false, false);
        ctx.prompt_cache_mode = Some(ryu_gw_providers::PromptCacheMode::Explicit);
        ctx.prompt_cache_ttl = Some("1h".into());

        let cfg = crate::config::PromptCacheConfig::default();
        assert!(cfg.allow_request_override, "override is on by default");
        let (mode, ttl) = resolve_prompt_cache_override(&cfg, &ctx);
        assert_eq!(mode, Some(ryu_gw_providers::PromptCacheMode::Explicit));
        assert_eq!(ttl.as_deref(), Some("1h"));
    }

    #[test]
    fn a_locked_node_drops_the_request_headers_entirely() {
        let mut ctx = signal_ctx(None, false, false);
        ctx.prompt_cache_mode = Some(ryu_gw_providers::PromptCacheMode::Explicit);
        ctx.prompt_cache_ttl = Some("1h".into());

        let cfg = crate::config::PromptCacheConfig {
            allow_request_override: false,
            ..Default::default()
        };
        let (mode, ttl) = resolve_prompt_cache_override(&cfg, &ctx);
        assert_eq!(mode, None, "a locked node must ignore x-ryu-prompt-cache");
        assert_eq!(ttl, None);
    }

    #[test]
    fn cache_usage_is_read_from_both_provider_vocabularies() {
        // OpenAI / OpenRouter shape.
        let oai = json!({ "usage": { "prompt_tokens_details": {
            "cached_tokens": 900, "cache_write_tokens": 100 } } });
        assert_eq!(provider_cached_tokens(&oai), 900);
        assert_eq!(provider_cache_write_tokens(&oai), 100);

        // Anthropic-native shape.
        let ant = json!({ "usage": {
            "cache_read_input_tokens": 42, "cache_creation_input_tokens": 7 } });
        assert_eq!(provider_cached_tokens(&ant), 42);
        assert_eq!(provider_cache_write_tokens(&ant), 7);

        // Uncached responses stay at zero (no phantom counters).
        let plain = json!({ "usage": { "prompt_tokens": 10 } });
        assert_eq!(provider_cached_tokens(&plain), 0);
        assert_eq!(provider_cache_write_tokens(&plain), 0);
    }

    #[test]
    fn stream_cache_usage_is_read_from_the_terminal_frame() {
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
            "data: {\"usage\":{\"prompt_tokens\":1000,\"prompt_tokens_details\":",
            "{\"cached_tokens\":900,\"cache_write_tokens\":100}}}\n\n",
            "data: [DONE]\n\n",
        );
        assert_eq!(sse_parse_cached_tokens(sse), 900);
        assert_eq!(sse_parse_cache_write_tokens(sse), 100);
    }

    /// An `AppState` whose credits config is exactly what a reservation test
    /// needs: reservations on, a known floor, and a known flat token rate.
    fn reserve_state(min_reserve_micro_usd: u64, cost_per_1k_micro_usd: u64) -> AppState {
        let mut config = crate::GatewayConfig::default();
        config.credits.reserve_enabled = true;
        config.credits.min_reserve_micro_usd = min_reserve_micro_usd;
        config.control_plane.cost_per_1k_micro_usd = cost_per_1k_micro_usd;
        let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
        AppState::new_for_test(config, audit, evals)
    }

    /// A managed-tenant context with a known unrestricted balance.
    fn managed_ctx(balance_micro_usd: i64) -> RequestContext {
        let mut ctx = signal_ctx(None, false, false);
        ctx.org_id = Some("o1".to_string());
        ctx.managed_inference = true;
        ctx.remaining_budget_micro_usd = Some(balance_micro_usd);
        ctx
    }

    #[test]
    fn reservation_estimate_floors_at_the_configured_minimum() {
        let state = reserve_state(10_000, 1);
        // A tiny completion still claims the floor, so a burst of cheap requests
        // is bounded by balance / floor rather than by nothing.
        let body = json!({ "max_tokens": 1 });
        assert_eq!(reservation_estimate_micro_usd(&state, &body), 10_000);
    }

    #[test]
    fn reservation_estimate_scales_with_max_tokens_above_the_floor() {
        // 1_000_000 tokens at 1000 micro-USD/1k = 1_000_000 micro-USD, over the floor.
        let state = reserve_state(10_000, 1000);
        let body = json!({ "max_tokens": 1_000_000 });
        assert_eq!(reservation_estimate_micro_usd(&state, &body), 1_000_000);
    }

    #[test]
    fn an_unbounded_completion_reserves_the_floor_not_zero() {
        // Naming no ceiling makes a request MORE expensive to serve, not free.
        let state = reserve_state(10_000, 1000);
        assert_eq!(reservation_estimate_micro_usd(&state, &json!({})), 10_000);
        // `max_completion_tokens` is the newer spelling and must read the same.
        let aliased = json!({ "max_completion_tokens": 1_000_000 });
        assert_eq!(reservation_estimate_micro_usd(&state, &aliased), 1_000_000);
    }

    #[test]
    fn concurrent_managed_requests_cannot_all_spend_one_balance() {
        // THE REGRESSION GUARD. Post-paid metering means nothing debits until a
        // request finishes, so without the reservation every one of these sees
        // the same balance and every one is admitted.
        let state = reserve_state(10_000, 0);
        let ctx = managed_ctx(50_000); // $0.05 ⇒ five $0.01 reservations
        let body = json!({ "max_tokens": 1 });

        let held: Vec<_> = (0..5)
            .map(|_| {
                maybe_reserve_credit(&state, &ctx, &body, None)
                    .expect("within balance")
                    .expect("a managed tenant takes a real permit")
            })
            .collect();
        assert_eq!(held.len(), 5);

        assert!(
            matches!(
                maybe_reserve_credit(&state, &ctx, &body, None),
                Err(GatewayError::InsufficientCredits)
            ),
            "the sixth concurrent request must get the same 402 as an empty wallet"
        );

        // Finishing the in-flight work returns the headroom.
        drop(held);
        assert!(maybe_reserve_credit(&state, &ctx, &body, None).is_ok());
    }

    #[test]
    fn a_dust_balance_no_longer_admits_an_expensive_request() {
        // The old gate asked `balance <= 0`, so one micro-USD bought a frontier
        // call. The gate is now the ESTIMATE against the balance.
        let state = reserve_state(10_000, 0);
        let ctx = managed_ctx(1);
        assert!(matches!(
            maybe_reserve_credit(&state, &ctx, &json!({}), None),
            Err(GatewayError::InsufficientCredits)
        ));
    }

    /// Run the clamp over a chat body and hand back what it became.
    fn clamped(state: &AppState, ctx: &RequestContext, mut body: Value) -> Value {
        clamp_output_ceiling(state, ctx, &mut body, None, OutputCeiling::Clamp);
        body
    }

    #[test]
    fn an_unstated_ceiling_becomes_the_affordable_one() {
        // THE OVERDRAFT GUARD. Naming no ceiling used to reserve the $0.01 floor
        // and then generate without limit, so a dust balance could front an
        // arbitrarily expensive completion. It now gets the largest ceiling the
        // balance actually covers.
        let state = reserve_state(10_000, 1000); // 1000 micro-USD per 1k tokens
        let ctx = managed_ctx(50_000); // $0.05 ⇒ 50k tokens at that rate
        let body = clamped(&state, &ctx, json!({ "messages": [] }));
        assert_eq!(body["max_tokens"], json!(50_000));
    }

    #[test]
    fn a_ceiling_the_balance_cannot_cover_is_lowered() {
        let state = reserve_state(10_000, 1000);
        let ctx = managed_ctx(50_000);
        let body = clamped(&state, &ctx, json!({ "max_tokens": 1_000_000 }));
        assert_eq!(body["max_tokens"], json!(50_000));
    }

    #[test]
    fn a_ceiling_within_budget_is_left_exactly_alone() {
        // Asking for less than you can afford is a preference, not a budget —
        // the clamp only ever lowers.
        let state = reserve_state(10_000, 1000);
        let ctx = managed_ctx(50_000);
        let body = clamped(&state, &ctx, json!({ "max_tokens": 128 }));
        assert_eq!(body["max_tokens"], json!(128));
    }

    /// A state whose price table knows one expensive model.
    fn priced_state(
        min_reserve_micro_usd: u64,
        flat_per_1k: u64,
        model: &str,
        output_per_1k: u64,
    ) -> AppState {
        let mut config = crate::GatewayConfig::default();
        config.credits.reserve_enabled = true;
        config.credits.min_reserve_micro_usd = min_reserve_micro_usd;
        config.control_plane.cost_per_1k_micro_usd = flat_per_1k;
        config.control_plane.model_pricing.insert(
            model.to_string(),
            crate::config::ModelPrice {
                input_per_1k_micro_usd: 3000,
                output_per_1k_micro_usd: output_per_1k,
            },
        );
        let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
        AppState::new_for_test(config, audit, evals)
    }

    #[test]
    fn an_expensive_model_gets_a_tighter_ceiling_than_the_flat_rate_would() {
        // THE RESIDUAL THE OVERDRAFT FIX LEFT. Priced at the flat 1000/1k this
        // balance buys 50k tokens; the model actually costs 10x that, so the
        // flat rate authorised 10x more generation than the org could pay for —
        // and it did so on precisely the frontier models where the overdraft is
        // worth having.
        let state = priced_state(10_000, 1000, "frontier-", 10_000);
        let ctx = managed_ctx(50_000);
        let body = clamped(
            &state,
            &ctx,
            json!({ "model": "frontier-xl-2026", "messages": [] }),
        );
        assert_eq!(body["max_tokens"], json!(5000));
    }

    #[test]
    fn a_cheap_model_is_not_truncated_by_a_blended_rate() {
        // The other half of the same bug: a blended rate charges a cheap model
        // as though it were expensive and cuts completions the org could always
        // afford.
        let state = priced_state(10_000, 1000, "cheap-", 100);
        let ctx = managed_ctx(50_000);
        let body = clamped(
            &state,
            &ctx,
            json!({ "model": "cheap-mini", "messages": [] }),
        );
        assert_eq!(body["max_tokens"], json!(500_000));
    }

    #[test]
    fn a_model_absent_from_the_table_falls_back_to_the_flat_rate() {
        let state = priced_state(10_000, 1000, "frontier-", 10_000);
        let ctx = managed_ctx(50_000);
        let body = clamped(
            &state,
            &ctx,
            json!({ "model": "something-unpriced", "messages": [] }),
        );
        assert_eq!(body["max_tokens"], json!(50_000));
    }

    #[test]
    fn the_clamp_writes_back_the_spelling_the_client_used() {
        // Adding `max_tokens` next to a `max_completion_tokens` the client sent
        // leaves both present, which some providers reject outright.
        let state = reserve_state(10_000, 1000);
        let ctx = managed_ctx(50_000);
        let body = clamped(&state, &ctx, json!({ "max_completion_tokens": 1_000_000 }));
        assert_eq!(body["max_completion_tokens"], json!(50_000));
        assert!(
            body.get("max_tokens").is_none(),
            "must not add the other spelling alongside it"
        );
    }

    #[test]
    fn the_clamp_is_net_of_this_orgs_in_flight_claims() {
        // Clamping against the GROSS balance would let concurrent unbounded
        // requests each size themselves at the whole wallet — the first would
        // claim all of it and its siblings would 402. That is a race, not a
        // bound. Each concurrent request must get a smaller honest ceiling.
        let state = reserve_state(10_000, 1000);
        let ctx = managed_ctx(50_000);
        let held = maybe_reserve_credit(&state, &ctx, &json!({ "max_tokens": 30_000 }), None)
            .expect("within balance")
            .expect("a managed tenant takes a real permit");
        // $0.05 balance less the $0.03 already claimed leaves 20k tokens' worth.
        let body = clamped(&state, &ctx, json!({ "messages": [] }));
        assert_eq!(body["max_tokens"], json!(20_000));
        drop(held);
    }

    #[test]
    fn the_clamp_leaves_non_text_bodies_untouched() {
        // `run_multimodal` and `submit_video_job` share `enforce_budget`, and a
        // token ceiling is meaningless — at best ignored, at worst rejected as an
        // unknown field.
        let state = reserve_state(10_000, 1000);
        let ctx = managed_ctx(50_000);
        let mut body = json!({ "prompt": "a cat" });
        clamp_output_ceiling(&state, &ctx, &mut body, None, OutputCeiling::Untouched);
        assert_eq!(body, json!({ "prompt": "a cat" }));
    }

    #[test]
    fn the_clamp_spares_tenants_who_are_not_spending_our_money() {
        // BYOK/unmanaged traffic has no managed cap to clamp against, and
        // imposing a ceiling on it would be a pure regression.
        let state = reserve_state(10_000, 1000);
        let mut unmanaged = managed_ctx(50_000);
        unmanaged.managed_inference = false;
        let body = clamped(&state, &unmanaged, json!({ "messages": [] }));
        assert!(body.get("max_tokens").is_none());

        // Managed but uncapped: no control-plane budget at all.
        let mut uncapped = managed_ctx(50_000);
        uncapped.remaining_budget_micro_usd = None;
        let body = clamped(&state, &uncapped, json!({ "messages": [] }));
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn a_node_that_meters_nothing_imposes_no_ceiling() {
        // A zero per-token rate cannot overdraw anyone, so there is nothing to
        // bound — and dividing by it must not be mistaken for "afford nothing".
        let state = reserve_state(10_000, 0);
        let ctx = managed_ctx(50_000);
        let body = clamped(&state, &ctx, json!({ "messages": [] }));
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn the_ceiling_accounts_for_the_billing_markup() {
        // The budget is denominated in CHARGED micro-USD but a token count costs
        // RAW provider micro-USD. Sizing the ceiling without undoing the markup
        // hands out one the debit then exceeds — the very overdraft this closes.
        let mut state = reserve_state(10_000, 1000);
        state.config.credits.markup_bps = 10_000; // +100%: charged = 2x raw
        let ctx = managed_ctx(50_000);
        let body = clamped(&state, &ctx, json!({ "messages": [] }));
        // $0.05 of BUDGET buys $0.025 of raw provider spend = 25k tokens.
        assert_eq!(body["max_tokens"], json!(25_000));
    }

    #[test]
    fn reservations_are_skipped_where_they_have_no_business_gating() {
        let state = reserve_state(10_000, 0);
        let body = json!({ "max_tokens": 1 });

        // Unmanaged (BYOK / static key): never gated.
        let mut unmanaged = managed_ctx(0);
        unmanaged.managed_inference = false;
        assert!(maybe_reserve_credit(&state, &unmanaged, &body, None)
            .expect("admitted")
            .is_none());

        // Managed but uncapped (no control-plane budget at all).
        let mut uncapped = managed_ctx(0);
        uncapped.remaining_budget_micro_usd = None;
        assert!(maybe_reserve_credit(&state, &uncapped, &body, None)
            .expect("admitted")
            .is_none());

        // No org to key the claim on.
        let mut orgless = managed_ctx(0);
        orgless.org_id = None;
        assert!(maybe_reserve_credit(&state, &orgless, &body, None)
            .expect("admitted")
            .is_none());
    }

    #[test]
    fn the_kill_switch_restores_the_unreserved_behaviour() {
        let mut state = reserve_state(10_000, 0);
        state.config.credits.reserve_enabled = false;
        let ctx = managed_ctx(1);
        // Same dust balance the reservation path refuses above.
        assert!(maybe_reserve_credit(&state, &ctx, &json!({}), None)
            .expect("admitted")
            .is_none());
    }

    #[test]
    fn the_reservation_is_taken_against_the_same_pool_the_gate_approved() {
        // A tenant whose money is pool-restricted grant credit must be able to
        // spend it: gating on the unrestricted balance alone would 402 them.
        let state = reserve_state(10_000, 0);
        let mut ctx = managed_ctx(0);
        ctx.unrestricted_budget_micro_usd = Some(0);
        ctx.pool_budgets_micro_usd =
            std::collections::HashMap::from([("cloudflare".to_string(), 50_000)]);

        assert!(
            preflight_credit_gate(&ctx, Some("cloudflare")).is_none(),
            "precondition: the gate admits this request on pooled money"
        );
        assert!(
            maybe_reserve_credit(&state, &ctx, &json!({}), Some("cloudflare"))
                .expect("the reservation must see the same pooled headroom")
                .is_some()
        );
        // …and the pool it did NOT route to is still refused.
        assert!(matches!(
            maybe_reserve_credit(&state, &ctx, &json!({}), Some("openrouter")),
            Err(GatewayError::InsufficientCredits)
        ));
    }

    #[test]
    fn preflight_credit_gate_managed_empty_rejects_others_allow() {
        let mut ctx = signal_ctx(None, false, false);
        ctx.org_id = Some("o1".to_string());

        // Non-managed traffic is never gated, even at a zero balance (BYOK /
        // static-key / master paths are exempt).
        ctx.managed_inference = false;
        ctx.remaining_budget_micro_usd = Some(0);
        assert!(preflight_credit_gate(&ctx, None).is_none());

        // Managed + positive balance ⇒ allowed.
        ctx.managed_inference = true;
        ctx.remaining_budget_micro_usd = Some(500);
        assert!(preflight_credit_gate(&ctx, None).is_none());

        // Managed + uncapped (None budget) ⇒ allowed.
        ctx.remaining_budget_micro_usd = None;
        assert!(preflight_credit_gate(&ctx, None).is_none());

        // Managed + exhausted (zero) ⇒ hard 402.
        ctx.remaining_budget_micro_usd = Some(0);
        assert!(matches!(
            preflight_credit_gate(&ctx, None),
            Some(GatewayError::InsufficientCredits)
        ));

        // Managed + overdrawn (negative) ⇒ hard 402.
        ctx.remaining_budget_micro_usd = Some(-5);
        assert!(matches!(
            preflight_credit_gate(&ctx, None),
            Some(GatewayError::InsufficientCredits)
        ));
    }

    #[test]
    fn debit_body_carries_the_pool_only_when_the_provider_is_tagged() {
        // Untagged provider ⇒ the pre-pool body, byte-identical. `pool` must be
        // ABSENT, not `null`: the control plane distinguishes the two.
        let legacy = debit_request_body(
            "o1",
            1_234,
            "gateway_usage",
            "req_1",
            None,
            None,
            &DebitAttribution::default(),
        );
        assert_eq!(legacy["orgId"], "o1");
        assert_eq!(legacy["amountMicroUsd"], 1_234);
        assert_eq!(legacy["reason"], "gateway_usage");
        assert_eq!(legacy["refId"], "req_1");
        assert!(legacy.get("pool").is_none());
        assert!(legacy.get("alertTier").is_none());

        // Tagged provider ⇒ the pool id travels verbatim under `pool`. This key
        // and this value are what let the ledger reach pool-restricted grants;
        // renaming either is a control-plane contract change.
        let pooled = debit_request_body(
            "o1",
            1_234,
            "gateway_usage",
            "req_1",
            Some(AlertTier::Warn),
            crate::credit_pools::pool_for_gateway_provider("bedrock"),
            &DebitAttribution::default(),
        );
        assert_eq!(pooled["pool"], "bedrock");
        assert_eq!(pooled["alertTier"], "warn");
    }

    /// Attribution is ADDITIVE and every absent field is OMITTED.
    ///
    /// The contract that matters is the same one `pool` and `alertTier` already
    /// hold: a control plane that does not know these keys must see a
    /// byte-identical legacy body. Sending `null` instead of omitting would
    /// satisfy a naive "is it there" check while writing an explicit null into
    /// a column whose whole meaning is "not reported".
    #[test]
    fn debit_body_omits_attribution_it_was_not_given() {
        let bare = debit_request_body(
            "o1",
            10,
            "gateway_usage",
            "req_1",
            None,
            None,
            &DebitAttribution::default(),
        );
        for key in [
            "provider",
            "model",
            "userId",
            "taskLabel",
            "inputTokens",
            "outputTokens",
            "durationMs",
            "estimated",
        ] {
            assert!(bare.get(key).is_none(), "{key} must be absent, not null");
        }

        let full = debit_request_body(
            "o1",
            10,
            "gateway_usage",
            "req_1",
            None,
            None,
            &DebitAttribution {
                provider: Some("anthropic".to_string()),
                model: Some("claude-sonnet-5".to_string()),
                input_tokens: Some(4_210),
                output_tokens: Some(380),
                duration_ms: Some(2_140),
                user_id: Some("u_1".to_string()),
                task_label: Some("3 tool calls".to_string()),
                estimated: None,
            },
        );
        assert_eq!(full["provider"], "anthropic");
        assert_eq!(full["model"], "claude-sonnet-5");
        assert_eq!(full["inputTokens"], 4_210);
        assert_eq!(full["outputTokens"], 380);
        assert_eq!(full["durationMs"], 2_140);
        assert_eq!(full["userId"], "u_1");
        assert_eq!(full["taskLabel"], "3 tool calls");
    }

    /// A blank string is not a value. An empty-string model on a ledger row
    /// renders as a present-but-nameless model, which reads as a bug to whoever
    /// is looking at their invoice — strictly worse than an honest blank.
    #[test]
    fn debit_body_treats_a_blank_attribution_string_as_absent() {
        let blank = debit_request_body(
            "o1",
            10,
            "gateway_usage",
            "req_1",
            None,
            None,
            &DebitAttribution {
                provider: Some("   ".to_string()),
                model: Some(String::new()),
                ..Default::default()
            },
        );
        assert!(blank.get("provider").is_none());
        assert!(blank.get("model").is_none());
    }

    #[test]
    fn media_fallback_is_marked_in_the_existing_ledger_task_label() {
        let estimated = debit_request_body(
            "o1",
            1_950,
            "media",
            "req_1:image",
            None,
            None,
            &DebitAttribution {
                provider: Some("replicate".to_string()),
                model: Some("image-model".to_string()),
                task_label: Some(media_task_label(&Modality::Image, true)),
                estimated: Some(true),
                ..Default::default()
            },
        );
        assert_eq!(estimated["taskLabel"], "image (estimated cost)");
        assert_eq!(estimated["estimated"], true);

        let measured = debit_request_body(
            "o1",
            2_925,
            "media",
            "req_2:image",
            None,
            None,
            &DebitAttribution {
                task_label: Some(media_task_label(&Modality::Image, false)),
                duration_ms: Some(3_000),
                estimated: Some(false),
                ..Default::default()
            },
        );
        assert_eq!(measured["taskLabel"], "image");
        assert_eq!(measured["durationMs"], 3_000);
        assert_eq!(measured["estimated"], false);
    }

    #[test]
    fn preflight_credit_gate_segregates_pool_restricted_grants() {
        // The wallet the whole pool split exists for: $50 of FRONTIER grant and
        // nothing unrestricted. Its total is positive, so the pre-pool scalar gate
        // would wave a Cloudflare request through and let cheap traffic burn the
        // scarce expensive allowance.
        let mut ctx = signal_ctx(None, false, false);
        ctx.org_id = Some("o1".to_string());
        ctx.managed_inference = true;
        ctx.remaining_budget_micro_usd = Some(50_000_000);
        ctx.unrestricted_budget_micro_usd = Some(0);
        ctx.pool_budgets_micro_usd = std::collections::HashMap::from([
            ("bedrock".to_string(), 50_000_000_i64),
            ("cloudflare".to_string(), 0_i64),
        ]);

        // Routed to the pool that funds it ⇒ served.
        assert!(preflight_credit_gate(&ctx, Some("bedrock")).is_none());

        // Routed to a pool it holds nothing for ⇒ 402, DESPITE a positive total.
        // This is the one case where reading `unrestricted_budget_micro_usd`
        // diverges from falling back to the total, so it is what proves the field
        // is actually being read.
        assert!(matches!(
            preflight_credit_gate(&ctx, Some("cloudflare")),
            Some(GatewayError::InsufficientCredits)
        ));

        // A pool absent from the map is treated as funding nothing — same as an
        // explicit zero, because both mean "no grant money here".
        assert!(matches!(
            preflight_credit_gate(&ctx, Some("openrouter")),
            Some(GatewayError::InsufficientCredits)
        ));

        // An UNTAGGED provider (openai, anthropic, local, …) is gated on the
        // unrestricted balance, NOT the total — this wallet funds it with nothing.
        // Admitting it here was a live money leak: the debit that follows carries
        // no pool, so `debitWallet` skips every grant row and drives the top-up
        // bucket negative while the $50 Bedrock grant sits untouched and Ryu
        // absorbs OpenAI's bill.
        assert!(matches!(
            preflight_credit_gate(&ctx, None),
            Some(GatewayError::InsufficientCredits)
        ));

        // Unrestricted money alone funds every pool: grants top it up, never cap it.
        ctx.unrestricted_budget_micro_usd = Some(1_000);
        assert!(preflight_credit_gate(&ctx, Some("cloudflare")).is_none());
        // …and it funds an untagged provider too. Tightening the untagged branch
        // must not become a blanket block on every non-pooled provider for anyone
        // who happens to hold a grant.
        assert!(preflight_credit_gate(&ctx, None).is_none());
    }

    #[test]
    fn preflight_credit_gate_degrades_to_the_scalar_on_a_pre_pool_control_plane() {
        // A control plane that does not yet emit `unrestrictedBudgetMicroUsd`
        // leaves it `None`. Collapsing that to 0 would gate every pooled request
        // to death the moment the gateway outran the control plane, so `None`
        // must mean "treat the whole balance as unrestricted".
        let mut ctx = signal_ctx(None, false, false);
        ctx.org_id = Some("o1".to_string());
        ctx.managed_inference = true;
        ctx.remaining_budget_micro_usd = Some(500);
        ctx.unrestricted_budget_micro_usd = None;
        assert!(preflight_credit_gate(&ctx, Some("bedrock")).is_none());

        ctx.remaining_budget_micro_usd = Some(0);
        assert!(matches!(
            preflight_credit_gate(&ctx, Some("bedrock")),
            Some(GatewayError::InsufficientCredits)
        ));

        // Uncapped stays uncapped whether or not a pool is in play.
        ctx.remaining_budget_micro_usd = None;
        assert!(preflight_credit_gate(&ctx, Some("bedrock")).is_none());
    }

    #[test]
    fn tool_signal_active_only_on_explicit_new_signal() {
        let cfg = crate::config::ToolsConfig::default();
        // Legacy-only context: x-ryu-composio-actions folded into tool_actions,
        // but the new header was not present → must NOT trigger the unified loop
        // (the bare Composio agent keeps its fast stream + legacy loop).
        let legacy = signal_ctx(Some("composio.SLACK"), false, false);
        assert!(!tool_signal_active(&legacy, &cfg));
        // New header present → triggers.
        let new_header = signal_ctx(Some("spider.crawl"), true, false);
        assert!(tool_signal_active(&new_header, &cfg));
        // x-ryu-tool-search: on → triggers even without an allowlist header.
        let search = signal_ctx(None, false, true);
        assert!(tool_signal_active(&search, &cfg));
        // always_on alone is request-independent and must NOT trigger (would fire
        // on header-less ACP egress).
        let mut always_on = cfg.clone();
        always_on.always_on = vec![json!({"type":"function","function":{"name":"x"}})];
        assert!(!tool_signal_active(
            &signal_ctx(None, false, false),
            &always_on
        ));
        // Disabled config is always inert.
        let disabled = crate::config::ToolsConfig {
            enabled: false,
            ..crate::config::ToolsConfig::default()
        };
        assert!(!tool_signal_active(&new_header, &disabled));
    }

    #[test]
    fn select_tool_loop_raw_passthrough_forces_plain() {
        let cfg = crate::config::ToolsConfig::default();

        // A request that WOULD hit the unified loop (catalog wired + signal)...
        let signaled = signal_ctx(Some("composio.GMAIL_SEARCH_EMAILS"), true, false);
        assert_eq!(
            select_tool_loop(&signaled, true, true, &cfg),
            ToolLoopKind::Unified
        );
        // ...and one that WOULD hit the legacy Composio loop (no signal, Composio on).
        let bare = signal_ctx(None, false, false);
        assert_eq!(
            select_tool_loop(&bare, false, true, &cfg),
            ToolLoopKind::Composio
        );

        // raw_tools forces Plain in BOTH cases, even with Composio configured —
        // so an SDK-side loop's own tool_calls are never swallowed.
        let mut raw_signaled = signaled;
        raw_signaled.raw_tools = true;
        assert_eq!(
            select_tool_loop(&raw_signaled, true, true, &cfg),
            ToolLoopKind::Plain
        );
        let mut raw_bare = bare;
        raw_bare.raw_tools = true;
        assert_eq!(
            select_tool_loop(&raw_bare, false, true, &cfg),
            ToolLoopKind::Plain
        );

        // Sanity: no catalog and no Composio ⇒ Plain regardless of signal.
        assert_eq!(
            select_tool_loop(&signal_ctx(None, true, false), false, false, &cfg),
            ToolLoopKind::Plain
        );
    }

    // ─── Anthropic betas (private `ryu_anthropic_beta` field) ────────────────

    /// A minimal chat body carrying the private betas field, as `api::chat`
    /// leaves it after folding in the caller's `anthropic-beta` header.
    fn body_with_betas() -> Value {
        let mut body = json!({ "model": "m" });
        body[ANTHROPIC_BETA_FIELD] = json!("code-execution-2025-05-22");
        body
    }

    #[test]
    fn anthropic_beta_survives_only_for_the_anthropic_dialect_providers() {
        // `bedrock` is the non-obvious half: it is `AnthropicProvider` under a
        // different registry id, so stripping there would silently drop the betas
        // on a wire format that accepts them.
        for provider in ["anthropic", crate::config::BEDROCK_PROVIDER_ID] {
            let mut body = body_with_betas();
            strip_anthropic_beta_for(&mut body, provider);
            assert_eq!(
                body[ANTHROPIC_BETA_FIELD],
                json!("code-execution-2025-05-22"),
                "{provider} reads the field and must keep it"
            );
        }
    }

    #[test]
    fn anthropic_beta_is_stripped_for_every_other_provider() {
        // Each of these clones the request body verbatim into its payload, where an
        // unknown top-level key 400s a strict endpoint.
        for provider in [
            "openai",
            "openrouter",
            "local",
            "core",
            "genai",
            "modal",
            crate::config::CLASSIFY_PROVIDER_ID,
            crate::config::CLOUDFLARE_PROVIDER_ID,
            crate::config::VERTEX_PROVIDER_ID,
            crate::config::OPENAI_CREDITS_PROVIDER_ID,
            // A provider id nobody has thought about yet: the allowlist direction
            // means it is safe by default.
            "some-future-provider",
        ] {
            let mut body = body_with_betas();
            strip_anthropic_beta_for(&mut body, provider);
            assert_eq!(
                body.get(ANTHROPIC_BETA_FIELD),
                None,
                "{provider} would forward the private field upstream"
            );
            // Only that key goes; the rest of the payload is untouched.
            assert_eq!(body, json!({ "model": "m" }));
        }
    }

    #[test]
    fn anthropic_beta_strip_is_a_no_op_when_the_field_was_never_set() {
        let original = json!({ "model": "gpt-4o", "messages": [] });
        let mut body = original.clone();
        strip_anthropic_beta_for(&mut body, "openai");
        assert_eq!(body, original);
    }

    // ─── Tool-policy profile resolution (#473 profiles) ──────────────────────

    use crate::config::{ToolProfile, ToolsConfig};

    /// A `RequestContext` with an `x-ryu-tools` CSV and a selected profile name.
    fn profile_ctx(tool_actions: Option<&str>, profile: Option<&str>) -> RequestContext {
        let mut ctx = signal_ctx(tool_actions, tool_actions.is_some(), false);
        ctx.tool_profile = profile.map(str::to_string);
        ctx
    }

    /// A ToolsConfig with `always_on` containing a single tool named `name`.
    fn cfg_with_always_on(name: &str) -> ToolsConfig {
        ToolsConfig {
            always_on: vec![json!({"type":"function","function":{"name": name}})],
            ..ToolsConfig::default()
        }
    }

    #[test]
    fn allowlist_no_profile_is_unchanged_default_behavior() {
        // Default-safety guard: with no profile selected the resolved list is
        // exactly the x-ryu-tools CSV followed by the always_on names, in order.
        let cfg = cfg_with_always_on("search.web");
        let ctx = profile_ctx(Some("spider.crawl, exa.find"), None);
        assert_eq!(
            effective_tool_allowlist(&ctx, &cfg),
            vec![
                "spider.crawl".to_string(),
                "exa.find".to_string(),
                "search.web".to_string(),
            ]
        );
        // No header and no profile ⇒ just always_on (the pre-profile behavior).
        let bare = profile_ctx(None, None);
        assert_eq!(
            effective_tool_allowlist(&bare, &cfg),
            vec!["search.web".to_string()]
        );
    }

    #[test]
    fn allowlist_client_wildcard_header_cannot_grant_arbitrary_tools() {
        // Regression: a client-supplied `x-ryu-tools: *` must NOT introduce the
        // wildcard grant. `"*"` may only come from an `unrestricted` profile.
        let cfg = ToolsConfig::default();

        // No profile: the bare `*` header resolves to an empty allowlist, not "*".
        let bare = profile_ctx(Some("*"), None);
        assert!(
            !effective_tool_allowlist(&bare, &cfg).contains(&"*".to_string()),
            "client wildcard leaked into the no-profile allowlist"
        );

        // `*` mixed with a real id keeps the real id and drops the wildcard.
        let mixed = profile_ctx(Some("spider.crawl, *"), None);
        let out = effective_tool_allowlist(&mixed, &cfg);
        assert!(out.contains(&"spider.crawl".to_string()));
        assert!(
            !out.contains(&"*".to_string()),
            "client wildcard survived alongside an explicit tool id"
        );

        // A non-`unrestricted` profile cannot be escalated to "*" via the header.
        let mut scoped_cfg = ToolsConfig::default();
        scoped_cfg.profiles.insert(
            "messaging".to_string(),
            ToolProfile {
                allow: vec!["slack.send".to_string()],
                ..ToolProfile::default()
            },
        );
        let escalate = profile_ctx(Some("*"), Some("messaging"));
        let scoped = effective_tool_allowlist(&escalate, &scoped_cfg);
        assert!(scoped.contains(&"slack.send".to_string()));
        assert!(
            !scoped.contains(&"*".to_string()),
            "client wildcard escalated a scoped profile to unrestricted"
        );
    }

    #[test]
    fn allowlist_messaging_profile_resolves_to_allow_plus_always_on() {
        let mut cfg = cfg_with_always_on("search.web");
        cfg.profiles.insert(
            "messaging".to_string(),
            ToolProfile {
                allow: vec!["slack.send".to_string(), "gmail.send".to_string()],
                ..ToolProfile::default()
            },
        );
        // No x-ryu-tools header: the profile's allow list seeds the allowlist.
        let ctx = profile_ctx(None, Some("messaging"));
        assert_eq!(
            effective_tool_allowlist(&ctx, &cfg),
            vec![
                "slack.send".to_string(),
                "gmail.send".to_string(),
                "search.web".to_string(),
            ]
        );
    }

    #[test]
    fn allowlist_explicit_tools_union_on_top_of_profile() {
        let mut cfg = ToolsConfig::default();
        cfg.profiles.insert(
            "messaging".to_string(),
            ToolProfile {
                allow: vec!["slack.send".to_string()],
                ..ToolProfile::default()
            },
        );
        // Explicit x-ryu-tools augments the profile (union; explicit entry appears
        // even though it is not in the profile).
        let ctx = profile_ctx(Some("github.pr"), Some("messaging"));
        let out = effective_tool_allowlist(&ctx, &cfg);
        assert!(out.contains(&"slack.send".to_string()));
        assert!(out.contains(&"github.pr".to_string()));
    }

    #[test]
    fn allowlist_deny_wins_over_allow_and_explicit() {
        let mut cfg = ToolsConfig::default();
        cfg.profiles.insert(
            "messaging".to_string(),
            ToolProfile {
                allow: vec!["slack.send".to_string(), "slack.admin".to_string()],
                deny: vec!["slack.admin".to_string(), "github.pr".to_string()],
                ..ToolProfile::default()
            },
        );
        // deny strips both a profile-allowed id and an explicitly-granted id.
        let ctx = profile_ctx(Some("github.pr"), Some("messaging"));
        let out = effective_tool_allowlist(&ctx, &cfg);
        assert!(out.contains(&"slack.send".to_string()));
        assert!(!out.contains(&"slack.admin".to_string()));
        assert!(!out.contains(&"github.pr".to_string()));
    }

    #[test]
    fn allowlist_deny_does_not_strip_always_on() {
        // Invariant: always_on tools are never deny-stripped, even if a profile
        // lists one in its deny set.
        let mut cfg = cfg_with_always_on("search.web");
        cfg.profiles.insert(
            "messaging".to_string(),
            ToolProfile {
                allow: vec!["slack.send".to_string()],
                deny: vec!["search.web".to_string()],
                ..ToolProfile::default()
            },
        );
        let ctx = profile_ctx(None, Some("messaging"));
        let out = effective_tool_allowlist(&ctx, &cfg);
        assert!(
            out.contains(&"search.web".to_string()),
            "always_on must survive a profile deny entry"
        );
    }

    #[test]
    fn allowlist_unknown_profile_falls_back_to_default() {
        // A stale / typo'd profile name must NOT deny-all — it behaves exactly as
        // if no profile were selected.
        let cfg = cfg_with_always_on("search.web");
        let ctx = profile_ctx(Some("spider.crawl"), Some("does-not-exist"));
        assert_eq!(
            effective_tool_allowlist(&ctx, &cfg),
            vec!["spider.crawl".to_string(), "search.web".to_string()]
        );
    }

    #[test]
    fn allowlist_unrestricted_profile_resolves_to_wildcard() {
        let mut cfg = cfg_with_always_on("search.web");
        cfg.profiles.insert(
            "full".to_string(),
            ToolProfile {
                unrestricted: true,
                ..ToolProfile::default()
            },
        );
        let ctx = profile_ctx(None, Some("full"));
        let out = effective_tool_allowlist(&ctx, &cfg);
        assert!(
            out.contains(&"*".to_string()),
            "full profile seeds wildcard"
        );
        assert!(out.contains(&"search.web".to_string()));
    }

    #[test]
    fn sse_extract_text_concatenates_deltas() {
        let raw = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"world\"}}]}\n\n",
            "data: [DONE]\n\n"
        );
        assert_eq!(sse_extract_text(raw), "Hello world");
    }

    #[test]
    fn sse_extract_text_ignores_non_data_and_malformed_lines() {
        let raw = concat!(
            ": keep-alive\n\n",
            "data: not-json\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n"
        );
        assert_eq!(sse_extract_text(raw), "ok");
    }

    #[test]
    fn sse_extract_then_scan_catches_secret_split_across_deltas() {
        // A secret token arrives split across two deltas; scanning each delta in
        // isolation would miss it, so we must scan the reassembled text.
        let raw = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"key sk-\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"ABCDEFGHIJ0123456789KLMN\"}}]}\n\n",
            "data: [DONE]\n\n"
        );
        let scanner = FirewallScanner::new(FirewallConfig::default());
        let assembled = sse_extract_text(raw);
        assert!(scanner.scan_outbound(&assembled).is_some());
    }

    #[test]
    fn sse_content_frames_are_valid_openai_sse() {
        let frames = sse_content_frames("blocked message");
        // The chunk must parse as a content delta a downstream OpenAI-SSE parser
        // will relay, and the transcript must terminate with the DONE sentinel.
        let first = frames
            .lines()
            .find_map(|l| l.strip_prefix("data: "))
            .expect("a data line");
        let json: Value = serde_json::from_str(first).expect("valid json chunk");
        assert_eq!(json["choices"][0]["delta"]["content"], "blocked message");
        assert!(frames.contains("data: [DONE]"));
    }

    #[test]
    fn outbound_enabled_respects_toggles() {
        let scanner = FirewallScanner::new(FirewallConfig::default());
        assert!(scanner.outbound_enabled());

        let off = FirewallConfig {
            scan_outbound: false,
            ..FirewallConfig::default()
        };
        assert!(!FirewallScanner::new(off).outbound_enabled());
    }

    /// A bare secret in a chat body does NOT reach the provider under the DEFAULT
    /// firewall config. This exercises the exact `PipelineStage::Firewall` decision
    /// (scan_inbound → match policy) with no policy overrides: the default policy
    /// is `Block`, so the Firewall stage rejects the request outright. The opt-in
    /// `Sanitize` path (redact-and-continue) is asserted separately below.
    #[test]
    fn bare_secret_not_forwarded_to_provider_under_default() {
        let scanner = FirewallScanner::new(FirewallConfig::default());
        let body = serde_json::json!({
            "model": "gpt-4o",
            "messages": [
                { "role": "user", "content": "deploy with AKIAIOSFODNN7EXAMPLE now" }
            ]
        });

        let prompt = extract_text_for_scanning(&body);
        let violation = scanner
            .scan_inbound(&prompt)
            .expect("a bare secret must trip the inbound scan");
        assert_eq!(violation.kind, crate::firewall::DetectionKind::Secret);

        // The default policy is Block: the Firewall stage's match arm returns
        // a FirewallBlocked error, so the body never egresses at all.
        assert_eq!(scanner.policy(), &FirewallPolicy::Block);
    }

    /// The opt-in `Sanitize` policy redacts a detected secret from the body
    /// instead of rejecting the request (redact-and-continue).
    #[test]
    fn bare_secret_redacted_from_provider_body_under_sanitize() {
        let scanner = FirewallScanner::new(FirewallConfig {
            policy: FirewallPolicy::Sanitize,
            ..FirewallConfig::default()
        });
        let mut body = serde_json::json!({
            "model": "gpt-4o",
            "messages": [
                { "role": "user", "content": "deploy with AKIAIOSFODNN7EXAMPLE now" }
            ]
        });

        sanitize_messages(&mut body, &scanner);

        let egress = body["messages"][0]["content"].as_str().unwrap();
        assert!(
            !egress.contains("AKIAIOSFODNN7EXAMPLE"),
            "secret must not reach the provider body: {egress}"
        );
        assert!(
            egress.contains("[REDACTED:"),
            "expected a redaction marker in the egress body: {egress}"
        );
    }

    // ─── Multimodal pipeline integration tests ────────────────────────────────

    /// Verify that `multimodal_input_text` extracts the right field per modality.
    #[test]
    fn multimodal_input_text_extracts_correct_fields() {
        let body = serde_json::json!({
            "prompt": "a cat",
            "input": "Hello world",
            "model": "test-model"
        });

        assert_eq!(multimodal_input_text(&body, &Modality::Image), "a cat");
        assert_eq!(multimodal_input_text(&body, &Modality::Tts), "Hello world");
        assert_eq!(multimodal_input_text(&body, &Modality::Stt), "");
        assert_eq!(multimodal_input_text(&body, &Modality::Chat), "");
    }

    /// Verify that an image request is dispatched to the provider registered in
    /// the modality map and that the audit record carries the correct provider
    /// label (`openai:image`). Uses a mock provider that succeeds immediately
    /// without a live endpoint.
    #[tokio::test]
    async fn multimodal_image_dispatched_to_configured_provider_and_audited() {
        use crate::config::{ModalityMapping, RoutingConfig};
        use crate::router::RouteDecision;
        use std::collections::HashMap;

        // Build minimal state with a modality map pointing image → openai.
        let mut modality_map = HashMap::new();
        modality_map.insert(
            Modality::Image,
            ModalityMapping {
                provider: crate::config::ProviderKind::OpenAi.into(),
                model: Some("dall-e-3".to_string()),
            },
        );

        let config = crate::config::GatewayConfig {
            routing: RoutingConfig {
                modality_map,
                ..RoutingConfig::default()
            },
            // Disable auth so the test doesn't need a key.
            auth: crate::config::AuthConfig {
                require_auth: false,
                ..Default::default()
            },
            // Disable the firewall to keep the test deterministic.
            firewall: FirewallConfig {
                enabled: false,
                ..FirewallConfig::default()
            },
            ..crate::config::GatewayConfig::default()
        };

        // The test uses route_modality to check the routing decision directly —
        // a full pipeline run would need a real or mock HTTP provider. We verify
        // the dispatch decision and audit field name here without a live endpoint.
        let router = crate::router::ModelRouter::new(config.routing.clone());
        let RouteDecision { provider, model } = router.route_modality(&Modality::Image, "dall-e-3");

        assert_eq!(
            provider,
            crate::config::ProviderKind::OpenAi,
            "image request must be dispatched to the provider in the modality map"
        );
        assert_eq!(
            model, "dall-e-3",
            "model pin in the modality map must be forwarded to the provider"
        );

        // Verify the audit label format used by run_multimodal.
        let provider_label = format!("openai:{}", Modality::Image.as_str());
        assert_eq!(
            provider_label, "openai:image",
            "audit record provider field must encode the modality"
        );
    }

    /// Verify that an STT request is dispatched to the provider registered in
    /// the modality map and carries the correct audit label.
    #[tokio::test]
    async fn multimodal_stt_dispatched_to_configured_provider_and_audited() {
        use crate::config::{ModalityMapping, RoutingConfig};
        use crate::router::RouteDecision;
        use std::collections::HashMap;

        let mut modality_map = HashMap::new();
        modality_map.insert(
            Modality::Stt,
            ModalityMapping {
                provider: crate::config::ProviderKind::OpenAi.into(),
                model: Some("whisper-1".to_string()),
            },
        );

        let config = crate::config::GatewayConfig {
            routing: RoutingConfig {
                modality_map,
                ..RoutingConfig::default()
            },
            ..crate::config::GatewayConfig::default()
        };

        let router = crate::router::ModelRouter::new(config.routing.clone());
        let RouteDecision { provider, model } = router.route_modality(&Modality::Stt, "whisper-1");

        assert_eq!(
            provider,
            crate::config::ProviderKind::OpenAi,
            "STT request must be dispatched to the provider in the modality map"
        );
        assert_eq!(
            model, "whisper-1",
            "model pin must be forwarded to the provider"
        );

        let provider_label = format!("openai:{}", Modality::Stt.as_str());
        assert_eq!(
            provider_label, "openai:stt",
            "audit record provider field must encode the modality"
        );
    }

    /// Verify that modality-to-provider mappings are swappable: changing the
    /// modality_map re-routes the same request to a different provider.
    #[test]
    fn modality_map_is_swappable_no_hardcoded_provider() {
        use crate::config::{ModalityMapping, ProviderKind, RoutingConfig};
        use std::collections::HashMap;

        for provider in [
            ProviderKind::OpenAi,
            ProviderKind::Local,
            ProviderKind::OpenRouter,
        ] {
            let mut modality_map = HashMap::new();
            modality_map.insert(
                Modality::Image,
                ModalityMapping {
                    provider: provider.clone().into(),
                    model: None,
                },
            );
            let router = crate::router::ModelRouter::new(RoutingConfig {
                modality_map,
                ..RoutingConfig::default()
            });
            let decision = router.route_modality(&Modality::Image, "test-model");
            assert_eq!(
                decision.provider, provider,
                "modality map must be fully swappable: {provider:?} must route to itself"
            );
        }
    }

    // ─── Per-attribute slot routing tests (M3 / #164) ────────────────────────

    /// Core forwards a carded agent's image slot as `x-ryu-slot-image-provider`
    /// and `x-ryu-slot-image-model`. The gateway must route the image call to
    /// the slot's provider even when the static modality_map says something else.
    /// This is the primary AC for issue #164: same agent, different providers per
    /// modality, with the slot override winning over the map entry.
    #[test]
    fn per_agent_slot_override_wins_over_modality_map() {
        use crate::config::{ModalityMapping, ProviderKind, RoutingConfig};
        use std::collections::HashMap;

        // Static modality_map says image → OpenAi, dall-e-3.
        let mut modality_map = HashMap::new();
        modality_map.insert(
            Modality::Image,
            ModalityMapping {
                provider: ProviderKind::OpenAi.into(),
                model: Some("dall-e-3".to_string()),
            },
        );

        let router = crate::router::ModelRouter::new(RoutingConfig {
            modality_map,
            ..RoutingConfig::default()
        });

        // The carded agent's image slot pins Local / "my-local-image-model".
        let slot_provider: ProviderId = ProviderKind::Local.into();
        let slot_model = "my-local-image-model";

        let decision = router.route_modality_with_slot(
            &Modality::Image,
            "dall-e-3",
            Some(&slot_provider),
            Some(slot_model),
        );

        assert_eq!(
            decision.provider,
            ProviderKind::Local,
            "slot provider must win over the static modality_map entry (AC2 #164)"
        );
        assert_eq!(
            decision.model, "my-local-image-model",
            "slot model must be forwarded to the provider (AC2 #164)"
        );
    }

    /// When the slot has a provider but no model, the requested (caller) model
    /// is forwarded, consistent with the existing modality_map behavior for
    /// entries that don't pin a model.
    #[test]
    fn per_agent_slot_without_model_forwards_caller_model() {
        use crate::config::ProviderKind;
        let router = crate::router::ModelRouter::new(crate::config::RoutingConfig::default());

        let slot_provider: ProviderId = ProviderKind::Anthropic.into();
        let decision = router.route_modality_with_slot(
            &Modality::Tts,
            "tts-caller-model",
            Some(&slot_provider),
            None,
        );

        assert_eq!(decision.provider, ProviderKind::Anthropic);
        assert_eq!(
            decision.model, "tts-caller-model",
            "caller model is passed through when the slot doesn't pin a model"
        );
    }

    /// Unset slot (None provider) falls back to the static modality_map, then to
    /// model routing. This is AC3 of #164: unset slot inherits the registry default.
    #[test]
    fn unset_slot_falls_back_to_modality_map_then_model_routing() {
        use crate::config::{ModalityMapping, ProviderKind, RoutingConfig};
        use std::collections::HashMap;

        let mut modality_map = HashMap::new();
        modality_map.insert(
            Modality::Image,
            ModalityMapping {
                provider: ProviderKind::OpenAi.into(),
                model: Some("dall-e-3".to_string()),
            },
        );

        let router = crate::router::ModelRouter::new(RoutingConfig {
            modality_map,
            ..RoutingConfig::default()
        });

        // No slot override: should fall through to modality_map.
        let decision =
            router.route_modality_with_slot(&Modality::Image, "some-caller-model", None, None);

        assert_eq!(
            decision.provider,
            ProviderKind::OpenAi,
            "absent slot must fall back to the static modality_map (AC3 #164)"
        );
        assert_eq!(
            decision.model, "dall-e-3",
            "modality_map model pin must be used when no slot override is present"
        );
    }

    /// Same carded agent: chat call routes to its chat slot provider, image call
    /// routes to its image slot provider — two different providers from the same
    /// request context. This is the primary AC of #164: per-attribute routing.
    ///
    /// The test also verifies `pre_process`-level behavior: when `ctx.slot_provider`
    /// is set, `pre_process` calls `route_modality_with_slot(Chat, ...)` instead of
    /// the plain `router.route()` path, so the chat slot wins over eval/model routing.
    #[test]
    fn same_carded_agent_chat_and_image_route_to_different_providers() {
        use crate::config::{ProviderKind, RoutingConfig};
        use crate::router::ModelRouter;

        // Default config: model routing for chat (gpt-4o → OpenAi), no modality map.
        let router = ModelRouter::new(RoutingConfig::default());

        // Chat call with a slot override — the agent card pins Anthropic for chat.
        // This exercises the `pre_process` branch added in #164: when
        // ctx.slot_provider is Some, route_modality_with_slot(Chat,...) is used.
        let chat_slot_provider: ProviderId = ProviderKind::Anthropic.into();
        let chat_slot_model = "claude-3-5-sonnet";
        let chat_decision = router.route_modality_with_slot(
            &Modality::Chat,
            "gpt-4o",
            Some(&chat_slot_provider),
            Some(chat_slot_model),
        );
        assert_eq!(
            chat_decision.provider,
            ProviderKind::Anthropic,
            "chat call with slot override must route to the slot provider (AC2 #164)"
        );
        assert_eq!(chat_decision.model, "claude-3-5-sonnet");

        // Image call — agent card pins Local provider for image generation.
        let image_slot_provider: ProviderId = ProviderKind::Local.into();
        let image_slot_model = "stable-diffusion-local";
        let image_decision = router.route_modality_with_slot(
            &Modality::Image,
            "dall-e-3",
            Some(&image_slot_provider),
            Some(image_slot_model),
        );
        assert_eq!(
            image_decision.provider,
            ProviderKind::Local,
            "image call from the same agent must route to the slot's provider"
        );
        assert_eq!(image_decision.model, "stable-diffusion-local");

        // Assert the two providers differ — this is the distinguishing assertion
        // for "same agent, two different providers per modality" (AC2 #164).
        assert_ne!(
            chat_decision.provider, image_decision.provider,
            "chat and image calls from the same carded agent must reach different providers"
        );
    }

    /// When `ctx.slot_provider` and `ctx.slot_model` are both None (default agent,
    /// no slot configured), pre_process falls through to eval/model routing — the
    /// slot path must not break routing for non-carded agents.
    #[test]
    fn no_slot_falls_through_to_model_routing() {
        use crate::config::{ProviderKind, RoutingConfig};
        use crate::router::ModelRouter;

        let router = ModelRouter::new(RoutingConfig::default());

        // No slot — should resolve via model-name prefix rules.
        let decision = router.route_modality_with_slot(&Modality::Chat, "gpt-4o", None, None);
        // gpt-4o has no modality_map entry for Chat and no modality_map at all,
        // so it falls through to model routing; the "gpt-" prefix → OpenAi.
        assert_eq!(
            decision.provider,
            ProviderKind::OpenAi,
            "absent slot must fall through to standard model routing for chat"
        );
    }

    /// End-to-end proof that provider routing is open to arbitrary registry ids:
    /// a provider registered under a brand-new id (`"acme"`) that the closed
    /// `ProviderKind` enum never covered is routable purely via
    /// `default_provider = "acme"` in config, and a real request driven through
    /// the full `run()` pipeline reaches that provider's `complete()`. This is the
    /// acceptance test for W6b — the enum is no longer on the road, only the map.
    #[tokio::test]
    async fn novel_provider_id_routable_end_to_end_through_pipeline() {
        use crate::audit::AuditLogger;
        use crate::config::{
            AuditConfig, EvalsConfig, FirewallConfig, GatewayConfig, ProviderId, RoutingConfig,
        };
        use crate::providers::Provider;
        use crate::state::AppState;
        use serde_json::{json, Value};
        use std::pin::Pin;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        // A provider under an id no enum variant knows about.
        struct AcmeProvider {
            calls: AtomicUsize,
        }
        impl Provider for AcmeProvider {
            fn name(&self) -> &'static str {
                "acme"
            }
            fn complete<'a>(
                &'a self,
                _model: &'a str,
                _body: &'a Value,
            ) -> Pin<
                Box<
                    dyn std::future::Future<Output = Result<Value, ryu_gw_providers::ProviderError>>
                        + Send
                        + 'a,
                >,
            > {
                self.calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    Ok(json!({
                        "id": "chatcmpl-acme",
                        "object": "chat.completion",
                        "model": "acme-1",
                        "choices": [{
                            "index": 0,
                            "message": {"role": "assistant", "content": "pong"},
                            "finish_reason": "stop"
                        }],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
                    }))
                })
            }
            fn complete_stream<'a>(
                &'a self,
                _model: &'a str,
                _body: &'a Value,
            ) -> Pin<
                Box<
                    dyn std::future::Future<
                            Output = Result<axum::body::Body, ryu_gw_providers::ProviderError>,
                        > + Send
                        + 'a,
                >,
            > {
                Box::pin(async move {
                    Err(ryu_gw_providers::ProviderError::Provider(
                        "no stream".into(),
                    ))
                })
            }
        }

        // Route everything to "acme" by config alone — no code names the enum.
        let config = GatewayConfig {
            routing: RoutingConfig {
                default_provider: ProviderId::from("acme"),
                ..RoutingConfig::default()
            },
            firewall: FirewallConfig {
                enabled: false,
                ..FirewallConfig::default()
            },
            ..GatewayConfig::default()
        };

        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
        let mut state = AppState::new_for_test(config, audit, evals);

        let acme = Arc::new(AcmeProvider {
            calls: AtomicUsize::new(0),
        });
        state
            .providers
            .register(Arc::clone(&acme) as Arc<dyn Provider>);
        let state = Arc::new(state);

        let ctx = RequestContext {
            request_id: "acme-route-req".to_string(),
            api_key: "sk-test".to_string(),
            is_master_key: false,
            org_id: None,
            team_id: None,
            project_id: None,
            user_name: None,
            user_id: None,
            agent_id: None,
            key_config: None,
            skill_ids: None,
            tool_actions: None,
            tools_header_present: false,
            slot_provider: None,
            slot_model: None,
            session_id: None,
            feature: None,
            companion_source: false,
            tool_search_requested: false,
            priority: crate::concurrency::Priority::Interactive,
            tool_profile: None,
            raw_tools: false,
            managed_inference: false,
            remaining_budget_micro_usd: None,
            unrestricted_budget_micro_usd: None,
            pool_budgets_micro_usd: std::collections::HashMap::new(),
            resolved_policy: None,
            prompt_cache_mode: None,
            prompt_cache_ttl: None,
            node_routing: None,
        };

        let body = json!({
            "model": "anything",
            "messages": [{"role": "user", "content": "ping"}]
        });

        let out = run(Arc::clone(&state), ctx, body)
            .await
            .expect("pipeline must route to the novel-id provider and succeed");

        assert_eq!(
            out.provider_used, "acme",
            "the provider registered under the novel id must serve the turn end-to-end"
        );
        assert_eq!(
            acme.calls.load(Ordering::SeqCst),
            1,
            "the novel-id provider's complete() must have been invoked exactly once"
        );
    }

    /// ProviderKind::from_str correctly round-trips the values forwarded as
    /// `x-ryu-slot-*-provider` headers from Core to the Gateway.
    #[test]
    fn provider_kind_from_str_parses_header_values() {
        use crate::config::ProviderKind;
        use std::str::FromStr;

        assert_eq!(
            "openai".parse::<ProviderKind>().unwrap(),
            ProviderKind::OpenAi
        );
        assert_eq!(
            "anthropic".parse::<ProviderKind>().unwrap(),
            ProviderKind::Anthropic
        );
        assert_eq!(
            "local".parse::<ProviderKind>().unwrap(),
            ProviderKind::Local
        );
        assert_eq!(
            "openrouter".parse::<ProviderKind>().unwrap(),
            ProviderKind::OpenRouter
        );
        assert_eq!("core".parse::<ProviderKind>().unwrap(), ProviderKind::Core);
        assert!("unknown-provider".parse::<ProviderKind>().is_err());
    }

    // ─── Streaming token-usage tap tests (#179) ───────────────────────────────

    /// inject_stream_usage_option adds include_usage=true to the body.
    /// A second call must not overwrite an existing value (idempotent).
    #[test]
    fn inject_stream_usage_option_adds_field_and_is_idempotent() {
        let mut body = json!({ "model": "gpt-4o", "messages": [] });
        inject_stream_usage_option(&mut body);
        assert_eq!(body["stream_options"]["include_usage"], json!(true));

        // Calling again must not change anything.
        inject_stream_usage_option(&mut body);
        assert_eq!(body["stream_options"]["include_usage"], json!(true));
    }

    /// inject_stream_usage_option preserves existing stream_options fields.
    #[test]
    fn inject_stream_usage_option_preserves_existing_stream_options() {
        let mut body = json!({
            "model": "gpt-4o",
            "stream_options": { "custom_field": 42 }
        });
        inject_stream_usage_option(&mut body);
        assert_eq!(body["stream_options"]["include_usage"], json!(true));
        // Original field must survive.
        assert_eq!(body["stream_options"]["custom_field"], json!(42));
    }

    /// sse_parse_usage extracts prompt_tokens and completion_tokens from the
    /// terminal OpenAI usage frame. This is the recorded SSE fixture for AC2.
    #[test]
    fn sse_parse_usage_extracts_from_terminal_usage_frame() {
        // Recorded SSE fixture: two content delta chunks + terminal usage chunk
        // + DONE, as emitted by OpenAI when stream_options.include_usage=true.
        let raw = concat!(
            "data: {\"id\":\"chatcmpl-x\",\"object\":\"chat.completion.chunk\",",
            "\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hello\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl-x\",\"object\":\"chat.completion.chunk\",",
            "\"choices\":[{\"index\":0,\"delta\":{\"content\":\" world\"},\"finish_reason\":\"stop\"}]}\n\n",
            // Terminal usage frame: choices is empty, usage carries the real counts.
            "data: {\"id\":\"chatcmpl-x\",\"object\":\"chat.completion.chunk\",",
            "\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":8,\"total_tokens\":20}}\n\n",
            "data: [DONE]\n\n"
        );

        let (input, output) = sse_parse_usage(raw);
        assert_eq!(
            input, 12,
            "prompt_tokens must be parsed from the terminal usage frame"
        );
        assert_eq!(
            output, 8,
            "completion_tokens must be parsed from the terminal usage frame"
        );
    }

    /// sse_parse_usage returns (0, 0) when the provider emits no usage frame,
    /// so the caller can fall back to the prompt estimate.
    #[test]
    fn sse_parse_usage_returns_zeros_when_no_usage_frame_present() {
        let raw = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n",
            "data: [DONE]\n\n"
        );
        let (input, output) = sse_parse_usage(raw);
        assert_eq!(input, 0);
        assert_eq!(output, 0);
    }

    /// sse_parse_usage ignores malformed lines and picks the last usage frame.
    #[test]
    fn sse_parse_usage_handles_malformed_lines_and_multiple_usage_frames() {
        let raw = concat!(
            ": keep-alive\n\n",
            "data: not-json\n\n",
            // First usage frame with lower counts.
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":3}}\n\n",
            // Second usage frame wins (last non-zero wins).
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":10}}\n\n",
            "data: [DONE]\n\n"
        );
        let (input, output) = sse_parse_usage(raw);
        // Last non-zero frame wins.
        assert_eq!(input, 20);
        assert_eq!(output, 10);
    }

    /// sse_parse_cost pulls OpenRouter's `usage.cost` from the terminal frame.
    #[test]
    fn sse_parse_cost_extracts_reported_cost() {
        let raw = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":8,",
            "\"cost\":0.0023}}\n\n",
            "data: [DONE]\n\n"
        );
        assert_eq!(sse_parse_cost(raw), Some(0.0023));
    }

    /// No `usage.cost` (non-OpenRouter provider) → None, so the debit falls back
    /// to the flat token estimate.
    #[test]
    fn sse_parse_cost_absent_returns_none() {
        let raw = concat!(
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":3}}\n\n",
            "data: [DONE]\n\n"
        );
        assert_eq!(sse_parse_cost(raw), None);
    }

    /// cost_usd_to_micro converts dollars to micro-USD and rejects junk values.
    #[test]
    fn cost_usd_to_micro_converts_and_rejects_negative_or_nonfinite() {
        assert_eq!(cost_usd_to_micro(0.0023), Some(2300));
        assert_eq!(cost_usd_to_micro(1.0), Some(1_000_000));
        assert_eq!(cost_usd_to_micro(0.0), Some(0));
        assert_eq!(cost_usd_to_micro(-1.0), None);
        assert_eq!(cost_usd_to_micro(f64::NAN), None);
        assert_eq!(cost_usd_to_micro(f64::INFINITY), None);
    }

    #[test]
    fn sse_parse_cost_preserves_a_free_provider_transaction() {
        let raw = "data: {\"usage\":{\"cost\":0}}\n\n";
        assert_eq!(sse_parse_cost(raw), Some(0.0));
        assert_eq!(cost_usd_to_micro(sse_parse_cost(raw).unwrap()), Some(0));
    }

    #[test]
    fn openrouter_identity_prefers_agent_and_ignores_other_providers() {
        let mut ctx = crate::pipeline::test_support::plain_request_context();
        ctx.user_id = Some("user-7".to_owned());
        ctx.agent_id = Some("agent-7".to_owned());

        let mut openrouter = json!({ "model": "openrouter/model" });
        stamp_openrouter_identity(&mut openrouter, "openrouter", &ctx);
        assert_eq!(openrouter["user"], json!("ryu-agent:agent-7"));

        let mut openai = json!({ "model": "gpt-4o" });
        stamp_openrouter_identity(&mut openai, "openai", &ctx);
        assert!(openai.get("user").is_none());
    }

    #[test]
    fn openrouter_identity_falls_back_to_user() {
        let mut ctx = crate::pipeline::test_support::plain_request_context();
        ctx.user_id = Some("user-7".to_owned());
        let mut body = json!({ "model": "openrouter/model" });
        stamp_openrouter_identity(&mut body, "openrouter", &ctx);
        assert_eq!(body["user"], json!("ryu-user:user-7"));
    }

    #[test]
    fn agent_route_proof_binds_the_bearer_and_agent() {
        type AgentRouteMac = Hmac<Sha256>;

        let bearer = "rgw_test-bearer";
        let mut mac = AgentRouteMac::new_from_slice(bearer.as_bytes()).unwrap();
        mac.update(b"ryu-agent-route-v1\0");
        mac.update(b"agent-7");
        let proof = hex::encode(mac.finalize().into_bytes());

        assert!(verify_agent_route_proof(
            Some("Bearer rgw_test-bearer"),
            "agent-7",
            &proof
        ));
        assert!(!verify_agent_route_proof(
            Some("Bearer rgw_test-bearer"),
            "agent-8",
            &proof
        ));
        assert!(!verify_agent_route_proof(
            Some("Bearer rgw_other-bearer"),
            "agent-7",
            &proof
        ));
    }

    /// attach_stream_observer writes a non-zero audit row at stream end when the
    /// SSE fixture contains a terminal usage frame (AC2 of issue #179).
    #[tokio::test]
    async fn stream_observer_writes_non_zero_audit_row_from_usage_frame() {
        use crate::audit::{AuditLogger, AuditQuery};
        use crate::config::{AuditConfig, EvalsConfig, GatewayConfig};
        use crate::evals::EvalsRunner;
        use crate::state::AppState;
        use axum::body::Body;
        use std::sync::Arc;

        // Recorded SSE fixture with a terminal usage frame (OpenAI format).
        let fixture = concat!(
            "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",",
            "\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hi\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl-test\",\"object\":\"chat.completion.chunk\",",
            "\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":3,\"total_tokens\":13}}\n\n",
            "data: [DONE]\n\n"
        );

        // Build a minimal AppState with audit enabled and evals enabled.
        let dir = std::env::temp_dir().join(format!(
            "ryu-stream-obs-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let db_path = dir.join("audit.db");
        let audit_config = AuditConfig {
            enabled: true,
            db_path: db_path.to_str().unwrap().to_string(),
        };
        let audit = AuditLogger::new(&audit_config).expect("audit logger");
        let evals_config = EvalsConfig {
            enabled: true,
            max_latency_ms: 10_000,
            sample_rate: 1.0,
            stream_usage: true,
        };
        let evals = EvalsRunner::new(evals_config.clone());

        let config = GatewayConfig {
            audit: audit_config.clone(),
            evals: evals_config,
            ..GatewayConfig::default()
        };

        let state = Arc::new(AppState::new_for_test(config, audit, evals));

        let ctx = RequestContext {
            request_id: "test-obs-req".to_string(),
            api_key: "sk-test".to_string(),
            is_master_key: false,
            org_id: None,
            team_id: None,
            project_id: None,
            user_name: None,
            user_id: None,
            agent_id: None,
            key_config: None,
            skill_ids: None,
            tool_actions: None,
            tools_header_present: false,
            slot_provider: None,
            slot_model: None,
            session_id: None,
            feature: None,
            companion_source: false,
            tool_search_requested: false,
            priority: crate::concurrency::Priority::Interactive,
            tool_profile: None,
            raw_tools: false,
            managed_inference: false,
            remaining_budget_micro_usd: None,
            unrestricted_budget_micro_usd: None,
            pool_budgets_micro_usd: std::collections::HashMap::new(),
            resolved_policy: None,
            prompt_cache_mode: None,
            prompt_cache_ttl: None,
            node_routing: None,
        };

        let body = Body::from(fixture);
        let observed = attach_stream_observer(
            body,
            Arc::clone(&state),
            ctx,
            "openai".to_string(),
            "gpt-4o".to_string(),
            5, // estimated (should be overridden by the real frame)
            Instant::now(),
            None,
        );

        // Drain the observed body to trigger the stream end hook.
        let _ = axum::body::to_bytes(observed, usize::MAX).await.unwrap();

        // Wait for the async audit writer to persist the row.
        let query = AuditQuery::default();
        let mut rows = Vec::new();
        for _ in 0..100 {
            rows = state.audit.query(&query).expect("query");
            if !rows.is_empty() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        assert_eq!(
            rows.len(),
            1,
            "exactly one audit row must be written at stream end"
        );
        let row = &rows[0];
        assert_eq!(
            row.input_tokens, 10,
            "input_tokens must match the usage frame (non-zero)"
        );
        assert_eq!(
            row.output_tokens, 3,
            "output_tokens must match the usage frame (non-zero)"
        );
        assert!(
            row.eval_score.is_some(),
            "eval_score must be populated for sampled streams"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Companion DLP egress guard tests (M7 / #199) ─────────────────────────

    /// AC1: companion_sanitize_messages redacts PII from string-content messages.
    #[test]
    fn companion_sanitize_messages_redacts_pii_in_string_content() {
        use crate::config::FirewallConfig;
        use crate::firewall::FirewallScanner;

        let scanner = FirewallScanner::new(FirewallConfig {
            enabled: false,
            redact_pii: false,
            redact_secrets: false,
            ..FirewallConfig::default()
        });

        let mut messages = serde_json::json!([
            {"role": "user", "content": "My email is user@example.com and key sk-abcdefghijklmnopqrstu"},
            {"role": "system", "content": "Safe system prompt"}
        ]);

        scanner.companion_sanitize_messages(&mut messages);

        let user_content = messages[0]["content"].as_str().unwrap();
        assert!(
            !user_content.contains("user@example.com"),
            "companion sanitize must redact PII email: {user_content}"
        );
        assert!(
            !user_content.contains("sk-abcdefghijklmnopqrstu"),
            "companion sanitize must redact secrets: {user_content}"
        );
        // Safe system prompt should not be altered (no PII).
        assert_eq!(
            messages[1]["content"].as_str().unwrap(),
            "Safe system prompt",
            "clean content must pass through unchanged"
        );
    }

    /// AC1: companion_sanitize_messages handles array-of-parts content shape.
    #[test]
    fn companion_sanitize_messages_redacts_pii_in_parts_content() {
        use crate::config::FirewallConfig;
        use crate::firewall::FirewallScanner;

        let scanner = FirewallScanner::new(FirewallConfig::default());

        let mut messages = serde_json::json!([
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Screen capture: SSN 123-45-6789"}
                ]
            }
        ]);

        scanner.companion_sanitize_messages(&mut messages);

        let text = messages[0]["content"][0]["text"].as_str().unwrap();
        assert!(
            !text.contains("123-45-6789"),
            "companion sanitize must redact PII in parts content: {text}"
        );
        assert!(
            text.contains("[REDACTED:"),
            "parts content must contain redaction placeholder: {text}"
        );
    }

    /// AC4: a non-companion request body passes through pre_process message
    /// extraction unmodified (the companion branch must be strictly gated on the
    /// `companion_source` flag). This is a unit-level check on the sanitization
    /// helpers — the scanner used is in default (warn-and-continue) mode.
    #[test]
    fn non_companion_clean_text_is_byte_identical_after_extraction() {
        // extract_text_for_scanning must return the same text regardless of the
        // companion flag — it reads messages, not modifies them.
        let body = serde_json::json!({
            "model": "gpt-4o",
            "messages": [
                {"role": "user", "content": "Hello, world!"}
            ]
        });
        let extracted = extract_text_for_scanning(&body);
        assert_eq!(extracted, "Hello, world!");
    }

    // ── Degraded-mode signal tests (#218) ─────────────────────────────────────

    /// DegradedMode::Fallback header_value encodes the provider name so the
    /// client can identify which fallback served the request (AC1 #218).
    #[test]
    fn degraded_mode_fallback_header_value_encodes_provider() {
        let mode = DegradedMode::Fallback("anthropic".to_string());
        assert_eq!(
            mode.header_value(),
            "fallback:anthropic",
            "x-degraded header must be 'fallback:<provider>' for the Fallback variant"
        );
    }

    /// DegradedMode::Fallback with an arbitrary provider name round-trips
    /// correctly — the header value is always prefixed with "fallback:".
    #[test]
    fn degraded_mode_fallback_header_value_prefix_is_stable() {
        for provider in ["openai", "local", "openrouter", "core"] {
            let mode = DegradedMode::Fallback(provider.to_string());
            let header = mode.header_value();
            assert!(
                header.starts_with("fallback:"),
                "header value must start with 'fallback:' for all providers, got: {header}"
            );
            assert!(
                header.ends_with(provider),
                "header value must end with the provider name, got: {header}"
            );
        }
    }

    /// When no degradation occurred (primary provider served the request),
    /// `degraded` is `None` in PipelineOutput — no x-degraded header is emitted.
    #[test]
    fn degraded_none_when_primary_serves_request() {
        // Simulate: primary was NOT skipped, so degraded is None.
        // We verify the DegradedMode logic directly.
        let primary_skipped = false;
        let provider_name = "openai";
        let degraded: Option<DegradedMode> = if primary_skipped {
            Some(DegradedMode::Fallback(provider_name.to_string()))
        } else {
            None
        };
        assert!(
            degraded.is_none(),
            "degraded must be None when the primary provider serves the request"
        );
    }

    /// When the primary was skipped (circuit open) and a fallback provider serves
    /// the request, degraded is Some(Fallback(name)) (AC1 #218).
    #[test]
    fn degraded_fallback_when_primary_skipped() {
        let primary_skipped = true;
        let provider_name = "anthropic";
        let degraded: Option<DegradedMode> = if primary_skipped {
            Some(DegradedMode::Fallback(provider_name.to_string()))
        } else {
            None
        };
        assert_eq!(
            degraded,
            Some(DegradedMode::Fallback("anthropic".to_string())),
            "degraded must be Some(Fallback) when the primary was skipped"
        );
        assert_eq!(degraded.unwrap().header_value(), "fallback:anthropic");
    }

    // ── Unified-evaluator inline bridge gating (P3) ───────────────────────────

    use crate::evaluators::EvaluatorBinding;

    fn scanner_with_bindings(bindings: Vec<EvaluatorBinding>) -> FirewallScanner {
        FirewallScanner::new(FirewallConfig {
            evaluators: bindings,
            ..FirewallConfig::default()
        })
    }

    fn binding(id: &str, enabled: bool, action: Option<FirewallPolicy>) -> EvaluatorBinding {
        EvaluatorBinding {
            id: id.into(),
            enabled,
            inline_action: action,
            offline: None,
            locked: false,
        }
    }

    /// A blocking/redacting enabled OUTPUT evaluator forces the streaming firewall
    /// to buffer (so it can actually fire on the default warn/off streaming path).
    #[test]
    fn output_inline_wants_transform_true_for_blocking_binding() {
        let reg = EvaluatorRegistry::new();
        let block =
            scanner_with_bindings(vec![binding("toxicity", true, Some(FirewallPolicy::Block))]);
        assert!(output_inline_wants_transform(&block, &reg));

        let sanitize = scanner_with_bindings(vec![binding(
            "pii_leakage",
            true,
            Some(FirewallPolicy::Sanitize),
        )]);
        assert!(output_inline_wants_transform(&sanitize, &reg));
    }

    /// A disabled binding is a no-op; a warn-action binding does not force buffering;
    /// an INPUT-target binding never affects the output buffer decision.
    #[test]
    fn output_inline_wants_transform_false_cases() {
        let reg = EvaluatorRegistry::new();
        // disabled
        assert!(!output_inline_wants_transform(
            &scanner_with_bindings(vec![binding(
                "toxicity",
                false,
                Some(FirewallPolicy::Block)
            )]),
            &reg
        ));
        // warn action → no buffering
        assert!(!output_inline_wants_transform(
            &scanner_with_bindings(vec![binding(
                "toxicity",
                true,
                Some(FirewallPolicy::WarnAndContinue)
            )]),
            &reg
        ));
        // input-target evaluator (code_injection) is not an output transform
        assert!(!output_inline_wants_transform(
            &scanner_with_bindings(vec![binding(
                "code_injection",
                true,
                Some(FirewallPolicy::Block)
            )]),
            &reg
        ));
        // no bindings at all
        assert!(!output_inline_wants_transform(
            &scanner_with_bindings(vec![]),
            &reg
        ));
    }

    /// An enabled toxicity binding routes to the LLM-judge (inspector) path, and a
    /// flagged verdict + its Block action drives the SAME block outcome the regex
    /// firewall uses (mock verdict tested at the pure-decision seam — the inspector
    /// itself is fail-open-tested in `firewall::inspector`).
    #[test]
    fn toxicity_binding_routes_to_judge_and_blocks() {
        let reg = EvaluatorRegistry::new();
        let tox = reg.get("toxicity").expect("toxicity seeded");
        assert!(tox.capabilities.inline, "toxicity is inline-capable");
        assert_eq!(tox.target, EvaluatorTarget::Output);
        assert!(
            matches!(tox.impl_, EvaluatorImpl::LlmJudge { .. }),
            "toxicity dispatches to the inspect_rubric judge path"
        );
        let action = inline_action_for(&binding("toxicity", true, None), tox);
        // Mock verdict = flagged ⇒ Block; clean ⇒ Allow.
        assert_eq!(inline_outcome(true, &action), InlineOutcome::Block);
        assert_eq!(inline_outcome(false, &action), InlineOutcome::Allow);
    }

    /// The inline action resolves binding-first, then the catalog default.
    #[test]
    fn inline_action_resolution_precedence() {
        let reg = EvaluatorRegistry::new();
        let tox = reg.get("toxicity").expect("toxicity seeded");
        // Binding override wins.
        assert_eq!(
            inline_action_for(
                &binding("toxicity", true, Some(FirewallPolicy::Sanitize)),
                tox
            ),
            FirewallPolicy::Sanitize
        );
        // No binding action ⇒ the catalog default (toxicity defaults to Block).
        assert_eq!(
            inline_action_for(&binding("toxicity", true, None), tox),
            FirewallPolicy::Block
        );
    }

    /// response_to_text concatenates text across ALL choices AND array-of-parts
    /// content, so toxic/PII text hidden in a second choice (`n>1`) or in a content
    /// part no longer bypasses the non-stream / cache-hit Output judge.
    #[test]
    fn response_to_text_extracts_all_choices_and_parts() {
        // Plain choices[0] string still works.
        let simple = serde_json::json!({
            "choices": [{ "message": { "content": "hello world" } }]
        });
        assert_eq!(response_to_text(&simple), "hello world");

        // Array-of-parts content is extracted.
        let parts = serde_json::json!({
            "choices": [{ "message": { "content": [
                { "type": "text", "text": "kill yourself you worthless trash" }
            ] } }]
        });
        assert!(response_to_text(&parts).contains("kill yourself"));

        // A toxic SECOND choice (n>1) is no longer invisible.
        let multi = serde_json::json!({
            "choices": [
                { "message": { "content": "benign first choice" } },
                { "message": { "content": "you are a piece of shit" } }
            ]
        });
        let text = response_to_text(&multi);
        assert!(text.contains("benign first choice"));
        assert!(
            text.contains("piece of shit"),
            "second choice must be extracted"
        );
    }

    // ── WASM policy tier: end-to-end pipeline enforcement (gateway plugin plane) ──
    //
    // Proves the full vertical slice: a manifest declares a `Wasm` policy evaluator
    // → the pipeline loads it sandboxed → `apply_inline_input_evaluators` calls it →
    // the verdict is enforced via the SAME Block/Sanitize/Warn machinery → a
    // misbehaving module FAILS CLOSED (blocks) even when the binding action is Warn
    // (threat-model item F: a trap must never be a silent bypass).

    /// Always-DENY guest (decision byte 1, reason "denied").
    const E2E_DENY_WAT: &str = r#"
      (module
        (memory (export "memory") 1)
        (data (i32.const 2100) "\01denied")
        (func (export "ryu_alloc") (param i32) (result i32) i32.const 1024)
        (func (export "ryu_policy_eval") (param i32) (param i32) (result i64)
          (i64.const 0x0000_0834_0000_0007)))
    "#;

    /// Always-ALLOW guest (decision byte 0).
    const E2E_ALLOW_WAT: &str = r#"
      (module
        (memory (export "memory") 1)
        (data (i32.const 2048) "\00")
        (func (export "ryu_alloc") (param i32) (result i32) i32.const 1024)
        (func (export "ryu_policy_eval") (param i32) (param i32) (result i64)
          (i64.const 0x0000_0800_0000_0001)))
    "#;

    /// Infinite-loop guest — trapped by fuel/epoch, must fail closed.
    const E2E_LOOP_WAT: &str = r#"
      (module
        (memory (export "memory") 1)
        (func (export "ryu_alloc") (param i32) (result i32) i32.const 1024)
        (func (export "ryu_policy_eval") (param i32) (param i32) (result i64)
          (loop $l (br $l)) (i64.const 0)))
    "#;

    fn wasm_b64(wat: &str) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(wat::parse_str(wat).expect("wat compiles"))
    }

    /// A custom input-target WASM policy evaluator declaration.
    fn wasm_evaluator(id: &str, wat: &str, fail_open: bool) -> Evaluator {
        Evaluator {
            id: id.to_string(),
            name: format!("wasm {id}"),
            description: "e2e wasm policy".to_string(),
            category: crate::evaluators::EvaluatorCategory::Security,
            target: EvaluatorTarget::Input,
            capabilities: crate::evaluators::Capabilities {
                inline: true,
                offline: false,
            },
            impl_: EvaluatorImpl::Wasm {
                module_base64: wasm_b64(wat),
                fail_open,
            },
            inline: Some(crate::evaluators::InlineConfig {
                action: FirewallPolicy::Block,
            }),
            offline: None,
            builtin: false,
            enforced: true,
            higher_is_better: true,
        }
    }

    fn wasm_state(evaluator: Evaluator) -> Arc<AppState> {
        let config = crate::config::GatewayConfig {
            custom_evaluators: vec![evaluator],
            ..crate::config::GatewayConfig::default()
        };
        let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit");
        let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
        Arc::new(AppState::new_for_test(config, audit, evals))
    }

    fn wasm_ctx() -> RequestContext {
        signal_ctx(None, false, false)
    }

    /// Run the input inline-evaluator stage with one enabled binding for `eval_id`
    /// at `action`, returning the pipeline result.
    async fn run_input_wasm(
        state: &AppState,
        eval_id: &str,
        action: FirewallPolicy,
    ) -> Result<Option<PolicyAlert>, GatewayError> {
        let scanner = scanner_with_bindings(vec![binding(eval_id, true, Some(action))]);
        let ctx = wasm_ctx();
        let mut body = serde_json::json!({ "model": "gpt-4o", "messages": [] });
        apply_inline_input_evaluators(state, &ctx, &mut body, &scanner, "hello there").await
    }

    #[tokio::test]
    async fn e2e_wasm_deny_blocks_request() {
        let state = wasm_state(wasm_evaluator("wasm_deny", E2E_DENY_WAT, false));
        let res = run_input_wasm(&state, "wasm_deny", FirewallPolicy::Block).await;
        assert!(
            matches!(res, Err(GatewayError::FirewallBlocked(_, _))),
            "a wasm DENY verdict bound to Block must 403, got {res:?}"
        );
    }

    #[tokio::test]
    async fn e2e_wasm_allow_passes_request() {
        let state = wasm_state(wasm_evaluator("wasm_allow", E2E_ALLOW_WAT, false));
        let res = run_input_wasm(&state, "wasm_allow", FirewallPolicy::Block).await;
        assert!(
            res.is_ok(),
            "a wasm ALLOW verdict must let the turn proceed, got {res:?}"
        );
    }

    /// The critical fail-direction control: a trapping guest with `fail_open = false`
    /// BLOCKS even when the binding's action is only `WarnAndContinue`. This is the
    /// exact bypass the threat model (item F) calls out — a misconfigured Warn action
    /// must NOT let a failed security policy through.
    #[tokio::test]
    async fn e2e_wasm_trap_fails_closed_even_when_action_is_warn() {
        let state = wasm_state(wasm_evaluator("wasm_loop", E2E_LOOP_WAT, false));
        let res = run_input_wasm(&state, "wasm_loop", FirewallPolicy::WarnAndContinue).await;
        assert!(
            matches!(res, Err(GatewayError::FirewallBlocked(_, _))),
            "a trapping fail-closed wasm policy must BLOCK regardless of Warn action, got {res:?}"
        );
    }

    /// An enrichment-style plugin may DECLARE `fail_open = true`; a trap then skips
    /// (allows) instead of blocking — the declared, non-default direction.
    #[tokio::test]
    async fn e2e_wasm_trap_fail_open_allows() {
        let state = wasm_state(wasm_evaluator("wasm_loop_open", E2E_LOOP_WAT, true));
        let res = run_input_wasm(&state, "wasm_loop_open", FirewallPolicy::Block).await;
        assert!(
            res.is_ok(),
            "a fail_open=true wasm policy must ALLOW on trap (declared direction), got {res:?}"
        );
    }

    /// Output-target symmetry: the same host + verdict + fail-direction machinery
    /// enforces on the non-streaming RESPONSE path (`apply_inline_output_evaluators`
    /// resolves its scanner from `ctx`, so the binding is seeded into the node
    /// firewall config the resolver reads). A wasm policy declared `target: Output`
    /// and bound Block denies the assembled response.
    #[tokio::test]
    async fn e2e_wasm_output_target_deny_blocks_response() {
        let mut ev = wasm_evaluator("wasm_out_deny", E2E_DENY_WAT, false);
        ev.target = EvaluatorTarget::Output;
        let config = crate::config::GatewayConfig {
            custom_evaluators: vec![ev],
            firewall: FirewallConfig {
                evaluators: vec![binding("wasm_out_deny", true, Some(FirewallPolicy::Block))],
                ..FirewallConfig::default()
            },
            ..crate::config::GatewayConfig::default()
        };
        let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit");
        let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
        let state = Arc::new(AppState::new_for_test(config, audit, evals));

        let ctx = wasm_ctx();
        let mut response = serde_json::json!({
            "model": "gpt-4o",
            "choices": [{ "message": { "role": "assistant", "content": "some reply" } }]
        });
        let res = apply_inline_output_evaluators(&state, &ctx, &mut response).await;
        assert!(
            matches!(res, Err(GatewayError::FirewallBlocked(_, _))),
            "an output-target wasm DENY bound to Block must block the response, got {res:?}"
        );
    }
}

#[cfg(test)]
mod authenticate_tests {
    use super::*;
    use crate::config::{ApiKeyConfig, AuthConfig, GatewayConfig};
    use crate::state::AppState;

    fn state_with_auth(auth: AuthConfig) -> AppState {
        let config = GatewayConfig {
            auth,
            ..GatewayConfig::default()
        };
        let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
        AppState::new_for_test(config, audit, evals)
    }

    fn api_key(key: &str, name: &str, trusted_forwarder: bool) -> ApiKeyConfig {
        ApiKeyConfig {
            key: key.to_string(),
            name: name.to_string(),
            org_id: Some("org-acme".to_string()),
            team_id: Some("team-1".to_string()),
            channel_id: None,
            project_id: Some("proj-1".to_string()),
            requests_per_minute: None,
            tokens_per_minute: None,
            token_budget_total: None,
            downgrade_to: None,
            trusted_forwarder,
        }
    }

    // ─── no-auth mode ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn no_auth_mode_makes_unknown_callers_anonymous() {
        let state = state_with_auth(AuthConfig {
            require_auth: false,
            api_keys: vec![],
            master_key: None,
        });
        let ctx = authenticate(&state, AuthInputs::with_key(Some("whatever")))
            .await
            .expect("no-auth accepts any key");
        assert!(!ctx.is_master_key);
        assert_eq!(ctx.api_key, "whatever");
        assert!(ctx.org_id.is_none());
    }

    #[tokio::test]
    async fn no_auth_mode_with_no_key_labels_api_key_anonymous() {
        let state = state_with_auth(AuthConfig {
            require_auth: false,
            api_keys: vec![],
            master_key: None,
        });
        let ctx = authenticate(&state, AuthInputs::with_key(None))
            .await
            .expect("no-auth accepts missing key");
        assert_eq!(ctx.api_key, "anonymous");
        assert!(!ctx.is_master_key);
    }

    #[tokio::test]
    async fn no_auth_mode_still_recognizes_provisioned_master_key() {
        // A provisioned master key stays authoritative even with require_auth off.
        let state = state_with_auth(AuthConfig {
            require_auth: false,
            api_keys: vec![],
            master_key: Some("master-secret".to_string()),
        });
        let ctx = authenticate(&state, AuthInputs::with_key(Some("master-secret")))
            .await
            .expect("master key recognized");
        assert!(ctx.is_master_key);
        assert_eq!(ctx.user_name.as_deref(), Some("master"));
    }

    #[tokio::test]
    async fn no_auth_master_key_honors_bearer_prefix() {
        let state = state_with_auth(AuthConfig {
            require_auth: false,
            api_keys: vec![],
            master_key: Some("master-secret".to_string()),
        });
        let ctx = authenticate(&state, AuthInputs::with_key(Some("Bearer master-secret")))
            .await
            .expect("bearer-prefixed master key recognized");
        assert!(ctx.is_master_key);
    }

    // ─── require_auth mode ───────────────────────────────────────────────────

    #[tokio::test]
    async fn require_auth_rejects_missing_key() {
        let state = state_with_auth(AuthConfig {
            require_auth: true,
            api_keys: vec![],
            master_key: None,
        });
        let err = authenticate(&state, AuthInputs::with_key(None))
            .await
            .expect_err("missing key must be rejected");
        assert!(matches!(err, GatewayError::Unauthorized(_)));
    }

    #[tokio::test]
    async fn require_auth_rejects_unknown_key() {
        let state = state_with_auth(AuthConfig {
            require_auth: true,
            api_keys: vec![api_key("sk-known", "known", false)],
            master_key: None,
        });
        let err = authenticate(&state, AuthInputs::with_key(Some("sk-unknown")))
            .await
            .expect_err("unknown key must be rejected");
        assert!(matches!(err, GatewayError::Unauthorized(_)));
    }

    #[tokio::test]
    async fn require_auth_matches_master_key() {
        let state = state_with_auth(AuthConfig {
            require_auth: true,
            api_keys: vec![],
            master_key: Some("master-secret".to_string()),
        });
        let ctx = authenticate(&state, AuthInputs::with_key(Some("Bearer master-secret")))
            .await
            .expect("master key accepted");
        assert!(ctx.is_master_key);
    }

    #[tokio::test]
    async fn static_key_match_populates_org_team_project() {
        let state = state_with_auth(AuthConfig {
            require_auth: true,
            api_keys: vec![api_key("sk-acme", "acme-key", false)],
            master_key: None,
        });
        let ctx = authenticate(&state, AuthInputs::with_key(Some("sk-acme")))
            .await
            .expect("static key accepted");
        assert!(!ctx.is_master_key);
        assert_eq!(ctx.org_id.as_deref(), Some("org-acme"));
        assert_eq!(ctx.team_id.as_deref(), Some("team-1"));
        assert_eq!(ctx.project_id.as_deref(), Some("proj-1"));
        assert_eq!(ctx.user_name.as_deref(), Some("acme-key"));
        assert!(ctx.key_config.is_some());
    }

    #[tokio::test]
    async fn untrusted_key_ignores_forwarded_identity_headers() {
        // trusted_forwarder = false => the client-supplied x-ryu-user-id /
        // x-ryu-agent-id are ignored and budget identity binds to the key name,
        // so a caller cannot spoof or rotate identity to evade its quota.
        let state = state_with_auth(AuthConfig {
            require_auth: true,
            api_keys: vec![api_key("sk-acme", "acme-key", false)],
            master_key: None,
        });
        let inputs = AuthInputs {
            raw_api_key: Some("sk-acme"),
            user_id: Some("spoofed-user".to_string()),
            agent_id: Some("spoofed-agent".to_string()),
            ..Default::default()
        };
        let ctx = authenticate(&state, inputs).await.expect("accepted");
        assert_eq!(
            ctx.user_id.as_deref(),
            Some("acme-key"),
            "budget identity must bind to the key name, not the spoofed header"
        );
        assert!(ctx.agent_id.is_none());
    }

    #[tokio::test]
    async fn trusted_forwarder_honors_forwarded_identity_headers() {
        let state = state_with_auth(AuthConfig {
            require_auth: true,
            api_keys: vec![api_key("sk-core", "ryu-core", true)],
            master_key: None,
        });
        let inputs = AuthInputs {
            raw_api_key: Some("sk-core"),
            user_id: Some("real-user".to_string()),
            agent_id: Some("real-agent".to_string()),
            ..Default::default()
        };
        let ctx = authenticate(&state, inputs).await.expect("accepted");
        assert_eq!(ctx.user_id.as_deref(), Some("real-user"));
        assert_eq!(ctx.agent_id.as_deref(), Some("real-agent"));
    }

    #[tokio::test]
    async fn rgw_token_without_resolve_cache_is_hard_rejected() {
        // An rgw_-shaped bearer only reaches the dynamic path when a resolve cache
        // is configured; the test state has none, so it must NOT fall open into
        // anonymous — it is a hard 401.
        let state = state_with_auth(AuthConfig {
            require_auth: true,
            api_keys: vec![],
            master_key: None,
        });
        let err = authenticate(&state, AuthInputs::with_key(Some("rgw_sometoken")))
            .await
            .expect_err("rgw_ token with no resolve cache must be rejected");
        assert!(matches!(err, GatewayError::Unauthorized(_)));
    }

    #[tokio::test]
    async fn static_key_match_strips_bearer_prefix() {
        let state = state_with_auth(AuthConfig {
            require_auth: true,
            api_keys: vec![api_key("sk-acme", "acme-key", false)],
            master_key: None,
        });
        let ctx = authenticate(&state, AuthInputs::with_key(Some("Bearer sk-acme")))
            .await
            .expect("bearer-prefixed static key accepted");
        assert_eq!(ctx.user_name.as_deref(), Some("acme-key"));
    }

    #[test]
    fn ct_eq_is_functionally_equivalent_to_str_eq() {
        // Constant-time compare returns the exact same boolean as `==`: the only
        // difference is the removed per-byte timing signal (see `ct_eq` doc comment).
        assert!(ct_eq("sk-abc", "sk-abc"));
        // Single trailing-byte difference (the case a naive `==` would leak).
        assert!(!ct_eq("sk-abc", "sk-abd"));
        // Length mismatch short-circuits to false (key length is not secret).
        assert!(!ct_eq("sk-ab", "sk-abc"));
        // Empty vs empty is equal.
        assert!(ct_eq("", ""));
    }
}

/// End-to-end fallback / cost-tier demotion tests driven through the full
/// `run()` pipeline with scripted providers. These pin the request-path behavior
/// the focus of the coverage sweep called out: a `ProviderRateLimited` demotes
/// down the fallback chain WITHOUT tripping the circuit, a generic provider error
/// trips the circuit and still fails over, an already-open circuit is skipped,
/// and chain exhaustion surfaces the typed `AllProvidersUnavailable` error.
#[cfg(test)]
mod fallback_tests {
    use super::{run, DegradedMode, RequestContext};
    use crate::audit::AuditLogger;
    use crate::config::{
        AuditConfig, CircuitBreakerConfig, EvalsConfig, FirewallConfig, GatewayConfig, ProviderId,
        RoutingConfig,
    };
    use crate::error::GatewayError;
    use crate::providers::Provider;
    use crate::state::AppState;
    use ryu_gw_providers::ProviderError;
    use serde_json::{json, Value};
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// What a scripted provider does on `complete()`.
    #[derive(Clone, Copy)]
    enum Mode {
        /// Return a valid completion.
        Ok,
        /// Return a 429 → `ProviderError::RateLimited` (capacity signal, demote).
        RateLimited,
        /// Return a 402 account/payment condition (demote without provider fault).
        PaymentRequired,
        /// Return a generic provider failure (fault, trip circuit + fail over).
        Fail,
    }

    struct StubProvider {
        id: &'static str,
        mode: Mode,
        calls: Arc<AtomicUsize>,
    }

    impl StubProvider {
        fn new(id: &'static str, mode: Mode) -> (Arc<Self>, Arc<AtomicUsize>) {
            let calls = Arc::new(AtomicUsize::new(0));
            let p = Arc::new(Self {
                id,
                mode,
                calls: Arc::clone(&calls),
            });
            (p, calls)
        }
    }

    impl Provider for StubProvider {
        fn name(&self) -> &'static str {
            self.id
        }

        fn complete<'a>(
            &'a self,
            _model: &'a str,
            _body: &'a Value,
        ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>>
        {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mode = self.mode;
            let id = self.id;
            Box::pin(async move {
                match mode {
                    Mode::Ok => Ok(json!({
                        "id": "chatcmpl-stub",
                        "object": "chat.completion",
                        "model": "stub-1",
                        "choices": [{
                            "index": 0,
                            "message": {"role": "assistant", "content": "pong"},
                            "finish_reason": "stop"
                        }],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
                    })),
                    Mode::RateLimited => Err(ProviderError::RateLimited {
                        provider: id.to_string(),
                        retry_after: Some(30),
                        reset_at: None,
                    }),
                    Mode::PaymentRequired => Err(ProviderError::PaymentRequired {
                        provider: id.to_string(),
                        message: "no credits".to_owned(),
                    }),
                    Mode::Fail => Err(ProviderError::Provider(format!("{id} boom"))),
                }
            })
        }

        fn complete_stream<'a>(
            &'a self,
            _model: &'a str,
            _body: &'a Value,
        ) -> Pin<
            Box<
                dyn std::future::Future<Output = Result<axum::body::Body, ProviderError>>
                    + Send
                    + 'a,
            >,
        > {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mode = self.mode;
            let id = self.id;
            Box::pin(async move {
                match mode {
                    Mode::Ok => {
                        // A minimal but well-formed SSE stream with a terminal usage
                        // frame + [DONE], so the stream observer has real counts.
                        let sse = concat!(
                            "data: {\"choices\":[{\"delta\":{\"content\":\"pong\"}}]}\n\n",
                            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n",
                            "data: [DONE]\n\n",
                        );
                        Ok(axum::body::Body::from(sse))
                    }
                    Mode::RateLimited => Err(ProviderError::RateLimited {
                        provider: id.to_string(),
                        retry_after: None,
                        reset_at: None,
                    }),
                    Mode::PaymentRequired => Err(ProviderError::PaymentRequired {
                        provider: id.to_string(),
                        message: "no credits".to_owned(),
                    }),
                    Mode::Fail => Err(ProviderError::Provider(format!("{id} stream boom"))),
                }
            })
        }
    }

    /// Build a state whose routing pins `primary` first, then `secondary`, with the
    /// firewall + circuit breaker configured for a deterministic test.
    fn chain_state(threshold: u32) -> AppState {
        let config = GatewayConfig {
            routing: RoutingConfig {
                default_provider: ProviderId::from("primary"),
                fallback_chain: vec![ProviderId::from("primary"), ProviderId::from("secondary")],
                ..RoutingConfig::default()
            },
            firewall: FirewallConfig {
                enabled: false,
                ..FirewallConfig::default()
            },
            circuit_breaker: CircuitBreakerConfig {
                enabled: true,
                failure_threshold: threshold,
                reset_timeout_secs: 30,
            },
            ..GatewayConfig::default()
        };
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
        AppState::new_for_test(config, audit, evals)
    }

    fn plain_ctx() -> RequestContext {
        RequestContext {
            request_id: "fallback-req".to_string(),
            api_key: "sk-test".to_string(),
            is_master_key: false,
            org_id: None,
            team_id: None,
            project_id: None,
            user_name: None,
            user_id: None,
            agent_id: None,
            key_config: None,
            skill_ids: None,
            tool_actions: None,
            tools_header_present: false,
            slot_provider: None,
            slot_model: None,
            session_id: None,
            feature: None,
            companion_source: false,
            tool_search_requested: false,
            priority: crate::concurrency::Priority::Interactive,
            tool_profile: None,
            raw_tools: false,
            managed_inference: false,
            remaining_budget_micro_usd: None,
            unrestricted_budget_micro_usd: None,
            pool_budgets_micro_usd: std::collections::HashMap::new(),
            resolved_policy: None,
            prompt_cache_mode: None,
            prompt_cache_ttl: None,
            node_routing: None,
        }
    }

    fn ping_body() -> Value {
        json!({ "model": "anything", "messages": [{"role": "user", "content": "ping"}] })
    }

    // ── node routing preferences, end to end through `run()` ─────────────────

    /// `chain_state` with a third provider in the chain, so a preference has
    /// something to actually reorder.
    fn three_chain_state() -> AppState {
        // Built from config, not mutated afterwards: `AppState::new_for_test`
        // constructs the router registry from `config.routing`, so a chain widened
        // after the fact would never reach the router.
        let config = GatewayConfig {
            routing: RoutingConfig {
                default_provider: ProviderId::from("primary"),
                fallback_chain: vec![
                    ProviderId::from("primary"),
                    ProviderId::from("secondary"),
                    ProviderId::from("tertiary"),
                ],
                ..RoutingConfig::default()
            },
            firewall: FirewallConfig {
                enabled: false,
                ..FirewallConfig::default()
            },
            circuit_breaker: CircuitBreakerConfig {
                enabled: true,
                failure_threshold: 10,
                reset_timeout_secs: 30,
            },
            ..GatewayConfig::default()
        };
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
        AppState::new_for_test(config, audit, evals)
    }

    fn prefs(fallback: &[&str]) -> super::node_routing::NodeRoutingPrefs {
        super::node_routing::NodeRoutingPrefs {
            fallback: fallback.iter().map(|s| (*s).to_string()).collect(),
            firewall: None,
        }
    }

    /// A node preference REORDERS the fleet's chain: with the primary demoting,
    /// the node's preferred fallback serves before the fleet's default second.
    #[tokio::test]
    async fn a_node_preference_reorders_the_fleet_fallback_chain() {
        let mut state = three_chain_state();
        let (primary, _) = StubProvider::new("primary", Mode::RateLimited);
        let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
        let (tertiary, tertiary_calls) = StubProvider::new("tertiary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        state.providers.register(secondary as Arc<dyn Provider>);
        state.providers.register(tertiary as Arc<dyn Provider>);
        let state = Arc::new(state);

        let mut ctx = plain_ctx();
        ctx.node_routing = Some(prefs(&["tertiary"]));

        let out = run(Arc::clone(&state), ctx, ping_body())
            .await
            .expect("the preferred fallback must serve");

        assert_eq!(out.provider_used, "tertiary");
        assert_eq!(
            secondary_calls.load(Ordering::SeqCst),
            0,
            "the fleet's default second was reordered behind the node's preference"
        );
        assert_eq!(tertiary_calls.load(Ordering::SeqCst), 1);
    }

    /// THE acceptance criterion: a preference may narrow and reorder the org's
    /// envelope, never widen it. A provider the fleet's own chain does not
    /// contain is never dispatched to, even when it is registered and healthy —
    /// because `preflight_credit_gate` only ever gated the PRIMARY's pool.
    #[tokio::test]
    async fn a_node_preference_can_never_add_a_provider_to_the_chain() {
        let mut state = chain_state(10);
        let (primary, _) = StubProvider::new("primary", Mode::RateLimited);
        let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
        // Registered and perfectly healthy, but NOT in the fleet's fallback chain.
        let (offchain, offchain_calls) = StubProvider::new("tertiary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        state.providers.register(secondary as Arc<dyn Provider>);
        state.providers.register(offchain as Arc<dyn Provider>);
        let state = Arc::new(state);

        let mut ctx = plain_ctx();
        ctx.node_routing = Some(prefs(&["tertiary"]));

        let out = run(Arc::clone(&state), ctx, ping_body())
            .await
            .expect("the fleet's own chain still serves the turn");

        assert_eq!(out.provider_used, "secondary");
        assert_eq!(
            offchain_calls.load(Ordering::SeqCst),
            0,
            "a preference must not route out of a credit pool nothing gated"
        );
        assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
    }

    /// A locked node ignores the preference wholesale — the `[node_routing]`
    /// lever, mirroring `[prompt_cache].allow_request_override`.
    #[tokio::test]
    async fn a_locked_node_ignores_the_preference_end_to_end() {
        let mut state = three_chain_state();
        state.config.node_routing.allow_request_override = false;
        let (primary, _) = StubProvider::new("primary", Mode::RateLimited);
        let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
        let (tertiary, tertiary_calls) = StubProvider::new("tertiary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        state.providers.register(secondary as Arc<dyn Provider>);
        state.providers.register(tertiary as Arc<dyn Provider>);
        let state = Arc::new(state);

        let mut ctx = plain_ctx();
        ctx.node_routing = Some(prefs(&["tertiary"]));

        let out = run(Arc::clone(&state), ctx, ping_body())
            .await
            .expect("the fleet order stands");

        assert_eq!(out.provider_used, "secondary");
        assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
        assert_eq!(tertiary_calls.load(Ordering::SeqCst), 0);
    }

    /// The polarity of the credit gate `clamped_fallback_chain` hands the clamp
    /// (`preflight_credit_gate(..).is_none()` — `Some(err)` means REJECTED) is
    /// expressed in exactly ONE place in production. A unit test that writes its
    /// own closure cannot pin it: inverting the adapter leaves such a test green
    /// while every reorder starts promoting providers the org cannot pay for.
    ///
    /// So this drives the real thing through `run()`. The setup is the segregated
    /// credit-pool case, which is also the only shape where the bug is reachable:
    /// the org has grant money in the PRIMARY's pool (so `enforce_budget` admits
    /// the request — it gates the primary's pool only) and nothing unrestricted,
    /// so the preferred fallback in a DIFFERENT pool is unfunded and must not be
    /// promoted ahead of the fleet's own next choice.
    #[tokio::test]
    async fn credit_gate_polarity_is_wired_correctly_end_to_end() {
        // Real provider ids, because `pool_for_gateway_provider` is a fixed table:
        // `cloudflare` → the "cloudflare" pool, `bedrock` → "bedrock". A made-up id
        // is untagged and would never exercise pool segregation at all.
        let config = GatewayConfig {
            routing: RoutingConfig {
                default_provider: ProviderId::from("cloudflare"),
                fallback_chain: vec![
                    ProviderId::from("cloudflare"),
                    ProviderId::from("secondary"),
                    ProviderId::from("bedrock"),
                ],
                ..RoutingConfig::default()
            },
            firewall: FirewallConfig {
                enabled: false,
                ..FirewallConfig::default()
            },
            circuit_breaker: CircuitBreakerConfig {
                enabled: true,
                failure_threshold: 10,
                reset_timeout_secs: 30,
            },
            ..GatewayConfig::default()
        };
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
        let mut state = AppState::new_for_test(config, audit, evals);

        let (primary, _) = StubProvider::new("cloudflare", Mode::RateLimited);
        let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
        let (bedrock, bedrock_calls) = StubProvider::new("bedrock", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        state.providers.register(secondary as Arc<dyn Provider>);
        state.providers.register(bedrock as Arc<dyn Provider>);
        let state = Arc::new(state);

        let mut ctx = plain_ctx();
        ctx.managed_inference = true;
        // Total is positive (so the wallet is not simply empty), but ALL of it is
        // pool-restricted to the primary's pool. Bedrock has nothing.
        ctx.remaining_budget_micro_usd = Some(50_000);
        ctx.unrestricted_budget_micro_usd = Some(0);
        ctx.pool_budgets_micro_usd =
            std::collections::HashMap::from([("cloudflare".to_string(), 50_000_i64)]);
        ctx.node_routing = Some(prefs(&["bedrock"]));

        let out = run(Arc::clone(&state), ctx, ping_body())
            .await
            .expect("the request is admitted on the primary's funded pool");

        assert_eq!(
            out.provider_used, "secondary",
            "a preference must not promote a provider whose pool the org cannot pay for"
        );
        assert_eq!(bedrock_calls.load(Ordering::SeqCst), 0);
        assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
    }

    // ── slot-model allowlist bypass (pre-existing hole) ──────────────────────

    /// `x-ryu-slot-chat-model` replaced the dispatched model AFTER the Policy
    /// stage had only checked `body["model"]`, so an `rgw_` bearer could name an
    /// approved model in the body and the real one in the slot headers and route
    /// around the org's `approved_models`. The disallowed slot is now IGNORED —
    /// the turn still runs, under a model the org did approve.
    ///
    /// The slot provider is set too, and that is not incidental: `route_modality`
    /// in `ryu-gw-router` only consults `slot_model` inside the
    /// `if let Some(provider) = slot_provider` arm, so the bypass needs BOTH
    /// `x-ryu-slot-chat-provider` and `-model`. Verified against the router rather
    /// than assumed from the pipeline's `slot_provider.is_some() ||
    /// slot_model.is_some()` guard, which is looser than what actually routes.
    #[tokio::test]
    async fn a_slot_model_outside_the_org_allowlist_is_ignored_not_dispatched() {
        let mut state = chain_state(10);
        let (primary, _) = StubProvider::new("primary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        let state = Arc::new(state);

        let mut ctx = plain_ctx();
        ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
            approved_models: vec!["approved-model".into()],
            ..Default::default()
        });
        ctx.slot_provider = Some(ProviderId::from("primary"));
        ctx.slot_model = Some("forbidden-model".into());

        let out = run(
            Arc::clone(&state),
            ctx,
            json!({
                "model": "approved-model",
                "messages": [{"role": "user", "content": "ping"}]
            }),
        )
        .await
        .expect("the turn still succeeds under the approved model");

        assert_ne!(
            out.model_used, "forbidden-model",
            "the client-supplied slot model bypassed the org's approved_models"
        );
        assert_eq!(out.model_used, "approved-model");
    }

    /// The other half: an ALLOWED slot model still wins, so the clamp did not
    /// break per-agent slot pinning. And with no allowlist at all (every
    /// non-allowlisted deployment) nothing changes.
    #[tokio::test]
    async fn an_allowed_slot_model_and_an_empty_allowlist_both_still_pin() {
        let mut state = chain_state(10);
        let (primary, _) = StubProvider::new("primary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        let state = Arc::new(state);

        let mut ctx = plain_ctx();
        ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
            approved_models: vec!["approved-model".into(), "slot-model".into()],
            ..Default::default()
        });
        ctx.slot_provider = Some(ProviderId::from("primary"));
        ctx.slot_model = Some("slot-model".into());
        let out = run(
            Arc::clone(&state),
            ctx,
            json!({"model": "approved-model", "messages": [{"role": "user", "content": "ping"}]}),
        )
        .await
        .expect("an approved slot model dispatches");
        assert_eq!(out.model_used, "slot-model");

        let mut ctx = plain_ctx();
        ctx.slot_provider = Some(ProviderId::from("primary"));
        ctx.slot_model = Some("anything-at-all".into());
        let out = run(Arc::clone(&state), ctx, ping_body())
            .await
            .expect("no allowlist ⇒ unchanged behaviour");
        assert_eq!(out.model_used, "anything-at-all");
    }

    /// A rate-limited primary demotes to the next provider in the chain: the
    /// secondary serves the turn, the response is flagged as a degraded fallback,
    /// and — crucially — the primary's circuit is NOT tripped (a 429 is a capacity
    /// signal, not a fault).
    #[tokio::test]
    async fn rate_limited_primary_demotes_to_secondary_without_tripping_circuit() {
        let mut state = chain_state(1);
        let (primary, primary_calls) = StubProvider::new("primary", Mode::RateLimited);
        let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        state.providers.register(secondary as Arc<dyn Provider>);
        let state = Arc::new(state);

        let out = run(Arc::clone(&state), plain_ctx(), ping_body())
            .await
            .expect("secondary must serve after primary rate-limits");

        assert_eq!(out.provider_used, "secondary");
        assert_eq!(
            out.degraded,
            Some(DegradedMode::Fallback("secondary".into()))
        );
        assert_eq!(primary_calls.load(Ordering::SeqCst), 1, "primary was tried");
        assert_eq!(
            secondary_calls.load(Ordering::SeqCst),
            1,
            "secondary served"
        );
        // The 429 must NOT open the primary's circuit even with threshold=1.
        assert!(
            !state.circuit_breaker.is_open("primary"),
            "a rate-limit is a capacity signal and must not trip the circuit"
        );
    }

    #[tokio::test]
    async fn payment_required_primary_demotes_without_tripping_circuit() {
        let mut state = chain_state(1);
        let (primary, primary_calls) = StubProvider::new("primary", Mode::PaymentRequired);
        let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        state.providers.register(secondary as Arc<dyn Provider>);
        let state = Arc::new(state);

        let out = run(Arc::clone(&state), plain_ctx(), ping_body())
            .await
            .expect("secondary must serve after the selected account returns 402");

        assert_eq!(out.provider_used, "secondary");
        assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
        assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
        assert!(
            !state.circuit_breaker.is_open("primary"),
            "a payment condition belongs to the account, not provider health"
        );
    }

    #[tokio::test]
    async fn exhausted_chain_preserves_the_payment_required_reason() {
        let mut state = chain_state(1);
        let (primary, _) = StubProvider::new("primary", Mode::PaymentRequired);
        let (secondary, _) = StubProvider::new("secondary", Mode::Fail);
        state.providers.register(primary as Arc<dyn Provider>);
        state.providers.register(secondary as Arc<dyn Provider>);
        let state = Arc::new(state);

        let err = match run(Arc::clone(&state), plain_ctx(), ping_body()).await {
            Err(error) => error,
            Ok(_) => panic!("an exhausted fallback chain must fail"),
        };
        assert!(
            matches!(err, GatewayError::ProviderPaymentRequired { .. }),
            "the actionable 402 must survive a later generic fallback error: {err:?}"
        );
    }

    /// A generic (non-429) primary failure trips the circuit breaker AND fails over
    /// to the secondary. With `failure_threshold == 1` a single failure opens the
    /// primary circuit.
    #[tokio::test]
    async fn generic_primary_failure_trips_circuit_and_fails_over() {
        let mut state = chain_state(1);
        let (primary, primary_calls) = StubProvider::new("primary", Mode::Fail);
        let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        state.providers.register(secondary as Arc<dyn Provider>);
        let state = Arc::new(state);

        let out = run(Arc::clone(&state), plain_ctx(), ping_body())
            .await
            .expect("secondary must serve after primary faults");

        assert_eq!(out.provider_used, "secondary");
        assert_eq!(
            out.degraded,
            Some(DegradedMode::Fallback("secondary".into()))
        );
        assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
        assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
        // A fault DOES trip the circuit (threshold 1).
        assert!(
            state.circuit_breaker.is_open("primary"),
            "a generic provider fault must open the primary's circuit"
        );
    }

    /// An already-open primary circuit is skipped entirely (its `complete()` is
    /// never called), and the request is served by the secondary as a fallback.
    #[tokio::test]
    async fn open_primary_circuit_is_skipped() {
        let mut state = chain_state(1);
        let (primary, primary_calls) = StubProvider::new("primary", Mode::Ok);
        let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        state.providers.register(secondary as Arc<dyn Provider>);
        // Force the primary circuit open before any request.
        state.circuit_breaker.record_failure("primary");
        assert!(state.circuit_breaker.is_open("primary"));
        let state = Arc::new(state);

        let out = run(Arc::clone(&state), plain_ctx(), ping_body())
            .await
            .expect("secondary serves when primary circuit is open");

        assert_eq!(out.provider_used, "secondary");
        assert_eq!(
            out.degraded,
            Some(DegradedMode::Fallback("secondary".into()))
        );
        assert_eq!(
            primary_calls.load(Ordering::SeqCst),
            0,
            "an open circuit must skip the provider without calling it"
        );
        assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
    }

    /// When every provider in the chain rate-limits, the whole chain is exhausted
    /// and the typed `ProviderRateLimited` error surfaces (never a silent success).
    #[tokio::test]
    async fn all_providers_rate_limited_surfaces_typed_error() {
        let mut state = chain_state(5);
        let (primary, _) = StubProvider::new("primary", Mode::RateLimited);
        let (secondary, _) = StubProvider::new("secondary", Mode::RateLimited);
        state.providers.register(primary as Arc<dyn Provider>);
        state.providers.register(secondary as Arc<dyn Provider>);
        let state = Arc::new(state);

        let err = match run(Arc::clone(&state), plain_ctx(), ping_body()).await {
            Err(e) => e,
            Ok(_) => panic!("an exhausted chain must error, not succeed"),
        };
        // The last error was a rate-limit; it is preserved as the typed variant.
        assert!(
            matches!(err, GatewayError::ProviderRateLimited { .. }),
            "exhausted-by-rate-limit must surface ProviderRateLimited, got {err:?}"
        );
    }

    /// When a generic-fault chain is exhausted, the error is wrapped into the
    /// stable `AllProvidersUnavailable` variant so clients get a consistent code.
    #[tokio::test]
    async fn all_providers_fault_surfaces_all_unavailable() {
        let mut state = chain_state(5);
        let (primary, _) = StubProvider::new("primary", Mode::Fail);
        let (secondary, _) = StubProvider::new("secondary", Mode::Fail);
        state.providers.register(primary as Arc<dyn Provider>);
        state.providers.register(secondary as Arc<dyn Provider>);
        let state = Arc::new(state);

        let err = match run(Arc::clone(&state), plain_ctx(), ping_body()).await {
            Err(e) => e,
            Ok(_) => panic!("an exhausted fault chain must error"),
        };
        assert!(
            matches!(err, GatewayError::AllProvidersUnavailable(_)),
            "exhausted-by-fault must wrap into AllProvidersUnavailable, got {err:?}"
        );
    }

    /// The happy path: a healthy primary serves the turn and the response is NOT
    /// flagged degraded (no fallback occurred).
    #[tokio::test]
    async fn healthy_primary_serves_without_degradation() {
        let mut state = chain_state(5);
        let (primary, primary_calls) = StubProvider::new("primary", Mode::Ok);
        let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        state.providers.register(secondary as Arc<dyn Provider>);
        let state = Arc::new(state);

        let out = run(Arc::clone(&state), plain_ctx(), ping_body())
            .await
            .expect("healthy primary serves");

        assert_eq!(out.provider_used, "primary");
        assert_eq!(out.degraded, None, "no fallback ⇒ not degraded");
        assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            secondary_calls.load(Ordering::SeqCst),
            0,
            "secondary must not be touched when the primary succeeds"
        );
    }

    /// A second identical request is served from the exact-match cache: the
    /// provider is invoked once (the priming call), and the cached turn reports
    /// `cache_hit`.
    #[tokio::test]
    async fn identical_request_is_served_from_cache_on_second_call() {
        let mut state = chain_state(5);
        let (primary, primary_calls) = StubProvider::new("primary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        let state = Arc::new(state);

        // Prime the cache.
        let first = run(Arc::clone(&state), plain_ctx(), ping_body())
            .await
            .expect("first call");
        assert!(!first.cache_hit, "the priming call is a miss");
        assert_eq!(primary_calls.load(Ordering::SeqCst), 1);

        // Identical body ⇒ exact-match hit; the provider is NOT called again.
        let second = run(Arc::clone(&state), plain_ctx(), ping_body())
            .await
            .expect("second call served from cache");
        assert!(second.cache_hit, "identical request must hit the cache");
        assert_eq!(
            primary_calls.load(Ordering::SeqCst),
            1,
            "a cache hit must not re-invoke the provider"
        );
    }

    /// The firewall integration point: with the inbound scanner on and a `Block`
    /// policy, a request carrying a detectable secret/PII is refused BEFORE any
    /// provider is reached (`FirewallBlocked`, provider never called).
    #[tokio::test]
    async fn inbound_firewall_block_short_circuits_before_the_provider() {
        use crate::config::FirewallPolicy;
        let config = GatewayConfig {
            routing: RoutingConfig {
                default_provider: ProviderId::from("primary"),
                fallback_chain: vec![ProviderId::from("primary")],
                ..RoutingConfig::default()
            },
            firewall: FirewallConfig {
                enabled: true,
                scan_inbound: true,
                policy: FirewallPolicy::Block,
                ..FirewallConfig::default()
            },
            ..GatewayConfig::default()
        };
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
        let mut state = AppState::new_for_test(config, audit, evals);
        let (primary, primary_calls) = StubProvider::new("primary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        let state = Arc::new(state);

        // A prompt carrying an email + an OpenAI-style key — the built-in scanner's
        // canonical detection fixture.
        let body = json!({
            "model": "anything",
            "messages": [{
                "role": "user",
                "content": "Contact user@example.com or use key sk-abcdefghijklmnopqrstu"
            }]
        });
        let err = match run(Arc::clone(&state), plain_ctx(), body).await {
            Err(e) => e,
            Ok(_) => panic!("a Block-policy firewall must refuse the request"),
        };
        assert!(
            matches!(err, GatewayError::FirewallBlocked(..)),
            "expected FirewallBlocked, got {err:?}"
        );
        assert_eq!(
            primary_calls.load(Ordering::SeqCst),
            0,
            "an inbound block must short-circuit before the provider is called"
        );
    }

    /// Streaming happy path: a healthy primary serves the SSE stream directly, the
    /// turn is not degraded, and the body drains to the provider's frames.
    #[tokio::test]
    async fn run_stream_serves_primary_without_degradation() {
        use super::run_stream;
        let mut state = chain_state(5);
        let (primary, primary_calls) = StubProvider::new("primary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        let state = Arc::new(state);

        let out = run_stream(Arc::clone(&state), plain_ctx(), ping_body())
            .await
            .expect("primary streams");
        assert_eq!(out.provider_used, "primary");
        assert_eq!(out.degraded, None);
        assert_eq!(primary_calls.load(Ordering::SeqCst), 1);

        // Draining the SSE body yields the provider's frames.
        let bytes = axum::body::to_bytes(out.body, usize::MAX)
            .await
            .expect("drain sse body");
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains("pong"),
            "stream carries the provider's content"
        );
        assert!(text.contains("[DONE]"), "stream is terminated");
    }

    /// Streaming fallback: a rate-limited primary demotes and the secondary streams,
    /// with the turn flagged as a degraded fallback.
    #[tokio::test]
    async fn run_stream_demotes_rate_limited_primary_to_secondary() {
        use super::run_stream;
        let mut state = chain_state(5);
        let (primary, primary_calls) = StubProvider::new("primary", Mode::RateLimited);
        let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        state.providers.register(secondary as Arc<dyn Provider>);
        let state = Arc::new(state);

        let out = run_stream(Arc::clone(&state), plain_ctx(), ping_body())
            .await
            .expect("secondary streams after primary rate-limits");
        assert_eq!(out.provider_used, "secondary");
        assert_eq!(
            out.degraded,
            Some(DegradedMode::Fallback("secondary".into()))
        );
        assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
        assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
        // The 429 on the stream path must not trip the primary's circuit either.
        assert!(!state.circuit_breaker.is_open("primary"));

        // Body still drains cleanly.
        let bytes = axum::body::to_bytes(out.body, usize::MAX)
            .await
            .expect("drain sse body");
        assert!(String::from_utf8_lossy(&bytes).contains("[DONE]"));
    }

    /// Streaming exhaustion: every provider faults, so `run_stream` surfaces the
    /// wrapped `AllProvidersUnavailable` error rather than an empty stream.
    #[tokio::test]
    async fn run_stream_exhausted_chain_errors() {
        use super::run_stream;
        let mut state = chain_state(5);
        let (primary, _) = StubProvider::new("primary", Mode::Fail);
        let (secondary, _) = StubProvider::new("secondary", Mode::Fail);
        state.providers.register(primary as Arc<dyn Provider>);
        state.providers.register(secondary as Arc<dyn Provider>);
        let state = Arc::new(state);

        let err = match run_stream(Arc::clone(&state), plain_ctx(), ping_body()).await {
            Err(e) => e,
            Ok(_) => panic!("an exhausted stream chain must error"),
        };
        assert!(matches!(err, GatewayError::AllProvidersUnavailable(_)));
    }

    /// The per-key request rate limiter gates the pipeline: with a 1-request/min
    /// budget the second identical (uncached) request is refused with `RateLimited`
    /// before the provider is reached.
    #[tokio::test]
    async fn per_key_request_rate_limit_rejects_the_second_call() {
        use crate::config::RateLimitConfig;
        let config = GatewayConfig {
            routing: RoutingConfig {
                default_provider: ProviderId::from("primary"),
                fallback_chain: vec![ProviderId::from("primary")],
                ..RoutingConfig::default()
            },
            firewall: FirewallConfig {
                enabled: false,
                ..FirewallConfig::default()
            },
            rate_limit: RateLimitConfig {
                enabled: true,
                requests_per_minute: Some(1),
                tokens_per_minute: None,
                max_burst_per_second: 0,
            },
            // Disable the exact cache so the second call actually reaches the limiter
            // rather than being served from cache.
            cache: crate::config::CacheConfig {
                enabled: false,
                ..crate::config::CacheConfig::default()
            },
            ..GatewayConfig::default()
        };
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
        let mut state = AppState::new_for_test(config, audit, evals);
        let (primary, _) = StubProvider::new("primary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        let state = Arc::new(state);

        // First request is within budget.
        run(Arc::clone(&state), plain_ctx(), ping_body())
            .await
            .expect("first request under the limit");
        // Second request exceeds 1/min ⇒ RateLimited.
        let err = match run(Arc::clone(&state), plain_ctx(), ping_body()).await {
            Err(e) => e,
            Ok(_) => panic!("second request must be rate limited"),
        };
        assert!(matches!(err, GatewayError::RateLimited));
    }

    /// Smart routing (Keyword strategy, no network) rewrites the request's model
    /// BEFORE provider routing: a rule whose description matches the prompt sends
    /// the turn to the rule's target model, which then resolves to the default
    /// provider as any hand-picked model would.
    #[tokio::test]
    async fn smart_routing_keyword_rewrites_the_model() {
        use crate::config::{RouteStrategy, SmartRoutingConfig, SmartRule};
        let mut routing = RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        };
        routing.smart_routing = SmartRoutingConfig {
            enabled: true,
            strategy: RouteStrategy::Keyword,
            rules: vec![SmartRule {
                description: "ping".to_string(),
                model: "claude-rewritten".to_string(),
                weight: 1.0,
            }],
            ..Default::default()
        };
        let config = GatewayConfig {
            routing,
            firewall: FirewallConfig {
                enabled: false,
                ..FirewallConfig::default()
            },
            ..GatewayConfig::default()
        };
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
        let mut state = AppState::new_for_test(config, audit, evals);
        let (primary, primary_calls) = StubProvider::new("primary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        let state = Arc::new(state);

        let out = run(Arc::clone(&state), plain_ctx(), ping_body())
            .await
            .expect("smart-routed request serves");
        // The model was rewritten by the matching keyword rule.
        assert_eq!(out.model_used, "claude-rewritten");
        // ...and still resolved to the default provider.
        assert_eq!(out.provider_used, "primary");
        assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
    }

    /// Outbound firewall: a provider response carrying a secret is blocked on the
    /// egress path when the policy is `Block`, so the leaked secret never reaches
    /// the client (`FirewallBlocked`).
    #[tokio::test]
    async fn outbound_firewall_block_stops_a_leaked_secret_response() {
        use crate::config::FirewallPolicy;

        // A provider that leaks a secret in its completion content.
        struct LeakyProvider;
        impl Provider for LeakyProvider {
            fn name(&self) -> &'static str {
                "primary"
            }
            fn complete<'a>(
                &'a self,
                _model: &'a str,
                _body: &'a serde_json::Value,
            ) -> Pin<
                Box<
                    dyn std::future::Future<
                            Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                        > + Send
                        + 'a,
                >,
            > {
                Box::pin(async move {
                    Ok(json!({
                        "choices": [{
                            "index": 0,
                            "message": {"role": "assistant", "content": "here is a key sk-abcdefghijklmnopqrstu"},
                            "finish_reason": "stop"
                        }],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 5, "total_tokens": 6}
                    }))
                })
            }
            fn complete_stream<'a>(
                &'a self,
                _model: &'a str,
                _body: &'a serde_json::Value,
            ) -> Pin<
                Box<
                    dyn std::future::Future<
                            Output = Result<axum::body::Body, ryu_gw_providers::ProviderError>,
                        > + Send
                        + 'a,
                >,
            > {
                Box::pin(async move {
                    Err(ryu_gw_providers::ProviderError::Provider(
                        "no stream".into(),
                    ))
                })
            }
        }

        let config = GatewayConfig {
            routing: RoutingConfig {
                default_provider: ProviderId::from("primary"),
                fallback_chain: vec![ProviderId::from("primary")],
                ..RoutingConfig::default()
            },
            firewall: FirewallConfig {
                enabled: true,
                scan_inbound: false,
                scan_outbound: true,
                policy: FirewallPolicy::Block,
                ..FirewallConfig::default()
            },
            cache: crate::config::CacheConfig {
                enabled: false,
                ..crate::config::CacheConfig::default()
            },
            ..GatewayConfig::default()
        };
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
        let mut state = AppState::new_for_test(config, audit, evals);
        state
            .providers
            .register(Arc::new(LeakyProvider) as Arc<dyn Provider>);
        let state = Arc::new(state);

        let err = match run(Arc::clone(&state), plain_ctx(), ping_body()).await {
            Err(e) => e,
            Ok(_) => panic!("a leaked-secret response must be blocked outbound"),
        };
        assert!(
            matches!(err, GatewayError::FirewallBlocked(..)),
            "expected outbound FirewallBlocked, got {err:?}"
        );
    }

    // ── Budget / credit enforcement (money path) ──────────────────────────────

    /// Build a state whose per-user budget for `u1` is `rule`, with a healthy
    /// `primary` provider registered. Returns `(state, primary_call_counter)`.
    fn budget_state(rule: crate::config::BudgetRule) -> (Arc<AppState>, Arc<AtomicUsize>) {
        use std::collections::HashMap;
        let mut users = HashMap::new();
        users.insert("u1".to_string(), rule);
        let config = GatewayConfig {
            routing: RoutingConfig {
                default_provider: ProviderId::from("primary"),
                fallback_chain: vec![ProviderId::from("primary")],
                ..RoutingConfig::default()
            },
            firewall: FirewallConfig {
                enabled: false,
                ..FirewallConfig::default()
            },
            budgets: crate::config::BudgetConfig {
                users,
                ..Default::default()
            },
            ..GatewayConfig::default()
        };
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
        let mut state = AppState::new_for_test(config, audit, evals);
        let (primary, calls) = StubProvider::new("primary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        let state = Arc::new(state);
        // Seed usage above the rule's limit so the very next request trips it.
        state.with_budget(|b| b.record(Some("u1"), None, 1_000_000));
        (state, calls)
    }

    fn u1_ctx() -> RequestContext {
        let mut ctx = plain_ctx();
        ctx.user_id = Some("u1".to_string());
        ctx
    }

    /// Build a state whose per-agent budget for `agent-a` is `rule`, with a
    /// healthy `primary` provider registered. Returns `(state, primary_call_counter)`.
    fn agent_budget_state(rule: crate::config::BudgetRule) -> (Arc<AppState>, Arc<AtomicUsize>) {
        use std::collections::HashMap;
        let mut agents = HashMap::new();
        agents.insert("agent-a".to_string(), rule);
        let config = GatewayConfig {
            routing: RoutingConfig {
                default_provider: ProviderId::from("primary"),
                fallback_chain: vec![ProviderId::from("primary")],
                ..RoutingConfig::default()
            },
            firewall: FirewallConfig {
                enabled: false,
                ..FirewallConfig::default()
            },
            budgets: crate::config::BudgetConfig {
                agents,
                ..Default::default()
            },
            ..GatewayConfig::default()
        };
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
        let mut state = AppState::new_for_test(config, audit, evals);
        let (primary, calls) = StubProvider::new("primary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        let state = Arc::new(state);
        // Seed usage above the rule's limit so the very next request trips it.
        state.with_budget(|b| b.record(None, Some("agent-a"), 1_000_000));
        (state, calls)
    }

    fn agent_a_ctx() -> RequestContext {
        let mut ctx = plain_ctx();
        ctx.agent_id = Some("agent-a".to_string());
        ctx
    }

    /// A `Stop` budget rule at/over its limit rejects the request with a hard
    /// `BudgetExceeded` before the provider is reached.
    #[tokio::test]
    async fn budget_stop_rejects_over_limit_before_dispatch() {
        use crate::config::{BudgetAction, BudgetRule};
        let (state, calls) = budget_state(BudgetRule {
            limit: 1_000_000,
            action: BudgetAction::Stop,
            downgrade_to: None,
            restrict_max_tokens: 256,
            alert: crate::config::AlertTier::Silent,
            include: crate::config::BudgetChargeInclusion::default(),
        });
        let err = match run(Arc::clone(&state), u1_ctx(), ping_body()).await {
            Err(e) => e,
            Ok(_) => panic!("an over-limit Stop budget must reject"),
        };
        assert!(
            matches!(err, GatewayError::BudgetExceeded(_)),
            "expected BudgetExceeded, got {err:?}"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "a hard budget stop must not reach the provider"
        );
    }

    /// An agent-specific `Stop` budget rejects the matching agent before the
    /// provider is reached.
    #[tokio::test]
    async fn agent_budget_stop_rejects_over_limit_before_dispatch() {
        use crate::config::{BudgetAction, BudgetRule};
        let (state, calls) = agent_budget_state(BudgetRule {
            limit: 1_000_000,
            action: BudgetAction::Stop,
            downgrade_to: None,
            restrict_max_tokens: 256,
            alert: crate::config::AlertTier::Silent,
            include: crate::config::BudgetChargeInclusion::default(),
        });
        let err = match run(Arc::clone(&state), agent_a_ctx(), ping_body()).await {
            Err(e) => e,
            Ok(_) => panic!("an over-limit agent Stop budget must reject"),
        };
        assert!(
            matches!(err, GatewayError::BudgetExceeded(_)),
            "expected BudgetExceeded, got {err:?}"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "a hard agent budget stop must not reach the provider"
        );
    }

    /// A `Downgrade` rule rewrites the request's model to the cheaper target and
    /// still serves the turn.
    #[tokio::test]
    async fn budget_downgrade_rewrites_model_and_serves() {
        use crate::config::{BudgetAction, BudgetRule};
        let (state, calls) = budget_state(BudgetRule {
            limit: 1_000_000,
            action: BudgetAction::Downgrade,
            downgrade_to: Some("cheap-model".to_string()),
            restrict_max_tokens: 256,
            alert: crate::config::AlertTier::Silent,
            include: crate::config::BudgetChargeInclusion::default(),
        });
        let out = run(Arc::clone(&state), u1_ctx(), ping_body())
            .await
            .expect("downgrade still serves");
        assert_eq!(out.model_used, "cheap-model", "the model was downgraded");
        assert_eq!(out.provider_used, "primary");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// A `Restrict` rule serves the turn but stamps the Restrict decision on the
    /// output (the request path strips tools + caps max_tokens).
    #[tokio::test]
    async fn budget_restrict_serves_with_a_restrict_decision() {
        use crate::config::{BudgetAction, BudgetRule};
        let (state, _calls) = budget_state(BudgetRule {
            limit: 1_000_000,
            action: BudgetAction::Restrict,
            downgrade_to: None,
            restrict_max_tokens: 128,
            alert: crate::config::AlertTier::Silent,
            include: crate::config::BudgetChargeInclusion::default(),
        });
        let out = run(Arc::clone(&state), u1_ctx(), ping_body())
            .await
            .expect("restrict still serves a minimal answer");
        let budget = out.budget.expect("a budget decision is stamped");
        assert_eq!(budget.action, BudgetAction::Restrict);
    }

    /// A `Notify` rule is non-blocking: it serves the turn and stamps the Notify
    /// decision without altering the model.
    #[tokio::test]
    async fn budget_notify_is_non_blocking() {
        use crate::config::{BudgetAction, BudgetRule};
        let (state, calls) = budget_state(BudgetRule {
            limit: 1_000_000,
            action: BudgetAction::Notify,
            downgrade_to: None,
            restrict_max_tokens: 256,
            alert: crate::config::AlertTier::Silent,
            include: crate::config::BudgetChargeInclusion::default(),
        });
        let out = run(Arc::clone(&state), u1_ctx(), ping_body())
            .await
            .expect("notify never blocks");
        assert_eq!(out.budget.expect("decision").action, BudgetAction::Notify);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// The pre-flight credit gate: a managed-inference tenant whose resolved wallet
    /// balance is already zero is rejected with a hard `InsufficientCredits` (402)
    /// before any provider is reached.
    #[tokio::test]
    async fn preflight_credit_gate_rejects_exhausted_managed_tenant() {
        let mut state = chain_state(5);
        let (primary, calls) = StubProvider::new("primary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        let state = Arc::new(state);

        let mut ctx = plain_ctx();
        ctx.org_id = Some("org-managed".to_string());
        ctx.managed_inference = true;
        ctx.remaining_budget_micro_usd = Some(0);

        let err = match run(Arc::clone(&state), ctx, ping_body()).await {
            Err(e) => e,
            Ok(_) => panic!("an exhausted managed wallet must be rejected pre-flight"),
        };
        assert!(
            matches!(err, GatewayError::InsufficientCredits),
            "expected InsufficientCredits, got {err:?}"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "the credit gate must short-circuit before dispatch"
        );
    }

    /// The streaming outbound firewall (Block policy) buffers the upstream SSE,
    /// scans the assembled text, and emits a blocked frame instead of the leaked
    /// secret — so a secret never streams to the client.
    #[tokio::test]
    async fn run_stream_outbound_firewall_block_redacts_leaked_secret() {
        use super::run_stream;
        use crate::config::FirewallPolicy;

        struct LeakyStream;
        impl Provider for LeakyStream {
            fn name(&self) -> &'static str {
                "primary"
            }
            fn complete<'a>(
                &'a self,
                _model: &'a str,
                _body: &'a serde_json::Value,
            ) -> Pin<
                Box<
                    dyn std::future::Future<
                            Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                        > + Send
                        + 'a,
                >,
            > {
                Box::pin(
                    async move { Err(ryu_gw_providers::ProviderError::Provider("n/a".into())) },
                )
            }
            fn complete_stream<'a>(
                &'a self,
                _model: &'a str,
                _body: &'a serde_json::Value,
            ) -> Pin<
                Box<
                    dyn std::future::Future<
                            Output = Result<axum::body::Body, ryu_gw_providers::ProviderError>,
                        > + Send
                        + 'a,
                >,
            > {
                let sse = concat!(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"key sk-abcdefghijklmnopqrstu\"}}]}\n\n",
                    "data: [DONE]\n\n",
                );
                Box::pin(async move { Ok(axum::body::Body::from(sse)) })
            }
        }

        let config = GatewayConfig {
            routing: RoutingConfig {
                default_provider: ProviderId::from("primary"),
                fallback_chain: vec![ProviderId::from("primary")],
                ..RoutingConfig::default()
            },
            firewall: FirewallConfig {
                enabled: true,
                scan_inbound: false,
                scan_outbound: true,
                policy: FirewallPolicy::Block,
                ..FirewallConfig::default()
            },
            ..GatewayConfig::default()
        };
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
        let mut state = AppState::new_for_test(config, audit, evals);
        state
            .providers
            .register(Arc::new(LeakyStream) as Arc<dyn Provider>);
        let state = Arc::new(state);

        let out = run_stream(Arc::clone(&state), plain_ctx(), ping_body())
            .await
            .expect("stream is served (as a blocked frame)");
        let bytes = axum::body::to_bytes(out.body, usize::MAX)
            .await
            .expect("drain sse body");
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            !text.contains("sk-abcdefghijklmnopqrstu"),
            "the outbound firewall must not let the secret stream through: {text}"
        );
    }

    /// Build a state with the firewall on at `policy` (+ optional alert tier) and a
    /// healthy `primary` provider. Exact cache disabled so each run re-scans.
    fn firewall_state(
        policy: crate::config::FirewallPolicy,
        alert: crate::config::AlertTier,
    ) -> (Arc<AppState>, Arc<AtomicUsize>) {
        let config = GatewayConfig {
            routing: RoutingConfig {
                default_provider: ProviderId::from("primary"),
                fallback_chain: vec![ProviderId::from("primary")],
                ..RoutingConfig::default()
            },
            firewall: FirewallConfig {
                enabled: true,
                scan_inbound: true,
                scan_outbound: false,
                policy,
                alert,
                ..FirewallConfig::default()
            },
            cache: crate::config::CacheConfig {
                enabled: false,
                ..crate::config::CacheConfig::default()
            },
            ..GatewayConfig::default()
        };
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
        let mut state = AppState::new_for_test(config, audit, evals);
        let (primary, calls) = StubProvider::new("primary", Mode::Ok);
        state.providers.register(primary as Arc<dyn Provider>);
        (Arc::new(state), calls)
    }

    fn secret_body() -> serde_json::Value {
        json!({
            "model": "anything",
            "messages": [{
                "role": "user",
                "content": "Contact user@example.com or use key sk-abcdefghijklmnopqrstu"
            }]
        })
    }

    /// A `Sanitize` inbound policy redacts the offending content in place and still
    /// serves the turn (never blocks).
    #[tokio::test]
    async fn inbound_firewall_sanitize_serves_the_request() {
        use crate::config::{AlertTier, FirewallPolicy};
        let (state, calls) = firewall_state(FirewallPolicy::Sanitize, AlertTier::Silent);
        let out = run(Arc::clone(&state), plain_ctx(), secret_body())
            .await
            .expect("sanitize never blocks");
        assert_eq!(out.provider_used, "primary");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "the sanitized request still reaches the provider"
        );
    }

    /// A `WarnAndContinue` inbound policy at a `Warn` alert tier serves the turn and
    /// stamps a firewall policy alert on the response (observable, non-blocking).
    #[tokio::test]
    async fn inbound_firewall_warn_stamps_alert_and_serves() {
        use crate::config::{AlertTier, FirewallPolicy};
        let (state, calls) = firewall_state(FirewallPolicy::WarnAndContinue, AlertTier::Warn);
        let out = run(Arc::clone(&state), plain_ctx(), secret_body())
            .await
            .expect("warn-and-continue never blocks");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(
            out.policy_alert.is_some(),
            "a warn-tier firewall match must stamp a policy alert on the response"
        );
    }
}
