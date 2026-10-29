//! Fal (https://fal.ai) provider — cloud image/video/audio generation.
//!
//! Fal is a **queued request** API: a submit `POST {base}/{model}` returns a
//! `request_id` plus `status_url` / `response_url`, and the caller polls the
//! status until `COMPLETED`, then fetches the response. Like Replicate this has
//! no synchronous endpoint, so:
//!
//!   - **image / TTS** (fast): [`generate_image`] / [`synthesize_speech`] submit
//!     and block-and-poll inline up to `poll_timeout_secs`, returning a
//!     normalized `{ "data": [{ "url": … }] }` body.
//!   - **video** (slow): [`crate::Provider::submit_video_bound`] submits and returns the job's
//!     `response_url` as its `provider_ref`; the client polls via [`crate::VideoPollOrigin::poll`].
//!
//! The job's `provider_ref` is the `response_url`; the status URL is
//! `{response_url}/status` (Fal's own convention), so one stored string is enough
//! to both poll status and fetch the result.
//!
//! `model` is the Fal model id (e.g. `fal-ai/flux/dev`) appended to `base_url`.
//! The submit body is the caller's body minus routing control fields, so the full
//! Fal input surface stays reachable without hardcoding a schema.

use crate::response_body::BoundedResponse;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tracing::debug;

use crate::error::ProviderError;
use crate::jobs::{JobStatus, VideoJob};

use super::{
    account_pool::AccountPool,
    egress::{send_with_egress, send_with_egress_captured},
    EgressClientPool, Provider,
};

pub struct FalProvider {
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    keys: Vec<String>,
    accounts: AccountPool,
    base_url: String,
    poll_interval: Duration,
    poll_timeout: Duration,
}

impl FalProvider {
    pub fn new(
        client: reqwest::Client,
        api_key: String,
        base_url: String,
        poll_interval_ms: u64,
        poll_timeout_secs: u64,
    ) -> Self {
        Self::new_with_egress(
            client,
            None,
            api_key,
            base_url,
            poll_interval_ms,
            poll_timeout_secs,
        )
    }

    pub fn new_with_egress(
        client: reqwest::Client,
        egress: Option<Arc<EgressClientPool>>,
        api_key: String,
        base_url: String,
        poll_interval_ms: u64,
        poll_timeout_secs: u64,
    ) -> Self {
        Self::new_with_accounts(
            client,
            egress,
            vec![api_key],
            base_url,
            poll_interval_ms,
            poll_timeout_secs,
        )
    }

    pub fn new_with_accounts(
        client: reqwest::Client,
        egress: Option<Arc<EgressClientPool>>,
        keys: Vec<String>,
        base_url: String,
        poll_interval_ms: u64,
        poll_timeout_secs: u64,
    ) -> Self {
        Self {
            client,
            egress,
            accounts: AccountPool::new(keys.len()),
            keys,
            base_url,
            poll_interval: Duration::from_millis(poll_interval_ms.max(250)),
            poll_timeout: Duration::from_secs(poll_timeout_secs.max(1)),
        }
    }

    fn validate_job_url(&self, raw: &str) -> Result<(), ProviderError> {
        let valid = reqwest::Url::parse(raw)
            .ok()
            .zip(reqwest::Url::parse(&self.base_url).ok())
            .is_some_and(|(url, base)| {
                url.origin() == base.origin()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
            });
        if valid {
            Ok(())
        } else {
            Err(ProviderError::DeliveryUncertain(
                "fal job reference is not on the configured queue origin".to_owned(),
            ))
        }
    }

    fn account_ref(&self, account: usize, url: &str) -> String {
        format!(
            "fl1:{:x}:{url}",
            Sha256::digest(self.keys[account].as_bytes())
        )
    }

