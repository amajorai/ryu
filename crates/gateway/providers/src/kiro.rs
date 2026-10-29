//! Kiro's native AWS chat transport. Credentials are supplied by sealed custody.
//! Protocol reference: decolua/9router a99cf572, open-sse/executors/kiro.js.
mod protocol;

use crate::{
    account_pool::AccountPool, egress::send_with_egress, EgressClientPool, Provider, ProviderError,
    ProviderQuotas,
};
use axum::body::Body;
use serde_json::{json, Value};
use std::{pin::Pin, sync::Arc};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KiroAuthMethod {
    OAuth,
    ApiKey,
    ExternalIdp,
}

pub struct KiroAccount {
    pub access_token: String,
    pub region: String,
    pub profile_arn: Option<String>,
    pub auth_method: KiroAuthMethod,
    /// Only trusted configuration may override the AWS service origin.
    pub endpoint: Option<String>,
}

impl std::fmt::Debug for KiroAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KiroAccount")
            .field("region", &self.region)
            .field("auth_method", &self.auth_method)
            .finish_non_exhaustive()
    }
}

pub struct KiroProvider {
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    credentials: Vec<KiroAccount>,
    accounts: AccountPool,
    quota: Arc<ProviderQuotas>,
}

impl KiroProvider {
    pub fn new(
        client: reqwest::Client,
        egress: Option<Arc<EgressClientPool>>,
        credentials: Vec<KiroAccount>,
        quota: Arc<ProviderQuotas>,
    ) -> Result<Self, ProviderError> {
        if credentials.is_empty() {
            return Err(invalid("Kiro needs a saved account"));
        }
        for account in &credentials {
            if account.access_token.is_empty()
                || account.access_token.chars().any(char::is_whitespace)
                || reqwest::header::HeaderValue::from_str(&account.access_token).is_err()
            {
                return Err(invalid("Invalid Kiro credential"));
            }
            let region = &account.region;
            let parts: Vec<_> = region.split('-').collect();
            if parts.len() != 3
                || parts[0].len() != 2
                || !parts[0].bytes().all(|c| c.is_ascii_lowercase())
                || parts[1].is_empty()
                || !parts[1].bytes().all(|c| c.is_ascii_lowercase())
                || !(1..=2).contains(&parts[2].len())
                || !parts[2].bytes().all(|c| c.is_ascii_digit())
            {
                return Err(invalid("Invalid AWS region"));
            }
            if account.profile_arn.as_ref().is_some_and(|arn| {
                !arn.starts_with(&format!("arn:aws:codewhisperer:{region}:"))
                    || arn.len() > 512
                    || reqwest::header::HeaderValue::from_str(arn).is_err()
            }) {
                return Err(invalid("Invalid Kiro profile ARN"));
            }
            if let Some(endpoint) = &account.endpoint {
                let url =
                    reqwest::Url::parse(endpoint).map_err(|_| invalid("Invalid Kiro endpoint"))?;
                let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
                if !url.username().is_empty()
                    || url.password().is_some()
                    || url.fragment().is_some()
                    || !(url.scheme() == "https" || url.scheme() == "http" && loopback)
                {
                    return Err(invalid("Kiro endpoint requires HTTPS"));
                }
            }
        }
        Ok(Self {
            accounts: AccountPool::new(credentials.len()),
            client,
            egress,
            credentials,
            quota,
        })
    }

