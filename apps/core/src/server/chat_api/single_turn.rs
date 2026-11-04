//! Cloud-account auth handlers and the chat turn pipeline with its plugin hooks: `route_single_turn_once` through `action_summary_frame`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Run one chat turn: resolve the per-turn skills-disclosure + auto-recall config,
/// then hand off to the single-agent route. Extracted so the plugin turn-hook
/// wrapper can re-run a turn during a `continue` loop.
pub(in crate::server) async fn route_single_turn_once(
    state: &ServerState,
    mut req: crate::sidecar::adapters::ChatStreamRequest,
    watch: crate::routing_policy::reactive::TurnWatch,
) -> axum::response::Response {
    // Resolve the auto sentinel before deriving memory access, then keep the
    // concrete id on the request so the router and memory layer use the same
    // agent and the classifier runs only once for this turn.
    let auto_target = match (req.target_agent_id.as_deref(), req.agent_id.as_deref()) {
        (Some(id), _) if id == crate::agent_routing::AUTO_AGENT_ID => Some(true),
        (None, Some(id)) if id == crate::agent_routing::AUTO_AGENT_ID => Some(false),
        _ => None,
    };
    if let Some(is_target) = auto_target {
        let user_text = req
            .messages
            .iter()
            .rev()
            .find(|message| message.role == "user")
            .map(crate::sidecar::adapters::ui_message_text)
            .unwrap_or_default();
        let resolved =
            crate::agent_routing::resolve_auto_agent(&user_text, req.conversation_id.as_deref())
                .await;
        if is_target {
            req.target_agent_id = Some(resolved);
        } else {
            req.agent_id = Some(resolved);
        }
    }
    // Apply the global skills disclosure mode (progressive vs full) from the pref
    // so the ACP chat path injects the L1 index + loads on demand (default) or the
    // full skill bodies. Cheap pref read; mirrors the per-request recall resolution.
    apply_skills_disclosure(state).await;
    // Resolve auto-recall (U17) config from prefs/env. Default ON; encoded as
    // `Some`/`None` so a disabled feature does zero work inside route_chat_stream.
    let memory_principal_available = node_org_id().is_none() || req.author_user_id.is_some();
    let temporary_context_enabled = req.persist
        || req
            .plugin_flags
            .get(crate::memory_policy::TEMPORARY_CONTEXT_FLAG)
            .copied()
            .unwrap_or(false);
    let recall = if memory_principal_available
        && temporary_context_enabled
        && resolve_auto_recall_enabled(state).await
    {
        // A council/mention target takes precedence over the ordinary agent id
        // during routing. Use the same explicit target for memory access, or an
        // agent-scoped fact can be recalled for the wrong agent on this turn.
        let memory_agent_id = req.target_agent_id.clone().or_else(|| req.agent_id.clone());
        // Resolve the active agent's memory access from its MemorySlot: which
        // scope levels it may recall and which Spaces it may inject. Missing agent
        // / slot => empty vecs, which mean "all levels, no Spaces" (back-compat).
        let (read_levels, space_ids) =
            resolve_memory_access(state, memory_agent_id.as_deref()).await;
        let memory_owner = if node_org_id().is_some() {
            req.author_user_id
                .as_deref()
                .map(str::to_owned)
                .unwrap_or_else(background_memory_user_id)
        } else {
            memory::LOCAL_USER.to_owned()
        };
        Some(crate::sidecar::adapters::AutoRecallConfig {
            retrieval: state.retrieval.clone(),
            top_k: resolve_auto_recall_top_k(state).await,
            // FTS (lexical) session search is a sub-source of auto-recall: default
            // OFF, only contributes when explicitly enabled. Resolved here so a
            // disabled feature does zero FTS work inside route_chat_stream.
            fts_enabled: resolve_fts_recall_enabled(state).await,
            read_levels,
            space_ids,
            caller_user_id: req.author_user_id.clone(),
            agent_id: memory_agent_id,
            include_sensitive_topics: state
                .memory
                .include_sensitive_topics(&memory_owner)
                .await
                .unwrap_or(false),
        })
    } else {
        None
    };
    // App-level context-window config (off by default). Resolved here, on the
    // interactive chat path, mirroring the recall resolution above.
    let ctx_window = resolve_context_window(state, &req).await;
    // A model change may have handed the earlier history off as a summary
    // (`context.handoff-on-model-change`, default: only when the new model's
    // window is smaller and the history no longer fits).
    let mut req = req;
    let handoff = context_handoff::resolve(state, &req).await;
    req.context_handoff = handoff.as_ref().and_then(context_handoff::applied);
    let response = route_chat_stream(
        req,
        Arc::clone(&state.agents),
        state.conversations.clone(),
        state.agent_store.clone(),
        Arc::clone(&state.manager),
        state.memory.clone(),
        Arc::clone(&state.worktree_diffs),
        Arc::clone(&state.mcp),
        state.skills.clone(),
        state.traces.clone(),
        recall,
        ctx_window,
        watch,
        state.subscription_costs.clone(),
    )
    .await;
    match handoff {
        Some(handoff) => context_handoff::with_marker(response, &handoff),
        None => response,
    }
}

