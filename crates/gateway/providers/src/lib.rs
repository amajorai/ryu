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

mod response_body;
use response_body::BoundedResponse;
mod account_pool;
mod audio;
pub use audio::{BoundSpeech, HostedSpeechOrigin};
pub mod anthropic;
pub mod assemblyai;
pub mod batches;
pub mod bfl;
pub mod cohere;
pub mod core;
pub mod deepgram;
pub mod edge_tts;
pub mod egress;
pub mod elevenlabs;
pub mod error;
pub mod fal;
pub mod genai;
pub mod google_translate_tts;
pub mod google_tts;
pub mod inworld;
pub mod jobs;
pub mod kiro;
pub mod local;
pub mod minimax;
pub mod modal;
pub mod openai;
pub mod openrouter;
pub mod polly;
pub mod prompt_cache;
pub mod qoder;
pub mod quota;
pub mod qwen;
pub mod recraft;
pub mod replicate;
pub mod runway;
pub mod safety_signals;
pub mod stability;
pub mod topaz;
pub mod trace_context;
pub mod vercel;
pub mod web;

use std::pin::Pin;
use std::time::Duration;

use axum::body::Body;
use reqwest::header::HeaderMap;
use serde_json::Value;
use tracing::warn;

pub use anthropic::AnthropicProvider;
pub use assemblyai::AssemblyAiProvider;
pub use batches::{
    BatchCreateRequest, BatchListQuery, BatchProvider, BatchProviderError, BatchProviderRouting,
    BatchRequestItem, BATCH_ENDPOINTS,
};
pub use bfl::BflProvider;
pub use cohere::CohereProvider;
pub use core::CoreProvider;
pub use deepgram::DeepgramProvider;
pub use edge_tts::EdgeTtsProvider;
pub use egress::EgressClientPool;
pub use elevenlabs::ElevenLabsProvider;
pub use error::ProviderError;
pub use fal::FalProvider;
pub use genai::{sdk_descriptor_for_model, GenAiProvider};
pub use google_translate_tts::GoogleTranslateTtsProvider;
pub use google_tts::{GoogleTtsAccount, GoogleTtsProvider};
pub use inworld::InworldProvider;
pub use jobs::{JobStatus, VideoJob};
pub use kiro::{KiroAccount, KiroAuthMethod, KiroProvider};
pub use safety_signals::{SafetyScope, SafetySignal};

/// Which job-based media a queued submission produces. Video and generated
/// audio (music, sound effects) share one queued-job contract: a provider
/// accepts the job, returns a private polling capability, and the normalized
/// output carries `{ data: [{ url }] }` for whatever media the model returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MediaJobKind {
    /// Video generation (`/v1/videos/generations`).
    Video,
    /// Audio generation: music or sound effects (`/v1/audio/generations`).
    Audio,
}

impl MediaJobKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaJobKind::Video => "video",
            MediaJobKind::Audio => "audio",
        }
    }
}

/// The accepted handle of any queued media job. Named for video because video
/// was the first job-based modality; audio jobs reuse the same shape.
pub type AcceptedMediaJob = AcceptedVideo;

/// Accepted work retains only its private polling capability. Never serialize it.
pub struct AcceptedVideo {
    pub initial: VideoJob,
    pub origin: std::sync::Arc<dyn VideoPollOrigin>,
}

pub type VideoPollFuture<'a> =
    Pin<Box<dyn std::future::Future<Output = Result<VideoJob, VideoPollError>> + Send + 'a>>;

pub trait VideoPollOrigin: Send + Sync {
    fn poll(&self) -> VideoPollFuture<'_>;
}

/// A failed poll cannot establish that accepted upstream generation terminated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoPollError {
    CredentialRejected,
    TransportUnavailable,
    RateLimited { retry_after: Option<u64> },
    UpstreamUnavailable,
    InvalidResponse,
}

impl std::fmt::Display for VideoPollError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::CredentialRejected => "origin credential was rejected",
            Self::TransportUnavailable => "origin transport is unavailable",
            Self::RateLimited { .. } => "origin polling is rate limited",
            Self::UpstreamUnavailable => "origin polling is unavailable",
            Self::InvalidResponse => "origin polling response is invalid",
        })
    }
}
impl std::error::Error for VideoPollError {}

pub(crate) async fn video_poll_response(
    request: reqwest::RequestBuilder,
) -> Result<reqwest::Response, VideoPollError> {
    let response = request
        .send()
        .await
        .map_err(|_| VideoPollError::TransportUnavailable)?;
    match response.status().as_u16() {
        200..=299 => Ok(response),
        401 | 403 => Err(VideoPollError::CredentialRejected),
        407 => Err(VideoPollError::TransportUnavailable),
        429 => Err(VideoPollError::RateLimited {
            retry_after: parse_rate_limit(response.headers()).and_then(|value| value.retry_after),
        }),
        _ => Err(VideoPollError::UpstreamUnavailable),
    }
}

