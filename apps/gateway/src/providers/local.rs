use std::pin::Pin;

use axum::body::Body;
use serde_json::Value;
use tracing::debug;

use crate::error::GatewayError;

use super::{
    chat_completions_url, check_response_status, check_stream_status, discover_openai_models,
    models_from_response, send_with_retry, Provider,
};

/// Provider for locally-running OpenAI-compatible servers such as Ollama or llama.cpp.
pub struct LocalProvider {
    client: reqwest::Client,
    base_url: String,
}

impl LocalProvider {
    pub fn new(client: reqwest::Client, base_url: String) -> Self {
        Self { client, base_url }
    }
}

impl Provider for LocalProvider {
    fn name(&self) -> &'static str {
        "local"
    }

    fn discover_models<'a>(
        &'a self,
    ) -> Pin<Box<dyn std::future::Future<Output = Option<Vec<Value>>> + Send + 'a>> {
        Box::pin(async move {
            let json = discover_openai_models(&self.client, &self.base_url, "").await?;
            models_from_response(json)
        })
    }

    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, GatewayError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            let url = chat_completions_url(&self.base_url);
            debug!(provider = "local", model, url = %url, "sending non-streaming request");

            let resp = send_with_retry(
                || {
                    let req = self.client.post(&url).json(&payload);
                    Box::pin(async move { req.send().await })
                },
                "local",
                2,
            )
            .await?;

            check_response_status(resp, "local", None).await
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
            debug!(provider = "local", model, "sending streaming request");

            let url = chat_completions_url(&self.base_url);
            let resp = send_with_retry(
                || {
                    let req = self.client.post(&url).json(&payload);
                    Box::pin(async move { req.send().await })
                },
                "local",
                2,
            )
            .await?;

            let resp = check_stream_status(resp, "local", None).await?;
            Ok(Body::from_stream(resp.bytes_stream()))
        })
    }
}
