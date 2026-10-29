use super::*;

/// The per-turn result slots [`send_turn_prompt`] wires to the prompt callback.
pub(super) struct TurnPrompt {
    pub(super) turn_usage: Arc<Mutex<Option<serde_json::Value>>>,
    pub(super) turn_error: Arc<Mutex<Option<(i32, String)>>>,
    pub(super) stop_rx: tokio::sync::oneshot::Receiver<()>,
}

/// Sends the turn's `session/prompt`, recording its usage or error for the turn end.
pub(super) fn send_turn_prompt(
    session: &agent_client_protocol::ActiveSession<'static, Agent>,
    turn_text: String,
    images: Vec<ImagePart>,
    agent_caps: AcpCaps,
) -> Result<TurnPrompt, agent_client_protocol::Error> {
    // Send the turn over the connection's low-level `PromptRequest`
    // path (both text-only and multimodal) so we can read the turn's
    // final `PromptResponse.usage` — the SDK's `send_prompt` helper
    // discards it. End-of-turn is signalled over a oneshot. This is
    // byte-for-byte what `send_prompt` does internally.
    let turn_usage: Arc<Mutex<Option<serde_json::Value>>> = Arc::new(Mutex::new(None));
    // Captures a fatal `session/prompt` failure (the request itself
    // erroring — e.g. no model configured / provider unreachable, which
    // surfaces as a transport error or timeout). Without this the error
    // was dropped inside `on_receiving_result` and the turn closed with
    // a normal `finish`, passing off any pre-failure agent banner as a
    // successful reply. Read after the update loop to emit a real error
    // frame instead.
    // `(code, message)`, not just the message: an expired OAuth token
    // arrives as JSON-RPC -32000 (`ErrorCode::AuthRequired`) and has to be
    // told apart from an unreachable provider, because the two need
    // opposite things from the user.
    let turn_error: Arc<Mutex<Option<(i32, String)>>> = Arc::new(Mutex::new(None));
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let mut blocks: Vec<ContentBlock> = vec![turn_text.into()];
    // Only attach image blocks when the agent advertised
    // `promptCapabilities.image`; sending them to an agent that
    // doesn't accept them can error or be silently dropped, so gate
    // on the negotiated capability (was previously unconditional).
    if !images.is_empty() {
        if agent_caps.prompt_image {
            for img in &images {
                blocks.push(ContentBlock::Image(ImageContent::new(
                    img.data.clone(),
                    img.mime_type.clone(),
                )));
            }
        } else {
            tracing::info!(
                "ACP agent does not advertise promptCapabilities.image; \
                                 dropping {} image attachment(s) from the prompt",
                images.len()
            );
        }
    }
    let usage_capture = Arc::clone(&turn_usage);
    let error_capture = Arc::clone(&turn_error);
    session
        .connection()
        .send_request_to(
            Agent,
            PromptRequest::new(session.session_id().clone(), blocks),
        )
        // ACP 3.x runs this callback before dispatching any later
        // inbound message, so it must never await connection traffic;
        // it only records the result and signals the turn loop.
        .on_receiving_result(move |result| async move {
            match result {
                Ok(resp) => {
                    let resp: PromptResponse = resp;
                    tracing::debug!(
                        stop_reason = ?resp.stop_reason,
                        "ACP prompt completed"
                    );
                    // Capture the turn's final token totals (ACP
                    // unstable usage). `None` when the agent reports
                    // no usage.
                    let usage = resp
                        .usage
                        .as_ref()
                        .and_then(|usage| serde_json::to_value(usage).ok())
                        .or_else(|| {
                            let meta = serde_json::to_value(resp.meta.as_ref()?).ok()?;
                            usage_from_quota_meta(&meta)
                        });
                    if let Some(v) = usage {
                        if let Ok(mut g) = usage_capture.lock() {
                            *g = Some(v);
                        }
                    }
                }
                // The prompt request itself failed. Historically this
                // error was swallowed (`result?` dropped it and the
                // turn ended clean). Capture it so the update loop can
                // surface a real error frame instead of a silent close.
                Err(e) => {
                    tracing::error!(error = %e, "ACP prompt result: Err");
                    if let Ok(mut g) = error_capture.lock() {
                        *g = Some((i32::from(e.code), e.to_string()));
                    }
                }
            }
            // The loop may have already exited; ignore a closed rx.
            let _ = stop_tx.send(());
            Ok(())
        })?;
    Ok(TurnPrompt {
        turn_usage,
        turn_error,
        stop_rx,
    })
}

