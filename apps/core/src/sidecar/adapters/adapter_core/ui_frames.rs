use super::*;

// ── AI SDK v6 UI Message Stream encoding ──────────────────────────────────────
//
// The clients (`apps/desktop` via `@ai-sdk/react` `DefaultChatTransport`, and
// `apps/cli`) speak the AI SDK v6 UI Message Stream: SSE frames whose `data:`
// payload is a JSON object with a `type` discriminator. This is the same
// protocol `apps/server`'s `/ai` route emits via `toUIMessageStreamResponse()`.
// Tool calls and results are first-class part types here, which is what lets the
// flagship desktop client render the agent's tool loop (not just final text).

/// Terminal SSE frame the AI SDK expects to close a UI message stream.
pub(crate) const DONE_SSE_LINE: &str = "data: [DONE]\n\n";

/// The terminal `[DONE]` SSE frame bytes. Exposed so the plugin turn-hook wrapper
/// (`server::run_chat_with_hooks`) can withhold each inner turn's `[DONE]` and
/// emit a single terminal one for the whole (possibly multi-turn) response.
pub(crate) fn done_sse_frame() -> Vec<u8> {
    DONE_SSE_LINE.as_bytes().to_vec()
}

/// Whether a forwarded SSE chunk is exactly the terminal `[DONE]` frame.
pub(crate) fn is_done_frame(bytes: &[u8]) -> bool {
    bytes == DONE_SSE_LINE.as_bytes()
}

/// Encode one UI message stream chunk as an SSE `data:` frame.
pub(crate) fn ui_chunk(value: &Value) -> Vec<u8> {
    format!("data: {value}\n\n").into_bytes()
}

/// `start` part — opens the assistant message.
pub(crate) fn ui_start() -> Vec<u8> {
    ui_chunk(&serde_json::json!({ "type": "start" }))
}

/// `text-start` part — opens a streamed text block with a stable id.
pub(crate) fn ui_text_start(id: &str) -> Vec<u8> {
    ui_chunk(&serde_json::json!({ "type": "text-start", "id": id }))
}

/// `text-delta` part — one chunk of streamed assistant text.
pub(crate) fn ui_text_delta(id: &str, delta: &str) -> Vec<u8> {
    ui_chunk(&serde_json::json!({ "type": "text-delta", "id": id, "delta": delta }))
}

/// `text-end` part — closes the streamed text block.
pub(crate) fn ui_text_end(id: &str) -> Vec<u8> {
    ui_chunk(&serde_json::json!({ "type": "text-end", "id": id }))
}

/// Milliseconds since the Unix epoch, the stamp every tool-timing field carries.
pub(crate) fn tool_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// Wall-clock starts for tool calls whose opening frame has gone out, keyed by
/// `toolCallId`.
///
/// Timing is stamped HERE rather than measured in the client because the client
/// can only time a row it watched run: a reopened conversation re-mounts rows
/// that finished days ago, so the desktop deliberately shows nothing for them
/// rather than restarting their clocks. That left exactly the case the user
/// cares about — "did this call take an hour and break?" — unanswerable the
/// moment you reload. A Core stamp makes the duration a property of the
/// persisted part instead of a property of having been watching.
#[derive(Default)]
pub(crate) struct ToolClock(pub(crate) std::collections::HashMap<String, i64>);

impl ToolClock {
    /// Record — or re-use — the start of `id`, returning it.
    ///
    /// Re-use is load-bearing: an ACP `tool_call_update` re-emits
    /// `tool-input-available` under the same id to fill in arguments the opening
    /// frame did not have yet, and a plan/thought snapshot re-emits on every
    /// chunk. Restarting the clock there would erase precisely the wait this is
    /// meant to expose, and a long call would perpetually read as just-started.
    pub(crate) fn start(&mut self, id: &str) -> i64 {
        *self.0.entry(id.to_owned()).or_insert_with(tool_now_ms)
    }

    /// Close `id`, yielding `(started_at, completed_at)`.
    ///
    /// `None` when this stream never opened the call — a bare output frame with
    /// no matching input, which is not renderable anyway.
    pub(crate) fn finish(&mut self, id: &str) -> Option<(i64, i64)> {
        self.0.remove(id).map(|started| (started, tool_now_ms()))
    }
}

