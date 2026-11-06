use super::*;

#[path = "box_governance.rs"]
pub(super) mod box_governance;
#[path = "org_admission.rs"]
mod org_admission;

pub(super) async fn authenticate_identity(
    state: &AppState,
    inputs: AuthInputs<'_>,
    operation: ApiKeyOperation,
) -> Result<RequestContext, GatewayError> {
    let AuthInputs {
        raw_api_key,
        user_id,
        agent_id,
        agent_provider_access,
        agent_proof,
        skill_ids,
        tool_actions,
        tools_header_present,
        capability_hints,
        slot_provider,
        slot_model,
        session_id,
        feature,
        companion_source,
        tool_search_requested,
        untrusted_caller,
        priority,
        tool_profile,
        raw_tools,
        prompt_cache_mode,
        prompt_cache_ttl,
        node_routing,
        user_jwt,
        host_conversation,
    } = inputs;
    let agent_provider_access = agent_provider_access
        .as_deref()
        .map(parse_agent_provider_access)
        .map(Arc::new);

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
        let owner_binding = ryu_gw_credentials::fingerprint(&api_key);
        RequestContext {
            authorized_operation: operation,
            provider_snapshot: Some(state.provider_runtime.snapshot()),
            // The HTTP request's id (also its `x-request-id`) for the first
            // context built while serving it; a fresh id otherwise.
            request_id: crate::api::http_conventions::claim_request_id(),
            api_key,
            owner_binding,
            is_master_key,
            org_id,
            team_id,
            project_id,
            user_name,
            user_id: eff_user_id,
            agent_id: eff_agent_id,
            agent_provider_access: agent_provider_access.clone(),
            key_config,
            skill_ids: skill_ids.clone(),
            tool_actions: tool_actions.clone(),
            tools_header_present,
            capability_hints: capability_hints.clone(),
            slot_provider: slot_provider.clone(),
            slot_model: slot_model.clone(),
            own_supply_route: None,
            violation_attempt: Default::default(),
            session_id: session_id.clone(),
            feature: feature.clone(),
            purpose: None,
            companion_source,
            tool_search_requested,
            untrusted_caller,
            priority,
            tool_profile: tool_profile.clone(),
            raw_tools,
            managed_inference,
            openrouter_routing_enabled: false,
            remaining_budget_micro_usd,
            unrestricted_budget_micro_usd,
            pool_budgets_micro_usd,
            credit_accounting_unavailable: false,
            budget_resolved_at: None,
            resolved_policy,
            prompt_cache_mode,
            prompt_cache_ttl: prompt_cache_ttl.clone(),
            node_routing: node_routing.clone(),
            org_limits: None,
            identity: None,
            standing: None,
            enforcement: None,
            // Set only by the static trusted-forwarder branch below.
            host_conversation: None,
        }
    };

    // A context with no key config, credit or org policy of its own.
    let plain_ctx = |is_master_key: bool,
                     api_key: String,
                     org_id: Option<String>,
                     user_name: Option<String>,
                     eff_user_id: Option<String>,
                     eff_agent_id: Option<String>| {
        let no_pools = std::collections::HashMap::new();
        build_ctx(
            is_master_key,
            api_key,
            org_id,
            None,
            None,
            user_name,
            eff_user_id,
            eff_agent_id,
            None,
            false,
            None,
            None,
            no_pools,
            None,
        )
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
        /// A `gwb1` Box key that no local `local-core` forwarder signed: verify
        /// it under the per-org Core proof keys (hosted fleet) and resolve the
        /// org budget outside the lock.
        TryBoxHosted(String),
    }

    // Use the live auth config (via RwLock) so keys added via PUT /v1/config
    // take effect immediately without a gateway restart.
    let outcome = state.with_auth(|auth| {
        if !auth.require_auth && operation == ApiKeyOperation::Inference {
            // Even in no-auth mode a PROVISIONED master key stays authoritative:
            // a caller presenting it is recognized as master (so the shared
            // control-plane admin gate — config/audit/budget-spend — honors it),
            // while everyone else remains anonymous exactly as before. Without a
            // configured master key this is a no-op (pairs with
            // `master_key_present` in `admin_loopback_allowed`).
            if let (Some(master), Some(raw)) = (&auth.master_key, raw_api_key) {
                let key = raw.strip_prefix("Bearer ").unwrap_or(raw);
                if ct_eq(key, master.as_str()) {
                    return StaticOutcome::Matched(plain_ctx(
                        true,
                        key.to_string(),
                        None,
                        Some("master".to_string()),
                        user_id.clone(),
                        agent_id.clone(),
                    ));
                }
            }
            return StaticOutcome::Matched(plain_ctx(
                false,
                raw_api_key.unwrap_or("anonymous").to_string(),
                None,
                None,
                user_id.clone(),
                None, // anonymous: never act as a header-named agent
            ));
        }

        let Some(key) = raw_api_key else {
            return StaticOutcome::Reject(GatewayError::Unauthorized(
                "No API key provided. Pass it via the Authorization header.".to_string(),
            ));
        };
        let key = key.strip_prefix("Bearer ").unwrap_or(key);

        // Local agent identity is issued by Core, never asserted by the recipient.
        // Scoped inference remains non-admin and non-forwarder: it cannot alter
        // routing policy, reattribute spend, or invoke privileged control routes.
        if key.starts_with("gws1.") {
            if operation != ApiKeyOperation::Inference {
                return StaticOutcome::Reject(GatewayError::Unauthorized(
                    "Scoped inference credentials do not authorize web services".to_owned(),
                ));
            }
            let scope = match super::auth::verify_scoped_inference(
                &auth.api_keys,
                key,
                agent_id.as_deref(),
                user_id.as_deref(),
                session_id.as_deref(),
            ) {
                Ok(scope) => scope,
                Err(error) => return StaticOutcome::Reject(error),
            };
            let owner_binding = scoped_inference_owner_binding(&scope);
            let mut context = plain_ctx(
                false,
                key.to_owned(),
                None,
                Some(format!("agent:{}", scope.agent_id)),
                scope.user_id,
                Some(scope.agent_id),
            );
            // Bind stored responses and cache entries to the scope, not to one
            // bearer string: Core remints the bearer under a long-lived agent,
            // and the same agent, user and session must keep reaching them.
            context.owner_binding = owner_binding;
            context.session_id = scope.session_id;
            context.agent_provider_access = narrow_agent_provider_access(
                context.agent_provider_access.take(),
                scope.provider_access,
            );
            return StaticOutcome::Matched(context);
        }

        // A Box's short-lived inference key (`gwb1`, design §7.6). Inference
        // only, never forwarder, admin or web-service power, and always
        // attributed to its Box session under `feature = "box"`.
        if ryu_gw_credentials::BoxInferenceScope::is_box_token(key) {
            if operation != ApiKeyOperation::Inference {
                return StaticOutcome::Reject(GatewayError::Unauthorized(
                    "Box inference credentials do not authorize web services".to_owned(),
                ));
            }
            // A local Gateway: Core signs with its `local-core` forwarder key.
            let local = box_governance::verify_local_box(
                &auth.api_keys,
                key,
                user_id.as_deref(),
                session_id.as_deref(),
            );
            let (scope, forwarder_org) = match local {
                None => return StaticOutcome::TryBoxHosted(key.to_owned()),
                Some(Err(error)) => return StaticOutcome::Reject(error),
                Some(Ok(verified)) => verified,
            };
            let mut context = plain_ctx(
                false,
                box_api_key_label(&scope),
                forwarder_org,
                Some(format!("box:{}", scope.box_id)),
                scope.user_id.clone(),
                None,
            );
            context.owner_binding = ryu_gw_credentials::fingerprint(key);
            context.session_id = Some(scope.session_id);
            context.feature = Some(BOX_FEATURE.to_owned());
            return StaticOutcome::Matched(context);
        }

        if let Some(master) = &auth.master_key {
            if ct_eq(key, master.as_str()) {
                return StaticOutcome::Matched(plain_ctx(
                    true,
                    key.to_string(),
                    None,
                    Some("master".to_string()),
                    user_id.clone(),
                    agent_id.clone(),
                ));
            }
        }

        let relay = org_core_relay::org_core_relay_entry(key);
        for cfg_key in auth.api_keys.iter().chain(&relay) {
            // Constant-time compare (as the master-key branch does): a naive
            // `==` short-circuits on the first differing byte, a timing oracle
            // that leaks the key byte-by-byte. Keep first-match semantics.
            if ct_eq(key, cfg_key.key.as_str()) {
                if !cfg_key.allows_operation(operation) {
                    return StaticOutcome::Reject(GatewayError::Unauthorized(
                        "API key does not authorize this operation".to_owned(),
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
                let mut context = build_ctx(
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
                );
                context.host_conversation =
                    trusted_host_conversation(cfg_key, host_conversation.as_ref());
                return StaticOutcome::Matched(context);
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
        StaticOutcome::Matched(ctx) => org_core_relay::check_relay_key_epoch(state, &ctx)
            .await
            .map(|()| ctx),
        StaticOutcome::Reject(err) => Err(err),
        StaticOutcome::TryBoxHosted(token) => {
            let (user, session) = (user_id.as_deref(), session_id.as_deref());
            let hosted = box_governance::resolve_hosted_box(state, &token, user, session).await?;
            let mut context = plain_ctx(
                false,
                box_api_key_label(&hosted.scope),
                Some(hosted.scope.org_id.clone()),
                Some(format!("box:{}", hosted.scope.box_id)),
                hosted.scope.user_id.clone(),
                None,
            );
            box_governance::finish_hosted_context(state, &mut context, hosted, &token)?;
            Ok(context)
        }
        StaticOutcome::TryDynamic(token) => {
            // Safe: `TryDynamic` is only produced when `resolve_cache` is `Some`.
            let cache = state
                .resolve_cache
                .as_ref()
                .expect("TryDynamic implies resolve_cache is Some");
            let credential_use = org_admission::credential_use_for(operation);
            match cache.resolve_cached_for(&token, credential_use).await {
                Ok(resolved) => {
                    // Platform standing first (spec 05.5): a suspended or
                    // banned credential gets its 00.7 code and appeal link
                    // before any billing or policy decision is made.
                    crate::standing::admit_resolved(&resolved, state.custody)?;
                    // Keep the platform floor this resolve carried when it is
                    // newer than the one held (spec 02.3).
                    state.observe_platform_floor(&resolved);
                    // Bill/attribute to the org under a redacted label: the raw
                    // bearer would be written verbatim into every audit row.
                    let dynamic_agent_id = resolved_dynamic_agent_id(
                        raw_api_key,
                        agent_id.as_deref(),
                        agent_proof.as_deref(),
                        &core_proof_keys_for_org(Some(&resolved.org_id)),
                    )?;
                    let api_key_label = format!("rgw_org:{}", resolved.org_id);
                    // The forwarded `x-ryu-user-id` is caller input and stays
                    // ignored here. A user identity is accepted only from a
                    // JWT that verifies against the control-plane JWKS and
                    // names the resolved org (C3); any failure leaves the
                    // request attributed to the org alone. A team- or
                    // personal-node credential's limits are then also bound
                    // to its own team or owner regardless of the JWT, so
                    // member and team caps cannot be skipped by leaving the
                    // JWT out (`bind_dynamic_caller`).
                    let verified_user =
                        verify_forwarded_user(state, user_jwt.as_deref(), &resolved.org_id).await;
                    let DynamicCaller {
                        user_id: verified_user_id,
                        bound_user_id,
                        team_ids,
                    } = bind_dynamic_caller(
                        resolved.owner_user_id.as_deref(),
                        resolved.owner_team_ids.as_deref(),
                        resolved.team_id.as_deref(),
                        verified_user,
                    );
                    let bills_tenants = state.config.credits.is_active();
                    let credit = resolved.metered_credit(bills_tenants);
                    let mut context = build_ctx(
                        false,
                        api_key_label,
                        Some(resolved.org_id.clone()),
                        team_ids.first().cloned(),
                        // The project the resolve validated (`x-project-id`).
                        resolved.project_id.clone(),
                        // `rgw_` bearer tokens are resolved by the control plane,
                        // but the forwarded identity headers are still caller
                        // input. Dynamic credentials have no trusted-forwarder
                        // configuration, so bind the user/audit identity to the
                        // resolved tenant. The agent identity is accepted only
                        // when Core supplied the HMAC proof above.
                        Some(format!("org:{}", resolved.org_id)),
                        verified_user_id,
                        dynamic_agent_id,
                        None,
                        credit.managed_inference,
                        credit.remaining_budget_micro_usd,
                        credit.unrestricted_budget_micro_usd,
                        credit.pool_budgets_micro_usd,
                        Some(resolved.policy.clone()),
                    );
                    org_admission::finish_dynamic_context(
                        state,
                        &mut context,
                        &resolved,
                        &token,
                        credential_use,
                        bound_user_id,
                        team_ids,
                    )?;
                    Ok(context)
                }
                // An `rgw_`-shaped token that does not resolve (invalid / revoked /
                // control plane unreachable) is a HARD 401 — never fall open into
                // anonymous.
                Err(crate::policy::ResolveErr::Busy) => Err(GatewayError::RateLimited),
                Err(crate::policy::ResolveErr::Unresolved) => Err(GatewayError::Unauthorized(
                    "Invalid or revoked gateway token.".to_string(),
                )),
            }
        }
    }
}