    fn resolve_ref<'a>(&self, reference: &'a str) -> Result<(usize, &'a str), ProviderError> {
        let (account, url) = if let Some(value) = reference.strip_prefix("fl1:") {
            let (fingerprint, url) = value
                .split_once(':')
                .ok_or_else(|| ProviderError::Provider("invalid Fal job reference".to_owned()))?;
            let account = self
                .keys
                .iter()
                .position(|key| format!("{:x}", Sha256::digest(key.as_bytes())) == fingerprint)
                .ok_or_else(|| {
                    ProviderError::Provider("Fal job account is no longer configured".to_owned())
                })?;
            (account, url)
        } else {
            (0, reference)
        };
        self.validate_job_url(url)?;
        if self.keys.get(account).is_none() {
            return Err(ProviderError::Provider(
                "Fal has no configured job account".to_owned(),
            ));
        }
        Ok((account, url))
    }

    fn submit_url(&self, model: &str) -> String {
        format!(
            "{}/{}",
            self.base_url.trim_end_matches('/'),
            model.trim_start_matches('/')
        )
    }

    /// Submit a request and return `(response_url, status, metrics)`.
    /// `response_url` is the job's `provider_ref`; append `/status` for the
    /// status endpoint. `metrics` is fal's own timing envelope, `Null` when the
    /// response carries none (the normal case for a job that is still queued).
    async fn submit(
        &self,
        model: &str,
        body: &Value,
    ) -> Result<(String, JobStatus, Value, usize, reqwest::Client), ProviderError> {
        let input = build_input(body);
        let url = self.submit_url(model);
        debug!(provider = "fal", model, %url, "submitting request");
        let submission = format!("fal-submit:{}", uuid::Uuid::new_v4());
        let mut last = None;
        for account in self.accounts.candidates(None) {
            let (resp, captured_client) = send_with_egress_captured(
                &self.client,
                self.egress.as_deref(),
                Some(&submission),
                "fal",
                0,
                |client| {
                    client
                        .post(&url)
                        .header("Authorization", format!("Key {}", self.keys[account]))
                        .json(&input)
                },
            )
            .await?;
            if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let rate = super::parse_rate_limit(resp.headers());
                let retry_after = rate.as_ref().and_then(|rate| rate.retry_after);
                self.accounts.record_rate_limit(account, retry_after);
                last = Some(ProviderError::RateLimited {
                    provider: "fal".to_owned(),
                    retry_after,
                    reset_at: rate.as_ref().and_then(|rate| rate.reset_at),
                });
                continue;
            }
            if resp.status() == reqwest::StatusCode::PAYMENT_REQUIRED {
                self.accounts.record_rate_limit(account, Some(300));
                last = Some(ProviderError::PaymentRequired {
                    provider: "fal".to_owned(),
                    message: "Fal account credits are required".to_owned(),
                });
                continue;
            }
            let accepted = resp.status().is_success();
            let json = parse_json(resp, "fal submit").await.map_err(|error| {
                if accepted {
                    ProviderError::DeliveryUncertain(
                        "fal accepted the request but its queue response was unreadable".to_owned(),
                    )
                } else {
                    error
                }
            })?;

            let response_url = json["response_url"]
                .as_str()
                .map(str::to_owned)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    ProviderError::DeliveryUncertain(
                        "fal submit returned no response_url".to_string(),
                    )
                })?;
            self.validate_job_url(&response_url)?;
            if let Some(pool) = &self.egress {
                pool.bind_job(&submission, &response_url);
            }
            return Ok((
                self.account_ref(account, &response_url),
                fal_status(&json),
                json["metrics"].clone(),
                account,
                captured_client,
            ));
        }
        Err(last.unwrap_or_else(|| ProviderError::RateLimited {
            provider: "fal".to_owned(),
            retry_after: None,
            reset_at: None,
        }))
    }

    /// Fetch a job's current status via `{response_url}/status`, returning both
    /// the status and fal's `metrics` envelope.
    ///
    /// THE METRICS ARE ONLY HERE. fal reports `metrics.inference_time` on the
    /// STATUS response and not on the result body, so a poll loop that discards
    /// the status payload — which this one did, keeping only the enum — throws
    /// away the single number the debit can bill from. Every fal image and video
    /// call therefore fell back to the flat per-call rate, which is a nominal
    /// duration rather than a measured one. Returned alongside the status so the
    /// caller can hand it to `with_media_usage` when it fetches the result.
    async fn status(&self, response_url: &str) -> Result<(JobStatus, Value), ProviderError> {
        let (account, response_url) = self.resolve_ref(response_url)?;
        let url = format!("{}/status", response_url.trim_end_matches('/'));
        let resp = send_with_egress(
            &self.client,
            self.egress.as_deref(),
            Some(response_url),
            "fal",
            0,
            |client| {
                client
                    .get(&url)
                    .header("Authorization", format!("Key {}", self.keys[account]))
            },
        )
        .await?;
        let json = parse_json(resp, "fal status").await?;
        Ok((fal_status(&json), json["metrics"].clone()))
    }

    /// Fetch a completed job's result and normalize it.
    async fn result(&self, response_url: &str) -> Result<Value, ProviderError> {
        let (account, response_url) = self.resolve_ref(response_url)?;
        let resp = send_with_egress(
            &self.client,
            self.egress.as_deref(),
            Some(response_url),
            "fal",
            0,
            |client| {
                client
                    .get(response_url)
                    .header("Authorization", format!("Key {}", self.keys[account]))
            },
        )
        .await?;
        let json = parse_json(resp, "fal result").await?;
        Ok(super::normalize_media_output(&json))
    }

    /// Submit and block-and-poll to completion, returning the normalized output.
    async fn run_inline(&self, model: &str, body: &Value) -> Result<Value, ProviderError> {
        self.run_inline_captured(model, body)
            .await
            .map(|(response, _)| response)
    }

    async fn run_inline_captured(
        &self,
        model: &str,
        body: &Value,
    ) -> Result<(Value, reqwest::Client), ProviderError> {
        let (response_url, mut status, mut metrics, _, client) = self.submit(model, body).await?;
        let deadline = Instant::now() + self.poll_timeout;
        while !status.is_terminal() {
            if Instant::now() >= deadline {
                return Err(ProviderError::DeliveryUncertain(
                    "fal request timed out before completing".to_string(),
                ));
            }
            tokio::time::sleep(self.poll_interval).await;
            // Keep the LAST status payload's metrics: `inference_time` only
            // appears once the request is COMPLETED, so the terminal poll is the
            // one that carries it and every earlier one is `Null`.
            let (next_status, next_metrics) = self.status(&response_url).await.map_err(|_| {
                ProviderError::DeliveryUncertain(
                    "fal request was accepted but its status could not be retrieved".to_owned(),
                )
            })?;
            status = next_status;
            metrics = next_metrics;
        }
        if status == JobStatus::Failed {
            return Err(ProviderError::Provider("fal request failed".to_string()));
        }
        Ok((
            super::with_media_usage(
                self.result(&response_url).await.map_err(|_| {
                    ProviderError::DeliveryUncertain(
                        "fal request was accepted but its result could not be retrieved".to_owned(),
                    )
                })?,
                &metrics,
            ),
            client,
        ))
    }
}