pub(crate) async fn video_poll_json(
    mut response: reqwest::Response,
) -> Result<Value, VideoPollError> {
    let mut bytes = Vec::new();
    const MAX_JSON: usize = 4 * 1024 * 1024;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| VideoPollError::InvalidResponse)?
    {
        if chunk.len() > MAX_JSON.saturating_sub(bytes.len()) {
            return Err(VideoPollError::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| VideoPollError::InvalidResponse)
}
pub use account_pool::AccountSelectionStrategy;
pub use local::LocalProvider;
pub use minimax::MiniMaxProvider;
pub use modal::ModalProvider;
pub use openai::OpenAiProvider;
pub use openrouter::{OpenRouterOptions, OpenRouterProvider};
pub use polly::{PollyAccount, PollyProvider};
pub use prompt_cache::{
    PromptCacheDialect, PromptCacheMode, PromptCacheOptions, PromptCacheOutcome, PromptCacheRequest,
};
pub use qoder::{QoderProvider, QoderRegion};
pub use quota::{ProviderQuotas, RateLimitInfo};
pub use qwen::QwenProvider;
pub use recraft::RecraftProvider;
pub use replicate::ReplicateProvider;
pub use runway::RunwayProvider;
pub use ryu_gw_credentials::ProviderAccountPolicy;
pub use stability::StabilityProvider;
pub use topaz::TopazProvider;
pub use vercel::{ResalePermission, VercelProvider};

// ─── Shared helpers used by individual provider modules ──────────────────────

/// Build a `/v1/chat/completions` URL from a base URL.
pub(crate) fn chat_completions_url(base_url: &str) -> String {
    format!("{}/chat/completions", base_url.trim_end_matches('/'))
}

/// Older OpenAI-compatible local/vLLM servers accept only `max_tokens`.
/// Normalize the current Chat Completions spelling at those provider edges.
pub(crate) fn normalize_legacy_completion_token_limit(body: &mut Value) {
    if let Some(object) = body.as_object_mut() {
        if let Some(limit) = object.remove("max_completion_tokens") {
            object.insert("max_tokens".to_owned(), limit);
        }
    }
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
    discover_openai_models_at(client, &url, api_key).await
}

/// [`discover_openai_models`] against an explicit catalog URL, for upstreams
/// whose default `/models` listing hides part of the catalog behind a query.
pub(crate) async fn discover_openai_models_at(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
) -> Option<Value> {
    let mut req = client.get(url).timeout(Duration::from_secs(6));
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }
    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    Some(resp.bounded_json::<Value>().await.ok()?)
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

/// A complete, same-window pair for choosing between accounts. The general
/// metrics parser intentionally retains partial fields, but combining a token
/// remaining count with a request limit would invent a false usage percentage.
pub(crate) fn parse_account_quota(headers: &HeaderMap) -> Option<RateLimitInfo> {
    let pairs = [
        (
            "x-ratelimit-remaining-tokens",
            "x-ratelimit-limit-tokens",
            "x-ratelimit-reset-tokens",
        ),
        (
            "x-ratelimit-remaining-requests",
            "x-ratelimit-limit-requests",
            "x-ratelimit-reset-requests",
        ),
        (
            "anthropic-ratelimit-tokens-remaining",
            "anthropic-ratelimit-tokens-limit",
            "anthropic-ratelimit-tokens-reset",
        ),
        (
            "anthropic-ratelimit-input-tokens-remaining",
            "anthropic-ratelimit-input-tokens-limit",
            "anthropic-ratelimit-input-tokens-reset",
        ),
        (
            "anthropic-ratelimit-output-tokens-remaining",
            "anthropic-ratelimit-output-tokens-limit",
            "anthropic-ratelimit-output-tokens-reset",
        ),
        (
            "anthropic-ratelimit-requests-remaining",
            "anthropic-ratelimit-requests-limit",
            "anthropic-ratelimit-requests-reset",
        ),
        (
            "x-ratelimit-remaining",
            "x-ratelimit-limit",
            "x-ratelimit-reset",
        ),
    ];
    for (remaining_header, limit_header, reset_header) in pairs {
        let remaining = header_u64(headers, &[remaining_header]);
        let limit = header_u64(headers, &[limit_header]);
        if let (Some(remaining), Some(limit)) = (remaining, limit) {
            if limit > 0 {
                let retry_after = header_u64(headers, &["retry-after"]);
                return Some(RateLimitInfo {
                    remaining: Some(remaining),
                    limit: Some(limit),
                    reset_at: headers
                        .get(reset_header)
                        .and_then(|value| value.to_str().ok())
                        .and_then(parse_quota_reset)
                        .or_else(|| retry_after.map(|seconds| now_secs().saturating_add(seconds))),
                    retry_after,
                });
            }
        }
    }
    None
}

/// Organization identity is a conservative quota domain: keys in the same
/// organization can share a limiter even when their individual keys differ.
/// Never publish this header as account metadata or a metrics label.
pub(crate) fn parse_quota_domain(headers: &HeaderMap) -> Option<&str> {
    ["anthropic-organization-id", "openai-organization"]
        .iter()
        .find_map(|name| headers.get(*name).and_then(|value| value.to_str().ok()))
        .filter(|domain| {
            !domain.is_empty() && domain.len() <= 128 && !domain.chars().any(char::is_control)
        })
}

fn parse_quota_reset(value: &str) -> Option<u64> {
    let value = value.trim();
    if let Ok(date) = chrono::DateTime::parse_from_rfc3339(value) {
        return u64::try_from(date.timestamp()).ok();
    }
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(now_secs().saturating_add(seconds));
    }
    let mut remaining = value;
    let mut seconds = 0_u64;
    let mut saw_unit = false;
    while !remaining.is_empty() {
        let digit_count = remaining.bytes().take_while(u8::is_ascii_digit).count();
        if digit_count == 0 {
            return None;
        }
        let number = remaining[..digit_count].parse::<u64>().ok()?;
        remaining = &remaining[digit_count..];
        let (factor, length) = if remaining.starts_with('d') {
            (86_400, 1)
        } else if remaining.starts_with('h') {
            (3_600, 1)
        } else if remaining.starts_with('m') && !remaining.starts_with("ms") {
            (60, 1)
        } else if remaining.starts_with('s') {
            (1, 1)
        } else if remaining.starts_with("ms") {
            // Round a fractional second up so an account is not reused early.
            seconds = seconds.checked_add(u64::from(number > 0))?;
            remaining = &remaining[2..];
            saw_unit = true;
            continue;
        } else {
            return None;
        };
        seconds = seconds.checked_add(number.checked_mul(factor)?)?;
        remaining = &remaining[length..];
        saw_unit = true;
    }
    saw_unit.then(|| now_secs().saturating_add(seconds))
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
    let body = resp.bounded_text().await.unwrap_or_default();
    if status == reqwest::StatusCode::PAYMENT_REQUIRED {
        return Err(ProviderError::PaymentRequired {
            provider: provider.to_owned(),
            message: provider_error_message(&body),
        });
    }
    Err(upstream_body_error(
        provider,
        status,
        &body,
        format!("{provider} stream error {status}: {body}"),
    ))
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
        let _ = resp.bounded_text().await;
        tracing::warn!(provider, status = %status, "provider rate limited (429)");
        return Err(ProviderError::RateLimited {
            provider: provider.to_string(),
            retry_after,
            reset_at,
        });
    }

    if status.is_success() {
        let json: Value = resp.bounded_json().await.map_err(|e| {
            ProviderError::Provider(format!("{provider} response parse error: {e}"))
        })?;
        if let (Some(q), Some(info)) = (quota, rate_limit.as_ref()) {
            q.record_success(provider, info);
        }
        return Ok(json);
    }

    // An error body is classified by its status, never by whether it parses: a
    // 400 answered with HTML or plain text is still this request's rejection,
    // not a provider fault.
    let body = resp.bounded_text().await.unwrap_or_default();
    let msg = error_body_message(&body);
    tracing::warn!(provider, status = %status, "provider returned error");
    if status == reqwest::StatusCode::PAYMENT_REQUIRED {
        return Err(ProviderError::PaymentRequired {
            provider: provider.to_owned(),
            message: msg,
        });
    }
    Err(upstream_body_error(
        provider,
        status,
        &body,
        format!("{provider} error {status}: {msg}"),
    ))
}

