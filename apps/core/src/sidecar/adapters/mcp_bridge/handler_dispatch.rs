use super::*;

impl RyuMcpHandler {
    /// Run one tool call and return the **model-facing text** for it.
    ///
    /// The whole body of [`rmcp::ServerHandler::call_tool`] lives here so both
    /// transports share one dispatch path byte for byte: the in-process ACP bridge
    /// (through the `ServerHandler` impl below) and the network JSON-RPC endpoint
    /// (through [`serve_http_jsonrpc`]). It takes no `RequestContext` because the
    /// `ServerHandler` methods never read theirs — which is exactly why the HTTP
    /// transport could be hand-rolled instead of pulling in an rmcp server
    /// transport whose only contribution would have been to manufacture that
    /// unused context.
    ///
    /// Every governance layer therefore applies identically on both transports:
    /// the capability gates, the mandatory persisted agent-configuration approval,
    /// the allowlist recheck inside `McpRegistry::call_tool`, the approval engine,
    /// and the untrusted-
    /// content boundary at the model edge. There is no second, laxer path.
    pub(super) async fn dispatch_tool(
        &self,
        tool_id: &str,
        args: Value,
    ) -> Result<String, McpError> {
        if matches!(tool_id, "execute" | "resume") {
            check_programmatic_tool_availability(
                tool_id,
                &self.agent_id,
                crate::fleet::is_agent_available(&self.agent_id),
            )?;
        }

        // Retained for the widget-emit path (the `_` arm moves `args` into
        // `call_tool_with_identity`).
        let tool_input = args.clone();

        if self.verified_plan_only().await && !tool_id.starts_with("plans.") {
            return Err(McpError::new(
                rmcp::model::ErrorCode::INVALID_REQUEST,
                "verified agent direct tool call denied; submit a typed plan with plans.submit",
                None,
            ));
        }

        if tool_id == ASK_USER_TOOL {
            return self.dispatch_ask_user(&args).await;
        }

        // The profile builder carries an explicit source ceiling. Do not let a
        // model route around it by embedding another registry call in PTC code;
        // the PTC invoker has no profile-scope channel of its own.
        if (self.composio_connection_scope.is_some() || self.conversation_scope.is_some())
            && matches!(tool_id, "execute" | "resume")
        {
            return Err(McpError::new(
                rmcp::model::ErrorCode::INVALID_REQUEST,
                "programmatic tool execution is unavailable during profile bootstrap",
                None,
            ));
        }

        // `execute` and `resume` are meta-tools, not registry entries, so the
        // normal registry allowlist check below cannot see them. An explicit
        // agent allowlist must opt into each programmatic surface; otherwise a
        // model could invoke PTC even when the agent excludes it.
        if matches!(tool_id, "execute" | "resume")
            && self.allowlist.as_ref().is_some_and(|allowlist| {
                !allowlist
                    .iter()
                    .any(|entry| entry == "*" || entry == tool_id)
            })
        {
            return Err(McpError::new(
                rmcp::model::ErrorCode::INVALID_REQUEST,
                format!("meta-tool '{tool_id}' is not in this agent's allowlist"),
                None,
            ));
        }

        // Capability gate (defense in depth): these tools are filtered out of the
        // advertised set for an agent that lacks the capability, but a model can
        // still emit a call to a tool it was never offered — refuse it here too.
        let normalized_tool_id = self.mcp.canonical_tool_id_for_registry(tool_id);
        let (annotations, http_method) = self.mcp.tool_effect_metadata(&normalized_tool_id).await;
        if let Err(error) = crate::agent_execution::ensure_tool_allowed_with_metadata(
            self.mcp.agent_store.as_ref(),
            Some(&self.agent_id),
            &normalized_tool_id,
            annotations.as_ref(),
            http_method.as_deref(),
        )
        .await
        {
            return Err(McpError::new(
                rmcp::model::ErrorCode::INVALID_REQUEST,
                error.to_string(),
                None,
            ));
        }
        let server_prefix = self
            .mcp
            .split_registered_tool_id(&normalized_tool_id)
            .map(|(server, _)| server)
            .unwrap_or_default();
        let orchestration_tool = server_prefix == crate::sidecar::mcp::delegate::SERVER_NAME
            || server_prefix == crate::sidecar::mcp::orchestrator::SERVER_NAME;
        if orchestration_tool && !self.caps.orchestrator {
            return Err(McpError::new(
                rmcp::model::ErrorCode::INVALID_REQUEST,
                format!(
                    "tool '{tool_id}' requires the orchestrator capability, which is disabled for this agent"
                ),
                None,
            ));
        }
        let creates_agents = normalized_tool_id == crate::sidecar::mcp::CREATE_AGENT_TOOL_ID
            || normalized_tool_id == crate::sidecar::mcp::CREATE_AGENT_TEAM_TOOL_ID;
        if creates_agents && !self.caps.can_create_agents {
            return Err(McpError::new(
                rmcp::model::ErrorCode::INVALID_REQUEST,
                format!(
                    "tool '{tool_id}' requires the agent-creation capability, which is disabled for this agent"
                ),
                None,
            ));
        }
        // App aliases must obtain the same interactive grant as their backend,
        // matching the ACL and operator-review target chosen by the registry.
        let (configuration_target, _) =
            self.mcp.approval_target_for_tool(&normalized_tool_id).await;
        let configure_approved =
            crate::runnable::agent_configuration_policy::requires_operator_approval(
                &self
                    .mcp
                    .canonical_tool_id_for_registry(&configuration_target),
            );
        if configure_approved {
            if crate::sidecar::control_plane::is_managed_node() {
                return Err(McpError::new(
                    rmcp::model::ErrorCode::INVALID_REQUEST,
                    "agent-builder configuration is disabled on managed nodes until agent ownership is bound to the verified caller"
                        .to_owned(),
                    None,
                ));
            }
            require_agent_builder_configure_permission(
                &self.permission_tx,
                self.permission_scope_id.as_deref(),
                &args,
            )
            .await?;
        } else {
            // Actions that drive Ryu itself (its HTTP API, an app's API, the
            // interface switch) ask in this chat rather than the Approvals inbox.
            self.require_in_chat_consent(&configuration_target, &args)
                .await?;
        }

        // ── Meta-tool dispatch arms (BEFORE the registry fallthrough) ──────────
        let result: Value = match tool_id {
            "tool_search" => self.dispatch_tool_search(&args).await?,
            "describe" => self.dispatch_describe(&args).await?,
            "execute" if tool_exec::is_available() => {
                let code = args
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let caller: Arc<dyn tool_exec::ToolCaller> = self.mcp.clone();
                let invoker = std::sync::Arc::new(
                    tool_exec::SandboxToolInvoker::registry_with_identity_and_conversation(
                        caller,
                        self.agent_id.clone(),
                        self.allowlist.clone(),
                        None,
                        self.current_identity_profiles().await?,
                        self.permission_scope_id.clone(),
                    ),
                );
                let outcome = tool_exec::execute_code(code, invoker, &self.agent_id).await;
                serde_json::to_value(outcome).map_err(|e| {
                    McpError::new(rmcp::model::ErrorCode::INTERNAL_ERROR, e.to_string(), None)
                })?
            }
            "resume" if tool_exec::is_available() => {
                let execution_id = args
                    .get("executionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let action = args
                    .get("action")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let content = args.get("content").cloned().unwrap_or(Value::Null);
                let outcome =
                    tool_exec::resume_execution(execution_id, &self.agent_id, action, content)
                        .await;
                serde_json::to_value(outcome).map_err(|e| {
                    McpError::new(rmcp::model::ErrorCode::INTERNAL_ERROR, e.to_string(), None)
                })?
            }
            // Registry fallthrough (incl. Composio by `composio.<slug>` id): the
            // allowlist is enforced inside `call_tool` (no direct-egress path).
            // The Identity Vault consult (epic #517) runs first inside
            // `call_tool_with_identity` for the agent's bound profiles.
            _ => self
                .mcp
                .call_tool_with_identity_scoped_authorized(
                    // The calling agent, so its configured `approval_tools`
                    // (policy Layer A) feed the approval gate.
                    Some(&self.agent_id),
                    tool_id,
                    args,
                    self.allowlist.as_deref(),
                    None,
                    &self.current_identity_profiles().await?,
                    // Reuse the server-derived conversation id as the ACP
                    // session marker. The registry uses this to notify the
                    // Gateway when a Composio action executes inside the
                    // in-process bridge; the HTTP Gateway loop leaves this
                    // argument unset because it meters its own call.
                    self.permission_scope_id.clone(),
                    // THE AGENT-PLANE PRINCIPAL. `permission_scope_id` IS the host
                    // conversation id (`acp.rs` keys the whole instance by it), so
                    // the agent's tool calls are authorized as the OWNER of the
                    // conversation the turn is running in — resolved fresh at
                    // dispatch, never cached at build time. This is what stops Bob's
                    // agent reading Alice's chats through `threads.read_thread` /
                    // `search_conversations.search`.
                    //
                    // On the HTTP transport it is `None` (there is no conversation),
                    // which lowers to a fail-closed `Unresolved` principal on a bound
                    // node — the conversation-reading tools refuse rather than guess.
                    // See [`serve_http_jsonrpc`] for why a client-supplied id must
                    // never be threaded in here to "fix" that.
                    self.permission_scope_id.as_deref(),
                    self.composio_connection_scope.as_deref(),
                    self.conversation_scope.as_deref(),
                    configure_approved,
                )
                .await
                .map_err(|e| {
                    McpError::new(rmcp::model::ErrorCode::INTERNAL_ERROR, e.to_string(), None)
                })?,
        };

        // Widget emit (D1): the MCP bridge is the single choke point for both
        // planes, so a tool that resolves to a `WidgetBinding` emits the widget
        // side-channel here, keyed to the tool call, in addition to the normal
        // text result. Only on the interactive/streaming path (a `permission_tx`
        // is present); headless callers — every HTTP caller included — get the
        // text result and no widget.
        if let Some(tx) = &self.permission_tx {
            // ACP plane: the bridge does not know the ACP-side tool-call id, so it
            // passes `None` and `build_widget_event` derives the synthetic
            // `wgtcall_{instance_id}` (behaviour unchanged). The Core OpenAI-compat
            // chat loop passes the REAL `tool_calls[].id` instead (R1 / A0).
            if let Some(event) = build_widget_event(
                &self.mcp,
                tool_id,
                &tool_input,
                &result,
                None,
                self.permission_scope_id.clone(),
                self.agent_id.clone(),
            )
            .await
            {
                let _ = tx.send(AcpEvent::ToolWidget(Box::new(event)));
            }
        }

        let text = match result {
            Value::String(s) => s,
            other => other.to_string(),
        };
        // Injection defense: external/registry/Composio tool RESULTS re-entering
        // the ACP model are untrusted (poisoned web/tool output can impersonate
        // the transcript). See `neutralize_external_result`.
        Ok(neutralize_external_result(tool_id, text))
    }
}

pub(super) fn check_programmatic_tool_availability(
    tool_id: &str,
    agent_id: &str,
    agent_available: bool,
) -> Result<(), McpError> {
    if !matches!(tool_id, "execute" | "resume") || agent_available {
        return Ok(());
    }
    Err(McpError::new(
        rmcp::model::ErrorCode::INVALID_REQUEST,
        format!("agent '{agent_id}' is unavailable under the node's organization policy"),
        None,
    ))
}