struct FalVideoOrigin {
    client: reqwest::Client,
    key: String,
    url: String,
    reference: String,
}
impl FalVideoOrigin {
    async fn result(&self, metrics: &Value) -> Result<Value, crate::VideoPollError> {
        let response = crate::video_poll_response(
            self.client
                .get(&self.url)
                .timeout(std::time::Duration::from_secs(300))
                .header("Authorization", format!("Key {}", self.key)),
        )
        .await?;
        let value = crate::video_poll_json(response).await?;
        Ok(super::with_media_usage(
            super::normalize_media_output(&value),
            metrics,
        ))
    }
}
impl crate::VideoPollOrigin for FalVideoOrigin {
    fn poll(&self) -> crate::VideoPollFuture<'_> {
        Box::pin(async move {
            let response = crate::video_poll_response(
                self.client
                    .get(format!("{}/status", self.url.trim_end_matches('/')))
                    .timeout(std::time::Duration::from_secs(300))
                    .header("Authorization", format!("Key {}", self.key)),
            )
            .await?;
            let value = crate::video_poll_json(response).await?;
            if !matches!(
                value["status"].as_str(),
                Some("COMPLETED" | "OK" | "IN_PROGRESS" | "IN_QUEUE" | "ERROR" | "FAILED")
            ) {
                return Err(crate::VideoPollError::InvalidResponse);
            }
            let status = fal_status(&value);
            let output = if status == JobStatus::Succeeded {
                Some(self.result(&value["metrics"]).await?)
            } else {
                None
            };
            Ok(VideoJob {
                provider_ref: self.reference.clone(),
                status,
                output,
                error: (status == JobStatus::Failed).then(|| "Fal generation failed".to_owned()),
            })
        })
    }
}
impl Provider for FalProvider {
    fn configure_account_policies(&self, policies: &[crate::ProviderAccountPolicy]) {
        self.accounts.configure(policies);
    }

    fn name(&self) -> &'static str {
        "fal"
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
        Box::pin(async move {
            Err(ProviderError::Provider(
                "fal is a media provider; chat is not supported".to_string(),
            ))
        })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<dyn std::future::Future<Output = Result<axum::body::Body, ProviderError>> + Send + 'a>,
    > {
        Box::pin(async move {
            Err(ProviderError::Provider(
                "fal is a media provider; chat is not supported".to_string(),
            ))
        })
    }

    fn generate_image<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move { self.run_inline(model, body).await })
    }

    /// fal is job-based: `run_inline` normalizes to `{data:[{url}],raw}`, so
    /// this always hands back a HOSTED URL, never inline audio bytes. That is
    /// the URL arm of the audio envelope Core decodes — Core fetches the link
    /// itself rather than expecting `b64_json`.
    fn synthesize_speech<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move { self.run_inline(model, body).await })
    }

    fn synthesize_speech_bound<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        _session: Option<&'a str>,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<crate::BoundSpeech, ProviderError>> + Send + 'a,
        >,
    > {
        Box::pin(async move {
            let (response, client) = self.run_inline_captured(model, body).await?;
            Ok(crate::BoundSpeech::hosted(response, client, "fal"))
        })
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
        Box::pin(async move { self.submit_queued_media(model, body).await })
    }

    /// The queue takes any model id with a free-form input, so generated audio
    /// (music, sound effects) uses exactly the submission and polling path video
    /// does; only the model id and its input fields differ.
    fn submit_media_job_bound<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        _kind: crate::MediaJobKind,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<crate::AcceptedMediaJob, ProviderError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.submit_queued_media(model, body).await })
    }
}

impl FalProvider {
    /// Submit one queued media job (video or audio) and return its pollable handle.
    async fn submit_queued_media(
        &self,
        model: &str,
        body: &Value,
    ) -> Result<crate::AcceptedMediaJob, ProviderError> {
        let (reference, status, metrics, account, client) = self.submit(model, body).await?;
        let (_, url) = self.resolve_ref(&reference)?;
        let origin = Arc::new(FalVideoOrigin {
            client,
            key: self.keys[account].clone(),
            url: url.to_owned(),
            reference: reference.clone(),
        });
        // Acceptance is already known. An unavailable completed result must
        // leave a pollable handle rather than lose the accepted operation.
        let output = if status == JobStatus::Succeeded {
            origin.result(&metrics).await.ok()
        } else {
            None
        };
        let observed = if status == JobStatus::Succeeded && output.is_none() {
            JobStatus::Running
        } else {
            status
        };
        Ok(crate::AcceptedVideo {
            initial: VideoJob {
                provider_ref: reference,
                status: observed,
                output,
                error: (status == JobStatus::Failed).then(|| "Fal generation failed".to_owned()),
            },
            origin,
        })
    }
}

