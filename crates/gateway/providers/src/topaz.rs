//! Topaz Video Express enhancement from an externally hosted S3 source.
//! Topaz fetches the presigned source URL; Gateway never downloads the video.

use std::{collections::HashSet, pin::Pin, sync::Arc};

use axum::body::Body;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    account_pool::AccountPool, egress::send_with_egress_captured, error::PAYMENT_REQUIRED_COOLDOWN,
    parse_rate_limit, AcceptedVideo, EgressClientPool, JobStatus, Provider, ProviderError,
    ProviderQuotas, VideoJob,
};

const MAX_JSON: usize = 4 * 1024 * 1024;

pub struct TopazProvider {
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    keys: Vec<String>,
    accounts: AccountPool,
    base_url: String,
    quota: Arc<ProviderQuotas>,
}

fn invalid(message: &str) -> ProviderError {
    ProviderError::Provider(format!("Topaz: {message}"))
}

fn uncertain(message: &str) -> ProviderError {
    ProviderError::DeliveryUncertain(format!("Topaz video enhancement: {message}"))
}

fn safe_https_url(raw: &str) -> bool {
    raw.starts_with("https://") && crate::web::ValidatedPublicWebUrl::parse(raw).is_ok()
}

fn valid_model_id(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 64
        && model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn express_payload(model: &str, body: &Value) -> Result<Value, ProviderError> {
    let object = body
        .as_object()
        .ok_or_else(|| invalid("video enhancement request must be an object"))?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "source" | "filters" | "output" | "model"))
    {
        return Err(invalid("unsupported video enhancement field"));
    }
    if !valid_model_id(model) {
        return Err(invalid("invalid Topaz model"));
    }
    let source = body["source"]
        .as_object()
        .ok_or_else(|| invalid("source is required"))?;
    if source
        .keys()
        .any(|key| !matches!(key.as_str(), "container" | "external"))
    {
        return Err(invalid("source accepts container and external only"));
    }
    let container = source
        .get("container")
        .unwrap_or(&Value::Null)
        .as_str()
        .filter(|value| {
            matches!(
                *value,
                "3gp"
                    | "avi"
                    | "dv"
                    | "flv"
                    | "m1v"
                    | "m2t"
                    | "m2ts"
                    | "m2v"
                    | "m4v"
                    | "mkv"
                    | "mov"
                    | "mp4"
                    | "mpeg"
                    | "mpg"
                    | "mts"
                    | "mxf"
                    | "ser"
                    | "ts"
                    | "vob"
                    | "webm"
                    | "wmv"
            )
        })
        .ok_or_else(|| invalid("unsupported source container"))?;
    let external = source
        .get("external")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            invalid("source.external is required; local uploads use a separate Topaz flow")
        })?;
    if external.len() != 2 || external.get("provider").and_then(Value::as_str) != Some("s3") {
        return Err(invalid("source.external must be an S3 presigned URL"));
    }
    let source_url = external
        .get("presignedUrl")
        .unwrap_or(&Value::Null)
        .as_str()
        .filter(|url| safe_https_url(url))
        .ok_or_else(|| invalid("source.external.presignedUrl must be HTTPS"))?;
    let filters = body["filters"]
        .as_array()
        .filter(|filters| !filters.is_empty())
        .ok_or_else(|| invalid("at least one enhancement filter is required"))?;
    if filters[0]["model"].as_str() != Some(model) {
        return Err(invalid(
            "the first filter model must match the routed model",
        ));
    }
    let output = body["output"]
        .as_object()
        .ok_or_else(|| invalid("output is required"))?;
    let resolution = output
        .get("resolution")
        .unwrap_or(&Value::Null)
        .as_object()
        .ok_or_else(|| invalid("output.resolution is required"))?;
    if !["width", "height"].iter().all(|key| {
        resolution
            .get(*key)
            .unwrap_or(&Value::Null)
            .as_u64()
            .is_some_and(|dimension| (1..=8192).contains(&dimension))
    }) {
        return Err(invalid(
            "output resolution must have positive bounded dimensions",
        ));
    }
    Ok(json!({
        "source": {"container": container, "external": {"provider": "s3", "presignedUrl": source_url}},
        "filters": filters,
        "output": output,
    }))
}

