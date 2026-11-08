use serde_json::{json, Value};

use super::tenant::valid_connection_id;
use super::ComposioClient;
use crate::error::GatewayError;

impl ComposioClient {
    /// Read the managed Composio action catalog for one toolkit. The caller only
    /// receives catalog metadata; the API key stays in this Gateway process.
    pub async fn list_tools(&self, toolkit_slug: &str) -> Result<Value, GatewayError> {
        let api_key =
            self.config.api_key.as_deref().ok_or_else(|| {
                GatewayError::Internal(anyhow::anyhow!("Composio API key not set"))
            })?;
        let url = format!("{}/tools", self.base_url());
        let response = self
            .http
            .get(url)
            .header("x-api-key", api_key)
            .query(&[("toolkit_slug", toolkit_slug), ("limit", "200")])
            .send()
            .await
            .map_err(|error| GatewayError::Internal(error.into()))?;
        if !response.status().is_success() {
            return Err(GatewayError::ProviderError(format!(
                "Composio toolkit catalog failed: {}",
                response.status()
            )));
        }
        response
            .json()
            .await
            .map_err(|error| GatewayError::Internal(error.into()))
    }

    /// Start the managed Composio connection flow for one toolkit.
    pub async fn connect(&self, toolkit_slug: &str, user_id: &str) -> Result<Value, GatewayError> {
        self.request_json(
            reqwest::Method::POST,
            "/connected_accounts",
            Some(json!({ "toolkit": toolkit_slug, "userId": user_id })),
        )
        .await
    }

    /// Remove one managed Composio connection.
    pub async fn disconnect(&self, connection_id: &str) -> Result<Value, GatewayError> {
        if !valid_connection_id(connection_id) {
            return Err(GatewayError::BadRequest(
                "invalid Composio connected account id".to_owned(),
            ));
        }
        self.request_json(
            reqwest::Method::DELETE,
            &format!("/connected_accounts/{connection_id}"),
            None,
        )
        .await
    }

    pub(super) async fn request_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, GatewayError> {
        let api_key =
            self.config.api_key.as_deref().ok_or_else(|| {
                GatewayError::Internal(anyhow::anyhow!("Composio API key not set"))
            })?;
        let url = format!("{}{path}", self.base_url());
        let mut request = self
            .http
            .request(method, url)
            .header("x-api-key", api_key)
            .header("Content-Type", "application/json");
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| GatewayError::Internal(error.into()))?;
        if !response.status().is_success() {
            return Err(GatewayError::ProviderError(format!(
                "Composio request failed: {}",
                response.status()
            )));
        }
        response
            .json()
            .await
            .map_err(|error| GatewayError::Internal(error.into()))
    }
}

#[cfg(test)]
#[path = "http_api_tests.rs"]
mod tests;
