use super::*;

use crate::routing_policy::reactive::TurnWatch;
use crate::server::subscription_costs::SubscriptionCostAttribution;
use crate::usage_history::live::TurnHistory;

/// Everything the detached completion task owns, moved in from `route_acp_stream`.
pub(crate) struct AcpCompletionCtx {
    pub(crate) worktree_guard: Option<WorktreeGuard>,
    pub(crate) conversation_id: Option<String>,
    pub(crate) traces: TraceStore,
    pub(crate) live_stream: Option<live_turn::LiveTurnHandle>,
    pub(crate) ui_tx: tokio::sync::mpsc::UnboundedSender<UiFrame>,
    pub(crate) agent_id: String,
    pub(crate) memory_citations: Vec<MemoryCitation>,
    pub(crate) agent_control_applied: Option<crate::agent_control::AgentControlApplied>,
    pub(crate) compaction_summary: Option<String>,
    pub(crate) acp_rx: tokio::sync::mpsc::UnboundedReceiver<acp::AcpEvent>,
    pub(crate) persist_store: ConversationStore,
    pub(crate) persist_conversation_id: Option<String>,
    pub(crate) persist_agent_id: Option<String>,
    pub(crate) watch: TurnWatch,
    pub(crate) watch_model: Option<String>,
    pub(crate) history_turn: TurnHistory,
    pub(crate) conversation_generation: Option<String>,
    pub(crate) cwd: PathBuf,
    pub(crate) harness_session_id: Option<String>,
    pub(crate) cost_attribution: Option<SubscriptionCostAttribution>,
    pub(crate) plugin_flags: std::collections::HashMap<String, bool>,
    pub(crate) worktree_diffs: crate::server::WorktreeDiffStore,
}

/// Sink for rendered frames: the original HTTP client plus the live-turn broadcast.
pub(crate) struct AcpEmitter {
    pub(crate) live_stream: Option<live_turn::LiveTurnHandle>,
    pub(crate) ui_tx: tokio::sync::mpsc::UnboundedSender<UiFrame>,
}

impl AcpEmitter {
    // Helper: send a frame to both the original HTTP client (ui_tx_clone)
    // and the live stream broadcast (for reconnecting clients).
    pub(crate) fn emit(&self, f: UiFrame) {
        if let Some(ref ls) = self.live_stream {
            ls.publish(&f);
        }
        let _ = self.ui_tx.send(f);
    }
}

/// Turn-wide handles the completion task's event handlers read.
#[derive(Clone, Copy)]
pub(crate) struct AcpTurnRefs<'a> {
    pub(crate) persist_store: &'a ConversationStore,
    pub(crate) persist_conversation_id: &'a Option<String>,
    pub(crate) persist_agent_id: &'a Option<String>,
    pub(crate) conversation_id: &'a Option<String>,
    pub(crate) agent_id: &'a String,
    pub(crate) watch: &'a TurnWatch,
    pub(crate) traces: &'a TraceStore,
}