/// Resolve an agent's memory access — the scope levels it may recall from and the
/// Space ids it may inject — from its persisted `MemorySlot`. Returns
/// `(read_levels, space_ids)`; both empty when the agent, or its memory slot, is
/// absent (meaning "all levels, no Spaces", the back-compat default enforced in
/// `run_auto_recall`).
pub(in crate::server) async fn resolve_memory_access(
    state: &ServerState,
    agent_id: Option<&str>,
) -> (Vec<String>, Vec<String>) {
    let Some(id) = agent_id.filter(|s| !s.is_empty()) else {
        return (Vec::new(), Vec::new());
    };
    match state.agent_store.get(id).await {
        Ok(Some(agent)) => match agent.memory {
            Some(slot) => (slot.read_levels, slot.space_ids),
            None => (Vec::new(), Vec::new()),
        },
        Ok(None) => (Vec::new(), Vec::new()),
        Err(e) => {
            tracing::warn!("resolve_memory_access: agent lookup failed for {id}: {e:#}");
            (Vec::new(), Vec::new())
        }
    }
}

/// Build the post-assistant-turn hook context from the persisted transcript
/// (most-recent 20 messages) + the request's plugin flags.
pub(in crate::server) async fn build_hook_context(
    state: &ServerState,
    conversation_id: &str,
    agent_id: Option<&str>,
    caller_user_id: Option<&str>,
    verified_caller: Option<&crate::identity_verify::VerifiedCaller>,
    flags: &std::collections::HashMap<String, bool>,
) -> crate::plugin_host::HookContext {
    const MAX_TRANSCRIPT: usize = 20;
    let transcript = match state
        .conversations
        .get_active_messages(conversation_id)
        .await
    {
        Ok(msgs) => {
            let skip = msgs.len().saturating_sub(MAX_TRANSCRIPT);
            msgs.into_iter()
                .skip(skip)
                .map(|m| crate::plugin_host::HookMessage {
                    role: m.role,
                    content: m.content,
                })
                .collect()
        }
        Err(e) => {
            tracing::warn!("plugin_host: could not load transcript for hooks: {e}");
            Vec::new()
        }
    };
    crate::plugin_host::HookContext {
        conversation_id: Some(conversation_id.to_string()),
        agent_id: agent_id.map(str::to_string),
        caller_user_id: caller_user_id.map(str::to_string),
        verified_caller: verified_caller.cloned(),
        transcript,
        flags: flags.clone(),
        input: None,
        ..Default::default()
    }
}

/// The process-global plugin-hook dispatcher: holds a [`ServerState`] so hook
/// phases fired from code with no `State` extractor in scope (the tool-dispatch
/// core, the delegation engine, the notification fan-out) can still run their
/// hooks. Installed once at boot by [`install_global_hook_dispatcher`].
pub(in crate::server) struct GlobalHookDispatcher {
    pub(in crate::server) state: ServerState,
}

impl crate::plugin_host::HookDispatch for GlobalHookDispatcher {
    fn dispatch<'a>(
        &'a self,
        phase: &'a str,
        ctx: crate::plugin_host::HookContext,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Vec<crate::plugin_host::HookDirective>> + Send + 'a>,
    > {
        Box::pin(async move { crate::plugin_host::dispatch_phase(&self.state, phase, &ctx).await })
    }

    fn dispatch_tool_result<'a>(
        &'a self,
        ctx: crate::plugin_host::HookContext,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<serde_json::Value>> + Send + 'a>>
    {
        Box::pin(
            async move { crate::plugin_host::dispatch_tool_result_phase(&self.state, &ctx).await },
        )
    }
}

/// Install the global hook dispatcher (idempotent). Called from `main` after the
/// `ServerState` is built.
pub fn install_global_hook_dispatcher(state: ServerState) {
    crate::plugin_host::set_global(std::sync::Arc::new(GlobalHookDispatcher { state }));
}

