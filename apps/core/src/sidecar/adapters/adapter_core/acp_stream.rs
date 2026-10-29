use super::*;

pub(crate) async fn route_acp_stream(
    req: ChatStreamRequest,
    // The turn's user message with any attached documents folded in; the
    // caller has already refused an empty one.
    user_message: String,
    spawn_cmd: String,
    cwd: PathBuf,
    // Ownership of the worktree guard transfers to the detached completion
    // task so cleanup (and diff capture) runs on ACP session end regardless
    // of whether the SSE consumer is still connected.
    worktree_guard: Option<WorktreeGuard>,
    project_environment: Vec<(String, String)>,
    short_term: Option<String>,
    long_term_system: Option<String>,
    memory_citations: Vec<MemoryCitation>,
    // The exact AGENTS.md / CLAUDE.md block assembled for this turn.
    project_instructions: Option<String>,
    // Normalized Cursor/Claude/AGENTS rule records for context plugins.
    project_rules: Option<Vec<Value>>,
    // Incremental persistence: the store + metadata replace the old FnOnce
    // persist closure so the detached task can write partial replies that
    // survive a client disconnect.
    persist_store: ConversationStore,
    persist_conversation_id: Option<String>,
    persist_agent_id: Option<String>,
    // The conversation id used as the key in `worktree_diffs`. `None` when the
    // caller did not send a conversation id (diff will not be stored).
    conversation_id: Option<String>,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    allowlist: Option<Vec<String>>,
    skills_allowlist: Vec<String>,
    // Per-agent Composio action slugs + effective agent id, threaded into the MCP
    // bridge so Composio reaches the ACP plane and PTC execution is scoped (#477).
    composio_actions: Vec<String>,
    bridge_agent_id: String,
    // Per-agent bound Identity Vault profiles (epic #517), threaded into the MCP
    // bridge so a tool call targeting a NEEDS_AUTH bound domain elicits and an
    // AUTHENTICATED one reads the credential under the gateway grant. Empty = none.
    identity_profile_ids: Vec<String>,
    traces: TraceStore,
    // How this turn ended, for the reactive failover wrapper. A vendor cap
    // arrives here as an ordinary `AcpEvent::Error`, so this is the plane the
    // whole feature exists for.
    watch: crate::routing_policy::reactive::TurnWatch,
    subscription_costs: Option<crate::server::subscription_costs::SubscriptionCostStore>,
    sdk_turn_selection: Option<SdkTurnSelection>,
    account_confinement: crate::agent_access::AccountConfinement,
) -> Response {
    // The composer's plan-mode pill, materialized into the message. Applied here,
    // above BOTH consumers, because the same string is sent two ways: as the tail
    // of the composed prompt on a session's first turn, and raw as the turn delta
    // on every later one.
    let user_message = apply_plan_mode_sentinel(user_message, req.acp_config.as_ref());

    let AcpHistorySetup {
        agent_id,
        managed_pi_history,
        history_turn,
    } = acp_history_setup(&req, &spawn_cmd, &sdk_turn_selection, &conversation_id);
    let cost_attribution = acp_cost_attribution(
        &req,
        subscription_costs,
        managed_pi_history,
        &sdk_turn_selection,
    );
    let AcpPromptTexts {
        watch_model,
        compaction_summary,
        delta_prompt,
        prompt,
        images,
    } = acp_prompt_texts(
        &req,
        &user_message,
        short_term,
        long_term_system,
        &mcp,
        &allowlist,
        &skills_allowlist,
    )
    .await;
    acp_apply_ryu_model_pick(&req, &agent_id, &sdk_turn_selection);
    let turn = acp_turn_config(&req);
    let AcpHookedPrompts {
        prompt,
        delta_prompt,
        fresh_session,
    } = acp_context_hook_phase(
        &req,
        prompt,
        delta_prompt,
        &project_instructions,
        &project_rules,
    )
    .await;
    let AcpSessionScope {
        additional_directories,
        tool_authority,
    } = acp_session_scope(
        &req,
        &cwd,
        &spawn_cmd,
        &agent_id,
        &persist_store,
        &conversation_id,
        &allowlist,
        &composio_actions,
        &identity_profile_ids,
    )
    .await;

    let conversation_generation = req.acp_conversation_generation.clone().flatten();
    let acp_rx = acp::spawn_acp_task(
        spawn_cmd,
        prompt,
        // New user message plus this turn's query context (no preamble/history) —
        // sent as the turn delta on every turn after a reused session's first, so
        // history is not re-sent.
        delta_prompt,
        fresh_session,
        images,
        cwd.clone(),
        additional_directories,
        project_environment,
        Some(mcp),
        allowlist,
        composio_actions,
        bridge_agent_id,
        sdk_turn_selection
            .as_ref()
            .map(|captured| captured.account.process_identity())
            .or_else(|| {
                cost_attribution.as_ref().map(|attribution| {
                    acp::managed_pi_session_identity(
                        &attribution.provider_id,
                        Some(&attribution.account_id),
                    )
                })
            }),
        identity_profile_ids,
        req.composio_connection_scope.clone(),
        req.profile_conversation_scope.clone(),
        tool_authority,
        turn,
        conversation_id.clone(),
        conversation_generation.clone(),
        req.public_agent_policy.is_some(),
        account_confinement,
    );

    // UI frame channel — the SSE generator is the sole consumer.  The
    // completion task pushes pre-rendered frames here; a dropped receiver
    // (client disconnect) is ignored via `let _ = ui_tx.send(…)` so the
    // completion task continues to run and finishes persistence/cleanup.
    let (ui_tx, mut ui_rx) = tokio::sync::mpsc::unbounded_channel::<UiFrame>();

    // Live turn: publish every frame keyed by conversation id so a reconnecting
    // client can replay this still-running turn via `/api/chat/stream/resume/:id`.
    // Skipped inside `live_turn::durable_turn`, which already publishes the same
    // frames as it drives this response. Dropping the handle unregisters it.
    let live_stream = persist_conversation_id
        .as_deref()
        .filter(|cid| !live_turn::in_durable_scope(cid))
        .map(|cid| live_turn::register(cid, false));

    // Detached completion task — owns the worktree guard, persist closure,
    // and diff store reference.  Runs to completion even when the SSE client
    // disconnects.  Frame sequence on the happy path is unchanged:
    //   start → text-start/delta/end (interleaved with tool frames) → finish → [DONE]
    let ui_tx_clone = ui_tx;
    // Per-request plugin flags, copied out of `req` before the spawn: the detached
    // task outlives this function, and a `message_end` hook reads its own composer
    // flag to decide whether to act this turn.
    let plugin_flags = req.plugin_flags.clone();
    let agent_control_applied = req.agent_control_applied.clone();
    let harness_session_id = req.session_id.clone();
    tokio::spawn(run_acp_completion(AcpCompletionCtx {
        worktree_guard,
        conversation_id,
        traces,
        live_stream,
        ui_tx: ui_tx_clone,
        agent_id,
        memory_citations,
        agent_control_applied,
        compaction_summary,
        acp_rx,
        persist_store,
        persist_conversation_id,
        persist_agent_id,
        watch,
        watch_model,
        history_turn,
        conversation_generation,
        cwd,
        harness_session_id,
        cost_attribution,
        plugin_flags,
        worktree_diffs,
    }));

    // SSE generator — forwards pre-rendered frames from the completion task.
    // Dropping this (client disconnect) does not affect the completion task.
    let transformed = async_stream::stream! {
        while let Some(frame) = ui_rx.recv().await {
            yield Ok::<_, std::convert::Infallible>(frame);
        }
    };

    sse_response(Body::from_stream(transformed))
}
