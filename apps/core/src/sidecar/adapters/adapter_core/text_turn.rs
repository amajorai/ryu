use super::*;

/// Shared core for non-streaming single-turn agent invocations.
///
/// Builds a minimal [`ChatStreamRequest`] carrying `text` as one user message,
/// the `conversation_id` for history, and the `agent_id` binding, routes it
/// through the full [`route_chat_stream`] path, and drains the SSE stream to the
/// final assistant text. `persist` decides whether the turn is written to the
/// conversation store: the channel path ([`run_reply_text`]) persists; internal
/// callers (the workflow `AgentRunner`) do not, so they leave no orphan history.
///
/// Turn-boundary plugin hooks are deliberately NOT fired here, and must not be
/// added: this is the shared core, and its callers are not all the same kind of
/// turn. A caller that IS a user opening a turn opts in at its own entry
/// ([`run_reply_text`] does). Firing here instead would give a `post_assistant_turn`
/// hook a `continue` loop around every workflow step and every delegated sub-agent
/// — turns whose caller already owns the "what runs next" decision — and a
/// `pre_user_turn` rewrite of prompts no user ever wrote. The message-plane and
/// tool hooks still fire for these turns inside [`route_chat_stream`], so nothing
/// here escapes a plugin's context engineering or its tool-result redaction.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_text_turn(
    conversation_id: String,
    agent_id: Option<String>,
    text: String,
    author_name: Option<String>,
    persist: bool,
    // `model` pins the model for this turn only, as the composer's picker does;
    // `None` runs the agent on its configured model.
    model: Option<String>,
    // Optional hard ceiling for generated output, applied stricter than the
    // agent's stored inference defaults.
    max_tokens_cap: Option<u32>,
    registry: Arc<AcpAgentRegistry>,
    conversations: ConversationStore,
    agent_store: AgentStore,
    manager: Arc<SidecarManager>,
    memory: MemoryStore,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    skills: SkillRegistry,
    traces: TraceStore,
    composio_connection_scope: Option<Vec<ComposioConnectionBinding>>,
    referenced_conversation_ids: Vec<String>,
) -> anyhow::Result<String> {
    run_text_turn_with_metadata(
        conversation_id,
        agent_id,
        text,
        author_name,
        persist,
        model,
        max_tokens_cap,
        registry,
        conversations,
        agent_store,
        manager,
        memory,
        worktree_diffs,
        mcp,
        skills,
        traces,
        composio_connection_scope,
        referenced_conversation_ids,
    )
    .await
    .map(|result| result.reply)
}

/// Metadata-preserving sibling used by channel delivery. The public
/// text-only primitive above stays source-compatible for workflow and hardware
/// callers, while this path carries the exact assistant row id created during
/// persistence.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_text_turn_with_metadata(
    conversation_id: String,
    agent_id: Option<String>,
    text: String,
    author_name: Option<String>,
    persist: bool,
    model: Option<String>,
    max_tokens_cap: Option<u32>,
    registry: Arc<AcpAgentRegistry>,
    conversations: ConversationStore,
    agent_store: AgentStore,
    manager: Arc<SidecarManager>,
    memory: MemoryStore,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    skills: SkillRegistry,
    traces: TraceStore,
    composio_connection_scope: Option<Vec<ComposioConnectionBinding>>,
    referenced_conversation_ids: Vec<String>,
) -> anyhow::Result<TextReplyResult> {
    run_text_turn_in_with_metadata(
        conversation_id,
        agent_id,
        text,
        author_name,
        persist,
        None,
        false,
        None,
        model,
        max_tokens_cap,
        registry,
        conversations,
        agent_store,
        manager,
        memory,
        worktree_diffs,
        mcp,
        skills,
        traces,
        composio_connection_scope,
        referenced_conversation_ids,
    )
    .await
}

/// Like [`run_text_turn`] but with an explicit working directory and optional
/// per-conversation git-worktree isolation. Used by the coordinator-threads
/// feature so a spawned worker conversation runs its configured agent in its own
/// isolated worktree (each worker gets a dedicated branch/worktree, reused across
/// turns by `route_chat_stream`'s persistent-session logic). When `cwd` is `None`
/// and `worktree_isolation` is `false` this is identical to `run_text_turn`.
///
/// No turn-boundary hooks here either, for the reason spelled out on
/// [`run_text_turn`]: a coordinator worker's turn is opened by the coordinator, not
/// by a user, and it is also the landing site of a hook's own `host.runAgent` — so
/// firing the phases here is the one shape that could re-enter itself across the
/// spawned task boundary the `IN_CHAT_HOOK` guard cannot see.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_text_turn_in(
    conversation_id: String,
    agent_id: Option<String>,
    text: String,
    author_name: Option<String>,
    persist: bool,
    cwd: Option<String>,
    worktree_isolation: bool,
    worktree_branch: Option<String>,
    // Per-turn model pin (see `run_text_turn`).
    model: Option<String>,
    // Optional hard ceiling for generated output, applied stricter than the
    // agent's stored inference defaults.
    max_tokens_cap: Option<u32>,
    registry: Arc<AcpAgentRegistry>,
    conversations: ConversationStore,
    agent_store: AgentStore,
    manager: Arc<SidecarManager>,
    memory: MemoryStore,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    skills: SkillRegistry,
    traces: TraceStore,
) -> anyhow::Result<String> {
    run_text_turn_in_with_metadata(
        conversation_id,
        agent_id,
        text,
        author_name,
        persist,
        cwd,
        worktree_isolation,
        worktree_branch,
        model,
        max_tokens_cap,
        registry,
        conversations,
        agent_store,
        manager,
        memory,
        worktree_diffs,
        mcp,
        skills,
        traces,
        None,
        Vec::new(),
    )
    .await
    .map(|result| result.reply)
}

