//! MiniMax native text-to-image API, including body-level errors on HTTP 200.
use crate::{
    account_pool::AccountPool, egress::send_with_egress, error::PAYMENT_REQUIRED_COOLDOWN,
    parse_rate_limit, EgressClientPool, Provider, ProviderError, ProviderQuotas,
};
use axum::body::Body;
use base64::Engine;
use serde_json::{json, Value};
use std::{pin::Pin, sync::Arc};

pub struct MiniMaxProvider {
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    keys: Vec<String>,
    accounts: AccountPool,
    base_url: String,
    quota: Arc<ProviderQuotas>,
}
impl MiniMaxProvider {
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
        let invalid = |message: &str| ProviderError::Provider(format!("MiniMax: {message}"));
        if model != "image-01" {
            return Err(invalid("unsupported image model"));
        }
        let prompt = body["prompt"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| invalid("prompt is required"))?;
        if prompt.chars().count() > 1500 {
            return Err(invalid("prompt exceeds 1500 characters"));
        }
        let count = body
            .get("n")
            .filter(|v| !v.is_null())
            .map(|v| {
                v.as_u64()
                    .filter(|n| (1..=9).contains(n))
                    .ok_or_else(|| invalid("n must be an integer from 1 to 9"))
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
            return Err(invalid("response_format must be url or b64_json"));
        }
        let mut payload = body
            .as_object()
            .cloned()
            .ok_or_else(|| invalid("image request must be an object"))?;
        payload.insert("model".into(), model.into());
        payload.insert("n".into(), count.into());
        payload.insert(
            "response_format".into(),
            if format == "url" { "url" } else { "base64" }.into(),
        );
        if let Some(size) = payload.remove("size").filter(|v| !v.is_null()) {
            if payload.contains_key("width")
                || payload.contains_key("height")
                || payload.contains_key("aspect_ratio")
            {
                return Err(invalid("use size or native dimensions/aspect_ratio"));
            }
            let (width, height) = size
                .as_str()
                .and_then(|s| s.split_once('x'))
                .ok_or_else(|| invalid("size must be WIDTHxHEIGHT"))?;
            payload.insert(
                "width".into(),
                width
                    .parse::<u64>()
                    .map_err(|_| invalid("invalid size"))?
                    .into(),
            );
            payload.insert(
                "height".into(),
                height
                    .parse::<u64>()
                    .map_err(|_| invalid("invalid size"))?
                    .into(),
            );
        }
        let dimensions = payload.contains_key("width") || payload.contains_key("height");
        if dimensions {
            if payload.contains_key("aspect_ratio") {
                return Err(invalid("choose dimensions or aspect_ratio"));
            }
            for field in ["width", "height"] {
                if !payload
                    .get(field)
                    .and_then(Value::as_u64)
                    .is_some_and(|n| (512..=2048).contains(&n) && n % 8 == 0)
                {
                    return Err(invalid(
                        "width and height must be multiples of 8 from 512 to 2048",
                    ));
                }
            }
        }
        if let Some(ratio) = payload.get("aspect_ratio") {
            if !ratio.as_str().is_some_and(|s| {
                ["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"].contains(&s)
            }) {
                return Err(invalid("unsupported aspect_ratio"));
            }
        }
        if payload.get("seed").is_some_and(|v| v.as_i64().is_none()) {
            return Err(invalid("seed must be an int64"));
        }
        if payload
            .get("prompt_optimizer")
            .is_some_and(|v| !v.is_boolean())
        {
            return Err(invalid("prompt_optimizer must be boolean"));
        }
        let uncertain = |message: &str| {
            ProviderError::DeliveryUncertain(format!("MiniMax image submission: {message}"))
        };
        let url = format!("{}/image_generation", self.base_url.trim_end_matches('/'));
        let mut last_error = None;
        for index in self.accounts.candidates(None) {
            let mut response = send_with_egress(
                &self.client,
                self.egress.as_deref(),
                None,
                "minimax",
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
                self.accounts.record_rate_limit(index, retry_after);
                last_error = Some(ProviderError::RateLimited {
                    provider: "minimax".into(),
                    retry_after,
                    reset_at: limits.as_ref().and_then(|v| v.reset_at),
                });
                continue;
            }
            if status == reqwest::StatusCode::PAYMENT_REQUIRED {
                self.accounts
                    .record_account_rejection(index, PAYMENT_REQUIRED_COOLDOWN);
                last_error = Some(ProviderError::PaymentRequired {
                    provider: "minimax".into(),
                    message: "MiniMax account balance is required".into(),
                });
                continue;
            }
            if status.is_server_error() {
                return Err(uncertain("upstream server error"));
            }
            if !status.is_success() {
                return Err(crate::upstream_status_error(
                    status,
                    format!("MiniMax: upstream returned HTTP {}", status.as_u16()),
                ));
            }
            let mut bytes = Vec::new();
            const MAX_RESPONSE: usize = 64 * 1024 * 1024;
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
            let code = result["base_resp"]["status_code"]
                .as_i64()
                .ok_or_else(|| uncertain("missing native status"))?;
            match code {
                0 => {}
                1002 | 2056 => {
                    let retry_after = Some(if code == 2056 { 18000 } else { 60 });
                    self.accounts.record_rate_limit(index, retry_after);
                    last_error = Some(ProviderError::RateLimited {
                        provider: "minimax".into(),
                        retry_after,
                        reset_at: None,
                    });
                    continue;
                }
                1008 => {
                    self.accounts
                        .record_account_rejection(index, PAYMENT_REQUIRED_COOLDOWN);
                    last_error = Some(ProviderError::PaymentRequired {
                        provider: "minimax".into(),
                        message: "MiniMax account balance is required".into(),
                    });
                    continue;
                }
                1000 | 1001 | 1024 | 1033 => {
                    return Err(uncertain(
                        "native execution failed without a definitive rejection",
                    ))
                }
                1004 | 2049 => return Err(invalid("API key authentication failed")),
                1026 | 1027 => {
                    return Err(uncertain(
                        "provider moderation stopped generation; automatic replay is disabled",
                    ))
                }
                2013 => return Err(invalid("native API rejected request parameters")),
                _ => return Err(uncertain(&format!("unrecognized native status {code}"))),
            }
            let field = if format == "url" {
                "image_urls"
            } else {
                "image_base64"
            };
            let images = result["data"][field]
                .as_array()
                .filter(|rows| rows.len() == count as usize)
                .ok_or_else(|| uncertain("image count is invalid"))?;
            let mut data = Vec::with_capacity(images.len());
            for image in images {
                let value = image
                    .as_str()
                    .ok_or_else(|| uncertain("image value is invalid"))?;
                if format == "url" {
                    let parsed = reqwest::Url::parse(value)
                        .map_err(|_| uncertain("image URL is invalid"))?;
                    if !matches!(parsed.scheme(), "https" | "http")
                        || parsed.host_str().is_none()
                        || !parsed.username().is_empty()
                        || parsed.password().is_some()
                    {
                        return Err(uncertain("image URL is invalid"));
                    }
                    data.push(json!({"url":value}));
                } else {
                    let decoded = base64::engine::general_purpose::STANDARD
                        .decode(value)
                        .map_err(|_| uncertain("image base64 is invalid"))?;
                    if decoded.is_empty() {
                        return Err(uncertain("image is empty"));
                    }
                    data.push(json!({"b64_json":value}));
                }
            }
            self.accounts.record_success(None, index);
            if let Some(limits) = limits.as_ref() {
                self.quota.record_success("minimax", limits);
            }
            let created = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            return Ok(json!({"created":created, "data":data}));
        }
        if let Some(ProviderError::RateLimited {
            retry_after,
            reset_at,
            ..
        }) = &last_error
        {
            self.quota
                .record_rate_limited("minimax", *retry_after, *reset_at);
        }
        Err(last_error.unwrap_or_else(|| invalid("no eligible image accounts")))
    }
}
impl Provider for MiniMaxProvider {
    fn name(&self) -> &'static str {
        "minimax"
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
            Some(vec![
                json!({"id":"image-01","object":"model","owned_by":"minimax","modality":"image"}),
            ])
        })
    }
    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async {
            Err(ProviderError::Provider(
                "This MiniMax adapter supports image generation".into(),
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
                "This MiniMax adapter does not stream chat".into(),
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
#[path = "minimax_test.rs"]
mod tests;
