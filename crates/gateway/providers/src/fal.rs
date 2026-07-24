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
//!   - **video** (slow): [`submit_video`] submits and returns the job's
//!     `response_url` as its `provider_ref`; the client polls via [`poll_video`].
//!
//! The job's `provider_ref` is the `response_url`; the status URL is
//! `{response_url}/status` (Fal's own convention), so one stored string is enough
//! to both poll status and fetch the result.
//!
//! `model` is the Fal model id (e.g. `fal-ai/flux/dev`) appended to `base_url`.
//! The submit body is the caller's body minus routing control fields, so the full
//! Fal input surface stays reachable without hardcoding a schema.

use std::pin::Pin;
use std::time::{Duration, Instant};

use serde_json::Value;
use tracing::debug;

use crate::error::ProviderError;
use crate::jobs::{JobStatus, VideoJob};

use super::Provider;

pub struct FalProvider {
    client: reqwest::Client,
    api_key: String,
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
        Self {
            client,
            api_key,
            base_url,
            poll_interval: Duration::from_millis(poll_interval_ms.max(250)),
            poll_timeout: Duration::from_secs(poll_timeout_secs.max(1)),
        }
    }

    fn submit_url(&self, model: &str) -> String {
        format!(
            "{}/{}",
            self.base_url.trim_end_matches('/'),
            model.trim_start_matches('/')
        )
    }

    /// Submit a request and return `(response_url, status)`. `response_url` is the
    /// job's `provider_ref`; append `/status` for the status endpoint.
    async fn submit(
        &self,
        model: &str,
        body: &Value,
    ) -> Result<(String, JobStatus), ProviderError> {
        let input = build_input(body);
        let url = self.submit_url(model);
        debug!(provider = "fal", model, %url, "submitting request");
        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Key {}", self.api_key))
            .json(&input)
            .send()
            .await
            .map_err(|e| ProviderError::Provider(format!("fal request failed: {e}")))?;
        let json = parse_json(resp, "fal submit").await?;

        let response_url = json["response_url"]
            .as_str()
            .map(str::to_owned)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ProviderError::Provider("fal submit returned no response_url".to_string())
            })?;
        Ok((response_url, fal_status(&json)))
    }

    /// Fetch a job's current status via `{response_url}/status`.
    async fn status(&self, response_url: &str) -> Result<JobStatus, ProviderError> {
        let url = format!("{}/status", response_url.trim_end_matches('/'));
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Key {}", self.api_key))
            .send()
            .await
            .map_err(|e| ProviderError::Provider(format!("fal status failed: {e}")))?;
        let json = parse_json(resp, "fal status").await?;
        Ok(fal_status(&json))
    }

    /// Fetch a completed job's result and normalize it.
    async fn result(&self, response_url: &str) -> Result<Value, ProviderError> {
        let resp = self
            .client
            .get(response_url)
            .header("Authorization", format!("Key {}", self.api_key))
            .send()
            .await
            .map_err(|e| ProviderError::Provider(format!("fal result failed: {e}")))?;
        let json = parse_json(resp, "fal result").await?;
        Ok(super::normalize_media_output(&json))
    }

    /// Submit and block-and-poll to completion, returning the normalized output.
    async fn run_inline(&self, model: &str, body: &Value) -> Result<Value, ProviderError> {
        let (response_url, mut status) = self.submit(model, body).await?;
        let deadline = Instant::now() + self.poll_timeout;
        while !status.is_terminal() {
            if Instant::now() >= deadline {
                return Err(ProviderError::Provider(
                    "fal request timed out before completing".to_string(),
                ));
            }
            tokio::time::sleep(self.poll_interval).await;
            status = self.status(&response_url).await?;
        }
        if status == JobStatus::Failed {
            return Err(ProviderError::Provider("fal request failed".to_string()));
        }
        self.result(&response_url).await
    }
}

impl Provider for FalProvider {
    fn name(&self) -> &'static str {
        "fal"
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
            let (response_url, status) = self.submit(model, body).await?;
            // If Fal reports the job already COMPLETED at submit time, fetch the
            // result now so a subsequent terminal poll returns the media rather
            // than an empty envelope.
            let output = if status == JobStatus::Succeeded {
                self.result(&response_url).await.ok()
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

    fn poll_video<'a>(
        &'a self,
        provider_ref: &'a str,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<VideoJob, ProviderError>> + Send + 'a>>
    {
        Box::pin(async move {
            let status = self.status(provider_ref).await?;
            let (output, error) = match status {
                JobStatus::Succeeded => (Some(self.result(provider_ref).await?), None),
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
async fn parse_json(resp: reqwest::Response, ctx: &str) -> Result<Value, ProviderError> {
    let status = resp.status();
    let json: Value = resp
        .json()
        .await
        .map_err(|e| ProviderError::Provider(format!("{ctx} parse error: {e}")))?;
    if status.is_success() {
        return Ok(json);
    }
    // Fal (FastAPI) validation errors return `detail` as an ARRAY of
    // `{loc, msg, type}` objects; a plain string covers other error shapes.
    let msg = json["detail"]
        .as_str()
        .or_else(|| json["detail"][0]["msg"].as_str())
        .or_else(|| json["error"].as_str())
        .or_else(|| json["message"].as_str())
        .unwrap_or("unknown error");
    Err(ProviderError::Provider(format!(
        "{ctx} error {status}: {msg}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
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
        FalProvider::new(reqwest::Client::new(), "fal-secret".into(), base_url, 250, 60)
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
            .submit_video("fal-ai/kling-video", &json!({ "prompt": "a wave" }))
            .await
            .unwrap();
        assert_eq!(job.status, JobStatus::Queued);
        assert_eq!(job.provider_ref, format!("{}/req/r1", server.base_url()));

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
    async fn submit_errors_when_no_response_url() {
        let server =
            MockServer::always(MockResponse::ok_json(r#"{"status":"IN_QUEUE"}"#)).await;
        let p = provider(server.base_url().to_string());
        let err = p.submit_video("fal-ai/x", &json!({})).await.unwrap_err();
        assert!(err.to_string().contains("no response_url"), "{err}");
    }

    #[tokio::test]
    async fn generate_image_inline_completes_without_polling() {
        // First reply: submit already COMPLETED. Second reply: the result fetch.
        let server = MockServer::start(vec![
            MockResponse::ok_json(
                r#"{"status":"COMPLETED","response_url":"{{BASE}}/req/r2"}"#,
            ),
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
        let job = p.poll_video(&ref_url).await.unwrap();
        assert_eq!(job.status, JobStatus::Succeeded);
        assert_eq!(job.output.unwrap()["data"][0]["url"], json!("https://x/v.mp4"));

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
        let job = p.poll_video(&ref_url).await.unwrap();
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
        let err = p.submit_video("fal-ai/x", &json!({})).await.unwrap_err();
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
