//! Direct Recraft JSON image generation. No chat/embedding capability is inferred.
use crate::{
    account_pool::AccountPool, egress::send_with_egress, error::PAYMENT_REQUIRED_COOLDOWN,
    parse_rate_limit, EgressClientPool, Provider, ProviderError, ProviderQuotas,
};
use axum::body::Body;
use base64::Engine;
use serde_json::{json, Value};
use std::{pin::Pin, sync::Arc};

pub const MODELS: &[&str] = &[
    "recraftv4_1",
    "recraftv4_1_vector",
    "recraftv4_1_pro",
    "recraftv4_1_pro_vector",
    "recraftv4_1_utility",
    "recraftv4_1_utility_vector",
    "recraftv4_1_utility_pro",
    "recraftv4_1_utility_pro_vector",
    "recraftv4_1_flash",
    "recraftv4_1_flash_raster",
    "recraftv4",
    "recraftv4_vector",
    "recraftv4_pro",
    "recraftv4_pro_vector",
    "recraftv4_styles",
    "recraftv4_styles_vector",
    "recraftv4_styles_pro",
    "recraftv4_styles_pro_vector",
    "recraftv3",
    "recraftv3_vector",
    "recraftv2",
    "recraftv2_vector",
];

pub struct RecraftProvider {
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    keys: Vec<String>,
    accounts: AccountPool,
    base_url: String,
    quota: Arc<ProviderQuotas>,
}
impl RecraftProvider {
    pub fn new(
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
    async fn generate(&self, model: &str, body: &Value) -> Result<Value, ProviderError> {
        let invalid = |message: &str| ProviderError::Provider(format!("Recraft: {message}"));
        if !MODELS.contains(&model) {
            return Err(invalid("unsupported image model"));
        }
        let prompt = body["prompt"]
            .as_str()
            .filter(|p| !p.trim().is_empty())
            .ok_or_else(|| invalid("prompt is required"))?;
        let max_prompt = if model.starts_with("recraftv2") || model.starts_with("recraftv3") {
            1000
        } else {
            10000
        };
        if prompt.chars().count() > max_prompt {
            return Err(invalid("prompt exceeds the selected model limit"));
        }
        let count = body
            .get("n")
            .filter(|v| !v.is_null())
            .map(|v| {
                v.as_u64()
                    .filter(|n| (1..=6).contains(n))
                    .ok_or_else(|| invalid("n must be an integer from 1 to 6"))
            })
            .transpose()?
            .unwrap_or(1);
        let format = body
            .get("response_format")
            .filter(|v| !v.is_null())
            .map(|v| {
                v.as_str()
                    .ok_or_else(|| invalid("response_format must be text"))
            })
            .transpose()?
            .unwrap_or("url");
        if !matches!(format, "url" | "b64_json") {
            return Err(invalid("Gateway supports url and b64_json responses"));
        }
        let mut payload = body
            .as_object()
            .cloned()
            .ok_or_else(|| invalid("image request must be an object"))?;
        payload.insert("model".to_owned(), model.into());
        payload.insert("n".to_owned(), count.into());
        payload.insert("response_format".to_owned(), format.into());
        let url = format!("{}/images/generations", self.base_url.trim_end_matches('/'));
        let mut last_error = None;
        for index in self.accounts.candidates(None) {
            let mut response = send_with_egress(
                &self.client,
                self.egress.as_deref(),
                None,
                "recraft",
                0,
                |client| {
                    client
                        .post(&url)
                        .bearer_auth(&self.keys[index])
                        .json(&payload)
                },
            )
            .await?;
            let status = response.status();
            let limits = parse_rate_limit(response.headers());
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = limits.as_ref().and_then(|v| v.retry_after);
                let reset_at = limits.as_ref().and_then(|v| v.reset_at);
                self.accounts.record_rate_limit(index, retry_after);

                last_error = Some(ProviderError::RateLimited {
                    provider: "recraft".to_owned(),
                    retry_after,
                    reset_at,
                });
                continue;
            }
            if status == reqwest::StatusCode::PAYMENT_REQUIRED {
                self.accounts
                    .record_account_rejection(index, PAYMENT_REQUIRED_COOLDOWN);
                last_error = Some(ProviderError::PaymentRequired {
                    provider: "recraft".to_owned(),
                    message: "Recraft account credits are required".to_owned(),
                });
                continue;
            }
            if !status.is_success() {
                return Err(crate::upstream_status_error(
                    status,
                    format!("Recraft: image upstream returned HTTP {}", status.as_u16()),
                ));
            }
            let uncertain = |message: &str| {
                ProviderError::DeliveryUncertain(format!(
                    "Recraft accepted image generation: {message}"
                ))
            };
            const MAX_RESPONSE: usize = 64 * 1024 * 1024;
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| uncertain("response could not be read"))?
            {
                if chunk.len() > MAX_RESPONSE.saturating_sub(bytes.len()) {
                    return Err(uncertain("response exceeds the Gateway limit"));
                }
                bytes.extend_from_slice(&chunk);
            }
            let result: Value =
                serde_json::from_slice(&bytes).map_err(|_| uncertain("response is not JSON"))?;
            let images = result["data"]
                .as_array()
                .filter(|rows| rows.len() == count as usize)
                .ok_or_else(|| uncertain("response image count is invalid"))?;
            for image in images {
                if format == "url" {
                    let url = image["url"]
                        .as_str()
                        .and_then(|url| reqwest::Url::parse(url).ok())
                        .filter(|url| {
                            matches!(url.scheme(), "https" | "http")
                                && url.host_str().is_some()
                                && url.username().is_empty()
                                && url.password().is_none()
                        });
                    if url.is_none() {
                        return Err(uncertain("image URL is invalid"));
                    }
                } else {
                    let encoded = image["b64_json"]
                        .as_str()
                        .ok_or_else(|| uncertain("image base64 is missing"))?;
                    let decoded = base64::engine::general_purpose::STANDARD
                        .decode(encoded)
                        .map_err(|_| uncertain("image base64 is invalid"))?;
                    if decoded.is_empty() {
                        return Err(uncertain("image is empty"));
                    }
                }
            }
            self.accounts.record_success(None, index);
            if let Some(limits) = limits.as_ref() {
                self.quota.record_success("recraft", limits);
            }
            return Ok(result);
        }
        if let Some(ProviderError::RateLimited {
            retry_after,
            reset_at,
            ..
        }) = &last_error
        {
            self.quota
                .record_rate_limited("recraft", *retry_after, *reset_at);
        }
        Err(last_error.unwrap_or_else(|| invalid("no eligible image accounts")))
    }
}
impl Provider for RecraftProvider {
    fn name(&self) -> &'static str {
        "recraft"
    }
    fn configure_account_policies(&self, policies: &[crate::ProviderAccountPolicy]) {
        self.accounts.configure(policies);
    }
    fn has_rotating_accounts(&self) -> bool {
        self.accounts.has_restrictions()
            || self.keys.len() > 1
            || self.egress.as_ref().is_some_and(|p| p.len() > 1)
    }
    fn discover_models<'a>(
        &'a self,
    ) -> Pin<Box<dyn std::future::Future<Output = Option<Vec<Value>>> + Send + 'a>> {
        Box::pin(async {
            Some(MODELS.iter().map(|model| json!({"id":model,"object":"model","owned_by":"recraft","modality":"image"})).collect())
        })
    }
    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async {
            Err(ProviderError::Provider(
                "Recraft is an image provider".to_owned(),
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
                "Recraft does not stream chat".to_owned(),
            ))
        })
    }
    fn generate_image<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(self.generate(model, body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockResponse, MockServer};
    fn provider(server: &MockServer, keys: Vec<String>) -> RecraftProvider {
        RecraftProvider::new(
            reqwest::Client::new(),
            None,
            keys,
            server.base_url().to_owned(),
            Arc::new(ProviderQuotas::new()),
        )
    }
    #[tokio::test]
    async fn rotates_rejected_accounts_and_preserves_json_image_fields() {
        let server = MockServer::start(vec![
            MockResponse::json(429, "{}").with_header("retry-after", "120"),
            MockResponse::ok_json(r#"{"data":[{"b64_json":"aW1hZ2U="}]}"#),
        ])
        .await;
        let p = provider(&server, vec!["first".into(), "second".into()]);
        let result = p.generate_image("recraftv4_1", &json!({"prompt":"A tree", "n":1, "response_format":"b64_json", "size":"16:9", "image_format":"png"})).await.unwrap();
        assert_eq!(result["data"][0]["b64_json"], "aW1hZ2U=");
        assert_ne!(p.quota.snapshot()["recraft"]["rate_limited"], json!(true));
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].header("authorization").as_deref(),
            Some("Bearer first")
        );
        assert_eq!(
            requests[1].header("authorization").as_deref(),
            Some("Bearer second")
        );
        assert_eq!(requests[1].path, "/images/generations");
        let wire: Value = serde_json::from_slice(&requests[1].body).unwrap();
        assert_eq!(wire["model"], "recraftv4_1");
        assert_eq!(wire["size"], "16:9");
        assert_eq!(wire["image_format"], "png");
    }
    #[tokio::test]
    async fn accepted_invalid_output_never_replays_and_disabled_accounts_receive_no_work() {
        let server = MockServer::always(MockResponse::ok_json(r#"{"data":[]}"#)).await;
        let p = provider(&server, vec!["first".into(), "second".into()]);
        assert!(matches!(
            p.generate_image("recraftv4_1", &json!({"prompt":"A tree"}))
                .await,
            Err(ProviderError::DeliveryUncertain(_))
        ));
        assert_eq!(server.requests().len(), 1);
        p.configure_account_policies(&[
            crate::ProviderAccountPolicy {
                enabled: false,
                ..Default::default()
            },
            crate::ProviderAccountPolicy {
                enabled: false,
                ..Default::default()
            },
        ]);
        assert!(p
            .generate_image("recraftv4_1", &json!({"prompt":"A tree"}))
            .await
            .is_err());
        assert_eq!(server.requests().len(), 1);
    }
    #[tokio::test]
    async fn uses_assigned_proxy_with_the_selected_account() {
        let proxy = MockServer::always(MockResponse::ok_json(
            r#"{"data":[{"url":"https://assets.example/image.webp"}]}"#,
        ))
        .await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(proxy.base_url()).unwrap())
            .build()
            .unwrap();
        let pool = Arc::new(EgressClientPool::new(vec![client]).unwrap());
        let p = RecraftProvider::new(
            reqwest::Client::new(),
            Some(pool),
            vec!["disabled".into(), "preferred".into()],
            "http://unreachable.invalid/v1".into(),
            Arc::new(ProviderQuotas::new()),
        );
        p.configure_account_policies(&[
            crate::ProviderAccountPolicy {
                enabled: false,
                ..Default::default()
            },
            crate::ProviderAccountPolicy::default(),
        ]);
        p.generate_image("recraftv4_1", &json!({"prompt":"A tree"}))
            .await
            .unwrap();
        let requests = proxy.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].header("authorization").as_deref(),
            Some("Bearer preferred")
        );
    }

    #[tokio::test]
    async fn rejects_invalid_requests_before_network_and_does_not_advertise_chat() {
        let server = MockServer::always(MockResponse::ok_json("{}")).await;
        let p = provider(&server, vec!["first".into()]);
        for body in [
            json!({"prompt":""}),
            json!({"prompt":"tree", "n":7}),
            json!({"prompt":"tree", "response_format":"multipart"}),
            json!({"prompt":"x".repeat(1001)}),
        ] {
            assert!(p.generate_image("recraftv3", &body).await.is_err());
        }
        assert!(p.complete("recraftv4_1", &json!({})).await.is_err());
        assert_eq!(server.requests().len(), 0);
        assert!(p
            .discover_models()
            .await
            .unwrap()
            .iter()
            .all(|m| m["modality"] == "image"));
    }
    #[tokio::test]
    async fn a_single_key_refused_for_credit_serves_again_once_refilled() {
        let server = MockServer::start(vec![
            MockResponse::json(402, "{}"),
            MockResponse::ok_json(r#"{"data":[{"b64_json":"aW1hZ2U="}]}"#),
        ])
        .await;
        let p = provider(&server, vec!["only".into()]);
        let body = json!({"prompt":"A tree", "response_format":"b64_json"});
        let refused = p.generate_image("recraftv4_1", &body).await;
        assert!(matches!(
            refused,
            Err(ProviderError::PaymentRequired { .. })
        ));
        p.generate_image("recraftv4_1", &body).await.unwrap();
        assert_eq!(server.requests().len(), 2);
    }
}
