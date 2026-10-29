//! Replicate (https://replicate.com) provider — cloud image/video generation.
//!
//! Replicate is an **async prediction** API: a request creates a prediction and
//! then the caller polls it until it reaches a terminal state and the `output`
//! (usually a URL or list of URLs) is available. There is no single synchronous
//! endpoint the way OpenAI's `/images/generations` is, so:
//!
//!   - **image / TTS** (fast): [`generate_image`] / [`synthesize_speech`] create
//!     the prediction and block-and-poll inline up to `poll_timeout_secs`,
//!     returning a normalized OpenAI-ish `{ "data": [{ "url": … }] }` body.
//!   - **video** (slow, minutes): [`crate::Provider::submit_video_bound`] creates the prediction and
//!     returns immediately with the prediction id as the job's `provider_ref`;
//!     the gateway stores the job and the client polls via [`crate::VideoPollOrigin::poll`].
//!
//! Model identification (`model`), matching the Replicate API's three forms:
//!   - `owner/name`            → `POST /models/{owner}/{name}/predictions`
//!   - `owner/name:<version>`  → `POST /predictions` with `{ version }`
//!   - `<version-hash>`        → `POST /predictions` with `{ version }`
//!
//! The prediction `input` is the caller's body (minus routing control fields),
//! or, if the caller nested an explicit `input` object, that verbatim — so the
//! full Replicate parameter surface stays reachable without hardcoding a schema.

use crate::response_body::BoundedResponse;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tracing::debug;

use crate::error::ProviderError;
use crate::jobs::{JobStatus, VideoJob};

use super::{
    account_pool::AccountPool,
    egress::{send_with_egress, send_with_egress_captured},
    EgressClientPool, Provider,
};

pub struct ReplicateProvider {
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    keys: Vec<String>,
    accounts: AccountPool,
    base_url: String,
    poll_interval: Duration,
    poll_timeout: Duration,
}

impl ReplicateProvider {
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

    fn base(&self) -> &str {
        self.base_url.trim_end_matches('/')
    }

