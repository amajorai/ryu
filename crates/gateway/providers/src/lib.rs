//! Ryu Gateway concrete backend providers.
//!
//! The `Provider` trait, its nine built-in HTTP implementations (OpenAI,
//! Anthropic, local, core, OpenRouter, Modal, GenAI, Replicate, Fal), and the
//! shared provider HTTP machinery (retry with back-off, rate-limit header
//! parsing, model discovery, media-output normalization). The per-provider quota
//! sink ([`quota`]) and the video-job value types ([`jobs`]) live here too so the
//! providers can name them.
//!
//! The `ProviderRegistry` + config-driven registration + provider-key custody
//! stay in `apps/gateway` (`src/providers.rs`) — "engine moves, wiring stays".
//! The trait returns a crate-local [`ProviderError`]; the gateway maps it 1:1 to
//! its `GatewayError` at the pipeline call boundary (`impl From<ProviderError>
//! for GatewayError`), which is what preserves the rate-limit-vs-fault
//! distinction the circuit breaker depends on.

pub mod anthropic;
pub mod core;
pub mod error;
pub mod fal;
pub mod genai;
pub mod jobs;
pub mod local;
pub mod modal;
pub mod openai;
pub mod openrouter;
pub mod quota;
pub mod replicate;

use std::pin::Pin;
use std::time::Duration;

use axum::body::Body;
use reqwest::header::HeaderMap;
use serde_json::Value;
use tracing::warn;

pub use anthropic::AnthropicProvider;
pub use core::CoreProvider;
pub use error::ProviderError;
pub use fal::FalProvider;
pub use genai::GenAiProvider;
pub use jobs::{JobStatus, VideoJob};
pub use local::LocalProvider;
pub use modal::ModalProvider;
pub use openai::OpenAiProvider;
pub use openrouter::{OpenRouterOptions, OpenRouterProvider};
pub use quota::{ProviderQuotas, RateLimitInfo};
pub use replicate::ReplicateProvider;

// ─── Shared helpers used by individual provider modules ──────────────────────

/// Build a `/v1/chat/completions` URL from a base URL.
pub(crate) fn chat_completions_url(base_url: &str) -> String {
    format!("{}/chat/completions", base_url.trim_end_matches('/'))
}

/// Fetch `GET {base}/models` from an OpenAI-compatible endpoint and return its
/// `data[]` model objects. `api_key` may be empty (e.g. a local Ollama server).
/// Discovery-only: a short 6 s timeout and any error / timeout / non-2xx /
/// empty result yields `None` so the caller falls back to the static list. Never
/// panics or propagates an error — `/v1/models` must stay infallible.
pub(crate) async fn discover_openai_models(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
) -> Option<Value> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let mut req = client.get(&url).timeout(Duration::from_secs(6));
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }
    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    Some(resp.json::<Value>().await.ok()?)
}

/// Turn a `GET /models` response body into its `data[]` model objects with an
/// `id`, dropping malformed entries. Returns `None` when nothing usable is found
/// so discovery is treated as a miss (fall back to the static list).
pub(crate) fn models_from_response(json: Value) -> Option<Vec<Value>> {
    let data = json.get("data")?.as_array()?;
    let models: Vec<Value> = data
        .iter()
        .filter(|m| m.get("id").and_then(Value::as_str).is_some())
        .cloned()
        .collect();
    (!models.is_empty()).then_some(models)
}

/// Parse the common rate-limit / quota headers a provider may return. Handles
/// OpenAI's `x-ratelimit-*`, Anthropic's `anthropic-ratelimit-*`, and the
/// standard `retry-after`. Returns `None` when nothing usable is present.
pub(crate) fn parse_rate_limit(headers: &HeaderMap) -> Option<RateLimitInfo> {
    let retry_after = header_u64(headers, &["retry-after"]);
    let remaining = header_u64(
        headers,
        &[
            "x-ratelimit-remaining-tokens",
            "x-ratelimit-remaining-requests",
            "anthropic-ratelimit-tokens-remaining",
            "anthropic-ratelimit-requests-remaining",
            "x-ratelimit-remaining",
        ],
    );
    let limit = header_u64(
        headers,
        &[
            "x-ratelimit-limit-tokens",
            "x-ratelimit-limit-requests",
            "anthropic-ratelimit-tokens-limit",
            "anthropic-ratelimit-requests-limit",
            "x-ratelimit-limit",
        ],
    );
    // A concrete reset instant is provider-specific and fiddly (OpenAI uses a
    // duration like "6m0s", Anthropic an RFC3339 timestamp). For v1 we derive the
    // reset from `retry-after` when present (now + retry_after); the raw reset
    // header parsing can be layered in later without changing the shape.
    let reset_at = retry_after.map(|s| now_secs().saturating_add(s));

    let info = RateLimitInfo {
        remaining,
        limit,
        reset_at,
        retry_after,
    };
    info.is_some().then_some(info)
}