#[allow(clippy::too_many_arguments)]
async fn run_text_turn_in_with_metadata(
    conversation_id: String,
    agent_id: Option<String>,
    text: String,
    author_name: Option<String>,
    persist: bool,
    cwd: Option<String>,
    worktree_isolation: bool,
    worktree_branch: Option<String>,
    model: Option<String>,
    max_tokens_cap: Option<u32>,
    registry: Arc<AcpAgentRegistry>,
    conversations: ConversationStore,
    agent_store: AgentStore,
    manager: Arc<SidecarManager>,
    memory: MemoryStore,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    skills: SkillRegistry,
    traces: TraceStore,
    composio_connection_scope: Option<Vec<ComposioConnectionBinding>>,
    referenced_conversation_ids: Vec<String>,
) -> anyhow::Result<TextReplyResult> {
    let profile_conversation_scope = composio_connection_scope
        .as_ref()
        .map(|_| referenced_conversation_ids.clone());
    let req = ChatStreamRequest {
        fresh_session: false,
        messages: vec![UiMessage {
            metadata: None,
            role: "user".to_owned(),
            content: UiContent::Text(text),
            parts: vec![],
        }],
        agent_id,
        agent_resource_authorization: None,
        turn_context: None,
        turn_query_context: None,
        response_mode: RyuResponseMode::Everyday,
        model: None,
        conversation_id: Some(conversation_id),
        context_handoff: None,
        acp_conversation_generation: None,
        session_id: None,
        client_id: None,
        referenced_conversation_ids,
        composio_connection_scope,
        profile_conversation_scope,
        enable_long_term: false,
        cwd,
        workspace_folders: Vec::new(),
        worktree_isolation,
        branch: None,
        worktree_path: None,
        worktree_branch,
        project_environment: None,
        cloud_environment_id: None,
        cloud_authorization: None,
        cloud_task_context: None,
        companion_source: false,
        client_tools: Vec::new(),
        browser_context_consent: false,
        browser_surface: None,
        target_agent_id: None,
        team_id: None,
        workflow_id: None,
        persist,
        skip_user_append: false,
        widget_follow_up_ticket: None,
        widget_provenance: None,
        agent_control_applied: None,
        inference: None,
        acp_mode: None,
        acp_config: None,
        // The per-turn model pin travels the same field the composer's picker
        // writes, so an off-chat caller and a typing user reach the agent's
        // model the same way. Empty is normalised to absent downstream.
        acp_model: model,
        lane_default: false,
        max_tokens_cap,
        // Programmatic fan-out (delegate / threads / worker / scheduled / team
        // member) — yield to a directly-typing user on the shared local engine.
        background: true,
        plugin_flags: std::collections::HashMap::new(),
        // Never styled: docs/output-styles.md §5 scopes output styles to the main
        // conversation, because a delegate's reply is structured text the PARENT
        // parses back and a style would reshape it. `route_chat_stream` enforces that
        // from `background` (which is what actually suppresses all profile injection);
        // spelling it out here too keeps the intent visible at the construction site.
        output_style: None,
        // Programmatic turn, no verified human author to attribute.
        author_user_id: None,
        verified_caller: None,
        // Connector-supplied sender display name (group/channel chats); None for
        // non-channel programmatic turns.
        author_name,
        user_jwt: None,
        public_agent_policy: None,
        read_only_tools: false,
        untrusted_caller: false,
    };

    // Route through the full streaming path (identical to the HTTP handler).
    // Headless callers (channels) pass `None` for auto-recall: they have no
    // `RetrievalStore` in scope and recall on bot/channel turns is a deliberate
    // v1 scope decision (the HTTP chat handler is where recall is wired).
    let response = route_chat_stream(
        req,
        registry,
        conversations,
        agent_store,
        manager,
        memory,
        worktree_diffs,
        mcp,
        skills,
        traces,
        None,
        // Programmatic fan-out (channels/threads) inherits the engine's own
        // overflow handling; app-level trimming is wired on the interactive
        // chat path (route_single_turn) only.
        None,
        // No reactive failover on the fan-out path: it drains the stream to a
        // string for a channel reply, so there is no info bar to explain a swap
        // and no user watching one happen.
        crate::routing_policy::reactive::TurnWatch::off(),
        None,
    )
    .await;

    // Drain the SSE response body, collecting all `text-delta` payloads into a
    // single String. Error frames propagate as Err. Shared with the team
    // orchestrator so both paths parse the AI SDK stream identically.
    drain_text_reply_with_metadata(response).await
}
