pub mod anthropic;
pub mod core;
pub mod fal;
pub mod genai;
pub mod local;
pub mod modal;
pub mod openai;
pub mod openrouter;
pub mod replicate;

use std::pin::Pin;
use std::time::Duration;

use axum::body::Body;
use serde_json::Value;
use tracing::warn;

use crate::{
    config::{ProviderKind, ProvidersConfig},
    error::GatewayError,
    jobs::VideoJob,
};

pub use anthropic::AnthropicProvider;
pub use core::CoreProvider;
pub use fal::FalProvider;
pub use genai::GenAiProvider;
pub use local::LocalProvider;
pub use modal::ModalProvider;
pub use openai::OpenAiProvider;
pub use openrouter::OpenRouterProvider;
pub use replicate::ReplicateProvider;

pub struct ProviderRegistry {
    openai: Option<OpenAiProvider>,
    anthropic: Option<AnthropicProvider>,
    local: Option<LocalProvider>,
    openrouter: Option<OpenRouterProvider>,
    core: Option<CoreProvider>,
    modal: Option<ModalProvider>,
    genai: Option<GenAiProvider>,
    replicate: Option<ReplicateProvider>,
    fal: Option<FalProvider>,
}

impl ProviderRegistry {
    pub fn new(config: &ProvidersConfig) -> Self {
        let client = build_client();

        let openai = config
            .openai
            .as_ref()
            .map(|c| OpenAiProvider::new(client.clone(), c.api_key.clone(), c.base_url.clone()));

        let anthropic = config
            .anthropic
            .as_ref()
            .map(|c| AnthropicProvider::new(client.clone(), c.api_key.clone(), c.base_url.clone()));

        let local = config
            .local
            .as_ref()
            .map(|c| LocalProvider::new(client.clone(), c.base_url.clone()));

        let openrouter = config.openrouter.as_ref().map(|c| {
            let options = openrouter::OpenRouterOptions {
                data_collection: (!c.data_collection.is_empty()).then(|| c.data_collection.clone()),
                zdr: c.zdr.then_some(true),
                sort: (!c.sort.is_empty()).then(|| c.sort.clone()),
                response_healing: c.response_healing,
                usage_accounting: c.usage_accounting,
            };
            OpenRouterProvider::new(
                client.clone(),
                c.api_key.clone(),
                c.base_url.clone(),
                c.site_url.clone(),
                c.site_name.clone(),
                options,
            )
        });

        let core = config
            .core
            .as_ref()
            .map(|c| CoreProvider::new(client.clone(), c.base_url.clone(), c.token.clone()));

        let modal = config
            .modal
            .as_ref()
            .map(|c| ModalProvider::new(client.clone(), c.api_key.clone(), c.base_url.clone()));

        let genai = config
            .genai
            .as_ref()
            .map(|c| GenAiProvider::new(c.keys.clone()));

        let replicate = config.replicate.as_ref().map(|c| {
            ReplicateProvider::new(
                client.clone(),
                c.api_key.clone(),
                c.base_url.clone(),
                c.poll_interval_ms,
                c.poll_timeout_secs,
            )
        });

        let fal = config.fal.as_ref().map(|c| {
            FalProvider::new(
                client.clone(),
                c.api_key.clone(),
                c.base_url.clone(),
                c.poll_interval_ms,
                c.poll_timeout_secs,
            )
        });

        Self {
            openai,
            anthropic,
            local,
            openrouter,
            core,
            modal,
            genai,
            replicate,
            fal,
        }
    }