/// The `providerMetadata` payload carrying one tool call's timing.
///
/// `providerMetadata` is the sanctioned open channel on an AI SDK tool chunk —
/// it is `Record<string, Record<string, JSONValue>>`, it survives the chunk
/// schema (a bare extra key would be stripped), and the SDK lands it on the part
/// as `callProviderMetadata`, which round-trips through the persisted part
/// schema. Namespaced under `ryu` so it can never collide with a real provider's
/// metadata.
///
/// Note the SDK REPLACES `callProviderMetadata` wholesale on each frame rather
/// than merging, which is why the closing frame repeats `startedAt` instead of
/// contributing `completedAt` alone.
pub(crate) fn tool_timing_meta(started_at: i64, completed_at: Option<i64>) -> Value {
    let mut timing = serde_json::Map::new();
    timing.insert("startedAt".to_owned(), Value::from(started_at));
    if let Some(done) = completed_at {
        timing.insert("completedAt".to_owned(), Value::from(done));
        timing.insert(
            "durationMs".to_owned(),
            Value::from((done - started_at).max(0)),
        );
    }
    serde_json::json!({ "ryu": Value::Object(timing) })
}

/// `tool-input-available` part — a tool call the agent has initiated.
///
/// `dynamic: true` produces a `dynamic-tool` part carrying a clean `toolName`
/// (rendered by the desktop's generic tool row). `dynamic: false` produces a
/// `tool-<Name>` part — the desktop binds rich renderers (Bash terminal, Edit
/// diff, Todo checklist, Thinking, …) to the canonical Claude-style names, so
/// ACP tool calls mapped via [`acp_tool_ui_name`] get the full tool UI.
///
/// `started_at` stamps the call's start (see [`ToolClock`]); `None` leaves the
/// frame byte-identical to an unstamped one.
pub(crate) fn ui_tool_input(
    tool_call_id: &str,
    tool_name: &str,
    input: &Value,
    dynamic: bool,
    started_at: Option<i64>,
) -> Vec<u8> {
    let mut chunk = serde_json::json!({
        "type": "tool-input-available",
        "toolCallId": tool_call_id,
        "toolName": tool_name,
        "input": input,
        "dynamic": dynamic,
    });
    if let Some(started) = started_at {
        chunk["providerMetadata"] = tool_timing_meta(started, None);
    }
    ui_chunk(&chunk)
}

/// `tool-output-available` part — the result of a tool call. The `dynamic`
/// flag must match the part's opening `tool-input-available` frame.
///
/// `timing` is the `(started_at, completed_at)` pair from [`ToolClock::finish`];
/// `None` leaves the frame byte-identical to an unstamped one.
pub(crate) fn ui_tool_output(
    tool_call_id: &str,
    output: &Value,
    dynamic: bool,
    timing: Option<(i64, i64)>,
) -> Vec<u8> {
    let mut chunk = serde_json::json!({
        "type": "tool-output-available",
        "toolCallId": tool_call_id,
        "output": output,
        "dynamic": dynamic,
    });
    if let Some((started, completed)) = timing {
        chunk["providerMetadata"] = tool_timing_meta(started, Some(completed));
    }
    ui_chunk(&chunk)
}

/// `data-tool-widget-available` part (spec §1.1, nested under `data` per D6) — a
/// tool call that resolved to a Ryu App widget. Core has already mapped
/// `structuredContent → toolOutput`, `_meta → toolResponseMetadata` (ryu/widget
/// stripped), and minted the `instanceId` in the MCP bridge; this only
/// serializes the resolved [`acp::ToolWidgetEvent`].
pub(crate) fn ui_tool_widget(w: &crate::sidecar::adapters::acp::ToolWidgetEvent) -> Vec<u8> {
    ui_data(
        "tool-widget-available",
        &serde_json::json!({
            "toolCallId": w.tool_call_id,
            "toolName": w.tool_name,
            "instanceId": w.instance_id,
            "serverId": w.server_id,
            "templateUri": w.template_uri,
            "widget": {
                "html": w.widget_html,
                "mimeType": w.widget_mime,
                "csp": { "resource_domains": w.resource_domains },
            },
            "toolInput": w.tool_input,
            "toolOutput": w.tool_output,
            "toolResponseMetadata": w.tool_response_metadata,
            "widgetAccessible": w.widget_accessible,
            "approvedGrants": w.approved_grants,
            "invoking": w.invoking,
            "invoked": w.invoked,
            "initialWidgetState": w.initial_widget_state,
            "maxHeight": Value::Null,
            "displayMode": w.display_mode,
        }),
    )
}
