use super::*;

/// Custom `data-<name>` part — an arbitrary structured payload the desktop reads
/// off `message.parts` (Vercel AI SDK data parts). Used for ACP control events
/// that are neither text nor tool calls: agent-initiated mode changes,
/// interactive tool-permission prompts, and slash-command advertisements.
pub(crate) fn ui_data(name: &str, data: &Value) -> Vec<u8> {
    ui_chunk(&serde_json::json!({ "type": format!("data-{name}"), "data": data }))
}

/// The context handoff a turn runs on, as a transient data part (see
/// `server::with_context_handoff_marker`). Clients that render the transcript
/// marker read it via `onData`; it never lands in the message parts.
pub(crate) fn ui_context_handoff_marker(
    handoff: &crate::server::conversations::ConversationContextHandoff,
) -> Vec<u8> {
    ui_chunk(&serde_json::json!({
        "type": "data-ryu-context-handoff",
        "data": handoff,
        "transient": true,
    }))
}

/// Stable Core message identity created by this exact assistant turn.
///
/// Channel connectors consume this private data part while draining the stream
/// so provider reactions can target the row that produced their outbound
/// message. It is deliberately emitted by the persistence site rather than
/// recovered later with a racy "latest message" query.
pub(crate) fn ui_assistant_message_id(message_id: &str) -> Vec<u8> {
    ui_data(
        "ryu-assistant-message-id",
        &serde_json::json!({ "messageId": message_id }),
    )
}

pub(crate) fn memory_citations_payload(citations: &[MemoryCitation]) -> Value {
    serde_json::json!({ "citations": citations })
}

pub(crate) fn ui_memory_citations(citations: &[MemoryCitation]) -> Vec<u8> {
    ui_data("ryu-memory-citations", &memory_citations_payload(citations))
}

/// The `data-ryu-failover` part announcing a reactive failover verdict — which
/// plan ran out, what happened about it, and when the first window reopens.
///
/// A data part rather than injected text: the decision is metadata about the
/// turn, not part of the answer, so it must not end up in the transcript that
/// gets replayed to the model on the next turn. Surfaces that do not render data
/// parts simply do not show it; the underlying vendor error is still emitted
/// unchanged behind it, so nothing is hidden from a text-only client.
pub(crate) fn ui_failover_note(verdict: &crate::routing_policy::reactive::Verdict) -> Vec<u8> {
    ui_data(
        "ryu-failover",
        &serde_json::to_value(verdict).unwrap_or(Value::Null),
    )
}

/// The same verdict as a visible **text** part — a self-contained text block
/// carrying the note sentence.
///
/// The data part above is a machine-readable record; this is what a human
/// actually sees, and it exists because `/api/chat/stream` is not a desktop-only
/// endpoint. The TUI, the native app and the island all POST to it and none of
/// them renders `data-*` frames, so shipping the explanation only as a data part
/// would mean those surfaces silently receive an answer from a *different
/// subscription* than the one selected — the exact silent-loss-of-control this
/// feature is supposed to prevent.
///
/// Emitted by the failover wrapper, which sits OUTSIDE the inner turn's
/// accumulator, so it is displayed but never persisted and never replayed to the
/// model on the next turn. That is the property that makes it safe to put in the
/// message body rather than in metadata: the transcript stays clean.
///
/// Its own `id` keeps it a separate text block from the answer, so it cannot be
/// concatenated into the reply text by a client that merges deltas by id.
pub(crate) fn ui_failover_text(
    verdict: &crate::routing_policy::reactive::Verdict,
) -> Option<Vec<u8>> {
    let note = verdict.note()?;
    const ID: &str = "ryu-failover-note";
    let mut out = ui_text_start(ID);
    out.extend(ui_text_delta(ID, note));
    out.extend(ui_text_end(ID));
    Some(out)
}
