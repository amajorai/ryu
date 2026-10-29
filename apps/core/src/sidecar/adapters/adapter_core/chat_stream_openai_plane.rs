use super::*;

/// Run the turn on an OpenAI-compatible route, through the Gateway when it is healthy.
pub(super) async fn dispatch_openai_compat_plane<F, Fut>(
    plane: TurnPlane<F>,
    run_trace: &mut Option<ryu_tracing::ScopeGuard>,
    base_url: String,
    model: String,
    api_key: Option<String>,
    via_gateway: bool,
) -> Response
where
    F: FnOnce(String, &'static str, Vec<Value>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Option<String>> + Send + 'static,
{
    let TurnPlane {
        req,
        registry,
        agent_store,
        mcp,
        skills,
        traces,
        watch,
        effective_agent_id,
        agent_slots,
        composio_actions,
        skills_allowlist,
        style_prefix,
        long_term_system,
        project_instructions,
        project_rules,
        memory_citations,
        working_memory_tool_withheld,
        provider_access,
        sampling,
        sampling_engine,
        turn_rejection,
        host_conversation_store,
        reply_checkpoint,
        persist,
        ..
    } = plane;
    if via_gateway {
        let gateway_healthy = crate::sidecar::gateway::is_healthy().await;
        if req
            .public_agent_policy
            .as_ref()
            .is_some_and(PublicAgentRunPolicy::has_tool_capabilities)
            && !gateway_healthy
        {
            return turn_rejection
                .reject("Public tool access requires a healthy Gateway connection.".to_owned())
                .await;
        }
        if req.cloud_task_context.is_some() && !gateway_healthy {
            return turn_rejection.reject("Cloud tasks require a healthy Gateway; host and direct-provider fallback are disabled.".to_owned()).await;
        }
        if forward_via_gateway(via_gateway, gateway_healthy) {
            // U18: hand the call to the local ryu-gateway, which owns
            // provider creds and forwards to the engine. Core no longer
            // needs its own provider key here. The gateway URL replaces
            // base_url; the gateway token (not the provider key) is the
            // bearer.
            let gateway_base = crate::sidecar::gateway::gateway_url();
            let gateway_token = match crate::sidecar::gateway::required_gateway_inference_token() {
                Ok(token) => Some(token),
                Err(error) => {
                    return turn_rejection
                        .reject(format!("Gateway inference credential unavailable: {error}"))
                        .await
                }
            };
            // Forward the selected agent id so the gateway can apply
            // per-agent token budgets (U21). Core has no local user concept,
            // so `x-ryu-user-id` is left for cloud/multi-tenant gateways.
            let budget_agent_id = effective_agent_id.clone();
            // For the default/"ryu" agent, attach the registry-configured
            // fallback chain so a gateway transport failure recovers to the
            // local engine instead of surfacing a raw error (AC1–AC4).
            let public_tool_run = req
                .public_agent_policy
                .as_ref()
                .is_some_and(PublicAgentRunPolicy::has_tool_capabilities);
            let fallback_chain = if public_tool_run || req.cloud_task_context.is_some() {
                vec![]
            } else if is_default_agent(effective_agent_id.as_deref()) {
                registry.fallback_chain_for_default()
            } else {
                vec![]
            };
            // Governed chat tool loop (R1 / A2): enabled ONLY on this
            // branch — chat egress is via the healthy gateway, so every
            // tool dispatch is governed through `/v1/exec/tool` (D5). The
            // agent's allowlist narrows which app render tools are offered.
            let tool_allowlist = resolve_agent_tool_allowlist(
                effective_agent_id.as_deref(),
                registry.as_ref(),
                &agent_store,
            )
            .await;
            let tool_allowlist = match req.public_agent_policy.as_ref() {
                Some(policy) => Some(
                    restrict_public_agent_tool_allowlist(mcp.as_ref(), tool_allowlist, policy)
                        .await,
                ),
                None => tool_allowlist,
            };
            let tool_allowlist =
                caller_scoped_tool_allowlist(req.untrusted_caller, mcp.as_ref(), tool_allowlist);
            let tool_allowlist = if req.read_only_tools {
                Some(restrict_read_only_tool_allowlist(mcp.as_ref(), tool_allowlist).await)
            } else {
                tool_allowlist
            };
            let tool_allowlist = if working_memory_tool_withheld {
                Some(withhold_working_memory_tool_allowlist(mcp.as_ref(), tool_allowlist).await)
            } else {
                tool_allowlist
            };
            // Suggestions are discovery for the owner's own tools; an
            // unverified caller gets none, so no hint can widen the turn.
            let capability_suggestions_enabled = !req.untrusted_caller;
            if public_tool_run && tool_allowlist.as_ref().is_some_and(Vec::is_empty) {
                return turn_rejection
                    .reject("No public read-only tools are available for this agent.".to_owned())
                    .await;
            }
            // The governed chat tool loop has no built-in widget producers
            // left (the in-process Ryu Apps provider was removed), so the
            // loop is permanently inert; the generic emit/host machinery
            // stays dormant. Keep the param wired as `false`.
            let chat_tools_enabled = req.cloud_task_context.is_some();
            // Per-agent Plane A override (spec §1): only for an agent that
            // has a stored `SmartRoutingConfig`; injected into the outbound
            // body as `ryu_smart_route` for the gateway to read and strip.
            // Absent → the global smart router (if any) applies as before.
            let smart_route_override = effective_agent_id
                .as_deref()
                .and_then(crate::agent_routing::smart_route_override);
            // The verified caller JWT rides only this gateway hop so a
            // hosted gateway can verify per-user attribution (C3).
            let gateway_user_jwt = req.user_jwt.clone();
            // The plane owns the run trace from here and finishes it at turn end.
            handoff_run_trace(run_trace);
            // The Gateway's tool loop acts for this conversation's owner
            // only when the turn's author is that owner.
            let gateway_host_conversation = gateway_host_conversation_for_turn(
                &host_conversation_store,
                req.conversation_id.as_deref(),
                req.verified_caller.as_ref(),
            )
            .await;
            return route_openai_stream(
                req,
                gateway_base,
                model,
                gateway_token,
                long_term_system,
                memory_citations.clone(),
                project_instructions.clone(),
                project_rules.clone(),
                budget_agent_id,
                persist,
                reply_checkpoint.clone(),
                fallback_chain,
                skills,
                skills_allowlist.clone(),
                style_prefix.clone(),
                composio_actions,
                agent_slots,
                // The gateway strips `ryu_sampling` and re-emits only the
                // samplers the chosen provider accepts (e.g. Anthropic top_k).
                sampling.with_gateway_extensions(),
                sampling_engine,
                Arc::clone(&mcp),
                traces.clone(),
                chat_tools_enabled,
                capability_suggestions_enabled,
                tool_allowlist,
                smart_route_override,
                // This hop targets the gateway, so the node's own routing
                // preferences may ride along (see `node_routing_header`).
                crate::sidecar::gateway::node_routing_header(),
                gateway_user_jwt,
                None,
                StreamHop::Provider,
                gateway_host_conversation,
                watch.clone(),
            )
            .await;
        }
        // Gateway is configured but unreachable — fall through to the
        // direct provider path so chat keeps working in degraded mode.
        tracing::warn!(
            gateway_url = %crate::sidecar::gateway::gateway_url(),
            "ryu-gateway unreachable; falling back to direct provider (degraded mode)"
        );
    }
    // Only Gateway enforces which of the user's providers an agent may
    // use, so a limited agent never takes a provider key around it.
    if !crate::agent_access::direct_provider_permitted(
        provider_access.as_deref(),
        api_key.as_deref(),
    ) {
        return error_stream(DIRECT_PROVIDER_REFUSAL.to_owned());
    }
    // Guard the unconfigured default: public OpenAI endpoint with no key
    // would just 401. Give the operator an actionable message instead.
    // Compare against the registry's last-resort literal so a file- or
    // env-configured alternative is never blocked.
    if is_default_agent(effective_agent_id.as_deref())
        && base_url == crate::registry::DEFAULT_LLM_BASE_URL
        && api_key.is_none()
    {
        return turn_rejection
            .reject(
                "Default LLM is not configured. Set RYU_DEFAULT_LLM_API_KEY (or OPENAI_API_KEY), \
                 or point RYU_DEFAULT_LLM_BASE_URL at a local OpenAI-compatible provider."
                    .to_owned(),
            )
            .await;
    }
    // Direct-to-provider (registry agent or degraded-mode fallback):
    // no gateway budget scoping.
    // Also carry the fallback chain when this is the default agent on the
    // degraded-mode path (gateway down → direct provider) so recovery
    // still applies.
    let mut fallback_chain = if is_default_agent(effective_agent_id.as_deref()) {
        registry.fallback_chain_for_default()
    } else {
        vec![]
    };
    // A limited agent's direct fallback may only reach keyless endpoints.
    fallback_chain.retain(|fallback| {
        crate::agent_access::direct_provider_permitted(
            provider_access.as_deref(),
            fallback.api_key.as_deref(),
        )
    });
    // Direct-to-provider (registry agent or degraded gateway-down mode):
    // no gateway to govern tool dispatch, so the chat tool loop is OFF
    // (no ungoverned dispatch path — D5).
    // The plane owns the run trace from here and finishes it at turn end.
    handoff_run_trace(run_trace);
    route_openai_stream(
        req,
        base_url,
        model,
        api_key,
        long_term_system,
        memory_citations.clone(),
        project_instructions.clone(),
        project_rules.clone(),
        None,
        persist,
        reply_checkpoint.clone(),
        fallback_chain,
        skills,
        skills_allowlist.clone(),
        style_prefix.clone(),
        Vec::new(),
        agent_slots,
        sampling.clone(),
        sampling_engine,
        Arc::clone(&mcp),
        traces.clone(),
        false,
        false,
        None,
        // Direct-to-provider (no gateway hop) → never inject the
        // gateway-only `ryu_smart_route` field.
        None,
        // …and no gateway on this hop → no `x-ryu-node-routing` either.
        None,
        // …nor the caller's JWT.
        None,
        None,
        StreamHop::Provider,
        // No Gateway on this hop → no host conversation to relay.
        None,
        watch.clone(),
    )
    .await
}
