use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use hmac::{Hmac, Mac};
use ryu_gw_contracts::credit_debit::CreditDebitReason;
use serde_json::{json, Value};
use sha2::Sha256;
use tracing::{debug, info, warn};
use uuid::Uuid;

#[cfg(test)]
mod audio_tests;
mod auxiliary;
mod edit_rescan;
#[cfg(test)]
mod edit_rescan_probe_tests;
#[cfg(test)]
mod edit_rescan_tests;
pub(crate) mod inference_governance;
mod media_knobs;
mod outbound_text;
#[cfg(test)]
mod outbound_text_tests;
#[cfg(test)]
mod phase0_bypass_tests;
mod pool_dispatch;
pub(crate) mod pool_execution;
#[cfg(test)]
mod pool_runtime_tests;
mod pool_signals;
#[cfg(test)]
mod pool_stream_tests;
pub(crate) mod upstream_features;
pub(crate) mod web;
use inference_governance::InferenceClient;
mod gen_ai_telemetry;
#[cfg(test)]
mod gen_ai_telemetry_tests;
pub(crate) mod model_alias;
mod own_supply;
pub(crate) mod provider_call_guard;
mod provider_usage;
mod stream_dlp;
#[cfg(test)]
mod stream_dlp_probe_tests;
#[cfg(test)]
mod stream_dlp_scope_tests;
mod tool_loop_screen;
#[cfg(test)]
mod tool_loop_screen_probe_tests;
#[cfg(test)]
mod tool_loop_screen_tests;
mod tool_rounds;
pub(crate) mod upstream_signals;
pub(crate) mod zero_data_retention;
use provider_usage::{
    cost_usd_to_micro, inject_stream_usage_option, provider_cache_write_tokens_reported,
    provider_cached_tokens_reported, response_reported_cost_usd, sse_estimate_output_tokens,
    sse_parse_cache_usage, sse_parse_cache_write_tokens_reported, sse_parse_cached_tokens_reported,
    sse_parse_cost, sse_parse_usage,
};

mod inline_eval;
use inline_eval::{
    backstop_flag, inline_detection_kind, inline_outcome, llm_judge_backstop_kind, InlineOutcome,
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
            org_limits: None,
            identity: None,
            standing: None,
            enforcement: None,
            host_conversation: None,
            authorized_operation: crate::config::ApiKeyOperation::Inference,
            provider_snapshot: None,
            request_id: "test-req".to_string(),
            api_key: "sk-test".to_string(),
            owner_binding: ryu_gw_credentials::fingerprint("sk-test"),
            is_master_key: false,
            org_id: None,
            team_id: None,
            project_id: None,
            user_name: None,
            user_id: None,
            agent_id: None,
            agent_provider_access: None,
            key_config: None,
            skill_ids: None,
            tool_actions: None,
            tools_header_present: false,
            capability_hints: None,
            slot_provider: None,
            slot_model: None,
            own_supply_route: None,
            violation_attempt: Default::default(),
            session_id: None,
            feature: None,
            purpose: None,
            companion_source: false,
            tool_search_requested: false,
            untrusted_caller: false,
            priority: crate::concurrency::Priority::Interactive,
            tool_profile: None,
            raw_tools: false,
            managed_inference: false,
            openrouter_routing_enabled: false,
            remaining_budget_micro_usd: None,
            unrestricted_budget_micro_usd: None,
            pool_budgets_micro_usd: std::collections::HashMap::new(),
            credit_accounting_unavailable: false,
            budget_resolved_at: None,
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
    budget::{BudgetAdmission, BudgetChargeKind, BudgetDecision, BudgetHold, CreditReservation},
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

// Production clusters split out of this file. Each child does `use super::*;`
// and the private globs below keep every item reachable inside `pipeline` by
// its old path; the `pub(crate) use` block re-exports what the rest of the
// crate imports as `crate::pipeline::<item>`.
pub(crate) use audit::audit_refused;
pub(crate) use auth::{authenticate, authenticate_for_operation, AuthInputs};
pub(crate) use body_shaping::ANTHROPIC_BETA_FIELD;
pub(crate) use core_proof::{ct_eq, has_core_proof_key};
pub(crate) use credit_reserve::credit_headroom_micro_usd;
pub(crate) use media_jobs::{submit_audio_job, submit_video_job};
pub(crate) use media_poll::{poll_audio_job, poll_video_job};
pub(crate) use prompt_text::is_dlp_guardrail;
pub(crate) use tool_debit::{
    external_tool_debit_reason, external_tool_ref_id, spawn_external_tool_debit_for_ids,
    spawn_managed_tool_debit, ManagedToolDebit,
};
mod audit;
use audit::*;
mod auth;
use auth::*;
mod auth_identity;
use auth_identity::*;
mod body_shaping;
use body_shaping::*;
mod budget;
use budget::*;
mod budget_charge;
use budget_charge::*;
mod core_proof;
use core_proof::*;
mod credit_reserve;
use credit_reserve::*;
mod debit;
use debit::*;
mod dlp_stream;
use dlp_stream::*;
mod inline_apply;
use inline_apply::*;
mod inline_flags;
use inline_flags::*;
mod json_text;
use json_text::*;
mod media_jobs;
use media_jobs::*;
mod media_poll;
mod prompt_text;
use prompt_text::*;
mod routing_smart;
use routing_smart::*;
mod stream_observe;
use stream_observe::*;
mod stream_observer;
use stream_observer::*;
mod stream_opening;
use stream_opening::*;
mod tool_debit;
use tool_debit::*;
mod tool_loop_select;
use tool_loop_select::*;

/// Build the firewall [`PolicyAlert`] for an inbound/outbound firewall match, or
/// `None` when the resolved firewall's `alert` tier is below `Warn` (so a
/// firewall with no configured tier fires no alert). `enforcement` is `block`
/// (Block) or `notify` (WarnAndContinue).
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
    pub(crate) authorized_operation: ApiKeyOperation,
    pub(crate) provider_snapshot: Option<Arc<crate::providers::ProviderSnapshot>>,
    pub request_id: String,
    pub api_key: String,
    /// Stable bearer binding used for asynchronous job ownership. Unlike
    /// `api_key`, this remains per-credential on dynamic org tokens and is not
    /// written to audit rows or returned to clients.
    pub owner_binding: String,
    pub is_master_key: bool,
    pub org_id: Option<String>,
    pub team_id: Option<String>,
    pub project_id: Option<String>,
    pub user_name: Option<String>,
    /// Caller identity for per-user budgets (U21), from `x-ryu-user-id`.
    pub user_id: Option<String>,
    /// Selected agent for per-agent budgets (U21), from `x-ryu-agent-id`.
    pub agent_id: Option<String>,
    /// The user's model providers this agent may use: Core's
    /// `x-ryu-agent-provider-access` header, intersected with a signed `gws1.`
    /// scope's list when both are present. `None` is unrestricted. It only ever
    /// narrows (see `inference_governance::authorize_agent_provider`), so it is
    /// honored from any caller: a forged value can only limit the forger. It
    /// limits only the user's own credentials: credential-free slots and a
    /// hosted organisation's fleet-served managed inference stay open.
    pub agent_provider_access: Option<Arc<std::collections::HashSet<String>>>,
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
    /// JSON-encoded, turn-scoped capability suggestion IDs from Core.
    pub capability_hints: Option<String>,
    /// Per-agent slot provider override (M3 / #164), from `x-ryu-slot-provider`.
    /// When set, this provider is used in place of the static modality_map entry
    /// for multimodal requests from carded agents. `None` falls back to the map.
    pub slot_provider: Option<ProviderId>,
    /// Per-agent slot model override (M3 / #164), from `x-ryu-slot-model`.
    /// When set alongside `slot_provider`, this model is forwarded to the provider
    /// instead of the config-pinned or caller-requested model.
    pub slot_model: Option<String>,
    /// Gateway-internal: the own-supply `(slot, upstream)` this attempt is
    /// dispatched to (see [`own_supply`]). Never set from a header or the body —
    /// only by the free-credit own-supply plan — so a client cannot name a slot
    /// through it. The body keeps the id the user picked, which is what the
    /// Policy stage authorized.
    pub own_supply_route: Option<(ProviderId, String)>,
    /// Gateway-internal: which attempt this context screens, for the
    /// violation events it records (spec 00.5). Default (0, no provider) for
    /// the inbound screens; an output screen or a tool round stamps its own
    /// on a clone. Never set from a header or the body.
    pub violation_attempt: crate::violations::AttemptRef,
    /// Core conversation/session id forwarded by Core via `x-ryu-session-id` (M4 / #176).
    /// Used as the correlation key for per-run/per-session audit queries.
    pub session_id: Option<String>,
    /// Product surface that originated this request (profiles / usage-points),
    /// from `x-ryu-feature` (`chat` | `island` | `predict` | `agent`). `None`
    /// when untagged (self-hosted / legacy callers). Recorded on the audit row so
    /// the reporter can build the per-feature daily usage breakdown.
    pub feature: Option<String>,
    /// Background feature behind this call, from `x-ryu-purpose`
    /// (`compaction`, `auto_title`, `plugin:<id>`, ...), already validated by
    /// [`crate::audit::valid_purpose`]. Recorded on the audit row so usage
    /// rollups can separate background spend; `feature` is unaffected.
    pub purpose: Option<String>,
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
    /// Core marked this turn as spoken by an unverified caller, from
    /// `x-ryu-untrusted-caller`. Restrict-only: the unified loop then offers
    /// neither `tool_search` nor the operator's always-on tools, grants nothing
    /// from capability hints, and a request without `x-ryu-tools` runs no
    /// managed tool loop at all.
    pub untrusted_caller: bool,
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
    /// Business-only OpenRouter node-routing entitlement from the control plane.
    /// Static and legacy contexts default to false.
    pub openrouter_routing_enabled: bool,
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
    /// The control plane could not read this managed tenant's entitlement or
    /// wallet (see [`crate::policy::TenantCredit::accounting_unavailable`]).
    /// Set only on a gateway that bills tenants; every credit gate then
    /// answers `503 credit_accounting_unavailable` instead of judging an
    /// unknown balance. `false` on every other path.
    pub credit_accounting_unavailable: bool,
    /// When the control-plane resolve that supplied the budget figures above
    /// was fetched. Resolutions are cached for up to a minute, per credential
    /// and operation, so the credit gate compares the last debit's balance
    /// report against THIS request's figures, not another entry's. `None` when
    /// the figures did not come from a resolve.
    pub budget_resolved_at: Option<Instant>,
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
    /// Control-plane org limits for a resolved `rgw_` request (contract C1):
    /// the org's caps, the presenting credential id, and the verified caller's
    /// teams. `None` on static-key, master, and anonymous paths.
    pub org_limits: Option<Arc<crate::org_limits::OrgLimitContext>>,
    /// Who this request is for (see [`crate::identity`]): the resolved
    /// credential, the verified user, the hashed tenant end user, the chosen
    /// actor and its upstream subject. Set by [`authenticate`]; `None` on
    /// contexts built outside it.
    pub identity: Option<Arc<crate::identity::RequestIdentity>>,
    /// What an in-flight tool loop or stream needs to check this request's
    /// platform standing again (see [`crate::standing::StandingGuard`]). Set
    /// for a dynamically resolved `rgw_` bearer; `None` everywhere else.
    pub standing: Option<Arc<crate::standing::StandingGuard>>,
    /// The abuse ladder's throttle and restrict posture and the in-flight
    /// slots this request holds on the fleet (see [`crate::enforcement`]).
    /// Set for a dynamically resolved `rgw_` bearer on `Fleet` custody when
    /// a level or the new-key limit applies; `None` everywhere else. The
    /// slots are given back when the last clone of the request drops.
    pub enforcement: Option<Arc<crate::enforcement::Enforcement>>,
    /// Core's proved host conversation for this turn, from
    /// `x-ryu-host-conversation-id` / `x-ryu-host-conversation-proof`. Kept only
    /// for a static trusted-forwarder key (see [`trusted_host_conversation`]);
    /// every other path drops it. The unified tool loop relays it to Core so
    /// each execution is judged against the turn owner's own tool rules.
    pub host_conversation: Option<crate::tools::HostConversation>,
}

impl RequestContext {
    /// This context stamped as the attempt at chain position `index`, bound
    /// to `provider`, for the screens of what that attempt produced.
    pub fn at_attempt(&self, index: usize, provider: &ProviderId) -> Self {
        let mut ctx = self.clone();
        ctx.violation_attempt = crate::violations::AttemptRef::new(index, Some(provider.clone()));
        ctx
    }

    /// Hosted credential id for audit rows and per-key rollups.
    pub fn key_id(&self) -> Option<String> {
        self.identity
            .as_ref()
            .and_then(|identity| identity.credential.as_ref())
            .map(|credential| credential.credential_id.clone())
            .or_else(|| {
                self.org_limits
                    .as_ref()
                    .and_then(|limits| limits.credential_id.clone())
            })
    }

    /// Every team this request is charged to, comma-joined for the audit row's
    /// `team_ids` (the reporter's `teamDaily` rollup credits each). Falls back
    /// to the single `team_id` for statically configured keys.
    pub fn audit_team_ids(&self) -> Option<String> {
        let teams = self
            .org_limits
            .as_ref()
            .map(|limits| limits.team_ids.as_slice())
            .unwrap_or_default();
        if teams.is_empty() {
            return self.team_id.clone();
        }
        Some(teams.join(","))
    }
}

/// Account bindings are scoped to the tenant and verified caller. A session id
/// alone must not collide or consume another caller's conversation capacity.
/// Owner binding for a Core-scoped inference bearer: a fingerprint of the
/// length-prefixed scope identity, so no two distinct scopes collide and none
/// collides with a fingerprint of a raw key.
fn scoped_inference_owner_binding(scope: &ryu_gw_credentials::InferenceScope) -> String {
    let field = |value: Option<&str>| {
        value.map_or_else(
            || "-".to_owned(),
            |value| format!("{}:{value}", value.len()),
        )
    };
    // The signed provider list is part of the scope: a limited and an unlimited
    // bearer for one agent never share stored responses or cache entries. The
    // list is sorted and each id length-prefixed; `-` is "no limit", which is
    // different from an empty list ("no provider").
    let provider_access = scope.provider_access.as_ref().map_or_else(
        || "-".to_owned(),
        |ids| {
            let mut ids: Vec<&str> = ids.iter().map(String::as_str).collect();
            ids.sort_unstable();
            ids.dedup();
            let ids: String = ids.iter().map(|id| format!("{}:{id},", id.len())).collect();
            format!("[{ids}]")
        },
    );
    ryu_gw_credentials::fingerprint(&format!(
        "gws1-scope\0{}\0{}\0{}\0{provider_access}",
        field(Some(&scope.agent_id)),
        field(scope.user_id.as_deref()),
        field(scope.session_id.as_deref()),
    ))
}

fn account_affinity(ctx: &RequestContext, body: &Value) -> Option<String> {
    let session = ctx
        .session_id
        .as_deref()
        .or_else(|| body.get("prompt_cache_key").and_then(Value::as_str))
        .or_else(|| body.get("conversation_id").and_then(Value::as_str))
        .or_else(|| body.get("sessionId").and_then(Value::as_str))
        .filter(|id| !id.is_empty() && id.len() <= 256)?;
    let org = ctx.org_id.as_deref().unwrap_or_default();
    let caller = ctx.user_id.as_deref().unwrap_or(&ctx.owner_binding);
    let scope = format!("{}:{org}{}:{caller}", org.len(), caller.len());
    Some(format!("{}:{scope}{session}", scope.len()))
}

fn provider_snapshot(
    state: &AppState,
    ctx: &RequestContext,
) -> Arc<crate::providers::ProviderSnapshot> {
    ctx.provider_snapshot
        .clone()
        .unwrap_or_else(|| state.provider_runtime.snapshot())
}

/// Request admission (pipeline steps 1 + 2), shared by every inference route:
/// the per-key requests-per-minute ceiling, then the org request ceiling, then
/// the per-key burst bucket, each consumed only when the previous one admitted
/// the request. A per-key refusal names its policy (`Retry-After` plus the IETF
/// `RateLimit` / `RateLimit-Policy` headers); an org refusal stays bare.
pub(crate) fn admit_request(state: &AppState, ctx: &RequestContext) -> Result<(), GatewayError> {
    let key_config = ctx.key_config.as_ref();
    if !state
        .rate_limiter
        .check_request_for_key(&ctx.api_key, key_config)
    {
        return Err(GatewayError::rate_limited(
            state.rate_limiter.request_limit_policy(key_config),
        ));
    }
    crate::org_limits::check_request(state, ctx)?;
    if !state.rate_limiter.check_burst(&ctx.api_key) {
        return Err(GatewayError::rate_limited(
            state.rate_limiter.burst_limit_policy(),
        ));
    }
    Ok(())
}

/// The refusing policy's name for a rate-limit log line (`org` when bare).
fn rate_limit_policy_name(error: &GatewayError) -> &'static str {
    match error {
        GatewayError::RateLimitedBy(limit) => limit.policy,
        _ => "org",
    }
}

fn capture_provider_snapshot(state: &AppState, ctx: &mut RequestContext) {
    if ctx.provider_snapshot.is_none() {
        ctx.provider_snapshot = Some(state.provider_runtime.snapshot());
    }
}

/// The cache tenant: the org, narrowed to the caller's user when one is known.
/// Members of one org must not receive each other's cached responses, and the
/// user id here is only ever a verified or trusted-forwarder identity (dynamic
/// tenants accept it only from a verified JWT). JSON framing keeps an org-only
/// tenant distinct from every `(org, user)` pair.
fn cache_tenant(ctx: &RequestContext) -> Option<String> {
    match (ctx.org_id.as_deref(), ctx.user_id.as_deref()) {
        (org, Some(user)) => Some(serde_json::json!(["user", org, user]).to_string()),
        (Some(org), None) => Some(org.to_owned()),
        (None, None) => None,
    }
}

fn provider_cache_scope<'a>(
    state: &AppState,
    ctx: &'a RequestContext,
    tenant: Option<&'a str>,
    provider: &'a str,
    model: &'a str,
) -> crate::cache::CacheScope<'a> {
    let snapshot = provider_snapshot(state, ctx);
    let epoch =
        crate::cache::CacheEpoch::new(*snapshot.epoch.boot.as_bytes(), snapshot.epoch.sequence);
    // Partition by credential as well as tenant: two static keys with no org (or
    // two credentials of one org) must not confirm or read each other's prompts
    // and answers through a shared entry.
    crate::cache::CacheScope::new(epoch, tenant, provider, model).with_caller(&ctx.owner_binding)
}

