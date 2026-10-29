use super::*;

/// Route a chat stream request to the correct agent sidecar and return an
/// `axum::Response` whose body is an AI SDK v6 UIMessageStream SSE.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TextReplyResult {
    pub reply: String,
    pub assistant_message_id: Option<String>,
    pub assistant_message_ids: Vec<String>,
    pub interactive_markup: Option<ryu_channel_contracts::InteractiveMarkup>,
}

/// Inner run function for non-streaming callers (channel bots, M11).
///
/// Builds a [`ChatStreamRequest`] from a `(conversation_id, agent_id, text)` turn,
/// runs the full engine + memory path shared with the HTTP streaming handler, and
/// drains the SSE stream to assemble the final reply `String`. Existing desktop/CLI
/// chat continues to call [`route_chat_stream`] directly — this function is a thin
/// wrapper that reuses every piece of that path without duplicating logic.
///
/// `conversation_id` is set to the Telegram `chat_id` (or any stable per-channel
/// id) so multi-turn exchanges share conversation history via the SQLite store.
///
/// Returns `Err` only when the underlying route produces an SSE error frame;
/// a missing reply (empty model response) returns `Ok("")`.
///
/// This is a REAL user turn — a human typed it into Telegram/WhatsApp/Slack — so
/// it carries the full turn-boundary hook treatment ([`run_pre_user_turn_hooks`],
/// [`run_post_assistant_turn_hooks`]), unlike the internal sub-turns that share
/// [`run_text_turn_in`] underneath. The hooks are fired HERE rather than in
/// `run_text_turn_in` for exactly that reason: the same inner function also serves
/// the workflow `AgentRunner`, the coordinator-thread worker, and the app
/// host-bridge, none of which are a user opening a turn.
#[allow(clippy::too_many_arguments)]
pub async fn run_reply_text(
    conversation_id: String,
    agent_id: Option<String>,
    text: String,
    author_name: Option<String>,
    registry: Arc<AcpAgentRegistry>,
    conversations: ConversationStore,
    agent_store: AgentStore,
    manager: Arc<SidecarManager>,
    memory: MemoryStore,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    skills: SkillRegistry,
    traces: TraceStore,
) -> anyhow::Result<TextReplyResult> {
    run_reply_text_with_channel_action(
        conversation_id,
        agent_id,
        text,
        author_name,
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
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn run_reply_text_with_channel_action(
    conversation_id: String,
    agent_id: Option<String>,
    text: String,
    author_name: Option<String>,
    registry: Arc<AcpAgentRegistry>,
    conversations: ConversationStore,
    agent_store: AgentStore,
    manager: Arc<SidecarManager>,
    memory: MemoryStore,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    skills: SkillRegistry,
    traces: TraceStore,
    channel_action: Option<ryu_channel_contracts::ChannelActionEvent>,
) -> anyhow::Result<TextReplyResult> {
    let admission = crate::execution_control::admit().map_err(anyhow::Error::msg)?;
    crate::agent_execution::ensure_noninteractive_run_allowed(&agent_store, agent_id.as_deref())
        .await?;
    // Pre-turn: a plugin may rewrite the inbound message, fold context into it, or
    // answer it outright. A `Handled` turn makes no model call, so it must persist
    // both rows itself (see `persist_handled_turn`).
    let pre = run_pre_user_turn_hooks_with_channel_action(
        text.clone(),
        Some(&conversation_id),
        agent_id.as_deref(),
        channel_action,
    )
    .await;
    let mut prompt = match pre {
        PreUserTurn::Prompt(p) => p,
        PreUserTurn::Handled {
            reply,
            interactive_markup,
        } => {
            let assistant_message_id = persist_handled_turn(
                &conversations,
                &conversation_id,
                &text,
                &reply,
                agent_id.as_deref(),
                None,
                author_name.as_deref(),
            )
            .await;
            return Ok(TextReplyResult {
                reply,
                assistant_message_ids: assistant_message_id.clone().into_iter().collect(),
                assistant_message_id,
                interactive_markup,
            });
        }
    };

    // The channel path persists: each inbound bot turn becomes conversation
    // history so multi-turn exchanges share context.
    //
    // The loop is the `continue` directive (the server-side goal loop), capped by
    // the same [`crate::plugin_host::MAX_CONTINUE_TURNS`] the HTTP wrapper uses so
    // one cap governs every transport. Each looped turn persists like a normal one;
    // what the channel DELIVERS is every turn joined, not just the last, because
    // the HTTP wrapper streams all of them into one response and a channel that
    // showed only the final turn would render a conversation the transcript
    // disagrees with.
    let mut delivered = String::new();
    let mut assistant_message_id = None;
    let mut assistant_message_ids = Vec::new();
    let mut interactive_markup = None;
    let mut turn: u32 = 0;
    loop {
        if admission.is_cancelled() {
            return Err(anyhow::anyhow!(crate::execution_control::PAUSED_MESSAGE));
        }
        let turn_result = run_text_turn_with_metadata(
            conversation_id.clone(),
            agent_id.clone(),
            prompt,
            author_name.clone(),
            true,
            // Channel turns run the agent as configured — no per-turn pin.
            None,
            None,
            Arc::clone(&registry),
            conversations.clone(),
            agent_store.clone(),
            Arc::clone(&manager),
            memory.clone(),
            Arc::clone(&worktree_diffs),
            Arc::clone(&mcp),
            skills.clone(),
            traces.clone(),
            None,
            Vec::new(),
        )
        .await;
        let result = match turn_result {
            Ok(result) => result,
            // The FIRST turn failing is the turn failing — the caller must hear
            // about it. A later turn is a hook's `continue`: the user already has a
            // real answer in hand, so a failed follow-up ends the loop rather than
            // erasing a reply that did land.
            Err(e) if delivered.is_empty() => return Err(e),
            Err(e) => {
                tracing::warn!(
                    "plugin_host: a continue turn failed after a delivered reply: {e:#}"
                );
                break;
            }
        };
        let reply = result.reply;
        if let Some(message_id) = result.assistant_message_id {
            assistant_message_ids.push(message_id.clone());
            assistant_message_id = Some(message_id);
        }
        if !reply.is_empty() {
            if !delivered.is_empty() {
                delivered.push_str("\n\n");
            }
            delivered.push_str(&reply);
        }

        if admission.is_cancelled() {
            return Err(anyhow::anyhow!(crate::execution_control::PAUSED_MESSAGE));
        }
        turn += 1;
        let post =
            run_post_assistant_turn_hooks(&conversations, &conversation_id, agent_id.as_deref())
                .await;
        if turn < crate::plugin_host::MAX_CONTINUE_TURNS {
            if let Some(next) = post.continue_text {
                prompt = next;
                interactive_markup = None;
                continue;
            }
        }
        interactive_markup = post.interactive_markup;
        break;
    }

    Ok(TextReplyResult {
        reply: delivered,
        assistant_message_id,
        assistant_message_ids,
        interactive_markup,
    })
}