/// Build the pre-user-turn hook context from the OUTGOING request — the pending
/// user message has not been sent to the model or persisted yet, so it comes from
/// `req.messages`, not the store. `input` is the last user message's text (what a
/// `pre_user_turn` hook rewrites); the recent request messages become the
/// transcript so the hook's `match` gate (flag / slash-command prefix) can
/// evaluate. Used by the auto-expand prompt-improver.
pub(in crate::server) fn build_pre_hook_context(
    req: &crate::sidecar::adapters::ChatStreamRequest,
    flags: &std::collections::HashMap<String, bool>,
) -> crate::plugin_host::HookContext {
    const MAX_TRANSCRIPT: usize = 20;
    let skip = req.messages.len().saturating_sub(MAX_TRANSCRIPT);
    let transcript: Vec<crate::plugin_host::HookMessage> = req
        .messages
        .iter()
        .skip(skip)
        .map(|m| crate::plugin_host::HookMessage {
            role: m.role.clone(),
            content: crate::sidecar::adapters::ui_message_text(m),
        })
        .collect();
    let input = transcript
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone());
    crate::plugin_host::HookContext {
        conversation_id: req.conversation_id.clone(),
        agent_id: req.agent_id.clone(),
        caller_user_id: req.author_user_id.clone(),
        verified_caller: req.verified_caller.clone(),
        transcript,
        flags: flags.clone(),
        input,
        ..Default::default()
    }
}

/// Build the next-turn request for a `continue` directive: reload the full
/// transcript and append the injected user turn (`text`). `route_chat_stream`
/// persists that final user turn + the next assistant reply, so the server-side
/// loop is recorded exactly like a normal turn.
pub(in crate::server) async fn continue_turn_request(
    state: &ServerState,
    prev: &crate::sidecar::adapters::ChatStreamRequest,
    conversation_id: &str,
    text: String,
) -> crate::sidecar::adapters::ChatStreamRequest {
    use crate::sidecar::adapters::{UiContent, UiMessage};
    let mut messages: Vec<UiMessage> = match state
        .conversations
        .get_active_messages(conversation_id)
        .await
    {
        Ok(msgs) => msgs
            .into_iter()
            .map(|m| UiMessage {
                metadata: None,
                role: m.role,
                content: UiContent::Text(m.content),
                parts: Vec::new(),
            })
            .collect(),
        Err(_) => prev.messages.clone(),
    };
    messages.push(UiMessage {
        metadata: None,
        role: "user".to_string(),
        content: UiContent::Text(text),
        parts: Vec::new(),
    });
    let mut next = prev.clone();
    next.messages = messages;
    next.persist = true;
    next
}

/// One `data-plugin_note` AI-SDK custom data part frame carrying a hook's note
/// (e.g. double-check's review). The client renders it out-of-band; it never
/// enters chat history.
pub(in crate::server) fn plugin_note_frame(text: &str) -> Vec<u8> {
    plugin_note_frame_with_question(text, None)
}

/// The optional question is the shared first-person intent bridge. Existing
/// note consumers can keep reading `text`; approval-aware clients can render
/// `question` above it without treating an observer note as an approval gate.
pub(in crate::server) fn plugin_note_frame_with_question(
    text: &str,
    question: Option<&str>,
) -> Vec<u8> {
    let mut data = serde_json::json!({ "text": text });
    if let Some(question) = question.map(str::trim).filter(|value| !value.is_empty()) {
        data["question"] = serde_json::Value::String(question.to_owned());
    }
    let value = serde_json::json!({ "type": "data-plugin_note", "data": data });
    format!("data: {value}\n\n").into_bytes()
}

#[derive(Debug)]
pub(in crate::server) struct ActionSummaryNote {
    pub(in crate::server) question: Option<String>,
    pub(in crate::server) sequence: u64,
    pub(in crate::server) text: String,
}

pub(in crate::server) const ACTION_SUMMARY_DRAIN_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(2);

pub(in crate::server) fn action_summary_frame(notes: &mut [ActionSummaryNote]) -> Vec<u8> {
    notes.sort_by_key(|note| note.sequence);
    let mut text = String::from("Action summary");
    for note in notes.iter() {
        text.push_str("\n\n");
        text.push_str(&note.text);
    }
    let question = notes.iter().rev().find_map(|note| note.question.as_deref());
    plugin_note_frame_with_question(&text, question)
}
