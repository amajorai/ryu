//! BFL asynchronous generation with account-qualified, origin-checked poll handles.
use crate::{
    account_pool::AccountPool,
    egress::{send_with_egress, send_with_egress_captured},
    error::PAYMENT_REQUIRED_COOLDOWN,
    parse_rate_limit, EgressClientPool, JobStatus, Provider, ProviderError, ProviderQuotas,
    VideoJob,
};
use axum::body::Body;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant},
};

pub const IMAGE_MODELS: &[&str] = &[
    "flux-2-max",
    "flux-2-pro-preview",
    "flux-2-pro",
    "flux-2-flex",
    "flux-2-klein-4b",
    "flux-2-klein-9b-preview",
    "flux-2-klein-9b",
    "flux-kontext-max",
    "flux-kontext-pro",
    "flux-pro-1.1-ultra",
    "flux-pro-1.1",
    "flux-pro",
    "flux-dev",
];
pub struct BflProvider {
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    keys: Vec<String>,
    accounts: AccountPool,
    base_url: String,
    quota: Arc<ProviderQuotas>,
    poll_interval: Duration,
    poll_timeout: Duration,
}
fn uncertain(message: &str) -> ProviderError {
    ProviderError::DeliveryUncertain(format!("BFL accepted generation: {message}"))
}
fn invalid(message: &str) -> ProviderError {
    ProviderError::Provider(format!("BFL: {message}"))
}
impl BflProvider {
    pub fn new(
        client: reqwest::Client,
        egress: Option<Arc<EgressClientPool>>,
        keys: Vec<String>,
        base_url: String,
        quota: Arc<ProviderQuotas>,
        poll_interval_ms: u64,
        poll_timeout_secs: u64,
    ) -> Self {
        Self {
            client,
            egress,
            accounts: AccountPool::new(keys.len()),
            keys,
            base_url,
            quota,
            poll_interval: Duration::from_millis(poll_interval_ms),
            poll_timeout: Duration::from_secs(poll_timeout_secs),
        }
    }
    fn valid_poll_url(&self, raw: &str, id: Option<&str>) -> Result<reqwest::Url, ProviderError> {
        let url = reqwest::Url::parse(raw).map_err(|_| uncertain("invalid polling URL"))?;
        let base = reqwest::Url::parse(&self.base_url).map_err(|_| invalid("invalid base URL"))?;
        let official = base
            .host_str()
            .is_some_and(|host| matches!(host, "api.bfl.ai" | "api.eu.bfl.ai" | "api.us.bfl.ai"));
        let allowed = if official {
            url.scheme() == "https"
                && url.port_or_known_default() == Some(443)
                && url
                    .host_str()
                    .is_some_and(|host| host.starts_with("api.") && host.ends_with(".bfl.ai"))
        } else {
            url.origin() == base.origin()
        };
        let ids: Vec<_> = url.query_pairs().filter(|(key, _)| key == "id").collect();
        if !allowed
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || url.path() != "/v1/get_result"
            || ids.len() != 1
            || ids[0].1.is_empty()
            || id.is_some_and(|id| ids[0].1 != id)
        {
            return Err(uncertain(
                "polling URL is outside the trusted API origin or task",
            ));
        }
        Ok(url)
    }
    fn account_ref(&self, index: usize, url: &str) -> String {
        format!(
            "bf1:{:x}:{url}",
            Sha256::digest(self.keys[index].as_bytes())
        )
    }
    fn resolve_ref(&self, reference: &str) -> Result<(usize, reqwest::Url), ProviderError> {
        let rest = reference
            .strip_prefix("bf1:")
            .ok_or_else(|| invalid("unsupported job reference"))?;
        let (fingerprint, url) = rest
            .split_once(':')
            .ok_or_else(|| invalid("invalid job reference"))?;
        let index = self
            .keys
            .iter()
            .position(|key| format!("{:x}", Sha256::digest(key.as_bytes())) == fingerprint)
            .ok_or_else(|| invalid("the original job account is no longer configured"))?;
        Ok((index, self.valid_poll_url(url, None)?))
    }
    async fn read_json(mut response: reqwest::Response) -> Result<Value, ProviderError> {
        let mut bytes = Vec::new();
        const MAX_JSON: usize = 4 * 1024 * 1024;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| uncertain("response could not be read"))?
        {
            if chunk.len() > MAX_JSON.saturating_sub(bytes.len()) {
                return Err(uncertain("JSON response exceeds the Gateway limit"));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| uncertain("response is not JSON"))
    }
    fn payload(model: &str, body: &Value, video: bool) -> Result<Value, ProviderError> {
        if (video && model != "flux-3-video") || (!video && !IMAGE_MODELS.contains(&model)) {
            return Err(invalid("unsupported model for this operation"));
        }
        let prompt = body["prompt"]
            .as_str()
            .filter(|p| !p.trim().is_empty() && p.len() <= 128 * 1024)
            .ok_or_else(|| invalid("a nonempty prompt up to 128 KiB is required"))?;
        if body
            .get("n")
            .is_some_and(|n| !n.is_null() && n.as_u64() != Some(1))
        {
            return Err(invalid("submit one generation per request"));
        }
        if !video
            && body
                .get("response_format")
                .is_some_and(|f| !f.is_null() && f.as_str() != Some("url"))
        {
            return Err(invalid("BFL currently returns a signed URL"));
        }
        if body.get("webhook_url").is_some() || body.get("webhook_secret").is_some() {
            return Err(invalid(
                "webhooks are not supported by this polling adapter",
            ));
        }
        let mut payload = body
            .as_object()
            .cloned()
            .ok_or_else(|| invalid("generation request must be an object"))?;
        for key in ["model", "n", "response_format"] {
            payload.remove(key);
        }
        payload.insert("prompt".into(), prompt.into());
        if video {
            let mode = body.get("mode").and_then(Value::as_str).unwrap_or("t2v");
            if !matches!(mode, "t2v" | "text-to-video") {
                return Err(invalid("this video operation accepts text-to-video mode"));
            }
            payload.insert("mode".into(), "t2v".into());
        } else if let Some(size) = payload.remove("size").filter(|v| !v.is_null()) {
            let size = size
                .as_str()
                .ok_or_else(|| invalid("size must be WIDTHxHEIGHT"))?;
            let (width, height) = size
                .split_once('x')
                .ok_or_else(|| invalid("size must be WIDTHxHEIGHT"))?;
            let width: u32 = width.parse().map_err(|_| invalid("invalid width"))?;
            let height: u32 = height.parse().map_err(|_| invalid("invalid height"))?;
            if width < 64 || height < 64 || width > 8192 || height > 8192 {
                return Err(invalid("image dimensions must be between 64 and 8192"));
            }
            if payload
                .get("width")
                .is_some_and(|v| v.as_u64() != Some(u64::from(width)))
                || payload
                    .get("height")
                    .is_some_and(|v| v.as_u64() != Some(u64::from(height)))
            {
                return Err(invalid("size conflicts with width or height"));
            }
            payload.insert("width".into(), width.into());
            payload.insert("height".into(), height.into());
        }
        Ok(Value::Object(payload))
    }
    async fn submit(
        &self,
        model: &str,
        body: &Value,
        video: bool,
    ) -> Result<(String, reqwest::Client, String), ProviderError> {
        let payload = Self::payload(model, body, video)?;
        let url = format!("{}/{model}", self.base_url.trim_end_matches('/'));
        let session = uuid::Uuid::new_v4().to_string();
        let mut last = None;
        for index in self.accounts.candidates(None) {
            let (response, captured_client) = send_with_egress_captured(
                &self.client,
                self.egress.as_deref(),
                Some(&session),
                "bfl",
                0,
                |client| {
                    client
                        .post(&url)
                        .header("x-key", &self.keys[index])
                        .json(&payload)
                },
            )
            .await?;
            let status = response.status();
            let limits = parse_rate_limit(response.headers());
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = limits.as_ref().and_then(|l| l.retry_after);
                let reset_at = limits.as_ref().and_then(|l| l.reset_at);
                self.accounts.record_rate_limit(index, retry_after);
                last = Some(ProviderError::RateLimited {
                    provider: "bfl".into(),
                    retry_after,
                    reset_at,
                });
                continue;
            }
            if status == reqwest::StatusCode::PAYMENT_REQUIRED {
                self.accounts
                    .record_account_rejection(index, PAYMENT_REQUIRED_COOLDOWN);
                last = Some(ProviderError::PaymentRequired {
                    provider: "bfl".into(),
                    message: "BFL account credits are required".into(),
                });
                continue;
            }
            if !status.is_success() {
                return Err(crate::upstream_status_error(
                    status,
                    format!("BFL: submission returned HTTP {}", status.as_u16()),
                ));
            }
            let accepted = Self::read_json(response).await?;
            let id = accepted["id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 512)
                .ok_or_else(|| uncertain("submission has no task id"))?;
            let raw = accepted["polling_url"]
                .as_str()
                .ok_or_else(|| uncertain("submission has no polling URL"))?;
            let poll = self.valid_poll_url(raw, Some(id))?;
            if let Some(pool) = self.egress.as_ref() {
                pool.bind_job(&session, poll.as_str());
            }
            return Ok((
                self.account_ref(index, poll.as_str()),
                captured_client,
                self.keys[index].clone(),
            ));
        }
        if let Some(ProviderError::RateLimited {
            retry_after,
            reset_at,
            ..
        }) = &last
        {
            self.quota
                .record_rate_limited("bfl", *retry_after, *reset_at);
        }
        Err(last.unwrap_or_else(|| invalid("no eligible generation accounts")))
    }
    async fn poll(&self, reference: &str) -> Result<VideoJob, ProviderError> {
        self.poll_with_timeout(reference, self.poll_timeout.max(Duration::from_millis(1)))
            .await
    }
    async fn poll_with_timeout(
        &self,
        reference: &str,
        timeout: Duration,
    ) -> Result<VideoJob, ProviderError> {
        let (index, url) = self.resolve_ref(reference)?;
        let response = send_with_egress(
            &self.client,
            self.egress.as_deref(),
            Some(url.as_str()),
            "bfl",
            0,
            |client| {
                client
                    .get(url.clone())
                    .timeout(timeout)
                    .header("x-key", &self.keys[index])
            },
        )
        .await
        .map_err(|_| uncertain("poll transport failed"))?;
        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Ok(VideoJob {
                provider_ref: reference.into(),
                status: JobStatus::Running,
                output: None,
                error: None,
            });
        }
        if !response.status().is_success() {
            return Err(uncertain("poll request failed"));
        }
        parse_poll(response, reference).await
    }
    async fn generate(&self, model: &str, body: &Value) -> Result<Value, ProviderError> {
        let (reference, _, _) = self.submit(model, body, false).await?;
        let start = Instant::now();
        loop {
            if start.elapsed() >= self.poll_timeout {
                return Err(uncertain("generation wait timed out"));
            }
            let job = self
                .poll_with_timeout(
                    &reference,
                    self.poll_timeout.saturating_sub(start.elapsed()),
                )
                .await?;
            match job.status {
                JobStatus::Succeeded => {
                    return job
                        .output
                        .ok_or_else(|| uncertain("ready result has no output"))
                }
                JobStatus::Failed => return Err(uncertain("generation failed or was moderated")),
                _ => tokio::time::sleep(self.poll_interval.max(Duration::from_millis(1))).await,
            }
        }
    }
}

