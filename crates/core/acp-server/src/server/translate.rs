use super::*;

// ── Stream translation ───────────────────────────────────────────────────────

/// Best-effort ACP tool kind for a Core tool name (Core normalizes ACP agents'
/// tools to names like `Bash`, `Read`, `Edit`, and native tools keep their own).
pub(super) fn tool_kind(name: &str) -> ToolKind {
    let name = name.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| name.contains(needle));
    if has(&["bash", "shell", "exec", "terminal", "command", "run"]) {
        ToolKind::Execute
    } else if has(&["edit", "write", "patch", "replace", "create"]) {
        ToolKind::Edit
    } else if has(&["delete", "remove"]) {
        ToolKind::Delete
    } else if has(&["move", "rename"]) {
        ToolKind::Move
    } else if has(&["grep", "glob", "search", "find", "list", "ls"]) {
        ToolKind::Search
    } else if has(&["fetch", "web", "http", "browse", "url"]) {
        ToolKind::Fetch
    } else if has(&["read", "view", "open"]) {
        ToolKind::Read
    } else if has(&["think", "todo", "plan"]) {
        ToolKind::Think
    } else {
        ToolKind::Other
    }
}

/// A readable title: the tool name plus its most telling argument.
pub(super) fn tool_title(name: &str, input: &Value) -> String {
    let detail = [
        "command",
        "file_path",
        "path",
        "pattern",
        "query",
        "url",
        "description",
    ]
    .iter()
    .find_map(|key| input.get(*key).and_then(Value::as_str))
    .map(|value| value.lines().next().unwrap_or(value).trim().to_owned())
    .filter(|value| !value.is_empty());
    match detail {
        Some(detail) => {
            let detail: String = detail.chars().take(120).collect();
            format!("{name}: {detail}")
        }
        None => name.to_owned(),
    }
}

fn tool_output_text(output: &Value) -> Option<String> {
    let text = match output {
        Value::Null => return None,
        Value::String(text) => text.clone(),
        Value::Object(object) => match object.get("content").and_then(Value::as_array) {
            Some(blocks) => blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
            None => serde_json::to_string_pretty(output).ok()?,
        },
        other => serde_json::to_string_pretty(other).ok()?,
    };
    if text.trim().is_empty() {
        return None;
    }
    if text.chars().count() > MAX_TOOL_TEXT_CHARS {
        let mut clipped: String = text.chars().take(MAX_TOOL_TEXT_CHARS).collect();
        clipped.push_str("\n…");
        return Some(clipped);
    }
    Some(text)
}

/// Stateful mapping from decoded Core events to ACP session updates.
#[derive(Default)]
pub(super) struct Translator {
    announced: HashSet<String>,
    pub(super) assistant_text: String,
    /// Question cards already relayed; a re-sent frame for the same id only
    /// updates the tool call, it never asks again.
    pub(super) questioned: HashSet<String>,
}

impl Translator {
    pub(super) fn translate(&mut self, event: CoreEvent) -> Vec<SessionUpdate> {
        match event {
            CoreEvent::TextDelta(text) if !text.is_empty() => {
                self.assistant_text.push_str(&text);
                vec![SessionUpdate::AgentMessageChunk(ContentChunk::new(
                    ContentBlock::from(text),
                ))]
            }
            CoreEvent::ReasoningDelta(text) if !text.is_empty() => {
                vec![SessionUpdate::AgentThoughtChunk(ContentChunk::new(
                    ContentBlock::from(text),
                ))]
            }
            CoreEvent::ToolInputStart { id, name } => {
                if !self.announced.insert(id.clone()) {
                    return Vec::new();
                }
                vec![SessionUpdate::ToolCall(
                    ToolCall::new(id, name.clone())
                        .kind(tool_kind(&name))
                        .status(ToolCallStatus::Pending),
                )]
            }
            CoreEvent::ToolInput { id, name, input } => {
                let title = tool_title(&name, &input);
                let kind = tool_kind(&name);
                if self.announced.insert(id.clone()) {
                    vec![SessionUpdate::ToolCall(
                        ToolCall::new(id, title)
                            .kind(kind)
                            .status(ToolCallStatus::InProgress)
                            .raw_input(input),
                    )]
                } else {
                    vec![SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                        id,
                        ToolCallUpdateFields::new()
                            .title(title)
                            .kind(kind)
                            .status(ToolCallStatus::InProgress)
                            .raw_input(input),
                    ))]
                }
            }
            CoreEvent::ToolOutput { id, output, status } => {
                let mut updates = Vec::new();
                if self.announced.insert(id.clone()) {
                    updates.push(SessionUpdate::ToolCall(
                        ToolCall::new(id.clone(), "Tool").status(ToolCallStatus::InProgress),
                    ));
                }
                let mut fields = ToolCallUpdateFields::new().status(status);
                // A status-only progress update carries no output; sending a
                // null would wipe whatever the client already shows.
                if !output.is_null() {
                    let content = tool_output_text(&output)
                        .map(|text| vec![ToolCallContent::from(ContentBlock::from(text))]);
                    fields = fields.content(content).raw_output(output);
                }
                updates.push(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
                    id, fields,
                )));
                updates
            }
            _ => Vec::new(),
        }
    }

    /// Make sure the client has seen the tool call a permission request refers
    /// to; the protocol references an existing call by id.
    pub(super) fn ensure_announced(&mut self, update: &ToolCallUpdate) -> Option<SessionUpdate> {
        let id = update.tool_call_id.0.to_string();
        if !self.announced.insert(id.clone()) {
            return None;
        }
        let fields = &update.fields;
        let title = fields
            .title
            .clone()
            .unwrap_or_else(|| "Tool approval".to_owned());
        Some(SessionUpdate::ToolCall(
            ToolCall::new(id, title)
                .kind(fields.kind.unwrap_or(ToolKind::Other))
                .status(ToolCallStatus::Pending)
                .raw_input(fields.raw_input.clone()),
        ))
    }
}
