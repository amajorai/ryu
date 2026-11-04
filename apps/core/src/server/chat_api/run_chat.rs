//! Cloud-account auth handlers and the chat turn pipeline with its plugin hooks: `run_chat_with_hooks_attached` through `run_chat_with_hooks_attached`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

pub(in crate::server) async fn run_chat_with_hooks_attached(
    state: ServerState,
    req: crate::sidecar::adapters::ChatStreamRequest,
) -> axum::response::Response {
    use axum::body::Body;
    use futures_util::StreamExt;

    let mut admission = match crate::execution_control::admit() {
        Ok(admission) => admission,
        Err(message) => return crate::sidecar::adapters::error_stream(message.to_owned()),
    };
    let eligible = req.conversation_id.is_some() && req.persist && !req.background;
    // Cheap gate: collect enabled hooks once. Empty (the common case) → no wrap.
    let hooks = if eligible && crate::tool_exec::is_available() {
        crate::plugin_host::collect_enabled_hooks(&state).await
    } else {
        Vec::new()
    };
    if hooks.is_empty() {
        return tokio::select! {
            biased;
            _ = admission.cancelled() => crate::sidecar::adapters::error_stream(crate::execution_control::PAUSED_MESSAGE.to_owned()),
            response = route_single_turn(&state, req) => response,
        };
    }

    let conversation_id = req.conversation_id.clone().unwrap_or_default();
    let agent_id = req.agent_id.clone();
    let flags = req.plugin_flags.clone();
    // Which pre-model phases are live? Cheap checks so a post-turn-only install
    // does zero extra work before the first turn.
    let has_pre = hooks
        .iter()
        .any(|h| h.on == crate::plugin_host::ON_PRE_USER_TURN);
    let has_session_start = hooks
        .iter()
        .any(|h| h.on == crate::plugin_host::ON_SESSION_START);
    let has_action = hooks.iter().any(|h| h.on == crate::plugin_host::ON_ACTION);

    let stream = async_stream::stream! {
        let mut current = req;
        let mut turn: u32 = 0;

        // Session start (Claude's SessionStart): on the FIRST turn of a
        // conversation, let a hook inject setup context or surface a note. First
        // turn = the store has no prior messages (the incoming user turn is not
        // persisted yet). Fail-open. Injected context is appended to the outgoing
        // user message so it reaches the model this turn.
        if has_session_start {
            let first_turn = state
                .conversations
                .get_active_messages(&conversation_id)
                .await
                .map(|m| m.is_empty())
                .unwrap_or(false);
            if first_turn {
                let sctx = build_pre_hook_context(&current, &flags);
                let directives = crate::plugin_host::run_hooks(
                    &state,
                    &sctx,
                    &hooks,
                    crate::plugin_host::ON_SESSION_START,
                )
                .await;
                for directive in directives {
                    match directive {
                        crate::plugin_host::HookDirective::Inject { text } => {
                            let t = text.trim();
                            if !t.is_empty() {
                                crate::sidecar::adapters::append_last_user_text(
                                    &mut current.messages,
                                    t,
                                );
                            }
                        }
                        crate::plugin_host::HookDirective::Note { text } => {
                            yield Ok::<_, std::convert::Infallible>(plugin_note_frame(&text));
                        }
                        _ => {}
                    }
                }
            }
        }

        // Pre-turn transform: before the first model turn, let a `pre_user_turn`
        // hook rewrite (`Replace`) or augment (`Inject`) the outgoing user message
        // (e.g. auto-expand's prompt improver, polite-prompts' tone rewrite). The result is what gets sent AND
        // persisted, so a reload shows the prompt that actually ran. Fail-open:
        // any hook error is a no-op and the original prompt is sent. Runs inside
        // the stream so the `sideModel` round-trip streams a note rather than
        // stalling before any bytes reach the client.
        // Set when a `pre_user_turn` hook returns `Handled` — the turn is answered
        // without a model call. `None` on every ordinary turn.
        let mut handled_text: Option<String> = None;
        if has_pre {
            let pre_ctx = build_pre_hook_context(&current, &flags);
            let directives = crate::plugin_host::run_hooks(
                &state,
                &pre_ctx,
                &hooks,
                crate::plugin_host::ON_PRE_USER_TURN,
            )
            .await;
            for directive in directives {
                match directive {
                    crate::plugin_host::HookDirective::Replace { text, .. } => {
                        let t = text.trim();
                        if !t.is_empty()
                            && crate::sidecar::adapters::set_last_user_text(
                                &mut current.messages,
                                t.to_string(),
                            )
                        {
                            yield Ok::<_, std::convert::Infallible>(plugin_note_frame(&format!(
                                "Rewritten prompt sent:\n\n{t}"
                            )));
                            // Apply at most one rewrite; a second pre-hook would
                            // fight over the same message.
                            break;
                        }
                    }
                    crate::plugin_host::HookDirective::Inject { text } => {
                        let t = text.trim();
                        if !t.is_empty() {
                            crate::sidecar::adapters::append_last_user_text(
                                &mut current.messages,
                                t,
                            );
                        }
                    }
                    crate::plugin_host::HookDirective::Handled { text, .. } => {
                        let t = text.trim();
                        if !t.is_empty() {
                            handled_text = Some(t.to_string());
                            // First writer wins: once a hook owns this turn, no
                            // later hook may also claim it or rewrite the prompt
                            // for a model call that is no longer going to happen.
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }

        // `Handled`: a hook answered the turn itself, so NO model call is made. The
        // reply is framed exactly like a streamed one — a client cannot tell the
        // difference, and must not, or it renders a turn that never opens or never
        // closes — and is persisted like any assistant message so a reload is
        // faithful. Fail-open stays intact: a persist error costs the transcript
        // row, never the response the user is already reading.
        if admission.is_cancelled() {
            yield Ok::<_, std::convert::Infallible>(crate::execution_control::error_frame());
            yield Ok(crate::sidecar::adapters::done_sse_frame());
            return;
        }
        if let Some(text) = handled_text.as_deref() {
            for frame in crate::sidecar::adapters::synthetic_assistant_frames(text) {
                yield Ok::<_, std::convert::Infallible>(frame);
            }
            // BOTH rows, via the same helper the off-HTTP transports use. The user
            // row matters and is easy to miss: `route_chat_stream` is the only
            // writer of the user message, and a handled turn skips it entirely, so
            // persisting just the assistant reply would reload the conversation as
            // an answer to a prompt that is not there. Passing the post-hook text
            // means a `Replace` that rewrote the prompt is what gets stored — the
            // transcript shows what actually ran, matching the note the Replace arm
            // already streams.
            let user_text = current
                .messages
                .iter()
                .rev()
                .find(|m| m.role == "user")
                .map(crate::sidecar::adapters::ui_message_text)
                .unwrap_or_default();
            let _ = crate::sidecar::adapters::persist_handled_ui_turn(
                &state.conversations,
                &current,
                &conversation_id,
                &user_text,
                text,
                agent_id.as_deref(),
            )
            .await;
        }

        loop {
            // A handled turn is already complete: skip the model entirely. Guarding
            // here rather than wrapping the loop keeps the terminal [DONE] below as
            // the single exit for every path.
            if handled_text.is_some() {
                break;
            }
            if admission.is_cancelled() {
                yield Ok(crate::execution_control::error_frame());
                break;
            }
            // Stream one turn, forwarding every UI part except its terminal [DONE].
            let inner = route_single_turn(&state, current.clone()).await;
            let mut body = inner.into_body().into_data_stream();
            let (notes_tx, mut notes_rx) =
                tokio::sync::mpsc::unbounded_channel::<ActionSummaryNote>();
            let mut notes_sender = if has_action { Some(notes_tx) } else { None };
            let mut notes_open = has_action;
            let mut body_done = false;
            let mut action_notes: Vec<ActionSummaryNote> = Vec::new();
            let mut action_probe = if has_action {
                Some(crate::plugin_host::ActionFrameProbe::default())
            } else {
                None
            };

            while !body_done {
                tokio::select! {
                    item = body.next(), if !body_done => {
                        match item {
                            Some(Ok(bytes)) => {
                                if crate::sidecar::adapters::is_done_frame(&bytes) {
                                    continue;
                                }
                                let forwarded = bytes.to_vec();
                                yield Ok::<_, std::convert::Infallible>(forwarded.clone());
                                if let (Some(probe), Some(sender)) =
                                    (action_probe.as_mut(), notes_sender.as_ref())
                                {
                                    for action in probe.feed(&forwarded) {
                                        spawn_action_hooks(
                                            &state,
                                            &hooks,
                                            &conversation_id,
                                            agent_id.as_deref(),
                                            current.author_user_id.as_deref(),
                                            current.verified_caller.as_ref(),
                                            &flags,
                                            action,
                                            sender,
                                        );
                                    }
                                }
                            }
                            Some(Err(_)) | None => {
                                body_done = true;
                                if let (Some(probe), Some(sender)) =
                                    (action_probe.as_mut(), notes_sender.as_ref())
                                {
                                    for action in probe.finish() {
                                        spawn_action_hooks(
                                            &state,
                                            &hooks,
                                            &conversation_id,
                                            agent_id.as_deref(),
                                            current.author_user_id.as_deref(),
                                            current.verified_caller.as_ref(),
                                            &flags,
                                            action,
                                            sender,
                                        );
                                    }
                                }
                                notes_sender.take();
                            }
                        }
                    }
                    note = notes_rx.recv(), if notes_open => {
                        match note {
                            Some(note) => {
                                action_notes.push(note);
                                yield Ok::<_, std::convert::Infallible>(
                                    action_summary_frame(&mut action_notes),
                                );
                            }
                            None => notes_open = false,
                        }
                    }
                }
            }

            // Give detached side-model calls a short, absolute drain window after
            // the primary stream ends. A slow or stuck side model must never hold
            // the terminal [DONE] frame open indefinitely.
            if notes_open {
                let deadline = tokio::time::Instant::now() + ACTION_SUMMARY_DRAIN_TIMEOUT;
                while notes_open {
                    let remaining =
                        deadline.saturating_duration_since(tokio::time::Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    match tokio::time::timeout(remaining, notes_rx.recv()).await {
                        Ok(Some(note)) => {
                            action_notes.push(note);
                            yield Ok::<_, std::convert::Infallible>(
                                action_summary_frame(&mut action_notes),
                            );
                        }
                        Ok(None) | Err(_) => notes_open = false,
                    }
                }
            }
            notes_open = false;

            // Stop ends the whole response, not just the inner turn: no post-turn
            // hook may run (or start another turn) after the user pressed it.
            if crate::sidecar::adapters::live_turn::cancel_requested(&conversation_id) {
                break;
            }
            // Post-turn hooks: build context from the persisted transcript.
            if admission.is_cancelled() {
                yield Ok(crate::execution_control::error_frame());
                break;
            }
            let ctx = build_hook_context(
                &state,
                &conversation_id,
                agent_id.as_deref(),
                current.author_user_id.as_deref(),
                current.verified_caller.as_ref(),
                &flags,
            )
            .await;
            let directives = crate::plugin_host::run_hooks(
                &state,
                &ctx,
                &hooks,
                crate::plugin_host::ON_POST_ASSISTANT_TURN,
            )
            .await;
            let mut next_text: Option<String> = None;
            if admission.is_cancelled() {
                yield Ok(crate::execution_control::error_frame());
                break;
            }
            for directive in directives {
                match directive {
                    crate::plugin_host::HookDirective::Note { text } => {
                        yield Ok(plugin_note_frame(&text));
                    }
                    crate::plugin_host::HookDirective::Continue { text } => {
                        if next_text.is_none() {
                            next_text = Some(text);
                        }
                    }
                    crate::plugin_host::HookDirective::ToolApproval { .. } => {
                        // Tool intents belong to action-summary frames, not the
                        // post-turn note channel.
                    }
                    // Pre-turn / context-phase / tool-phase directives are no-ops
                    // post-turn: there is no outgoing prompt or message array left
                    // to rewrite, and no tool call to block or transform here.
                    // `Rewrite` is an ON_CONTEXT directive ("ignored elsewhere") and
                    // `Transform` rewrites a tool RESULT, so both are inert at this
                    // point in the turn.
                    crate::plugin_host::HookDirective::Replace { .. }
                    | crate::plugin_host::HookDirective::Inject { .. }
                    | crate::plugin_host::HookDirective::Deny { .. }
                    | crate::plugin_host::HookDirective::Transform { .. }
                    | crate::plugin_host::HookDirective::Rewrite { .. }
                    | crate::plugin_host::HookDirective::SelectModel { .. }
                    | crate::plugin_host::HookDirective::InteractiveMessage { .. }
                    // `Handled` short-circuits a turn BEFORE the model call; by the
                    // post-turn point the call has already happened, so honouring it
                    // here would discard a real reply the user already saw stream in.
                    | crate::plugin_host::HookDirective::Handled { .. } => {}
                    crate::plugin_host::HookDirective::None => {}
                }
            }

            turn += 1;
            if crate::sidecar::adapters::live_turn::cancel_requested(&conversation_id) {
                break;
            }
            match next_text {
                Some(text) if turn < crate::plugin_host::MAX_CONTINUE_TURNS => {
                    current = continue_turn_request(&state, &current, &conversation_id, text).await;
                }
                _ => break,
            }
        }
        // One terminal DONE for the whole (possibly multi-turn) response.
        yield Ok(crate::sidecar::adapters::done_sse_frame());
    };

    crate::sidecar::adapters::sse_response(Body::from_stream(stream))
}
