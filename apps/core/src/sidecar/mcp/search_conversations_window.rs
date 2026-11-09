//! `around_message_id` mode of `search_conversations.search`: read the
//! transcript around one message instead of searching.
//!
//! A search hit is a short snippet; the surrounding turns are the ground truth an
//! agent should check before relying on it. This is a mode of the existing tool,
//! not a new tool id, so it inherits every gate that tool already has on both
//! agent planes: the per-agent allowlist, the `ToolPrincipal` fail-closed rule,
//! the profile-scope ceiling, and the exfiltration guard's private-source class.
//!
//! **Tenancy.** The message's conversation must be in the same id set a search
//! would touch ([`super::resolve_conversation_ids`]: the principal's visible set,
//! intersected with any caller-supplied `conversation_ids` and the server-owned
//! scope). A message the caller cannot read returns exactly the same envelope as
//! a message that does not exist.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use super::ToolPrincipal;
use crate::server::conversations::{ConversationStore, MessageWindow, StoredMessage};

/// Messages returned on each side of the target when the caller does not say.
const DEFAULT_SIDE: usize = 3;
/// Upper bound on each side, so one call cannot dump a whole transcript.
const MAX_SIDE: usize = 10;
/// Per-message content cap (characters). Longer than a search snippet, because
/// the point is to read what was said, but still bounded.
const MESSAGE_MAX_CHARS: usize = 2_000;

/// Add the window arguments to the search schema and make `query` optional
/// (it is required unless `around_message_id` is set).
pub(super) fn extend_schema(schema: &mut Value) {
    if let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) {
        properties.insert(
            "around_message_id".to_owned(),
            json!({
                "type": "string",
                "description": "Read the transcript around this message (a message_id from \
                                an earlier search result) instead of searching. 'query' and \
                                'mode' are then ignored."
            }),
        );
        for side in ["before", "after"] {
            properties.insert(
                side.to_owned(),
                json!({
                    "type": "integer",
                    "description": format!(
                        "With around_message_id: how many messages {side} it to return \
                         (default {DEFAULT_SIDE})."
                    ),
                    "minimum": 0,
                    "maximum": MAX_SIDE
                }),
            );
        }
    }
    if let Some(object) = schema.as_object_mut() {
        object.remove("required");
    }
}

/// The `around_message_id` argument, when the call asks for a window.
pub(super) fn around_message_id(arguments: &Value) -> Result<Option<&str>> {
    match arguments.get("around_message_id") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(id)) => Ok(Some(id.trim()).filter(|id| !id.is_empty())),
        Some(_) => Err(anyhow!("'around_message_id' must be a message id string")),
    }
}

fn side(arguments: &Value, field: &str) -> Result<usize> {
    match arguments.get(field) {
        None | Some(Value::Null) => Ok(DEFAULT_SIDE),
        Some(value) => value
            .as_u64()
            .map(|n| (n as usize).min(MAX_SIDE))
            .ok_or_else(|| anyhow!("'{field}' must be a non-negative integer")),
    }
}

/// One envelope for "no such message" and "not yours", so the two cannot be
/// told apart.
fn not_found() -> Value {
    json!({
        "ok": false,
        "available": true,
        "error": "message not found",
        "messages": [],
        "count": 0
    })
}

fn render_message(message: &StoredMessage, target: bool) -> Value {
    let mut out = json!({
        "message_id": message.id,
        "role": message.role,
        "content": truncate(&message.content),
        "created_at": message.created_at,
    });
    if let Some(author) = message.author_name.as_deref() {
        out["author_name"] = json!(author);
    }
    if target {
        out["target"] = json!(true);
    }
    out
}

fn render(window: &MessageWindow) -> Value {
    let messages: Vec<Value> = window
        .messages
        .iter()
        .enumerate()
        .map(|(index, message)| render_message(message, index == window.target_index))
        .collect();
    json!({
        "ok": true,
        "available": true,
        "conversation_id": window.conversation_id,
        "conversation_title": window.conversation_title,
        "messages": messages,
        "count": messages.len(),
        "has_earlier": window.has_earlier,
        "has_later": window.has_later,
    })
}

/// Read the window around `message_id` after the same tenancy gate a search uses.
pub(super) async fn dispatch_window(
    message_id: &str,
    arguments: &Value,
    store: &ConversationStore,
    principal: &ToolPrincipal,
    conversation_scope: Option<&[String]>,
) -> Result<Value> {
    let before = side(arguments, "before")?;
    let after = side(arguments, "after")?;
    if !store.chat_memory_enabled() {
        return Ok(super::unavailable(
            "conversation memory search is disabled; enable Remember chats first",
        ));
    }
    let Some(conversation_id) = store.message_conversation_id(message_id).await? else {
        return Ok(not_found());
    };
    let readable =
        super::resolve_conversation_ids(arguments, store, principal, conversation_scope).await?;
    if readable.is_some_and(|ids| !ids.contains(&conversation_id)) {
        return Ok(not_found());
    }
    Ok(store
        .message_window(&conversation_id, message_id, before, after)
        .await?
        .map_or_else(not_found, |window| render(&window)))
}

fn truncate(text: &str) -> String {
    if text.chars().count() <= MESSAGE_MAX_CHARS {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(MESSAGE_MAX_CHARS).collect();
    out.push('…');
    out
}

#[cfg(test)]
#[path = "search_conversations_window_tests.rs"]
mod tests;