/// Build the Fal submit body: the caller's body minus routing control fields.
/// Fal takes the input object directly (no `input` wrapper), so an explicit
/// nested `input` is unwrapped if present.
fn build_input(body: &Value) -> Value {
    // An explicit nested `input` OBJECT is unwrapped verbatim. A non-object
    // `input` (e.g. the OpenAI TTS `input` text string) is NOT a Fal payload, so
    // fall through to the strip-control-fields branch rather than POSTing a bare
    // JSON scalar that Fal's queue endpoint would reject.
    if let Some(input) = body.get("input").filter(|v| v.is_object()) {
        return input.clone();
    }
    let mut map = body.as_object().cloned().unwrap_or_default();
    map.remove("model");
    map.remove("n");
    map.remove("provider");
    Value::Object(map)
}

/// Map a Fal status payload to a [`JobStatus`].
fn fal_status(json: &Value) -> JobStatus {
    match json["status"].as_str().unwrap_or("") {
        "COMPLETED" | "OK" => JobStatus::Succeeded,
        "IN_PROGRESS" => JobStatus::Running,
        "IN_QUEUE" => JobStatus::Queued,
        "ERROR" | "FAILED" => JobStatus::Failed,
        _ => JobStatus::Queued,
    }
}

/// Parse a Fal HTTP response, surfacing non-2xx bodies as errors.
///
/// A non-2xx reply is classified by its status, never by whether its body
/// parses: a 403 answered with an HTML error page, an empty body or plain text
/// is still this request's rejection, not a provider health fault.
async fn parse_json(resp: reqwest::Response, ctx: &str) -> Result<Value, ProviderError> {
    let status = resp.status();
    if status.is_success() {
        return resp
            .bounded_json()
            .await
            .map_err(|e| ProviderError::Provider(format!("{ctx} parse error: {e}")));
    }
    let body = resp.bounded_text().await.unwrap_or_default();
    let json: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    // Fal (FastAPI) validation errors return `detail` as an ARRAY of
    // `{loc, msg, type}` objects; a plain string covers other error shapes.
    let msg = json["detail"]
        .as_str()
        .or_else(|| json["detail"][0]["msg"].as_str())
        .or_else(|| json["error"].as_str())
        .or_else(|| json["message"].as_str())
        .unwrap_or("unknown error");
    Err(crate::upstream_status_error(
        status,
        format!("{ctx} error {status}: {msg}"),
    ))
}

