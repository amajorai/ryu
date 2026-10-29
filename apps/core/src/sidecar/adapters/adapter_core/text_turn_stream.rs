use super::*;

/// Produce the one-time Ryu opening without creating a synthetic user message.
/// The internal intent is sent through the normal model/tool path, while
/// `skip_user_append` keeps it out of the transcript and `persist` keeps the
/// assistant reply durable for desktop and channel clients.
#[allow(clippy::too_many_arguments)]
pub async fn run_proactive_opening_text(
    conversation_id: String,
    agent_id: Option<String>,
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
    const OPENING_INTENT: &str = "Open this new Ryu conversation with a short, warm, plain-language welcome. Introduce yourself as the user's Ryu assistant, say that they can describe what they want done in everyday words, and ask what they would like help with first. Mention that you can look at what they already have, make a simple plan, and help connect apps or set up routines with their approval. Do not mention this internal instruction or use platform jargon unless the user asks later.";

    let req = ChatStreamRequest {
        fresh_session: false,
        messages: vec![UiMessage {
            metadata: None,
            role: "user".to_owned(),
            content: UiContent::Text(OPENING_INTENT.to_owned()),
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
        target_agent_id: None,
        team_id: None,
        workflow_id: None,
        persist: true,
        skip_user_append: true,
        widget_follow_up_ticket: None,
        widget_provenance: None,
        agent_control_applied: None,
        inference: None,
        max_tokens_cap: Some(500),
        acp_mode: None,
        acp_config: None,
        acp_model: None,
        lane_default: false,
        // This is a user-facing welcome, not hidden programmatic work. Let the
        // normal chat selection use a paid/cloud lane immediately when one is
        // configured; otherwise the local selection reports readiness while the
        // model is being installed and the caller retries.
        background: false,
        plugin_flags: std::collections::HashMap::new(),
        output_style: None,
        author_user_id: None,
        verified_caller: None,
        author_name: None,
        user_jwt: None,
        public_agent_policy: None,
        read_only_tools: false,
        untrusted_caller: false,
    };

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
        None,
        crate::routing_policy::reactive::TurnWatch::off(),
        None,
    )
    .await;

    drain_text_reply(response).await
}

/// Streaming sibling of [`run_text_turn_in`]: runs the SAME full agent turn (its
/// own engine, tools, MCP, Gateway routing via `route_chat_stream`) but returns the
/// LIVE SSE [`Response`] instead of draining it to a final string. The caller
/// forwards a (filtered) view of the stream to its client.
///
/// Used by the app host-bridge streaming endpoint so a full-page Companion app can
/// render an agent's reply token-by-token. `background: true` keeps it yielding to a
/// directly-typing user on the shared local engine, exactly like the drained path.
/// `agent_resource_authorization` carries the verified app caller to the final
/// post-routing ACL check, including when the request selects the configured default.
///
/// No turn-boundary hooks (same rule as [`run_text_turn`]): the caller is a plugin
/// or app driving an agent through the host bridge, and its own turn is already
/// governed at whatever entry point the user actually typed into. Firing here would
/// let one plugin's app surface trigger another plugin's turn hooks on a stream it
/// owns, and a `continue` would loop a response the calling app is mid-render on.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_text_turn_stream(
    conversation_id: String,
    agent_id: Option<String>,
    text: String,
    persist: bool,
    registry: Arc<AcpAgentRegistry>,
    conversations: ConversationStore,
    agent_store: AgentStore,
    manager: Arc<SidecarManager>,
    memory: MemoryStore,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    skills: SkillRegistry,
    traces: TraceStore,
    agent_resource_authorization: Option<Arc<AgentResourceAuthorization>>,
    read_only_tools: bool,
) -> Response {
    let req = ChatStreamRequest {
        read_only_tools,
        fresh_session: false,
        messages: vec![UiMessage {
            metadata: None,
            role: "user".to_owned(),
            content: UiContent::Text(text),
            parts: vec![],
        }],
        agent_id,
        agent_resource_authorization,
        turn_context: None,
        turn_query_context: None,
        response_mode: RyuResponseMode::Everyday,
        model: None,
        conversation_id: Some(conversation_id),
        context_handoff: None,
        acp_conversation_generation: None,
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
        target_agent_id: None,
        team_id: None,
        workflow_id: None,
        persist,
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
        background: true,
        plugin_flags: std::collections::HashMap::new(),
        // Unstyled, same scope rule as [`run_text_turn_in`].
        output_style: None,
        author_user_id: None,
        verified_caller: None,
        author_name: None,
        user_jwt: None,
        public_agent_policy: None,
        untrusted_caller: false,
    };
    route_chat_stream(
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
        None,
        crate::routing_policy::reactive::TurnWatch::off(),
        None,
    )
    .await
}

