use std::{pin::Pin, sync::Arc};

use axum::body::Body;
use serde_json::Value;
use tracing::debug;

use crate::{
    account_pool::AccountPool,
    error::{ProviderError, PAYMENT_REQUIRED_COOLDOWN},
    quota::ProviderQuotas,
};

use super::{
    chat_completions_url, check_response_status, check_stream_status, egress::send_with_egress,
    normalize_legacy_completion_token_limit, streaming_request, EgressClientPool, Provider,
};

/// Modal (https://modal.com) — serverless GPU inference. A Ryu Cloud GPU node
/// deploys an OpenAI-compatible app (vLLM/TGI) on Modal and routes heavy local
/// model calls to it: GPU on demand (pay-per-second, scale-to-zero) while the
/// always-on orchestration node stays on cheap CPU. The wire format is OpenAI's,
/// so this is a thin bearer client (no provider-specific headers).
pub struct ModalProvider {
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    keys: Vec<String>,
    accounts: AccountPool,
    quota: Arc<ProviderQuotas>,
    base_url: String,
}

impl ModalProvider {
    pub fn new(
        client: reqwest::Client,
        keys: Vec<String>,
        base_url: String,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self::new_with_egress(client, None, keys, base_url, quota)
    }

    pub fn new_with_egress(
        client: reqwest::Client,
        egress: Option<Arc<EgressClientPool>>,
        keys: Vec<String>,
        base_url: String,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self {
            client,
            egress,
            accounts: AccountPool::new(keys.len()),
            keys,
            base_url,
            quota,
        }
    }

    fn account_rejected(&self, index: usize, error: &ProviderError) -> bool {
        match error {
            ProviderError::RateLimited { retry_after, .. } => {
                self.accounts.record_rate_limit(index, *retry_after);
                true
            }
            ProviderError::PaymentRequired { .. } => {
                self.accounts
                    .record_account_rejection(index, PAYMENT_REQUIRED_COOLDOWN);
                true
            }
            _ => false,
        }
    }

    fn exhausted(&self, last_error: Option<ProviderError>) -> ProviderError {
        last_error.unwrap_or_else(|| ProviderError::RateLimited {
            provider: "modal".to_owned(),
            retry_after: None,
            reset_at: None,
        })
    }
}

/// The `modal/` routing prefix selects this provider; the deployed app (vLLM)
/// expects the bare model name, so strip it before forwarding. A model with no
/// prefix (an explicit model_map entry → Modal) passes through unchanged.
fn upstream_model(model: &str) -> &str {
    model.strip_prefix("modal/").unwrap_or(model)
}

impl Provider for ModalProvider {
    fn configure_account_policies(&self, policies: &[crate::ProviderAccountPolicy]) {
        self.accounts.configure(policies);
    }