/// What the turn's read loop does after [`read_turn_update`].
pub(super) enum TurnRead {
    Message(SessionMessage),
    Continue,
    Break,
}

/// Sends a requested cancel once, then waits for the next session update, the
/// prompt's end, a cancel, or the cancel-settle deadline.
#[allow(clippy::too_many_arguments)]
pub(super) async fn read_turn_update(
    session: &mut agent_client_protocol::ActiveSession<'static, Agent>,
    admission: &mut crate::execution_control::Admission,
    cancel: &TurnCancel,
    cancelled: &mut bool,
    cancel_deadline: &mut Option<tokio::time::Instant>,
    stop_rx: &mut tokio::sync::oneshot::Receiver<()>,
    tx: &mpsc::UnboundedSender<AcpEvent>,
    sink: &Mutex<Option<mpsc::UnboundedSender<AcpEvent>>>,
) -> Result<TurnRead, agent_client_protocol::Error> {
    // Explicit cancellation requested between updates: tell the agent
    // to stop (ACP `session/cancel`), ONCE. The turn does not end
    // here: ACP lets the agent flush trailing updates (final chunks,
    // cancelled tool calls) before it answers the prompt, and the
    // session's update queue is shared by every turn, so leaving them
    // queued would replay them into the NEXT turn's reply. Keep
    // reading them into this turn until the prompt answers or the
    // settle deadline passes.
    if !*cancelled && cancel.flag.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = session
            .connection()
            .send_notification_to(Agent, CancelNotification::new(session.session_id().clone()));
        *cancelled = true;
        *cancel_deadline = Some(tokio::time::Instant::now() + ACP_CANCEL_SETTLE_TIMEOUT);
    }
    // `biased` + the `stop_rx` branch coming second guarantees every
    // buffered update is drained before end-of-turn breaks the loop:
    // `read_update` is polled first and only yields to `stop_rx` when
    // its queue is empty. The prompt response (which fires `stop_rx`)
    // arrives after all session notifications, so the queue is fully
    // populated by the time `stop_rx` can win.
    let message = tokio::select! {
        biased;
        _ = admission.cancelled(), if !*cancelled => {
            cancel.flag.store(true, std::sync::atomic::Ordering::SeqCst);
            return Ok(TurnRead::Continue);
        }
        // Ahead of `read_update` so an agent that keeps streaming
        // after `session/cancel` cannot hold the turn open forever.
        _ = tokio::time::sleep_until(
            cancel_deadline.unwrap_or_else(tokio::time::Instant::now),
        ), if cancel_deadline.is_some() => {
            // The agent never answered the cancel. Discard what it
            // is still sending (bounded) so none of it reaches the
            // next turn, then end this one. Its requests are still
            // answered: one left pending can keep the agent blocked.
            let drain_until =
                tokio::time::Instant::now() + ACP_CANCEL_SETTLE_TIMEOUT;
            while tokio::time::Instant::now() < drain_until {
                match tokio::time::timeout(LOAD_REPLAY_QUIET, session.read_update())
                    .await
                {
                    Ok(Ok(SessionMessage::SessionMessage(message))) => {
                        if let Err(error) = answer_cancelled_turn_request(message).await {
                            tracing::debug!(%error, "answering an agent request after cancel failed");
                        }
                    }
                    Ok(Ok(_)) => {}
                    _ => break,
                }
            }
            return Ok(TurnRead::Break);
        }
        update = session.read_update() => match update {
            Ok(update) => update,
            Err(error) => {
                let detail = error.to_string();
                tracing::error!(error = %detail, "ACP session update stream failed");
                let _ = tx.send(AcpEvent::Error(AcpFailure {
                    code: "acp_transport_error".to_owned(),
                    title: "Agent connection lost".to_owned(),
                    message: format!("The agent connection ended before the turn completed: {detail}"),
                }));
                if let Ok(mut g) = sink.lock() {
                    *g = None;
                }
                return Err(error);
            }
        },
        // `Err` means the prompt callback errored and dropped the
        // sender; either way the turn is over.
        _ = &mut *stop_rx => return Ok(TurnRead::Break),
        // Woken by an explicit cancel; loop back to the flag check
        // above (which sends `session/cancel`).
        _ = cancel.notify.notified(), if !*cancelled => return Ok(TurnRead::Continue),
    };
    Ok(TurnRead::Message(message))
}
