//! Direct Runway video submission and account-qualified task polling.
use crate::{
    account_pool::AccountPool,
    egress::{send_with_egress, send_with_egress_captured},
    error::PAYMENT_REQUIRED_COOLDOWN,
    parse_rate_limit, EgressClientPool, JobStatus, Provider, ProviderError, ProviderQuotas,
    VideoJob,
};
use axum::body::Body;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{pin::Pin, sync::Arc};

pub struct RunwayProvider {
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    keys: Vec<String>,
    accounts: AccountPool,
    base_url: String,
    quota: Arc<ProviderQuotas>,
}
fn invalid(message: &str) -> ProviderError {
    ProviderError::Provider(format!("Runway: {message}"))
}
fn uncertain(message: &str) -> ProviderError {
    ProviderError::DeliveryUncertain(format!("Runway video submission: {message}"))
}
fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|uuid| {
        uuid.get_version_num() == 4 && uuid.hyphenated().to_string() == id.to_lowercase()
    })
}
impl RunwayProvider {
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
    fn image_uri(value: &Value) -> Result<(), ProviderError> {
        let raw = value
            .as_str()
            .ok_or_else(|| invalid("promptImage URI must be text"))?;
        if let Some(rest) = raw.strip_prefix("data:image/") {
            if raw.len() > 5 * 1024 * 1024 {
                return Err(invalid("image data URI exceeds 5 MiB"));
            }
            let (kind, encoded) = rest
                .split_once(";base64,")
                .ok_or_else(|| invalid("image data URI must use base64"))?;
            if !matches!(kind, "jpeg" | "png" | "webp")
                || base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .ok()
                    .filter(|bytes| !bytes.is_empty())
                    .is_none()
            {
                return Err(invalid("invalid image data URI"));
            }
            return Ok(());
        }
        if raw.starts_with("runway://")
            && (13..=5000).contains(&raw.len())
            && !raw.chars().any(char::is_control)
        {
            return Ok(());
        }
        let url = reqwest::Url::parse(raw).map_err(|_| invalid("invalid image URL"))?;
        if raw.len() > 2048
            || url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid(
                "image URL must be HTTPS without embedded credentials",
            ));
        }
        Ok(())
    }
    fn payload(model: &str, body: &Value) -> Result<(&'static str, Value), ProviderError> {
        if !matches!(model, "gen4.5" | "gen4_turbo") {
            return Err(invalid("unsupported video model"));
        }
        let mut payload = body
            .as_object()
            .cloned()
            .ok_or_else(|| invalid("video request must be an object"))?;
        if let Some(prompt) = payload.remove("prompt") {
            if payload.contains_key("promptText") {
                return Err(invalid("choose prompt or promptText"));
            }
            payload.insert("promptText".into(), prompt);
        }
        let image = payload.get("promptImage").filter(|v| !v.is_null());
        if let Some(image) = image {
            if let Some(images) = image.as_array() {
                if images.len() != 1 || images[0]["position"] != "first" {
                    return Err(invalid("this model accepts one first-frame image"));
                }
                Self::image_uri(&images[0]["uri"])?;
            } else {
                Self::image_uri(image)?;
            }
        }
        let image_mode = image.is_some();
        if !image_mode && model == "gen4_turbo" {
            return Err(invalid("gen4_turbo requires promptImage"));
        }
        let prompt = payload.get("promptText");
        if model == "gen4.5" || prompt.is_some() {
            if !prompt
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 1000)
            {
                return Err(invalid("prompt must contain 1 to 1000 UTF-16 code units"));
            }
        }
        if payload
            .get("n")
            .is_some_and(|v| !v.is_null() && v.as_u64() != Some(1))
        {
            return Err(invalid("submit one video per request"));
        }
        payload.remove("n");
        if let Some(size) = payload.remove("size").filter(|v| !v.is_null()) {
            if payload.contains_key("ratio") {
                return Err(invalid("choose size or ratio"));
            }
            payload.insert(
                "ratio".into(),
                size.as_str()
                    .ok_or_else(|| invalid("size must be text"))?
                    .replace('x', ":")
                    .into(),
            );
        }
        let ratios: &[&str] = if image_mode {
            &[
                "1280:720", "720:1280", "1104:832", "960:960", "832:1104", "1584:672",
            ]
        } else {
            &["1280:720", "720:1280"]
        };
        if !payload
            .get("ratio")
            .and_then(Value::as_str)
            .is_some_and(|r| ratios.contains(&r))
        {
            return Err(invalid(
                "ratio is required and must match a supported resolution",
            ));
        }
        if model == "gen4.5" || payload.contains_key("duration") {
            if !payload
                .get("duration")
                .and_then(Value::as_u64)
                .is_some_and(|n| (2..=10).contains(&n))
            {
                return Err(invalid("duration must be an integer from 2 to 10 seconds"));
            }
        }
        if payload
            .get("seed")
            .is_some_and(|v| !v.as_u64().is_some_and(|n| n <= u32::MAX as u64))
        {
            return Err(invalid("seed must be an unsigned 32-bit integer"));
        }
        payload.insert("model".into(), model.into());
        Ok((
            if image_mode {
                "image_to_video"
            } else {
                "text_to_video"
            },
            Value::Object(payload),
        ))
    }
    fn reference(&self, index: usize, id: &str) -> String {
        format!("rw1:{:x}:{id}", Sha256::digest(self.keys[index].as_bytes()))
    }
    fn resolve(&self, reference: &str) -> Result<(usize, String), ProviderError> {
        let (fingerprint, id) = reference
            .strip_prefix("rw1:")
            .and_then(|rest| rest.split_once(':'))
            .ok_or_else(|| invalid("invalid job reference"))?;
        if !valid_id(id) {
            return Err(invalid("invalid task id"));
        }
        let index = self
            .keys
            .iter()
            .position(|key| format!("{:x}", Sha256::digest(key.as_bytes())) == fingerprint)
            .ok_or_else(|| invalid("original job account is no longer configured"))?;
        Ok((
            index,
            format!("{}/tasks/{id}", self.base_url.trim_end_matches('/')),
        ))
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
                return Err(uncertain("response exceeds the Gateway limit"));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| uncertain("response is not JSON"))
    }
    async fn submit(
        &self,
        model: &str,
        body: &Value,
    ) -> Result<crate::AcceptedVideo, ProviderError> {
        let (operation, payload) = Self::payload(model, body)?;
        let url = format!("{}/{operation}", self.base_url.trim_end_matches('/'));
        let session = uuid::Uuid::new_v4().to_string();
        let mut last = None;
        for index in self.accounts.candidates(None) {
            let (response, captured_client) = send_with_egress_captured(
                &self.client,
                self.egress.as_deref(),
                Some(&session),
                "runway",
                0,
                |client| {
                    client
                        .post(&url)
                        .bearer_auth(&self.keys[index])
                        .header("X-Runway-Version", "2024-11-06")
                        .json(&payload)
                },
            )
            .await?;
            let status = response.status();
            let limits = parse_rate_limit(response.headers());
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = limits.as_ref().and_then(|l| l.retry_after);
                self.accounts.record_rate_limit(index, retry_after);
                last = Some(ProviderError::RateLimited {
                    provider: "runway".into(),
                    retry_after,
                    reset_at: limits.as_ref().and_then(|l| l.reset_at),
                });
                continue;
            }
            if status == reqwest::StatusCode::PAYMENT_REQUIRED {
                self.accounts
                    .record_account_rejection(index, PAYMENT_REQUIRED_COOLDOWN);
                last = Some(ProviderError::PaymentRequired {
                    provider: "runway".into(),
                    message: "Runway account credits are required".into(),
                });
                continue;
            }
            if status.is_server_error() || status == reqwest::StatusCode::REQUEST_TIMEOUT {
                return Err(uncertain(
                    "upstream execution failed without a definitive rejection",
                ));
            }
            if !status.is_success() {
                return Err(crate::upstream_status_error(
                    status,
                    format!("Runway: submission returned HTTP {}", status.as_u16()),
                ));
            }
            let accepted = Self::read_json(response).await?;
            let id = accepted["id"]
                .as_str()
                .filter(|id| valid_id(id))
                .ok_or_else(|| uncertain("submission has no valid task id"))?;
            let reference = self.reference(index, id);
            if let Some(pool) = &self.egress {
                pool.bind_job(&session, &reference);
            }
            self.accounts.record_success(None, index);
            if let Some(limits) = limits.as_ref() {
                self.quota.record_success("runway", limits);
            }
            return Ok(crate::AcceptedVideo {
                initial: VideoJob {
                    provider_ref: reference.clone(),
                    status: JobStatus::Queued,
                    output: None,
                    error: None,
                },
                origin: Arc::new(RunwayVideoOrigin {
                    client: captured_client,
                    key: self.keys[index].clone(),
                    url: self.resolve(&reference)?.1,
                    reference: reference.clone(),
                }),
            });
        }
        if let Some(ProviderError::RateLimited {
            retry_after,
            reset_at,
            ..
        }) = &last
        {
            self.quota
                .record_rate_limited("runway", *retry_after, *reset_at);
        }
        Err(last.unwrap_or_else(|| invalid("no eligible video accounts")))
    }
    async fn poll(&self, reference: &str) -> Result<VideoJob, ProviderError> {
        let (index, url) = self.resolve(reference)?;
        let response = send_with_egress(
            &self.client,
            self.egress.as_deref(),
            Some(reference),
            "runway",
            0,
            |client| {
                client
                    .get(&url)
                    .bearer_auth(&self.keys[index])
                    .header("X-Runway-Version", "2024-11-06")
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
}

struct RunwayVideoOrigin {
    client: reqwest::Client,
    key: String,
    url: String,
    reference: String,
}
impl crate::VideoPollOrigin for RunwayVideoOrigin {
    fn poll(&self) -> crate::VideoPollFuture<'_> {
        Box::pin(async move {
            let response = crate::video_poll_response(
                self.client
                    .get(&self.url)
                    .timeout(std::time::Duration::from_secs(300))
                    .bearer_auth(&self.key)
                    .header("X-Runway-Version", "2024-11-06"),
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
    let result = RunwayProvider::read_json(response).await?;
    let expected_id = reference
        .rsplit(':')
        .next()
        .ok_or_else(|| invalid("invalid job reference"))?;
    if result["id"].as_str() != Some(expected_id) {
        return Err(uncertain("poll returned a different task"));
    }
    let status = match result["status"].as_str() {
        Some("PENDING" | "THROTTLED") => JobStatus::Queued,
        Some("RUNNING") => JobStatus::Running,
        Some("SUCCEEDED") => JobStatus::Succeeded,
        Some("FAILED" | "CANCELLED") => JobStatus::Failed,
        _ => return Err(uncertain("unknown task status")),
    };
    let output = if status == JobStatus::Succeeded {
        let urls = result["output"]
            .as_array()
            .filter(|urls| !urls.is_empty())
            .ok_or_else(|| uncertain("successful task has no output"))?;
        let mut data = Vec::with_capacity(urls.len());
        for value in urls {
            let raw = value
                .as_str()
                .ok_or_else(|| uncertain("invalid output URL"))?;
            let url = reqwest::Url::parse(raw).map_err(|_| uncertain("invalid output URL"))?;
            if !matches!(url.scheme(), "https" | "http")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(uncertain("invalid output URL"));
            }
            data.push(json!({"url":raw}));
        }
        Some(json!({"data":data}))
    } else {
        None
    };
    Ok(VideoJob {
        provider_ref: reference.into(),
        status,
        output,
        error: if status == JobStatus::Failed {
            Some("Runway task failed or was cancelled".into())
        } else {
            None
        },
    })
}
impl Provider for RunwayProvider {
    fn name(&self) -> &'static str {
        "runway"
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
            Some(
                ["gen4.5", "gen4_turbo"]
                    .iter()
                    .map(
                        |m| json!({"id":m,"object":"model","owned_by":"runway","modality":"video"}),
                    )
                    .collect(),
            )
        })
    }
    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async { Err(invalid("this adapter generates video")) })
    }
    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        Box::pin(async { Err(invalid("chat streaming is unsupported")) })
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
        Box::pin(self.submit(model, body))
    }
}

#[cfg(test)]
#[path = "runway_test.rs"]
mod tests;
