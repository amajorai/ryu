use super::*;

/// The concrete route a turn dispatches on, with the agent's account limits.
pub(super) struct TurnRoute {
    pub(super) provider_access: Option<Vec<String>>,
    pub(super) account_confinement: crate::agent_access::AccountConfinement,
    pub(super) route: AgentRoute,
}

/// Resolve the agent's route and refuse routes this turn's caller or context may not use.
pub(super) async fn resolve_turn_route(
    req: &mut ChatStreamRequest,
    binding: &TurnBinding,
    registry: &Arc<AcpAgentRegistry>,
    provider_reg: &ProviderRegistry,
    agent_store: &AgentStore,
) -> Result<TurnRoute, Response> {
    let TurnBinding {
        effective_agent_id,
        engine,
        model,
        ..
    } = binding;
    // The agent's model provider access, read from its current record. It is
    // signed into ACP bearers here and checked again before any direct hop.
    let provider_access = match effective_agent_id.as_deref() {
        Some(id) => crate::agent_access::provider_access_for_agent(agent_store, id).await,
        None => None,
    };

    // Per-agent ACP session defaults (`acp-agent-settings`), resolved against
    // the final agent after routing policy: keep the model pick inside the
    // agent's allowlist and fill a mode/model/config option the turn left unset.
    if let Some(settings) = effective_agent_id.as_deref().and_then(|id| {
        acp_agent_settings_for(id, engine.as_deref(), registry, provider_access.as_deref())
    }) {
        apply_acp_session_defaults(req, &settings, model.is_none());
    }
    // What the OS sandbox hides from the agent's engine because of its account
    // access, applied whatever the folder's trust.
    let account_confinement = match effective_agent_id.as_deref() {
        Some(id) => crate::agent_access::account_confinement_for_agent(agent_store, id).await,
        None => crate::agent_access::AccountConfinement::None,
    };
    let mut route = if req.cloud_task_context.is_some() {
        default_agent_route(provider_reg)
    } else {
        match agent_route_with_user_jwt(
            effective_agent_id.as_deref(),
            engine.as_deref(),
            model.as_deref(),
            registry,
            provider_reg,
            req.user_jwt.as_deref(),
            req.composio_connection_scope.as_deref(),
            req.profile_conversation_scope.as_deref(),
            req.conversation_id.as_deref(),
            provider_access.as_deref(),
        ) {
            Some(r) => r,
            None => {
                let msg = match effective_agent_id.as_deref() {
                    None => "No agent selected. Please pick an agent.".to_owned(),
                    // The agent exists (its record set this limit), so the route
                    // builders refused it. Name the engine's own reason when it
                    // calls its provider itself; otherwise (Ryu's engine, or a
                    // Gateway Core does not manage) a limited agent runs only
                    // through the Core-managed Gateway with Gateway routing on.
                    Some(id) if provider_access.is_some() => {
                        match limited_route_refusal(
                            id,
                            engine.as_deref().unwrap_or(id),
                            registry,
                            provider_access.as_deref(),
                        ) {
                            Some(reason) => format!("Ryu could not start {id}: {reason}"),
                            None => format!(
                                "Ryu could not start {id}: its account access limits which model providers it may use, and that is only enforced when its models go through Ryu's own Gateway. Turn on Gateway routing (and use the Gateway Ryu manages), or change the agent's account access."
                            ),
                        }
                    }
                    Some(id) => format!("Unknown agent: {id}"),
                };
                return Err(error_stream(msg));
            }
        }
    };
    if req.cloud_task_context.is_some() {
        if !cloud_agent_supported(effective_agent_id.as_deref()) {
            return Err(error_stream(
                "This agent transport cannot execute in an isolated cloud environment. Select Ryu."
                    .to_owned(),
            ));
        }
        if let AgentRoute::OpenAiCompat {
            model: routed_model,
            ..
        } = &mut route
        {
            if let Some(selected_model) = model.as_ref().filter(|value| !value.is_empty()) {
                *routed_model = selected_model.clone();
            }
        }
    }
    if !public_agent_route_supported(&route, req.public_agent_policy.as_ref()) {
        return Err(error_stream(
            "Public execution is unavailable for this agent runtime.".to_owned(),
        ));
    }
    if req.read_only_tools && !read_only_route_supported(&route) {
        return Err(error_stream(
            "This app may start only read-only agents, and this agent runtime runs its own tools. \
             Declare the `hook:run-agent:write` grant to run it, or pick a Ryu-governed agent."
                .to_owned(),
        ));
    }
    // An agent runtime with its own tool loop cannot be narrowed per turn, so an
    // unverified caller is answered on the default model route instead, the same
    // substitution a cloud task makes. The agent's persona is already in the
    // system block, so the caller still hears the configured assistant.
    if req.untrusted_caller && !untrusted_caller_route_supported(&route) {
        tracing::info!(
            agent = ?effective_agent_id,
            "unverified caller turn moved to the default model route: the agent runtime runs its own tools"
        );
        route = default_agent_route(provider_reg);
    }
    Ok(TurnRoute {
        provider_access,
        account_confinement,
        route,
    })
}

/// Resolve advanced sampling (agent, engine, model, request) and the engine that translates it.
pub(super) async fn resolve_turn_sampling(
    req: &ChatStreamRequest,
    route: &AgentRoute,
    model: &Option<String>,
    effective_agent_id: &Option<String>,
    agent_store: &AgentStore,
) -> (crate::inference::SamplingConfig, crate::inference::Engine) {
    // Resolve advanced sampling: legacy agent values are the base, engine-wide
    // configuration comes next, the node's per-model settings (local or cloud)
    // override those, and an explicit per-request override wins last. The engine
    // governs field-name translation and the remote-OpenAI safety gate: only a
    // LocalEngine route gets the non-standard sampler fields (top_k/min_p/…);
    // every other route is treated as Engine::Other so a remote OpenAI endpoint
    // never 400s on an unknown field. Cloud samplers reach the gateway separately
    // through `SamplingConfig::with_gateway_extensions`.
    let (engine_defaults, model_defaults) =
        match crate::server::preferences::PreferencesStore::open_default() {
            Ok(preferences) => {
                let engine_defaults = match route {
                    AgentRoute::LocalEngine { engine, .. } => {
                        preferences.get_engine_sampling_config(engine).await
                    }
                    _ => crate::inference::SamplingConfig::default(),
                };
                let model_defaults =
                    model_sampling_defaults(&preferences, route, model.as_deref()).await;
                (engine_defaults, model_defaults)
            }
            Err(error) => {
                tracing::warn!(%error, "could not read sampling defaults");
                Default::default()
            }
        };
    let mut sampling = {
        let agent_defaults = match effective_agent_id.as_deref() {
            Some(id) => agent_store
                .get(id)
                .await
                .ok()
                .flatten()
                .and_then(|r| r.inference)
                .unwrap_or_default(),
            None => crate::inference::SamplingConfig::default(),
        };
        agent_defaults
            .merge(&engine_defaults)
            .merge(&model_defaults)
            .merge(&req.inference.clone().unwrap_or_default())
    };
    if let Some(cap) = req.max_tokens_cap {
        apply_max_tokens_cap(&mut sampling, cap);
    }
    let sampling_engine = match route {
        AgentRoute::LocalEngine { engine, .. } => crate::inference::Engine::from_name(engine),
        _ => crate::inference::Engine::Other,
    };
    (sampling, sampling_engine)
}
