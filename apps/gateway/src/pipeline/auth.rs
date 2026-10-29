use super::*;

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
    /// The agent's provider access from `x-ryu-agent-provider-access`: a CSV
    /// of provider registry ids, or `none`. Restrict-only (see
    /// [`RequestContext::agent_provider_access`]).
    pub agent_provider_access: Option<String>,
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
    /// JSON-encoded, turn-scoped capability suggestion IDs from Core.
    pub capability_hints: Option<String>,
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
    /// Untrusted-caller restriction (see [`RequestContext::untrusted_caller`]),
    /// from `x-ryu-untrusted-caller`.
    pub untrusted_caller: bool,
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
    /// The caller's Better Auth JWT forwarded by Core, from `x-ryu-user-jwt`.
    /// Only the dynamic `rgw_` path reads it, and only after verifying it
    /// against the control-plane JWKS and the resolved org (contract C3).
    pub user_jwt: Option<String>,
    /// Core's host conversation and its proof, from
    /// `x-ryu-host-conversation-id` / `x-ryu-host-conversation-proof`. Caller
    /// input until [`trusted_host_conversation`] keeps it for a trusted forwarder.
    pub host_conversation: Option<crate::tools::HostConversation>,
}

/// Keep a forwarded host conversation only for a static trusted-forwarder key
/// (Core's own relay key). A scoped `gws1.` credential, a dynamic `rgw_`
/// token, the master key and anonymous callers never relay it: Core would
/// reject a forged proof anyway, but the Gateway does not forward one either.
pub(super) fn trusted_host_conversation(
    key: &ApiKeyConfig,
    forwarded: Option<&crate::tools::HostConversation>,
) -> Option<crate::tools::HostConversation> {
    key.trusted_forwarder.then(|| forwarded.cloned()).flatten()
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
    authenticate_for_operation(state, inputs, ApiKeyOperation::Inference).await
}

pub(crate) async fn authenticate_for_operation(
    state: &AppState,
    inputs: AuthInputs<'_>,
    operation: ApiKeyOperation,
) -> Result<RequestContext, GatewayError> {
    let presented = inputs
        .raw_api_key
        .map(|raw| raw.strip_prefix("Bearer ").unwrap_or(raw).to_owned());
    let mut ctx = authenticate_identity(state, inputs, operation).await?;
    // The platform floor binds every request on the fleet (spec 02.3). One
    // that holds no floor refuses with a retryable 503 rather than serving
    // under tenant policy alone. After identity, so standing codes win.
    crate::platform_floor::admit(state.custody, &state.platform_floor, ctx.is_master_key)?;
    crate::identity::attach(&state.identity_keys, &mut ctx);
    apply_caller_policy(state, &mut ctx, presented.as_deref()).await;
    Ok(ctx)
}

/// Whether the request's user id was asserted by Core (a trusted forwarder
/// key, a `gws1` scoped key, or a `gwb1` Box key, whose user id is in the
/// Core-signed scope) and so may select that user's policy.
pub(super) fn caller_identity_is_core_forwarded(ctx: &RequestContext) -> bool {
    ctx.key_config
        .as_ref()
        .is_some_and(|key| key.trusted_forwarder)
        || ctx.api_key.starts_with("gws1.")
        || (ctx.feature.as_deref() == Some(BOX_FEATURE) && ctx.api_key.starts_with("box:"))
}

/// Narrow the request's policy to the caller's own effective policy when the
/// caller is known on a control-plane-managed gateway (see
/// `policy::user_policy`). The caller identity is only trusted when it came
/// from a verified user JWT (dynamic `rgw_` path) or a trusted forwarder
/// (Core's static key, its scoped `gws1.` credential, or a `gwb1.` Box key);
/// any other forwarded user id is caller input and is ignored here, as
/// everywhere else. A
/// personal-node `rgw_` credential is narrowed by its owner's policy even
/// without a JWT: the binding comes from the control plane, and the policy
/// only ever narrows.
pub(super) async fn apply_caller_policy(
    state: &AppState,
    ctx: &mut RequestContext,
    presented: Option<&str>,
) {
    if ctx.is_master_key {
        return;
    }
    let caller = ctx.user_id.clone().or_else(|| {
        ctx.org_limits
            .as_deref()
            .and_then(|limits| limits.bound_user_id.clone())
    });
    let (Some(cache), Some(user_id)) = (state.user_policy.as_ref(), caller) else {
        return;
    };
    let dynamic = ctx.api_key.starts_with("rgw_org:") && ctx.resolved_policy.is_some();
    let forwarded = caller_identity_is_core_forwarded(ctx);
    let (token, base) = if dynamic {
        let (Some(token), Some(base)) = (presented, ctx.resolved_policy.clone()) else {
            return;
        };
        (token.to_owned(), base)
    } else if forwarded {
        let Some(token) = cache.static_key() else {
            return;
        };
        (token.to_owned(), state.policy_snapshot())
    } else {
        return;
    };
    let rules = cache.rules_for(&token, &user_id).await;
    ctx.resolved_policy = Some(crate::policy::policy_for_caller(&base, rules.as_deref()));
}

