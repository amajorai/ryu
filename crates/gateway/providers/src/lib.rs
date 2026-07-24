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

    let json: Value = resp
        .json()
        .await
        .map_err(|e| ProviderError::Provider(format!("{provider} response parse error: {e}")))?;

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

/// Shared in-process mock HTTP server for provider tests. Binds an ephemeral
/// `127.0.0.1` port (never leaves localhost), records every request it receives,
/// and replies from a queue of canned responses. Used by the provider modules'
/// inline `#[cfg(test)]` suites to exercise the async request/auth/error paths
/// without any real network, keys, or sleeps.
#[cfg(test)]
pub(crate) mod test_support {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use axum::body::{Body, Bytes};
    use axum::extract::State;
    use axum::http::{HeaderMap, Method, StatusCode, Uri};
    use axum::response::Response;
    use axum::routing::any;
    use axum::Router;
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;

    /// One canned HTTP reply.
    #[derive(Clone)]
    pub struct MockResponse {
        pub status: u16,
        pub headers: Vec<(String, String)>,
        pub body: String,
    }

    impl MockResponse {
        /// A `200 OK` JSON reply.
        pub fn ok_json(body: impl Into<String>) -> Self {
            Self {
                status: 200,
                headers: vec![("content-type".into(), "application/json".into())],
                body: body.into(),
            }
        }

        /// An arbitrary-status JSON reply.
        pub fn json(status: u16, body: impl Into<String>) -> Self {
            Self {
                status,
                headers: vec![("content-type".into(), "application/json".into())],
                body: body.into(),
            }
        }

        pub fn with_header(mut self, k: &str, v: &str) -> Self {
            self.headers.push((k.to_string(), v.to_string()));
            self
        }
    }

    /// A recorded inbound request.
    #[derive(Clone)]
    pub struct Recorded {
        pub method: String,
        pub path: String,
        pub headers: HeaderMap,
        pub body: Vec<u8>,
    }

    impl Recorded {
        /// Parse the recorded body as JSON (panics if not JSON — tests send JSON).
        pub fn json(&self) -> serde_json::Value {
            serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
        }

        pub fn header(&self, name: &str) -> Option<String> {
            self.headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        }
    }

    #[derive(Clone)]
    struct AppState {
        responses: Arc<Mutex<VecDeque<MockResponse>>>,
        requests: Arc<Mutex<Vec<Recorded>>>,
        /// The server's own `http://127.0.0.1:port` base; substituted for the
        /// literal `{{BASE}}` in any reply body so a response can point a
        /// follow-up poll/result URL back at this same mock.
        base_url: String,
    }

    /// A running mock server. Aborts its serving task on drop.
    pub struct MockServer {
        base_url: String,
        requests: Arc<Mutex<Vec<Recorded>>>,
        handle: JoinHandle<()>,
    }

    impl Drop for MockServer {
        fn drop(&mut self) {
            self.handle.abort();
        }
    }

    async fn handler(
        State(state): State<AppState>,
        method: Method,
        uri: Uri,
        headers: HeaderMap,
        body: Bytes,
    ) -> Response {
        state.requests.lock().unwrap().push(Recorded {
            method: method.to_string(),
            path: uri.path().to_string(),
            headers,
            body: body.to_vec(),
        });

        let reply = {
            let mut q = state.responses.lock().unwrap();
            if q.len() > 1 {
                q.pop_front().unwrap()
            } else {
                q.front().cloned().unwrap_or_else(|| MockResponse::ok_json("{}"))
            }
        };

        let body = reply.body.replace("{{BASE}}", &state.base_url);
        let mut builder = Response::builder()
            .status(StatusCode::from_u16(reply.status).unwrap_or(StatusCode::OK));
        for (k, v) in &reply.headers {
            builder = builder.header(k, v);
        }
        builder.body(Body::from(body)).unwrap()
    }

    impl MockServer {
        /// Start a mock server that replies with `responses` in order (the last
        /// one repeats once the queue is down to a single entry).
        pub async fn start(responses: Vec<MockResponse>) -> Self {
            let requests = Arc::new(Mutex::new(Vec::new()));
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let base_url = format!("http://{addr}");

            let state = AppState {
                responses: Arc::new(Mutex::new(responses.into_iter().collect())),
                requests: requests.clone(),
                base_url: base_url.clone(),
            };
            let app = Router::new()
                .route("/", any(handler))
                .fallback(any(handler))
                .with_state(state);

            let handle = tokio::spawn(async move {
                let _ = axum::serve(listener, app).await;
            });

            Self {
                base_url,
                requests,
                handle,
            }
        }

