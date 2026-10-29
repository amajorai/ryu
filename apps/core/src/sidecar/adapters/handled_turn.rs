//! UI turns answered by a hook still use the canonical structured message writer.
use super::{persist_handled_turn, ChatStreamRequest, UiMessage};
use crate::server::conversations::{ConversationStore, MessageProvenance, Tenancy};

pub(crate) async fn persist_handled_ui_turn(
    conversations: &ConversationStore,
    request: &ChatStreamRequest,
    conversation_id: &str,
    user_text: &str,
    reply: &str,
    agent_id: Option<&str>,
) -> Option<String> {
    if !request.persist {
        return None;
    }
    let user_message = request
        .messages
        .iter()
        .rev()
        .find(|message| message.role == "user");
    let parts = user_message.and_then(UiMessage::render_parts);
    let provenance = request
        .widget_provenance
        .as_ref()
        .map(|value| MessageProvenance {
            source: value.source.to_owned(),
            widget_instance_id: value.widget_instance_id.clone(),
            origin_server: value.origin_server.clone(),
        });
    if !request.skip_user_append && (!user_text.is_empty() || parts.is_some()) {
        if let Err(error) = conversations
            .append_message_as_with_render_data(
                conversation_id,
                "user",
                user_text,
                agent_id,
                request.author_user_id.as_deref(),
                request.author_name.as_deref(),
                Tenancy::Unattributed,
                provenance.as_ref(),
                request.client_id.as_deref(),
                parts.as_ref(),
                user_message.and_then(|message| message.metadata.as_ref()),
            )
            .await
        {
            tracing::warn!(error = %error, "could not persist hook-handled UI user message");
        }
    }
    // The off-HTTP helper owns reply persistence. An empty user string skips its text-only writer.
    persist_handled_turn(
        conversations,
        conversation_id,
        "",
        reply,
        agent_id,
        None,
        None,
    )
    .await
}