/// The embedding-cache scope and cacheable request shape for an embeddings
/// call, or `None` when it must bypass the cache: the cache is off, the
/// operation is a rerank, node routing pins the upstream, the bound route
/// forbids response caching, or the body is not cacheable (token-array inputs,
/// `user`, unknown `encoding_format`). The scope is the same tenant + caller +
/// provider + model + provider-epoch namespace the response caches use.
fn embedding_cache_slot(
    state: &AppState,
    ctx: &RequestContext,
    decision: &RouteDecision,
    body: &Value,
    operation: EmbeddingOperation,
) -> Option<(String, ryu_gw_cache::EmbeddingRequest)> {
    if !matches!(operation, EmbeddingOperation::Embed)
        || state.embedding_cache.is_none()
        || ctx.node_routing.is_some()
    {
        return None;
    }
    let route = bind_route(state, ctx, decision).ok()?;
    if !route.cache_allowed {
        return None;
    }
    let request = ryu_gw_cache::EmbeddingRequest::from_body(body)?;
    let tenant = cache_tenant(ctx);
    let scope = provider_cache_scope(
        state,
        ctx,
        tenant.as_deref(),
        route.provider_id.as_str(),
        &route.model,
    )
    .semantic_scope();
    Some((scope, request))
}

fn provider_circuit_key(state: &AppState, ctx: &RequestContext, provider: &str) -> String {
    provider_snapshot(state, ctx).epoch.circuit_key(provider)
}

/// Bind one routed decision to the request's captured provider generation.
/// Callers keep the returned provider, region, cache eligibility, and epoch
/// together through governance and dispatch rather than independently reading
/// the mutable runtime state.
fn bind_route(
    state: &AppState,
    ctx: &RequestContext,
    decision: &RouteDecision,
) -> Result<crate::providers::BoundRoute, GatewayError> {
    provider_snapshot(state, ctx).bind(decision)
}

fn bound_circuit_key(route: &crate::providers::BoundRoute) -> String {
    route.epoch.circuit_key(route.provider_id.as_str())
}

fn canonical_sdk_provider(
    state: &AppState,
    ctx: &RequestContext,
    provider: &ProviderId,
    model: &str,
) -> Result<ProviderId, GatewayError> {
    if ryu_gw_credentials::sdk_provider_by_id(provider.as_str()).is_none() {
        return Ok(provider.clone());
    }
    provider_snapshot(&state, &ctx)
        .providers
        .canonicalize_sdk_route(provider.as_str(), model)
        .map(ProviderId::from)
        .ok_or_else(|| {
            GatewayError::BadRequest(
                "SDK connection is inactive or the model belongs to a different provider".into(),
            )
        })
}
fn canonicalize_sdk_decision(
    state: &AppState,
    ctx: &RequestContext,
    decision: &mut RouteDecision,
) -> Result<(), GatewayError> {
    decision.provider = canonical_sdk_provider(state, ctx, &decision.provider, &decision.model)?;
    Ok(())
}
async fn resolve_provider_pool(
    state: &AppState,
    ctx: &RequestContext,
    body: &Value,
    decision: &mut RouteDecision,
) -> Result<Option<crate::provider_pools::SelectedPoolRoute>, GatewayError> {
    let affinity = account_affinity(ctx, body);
    let facts = pool_signals::scoped_request_facts(state, ctx, body);
    let signals = pool_signals::member_facts(state, ctx, &facts);
    let mut route = provider_snapshot(&state, &ctx)
        .provider_pools
        .select_wait_with_facts(
            decision.provider.as_str(),
            affinity.as_deref(),
            &facts,
            |id, model| {
                let Ok(provider) = canonical_sdk_provider(state, ctx, &ProviderId::from(id), model)
                else {
                    return false;
                };
                provider_snapshot(&state, &ctx)
                    .providers
                    .get_owned(provider.as_str())
                    .is_some()
                    && !state.circuit_breaker.is_open(&provider_circuit_key(
                        &state,
                        &ctx,
                        provider.as_str(),
                    ))
                    && inference_governance::authorize_provider_region(state, ctx, &provider)
                        .is_ok()
            },
            |member| {
                signals
                    .get(&(member.provider.clone(), member.model.clone()))
                    .cloned()
                    .unwrap_or_default()
            },
        )
        .await
        .map_err(GatewayError::AllProvidersUnavailable)?;
    if let Some(selected) = route.as_mut() {
        selected.provider =
            canonical_sdk_provider(state, ctx, &selected.provider, &selected.model)?;
        for candidate in &mut selected.fallback_candidates {
            candidate.provider =
                canonical_sdk_provider(state, ctx, &candidate.provider, &candidate.model)?;
        }
        decision.provider = selected.provider.clone();
        decision.model.clone_from(&selected.model);
    }
    Ok(route)
}

fn reconcile_pool_after_budget(
    decision: &RouteDecision,
    route: &mut Option<crate::provider_pools::SelectedPoolRoute>,
) -> Result<(), GatewayError> {
    if route.as_ref().is_some_and(|selected| {
        selected.provider != decision.provider || selected.model != decision.model
    }) {
        *route = None;
    }
    if decision.provider.as_str().starts_with("pool:") {
        return Err(GatewayError::AllProvidersUnavailable(
            "budget downgrade resolved to a provider pool after admission".to_owned(),
        ));
    }
    Ok(())
}

struct ChatAttemptRoute {
    decision: RouteDecision,
    pool: Option<crate::provider_pools::SelectedPoolRoute>,
}

/// Append a context-relay pool's handoff to `messages`, after screening it
/// (P0-4). The handoff carries the previous target's answer, which no inbound
/// screen has read.
fn apply_pool_relay(
    state: &AppState,
    ctx: &RequestContext,
    route: Option<&crate::provider_pools::SelectedPoolRoute>,
    body: &mut Value,
    model: &str,
    start: Instant,
) -> Result<Option<PolicyAlert>, GatewayError> {
    let Some(route) = route else {
        return Ok(None);
    };
    let Some(session) = account_affinity(ctx, body) else {
        return Ok(None);
    };
    let scope_session = format!("{}:{}", auxiliary::scope(state, ctx), session);
    let handoff = provider_snapshot(state, ctx)
        .provider_pools
        .relay_messages(route, &scope_session);
    if handoff.is_empty() {
        return Ok(None);
    }
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return Ok(None);
    };
    let handoff = Value::Array(handoff);
    let alert = edit_rescan::screen_edit_audited(
        state,
        ctx,
        edit_rescan::EditSite::PoolRelay,
        &handoff,
        model,
        start,
    )?;
    if let Value::Array(handoff) = handoff {
        messages.extend(handoff);
    }
    Ok(alert)
}

fn chat_attempt_routes(
    state: &AppState,
    ctx: &RequestContext,
    decision: &RouteDecision,
    selected_pool: Option<&crate::provider_pools::SelectedPoolRoute>,
) -> Vec<ChatAttemptRoute> {
    if let Some(selected) = selected_pool {
        let mut attempts = Vec::with_capacity(1 + selected.fallback_candidates.len());
        attempts.push(ChatAttemptRoute {
            decision: decision.clone(),
            pool: Some(selected.clone()),
        });
        for candidate in &selected.fallback_candidates {
            attempts.push(ChatAttemptRoute {
                decision: RouteDecision {
                    provider: candidate.provider.clone(),
                    model: candidate.model.clone(),
                },
                pool: Some(crate::provider_pools::SelectedPoolRoute {
                    pool_name: selected.pool_name.clone(),
                    member_index: candidate.member_index,
                    provider: candidate.provider.clone(),
                    model: candidate.model.clone(),
                    fallback_candidates: Vec::new(),
                    execution: None,
                }),
            });
        }
        return attempts;
    }
    clamped_fallback_chain(state, ctx, decision)
        .into_iter()
        .map(|provider| ChatAttemptRoute {
            decision: RouteDecision {
                provider,
                model: decision.model.clone(),
            },
            pool: None,
        })
        .collect()
}

fn restore_token_ceiling(body: &mut Value, key: &str, original: Option<&Value>) {
    let Some(map) = body.as_object_mut() else {
        return;
    };
    if let Some(value) = original {
        map.insert(key.to_owned(), value.clone());
    } else {
        map.remove(key);
    }
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

/// Shared pre-processing: rate-limit + burst check + inbound-firewall + routing.
/// Returns the routing decision and exact-match cache key.
///
/// The route stage computes whether [`apply_smart_routing`] rewrote
/// `body["model"]`; in that case eval-driven A/B routing is skipped so the
/// classifier's choice is honored (otherwise `eval_route` would override the
/// model's provider — see the no-slot branch below).
async fn pre_process(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    body: &mut Value,
) -> Result<
    (
        RouteDecision,
        String,
        Option<PolicyAlert>,
        Option<crate::provider_pools::SelectedPoolRoute>,
    ),
    GatewayError,
> {
    zero_data_retention::enforce_requested_zdr(state, ctx, body)?;
    // Server tools and non-caching betas are refused on the fleet before any
    // provider is chosen, so no fallback can carry them elsewhere.
    upstream_features::enforce(state.custody, body)?;
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
    let definition_text = extract_definition_text(body);
    // Every other provider-bound string (a top-level `prompt`, non-text content
    // parts, escaped tool arguments). Detection-only: see `outbound_text`.
    // The chat slot model header replaces `model` at the Route stage, after
    // this screen, so it is screened here like `model` itself.
    let residual_text =
        outbound_text::chat_residual_text(body).with_control_token(ctx.slot_model.as_deref());
    let scanner = state.resolved_scanner(ctx);
    state
        .evaluator_registry()
        .validate_inline_bindings(&scanner.config().evaluators)
        .map_err(GatewayError::BadRequest)?;
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
                if let Err(error) = admit_request(state, ctx) {
                    warn!(key_id = %crate::audit::credential_log_id(&ctx.api_key), request_id = %ctx.request_id, policy = rate_limit_policy_name(&error), "rate limit exceeded");
                    state.metrics.inc_rate_limited();
                    return Err(error);
                }
            }

            // Step 3: inbound regex firewall on the per-request RESOLVED scanner
            // (node → org → agent).
            PipelineStage::Firewall => {
                let mut sanitized = false;
                if let Some(violation) = scanner
                    .scan_inbound(&prompt_text)
                    .or_else(|| scan_definitions_inbound(scanner.as_ref(), &definition_text))
                {
                    // Violation events cover blocks and redactions only (spec
                    // 03.4.3); a warn-tier match is on the feed, not the ledger.
                    let (traffic_action, event_action) = match scanner.policy() {
                        FirewallPolicy::Block => (
                            crate::traffic::VerdictAction::Block,
                            Some(crate::audit::EnforcementAction::Blocked),
                        ),
                        FirewallPolicy::Sanitize => (
                            crate::traffic::VerdictAction::Sanitize,
                            Some(crate::audit::EnforcementAction::Redacted),
                        ),
                        FirewallPolicy::WarnAndContinue => {
                            (crate::traffic::VerdictAction::Warn, None)
                        }
                    };
                    let layers = state.firewall_layers(ctx);
                    let event_id = event_action.and_then(|event_action| {
                        crate::violations::record_firewall_match(
                            state,
                            ctx,
                            &violation,
                            &layers,
                            event_action,
                        )
                    });
                    state.traffic.note_verdict(
                        &ctx.request_id,
                        crate::traffic::firewall_verdict(
                            &violation.pattern_name,
                            &violation.kind,
                            &layers,
                            traffic_action,
                        )
                        .with_event(event_id),
                    );
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
                                "firewall: inbound violation under Sanitize policy"
                            );
                            sanitized = sanitize_inbound_or_block(
                                state,
                                ctx,
                                body,
                                scanner.as_ref(),
                                "firewall",
                            )?;
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
                // Screen the residual of the body as Sanitize left it, so the
                // decoded form of a redacted leaf is redacted too.
                let sanitized_residual = sanitized.then(|| {
                    outbound_text::chat_residual_text(body)
                        .with_control_token(ctx.slot_model.as_deref())
                });
                let residual_alert = outbound_text::screen_residual_inbound(
                    state,
                    ctx,
                    scanner.as_ref(),
                    sanitized_residual.as_ref().unwrap_or(&residual_text),
                )?;
                pending_alert = merge_alert(pending_alert, residual_alert);
                // The hazard screener, after the regex floor and over the bytes
                // Sanitize left. It keys off custody and tier only, never the
                // tenant scanner's switches (`crate::screening`).
                crate::screening::admit::screen_chat_with(
                    state,
                    ctx,
                    body,
                    sanitized_residual
                        .as_ref()
                        .unwrap_or(&residual_text)
                        .screened_text(),
                    crate::screening::admit::Surface::Chat,
                )
                .await?;
            }

            // Step 3a: LLM traffic inspector (opt-in, inbound-only). Calls a cheap
            // model directly (never the tool loop) and fails OPEN — a timeout /
            // provider error / bad JSON is treated as not-flagged (allow + warn).
            // Gated by `enabled` + `min_chars` inside `inspect`, so it is a cheap
            // no-op when disabled.
            PipelineStage::Inspector => {
                let inspector_cfg = scanner.config().inspector.clone();
                if inspector_cfg.enabled {
                    let inference = auxiliary::GovernedInference::new(
                        Arc::clone(state),
                        ctx.clone(),
                        "inspector",
                    );
                    let current_text = extract_text_for_scanning(body);
                    let verdict =
                        InspectorClient::inspect(&current_text, &inspector_cfg, &inference).await?;
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
                                    "inspector: flagged inbound content under Sanitize policy"
                                );
                                sanitize_inbound_or_block(
                                    state,
                                    ctx,
                                    body,
                                    scanner.as_ref(),
                                    "inspector",
                                )?;
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
                        let violation = match scanner
                            .scan_locked_guardrails(&prompt_text, &policy.locked_guardrails)
                            .or_else(|| {
                                scanner.scan_locked_guardrails(
                                    &definition_text,
                                    &definition_dlp_guardrails(&policy.locked_guardrails),
                                )
                            }) {
                            Some(violation) => Some(violation),
                            None => outbound_text::residual_locked_violation(
                                state,
                                scanner.as_ref(),
                                &policy.locked_guardrails,
                                &residual_text,
                            )?,
                        };
                        if let Some(violation) = violation {
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
                        let verdict = category_names.iter().fold(
                            crate::traffic::TrafficVerdict::new(
                                crate::traffic::DecidedBy::Node,
                                crate::traffic::VerdictAction::Sanitize,
                            ),
                            |verdict, category| verdict.with_detector(category),
                        );
                        let record = crate::audit::AuditRecord {
                            request_id: ctx.request_id.clone(),
                            api_key: ctx.api_key.clone(),
                            user_name: ctx.user_name.clone(),
                            org_id: ctx.org_id.clone(),
                            team_id: ctx.team_id.clone(),
                            team_ids: ctx.audit_team_ids(),
                            key_id: ctx.key_id(),
                            project_id: ctx.project_id.clone(),
                            provider: "companion-dlp".to_string(),
                            model: body["model"].as_str().unwrap_or("unknown").to_string(),
                            input_tokens: 0,
                            output_tokens: 0,
                            cache_read_tokens: None,
                            cache_write_tokens: None,
                            cache_hit: false,
                            prompt_cache_outcome: None,
                            prompt_cache_read_tokens: None,
                            prompt_cache_write_tokens: None,
                            cache_write_1h_tokens: None,
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
                            purpose: ctx.purpose.clone(),
                            managed_inference: ctx.managed_inference,
                            provider_cost_micro_usd: None,
                            event_type: crate::audit::EventType::ModelCall,
                            backend: Some("companion".to_string()),
                            command: None,
                            duration_ms: None,
                            exit_code: None,
                            widget_instance_id: None,
                        };
                        state.log_audit_with(
                            record,
                            crate::traffic::TrafficOutcome::verdict(verdict),
                        );
                    }
                }
            }

            // Step 4: model routing (Plane A). Per-agent chat slot override wins
            // over eval/model routing (M3 / #164); eval-driven A/B routing only
            // applies when no slot is set and the classifier did not already choose.
            PipelineStage::Route => {
                let smart_routed = apply_smart_routing(state, ctx, body).await?;
                let requested_model = body["model"].as_str().unwrap_or("gpt-4o").to_owned();
                auxiliary::authorize_model(state, ctx, &requested_model)?;
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
                decision = Some(
                    if let Some((slot, upstream)) = ctx.own_supply_route.as_ref() {
                        // A free-credit own-supply attempt: the plan already chose
                        // the slot and the upstream id; the body still names the
                        // id the user picked (authorized just above).
                        RouteDecision {
                            provider: slot.clone(),
                            model: upstream.clone(),
                        }
                    } else if ctx.slot_provider.is_some() || slot_model.is_some() {
                        provider_snapshot(&state, &ctx)
                            .router
                            .route_modality_with_slot(
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
                        provider_snapshot(&state, &ctx)
                            .router
                            .route(&requested_model)
                    } else {
                        provider_snapshot(&state, &ctx)
                            .router
                            .eval_route(&requested_model, |p| {
                                state.evals.provider_score(p.as_str())
                            })
                            .unwrap_or_else(|| {
                                provider_snapshot(&state, &ctx)
                                    .router
                                    .route(&requested_model)
                            })
                    },
                );
                if let Some(decision) = decision.as_mut() {
                    canonicalize_sdk_decision(state, ctx, decision)?;
                }
            }

            // Ordering anchor only. Auditing needs the provider response, so the
            // real `audit.log` runs post-provider in `run` / `run_stream` — which
            // is genuinely last. Modelled as a pinned terminal stage purely so
            // "audit is always last" is an enforceable, testable invariant; here it
            // is a deliberate no-op, NOT a missing implementation.
            PipelineStage::Audit => {}
        }
    }

    // Keep the provider prompt-cache prefix stable. A Sanitize stage above only
    // redacts on a turn it flags, but the flag depends on the whole request (the
    // newest message, an LLM inspector verdict), while the redaction rewrites
    // every turn and the tool definitions. Without this pass the same history
    // and tools egress redacted on one turn and raw on the next, so the
    // provider's cached prefix (tools → system → earlier messages) is
    // invalidated. Redaction is a pure per-string transform and idempotent, so
    // applying it whenever a Sanitize posture is configured makes each string's
    // egress form depend on config alone. A turn a stage already sanitized is
    // unchanged here.
    if sanitize_posture_configured(state, scanner.as_ref())
        && sanitize_messages(body, scanner.as_ref())
    {
        debug!(
            request_id = %ctx.request_id,
            "sanitize: redacted unflagged content to keep the cached prompt prefix stable"
        );
    }

    // `Route` is pinned present in every resolved `StageOrder`, so the loop always
    // produced a decision.
    let mut decision =
        decision.expect("Route stage is pinned present in every resolved StageOrder");
    let pool_route = resolve_provider_pool(state, ctx, body, &mut decision).await?;
    canonicalize_sdk_decision(state, ctx, &mut decision)?;

    // Build exact-match cache key from the (possibly sanitized) body.
    let tenant = cache_tenant(ctx);
    let cache_key = Cache::make_key(
        &provider_cache_scope(
            state,
            ctx,
            tenant.as_deref(),
            decision.provider.as_str(),
            &decision.model,
        ),
        &body["messages"],
        body.get("tools"),
        ctx.capability_hints.as_deref(),
    );

    Ok((decision, cache_key, pending_alert, pool_route))
}

