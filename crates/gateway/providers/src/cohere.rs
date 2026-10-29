use crate::response_body::BoundedResponse;
use std::pin::Pin;
use std::sync::Arc;

use axum::body::Body;
use serde_json::{json, Value};

use crate::{error::ProviderError, quota::ProviderQuotas};

use super::{
    account_pool::AccountPool, egress::send_with_egress, parse_rate_limit, upstream_status_error,
    EgressClientPool, Provider,
};

/// Cohere Embed/Rerank v2. The request and embedding response differ from the
/// OpenAI schema, so this is an adapter rather than an OpenAI-compatible alias.
pub struct CohereProvider {
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    keys: Vec<String>,
    accounts: AccountPool,
    base_url: String,
    quota: Arc<ProviderQuotas>,
}

impl CohereProvider {
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

    async fn send_request(
        &self,
        url: &str,
        key: &str,
        payload: &Value,
    ) -> Result<reqwest::Response, ProviderError> {
        let response = send_with_egress(
            &self.client,
            self.egress.as_deref(),
            None,
            "cohere",
            0,
            |client| client.post(url).bearer_auth(key).json(payload),
        )
        .await?;
        if response.status().is_server_error()
            || response.status() == reqwest::StatusCode::REQUEST_TIMEOUT
        {
            return Err(ProviderError::DeliveryUncertain(
                "Cohere service request failed without a definitive rejection".to_owned(),
            ));
        }
        Ok(response)
    }

    async fn post(&self, path: &str, payload: &Value) -> Result<Value, ProviderError> {
        let url = format!("{}/{}", self.base_url.trim_end_matches('/'), path);
        let mut last_limit = None;
        for index in self.accounts.candidates(None) {
            let key = &self.keys[index];
            let response = self.send_request(&url, key, payload).await?;
            let status = response.status();
            let rate_limit = parse_rate_limit(response.headers());
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = rate_limit.as_ref().and_then(|info| info.retry_after);
                let reset_at = rate_limit.as_ref().and_then(|info| info.reset_at);
                self.accounts.record_rate_limit(index, retry_after);
                self.quota
                    .record_rate_limited("cohere", retry_after, reset_at);
                last_limit = Some(ProviderError::RateLimited {
                    provider: "cohere".to_owned(),
                    retry_after,
                    reset_at,
                });
                continue;
            }
            let response_body: Value = response.bounded_json().await.map_err(|_| {
                if status.is_success() {
                    ProviderError::DeliveryUncertain(
                        "Cohere accepted response could not be decoded".to_owned(),
                    )
                } else {
                    upstream_status_error(
                        status,
                        format!("Cohere HTTP {status}: error response could not be decoded"),
                    )
                }
            })?;
            if !status.is_success() {
                let message = response_body
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("provider request failed");
                // A 400/404/413/422 rejects this request; typed so it does not
                // count toward the provider circuit every tenant shares.
                return Err(upstream_status_error(
                    status,
                    format!(
                        "Cohere HTTP {status}: {}",
                        message.chars().take(300).collect::<String>()
                    ),
                ));
            }
            if let Some(info) = rate_limit.as_ref() {
                self.quota.record_success("cohere", info);
            }
            return Ok(response_body);
        }
        Err(last_limit.unwrap_or_else(|| ProviderError::RateLimited {
            provider: "cohere".to_owned(),
            retry_after: None,
            reset_at: None,
        }))
    }
}

impl Provider for CohereProvider {
    fn configure_account_policies(&self, policies: &[crate::ProviderAccountPolicy]) {
        self.accounts.configure(policies);
    }