    fn name(&self) -> &'static str {
        "modal"
    }

    fn has_rotating_accounts(&self) -> bool {
        self.accounts.has_restrictions()
            || self.keys.len() > 1
            || self.egress.as_ref().is_some_and(|pool| pool.len() > 1)
    }

    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        self.complete_for_session(model, body, None)
    }

    fn complete_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        session: Option<&'a str>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(upstream_model(model).to_string());
            normalize_legacy_completion_token_limit(&mut payload);
            debug!(provider = "modal", model, "sending non-streaming request");

            let mut last_error = None;
            for index in self.accounts.candidates(session) {
                let resp = send_with_egress(
                    &self.client,
                    self.egress.as_deref(),
                    session,
                    "modal",
                    0,
                    |client| {
                        client
                            .post(chat_completions_url(&self.base_url))
                            .bearer_auth(&self.keys[index])
                            .json(&payload)
                    },
                )
                .await?;

                match check_response_status(resp, "modal", Some(&self.quota)).await {
                    Ok(response) => {
                        self.accounts.record_success(session, index);
                        return Ok(response);
                    }
                    Err(error) if self.account_rejected(index, &error) => last_error = Some(error),
                    Err(error) => return Err(error),
                }
            }
            Err(self.exhausted(last_error))
        })
    }

    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        self.complete_stream_for_session(model, body, None)
    }

    fn complete_stream_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        session: Option<&'a str>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(upstream_model(model).to_string());
            payload["stream"] = Value::Bool(true);
            normalize_legacy_completion_token_limit(&mut payload);
            debug!(provider = "modal", model, "sending streaming request");

            let mut last_error = None;
            for index in self.accounts.candidates(session) {
                let resp = send_with_egress(
                    &self.client,
                    self.egress.as_deref(),
                    session,
                    "modal",
                    0,
                    |client| {
                        streaming_request(
                            client
                                .post(chat_completions_url(&self.base_url))
                                .bearer_auth(&self.keys[index])
                                .json(&payload),
                        )
                    },
                )
                .await?;

                match check_stream_status(resp, "modal", Some(&self.quota)).await {
                    Ok(response) => {
                        self.accounts.record_success(session, index);
                        return Ok(Body::from_stream(response.bytes_stream()));
                    }
                    Err(error) if self.account_rejected(index, &error) => last_error = Some(error),
                    Err(error) => return Err(error),
                }
            }
            Err(self.exhausted(last_error))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockResponse, MockServer};
    use serde_json::json;

    #[tokio::test]
    async fn multiple_modal_keys_keep_session_affinity() {
        let server = MockServer::always(MockResponse::ok_json(r#"{"id":"m"}"#)).await;
        let provider = ModalProvider::new(
            reqwest::Client::new(),
            vec!["first".to_owned(), "second".to_owned()],
            server.base_url().to_owned(),
            Arc::new(ProviderQuotas::new()),
        );
        assert!(provider.has_rotating_accounts());
        for session in ["session-a", "session-b", "session-a"] {
            provider
                .complete_for_session(
                    "modal/deployed-model",
                    &json!({"messages":[]}),
                    Some(session),
                )
                .await
                .unwrap();
        }
        let requests = server.requests();
        assert_eq!(requests.len(), 3);
        for (request, key) in requests.iter().zip(["first", "second", "first"]) {
            assert_eq!(
                request.header("authorization"),
                Some(format!("Bearer {key}"))
            );
            assert_eq!(request.json()["model"], "deployed-model");
        }
    }

    #[tokio::test]
    async fn buffered_and_streaming_rotate_rejected_accounts_before_returning() {
        for streaming in [false, true] {
            for status in [429, 402] {
                let success = if streaming {
                    MockResponse::ok_bytes("text/event-stream", b"data: [DONE]\n\n".to_vec())
                } else {
                    MockResponse::ok_json(r#"{"id":"m"}"#)
                };
                let server = MockServer::start(vec![
                    MockResponse::json(status, r#"{"error":{"message":"account unavailable"}}"#)
                        .with_header("retry-after", "60"),
                    success.clone(),
                    success,
                ])
                .await;
                let provider = ModalProvider::new(
                    reqwest::Client::new(),
                    vec!["first".to_owned(), "second".to_owned()],
                    server.base_url().to_owned(),
                    Arc::new(ProviderQuotas::new()),
                );
                for _ in 0..2 {
                    let body = json!({"messages":[]});
                    if streaming {
                        let stream = provider
                            .complete_stream_for_session("modal/model", &body, Some("same-session"))
                            .await
                            .unwrap();
                        assert_eq!(
                            axum::body::to_bytes(stream, 1024).await.unwrap().as_ref(),
                            b"data: [DONE]\n\n"
                        );
                    } else {
                        assert_eq!(
                            provider
                                .complete_for_session("modal/model", &body, Some("same-session"))
                                .await
                                .unwrap()["id"],
                            "m"
                        );
                    }
                }
                let requests = server.requests();
                assert_eq!(requests.len(), 3);
                assert_eq!(
                    requests[0].header("authorization").as_deref(),
                    Some("Bearer first")
                );
                for request in &requests[1..] {
                    assert_eq!(
                        request.header("authorization").as_deref(),
                        Some("Bearer second")
                    );
                }
            }
        }
    }

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
            vec!["modal-token".to_string()],
            server.base_url().to_string(),
            Arc::new(ProviderQuotas::new()),
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
            vec!["t".to_string()],
            server.base_url().to_string(),
            Arc::new(ProviderQuotas::new()),
        );
        let err = p
            .complete("m", &json!({ "messages": [] }))
            .await
            .unwrap_err();
        // 500 is a server error → surfaced as a Provider error (not RateLimited).
        assert!(matches!(err, ProviderError::Provider(_)));
        assert!(err.to_string().contains("gpu cold start failed"));
    }

    #[tokio::test]
    async fn a_single_key_refused_for_credit_serves_again_once_refilled() {
        let server = MockServer::start(vec![
            MockResponse::json(402, r#"{"error":{"message":"out of credit"}}"#),
            MockResponse::ok_json(r#"{"id":"m"}"#),
        ])
        .await;
        let provider = ModalProvider::new(
            reqwest::Client::new(),
            vec!["only".to_owned()],
            server.base_url().to_owned(),
            Arc::new(ProviderQuotas::new()),
        );
        let body = json!({"messages":[]});
        let refused = provider
            .complete_for_session("modal/model", &body, None)
            .await;
        assert!(matches!(
            refused,
            Err(ProviderError::PaymentRequired { .. })
        ));
        provider
            .complete_for_session("modal/model", &body, None)
            .await
            .unwrap();
        assert_eq!(server.requests().len(), 2);
    }
}