    pub fn get(&self, kind: &ProviderKind) -> Option<&dyn Provider> {
        match kind {
            ProviderKind::OpenAi => self.openai.as_ref().map(|p| p as &dyn Provider),
            ProviderKind::Anthropic => self.anthropic.as_ref().map(|p| p as &dyn Provider),
            ProviderKind::Local => self.local.as_ref().map(|p| p as &dyn Provider),
            ProviderKind::OpenRouter => self.openrouter.as_ref().map(|p| p as &dyn Provider),
            ProviderKind::Core => self.core.as_ref().map(|p| p as &dyn Provider),
            ProviderKind::Modal => self.modal.as_ref().map(|p| p as &dyn Provider),
            ProviderKind::GenAi => self.genai.as_ref().map(|p| p as &dyn Provider),
            ProviderKind::Replicate => self.replicate.as_ref().map(|p| p as &dyn Provider),
            ProviderKind::Fal => self.fal.as_ref().map(|p| p as &dyn Provider),
        }
    }

    pub fn available_providers(&self) -> Vec<ProviderKind> {
        let mut out = Vec::new();
        if self.openai.is_some() {
            out.push(ProviderKind::OpenAi);
        }
        if self.anthropic.is_some() {
            out.push(ProviderKind::Anthropic);
        }
        if self.local.is_some() {
            out.push(ProviderKind::Local);
        }
        if self.openrouter.is_some() {
            out.push(ProviderKind::OpenRouter);
        }
        if self.core.is_some() {
            out.push(ProviderKind::Core);
        }
        if self.modal.is_some() {
            out.push(ProviderKind::Modal);
        }
        if self.genai.is_some() {
            out.push(ProviderKind::GenAi);
        }
        if self.replicate.is_some() {
            out.push(ProviderKind::Replicate);
        }
        if self.fal.is_some() {
            out.push(ProviderKind::Fal);
        }
        out
    }
}

fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .expect("failed to build HTTP client")
}

// ─── Shared helpers used by individual provider modules ──────────────────────

/// Build a `/v1/chat/completions` URL from a base URL.
pub(super) fn chat_completions_url(base_url: &str) -> String {
    format!("{}/chat/completions", base_url.trim_end_matches('/'))
}

/// Fetch `GET {base}/models` from an OpenAI-compatible endpoint and return its
/// `data[]` model objects. `api_key` may be empty (e.g. a local Ollama server).
/// Discovery-only: a short 6 s timeout and any error / timeout / non-2xx /
/// empty result yields `None` so the caller falls back to the static list. Never
/// panics or propagates an error — `/v1/models` must stay infallible.
pub(super) async fn discover_openai_models(
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
pub(super) fn models_from_response(json: Value) -> Option<Vec<Value>> {
    let data = json.get("data")?.as_array()?;
    let models: Vec<Value> = data
        .iter()
        .filter(|m| m.get("id").and_then(Value::as_str).is_some())
        .cloned()
        .collect();
    (!models.is_empty()).then_some(models)
}

/// Check a streaming response for a non-2xx status and return an error.
pub(super) async fn check_stream_status(
    resp: reqwest::Response,
    provider: &str,
) -> Result<reqwest::Response, GatewayError> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    Err(GatewayError::ProviderError(format!(
        "{provider} stream error {status}: {body}"
    )))
}

/// Check a completed response for a non-2xx status, parse and return the JSON body.
pub(super) async fn check_response_status(
    resp: reqwest::Response,
    provider: &str,
) -> Result<Value, GatewayError> {
    let status = resp.status();
    let json: Value = resp.json().await.map_err(|e| {
        GatewayError::ProviderError(format!("{provider} response parse error: {e}"))
    })?;

    if status.is_success() {
        return Ok(json);
    }

    let msg = json["error"]["message"]
        .as_str()
        .unwrap_or("unknown error")
        .to_string();
    tracing::warn!(provider, status = %status, error = %msg, "provider returned error");
    Err(GatewayError::ProviderError(format!(
        "{provider} error {status}: {msg}"
    )))
}