    /// Create a prediction for `model` with `input`, returning the raw prediction
    /// JSON (`{ id, status, output, error, urls }`).
    async fn create_prediction(
        &self,
        model: &str,
        input: Value,
    ) -> Result<(Value, usize, reqwest::Client), ProviderError> {
        let (url, payload) = if let Some((_slug, version)) = model.split_once(':') {
            // owner/name:<version> — use the versioned predictions endpoint.
            (
                format!("{}/predictions", self.base()),
                json!({ "version": version, "input": input }),
            )
        } else if model.contains('/') {
            // owner/name — official-model predictions endpoint.
            (
                format!("{}/models/{}/predictions", self.base(), model),
                json!({ "input": input }),
            )
        } else {
            // bare version hash.
            (
                format!("{}/predictions", self.base()),
                json!({ "version": model, "input": input }),
            )
        };

        debug!(provider = "replicate", model, %url, "creating prediction");
        let submission = format!("replicate-submit:{}", uuid::Uuid::new_v4());
        let mut last = None;
        for account in self.accounts.candidates(None) {
            let (resp, captured_client) = send_with_egress_captured(
                &self.client,
                self.egress.as_deref(),
                Some(&submission),
                "replicate",
                0,
                |client| {
                    client
                        .post(&url)
                        .bearer_auth(&self.keys[account])
                        .json(&payload)
                },
            )
            .await?;
            if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let rate = super::parse_rate_limit(resp.headers());
                let retry_after = rate.as_ref().and_then(|rate| rate.retry_after);
                self.accounts.record_rate_limit(account, retry_after);
                last = Some(ProviderError::RateLimited {
                    provider: "replicate".to_owned(),
                    retry_after,
                    reset_at: rate.as_ref().and_then(|rate| rate.reset_at),
                });
                continue;
            }
            if resp.status() == reqwest::StatusCode::PAYMENT_REQUIRED {
                self.accounts.record_rate_limit(account, Some(300));
                last = Some(ProviderError::PaymentRequired {
                    provider: "replicate".to_owned(),
                    message: "Replicate account credits are required".to_owned(),
                });
                continue;
            }
            let accepted = resp.status().is_success();
            let prediction =
                match parse_prediction(resp, "replicate create")
                    .await
                    .map_err(|error| {
                        if accepted {
                            ProviderError::DeliveryUncertain(
                        "replicate accepted the request but its prediction response was unreadable"
                            .to_owned(),
                    )
                        } else {
                            error
                        }
                    }) {
                    Ok(value) => value,
                    Err(error @ ProviderError::RateLimited { .. }) => {
                        if let ProviderError::RateLimited { retry_after, .. } = &error {
                            self.accounts.record_rate_limit(account, *retry_after);
                        }
                        last = Some(error);
                        continue;
                    }
                    Err(error) => return Err(error),
                };
            if prediction["id"].as_str().is_none_or(str::is_empty) {
                return Err(ProviderError::DeliveryUncertain(
                    "replicate accepted the request but returned no prediction ID".to_owned(),
                ));
            }
            if let (Some(pool), Some(id)) = (&self.egress, prediction["id"].as_str()) {
                pool.bind_job(&submission, id);
            }
            self.accounts.record_success(None, account);
            return Ok((prediction, account, captured_client));
        }
        Err(last.unwrap_or_else(|| ProviderError::RateLimited {
            provider: "replicate".to_owned(),
            retry_after: None,
            reset_at: None,
        }))
    }

    fn account_ref(&self, account: usize, id: &str) -> String {
        format!(
            "rp1:{:x}:{id}",
            Sha256::digest(self.keys[account].as_bytes())
        )
    }

    fn resolve_ref<'a>(&self, reference: &'a str) -> Result<(usize, &'a str), ProviderError> {
        let (account, id) = if let Some(value) = reference.strip_prefix("rp1:") {
            let (fingerprint, id) = value.split_once(':').ok_or_else(|| {
                ProviderError::Provider("invalid Replicate job reference".to_owned())
            })?;
            let account = self
                .keys
                .iter()
                .position(|key| format!("{:x}", Sha256::digest(key.as_bytes())) == fingerprint)
                .ok_or_else(|| {
                    ProviderError::Provider(
                        "Replicate job account is no longer configured".to_owned(),
                    )
                })?;
            (account, id)
        } else {
            (0, reference)
        };
        if id.is_empty()
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            || self.keys.get(account).is_none()
        {
            return Err(ProviderError::Provider(
                "invalid Replicate prediction reference".to_owned(),
            ));
        }
        Ok((account, id))
    }

    /// Fetch a prediction's current state by id.
    async fn get_prediction(&self, reference: &str) -> Result<Value, ProviderError> {
        let (account, id) = self.resolve_ref(reference)?;
        let url = format!("{}/predictions/{}", self.base(), id);
        let resp = send_with_egress(
            &self.client,
            self.egress.as_deref(),
            Some(id),
            "replicate",
            0,
            |client| client.get(&url).bearer_auth(&self.keys[account]),
        )
        .await?;
        parse_prediction(resp, "replicate poll").await
    }

    /// Create a prediction and block-and-poll it to a terminal state, returning
    /// the normalized media output. Used for the fast (image/TTS) modalities.
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
        let input = build_input(body);
        let (prediction, account, client) = self.create_prediction(model, input).await?;
        let mut current = prediction;

        let deadline = Instant::now() + self.poll_timeout;
        loop {
            let status = replicate_status(&current);
            if status.is_terminal() {
                break;
            }
            if Instant::now() >= deadline {
                return Err(ProviderError::DeliveryUncertain(
                    "replicate prediction timed out before completing".to_string(),
                ));
            }
            tokio::time::sleep(self.poll_interval).await;
            let id = current["id"].as_str().unwrap_or_default().to_string();
            if id.is_empty() {
                return Err(ProviderError::Provider(
                    "replicate prediction has no id to poll".to_string(),
                ));
            }
            current = self
                .get_prediction(&self.account_ref(account, &id))
                .await
                .map_err(|_| {
                    ProviderError::DeliveryUncertain(
                        "replicate prediction was accepted but its result could not be retrieved"
                            .to_owned(),
                    )
                })?;
        }

        if replicate_status(&current) == JobStatus::Failed {
            let err = current["error"].as_str().unwrap_or("prediction failed");
            return Err(ProviderError::Provider(format!("replicate: {err}")));
        }
        Ok((
            super::with_media_usage(
                super::normalize_media_output(&current["output"]),
                &current["metrics"],
            ),
            client,
        ))
    }

    fn video_from_prediction(prediction: &Value) -> VideoJob {
        let status = replicate_status(prediction);
        let provider_ref = prediction["id"].as_str().unwrap_or_default().to_string();
        let (output, error) = match status {
            JobStatus::Succeeded => (
                Some(super::with_media_usage(
                    super::normalize_media_output(&prediction["output"]),
                    &prediction["metrics"],
                )),
                None,
            ),
            JobStatus::Failed => (None, Some("Replicate prediction failed".to_owned())),
            _ => (None, None),
        };
        VideoJob {
            provider_ref,
            status,
            output,
            error,
        }
    }
}

