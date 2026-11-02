//! Parse ChatGPT and Claude conversations into imported messages.

use super::*;

/// The visible ChatGPT thread: `current_node` up to the root, reversed.
pub fn parse_chatgpt(raw: &Value) -> Option<ExportConversation> {
    let id = raw
        .get("conversation_id")
        .or_else(|| raw.get("id"))
        .and_then(Value::as_str)?
        .to_string();
    let mapping = raw.get("mapping")?.as_object()?;
    let mut node_id = raw
        .get("current_node")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            // No current_node: follow first children from the root.
            let root = mapping
                .values()
                .find(|n| n.get("parent").map_or(true, Value::is_null))?;
            let mut node = root;
            loop {
                let next = node
                    .get("children")
                    .and_then(Value::as_array)
                    .and_then(|c| c.last())
                    .and_then(Value::as_str)
                    .and_then(|child| mapping.get(child));
                match next {
                    Some(child) => node = child,
                    None => break,
                }
            }
            node.get("id").and_then(Value::as_str).map(str::to_string)
        });
    let mut chain = Vec::new();
    let mut on_branch = HashSet::new();
    let mut guard = 0usize;
    while let Some(current) = node_id.take() {
        guard += 1;
        if guard > mapping.len() + 1 {
            break;
        }
        let Some(node) = mapping.get(&current) else {
            break;
        };
        if let Some(message) = node.get("message").filter(|m| !m.is_null()) {
            chain.push(message);
        }
        node_id = node
            .get("parent")
            .and_then(Value::as_str)
            .map(str::to_string);
        on_branch.insert(current);
    }
    chain.reverse();
    let messages = chain.into_iter().filter_map(chatgpt_message).collect();
    // Messages on branches the user has left (an edited prompt, a regenerated
    // reply). They are not imported; see `ExportConversation::superseded`.
    let superseded = mapping
        .iter()
        .filter(|(id, _)| !on_branch.contains(id.as_str()))
        .filter_map(|(_, node)| node.get("message").filter(|m| !m.is_null()))
        .filter_map(chatgpt_message)
        .map(|message| {
            (
                message_key(&message.role, &message.content),
                message.created_at,
            )
        })
        .collect();
    let title = raw
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some(finish(id, title, messages, superseded))
}

/// One visible user or assistant message of a ChatGPT export, as imported.
pub(super) fn chatgpt_message(message: &Value) -> Option<ImportedMessage> {
    let role = message
        .pointer("/author/role")
        .and_then(Value::as_str)
        .unwrap_or("");
    let hidden = message
        .pointer("/metadata/is_visually_hidden_from_conversation")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || message.get("weight").and_then(Value::as_f64) == Some(0.0);
    if hidden || !matches!(role, "user" | "assistant") {
        return None;
    }
    let text = chatgpt_content_text(message.get("content"))?;
    Some(ImportedMessage {
        role: role.to_string(),
        content: clamp(&text),
        created_at: epoch_seconds_to_ms(message.get("create_time")),
    })
}

/// Readable text for one ChatGPT message content object. Reasoning and
/// context records return `None`; images and files become placeholders.
pub(super) fn chatgpt_content_text(content: Option<&Value>) -> Option<String> {
    let content = content?;
    let kind = content
        .get("content_type")
        .and_then(Value::as_str)
        .unwrap_or("text");
    let text = match kind {
        "text" | "multimodal_text" => {
            let parts = content.get("parts").and_then(Value::as_array)?;
            parts
                .iter()
                .filter_map(|part| match part {
                    Value::String(s) => Some(s.clone()),
                    Value::Object(obj) => match obj.get("content_type").and_then(Value::as_str) {
                        Some("image_asset_pointer") => Some("[image]".to_string()),
                        Some("audio_transcription") => {
                            obj.get("text").and_then(Value::as_str).map(str::to_string)
                        }
                        Some(
                            "audio_asset_pointer" | "real_time_user_audio_video_asset_pointer",
                        ) => None,
                        _ => obj.get("text").and_then(Value::as_str).map(str::to_string),
                    },
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        }
        "code" => {
            let language = content
                .get("language")
                .and_then(Value::as_str)
                .filter(|l| *l != "unknown")
                .unwrap_or("");
            let body = content.get("text").and_then(Value::as_str)?;
            format!("```{language}\n{body}\n```")
        }
        "tether_quote" => {
            let title = content
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Quote");
            let body = content
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            format!("> {title}\n> {body}")
        }
        _ => return None,
    };
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

pub fn parse_claude(raw: &Value) -> Option<ExportConversation> {
    let id = raw.get("uuid").and_then(Value::as_str)?.to_string();
    let mut messages = Vec::new();
    for message in raw.get("chat_messages").and_then(Value::as_array)? {
        let role = match message.get("sender").and_then(Value::as_str) {
            Some("human") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        let mut text = message
            .get("content")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|block| match block.get("type").and_then(Value::as_str) {
                        Some("text") => block
                            .get("text")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        Some("tool_use") => block
                            .get("name")
                            .and_then(Value::as_str)
                            .map(|name| format!("[used {name}]")),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n")
            })
            .filter(|text| !text.trim().is_empty())
            .or_else(|| {
                message
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_default();
        for list in ["attachments", "files"] {
            for file in message
                .get(list)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(name) = file.get("file_name").and_then(Value::as_str) {
                    text.push_str(&format!("\n\n[attached: {name}]"));
                }
            }
        }
        if text.trim().is_empty() {
            continue;
        }
        messages.push(ImportedMessage {
            role: role.to_string(),
            content: clamp(&text),
            created_at: iso_to_ms(message.get("created_at")),
        });
    }
    let title = raw
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some(finish(id, title, messages, Vec::new()))
}

// ---------------------------------------------------------------------------
// Saved context (ChatGPT custom instructions, Claude memory)
// ---------------------------------------------------------------------------