/// The detached completion task: drain ACP events into UI frames, persist, finalize.
pub(crate) async fn run_acp_completion(ctx: AcpCompletionCtx) {
    let AcpCompletionCtx {
        worktree_guard,
        conversation_id,
        traces,
        live_stream,
        ui_tx,
        agent_id,
        memory_citations,
        agent_control_applied,
        compaction_summary,
        mut acp_rx,
        persist_store,
        persist_conversation_id,
        persist_agent_id,
        watch,
        watch_model,
        mut history_turn,
        conversation_generation,
        cwd,
        harness_session_id,
        cost_attribution,
        plugin_flags,
        worktree_diffs,
    } = ctx;
    let mut em = AcpEmitter { live_stream, ui_tx };
    // After stream completes the guard is transferred into WorktreeRun
    // (so the worktree survives for apply). If abandoned before completion
    // the guard drops here and cleans up via its Drop impl.
    let mut guard = worktree_guard;
    // Ends this conversation's `agent_run` trace scope when the turn task
    // finishes (a no-op when no run scope is active).
    let mut run_finisher = conversation_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(|conversation| traces.run_finisher(conversation));
    let refs = AcpTurnRefs {
        persist_store: &persist_store,
        persist_conversation_id: &persist_conversation_id,
        persist_agent_id: &persist_agent_id,
        conversation_id: &conversation_id,
        agent_id: &agent_id,
        watch: &watch,
        traces: &traces,
    };
    let mut st = AcpTurnState::new(&conversation_id, &agent_id);
    st.prologue(
        &em,
        &memory_citations,
        &agent_control_applied,
        compaction_summary,
    );

    while let Some(event) = acp_rx.recv().await {
        st.checkpoint_persist(&em, refs).await;
        match event {
            acp::AcpEvent::UserText(text) => acp_forward_user_text(&em, text),
            acp::AcpEvent::Banner(text) => acp_forward_banner(&em, text),
            acp::AcpEvent::Text(text) => st.on_text(&em, refs, text).await,
            acp::AcpEvent::Thought(text) => st.on_thought(&em, refs, text),
            acp::AcpEvent::Plan(entries) => st.on_plan(&em, refs, entries),
            acp::AcpEvent::ToolCall {
                id,
                title,
                kind,
                input,
                locations,
            } => {
                st.on_tool_call(&em, refs, id, title, kind, input, locations)
                    .await
            }
            acp::AcpEvent::ToolResult {
                id,
                status,
                output,
                input,
            } => {
                st.on_tool_result(&em, refs, id, status, output, input)
                    .await
            }
            acp::AcpEvent::ToolSteps {
                parent_id,
                steps,
                final_answer,
            } => st.on_tool_steps(&em, refs, parent_id, steps, final_answer),
            acp::AcpEvent::ToolWidget(w) => {
                // A tool call resolved to a Ryu App widget (D1): emit the
                // `data-tool-widget-available` part in addition to the tool
                // row (already emitted for the same tool). Emit-only, like the
                // other data parts — reload re-emits from the resource cache.
                em.emit(ui_tool_widget(&w));
            }
            acp::AcpEvent::Media { mime, data } => {
                // A non-text assistant content block (inline image/audio).
                // Forward as an AI-SDK v6 `file` part carrying a data URL so the
                // desktop renders it inline (previously dropped). Close any open
                // thought first for clean part ordering.
                st.close_thought(&em);
                let url = format!("data:{mime};base64,{data}");
                st.acc.file(&mime, &url);
                em.emit(ui_chunk(&serde_json::json!({
                    "type": "file",
                    "mediaType": mime,
                    "url": url,
                })));
            }
            acp::AcpEvent::ModeChanged(mode_id) => {
                // Agent-initiated mode switch; forward so the desktop's mode
                // picker reflects the new active mode.
                em.emit(ui_data(
                    "ryu-acp-mode",
                    &serde_json::json!({ "currentModeId": mode_id }),
                ));
            }
            acp::AcpEvent::ConfigWarning {
                field,
                requested,
                message,
            } => {
                // Non-fatal: a session control the user chose (e.g. the model
                // pick) was not accepted by the agent. Forward as a data part
                // so the UI can react — e.g. clear a model pick the agent never
                // applied — instead of silently misleading the user (QA B2).
                em.emit(ui_data(
                    "ryu-acp-config-warning",
                    &serde_json::json!({
                        "field": field,
                        "requested": requested,
                        "message": message,
                    }),
                ));
            }
            acp::AcpEvent::ConfigUpdate(updates) => {
                // A tool result asked the CLIENT to update session config values
                // it holds and re-sends every turn (`details.ryuConfig`). Forward
                // as a data part; the desktop adopts each pair into its option
                // state AND persists it, so the NEXT turn carries the new value.
                // Advisory: Core keeps no session config state of its own here and
                // does not validate the ids — a client ignores what it doesn't hold.
                em.emit(ui_data(
                    "ryu-acp-config",
                    &serde_json::json!({ "config": updates }),
                ));
            }
            acp::AcpEvent::AvailableCommands(commands) => {
                // Agent published its slash commands; forward the full list so
                // the desktop replaces its cached set and renders the `/` popover.
                em.emit(ui_data(
                    "ryu-acp-commands",
                    &serde_json::json!({ "commands": commands }),
                ));
            }
            acp::AcpEvent::AuthNeeded { agent_id, message } => {
                // The agent needs the user to log in again (an expired OAuth /
                // subscription token). A data part rather than an error frame:
                // the turn is recoverable, and the client can render the
                // agent's own advertised `authMethods` as a "Log in again"
                // action rather than a dead-end failure. The desktop already
                // owns the flow behind `POST /api/agents/:id/authenticate`.
                em.emit(ui_data(
                    "ryu-acp-auth-required",
                    &serde_json::json!({ "agentId": agent_id, "message": message }),
                ));
            }
            acp::AcpEvent::ConfigOptions(options) => {
                // The agent re-published its session config options, either in
                // answer to `session/set_config_option` or unprompted. Forward
                // the full list so the composer's per-agent pickers replace
                // their cached set — this is how an option that only exists for
                // another option's VALUE (codex's reasoning effort, revealed
                // once a model that has one is picked) reaches the client at
                // all. Same replace-wholesale contract as `ryu-acp-commands`.
                em.emit(ui_data(
                    "ryu-acp-config-options",
                    &serde_json::json!({ "configOptions": options }),
                ));
            }
            acp::AcpEvent::SessionInfo(info) => {
                acp_record_session_info(
                    &em,
                    refs,
                    &mut history_turn,
                    &conversation_generation,
                    &cwd,
                    &harness_session_id,
                    info,
                )
                .await
            }
            acp::AcpEvent::Usage(u) => st.on_usage(&em, refs, &history_turn, &cost_attribution, u),
            acp::AcpEvent::PermissionRequest {
                request_id,
                tool_call,
                options,
            } => {
                // The agent paused to ask for tool approval. Close any open
                // text/thought block so the prompt renders as its own element,
                // then surface the options; the desktop POSTs the chosen
                // option id to /api/chat/permission to unblock the agent.
                st.close_thought(&em);
                st.close_text(&em);
                em.emit(ui_data(
                    "ryu-permission",
                    &serde_json::json!({
                        "requestId": request_id,
                        "toolCall": tool_call,
                        "options": options,
                    }),
                ));
            }
            acp::AcpEvent::QuestionRequest {
                tool_call_id,
                input,
            } => {
                // The ACP request handler owns the live responder and waits
                // on the same question registry that /api/chat/question
                // resolves. This frame is display-only; completion arrives
                // from ACP after the responder receives the answer.
                st.close_thought(&em);
                st.close_text(&em);
                let started = st.tool_clock.start(&tool_call_id);
                st.tool_dynamic.insert(tool_call_id.clone(), false);
                em.emit(ui_tool_input(
                    &tool_call_id,
                    "Question",
                    &input,
                    false,
                    Some(started),
                ));
                st.acc
                    .tool_input(&tool_call_id, "Question", &input, false, Some(started));
            }
            acp::AcpEvent::Error(failure) => {
                st.on_error_exit(
                    &mut em,
                    refs,
                    &watch_model,
                    &mut run_finisher,
                    &mut guard,
                    failure,
                )
                .await;
                return;
            }
        }
    }

    st.finish_turn(&mut em, refs, &plugin_flags, &worktree_diffs, &mut guard)
        .await;
    // _guard drops here — worktree removed after diff captured
}
