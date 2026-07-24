use std::pin::Pin;

use axum::body::Body;
use serde_json::Value;
use tracing::debug;

use crate::error::ProviderError;

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
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
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
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockResponse, MockServer};
    use serde_json::json;

    #[tokio::test]
    async fn complete_injects_model_and_sends_no_auth_header() {
        let server = MockServer::always(MockResponse::ok_json(r#"{"id":"local"}"#)).await;
        let p = LocalProvider::new(reqwest::Client::new(), server.base_url().to_string());
        let out = p
            .complete("qwen2.5", &json!({ "messages": [] }))
            .await
            .unwrap();
        assert_eq!(out["id"], json!("local"));

        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/chat/completions");
        // A local server (Ollama/llama.cpp) takes no bearer key.
        assert!(reqs[0].header("authorization").is_none());
        assert_eq!(reqs[0].json()["model"], json!("qwen2.5"));
    }

    #[tokio::test]
    async fn complete_maps_client_error_without_retry() {
        // 4xx is not a server error, so send_with_retry returns it immediately
        // (no back-off sleeps) and check_response_status maps it.
        let server = MockServer::always(MockResponse::json(
            404,
            r#"{"error":{"message":"model not found"}}"#,
        ))
        .await;
        let p = LocalProvider::new(reqwest::Client::new(), server.base_url().to_string());
        let err = p
            .complete("missing", &json!({ "messages": [] }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("model not found"));
        assert_eq!(server.request_count(), 1);
    }

    #[tokio::test]
    async fn discover_models_returns_data_entries() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"data":[{"id":"qwen2.5"},{"id":"llama3.2"}]}"#,
        ))
        .await;
        let p = LocalProvider::new(reqwest::Client::new(), server.base_url().to_string());
        let models = p.discover_models().await.expect("some models");
        assert_eq!(models.len(), 2);
        assert_eq!(server.requests()[0].path, "/models");
    }

    #[tokio::test]
    async fn discover_models_none_on_non_2xx() {
        let server = MockServer::always(MockResponse::json(500, "boom")).await;
        let p = LocalProvider::new(reqwest::Client::new(), server.base_url().to_string());
        // Discovery is infallible: a server error yields None (fall back to static list).
        assert!(p.discover_models().await.is_none());
    }
}
