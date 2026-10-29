use super::*;

// ── Prompt conversion ────────────────────────────────────────────────────────

fn data_url(mime: &str, base64_data: &str) -> String {
    format!("data:{mime};base64,{base64_data}")
}

fn file_name(uri: &str) -> String {
    uri.trim_end_matches('/')
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("attachment")
        .to_owned()
}

/// Convert an ACP prompt into AI SDK v6 UI message parts, plus the plain text
/// kept in the local transcript.
pub(super) fn prompt_parts(
    prompt: &[ContentBlock],
) -> Result<(String, Vec<Value>), agent_client_protocol::Error> {
    let mut text = String::new();
    let mut parts = Vec::new();
    let mut push_text = |parts: &mut Vec<Value>, value: String| {
        text.push_str(&value);
        parts.push(json!({ "type": "text", "text": value }));
    };
    for block in prompt {
        match block {
            ContentBlock::Text(content) => push_text(&mut parts, content.text.clone()),
            ContentBlock::Image(image) => parts.push(json!({
                "type": "file",
                "mediaType": image.mime_type,
                "url": data_url(&image.mime_type, &image.data),
            })),
            ContentBlock::Audio(_) => {
                return Err(invalid_params("Ryu does not accept audio prompts"));
            }
            ContentBlock::ResourceLink(link) => {
                push_text(&mut parts, format!("\n[{}]({})\n", link.name, link.uri));
            }
            ContentBlock::Resource(embedded) => match &embedded.resource {
                EmbeddedResourceResource::TextResourceContents(resource) => {
                    // Core reads `text/*` file parts as attached documents; any
                    // textual resource is sent as text/plain so it is never dropped.
                    let mime = resource
                        .mime_type
                        .as_deref()
                        .filter(|mime| mime.starts_with("text/"))
                        .unwrap_or("text/plain");
                    let encoded =
                        base64::engine::general_purpose::STANDARD.encode(resource.text.as_bytes());
                    parts.push(json!({
                        "type": "file",
                        "mediaType": mime,
                        "filename": file_name(&resource.uri),
                        "url": data_url(mime, &encoded),
                    }));
                }
                EmbeddedResourceResource::BlobResourceContents(resource) => {
                    let mime = resource
                        .mime_type
                        .clone()
                        .unwrap_or_else(|| "application/octet-stream".to_owned());
                    parts.push(json!({
                        "type": "file",
                        "mediaType": mime,
                        "filename": file_name(&resource.uri),
                        "url": data_url(&mime, &resource.blob),
                    }));
                }
                _ => {}
            },
            _ => {}
        }
    }
    if parts.is_empty() {
        return Err(invalid_params("the prompt is empty"));
    }
    Ok((text, parts))
}

pub(super) fn chat_body(job: &PromptJob, parts: Vec<Value>) -> Value {
    let mut messages: Vec<Value> = job
        .history
        .iter()
        .map(
            |turn| json!({ "role": turn.role, "content": [{ "type": "text", "text": turn.text }] }),
        )
        .collect();
    messages.push(json!({ "role": "user", "parts": parts }));
    let mut body = json!({
        "messages": messages,
        "conversation_id": job.conversation_id,
        "enable_long_term": false,
    });
    if let Some(agent) = &job.agent_id {
        body["agent_id"] = Value::String(agent.clone());
    }
    if let Some(cwd) = &job.cwd {
        body["cwd"] = Value::String(cwd.clone());
    }
    body
}
