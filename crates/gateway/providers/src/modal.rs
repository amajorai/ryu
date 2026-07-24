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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockResponse, MockServer};
    use serde_json::json;

    #[test]
    fn upstream_model_strips_modal_prefix() {
        assert_eq!(upstream_model("modal/llama-3.1-70b"), "llama-3.1-70b");
        // A model with no prefix passes through unchanged.
        assert_eq!(upstream_model("llama-3.1-70b"), "llama-3.1-70b");
        // Only the leading prefix is stripped.
        assert_eq!(upstream_model("modal/a/modal/b"), "a/modal/b");
    }

    #[tokio::test]
    async fn complete_strips_prefix_and_sends_bearer() {
        let server = MockServer::always(MockResponse::ok_json(r#"{"id":"m"}"#)).await;
        let p = ModalProvider::new(
            reqwest::Client::new(),
            "modal-token".to_string(),
            server.base_url().to_string(),
        );
        let out = p
            .complete("modal/llama-3", &json!({ "messages": [] }))
            .await
            .unwrap();
        assert_eq!(out["id"], json!("m"));

        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/chat/completions");
        assert_eq!(
            reqs[0].header("authorization").as_deref(),
            Some("Bearer modal-token")
        );
        // The `modal/` prefix is stripped before forwarding to the vLLM app.
        assert_eq!(reqs[0].json()["model"], json!("llama-3"));
    }

    #[tokio::test]
    async fn complete_maps_upstream_error() {
        let server = MockServer::always(MockResponse::json(
            500,
            r#"{"error":{"message":"gpu cold start failed"}}"#,
        ))
        .await;
        let p = ModalProvider::new(
            reqwest::Client::new(),
            "t".to_string(),
            server.base_url().to_string(),
        );
        let err = p
            .complete("m", &json!({ "messages": [] }))
            .await
            .unwrap_err();
        // 500 is a server error → surfaced as a Provider error (not RateLimited).
        assert!(matches!(err, ProviderError::Provider(_)));
        assert!(err.to_string().contains("gpu cold start failed"));
    }
}
