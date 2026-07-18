use std::pin::Pin;

use axum::body::Body;
use serde_json::Value;
use tracing::debug;

use crate::error::ProviderError;

use super::{
    chat_completions_url, check_response_status, check_stream_status, send_with_retry, Provider,
};

/// Provider that proxies requests to apps/core's OpenAI-compatible endpoint,
/// enabling routing to zeroclaw, openclaw, and core-managed local LLM providers.
pub struct CoreProvider {
    client: reqwest::Client,
    base_url: String,
    token: Option<String>,
}

impl CoreProvider {
    pub fn new(client: reqwest::Client, base_url: String, token: Option<String>) -> Self {
        Self {
            client,
            base_url,
            token,
        }
    }
}

impl Provider for CoreProvider {
    fn name(&self) -> &'static str {
        "core"
    }

    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            let url = chat_completions_url(&self.base_url);
            let token = self.token.as_deref();
            debug!(provider = "core", model, url = %url, "sending non-streaming request");

            let resp = send_with_retry(
                || {
                    let mut req = self.client.post(&url).json(&payload);
                    if let Some(t) = token {
                        req = req.bearer_auth(t);
                    }
                    Box::pin(async move { req.send().await })
                },
                "core",
                2,
            )
            .await?;

            check_response_status(resp, "core", None).await
        })
    }

    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            payload["stream"] = Value::Bool(true);
            let url = chat_completions_url(&self.base_url);
            let token = self.token.as_deref();
            debug!(provider = "core", model, "sending streaming request");

            let resp = send_with_retry(
                || {
                    let mut req = self.client.post(&url).json(&payload);
                    if let Some(t) = token {
                        req = req.bearer_auth(t);
                    }
                    Box::pin(async move { req.send().await })
                },
                "core",
                2,
            )
            .await?;

            let resp = check_stream_status(resp, "core", None).await?;
            Ok(Body::from_stream(resp.bytes_stream()))
        })
    }
}
