use super::*;

impl RyuMcpHandler {
    /// Ask the user in this chat before an agent changes Ryu itself.
    ///
    /// Applies only to [`crate::approvals::chat_grants::chat_confirmable`] tools
    /// that the approval policy would gate right now, and only when this bridge
    /// holds an interactive channel. Without one (the network MCP route, a
    /// detached run) this returns `Ok` and the approval gate queues the call in
    /// the Approvals inbox exactly as before; it never treats "nobody to ask" as
    /// consent. An "Allow" is recorded as a grant that the gate consumes after
    /// its organization-policy check, so it cannot override an admin denial.
    pub(super) async fn require_in_chat_consent(
        &self,
        gate_id: &str,
        args: &Value,
    ) -> Result<(), McpError> {
        use crate::approvals::chat_grants;
        let (Some(tx), Some(conversation_id)) = (
            self.permission_tx.as_ref(),
            self.permission_scope_id.as_deref(),
        ) else {
            return Ok(());
        };
        if !chat_grants::chat_confirmable(gate_id)
            || chat_grants::allowed_for_conversation(conversation_id, gate_id)
        {
            return Ok(());
        }
        let agent_approval_tools = match self.mcp.agent_store.as_ref() {
            Some(store) => store
                .get(&self.agent_id)
                .await
                .ok()
                .flatten()
                .map(|record| record.approval_tools)
                .unwrap_or_default(),
            None => Vec::new(),
        };
        if !chat_grants::would_gate(gate_id, &agent_approval_tools).await {
            return Ok(());
        }
        let title = in_chat_consent_title(gate_id, args);
        let raw_input = if args.is_object() {
            args.clone()
        } else {
            json!({ "arguments": args })
        };
        let chosen = crate::sidecar::adapters::acp::request_user_permission(
            tx,
            json!({
                "title": title,
                "kind": gate_id,
                "rawInput": raw_input,
                "fields": { "title": title }
            }),
            consent_options(gate_id),
            Some(conversation_id.to_owned()),
        )
        .await;
        match chosen.as_deref() {
            Some("allow_once") => {
                chat_grants::grant_once(conversation_id, gate_id, args);
                Ok(())
            }
            // Never offered for a Gateway or routing change; refuse a forged answer.
            Some("allow_session") if !is_gateway_settings_change(gate_id) => {
                chat_grants::grant_for_conversation(conversation_id, gate_id);
                Ok(())
            }
            _ => Err(McpError::new(
                rmcp::model::ErrorCode::INVALID_REQUEST,
                format!(
                    "The user declined `{gate_id}`; it was not run. Do not retry it unless \
                     the user asks again."
                ),
                None,
            )),
        }
    }

    /// `ask_user`: render a Question card and either wait for the answer or,
    /// when the agent marked it async or nobody is available, return at once.
    pub(super) async fn dispatch_ask_user(&self, args: &Value) -> Result<String, McpError> {
        let Some(mut input) = super::super::acp_question_input(ASK_USER_TOOL, args) else {
            return Err(McpError::new(
                rmcp::model::ErrorCode::INVALID_PARAMS,
                "ask_user needs a non-empty `questions` array whose items carry a `question`"
                    .to_owned(),
                None,
            ));
        };
        let Some(tx) = self.permission_tx.as_ref() else {
            return Ok(ask_user_unreachable_reply());
        };
        let conversation_id = self.permission_scope_id.clone().unwrap_or_default();
        let requested_async = args.get("async").and_then(Value::as_bool).unwrap_or(false);
        let reason = if requested_async {
            Some("marked non-urgent")
        } else if crate::presence::questions_deferred() {
            Some("the user is away")
        } else if conversation_id.is_empty() {
            Some("no conversation to answer in")
        } else {
            None
        };
        let question_id = next_ask_user_id();
        input["toolCallId"] = Value::String(question_id.clone());
        input["async"] = Value::Bool(reason.is_some());
        let questions = input.get("questions").cloned().unwrap_or(Value::Null);

        if let Some(reason) = reason {
            let _ = tx.send(AcpEvent::QuestionRequest {
                tool_call_id: question_id.clone(),
                input,
            });
            let _ = tx.send(AcpEvent::ToolResult {
                id: question_id,
                status: "completed".to_owned(),
                output: Some(crate::sidecar::adapters::acp::deferred_question_output()),
                input: None,
            });
            return Ok(ask_user_async_reply(reason));
        }

        // The stream the card rides on may already be gone (the turn ended or
        // the client disconnected). Nobody can see or answer the question
        // then, and the presence poll below would not notice, so tell the agent
        // at once instead of holding the tool call for the whole window.
        let Some(mut rx) =
            crate::sidecar::adapters::acp::post_question(tx, &conversation_id, &question_id, input)
        else {
            return Ok(ask_user_unreachable_reply());
        };
        let deadline = tokio::time::Instant::now() + ASK_USER_BLOCKING_TIMEOUT;
        let outcome = loop {
            tokio::select! {
                answer = &mut rx => break answer.ok(),
                () = tokio::time::sleep(ASK_USER_PRESENCE_POLL) => {
                    if crate::presence::questions_deferred()
                        || tokio::time::Instant::now() >= deadline
                    {
                        break None;
                    }
                }
            }
        };
        match outcome {
            Some(answers) => {
                let _ = tx.send(AcpEvent::ToolResult {
                    id: question_id,
                    status: "completed".to_owned(),
                    output: Some(json!({ "answers": answers.clone() })),
                    input: None,
                });
                Ok(format_question_answers(&questions, &answers))
            }
            None => {
                // The user left or never answered: keep the card open as an
                // async question and let the agent carry on.
                crate::sidecar::adapters::acp::cancel_question(&conversation_id, &question_id);
                let _ = tx.send(AcpEvent::ToolResult {
                    id: question_id,
                    status: "completed".to_owned(),
                    output: Some(crate::sidecar::adapters::acp::deferred_question_output()),
                    input: None,
                });
                Ok(ask_user_async_reply("no answer yet"))
            }
        }
    }
}

impl rmcp::ServerHandler for RyuMcpHandler {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::default()
            .with_server_info(Implementation::from_build_env())
            .with_protocol_version(ProtocolVersion::LATEST)
    }

    async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: RequestContext<rmcp::RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(
            self.build_tool_list().await,
        ))
    }

    async fn call_tool(
        &self,
        request: rmcp::model::CallToolRequestParams,
        _context: RequestContext<rmcp::RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let args: Value = request
            .arguments
            .clone()
            .map(Value::Object)
            .unwrap_or(Value::Null);
        let text = self.dispatch_tool(request.name.as_ref(), args).await?;
        Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
    }
}
