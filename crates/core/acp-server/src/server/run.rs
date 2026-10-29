use super::*;

pub(super) struct PromptOutcome {
    pub(super) result: Result<PromptResponse, agent_client_protocol::Error>,
    /// Turns to append to the session transcript.
    pub(super) transcript: Vec<Turn>,
}

pub(super) fn notify(
    cx: &ConnectionTo<Client>,
    session_id: &SessionId,
    update: SessionUpdate,
) -> Result<(), agent_client_protocol::Error> {
    cx.send_notification(SessionNotification::new(session_id.clone(), update))
}

pub(super) async fn run_prompt(
    state: &State,
    cx: &ConnectionTo<Client>,
    job: PromptJob,
    prompt: &[ContentBlock],
) -> PromptOutcome {
    let (user_text, parts) = match prompt_parts(prompt) {
        Ok(converted) => converted,
        Err(error) => {
            return PromptOutcome {
                result: Err(error),
                transcript: Vec::new(),
            }
        }
    };
    let mut translator = Translator::default();
    let result = stream_turn(state, cx, &job, parts, &mut translator).await;
    if matches!(result, Ok(StopReason::Cancelled)) {
        // Aborting our read alone does not stop Core; ask it to end the run.
        if let Err(error) = state.core.cancel(&job.conversation_id).await {
            tracing::warn!("Ryu did not acknowledge the cancel: {error}");
        }
    }
    let mut transcript = Vec::new();
    if result.is_ok() {
        transcript.push(Turn {
            role: "user",
            text: user_text,
        });
        if !translator.assistant_text.is_empty() {
            transcript.push(Turn {
                role: "assistant",
                text: translator.assistant_text,
            });
        }
    }
    PromptOutcome {
        result: result.map(PromptResponse::new),
        transcript,
    }
}

/// Stream one Core turn into ACP updates. Returns the stop reason; Core's
/// stream carries no finish reason beyond "done", so a turn ends either
/// `end_turn` or (when the client cancelled) `cancelled`.
async fn stream_turn(
    state: &State,
    cx: &ConnectionTo<Client>,
    job: &PromptJob,
    parts: Vec<Value>,
    translator: &mut Translator,
) -> Result<StopReason, agent_client_protocol::Error> {
    let body = chat_body(job, parts);
    let response = tokio::select! {
        biased;
        () = job.cancel.cancelled() => return Ok(StopReason::Cancelled),
        response = state.core.chat_stream(&body) => response?,
    };
    let mut stream = response.bytes_stream();
    let mut buffer = LineBuffer::default();
    loop {
        let chunk = tokio::select! {
            biased;
            () = job.cancel.cancelled() => return Ok(StopReason::Cancelled),
            chunk = stream.next() => chunk,
        };
        let (lines, body_ended) = match chunk {
            Some(Ok(bytes)) => (buffer.push(&bytes), false),
            Some(Err(error)) => {
                return Err(internal_error(format!(
                    "the Ryu stream was interrupted: {error}"
                )))
            }
            None => (buffer.finish().into_iter().collect::<Vec<_>>(), true),
        };
        for line in lines {
            match decode_line(&line) {
                CoreEvent::Done => return Ok(StopReason::EndTurn),
                CoreEvent::Error(message) => return Err(internal_error(message)),
                CoreEvent::Permission {
                    request_id,
                    tool_call,
                    options,
                } => {
                    forward_permission(state, cx, job, translator, &request_id, tool_call, options)
                        .await?;
                    if job.cancel.is_cancelled() {
                        return Ok(StopReason::Cancelled);
                    }
                }
                CoreEvent::Question { id, input } => {
                    forward_question(state, cx, job, translator, id, input).await?;
                    if job.cancel.is_cancelled() {
                        return Ok(StopReason::Cancelled);
                    }
                }
                event => {
                    for update in translator.translate(event) {
                        notify(cx, &job.session_id, update)?;
                    }
                }
            }
        }
        if body_ended {
            // Body closed without `[DONE]`: treat as a completed turn, as the
            // CLI does.
            return Ok(StopReason::EndTurn);
        }
    }
}

/// The ACP `ToolCallUpdate` a permission request refers to. Agent-raised
/// prompts forward the agent's own update; Core's own gates (e.g. in-chat
/// consent) send `{title, rawInput, fields: {title}}` without a `toolCallId`,
/// so rebuild what the user needs to see from the raw JSON instead of
/// dropping it.
fn permission_tool_call(request_id: &str, tool_call: Value) -> ToolCallUpdate {
    if let Ok(update) = serde_json::from_value::<ToolCallUpdate>(tool_call.clone()) {
        return update;
    }
    let id = tool_call
        .get("toolCallId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map_or_else(|| format!("permission-{request_id}"), str::to_owned);
    let title = [&tool_call["title"], &tool_call["fields"]["title"]]
        .into_iter()
        .find_map(|value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
        })
        .unwrap_or("Tool approval")
        .to_owned();
    let raw_input = tool_call
        .get("rawInput")
        .filter(|value| !value.is_null())
        .cloned();
    ToolCallUpdate::new(
        id,
        ToolCallUpdateFields::new()
            .title(title)
            .kind(ToolKind::Other)
            .raw_input(raw_input),
    )
}

/// Relay a Core tool-approval pause to the client and Core's answer back.
/// Anything other than an explicit option choice — the client cancels, errors,
/// or the turn is cancelled meanwhile — is sent to Core as a denial.
async fn forward_permission(
    state: &State,
    cx: &ConnectionTo<Client>,
    job: &PromptJob,
    translator: &mut Translator,
    request_id: &str,
    tool_call: Value,
    options: Value,
) -> Result<(), agent_client_protocol::Error> {
    let options: Vec<PermissionOption> = serde_json::from_value(options).unwrap_or_default();
    let tool_call = permission_tool_call(request_id, tool_call);

    let decision = if options.is_empty() {
        tracing::warn!(
            request_id,
            "permission request carried no usable options; denying"
        );
        None
    } else {
        if let Some(update) = translator.ensure_announced(&tool_call) {
            notify(cx, &job.session_id, update)?;
        }
        let request = RequestPermissionRequest::new(job.session_id.clone(), tool_call, options);
        // Losing the race to `cancel` drops the pending request, which makes
        // the protocol crate send `$/cancel_request` so the editor can close
        // its prompt.
        tokio::select! {
            biased;
            () = job.cancel.cancelled() => None,
            answer = cx.send_request(request).block_task() => match answer {
                Ok(response) => match response.outcome {
                    RequestPermissionOutcome::Selected(selected) => {
                        Some(selected.option_id.0.to_string())
                    }
                    _ => None,
                },
                Err(error) => {
                    tracing::warn!("permission request failed, denying: {error:?}");
                    None
                }
            },
        }
    };

    if let Err(error) = state
        .core
        .resolve_permission(request_id, decision.as_deref())
        .await
    {
        tracing::warn!(
            request_id,
            "could not deliver the permission decision to Ryu: {error}"
        );
    }
    Ok(())
}