/// Statuses that refuse the request itself rather than signal a passing
/// provider fault: every 4xx except 402 (payment, its own variant), 408 (a
/// timeout, which is a health fault) and 429 (capacity, its own variant). A 403
/// is a rejection because an upstream refuses content with it; whether a 401
/// also counts against the provider's health is the gateway's decision, made
/// from the carried status.
pub(crate) fn is_request_rejection(status: reqwest::StatusCode) -> bool {
    status.is_client_error() && !matches!(status.as_u16(), 402 | 408 | 429)
}

/// The statuses that MAY refuse an account's credential rather than the
/// request; [`is_account_auth_failure`] decides from the body.
pub(crate) fn is_credential_status(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
    )
}

/// `error.type` / `error.code` values that name a problem with the key or its
/// account rather than with the request:
/// - Anthropic `authentication_error` ("There's an issue with your API key").
///   Its `permission_error` is deliberately absent: it reports that the key may
///   not use the requested resource (a model or beta not enabled), which is
///   about the request.
/// - OpenAI-compatible `invalid_api_key`, `account_deactivated`,
///   `insufficient_quota` and `billing_not_active`.
const KEY_REFUSAL_ERROR_CODES: &[&str] = &[
    "authentication_error",
    "invalid_api_key",
    "account_deactivated",
    "insufficient_quota",
    "billing_not_active",
];

/// Google (`generativelanguage`) `error.details[].reason` values that refuse
/// the key or its project rather than the request.
const KEY_REFUSAL_GOOGLE_REASONS: &[&str] = &[
    "API_KEY_INVALID",
    "API_KEY_SERVICE_BLOCKED",
    "SERVICE_DISABLED",
];

/// Whether an upstream answer refuses one account's credential (a revoked,
/// expired or unauthorized key) rather than the request. A multi-account chat
/// adapter tries its next key on these and cools the refused one; see
/// [`AccountPool::record_auth_failure`].
///
/// A 401 always refuses the credential. A 403 does only when its error body
/// names a key or account problem ([`KEY_REFUSAL_ERROR_CODES`],
/// [`KEY_REFUSAL_GOOGLE_REASONS`]): providers also answer 403 for refusals of
/// the request itself (a model or beta the key may not use, an unsupported
/// region, flagged content), and rotating on those would walk and cool every
/// key for a request no key can serve.
///
/// [`AccountPool::record_auth_failure`]: account_pool::AccountPool::record_auth_failure
pub(crate) fn is_account_auth_failure(status: reqwest::StatusCode, body: &str) -> bool {
    match status {
        reqwest::StatusCode::UNAUTHORIZED => true,
        reqwest::StatusCode::FORBIDDEN => error_body_refuses_key(body),
        _ => false,
    }
}

fn error_body_refuses_key(body: &str) -> bool {
    let Ok(json) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    // Google answers some errors as a one-element array.
    let error = match &json {
        Value::Array(items) => items.first().map_or(&Value::Null, |item| &item["error"]),
        other => &other["error"],
    };
    let names_key_problem = |value: &Value| {
        value
            .as_str()
            .is_some_and(|name| KEY_REFUSAL_ERROR_CODES.contains(&name))
    };
    names_key_problem(&error["type"])
        || names_key_problem(&error["code"])
        || error["details"].as_array().is_some_and(|details| {
            details.iter().any(|detail| {
                detail["reason"]
                    .as_str()
                    .is_some_and(|reason| KEY_REFUSAL_GOOGLE_REASONS.contains(&reason))
            })
        })
}

/// Read a 401/403 answer into the error the status checks build for it
/// ([`check_response_status`], or [`check_stream_status`] when `stream`), and
/// whether it refuses the account's credential ([`is_account_auth_failure`]).
/// Adapters that rotate keys read the body here because the status checks keep
/// only the human message, not the error type or code.
pub(crate) async fn read_credential_refusal(
    resp: reqwest::Response,
    provider: &str,
    stream: bool,
) -> (ProviderError, bool) {
    let status = resp.status();
    let body = resp.bounded_text().await.unwrap_or_default();
    let message = if stream {
        format!("{provider} stream error {status}: {body}")
    } else {
        tracing::warn!(provider, status = %status, "provider returned error");
        format!("{provider} error {status}: {}", error_body_message(&body))
    };
    upstream_error_with_key_refusal(provider, status, &body, message)
}

/// The error for a non-2xx answer whose body was read, and whether it refuses
/// the account's credential ([`is_account_auth_failure`]). A refused credential
/// is a fault of the account, never a refusal of the request's content, so the
/// safety table is not consulted for it. A 403 that names a key problem counts
/// toward the provider's health like any provider fault; a 401 carries its
/// status for the gateway. Every other answer takes [`upstream_body_error`].
pub(crate) fn upstream_error_with_key_refusal(
    provider: &str,
    status: reqwest::StatusCode,
    body: &str,
    message: String,
) -> (ProviderError, bool) {
    if !is_account_auth_failure(status, body) {
        return (upstream_body_error(provider, status, body, message), false);
    }
    let error = if status == reqwest::StatusCode::FORBIDDEN {
        ProviderError::Provider(message)
    } else {
        upstream_status_error(status, message)
    };
    (error, true)
}

/// The error for a non-2xx upstream status that is neither a 429 nor a 402.
/// Every adapter that checks status itself must use this rather than build
/// [`ProviderError::Provider`] directly: a request rejection (see
/// [`is_request_rejection`]) becomes [`ProviderError::Rejected`], which the
/// gateway does not count toward the provider circuit shared by every tenant.
pub(crate) fn upstream_status_error(status: reqwest::StatusCode, message: String) -> ProviderError {
    if is_request_rejection(status) {
        ProviderError::Rejected {
            status: status.as_u16(),
            message,
        }
    } else {
        ProviderError::Provider(message)
    }
}

