use super::*;

// ── Agent teams orchestration ────────────────────────────────────────────────
//
// A team turn fans out one user message to several member agents per the team's
// coordination strategy and merges their replies into ONE attributed SSE stream.
// Every member runs through the exact same `route_chat_stream` path (so each
// keeps its own engine binding, gateway routing, tools, persona) — the team
// layer only decides *which* members run, *what prompt* each sees, and *how* the
// replies are stitched together.
//
// Persistence model (verified to reload identically): the orchestrator writes the
// user turn once and a single combined assistant turn attributed to the team id;
// member sub-requests run with `persist = false` so they never write their own
// rows. Member replies are attributed inline with a `**Name**` markdown header —
// a guaranteed-render fallback that needs no client changes.

/// Bundle of the stores a team turn needs, so the orchestrator and its
/// per-member helper don't each carry a dozen positional args.
#[derive(Clone)]
pub struct TeamRunDeps {
    pub acp_conversation_generation: Option<Option<String>>,
    pub registry: Arc<AcpAgentRegistry>,
    pub conversations: ConversationStore,
    pub agent_store: AgentStore,
    pub manager: Arc<SidecarManager>,
    pub memory: MemoryStore,
    pub worktree_diffs: crate::server::WorktreeDiffStore,
    pub mcp: Arc<McpRegistry>,
    pub skills: SkillRegistry,
    pub traces: TraceStore,
    /// The verified caller's exact-agent ACL, applied to each member's settled
    /// agent (including a Router/auto handoff). `None` for internal fan-out.
    pub agent_resource_authorization: Option<Arc<AgentResourceAuthorization>>,
}

/// Run a single team member for one turn and return its final assistant text.
///
/// Reuses `route_chat_stream` wholesale (engine binding, gateway, tools, memory)
/// with `persist = false` so the member's reply is not written to the store — the
/// orchestrator persists one combined turn itself. A real `conversation_id` is
/// still passed so ACP members get short-term context (recent turns) for the
/// conversation; `target_agent_id` binds the call to this member.
///
/// Turn-boundary hooks deliberately do NOT fire per member, and adding them here
/// would be a bug, not a fix. One user turn fans out to N members, so a
/// `post_assistant_turn` hook would run N times for it: N notes for one question,
/// and N independent `continue` loops each allowed [`crate::plugin_host::MAX_CONTINUE_TURNS`]
/// — a cap written for one turn, silently multiplied by the member count. A
/// per-member `pre_user_turn` is just as wrong: it would rewrite the same prompt N
/// times, once per member, each rewrite invisible to the others. The single
/// legitimate rewrite happens once, upstream, in [`route_team_chat_stream`].
///
/// A member turn is also not a state a post-turn hook can read: members run with
/// `persist = false`, so the transcript such a hook loaded would show the PREVIOUS
/// turn — it would review an answer that is not the one it was fired for.
///
/// What still governs each member: `context` and the tool phases
/// (`pre_tool_use` / `tool_result` / `post_tool_use`) fire inside
/// [`route_chat_stream`] and the tool-dispatch core for every member individually,
/// so a context-engineering plugin and a tool-result redaction plugin both apply
/// here in full. Only the turn-boundary loop is suppressed. (`message_end` fires
/// too, but its rewrite targets persistence, which a `persist = false` member does
/// not do — a member's text reaches the combined message ungoverned by that phase.
/// That is a gap in how the team path persists, not something this decision
/// creates or can close.)
pub(crate) async fn run_member_text(
    member_id: &str,
    messages: Vec<UiMessage>,
    conversation_id: Option<String>,
    deps: &TeamRunDeps,
) -> anyhow::Result<String> {
    run_member_text_with_flags(
        member_id,
        messages,
        conversation_id,
        deps,
        std::collections::HashMap::new(),
    )
    .await
}

