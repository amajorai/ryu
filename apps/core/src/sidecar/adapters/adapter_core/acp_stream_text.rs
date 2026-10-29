use super::*;

// A USER message chunk (ACP `user_message_chunk`). Surfaced as a
// data part rather than dropped, and kept OUT of the assistant
// `reply` buffer. No-op for empty chunks.
//
// INERT FORWARD-PLUMBING — `data-ryu-acp-user` has NO consumer
// anywhere in the repo (`git grep ryu-acp-user` returns only this
// line), and there is no generic unknown-`data-*` fallback. Do
// NOT "finish" it by adding a renderer without first fixing the
// premise below; an audit already proposed exactly that and the
// proposal was wrong on three counts:
//
//   1. The comment this replaces said the chunk comes "chiefly
//      from a `session/load` history replay". It cannot.
//      `load_acp_session` opens its own short-lived connection
//      that sends `initialize` + `LoadSessionRequest` and reads
//      the response; this arm lives on the LIVE prompt
//      connection. So the only way it fires is an agent echoing
//      the message the user just sent — which a renderer would
//      DOUBLE on screen.
//   2. Nothing calls the resume path anyway: the route
//      `POST /api/agents/:id/sessions/:sid/load` has no caller in
//      the desktop, core-client or TUI.
//   3. `emit` fans out to the live stream only — it never
//      reaches the `PartsAccumulator`, so this cannot survive a
//      reload. And that accumulator is the ASSISTANT row's parts
//      array, so pushing a user turn into it would persist a user
//      message as part of an assistant message.
//
// Before building any consumer: capture a live agent actually
// sending `user_message_chunk` (the probe captures in
// jobs/006aadd6/tmp/acp-probes/*.json show none do), and decide
// echo-vs-replay from that evidence. If it never fires, delete
// this arm and its `AcpEvent::UserText` plumbing instead.
pub(crate) fn acp_forward_user_text(em: &AcpEmitter, text: String) {
    if text.is_empty() {
        return;
    }
    em.emit(ui_data(
        "ryu-acp-user",
        &serde_json::json!({ "text": text }),
    ));
}

// The agent's `session/new` startup banner (pi-acp's skills /
// commands listing and available-update notice). It arrives as
// an `agent_message_chunk` but is not an answer to anything —
// the user has not spoken yet — so it gets the same treatment
// as the user-echo above: surfaced as a data part the client
// can render as agent chrome, and kept OUT of the assistant
// `reply` buffer so it is never persisted as an assistant
// message row. This is what stopped a fresh chat opening with
// the machine's whole skills list already in it.
//
// INERT FORWARD-PLUMBING, same as the user-echo above:
// `data-ryu-acp-startup` has NO consumer (`git grep
// ryu-acp-startup` returns only this line). The suppression half
// shipped and works; the render half never did, so this content
// is currently invisible rather than relocated. That is the
// safer of the two states — rendering it as an ordinary message
// bubble would recreate the exact bug the suppression fixed, and
// the probe captures show no agent sending the
// `_meta.piAcp.startupInfo` this reads. If a consumer is ever
// built it must be collapsed agent chrome, not a bubble;
// otherwise delete this arm and the `AcpEvent::Banner` plumbing.
pub(crate) fn acp_forward_banner(em: &AcpEmitter, text: String) {
    if text.is_empty() {
        return;
    }
    em.emit(ui_data(
        "ryu-acp-startup",
        &serde_json::json!({ "text": text }),
    ));
}

/// Session metadata: usage history, the ACP binding ledger, the native session id.
pub(crate) async fn acp_record_session_info(
    em: &AcpEmitter,
    refs: AcpTurnRefs<'_>,
    history_turn: &mut crate::usage_history::live::TurnHistory,
    conversation_generation: &Option<String>,
    cwd: &PathBuf,
    harness_session_id: &Option<String>,
    info: Value,
) {
    let AcpTurnRefs {
        persist_store,
        persist_conversation_id,
        persist_agent_id,
        ..
    } = refs;
    history_turn.session_info(&info);
    // Session metadata is agent-provided ACP state. Keep it as
    // data rather than pretending it was assistant prose.
    if let (Some(conversation_id), Some(session_id), Some(generation)) = (
        persist_conversation_id.as_deref(),
        info.get("sessionId").and_then(Value::as_str),
        conversation_generation.as_deref(),
    ) {
        if let Some(store) = crate::server::agent_sync::global_store() {
            let agent_id = persist_agent_id.as_deref().unwrap_or("unknown");
            let engine = agent_id.strip_prefix("acp:").unwrap_or(agent_id);
            if let Err(error) = store
                .record_acp_binding_async(
                    conversation_id,
                    agent_id,
                    engine,
                    session_id,
                    Some(&cwd),
                    info.get("capabilities").unwrap_or(&Value::Null),
                    generation,
                )
                .await
            {
                tracing::debug!("agent sync: ACP binding ledger update skipped: {error:#}");
            }
        }
    }
    if let (Some(harness_id), Some(native_id)) = (
        harness_session_id.as_deref(),
        info.get("sessionId").and_then(Value::as_str),
    ) {
        if let Err(error) = persist_store
            .set_session_native_id(harness_id, native_id)
            .await
        {
            tracing::debug!("harness: native session binding update skipped: {error:#}");
        }
    }
    em.emit(ui_data("ryu-acp-session-info", &info));
}