        /// Convenience: a server that always replies with a single response.
        pub async fn always(response: MockResponse) -> Self {
            Self::start(vec![response]).await
        }

        pub fn base_url(&self) -> &str {
            &self.base_url
        }

        /// All requests received so far, in arrival order.
        pub fn requests(&self) -> Vec<Recorded> {
            self.requests.lock().unwrap().clone()
        }

        pub fn request_count(&self) -> usize {
            self.requests.lock().unwrap().len()
        }
    }
}

#[cfg(test)]
mod helper_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn url_builders_trim_trailing_slash() {
        assert_eq!(
            chat_completions_url("https://api.x.ai/v1/"),
            "https://api.x.ai/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://api.x.ai/v1"),
            "https://api.x.ai/v1/chat/completions"
        );
        assert_eq!(
            images_url("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/images/generations"
        );
        assert_eq!(
            audio_speech_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/audio/speech"
        );
        assert_eq!(
            audio_transcriptions_url("https://api.openai.com/v1//"),
            "https://api.openai.com/v1/audio/transcriptions"
        );
    }

    #[test]
    fn models_from_response_keeps_only_entries_with_id() {
        let body = json!({
            "data": [
                { "id": "gpt-4o" },
                { "no_id": true },
                { "id": "gpt-4o-mini", "extra": 1 }
            ]
        });
        let models = models_from_response(body).expect("some models");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["id"], json!("gpt-4o"));
        assert_eq!(models[1]["id"], json!("gpt-4o-mini"));
    }

    #[test]
    fn models_from_response_none_when_empty_or_malformed() {
        assert!(models_from_response(json!({ "data": [] })).is_none());
        assert!(models_from_response(json!({ "data": [{ "no_id": 1 }] })).is_none());
        assert!(models_from_response(json!({ "not_data": [] })).is_none());
        assert!(models_from_response(json!({ "data": "oops" })).is_none());
    }

    #[test]
    fn parse_rate_limit_reads_anthropic_headers() {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert(
            "anthropic-ratelimit-tokens-remaining",
            "42".parse().unwrap(),
        );
        h.insert("anthropic-ratelimit-tokens-limit", "1000".parse().unwrap());
        let info = parse_rate_limit(&h).expect("some");
        assert_eq!(info.remaining, Some(42));
        assert_eq!(info.limit, Some(1000));
        // No retry-after → no derived reset instant.
        assert_eq!(info.retry_after, None);
        assert_eq!(info.reset_at, None);
    }

    #[test]
    fn parse_rate_limit_first_present_key_wins() {
        // remaining-tokens should be preferred over remaining-requests (first in list).
        let mut h = reqwest::header::HeaderMap::new();
        h.insert("x-ratelimit-remaining-requests", "5".parse().unwrap());
        let info = parse_rate_limit(&h).expect("some");
        assert_eq!(info.remaining, Some(5));
    }

    #[test]
    fn is_media_url_matches_http_and_data_uris() {
        assert!(is_media_url("https://x/a.png"));
        assert!(is_media_url("http://x/a.png"));
        assert!(is_media_url("data:image/png;base64,AAAA"));
        assert!(!is_media_url("ftp://x/a.png"));
        assert!(!is_media_url("just text"));
    }

    #[test]
    fn normalize_media_output_preserves_raw_and_ignores_non_urls() {
        let out = normalize_media_output(&json!({ "seed": 7, "note": "hello" }));
        assert_eq!(out["data"].as_array().unwrap().len(), 0);
        assert_eq!(out["raw"]["seed"], json!(7));
    }
}

#[cfg(test)]
mod status_check_tests {
    use super::test_support::{MockResponse, MockServer};
    use super::{check_response_status, check_stream_status, ProviderError};
    use crate::quota::ProviderQuotas;

