//! Dream's source material: a bounded, visibility-filtered window of recent
//! chat messages.

use super::candidates::bounded_text;
use super::{DREAM_MAX_CONVERSATIONS, DREAM_MAX_TRANSCRIPT_CHARS, DREAM_MESSAGES_PER_CONVERSATION};
use crate::server::{memory, ServerState};

#[derive(Debug, Clone)]
pub(super) struct DreamSource {
    pub(super) conversation_id: String,
    pub(super) conversation_title: String,
    pub(super) message_id: String,
    pub(super) role: String,
    pub(super) content: String,
    /// When the message was stored; the newest one is Dream's run watermark.
    pub(super) created_at: i64,
}

pub(super) async fn load_sources(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    include_sensitive: bool,
) -> anyhow::Result<Vec<DreamSource>> {
    let summaries = state
        .conversations
        .list_conversations_visible(
            caller.as_ref().map(|caller| caller.user_id.as_str()),
            caller.as_ref().and_then(|caller| caller.org_id.as_deref()),
            crate::sidecar::control_plane::registered_org().is_some(),
        )
        .await?;
    let mut sources = Vec::new();
    let mut transcript_chars = 0;
    'conversations: for summary in summaries.into_iter().take(DREAM_MAX_CONVERSATIONS) {
        let messages = state
            .conversations
            .get_recent_messages(&summary.id, DREAM_MESSAGES_PER_CONVERSATION)
            .await?;
        for message in messages {
            if !matches!(message.role.as_str(), "user" | "assistant")
                || message.content.trim().is_empty()
            {
                continue;
            }
            if !include_sensitive && !memory::detect_sensitive_topics(&message.content).is_empty() {
                continue;
            }
            let Some(content) = bounded_text(&message.content, 4_000) else {
                continue;
            };
            let cost = content.len() + message.id.len() + 40;
            if transcript_chars + cost > DREAM_MAX_TRANSCRIPT_CHARS && !sources.is_empty() {
                break 'conversations;
            }
            transcript_chars += cost;
            sources.push(DreamSource {
                conversation_id: summary.id.clone(),
                conversation_title: summary
                    .title
                    .clone()
                    .unwrap_or_else(|| "Conversation".to_owned()),
                message_id: message.id,
                role: message.role,
                content,
                created_at: message.created_at,
            });
        }
    }
    Ok(sources)
}
