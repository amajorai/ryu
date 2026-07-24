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
//!   - **video** (slow, minutes): [`submit_video`] creates the prediction and
//!     returns immediately with the prediction id as the job's `provider_ref`;
//!     the gateway stores the job and the client polls via [`poll_video`].
//!
//! Model identification (`model`), matching the Replicate API's three forms:
//!   - `owner/name`            → `POST /models/{owner}/{name}/predictions`
//!   - `owner/name:<version>`  → `POST /predictions` with `{ version }`
//!   - `<version-hash>`        → `POST /predictions` with `{ version }`
//!
//! The prediction `input` is the caller's body (minus routing control fields),
//! or, if the caller nested an explicit `input` object, that verbatim — so the
//! full Replicate parameter surface stays reachable without hardcoding a schema.

use std::pin::Pin;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tracing::debug;

use crate::error::ProviderError;
use crate::jobs::{JobStatus, VideoJob};

use super::Provider;

pub struct ReplicateProvider {
    client: reqwest::Client,
    api_key: String,
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
        Self {
            client,
            api_key,
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
    async fn create_prediction(&self, model: &str, input: Value) -> Result<Value, ProviderError> {
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
        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|e| ProviderError::Provider(format!("replicate request failed: {e}")))?;
        parse_prediction(resp, "replicate create").await
    }

    /// Fetch a prediction's current state by id.
    async fn get_prediction(&self, id: &str) -> Result<Value, ProviderError> {
        let url = format!("{}/predictions/{}", self.base(), id);
        let resp = self
            .client
            .get(&url)
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| ProviderError::Provider(format!("replicate poll failed: {e}")))?;
        parse_prediction(resp, "replicate poll").await
    }

    /// Create a prediction and block-and-poll it to a terminal state, returning
    /// the normalized media output. Used for the fast (image/TTS) modalities.
    async fn run_inline(&self, model: &str, body: &Value) -> Result<Value, ProviderError> {
        let input = build_input(body);
        let prediction = self.create_prediction(model, input).await?;
        let mut current = prediction;

        let deadline = Instant::now() + self.poll_timeout;
        loop {
            let status = replicate_status(&current);
            if status.is_terminal() {
                break;
            }
            if Instant::now() >= deadline {
                return Err(ProviderError::Provider(
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
            current = self.get_prediction(&id).await?;
        }

        if replicate_status(&current) == JobStatus::Failed {
            let err = current["error"].as_str().unwrap_or("prediction failed");
            return Err(ProviderError::Provider(format!("replicate: {err}")));
        }
        Ok(super::normalize_media_output(&current["output"]))
    }

    fn video_from_prediction(prediction: &Value) -> VideoJob {
        let status = replicate_status(prediction);
        let provider_ref = prediction["id"].as_str().unwrap_or_default().to_string();
        let (output, error) = match status {
            JobStatus::Succeeded => (
                Some(super::normalize_media_output(&prediction["output"])),
                None,
            ),
            JobStatus::Failed => (
                None,
                Some(
                    prediction["error"]
                        .as_str()
                        .unwrap_or("prediction failed")
                        .to_string(),
                ),
            ),
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

impl Provider for ReplicateProvider {
    fn name(&self) -> &'static str {
        "replicate"
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

    fn synthesize_speech<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move { self.run_inline(model, body).await })
    }

    fn submit_video<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<VideoJob, ProviderError>> + Send + 'a>>
    {
        Box::pin(async move {
            let input = build_input(body);
            let prediction = self.create_prediction(model, input).await?;
            let job = Self::video_from_prediction(&prediction);
            if job.provider_ref.is_empty() {
                return Err(ProviderError::Provider(
                    "replicate submit returned no prediction id".to_string(),
                ));
            }
            Ok(job)
        })
    }

    fn poll_video<'a>(
        &'a self,
        provider_ref: &'a str,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<VideoJob, ProviderError>> + Send + 'a>>
    {
        Box::pin(async move {
            let prediction = self.get_prediction(provider_ref).await?;
            Ok(Self::video_from_prediction(&prediction))
        })
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
async fn parse_prediction(resp: reqwest::Response, ctx: &str) -> Result<Value, ProviderError> {
    let status = resp.status();
    let json: Value = resp
        .json()
        .await
        .map_err(|e| ProviderError::Provider(format!("{ctx} parse error: {e}")))?;
    if status.is_success() || status.as_u16() == 201 {
        return Ok(json);
    }
    let msg = json["detail"]
        .as_str()
        .or_else(|| json["error"].as_str())
        .unwrap_or("unknown error");
    Err(ProviderError::Provider(format!(
        "{ctx} error {status}: {msg}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(job.output.unwrap()["data"][0]["url"], json!("https://x/v.mp4"));
        assert!(job.error.is_none());
    }

    #[test]
    fn video_from_prediction_failed_carries_error() {
        let pred = json!({ "id": "p", "status": "failed", "error": "OOM" });
        let job = ReplicateProvider::video_from_prediction(&pred);
        assert_eq!(job.status, JobStatus::Failed);
        assert_eq!(job.error.as_deref(), Some("OOM"));
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
        ReplicateProvider::new(reqwest::Client::new(), "r8-secret".into(), base_url, 250, 60)
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
            .submit_video("stability-ai/sdxl", &json!({ "prompt": "a dog" }))
            .await
            .unwrap();
        assert_eq!(job.provider_ref, "pred_9");
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
    async fn submit_video_versioned_model_uses_predictions_with_version() {
        let server =
            MockServer::always(MockResponse::json(201, r#"{"id":"p","status":"starting"}"#)).await;
        let p = provider(server.base_url().to_string());
        p.submit_video("owner/name:abc123", &json!({ "prompt": "x" }))
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
        p.submit_video("deadbeefhash", &json!({ "prompt": "x" }))
            .await
            .unwrap();
        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/predictions");
        assert_eq!(reqs[0].json()["version"], json!("deadbeefhash"));
    }

    #[tokio::test]
    async fn submit_video_errors_when_no_prediction_id() {
        let server =
            MockServer::always(MockResponse::json(201, r#"{"status":"starting"}"#)).await;
        let p = provider(server.base_url().to_string());
        let err = p
            .submit_video("owner/name", &json!({}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("no prediction id"), "{err}");
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
        let job = p.poll_video("pred_5").await.unwrap();
        assert_eq!(job.status, JobStatus::Succeeded);
        assert_eq!(server.requests()[0].path, "/predictions/pred_5");
    }

    #[tokio::test]
    async fn create_prediction_maps_error_detail() {
        let server = MockServer::always(MockResponse::json(
            422,
            r#"{"detail":"input is invalid"}"#,
        ))
        .await;
        let p = provider(server.base_url().to_string());
        let err = p
            .submit_video("owner/name", &json!({}))
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
