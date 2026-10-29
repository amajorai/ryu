use super::*;

/// Answers an agent elicitation (structured user question) for the live turn.
pub(super) async fn handle_elicitation_request(
    req: ElicitationCreateRequest,
    responder: agent_client_protocol::Responder<ElicitationCreateResponse>,
    turn_cancelled: bool,
    tx_question: mpsc::UnboundedSender<AcpEvent>,
    question_conversation: String,
) -> Result<(), agent_client_protocol::Error> {
    if turn_cancelled {
        responder.respond(ElicitationCreateResponse::cancelled())?;
        return Ok(());
    }
    let question_id = elicitation_tool_call_id(&req);
    let mut input = elicitation_question_input(&req, &question_id);
    // Nobody is available (away, do-not-disturb,
    // gaming, or the desktop went quiet): do not
    // stall the turn on a human. The card stays in
    // the transcript as an async question, the
    // agent is released at once, and the eventual
    // answer arrives as a normal user message.
    if crate::presence::questions_deferred() {
        input["async"] = serde_json::Value::Bool(true);
        let _ = tx_question.send(AcpEvent::QuestionRequest {
            tool_call_id: question_id.clone(),
            input,
        });
        // A Core-minted id has no ACP tool call that
        // would ever close the card, so close it
        // here; a real tool call's own update does.
        if question_id.starts_with("elicitation-") {
            let _ = tx_question.send(AcpEvent::ToolResult {
                id: question_id.clone(),
                status: "completed".to_owned(),
                output: Some(deferred_question_output()),
                input: None,
            });
        }
        responder.respond(ElicitationCreateResponse::cancelled())?;
        return Ok(());
    }
    // Cancelled at once when nobody is listening,
    // and after ten minutes without an answer.
    let result =
        request_user_answer(&tx_question, &question_conversation, &question_id, input).await;
    let response = match result {
        Some(answers) => ElicitationCreateResponse {
            action: "accept".to_owned(),
            content: Some(serde_json::json!({
                "answers": answers,
            })),
        },
        None => ElicitationCreateResponse::cancelled(),
    };
    responder.respond(response)?;
    Ok(())
}

/// Answers an agent permission request after the command-approval scan.
#[allow(clippy::too_many_arguments)]
pub(super) async fn handle_permission_request(
    req: RequestPermissionRequest,
    responder: agent_client_protocol::Responder<RequestPermissionResponse>,
    turn_cancelled: bool,
    scan_agent: String,
    interactive: bool,
    workspace_trusted: bool,
    tx_perm: mpsc::UnboundedSender<AcpEvent>,
    perm_conversation: String,
) -> Result<(), agent_client_protocol::Error> {
    // A cancelled turn answers every permission
    // request `cancelled` (ACP), without a scan.
    if turn_cancelled {
        responder.respond(RequestPermissionResponse::new(
            RequestPermissionOutcome::Cancelled,
        ))?;
        return Ok(());
    }
    // Security seam: pre-scan LLM-emitted shell/exec
    // commands through the gateway command-approval
    // scanner before granting. A Deny short-circuits
    // to reject regardless of mode (headless would
    // otherwise auto-approve the first option). In
    // headless mode ApprovalRequired also rejects (no
    // human to consult) - fail closed. This is
    // accident prevention, not containment; ACP agents
    // are first-party binaries, so we gate their
    // commands rather than scrub their env. See
    // SECURITY.md.
    let tool_call_json = serde_json::to_value(&req.tool_call).unwrap_or(serde_json::Value::Null);
    let scan = acp_exec_scan_verdict(&tool_call_json, &scan_agent).await;
    let route = route_permission(&scan, interactive, &tool_call_json, workspace_trusted);
    let outcome = if route == PermissionRoute::Reject {
        RequestPermissionOutcome::Cancelled
    } else if route == PermissionRoute::AskUser {
        // Surface the request to the user and await
        // their decision; cancel (reject) on timeout,
        // or at once when nobody is listening. The
        // prompt is scoped to this instance's
        // conversation so its decision can be
        // ACL-gated (see `peek_permission_scope`).
        let chosen = request_user_permission(
            &tx_perm,
            serde_json::to_value(&req.tool_call).unwrap_or(serde_json::Value::Null),
            serde_json::to_value(&req.options).unwrap_or(serde_json::Value::Null),
            Some(perm_conversation.clone()),
        )
        .await;
        match chosen {
            Some(option_id) => {
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id))
            }
            None => RequestPermissionOutcome::Cancelled,
        }
    } else {
        // Headless: approve once so tool use works
        // without a UI — only what `route_permission`
        // let through (a clean scan; for shell, a
        // readable command in a trusted workspace).
        // Never an "always" option: an unattended run
        // must not persist a rule in the agent's own
        // settings.
        headless_allow_once(&req.options).map_or(RequestPermissionOutcome::Cancelled, |option_id| {
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id))
        })
    };
    responder.respond(RequestPermissionResponse::new(outcome))?;
    Ok(())
}
