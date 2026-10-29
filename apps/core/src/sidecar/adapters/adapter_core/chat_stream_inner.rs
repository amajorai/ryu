use super::*;

pub(crate) async fn route_chat_stream_inner(
    mut req: ChatStreamRequest,
    registry: Arc<AcpAgentRegistry>,
    conversations: ConversationStore,
    agent_store: AgentStore,
    manager: Arc<SidecarManager>,
    memory: MemoryStore,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    skills: SkillRegistry,
    traces: TraceStore,
    recall: Option<AutoRecallConfig>,
    // App-level context-window management (opt-in / off by default). `None`
    // means full history is sent and the engine handles overflow. When set, the
    // OpenAI-compat path trims `req.messages` to the token budget and the ACP
    // path replaces its fixed last-10 replay with a budgeted window — both
    // always keeping the system block, optionally summarizing dropped turns.
    ctx_window: Option<context_window::ContextWindowConfig>,
    // How this turn ended, reported back to a caller that may retry it on
    // another subscription plan (`routing_policy::reactive`). Disarmed by
    // default — `TurnWatch::off()` allocates nothing and every method is a
    // no-op, so only the failover wrapper pays for this.
    watch: crate::routing_policy::reactive::TurnWatch,
    subscription_costs: Option<crate::server::subscription_costs::SubscriptionCostStore>,
) -> Response {
    if let Err(response) = admit_chat_turn(&mut req, &conversations).await {
        return response;
    }
    let TurnAgentStart {
        user_text,
        durable_conversation,
        widget_provenance,
        provider_reg,
        mut effective_agent_id,
    } = resolve_turn_agent(&req, &conversations).await;
    let scope = apply_scope_defaults(
        &mut req,
        &conversations,
        durable_conversation,
        &mut effective_agent_id,
    )
    .await;
    let mut binding =
        resolve_turn_binding(&mut req, &agent_store, effective_agent_id, &scope).await;
    select_plugin_model(&mut req, &mut binding, durable_conversation).await;
    apply_pending_agent_control(
        &mut req,
        &mut binding,
        &conversations,
        &agent_store,
        durable_conversation,
    )
    .await;
    let agent_instructions = match enforce_turn_gates(&mut req, &mut binding, &agent_store).await {
        Ok(agent_instructions) => agent_instructions,
        Err(response) => return response,
    };
    let persisted_user_message_id =
        persist_user_turn(&req, &conversations, &user_text, &widget_provenance).await;
    let (persona_prefix, style_prefix) =
        resolve_turn_style(&req, &binding.persona, &agent_instructions);
    let TurnMemory {
        memory_policy,
        memory_principal_available,
        memory_owner,
        memory_context_enabled,
        auto_recall_allowed,
        recall,
        mut memory_citations,
        recency_ids,
        mut query_context,
        session_memory,
    } = load_turn_memory(
        &req,
        &memory,
        recall,
        &binding.effective_agent_id,
        &scope.memory_project_id,
        &user_text,
    )
    .await;
    let TurnSystem {
        mut breakdown,
        mut long_term_system,
        project_instructions,
        project_rules,
        recency_fact_ids,
    } = assemble_turn_system(
        &req,
        &conversations,
        &session_memory,
        &query_context,
        persona_prefix,
        &agent_instructions,
        &style_prefix,
        &scope.turn_project_id,
        &binding.effective_agent_id,
        scope.turn_is_feed_main_thread,
        memory_principal_available,
        memory_context_enabled,
        auto_recall_allowed,
        recency_ids,
    )
    .await;
    // Hierarchical run trace: one `agent_run` root per turn. Spans opened later
    // for this conversation (retrieval, model and tool calls) nest under it.
    // Until a plane takes the turn over, the guard ends the run as failed on
    // any early return; each plane finishes it through `run_finisher`.
    let mut run_trace = begin_run_trace(
        &traces,
        req.conversation_id.as_deref(),
        binding.effective_agent_id.as_deref(),
    )
    .await;
    run_turn_auto_recall(
        &recall,
        &traces,
        &req,
        &user_text,
        &conversations,
        &memory,
        &scope.memory_project_id,
        &recency_fact_ids,
        &mut breakdown,
        &mut memory_citations,
        &mut query_context,
    )
    .await;
    let memory_citations = dedupe_memory_citations(memory_citations);
    let (working_memory_tool_withheld, turn_context) = assemble_turn_context(
        &req,
        &conversations,
        &memory,
        &agent_store,
        &binding.effective_agent_id,
        memory_principal_available,
        &memory_owner,
        &mut breakdown,
        &mut query_context,
        session_memory,
    )
    .await;
    record_turn_memory(
        &req,
        &memory,
        &traces,
        &memory_policy,
        memory_principal_available,
        &memory_owner,
        &binding.effective_agent_id,
        &scope.memory_project_id,
        &user_text,
    )
    .await;
    let TurnRoute {
        provider_access,
        account_confinement,
        route,
    } = match resolve_turn_route(&mut req, &binding, &registry, &provider_reg, &agent_store).await {
        Ok(turn_route) => turn_route,
        Err(response) => return response,
    };
    let (sampling, sampling_engine) = resolve_turn_sampling(
        &req,
        &route,
        &binding.model,
        &binding.effective_agent_id,
        &agent_store,
    )
    .await;
    let short_term = replay_acp_short_term(
        &mut req,
        &route,
        &ctx_window,
        &long_term_system,
        &turn_context,
        &conversations,
    )
    .await;
    fit_openai_history(
        &mut req,
        &route,
        &ctx_window,
        &mut long_term_system,
        &turn_context,
        &mut breakdown,
        &skills,
        &binding.skills_allowlist,
        &style_prefix,
        durable_conversation,
    )
    .await;

    // Resolve the effective working directory for ACP. If the request carries a
    // `cwd` and worktree isolation is requested, allocate a per-run git worktree
    // from the repo root so the agent never mutates the user's main checkout.
    // The guard is returned even on the non-isolation path to carry the resolved
    // path; for that path `guard` is `None` and we pass `effective_cwd` directly.
    // Every plane reads it from the request: see `ChatStreamRequest::turn_context`.
    req.turn_context = turn_context;
    req.turn_query_context = query_context;

    let requested_environment = request_environment_variables(&req);
    let (worktree_reused, effective_cwd, worktree_guard) =
        match allocate_turn_worktree(&req, &route, &worktree_diffs, &requested_environment).await {
            Ok(worktree) => worktree,
            Err(response) => return response,
        };
    let turn_rejection =
        mark_turn_running(&req, &conversations, durable_conversation, &worktree_guard).await;
    checkpoint_turn_workspace(
        &req,
        &conversations,
        persisted_user_message_id,
        &worktree_guard,
    )
    .await;

    // When `persist` is false (team member sub-requests), force the assistant
    // persist target to None so the per-member reply is not written — the team
    // orchestrator persists one combined assistant turn itself.
    let conversation_id_for_persist = if req.persist {
        req.conversation_id.clone()
    } else {
        None
    };
    // Use effective_agent_id so the persisted assistant message is attributed to
    // the agent that actually handled the turn (target_agent_id if set, else primary).
    let persist_agent_id = binding.effective_agent_id.clone();
    // The ACP path uses incremental persistence (store + metadata passed
    // directly); non-ACP paths still use the FnOnce closure.
    let persist_store_for_acp = conversations.clone();
    // Read on the Gateway hop to decide whether the turn's author owns the
    // conversation the Gateway's tool loop would act for.
    let host_conversation_store = conversations.clone();
    let memory_citations_for_persist = memory_citations.clone();
    // Shared by the OpenAI-compatible stream (which checkpoints into it) and the
    // terminal persist (which finishes the checkpointed row). Routes that never
    // observe it (A2A) keep their single terminal append.
    let reply_checkpoint = conversation_id_for_persist.clone().map(|conv_id| {
        ReplyCheckpoint::new(conversations.clone(), conv_id, persist_agent_id.clone())
    });
    let persist = {
        let conv_id = conversation_id_for_persist.clone();
        let agent_id = persist_agent_id.clone();
        let checkpoint = reply_checkpoint.clone();
        move |reply: String, outcome: &'static str, data_parts: Vec<Value>| {
            persist_assistant_reply(
                conversations.clone(),
                conv_id,
                agent_id,
                reply,
                outcome,
                memory_citations_for_persist.clone(),
                checkpoint,
                data_parts,
            )
        }
    };

    let plane = TurnPlane {
        req,
        registry,
        agent_store,
        manager,
        worktree_diffs,
        mcp,
        skills,
        traces,
        watch,
        subscription_costs,
        provider_reg,
        durable_conversation,
        effective_agent_id: binding.effective_agent_id,
        agent_slots: binding.agent_slots,
        composio_actions: binding.composio_actions,
        skills_allowlist: binding.skills_allowlist,
        identity_profile_ids: binding.identity_profile_ids,
        style_prefix,
        breakdown,
        long_term_system,
        project_instructions,
        project_rules,
        memory_citations,
        working_memory_tool_withheld,
        provider_access,
        account_confinement,
        sampling,
        sampling_engine,
        short_term,
        requested_environment,
        worktree_reused,
        effective_cwd,
        worktree_guard,
        turn_rejection,
        conversation_id_for_persist,
        persist_agent_id,
        persist_store_for_acp,
        host_conversation_store,
        reply_checkpoint,
        persist,
    };
    match route {
        AgentRoute::A2a { peer_id } => dispatch_a2a_plane(plane, peer_id).await,
        AgentRoute::OpenAiCompat {
            base_url,
            model,
            api_key,
            via_gateway,
        } => {
            dispatch_openai_compat_plane(
                plane,
                &mut run_trace,
                base_url,
                model,
                api_key,
                via_gateway,
            )
            .await
        }
        AgentRoute::LocalEngine {
            engine,
            base_url,
            model,
        } => dispatch_local_engine_plane(plane, &mut run_trace, engine, base_url, model).await,
        AgentRoute::Acp { spawn_cmd } => dispatch_acp_plane(plane, &mut run_trace, spawn_cmd).await,
        AgentRoute::SdkApp { base_url, model } => {
            dispatch_sdk_app_plane(plane, &mut run_trace, base_url, model).await
        }
    }
}
