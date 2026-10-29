use super::*;

/// Hand back a worktree whose turn was rejected before it ran. A reused guard
/// returns to the conversation's diff entry, so the next turn keeps working in
/// the same worktree, unless that entry is gone or already holds a guard again.
/// Any other guard is released under the current cleanup policy as it drops.
pub(crate) async fn release_unstarted_worktree(
    worktree_diffs: &crate::server::WorktreeDiffStore,
    conversation_id: Option<&str>,
    guard: Option<WorktreeGuard>,
    reused: bool,
) {
    let mut guard = guard;
    if reused {
        if let Some(conversation_id) = conversation_id {
            let mut store = worktree_diffs.lock().await;
            if let Some(run) = store
                .get_mut(conversation_id)
                .filter(|run| run.guard.is_none())
            {
                if let Some(mut live_guard) = guard.take() {
                    live_guard.suspend_managed_pruning();
                    run.guard = Some(live_guard);
                }
            }
        }
    }
    refresh_managed_worktree_cleanup(&mut guard).await;
}

/// Resolve cleanup at release, so settings changed during the run take effect.
pub(crate) async fn refresh_managed_worktree_cleanup(guard: &mut Option<WorktreeGuard>) {
    let Some(guard) = guard.as_mut() else {
        return;
    };
    guard.suspend_managed_pruning();
    let Some(state) = crate::learning::global_state() else {
        return;
    };
    match crate::server::governance::runtime_worktree_options(&state.preferences).await {
        Ok(options) => guard.update_managed_options(&options),
        Err(error) => {
            tracing::warn!(error = %error, "cleanup settings unavailable; worktree retained")
        }
    }
}

// ── Error helper ──────────────────────────────────────────────────────────────

/// The `error` + `finish` + `[DONE]` frames that terminate a stream on failure,
/// in AI SDK v6 UI message stream form.
pub(crate) fn error_ui_lines(msg: &str) -> [Vec<u8>; 3] {
    [
        ui_chunk(&serde_json::json!({ "type": "error", "errorText": msg })),
        ui_finish(),
        DONE_SSE_LINE.as_bytes().to_vec(),
    ]
}

pub(crate) fn error_stream(msg: String) -> Response {
    let mut payload = ui_start();
    for line in error_ui_lines(&msg) {
        payload.extend_from_slice(&line);
    }
    sse_response(Body::from(payload))
}

// ── AgentAdapter trait ────────────────────────────────────────────────────────

/// Universal adapter trait for AI agents (zeroclaw, openclaw, etc.)
pub trait AgentAdapter: Send + Sync {
    fn name(&self) -> &'static str;
    fn is_available(&self) -> bool;

    fn send_message(
        &self,
        agent_id: &str,
        req: ChatRequest,
    ) -> BoxFuture<anyhow::Result<Vec<ChatChunk>>>;

    fn list_agents(&self) -> BoxFuture<anyhow::Result<Vec<AgentInfo>>>;

    fn create_agent(&self, config: AgentConfig) -> BoxFuture<anyhow::Result<AgentInfo>>;

    fn get_memory(
        &self,
        agent_id: &str,
        query: String,
    ) -> BoxFuture<anyhow::Result<Vec<MemoryEntry>>>;

    fn list_tools(&self, agent_id: &str) -> BoxFuture<anyhow::Result<Vec<ToolInfo>>>;
}
