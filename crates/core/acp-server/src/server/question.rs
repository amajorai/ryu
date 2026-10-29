use super::*;

/// Option id for "skip this question" in a Question's permission prompt.
const QUESTION_SKIP_OPTION: &str = "skip";

/// One question of a Question card, as Core renders it.
struct QuestionItem {
    title: String,
    kind: String,
    /// `(id, label)` per choice.
    options: Vec<(String, String)>,
}

fn question_items(input: &Value) -> Vec<QuestionItem> {
    input
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|question| QuestionItem {
            title: question
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Question")
                .to_owned(),
            kind: question
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("text")
                .to_owned(),
            options: question
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|option| {
                    let id = option.get("id").and_then(Value::as_str)?;
                    let label = option.get("label").and_then(Value::as_str).unwrap_or(id);
                    Some((id.to_owned(), label.to_owned()))
                })
                .collect(),
        })
        .collect()
}

/// The answer Core records for one question: the chosen option, or a skip.
fn question_answer(question: &QuestionItem, chosen: Option<&str>) -> Value {
    let picked = chosen
        .and_then(|option| option.strip_prefix("option-"))
        .and_then(|index| index.parse::<usize>().ok())
        .and_then(|index| question.options.get(index));
    match picked {
        Some((id, _)) => {
            let kind = if question.kind == "multi" {
                "multi"
            } else {
                "single"
            };
            json!({ "kind": kind, "selectedIds": [id] })
        }
        None => json!({ "kind": "skip" }),
    }
}

/// Relay a Core Question card. Core blocks the agent on a non-async card until
/// `/api/chat/question` answers it, so every question gets an answer here: a
/// choice question is asked through `session/request_permission` (its options
/// plus Skip); a free-text question, or any question the client cancels,
/// errors on, or the turn cancels under, is answered as skipped so the agent
/// continues at once instead of waiting out Core's timeout.
pub(super) async fn forward_question(
    state: &State,
    cx: &ConnectionTo<Client>,
    job: &PromptJob,
    translator: &mut Translator,
    id: String,
    input: Value,
) -> Result<(), agent_client_protocol::Error> {
    // Keep the card in the editor's transcript like any other tool call; the
    // later tool output closes it.
    for update in translator.translate(CoreEvent::ToolInput {
        id: id.clone(),
        name: "Question".to_owned(),
        input: input.clone(),
    }) {
        notify(cx, &job.session_id, update)?;
    }
    if !translator.questioned.insert(id.clone()) {
        return Ok(());
    }
    let questions = question_items(&input);
    let blocking = input.get("async").and_then(Value::as_bool) != Some(true);

    let mut answers = Vec::with_capacity(questions.len());
    for question in &questions {
        if !blocking || question.options.is_empty() || job.cancel.is_cancelled() {
            if !job.cancel.is_cancelled() {
                let note = if blocking {
                    "This question needs a typed answer, which can't be sent from here, so it was skipped."
                } else {
                    "Answer in a new message when you're ready."
                };
                notify(
                    cx,
                    &job.session_id,
                    SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::from(
                        format!("\n\n**{}**\n{note}\n\n", question.title),
                    ))),
                )?;
            }
            answers.push(question_answer(question, None));
            continue;
        }
        let mut options: Vec<PermissionOption> = question
            .options
            .iter()
            .enumerate()
            .map(|(index, (_, label))| {
                PermissionOption::new(
                    format!("option-{index}"),
                    label.clone(),
                    PermissionOptionKind::AllowOnce,
                )
            })
            .collect();
        options.push(PermissionOption::new(
            QUESTION_SKIP_OPTION,
            "Skip",
            PermissionOptionKind::RejectOnce,
        ));
        let tool_call = ToolCallUpdate::new(
            id.clone(),
            ToolCallUpdateFields::new().title(question.title.clone()),
        );
        let request = RequestPermissionRequest::new(job.session_id.clone(), tool_call, options);
        // As above, cancelling drops the request and sends `$/cancel_request`.
        let chosen = tokio::select! {
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
                    tracing::warn!("question prompt failed, skipping: {error:?}");
                    None
                }
            },
        };
        answers.push(question_answer(question, chosen.as_deref()));
    }

    if !blocking {
        // Core already released the agent; the answer arrives as a new message.
        return Ok(());
    }
    if answers.is_empty() {
        answers.push(json!({ "kind": "skip" }));
    }
    let tool_call_id = input
        .get("toolCallId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(&id);
    let delivered = match state
        .core
        .answer_question(&job.conversation_id, tool_call_id, &answers)
        .await
    {
        Ok(resolved) => resolved,
        Err(error) => {
            tracing::warn!(
                tool_call_id,
                "could not deliver the question answer to Ryu: {error}"
            );
            false
        }
    };
    // Core no longer waits on this card (it timed out or was answered
    // elsewhere), so the choice had no effect. Say so rather than drop it; the
    // user can send it as a normal message.
    let chosen: Vec<&str> = questions
        .iter()
        .zip(&answers)
        .filter_map(|(question, answer)| {
            let id = answer["selectedIds"][0].as_str()?;
            question
                .options
                .iter()
                .find(|(option, _)| option == id)
                .map(|(_, label)| label.as_str())
        })
        .collect();
    if !delivered && !chosen.is_empty() && !job.cancel.is_cancelled() {
        notify(
            cx,
            &job.session_id,
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::from(format!(
                "\n\nYour answer ({}) did not reach the agent. Send it as a message if it still matters.\n\n",
                chosen.join(", ")
            )))),
        )?;
    }
    Ok(())
}