async fn read_json(mut response: reqwest::Response) -> Result<Value, ProviderError> {
    let mut bytes = Vec::new();
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

fn job_from_status(value: &Value, reference: &str) -> Result<VideoJob, ProviderError> {
    let status = match value["status"].as_str() {
        Some("requested" | "accepted" | "initializing") => JobStatus::Queued,
        Some("preprocessing" | "processing" | "postprocessing" | "canceling") => JobStatus::Running,
        Some("complete") => JobStatus::Succeeded,
        Some("canceled" | "failed") => JobStatus::Failed,
        _ => return Err(uncertain("unknown enhancement status")),
    };
    let output = if status == JobStatus::Succeeded {
        let url = value["download"]["url"]
            .as_str()
            .filter(|url| safe_https_url(url))
            .ok_or_else(|| uncertain("completed enhancement has no valid download URL"))?;
        Some(json!({"data": [{"url": url}]}))
    } else {
        None
    };
    Ok(VideoJob {
        provider_ref: reference.to_owned(),
        status,
        output,
        error: (status == JobStatus::Failed)
            .then(|| "Topaz enhancement failed or was canceled".to_owned()),
    })
}

fn system_models(value: &Value) -> Option<Vec<Value>> {
    let raw = value.get("supportedModels")?.as_array()?;
    if raw.len() > 128 {
        return None;
    }
    let mut seen = HashSet::new();
    let mut models = Vec::with_capacity(raw.len());
    for entry in raw {
        let model = entry.as_str()?;
        if !valid_model_id(model) {
            return None;
        }
        if seen.insert(model) {
            models.push(json!({
                "id": model,
                "object": "model",
                "owned_by": "topaz",
                "modality": "video"
            }));
        }
    }
    Some(models)
}

impl TopazProvider {
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

    async fn submit(&self, model: &str, body: &Value) -> Result<AcceptedVideo, ProviderError> {
        let payload = express_payload(model, body)?;
        let url = format!("{}/video/express", self.base_url.trim_end_matches('/'));
        let session = uuid::Uuid::new_v4().to_string();
        let mut last = None;
        for index in self.accounts.candidates(None) {
            let (response, captured_client) = send_with_egress_captured(
                &self.client,
                self.egress.as_deref(),
                Some(&session),
                "topaz",
                0,
                |client| {
                    client
                        .post(&url)
                        .header("X-API-Key", &self.keys[index])
                        .json(&payload)
                },
            )
            .await?;
            let status = response.status();
            let limits = parse_rate_limit(response.headers());
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = limits.as_ref().and_then(|info| info.retry_after);
                self.accounts.record_rate_limit(index, retry_after);
                last = Some(ProviderError::RateLimited {
                    provider: "topaz".into(),
                    retry_after,
                    reset_at: limits.as_ref().and_then(|info| info.reset_at),
                });
                continue;
            }
            if status == reqwest::StatusCode::PAYMENT_REQUIRED {
                self.accounts
                    .record_account_rejection(index, PAYMENT_REQUIRED_COOLDOWN);
                last = Some(ProviderError::PaymentRequired {
                    provider: "topaz".into(),
                    message: "Topaz account credits are required".into(),
                });
                continue;
            }
            if status.is_server_error() || status == reqwest::StatusCode::REQUEST_TIMEOUT {
                return Err(uncertain(
                    "upstream submission failed without a definitive rejection",
                ));
            }
            if !status.is_success() {
                return Err(crate::upstream_status_error(
                    status,
                    format!("Topaz: submission returned HTTP {}", status.as_u16()),
                ));
            }
            let accepted = read_json(response).await?;
            let id = accepted["requestId"]
                .as_str()
                .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                .ok_or_else(|| uncertain("submission has no valid request ID"))?;
            if accepted.get("uploadUrls").is_some() || accepted.get("uploadId").is_some() {
                return Err(uncertain("Topaz unexpectedly requested a source upload"));
            }
            let reference = format!("tz1:{:x}:{id}", Sha256::digest(self.keys[index].as_bytes()));
            if let Some(pool) = &self.egress {
                pool.bind_job(&session, &reference);
            }
            self.accounts.record_success(None, index);
            if let Some(info) = limits.as_ref() {
                self.quota.record_success("topaz", info);
            }
            return Ok(AcceptedVideo {
                initial: VideoJob {
                    provider_ref: reference.clone(),
                    status: JobStatus::Queued,
                    output: None,
                    error: None,
                },
                origin: Arc::new(TopazVideoOrigin {
                    client: captured_client,
                    key: self.keys[index].clone(),
                    url: format!("{}/video/{id}/status", self.base_url.trim_end_matches('/')),
                    reference,
                }),
            });
        }
        Err(last.unwrap_or_else(|| invalid("no eligible video accounts")))
    }

    async fn live_models(&self) -> Option<Vec<Value>> {
        let url = format!("{}/video/status", self.base_url.trim_end_matches('/'));
        let (response, _) = send_with_egress_captured(
            &self.client,
            self.egress.as_deref(),
            None,
            "topaz",
            0,
            |client| client.get(&url),
        )
        .await
        .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let value = read_json(response).await.ok()?;
        system_models(&value)
    }
}

struct TopazVideoOrigin {
    client: reqwest::Client,
    key: String,
    url: String,
    reference: String,
}

impl crate::VideoPollOrigin for TopazVideoOrigin {
    fn poll(&self) -> crate::VideoPollFuture<'_> {
        Box::pin(async move {
            let response = crate::video_poll_response(
                self.client
                    .get(&self.url)
                    .header("X-API-Key", &self.key)
                    .timeout(std::time::Duration::from_secs(300)),
            )
            .await?;
            let value = read_json(response)
                .await
                .map_err(|_| crate::VideoPollError::InvalidResponse)?;
            job_from_status(&value, &self.reference)
                .map_err(|_| crate::VideoPollError::InvalidResponse)
        })
    }
}

impl Provider for TopazProvider {
    fn name(&self) -> &'static str {
        "topaz"
    }

    fn configure_account_policies(&self, policies: &[crate::ProviderAccountPolicy]) {
        self.accounts.configure(policies);
    }

    fn has_rotating_accounts(&self) -> bool {
        self.accounts.has_restrictions()
            || self.keys.len() > 1
            || self.egress.as_ref().is_some_and(|pool| pool.len() > 1)
    }

    fn discover_models<'a>(
        &'a self,
    ) -> Pin<Box<dyn std::future::Future<Output = Option<Vec<Value>>> + Send + 'a>> {
        Box::pin(self.live_models())
    }

    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async { Err(invalid("Topaz enhances an existing video")) })
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
    ) -> Pin<Box<dyn std::future::Future<Output = Result<AcceptedVideo, ProviderError>> + Send + 'a>>
    {
        Box::pin(self.submit(model, body))
    }
}

#[cfg(test)]
#[path = "topaz_test.rs"]
mod tests;
