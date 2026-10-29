use std::pin::Pin;

use axum::body::Body;
use serde_json::Value;
use tracing::debug;

use crate::error::ProviderError;

use super::{
    chat_completions_url, check_response_status, check_stream_status, parse_rate_limit,
    send_with_retry, streaming_request, BoundedResponse, Provider, STREAM_READ_TIMEOUT,
};

#[derive(Clone, Copy)]
enum CoreTransport {
    Local,
    KiroBroker,
}

/// Provider that proxies requests to apps/core's OpenAI-compatible endpoint,
/// enabling routing to zeroclaw, openclaw, and core-managed local LLM providers.
pub struct CoreProvider {
    client: reqwest::Client,
    base_url: String,
    token: Option<String>,
    transport: CoreTransport,
}

impl CoreProvider {
    pub fn new(client: reqwest::Client, base_url: String, token: Option<String>) -> Self {
        Self {
            client,
            base_url,
            token,
            transport: CoreTransport::Local,
        }
    }

    /// Forward to Core's sealed-account broker only. A node bearer must never
    /// follow a redirect, an environment proxy, or a configurable remote host.
    pub fn kiro_proxy(
        _client: reqwest::Client,
        base_url: String,
        token: Option<String>,
    ) -> Result<Self, ProviderError> {
        let invalid =
            || ProviderError::Provider("kiro broker requires a trusted loopback endpoint".into());
        let url = reqwest::Url::parse(&base_url).map_err(|_| invalid())?;
        let loopback = url
            .host_str()
            .and_then(|host| {
                host.trim_start_matches('[')
                    .trim_end_matches(']')
                    .parse::<std::net::IpAddr>()
                    .ok()
            })
            .is_some_and(|address| address.is_loopback());
        if !loopback
            || !matches!(url.scheme(), "http" | "https")
            || url.path() != "/api/pi-config/kiro/v1"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid());
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(std::time::Duration::from_secs(10))
            // Non-streaming turns keep the 120 s total; a streamed turn lifts
            // it per request (see `kiro_request`), while this idle bound still
            // fails a stalled stream.
            .timeout(std::time::Duration::from_secs(120))
            .read_timeout(STREAM_READ_TIMEOUT)
            .build()
            .map_err(|_| {
                ProviderError::Provider("could not prepare kiro broker transport".into())
            })?;
        Ok(Self {
            client,
            base_url,
            token,
            transport: CoreTransport::KiroBroker,
        })
    }

    fn kiro_request(
        &self,
        model: &str,
        body: &Value,
        stream: bool,
        session: Option<&str>,
    ) -> reqwest::RequestBuilder {
        let mut payload = body.clone();
        payload["model"] = Value::String(model.to_owned());
        payload["stream"] = Value::Bool(stream);
        let mut request = self
            .client
            .post(chat_completions_url(&self.base_url))
            .json(&payload);
        if stream {
            // A long generation streams past the client's 120 s total; Core's
            // own Kiro hop allows the same lifted total.
            request = streaming_request(request);
        }
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        if let Some(session) = session {
            request = request.header("x-ryu-session-id", session);
        }
        request
    }

    async fn kiro_response(
        &self,
        model: &str,
        body: &Value,
        stream: bool,
        session: Option<&str>,
    ) -> Result<reqwest::Response, ProviderError> {
        let request = self.kiro_request(model, body, stream, session);
        // Never replay inference. An HTTP response may explicitly attest that
        // delivery is uncertain; transport errors after connect have the same risk.
        let response = crate::trace_context::apply(request)
            .send()
            .await
            .map_err(|error| {
                if error.is_connect() {
                    ProviderError::Transport("kiro broker connection failed".into())
                } else if error.is_builder() {
                    ProviderError::Provider("kiro broker request could not be prepared".into())
                } else {
                    ProviderError::DeliveryUncertain(
                        "kiro inference delivery was not confirmed".into(),
                    )
                }
            })?;
        crate::trace_context::observe_status(response.status());
        if response
            .headers()
            .get("x-ryu-delivery-uncertain")
            .and_then(|value| value.to_str().ok())
            == Some("true")
        {
            return Err(ProviderError::DeliveryUncertain(
                "kiro inference delivery was not confirmed".into(),
            ));
        }
        match response.status().as_u16() {
            200..=299 => Ok(response),
            429 => {
                let rate = parse_rate_limit(response.headers());
                Err(ProviderError::RateLimited {
                    provider: "kiro".into(),
                    retry_after: rate.as_ref().and_then(|rate| rate.retry_after),
                    reset_at: rate.and_then(|rate| rate.reset_at),
                })
            }
            402 => Err(ProviderError::PaymentRequired {
                provider: "kiro".into(),
                message: "kiro account requires payment".into(),
            }),
            status => Err(crate::upstream_status_error(
                response.status(),
                format!("kiro broker rejected request (HTTP {status})"),
            )),
        }
    }

    async fn kiro_complete(
        &self,
        model: &str,
        body: &Value,
        session: Option<&str>,
    ) -> Result<Value, ProviderError> {
        self.kiro_response(model, body, false, session)
            .await?
            .bounded_json()
            .await
            .map_err(|_| {
                ProviderError::DeliveryUncertain(
                    "kiro inference response could not be confirmed".into(),
                )
            })
    }

    async fn kiro_stream(
        &self,
        model: &str,
        body: &Value,
        session: Option<&str>,
    ) -> Result<Body, ProviderError> {
        let response = self.kiro_response(model, body, true, session).await?;
        Ok(Body::from_stream(response.bytes_stream()))
    }
}