// Upstream error strings may echo prompts or credentials. Logs retain only
// governed failure metadata; the response path applies its own policy.
fn log_provider_failure(provider: &str, error: &GatewayError, context: &'static str) {
    warn!(
        provider,
        error_kind = provider_error_log_kind(error),
        context,
        "upstream provider request failed"
    );
}

fn provider_error_log_kind(error: &GatewayError) -> &'static str {
    match error {
        GatewayError::ProviderRateLimited { .. } => "rate_limited",
        GatewayError::ProviderPaymentRequired { .. } => "payment_required",
        GatewayError::ProviderTransport(_) => "transport",
        GatewayError::ProviderDeliveryUncertain(_) => "delivery_uncertain",
        GatewayError::ProviderError(_) => "provider_error",
        GatewayError::ProviderRejected { .. } => "request_rejected",
        _ => "request_failure",
    }
}

/// Whether this error says the provider itself is unhealthy, so it counts
/// toward the provider circuit (and pool-member demotion) every tenant shares.
///
/// A positive allowlist of genuine upstream health faults: a 5xx, a 408 or an
/// unreadable reply (all `ProviderError`), and a credential the upstream no
/// longer accepts (a 401 rejection), which is broken for every caller. Nothing
/// else counts. Safety and policy outcomes are decisions about one request
/// (see [`GatewayError::is_safety_outcome`]); any other upstream 4xx, including
/// a 403 content refusal, is about one request's content; rate limits and
/// payment-required replies are capacity or account state; a transport or
/// delivery-uncertain failure is the network path, not the provider. The match
/// is exhaustive so a new variant must be classified before it compiles.
fn penalizes_provider_circuit(error: &GatewayError) -> bool {
    match error {
        GatewayError::ProviderError(_) => true,
        GatewayError::ProviderRejected { status, .. } => *status == 401,
        GatewayError::FirewallBlocked(..)
        | GatewayError::UpstreamSafetyRefused(_)
        | GatewayError::PolicyViolation(_)
        | GatewayError::PlatformRefused { .. }
        | GatewayError::ScreeningUnavailable { .. }
        | GatewayError::ContentBlocked(_)
        | GatewayError::ScreeningDegradedThrottle { .. }
        | GatewayError::ScreeningCapacityExceeded
        | GatewayError::StandingRefused(_)
        | GatewayError::StandingUnavailable
        | GatewayError::AbuseThrottled(_)
        | GatewayError::AccountRestricted(_)
        | GatewayError::NewKeyRateLimited { .. }
        | GatewayError::RateLimited
        | GatewayError::RateLimitedBy(_)
        | GatewayError::ConfigConflict(_)
        | GatewayError::Unauthorized(_)
        | GatewayError::NoProvider(_)
        | GatewayError::ProviderTransport(_)
        | GatewayError::ProviderDeliveryUncertain(_)
        | GatewayError::ProviderPaymentRequired { .. }
        | GatewayError::ProviderRateLimited { .. }
        | GatewayError::CircuitOpen(_)
        | GatewayError::Overloaded(_)
        | GatewayError::BudgetExceeded(_)
        | GatewayError::BudgetStoreUnavailable(_)
        | GatewayError::InsufficientCredits
        | GatewayError::AccountingUnavailable
        | GatewayError::ToolUnpriced(_)
        | GatewayError::ToolNotServable(_)
        | GatewayError::ToolPaymentRequired(_)
        | GatewayError::ProviderResponseTooLarge { .. }
        | GatewayError::ProviderBodyUnreadable { .. }
        | GatewayError::AllProvidersUnavailable(_)
        | GatewayError::BadRequest(_)
        | GatewayError::InvalidRequest { .. }
        | GatewayError::Internal(_) => false,
    }
}

/// Whether a failed attempt ends the fallback chain instead of moving to the
/// next provider: on the hosted fleet and on a managed node an upstream 4xx
/// other than 408 and 429 is returned as is (see
/// [`crate::custody::GatewayCustody::ends_chain_on_refusal`] and
/// [`GatewayError::ends_hosted_attempt`]). Callers return safety outcomes
/// before this on every custody.
fn ends_attempt_chain(state: &AppState, error: &GatewayError) -> bool {
    state.custody.ends_chain_on_refusal() && error.ends_hosted_attempt()
}

#[cfg(test)]
mod transport_circuit_tests;

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

/// [`own_supply::SupplyView`] over this request's captured provider generation
/// and policy.
struct RequestSupply<'a> {
    state: &'a AppState,
    snapshot: Arc<crate::providers::ProviderSnapshot>,
    policy: Option<crate::policy::EffectivePolicy>,
}

impl<'a> RequestSupply<'a> {
    fn new(state: &'a AppState, ctx: &RequestContext) -> Self {
        let policy = (!ctx.is_master_key).then(|| {
            ctx.resolved_policy
                .clone()
                .unwrap_or_else(|| state.policy_snapshot())
        });
        Self {
            state,
            snapshot: provider_snapshot(state, ctx),
            policy,
        }
    }

    fn routes_to_ryu_router(&self, model: &str) -> bool {
        self.snapshot.router.route(model).provider.as_str() == own_supply::RYU_ROUTER_SLOT
    }
}

impl own_supply::SupplyView for RequestSupply<'_> {
    fn table(&self) -> Arc<ryu_gw_router::own_supply::OwnSupplyTable> {
        self.state.own_supply.table()
    }

    fn serves(&self, slot: &str, shown_model: &str) -> bool {
        self.snapshot.providers.get(slot).is_some()
            && self.policy.as_ref().is_none_or(|policy| {
                policy.allows_model(shown_model) && policy.allows_provider(slot)
            })
    }

    fn is_routable(&self, row: &ryu_gw_router::own_supply::OwnSupplyRow) -> bool {
        self.state.own_supply.is_routable(row)
    }

    fn allowance(&self, pool: &str) -> Option<crate::credit_pools::PoolAllowance> {
        self.state.pool_allowances.get(pool)
    }
}

/// The own-supply plan for this request, if it qualifies (see [`own_supply`]).
fn own_supply_plan(
    state: &AppState,
    ctx: &RequestContext,
    body: &Value,
) -> Option<own_supply::OwnSupplyPlan> {
    let requested = body["model"].as_str()?;
    // Ladder L3 takes own-supply vendor slots away (spec 04.8.1): the
    // request stays on the Ryu Router route.
    if crate::enforcement::is_restricted(ctx) {
        return None;
    }
    let supply = RequestSupply::new(state, ctx);
    // Only a managed caller can be planned; skip walking the prompt otherwise.
    let estimated_prompt_tokens = if ctx.managed_inference {
        estimate_prompt_tokens(body)
    } else {
        0
    };
    let plan = own_supply::plan(
        requested,
        supply.routes_to_ryu_router(requested),
        estimated_prompt_tokens,
        ctx,
        &supply,
        chrono::Utc::now(),
    )?;
    info!(
        request_id = %ctx.request_id,
        org_id = ?ctx.org_id,
        slot = %plan.slot,
        basis = plan.basis.as_str(),
        "credits: serving a Ryu Router pick from own supply"
    );
    Some(plan)
}

/// The own-supply attempt: the same body under the id the user sees (for
/// `openrouter/auto`, the pool default's id), dispatched to exactly the plan's
/// `(slot, upstream)` through the gateway-internal route pin.
fn own_supply_attempt(
    ctx: &RequestContext,
    body: &Value,
    plan: &own_supply::OwnSupplyPlan,
) -> (RequestContext, Value) {
    let mut attempt_ctx = ctx.clone();
    attempt_ctx.own_supply_route =
        Some((ProviderId::from(plan.slot.as_str()), plan.upstream.clone()));
    let mut routed = body.clone();
    routed["model"] = Value::String(plan.shown_model.clone());
    (attempt_ctx, routed)
}

/// After a failed own-supply attempt: an upstream 404 (model gone) or 401
/// (credential refused) takes the row off this gateway for an hour
/// (`own_supply_table::QUARANTINE_FOR`). A 403 or a safety outcome never does.
fn note_own_supply_failure(
    state: &AppState,
    plan: &own_supply::OwnSupplyPlan,
    error: &GatewayError,
) {
    if own_supply::is_row_unavailable(error) {
        state.own_supply.quarantine(&plan.slot, &plan.upstream);
    }
}

/// Authorize the model a route will DISPATCH. When the route is exactly the
/// Ryu alias / pool namespace the client requested (`ryu-code/max` →
/// `anthropic-credits` + `claude-opus-4-5`), the requested id is what the
/// org's allowlist approved at the Policy stage, so the upstream id is not
/// re-checked: approving the alias must be enough, and the upstream id is not
/// something an admin is ever shown. Any other route (a budget downgrade, a
/// fallback to another model) is checked as before.
fn authorize_routed_model(
    state: &AppState,
    ctx: &RequestContext,
    requested_model: &str,
    decision: &RouteDecision,
) -> Result<(), GatewayError> {
    // Ladder L3 first: an alias or own-supply route the org approved is
    // still refused when it lands on an own-supply vendor slot or a model
    // off the floor's restricted list.
    crate::enforcement::authorize_route(
        state,
        ctx,
        decision.provider.as_str(),
        decision.model.as_str(),
    )?;
    let routed = (decision.provider.as_str(), decision.model.as_str());
    let is_requested_pool_route = ryu_gw_router::pool_model_alias_route(requested_model)
        == Some(routed)
        || ryu_gw_router::pool_namespace_route(requested_model) == Some(routed)
        // The own-supply plan's route serves exactly the id the user picked.
        || ctx
            .own_supply_route
            .as_ref()
            .is_some_and(|(slot, upstream)| (slot.as_str(), upstream.as_str()) == routed);
    if is_requested_pool_route {
        return Ok(());
    }
    auxiliary::authorize_model(state, ctx, &decision.model)
}

/// `x-degraded: fallback:<slot>` must not name a Ryu-operated slot to a
/// managed caller; it reads `fallback:ryu` instead. Operators keep the slot.
fn mask_degraded(degraded: &mut Option<DegradedMode>, managed: bool) {
    if !managed {
        return;
    }
    if let Some(DegradedMode::Fallback(provider)) = degraded {
        if crate::credit_pools::is_ryu_router_slot(provider) {
            *provider = model_alias::ALIAS_PROVIDER_LABEL.to_owned();
        }
    }
}

/// `x-provider` for a managed caller: work any Ryu-operated slot served (own
/// supply or the OpenRouter pass-through) reads as Ryu Router (`ryu`).
fn mask_provider_used(provider_used: &mut &'static str, managed: bool) {
    if managed && crate::credit_pools::is_ryu_router_slot(provider_used) {
        *provider_used = model_alias::ALIAS_PROVIDER_LABEL;
    }
}

/// Show the user's own id on an own-supply error that will not fall back.
fn mask_own_supply_error(
    error: GatewayError,
    plan: &own_supply::OwnSupplyPlan,
    managed: bool,
) -> GatewayError {
    let error = model_alias::mask_model(error, &plan.upstream, &plan.shown_model);
    model_alias::mask_pool_slots(error, managed)
}

// ─── Non-streaming pipeline ───────────────────────────────────────────────────

/// Whether a client hang-up must leave this buffered call running.
///
/// True when this node debits the org's wallet for the call: accepted provider
/// work has to reach the settlement that audits, budgets and debits it, so a
/// client timeout cannot turn into unbilled provider spend.
///
/// An unmetered call (a Desktop's Core-managed local Gateway, a self-hosted
/// node) keeps cancel-on-drop. Its client gone, queued or in-flight work is
/// dropped, which frees the local engine's admission slot and queue place for
/// the next caller instead of serving a response nobody will read.
fn settles_after_client_hang_up(state: &AppState, ctx: &RequestContext) -> bool {
    state.config.credits.is_active() && ctx.org_id.as_deref().is_some_and(|org| !org.is_empty())
}

/// Run a buffered pipeline, on its own task when `detach` is set.
///
/// A client that hangs up (or times out) makes hyper drop the handler future.
/// Awaited inline, that drop cancels the provider call mid-flight, after the
/// provider may have accepted the work but before the settlement that audits,
/// budgets and debits it. On its own task the pipeline outlives the handler:
/// dropping this future only detaches the `JoinHandle`, so dispatched work
/// finishes and is settled exactly like a delivered response. The task keeps
/// the caller's tracing span and route template (the traffic feed reads it).
/// See [`settles_after_client_hang_up`] for which calls detach.
async fn run_buffered<T: Send + 'static>(
    detach: bool,
    work: impl std::future::Future<Output = Result<T, GatewayError>> + Send + 'static,
) -> Result<T, GatewayError> {
    use tracing::Instrument;
    if !detach {
        return work.await;
    }
    match tokio::spawn(crate::traffic::carry_route(work).in_current_span()).await {
        Ok(result) => result,
        Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
        Err(error) => Err(GatewayError::Internal(anyhow::anyhow!(
            "pipeline task was cancelled: {error}"
        ))),
    }
}

pub async fn run(
    state: Arc<AppState>,
    ctx: RequestContext,
    body: Value,
) -> Result<PipelineOutput, GatewayError> {
    let managed = ctx.managed_inference;
    // Free credit first: a Ryu Router pick Ryu can serve from its own supply is
    // served there, shown under the id the user picked (see `own_supply`).
    if let Some(plan) = own_supply_plan(&state, &ctx, &body) {
        let (attempt_ctx, attempt_body) = own_supply_attempt(&ctx, &body, &plan);
        let attempt = run_unaliased(Arc::clone(&state), attempt_ctx, attempt_body).await;
        if let Err(error) = &attempt {
            note_own_supply_failure(&state, &plan, error);
        }
        match attempt {
            Ok(mut output) => {
                model_alias::apply_to_output(
                    &mut output.response,
                    &mut output.model_used,
                    &mut output.provider_used,
                    &plan.shown_model,
                );
                mask_degraded(&mut output.degraded, managed);
                return Ok(output);
            }
            Err(error) if own_supply::may_fall_back(&error, &ctx) => {
                warn!(
                    request_id = %ctx.request_id,
                    slot = %plan.slot,
                    error = %error,
                    "own supply failed before output; serving from the Ryu Router route"
                );
            }
            Err(error) => return Err(mask_own_supply_error(error, &plan, managed)),
        }
    }
    // A Ryu model alias (`ryu-code/max`) is resolved to the supplier's id for
    // dispatch; the client gets the alias back, never the supplier's id.
    let alias = model_alias::requested_alias(&body);
    let mut output = run_unaliased(state, ctx, body).await.map_err(|error| {
        model_alias::mask_pool_slots(model_alias::mask_error(error, alias), managed)
    })?;
    // A pre-alias raw id an own-supply slot served is shown under the id the
    // user knows, never the supplier's.
    let shown: Option<String> = alias
        .map(str::to_owned)
        .or_else(|| model_alias::served_display_id(output.provider_used, &output.model_used));
    if let Some(shown) = shown {
        model_alias::apply_to_output(
            &mut output.response,
            &mut output.model_used,
            &mut output.provider_used,
            &shown,
        );
    }
    mask_degraded(&mut output.degraded, managed);
    mask_provider_used(&mut output.provider_used, managed);
    Ok(output)
}

async fn run_unaliased(
    state: Arc<AppState>,
    ctx: RequestContext,
    body: Value,
) -> Result<PipelineOutput, GatewayError> {
    // Dispatch one buffered attempt; metered calls run detached (see
    // `run_buffered`) so a client hang-up never skips settlement.
    let detach = settles_after_client_hang_up(&state, &ctx);
    // A detached call outlives its caller. Dropping this future (a client
    // hang-up) cancels `caller`, which stops a tool loop from running further
    // tools or rounds; see `run_attached`.
    let caller = tokio_util::sync::CancellationToken::new();
    let _cancel_on_hang_up = caller.clone().drop_guard();
    run_buffered(
        detach,
        run_attached(state, ctx, body, detach.then_some(caller)),
    )
    .await
}

/// Bill the provider rounds a buffered tool loop ran before it failed.
///
/// They are provider spend even though the request did not succeed on this
/// attempt. They settle under their own ref, `{request_id}:attempt-{n}`, so a
/// fallback attempt that succeeds afterwards is not deduplicated against them
/// by the idempotent debit. The credit claim follows this debit. `error`, when
/// known, is what the loop failed with; the traffic feed reports it.
#[allow(clippy::too_many_arguments)]
fn settle_failed_tool_rounds(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    attempt_index: usize,
    rounds: tool_rounds::ToolRoundTotals,
    provider: &str,
    model: &str,
    budget: Option<BudgetDecision>,
    start: Instant,
    reservation: Option<CreditReservation>,
    error: Option<&GatewayError>,
) {
    settle_unanswered_tool_rounds(
        state,
        ctx,
        format!("{}:attempt-{attempt_index}", ctx.request_id),
        rounds,
        provider,
        model,
        budget,
        start,
        reservation,
        "tool loop failed after paid provider rounds",
        error,
    );
}

/// Bill a tool loop the pool's final-execution deadline cut off, as a failed
/// attempt (`{request_id}:attempt-{n}`).
///
/// The deadline drops the loop, but a metered round runs on its own task and
/// keeps going: the provider bills it, so Ryu must too. With no round in
/// flight, the answered rounds settle now. Otherwise one settlement waits,
/// bounded by [`ABANDONED_PROVIDER_WAIT`], for the round to finish, then bills
/// every round once, the late one from its real usage. A second debit for the
/// late round alone would need its own ref (the same ref is deduplicated), so
/// the rounds settle together, as on the hang-up paths. The credit claim is
/// held until that debit resolves.
#[allow(clippy::too_many_arguments)]
fn settle_timed_out_tool_rounds(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    attempt_index: usize,
    ledger: &Arc<tool_rounds::ToolRoundLedger>,
    provider: &'static str,
    model: &str,
    budget: Option<BudgetDecision>,
    start: Instant,
    reservation: Option<CreditReservation>,
) {
    let settle = move |state: &Arc<AppState>,
                       ctx: &RequestContext,
                       model: &str,
                       rounds: tool_rounds::ToolRoundTotals| {
        if rounds.rounds > 0 {
            settle_failed_tool_rounds(
                state,
                ctx,
                attempt_index,
                rounds,
                provider,
                model,
                budget,
                start,
                reservation,
                None,
            );
        }
    };
    let handle = tokio::runtime::Handle::try_current();
    match handle {
        Ok(handle) if ledger.rounds_in_flight() > 0 => {
            let (state, ctx, ledger, model) = (
                Arc::clone(state),
                ctx.clone(),
                Arc::clone(ledger),
                model.to_owned(),
            );
            handle.spawn(async move {
                let rounds = ledger.settled(ABANDONED_PROVIDER_WAIT).await;
                settle(&state, &ctx, &model, rounds);
            });
        }
        _ => settle(state, ctx, model, ledger.totals()),
    }
}

