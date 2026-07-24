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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockResponse, MockServer};
    use serde_json::json;

    #[tokio::test]
    async fn complete_sends_bearer_when_token_present() {
        let server = MockServer::always(MockResponse::ok_json(r#"{"id":"core"}"#)).await;
        let p = CoreProvider::new(
            reqwest::Client::new(),
            server.base_url().to_string(),
            Some("core-secret".to_string()),
        );
        let out = p
            .complete("zeroclaw", &json!({ "messages": [] }))
            .await
            .unwrap();
        assert_eq!(out["id"], json!("core"));

        let reqs = server.requests();
        assert_eq!(
            reqs[0].header("authorization").as_deref(),
            Some("Bearer core-secret")
        );
        assert_eq!(reqs[0].json()["model"], json!("zeroclaw"));
    }

    #[tokio::test]
    async fn complete_omits_auth_when_no_token() {
        let server = MockServer::always(MockResponse::ok_json(r#"{"id":"core"}"#)).await;
        let p = CoreProvider::new(reqwest::Client::new(), server.base_url().to_string(), None);
        p.complete("m", &json!({ "messages": [] })).await.unwrap();
        // No token configured → no Authorization header is attached.
        assert!(server.requests()[0].header("authorization").is_none());
    }

    #[tokio::test]
    async fn complete_error_does_not_leak_token() {
        const SECRET: &str = "core-token-DO-NOT-LEAK";
        let server = MockServer::always(MockResponse::json(
            400,
            r#"{"error":{"message":"bad request"}}"#,
        ))
        .await;
        let p = CoreProvider::new(
            reqwest::Client::new(),
            server.base_url().to_string(),
            Some(SECRET.to_string()),
        );
        let err = p
            .complete("m", &json!({ "messages": [] }))
            .await
            .unwrap_err();
        let rendered = format!("{err}{err:?}");
        assert!(!rendered.contains(SECRET), "leaked: {rendered}");
    }
}