/// Read the first present header from `keys` as a `u64` (trimmed). Non-numeric or
/// missing values are skipped so a malformed header never poisons the signal.
fn header_u64(headers: &HeaderMap, keys: &[&str]) -> Option<u64> {
    for k in keys {
        if let Some(v) = headers.get(*k).and_then(|v| v.to_str().ok()) {
            if let Ok(n) = v.trim().parse::<u64>() {
                return Some(n);
            }
        }
    }
    None
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Check a streaming response for a non-2xx status and return an error. An HTTP
/// 429 becomes the typed [`ProviderError::RateLimited`] (so the pipeline can
/// rotate accounts / demote tier without penalizing the circuit breaker) and
/// is recorded into the quota sink when one is provided.
pub(crate) async fn check_stream_status(
    resp: reqwest::Response,
    provider: &str,
    quota: Option<&ProviderQuotas>,
) -> Result<reqwest::Response, ProviderError> {
    let status = resp.status();
    let rate_limit = parse_rate_limit(resp.headers());
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry_after = rate_limit.as_ref().and_then(|r| r.retry_after);
        let reset_at = rate_limit.as_ref().and_then(|r| r.reset_at);
        if let Some(q) = quota {
            q.record_rate_limited(provider, retry_after, reset_at);
        }
        return Err(ProviderError::RateLimited {
            provider: provider.to_string(),
            retry_after,
            reset_at,
        });
    }
    if status.is_success() {
        if let (Some(q), Some(info)) = (quota, rate_limit.as_ref()) {
            q.record_success(provider, info);
        }
        return Ok(resp);
    }
    let body = resp.text().await.unwrap_or_default();
    Err(ProviderError::Provider(format!(
        "{provider} stream error {status}: {body}"
    )))
}

/// Check a completed response for a non-2xx status, parse and return the JSON
/// body. An HTTP 429 becomes the typed [`ProviderError::RateLimited`]; any
/// rate-limit headers (on success or 429) are recorded into the quota sink when
/// provided.
pub(crate) async fn check_response_status(
    resp: reqwest::Response,
    provider: &str,
    quota: Option<&ProviderQuotas>,
) -> Result<Value, ProviderError> {
    let status = resp.status();
    let rate_limit = parse_rate_limit(resp.headers());

    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry_after = rate_limit.as_ref().and_then(|r| r.retry_after);
        let reset_at = rate_limit.as_ref().and_then(|r| r.reset_at);
        if let Some(q) = quota {
            q.record_rate_limited(provider, retry_after, reset_at);
        }
        // Drain the body best-effort for the log; it is not surfaced to the caller.
        let _ = resp.text().await;
        tracing::warn!(provider, status = %status, "provider rate limited (429)");
        return Err(ProviderError::RateLimited {
            provider: provider.to_string(),
            retry_after,
            reset_at,
        });
    }

    let json: Value = resp.json().await.map_err(|e| {
        ProviderError::Provider(format!("{provider} response parse error: {e}"))
    })?;

    if status.is_success() {
        if let (Some(q), Some(info)) = (quota, rate_limit.as_ref()) {
            q.record_success(provider, info);
        }
        return Ok(json);
    }

    let msg = json["error"]["message"]
        .as_str()
        .unwrap_or("unknown error")
        .to_string();
    tracing::warn!(provider, status = %status, error = %msg, "provider returned error");
    Err(ProviderError::Provider(format!(
        "{provider} error {status}: {msg}"
    )))
}