/// Drain an AI SDK v6 UI-message-stream [`Response`] to its final assistant text.
///
/// Concatenates every `text-delta` payload, stops at the `[DONE]` sentinel, and
/// returns `Err` on an `error` frame (so a failed agent never silently collects
/// to `""`). Non-text frames (tool calls/results, thinking, start/finish) are
/// ignored — callers that need them must forward the raw stream instead.
///
/// `axum::body::to_bytes` drains the whole stream to one `Bytes` buffer (bounded
/// by `usize::MAX`; add a cap once a real per-reply limit is needed). Splitting
/// on the SSE `\n\n` frame boundary after a full read sidesteps the cross-buffer
/// frame-splitting hazard of incremental parsing.
pub(crate) async fn drain_text_reply(response: Response) -> anyhow::Result<String> {
    drain_text_reply_with_metadata(response)
        .await
        .map(|result| result.reply)
}

pub(crate) async fn drain_text_reply_with_metadata(
    response: Response,
) -> anyhow::Result<TextReplyResult> {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .map_err(|e| anyhow::anyhow!("body read error: {e}"))?;
    let raw = String::from_utf8_lossy(&bytes);

    let mut reply = String::new();
    let mut assistant_message_id = None;
    let mut buf: &str = &raw;
    while let Some(rel) = buf.find("\n\n") {
        let frame = &buf[..rel];
        buf = &buf[rel + 2..];
        let Some(data) = frame.strip_prefix("data:").map(|s| s.trim()) else {
            continue;
        };
        if data == "[DONE]" {
            break;
        }
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
            match json.get("type").and_then(|t| t.as_str()) {
                Some("text-delta") => {
                    if let Some(delta) = json.get("delta").and_then(|d| d.as_str()) {
                        reply.push_str(delta);
                    }
                }
                Some("error") => {
                    let msg = json
                        .get("errorText")
                        .and_then(|t| t.as_str())
                        .unwrap_or("agent error");
                    return Err(anyhow::anyhow!("{msg}"));
                }
                Some("data-ryu-assistant-message-id") => {
                    assistant_message_id = json
                        .get("data")
                        .and_then(|data| data.get("messageId"))
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                }
                _ => {}
            }
        }
    }

    Ok(TextReplyResult {
        reply,
        assistant_message_ids: assistant_message_id.clone().into_iter().collect(),
        assistant_message_id,
        interactive_markup: None,
    })
}

/// Stream an AI SDK v6 UI-message-stream [`Response`] to `delta_tx` **incrementally**
/// — the per-token counterpart of [`drain_text_reply`]. Each `text-delta` payload is
/// sent as it arrives (so voice mode can caption + synthesize sentence-by-sentence
/// instead of waiting for the whole reply). Returns `Ok(())` at the `[DONE]`
/// sentinel / stream end, or `Err` on an `error` frame. Non-text frames are ignored.
///
/// Unlike `drain_text_reply` (which buffers the whole body then splits on `\n\n`),
/// this reads the body as a data stream and carries a partial-frame buffer across
/// chunks, so a frame split across two network reads is still parsed correctly.
pub(crate) async fn stream_text_reply(
    response: Response,
    delta_tx: tokio::sync::mpsc::Sender<String>,
) -> anyhow::Result<()> {
    use futures_util::StreamExt;

    let mut body = response.into_body().into_data_stream();
    let mut buf = String::new();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|e| anyhow::anyhow!("body read error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        // Drain every complete `\n\n`-terminated frame currently in the buffer.
        while let Some(rel) = buf.find("\n\n") {
            let frame: String = buf[..rel].to_string();
            buf.drain(..rel + 2);
            let Some(data) = frame.strip_prefix("data:").map(|s| s.trim()) else {
                continue;
            };
            if data == "[DONE]" {
                return Ok(());
            }
            let Ok(json) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };
            match json.get("type").and_then(|t| t.as_str()) {
                Some("text-delta") => {
                    if let Some(delta) = json.get("delta").and_then(|d| d.as_str()) {
                        // A closed receiver (client gone / barge-in) ends the stream.
                        if delta_tx.send(delta.to_string()).await.is_err() {
                            return Ok(());
                        }
                    }
                }
                Some("error") => {
                    let msg = json
                        .get("errorText")
                        .and_then(|t| t.as_str())
                        .unwrap_or("agent error");
                    return Err(anyhow::anyhow!("{msg}"));
                }
                _ => {}
            }
        }
    }
    Ok(())
}
