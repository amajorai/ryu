use serde_json::{json, Value};
use tracing::{debug, warn};

use super::tenant::valid_action_slug;
use super::ComposioClient;
use crate::error::GatewayError;

impl ComposioClient {
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
        self.execute_with_connection(action_name, input, entity_id, None)
            .await
    }

    /// Execute with an optional connected-account id selected by an app such as
    /// Outpost. The entity remains Gateway-owned; the connection id is only a
    /// provider operation argument and never a credential.
    pub async fn execute_with_connection(
        &self,
        action_name: &str,
        input: Value,
        entity_id: &str,
        connected_account_id: Option<&str>,
    ) -> Result<Value, GatewayError> {
        let mut response = self
            .execute_response(action_name, input, entity_id, connected_account_id, None)
            .await?;
        Ok(response["data"].take())
    }

    pub async fn execute_metered(
        &self,
        action_name: &str,
        input: Value,
        entity_id: &str,
        connected_account_id: Option<&str>,
    ) -> Result<(Value, u64, String), GatewayError> {
        self.execute_metered_within(action_name, input, entity_id, connected_account_id, None)
            .await
    }

    /// [`Self::execute_metered`] with a per-call upstream timeout in place of the
    /// client's default, for tools known to run long (a `file_uploadable` tool
    /// that pulls a staged file and pushes it to the platform). A timeout after
    /// the request was sent is [`GatewayError::ProviderDeliveryUncertain`]: the
    /// tool may still complete upstream, so callers must not blindly retry it.
    pub async fn execute_metered_within(
        &self,
        action_name: &str,
        input: Value,
        entity_id: &str,
        connected_account_id: Option<&str>,
        timeout: Option<std::time::Duration>,
    ) -> Result<(Value, u64, String), GatewayError> {
        let mut response = self
            .execute_response(action_name, input, entity_id, connected_account_id, timeout)
            .await?;
        let client = receipt_client()?;
        // Bind the billing log to the identity this request selected: the
        // pinned account, or (when none was pinned) the Gateway-owned entity,
        // whose ownership of the logged account the receipt verifies.
        let expected = connected_account_id.map_or(
            ryu_composio::receipt::ExpectedExecutionIdentity::Entity(entity_id),
            ryu_composio::receipt::ExpectedExecutionIdentity::ConnectedAccount,
        );
        let receipt = ryu_composio::receipt::execution_receipt(
            client,
            &self.base_url(),
            self.config.api_key.as_deref().unwrap_or(""),
            &response,
            expected,
        )
        .await
        .map_err(|_| GatewayError::AccountingUnavailable)?;
        let charge = ryu_gw_contracts::composio_billing::price_composio_usage(
            &receipt.usage,
            &self.config.billing,
            1,
        )
        .map_err(|_| GatewayError::AccountingUnavailable)?;
        Ok((
            response["data"].take(),
            charge.total_micro_usd,
            receipt.transaction_id,
        ))
    }

    pub(super) async fn execute_response(
        &self,
        action_name: &str,
        input: Value,
        entity_id: &str,
        connected_account_id: Option<&str>,
        timeout: Option<std::time::Duration>,
    ) -> Result<Value, GatewayError> {
        if !valid_action_slug(action_name) {
            return Err(GatewayError::BadRequest(
                "Composio tool id must be a plain action slug".to_owned(),
            ));
        }
        let api_key =
            self.config.api_key.as_deref().ok_or_else(|| {
                GatewayError::Internal(anyhow::anyhow!("Composio API key not set"))
            })?;

        // v3.1: POST /tools/execute/{tool_slug} with { arguments, user_id }.
        let url = format!("{}/tools/execute/{action_name}", self.base_url());

        debug!(action = action_name, entity_id, "executing Composio action");

        let mut payload = json!({
            "arguments": input,
            "user_id": entity_id,
            "entity_id": entity_id,
        });
        if let Some(connection_id) = connected_account_id {
            payload["connected_account_id"] = Value::String(connection_id.to_owned());
        }
        let mut request = self
            .http
            .post(&url)
            .header("x-api-key", api_key)
            .header("Content-Type", "application/json")
            .json(&payload);
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        let resp = request.send().await.map_err(|error| {
            if error.is_timeout() {
                // The action may still be running upstream; say so rather than
                // reporting a failure the caller would retry.
                GatewayError::ProviderDeliveryUncertain(format!(
                    "Composio action {action_name} did not answer in time; its outcome is unknown"
                ))
            } else {
                GatewayError::Internal(error.into())
            }
        })?;

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

        let body: Value = resp
            .json()
            .await
            .map_err(|e| GatewayError::Internal(e.into()))?;

        Ok(body)
    }
}

/// Shared no-redirect client for billing-receipt fetches, so each metered
/// execution reuses pooled connections instead of a new TLS handshake.
pub(super) fn receipt_client() -> Result<&'static reqwest::Client, GatewayError> {
    static RECEIPT_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(client) = RECEIPT_CLIENT.get() {
        return Ok(client);
    }
    let built = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| GatewayError::Internal(error.into()))?;
    Ok(RECEIPT_CLIENT.get_or_init(|| built))
}