/// Parse the `x-ryu-agent-provider-access` value: `none` (or nothing usable)
/// is the empty set, otherwise comma-separated provider registry ids. Malformed
/// ids are dropped, which can only narrow.
pub(super) fn parse_agent_provider_access(raw: &str) -> std::collections::HashSet<String> {
    let raw = raw.trim();
    if raw.eq_ignore_ascii_case("none") {
        return std::collections::HashSet::new();
    }
    raw.split(',')
        .map(str::trim)
        .filter(|id| ryu_gw_credentials::is_provider_access_id(id))
        .map(str::to_owned)
        .collect()
}

/// Combine a header-supplied provider access with a signed scope's list. Either
/// alone applies as is; both present apply their intersection, so neither can
/// widen the other.
pub(super) fn narrow_agent_provider_access(
    header: Option<Arc<std::collections::HashSet<String>>>,
    scope: Option<Vec<String>>,
) -> Option<Arc<std::collections::HashSet<String>>> {
    let scope: Option<std::collections::HashSet<String>> =
        scope.map(|ids| ids.into_iter().collect());
    match (header, scope) {
        (None, None) => None,
        (Some(header), None) => Some(header),
        (None, Some(scope)) => Some(Arc::new(scope)),
        (Some(header), Some(scope)) => {
            Some(Arc::new(header.intersection(&scope).cloned().collect()))
        }
    }
}

/// The organization tool policy (C2) this request's tool loops enforce: the
/// same `resolved_policy || snapshot` the model gates use, so a caller whose
/// rules never resolved (an unavailable policy) is refused every tool. The
/// master key enforces none. Each denial writes an `org_policy.tool_denied`
/// audit row attributed to the request's org.
pub(super) fn org_tool_gate(
    state: &Arc<AppState>,
    ctx: &RequestContext,
) -> crate::policy::OrgToolGate {
    if ctx.is_master_key {
        return crate::policy::OrgToolGate::default();
    }
    let policy = ctx
        .resolved_policy
        .clone()
        .unwrap_or_else(|| state.policy_snapshot());
    let audit_state = Arc::clone(state);
    let api_key = ctx.api_key.clone();
    let org_id = ctx.org_id.clone();
    let user_id = ctx.user_id.clone();
    let agent_id = ctx.agent_id.clone();
    let request_id = ctx.request_id.clone();
    let audit: crate::policy::ToolDenialAudit = Arc::new(move |tool_id: &str, reason: &str| {
        if !audit_state.audit.is_enabled() {
            return;
        }
        let mut record = crate::audit::AuditLogger::make_control_record_with_agent(
            request_id.clone(),
            api_key.clone(),
            user_id.clone().unwrap_or_else(|| "gateway".to_owned()),
            user_id.clone(),
            agent_id.clone(),
            "org_policy.tool_denied".to_owned(),
            tool_id.chars().take(120).collect(),
            Some(reason.chars().take(400).collect()),
        );
        record.org_id = org_id.clone();
        audit_state.log_audit(record);
    });
    crate::policy::OrgToolGate::new(policy, Some(audit))
}

/// Verify Core's forwarded user JWT for a resolved org. `None` when no token
/// was sent, no verifier is configured, or verification fails for any reason.
pub(super) async fn verify_forwarded_user(
    state: &AppState,
    user_jwt: Option<&str>,
    org_id: &str,
) -> Option<crate::policy::VerifiedUser> {
    let token = user_jwt.filter(|token| !token.is_empty())?;
    let verifier = state.user_jwt.as_ref()?;
    match verifier.verify_for_org(token, org_id).await {
        Ok(user) => Some(user),
        Err(error) => {
            debug!(
                ?error,
                org_id, "forwarded user JWT not accepted; attributing to the org"
            );
            None
        }
    }
}

// ─── Smart model routing ─────────────────────────────────────────────────────
