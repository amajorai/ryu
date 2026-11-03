//! The per-request context resolved from auth and the request headers.

use super::*;

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
