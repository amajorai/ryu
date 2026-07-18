use std::pin::Pin;

use axum::body::Body;
use serde_json::Value;
use tracing::debug;

use crate::error::ProviderError;

use super::{chat_completions_url, check_response_status, check_stream_status, Provider};

/// Modal (https://modal.com) — serverless GPU inference. A Ryu Cloud GPU node
/// deploys an OpenAI-compatible app (vLLM/TGI) on Modal and routes heavy local
/// model calls to it: GPU on demand (pay-per-second, scale-to-zero) while the
/// always-on orchestration node stays on cheap CPU. The wire format is OpenAI's,
/// so this is a thin bearer client (no provider-specific headers).
pub struct ModalProvider {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
}

impl ModalProvider {
    pub fn new(client: reqwest::Client, api_key: String, base_url: String) -> Self {
        Self {
            client,
            api_key,
            base_url,
        }
    }
}

/// The `modal/` routing prefix selects this provider; the deployed app (vLLM)
/// expects the bare model name, so strip it before forwarding. A model with no
/// prefix (an explicit model_map entry → Modal) passes through unchanged.
fn upstream_model(model: &str) -> &str {
    model.strip_prefix("modal/").unwrap_or(model)
}

impl Provider for ModalProvider {
    fn name(&self) -> &'static str {
        "modal"
    }

    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(upstream_model(model).to_string());
            debug!(provider = "modal", model, "sending non-streaming request");

            let resp = self
                .client
                .post(chat_completions_url(&self.base_url))
                .bearer_auth(&self.api_key)
                .json(&payload)
                .send()
                .await
                .map_err(|e| ProviderError::Provider(format!("modal request failed: {e}")))?;

            check_response_status(resp, "modal", None).await
        })
    }

    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(upstream_model(model).to_string());
            payload["stream"] = Value::Bool(true);
            debug!(provider = "modal", model, "sending streaming request");

            let resp = self
                .client
                .post(chat_completions_url(&self.base_url))
                .bearer_auth(&self.api_key)
                .json(&payload)
                .send()
                .await
                .map_err(|e| {
                    ProviderError::Provider(format!("modal stream request failed: {e}"))
                })?;

            let resp = check_stream_status(resp, "modal", None).await?;
            Ok(Body::from_stream(resp.bytes_stream()))
        })
    }
}