impl Provider for CoreProvider {
    fn name(&self) -> &'static str {
        match self.transport {
            CoreTransport::Local => "core",
            CoreTransport::KiroBroker => "kiro",
        }
    }

    fn has_rotating_accounts(&self) -> bool {
        matches!(self.transport, CoreTransport::KiroBroker)
    }

    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            if matches!(self.transport, CoreTransport::KiroBroker) {
                return self.kiro_complete(model, body, None).await;
            }
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
                    Box::pin(crate::trace_context::apply(req).send())
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
            if matches!(self.transport, CoreTransport::KiroBroker) {
                return self.kiro_stream(model, body, None).await;
            }
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            payload["stream"] = Value::Bool(true);
            let url = chat_completions_url(&self.base_url);
            let token = self.token.as_deref();
            debug!(provider = "core", model, "sending streaming request");

            let resp = send_with_retry(
                || {
                    let mut req = streaming_request(self.client.post(&url).json(&payload));
                    if let Some(t) = token {
                        req = req.bearer_auth(t);
                    }
                    Box::pin(crate::trace_context::apply(req).send())
                },
                "core",
                2,
            )
            .await?;

            let resp = check_stream_status(resp, "core", None).await?;
            Ok(Body::from_stream(resp.bytes_stream()))
        })
    }

    fn complete_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        session: Option<&'a str>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        match self.transport {
            CoreTransport::Local => self.complete(model, body),
            CoreTransport::KiroBroker => Box::pin(self.kiro_complete(model, body, session)),
        }
    }

    fn complete_stream_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        session: Option<&'a str>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        match self.transport {
            CoreTransport::Local => self.complete_stream(model, body),
            CoreTransport::KiroBroker => Box::pin(self.kiro_stream(model, body, session)),
        }
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

    fn kiro(server: &MockServer) -> CoreProvider {
        CoreProvider::kiro_proxy(
            reqwest::Client::new(),
            format!("{}/api/pi-config/kiro/v1", server.base_url()),
            Some("fixture-node-bearer".into()),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn kiro_broker_nonstream_preserves_session_auth_and_model() {
        let server = MockServer::always(MockResponse::ok_json(r#"{"id":"kiro-fixture"}"#)).await;
        let provider = kiro(&server);
        assert_eq!(provider.name(), "kiro");
        assert!(provider.has_rotating_accounts());
        let output = provider
            .complete_for_session(
                "claude-fixture",
                &json!({"messages":[]}),
                Some("conversation-one"),
            )
            .await
            .unwrap();
        assert_eq!(output["id"], "kiro-fixture");
        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/api/pi-config/kiro/v1/chat/completions");
        assert_eq!(
            requests[0].header("authorization").as_deref(),
            Some("Bearer fixture-node-bearer")
        );
        assert_eq!(
            requests[0].header("x-ryu-session-id").as_deref(),
            Some("conversation-one")
        );
        assert_eq!(requests[0].json()["model"], "claude-fixture");
        assert_eq!(requests[0].json()["stream"], false);
    }

    #[tokio::test]
    async fn kiro_broker_stream_preserves_session_auth_and_sse_bytes() {
        let bytes = b"data: {\"fixture\":true}\n\ndata: [DONE]\n\n".to_vec();
        let server =
            MockServer::always(MockResponse::ok_bytes("text/event-stream", bytes.clone())).await;
        let provider = kiro(&server);
        let stream = provider
            .complete_stream_for_session(
                "claude-fixture",
                &json!({"messages":[]}),
                Some("conversation-one"),
            )
            .await
            .unwrap();
        assert_eq!(
            axum::body::to_bytes(stream, 4096).await.unwrap().as_ref(),
            bytes.as_slice()
        );
        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].header("authorization").as_deref(),
            Some("Bearer fixture-node-bearer")
        );
        assert_eq!(
            requests[0].header("x-ryu-session-id").as_deref(),
            Some("conversation-one")
        );
        assert_eq!(requests[0].json()["stream"], true);
    }

    #[tokio::test]
    async fn kiro_broker_delivery_uncertain_is_typed_and_never_replayed() {
        for stream in [false, true] {
            let server = MockServer::always(
                MockResponse::json(502, r#"{"private":"fixture-upstream-secret"}"#)
                    .with_header("x-ryu-delivery-uncertain", "true"),
            )
            .await;
            let provider = kiro(&server);
            let error = if stream {
                provider
                    .complete_stream_for_session(
                        "m",
                        &json!({"messages":[]}),
                        Some("bound-session"),
                    )
                    .await
                    .unwrap_err()
            } else {
                provider
                    .complete_for_session("m", &json!({"messages":[]}), Some("bound-session"))
                    .await
                    .unwrap_err()
            };
            assert!(matches!(error, ProviderError::DeliveryUncertain(_)));
            let rendered = format!("{error}{error:?}");
            assert!(!rendered.contains("fixture-upstream-secret"));
            assert!(!rendered.contains("fixture-node-bearer"));
            assert_eq!(server.requests().len(), 1);
        }
    }

    #[tokio::test]
    async fn kiro_broker_never_follows_redirect_with_node_bearer() {
        let destination = MockServer::always(MockResponse::ok_json("{}")).await;
        let origin = MockServer::always(
            MockResponse::json(307, "fixture-private-error")
                .with_header("location", destination.base_url()),
        )
        .await;
        let provider = kiro(&origin);
        let error = provider
            .complete("m", &json!({"messages":[]}))
            .await
            .unwrap_err();
        assert!(!format!("{error}{error:?}").contains("fixture-private-error"));
        assert_eq!(origin.requests().len(), 1);
        assert!(destination.requests().is_empty());
    }

    #[tokio::test]
    async fn kiro_broker_explicit_rejection_is_redacted_and_not_retried() {
        for status in [401, 429, 503] {
            let server =
                MockServer::always(MockResponse::json(status, "fixture-private-error")).await;
            let provider = kiro(&server);
            let error = provider
                .complete("m", &json!({"messages":[]}))
                .await
                .unwrap_err();
            if status == 429 {
                assert!(matches!(error, ProviderError::RateLimited { .. }));
            }
            assert!(!format!("{error}{error:?}").contains("fixture-private-error"));
            assert_eq!(server.requests().len(), 1);
        }
    }

    #[tokio::test]
    async fn kiro_broker_invalid_success_response_cannot_be_replayed() {
        let server =
            MockServer::always(MockResponse::ok_json("fixture-invalid-json-private")).await;
        let error = kiro(&server)
            .complete("m", &json!({"messages":[]}))
            .await
            .unwrap_err();
        assert!(matches!(error, ProviderError::DeliveryUncertain(_)));
        assert_eq!(server.requests().len(), 1);
        assert!(!error.to_string().contains("fixture-invalid-json-private"));
    }

    #[test]
    fn kiro_broker_rejects_remote_or_ambiguous_bearer_destinations() {
        for base in [
            "https://example.com/api/pi-config/kiro/v1",
            "http://localhost/api/pi-config/kiro/v1",
            "http://127.0.0.1/v1",
            "http://127.0.0.1/api/pi-config/kiro/v1?token=fixture-private",
            "http://127.0.0.1/api/pi-config/kiro/v1#fixture-private",
            "http://fixture-private@127.0.0.1/api/pi-config/kiro/v1",
            "ftp://127.0.0.1/api/pi-config/kiro/v1",
        ] {
            let error = CoreProvider::kiro_proxy(
                reqwest::Client::new(),
                base.into(),
                Some("fixture-node-bearer".into()),
            )
            .err()
            .expect("rejected endpoint");
            assert!(!format!("{error}{error:?}").contains("fixture-private"));
        }
        assert!(CoreProvider::kiro_proxy(
            reqwest::Client::new(),
            "http://[::1]:7980/api/pi-config/kiro/v1".into(),
            None
        )
        .is_ok());
    }

    #[test]
    fn kiro_broker_stream_lifts_the_client_total_timeout() {
        let provider = CoreProvider::kiro_proxy(
            reqwest::Client::new(),
            "http://127.0.0.1:7980/api/pi-config/kiro/v1".into(),
            None,
        )
        .expect("loopback broker");
        let body = json!({ "messages": [] });
        let streamed = provider
            .kiro_request("kiro-model", &body, true, None)
            .build()
            .unwrap();
        assert_eq!(streamed.timeout(), Some(&crate::STREAM_TOTAL_TIMEOUT));
        // Non-streaming turns keep the client's 120 s total.
        let single = provider
            .kiro_request("kiro-model", &body, false, None)
            .build()
            .unwrap();
        assert_eq!(single.timeout(), None);
    }
}