struct ReplicateVideoOrigin {
    client: reqwest::Client,
    key: String,
    url: String,
    id: String,
    reference: String,
}
impl crate::VideoPollOrigin for ReplicateVideoOrigin {
    fn poll(&self) -> crate::VideoPollFuture<'_> {
        Box::pin(async move {
            let response = crate::video_poll_response(
                self.client
                    .get(&self.url)
                    .timeout(std::time::Duration::from_secs(300))
                    .bearer_auth(&self.key),
            )
            .await?;
            let value = crate::video_poll_json(response).await?;
            if value["id"].as_str() != Some(self.id.as_str())
                || !matches!(
                    value["status"].as_str(),
                    Some("starting" | "processing" | "succeeded" | "failed" | "canceled")
                )
            {
                return Err(crate::VideoPollError::InvalidResponse);
            }
            let mut job = ReplicateProvider::video_from_prediction(&value);
            job.provider_ref = self.reference.clone();
            Ok(job)
        })
    }
}
impl Provider for ReplicateProvider {
    fn configure_account_policies(&self, policies: &[crate::ProviderAccountPolicy]) {
        self.accounts.configure(policies);
    }

    fn name(&self) -> &'static str {
        "replicate"
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
                "replicate is a media provider; chat is not supported".to_string(),
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
                "replicate is a media provider; chat is not supported".to_string(),
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