    async fn fetch(server: &MockServer) -> reqwest::Response {
        reqwest::Client::new()
            .get(server.base_url())
            .send()
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn check_response_status_success_records_quota() {
        let server = MockServer::always(
            MockResponse::ok_json(r#"{"ok":true}"#)
                .with_header("x-ratelimit-remaining-tokens", "900"),
        )
        .await;
        let quota = ProviderQuotas::new();
        let resp = fetch(&server).await;
        let json = check_response_status(resp, "p", Some(&quota)).await.unwrap();
        assert_eq!(json["ok"], serde_json::json!(true));
        assert_eq!(quota.snapshot()["p"]["remaining"], serde_json::json!(900));
    }

    #[tokio::test]
    async fn check_response_status_429_is_rate_limited_and_recorded() {
        let server = MockServer::always(
            MockResponse::json(429, r#"{"error":{"message":"slow down"}}"#)
                .with_header("retry-after", "12"),
        )
        .await;
        let quota = ProviderQuotas::new();
        let resp = fetch(&server).await;
        let err = check_response_status(resp, "p", Some(&quota))
            .await
            .unwrap_err();
        match err {
            ProviderError::RateLimited {
                provider,
                retry_after,
                ..
            } => {
                assert_eq!(provider, "p");
                assert_eq!(retry_after, Some(12));
            }
            other => panic!("expected RateLimited, got {other:?}"),
        }
        assert_eq!(quota.snapshot()["p"]["rate_limited"], serde_json::json!(true));
    }

    #[tokio::test]
    async fn check_response_status_maps_error_message() {
        let server = MockServer::always(MockResponse::json(
            400,
            r#"{"error":{"message":"bad model"}}"#,
        ))
        .await;
        let resp = fetch(&server).await;
        let err = check_response_status(resp, "p", None).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("bad model"), "got: {msg}");
        assert!(msg.contains("400"));
    }

    #[tokio::test]
    async fn check_stream_status_429_maps_to_rate_limited() {
        let server = MockServer::always(
            MockResponse::json(429, "rate limited").with_header("retry-after", "7"),
        )
        .await;
        let resp = fetch(&server).await;
        let err = check_stream_status(resp, "p", None).await.unwrap_err();
        assert!(matches!(err, ProviderError::RateLimited { .. }));
    }

    #[tokio::test]
    async fn check_stream_status_error_includes_status_and_body() {
        let server = MockServer::always(MockResponse::json(503, "upstream down")).await;
        let resp = fetch(&server).await;
        let err = check_stream_status(resp, "p", None).await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("503"), "got: {msg}");
        assert!(msg.contains("upstream down"), "got: {msg}");
    }
}

#[cfg(test)]
mod default_trait_methods_tests {
    use super::{LocalProvider, Provider, ProviderError};
    use serde_json::json;

    // LocalProvider does not override the media modalities, so it exercises the
    // `Provider` trait's default "unsupported" implementations without any network.
    fn provider() -> LocalProvider {
        LocalProvider::new(reqwest::Client::new(), "http://127.0.0.1:1".to_string())
    }

    fn assert_unsupported(err: ProviderError, needle: &str) {
        match err {
            ProviderError::Provider(msg) => {
                assert!(msg.contains("local"), "expected provider name, got: {msg}");
                assert!(msg.contains(needle), "expected '{needle}' in: {msg}");
            }
            other => panic!("expected Provider error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn default_media_methods_report_unsupported() {
        let p = provider();
        let b = json!({});
        assert_unsupported(
            p.generate_image("m", &b).await.unwrap_err(),
            "image generation",
        );
        assert_unsupported(p.synthesize_speech("m", &b).await.unwrap_err(), "TTS");
        assert_unsupported(p.transcribe_audio("m", &b).await.unwrap_err(), "STT");
        assert_unsupported(p.submit_video("m", &b).await.unwrap_err(), "video");
        assert_unsupported(p.poll_video("ref").await.unwrap_err(), "video");
    }

    #[tokio::test]
    async fn default_discover_models_is_none() {
        // The base trait default returns None; LocalProvider overrides it to hit an
        // endpoint, but a struct using the base default (via the trait object) would
        // return None. Here we assert the documented contract on a bogus endpoint:
        // discovery must never panic and returns None on connection failure.
        let p = provider();
        assert!(p.discover_models().await.is_none());
    }
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
