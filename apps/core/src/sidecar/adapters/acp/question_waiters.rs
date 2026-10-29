use super::*;

/// `request_id → (waiter, host conversation id)`.
///
/// The conversation is carried so `POST /api/chat/permission` can GATE the decision
/// on the thread the prompt belongs to. Without it, `perm-<seq>` ids are sequential
/// and trivially guessable, so any holder of the node token could approve or DENY
/// another user's pending tool-permission prompt — a human-in-the-loop integrity
/// bypass. `None` for an ephemeral (no-conversation) instance.
type PermissionWaiters = Mutex<
    std::collections::HashMap<
        String,
        (tokio::sync::oneshot::Sender<Option<String>>, Option<String>),
    >,
>;

/// `conversation_id/tool_call_id → (answer waiter, host conversation id)`.
///
/// Question tools are surfaced as ACP tool calls, but their answer is a
/// client-side interaction. Keep the waiter separate from permission waiters:
/// an answer is structured data, not an option id, and must never be accepted
/// by the permission endpoint by accident.
type QuestionWaiters = Mutex<
    std::collections::HashMap<String, (tokio::sync::oneshot::Sender<serde_json::Value>, String)>,
>;

pub(super) fn pending_permissions() -> &'static PermissionWaiters {
    static WAITERS: OnceLock<PermissionWaiters> = OnceLock::new();
    WAITERS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

pub(super) fn pending_questions() -> &'static QuestionWaiters {
    static WAITERS: OnceLock<QuestionWaiters> = OnceLock::new();
    WAITERS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn question_key(conversation_id: &str, tool_call_id: &str) -> String {
    format!("{conversation_id}\u{1f}{tool_call_id}")
}

pub(super) fn elicitation_tool_call_id(request: &ElicitationCreateRequest) -> String {
    request
        .mode
        .get("scope")
        .and_then(|scope| scope.get("toolCallId"))
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("elicitation-{}", next_permission_id()))
}

pub(super) fn elicitation_question_input(
    request: &ElicitationCreateRequest,
    tool_call_id: &str,
) -> serde_json::Value {
    serde_json::json!({
        "toolCallId": tool_call_id,
        "questions": [{
            "id": "q-0",
            "title": request.message,
            "kind": "text",
            "options": [],
        }],
        "schema": request.mode,
    })
}

/// Tool output recorded on a Question card that did not block the turn. The
/// desktop keeps a card with this output pending until the user answers, then
/// sends the answer as a new user message.
pub fn deferred_question_output() -> serde_json::Value {
    serde_json::json!({
        "deferred": true,
        "message": "The user is not available right now. This question stays open; their answer will arrive later as a new message.",
    })
}

/// Register the answer channel for a Question tool call. The ACP tool-call id
/// is stable for the life of the session and is also sent on the wire as
/// `toolCallId`, so reconnecting clients can answer the exact pending call.
pub fn register_question(
    conversation_id: String,
    tool_call_id: String,
) -> tokio::sync::oneshot::Receiver<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    if !conversation_id.is_empty() && !tool_call_id.is_empty() {
        if let Ok(mut map) = pending_questions().lock() {
            map.insert(
                question_key(&conversation_id, &tool_call_id),
                (tx, conversation_id),
            );
        }
    }
    rx
}

/// Return the conversation owning a pending Question, without consuming it.
pub fn peek_question_scope(conversation_id: &str, tool_call_id: &str) -> Option<String> {
    pending_questions().lock().ok().and_then(|map| {
        map.get(&question_key(conversation_id, tool_call_id))
            .map(|(_, scope)| scope.clone())
    })
}

/// Deliver a structured answer to a pending Question tool call.
pub fn resolve_question(
    conversation_id: &str,
    tool_call_id: &str,
    answers: serde_json::Value,
) -> bool {
    let sender = pending_questions()
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&question_key(conversation_id, tool_call_id)));
    match sender {
        Some((tx, _scope)) => tx.send(answers).is_ok(),
        None => false,
    }
}

/// Drop a pending Question when its ACP stream ends or the client disconnects.
pub fn cancel_question(conversation_id: &str, tool_call_id: &str) {
    if let Ok(mut map) = pending_questions().lock() {
        map.remove(&question_key(conversation_id, tool_call_id));
    }
}

/// Register the answer waiter for a Question card and post the card on `tx`.
///
/// Returns the receiver the caller awaits for the answer. It returns `None`
/// when the receiving side of `tx` is already gone: nobody can see the card or
/// answer it, so the waiter is dropped at once instead of being left to a
/// timeout. Shared by the ACP elicitation handler and the `ask_user` tool.
pub fn post_question(
    tx: &mpsc::UnboundedSender<AcpEvent>,
    conversation_id: &str,
    tool_call_id: &str,
    input: serde_json::Value,
) -> Option<tokio::sync::oneshot::Receiver<serde_json::Value>> {
    let rx = register_question(conversation_id.to_owned(), tool_call_id.to_owned());
    let posted = tx.send(AcpEvent::QuestionRequest {
        tool_call_id: tool_call_id.to_owned(),
        input,
    });
    if posted.is_err() {
        cancel_question(conversation_id, tool_call_id);
        return None;
    }
    Some(rx)
}

/// How long a blocking Question waits for the user before it is cancelled.
const QUESTION_ANSWER_WINDOW: std::time::Duration = std::time::Duration::from_secs(600);

/// Post a Question card and wait for the user's structured answer. `None`
/// means no answer is coming: nobody can see the card (see [`post_question`]),
/// or the window closed first, in which case the waiter is dropped.
pub async fn request_user_answer(
    tx: &mpsc::UnboundedSender<AcpEvent>,
    conversation_id: &str,
    tool_call_id: &str,
    input: serde_json::Value,
) -> Option<serde_json::Value> {
    let rx = post_question(tx, conversation_id, tool_call_id, input)?;
    let answers = tokio::time::timeout(QUESTION_ANSWER_WINDOW, rx)
        .await
        .ok()
        .and_then(Result::ok);
    if answers.is_none() {
        cancel_question(conversation_id, tool_call_id);
    }
    answers
}

/// The pending Question waiters scoped to one conversation.
#[cfg(test)]
pub(crate) fn pending_question_count(conversation_id: &str) -> usize {
    pending_questions()
        .lock()
        .map(|map| {
            map.values()
                .filter(|(_, scope)| scope == conversation_id)
                .count()
        })
        .unwrap_or(0)
}
