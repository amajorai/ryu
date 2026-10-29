use super::*;

/// Everything a dispatch plane takes over once the turn's route is settled.
pub(super) struct TurnPlane<F> {
    pub(super) req: ChatStreamRequest,
    pub(super) registry: Arc<AcpAgentRegistry>,
    pub(super) agent_store: AgentStore,
    pub(super) manager: Arc<SidecarManager>,
    pub(super) worktree_diffs: crate::server::WorktreeDiffStore,
    pub(super) mcp: Arc<McpRegistry>,
    pub(super) skills: SkillRegistry,
    pub(super) traces: TraceStore,
    pub(super) watch: crate::routing_policy::reactive::TurnWatch,
    pub(super) subscription_costs: Option<crate::server::subscription_costs::SubscriptionCostStore>,
    pub(super) provider_reg: ProviderRegistry,
    pub(super) durable_conversation: bool,
    pub(super) effective_agent_id: Option<String>,
    pub(super) agent_slots: AgentSlots,
    pub(super) composio_actions: Vec<String>,
    pub(super) skills_allowlist: Vec<String>,
    pub(super) identity_profile_ids: Vec<String>,
    pub(super) style_prefix: Option<String>,
    pub(super) breakdown: context_breakdown::BreakdownBuilder,
    pub(super) long_term_system: Option<String>,
    pub(super) project_instructions: Option<String>,
    pub(super) project_rules: Option<Vec<Value>>,
    pub(super) memory_citations: Vec<MemoryCitation>,
    pub(super) working_memory_tool_withheld: bool,
    pub(super) provider_access: Option<Vec<String>>,
    pub(super) account_confinement: crate::agent_access::AccountConfinement,
    pub(super) sampling: crate::inference::SamplingConfig,
    pub(super) sampling_engine: crate::inference::Engine,
    pub(super) short_term: Option<String>,
    pub(super) requested_environment: Vec<(String, String)>,
    pub(super) worktree_reused: bool,
    pub(super) effective_cwd: PathBuf,
    pub(super) worktree_guard: Option<WorktreeGuard>,
    pub(super) turn_rejection: TurnRejection,
    pub(super) conversation_id_for_persist: Option<String>,
    pub(super) persist_agent_id: Option<String>,
    pub(super) persist_store_for_acp: ConversationStore,
    pub(super) host_conversation_store: ConversationStore,
    pub(super) reply_checkpoint: Option<ReplyCheckpoint>,
    pub(super) persist: F,
}

