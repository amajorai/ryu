use reqwest::Client;
use serde_json::{json, Value};
use tracing::{debug, info, warn};

use crate::config::ComposioConfig;
use crate::error::GatewayError;
use crate::providers::Provider;

/// Default Composio REST base (v3.1, current as of 2026-06). The old `/api/v1`
/// is gone; v3.1 executes tools at `/tools/execute/{tool_slug}`. Swappable via
/// `COMPOSIO_BASE_URL` so a future surface change is one env, not a rebuild
/// (kept in sync with `apps/core/src/composio_catalog`).
const DEFAULT_COMPOSIO_BASE_URL: &str = "https://backend.composio.dev/api/v3.1";

fn composio_base_url() -> String {
    std::env::var("COMPOSIO_BASE_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| DEFAULT_COMPOSIO_BASE_URL.to_string())
}

pub struct ComposioClient {
    http: Client,
    config: ComposioConfig,
}

impl ComposioClient {
    pub fn new(config: ComposioConfig, http: Client) -> Self {
        Self { http, config }
    }

    /// Return the list of allowlisted Composio action names.
    pub fn actions(&self) -> &[String] {
        &self.config.actions
    }

    /// Inject allowlisted Composio actions as tool definitions into the
    /// request body so the model can emit `tool_call` turns for them.
    ///
    /// Each action is represented as a minimal OpenAI-compatible tool
    /// definition. Full JSON-Schema parameter schemas require a live fetch
    /// from `/actions/{name}` which is done lazily; the injected stub is
    /// sufficient for the model to choose the action and pass its own
    /// arguments — the gateway validates against the allowlist on execution.
    ///
    /// Only injects when `body["tools"]` is absent or empty so callers can
    /// provide their own tool definitions without being overwritten.
    ///
    /// `allowed` is the effective action allowlist for this request: the
    /// per-agent set Core forwarded (`x-ryu-composio-actions`) when present, else
    /// the gateway's global `config.actions` (#456). The execution check in
    /// [`run_tool_loop`] uses the same slice so injection and gating agree.
    pub fn inject_tools(&self, body: &mut Value, allowed: &[String]) {
        if allowed.is_empty() {
            return;
        }

        // Respect any tool list the caller already built.
        let already_has_tools = body["tools"]
            .as_array()
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        if already_has_tools {
            return;
        }

        let tool_defs: Vec<Value> = allowed
            .iter()
            .map(|action_name| {
                json!({
                    "type": "function",
                    "function": {
                        "name": action_name,
                        "description": format!(
                            "Composio action '{}'. Pass the required parameters \
                             as JSON in the arguments field.",
                            action_name
                        ),
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "arguments": {
                                    "type": "object",
                                    "description": "Action-specific parameters"
                                }
                            }
                        }
                    }
                })
            })
            .collect();

        debug!(
            count = tool_defs.len(),
            "injecting Composio tool definitions"
        );
        body["tools"] = json!(tool_defs);
    }

    /// Execute a single Composio action by name.
    ///
    /// The `entity_id` parameter selects the connected-account owner in
    /// Composio's entity model. Pass the caller's user-id (from the
    /// `x-ryu-user-id` header) when available; fall back to the configured
    /// default (`COMPOSIO_ENTITY_ID` env, or `"default"` for single-user
    /// setups).
    ///
    /// Returns the `data` field from the Composio response, or an error.
    pub async fn execute(
        &self,
        action_name: &str,
        input: Value,
        entity_id: &str,
    ) -> Result<Value, GatewayError> {
        let api_key =
            self.config.api_key.as_deref().ok_or_else(|| {
                GatewayError::Internal(anyhow::anyhow!("Composio API key not set"))
            })?;

        // v3.1: POST /tools/execute/{tool_slug} with { arguments, user_id }.
        let url = format!("{}/tools/execute/{action_name}", composio_base_url());

        debug!(action = action_name, entity_id, "executing Composio action");

        let resp = self
            .http
            .post(&url)
            .header("x-api-key", api_key)
            .header("Content-Type", "application/json")
            .json(&json!({
                "arguments": input,
                "user_id": entity_id,
                "entity_id": entity_id,
            }))
            .send()
            .await
            .map_err(|e| GatewayError::Internal(e.into()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            // The error body is third-party integration data (may carry PII);
            // log only its size, never its content.
            let body = resp.text().await.unwrap_or_default();
            warn!(action = action_name, %status, body_len = body.len(), "Composio action failed");
            return Err(GatewayError::ProviderError(format!(
                "Composio action {action_name} failed: {status}"
            )));
        }

        let mut body: Value = resp
            .json()
            .await
            .map_err(|e| GatewayError::Internal(e.into()))?;

        // Composio wraps results in a `data` field; unwrap it if present.
        Ok(body["data"].take())
    }

    /// Run the agentic tool-call loop for a non-streaming request.
    ///
    /// After each provider completion, checks the response for `tool_calls`.
    /// Allowed tool calls are executed via Composio; their results are appended
    /// as `tool` messages and the loop continues until no tool calls remain or
    /// `max_rounds` is reached.
    ///
    /// `entity_id` is passed to `execute()` on every action call to select
    /// the correct connected account. Callers should prefer
    /// `RequestContext::user_id` and fall back to `ComposioConfig::entity_id`.
    ///
    /// Returns the final assistant turn plus the number of executed (billable)
    /// Composio actions across all rounds. Every action this loop dispatches is a
    /// Composio execution, so the count is every allowed call reaching `execute`;
    /// allowlist-denied calls are not counted. The caller debits them at cost
    /// (#496 managed-plan tool-call cost).
    pub async fn run_tool_loop(
        &self,
        body: &mut Value,
        provider: &dyn Provider,
        model: &str,
        entity_id: &str,
        allowed: &[String],
    ) -> Result<(Value, u64), GatewayError> {
        // Inject action tool definitions before the first completion so the
        // model knows which actions are available (scoped to `allowed`).
        self.inject_tools(body, allowed);

        let mut response = provider.complete(model, body).await?;
        let mut billable_tool_calls: u64 = 0;

        for round in 0..self.config.max_rounds {
            let tool_calls = match response["choices"][0]["message"]["tool_calls"].as_array() {
                Some(tc) if !tc.is_empty() => tc.clone(),
                _ => break, // no tool calls — done
            };

            info!(round, count = tool_calls.len(), "Composio tool-call round");

            // Append the assistant turn with the tool_calls.
            if let Some(msgs) = body["messages"].as_array_mut() {
                msgs.push(response["choices"][0]["message"].clone());
            }

            // Execute each tool call and inject results.
            for tc in &tool_calls {
                let name = tc["function"]["name"].as_str().unwrap_or("");
                let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
                let tool_call_id = tc["id"].as_str().unwrap_or("");

                let input: Value = serde_json::from_str(args_str).unwrap_or(json!({}));

                let result = if allowed.iter().any(|a| a == name) {
                    billable_tool_calls = billable_tool_calls.saturating_add(1);
                    match self.execute(name, input, entity_id).await {
                        Ok(r) => r,
                        Err(e) => {
                            warn!(action = name, error = %e, "Composio action error; returning error result");
                            json!({ "error": e.to_string() })
                        }
                    }
                } else {
                    warn!(action = name, "Composio action not in allowlist; skipping");
                    json!({ "error": format!("action '{name}' not allowed") })
                };

                if let Some(msgs) = body["messages"].as_array_mut() {
                    msgs.push(json!({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": result.to_string(),
                    }));
                }
            }

            // Follow-up completion with tool results injected.
            response = provider.complete(model, body).await?;
        }

        Ok((response, billable_tool_calls))
    }
}