/// Team member variant that carries the caller's per-turn plugin flags. The
/// ordinary team path keeps the empty map because its members are internal
/// fan-out calls; a temporary chat can explicitly opt its members into the same
/// read-only personalized context as a single-agent turn.
pub(crate) async fn run_member_text_with_flags(
    member_id: &str,
    messages: Vec<UiMessage>,
    conversation_id: Option<String>,
    deps: &TeamRunDeps,
    plugin_flags: std::collections::HashMap<String, bool>,
) -> anyhow::Result<String> {
    let conversation_generation = if conversation_id.is_some() {
        deps.acp_conversation_generation.clone()
    } else {
        Some(None)
    };
    let req = ChatStreamRequest {
        fresh_session: false,
        messages,
        agent_id: Some(member_id.to_owned()),
        agent_resource_authorization: deps.agent_resource_authorization.clone(),
        turn_context: None,
        turn_query_context: None,
        response_mode: RyuResponseMode::Everyday,
        model: None,
        conversation_id,
        context_handoff: None,
        acp_conversation_generation: conversation_generation,
        session_id: None,
        client_id: None,
        referenced_conversation_ids: Vec::new(),
        composio_connection_scope: None,
        profile_conversation_scope: None,
        enable_long_term: false,
        cwd: None,
        workspace_folders: Vec::new(),
        worktree_isolation: false,
        branch: None,
        worktree_path: None,
        worktree_branch: None,
        project_environment: None,
        cloud_environment_id: None,
        cloud_authorization: None,
        cloud_task_context: None,
        companion_source: false,
        client_tools: Vec::new(),
        browser_context_consent: false,
        browser_surface: None,
        target_agent_id: Some(member_id.to_owned()),
        team_id: None,
        workflow_id: None,
        persist: false,
        skip_user_append: false,
        widget_follow_up_ticket: None,
        widget_provenance: None,
        agent_control_applied: None,
        inference: None,
        max_tokens_cap: None,
        acp_mode: None,
        acp_config: None,
        acp_model: None,
        lane_default: false,
        // Programmatic fan-out (delegate / threads / worker / scheduled / team
        // member) — yield to a directly-typing user on the shared local engine.
        background: true,
        plugin_flags,
        // Unstyled, same scope rule as [`run_text_turn_in`].
        output_style: None,
        // Programmatic per-member turn, no human author to attribute.
        author_user_id: None,
        verified_caller: None,
        author_name: None,
        user_jwt: None,
        public_agent_policy: None,
        read_only_tools: false,
        untrusted_caller: false,
    };
    // Team members run with auto-recall OFF: a single user message is fanned out
    // to N members, so per-member recall would be N× redundant retrieval on the
    // same query. Recall is wired at the single-agent HTTP chat handler.
    let response = route_chat_stream(
        req,
        Arc::clone(&deps.registry),
        deps.conversations.clone(),
        deps.agent_store.clone(),
        Arc::clone(&deps.manager),
        deps.memory.clone(),
        Arc::clone(&deps.worktree_diffs),
        Arc::clone(&deps.mcp),
        deps.skills.clone(),
        deps.traces.clone(),
        None,
        // Team member turns inherit engine overflow handling (see above).
        None,
        // Team members run with `persist = false` and the orchestrator writes one
        // combined turn, so a per-member retry would have to be reconciled against
        // a reply that has not been assembled yet. Left on the direct path.
        crate::routing_policy::reactive::TurnWatch::off(),
        None,
    )
    .await;
    drain_text_reply(response).await
}

/// Clone `original`, rewriting the last user message so `preamble` precedes its
/// text. This is how cross-member context (round-robin transcript, debate
/// synthesis brief, router instruction) is injected uniformly for BOTH ACP and
/// OpenAI-compat members — ACP only forwards the last user message, so folding
/// context into that message reaches every engine without history threading.
pub(crate) fn messages_with_preamble(original: &[UiMessage], preamble: &str) -> Vec<UiMessage> {
    let mut messages = original.to_vec();
    if let Some(last_user) = messages.iter_mut().rev().find(|m| m.role == "user") {
        let existing = last_user.content.as_text();
        last_user.content = UiContent::Text(format!("{preamble}\n\n{existing}"));
        last_user.parts = vec![];
    }
    messages
}

/// Resolve a `(member_id, display_name)` for each team member, falling back to
/// the id when the agent record is missing (e.g. an uninstalled built-in).
pub(crate) async fn member_names(
    members: &[String],
    agent_store: &AgentStore,
) -> Vec<(String, String)> {
    let mut out = Vec::with_capacity(members.len());
    for id in members {
        let name = agent_store
            .get(id)
            .await
            .ok()
            .flatten()
            .map(|a| a.name)
            .unwrap_or_else(|| id.clone());
        out.push((id.clone(), name));
    }
    out
}

/// Format one member's reply as an attributed UI text block (header + body),
/// pushing the frames to `out` and the same text to `combined` (what gets
/// persisted, so a reload renders identically to the live stream).
pub(crate) fn push_member_block(
    out: &mut Vec<Vec<u8>>,
    combined: &mut String,
    block_id: &str,
    label: &str,
    body: &str,
) {
    let header = format!("**{label}**\n\n");
    out.push(ui_text_start(block_id));
    out.push(ui_text_delta(block_id, &header));
    out.push(ui_text_delta(block_id, body));
    out.push(ui_text_end(block_id));
    combined.push_str(&header);
    combined.push_str(body);
    combined.push_str("\n\n");
}