/// [`upstream_status_error`] for an error whose body was read: a body that
/// matches a row of the safety-signal table ([`safety_signals::classify`])
/// becomes [`ProviderError::SafetyRefused`]; anything else keeps the status
/// classification. Every adapter that reads an error body uses this, so the
/// table is consulted in one place.
pub(crate) fn upstream_body_error(
    provider: &str,
    status: reqwest::StatusCode,
    body: &str,
    message: String,
) -> ProviderError {
    if is_request_rejection(status) {
        if let Some(signal) = safety_signals::classify(provider, status.as_u16(), body) {
            tracing::warn!(
                provider,
                status = %status,
                row = signal.row,
                scope = signal.scope.as_str(),
                "provider refused the request for a safety reason"
            );
            return ProviderError::SafetyRefused {
                provider: provider.to_owned(),
                status: status.as_u16(),
                scope: signal.scope,
                row: signal.row,
                code: signal.code,
                message,
            };
        }
    }
    upstream_status_error(status, message)
}

/// The human message of a non-2xx body: an OpenAI-style `error.message`, else
/// `unknown error` (also for a body that is not JSON at all; its raw text is
/// not surfaced, matching the completed-response path before this helper).
pub(crate) fn error_body_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|json| json["error"]["message"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown error".to_owned())
}

/// Chat completions run before their response is decoded: a 2xx whose body
/// cannot be read or parsed was already generated (and billed) upstream, so it
/// must not be replayed on a fallback provider. Non-2xx statuses keep the
/// [`check_response_status`] classification.
pub(crate) async fn check_completion_response(
    resp: reqwest::Response,
    provider: &str,
    quota: Option<&ProviderQuotas>,
) -> Result<Value, ProviderError> {
    let accepted = resp.status().is_success();
    check_response_status(resp, provider, quota)
        .await
        .map_err(|error| {
            if accepted {
                ProviderError::DeliveryUncertain(format!(
                    "{provider} accepted response could not be decoded"
                ))
            } else {
                error
            }
        })
}

/// Classify a failed single-shot inference send. Only a connection that was
/// never established is safe to replay on another provider; a timeout or
/// mid-request transport failure may have reached a generation that is still
/// running upstream.
pub(crate) fn classify_send_error(context: &str, error: &reqwest::Error) -> ProviderError {
    if error.is_connect() {
        ProviderError::Transport(format!("{context}: connection failed"))
    } else if error.is_timeout() || error.is_request() {
        ProviderError::DeliveryUncertain(format!("{context}: delivery is uncertain"))
    } else {
        ProviderError::Provider(format!("{context}: {error}"))
    }
}

/// Pull a provider's human message from an error body without losing a plain
/// text response. Streaming status checks have not parsed JSON yet, unlike the
/// completed-response path above.
fn provider_error_message(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|json| json["error"]["message"].as_str().map(str::to_owned))
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| {
            let trimmed = body.trim();
            if trimmed.is_empty() {
                "payment or provider credits required".to_owned()
            } else {
                trimmed.to_owned()
            }
        })
}

/// Check a completed **audio** response and normalize it to the JSON audio
/// envelope Core consumes:
///
/// ```json
/// { "object": "audio",
///   "data": [{ "b64_json": "<base64>", "content_type": "audio/wav" }],
///   "raw": null }
/// ```
///
/// A sibling of [`check_response_status`] rather than a change to it: that
/// function is shared by chat, image, STT and video and parses JSON
/// unconditionally, which is exactly the bug here — `POST /v1/audio/speech`
/// answers with raw `audio/*` bytes, so every real synthesis died as
/// "`{provider}` response parse error". The 429 arm is kept byte-identical
/// because the circuit breaker and the fallback chain key off the typed
/// [`ProviderError::RateLimited`].
///
/// Providers that answer in JSON (an OpenAI-compatible relay returning
/// `{"audio": "<b64>"}`, or an error body) are passed through verbatim — their
/// JSON text is never base64'd as if it were audio.
pub(crate) async fn audio_response_to_envelope(
    resp: reqwest::Response,
    provider: &str,
    quota: Option<&ProviderQuotas>,
) -> Result<Value, ProviderError> {
    use base64::Engine as _;

    let status = resp.status();
    let rate_limit = parse_rate_limit(resp.headers());

    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry_after = rate_limit.as_ref().and_then(|r| r.retry_after);
        let reset_at = rate_limit.as_ref().and_then(|r| r.reset_at);
        if let Some(q) = quota {
            q.record_rate_limited(provider, retry_after, reset_at);
        }
        // Drain the body best-effort for the log; it is not surfaced to the caller.
        let _ = resp.bounded_text().await;
        tracing::warn!(provider, status = %status, "provider rate limited (429)");
        return Err(ProviderError::RateLimited {
            provider: provider.to_string(),
            retry_after,
            reset_at,
        });
    }

    // Capture the content type BEFORE the body is consumed.
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    if !status.is_success() {
        // Errors are JSON (or text) even on an audio endpoint. Lift
        // `error.message` when it is there, else surface the raw body.
        let body = resp.bounded_text().await.unwrap_or_default();
        let msg = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| body.trim().to_string());
        tracing::warn!(provider, status = %status, "provider returned error");
        return Err(upstream_status_error(
            status,
            format!("{provider} error {status}: {msg}"),
        ));
    }

    if let (Some(q), Some(info)) = (quota, rate_limit.as_ref()) {
        q.record_success(provider, info);
    }

    if content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .eq_ignore_ascii_case("application/json")
    {
        return resp
            .bounded_json()
            .await
            .map_err(|e| ProviderError::Provider(format!("{provider} response parse error: {e}")));
    }

    let bytes = resp
        .bounded_bytes()
        .await
        .map_err(|e| ProviderError::Provider(format!("{provider} audio read error: {e}")))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let ct = if content_type.is_empty() {
        "audio/mpeg".to_string()
    } else {
        content_type
    };
    Ok(serde_json::json!({
        "object": "audio",
        "data": [{ "b64_json": b64, "content_type": ct }],
        "raw": Value::Null,
    }))
}

/// Total deadline for one streamed completion. Provider clients keep a 300 s
/// total for non-streaming calls, which would cut a long agentic or
/// extended-thinking stream mid-answer even while it is still producing tokens.
pub const STREAM_TOTAL_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);

/// Inactivity bound for provider HTTP clients: time to the response head, then
/// between body reads. It equals the former 300 s total, so silent reasoning
/// phases and non-streaming time-to-first-byte do not regress, and a stalled
/// stream still fails under [`STREAM_TOTAL_TIMEOUT`].
pub const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(300);