/// Bill tool-loop rounds that did not answer the request: rounds before a
/// failed round, or the rounds of a loop its caller abandoned. `debit_ref` is
/// the ref they settle under. The credit claim, shrunk to what the rounds
/// cost, follows this debit. The row reads the request's own traffic note, so
/// it carries the request's route, stages and verdict, and reports `error`
/// when the loop failed with one.
#[allow(clippy::too_many_arguments)]
fn settle_unanswered_tool_rounds(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    debit_ref: String,
    rounds: tool_rounds::ToolRoundTotals,
    provider: &str,
    model: &str,
    budget: Option<BudgetDecision>,
    start: Instant,
    reservation: Option<CreditReservation>,
    reason: &str,
    error: Option<&GatewayError>,
) {
    let mut attempt_ctx = ctx.clone();
    attempt_ctx.request_id = debit_ref;
    // No round answered the request, so none is judged against the token
    // limits: all of them are recorded below like earlier rounds.
    let tokens = rounds.input_tokens.saturating_add(rounds.output_tokens);
    let reservation = shrink_credit_claim(
        state,
        ctx,
        reservation,
        tool_rounds_charge_micro_usd(state, &rounds, provider, model),
    );
    let mut settlement = inference_governance::settle_completion(
        state,
        &attempt_ctx,
        &rounds.billing_view(&Value::Null),
        inference_governance::CompletionReceipt {
            provider: provider.to_owned(),
            model: model.to_owned(),
            purpose: None,
            audit_provider: provider.to_owned(),
            backend: None,
            start,
            admitted_tokens: tokens,
            estimated_input: 0,
            budget,
            reservations: reservation.into_iter().collect(),
            zero_cost: false,
        },
    );
    settlement.record_mut().error = Some(reason.to_owned());
    settlement.join_note_of(&ctx.request_id);
    if let Some(error) = error {
        settlement.report(error);
    }
    record_earlier_round_tokens(state, ctx, tokens);
}

/// How a buffered tool loop ended when its caller can hang up.
enum LoopOutcome<T> {
    Finished(T),
    /// The caller hung up first. The loop was dropped: no further tool runs
    /// and no new round starts.
    CallerGone,
}

/// Run `work`, a buffered tool loop, until it finishes or `caller` (present
/// on a metered, detached call) is cancelled by a client hang-up. Cancellation
/// wins a tie, and a caller already gone never starts the loop.
async fn unless_caller_gone<T>(
    work: impl std::future::Future<Output = T>,
    caller: Option<&tokio_util::sync::CancellationToken>,
) -> LoopOutcome<T> {
    let Some(caller) = caller else {
        return LoopOutcome::Finished(work.await);
    };
    tokio::select! {
        biased;
        () = caller.cancelled() => LoopOutcome::CallerGone,
        output = work => LoopOutcome::Finished(output),
    }
}

/// What a tool loop's rounds are charged, in micro-USD: the same figure the
/// budgets and the debit use.
fn tool_rounds_charge_micro_usd(
    state: &AppState,
    rounds: &tool_rounds::ToolRoundTotals,
    provider: &str,
    model: &str,
) -> u64 {
    charged_budget_cost_micro_usd(
        state,
        Some(provider),
        rounds.reported_cost_usd(),
        rounds.input_tokens,
        rounds.output_tokens,
        model,
        rounds.cache_usage(),
    )
}

/// Shrink a credit claim to `spent_micro_usd`, what the work actually cost.
///
/// A failed attempt's claim is held until its debit resolves. At full size,
/// the fallback attempt that follows would have to fit alongside the failed
/// attempt's whole estimate, and an org near its balance would be refused
/// although it can pay for both. The smaller claim is taken before the
/// original is released, so the amount held never dips below the spend. A
/// claim is never grown.
fn shrink_credit_claim(
    state: &AppState,
    ctx: &RequestContext,
    claim: Option<CreditReservation>,
    spent_micro_usd: u64,
) -> Option<CreditReservation> {
    let claim = claim?;
    let Some(org_id) = ctx.org_id.as_deref().filter(|org| !org.is_empty()) else {
        return Some(claim);
    };
    let held = i64::try_from(spent_micro_usd)
        .unwrap_or(i64::MAX)
        .min(claim.amount_micro_usd());
    let shrunk = state.wallet.try_reserve(org_id, held, i64::MAX);
    drop(claim);
    shrunk
}

/// Count a tool loop's earlier provider rounds against the per-minute token
/// limits without refusing the request for them.
///
/// Every round is billed, but the token limits judge only the round that
/// answers, as they did before rounds were metered. Judging the sum would turn
/// a loop that already ran its tools and was debited into a 429, and the
/// client's retry would run the tools and pay again. Each bucket is charged at
/// most one window of these tokens, so one request cannot put it more than a
/// minute into debt.
fn record_earlier_round_tokens(state: &AppState, ctx: &RequestContext, tokens: u64) {
    if tokens == 0 {
        return;
    }
    state.rate_limiter.record_tokens_within_window_for_key(
        &ctx.api_key,
        tokens,
        ctx.key_config.as_ref(),
    );
    crate::org_limits::record_tokens_within_window(state, ctx, tokens);
}

