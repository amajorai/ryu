use super::*;

/// Write the assistant reply to the conversation store. Called after a stream
/// completes; a no-op when there is no `conversation_id` or the reply is empty.
/// Write the assistant reply to the conversation store and update run_status.
/// Called after a stream completes; a no-op when there is no `conversation_id`.
/// `outcome` is "completed" on clean end, "failed" on error.
/// Crash checkpoint for a streaming OpenAI-compatible reply.
///
/// That path used to write its assistant row once, at the turn's terminal exit,
/// so a Core crash, force-quit or OOM mid-reply lost the whole answer. Now a
/// reply still streaming [`REPLY_CHECKPOINT_INTERVAL`] after its first token gets
/// its row created, then rewritten at most once per interval. The terminal
/// [`persist_assistant_reply`] updates that row instead of appending a second
/// one. A reply that finishes inside the first interval — most of them — makes
/// exactly the single write it always did. The interval bounds both crash loss
/// and the cost of rewriting the whole reply, as on the ACP path.
#[derive(Clone)]
pub(crate) struct ReplyCheckpoint {
    pub(crate) store: ConversationStore,
    pub(crate) conversation_id: String,
    pub(crate) agent_id: Option<String>,
    pub(crate) state: Arc<tokio::sync::Mutex<ReplyCheckpointState>>,
}

#[derive(Default)]
pub(crate) struct ReplyCheckpointState {
    message_id: Option<String>,
    /// When text was first observed, then when it was last written.
    pub(crate) due_from: Option<std::time::Instant>,
    written_len: usize,
}

pub(crate) const REPLY_CHECKPOINT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

impl ReplyCheckpoint {
    pub(crate) fn new(
        store: ConversationStore,
        conversation_id: String,
        agent_id: Option<String>,
    ) -> Self {
        Self {
            store,
            conversation_id,
            agent_id,
            state: Arc::default(),
        }
    }

    /// Note the reply so far (`settled` from finished tool rounds plus the
    /// round in progress) and write it if a checkpoint is due. Cheap when not
    /// due: no allocation, no I/O.
    pub(crate) async fn observe(&self, settled: &str, current: &str) {
        let mut state = self.state.lock().await;
        let len = settled.len() + current.len();
        if len == 0 || len == state.written_len {
            return;
        }
        let Some(due_from) = state.due_from else {
            state.due_from = Some(std::time::Instant::now());
            return;
        };
        if due_from.elapsed() < REPLY_CHECKPOINT_INTERVAL {
            return;
        }
        let reply = format!("{settled}{current}");
        match state.message_id.clone() {
            Some(message_id) => {
                if let Err(e) = self.store.update_message_content(&message_id, &reply).await {
                    tracing::warn!("failed to checkpoint assistant reply: {e:#}");
                }
            }
            None => match self
                .store
                .append_message_as(
                    &self.conversation_id,
                    "assistant",
                    &reply,
                    self.agent_id.as_deref(),
                    None,
                    None,
                    Tenancy::Unattributed, // row exists; owner preserved by COALESCE
                )
                .await
            {
                Ok(message_id) => state.message_id = Some(message_id),
                Err(e) => tracing::warn!("failed to create checkpoint assistant row: {e:#}"),
            },
        }
        state.written_len = len;
        state.due_from = Some(std::time::Instant::now());
    }

    pub(crate) async fn message_id(&self) -> Option<String> {
        self.state.lock().await.message_id.clone()
    }
}

pub(crate) async fn persist_assistant_reply(
    store: ConversationStore,
    conversation_id: Option<String>,
    agent_id: Option<String>,
    reply: String,
    outcome: &'static str,
    memory_citations: Vec<MemoryCitation>,
    checkpoint: Option<ReplyCheckpoint>,
    data_parts: Vec<Value>,
) -> Option<String> {
    let Some(conversation_id) = conversation_id else {
        return None;
    };
    let checkpointed_id = match checkpoint.as_ref() {
        Some(checkpoint) => checkpoint.message_id().await,
        None => None,
    };
    let mut persisted_message_id = None;
    if !reply.is_empty() {
        let written = match checkpointed_id {
            // The row already exists: finish it rather than appending a twin.
            Some(message_id) => store
                .update_message_content(&message_id, &reply)
                .await
                .map(|_| message_id),
            None => {
                store
                    .append_message_as(
                        &conversation_id,
                        "assistant",
                        &reply,
                        agent_id.as_deref(),
                        None,
                        None,
                        Tenancy::Unattributed, // row exists; owner preserved by COALESCE
                    )
                    .await
            }
        };
        match written {
            Ok(message_id) if !(memory_citations.is_empty() && data_parts.is_empty()) => {
                // Sealed parts: the reply text, then the metadata parts the live
                // turn showed beside it (memory citations, the turn's usage
                // stats), so a reloaded conversation renders the same footer
                // and context meter instead of nothing.
                let mut parts = vec![serde_json::json!({
                    "type": "text",
                    "text": reply,
                    "state": "done",
                })];
                if !memory_citations.is_empty() {
                    parts.push(serde_json::json!({
                        "type": "data-ryu-memory-citations",
                        "data": memory_citations_payload(&memory_citations),
                    }));
                }
                parts.extend(data_parts);
                if let Err(e) = store
                    .update_message_parts(&message_id, &Value::Array(parts).to_string())
                    .await
                {
                    tracing::warn!("failed to persist assistant message parts: {e:#}");
                }
                persisted_message_id = Some(message_id);
            }
            Ok(message_id) => persisted_message_id = Some(message_id),
            Err(e) => tracing::warn!("failed to persist assistant reply: {e:#}"),
        }
    }
    if let Err(e) = store.set_run_status(&conversation_id, outcome).await {
        tracing::warn!("failed to set run_status to {outcome}: {e:#}");
    }
    persisted_message_id
}