/// Retry a fallible `reqwest` send closure up to `max_retries` times on
/// transient errors (5xx or connection failure), with exponential back-off
/// (1 s, 2 s, 4 s, …).  4xx errors are not retried.
pub(crate) async fn send_with_retry(
    make_request: impl Fn() -> Pin<
        Box<dyn std::future::Future<Output = Result<reqwest::Response, reqwest::Error>> + Send>,
    >,
    provider: &str,
    max_retries: u32,
) -> Result<reqwest::Response, ProviderError> {
    let mut attempt = 0u32;
    loop {
        match make_request().await {
            Ok(resp) if resp.status().is_server_error() => {
                if attempt >= max_retries {
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    return Err(ProviderError::Provider(format!(
                        "{provider} error {status} after {attempt} retries: {text}"
                    )));
                }
                let delay = Duration::from_secs(1u64 << attempt);
                warn!(provider, attempt, ?delay, "transient 5xx, retrying");
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
            Ok(resp) => return Ok(resp),
            Err(e) if e.is_connect() || e.is_timeout() => {
                if attempt >= max_retries {
                    return Err(ProviderError::Provider(format!(
                        "{provider} connection error after {attempt} retries: {e}"
                    )));
                }
                let delay = Duration::from_secs(1u64 << attempt);
                warn!(provider, attempt, ?delay, error = %e, "connection error, retrying");
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
            Err(e) => {
                return Err(ProviderError::Provider(format!(
                    "{provider} request failed: {e}"
                )));
            }
        }
    }
}

// ─── Provider trait ───────────────────────────────────────────────────────────

/// Common interface implemented by every backend provider.
pub trait Provider: Send + Sync {
    fn name(&self) -> &'static str;

    /// Discover available models via an OpenAI-compatible `GET {base}/models`.
    /// Returns the upstream `data[]` model objects on success, or `None` when the
    /// provider exposes no such endpoint or the call errors/times out — in which
    /// case `/v1/models` falls back to the static builtin list for it. The
    /// default is `None`; only OpenAI-compat providers override it. Uses a short
    /// per-request timeout so a slow upstream never stalls the endpoint.
    fn discover_models<'a>(
        &'a self,
    ) -> Pin<Box<dyn std::future::Future<Output = Option<Vec<Value>>> + Send + 'a>> {
        Box::pin(async { None })
    }

    /// Non-streaming completion. Returns the full response JSON.
    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>>;

    /// Streaming completion. Returns a raw SSE byte stream.
    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>>;

    /// Image generation. `body` follows the OpenAI `/v1/images/generations` shape.
    /// Returns the full response JSON. Default implementation returns an error so
    /// providers that don't support image-gen don't need to implement it.
    fn generate_image<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        let name = self.name();
        Box::pin(async move {
            Err(ProviderError::Provider(format!(
                "{name} does not support image generation"
            )))
        })
    }

    /// Text-to-speech synthesis. `body` follows the OpenAI `/v1/audio/speech`
    /// shape (`model`, `input`, `voice`). Returns the full response JSON.
    /// Default implementation returns an error.
    fn synthesize_speech<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        let name = self.name();
        Box::pin(async move {
            Err(ProviderError::Provider(format!(
                "{name} does not support TTS"
            )))
        })
    }

    /// Speech-to-text transcription. `body` follows the OpenAI
    /// `/v1/audio/transcriptions` shape (`model`, `file`). Returns the full
    /// response JSON. Default implementation returns an error.
    fn transcribe_audio<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        let name = self.name();
        Box::pin(async move {
            Err(ProviderError::Provider(format!(
                "{name} does not support STT"
            )))
        })
    }

    /// Submit a video-generation job. Unlike the synchronous modalities, video
    /// is job-based: this kicks off the provider's async prediction/queue and
    /// returns a [`VideoJob`] handle (its `provider_ref` + initial status) the
    /// gateway stores so the client can poll. `body` follows the same free-form
    /// shape as image gen (`{ prompt, ... }`). Default: unsupported.
    fn submit_video<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<VideoJob, ProviderError>> + Send + 'a>>
    {
        let name = self.name();
        Box::pin(async move {
            Err(ProviderError::Provider(format!(
                "{name} does not support video generation"
            )))
        })
    }

    /// Poll a previously-submitted video job by its `provider_ref` (returned from
    /// [`Self::submit_video`]). Returns the job's current [`VideoJob`] state,
    /// with `output` populated once it succeeds. Default: unsupported.
    fn poll_video<'a>(
        &'a self,
        _provider_ref: &'a str,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<VideoJob, ProviderError>> + Send + 'a>>
    {
        let name = self.name();
        Box::pin(async move {
            Err(ProviderError::Provider(format!(
                "{name} does not support video generation"
            )))
        })
    }
}

// ─── Helper: build endpoint URLs for multimodal routes ───────────────────────