    async fn request(
        &self,
        model: &str,
        body: &Value,
        session: Option<&str>,
    ) -> Result<reqwest::Response, ProviderError> {
        let index = self
            .accounts
            .candidates(session)
            .first()
            .copied()
            .ok_or_else(|| invalid("Kiro account is unavailable"))?;
        let account = &self.credentials[index];
        let payload = protocol::request(model, body, session, account.profile_arn.as_deref())?;
        let endpoint = account.endpoint.clone().unwrap_or_else(|| {
            format!(
                "https://q.{}.amazonaws.com/generateAssistantResponse",
                account.region
            )
        });
        let response = send_with_egress(
            &self.client,
            self.egress.as_deref(),
            session,
            "kiro",
            0,
            |client| {
                let mut request = client
                    .post(&endpoint)
                    .bearer_auth(&account.access_token)
                    .header("x-amz-sso-bearer", &account.access_token)
                    .header("x-amzn-kiro-agent-mode", "spec")
                    .header("amz-sdk-invocation-id", uuid::Uuid::new_v4().to_string())
                    .header("amz-sdk-request", "attempt=1; max=1")
                    .json(&payload);
                if endpoint.contains("://codewhisperer.") {
                    request = request.header(
                        "x-amz-target",
                        "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
                    );
                }
                if let Some(arn) = &account.profile_arn {
                    request = request.header("x-amzn-codewhisperer-profile-arn", arn);
                }
                match account.auth_method {
                    KiroAuthMethod::ApiKey => request.header("TokenType", "API_KEY"),
                    KiroAuthMethod::ExternalIdp => request.header("TokenType", "EXTERNAL_IDP"),
                    KiroAuthMethod::OAuth => request,
                }
            },
        )
        .await?;
        let status = response.status();
        if status.as_u16() == 429 {
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse().ok());
            self.accounts.record_rate_limit(index, retry_after);
            self.quota.record_rate_limited("kiro", retry_after, None);
            return Err(ProviderError::RateLimited {
                provider: "kiro".into(),
                retry_after,
                reset_at: None,
            });
        }
        if status.is_server_error() || status.as_u16() == 408 {
            return Err(uncertain("Kiro request delivery is uncertain"));
        }
        if !status.is_success() {
            return Err(crate::upstream_status_error(
                status,
                format!("Kiro rejected request (HTTP {})", status.as_u16()),
            ));
        }
        self.accounts.record_success(session, index);
        if let Some(info) = crate::parse_rate_limit(response.headers()) {
            self.quota.record_success("kiro", &info);
        }
        Ok(response)
    }

    async fn models(&self) -> Option<Vec<Value>> {
        use crate::response_body::BoundedResponse;
        let index = *self.accounts.candidates(None).first()?;
        let account = &self.credentials[index];
        let origin = account
            .endpoint
            .clone()
            .unwrap_or_else(|| format!("https://q.{}.amazonaws.com", account.region));
        let mut url = reqwest::Url::parse(&origin).ok()?;
        url.set_path("/ListAvailableModels");
        url.set_query(None);
        let mut models = Vec::new();
        let mut next: Option<String> = None;
        let mut seen = std::collections::HashSet::new();
        for _ in 0..20 {
            let mut page = url.clone();
            page.query_pairs_mut().append_pair("origin", "AI_EDITOR");
            if let Some(profile) = &account.profile_arn {
                page.query_pairs_mut().append_pair("profileArn", profile);
            }
            if let Some(token) = &next {
                page.query_pairs_mut().append_pair("nextToken", token);
            }
            let response = send_with_egress(
                &self.client,
                self.egress.as_deref(),
                None,
                "kiro",
                0,
                |client| {
                    let mut request = client
                        .get(page.clone())
                        .bearer_auth(&account.access_token)
                        .header("x-amz-sso-bearer", &account.access_token)
                        .timeout(std::time::Duration::from_secs(10));
                    match account.auth_method {
                        KiroAuthMethod::ApiKey => request = request.header("TokenType", "API_KEY"),
                        KiroAuthMethod::ExternalIdp => {
                            request = request.header("TokenType", "EXTERNAL_IDP")
                        }
                        KiroAuthMethod::OAuth => {}
                    }
                    request
                },
            )
            .await
            .ok()?;
            if !response.status().is_success() {
                return None;
            }
            let data: Value = response.bounded_json().await.ok()?;
            for model in data["models"].as_array()? {
                let id = model["modelId"].as_str().or_else(|| model["id"].as_str())?;
                if id.len() > 256 || models.len() >= 10_000 {
                    return None;
                }
                let mut entry = model.clone();
                entry["id"] = json!(id);
                entry["object"] = json!("model");
                entry["owned_by"] = json!("kiro");
                models.push(entry);
            }
            next = data["nextToken"]
                .as_str()
                .filter(|token| !token.is_empty())
                .map(str::to_owned);
            match &next {
                None => return Some(models),
                Some(token) if token.len() <= 4096 && seen.insert(token.clone()) => {}
                _ => return None,
            }
        }
        None
    }
}

fn invalid(message: &str) -> ProviderError {
    ProviderError::Provider(message.into())
}
fn uncertain(message: &str) -> ProviderError {
    ProviderError::DeliveryUncertain(message.into())
}