impl AcpTurnState {
    /// Reply text: incremental persistence plus the text part's frames.
    pub(crate) async fn on_text(&mut self, em: &AcpEmitter, refs: AcpTurnRefs<'_>, text: String) {
        let AcpTurnRefs {
            persist_store,
            persist_conversation_id,
            persist_agent_id,
            watch,
            ..
        } = refs;
        if text.is_empty() {
            return;
        }
        if self.first_response_at.is_none() {
            self.first_response_at = Some(std::time::Instant::now());
        }
        self.close_thought(em);
        self.reply.push_str(&text);
        self.bytes_since_flush += text.len();

        // Incremental persistence: create the message row on the
        // first text chunk, then update it periodically so the
        // reply survives a client disconnect.
        if let Some(ref conv_id) = persist_conversation_id {
            if self.persisted_msg_id.is_none() {
                // First chunk — insert the row with whatever we have so far.
                match persist_store
                    .append_message_as(
                        conv_id,
                        "assistant",
                        &self.reply,
                        persist_agent_id.as_deref(),
                        None,
                        None,
                        Tenancy::Unattributed, // row exists (stamped by chat_stream)
                    )
                    .await
                {
                    Ok(mid) => {
                        self.persisted_msg_id = Some(mid);
                        self.bytes_since_flush = 0;
                    }
                    Err(e) => {
                        tracing::warn!("failed to create incremental assistant message: {e:#}")
                    }
                }
            } else if self.bytes_since_flush >= INCREMENTAL_FLUSH_BYTES {
                // Periodic flush — update the existing row.
                if let Some(ref mid) = self.persisted_msg_id {
                    if let Err(e) = persist_store.update_message_content(mid, &self.reply).await {
                        tracing::warn!("failed to flush incremental reply: {e:#}");
                    }
                }
                self.bytes_since_flush = 0;
            }
        }

        if !self.text_open {
            self.text_open = true;
            let id = format!("{TEXT_ID}-{}", self.text_seq);
            em.emit(ui_text_start(&id));
        }
        let id = format!("{TEXT_ID}-{}", self.text_seq);
        // Past this point the user is reading an answer, so a later
        // failure can no longer be retried on another plan without
        // stacking a second answer on top of this one.
        watch.mark_content();
        em.emit(ui_text_delta(&id, &text));
        self.acc.text_delta(&id, &text);
    }

    /// A reasoning chunk, coalesced into the live Thinking part.
    pub(crate) fn on_thought(&mut self, em: &AcpEmitter, refs: AcpTurnRefs<'_>, text: String) {
        let watch = refs.watch;
        if text.is_empty() {
            return;
        }
        if self.first_response_at.is_none() {
            self.first_response_at = Some(std::time::Instant::now());
        }
        // Thinking is output: it is on screen the moment it streams,
        // and it also fills `acc`. Not marking it would make the
        // failover wrapper hold every thought back until the first
        // text delta — turning a reasoning-heavy turn into a long
        // dead pause followed by a dump.
        watch.mark_content();
        self.close_text(em);
        self.thought_acc.push_str(&text);
        self.thought_open = true;
        if self
            .thought_emitted_at
            .is_none_or(|emitted| emitted.elapsed() >= THOUGHT_EMIT_INTERVAL)
        {
            self.flush_thought(em);
        }
    }

    /// A plan snapshot, rendered as the TodoWrite checklist.
    pub(crate) fn on_plan(&mut self, em: &AcpEmitter, refs: AcpTurnRefs<'_>, entries: Value) {
        let watch = refs.watch;
        // Same as `Thought`: the todo checklist renders as it arrives.
        watch.mark_content();
        self.close_thought(em);
        self.close_text(em);
        self.plan_open = true;
        // Full snapshot each time, same part id: the desktop's Todo
        // checklist updates in place as entries change status.
        let plan_input = serde_json::json!({ "todos": entries });
        let started = self.tool_clock.start(PLAN_TOOL_ID);
        em.emit(ui_tool_input(
            PLAN_TOOL_ID,
            "TodoWrite",
            &plan_input,
            false,
            Some(started),
        ));
        self.acc
            .tool_input(PLAN_TOOL_ID, "TodoWrite", &plan_input, false, Some(started));
    }
}