async fn run_attached(
    state: Arc<AppState>,
    mut ctx: RequestContext,
    mut body: Value,
    // Cancelled when the client of a detached (metered) call hangs up.
    caller: Option<tokio_util::sync::CancellationToken>,
) -> Result<PipelineOutput, GatewayError> {
    capture_provider_snapshot(&state, &mut ctx);
    let start = Instant::now();

    state.metrics.inc_requests();
    let mut sampling_extensions = SamplingExtensions::take(&mut body);

    // Admission and content governance precede optional smart-router inference.
    let requested_model = body["model"].as_str().unwrap_or("unknown").to_string();
    let (mut decision, cache_key, mut pre_alert, mut pool_route) =
        pre_process(&state, &ctx, &mut body).await.map_err(|e| {
            state.metrics.inc_errors();
            audit_failure(&state, &ctx, &requested_model, &e, start);
            e
        })?;
    state.traffic.note_screen(
        &ctx.request_id,
        crate::traffic::current_route(),
        start.elapsed().as_millis() as u64,
    );

    let cache_route = bind_route(&state, &ctx, &decision)?;

    // Gateway response caches have no account dimension. A multi-key provider
    // uses session-sticky upstream prompt caching instead; serving a Gateway
    // hit here could reuse an answer from a different account or obscure a
    // quota failover before the account is even selected.
    let cache_allowed = pool_route.is_none()
        && ctx.capability_hints.is_none()
        && ctx.node_routing.is_none()
        && cache_route.cache_allowed;
    let cache_origin = (cache_route.provider_id.clone(), cache_route.model.clone());
    let semantic_tenant = cache_tenant(&ctx);
    let semantic_scope = provider_cache_scope(
        &state,
        &ctx,
        semantic_tenant.as_deref(),
        cache_route.provider_id.as_str(),
        &cache_route.model,
    )
    .semantic_scope();

    // 5a. Exact-match cache lookup — return early on hit
    if cache_allowed {
        if let Some(cached) = state.cache.get_async(&cache_key).await {
            debug!(request_id = %ctx.request_id, "exact cache hit");
            state.metrics.inc_cache_hit();
            // Output-target inline evaluators must run on cache hits too: the exact
            // cache key is (org, model, messages) — NOT scoped by agent — so an agent
            // with `toxicity: Block` / `pii_leakage: Sanitize` could otherwise be
            // served a sibling agent's cached toxic/PII response with the guardrail
            // silently bypassed. No-op (allocation-free) when the agent has no
            // output evaluators, so a plain cache hit stays fast.
            let mut cached = cached;
            // The entry holds the response as DLP'd for whoever populated it;
            // this caller's own (possibly stricter) outbound policy applies too.
            apply_outbound_json_dlp(&state, &ctx, &mut cached)?;
            apply_inline_output_evaluators(&state, &ctx, &mut cached).await?;
            screen_buffered_output(&state, &ctx, &cached).await?;
            audit_cache_hit(
                &state,
                &ctx,
                "cache",
                &model_alias::display_model(decision.provider.as_str(), &decision.model),
                &cached,
                start,
            );
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
    }

    // 5b. Semantic cache lookup (optional)
    let mut semantic_embedding: Option<Vec<f32>> = None;
    if cache_allowed {
        if let (Some(sc), Some(_openai_cfg)) = (
            state.semantic_cache.active(),
            provider_snapshot(&state, &ctx).config.openai.as_ref(),
        ) {
            let text = SemanticCache::messages_to_text(&body["messages"]);
            let inference = auxiliary::GovernedInference::new(
                Arc::clone(&state),
                ctx.clone(),
                "semantic-cache",
            );
            if let Some(emb) = inference.embed(sc.embedding_model(), &text, 30_000).await? {
                if let Some(cached) = sc.lookup_async(Some(&semantic_scope), &emb).await {
                    debug!(request_id = %ctx.request_id, "semantic cache hit");
                    state.metrics.inc_semantic_cache_hit();
                    state.metrics.inc_cache_hit();
                    // Same per-agent bypass concern as the exact cache above: the
                    // semantic cache is org-scoped, not agent-scoped, so run the
                    // output-target inline evaluators before serving a cached hit.
                    let mut cached = cached;
                    apply_outbound_json_dlp(&state, &ctx, &mut cached)?;
                    apply_inline_output_evaluators(&state, &ctx, &mut cached).await?;
                    screen_buffered_output(&state, &ctx, &cached).await?;
                    audit_cache_hit(
                        &state,
                        &ctx,
                        "semantic-cache",
                        &model_alias::display_model(decision.provider.as_str(), &decision.model),
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
    }

    state.metrics.inc_cache_miss();

    // 6. Skills injection, then a screen of the injected text (P0-4).
    let skills_alert =
        edit_rescan::inject_skills(&state, &ctx, &mut body, &requested_model, start)?;
    pre_alert = merge_alert(pre_alert, skills_alert);

    // 6a. Shared (cross-machine) budget — enforce the control-plane coordinator's
    // most recent verdict. The master key always bypasses budget gates.
    if !ctx.is_master_key && state.shared_budget.is_shared_exceeded() {
        warn!(key_id = %crate::audit::credential_log_id(&ctx.api_key), "shared budget exceeded (coordinator verdict)");
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
                            key_id = %crate::audit::credential_log_id(&ctx.api_key),
                            used,
                            budget,
                            downgrade = %downgrade_model,
                            "token budget exceeded, downgrading model"
                        );
                        body["model"] = Value::String(downgrade_model.clone());
                        decision = provider_snapshot(&state, &ctx)
                            .router
                            .route(downgrade_model);
                    } else {
                        warn!(key_id = %crate::audit::credential_log_id(&ctx.api_key), used, budget, "token budget exceeded");
                        state.metrics.inc_budget_exceeded();
                        state.metrics.inc_errors();
                        return Err(GatewayError::BudgetExceeded(None));
                    }
                }
            }
        }
    }

    let mut execution_ceiling = None;
    if let Some(route) = pool_route
        .as_ref()
        .filter(|route| route.execution.is_some())
    {
        match pool_dispatch::prepare(Arc::clone(&state), &ctx, route, body.clone()).await? {
            Some(pool_dispatch::PreparedExecution::Single {
                target,
                mut response,
            }) => {
                apply_outbound_json_dlp(&state, &ctx, &mut response)?;
                apply_inline_output_evaluators(&state, &ctx, &mut response).await?;
                screen_buffered_output(&state, &ctx, &response).await?;
                let bound = provider_snapshot(&state, &ctx).bind(&RouteDecision {
                    provider: ProviderId::from(target.provider.as_str()),
                    model: target.model.clone(),
                })?;
                return Ok(PipelineOutput {
                    response,
                    context: ctx,
                    provider_used: bound.provider.name(),
                    model_used: target.model,
                    cache_hit: false,
                    budget: None,
                    eval_score: None,
                    degraded: None,
                    policy_alert: pre_alert,
                    prompt_cache: ryu_gw_providers::PromptCacheOutcome::Disabled,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                });
            }
            Some(pool_dispatch::PreparedExecution::Final {
                target,
                body: prepared,
                timeout_ms,
                output_bytes,
            }) => {
                body = prepared;
                decision = RouteDecision {
                    provider: ProviderId::from(target.provider.as_str()),
                    model: target.model,
                };
                execution_ceiling = Some((
                    tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms),
                    output_bytes,
                ));
                pool_route = None;
            }
            None => {}
        }
    }

    let execution_final_route = execution_ceiling.map(|_| decision.clone());
    let original_max_tokens = body.get("max_tokens").cloned();
    let original_max_completion_tokens = body.get("max_completion_tokens").cloned();

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
        // Local budgets are recorded synchronously before this returns, so the
        // in-flight claim simply lives until then.
        budget_hold: _budget_hold,
    } = enforce_budget(
        &state,
        &ctx,
        &mut body,
        &mut decision,
        BudgetChargeKind::Model,
        OutputCeiling::Clamp,
    )?;
    if execution_final_route.as_ref().is_some_and(|target| {
        target.provider != decision.provider || target.model != decision.model
    }) {
        return Err(GatewayError::BudgetExceeded(None));
    }
    authorize_routed_model(&state, &ctx, &requested_model, &decision)?;
    reconcile_pool_after_budget(&decision, &mut pool_route)?;
    // One response, one header: firewall (Ok-path) alert first so it wins a tie
    // against a same-tier budget alert (deterministic).
    let mut policy_alert = merge_alert(pre_alert, budget_alert);

    // 6d. Context compression (egress transform). When enabled, send the
    // messages to the compression service and swap in the result before any
    // provider call. Runs once for the whole fallback chain. The swapped-in
    // messages are screened; a failed compression leaves the body untouched,
    // except on the hosted fleet, where it refuses the request (see
    // `edit_rescan::compress`).
    let compression_alert =
        edit_rescan::compress(&state, &ctx, &mut body, &decision.model, start).await?;
    policy_alert = merge_alert(policy_alert, compression_alert);

    let pool_base_body = body.clone();
    let fallback_chain = if execution_ceiling.is_some() {
        vec![ChatAttemptRoute {
            decision: decision.clone(),
            pool: None,
        }]
    } else {
        chat_attempt_routes(&state, &ctx, &decision, pool_route.as_ref())
    };
    let mut last_err: Option<GatewayError> = None;
    // Track whether the primary provider (first in chain) was skipped so we
    // can signal DegradedMode::Fallback when a later provider serves the request.
    let primary_provider = fallback_chain
        .first()
        .map(|attempt| attempt.decision.provider.clone());
    let mut primary_skipped = false;

    // Stamp markers after request transforms. A pool retry restores the request
    // body and applies markers again for that member's model and dialect.
    let mut prompt_cache_outcome = apply_prompt_cache(&state, &ctx, &decision.model, &mut body);

    for (attempt_index, attempt) in fallback_chain.iter().enumerate() {
        // Standing first on every attempt (spec 05.5): a push that lands
        // while an attempt fails must stop the next one from dispatching.
        crate::standing::recheck(&state, &ctx).await?;
        if attempt_index > 0 {
            drop(credit_reservation.take());
            // Generic retries retain any completed tool turns. Explicit pool
            // retries keep their existing per-member request reset semantics.
            if pool_route.is_some() {
                body = pool_base_body.clone();
            }
            restore_token_ceiling(&mut body, "max_tokens", original_max_tokens.as_ref());
            restore_token_ceiling(
                &mut body,
                "max_completion_tokens",
                original_max_completion_tokens.as_ref(),
            );
            if let Some(restrict) = budget
                .as_ref()
                .filter(|rule| rule.action == crate::config::BudgetAction::Restrict)
            {
                body["max_tokens"] = Value::from(restrict.restrict_max_tokens);
            }
            decision = attempt.decision.clone();
            if let Err(error) = canonicalize_sdk_decision(&state, &ctx, &mut decision) {
                last_err = Some(error);
                continue;
            }
            if let Err(error) = authorize_routed_model(&state, &ctx, &requested_model, &decision) {
                last_err = Some(error);
                continue;
            }
            match reserve_route_credit(&state, &ctx, &mut body, &decision, OutputCeiling::Clamp) {
                Ok(reservation) => credit_reservation = reservation,
                Err(error) => {
                    last_err = Some(error);
                    continue;
                }
            }
            prompt_cache_outcome = apply_prompt_cache(&state, &ctx, &decision.model, &mut body);
        }
        let candidate_provider = &attempt.decision.provider;
        let route = match bind_route(
            &state,
            &ctx,
            &RouteDecision {
                provider: candidate_provider.clone(),
                model: attempt.decision.model.clone(),
            },
        ) {
            Ok(route) => route,
            Err(error) => {
                last_err = Some(error);
                continue;
            }
        };
        let provider_kind = &route.provider_id;
        if let Err(error) = inference_governance::authorize_bound_route_region(&state, &ctx, &route)
        {
            last_err = Some(error);
            if Some(provider_kind) == primary_provider.as_ref() {
                primary_skipped = true;
            }
            continue;
        }
        // 7. Circuit breaker check
        if state.circuit_breaker.is_open(&bound_circuit_key(&route)) {
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

        // A refused handoff ends the request: retrying it on the next member
        // would send the same content to another provider.
        let relay_alert = apply_pool_relay(
            &state,
            &ctx,
            attempt.pool.as_ref(),
            &mut body,
            &decision.model,
            start,
        )?;
        policy_alert = merge_alert(policy_alert, relay_alert);
        // Per-attempt re-admission (spec 02.12 and 00.12): the hazard screener
        // reads the body this attempt sends, skills, compression and relay
        // edits included. Unchanged segments answer from the segment cache,
        // so a fallback attempt costs no second classifier call.
        if let Err(error) = crate::screening::admit::screen_chat_as(
            &state,
            &ctx,
            &body,
            crate::screening::admit::Surface::Chat,
            &attempt.decision.model,
        )
        .await
        {
            state.metrics.inc_errors();
            audit_failure(&state, &ctx, &decision.model, &error, start);
            return Err(error);
        }
        let provider = Arc::clone(&route.provider);

        state.metrics.inc_provider_request(provider.name());

        // Only an Anthropic-dialect provider reads the caller's betas; for anyone
        // else the private field is an unknown top-level key that would 400 a
        // strict endpoint. Per attempt, because fallback swaps the provider.
        strip_anthropic_beta_for(&mut body, provider.name());
        strip_cache_control_for(&mut body, provider.name(), &decision.model);
        sampling_extensions.apply_for(&mut body, provider.name());
        stamp_upstream_identity(
            &state,
            &ctx,
            &mut body,
            provider.name(),
            crate::identity::UpstreamSurface::Chat,
        );

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
        let tools_restricted = matches!(
            budget.as_ref().map(|b| b.action),
            Some(crate::config::BudgetAction::Restrict)
        );
        let loop_kind = select_tool_loop(
            &ctx,
            state.tools.is_some(),
            state.composio.is_some(),
            &state.config.tools,
            tools_restricted,
        );
        let runs_tool_loop = matches!(loop_kind, ToolLoopKind::Unified);
        let _admission = if runs_tool_loop {
            crate::concurrency::AdmissionPermit::none()
        } else {
            match state
                .admission
                .acquire_for(provider.name(), ctx.priority, ctx.org_id.as_deref())
                .await
            {
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
        let (original_provider_options, original_models) =
            apply_node_openrouter_preferences(&state, &ctx, provider.name(), &mut body, true);
        let _pool_load = attempt
            .pool
            .as_ref()
            .and_then(|pool| provider_snapshot(&state, &ctx).provider_pools.acquire(pool));
        // A tool loop calls the provider once per round; each round is billed,
        // not only the final one the loop returns.
        let round_ledger = (loop_kind != ToolLoopKind::Plain)
            .then(|| Arc::new(tool_rounds::ToolRoundLedger::default()));
        // A detached (metered) call stops its tool loop when the client hangs
        // up, so its rounds run on their own tasks: the round in flight then
        // finishes and is billed from its real usage.
        let loop_caller = caller.as_ref().filter(|_| round_ledger.is_some());
        let metered_rounds = round_ledger.as_ref().map(|ledger| {
            tool_rounds::MeteredRounds::new(
                Arc::clone(&provider),
                Arc::clone(ledger),
                loop_caller.is_some(),
            )
        });
        let loop_provider: &dyn ryu_gw_providers::Provider = match &metered_rounds {
            Some(metered) => metered,
            None => provider.as_ref(),
        };
        // OTel GenAI model-call span for this attempt: a child of the inbound
        // HTTP server span, ended when the provider returns or fails. Provider
        // requests made inside carry its `traceparent`. A tool loop makes
        // several provider calls with tool runs in between, so it gets one
        // span per provider call (`traced_provider`) instead of one around
        // the whole loop.
        let model_span = if matches!(loop_kind, ToolLoopKind::Plain) {
            gen_ai_telemetry::start_span(
                &state,
                &ctx,
                crate::telemetry::gen_ai_span::OPERATION_CHAT,
                Some(gen_ai_telemetry::chat_output_type(&body)),
                provider.name(),
                &decision.model,
                &body,
                false,
            )
        } else {
            crate::telemetry::gen_ai_span::ModelCallSpan::disabled()
        };
        let traced_provider = gen_ai_telemetry::TracedProvider::new(&state, &ctx, loop_provider);
        let completion = model_span.instrument(async {
            match loop_kind {
                ToolLoopKind::Unified => {
                    let catalog = state
                        .tools
                        .as_ref()
                        .expect("Unified selected ⇒ tools catalog present");
                    let allowed = effective_tool_allowlist(&ctx, &state.config.tools);
                    let hints = unified_loop_hints(&ctx, &allowed);
                    let (composio_user_id, require_composio_user_id) =
                        unified_composio_identity(&state, &ctx)?;
                    let tool_ctx = crate::tools::ToolLoopContext {
                        agent_id: ctx.agent_id.clone(),
                        user_id: ctx.user_id.clone(),
                        composio_user_id,
                        require_composio_user_id,
                        allowed,
                        firewall: Some(tool_loop_screen::firewall(&state, &ctx)),
                        untrusted_caller: ctx.untrusted_caller,
                        parallel_reads: state.config.tools.parallel_reads,
                        host_conversation: ctx.host_conversation.clone(),
                        org_tools: org_tool_gate(&state, &ctx),
                    };
                    inject_unified_loop_tools(
                        &mut body,
                        &ctx,
                        &state.config.tools,
                        tools_restricted,
                    );
                    let affinity = account_affinity(&ctx, &body);
                    crate::tools::run_tool_loop_with_hints_for_session(
                        &mut body,
                        &traced_provider,
                        &decision.model,
                        catalog,
                        &tool_ctx,
                        state.config.tools.max_rounds,
                        state.config.tools.describe_top_n,
                        hints.as_deref(),
                        affinity.as_deref(),
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
                    if state.resolve_cache.is_some() && ctx.org_id.is_none() {
                        return Err(GatewayError::Unauthorized(
                            "managed Composio calls require an authenticated organization"
                                .to_owned(),
                        ));
                    }
                    let entity_id = composio
                        .entity_for_request(ctx.org_id.as_deref(), ctx.user_id.as_deref())?;
                    // A request header may narrow the operator's Composio grants,
                    // never introduce an action absent from global configuration.
                    let allowed =
                        legacy_composio_allowlist(ctx.tool_actions.as_deref(), composio.actions());
                    let affinity = account_affinity(&ctx, &body);
                    let on_charge = |cost, transaction_id: &str| {
                        spawn_external_tool_debit_for_ids(
                            &state,
                            &ctx.owner_binding,
                            ctx.user_id.as_deref(),
                            ctx.agent_id.as_deref(),
                            ctx.session_id.as_deref(),
                            ctx.org_id.as_deref(),
                            &ctx.request_id,
                            ctx.managed_inference,
                            "composio",
                            None,
                            Some(cost),
                            Some(transaction_id),
                            false,
                            Some("Composio tool execution with provider receipt"),
                            1,
                            crate::org_limits::subject_for(&ctx).as_ref(),
                        );
                    };
                    composio
                        .run_tool_loop_for_session(
                            &mut body,
                            &traced_provider,
                            &decision.model,
                            &entity_id,
                            &allowed,
                            state
                                .tools
                                .as_ref()
                                .map(|catalog| catalog as &dyn crate::tools::CoreCatalog),
                            ctx.agent_id.as_deref(),
                            affinity.as_deref(),
                            Some(&tool_loop_screen::firewall(&state, &ctx)),
                            &org_tool_gate(&state, &ctx),
                            &on_charge,
                        )
                        .await
                }
                ToolLoopKind::Plain => {
                    // Plain completion: no tool loop ⇒ no billable tool calls. Also the
                    // raw-passthrough target — the caller's own tools/tool_calls pass
                    // through untouched.
                    let affinity = account_affinity(&ctx, &body);
                    provider
                        .complete_for_session(&decision.model, &body, affinity.as_deref())
                        .await
                        .map_err(GatewayError::from)
                        .map(|v| (v, 0u64))
                }
            }
        });
        let completion = unless_caller_gone(completion, loop_caller);
        let completion_outcome = if let Some((deadline, _)) = execution_ceiling {
            match tokio::time::timeout_at(deadline, completion).await {
                Ok(outcome) => outcome,
                Err(_) => {
                    // Rounds the provider answered are spend, and so is a
                    // metered round still in flight.
                    if let Some(ledger) = round_ledger.as_ref() {
                        settle_timed_out_tool_rounds(
                            &state,
                            &ctx,
                            attempt_index,
                            ledger,
                            provider.name(),
                            &decision.model,
                            budget.clone(),
                            start,
                            credit_reservation.take(),
                        );
                    }
                    let error = GatewayError::ProviderDeliveryUncertain(
                        "Pool final execution timed out and is not replayed".into(),
                    );
                    gen_ai_telemetry::finish_error(model_span, &error);
                    return Err(error);
                }
            }
        } else {
            completion.await
        };
        let completion_result = match completion_outcome {
            LoopOutcome::Finished(result) => result,
            LoopOutcome::CallerGone => {
                // The client hung up mid-loop. Bill every round the provider
                // answered, including the one in flight once it finishes,
                // under the request id; nobody reads the response.
                let rounds = match round_ledger.as_ref() {
                    Some(ledger) => ledger.settled(ABANDONED_PROVIDER_WAIT).await,
                    None => tool_rounds::ToolRoundTotals::default(),
                };
                if rounds.rounds > 0 {
                    settle_unanswered_tool_rounds(
                        &state,
                        &ctx,
                        ctx.request_id.clone(),
                        rounds,
                        provider.name(),
                        &decision.model,
                        budget.clone(),
                        start,
                        credit_reservation.take(),
                        "client disconnected during the tool loop",
                        None,
                    );
                }
                return Err(GatewayError::Internal(anyhow::anyhow!(
                    "the client disconnected during the tool loop"
                )));
            }
        };
        match &completion_result {
            Ok((response, _)) => gen_ai_telemetry::finish_chat(model_span, response),
            Err(error) => gen_ai_telemetry::finish_error(model_span, error),
        }
        restore_node_openrouter_preferences(
            provider.name(),
            &mut body,
            original_provider_options,
            original_models,
        );

        match completion_result {
            Ok((mut response, billable_tool_calls)) => {
                upstream_signals::note_soft_refusal(
                    &state,
                    &ctx,
                    attempt_index,
                    provider.name(),
                    &response,
                );
                // A tool loop settles every round it ran. The client still
                // receives the final round's own usage.
                let round_totals = round_ledger.as_ref().map(|ledger| ledger.totals());
                let billed = round_totals.map(|rounds| rounds.billing_view(&response));
                // Only the answering round is judged against the token limits;
                // `admitted_tokens` keeps the earlier rounds out of that check.
                let earlier_round_tokens =
                    round_totals.map_or(0, |rounds| rounds.earlier_round_tokens());
                if execution_ceiling.is_some_and(|(_, limit)| {
                    pool_execution::response_text_bytes(&response)
                        .map_or(true, |bytes| bytes > limit)
                }) {
                    // Settle accepted work below before rejecting oversized output.
                    let _settlement = inference_governance::settle_completion(
                        &state,
                        &ctx,
                        billed.as_ref().unwrap_or(&response),
                        inference_governance::CompletionReceipt {
                            provider: provider.name().to_owned(),
                            model: decision.model.clone(),
                            purpose: Some("pool_output_limit"),
                            audit_provider: provider.name().into(),
                            backend: Some("pool-final"),
                            start,
                            admitted_tokens: earlier_round_tokens,
                            estimated_input: estimate_prompt_tokens(&body),
                            budget: budget.clone(),
                            reservations: credit_reservation.take().into_iter().collect(),
                            zero_cost: false,
                        },
                    );
                    record_earlier_round_tokens(&state, &ctx, earlier_round_tokens);
                    return Err(GatewayError::ProviderError(
                        "Pool final output exceeds configured byte limit".into(),
                    ));
                }
                // Provider generation is complete and the response is fully
                // buffered. Release the local-engine slot before an output
                // evaluator makes a judge call through the same provider; a
                // single-slot local engine must be re-entrant for that
                // post-generation governance pass.
                drop(_admission);
                state
                    .circuit_breaker
                    .record_success(&bound_circuit_key(&route));
                if let Some(route) = attempt.pool.as_ref() {
                    let affinity = account_affinity(&ctx, &body);
                    provider_snapshot(&state, &ctx)
                        .provider_pools
                        .record_success_facts(
                            route,
                            affinity.as_deref(),
                            &pool_signals::scoped_request_facts(&state, &ctx, &pool_base_body),
                            start.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
                        );
                }
                // Determine degraded mode: we served via a fallback when the primary
                // was skipped and a different provider is now responding (#218).
                let degraded = if primary_skipped {
                    state.metrics.inc_degraded_fallback();
                    Some(DegradedMode::Fallback(provider.name().to_string()))
                } else {
                    None
                };

                let billed_response = billed.as_ref().unwrap_or(&response);
                let input_tokens = billed_response["usage"]["prompt_tokens"]
                    .as_u64()
                    .unwrap_or(0);
                let output_tokens = billed_response["usage"]["completion_tokens"]
                    .as_u64()
                    .unwrap_or(0);
                let cache_read_reported = provider_cached_tokens_reported(&response);
                let cache_write_reported = provider_cache_write_tokens_reported(&response);
                let cached_tokens = cache_read_reported.unwrap_or(0);
                let cache_write_tokens = cache_write_reported.unwrap_or(0);
                if cached_tokens > 0 {
                    state.metrics.add_cached_tokens(cached_tokens);
                }
                if cache_write_tokens > 0 {
                    state.metrics.add_cache_write_tokens(cache_write_tokens);
                }

                let mut settlement = inference_governance::settle_completion(
                    &state,
                    &ctx,
                    billed_response,
                    inference_governance::CompletionReceipt {
                        provider: provider.name().to_owned(),
                        model: decision.model.clone(),
                        purpose: None,
                        audit_provider: provider.name().into(),
                        backend: None,
                        start,
                        admitted_tokens: earlier_round_tokens,
                        estimated_input: estimate_prompt_tokens(&body),
                        budget: budget.clone(),
                        reservations: credit_reservation.take().into_iter().collect(),
                        zero_cost: false,
                    },
                );
                record_earlier_round_tokens(&state, &ctx, earlier_round_tokens);
                {
                    let record = settlement.record_mut();
                    record.prompt_cache_outcome = Some(prompt_cache_outcome.as_str().to_owned());
                    record.prompt_cache_read_tokens = cache_read_reported;
                    record.prompt_cache_write_tokens = cache_write_reported;
                }
                // Tools have already executed too; output rejection must not erase their bill.
                spawn_tool_call_debit(&state, &ctx, billable_tool_calls);
                // 9. Outbound firewall
                let policy_pass =
                    apply_outbound_json_dlp(&state, &ctx, &mut response).map_err(|error| {
                        settlement.fail(&error);
                        error
                    })?;

                // 9b. Unified-evaluator inline guardrails — OUTPUT target (P3).
                // Runs the resolved per-agent policy's enabled output evaluators
                // (pii_leakage regex, toxicity/bias LLM-judge) over the response,
                // reusing the firewall block/sanitize machinery. No-op when no
                // binding is enabled.
                apply_inline_output_evaluators(&state, &ctx, &mut response)
                    .await
                    .map_err(|error| {
                        settlement.fail(&error);
                        error
                    })?;

                // 9c. Hazard screener on the output role (screener addendum
                // section 8). Classified before return; a block withholds the
                // response after the provider ran, so the settlement fails.
                // Its events name this attempt and its provider (spec 00.5).
                screen_buffered_output(
                    &state,
                    &ctx.at_attempt(attempt_index, &attempt.decision.provider),
                    &response,
                )
                .await
                .map_err(|error| {
                    settlement.fail(&error);
                    error
                })?;

                if settlement.overrun {
                    state.metrics.inc_rate_limited();
                    state.metrics.inc_errors();
                    return Err(GatewayError::RateLimited);
                }

                if let Some(route) = attempt.pool.as_ref() {
                    if let Some(session) = account_affinity(&ctx, &pool_base_body) {
                        let scope_session =
                            format!("{}:{}", auxiliary::scope(&state, &ctx), session);
                        let latest_user = pool_base_body["messages"]
                            .as_array()
                            .and_then(|messages| {
                                messages
                                    .iter()
                                    .rev()
                                    .find(|message| message["role"] == "user")
                            })
                            .and_then(|message| message["content"].as_str())
                            .unwrap_or_default();
                        provider_snapshot(&state, &ctx).provider_pools.record_relay(
                            route,
                            &scope_session,
                            &response,
                            latest_user,
                        );
                    }
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
                if cache_allowed
                    && provider_kind == &decision.provider
                    && decision.provider == cache_origin.0
                    && decision.model == cache_origin.1
                    && route.cache_allowed
                {
                    state.cache.insert_async(cache_key, response.clone()).await;
                }

                // 12b. Semantic cache store (if we fetched an embedding earlier)
                if cache_allowed
                    && provider_kind == &decision.provider
                    && decision.provider == cache_origin.0
                    && decision.model == cache_origin.1
                    && route.cache_allowed
                {
                    if let (Some(sc), Some(emb)) =
                        (state.semantic_cache.active(), semantic_embedding)
                    {
                        sc.insert_async(Some(semantic_scope.clone()), emb, response.clone())
                            .await;
                    }
                }

                // 11b. Online evals (`[evals.online]`): offer a sampled copy of
                //      the DLP-processed exchange to the background scorer.
                //      Non-blocking; a full queue drops the sample.
                if state.online_evals.is_running() {
                    crate::online_evals::maybe_enqueue(
                        &state,
                        &ctx,
                        &crate::online_evals::latest_user_text(&pool_base_body),
                        &crate::online_evals::response_text(&response),
                        &decision.model,
                        provider.name(),
                    );
                }

                settlement.record_mut().eval_score = eval_score;
                settlement.record_mut().latency_ms = latency_ms;

                // 14b. The OTel GenAI model-call span already ended when the
                // provider returned (`gen_ai_telemetry::finish_chat` above).
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
                    cache_write_tokens,
                    latency_ms,
                    eval_score = ?eval_score,
                    degraded = ?degraded,
                    "request completed"
                );

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
                // A recognised upstream safety refusal on a Ryu-held
                // credential becomes a safety outcome here (spec 03.5).
                let e = upstream_signals::settle(&state, &ctx, attempt_index, e);
                // Rounds the provider answered before the loop failed are spend.
                if let Some(rounds) = round_ledger
                    .as_ref()
                    .map(|ledger| ledger.totals())
                    .filter(|rounds| rounds.rounds > 0)
                {
                    settle_failed_tool_rounds(
                        &state,
                        &ctx,
                        attempt_index,
                        rounds,
                        provider.name(),
                        &decision.model,
                        budget.clone(),
                        start,
                        credit_reservation.take(),
                        Some(&e),
                    );
                }
                if matches!(e, GatewayError::AccountingUnavailable) {
                    if let Some(org_id) = ctx.org_id.as_deref() {
                        state.wallet.set_org_accounting_unavailable(org_id, true);
                    }
                    return Err(e);
                }
                // A safety or policy outcome (a tool loop stopped by the
                // firewall, a refused route) is not a provider failure: no
                // circuit penalty and no fallback, which would shop the request
                // to another provider and run the loop and its tools again.
                if e.is_safety_outcome() {
                    audit_failure(&state, &ctx, &decision.model, &e, start);
                    return Err(e);
                }
                if let Some(route) = attempt.pool.as_ref() {
                    match &e {
                        GatewayError::ProviderRateLimited { retry_after, .. } => {
                            provider_snapshot(&state, &ctx)
                                .provider_pools
                                .record_rate_limit(route, *retry_after);
                        }
                        GatewayError::ProviderPaymentRequired { .. } => {
                            provider_snapshot(&state, &ctx)
                                .provider_pools
                                .record_rate_limit(route, Some(300));
                        }
                        // Feeds the Auto strategy's observed reliability; without it
                        // the ring would only ever hold successes.
                        error if penalizes_provider_circuit(error) => {
                            provider_snapshot(&state, &ctx)
                                .provider_pools
                                .record_failure(route);
                        }
                        _ => {}
                    }
                }
                if matches!(&e, GatewayError::ProviderDeliveryUncertain(_)) {
                    state.metrics.inc_provider_error(provider.name());
                    last_err = Some(e);
                    break;
                }
                // Capacity (429) and account payment (402) are retry/fallback
                // signals, not provider outages. Neither may poison health state.
                if !penalizes_provider_circuit(&e) {
                    state.metrics.inc_provider_error(provider.name());
                    log_provider_failure(
                        provider.name(),
                        &e,
                        "provider unavailable for this account, demoting to next tier",
                    );
                } else {
                    state
                        .circuit_breaker
                        .record_failure(&bound_circuit_key(&route));
                    state.metrics.inc_provider_error(provider.name());
                    log_provider_failure(provider.name(), &e, "provider failed, trying fallback");
                }
                if ends_attempt_chain(&state, &e) {
                    last_err = Some(e);
                    break;
                }
                if Some(provider_kind) == primary_provider.as_ref() {
                    primary_skipped = true;
                }
                remember_preferred_provider_error(&mut last_err, e);
                if attempt.pool.is_some() && loop_kind != ToolLoopKind::Plain {
                    // A managed tool loop may already have performed side effects
                    // before its model call failed. Never replay it on a member.
                    break;
                }
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
            // A refusal that ended the chain on the hosted fleet or a managed
            // node is returned as itself: the providers did not all fail.
            GatewayError::ProviderRejected { .. } if state.custody.ends_chain_on_refusal() => prev,
            // Wrap generic chain errors into the typed variant so clients get
            // a stable `all_providers_unavailable` code, not a 404 or 502.
            GatewayError::CircuitOpen(_)
            | GatewayError::ProviderError(_)
            | GatewayError::ProviderRejected { .. }
            | GatewayError::ProviderTransport(_) => GatewayError::AllProvidersUnavailable(format!(
                "All providers unavailable for model '{}': {prev}",
                decision.model
            )),
            other => other,
        },
    );
    audit_failure(&state, &ctx, &decision.model, &err, start);
    let error_code = match &err {
        GatewayError::AllProvidersUnavailable(_) => "all_providers_unavailable",
        GatewayError::ProviderRateLimited { .. } => "provider_rate_limited",
        GatewayError::ProviderPaymentRequired { .. } => "provider_payment_required",
        GatewayError::RateLimited | GatewayError::RateLimitedBy(_) => "rate_limit_exceeded",
        GatewayError::InsufficientCredits => "insufficient_credits",
        GatewayError::AccountingUnavailable => "credit_accounting_unavailable",
        GatewayError::BudgetStoreUnavailable(_) => "budget_store_unavailable",
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

pub async fn run_stream(
    state: Arc<AppState>,
    ctx: RequestContext,
    body: Value,
) -> Result<PipelineStreamOutput, GatewayError> {
    let managed = ctx.managed_inference;
    // See `run`. A stream that has started is never re-run: only an error
    // returned before the response exists falls back.
    if let Some(plan) = own_supply_plan(&state, &ctx, &body) {
        let (attempt_ctx, attempt_body) = own_supply_attempt(&ctx, &body, &plan);
        let attempt = run_stream_unaliased(Arc::clone(&state), attempt_ctx, attempt_body).await;
        if let Err(error) = &attempt {
            note_own_supply_failure(&state, &plan, error);
        }
        match attempt {
            Ok(mut output) => {
                output.body = model_alias::alias_stream(output.body, plan.shown_model.clone());
                output.model_used = plan.shown_model;
                output.provider_used = model_alias::ALIAS_PROVIDER_LABEL;
                mask_degraded(&mut output.degraded, managed);
                return Ok(output);
            }
            Err(error) if own_supply::may_fall_back(&error, &ctx) => {
                warn!(
                    request_id = %ctx.request_id,
                    slot = %plan.slot,
                    error = %error,
                    "own supply failed before output; streaming from the Ryu Router route"
                );
            }
            Err(error) => return Err(mask_own_supply_error(error, &plan, managed)),
        }
    }
    // See `run`: every streamed frame names the alias the client asked for.
    let alias = model_alias::requested_alias(&body);
    let mut output = run_stream_unaliased(state, ctx, body)
        .await
        .map_err(|error| {
            model_alias::mask_pool_slots(model_alias::mask_error(error, alias), managed)
        })?;
    let shown: Option<String> = alias
        .map(str::to_owned)
        .or_else(|| model_alias::served_display_id(output.provider_used, &output.model_used));
    if let Some(shown) = shown {
        output.body = model_alias::alias_stream(output.body, shown.clone());
        output.model_used = shown;
        output.provider_used = model_alias::ALIAS_PROVIDER_LABEL;
    }
    mask_degraded(&mut output.degraded, managed);
    mask_provider_used(&mut output.provider_used, managed);
    Ok(output)
}

async fn run_stream_unaliased(
    state: Arc<AppState>,
    mut ctx: RequestContext,
    mut body: Value,
) -> Result<PipelineStreamOutput, GatewayError> {
    capture_provider_snapshot(&state, &mut ctx);
    let start = Instant::now();
    // A metered stream settles provider work its client abandons before the
    // first byte (see `StreamOpening`); an unmetered one keeps cancel-on-drop.
    let settles_after_hang_up = settles_after_client_hang_up(&state, &ctx);

    state.metrics.inc_requests();
    let mut sampling_extensions = SamplingExtensions::take(&mut body);

    // Admission and content governance precede optional smart-router inference.
    let requested_model = body["model"].as_str().unwrap_or("unknown").to_string();
    let (mut decision, _cache_key, mut pre_alert, mut pool_route) =
        pre_process(&state, &ctx, &mut body).await.map_err(|e| {
            state.metrics.inc_errors();
            audit_failure(&state, &ctx, &requested_model, &e, start);
            e
        })?;
    state.traffic.note_screen(
        &ctx.request_id,
        crate::traffic::current_route(),
        start.elapsed().as_millis() as u64,
    );

    // Skills injection, then a screen of the injected text (P0-4).
    let skills_alert =
        edit_rescan::inject_skills(&state, &ctx, &mut body, &requested_model, start)?;
    pre_alert = merge_alert(pre_alert, skills_alert);

    let mut execution_ceiling = None;
    if let Some(route) = pool_route
        .as_ref()
        .filter(|route| route.execution.is_some())
    {
        match pool_dispatch::prepare(Arc::clone(&state), &ctx, route, body.clone()).await? {
            Some(pool_dispatch::PreparedExecution::Single {
                target,
                mut response,
            }) => {
                apply_outbound_json_dlp(&state, &ctx, &mut response)?;
                apply_inline_output_evaluators(&state, &ctx, &mut response).await?;
                screen_buffered_output(&state, &ctx, &response).await?;
                let bound = provider_snapshot(&state, &ctx).bind(&RouteDecision {
                    provider: ProviderId::from(target.provider.as_str()),
                    model: target.model.clone(),
                })?;
                let data = crate::tools::value_to_sse_stream(&response);
                return Ok(PipelineStreamOutput {
                    body: data,
                    context: ctx,
                    provider_used: bound.provider.name(),
                    model_used: target.model,
                    budget: None,
                    degraded: None,
                    policy_alert: pre_alert,
                    prompt_cache: ryu_gw_providers::PromptCacheOutcome::Disabled,
                });
            }
            Some(pool_dispatch::PreparedExecution::Final {
                target,
                body: prepared,
                timeout_ms,
                output_bytes,
            }) => {
                body = prepared;
                decision = RouteDecision {
                    provider: ProviderId::from(target.provider.as_str()),
                    model: target.model,
                };
                execution_ceiling = Some((
                    tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms),
                    output_bytes,
                ));
                pool_route = None;
            }
            None => {}
        }
    }

    let execution_final_route = execution_ceiling.map(|_| decision.clone());
    let original_max_tokens = body.get("max_tokens").cloned();
    let original_max_completion_tokens = body.get("max_completion_tokens").cloned();

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
        reservation: mut credit_reservation,
        // Same lifetime: the stream observer records the spend at stream end,
        // and this in-flight claim is released only after that.
        budget_hold,
    } = enforce_budget(
        &state,
        &ctx,
        &mut body,
        &mut decision,
        BudgetChargeKind::Model,
        OutputCeiling::Clamp,
    )?;
    if execution_final_route.as_ref().is_some_and(|target| {
        target.provider != decision.provider || target.model != decision.model
    }) {
        return Err(GatewayError::BudgetExceeded(None));
    }
    authorize_routed_model(&state, &ctx, &requested_model, &decision)?;
    reconcile_pool_after_budget(&decision, &mut pool_route)?;
    // Firewall (Ok-path) alert first so it wins a same-tier tie deterministically.
    let mut policy_alert = merge_alert(pre_alert, budget_alert);

    // Compress once before streaming dispatch, matching the regular chat path
    // (screened, and fail closed on the hosted fleet).
    let compression_alert =
        edit_rescan::compress(&state, &ctx, &mut body, &decision.model, start).await?;
    policy_alert = merge_alert(policy_alert, compression_alert);

    // Ask the provider to emit a terminal usage frame so the stream observer
    // can parse real token counts at stream end. Falls back to the estimates
    // for non-conforming providers (e.g. local llama.cpp builds that ignore
    // stream_options). `evals.stream_usage` is the swappable default (issue
    // #179), but a METERED stream always asks, overriding a client `false`:
    // it is billed from that frame.
    let stream_metered = state.config.credits.is_active() || ctx.managed_inference;
    if state.config.evals.stream_usage || stream_metered {
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
        && (!state.rate_limiter.check_tokens_for_key(
            &ctx.api_key,
            estimated_tokens,
            ctx.key_config.as_ref(),
        ) || !crate::org_limits::check_tokens(&state, &ctx, estimated_tokens))
    {
        warn!(key_id = %crate::audit::credential_log_id(&ctx.api_key), tokens = estimated_tokens, "token-per-minute budget exceeded (stream admission)");
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
    let tools_restricted = matches!(
        budget.as_ref().map(|b| b.action),
        Some(crate::config::BudgetAction::Restrict)
    );

    let tools_active = select_tool_loop(
        &ctx,
        state.tools.is_some(),
        false,
        &state.config.tools,
        tools_restricted,
    ) == ToolLoopKind::Unified;

    let pool_base_body = body.clone();
    let fallback_chain = if execution_ceiling.is_some() {
        vec![ChatAttemptRoute {
            decision: decision.clone(),
            pool: None,
        }]
    } else {
        chat_attempt_routes(&state, &ctx, &decision, pool_route.as_ref())
    };
    let mut last_err: Option<GatewayError> = None;
    let primary_provider_stream = fallback_chain
        .first()
        .map(|attempt| attempt.decision.provider.clone());
    let mut primary_skipped_stream = false;

    // Stamp markers after request transforms. A pool retry restores the request
    // body and applies markers again for that member's model and dialect.
    let mut prompt_cache_outcome = apply_prompt_cache(&state, &ctx, &decision.model, &mut body);

    for (attempt_index, attempt) in fallback_chain.iter().enumerate() {
        // Standing first on every attempt (spec 05.5): a push that lands
        // while an attempt fails must stop the next one from dispatching.
        crate::standing::recheck(&state, &ctx).await?;
        if attempt_index > 0 {
            drop(credit_reservation.take());
            if pool_route.is_some() {
                body = pool_base_body.clone();
            }
            restore_token_ceiling(&mut body, "max_tokens", original_max_tokens.as_ref());
            restore_token_ceiling(
                &mut body,
                "max_completion_tokens",
                original_max_completion_tokens.as_ref(),
            );
            if let Some(restrict) = budget
                .as_ref()
                .filter(|rule| rule.action == crate::config::BudgetAction::Restrict)
            {
                body["max_tokens"] = Value::from(restrict.restrict_max_tokens);
            }
            decision = attempt.decision.clone();
            if let Err(error) = canonicalize_sdk_decision(&state, &ctx, &mut decision) {
                last_err = Some(error);
                continue;
            }
            if let Err(error) = authorize_routed_model(&state, &ctx, &requested_model, &decision) {
                last_err = Some(error);
                continue;
            }
            match reserve_route_credit(&state, &ctx, &mut body, &decision, OutputCeiling::Clamp) {
                Ok(reservation) => credit_reservation = reservation,
                Err(error) => {
                    last_err = Some(error);
                    continue;
                }
            }
            prompt_cache_outcome = apply_prompt_cache(&state, &ctx, &decision.model, &mut body);
        }
        let candidate_provider = &attempt.decision.provider;
        let canonical_provider =
            match canonical_sdk_provider(&state, &ctx, candidate_provider, &attempt.decision.model)
            {
                Ok(provider) => provider,
                Err(error) => {
                    last_err = Some(error);
                    continue;
                }
            };
        let provider_kind = &canonical_provider;
        if let Err(error) =
            inference_governance::authorize_provider_region(&state, &ctx, provider_kind)
        {
            last_err = Some(error);
            if Some(provider_kind) == primary_provider_stream.as_ref() {
                primary_skipped_stream = true;
            }
            continue;
        }
        if state.circuit_breaker.is_open(&provider_circuit_key(
            &state,
            &ctx,
            provider_kind.as_str(),
        )) {
            remember_preferred_provider_error(
                &mut last_err,
                GatewayError::CircuitOpen(provider_kind.as_str().to_string()),
            );
            if Some(provider_kind) == primary_provider_stream.as_ref() {
                primary_skipped_stream = true;
            }
            continue;
        }

        let Some(provider) = provider_snapshot(&state, &ctx)
            .providers
            .get_owned(provider_kind.as_str())
        else {
            if Some(provider_kind) == primary_provider_stream.as_ref() {
                primary_skipped_stream = true;
            }
            continue;
        };

        // A refused handoff ends the request, as on the non-streaming path.
        let relay_alert = apply_pool_relay(
            &state,
            &ctx,
            attempt.pool.as_ref(),
            &mut body,
            &decision.model,
            start,
        )?;
        policy_alert = merge_alert(policy_alert, relay_alert);
        // Per-attempt re-admission (spec 02.12 and 00.12): the hazard screener
        // reads the body this attempt sends, skills, compression and relay
        // edits included. Unchanged segments answer from the segment cache,
        // so a fallback attempt costs no second classifier call.
        if let Err(error) = crate::screening::admit::screen_chat_as(
            &state,
            &ctx,
            &body,
            crate::screening::admit::Surface::Chat,
            &attempt.decision.model,
        )
        .await
        {
            state.metrics.inc_errors();
            audit_failure(&state, &ctx, &decision.model, &error, start);
            return Err(error);
        }

        state.metrics.inc_provider_request(provider.name());

        // Anthropic betas: same per-attempt strip as the non-streaming path.
        strip_anthropic_beta_for(&mut body, provider.name());
        strip_cache_control_for(&mut body, provider.name(), &decision.model);
        sampling_extensions.apply_for(&mut body, provider.name());
        stamp_upstream_identity(
            &state,
            &ctx,
            &mut body,
            provider.name(),
            crate::identity::UpstreamSurface::Chat,
        );

        // Admission gate (streaming): same priority queue as the non-stream path.
        // The permit must outlive `run_stream` — a generation occupies an engine
        // slot for its whole duration — so on success it is *moved into* the
        // returned SSE body and dropped only at stream end (see
        // `hold_admission_until_stream_end`). On a provider error it drops here
        // and the slot frees before the fallback attempt. As on the non-stream
        // path, the re-entrant tool-loop case (`tools_active`) is left ungated to
        // avoid a parent holding a slot while a delegated child waits for one.
        // Output guardrails do not bypass this gate: their helper releases the
        // permit after the upstream stream is fully buffered, immediately before
        // any re-entrant LLM judge runs.
        let admission_permit = if tools_active {
            crate::concurrency::AdmissionPermit::none()
        } else {
            match state
                .admission
                .acquire_for(provider.name(), ctx.priority, ctx.org_id.as_deref())
                .await
            {
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
        let (original_provider_options, original_models) =
            apply_node_openrouter_preferences(&state, &ctx, provider.name(), &mut body, true);
        let pool_load = attempt
            .pool
            .as_ref()
            .and_then(|pool| provider_snapshot(&state, &ctx).provider_pools.acquire(pool));
        // Every provider round of a tool loop is billed, not only the one the
        // synthesized stream carries.
        let round_ledger = tools_active.then(|| Arc::new(tool_rounds::ToolRoundLedger::default()));
        // A metered stream opens on its own task: the provider's answer, not
        // a client hang-up, decides whether the prompt is billed.
        let detached_open = (settles_after_hang_up && !tools_active)
            .then(|| Arc::new(DetachedStreamOpen::default()));
        // The observer exists before the provider is called, so work a client
        // abandons before the first byte is still settled. It holds the credit
        // claim from here on.
        let opening = StreamOpening::new(
            StreamObserverState::new(
                Arc::clone(&state),
                ctx.clone(),
                provider.name().to_string(),
                decision.model.clone(),
                prompt_cache_outcome,
                estimated_tokens,
                start,
                // Managed policy-alert (item 4): stamp the matched budget-cap
                // tier onto the stream-end debit. `limit > 0` excludes the
                // wallet-empty decision; only tiers >= Warn ride.
                budget
                    .as_ref()
                    .filter(|b| b.limit > 0 && b.alert >= AlertTier::Warn)
                    .map(|b| b.alert),
                // The credit claim follows the stream's debit, on every exit
                // including a client hang-up.
                credit_reservation.take(),
            )
            .with_online_prompt(&pool_base_body),
            round_ledger.clone(),
            detached_open.clone(),
            settles_after_hang_up,
        );
        // OTel GenAI model-call span for this attempt; on success it rides into
        // the stream observer and ends when the upstream stream does. The
        // buffered tool loop instead gets one span per provider call
        // (`traced_provider`), so its synthesized stream carries no span.
        let model_span = if tools_active {
            crate::telemetry::gen_ai_span::ModelCallSpan::disabled()
        } else {
            gen_ai_telemetry::start_span(
                &state,
                &ctx,
                crate::telemetry::gen_ai_span::OPERATION_CHAT,
                Some(gen_ai_telemetry::chat_output_type(&body)),
                provider.name(),
                &decision.model,
                &body,
                true,
            )
        };
        let open_stream = model_span.instrument(async {
            if tools_active {
                let allowed = effective_tool_allowlist(&ctx, &state.config.tools);
                let hints = unified_loop_hints(&ctx, &allowed);
                let (composio_user_id, require_composio_user_id) =
                    unified_composio_identity(&state, &ctx)?;
                let tool_ctx = crate::tools::ToolLoopContext {
                    agent_id: ctx.agent_id.clone(),
                    user_id: ctx.user_id.clone(),
                    composio_user_id,
                    require_composio_user_id,
                    allowed,
                    firewall: Some(tool_loop_screen::firewall(&state, &ctx)),
                    untrusted_caller: ctx.untrusted_caller,
                    parallel_reads: state.config.tools.parallel_reads,
                    host_conversation: ctx.host_conversation.clone(),
                    org_tools: org_tool_gate(&state, &ctx),
                };
                inject_unified_loop_tools(&mut body, &ctx, &state.config.tools, tools_restricted);
                // run_tool_loop forces stream:false internally for the provider calls.
                let affinity = account_affinity(&ctx, &body);
                let metered_rounds = tool_rounds::MeteredRounds::new(
                    Arc::clone(&provider),
                    Arc::clone(
                        round_ledger
                            .as_ref()
                            .expect("tools_active implies a round ledger"),
                    ),
                    settles_after_hang_up,
                );
                let traced_provider =
                    gen_ai_telemetry::TracedProvider::new(&state, &ctx, &metered_rounds);
                match crate::tools::run_tool_loop_with_hints_for_session(
                    &mut body,
                    &traced_provider,
                    &decision.model,
                    state.tools.as_ref().expect("tools_active implies Some"),
                    &tool_ctx,
                    state.config.tools.max_rounds,
                    state.config.tools.describe_top_n,
                    hints.as_deref(),
                    affinity.as_deref(),
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
                let affinity = account_affinity(&ctx, &body);
                match &detached_open {
                    Some(open) => open
                        .open(
                            Arc::clone(&provider),
                            decision.model.clone(),
                            body.clone(),
                            affinity,
                        )
                        .await
                        .map_err(GatewayError::from),
                    None => provider
                        .complete_stream_for_session(&decision.model, &body, affinity.as_deref())
                        .await
                        .map_err(GatewayError::from),
                }
            }
        });
        let stream_result: Result<Body, GatewayError> =
            if let Some((deadline, _)) = execution_ceiling {
                match tokio::time::timeout_at(deadline, open_stream).await {
                    Ok(result) => result,
                    Err(_) => {
                        let error = GatewayError::ProviderDeliveryUncertain(
                            "Pool final stream opening timed out; accepted calls are not replayed"
                                .into(),
                        );
                        gen_ai_telemetry::finish_error(model_span, &error);
                        return Err(error);
                    }
                }
            } else {
                open_stream.await
            };
        restore_node_openrouter_preferences(
            provider.name(),
            &mut body,
            original_provider_options,
            original_models,
        );
        // Opened or failed: the observer is the caller's again.
        let mut observer = opening.opened();

        match stream_result {
            Ok(stream_body) => {
                state.circuit_breaker.record_success(&provider_circuit_key(
                    &state,
                    &ctx,
                    provider.name(),
                ));
                if let Some(route) = attempt.pool.as_ref() {
                    let affinity = account_affinity(&ctx, &body);
                    provider_snapshot(&state, &ctx)
                        .provider_pools
                        .record_success_facts(
                            route,
                            affinity.as_deref(),
                            &pool_signals::scoped_request_facts(&state, &ctx, &pool_base_body),
                            start.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
                        );
                }

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
                // arrives. Streaming responses are parsed and redacted frame by
                // frame and released once the violation scan has covered them
                // (`stream_dlp`); under Block a violation ends the stream with
                // the block notice before any matched text is released. Custom
                // patterns and output evaluators keep the fully buffered scan.
                // Observe original upstream usage before client-facing DLP can replace frames.
                // A tool loop's stream bills every round the loop ran.
                observer.tool_rounds = round_ledger.as_ref().map(|ledger| ledger.totals());
                // The attempt's model-call span ends when the upstream stream does.
                observer.model_span = Some(model_span);
                // Standing is checked before every output window, beneath the
                // stream observer, so a stream cut by a refusal still settles.
                let stream_body = crate::standing::guard_stream(
                    stream_body,
                    Arc::clone(&state),
                    ctx.standing.clone(),
                );
                let observed_body = observe_stream(stream_body, observer);
                let observed_body = if let Some((deadline, limit)) = execution_ceiling {
                    bound_pool_stream(observed_body, deadline, limit)
                } else {
                    observed_body
                };

                let (observed_body, admission_permit) = apply_outbound_firewall_stream(
                    observed_body,
                    Arc::clone(&state),
                    ctx.clone(),
                    admission_permit,
                )
                .await;
                // 9b. Hazard screener windows over what the client receives
                // (screener addendum section 8): asynchronous, and a block
                // ends the stream with the output-blocked error frame.
                let observed_body = crate::screening::output::guard_stream(
                    observed_body,
                    Arc::clone(&state),
                    ctx.at_attempt(attempt_index, &attempt.decision.provider),
                    Some(decision.model.clone()),
                );

                // Hold any remaining admission slot (the pass-through path) for
                // the *whole* client stream: move it into the body so it drops
                // only when the SSE is fully consumed (or the client
                // disconnects). Buffered guardrail paths already released the
                // engine slot after the upstream generation ended. The credit
                // claim is held by the observer's debit task instead.
                let observed_body =
                    hold_admission_until_stream_end(observed_body, admission_permit);
                let observed_body = hold_until_stream_end(observed_body, budget_hold);
                // The ladder's in-flight slots (spec 04.8.1) are held until
                // the client has the whole stream, not until headers.
                let observed_body = hold_until_stream_end(observed_body, ctx.enforcement.clone());
                let observed_body = hold_pool_load_until_stream_end(observed_body, pool_load);
                let observed_body = if let Some(route) = attempt.pool.clone() {
                    capture_pool_relay_stream(
                        observed_body,
                        Arc::clone(&state),
                        ctx.clone(),
                        route,
                        pool_base_body.clone(),
                    )
                } else {
                    observed_body
                };

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
                let e = upstream_signals::settle(&state, &ctx, attempt_index, e);
                gen_ai_telemetry::finish_error(model_span, &e);
                match round_ledger
                    .as_ref()
                    .map(|ledger| ledger.totals())
                    .filter(|rounds| rounds.rounds > 0)
                {
                    // A tool loop that failed after rounds the provider
                    // answered: those rounds are spend, billed now under their
                    // own ref so a fallback attempt's debit is not taken for a
                    // duplicate of this one. The claim, shrunk to what the
                    // rounds cost, follows this debit.
                    Some(rounds) => {
                        observer.credit_reservation = shrink_credit_claim(
                            &state,
                            &ctx,
                            observer.credit_reservation.take(),
                            tool_rounds_charge_micro_usd(
                                &state,
                                &rounds,
                                provider.name(),
                                &decision.model,
                            ),
                        );
                        observer.tool_rounds = Some(rounds);
                        observer.interruption = Some("tool loop failed after paid provider rounds");
                        observer.ctx.request_id =
                            format!("{}:attempt-{attempt_index}", ctx.request_id);
                        drop(observer);
                    }
                    // Nothing was served: no charge, and the claim goes back to
                    // the attempt loop exactly as before.
                    None => {
                        credit_reservation = observer.credit_reservation.take();
                        observer.done = true;
                    }
                }
                // See the non-stream arm: a safety outcome ends the request.
                if e.is_safety_outcome() {
                    audit_failure(&state, &ctx, &decision.model, &e, start);
                    return Err(e);
                }
                if let Some(route) = attempt.pool.as_ref() {
                    match &e {
                        GatewayError::ProviderRateLimited { retry_after, .. } => {
                            provider_snapshot(&state, &ctx)
                                .provider_pools
                                .record_rate_limit(route, *retry_after);
                        }
                        GatewayError::ProviderPaymentRequired { .. } => {
                            provider_snapshot(&state, &ctx)
                                .provider_pools
                                .record_rate_limit(route, Some(300));
                        }
                        // Feeds the Auto strategy's observed reliability; without it
                        // the ring would only ever hold successes.
                        error if penalizes_provider_circuit(error) => {
                            provider_snapshot(&state, &ctx)
                                .provider_pools
                                .record_failure(route);
                        }
                        _ => {}
                    }
                }
                if matches!(&e, GatewayError::ProviderDeliveryUncertain(_)) {
                    state.metrics.inc_provider_error(provider.name());
                    last_err = Some(e);
                    break;
                }
                // See the non-stream arm: 429 capacity and 402 payment conditions
                // demote tiers without a circuit penalty.
                if !penalizes_provider_circuit(&e) {
                    state.metrics.inc_provider_error(provider.name());
                    log_provider_failure(
                        provider.name(),
                        &e,
                        "stream provider unavailable for this account, demoting to next tier",
                    );
                } else {
                    state.circuit_breaker.record_failure(&provider_circuit_key(
                        &state,
                        &ctx,
                        provider.name(),
                    ));
                    state.metrics.inc_provider_error(provider.name());
                    log_provider_failure(
                        provider.name(),
                        &e,
                        "stream provider failed, trying fallback",
                    );
                }
                if ends_attempt_chain(&state, &e) {
                    last_err = Some(e);
                    break;
                }
                if Some(provider_kind) == primary_provider_stream.as_ref() {
                    primary_skipped_stream = true;
                }
                remember_preferred_provider_error(&mut last_err, e);
                if attempt.pool.is_some() && tools_active {
                    // A buffered tool loop can have performed external actions
                    // before its final provider failure. Do not replay it.
                    break;
                }
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
            GatewayError::ProviderRejected { .. } if state.custody.ends_chain_on_refusal() => prev,
            GatewayError::CircuitOpen(_)
            | GatewayError::ProviderError(_)
            | GatewayError::ProviderRejected { .. }
            | GatewayError::ProviderTransport(_) => GatewayError::AllProvidersUnavailable(format!(
                "All providers unavailable for model '{}': {prev}",
                decision.model
            )),
            other => other,
        },
    );
    audit_failure(&state, &ctx, &decision.model, &err, start);
    Err(err)
}

fn hold_pool_load_until_stream_end(
    body: Body,
    lease: Option<ryu_gw_router::pool::PoolLease>,
) -> Body {
    hold_until_stream_end(body, lease)
}

fn bound_pool_stream(body: Body, deadline: tokio::time::Instant, limit: usize) -> Body {
    use futures_util::StreamExt;
    let stream = async_stream::stream! {
        let mut source = body.into_data_stream();
        let mut received = 0usize;
        loop {
            match tokio::time::timeout_at(deadline,source.next()).await {
                Ok(Some(Ok(bytes))) => {
                    received = received.saturating_add(bytes.len());
                    if received > limit {
                        yield Err(std::io::Error::other("Pool stream output limit reached"));
                        break;
                    }
                    yield Ok(bytes);
                }
                Ok(Some(Err(error))) => { yield Err(std::io::Error::other(error.to_string())); break; }
                Ok(None) => break,
                Err(_) => { yield Err(std::io::Error::other("Pool stream deadline reached")); break; }
            }
        }
    };
    Body::from_stream(stream)
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
    body: Value,
    modality: Modality,
) -> Result<PipelineOutput, GatewayError> {
    if modality == Modality::Tts {
        return Err(GatewayError::BadRequest(
            "Speech requires the bound delivery pipeline".into(),
        ));
    }
    run_multimodal_bound(state, ctx, body, modality)
        .await
        .map(|(output, _)| output)
}

/// Accepted provider work settles once before opaque hosted audio delivery.
pub async fn run_speech(
    state: Arc<AppState>,
    ctx: RequestContext,
    body: Value,
) -> Result<(PipelineOutput, Option<ryu_gw_providers::HostedSpeechOrigin>), GatewayError> {
    run_multimodal_bound(state, ctx, body, Modality::Tts).await
}

/// Metered media generation is detached for the same reason as [`run`]: a
/// client hang-up must not cancel accepted provider work before it is settled.
async fn run_multimodal_bound(
    state: Arc<AppState>,
    ctx: RequestContext,
    body: Value,
    modality: Modality,
) -> Result<(PipelineOutput, Option<ryu_gw_providers::HostedSpeechOrigin>), GatewayError> {
    let detach = settles_after_client_hang_up(&state, &ctx);
    run_buffered(
        detach,
        run_multimodal_bound_attached(state, ctx, body, modality),
    )
    .await
}

async fn run_multimodal_bound_attached(
    state: Arc<AppState>,
    mut ctx: RequestContext,
    mut body: Value,
    modality: Modality,
) -> Result<(PipelineOutput, Option<ryu_gw_providers::HostedSpeechOrigin>), GatewayError> {
    capture_provider_snapshot(&state, &mut ctx);
    let start = Instant::now();

    state.metrics.inc_requests();

    let requested_model = body["model"].as_str().unwrap_or("unknown").to_string();

    // Ladder L3 takes media generation and transcription away (spec
    // 04.8.1). Chat through this path is not media.
    if modality != Modality::Chat {
        if let Err(e) = crate::enforcement::refuse_media(&ctx) {
            state.metrics.inc_errors();
            audit_failure(&state, &ctx, &requested_model, &e, start);
            return Err(e);
        }
    }
    screen_media_knobs(&state, &ctx, &mut body, &requested_model, start)?;
    let input_alert =
        inference_governance::inspect_multimodal_input(&state, &ctx, &mut body, &modality)
            .map_err(|e| {
                state.metrics.inc_errors();
                audit_failure(&state, &ctx, &requested_model, &e, start);
                e
            })?;
    let screen_surface = match modality {
        Modality::Chat => crate::screening::admit::Surface::Chat,
        Modality::Stt => crate::screening::admit::Surface::Transcription,
        _ => crate::screening::admit::Surface::Media,
    };
    if let Err(e) = crate::screening::admit::screen_value(&state, &ctx, &body, screen_surface).await
    {
        state.metrics.inc_errors();
        audit_failure(&state, &ctx, &requested_model, &e, start);
        return Err(e);
    }

    // An unavailable guardrail must never silently permit a billed media request.
    let scanner = state.resolved_scanner(&ctx);
    state
        .evaluator_registry()
        .validate_inline_bindings(&scanner.config().evaluators)
        .map_err(|reason| {
            let error = GatewayError::BadRequest(reason);
            state.metrics.inc_errors();
            audit_failure(&state, &ctx, &requested_model, &error, start);
            error
        })?;

    // Rate limit + burst check.
    if let Err(e) = admit_request(&state, &ctx) {
        warn!(key_id = %crate::audit::credential_log_id(&ctx.api_key), policy = rate_limit_policy_name(&e), "rate limit exceeded (multimodal)");
        state.metrics.inc_rate_limited();
        audit_failure(&state, &ctx, &requested_model, &e, start);
        return Err(e);
    }

    // Modality-aware routing — honor the per-agent slot override forwarded by
    // Core (M3 / #164) so each modality call from the same carded agent can
    // reach a different provider. Governance (firewall, budgets, policy) runs
    // after routing and is never bypassed.
    let decision = provider_snapshot(&state, &ctx)
        .router
        .route_modality_with_slot(
            &modality,
            &requested_model,
            ctx.slot_provider.as_ref(),
            ctx.slot_model.as_deref(),
        );

    // Budget enforcement (reuse the chat path's enforcer).
    let mut decision = decision;
    canonicalize_sdk_decision(&state, &ctx, &mut decision)?;
    inference_governance::authorize_model(&state, &ctx, &decision.model).map_err(|e| {
        state.metrics.inc_errors();
        audit_failure(&state, &ctx, &decision.model, &e, start);
        e
    })?;
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
        // Media spend is recorded before this returns; hold the claim until then.
        budget_hold: _budget_hold,
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

    let policy_alert = merge_alert(input_alert, policy_alert);

    inference_governance::authorize_model(&state, &ctx, &decision.model).map_err(|e| {
        state.metrics.inc_errors();
        audit_failure(&state, &ctx, &decision.model, &e, start);
        e
    })?;
    state.traffic.note_screen(
        &ctx.request_id,
        crate::traffic::current_route(),
        start.elapsed().as_millis() as u64,
    );

    let fallback_chain = clamped_fallback_chain(&state, &ctx, &decision);
    let mut last_err: Option<GatewayError> = None;
    let primary_provider_mm = fallback_chain.first().cloned();
    let mut primary_skipped_mm = false;

    for (attempt_index, candidate_provider) in fallback_chain.iter().enumerate() {
        // Standing first on every attempt (spec 05.5): a push that lands
        // while an attempt fails must stop the next one from dispatching.
        crate::standing::recheck(&state, &ctx).await?;
        let canonical_provider =
            match canonical_sdk_provider(&state, &ctx, candidate_provider, &decision.model) {
                Ok(provider) => provider,
                Err(error) => {
                    last_err = Some(error);
                    continue;
                }
            };
        let provider_kind = &canonical_provider;
        if let Err(error) =
            inference_governance::authorize_provider_region(&state, &ctx, provider_kind)
        {
            last_err = Some(error);
            if Some(provider_kind) == primary_provider_mm.as_ref() {
                primary_skipped_mm = true;
            }
            continue;
        }
        if state.circuit_breaker.is_open(&provider_circuit_key(
            &state,
            &ctx,
            provider_kind.as_str(),
        )) {
            remember_preferred_provider_error(
                &mut last_err,
                GatewayError::CircuitOpen(provider_kind.as_str().to_string()),
            );
            if Some(provider_kind) == primary_provider_mm.as_ref() {
                primary_skipped_mm = true;
            }
            continue;
        }

        let Some(provider) = provider_snapshot(&state, &ctx)
            .providers
            .get_owned(provider_kind.as_str())
        else {
            if Some(provider_kind) == primary_provider_mm.as_ref() {
                primary_skipped_mm = true;
            }
            continue;
        };

        if attempt_index > 0 {
            drop(credit_reservation.take());
            let retry = RouteDecision {
                provider: provider_kind.clone(),
                model: decision.model.clone(),
            };
            match reserve_route_credit(&state, &ctx, &mut body, &retry, OutputCeiling::Untouched) {
                Ok(reservation) => credit_reservation = reservation,
                Err(error) => {
                    last_err = Some(error);
                    continue;
                }
            }
        }

        state.metrics.inc_provider_request(provider.name());

        stamp_upstream_identity(
            &state,
            &ctx,
            &mut body,
            provider.name(),
            crate::identity::UpstreamSurface::for_modality(&modality),
        );

        let (original_provider_options, original_models) =
            apply_node_openrouter_preferences(&state, &ctx, provider.name(), &mut body, false);
        let speech_affinity = account_affinity(&ctx, &body);
        let mut speech_origin = None;
        let (gen_ai_operation, gen_ai_output_type) =
            gen_ai_telemetry::multimodal_operation(&modality, &body);
        let model_span = gen_ai_telemetry::start_span(
            &state,
            &ctx,
            gen_ai_operation,
            Some(gen_ai_output_type),
            provider.name(),
            &decision.model,
            &body,
            false,
        );
        let result = model_span
            .instrument(async {
                match modality {
                    Modality::Image => provider
                        .generate_image(&decision.model, &body)
                        .await
                        .map_err(GatewayError::from),
                    Modality::Tts => provider
                        .synthesize_speech_bound(&decision.model, &body, speech_affinity.as_deref())
                        .await
                        .map(|bound| {
                            let (response, origin) = bound.into_parts();
                            speech_origin = origin;
                            response
                        })
                        .map_err(GatewayError::from),
                    Modality::Stt => provider
                        .transcribe_audio(&decision.model, &body)
                        .await
                        .map_err(GatewayError::from),
                    Modality::Chat => {
                        let affinity = account_affinity(&ctx, &body);
                        provider
                            .complete_for_session(&decision.model, &body, affinity.as_deref())
                            .await
                            .map_err(GatewayError::from)
                    }
                    // Video and audio generation are job-based (submit + poll);
                    // they never flow through the block-and-return path.
                    // `submit_media_job` handles them instead.
                    Modality::Video => Err(GatewayError::ProviderError(
                        "video generation is job-based; use POST /v1/videos/generations"
                            .to_string(),
                    )),
                    Modality::Audio => Err(GatewayError::ProviderError(
                        "audio generation is job-based; use POST /v1/audio/generations".to_string(),
                    )),
                }
            })
            .await;
        match &result {
            Ok(response) if modality == Modality::Chat => {
                gen_ai_telemetry::finish_chat(model_span, response)
            }
            Ok(response) => gen_ai_telemetry::finish_reported(model_span, response),
            Err(error) => gen_ai_telemetry::finish_error(model_span, error),
        }
        restore_node_openrouter_preferences(
            provider.name(),
            &mut body,
            original_provider_options,
            original_models,
        );

        match result {
            Ok(mut response) => {
                state.circuit_breaker.record_success(&provider_circuit_key(
                    &state,
                    &ctx,
                    provider.name(),
                ));
                let latency_ms = start.elapsed().as_millis() as u64;

                apply_outbound_json_dlp(&state, &ctx, &mut response).map_err(|e| {
                    audit_failure(&state, &ctx, &decision.model, &e, start);
                    e
                })?;
                // Hazard screener on the output role: chat text and STT
                // transcripts are classified before return (spec 02.11.3).
                // Generated images are not classified yet (no vision backend).
                let screened_output = match modality {
                    Modality::Chat => Some(crate::screening::output::response_text(&response)),
                    Modality::Stt => response["text"].as_str().map(str::to_owned),
                    _ => None,
                };
                if let Some(text) = screened_output {
                    crate::screening::output::screen_buffered(
                        &state,
                        &ctx.at_attempt(attempt_index, candidate_provider),
                        &text,
                        Some(decision.model.as_str()),
                    )
                    .await
                    .map_err(|e| {
                        audit_failure(&state, &ctx, &decision.model, &e, start);
                        e
                    })?;
                }

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
                    team_ids: ctx.audit_team_ids(),
                    key_id: ctx.key_id(),
                    project_id: ctx.project_id.clone(),
                    provider: format!("{}:{}", provider.name(), modality.as_str()),
                    model: decision.model.clone(),
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_tokens: None,
                    cache_write_tokens: None,
                    cache_hit: false,
                    prompt_cache_outcome: None,
                    prompt_cache_read_tokens: None,
                    prompt_cache_write_tokens: None,
                    cache_write_1h_tokens: None,
                    latency_ms,
                    eval_score: None,
                    error: None,
                    skill_ids: ctx.skill_ids.clone(),
                    session_id: ctx.session_id.clone(),
                    user_id: ctx.user_id.clone(),
                    agent_id: ctx.agent_id.clone(),
                    feature: ctx.feature.clone(),
                    purpose: ctx.purpose.clone(),
                    managed_inference: ctx.managed_inference,
                    provider_cost_micro_usd,
                    event_type: crate::audit::EventType::ModelCall,
                    backend: None,
                    command: None,
                    duration_ms: None,
                    exit_code: None,
                    widget_instance_id: None,
                });

                // The OTel GenAI span (`generate_content`, or `chat` for a chat
                // modality) ended when the provider returned, carrying only the
                // token counts the provider actually reported.
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
                        let ref_id = media_debit_reference(&modality);
                        let pool = crate::credit_pools::pool_for_gateway_provider(provider.name());
                        let debit_attribution = DebitAttribution {
                            provider: Some(provider.name().to_string()),
                            upstream_provider: provider_usage::response_upstream_provider(
                                &response,
                            ),
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
                            tags: crate::org_limits::tags_for(&ctx),
                            ..Default::default()
                        };
                        tokio::spawn(async move {
                            debit_wallet_for_request(
                                state_debit,
                                org_id,
                                ref_id,
                                CreditDebitReason::GatewayUsage,
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

                return Ok((
                    PipelineOutput {
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
                    },
                    speech_origin,
                ));
            }
            Err(e) => {
                let e = upstream_signals::settle(&state, &ctx, attempt_index, e);
                // A safety outcome ends the request: see the chat arm.
                if e.is_safety_outcome() {
                    audit_failure(&state, &ctx, &decision.model, &e, start);
                    return Err(e);
                }
                if matches!(&e, GatewayError::ProviderDeliveryUncertain(_)) {
                    state.metrics.inc_provider_error(provider.name());
                    last_err = Some(e);
                    break;
                }
                if penalizes_provider_circuit(&e) {
                    state.circuit_breaker.record_failure(&provider_circuit_key(
                        &state,
                        &ctx,
                        provider.name(),
                    ));
                }
                state.metrics.inc_provider_error(provider.name());
                log_provider_failure(
                    provider.name(),
                    &e,
                    "multimodal provider failed, trying fallback",
                );
                if ends_attempt_chain(&state, &e) {
                    last_err = Some(e);
                    break;
                }
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
            GatewayError::ProviderRejected { .. } if state.custody.ends_chain_on_refusal() => prev,
            GatewayError::CircuitOpen(_)
            | GatewayError::ProviderError(_)
            | GatewayError::ProviderRejected { .. }
            | GatewayError::ProviderTransport(_) => GatewayError::AllProvidersUnavailable(format!(
                "All providers unavailable for {modality:?} model '{}': {prev}",
                decision.model
            )),
            other => other,
        },
    );
    audit_failure(&state, &ctx, &decision.model, &err, start);
    Err(err)
}

/// Run embeddings or reranking through the same governance used by chat and
/// multimodal calls. These endpoints still consume provider tokens and wallet
/// credits even though their response shape is not a chat completion.
/// Metered calls are detached for the same reason as [`run`]: a client hang-up
/// must not cancel an accepted embedding or rerank call before it is settled.
pub async fn run_embedding(
    state: Arc<AppState>,
    ctx: RequestContext,
    body: Value,
    operation: EmbeddingOperation,
) -> Result<PipelineOutput, GatewayError> {
    let detach = settles_after_client_hang_up(&state, &ctx);
    run_buffered(detach, run_embedding_attached(state, ctx, body, operation)).await
}

async fn run_embedding_attached(
    state: Arc<AppState>,
    mut ctx: RequestContext,
    mut body: Value,
    operation: EmbeddingOperation,
) -> Result<PipelineOutput, GatewayError> {
    capture_provider_snapshot(&state, &mut ctx);
    let start = Instant::now();
    state.metrics.inc_requests();
    let requested_model = body["model"].as_str().unwrap_or("unknown").to_string();

    if let Err(error) = admit_request(&state, &ctx) {
        state.metrics.inc_rate_limited();
        audit_failure(&state, &ctx, &requested_model, &error, start);
        return Err(error);
    }

    let shape = match operation {
        EmbeddingOperation::Embed => inference_governance::InputShape::Embedding,
        EmbeddingOperation::Rerank => inference_governance::InputShape::Rerank,
    };
    let mut decision = provider_snapshot(&state, &ctx)
        .router
        .route(&requested_model);
    canonicalize_sdk_decision(&state, &ctx, &mut decision)?;
    let input_alert = (|| {
        inference_governance::authorize_model(&state, &ctx, &requested_model)?;
        inference_governance::enforce_lifetime_budget(&state, &ctx, &mut body, &mut decision)?;
        inference_governance::inspect_input(&state, &ctx, &mut body, shape)
    })()
    .map_err(|error| {
        audit_failure(&state, &ctx, &requested_model, &error, start);
        error
    })?;
    if let Err(error) = crate::screening::admit::screen_value(
        &state,
        &ctx,
        &body,
        crate::screening::admit::Surface::Embeddings,
    )
    .await
    {
        audit_failure(&state, &ctx, &requested_model, &error, start);
        return Err(error);
    }
    let estimated_input = inference_governance::input_token_estimate(&body, shape);
    if !state.rate_limiter.check_tokens_for_key(
        &ctx.api_key,
        estimated_input,
        ctx.key_config.as_ref(),
    ) || !crate::org_limits::check_tokens(&state, &ctx, estimated_input)
    {
        let error = GatewayError::RateLimited;
        audit_failure(&state, &ctx, &requested_model, &error, start);
        return Err(error);
    }

    let original_max_tokens = body.get("max_tokens").cloned();
    let BudgetOutcome {
        decision: budget,
        alert: policy_alert,
        reservation: mut credit_reservation,
        budget_hold: _budget_hold,
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

    inference_governance::authorize_model(&state, &ctx, &decision.model).map_err(|error| {
        audit_failure(&state, &ctx, &decision.model, &error, start);
        error
    })?;
    inference_governance::authorize_provider_region(&state, &ctx, &decision.provider).map_err(
        |error| {
            audit_failure(&state, &ctx, &decision.model, &error, start);
            error
        },
    )?;
    body["model"] = json!(decision.model);
    // Restrict is a text-generation budget action; do not add a chat-only field to this wire shape.
    if let Some(max_tokens) = original_max_tokens {
        body["max_tokens"] = max_tokens;
    } else if let Some(object) = body.as_object_mut() {
        object.remove("max_tokens");
    }
    let mut input_reservation =
        inference_governance::reserve_input_credit(&state, &ctx, &decision, estimated_input)
            .map_err(|error| {
                audit_failure(&state, &ctx, &decision.model, &error, start);
                error
            })?;
    let policy_alert = merge_alert(input_alert, policy_alert);
    state.traffic.note_screen(
        &ctx.request_id,
        crate::traffic::current_route(),
        start.elapsed().as_millis() as u64,
    );

    // Embedding cache: a request whose every input is cached is answered without
    // a provider call, after all admission and input governance above ran.
    let embedding_slot = embedding_cache_slot(&state, &ctx, &decision, &body, operation);
    if let (Some(cache), Some((scope, request))) =
        (state.embedding_cache.as_ref(), embedding_slot.as_ref())
    {
        if let Some(cached) = cache.lookup(scope, &decision.model, request).await {
            debug!(request_id = %ctx.request_id, "embedding cache hit");
            state.metrics.inc_embedding_cache_hit();
            audit_cache_hit(
                &state,
                &ctx,
                "cache",
                &model_alias::display_model(decision.provider.as_str(), &decision.model),
                &cached,
                start,
            );
            return Ok(PipelineOutput {
                response: cached,
                context: ctx,
                provider_used: "cache",
                model_used: decision.model,
                cache_hit: true,
                budget: None,
                eval_score: None,
                degraded: None,
                policy_alert,
                prompt_cache: ryu_gw_providers::PromptCacheOutcome::Disabled,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
            });
        }
        state.metrics.inc_embedding_cache_miss();
    }

    let fallback_chain = clamped_fallback_chain(&state, &ctx, &decision);
    let primary_provider = fallback_chain.first().cloned();
    let mut primary_skipped = false;
    let mut last_error: Option<GatewayError> = None;

    for (attempt_index, candidate_provider) in fallback_chain.iter().enumerate() {
        // Standing first on every attempt (spec 05.5): a push that lands
        // while an attempt fails must stop the next one from dispatching.
        crate::standing::recheck(&state, &ctx).await?;
        let canonical_provider =
            match canonical_sdk_provider(&state, &ctx, candidate_provider, &decision.model) {
                Ok(provider) => provider,
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            };
        let provider_kind = &canonical_provider;
        if let Err(error) =
            inference_governance::authorize_provider_region(&state, &ctx, provider_kind)
        {
            last_error = Some(error);
            if Some(provider_kind) == primary_provider.as_ref() {
                primary_skipped = true;
            }
            continue;
        }
        if state.circuit_breaker.is_open(&provider_circuit_key(
            &state,
            &ctx,
            provider_kind.as_str(),
        )) {
            last_error = Some(GatewayError::CircuitOpen(
                provider_kind.as_str().to_string(),
            ));
            if Some(provider_kind) == primary_provider.as_ref() {
                primary_skipped = true;
            }
            continue;
        }

        let Some(provider) = provider_snapshot(&state, &ctx)
            .providers
            .get_owned(provider_kind.as_str())
        else {
            if Some(provider_kind) == primary_provider.as_ref() {
                primary_skipped = true;
            }
            continue;
        };
        if attempt_index > 0 {
            drop(credit_reservation.take());
            drop(input_reservation.take());
            let retry = RouteDecision {
                provider: provider_kind.clone(),
                model: decision.model.clone(),
            };
            let pool = crate::credit_pools::pool_for_gateway_provider(provider_kind.as_str());
            if let Some(error) = preflight_credit_gate(&ctx, pool) {
                last_error = Some(error);
                continue;
            }
            match inference_governance::reserve_input_credit(&state, &ctx, &retry, estimated_input)
            {
                Ok(reservation) => input_reservation = reservation,
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            }
        }
        state.metrics.inc_provider_request(provider.name());

        let mut provider_body = body.clone();
        node_routing::apply_openrouter_preferences(
            ctx.openrouter_routing_enabled,
            ctx.node_routing.as_ref(),
            &state.config.node_routing,
            provider.name(),
            &mut provider_body,
        );
        let embedding_surface = match operation {
            EmbeddingOperation::Embed => crate::identity::UpstreamSurface::Embedding,
            EmbeddingOperation::Rerank => crate::identity::UpstreamSurface::Rerank,
        };
        stamp_upstream_identity(
            &state,
            &ctx,
            &mut provider_body,
            provider.name(),
            embedding_surface,
        );
        let model_span = gen_ai_telemetry::start_span(
            &state,
            &ctx,
            gen_ai_telemetry::embedding_operation(operation),
            None,
            provider.name(),
            &decision.model,
            &provider_body,
            false,
        );
        let result = model_span
            .instrument(async {
                match operation {
                    EmbeddingOperation::Embed => provider
                        .embed(&decision.model, &provider_body)
                        .await
                        .map_err(GatewayError::from),
                    EmbeddingOperation::Rerank => provider
                        .rerank(&decision.model, &provider_body)
                        .await
                        .map_err(GatewayError::from),
                }
            })
            .await;
        match &result {
            Ok(response) => gen_ai_telemetry::finish_reported(model_span, response),
            Err(error) => gen_ai_telemetry::finish_error(model_span, error),
        }

        match result {
            Ok(response) => {
                state.circuit_breaker.record_success(&provider_circuit_key(
                    &state,
                    &ctx,
                    provider.name(),
                ));
                let exceeded = inference_governance::settle_completion(
                    &state,
                    &ctx,
                    &response,
                    inference_governance::CompletionReceipt {
                        provider: provider.name().to_owned(),
                        model: decision.model.clone(),
                        purpose: Some(operation.as_str()),
                        audit_provider: format!("{}:{}", provider.name(), operation.as_str()),
                        backend: None,
                        start,
                        admitted_tokens: estimated_input,
                        estimated_input,
                        budget: budget.clone(),
                        reservations: [credit_reservation.take(), input_reservation.take()]
                            .into_iter()
                            .flatten()
                            .collect(),
                        zero_cost: false,
                    },
                );
                if exceeded.overrun {
                    state.metrics.inc_rate_limited();
                    state.metrics.inc_errors();
                    return Err(GatewayError::RateLimited);
                }

                // Only the provider the cache scope names may populate it; a
                // fallback provider's vectors live in a different space.
                if provider_kind == &decision.provider {
                    if let (Some(cache), Some((scope, request))) =
                        (state.embedding_cache.as_ref(), embedding_slot.as_ref())
                    {
                        cache.store(scope, request, &response).await;
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
                let error = upstream_signals::settle(&state, &ctx, attempt_index, error);
                // A safety outcome ends the request: see the chat arm.
                if error.is_safety_outcome() {
                    audit_failure(&state, &ctx, &decision.model, &error, start);
                    return Err(error);
                }
                if matches!(&error, GatewayError::ProviderDeliveryUncertain(_)) {
                    state.metrics.inc_provider_error(provider.name());
                    last_error = Some(error);
                    break;
                }
                if penalizes_provider_circuit(&error) {
                    state.circuit_breaker.record_failure(&provider_circuit_key(
                        &state,
                        &ctx,
                        provider.name(),
                    ));
                }
                state.metrics.inc_provider_error(provider.name());
                let ends_chain = ends_attempt_chain(&state, &error);
                last_error = Some(error);
                if ends_chain {
                    break;
                }
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
            GatewayError::ProviderRejected { .. } if state.custody.ends_chain_on_refusal() => {
                previous
            }
            GatewayError::CircuitOpen(_)
            | GatewayError::ProviderError(_)
            | GatewayError::ProviderRejected { .. }
            | GatewayError::ProviderTransport(_) => GatewayError::AllProvidersUnavailable(format!(
                "All providers unavailable for {} model '{}': {previous}",
                operation.as_str(),
                decision.model
            )),
            other => other,
        },
    );
    audit_failure(&state, &ctx, &decision.model, &error, start);
    Err(error)
}

/// Extract the user-visible input text from a multimodal request body for
/// inbound firewall scanning. TTS: `input`; image, video and audio: `prompt`
/// plus every other non-`data:` string leaf (see
/// `inference_governance::multimodal_text_fields`); STT: no text. These are the
/// fields Sanitize rewrites; every other string the provider receives is
/// screened as the residual (see `outbound_text`).
fn multimodal_input_text(body: &Value, modality: &Modality) -> String {
    inference_governance::multimodal_text_fields(body, modality).join("\n")
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod authenticate_tests;

/// End-to-end fallback / cost-tier demotion tests driven through the full
/// `run()` pipeline with scripted providers. These pin the request-path behavior
/// the focus of the coverage sweep called out: a `ProviderRateLimited` demotes
/// down the fallback chain WITHOUT tripping the circuit, a generic provider error
/// trips the circuit and still fails over, an already-open circuit is skipped,
/// and chain exhaustion surfaces the typed `AllProvidersUnavailable` error.
#[cfg(test)]
mod fallback_tests;

fn capture_pool_relay_stream(
    body: Body,
    state: Arc<AppState>,
    ctx: RequestContext,
    route: crate::provider_pools::SelectedPoolRoute,
    request: Value,
) -> Body {
    use futures_util::StreamExt;
    let stream = async_stream::stream! {
        let mut source=body.into_data_stream();
        let mut captured=Vec::new();
        let mut valid=true;
        while let Some(chunk)=source.next().await {
            if let Ok(bytes)=&chunk {
                if valid && captured.len().saturating_add(bytes.len())<=262_144 { captured.extend_from_slice(bytes); }
                else { valid=false;captured.clear(); }
            } else { valid=false; }
            yield chunk;
        }
        if valid {
            if let Ok(text)=std::str::from_utf8(&captured) {
                let mut answer=String::new();let mut done=false;let mut failed=false;
                for line in text.lines().filter_map(|line|line.strip_prefix("data:").map(str::trim)) {
                    if line=="[DONE]" { done=true;continue; }
                    if let Ok(value)=serde_json::from_str::<Value>(line) {
                        failed|=value.get("error").is_some();
                        if let Some(content)=value.pointer("/choices/0/delta/content").and_then(Value::as_str) { answer.push_str(content); }
                    }
                }
                if done && !failed && answer.len()<=16_384 {
                    if let Some(session)=account_affinity(&ctx,&request) {
                        let scoped=format!("{}:{}",auxiliary::scope(&state,&ctx),session);
                        let user=request["messages"].as_array().and_then(|messages|messages.iter().rev().find(|message|message["role"]=="user")).and_then(|message|message["content"].as_str()).unwrap_or_default();
                        provider_snapshot(&state,&ctx).provider_pools.record_relay(&route,&scoped,&json!({"choices":[{"message":{"role":"assistant","content":answer}}]}),user);
                    }
                }
            }
        }
    };
    Body::from_stream(stream)
}
