use std::pin::Pin;

use axum::body::Body;
use serde_json::Value;
use tracing::debug;

use crate::error::GatewayError;

use super::{chat_completions_url, check_response_status, check_stream_status, Provider};

/// OpenRouter (https://openrouter.ai) — OpenAI-compatible API with access to
/// 200+ models from every major provider. Uses the same wire format as OpenAI,
/// just with two extra identification headers.
pub struct OpenRouterProvider {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
    /// Sent as HTTP-Referer for OpenRouter usage attribution.
    site_url: String,
    /// Sent as X-Title for OpenRouter usage attribution.
    site_name: String,
}

impl OpenRouterProvider {
    pub fn new(
        client: reqwest::Client,
        api_key: String,
        base_url: String,
        site_url: String,
        site_name: String,
    ) -> Self {
        Self {
            client,
            api_key,
            base_url,
            site_url,
            site_name,
        }
    }
}

impl Provider for OpenRouterProvider {
    fn name(&self) -> &'static str {
        "openrouter"
    }

    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, GatewayError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            debug!(
                provider = "openrouter",
                model, "sending non-streaming request"
            );

            let resp = self
                .client
                .post(chat_completions_url(&self.base_url))
                .bearer_auth(&self.api_key)
                .header("HTTP-Referer", &self.site_url)
                .header("X-Title", &self.site_name)
                .json(&payload)
                .send()
                .await
                .map_err(|e| {
                    GatewayError::ProviderError(format!("openrouter request failed: {e}"))
                })?;

            check_response_status(resp, "openrouter").await
        })
    }

    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, GatewayError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            payload["stream"] = Value::Bool(true);
            debug!(provider = "openrouter", model, "sending streaming request");

            let resp = self
                .client
                .post(chat_completions_url(&self.base_url))
                .bearer_auth(&self.api_key)
                .header("HTTP-Referer", &self.site_url)
                .header("X-Title", &self.site_name)
                .json(&payload)
                .send()
                .await
                .map_err(|e| {
                    GatewayError::ProviderError(format!("openrouter stream request failed: {e}"))
                })?;

            let resp = check_stream_status(resp, "openrouter").await?;
            Ok(Body::from_stream(resp.bytes_stream()))
        })
    }
}
