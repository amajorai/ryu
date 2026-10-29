use super::*;

/// Accumulates an assistant turn's structured render `parts` (the AI SDK *reduced*
/// UIMessage part shape) alongside the SSE frames, so the exact tool/text/file
/// parts the live turn showed can be persisted and re-rendered on reload — the
/// cowork context (Progress / Sources / Subagents) and the transcript's tool rows,
/// not just flat `content` text.
///
/// It mirrors the AI SDK client's frame reduction: text deltas coalesce into one
/// `text` part per block id, and a tool's `tool-output-available` frame patches the
/// same part its `tool-input-available` opened (matched by `toolCallId`) — so the
/// persisted array is byte-for-byte what the client built from the live stream.
#[derive(Default)]
pub(crate) struct PartsAccumulator {
    pub(crate) parts: Vec<Value>,
    /// `toolCallId` → index in `parts`, so an output frame patches the part its
    /// input opened (and a re-emitted plan/thought snapshot updates in place).
    tool_idx: std::collections::HashMap<String, usize>,
    /// text block id → index in `parts`, so deltas append to the open text part.
    text_idx: std::collections::HashMap<String, usize>,
}

impl PartsAccumulator {
    /// Append a streamed text delta to the (single) text part for `block_id`,
    /// opening it on first delta.
    pub(crate) fn text_delta(&mut self, block_id: &str, delta: &str) {
        if let Some(&i) = self.text_idx.get(block_id) {
            let prev = self.parts[i]
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            self.parts[i]["text"] = Value::String(format!("{prev}{delta}"));
        } else {
            let i = self.parts.len();
            self.parts
                .push(serde_json::json!({ "type": "text", "text": delta, "state": "done" }));
            self.text_idx.insert(block_id.to_owned(), i);
        }
    }

    /// Open (or update in place) a tool part. Mirrors [`ui_tool_input`]:
    /// `dynamic = false` → a `tool-<name>` part; `dynamic = true` → a
    /// `dynamic-tool` part carrying `toolName`. Re-emitting the same id (plan /
    /// thinking snapshots) refreshes its `input`.
    ///
    /// `started_at` mirrors the wire frame's timing stamp onto the PERSISTED
    /// part, under the same `callProviderMetadata` key the AI SDK client would
    /// have written from the live stream. Without this the sealed parts would
    /// disagree with what the user just watched, which is the whole failure mode
    /// the stamp exists to fix: timing visible live, gone on reload.
    pub(crate) fn tool_input(
        &mut self,
        id: &str,
        tool_name: &str,
        input: &Value,
        dynamic: bool,
        started_at: Option<i64>,
    ) {
        if let Some(&i) = self.tool_idx.get(id) {
            self.parts[i]["input"] = input.clone();
            return;
        }
        let i = self.parts.len();
        let mut part = if dynamic {
            serde_json::json!({
                "type": "dynamic-tool",
                "toolName": tool_name,
                "toolCallId": id,
                "state": "input-available",
                "input": input,
            })
        } else {
            serde_json::json!({
                "type": format!("tool-{tool_name}"),
                "toolCallId": id,
                "state": "input-available",
                "input": input,
            })
        };
        if let Some(started) = started_at {
            part["callProviderMetadata"] = tool_timing_meta(started, None);
        }
        self.parts.push(part);
        self.tool_idx.insert(id.to_owned(), i);
    }

    /// Patch a tool part with its terminal `output` + state. Mirrors
    /// [`ui_tool_output`]: `error` sets `output-error`, else `output-available`. A
    /// bare output with no matching input part is dropped (not renderable).
    pub(crate) fn tool_output(
        &mut self,
        id: &str,
        output: &Value,
        error: bool,
        timing: Option<(i64, i64)>,
    ) {
        if let Some(&i) = self.tool_idx.get(id) {
            let state = if error {
                "output-error"
            } else {
                "output-available"
            };
            self.parts[i]["state"] = Value::String(state.to_owned());
            self.parts[i]["output"] = output.clone();
            if let Some((started, completed)) = timing {
                self.parts[i]["callProviderMetadata"] = tool_timing_meta(started, Some(completed));
            }
        }
    }

    /// Append an inline `file` part (assistant media block). Mirrors the `file`
    /// chunk the [`acp::AcpEvent::Media`] arm emits.
    pub(crate) fn file(&mut self, media_type: &str, url: &str) {
        self.parts.push(serde_json::json!({
            "type": "file",
            "mediaType": media_type,
            "url": url,
        }));
    }

    /// Append a structured data part emitted alongside the assistant stream.
    /// Data parts are metadata rather than prose, but keeping them in the
    /// persisted reduced UIMessage lets the desktop show the same control
    /// notice after a conversation reload.
    pub(crate) fn data(&mut self, name: &str, data: &Value) {
        self.parts.push(serde_json::json!({
            "type": format!("data-{name}"),
            "data": data,
        }));
    }

    /// Append the terminal error card for a failed assistant turn. Unlike the
    /// AI SDK's stream-level `error` frame, this reduced UIMessage part is stored
    /// with the assistant row so the reason and recovery survive rehydration.
    pub(crate) fn error(&mut self, code: &str, title: &str, message: &str) {
        self.parts.push(serde_json::json!({
            "type": "error",
            "code": code,
            "title": title,
            "message": message,
        }));
    }

    /// Collapse every text part into ONE part carrying `text`, positioned where
    /// the first text part was (appended when the turn produced no text at all).
    ///
    /// Called exactly once, at finalization, when a `message_end` hook rewrote the
    /// reply. Rewriting only `messages.content` would leave the sealed parts
    /// holding the pre-hook text, and the desktop renders `parts` whenever they
    /// exist — so a reloaded conversation would disagree with the message the user
    /// is looking at. Collapsing rather than patching each block is deliberate: the
    /// hook returns one finalized string, so which of several streamed text blocks
    /// a given slice of it belonged to is no longer knowable.
    ///
    /// Dropping parts shifts every later index, so both id→index maps are rebuilt
    /// from the new vector instead of patched. `text_idx` is intentionally left
    /// empty: the block ids that were collapsed no longer name anything, and a
    /// later delta must not append to the rewritten part. Safe because this runs
    /// after the close-out frames, with nothing left to accumulate.
    pub(crate) fn replace_text(&mut self, text: &str) {
        let new_part = serde_json::json!({ "type": "text", "text": text, "state": "done" });
        let old = std::mem::take(&mut self.parts);
        let mut rebuilt: Vec<Value> = Vec::with_capacity(old.len() + 1);
        let mut placed = false;
        for part in old {
            if part.get("type").and_then(Value::as_str) == Some("text") {
                if !placed {
                    rebuilt.push(new_part.clone());
                    placed = true;
                }
                continue;
            }
            rebuilt.push(part);
        }
        if !placed {
            rebuilt.push(new_part);
        }
        self.parts = rebuilt;
        self.text_idx.clear();
        self.tool_idx.clear();
        for (i, part) in self.parts.iter().enumerate() {
            if let Some(id) = part.get("toolCallId").and_then(Value::as_str) {
                self.tool_idx.insert(id.to_owned(), i);
            }
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.parts.is_empty()
    }

    /// Serialize the accumulated parts for the `messages.parts` column. Falls back
    /// to `"[]"` if serialization somehow fails (it cannot for these JSON values).
    pub(crate) fn to_json(&self) -> String {
        serde_json::to_string(&self.parts).unwrap_or_else(|_| "[]".to_owned())
    }
}
