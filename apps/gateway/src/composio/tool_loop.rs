use serde_json::{json, Value};
use tracing::{info, warn};

use super::ComposioClient;
use crate::error::GatewayError;
use crate::providers::Provider;

impl ComposioClient {
    /// Run the agentic tool-call loop for a non-streaming request.
    ///
    /// After each provider completion, checks the response for `tool_calls`.
    /// Allowed calls use Core's governed dispatcher when it is configured;
    /// standalone Gateway executes its configured Composio actions directly.
    /// Results are appended
    /// as `tool` messages and the loop continues until no tool calls remain or
    /// `max_rounds` is reached.
    ///
    /// `entity_id` selects the connected account. Core's legacy `user_id` wire
    /// field carries this selector; Core resolves owner authority independently
    /// from its ToolPrincipal and refuses unresolved shared-node callers.
    /// `agent_id` comes from the authenticated request context. Callers prefer
    /// `RequestContext::user_id` and fall back to `ComposioConfig::entity_id`.
    ///
    /// Returns the final assistant turn and a zero compatibility counter.
    /// Core settles its own execution receipts;
    /// standalone executions settle through `on_charge`. The returned count is
    /// zero so the pipeline cannot debit either path a second time.
    pub async fn run_tool_loop_for_session(
        &self,
        body: &mut Value,
        provider: &dyn Provider,
        model: &str,
        entity_id: &str,
        allowed: &[String],
        catalog: Option<&dyn crate::tools::CoreCatalog>,
        agent_id: Option<&str>,
        session: Option<&str>,
        firewall: Option<&crate::tools::ToolLoopFirewall>,
        org_tools: &crate::policy::OrgToolGate,
        on_charge: &(dyn Fn(u64, &str) + Send + Sync),
    ) -> Result<(Value, u64), GatewayError> {
        // Inject action tool definitions before the first completion so the
        // model knows which actions are available (scoped to `allowed`, minus
        // anything the organization's tool policy denies).
        let offered: Vec<String> = allowed
            .iter()
            .filter(|action| {
                org_tools.permits(&format!(
                    "{}{}",
                    crate::tools::catalog_client::COMPOSIO_TOOL_PREFIX,
                    action
                ))
            })
            .cloned()
            .collect();
        self.inject_tools(body, &offered);

        let mut response = provider.complete_for_session(model, body, session).await?;

        for round in 0..self.config.max_rounds {
            let tool_calls = match response["choices"][0]["message"]["tool_calls"].as_array() {
                Some(tc) if !tc.is_empty() => tc.clone(),
                _ => break, // no tool calls — done
            };

            info!(round, count = tool_calls.len(), "Composio tool-call round");

            // Screen the model turn (its text and every action's arguments)
            // before any action runs or the turn is sent back to the provider.
            if let Some(firewall) = firewall {
                firewall.screen_appended(&response["choices"][0]["message"])?;
                firewall
                    .screen_hazard(
                        &response["choices"][0]["message"],
                        crate::tools::ToolRoundPart::ModelTurn,
                        round,
                    )
                    .await?;
                // A suspension pushed mid-loop stops it before any action runs.
                firewall.check_standing().await?;
            }

            // Append the assistant turn with the tool_calls.
            if let Some(msgs) = body["messages"].as_array_mut() {
                msgs.push(response["choices"][0]["message"].clone());
            }

            // Execute each tool call and inject results.
            for tc in &tool_calls {
                let name = tc["function"]["name"].as_str().unwrap_or("");
                let arguments = crate::tools::call_arguments(tc);
                let args_str: &str = &arguments;
                let tool_call_id = tc["id"].as_str().unwrap_or("");

                let input: Value = serde_json::from_str(args_str).unwrap_or(json!({}));

                let tool_span = crate::telemetry::gen_ai_span::execute_tool_span(
                    name,
                    tool_call_id,
                    "extension",
                );
                // Only a successful action RESULT is untrusted external content;
                // denials and error envelopes are Gateway-generated.
                let mut is_external_result = false;
                let tool_id = format!(
                    "{}{}",
                    crate::tools::catalog_client::COMPOSIO_TOOL_PREFIX,
                    name
                );
                let denied = firewall.and_then(|firewall| firewall.deny_call(&tool_id, args_str));
                let result = if !allowed.iter().any(|a| a == name) {
                    warn!(action = name, "Composio action not in allowlist; skipping");
                    json!({ "error": format!("action '{name}' not allowed") })
                } else if let Err(reason) = org_tools.check(&tool_id) {
                    // The organization's tool policy (C2) applies before both the
                    // Core catalog and the direct provider branch.
                    json!({ "error": reason })
                } else if let Some(reason) = denied {
                    warn!(action = name, %reason, "Composio action denied by the Gateway firewall");
                    json!({ "error": format!("action denied ({reason})") })
                } else if let Some(catalog) = catalog {
                    // Core owns the persisted connection ceiling, owner and
                    // approval checks, and the execution charge. A refusal or
                    // unreachable Core must never fall back to provider access.
                    match tracing::Instrument::instrument(
                        catalog.call_tool(
                            &format!(
                                "{}{}",
                                crate::tools::catalog_client::COMPOSIO_TOOL_PREFIX,
                                name
                            ),
                            input,
                            agent_id,
                            // This wire field is only an entity selector;
                            // it cannot supply Core's ToolPrincipal authority.
                            Some(entity_id),
                            None,
                            None,
                            false,
                        ),
                        tool_span.clone(),
                    )
                    .await
                    {
                        Ok(result) => {
                            is_external_result = true;
                            result
                        }
                        Err(error) => json!({ "error": error }),
                    }
                } else {
                    match tracing::Instrument::instrument(
                        self.execute_metered(name, input, entity_id, None),
                        tool_span.clone(),
                    )
                    .await
                    {
                        Ok((result, cost, transaction_id)) => {
                            // Settle each execution before a later model turn can
                            // fail. The provider log ID deduplicates wallet retries.
                            on_charge(cost, &transaction_id);
                            is_external_result = true;
                            result
                        }
                        Err(GatewayError::AccountingUnavailable) => {
                            return Err(GatewayError::AccountingUnavailable)
                        }
                        Err(e) => {
                            warn!(action = name, error = %e, "Composio action error; returning error result");
                            json!({ "error": e.to_string() })
                        }
                    }
                };
                crate::telemetry::gen_ai_span::record_tool_result(&tool_span, &result);
                drop(tool_span);

                // Screen the raw result before it is wrapped or redacted, so a
                // blocking match ends the loop instead of reaching the next round.
                if let Some(firewall) = firewall {
                    firewall.screen_appended(&result)?;
                    firewall
                        .screen_hazard(&result, crate::tools::ToolRoundPart::ToolResult, round)
                        .await?;
                }

                // Mail, documents and other action output is attacker-reachable
                // content: screen it with the request firewall and wrap it in
                // untrusted-content markers, exactly as the unified loop does.
                let content = if is_external_result {
                    crate::tools::external_tool_result_content(firewall, name, &result)
                } else {
                    result.to_string()
                };
                if let Some(msgs) = body["messages"].as_array_mut() {
                    msgs.push(json!({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": content,
                    }));
                }
            }

            // Follow-up completion with tool results injected.
            if let Some(firewall) = firewall {
                firewall.check_standing().await?;
            }
            response = provider.complete_for_session(model, body, session).await?;
        }

        // Per-execution receipts already settled the tools. The shared loop
        // interface's second value is zero, so callers cannot double-debit.
        Ok((response, 0))
    }
}