struct BflVideoOrigin {
    client: reqwest::Client,
    key: String,
    url: reqwest::Url,
    reference: String,
    timeout: Duration,
}
impl crate::VideoPollOrigin for BflVideoOrigin {
    fn poll(&self) -> crate::VideoPollFuture<'_> {
        Box::pin(async move {
            let response = crate::video_poll_response(
                self.client
                    .get(self.url.clone())
                    .timeout(self.timeout)
                    .header("x-key", &self.key),
            )
            .await?;
            parse_poll(response, &self.reference)
                .await
                .map_err(|_| crate::VideoPollError::InvalidResponse)
        })
    }
}
async fn parse_poll(
    response: reqwest::Response,
    reference: &str,
) -> Result<VideoJob, ProviderError> {
    let result = BflProvider::read_json(response).await?;
    let status = match result["status"].as_str() {
        Some("Pending") => JobStatus::Queued,
        Some("Reasoning" | "Generating") => JobStatus::Running,
        Some("Ready") => JobStatus::Succeeded,
        Some("Error" | "Failed" | "Task not found" | "Request Moderated" | "Content Moderated") => {
            JobStatus::Failed
        }
        _ => return Err(uncertain("unknown task status")),
    };
    let output = if status == JobStatus::Succeeded {
        let sample = result["result"]["sample"]
            .as_str()
            .ok_or_else(|| uncertain("ready result has no asset URL"))?;
        let asset = reqwest::Url::parse(sample).map_err(|_| uncertain("invalid asset URL"))?;
        if !matches!(asset.scheme(), "http" | "https")
            || asset.host_str().is_none()
            || !asset.username().is_empty()
            || asset.password().is_some()
        {
            return Err(uncertain("invalid asset URL"));
        }
        Some(json!({"data":[{"url":sample}]}))
    } else {
        None
    };
    Ok(VideoJob {
        provider_ref: reference.into(),
        status,
        output,
        error: if status == JobStatus::Failed {
            Some("BFL generation failed or was moderated".into())
        } else {
            None
        },
    })
}
impl Provider for BflProvider {
    fn name(&self) -> &'static str {
        "bfl"
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
            let mut models: Vec<_> = IMAGE_MODELS
                .iter()
                .map(|m| json!({"id":m,"object":"model","owned_by":"bfl","modality":"image"}))
                .collect();
            models.push(
                json!({"id":"flux-3-video","object":"model","owned_by":"bfl","modality":"video"}),
            );
            Some(models)
        })
    }
    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async { Err(invalid("this adapter generates images and video")) })
    }
    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        Box::pin(async { Err(invalid("chat streaming is unsupported")) })
    }
    fn generate_image<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(self.generate(model, body))
    }

    fn submit_video_bound<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<crate::AcceptedVideo, ProviderError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            let (reference, client, key) = self.submit(model, body, true).await?;
            let (_, url) = self.resolve_ref(&reference)?;
            Ok(crate::AcceptedVideo {
                initial: VideoJob {
                    provider_ref: reference.clone(),
                    status: JobStatus::Queued,
                    output: None,
                    error: None,
                },
                origin: Arc::new(BflVideoOrigin {
                    client,
                    key,
                    url,
                    reference,
                    timeout: self.poll_timeout.max(Duration::from_millis(1)),
                }),
            })
        })
    }
}

#[cfg(test)]
#[path = "bfl_test.rs"]
mod tests;
