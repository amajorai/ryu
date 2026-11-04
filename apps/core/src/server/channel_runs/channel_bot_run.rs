//! Channel bot run endpoint (M11 / #226).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Channel bot run endpoint (M11 / #226) ────────────────────────────────────

/// Request body for `POST /api/channels/run`.
///
/// Channel bots send one inbound turn and receive the assembled reply plus any
/// interactive markup produced by a plugin or app turn hook. `conversation_id`
/// should be stable per chat (e.g. Telegram `chat_id`) so multi-turn exchanges
/// share conversation history in the Core session store. `channelAction`, when
/// present, is an untrusted typed callback event from a previously sent button.
#[derive(serde::Deserialize, utoipa::ToSchema)]
pub(in crate::server) struct ChannelRunRequest {
    /// Stable per-chat identifier used as the Core conversation id.
    pub(in crate::server) conversation_id: String,
    /// Provider delivery identity. When present, Core replays a completed result
    /// for this key instead of appending/running the same inbound webhook twice.
    #[serde(default, rename = "idempotencyKey", alias = "idempotency_key")]
    #[schema(rename = "idempotencyKey")]
    pub(in crate::server) idempotency_key: Option<String>,
    /// Control-plane channel config id. When present, Core records the
    /// conversation as a channel-backed shared session.
    #[serde(default)]
    pub(in crate::server) channel_id: Option<String>,
    /// The agent to route the message to. Falls back to the default agent when absent.
    #[serde(default)]
    pub(in crate::server) agent_id: Option<String>,
    /// The team to route the message to. When set (and non-empty) it takes
    /// precedence over `agent_id`: the message fans out to the team's members
    /// per its coordination strategy (a lead agent orchestrating the others)
    /// and the combined, attributed reply is returned.
    #[serde(default)]
    pub(in crate::server) team_id: Option<String>,
    /// The user's message text.
    pub(in crate::server) text: String,
    /// Optional sender display name for group/channel chats (Telegram first
    /// name, Discord username, …). Connector-supplied and UNVERIFIED — recorded
    /// on the user message so a multi-participant thread knows who spoke; never
    /// used for auth. Absent for 1:1 chats.
    #[serde(default)]
    pub(in crate::server) author_name: Option<String>,
    /// Optional typed channel button event; its payload is untrusted user input.
    #[serde(default, rename = "channelAction", alias = "channel_action")]
    #[schema(rename = "channelAction", value_type = Option<serde_json::Value>)]
    pub(in crate::server) channel_action: Option<ryu_channel_contracts::ChannelActionEvent>,
}

/// Successful response from `POST /api/channels/run`.
#[derive(utoipa::ToSchema)]
pub(in crate::server) struct ChannelRunResponse {
    /// Assembled assistant reply text.
    pub(in crate::server) reply: String,
    /// Durable id for the primary assistant message, when one was persisted.
    #[schema(rename = "assistantMessageId")]
    pub(in crate::server) assistant_message_id: Option<String>,
    /// Durable ids for all assistant messages produced by the turn.
    #[schema(rename = "assistantMessageIds")]
    pub(in crate::server) assistant_message_ids: Vec<String>,
    /// Agent that handled the turn, if one was resolved.
    #[schema(rename = "agentId")]
    pub(in crate::server) agent_id: Option<String>,
    /// Warning returned when a deleted agent binding fell back to the default.
    #[schema(rename = "fallbackWarning")]
    pub(in crate::server) fallback_warning: Option<String>,
    /// Platform-neutral quick replies, callback buttons, or URL buttons from a hook.
    #[schema(rename = "interactiveMarkup", value_type = Option<serde_json::Value>)]
    pub(in crate::server) interactive_markup: Option<ryu_channel_contracts::InteractiveMarkup>,
    /// Emojis the agent placed on the turn's user message with `agents.react`,
    /// oldest first. The channel adapter mirrors them onto the provider message.
    #[schema(rename = "agentReactions")]
    pub(in crate::server) agent_reactions: Vec<String>,
}

/// Agent-authored reactions on the channel turn's user message. Read from the
/// durable reaction store rather than the replay row, so a retried delivery
/// mirrors the same reaction without a second model run. Best-effort: a read
/// failure only costs the mirrored reaction, never the reply.
pub(in crate::server) async fn channel_turn_agent_reactions(
    conversations: &crate::server::conversations::ConversationStore,
    conversation_id: &str,
) -> Vec<String> {
    conversations
        .agent_reactions_on_latest_user_message(conversation_id)
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "could not read agent reactions for a channel turn");
            Vec::new()
        })
}

/// Resolve a deleted single-agent binding without destroying the channel
/// record. Existing non-active agents keep their normal lifecycle error; only a
/// genuinely missing record is treated as an orphan and moved to the configured
/// default agent.
pub(in crate::server) async fn resolve_channel_agent(
    store: &AgentStore,
    requested: Option<String>,
) -> anyhow::Result<(Option<String>, Option<String>)> {
    let Some(requested_id) = requested else {
        return Ok((None, None));
    };
    if let Some(record) = store.get(&requested_id).await? {
        if record.lifecycle_status == crate::agents::AgentLifecycleStatus::Active {
            return Ok((Some(requested_id), None));
        }
        return Ok((Some(requested_id), None));
    }

    let default_id = crate::registry::ProviderRegistry::load().default_agent_id;
    let fallback = match store.get(&default_id).await? {
        Some(record) if record.lifecycle_status == crate::agents::AgentLifecycleStatus::Active => {
            Some(default_id)
        }
        _ => None,
    };
    let warning = format!(
        "This channel was reverted to the default agent because its original agent '{requested_id}' was deleted."
    );
    Ok((fallback, Some(warning)))
}