    fn name(&self) -> &'static str {
        "cohere"
    }

    fn has_rotating_accounts(&self) -> bool {
        self.accounts.has_restrictions()
            || self.keys.len() > 1
            || self.egress.as_ref().is_some_and(|pool| pool.len() > 1)
    }

    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async {
            Err(ProviderError::Provider(
                "Cohere chat is not configured in this adapter".to_owned(),
            ))
        })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        Box::pin(async {
            Err(ProviderError::Provider(
                "Cohere chat streaming is not configured in this adapter".to_owned(),
            ))
        })
    }

    fn embed<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let inputs: Vec<&str> = match body.get("input") {
                Some(Value::String(text)) => vec![text],
                Some(Value::Array(items)) => items
                    .iter()
                    .map(|item| {
                        item.as_str().ok_or_else(|| {
                            ProviderError::Provider(
                                "Cohere embedding input must contain text".to_owned(),
                            )
                        })
                    })
                    .collect::<Result<_, _>>()?,
                _ => {
                    return Err(ProviderError::Provider(
                        "Cohere embedding input is missing".to_owned(),
                    ))
                }
            };
            let input_type = body
                .get("input_type")
                .and_then(Value::as_str)
                .unwrap_or("search_document");
            if !matches!(
                input_type,
                "search_document" | "search_query" | "classification" | "clustering"
            ) {
                return Err(ProviderError::Provider(
                    "Unsupported Cohere input_type".to_owned(),
                ));
            }
            let payload = json!({
                "model": model,
                "texts": inputs,
                "input_type": input_type,
                "embedding_types": ["float"],
            });
            let upstream = self.post("v2/embed", &payload).await?;
            let vectors = upstream
                .get("embeddings")
                .and_then(|embeddings| embeddings.get("float"))
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    ProviderError::DeliveryUncertain(
                        "Cohere returned no float embeddings".to_owned(),
                    )
                })?;
            if vectors.len() != inputs.len()
                || vectors.iter().any(|vector| {
                    vector.as_array().is_none_or(|values| {
                        values.is_empty() || values.iter().any(|value| !value.is_number())
                    })
                })
            {
                return Err(ProviderError::DeliveryUncertain(
                    "Cohere returned malformed embeddings".to_owned(),
                ));
            }
            let data: Vec<Value> = vectors
                .iter()
                .enumerate()
                .map(|(index, vector)| json!({ "object": "embedding", "index": index, "embedding": vector }))
                .collect();
            let tokens = upstream
                .get("meta")
                .and_then(|meta| meta.get("billed_units"))
                .and_then(|units| units.get("input_tokens"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            Ok(json!({
                "object": "list",
                "data": data,
                "model": model,
                "usage": { "prompt_tokens": tokens, "total_tokens": tokens },
            }))
        })
    }

    fn rerank<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let query = body.get("query").and_then(Value::as_str).ok_or_else(|| {
                ProviderError::Provider("Cohere rerank query is missing".to_owned())
            })?;
            let documents = body
                .get("documents")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    ProviderError::Provider("Cohere rerank documents are missing".to_owned())
                })?;
            let mut payload = json!({ "model": model, "query": query, "documents": documents });
            if let Some(top_n) = body.get("top_n") {
                payload["top_n"] = top_n.clone();
            }
            let upstream = self.post("v2/rerank", &payload).await?;
            if upstream.get("results").and_then(Value::as_array).is_none() {
                return Err(ProviderError::DeliveryUncertain(
                    "Cohere returned no rerank results".to_owned(),
                ));
            }
            Ok(upstream)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockResponse, MockServer};

    #[tokio::test]
    async fn request_rejections_are_typed_even_without_a_json_body() {
        for (status, reply) in [(400, r#"{"message":"invalid model"}"#), (422, "not json")] {
            let server = MockServer::always(MockResponse::json(status, reply)).await;
            let provider = CohereProvider::new(
                reqwest::Client::new(),
                vec!["secret".to_owned()],
                server.base_url().to_owned(),
                Arc::new(ProviderQuotas::new()),
            );
            let result = provider
                .embed("embed-v4.0", &json!({"input": "alpha"}))
                .await;
            assert!(
                matches!(result, Err(ProviderError::Rejected { .. })),
                "{status}"
            );
        }
        let server = MockServer::always(MockResponse::json(500, "{}")).await;
        let provider = CohereProvider::new(
            reqwest::Client::new(),
            vec!["secret".to_owned()],
            server.base_url().to_owned(),
            Arc::new(ProviderQuotas::new()),
        );
        let result = provider
            .embed("embed-v4.0", &json!({"input": "alpha"}))
            .await;
        // A server error is not a rejection of this request: the transport marks
        // it delivery-uncertain so it is neither replayed nor typed as a 4xx.
        assert!(matches!(result, Err(ProviderError::DeliveryUncertain(_))));
    }

    #[tokio::test]
    async fn embed_translates_cohere_vectors_to_gateway_schema() {
        let server = MockServer::always(MockResponse::ok_json(r#"{"embeddings":{"float":[[0.1,0.2],[0.3,0.4]]},"meta":{"billed_units":{"input_tokens":4}}}"#)).await;
        let provider = CohereProvider::new(
            reqwest::Client::new(),
            vec!["secret".to_owned()],
            server.base_url().to_owned(),
            Arc::new(ProviderQuotas::new()),
        );
        let result = provider
            .embed(
                "embed-v4.0",
                &json!({"input":["alpha","beta"],"input_type":"search_query"}),
            )
            .await
            .unwrap();
        assert_eq!(result["data"][1]["embedding"], json!([0.3, 0.4]));
        assert_eq!(result["usage"]["prompt_tokens"], 4);
        let request = &server.requests()[0];
        assert_eq!(request.path, "/v2/embed");
        assert_eq!(request.json()["texts"], json!(["alpha", "beta"]));
        assert_eq!(request.json()["input_type"], "search_query");
    }

    #[tokio::test]
    async fn rerank_posts_native_options_and_preserves_results_and_billed_usage() {
        let upstream = json!({
            "id": "rerank-proof",
            "results": [
                {"index": 1, "relevance_score": 0.97},
                {"index": 0, "relevance_score": 0.12}
            ],
            "meta": {"billed_units": {"search_units": 1}}
        });
        let server = MockServer::always(MockResponse::ok_json(&upstream.to_string())).await;
        let provider = CohereProvider::new(
            reqwest::Client::new(),
            vec!["rerank-proof-key".to_owned()],
            server.base_url().to_owned(),
            Arc::new(ProviderQuotas::new()),
        );
        let documents = json!(["unrelated document", "matching document"]);
        let result = provider
            .rerank(
                "rerank-v3.5",
                &json!({"query": "matching", "documents": documents, "top_n": 2}),
            )
            .await
            .unwrap();
        assert_eq!(result, upstream);
        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/v2/rerank");
        assert_eq!(
            request.header("authorization").as_deref(),
            Some("Bearer rerank-proof-key")
        );
        assert_eq!(
            request.json(),
            json!({
                "model": "rerank-v3.5",
                "query": "matching",
                "documents": documents,
                "top_n": 2
            })
        );
    }

    #[tokio::test]
    async fn ambiguous_embed_and_rerank_never_replay_or_rotate_accounts() {
        for embed in [true, false] {
            let server = MockServer::always(MockResponse::json(503, "{}")).await;
            let provider = CohereProvider::new(
                reqwest::Client::new(),
                vec!["first".to_owned(), "second".to_owned()],
                server.base_url().to_owned(),
                Arc::new(ProviderQuotas::new()),
            );
            let result = if embed {
                provider
                    .embed("embed-v4.0", &json!({"input":"hello"}))
                    .await
            } else {
                provider
                    .rerank(
                        "rerank-v3.5",
                        &json!({"query":"hello","documents":["world"]}),
                    )
                    .await
            };
            assert!(matches!(result, Err(ProviderError::DeliveryUncertain(_))));
            assert_eq!(server.requests().len(), 1);
        }
    }
}