/// Build an `/v1/images/generations` URL from a base URL.
pub(crate) fn images_url(base_url: &str) -> String {
    format!("{}/images/generations", base_url.trim_end_matches('/'))
}

/// Build an `/v1/audio/speech` URL from a base URL.
pub(crate) fn audio_speech_url(base_url: &str) -> String {
    format!("{}/audio/speech", base_url.trim_end_matches('/'))
}

/// Build an `/v1/audio/transcriptions` URL from a base URL.
pub(crate) fn audio_transcriptions_url(base_url: &str) -> String {
    format!("{}/audio/transcriptions", base_url.trim_end_matches('/'))
}

// ─── Shared media-output normalization (cloud media providers) ────────────────

/// Normalize an arbitrary provider media `output` (a URL string, a list of URLs,
/// or a nested object like `{ images: [{ url }] }`) into the OpenAI-ish
/// `{ "data": [{ "url": … }], "raw": <original> }` shape the desktop clients
/// render. `raw` preserves the full provider output for callers that need it.
pub(crate) fn normalize_media_output(output: &Value) -> Value {
    let mut data: Vec<Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    collect_media_urls(output, &mut data, &mut seen);
    serde_json::json!({ "data": data, "raw": output.clone() })
}

/// Recursively collect renderable media URLs from an arbitrary output value,
/// de-duplicating so repeated URLs (e.g. a result echoed in nested fields) are
/// emitted once.
fn collect_media_urls(value: &Value, out: &mut Vec<Value>, seen: &mut Vec<String>) {
    match value {
        Value::String(s) if is_media_url(s) => {
            if !seen.iter().any(|u| u == s) {
                seen.push(s.clone());
                out.push(serde_json::json!({ "url": s }));
            }
        }
        Value::Array(arr) => {
            for v in arr {
                collect_media_urls(v, out, seen);
            }
        }
        Value::Object(map) => {
            for v in map.values() {
                collect_media_urls(v, out, seen);
            }
        }
        _ => {}
    }
}

/// Whether a string looks like a fetchable media URL or an inline data URI.
fn is_media_url(s: &str) -> bool {
    s.starts_with("http://") || s.starts_with("https://") || s.starts_with("data:")
}

#[cfg(test)]
mod rate_limit_tests {
    use super::parse_rate_limit;
    use reqwest::header::HeaderMap;

    #[test]
    fn parses_remaining_limit_and_retry_after() {
        let mut h = HeaderMap::new();
        h.insert("x-ratelimit-remaining-tokens", "1200".parse().unwrap());
        h.insert("x-ratelimit-limit-tokens", "10000".parse().unwrap());
        h.insert("retry-after", "30".parse().unwrap());
        let info = parse_rate_limit(&h).expect("some");
        assert_eq!(info.remaining, Some(1200));
        assert_eq!(info.limit, Some(10000));
        assert_eq!(info.retry_after, Some(30));
        // reset_at is derived from retry-after (now + 30), so it must be in the future.
        assert!(info.reset_at.unwrap() >= 30);
    }

    #[test]
    fn none_when_no_rate_limit_headers() {
        let mut h = HeaderMap::new();
        h.insert("content-type", "application/json".parse().unwrap());
        assert!(parse_rate_limit(&h).is_none());
    }

    #[test]
    fn ignores_malformed_numeric_headers() {
        let mut h = HeaderMap::new();
        h.insert("x-ratelimit-remaining", "not-a-number".parse().unwrap());
        assert!(parse_rate_limit(&h).is_none());
    }
}

#[cfg(test)]
mod media_output_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_string_url() {
        let out = normalize_media_output(&json!("https://r.example/a.png"));
        assert_eq!(out["data"][0]["url"], json!("https://r.example/a.png"));
    }

    #[test]
    fn normalizes_array_of_urls() {
        let out = normalize_media_output(&json!(["https://x/a.mp4", "https://x/b.mp4"]));
        assert_eq!(out["data"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn normalizes_fal_images_shape() {
        let out = normalize_media_output(
            &json!({ "images": [{ "url": "https://x/i.png", "width": 512 }] }),
        );
        assert_eq!(out["data"][0]["url"], json!("https://x/i.png"));
    }

    #[test]
    fn dedupes_repeated_urls() {
        let out = normalize_media_output(
            &json!({ "video": { "url": "https://x/v.mp4" }, "url": "https://x/v.mp4" }),
        );
        assert_eq!(out["data"].as_array().unwrap().len(), 1);
    }
}
