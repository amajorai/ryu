//! Session-aware selection among outbound HTTP clients.
//!
//! Gateway builds one `reqwest::Client` per configured proxy endpoint. Provider
//! adapters choose a client for each request and retain that client through the
//! request's retries. A failed endpoint cools down without changing the selected
//! upstream provider, model, or API-key account.

use crate::account_pool::AccountPool;
use crate::error::ProviderError;

use super::send_with_retry;

pub struct EgressClientPool {
    clients: Vec<reqwest::Client>,
    sdk_clients: Vec<reqwest_sdk::Client>,
    priorities: Vec<u32>,
    selector: AccountPool,
}

impl EgressClientPool {
    pub fn new(clients: Vec<reqwest::Client>) -> Result<Self, &'static str> {
        if clients.is_empty() {
            return Err("egress pool needs at least one HTTP client");
        }
        if clients.len() > 32 {
            return Err("egress pool supports at most 32 HTTP clients");
        }
        Ok(Self {
            priorities: vec![0; clients.len()],
            selector: AccountPool::new(clients.len()),
            clients,
            sdk_clients: Vec::new(),
        })
    }

    pub fn with_priorities(mut self, priorities: Vec<u32>) -> Result<Self, &'static str> {
        if priorities.len() != self.clients.len() {
            return Err("egress priorities must match endpoint count");
        }
        self.priorities = priorities;
        Ok(self)
    }

    pub fn with_sdk_clients(
        mut self,
        clients: Vec<reqwest_sdk::Client>,
    ) -> Result<Self, &'static str> {
        if clients.len() != self.clients.len() {
            return Err("SDK transports must match egress endpoint count");
        }
        self.sdk_clients = clients;
        Ok(self)
    }

    pub fn sdk_client(&self, index: usize) -> Option<&reqwest_sdk::Client> {
        self.sdk_clients.get(index)
    }

    /// Candidates in selection order. An empty result means every endpoint is
    /// cooling down. The borrowed clients remain valid for the pool's lifetime.
    pub fn candidates(&self, session: Option<&str>) -> Vec<(usize, &reqwest::Client)> {
        self.selector
            .candidates_with_priorities(session, &self.priorities)
            .into_iter()
            .map(|index| (index, &self.clients[index]))
            .collect()
    }

    pub fn len(&self) -> usize {
        self.clients.len()
    }

    pub fn record_success(&self, session: Option<&str>, index: usize) {
        self.selector.record_success(session, index);
    }

    pub fn record_failure(&self, index: usize, retry_after_secs: Option<u64>) {
        self.selector.record_rate_limit(index, retry_after_secs);
    }

    pub fn bind_job(&self, submission: &str, job: &str) {
        self.selector.copy_binding(submission, job);
    }
}