    /// replicate is job-based: `run_inline` normalizes to `{data:[{url}],raw}`,
    /// so this always hands back a HOSTED URL, never inline audio bytes. That is
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
            Ok(crate::BoundSpeech::hosted(response, client, "replicate"))
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

impl ReplicateProvider {
    /// Submit one queued media job (video or audio) and return its pollable handle.
    async fn submit_queued_media(
        &self,
        model: &str,
        body: &Value,
    ) -> Result<crate::AcceptedMediaJob, ProviderError> {
        let (prediction, account, client) =
            self.create_prediction(model, build_input(body)).await?;
        let mut initial = Self::video_from_prediction(&prediction);
        initial.provider_ref = self.account_ref(account, &initial.provider_ref);
        let (_, id) = self.resolve_ref(&initial.provider_ref)?;
        let origin = Arc::new(ReplicateVideoOrigin {
            client,
            key: self.keys[account].clone(),
            url: format!("{}/predictions/{id}", self.base()),
            id: id.to_owned(),
            reference: initial.provider_ref.clone(),
        });
        Ok(crate::AcceptedVideo { initial, origin })
    }
}

/// Build the Replicate `input` object from the caller's body: an explicit nested
/// `input` wins; otherwise the body minus routing control fields is the input.
fn build_input(body: &Value) -> Value {
    // An explicit nested `input` OBJECT is passed through verbatim (full schema
    // control). A non-object `input` (e.g. the OpenAI TTS `input` text string)
    // is NOT a Replicate input payload, so fall through to the strip-and-wrap
    // branch rather than sending a bare scalar Replicate would reject.
    if let Some(input) = body.get("input").filter(|v| v.is_object()) {
        return input.clone();
    }
    let mut map = body.as_object().cloned().unwrap_or_default();
    map.remove("model");
    map.remove("n");
    map.remove("provider");
    Value::Object(map)
}

/// Map a Replicate prediction `status` string to a [`JobStatus`].
fn replicate_status(prediction: &Value) -> JobStatus {
    match prediction["status"].as_str().unwrap_or("") {
        "succeeded" => JobStatus::Succeeded,
        "failed" | "canceled" => JobStatus::Failed,
        "processing" => JobStatus::Running,
        // "starting" and anything unknown → treat as queued (keep polling).
        _ => JobStatus::Queued,
    }
}

/// Parse a prediction HTTP response, surfacing non-2xx bodies as errors.
///
/// A non-2xx reply is classified by its status, never by whether its body
/// parses: a 403 answered with an HTML error page, an empty body or plain text
/// is still this request's rejection, not a provider health fault.
async fn parse_prediction(resp: reqwest::Response, ctx: &str) -> Result<Value, ProviderError> {
    let status = resp.status();
    if status.is_success() {
        return resp
            .bounded_json()
            .await
            .map_err(|e| ProviderError::Provider(format!("{ctx} parse error: {e}")));
    }
    let body = resp.bounded_text().await.unwrap_or_default();
    let json: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let msg = json["detail"]
        .as_str()
        .or_else(|| json["error"].as_str())
        .unwrap_or("unknown error");
    Err(crate::upstream_status_error(
        status,
        format!("{ctx} error {status}: {msg}"),
    ))
}

#[cfg(test)]
impl ReplicateProvider {
    fn submit_fixture<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<VideoJob, ProviderError>> + Send + 'a>>
    {
        Box::pin(async move {
            let input = build_input(body);
            let (prediction, account, _) = self.create_prediction(model, input).await?;
            let mut job = Self::video_from_prediction(&prediction);
            if job.provider_ref.is_empty() {
                return Err(ProviderError::Provider(
                    "replicate submit returned no prediction id".to_string(),
                ));
            }
            job.provider_ref = self.account_ref(account, &job.provider_ref);
            Ok(job)
        })
    }
    fn poll_reference_fixture<'a>(
        &'a self,
        provider_ref: &'a str,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<VideoJob, ProviderError>> + Send + 'a>>
    {
        Box::pin(async move {
            let prediction = self.get_prediction(provider_ref).await?;
            let mut job = Self::video_from_prediction(&prediction);
            job.provider_ref = provider_ref.to_owned();
            Ok(job)
        })
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn captured_origin_reports_blockage_without_terminating_or_replaying() {
        let server = MockServer::start(vec![
            MockResponse::ok_json(r#"{"id":"job1","status":"starting"}"#),
            MockResponse::json(401, r#"{"error":"origin-key raw upstream secret"}"#),
            MockResponse::json(407, "{}"),
            MockResponse::json(429, "{}").with_header("retry-after", "7"),
            MockResponse::json(503, "{}"),
            MockResponse::ok_json(r#"{"status":"unknown"}"#),
            MockResponse::ok_json(
                r#"{"id":"job1","status":"failed","error":"origin-key raw upstream secret"}"#,
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
        let provider = ReplicateProvider::new_with_accounts(
            reqwest::Client::new(),
            Some(pool),
            vec!["origin-key".into()],
            "http://origin.invalid/v1".into(),
            1,
            5,
        );
        let accepted = provider
            .submit_video_bound("owner/video", &json!({"prompt":"video"}))
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
            MockResponse::ok_json(r#"{"id":"job1","status":"starting"}"#),
            MockResponse::ok_json(
                r#"{"id":"job1","status":"succeeded","output":"https://assets.example/video.mp4"}"#,
            ),
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
        let mut provider = ReplicateProvider::new_with_accounts(
            reqwest::Client::new(),
            Some(pool.clone()),
            vec!["origin-key".into()],
            "http://origin.invalid/v1".into(),
            1,
            5,
        );
        let accepted = provider
            .submit_video_bound("owner/video", &json!({"prompt":"video"}))
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
        assert_eq!(requests.len(), 2);
        for request in requests {
            assert_eq!(
                request.header("authorization").as_deref(),
                Some("Bearer origin-key")
            );
        }
    }

    use super::*;
    #[tokio::test]
    async fn rejected_account_rotates_and_video_ref_survives_key_reordering() {
        use crate::test_support::{MockResponse, MockServer};
        let server=MockServer::start(vec![MockResponse::json(429,"{}").with_header("retry-after","60"),MockResponse::json(201,r#"{"id":"accepted-job","status":"starting"}"#),MockResponse::ok_json(r#"{"id":"accepted-job","status":"succeeded","output":"https://example.com/video.mp4"}"#)]).await;
        let provider = ReplicateProvider::new_with_accounts(
            reqwest::Client::new(),
            None,
            vec!["first-account".to_owned(), "second-account".to_owned()],
            server.base_url().to_owned(),
            250,
            5,
        );
        let job = provider
            .submit_fixture("owner/model", &json!({"prompt":"cat"}))
            .await
            .unwrap();
        assert!(provider.has_rotating_accounts());
        assert!(!job.provider_ref.contains("second-account"));
        let restarted = ReplicateProvider::new_with_accounts(
            reqwest::Client::new(),
            None,
            vec!["second-account".to_owned(), "first-account".to_owned()],
            server.base_url().to_owned(),
            250,
            5,
        );
        let finished = restarted
            .poll_reference_fixture(&job.provider_ref)
            .await
            .unwrap();
        assert_eq!(finished.provider_ref, job.provider_ref);
        assert_eq!(finished.status, JobStatus::Succeeded);
        let requests = server.requests();
        assert_eq!(requests.len(), 3);
        assert_eq!(
            requests[0].header("authorization").as_deref(),
            Some("Bearer first-account")
        );
        assert_eq!(
            requests[1].header("authorization").as_deref(),
            Some("Bearer second-account")
        );
        assert_eq!(
            requests[2].header("authorization").as_deref(),
            Some("Bearer second-account")
        );
        let removed = ReplicateProvider::new_with_accounts(
            reqwest::Client::new(),
            None,
            vec!["first-account".to_owned()],
            server.base_url().to_owned(),
            250,
            5,
        );
        assert!(removed
            .poll_reference_fixture(&job.provider_ref)
            .await
            .is_err());
        assert_eq!(server.requests().len(), 3);
    }

    #[tokio::test]
    async fn separate_inline_predictions_rotate_accounts_and_keep_their_poll_key() {
        use crate::test_support::{MockResponse, MockServer};
        let server = MockServer::start(vec![
            MockResponse::ok_json(r#"{"id":"one","status":"processing"}"#),
            MockResponse::ok_json(
                r#"{"id":"one","status":"succeeded","output":"https://example.com/one.png"}"#,
            ),
            MockResponse::ok_json(r#"{"id":"two","status":"processing"}"#),
            MockResponse::ok_json(
                r#"{"id":"two","status":"succeeded","output":"https://example.com/two.png"}"#,
            ),
        ])
        .await;
        let provider = ReplicateProvider::new_with_accounts(
            reqwest::Client::new(),
            None,
            vec!["first".to_owned(), "second".to_owned()],
            server.base_url().to_owned(),
            250,
            5,
        );
        for _ in 0..2 {
            provider
                .generate_image("owner/model", &json!({"prompt":"cat"}))
                .await
                .unwrap();
        }
        for (request, key) in server
            .requests()
            .iter()
            .zip(["first", "first", "second", "second"])
        {
            assert_eq!(
                request.header("authorization"),
                Some(format!("Bearer {key}"))
            );
        }
    }

    #[tokio::test]
    async fn predictions_keep_their_submit_proxy_through_polling() {
        use crate::test_support::{MockResponse, MockServer};
        let first=MockServer::start(vec![MockResponse::ok_json(r#"{"id":"first-job","status":"processing"}"#),MockResponse::ok_json(r#"{"id":"first-job","status":"succeeded","output":"https://example.com/first.png"}"#)]).await;
        let second=MockServer::start(vec![MockResponse::ok_json(r#"{"id":"second-job","status":"processing"}"#),MockResponse::ok_json(r#"{"id":"second-job","status":"succeeded","output":"https://example.com/second.png"}"#)]).await;
        let clients = [first.base_url(), second.base_url()]
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
        let provider = ReplicateProvider::new_with_egress(
            reqwest::Client::new(),
            Some(pool),
            "account-key".to_owned(),
            "http://unreachable.invalid/v1".to_owned(),
            250,
            5,
        );
        for output in ["first", "second"] {
            let result = provider
                .generate_image("owner/model", &json!({"prompt":"cat"}))
                .await
                .unwrap();
            assert_eq!(
                result["data"][0]["url"],
                format!("https://example.com/{output}.png")
            );
        }
        for (server, id) in [(&first, "first-job"), (&second, "second-job")] {
            let requests = server.requests();
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[0].method, "POST");
            assert_eq!(requests[1].method, "GET");
            assert_eq!(requests[1].path, format!("/v1/predictions/{id}"));
            for request in requests {
                assert_eq!(
                    request.header("authorization").as_deref(),
                    Some("Bearer account-key")
                );
            }
        }
    }

    #[tokio::test]
    async fn accepted_prediction_poll_failure_cannot_trigger_resubmission() {
        use crate::test_support::{MockResponse, MockServer};
        let server = MockServer::start(vec![
            MockResponse::ok_json(r#"{"id":"accepted-job","status":"processing"}"#),
            MockResponse::json(503, "{}"),
        ])
        .await;
        let provider = ReplicateProvider::new(
            reqwest::Client::new(),
            "account-key".to_owned(),
            server.base_url().to_owned(),
            250,
            5,
        );
        let error = provider
            .generate_image("owner/model", &json!({"prompt":"cat"}))
            .await
            .unwrap_err();
        assert!(matches!(error, ProviderError::DeliveryUncertain(_)));
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
    async fn unusable_successful_submission_response_is_not_replayable() {
        use crate::test_support::{MockResponse, MockServer};
        for body in ["not-json", r#"{"status":"processing"}"#] {
            let server = MockServer::always(MockResponse::ok_json(body)).await;
            let provider = ReplicateProvider::new(
                reqwest::Client::new(),
                "account-key".to_owned(),
                server.base_url().to_owned(),
                250,
                5,
            );
            assert!(matches!(
                provider
                    .generate_image("owner/model", &json!({"prompt":"cat"}))
                    .await,
                Err(ProviderError::DeliveryUncertain(_))
            ));
            assert_eq!(server.requests().len(), 1);
        }
    }

    #[test]
    fn build_input_respects_explicit_input() {
        let body = json!({ "model": "x", "input": { "prompt": "cat" } });
        assert_eq!(build_input(&body), json!({ "prompt": "cat" }));
    }

    #[test]
    fn build_input_wraps_body_minus_control_fields() {
        let body =
            json!({ "model": "x", "n": 2, "provider": "replicate", "prompt": "cat", "seed": 7 });
        assert_eq!(build_input(&body), json!({ "prompt": "cat", "seed": 7 }));
    }

    #[test]
    fn build_input_ignores_non_object_input_string() {
        // OpenAI TTS body: `input` is a text string, NOT a Replicate payload —
        // it must fall through to the strip-and-wrap branch, not be returned bare.
        let body = json!({ "model": "x", "input": "say hello", "voice": "alloy" });
        assert_eq!(
            build_input(&body),
            json!({ "input": "say hello", "voice": "alloy" })
        );
    }

    #[test]
    fn status_mapping() {
        assert_eq!(
            replicate_status(&json!({"status":"starting"})),
            JobStatus::Queued
        );
        assert_eq!(
            replicate_status(&json!({"status":"processing"})),
            JobStatus::Running
        );
        assert_eq!(
            replicate_status(&json!({"status":"succeeded"})),
            JobStatus::Succeeded
        );
        assert_eq!(
            replicate_status(&json!({"status":"failed"})),
            JobStatus::Failed
        );
        assert_eq!(
            replicate_status(&json!({"status":"canceled"})),
            JobStatus::Failed
        );
        // Unknown / starting → queued (keep polling).
        assert_eq!(replicate_status(&json!({})), JobStatus::Queued);
    }

    #[test]
    fn video_from_prediction_succeeded_normalizes_output() {
        let pred = json!({
            "id": "pred_1",
            "status": "succeeded",
            "output": "https://x/v.mp4"
        });
        let job = ReplicateProvider::video_from_prediction(&pred);
        assert_eq!(job.provider_ref, "pred_1");
        assert_eq!(job.status, JobStatus::Succeeded);
        assert_eq!(
            job.output.unwrap()["data"][0]["url"],
            json!("https://x/v.mp4")
        );
        assert!(job.error.is_none());
    }

    #[test]
    fn video_from_prediction_failed_carries_error() {
        let pred = json!({ "id": "p", "status": "failed", "error": "OOM" });
        let job = ReplicateProvider::video_from_prediction(&pred);
        assert_eq!(job.status, JobStatus::Failed);
        assert_eq!(job.error.as_deref(), Some("Replicate prediction failed"));
        assert!(job.output.is_none());
    }

    #[test]
    fn video_from_prediction_running_has_no_output_or_error() {
        let pred = json!({ "id": "p", "status": "processing" });
        let job = ReplicateProvider::video_from_prediction(&pred);
        assert_eq!(job.status, JobStatus::Running);
        assert!(job.output.is_none());
        assert!(job.error.is_none());
    }

    #[test]
    fn base_trims_trailing_slash() {
        let p = ReplicateProvider::new(
            reqwest::Client::new(),
            "k".into(),
            "https://api.replicate.com/v1/".into(),
            250,
            60,
        );
        assert_eq!(p.base(), "https://api.replicate.com/v1");
    }

    #[test]
    fn new_clamps_poll_interval_and_timeout_to_minimums() {
        let p = ReplicateProvider::new(reqwest::Client::new(), "k".into(), "u".into(), 0, 0);
        assert_eq!(p.poll_interval, Duration::from_millis(250));
        assert_eq!(p.poll_timeout, Duration::from_secs(1));
    }

    // ── async prediction paths over a local mock server ───────────────────────
    use crate::test_support::{MockResponse, MockServer};

    fn provider(base_url: String) -> ReplicateProvider {
        ReplicateProvider::new(
            reqwest::Client::new(),
            "r8-secret".into(),
            base_url,
            250,
            60,
        )
    }

    #[tokio::test]
    async fn submit_video_owner_name_uses_models_predictions_endpoint() {
        let server = MockServer::always(MockResponse::json(
            201,
            r#"{"id":"pred_9","status":"starting"}"#,
        ))
        .await;
        let p = provider(server.base_url().to_string());
        let job = p
            .submit_fixture("stability-ai/sdxl", &json!({ "prompt": "a dog" }))
            .await
            .unwrap();
        assert_eq!(p.resolve_ref(&job.provider_ref).unwrap(), (0, "pred_9"));
        assert_eq!(job.status, JobStatus::Queued);

        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/models/stability-ai/sdxl/predictions");
        assert_eq!(
            reqs[0].header("authorization").as_deref(),
            Some("Bearer r8-secret")
        );
        // The body is `{ input: <stripped body> }` — no `version` for official models.
        assert_eq!(reqs[0].json()["input"]["prompt"], json!("a dog"));
        assert!(reqs[0].json().get("version").is_none());
    }

    #[tokio::test]
    async fn audio_job_forwards_provider_input_fields_and_normalizes_audio_output() {
        // A Replicate audio model (for example a MusicGen deployment) takes its
        // reference media as model-specific input fields. They arrive merged
        // into the body and must reach `input` unchanged; the terminal output
        // (a bare URL string) normalizes to the shared media envelope.
        let server = MockServer::start(vec![
            MockResponse::json(201, r#"{"id":"pred_audio","status":"starting"}"#),
            MockResponse::ok_json(
                r#"{"id":"pred_audio","status":"succeeded","output":"https://media.example.test/music.mp3","metrics":{"predict_time":4.5}}"#,
            ),
        ])
        .await;
        let p = provider(server.base_url().to_string());
        let body = json!({
            "model": "meta/musicgen",
            "provider": "replicate",
            "prompt": "upbeat drums",
            "duration": 8,
            "audio_url": "https://media.example.test/melody.wav",
            "image_url": "https://media.example.test/cover.png",
            "video_url": "https://media.example.test/clip.mp4"
        });
        let accepted = p
            .submit_media_job_bound("meta/musicgen", &body, crate::MediaJobKind::Audio)
            .await
            .unwrap();
        assert_eq!(accepted.initial.status, JobStatus::Queued);
        let polled = accepted.origin.poll().await.unwrap();
        assert_eq!(polled.status, JobStatus::Succeeded);
        let output = polled.output.expect("succeeded audio output");
        assert_eq!(
            output["data"],
            json!([{ "url": "https://media.example.test/music.mp3" }])
        );
        assert_eq!(output["usage"]["compute_seconds"], json!(4.5));

        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/models/meta/musicgen/predictions");
        let input = &reqs[0].json()["input"];
        assert_eq!(
            input["audio_url"],
            json!("https://media.example.test/melody.wav")
        );
        assert_eq!(
            input["image_url"],
            json!("https://media.example.test/cover.png")
        );
        assert_eq!(
            input["video_url"],
            json!("https://media.example.test/clip.mp4")
        );
        assert_eq!(input["duration"], json!(8));
        for control in ["model", "provider", "n"] {
            assert!(
                input.get(control).is_none(),
                "{control} must not reach Replicate"
            );
        }
    }

    #[tokio::test]
    async fn submit_video_versioned_model_uses_predictions_with_version() {
        let server =
            MockServer::always(MockResponse::json(201, r#"{"id":"p","status":"starting"}"#)).await;
        let p = provider(server.base_url().to_string());
        p.submit_fixture("owner/name:abc123", &json!({ "prompt": "x" }))
            .await
            .unwrap();
        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/predictions");
        assert_eq!(reqs[0].json()["version"], json!("abc123"));
    }

    #[tokio::test]
    async fn submit_video_bare_hash_uses_predictions_with_version() {
        let server =
            MockServer::always(MockResponse::json(201, r#"{"id":"p","status":"starting"}"#)).await;
        let p = provider(server.base_url().to_string());
        p.submit_fixture("deadbeefhash", &json!({ "prompt": "x" }))
            .await
            .unwrap();
        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/predictions");
        assert_eq!(reqs[0].json()["version"], json!("deadbeefhash"));
    }

    #[tokio::test]
    async fn submit_video_errors_when_no_prediction_id() {
        let server = MockServer::always(MockResponse::json(201, r#"{"status":"starting"}"#)).await;
        let p = provider(server.base_url().to_string());
        let err = p
            .submit_fixture("owner/name", &json!({}))
            .await
            .unwrap_err();
        assert!(matches!(&err, ProviderError::DeliveryUncertain(_)), "{err}");
        assert!(err.to_string().contains("no prediction ID"), "{err}");
    }

    #[tokio::test]
    async fn generate_image_inline_returns_immediately_on_terminal_success() {
        // create_prediction returns an already-succeeded prediction → run_inline
        // breaks on the first check with no poll sleep.
        let server = MockServer::always(MockResponse::json(
            201,
            r#"{"id":"p","status":"succeeded","output":["https://x/i.png"]}"#,
        ))
        .await;
        let p = provider(server.base_url().to_string());
        let out = p
            .generate_image("owner/name", &json!({ "prompt": "cat" }))
            .await
            .unwrap();
        assert_eq!(out["data"][0]["url"], json!("https://x/i.png"));
        // Only the create call — no polling round-trip.
        assert_eq!(server.request_count(), 1);
    }

    #[tokio::test]
    async fn generate_image_inline_surfaces_failed_prediction() {
        let server = MockServer::always(MockResponse::json(
            201,
            r#"{"id":"p","status":"failed","error":"nsfw filter"}"#,
        ))
        .await;
        let p = provider(server.base_url().to_string());
        let err = p
            .generate_image("owner/name", &json!({ "prompt": "cat" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("nsfw filter"), "{err}");
    }

    #[tokio::test]
    async fn poll_video_fetches_prediction_by_ref() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"id":"pred_5","status":"succeeded","output":"https://x/v.mp4"}"#,
        ))
        .await;
        let p = provider(server.base_url().to_string());
        let job = p.poll_reference_fixture("pred_5").await.unwrap();
        assert_eq!(job.status, JobStatus::Succeeded);
        assert_eq!(server.requests()[0].path, "/predictions/pred_5");
    }

    #[tokio::test]
    async fn create_prediction_maps_error_detail() {
        let server =
            MockServer::always(MockResponse::json(422, r#"{"detail":"input is invalid"}"#)).await;
        let p = provider(server.base_url().to_string());
        let err = p
            .submit_fixture("owner/name", &json!({}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("input is invalid"), "{err}");
        assert!(err.to_string().contains("422"));
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
        assert!(p
            .complete_stream("m", &json!({}))
            .await
            .unwrap_err()
            .to_string()
            .contains("chat is not supported"));
    }
}