/// Lift the client's total timeout to [`STREAM_TOTAL_TIMEOUT`] for a streamed
/// completion request. Build the request inside the send closure so the
/// override also applies to an egress-pool client. The client's
/// `read_timeout` ([`STREAM_READ_TIMEOUT`]) still fails a stalled upstream.
pub fn streaming_request(builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    builder.timeout(STREAM_TOTAL_TIMEOUT)
}

/// Retry a fallible `reqwest` send closure up to `max_retries` times, with
/// exponential back-off (1 s, 2 s, 4 s, …), only where the upstream cannot have
/// run the request: a connection that was never established, or a 502/503
/// gateway rejection. Inference is never replayed after the connection was
/// established: a timeout or mid-request transport failure returns
/// [`ProviderError::DeliveryUncertain`] at once, because the upstream may still
/// be generating (and billing) the first attempt. Other 5xx statuses (500, 504,
/// Cloudflare 524) and 4xx errors are returned without retry.
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
                let status = resp.status();
                if attempt >= max_retries || !is_replay_safe_server_status(status) {
                    trace_context::observe_status(status);
                    let text = resp.bounded_text().await.unwrap_or_default();
                    return Err(ProviderError::Provider(format!(
                        "{provider} error {status} after {attempt} retries: {text}"
                    )));
                }
                let delay = Duration::from_secs(1u64 << attempt);
                warn!(provider, attempt, ?delay, %status, "transient gateway rejection, retrying");
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
            Ok(resp) => {
                trace_context::observe_status(resp.status());
                return Ok(resp);
            }
            Err(e) if e.is_connect() => {
                if attempt >= max_retries {
                    return Err(ProviderError::Transport(format!(
                        "{provider} connection error after {attempt} retries"
                    )));
                }
                let delay = Duration::from_secs(1u64 << attempt);
                warn!(provider, attempt, ?delay, "connection error, retrying");
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
            Err(e) if e.is_timeout() || e.is_request() => {
                return Err(ProviderError::DeliveryUncertain(format!(
                    "{provider} request delivery is uncertain"
                )));
            }
            Err(e) => {
                return Err(ProviderError::Provider(format!(
                    "{provider} request failed: {e}"
                )));
            }
        }
    }
}

/// 502/503 are gateway or overload rejections that conventionally mean the
/// origin did not run the request, so an in-place retry should not double-bill.
/// 500, 504 and Cloudflare 524 may follow an origin that is still generating.
fn is_replay_safe_server_status(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::BAD_GATEWAY | reqwest::StatusCode::SERVICE_UNAVAILABLE
    )
}

// ─── Provider trait ───────────────────────────────────────────────────────────

/// Successful service work may already be billable even if decoding fails.
pub(crate) async fn check_service_response(
    response: reqwest::Response,
    provider: &str,
    quota: Option<&ProviderQuotas>,
) -> Result<Value, ProviderError> {
    if response.status().is_server_error()
        || response.status() == reqwest::StatusCode::REQUEST_TIMEOUT
    {
        return Err(ProviderError::DeliveryUncertain(format!(
            "{provider} service request failed without a definitive rejection"
        )));
    }
    let accepted = response.status().is_success();
    check_response_status(response, provider, quota)
        .await
        .map_err(|error| {
            if accepted {
                ProviderError::DeliveryUncertain(format!(
                    "{provider} accepted service response could not be decoded"
                ))
            } else {
                error
            }
        })
}

pub(crate) async fn service_audio_response(
    response: reqwest::Response,
    provider: &str,
    quota: Option<&ProviderQuotas>,
) -> Result<Value, ProviderError> {
    let accepted = response.status().is_success();
    audio_response_to_envelope(response, provider, quota)
        .await
        .map_err(|error| {
            if accepted {
                ProviderError::DeliveryUncertain(format!(
                    "{provider} accepted audio response could not be decoded"
                ))
            } else {
                error
            }
        })
}

/// Common interface implemented by every backend provider.
pub trait Provider: Send + Sync {
    fn name(&self) -> &'static str;