/// Hand the turn to an A2A peer.
pub(super) async fn dispatch_a2a_plane<F, Fut>(plane: TurnPlane<F>, peer_id: String) -> Response
where
    F: FnOnce(String, &'static str, Vec<Value>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Option<String>> + Send + 'static,
{
    let TurnPlane {
        req,
        watch,
        persist,
        ..
    } = plane;
    let persist_without_message_id = move |reply, outcome| async move {
        let _ = persist(reply, outcome, Vec::new()).await;
    };
    crate::a2a::route_peer_chat(req, peer_id, persist_without_message_id, watch).await
}

/// Run the turn on the bound local engine, made resident first.
pub(super) async fn dispatch_local_engine_plane<F, Fut>(
    plane: TurnPlane<F>,
    run_trace: &mut Option<ryu_tracing::ScopeGuard>,
    engine: String,
    base_url: String,
    model: Option<String>,
) -> Response
where
    F: FnOnce(String, &'static str, Vec<Value>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Option<String>> + Send + 'static,
{
    let TurnPlane {
        req,
        manager,
        mcp,
        skills,
        traces,
        watch,
        skills_allowlist,
        style_prefix,
        long_term_system,
        project_instructions,
        project_rules,
        memory_citations,
        sampling,
        sampling_engine,
        turn_rejection,
        reply_checkpoint,
        persist,
        ..
    } = plane;
    // Make the bound engine the single resident local engine. Idempotent
    // if already active; performs a stop-then-start swap otherwise (U4).
    tracing::info!(engine = %engine, "route_chat_stream: ensuring local engine is resident");
    if let Err(e) = manager.set_active_local_engine(&engine).await {
        return turn_rejection
            .reject(format!("Could not activate local engine '{engine}': {e}"))
            .await;
    }
    let model = resolve_local_engine_model(&engine, model).await;
    // Local engines have no provider key; persist the reply on completion.
    // No fallback chain for local-engine routes — they are the fallback.
    // Local engines go direct; slot overrides are gateway-only so we pass
    // an empty default here.
    // Local engines go direct (no gateway hop), so the governed chat tool
    // loop is OFF here — dispatch must be gateway-governed (D5). A local
    // model served THROUGH the gateway takes the OpenAiCompat branch above.
    let native_turn_control = if engine == "llamacpp" {
        turn_control::NativeTurnControl::new(
            req.conversation_id.as_deref(),
            base_url.clone(),
            model.clone(),
            sampling
                .extra
                .get("reasoning_effort")
                .and_then(Value::as_str)
                .map(str::to_owned),
        )
    } else {
        None
    };
    // The plane owns the run trace from here and finishes it at turn end.
    handoff_run_trace(run_trace);
    route_openai_stream(
        req,
        base_url,
        model,
        None,
        long_term_system,
        memory_citations.clone(),
        project_instructions.clone(),
        project_rules.clone(),
        None,
        persist,
        reply_checkpoint.clone(),
        vec![],
        skills,
        skills_allowlist.clone(),
        style_prefix.clone(),
        Vec::new(),
        AgentSlots::default(),
        sampling.clone(),
        sampling_engine,
        Arc::clone(&mcp),
        traces.clone(),
        false,
        false,
        None,
        // Local engine goes direct (no gateway hop) → no `ryu_smart_route`.
        None,
        // …and no gateway on this hop → no `x-ryu-node-routing` either.
        None,
        // …nor the caller's JWT.
        None,
        native_turn_control,
        StreamHop::Local,
        // No Gateway on this hop → no host conversation to relay.
        None,
        watch.clone(),
    )
    .await
}

/// Run the turn on an SDK app's loopback endpoint.
pub(super) async fn dispatch_sdk_app_plane<F, Fut>(
    plane: TurnPlane<F>,
    run_trace: &mut Option<ryu_tracing::ScopeGuard>,
    base_url: String,
    model: String,
) -> Response
where
    F: FnOnce(String, &'static str, Vec<Value>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Option<String>> + Send + 'static,
{
    let TurnPlane {
        req,
        mcp,
        skills,
        traces,
        watch,
        skills_allowlist,
        style_prefix,
        long_term_system,
        project_instructions,
        project_rules,
        memory_citations,
        sampling,
        sampling_engine,
        reply_checkpoint,
        persist,
        ..
    } = plane;
    // SDK apps are not swappable local engines (no exclusive GPU slot),
    // so we do not call set_active_local_engine. Core routes the chat
    // request directly to the loopback endpoint the SDK process serves.
    // The SDK process's model calls flow through the gateway via env-
    // injection applied at spawn time (sdk::sdk_app_spawn_parts).
    tracing::info!(
        agent_id = ?req.agent_id,
        url = %base_url,
        "route_chat_stream: routing to SDK app loopback"
    );
    // No fallback chain and no gateway on this hop — the SDK app owns its
    // own provider routing (via injected OPENAI_BASE_URL).
    // The SDK app owns its own provider routing (injected OPENAI_BASE_URL);
    // no gateway on this hop, so the governed chat tool loop is OFF (D5).
    // The plane owns the run trace from here and finishes it at turn end.
    handoff_run_trace(run_trace);
    route_openai_stream(
        req,
        base_url,
        model,
        None,
        long_term_system,
        memory_citations.clone(),
        project_instructions,
        project_rules,
        None,
        persist,
        reply_checkpoint.clone(),
        vec![],
        skills,
        skills_allowlist,
        style_prefix.clone(),
        Vec::new(),
        AgentSlots::default(),
        sampling,
        sampling_engine,
        Arc::clone(&mcp),
        traces.clone(),
        false,
        false,
        None,
        // SDK app owns its own provider routing (injected OPENAI_BASE_URL);
        // no gateway on this hop → no `ryu_smart_route`.
        None,
        // …and no gateway on this hop → no `x-ryu-node-routing` either.
        None,
        // …nor the caller's JWT.
        None,
        None,
        StreamHop::Local,
        // No Gateway on this hop → no host conversation to relay.
        None,
        watch.clone(),
    )
    .await
}