#[cfg(test)]
impl FalProvider {
    fn submit_fixture<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<VideoJob, ProviderError>> + Send + 'a>>
    {
        Box::pin(async move {
            let (response_url, status, metrics, _, _) = self.submit(model, body).await?;
            // If Fal reports the job already COMPLETED at submit time, fetch the
            // result now so a subsequent terminal poll returns the media rather
            // than an empty envelope.
            let output = if status == JobStatus::Succeeded {
                Some(super::with_media_usage(
                    self.result(&response_url).await.map_err(|_| {
                        ProviderError::DeliveryUncertain(
                            "fal video completed but its result could not be retrieved".to_owned(),
                        )
                    })?,
                    &metrics,
                ))
            } else {
                None
            };
            Ok(VideoJob {
                provider_ref: response_url,
                status,
                output,
                error: None,
            })
        })
    }
    fn poll_reference_fixture<'a>(
        &'a self,
        provider_ref: &'a str,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<VideoJob, ProviderError>> + Send + 'a>>
    {
        Box::pin(async move {
            let (status, metrics) = self.status(provider_ref).await?;
            let (output, error) = match status {
                JobStatus::Succeeded => (
                    Some(super::with_media_usage(
                        self.result(provider_ref).await?,
                        &metrics,
                    )),
                    None,
                ),
                JobStatus::Failed => (None, Some("fal request failed".to_string())),
                _ => (None, None),
            };
            Ok(VideoJob {
                provider_ref: provider_ref.to_string(),
                status,
                output,
                error,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn captured_origin_reports_blockage_without_terminating_or_replaying() {
        let server = MockServer::start(vec![
            MockResponse::ok_json(
                r#"{"status":"IN_QUEUE","response_url":"http://origin.invalid/req/job1"}"#,
            ),
            MockResponse::json(401, r#"{"error":"origin-key raw upstream secret"}"#),
            MockResponse::json(407, "{}"),
            MockResponse::json(429, "{}").with_header("retry-after", "7"),
            MockResponse::json(503, "{}"),
            MockResponse::ok_json(r#"{"status":"unknown"}"#),
            MockResponse::ok_json(
                r#"{"status":"FAILED","error":"origin-key raw upstream secret"}"#,
            ),
        ])
        .await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(server.base_url()).unwrap())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let pool = Arc::new(EgressClientPool::new(vec![client]).unwrap());
        let provider = FalProvider::new_with_accounts(
            reqwest::Client::new(),
            Some(pool),
            vec!["origin-key".into()],
            "http://origin.invalid".into(),
            1,
            5,
        );
        let accepted = provider
            .submit_video_bound("fal-ai/video", &json!({"prompt":"video"}))
            .await
            .unwrap();
        for expected in [
            crate::VideoPollError::CredentialRejected,
            crate::VideoPollError::TransportUnavailable,
            crate::VideoPollError::RateLimited {
                retry_after: Some(7),
            },
            crate::VideoPollError::UpstreamUnavailable,
            crate::VideoPollError::InvalidResponse,
        ] {
            let error = accepted.origin.poll().await.unwrap_err();
            assert_eq!(error, expected);
            assert!(!error.to_string().contains("origin-key"));
            assert!(!format!("{error:?}").contains("raw upstream"));
        }
        let terminal = accepted.origin.poll().await.unwrap();
        assert_eq!(terminal.status, JobStatus::Failed);
        assert!(!terminal.error.unwrap().contains("origin-key"));
        let requests = server.requests();
        assert_eq!(requests.len(), 7);
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.method == "POST")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn captured_origin_survives_removal_endpoint_change_and_proxy_eviction() {
        let original = MockServer::start(vec![
            MockResponse::ok_json(
                r#"{"status":"IN_QUEUE","response_url":"http://origin.invalid/req/job1"}"#,
            ),
            MockResponse::ok_json(r#"{"status":"COMPLETED","metrics":{"inference_time":1.0}}"#),
            MockResponse::ok_json(r#"{"video":{"url":"https://assets.example/video.mp4"}}"#),
        ])
        .await;
        let replacement = MockServer::always(MockResponse::json(500, "{}")).await;
        let clients = [original.base_url(), replacement.base_url()]
            .into_iter()
            .map(|url| {
                reqwest::Client::builder()
                    .no_proxy()
                    .proxy(reqwest::Proxy::all(url).unwrap())
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(std::time::Duration::from_secs(5))
                    .build()
                    .unwrap()
            })
            .collect();
        let pool = Arc::new(EgressClientPool::new(clients).unwrap());
        let mut provider = FalProvider::new_with_accounts(
            reqwest::Client::new(),
            Some(pool.clone()),
            vec!["origin-key".into()],
            "http://origin.invalid".into(),
            1,
            5,
        );
        let accepted = provider
            .submit_video_bound("fal-ai/video", &json!({"prompt":"video"}))
            .await
            .unwrap();
        assert_eq!(accepted.initial.status, JobStatus::Queued);
        provider.keys.clear();
        provider.base_url = "http://replacement.invalid/v1".into();
        for index in 0..10_010 {
            pool.candidates(Some(&format!("eviction-{index}")));
        }
        pool.record_failure(0, Some(300));
        drop(provider);
        let observed = accepted.origin.poll().await.unwrap();
        assert_eq!(observed.status, JobStatus::Succeeded);
        assert!(observed.output.is_some());
        assert!(replacement.requests().is_empty());
        let requests = original.requests();
        assert_eq!(requests.len(), 3);
        for request in requests {
            assert_eq!(
                request.header("authorization").as_deref(),
                Some("Key origin-key")
            );
        }
    }

    use super::*;
    #[tokio::test]
    async fn fal_accounts_rotate_before_acceptance_and_job_refs_keep_the_original_key() {
        let server = MockServer::start(vec![
            MockResponse::json(429, "{}"),
            MockResponse::ok_json(r#"{"status":"IN_QUEUE","response_url":"{{BASE}}/req/job"}"#),
            MockResponse::ok_json(r#"{"status":"COMPLETED"}"#),
            MockResponse::ok_json(r#"{"images":[{"url":"https://example.com/result.png"}]}"#),
        ])
        .await;
        let provider = FalProvider::new_with_accounts(
            reqwest::Client::new(),
            None,
            vec!["first".to_owned(), "second".to_owned()],
            server.base_url().to_owned(),
            250,
            5,
        );
        let job = provider
            .submit_fixture("fal-ai/model", &serde_json::json!({"prompt":"cat"}))
            .await
            .unwrap();
        assert!(!job.provider_ref.contains("second"));
        let restarted = FalProvider::new_with_accounts(
            reqwest::Client::new(),
            None,
            vec!["second".to_owned(), "first".to_owned()],
            server.base_url().to_owned(),
            250,
            5,
        );
        let output = restarted
            .poll_reference_fixture(&job.provider_ref)
            .await
            .unwrap();
        assert_eq!(output.status, JobStatus::Succeeded);
        assert_eq!(output.provider_ref, job.provider_ref);
        let requests = server.requests();
        assert_eq!(requests.len(), 4);
        assert_eq!(
            requests[0].header("authorization").as_deref(),
            Some("Key first")
        );
        for request in &requests[1..] {
            assert_eq!(
                request.header("authorization").as_deref(),
                Some("Key second")
            );
        }
        let removed = FalProvider::new_with_accounts(
            reqwest::Client::new(),
            None,
            vec!["first".to_owned()],
            server.base_url().to_owned(),
            250,
            5,
        );
        assert!(removed
            .poll_reference_fixture(&job.provider_ref)
            .await
            .is_err());
        assert_eq!(server.requests().len(), 4);
    }

    #[tokio::test]
    async fn new_fal_jobs_round_robin_among_configured_keys() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"status":"IN_QUEUE","response_url":"{{BASE}}/req/job"}"#,
        ))
        .await;
        let provider = FalProvider::new_with_accounts(
            reqwest::Client::new(),
            None,
            vec!["first".to_owned(), "second".to_owned()],
            server.base_url().to_owned(),
            250,
            5,
        );
        for _ in 0..2 {
            provider
                .submit_fixture("fal-ai/model", &serde_json::json!({"prompt":"cat"}))
                .await
                .unwrap();
        }
        let requests = server.requests();
        assert_eq!(
            requests[0].header("authorization").as_deref(),
            Some("Key first")
        );
        assert_eq!(
            requests[1].header("authorization").as_deref(),
            Some("Key second")
        );
        assert!(provider.has_rotating_accounts());
    }

    #[tokio::test]
    async fn fal_submit_status_and_result_keep_the_same_proxy() {
        use crate::test_support::{MockResponse, MockServer};
        let replies = vec![
            MockResponse::ok_json(
                r#"{"status":"IN_QUEUE","response_url":"http://unreachable.invalid/req/one"}"#,
            ),
            MockResponse::ok_json(r#"{"status":"COMPLETED"}"#),
            MockResponse::ok_json(r#"{"images":[{"url":"https://example.com/result.png"}]}"#),
        ];
        let first = MockServer::start(replies).await;
        let backup = MockServer::always(MockResponse::json(500, "{}")).await;
        let clients = [first.base_url(), backup.base_url()]
            .into_iter()
            .map(|url| {
                reqwest::Client::builder()
                    .no_proxy()
                    .proxy(reqwest::Proxy::all(url).unwrap())
                    .build()
                    .unwrap()
            })
            .collect();
        let pool = Arc::new(EgressClientPool::new(clients).unwrap());
        let provider = FalProvider::new_with_egress(
            reqwest::Client::new(),
            Some(pool),
            "same-account".to_owned(),
            "http://unreachable.invalid".to_owned(),
            250,
            5,
        );
        let result = provider
            .generate_image("fal-ai/model", &serde_json::json!({"prompt":"cat"}))
            .await
            .unwrap();
        assert_eq!(result["data"][0]["url"], "https://example.com/result.png");
        let requests = first.requests();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].method, "POST");
        assert_eq!(requests[1].path, "/req/one/status");
        assert_eq!(requests[2].path, "/req/one");
        for request in requests {
            assert_eq!(
                request.header("authorization").as_deref(),
                Some("Key same-account")
            );
        }
        assert!(backup.requests().is_empty());
    }

    #[tokio::test]
    async fn accepted_fal_job_with_poll_failure_is_not_replayable() {
        use crate::test_support::{MockResponse, MockServer};
        let server = MockServer::start(vec![
            MockResponse::ok_json(r#"{"status":"IN_QUEUE","response_url":"{{BASE}}/req/one"}"#),
            MockResponse::json(503, "{}"),
        ])
        .await;
        let provider = FalProvider::new(
            reqwest::Client::new(),
            "key".to_owned(),
            server.base_url().to_owned(),
            250,
            5,
        );
        assert!(matches!(
            provider
                .generate_image("fal-ai/model", &serde_json::json!({"prompt":"cat"}))
                .await,
            Err(ProviderError::DeliveryUncertain(_))
        ));
        assert_eq!(
            server
                .requests()
                .iter()
                .filter(|request| request.method == "POST")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn foreign_job_reference_is_rejected_before_credentials_leave_the_queue_origin() {
        use crate::test_support::{MockResponse, MockServer};
        let foreign = MockServer::always(MockResponse::ok_json("{}")).await;
        let server = MockServer::always(MockResponse::ok_json(format!(
            r#"{{"status":"IN_QUEUE","response_url":"{}/stolen"}}"#,
            foreign.base_url()
        )))
        .await;
        let provider = FalProvider::new(
            reqwest::Client::new(),
            "key".to_owned(),
            server.base_url().to_owned(),
            250,
            5,
        );
        assert!(matches!(
            provider
                .generate_image("fal-ai/model", &serde_json::json!({"prompt":"cat"}))
                .await,
            Err(ProviderError::DeliveryUncertain(_))
        ));
        assert!(foreign.requests().is_empty());
    }

    #[tokio::test]
    async fn completed_video_result_failure_is_not_reported_as_empty_success() {
        let server = MockServer::start(vec![
            MockResponse::ok_json(r#"{"status":"COMPLETED","response_url":"{{BASE}}/req/one"}"#),
            MockResponse::json(503, "{}"),
        ])
        .await;
        let provider = FalProvider::new(
            reqwest::Client::new(),
            "key".to_owned(),
            server.base_url().to_owned(),
            250,
            5,
        );
        assert!(matches!(
            provider
                .submit_fixture("fal-ai/model", &serde_json::json!({"prompt":"cat"}))
                .await,
            Err(ProviderError::DeliveryUncertain(_))
        ));
    }
    use serde_json::json;

    #[test]
    fn submit_url_joins_model() {
        let p = FalProvider::new(
            reqwest::Client::new(),
            "k".into(),
            "https://queue.fal.run".into(),
            1000,
            60,
        );
        assert_eq!(
            p.submit_url("fal-ai/flux/dev"),
            "https://queue.fal.run/fal-ai/flux/dev"
        );
    }

    #[test]
    fn build_input_strips_control_fields() {
        let body = json!({ "model": "fal-ai/flux", "n": 1, "provider": "fal", "prompt": "cat" });
        assert_eq!(build_input(&body), json!({ "prompt": "cat" }));
    }

    #[test]
    fn build_input_ignores_non_object_input_string() {
        // OpenAI TTS `input` is a text string, not a Fal payload — it must stay in
        // the wrapped object rather than become the bare JSON body.
        let body = json!({ "model": "fal-ai/x", "input": "say hi", "voice": "alloy" });
        assert_eq!(
            build_input(&body),
            json!({ "input": "say hi", "voice": "alloy" })
        );
    }

    #[test]
    fn status_mapping() {
        assert_eq!(fal_status(&json!({"status":"IN_QUEUE"})), JobStatus::Queued);
        assert_eq!(
            fal_status(&json!({"status":"IN_PROGRESS"})),
            JobStatus::Running
        );
        assert_eq!(
            fal_status(&json!({"status":"COMPLETED"})),
            JobStatus::Succeeded
        );
        assert_eq!(fal_status(&json!({"status":"OK"})), JobStatus::Succeeded);
        assert_eq!(fal_status(&json!({"status":"ERROR"})), JobStatus::Failed);
        assert_eq!(fal_status(&json!({"status":"FAILED"})), JobStatus::Failed);
        // Unknown / missing → queued (keep polling).
        assert_eq!(fal_status(&json!({})), JobStatus::Queued);
    }

    #[test]
    fn submit_url_normalizes_slashes() {
        let p = FalProvider::new(
            reqwest::Client::new(),
            "k".into(),
            "https://queue.fal.run/".into(),
            250,
            60,
        );
        // Trailing base slash + leading model slash collapse to one.
        assert_eq!(p.submit_url("/fal-ai/x"), "https://queue.fal.run/fal-ai/x");
    }

    #[test]
    fn new_clamps_poll_bounds() {
        let p = FalProvider::new(reqwest::Client::new(), "k".into(), "u".into(), 0, 0);
        assert_eq!(p.poll_interval, Duration::from_millis(250));
        assert_eq!(p.poll_timeout, Duration::from_secs(1));
    }

    // ── async submit / poll paths over a local mock server ────────────────────
    use crate::test_support::{MockResponse, MockServer};

    fn provider(base_url: String) -> FalProvider {
        FalProvider::new(
            reqwest::Client::new(),
            "fal-secret".into(),
            base_url,
            250,
            60,
        )
    }

    #[tokio::test]
    async fn submit_video_sends_key_header_and_returns_response_url() {
        // Submit reports IN_QUEUE; provider_ref is the returned response_url.
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"request_id":"r1","status":"IN_QUEUE","response_url":"{{BASE}}/req/r1"}"#,
        ))
        .await;
        let p = provider(server.base_url().to_string());
        let job = p
            .submit_fixture("fal-ai/kling-video", &json!({ "prompt": "a wave" }))
            .await
            .unwrap();
        assert_eq!(job.status, JobStatus::Queued);
        assert_eq!(
            p.resolve_ref(&job.provider_ref).unwrap(),
            (0, format!("{}/req/r1", server.base_url()).as_str())
        );

        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/fal-ai/kling-video");
        // Fal auth is `Authorization: Key <token>`, not Bearer.
        assert_eq!(
            reqs[0].header("authorization").as_deref(),
            Some("Key fal-secret")
        );
        // Control fields stripped; input posted directly (no wrapper).
        assert_eq!(reqs[0].json()["prompt"], json!("a wave"));
    }

    #[tokio::test]
    async fn audio_job_forwards_provider_input_fields_and_normalizes_audio_output() {
        // Core merges an app's `provider_input` into the cloud body, so the
        // model-specific reference fields arrive as plain top-level keys. Fal
        // must post them unchanged, and an audio result must normalize into the
        // same `{ data: [{ url }] }` envelope a video result uses.
        let server = MockServer::start(vec![
            MockResponse::ok_json(
                r#"{"request_id":"a1","status":"COMPLETED","response_url":"{{BASE}}/req/a1"}"#,
            ),
            MockResponse::ok_json(
                r#"{"audio_file":{"url":"https://media.example.test/score.wav","content_type":"audio/wav"}}"#,
            ),
        ])
        .await;
        let p = provider(server.base_url().to_string());
        let body = json!({
            "model": "fal-ai/stable-audio",
            "provider": "fal",
            "n": 1,
            "prompt": "warm synth pad",
            "seconds_total": 12,
            "video_url": "https://media.example.test/source.mp4",
            "image_url": "data:image/png;base64,aGVsbG8=",
            "audio_url": "https://media.example.test/voice.wav"
        });
        let accepted = p
            .submit_media_job_bound("fal-ai/stable-audio", &body, crate::MediaJobKind::Audio)
            .await
            .unwrap();
        assert_eq!(accepted.initial.status, JobStatus::Succeeded);
        let output = accepted.initial.output.expect("completed audio output");
        assert_eq!(
            output["data"],
            json!([{ "url": "https://media.example.test/score.wav" }])
        );

        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/fal-ai/stable-audio");
        let sent = reqs[0].json();
        assert_eq!(
            sent["video_url"],
            json!("https://media.example.test/source.mp4")
        );
        assert_eq!(sent["image_url"], json!("data:image/png;base64,aGVsbG8="));
        assert_eq!(
            sent["audio_url"],
            json!("https://media.example.test/voice.wav")
        );
        assert_eq!(sent["seconds_total"], json!(12));
        for control in ["model", "provider", "n"] {
            assert!(sent.get(control).is_none(), "{control} must not reach Fal");
        }
    }

    #[tokio::test]
    async fn video_kind_through_the_media_job_entry_matches_submit_video() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"request_id":"v1","status":"IN_QUEUE","response_url":"{{BASE}}/req/v1"}"#,
        ))
        .await;
        let p = provider(server.base_url().to_string());
        let accepted = p
            .submit_media_job_bound(
                "fal-ai/wan-vace",
                &json!({"prompt":"restyle","video_url":"https://media.example.test/in.mp4"}),
                crate::MediaJobKind::Video,
            )
            .await
            .unwrap();
        assert_eq!(accepted.initial.status, JobStatus::Queued);
        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/fal-ai/wan-vace");
        assert_eq!(
            reqs[0].json()["video_url"],
            json!("https://media.example.test/in.mp4")
        );
    }

    #[tokio::test]
    async fn submit_errors_when_no_response_url() {
        let server = MockServer::always(MockResponse::ok_json(r#"{"status":"IN_QUEUE"}"#)).await;
        let p = provider(server.base_url().to_string());
        let err = p.submit_fixture("fal-ai/x", &json!({})).await.unwrap_err();
        assert!(err.to_string().contains("no response_url"), "{err}");
    }

    #[tokio::test]
    async fn generate_image_inline_completes_without_polling() {
        // First reply: submit already COMPLETED. Second reply: the result fetch.
        let server = MockServer::start(vec![
            MockResponse::ok_json(r#"{"status":"COMPLETED","response_url":"{{BASE}}/req/r2"}"#),
            MockResponse::ok_json(r#"{"images":[{"url":"https://x/i.png"}]}"#),
        ])
        .await;
        let p = provider(server.base_url().to_string());
        let out = p
            .generate_image("fal-ai/flux", &json!({ "prompt": "cat" }))
            .await
            .unwrap();
        assert_eq!(out["data"][0]["url"], json!("https://x/i.png"));
        // submit + result only; the terminal status skips the poll loop.
        assert_eq!(server.request_count(), 2);
        assert_eq!(server.requests()[1].path, "/req/r2");
    }

    #[tokio::test]
    async fn poll_video_succeeded_fetches_and_normalizes_result() {
        // status → COMPLETED, then result fetch.
        let server = MockServer::start(vec![
            MockResponse::ok_json(r#"{"status":"COMPLETED"}"#),
            MockResponse::ok_json(r#"{"video":{"url":"https://x/v.mp4"}}"#),
        ])
        .await;
        let p = provider(server.base_url().to_string());
        let ref_url = format!("{}/req/r3", server.base_url());
        let job = p.poll_reference_fixture(&ref_url).await.unwrap();
        assert_eq!(job.status, JobStatus::Succeeded);
        assert_eq!(
            job.output.unwrap()["data"][0]["url"],
            json!("https://x/v.mp4")
        );

        let reqs = server.requests();
        // Status is polled at `{response_url}/status`.
        assert_eq!(reqs[0].path, "/req/r3/status");
    }

    #[tokio::test]
    async fn poll_video_failed_reports_error_without_result_fetch() {
        let server = MockServer::always(MockResponse::ok_json(r#"{"status":"FAILED"}"#)).await;
        let p = provider(server.base_url().to_string());
        let ref_url = format!("{}/req/x", server.base_url());
        // status() hits the mock; FAILED → error, no result fetch.
        let job = p.poll_reference_fixture(&ref_url).await.unwrap();
        assert_eq!(job.status, JobStatus::Failed);
        assert_eq!(job.error.as_deref(), Some("fal request failed"));
    }

    #[tokio::test]
    async fn parse_json_maps_fastapi_detail_array() {
        // Fal (FastAPI) validation errors: `detail` is an array of {loc,msg,type}.
        let server = MockServer::always(MockResponse::json(
            422,
            r#"{"detail":[{"loc":["body","prompt"],"msg":"field required","type":"missing"}]}"#,
        ))
        .await;
        let p = provider(server.base_url().to_string());
        let err = p.submit_fixture("fal-ai/x", &json!({})).await.unwrap_err();
        assert!(err.to_string().contains("field required"), "{err}");
    }

    #[tokio::test]
    async fn chat_is_unsupported() {
        let p = provider("http://127.0.0.1:1".to_string());
        assert!(p
            .complete("m", &json!({}))
            .await
            .unwrap_err()
            .to_string()
            .contains("chat is not supported"));
    }
}