    /// Direct service capabilities are separate from inference models.
    fn web_descriptor(&self) -> Option<&'static ryu_gw_credentials::web::WebProviderDescriptor> {
        None
    }

    fn web_search_for_session<'a>(
        &'a self,
        _request: &'a web::WebSearchRequest,
        _session: Option<&'a str>,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<web::WebSearchOutput, ProviderError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async {
            Err(ProviderError::Provider(
                "Provider does not support web search".to_owned(),
            ))
        })
    }

    fn web_fetch_for_session<'a>(
        &'a self,
        _request: &'a web::WebFetchRequest,
        _session: Option<&'a str>,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<web::WebFetchOutput, ProviderError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async {
            Err(ProviderError::Provider(
                "Provider does not support web fetch".to_owned(),
            ))
        })
    }

    /// Installed by the registry before serving requests, in credential order.
    fn configure_account_policies(&self, _policies: &[ProviderAccountPolicy]) {}

    /// Provider-level strategy for new, unbound API-key requests.
    fn configure_account_strategy(&self, _strategy: AccountSelectionStrategy) {}

    /// Fill-first used-quota percentage at which new sessions leave the
    /// current account. Provider implementations with no account pool ignore it.
    fn configure_fill_first_drain_percent(&self, _percent: u8) {}

    /// A rotating account pool cannot share Gateway response-cache entries
    /// across accounts. Provider-side prompt caching still runs for its pinned
    /// sessions.
    fn has_rotating_accounts(&self) -> bool {
        false
    }

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

    /// A session-aware completion. Providers without account pools keep the
    /// ordinary completion path; rotating providers use `session` to preserve
    /// prompt-cache and Responses continuity across turns.
    fn complete_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        _session: Option<&'a str>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        self.complete(model, body)
    }

    /// Streaming completion. Returns a raw SSE byte stream.
    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>>;

    fn complete_stream_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        _session: Option<&'a str>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        self.complete_stream(model, body)
    }

    /// Generate embeddings. Providers that expose an OpenAI-compatible
    /// embeddings endpoint can override this; other providers remain valid and
    /// report an unsupported operation.
    fn embed<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        let name = self.name();
        Box::pin(async move {
            Err(ProviderError::Provider(format!(
                "{name} does not support embeddings"
            )))
        })
    }

    /// Rerank documents. This is intentionally a separate capability from
    /// chat completion: model routing may select a provider that supports one
    /// without silently pretending to support the other.
    fn rerank<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        let name = self.name();
        Box::pin(async move {
            Err(ProviderError::Provider(format!(
                "{name} does not support reranking"
            )))
        })
    }

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

    /// Captured speech delivery origin is private runtime custody, never JSON.
    fn synthesize_speech_bound<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        _session: Option<&'a str>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<BoundSpeech, ProviderError>> + Send + 'a>>
    {
        Box::pin(async move {
            self.synthesize_speech(model, body)
                .await
                .map(BoundSpeech::inline)
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
    fn submit_video_bound<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<AcceptedVideo, ProviderError>> + Send + 'a>>
    {
        let name = self.name();
        Box::pin(async move {
            Err(ProviderError::Provider(format!(
                "{name} does not support video generation"
            )))
        })
    }

    /// Submit any queued media job. Video defaults to [`Self::submit_video_bound`]
    /// so every existing video provider keeps working unchanged. Audio is opt-in:
    /// only providers whose queue accepts an arbitrary model id with a free-form
    /// input (Fal, Replicate) override this, so a provider with a fixed video
    /// schema (Runway, Topaz, BFL) keeps rejecting audio rather than receiving a
    /// body it would misread.
    fn submit_media_job_bound<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        kind: MediaJobKind,
    ) -> Pin<
        Box<dyn std::future::Future<Output = Result<AcceptedMediaJob, ProviderError>> + Send + 'a>,
    > {
        match kind {
            MediaJobKind::Video => self.submit_video_bound(model, body),
            MediaJobKind::Audio => {
                let name = self.name();
                Box::pin(async move {
                    Err(ProviderError::Provider(format!(
                        "{name} does not support audio generation"
                    )))
                })
            }
        }
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

/// Build an OpenAI-compatible `/v1/embeddings` URL from a provider base URL.
pub(crate) fn embeddings_url(base_url: &str) -> String {
    format!("{}/embeddings", base_url.trim_end_matches('/'))
}

/// Build a `/v1/rerank` URL from a provider base URL.
pub(crate) fn rerank_url(base_url: &str) -> String {
    format!("{}/rerank", base_url.trim_end_matches('/'))
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

/// The per-provider field names carrying billable compute seconds, in the order
/// they are tried.
///
/// Both providers nest theirs under `metrics`, and both mean the same thing —
/// time the model actually ran, excluding queue wait — but they disagree on the
/// leaf name:
///
///  - **Replicate** `metrics.predict_time`: "the amount of CPU or GPU time, in
///    seconds, that the prediction used while running". Present only on a
///    terminated prediction.
///  - **fal** `metrics.inference_time`: "seconds the runner spent processing",
///    present only when the request is `COMPLETED`. fal bills on exactly this —
///    queue time before a runner picks the job up is free — so it is the right
///    number to charge from, not merely the closest one available.
const COMPUTE_SECOND_KEYS: [&str; 2] = ["predict_time", "inference_time"];

/// Attach a provider's own usage report to a normalized media response.
///
/// METERING NEEDS THE TRANSACTION, NOT AN AVERAGE. A flat per-call media rate
/// charges a two-second image and a sixty-second video the same amount, so it is
/// wrong by up to ~30x in both directions on the same configured number.
/// Replicate reports `metrics.predict_time` — the billable compute seconds — and
/// the normalizer used to discard it along with the rest of the prediction
/// envelope, which is why the debit downstream had nothing to bill from.
///
/// Kept as a separate step rather than folded into `normalize_media_output` so
/// providers that report nothing stay unchanged and simply omit the key; the
/// debit path treats a missing `usage` as "fall back to the flat rate".
pub(crate) fn with_media_usage(mut normalized: Value, usage: &Value) -> Value {
    let seconds = COMPUTE_SECOND_KEYS.iter().find_map(|key| {
        usage
            .get(key)
            .and_then(serde_json::Value::as_f64)
            .filter(|s| *s > 0.0)
    });
    if let Some(seconds) = seconds {
        normalized["usage"] = serde_json::json!({ "compute_seconds": seconds });
    }
    normalized
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
#[path = "health_signal_probe_test.rs"]
mod health_signal_probe;

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
        /// Raw body for replies that are not text (audio, images). When set it
        /// is served verbatim and `body` is ignored — including the `{{BASE}}`
        /// substitution, which would corrupt binary payloads.
        pub body_bytes: Option<Vec<u8>>,
    }

    impl MockResponse {
        /// A `200 OK` JSON reply.
        pub fn ok_json(body: impl Into<String>) -> Self {
            Self {
                status: 200,
                headers: vec![("content-type".into(), "application/json".into())],
                body: body.into(),
                body_bytes: None,
            }
        }

        /// An arbitrary-status JSON reply.
        pub fn json(status: u16, body: impl Into<String>) -> Self {
            Self {
                status,
                headers: vec![("content-type".into(), "application/json".into())],
                body: body.into(),
                body_bytes: None,
            }
        }

        /// A `200 OK` reply carrying arbitrary (possibly non-UTF-8) bytes under
        /// an explicit content type — how a real TTS endpoint answers.
        pub fn ok_bytes(content_type: &str, body: Vec<u8>) -> Self {
            Self {
                status: 200,
                headers: vec![("content-type".into(), content_type.into())],
                body: String::new(),
                body_bytes: Some(body),
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
        pub query: Option<String>,
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
            query: uri.query().map(str::to_owned),
            headers,
            body: body.to_vec(),
        });

        let reply = {
            let mut q = state.responses.lock().unwrap();
            if q.len() > 1 {
                q.pop_front().unwrap()
            } else {
                q.front()
                    .cloned()
                    .unwrap_or_else(|| MockResponse::ok_json("{}"))
            }
        };

        let mut builder = Response::builder()
            .status(StatusCode::from_u16(reply.status).unwrap_or(StatusCode::OK));
        for (k, v) in &reply.headers {
            builder = builder.header(k, v);
        }
        match reply.body_bytes {
            Some(bytes) => builder.body(Body::from(bytes)).unwrap(),
            None => {
                let body = reply.body.replace("{{BASE}}", &state.base_url);
                builder.body(Body::from(body)).unwrap()
            }
        }
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

    /// An upstream that accepts a request body, counts it, and then stalls for
    /// 2 s, past a short per-request or client timeout. Abort the handle when done.
    pub async fn stalled_server() -> (String, Arc<std::sync::atomic::AtomicUsize>, JoinHandle<()>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        async fn stalled(State(seen): State<Arc<AtomicUsize>>, body: Bytes) -> Response {
            assert!(!body.is_empty());
            seen.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            Response::new(Body::from(r#"{"ok":true}"#))
        }
        let seen = Arc::new(AtomicUsize::new(0));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .fallback(any(stalled))
            .with_state(Arc::clone(&seen));
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (url, seen, server)
    }
}

#[cfg(test)]
mod helper_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_a_401_or_a_key_naming_403_refuses_the_account() {
        use reqwest::StatusCode;
        let forbidden = |body: &str| is_account_auth_failure(StatusCode::FORBIDDEN, body);
        assert!(is_account_auth_failure(StatusCode::UNAUTHORIZED, ""));
        assert!(forbidden(
            r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#
        ));
        assert!(forbidden(
            r#"{"error":{"message":"bad","type":"invalid_request_error","code":"invalid_api_key"}}"#
        ));
        assert!(forbidden(
            r#"{"error":{"message":"quota","type":"insufficient_quota","code":"insufficient_quota"}}"#
        ));
        assert!(forbidden(
            r#"[{"error":{"code":403,"status":"PERMISSION_DENIED","details":[{"reason":"API_KEY_SERVICE_BLOCKED"}]}}]"#
        ));
        // Refusals of the request itself.
        assert!(!forbidden(
            r#"{"type":"error","error":{"type":"permission_error","message":"model not enabled"}}"#
        ));
        assert!(!forbidden(
            r#"{"error":{"code":"unsupported_country_region_territory","message":"region"}}"#
        ));
        assert!(!forbidden(
            r#"{"error":{"code":403,"message":"input was flagged"}}"#
        ));
        assert!(!forbidden("Forbidden"));
        assert!(!forbidden(""));
        // Other statuses never refuse the account here, whatever the body says.
        assert!(!is_account_auth_failure(
            StatusCode::BAD_REQUEST,
            r#"{"error":{"code":"invalid_api_key"}}"#
        ));
    }

    #[test]
    fn streaming_request_lifts_the_total_timeout() {
        let request = streaming_request(reqwest::Client::new().post("http://127.0.0.1/x"))
            .build()
            .unwrap();
        assert_eq!(request.timeout(), Some(&STREAM_TOTAL_TIMEOUT));
        assert!(STREAM_TOTAL_TIMEOUT > STREAM_READ_TIMEOUT);
    }

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
    fn legacy_provider_token_limit_keeps_only_max_tokens() {
        let mut body = json!({ "max_completion_tokens": 128 });

        normalize_legacy_completion_token_limit(&mut body);

        assert_eq!(body["max_tokens"], json!(128));
        assert!(body.get("max_completion_tokens").is_none());
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
    fn account_quota_requires_matching_remaining_and_limit_headers() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("x-ratelimit-remaining-tokens", "90".parse().unwrap());
        headers.insert("x-ratelimit-limit-requests", "100".parse().unwrap());
        assert!(parse_account_quota(&headers).is_none());
        headers.insert("x-ratelimit-remaining-requests", "20".parse().unwrap());
        let observation = parse_account_quota(&headers).unwrap();
        assert_eq!(observation.remaining, Some(20));
        assert_eq!(observation.limit, Some(100));
    }

    #[test]
    fn account_quota_uses_the_matching_window_reset_header() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("x-ratelimit-remaining-tokens", "8".parse().unwrap());
        headers.insert("x-ratelimit-limit-tokens", "10".parse().unwrap());
        headers.insert("x-ratelimit-reset-tokens", "1m30s".parse().unwrap());
        let now = now_secs();
        let reset = parse_account_quota(&headers).unwrap().reset_at.unwrap();
        assert!(reset >= now + 90 && reset <= now_secs() + 90);

        headers.clear();
        headers.insert("anthropic-ratelimit-tokens-remaining", "8".parse().unwrap());
        headers.insert("anthropic-ratelimit-tokens-limit", "10".parse().unwrap());
        headers.insert(
            "anthropic-ratelimit-tokens-reset",
            "2030-01-01T00:00:00Z".parse().unwrap(),
        );
        assert_eq!(
            parse_account_quota(&headers).unwrap().reset_at,
            Some(1_893_456_000),
        );
        headers.insert(
            "anthropic-ratelimit-tokens-reset",
            "invalid".parse().unwrap(),
        );
        assert_eq!(parse_account_quota(&headers).unwrap().reset_at, None);
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

    #[test]
    fn normalize_media_output_collects_generated_audio_shapes() {
        // A nested file object (the shape Fal audio models return) and a bare
        // URL string (the shape Replicate audio models return) both normalize
        // to the same `{ data: [{ url }] }` envelope video uses.
        let nested = normalize_media_output(&json!({
            "audio_file": {
                "url": "https://media.example.test/music.wav",
                "content_type": "audio/wav"
            },
            "seed": 3
        }));
        assert_eq!(
            nested["data"],
            json!([{ "url": "https://media.example.test/music.wav" }])
        );
        let bare = normalize_media_output(&json!("https://media.example.test/sfx.mp3"));
        assert_eq!(
            bare["data"],
            json!([{ "url": "https://media.example.test/sfx.mp3" }])
        );
        let inline = normalize_media_output(&json!({ "audio": "data:audio/wav;base64,UklGRg==" }));
        assert_eq!(
            inline["data"][0]["url"],
            json!("data:audio/wav;base64,UklGRg==")
        );
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
        let json = check_response_status(resp, "p", Some(&quota))
            .await
            .unwrap();
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
        assert_eq!(
            quota.snapshot()["p"]["rate_limited"],
            serde_json::json!(true)
        );
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

    /// The body of a safety-signal fixture, as the upstream sent it.
    fn safety_fixture_body(raw: &str) -> String {
        let json: serde_json::Value = serde_json::from_str(raw).expect("fixture is JSON");
        json["body"].to_string()
    }

    #[tokio::test]
    async fn a_matching_error_body_is_a_safety_refusal_on_both_status_checks() {
        let body = safety_fixture_body(include_str!(
            "../tests/fixtures/safety/openrouter_moderation.json"
        ));
        for streaming in [false, true] {
            let server = MockServer::always(MockResponse::json(403, &body)).await;
            let resp = fetch(&server).await;
            let err = if streaming {
                check_stream_status(resp, "openrouter", None)
                    .await
                    .err()
                    .expect("refused")
            } else {
                check_response_status(resp, "openrouter", None)
                    .await
                    .unwrap_err()
            };
            match err {
                ProviderError::SafetyRefused {
                    provider,
                    status,
                    scope,
                    row,
                    ..
                } => {
                    assert_eq!(provider, "openrouter");
                    assert_eq!(status, 403);
                    assert_eq!(scope, crate::SafetyScope::Content);
                    assert_eq!(row, "openrouter.moderation");
                }
                other => panic!("expected SafetyRefused, got {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn the_same_body_from_another_provider_stays_an_ordinary_rejection() {
        let body = safety_fixture_body(include_str!(
            "../tests/fixtures/safety/openrouter_moderation.json"
        ));
        let server = MockServer::always(MockResponse::json(403, &body)).await;
        let resp = fetch(&server).await;
        let err = check_response_status(resp, "fireworks", None)
            .await
            .unwrap_err();
        assert!(
            matches!(err, ProviderError::Rejected { status: 403, .. }),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn a_plain_forbidden_body_stays_an_ordinary_rejection() {
        let body = safety_fixture_body(include_str!(
            "../tests/fixtures/safety/openrouter_forbidden_key.json"
        ));
        let server = MockServer::always(MockResponse::json(403, &body)).await;
        let resp = fetch(&server).await;
        let err = check_response_status(resp, "openrouter", None)
            .await
            .unwrap_err();
        assert!(
            matches!(err, ProviderError::Rejected { status: 403, .. }),
            "{err:?}"
        );
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

    #[tokio::test]
    async fn payment_required_is_typed_and_keeps_the_provider_message() {
        let server = MockServer::always(MockResponse::json(
            402,
            r#"{"error":{"message":"no credits"}}"#,
        ))
        .await;
        let resp = fetch(&server).await;
        let err = check_response_status(resp, "openrouter", None)
            .await
            .unwrap_err();
        match err {
            ProviderError::PaymentRequired { provider, message } => {
                assert_eq!(provider, "openrouter");
                assert_eq!(message, "no credits");
            }
            other => panic!("expected PaymentRequired, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn streaming_payment_required_is_typed_and_keeps_the_response_body() {
        let server = MockServer::always(MockResponse::json(
            402,
            r#"{"error":{"message":"insufficient credits"}}"#,
        ))
        .await;
        let resp = fetch(&server).await;
        let err = check_stream_status(resp, "openrouter", None)
            .await
            .unwrap_err();
        match err {
            ProviderError::PaymentRequired { provider, message } => {
                assert_eq!(provider, "openrouter");
                assert!(message.contains("insufficient credits"));
            }
            other => panic!("expected PaymentRequired, got {other:?}"),
        }
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
        assert_unsupported(p.submit_video_bound("m", &b).await.err().unwrap(), "video");
        assert_unsupported(
            p.submit_media_job_bound("m", &b, super::MediaJobKind::Video)
                .await
                .err()
                .unwrap(),
            "video",
        );
        assert_unsupported(
            p.submit_media_job_bound("m", &b, super::MediaJobKind::Audio)
                .await
                .err()
                .unwrap(),
            "audio generation",
        );
    }

    /// Fixed-schema video providers must keep refusing generated audio: they
    /// never override `submit_media_job_bound`, so the refusal happens before
    /// any request is built (the unroutable base URL proves no network call).
    #[tokio::test]
    async fn fixed_schema_video_providers_reject_audio_jobs() {
        let quotas = || std::sync::Arc::new(crate::ProviderQuotas::new());
        let base = "http://127.0.0.1:1".to_owned();
        let providers: Vec<Box<dyn Provider>> = vec![
            Box::new(crate::RunwayProvider::new(
                reqwest::Client::new(),
                None,
                vec!["k".into()],
                base.clone(),
                quotas(),
            )),
            Box::new(crate::TopazProvider::new(
                reqwest::Client::new(),
                None,
                vec!["k".into()],
                base.clone(),
                quotas(),
            )),
            Box::new(crate::BflProvider::new(
                reqwest::Client::new(),
                None,
                vec!["k".into()],
                base,
                quotas(),
                10,
                1,
            )),
        ];
        let body = json!({"prompt":"a drum loop"});
        for provider in providers {
            let error = provider
                .submit_media_job_bound("any-model", &body, super::MediaJobKind::Audio)
                .await
                .err()
                .expect("audio must be refused");
            match error {
                ProviderError::Provider(message) => {
                    assert!(
                        message.contains("does not support audio generation"),
                        "{message}"
                    );
                    assert!(message.contains(provider.name()), "{message}");
                }
                other => panic!("expected a Provider refusal, got {other:?}"),
            }
        }
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

    /// Both providers' compute-second fields, pinned by NAME.
    ///
    /// The names are the whole contract with an external API, and getting one
    /// wrong is silent: `with_media_usage` simply attaches nothing, the debit
    /// finds no `usage.compute_seconds`, and the call bills the flat nominal rate
    /// instead — which is what fal did for every image and video until its key
    /// was added here. A rename upstream fails this test rather than quietly
    /// reverting media billing to an estimate.
    ///
    /// Field sources, both primary:
    ///  - Replicate HTTP API reference: `metrics.predict_time` is "the amount of
    ///    CPU or GPU time, in seconds, that the prediction used while running",
    ///    present only on a terminated prediction.
    ///  - fal queue docs: `metrics.inference_time` is "seconds the runner spent
    ///    processing (only when COMPLETED)", and fal bills on exactly that —
    ///    queue wait is free.
    #[test]
    fn media_usage_reads_both_replicate_and_fal_timing_fields() {
        let normalized = || json!({ "data": [{ "url": "https://x/a.png" }] });

        let replicate = with_media_usage(
            normalized(),
            &json!({ "predict_time": 2.5, "total_time": 9.0 }),
        );
        assert_eq!(replicate["usage"]["compute_seconds"], json!(2.5));

        let fal = with_media_usage(normalized(), &json!({ "inference_time": 3.42 }));
        assert_eq!(fal["usage"]["compute_seconds"], json!(3.42));

        // `total_time` is NOT billable — it includes queue and upload time that
        // neither provider charges for. Reading it would over-bill every call.
        let total_only = with_media_usage(normalized(), &json!({ "total_time": 9.0 }));
        assert!(total_only.get("usage").is_none());

        // A provider that reports nothing, or reports a zero/absent duration,
        // must leave `usage` off entirely so the debit falls back to the flat
        // rate rather than billing zero seconds.
        for empty in [json!({}), json!(null), json!({ "inference_time": 0.0 })] {
            assert!(
                with_media_usage(normalized(), &empty)
                    .get("usage")
                    .is_none(),
                "no usage key for {empty:?}"
            );
        }
    }
}