/// A configured pool can move to another endpoint only before an upstream
/// request could have been accepted: connection establishment failure or 407.
/// Timeouts after connection establishment return without replay. Provider
/// status responses stay on the selected endpoint and do not cool its transport.
pub(crate) async fn send_with_egress(
    default_client: &reqwest::Client,
    egress: Option<&EgressClientPool>,
    session: Option<&str>,
    provider: &str,
    max_retries: u32,
    make_request: impl Fn(&reqwest::Client) -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, ProviderError> {
    send_with_egress_captured(
        default_client,
        egress,
        session,
        provider,
        max_retries,
        make_request,
    )
    .await
    .map(|(response, _)| response)
}

/// Returns the exact successful client before bindings can expire or be evicted.
pub(crate) async fn send_with_egress_captured(
    default_client: &reqwest::Client,
    egress: Option<&EgressClientPool>,
    session: Option<&str>,
    provider: &str,
    max_retries: u32,
    make_request: impl Fn(&reqwest::Client) -> reqwest::RequestBuilder,
) -> Result<(reqwest::Response, reqwest::Client), ProviderError> {
    let Some(pool) = egress else {
        if max_retries == 0 {
            return crate::trace_context::apply(make_request(default_client))
                .send()
                .await
                .map(|response| {
                    crate::trace_context::observe_status(response.status());
                    (response, default_client.clone())
                })
                .map_err(|error| {
                    if error.is_connect() {
                        ProviderError::Transport(format!("{provider} connection failed"))
                    } else if error.is_timeout() || error.is_request() {
                        ProviderError::DeliveryUncertain(format!(
                            "{provider} request delivery is uncertain"
                        ))
                    } else {
                        ProviderError::Provider(format!("{provider} request failed"))
                    }
                });
        }
        return send_with_retry(
            || Box::pin(crate::trace_context::apply(make_request(default_client)).send()),
            provider,
            max_retries,
        )
        .await
        .map(|response| (response, default_client.clone()));
    };
    let candidates = pool.candidates(session);
    if candidates.is_empty() {
        return Err(ProviderError::Transport(
            "all configured egress endpoints are cooling down".to_owned(),
        ));
    }
    for (index, client) in candidates {
        match crate::trace_context::apply(make_request(client))
            .send()
            .await
        {
            Ok(response)
                if response.status() == reqwest::StatusCode::PROXY_AUTHENTICATION_REQUIRED =>
            {
                pool.record_failure(index, Some(300));
            }
            Ok(response) => {
                pool.record_success(session, index);
                crate::trace_context::observe_status(response.status());
                return Ok((response, client.clone()));
            }
            Err(error) if error.is_connect() => {
                pool.record_failure(index, None);
            }
            Err(error) if error.is_timeout() => {
                pool.record_failure(index, None);
                return Err(ProviderError::DeliveryUncertain(format!(
                    "{provider} egress request timed out; delivery is uncertain"
                )));
            }
            Err(error) if error.is_request() => {
                pool.record_failure(index, None);
                return Err(ProviderError::DeliveryUncertain(format!(
                    "{provider} egress delivery failed; delivery is uncertain"
                )));
            }
            Err(_) => {
                return Err(ProviderError::Provider(format!(
                    "{provider} egress request failed"
                )))
            }
        }
    }
    Err(ProviderError::Transport(
        "configured egress endpoints rejected their connections".to_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{stalled_server, MockResponse, MockServer};
    use serde_json::json;

    fn proxy_client(url: &str) -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(url).unwrap())
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn proxy_407_fails_over_in_the_same_call_and_rebinds_the_session() {
        let denied = MockServer::always(MockResponse::json(407, "{}")).await;
        let accepted = MockServer::always(MockResponse::ok_json(r#"{"ok":true}"#)).await;
        let pool = EgressClientPool::new(vec![
            proxy_client(denied.base_url()),
            proxy_client(accepted.base_url()),
        ])
        .unwrap();
        for _ in 0..2 {
            let response = send_with_egress(
                &reqwest::Client::new(),
                Some(&pool),
                Some("session"),
                "inworld",
                0,
                |client| {
                    client
                        .post("http://unreachable.invalid/infer")
                        .bearer_auth("same-account")
                        .json(&json!({"input":"hello"}))
                },
            )
            .await
            .unwrap();
            assert_eq!(response.status(), 200);
        }
        assert_eq!(denied.requests().len(), 1);
        assert_eq!(accepted.requests().len(), 2);
        for request in accepted.requests() {
            assert_eq!(
                request.header("authorization").as_deref(),
                Some("Bearer same-account")
            );
        }
    }

    #[tokio::test]
    async fn connection_refusal_fails_over_before_request_delivery() {
        let unused = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let unavailable = format!("http://{}", unused.local_addr().unwrap());
        drop(unused);
        let accepted = MockServer::always(MockResponse::ok_json("{}")).await;
        let pool = EgressClientPool::new(vec![
            proxy_client(&unavailable),
            proxy_client(accepted.base_url()),
        ])
        .unwrap();
        let response = send_with_egress(
            &reqwest::Client::new(),
            Some(&pool),
            None,
            "openai",
            0,
            |client| {
                client
                    .post("http://unreachable.invalid/infer")
                    .json(&json!({"input":"hello"}))
            },
        )
        .await
        .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(accepted.requests().len(), 1);
    }

    #[tokio::test]
    async fn upstream_statuses_do_not_rotate_or_cool_a_proxy() {
        for status in [429, 500] {
            let first = MockServer::always(MockResponse::json(status, "{}")).await;
            let backup = MockServer::always(MockResponse::ok_json("{}")).await;
            let pool = EgressClientPool::new(vec![
                proxy_client(first.base_url()),
                proxy_client(backup.base_url()),
            ])
            .unwrap();
            let response = send_with_egress(
                &reqwest::Client::new(),
                Some(&pool),
                Some("session"),
                "openai",
                5,
                |client| client.post("http://unreachable.invalid/infer"),
            )
            .await
            .unwrap();
            assert_eq!(response.status().as_u16(), status);
            assert_eq!(first.requests().len(), 1);
            assert!(backup.requests().is_empty());
            assert_eq!(pool.candidates(Some("session"))[0].0, 0);
        }
    }

    #[tokio::test]
    async fn timeout_after_accepting_a_body_is_not_replayed() {
        use std::sync::atomic::Ordering;
        let (url, seen, server) = stalled_server().await;
        let backup = MockServer::always(MockResponse::ok_json("{}")).await;
        let pool = EgressClientPool::new(vec![proxy_client(&url), proxy_client(backup.base_url())])
            .unwrap();
        let error = send_with_egress(
            &reqwest::Client::new(),
            Some(&pool),
            Some("session"),
            "inworld",
            5,
            |client| {
                client
                    .post("http://unreachable.invalid/infer")
                    .timeout(std::time::Duration::from_millis(300))
                    .json(&json!({"input":"hello"}))
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(error, ProviderError::DeliveryUncertain(_)));
        assert_eq!(seen.load(Ordering::SeqCst), 1);
        assert!(backup.requests().is_empty());
        assert_eq!(pool.candidates(Some("session"))[0].0, 1);
        server.abort();
    }

    /// Without an egress pool, retrying chat paths (OpenAI-compatible, Core,
    /// Local) must not replay a generation the upstream may still be billing.
    #[tokio::test]
    async fn direct_retrying_send_does_not_replay_a_timed_out_generation() {
        use std::sync::atomic::Ordering;
        let (url, seen, server) = stalled_server().await;
        let error = send_with_egress(&reqwest::Client::new(), None, None, "openai", 3, |client| {
            client
                .post(format!("{url}/chat/completions"))
                .timeout(std::time::Duration::from_millis(300))
                .json(&json!({"messages":[]}))
        })
        .await
        .unwrap_err();
        assert!(matches!(error, ProviderError::DeliveryUncertain(_)));
        assert_eq!(seen.load(Ordering::SeqCst), 1);
        server.abort();
    }

    #[tokio::test]
    async fn direct_retrying_send_returns_origin_5xx_without_replay() {
        for status in [500, 504, 524] {
            let server = MockServer::always(MockResponse::json(status, "{}")).await;
            let url = format!("{}/chat/completions", server.base_url());
            let error =
                send_with_egress(&reqwest::Client::new(), None, None, "openai", 3, |client| {
                    client.post(&url).json(&json!({"messages":[]}))
                })
                .await
                .unwrap_err();
            assert!(
                matches!(error, ProviderError::Provider(_)),
                "{status}: {error:?}"
            );
            assert_eq!(server.requests().len(), 1, "{status}");
        }
    }

    #[tokio::test]
    async fn direct_retrying_send_retries_gateway_rejections_and_refused_connections() {
        let server = MockServer::start(vec![
            MockResponse::json(503, "{}"),
            MockResponse::ok_json("{}"),
        ])
        .await;
        let url = format!("{}/chat/completions", server.base_url());
        let response =
            send_with_egress(&reqwest::Client::new(), None, None, "openai", 1, |client| {
                client.post(&url).json(&json!({"messages":[]}))
            })
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(server.requests().len(), 2);

        let unused = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let refused = format!("http://{}/chat/completions", unused.local_addr().unwrap());
        drop(unused);
        let error = send_with_egress(&reqwest::Client::new(), None, None, "openai", 1, |client| {
            client.post(&refused).json(&json!({"messages":[]}))
        })
        .await
        .unwrap_err();
        assert!(matches!(error, ProviderError::Transport(_)), "{error:?}");
    }

    #[test]
    fn rotates_new_sessions_but_preserves_an_existing_session() {
        let pool =
            EgressClientPool::new(vec![reqwest::Client::new(), reqwest::Client::new()]).unwrap();
        assert_eq!(pool.candidates(Some("one"))[0].0, 0);
        assert_eq!(pool.candidates(Some("two"))[0].0, 1);
        assert_eq!(pool.candidates(Some("one"))[0].0, 0);
    }

    #[test]
    fn failed_endpoint_cools_down_and_session_rebinds_on_success() {
        let pool =
            EgressClientPool::new(vec![reqwest::Client::new(), reqwest::Client::new()]).unwrap();
        assert_eq!(pool.candidates(Some("one"))[0].0, 0);
        pool.record_failure(0, Some(30));
        assert_eq!(pool.candidates(Some("one"))[0].0, 1);
        pool.record_success(Some("one"), 1);
        assert_eq!(pool.candidates(Some("one"))[0].0, 1);
        pool.record_failure(1, Some(30));
        assert!(pool.candidates(Some("one")).is_empty());
    }

    #[test]
    fn job_binding_inherits_the_submission_transport() {
        let pool =
            EgressClientPool::new(vec![reqwest::Client::new(), reqwest::Client::new()]).unwrap();
        assert_eq!(pool.candidates(Some("submit"))[0].0, 0);
        pool.bind_job("submit", "prediction-id");
        assert_eq!(pool.candidates(Some("another-submit"))[0].0, 1);
        assert_eq!(pool.candidates(Some("prediction-id"))[0].0, 0);
    }

    #[test]
    fn rejects_empty_or_oversized_pools() {
        assert!(EgressClientPool::new(Vec::new()).is_err());
        assert!(EgressClientPool::new(vec![reqwest::Client::new(); 33]).is_err());
    }

    #[test]
    fn sdk_clients_share_endpoint_indexes_and_reject_mismatched_transport_sets() {
        let pool =
            EgressClientPool::new(vec![reqwest::Client::new(), reqwest::Client::new()]).unwrap();
        assert!(pool
            .with_sdk_clients(vec![reqwest_sdk::Client::new()])
            .is_err());
        let pool = EgressClientPool::new(vec![reqwest::Client::new(), reqwest::Client::new()])
            .unwrap()
            .with_sdk_clients(vec![reqwest_sdk::Client::new(), reqwest_sdk::Client::new()])
            .unwrap();
        assert!(pool.sdk_client(0).is_some());
        assert!(pool.sdk_client(1).is_some());
        assert!(pool.sdk_client(2).is_none());
    }

    #[test]
    fn priority_groups_rotate_evenly_and_keep_a_healthy_session_binding() {
        let pool = EgressClientPool::new(vec![reqwest::Client::new(); 4])
            .unwrap()
            .with_priorities(vec![20, 0, 0, 100])
            .unwrap();
        for (session, index) in [("a", 1), ("b", 2), ("c", 1), ("d", 2)] {
            assert_eq!(pool.candidates(Some(session))[0].0, index);
        }
        assert_eq!(pool.candidates(Some("a"))[0].0, 1);
        pool.record_failure(1, Some(60));
        pool.record_failure(2, Some(60));
        assert_eq!(pool.candidates(Some("a"))[0].0, 0);
        pool.record_success(Some("a"), 0);
        assert_eq!(pool.candidates(Some("a"))[0].0, 0);
        pool.record_failure(0, Some(60));
        assert_eq!(pool.candidates(Some("a"))[0].0, 3);
    }
}
