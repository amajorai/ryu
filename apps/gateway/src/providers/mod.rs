pub mod anthropic;
pub mod core;
pub mod genai;
pub mod local;
pub mod modal;
pub mod openai;
pub mod openrouter;

use std::pin::Pin;
use std::time::Duration;

use axum::body::Body;
use serde_json::Value;
use tracing::warn;

use crate::{
    config::{ProviderKind, ProvidersConfig},
    error::GatewayError,
};

pub use anthropic::AnthropicProvider;
pub use core::CoreProvider;
pub use genai::GenAiProvider;
pub use local::LocalProvider;
pub use modal::ModalProvider;
pub use openai::OpenAiProvider;
pub use openrouter::OpenRouterProvider;

pub struct ProviderRegistry {
    openai: Option<OpenAiProvider>,
    anthropic: Option<AnthropicProvider>,
    local: Option<LocalProvider>,
    openrouter: Option<OpenRouterProvider>,
    core: Option<CoreProvider>,
    modal: Option<ModalProvider>,
    genai: Option<GenAiProvider>,
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
            OpenRouterProvider::new(
                client.clone(),
                c.api_key.clone(),
                c.base_url.clone(),
                c.site_url.clone(),
                c.site_name.clone(),
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

        Self {
            openai,
            anthropic,
            local,
            openrouter,
            core,
            modal,
            genai,
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