impl Provider for KiroProvider {
    fn name(&self) -> &'static str {
        "kiro"
    }
    fn discover_models<'a>(
        &'a self,
    ) -> Pin<Box<dyn std::future::Future<Output = Option<Vec<Value>>> + Send + 'a>> {
        Box::pin(self.models())
    }
    fn configure_account_policies(&self, policies: &[crate::ProviderAccountPolicy]) {
        self.accounts.configure(policies);
    }
    fn configure_account_strategy(&self, strategy: crate::AccountSelectionStrategy) {
        self.accounts.configure_strategy(strategy);
    }
    fn configure_fill_first_drain_percent(&self, percent: u8) {
        self.accounts.configure_fill_first_drain_percent(percent);
    }
    fn has_rotating_accounts(&self) -> bool {
        self.credentials.len() > 1 || self.accounts.has_restrictions()
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
        Box::pin(
            async move { protocol::read(self.request(model, body, session).await?, model).await },
        )
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
            Ok(protocol::stream(
                self.request(model, body, session).await?,
                model,
            ))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockResponse, MockServer};
    use protocol::tests::encode;

    fn account(endpoint: String, token: &str) -> KiroAccount {
        KiroAccount {
            access_token: token.into(),
            region: "us-east-1".into(),
            profile_arn: None,
            auth_method: KiroAuthMethod::OAuth,
            endpoint: Some(endpoint),
        }
    }
    fn response() -> MockResponse {
        let mut bytes = encode("assistantResponseEvent", json!({"content":"hello"}));
        bytes.extend(encode(
            "metricsEvent",
            json!({"inputTokens":8,"outputTokens":3}),
        ));
        bytes.extend(encode("messageStopEvent", json!({"stopReason":"end_turn"})));
        MockResponse::ok_bytes("application/vnd.amazon.eventstream", bytes)
    }

    #[tokio::test]
    async fn actual_http_identity_is_session_sticky_and_native_response_translates() {
        let server = MockServer::always(response()).await;
        let provider = KiroProvider::new(
            reqwest::Client::new(),
            None,
            vec![
                account(server.base_url().into(), "first"),
                account(server.base_url().into(), "second"),
            ],
            Arc::new(ProviderQuotas::default()),
        )
        .unwrap();
        let body = json!({"messages":[{"role":"user","content":"hello"}]});
        for session in ["one", "two", "one"] {
            let output = provider
                .complete_for_session("claude-sonnet-4", &body, Some(session))
                .await
                .unwrap();
            assert_eq!(output["choices"][0]["message"]["content"], "hello");
            assert_eq!(output["usage"]["total_tokens"], 11);
        }
        let requests = server.requests();
        for (index, token) in ["first", "second", "first"].into_iter().enumerate() {
            assert_eq!(
                requests[index].header("authorization").unwrap(),
                format!("Bearer {token}")
            );
            assert_eq!(requests[index].header("x-amz-sso-bearer").unwrap(), token);
        }
        assert_eq!(
            requests[0].json()["conversationState"]["currentMessage"]["userInputMessage"]
                ["modelId"],
            "claude-sonnet-4"
        );
    }

    #[tokio::test]
    async fn uncertain_delivery_and_bad_frame_are_never_replayed() {
        for response in [
            MockResponse::json(503, "secret token echo"),
            MockResponse::ok_bytes("application/vnd.amazon.eventstream", vec![0; 16]),
        ] {
            let server = MockServer::always(response).await;
            let provider = KiroProvider::new(
                reqwest::Client::new(),
                None,
                vec![account(server.base_url().into(), "secret")],
                Arc::new(ProviderQuotas::default()),
            )
            .unwrap();
            let error = provider
                .complete(
                    "m",
                    &json!({"messages":[{"role":"user","content":"hello"}]}),
                )
                .await
                .unwrap_err();
            assert!(matches!(error, ProviderError::DeliveryUncertain(_)));
            assert!(!format!("{error:?}").contains("secret"));
            assert_eq!(server.requests().len(), 1);
        }
    }

    #[test]
    fn credentials_are_redacted_and_bad_origins_fail_closed() {
        let account = account("http://evil.example".into(), "never-log");
        assert!(!format!("{account:?}").contains("never-log"));
        assert!(KiroProvider::new(
            reqwest::Client::new(),
            None,
            vec![account],
            Arc::new(ProviderQuotas::default())
        )
        .is_err());
    }

    #[tokio::test]
    async fn native_discovery_paginates_and_preserves_profile_identity() {
        let server = MockServer::start(vec![
            MockResponse::ok_json(r#"{"models":[{"modelId":"one"}],"nextToken":"page2"}"#),
            MockResponse::ok_json(r#"{"models":[{"modelId":"two"}]}"#),
        ])
        .await;
        let mut credentials = account(server.base_url().into(), "identity");
        credentials.profile_arn = Some("arn:aws:codewhisperer:us-east-1:123:profile/p".into());
        let provider = KiroProvider::new(
            reqwest::Client::new(),
            None,
            vec![credentials],
            Arc::new(ProviderQuotas::default()),
        )
        .unwrap();
        let models = provider.discover_models().await.unwrap();
        assert_eq!(
            models
                .iter()
                .map(|m| m["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["one", "two"]
        );
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].header("authorization").unwrap(),
            "Bearer identity"
        );
    }

    #[tokio::test]
    async fn native_discovery_rejects_token_cycles_and_error_echoes() {
        let server =
            MockServer::always(MockResponse::ok_json(r#"{"models":[],"nextToken":"same"}"#)).await;
        let provider = KiroProvider::new(
            reqwest::Client::new(),
            None,
            vec![account(server.base_url().into(), "identity")],
            Arc::new(ProviderQuotas::default()),
        )
        .unwrap();
        assert!(provider.discover_models().await.is_none());
        assert_eq!(server.requests().len(), 2);
    }

    #[tokio::test]
    async fn streaming_projection_finishes_with_observed_usage_and_done() {
        let server = MockServer::always(response()).await;
        let provider = KiroProvider::new(
            reqwest::Client::new(),
            None,
            vec![account(server.base_url().into(), "identity")],
            Arc::new(ProviderQuotas::default()),
        )
        .unwrap();
        let body = provider
            .complete_stream(
                "m",
                &json!({"messages":[{"role":"user","content":"hello"}]}),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(body, 1024 * 1024).await.unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        assert!(text.contains("chat.completion.chunk"));
        assert!(text.contains("hello"));
        assert!(text.contains("\"total_tokens\":11"));
        assert!(text.ends_with("data: [DONE]\n\n"));
    }

    #[tokio::test]
    async fn rate_limit_is_observed_without_replaying_to_second_account() {
        let server = MockServer::always(
            MockResponse::json(429, "secret echo").with_header("retry-after", "9"),
        )
        .await;
        let provider = KiroProvider::new(
            reqwest::Client::new(),
            None,
            vec![
                account(server.base_url().into(), "first"),
                account(server.base_url().into(), "second"),
            ],
            Arc::new(ProviderQuotas::default()),
        )
        .unwrap();
        assert!(matches!(
            provider
                .complete(
                    "m",
                    &json!({"messages":[{"role":"user","content":"hello"}]})
                )
                .await,
            Err(ProviderError::RateLimited {
                retry_after: Some(9),
                ..
            })
        ));
        assert_eq!(server.requests().len(), 1);
    }

    #[tokio::test]
    async fn stream_delivers_validated_first_frame_before_terminal_is_available() {
        use futures_util::StreamExt;
        let terminal = Arc::new(tokio::sync::Notify::new());
        let gate = Arc::clone(&terminal);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = axum::Router::new().route(
            "/",
            axum::routing::post(move || {
                let gate = Arc::clone(&gate);
                async move {
                    Body::from_stream(futures_util::stream::unfold(
                        (0, gate),
                        |(step, gate)| async move {
                            let data = match step {
                                0 => encode(
                                    "assistantResponseEvent",
                                    json!({"content":"first-frame"}),
                                ),
                                1 => {
                                    gate.notified().await;
                                    encode("messageStopEvent", json!({"stopReason":"end_turn"}))
                                }
                                _ => return None,
                            };
                            Some((
                                Ok::<_, std::io::Error>(bytes::Bytes::from(data)),
                                (step + 1, gate),
                            ))
                        },
                    ))
                }
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let provider = KiroProvider::new(
            reqwest::Client::new(),
            None,
            vec![account(format!("http://{address}/"), "identity")],
            Arc::new(ProviderQuotas::default()),
        )
        .unwrap();
        let body = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            provider.complete_stream(
                "m",
                &json!({"messages":[{"role":"user","content":"hello"}]}),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        let mut stream = body.into_data_stream();
        let first = tokio::time::timeout(std::time::Duration::from_secs(5), stream.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(std::str::from_utf8(&first).unwrap().contains("first-frame"));
        terminal.notify_one();
        let last = stream.next().await.unwrap().unwrap();
        assert!(std::str::from_utf8(&last).unwrap().contains("[DONE]"));
        assert!(stream.next().await.is_none());
        server.abort();
    }
}
