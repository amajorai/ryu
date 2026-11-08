use serde_json::{json, Value};
use tracing::debug;

use super::tenant::{valid_connection_id, ComposioTenantScope};
use super::ComposioClient;
use crate::error::GatewayError;

impl ComposioClient {
    /// An org-bound request must never select the shared single-user fallback.
    /// `user_id` here is the identity already accepted by Gateway authentication,
    /// not a raw request header.
    pub fn entity_for_request(
        &self,
        org_id: Option<&str>,
        user_id: Option<&str>,
    ) -> Result<String, GatewayError> {
        if let Some(org_id) = org_id {
            let tenant = ComposioTenantScope::new(org_id)?;
            return Ok(tenant.entity_for_user(user_id));
        }
        Ok(user_id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(self.config.entity_id.as_str())
            .to_owned())
    }

    /// Composio may accept a specific connected-account id independently of
    /// `user_id`. Check its provider-recorded owner before any tenant action:
    /// it must be org-shared, an app account, or the caller's own entity.
    pub async fn connection_user_for_tenant(
        &self,
        connection_id: &str,
        tenant: &ComposioTenantScope,
        caller_user_id: Option<&str>,
    ) -> Result<String, GatewayError> {
        if !valid_connection_id(connection_id) {
            return Err(GatewayError::BadRequest(
                "invalid Composio connected account id".to_owned(),
            ));
        }
        let value = self
            .request_json(
                reqwest::Method::GET,
                &format!("/connected_accounts/{connection_id}"),
                None,
            )
            .await?;
        let account = if value.get("id").is_some() {
            &value
        } else {
            value.get("data").unwrap_or(&value)
        };
        let user_id = account.get("user_id").and_then(Value::as_str);
        if account.get("id").and_then(Value::as_str) != Some(connection_id)
            || !user_id.is_some_and(|value| tenant.owns_user_id(value, caller_user_id))
        {
            return Err(GatewayError::PolicyViolation(
                "Composio account is unavailable for this organization".to_owned(),
            ));
        }
        Ok(user_id.expect("checked above").to_owned())
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
}

#[cfg(test)]
#[path = "routing_tests.rs"]
mod tests;