/// Retry a fallible `reqwest` send closure up to `max_retries` times on
/// transient errors (5xx or connection failure), with exponential back-off
/// (1 s, 2 s, 4 s, …).  4xx errors are not retried.
pub(super) async fn send_with_retry(
    make_request: impl Fn() -> Pin<
        Box<dyn std::future::Future<Output = Result<reqwest::Response, reqwest::Error>> + Send>,
    >,
    provider: &str,
    max_retries: u32,
) -> Result<reqwest::Response, GatewayError> {
    let mut attempt = 0u32;
    loop {
        match make_request().await {
            Ok(resp) if resp.status().is_server_error() => {
                if attempt >= max_retries {
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    return Err(GatewayError::ProviderError(format!(
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
                    return Err(GatewayError::ProviderError(format!(
                        "{provider} connection error after {attempt} retries: {e}"
                    )));
                }
                let delay = Duration::from_secs(1u64 << attempt);
                warn!(provider, attempt, ?delay, error = %e, "connection error, retrying");
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
            Err(e) => {
                return Err(GatewayError::ProviderError(format!(
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
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, GatewayError>> + Send + 'a>>;

    /// Streaming completion. Returns a raw SSE byte stream.
    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, GatewayError>> + Send + 'a>>;

    /// Image generation. `body` follows the OpenAI `/v1/images/generations` shape.
    /// Returns the full response JSON. Default implementation returns an error so
    /// providers that don't support image-gen don't need to implement it.
    fn generate_image<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, GatewayError>> + Send + 'a>> {
        let name = self.name();
        Box::pin(async move {
            Err(GatewayError::ProviderError(format!(
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
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, GatewayError>> + Send + 'a>> {
        let name = self.name();
        Box::pin(async move {
            Err(GatewayError::ProviderError(format!(
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
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, GatewayError>> + Send + 'a>> {
        let name = self.name();
        Box::pin(async move {
            Err(GatewayError::ProviderError(format!(
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
    ) -> Pin<Box<dyn std::future::Future<Output = Result<VideoJob, GatewayError>> + Send + 'a>> {
        let name = self.name();
        Box::pin(async move {
            Err(GatewayError::ProviderError(format!(
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
    ) -> Pin<Box<dyn std::future::Future<Output = Result<VideoJob, GatewayError>> + Send + 'a>> {
        let name = self.name();
        Box::pin(async move {
            Err(GatewayError::ProviderError(format!(
                "{name} does not support video generation"
            )))
        })
    }
}

// ─── Helper: build endpoint URLs for multimodal routes ───────────────────────

/// Build an `/v1/images/generations` URL from a base URL.
pub(super) fn images_url(base_url: &str) -> String {
    format!("{}/images/generations", base_url.trim_end_matches('/'))
}

/// Build an `/v1/audio/speech` URL from a base URL.
pub(super) fn audio_speech_url(base_url: &str) -> String {
    format!("{}/audio/speech", base_url.trim_end_matches('/'))
}

/// Build an `/v1/audio/transcriptions` URL from a base URL.
pub(super) fn audio_transcriptions_url(base_url: &str) -> String {
    format!("{}/audio/transcriptions", base_url.trim_end_matches('/'))
}

// ─── Shared media-output normalization (cloud media providers) ────────────────

/// Normalize an arbitrary provider media `output` (a URL string, a list of URLs,
/// or a nested object like `{ images: [{ url }] }`) into the OpenAI-ish
/// `{ "data": [{ "url": … }], "raw": <original> }` shape the desktop clients
/// render. `raw` preserves the full provider output for callers that need it.
pub(super) fn normalize_media_output(output: &Value) -> Value {
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
        let out =
            normalize_media_output(&json!({ "images": [{ "url": "https://x/i.png", "width": 512 }] }));
        assert_eq!(out["data"][0]["url"], json!("https://x/i.png"));
    }

    #[test]
    fn dedupes_repeated_urls() {
        let out = normalize_media_output(&json!({ "video": { "url": "https://x/v.mp4" }, "url": "https://x/v.mp4" }));
        assert_eq!(out["data"].as_array().unwrap().len(), 1);
    }
}
