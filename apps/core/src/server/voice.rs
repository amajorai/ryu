//! Voice engine data path — Voice Recognition transcription and Audio synthesis.
//!
//! `POST /api/voice/transcribe` accepts a multipart upload with a `file` field
//! (the audio) and proxies it to the selected local/cloud STT runtime, returning
//! `{ "text": "..." }` plus segments when available. This is the consumer that
//! makes the voice engines callable: install + start the chosen runtime from the
//! Store, then POST audio here.
//!
//! Per the Core-vs-Gateway rule this is **Core** (it decides *what runs* — which
//! voice engine handles the audio). Both legs can also route to the cloud:
//! `?engine=gateway` on transcribe goes through the Gateway's Voice Recognition slot
//! (`crates/core/stt`), and `engine: "gateway"` on speak goes through its Audio
//! slot ([`synth_via_gateway`] below).

use axum::{
    extract::{Multipart, Query, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::ServerState;

// The Voice Recognition primitive — result types (`Transcription`/`TranscriptSegment`),
// `verbose_json` parsing, the engine dispatch, and the in-process parakeet ONNX
// engine — now lives in the extracted `ryu-stt` crate. Re-export the result types
// + the cross-surface default resolver + the Core-wired data-path entrypoints
// (`stt_host`) so the route handlers below and external callers keep referring to
// `crate::server::voice::{...}` unchanged.
pub use ryu_stt::{default_stt_engine, TranscriptSegment, Transcription};

pub use crate::stt_host::{transcribe_wav, transcribe_wav_detailed};

/// Optional `?engine=` selector for the transcription engine.
#[derive(Debug, Deserialize)]
pub struct TranscribeQuery {
    /// `"parakeet"` (default), `"whisper"` (local whisper.cpp), `"audiocpp"`
    /// (the native audio.cpp runtime), or `"gateway"` (Gateway-routed Whisper —
    /// the swappable cloud Voice Recognition slot, default Groq).
    /// When omitted, the cross-surface default from [`default_stt_engine`] is used.
    #[serde(default)]
    pub engine: Option<String>,
}

/// Request body for Audio synthesis.
#[derive(Debug, Deserialize)]
pub struct SpeakRequest {
    /// The text to speak.
    pub text: String,
    /// Engine selector. Omitted or `"outetts"` → the built-in OuteTTS engine
    /// (backward compatible). `"gateway"` routes to the Gateway's Audio modality
    /// slot; `"audiocpp"` routes to the native audio.cpp server. Any other id
    /// (e.g. `"kitten"`, `"pocket"`) is served by the universal Ryu Audio sidecar
    /// (`apps-store/voice/sidecar`).
    #[serde(default)]
    pub engine: Option<String>,
    /// Voice id (engine-specific); defaults to the engine's default voice.
    #[serde(default)]
    pub voice: Option<String>,
    /// Speaking-rate multiplier where the engine supports it.
    #[serde(default)]
    pub speed: Option<f32>,
    /// BCP-47-ish language hint for multilingual engines.
    #[serde(default)]
    pub language: Option<String>,
    /// Reference wav path/URL for cloning-capable engines (ignored otherwise).
    #[serde(default)]
    pub reference_audio: Option<String>,
}

/// The exact system prompt S1-mini was trained with. Keep this literal stable:
/// the model card warns that changing it can produce empty or garbled output.
pub const S1_MINI_SYSTEM_PROMPT: &str =
    "You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text.";

const S1_DEFAULT_STYLING: &str = "semi-formal";
const S1_DEFAULT_STRUCTURE: &str = "prose";
const S1_DEFAULT_CONTEXT: &str = "general";
const S1_STYLINGS: &[&str] = &["casual", "semi-casual", "semi-formal", "formal"];
const S1_STRUCTURES: &[&str] = &["prose", "lists"];
const S1_CONTEXTS: &[&str] = &["general", "email"];
const S1_MAX_NEW_TOKENS: u32 = 1024;

/// Request body for the Speech Processing cleanup stage.
#[derive(Debug, Deserialize)]
pub struct SpeechProcessingRequest {
    /// Raw text returned by Voice Recognition.
    pub text: String,
    /// Speech Processing engine id. Omitted = the node's default S1-mini engine.
    #[serde(default)]
    pub engine: Option<String>,
    /// S1-mini styling control-line value.
    #[serde(default)]
    pub styling: Option<String>,
    /// S1-mini structure control-line value.
    #[serde(default)]
    pub structure: Option<String>,
    /// S1-mini destination-context control-line value.
    #[serde(default)]
    pub context: Option<String>,
}

/// Request body for installing the default Speech Processing model.
#[derive(Debug, Deserialize)]
pub struct InstallSpeechProcessingModelRequest {
    /// Engine id to install. Omitted = S1-mini.
    #[serde(default)]
    pub engine: Option<String>,
}

fn s1_axis(
    value: Option<&str>,
    default: &str,
    allowed: &[&str],
    name: &str,
) -> Result<String, String> {
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default);
    if allowed.contains(&value) {
        Ok(value.to_owned())
    } else {
        Err(format!("unsupported S1-mini {name} value: {value}"))
    }
}

fn s1_control_line(request: &SpeechProcessingRequest) -> Result<String, String> {
    let styling = s1_axis(
        request.styling.as_deref(),
        S1_DEFAULT_STYLING,
        S1_STYLINGS,
        "styling",
    )?;
    let structure = s1_axis(
        request.structure.as_deref(),
        S1_DEFAULT_STRUCTURE,
        S1_STRUCTURES,
        "structure",
    )?;
    let context = s1_axis(
        request.context.as_deref(),
        S1_DEFAULT_CONTEXT,
        S1_CONTEXTS,
        "context",
    )?;
    Ok(format!(
        "[Styling: {styling}] [Structure: {structure}] [Context: {context}]"
    ))
}

fn s1_payload(model: &str, request: &SpeechProcessingRequest) -> Result<Value, String> {
    let text = request.text.trim();
    if text.is_empty() {
        return Err("missing `text` (the raw transcript to clean)".to_owned());
    }
    let engine = request
        .engine
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_ENGINE_ID);
    if engine != crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_ENGINE_ID {
        return Err(format!("unknown Speech Processing engine: {engine}"));
    }
    let control = s1_control_line(request)?;
    Ok(json!({
        "model": model,
        "messages": [
            { "role": "system", "content": S1_MINI_SYSTEM_PROMPT },
            { "role": "user", "content": format!("{control}\n{text}") },
        ],
        "temperature": 0,
        "max_tokens": S1_MAX_NEW_TOKENS,
        "stream": false,
        "chat_template_kwargs": { "enable_thinking": false },
    }))
}

/// `GET /api/voice/speech-processing-engines` — the node's Speech Processing
/// engines and model state. The list is deliberately separate from Voice
/// Recognition: ASR and cleanup are two independent layers.
#[utoipa::path(
    get,
    path = "/api/voice/speech-processing-engines",
    tag = "Voice",
    summary = "list Speech Processing engines",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn speech_processing_engines(State(state): State<ServerState>) -> impl IntoResponse {
    let registry = crate::registry::ModelRegistry::from_env();
    let loaded = state
        .manager
        .statuses()
        .into_iter()
        .find(|status| {
            status.name
                == crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_SIDECAR_NAME
        })
        .is_some_and(|status| status.running);
    let installed = registry.local_speech_model.weight_path().exists();
    let row = json!({
        "id": crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_ENGINE_ID,
        "display_name": "S1-mini by Superwhisper",
        "description": "Local transcript cleanup · punctuation, filler removal, corrections, and formatting",
        "model": registry.local_speech_model.id,
        "size_mb": 484,
        "languages": ["en"],
        "sidecar": crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_SIDECAR_NAME,
        "installed": installed,
        "loaded": loaded,
    });
    (
        StatusCode::OK,
        Json(json!({ "object": "list", "data": [row] })),
    )
        .into_response()
}

/// `POST /api/voice/speech-processing-model/install` — download the curated
/// default S1-mini GGUF through Core's checksum-verified download center.
#[utoipa::path(
    post,
    path = "/api/voice/speech-processing-model/install",
    tag = "Voice",
    summary = "install the Speech Processing model",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn speech_processing_model_install(
    State(state): State<ServerState>,
    Json(request): Json<InstallSpeechProcessingModelRequest>,
) -> impl IntoResponse {
    let engine = request
        .engine
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_ENGINE_ID);
    if engine != crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_ENGINE_ID {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("unknown Speech Processing engine: {engine}") })),
        )
            .into_response();
    }

    let registry = crate::registry::ModelRegistry::from_env();
    let id = registry.local_speech_model.id.clone();
    let result = state
        .downloads
        .resume_and_download_blocking(crate::model_catalog::gguf_download_spec(
            &id,
            &registry.local_speech_model.weight_url,
            &registry.local_speech_model.sha256,
            &format!("{id} (Speech Processing model)"),
            crate::downloads::DownloadRole::SpeechModel,
        ))
        .await;
    match result {
        Ok(path) => {
            state
                .manager
                .mark_installed(
                    crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_SIDECAR_NAME,
                )
                .await;
            if let Err(error) = crate::model_catalog::record_default_download(
                &id,
                &registry.local_speech_model.weight_url,
                None,
                None,
            ) {
                tracing::warn!("recording Speech Processing model provenance failed: {error:#}");
            }
            (
                StatusCode::OK,
                Json(json!({ "success": true, "engine": engine, "model": id, "path": path })),
            )
                .into_response()
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(
                json!({ "error": format!("installing Speech Processing model failed: {error:#}") }),
            ),
        )
            .into_response(),
    }
}

/// `POST /api/voice/speech-processing` — clean one raw ASR transcript with the
/// selected Speech Processing engine. The dedicated sidecar is warmed lazily;
/// disabling cleanup in Dictation simply skips this endpoint.
#[utoipa::path(
    post,
    path = "/api/voice/speech-processing",
    tag = "Voice",
    summary = "clean a speech transcript",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn speech_processing(
    State(state): State<ServerState>,
    Json(request): Json<SpeechProcessingRequest>,
) -> impl IntoResponse {
    let registry = crate::registry::ModelRegistry::from_env();
    let model = registry.local_speech_model.id.clone();
    let payload = match s1_payload(&model, &request) {
        Ok(payload) => payload,
        Err(error) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response()
        }
    };

    let sidecar_name = crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_SIDECAR_NAME;
    let _activity = state.manager.enter_request(sidecar_name);
    if let Err(error) = state
        .manager
        .wake_and_await_healthy(sidecar_name, std::time::Duration::from_secs(120))
        .await
    {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": format!("Speech Processing engine is unavailable: {error:#}") })),
        )
            .into_response();
    }

    let url = format!(
        "{}/v1/chat/completions",
        crate::sidecar::providers::llamacpp::speech::speech_processing_base_url()
    );
    let response = match state.client.post(&url).json(&payload).send().await {
        Ok(response) => response,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("Speech Processing request failed: {error}") })),
            )
                .into_response();
        }
    };
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return (
            StatusCode::BAD_GATEWAY,
            Json(
                json!({ "error": format!("Speech Processing engine returned {status}: {detail}") }),
            ),
        )
            .into_response();
    }

    let value: Value = match response.json().await {
        Ok(value) => value,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("could not parse Speech Processing response: {error}") })),
            )
                .into_response();
        }
    };
    let Some(text) = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
    else {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "Speech Processing response contained no text" })),
        )
            .into_response();
    };
    (
        StatusCode::OK,
        Json(json!({
            "text": text.trim(),
            "engine": crate::sidecar::providers::llamacpp::speech::SPEECH_PROCESSING_ENGINE_ID,
            "model": model,
        })),
    )
        .into_response()
}

/// `POST /api/voice/speak` — synthesize Audio from text, returning a `audio/wav`
/// body. Engine selection mirrors `/api/voice/transcribe`'s `?engine=` pattern:
/// omitted (or `"outetts"`) runs the built-in OuteTTS `llama-tts` path; any other
/// engine id is proxied to the universal Ryu Audio sidecar's `/generate`. Nothing
/// is hardcoded — the available engines are whatever the sidecar registry serves.
#[utoipa::path(
    post,
    path = "/api/voice/speak",
    tag = "Voice",
    summary = "synthesize Audio from text, returning a `audio/wav",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn speak(
    State(state): State<ServerState>,
    Json(req): Json<SpeakRequest>,
) -> impl IntoResponse {
    let text = req.text.trim();
    if text.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing `text` (the words to speak)" })),
        )
            .into_response();
    }

    // The cross-surface default engine (Kokoro 82M) is a swappable registry default,
    // not a hardcoded literal — resolved here so one env var re-points every surface.
    let engine = req
        .engine
        .clone()
        .unwrap_or_else(crate::sidecar::providers::ryutts::default_tts_engine);

    // Built-in fallback engine: OuteTTS via the shared llama-tts binary (no sidecar).
    if engine == "outetts" {
        return match crate::sidecar::providers::outetts::synthesize(text).await {
            Ok(wav) => (StatusCode::OK, [(header::CONTENT_TYPE, "audio/wav")], wav).into_response(),
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("audio generation failed: {e:#}") })),
            )
                .into_response(),
        };
    }

    // The cloud slot: route to the Gateway's Audio modality provider. Same
    // graceful degrade as the sidecar path below — a cloud outage must not
    // silence the island — but the content type comes from the provider, since
    // it may hand back mp3 rather than wav.
    if engine == "gateway" {
        match synth_via_gateway(&state.client, req.voice.as_deref(), req.speed, text).await {
            Ok((audio, content_type)) => {
                return (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, content_type)],
                    audio,
                )
                    .into_response();
            }
            Err(gateway_err) => {
                tracing::warn!("gateway Audio failed ({gateway_err}); falling back to OuteTTS");
                return match crate::sidecar::providers::outetts::synthesize(text).await {
                    Ok(wav) => {
                        (StatusCode::OK, [(header::CONTENT_TYPE, "audio/wav")], wav).into_response()
                    }
                    Err(fallback_err) => (
                        StatusCode::BAD_GATEWAY,
                        Json(json!({
                            "error": format!(
                                "gateway Audio failed ({gateway_err}) and the OuteTTS \
                                 fallback also failed ({fallback_err:#})."
                            )
                        })),
                    )
                        .into_response(),
                };
            }
        }
    }

    // Native audio.cpp is an explicit runtime choice. Do not silently fall
    // through to OuteTTS here: a caller selecting this engine must either get
    // audio.cpp output or an actionable unavailable/error response.
    if engine == "audiocpp" {
        return match synth_via_audio_cpp(&state.client, &req, text).await {
            Ok(wav) => (StatusCode::OK, [(header::CONTENT_TYPE, "audio/wav")], wav).into_response(),
            Err(error) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("audio.cpp synthesis failed: {error}") })),
            )
                .into_response(),
        };
    }

    // Everything else (incl. the Kokoro default): proxy to the Ryu Audio sidecar's
    // normalized /generate. If the sidecar is down or the engine can't render (e.g.
    // the sidecar runtime isn't provisioned yet on this node), degrade gracefully to
    // the always-available OuteTTS fallback so spoken output never hard-fails.
    match synth_via_sidecar(&state, &engine, &req, text).await {
        Ok(wav) => (StatusCode::OK, [(header::CONTENT_TYPE, "audio/wav")], wav).into_response(),
        Err(sidecar_err) => {
            tracing::warn!(
                engine = %engine,
                "Audio sidecar synthesis failed ({sidecar_err}); falling back to OuteTTS"
            );
            match crate::sidecar::providers::outetts::synthesize(text).await {
                Ok(wav) => {
                    (StatusCode::OK, [(header::CONTENT_TYPE, "audio/wav")], wav).into_response()
                }
                Err(fallback_err) => (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({
                        "error": format!(
                            "Audio engine '{engine}' failed ({sidecar_err}) and the OuteTTS \
                             fallback also failed ({fallback_err:#})."
                        )
                    })),
                )
                    .into_response(),
            }
        }
    }
}

/// Proxy one synthesis request to the Ryu Audio sidecar's `/generate`, returning the
/// `audio/wav` bytes or a human-readable error. Factored out so [`speak`] can wrap it
/// in an OuteTTS fallback (and so the low-latency voice-session path can reuse it).
async fn synth_via_sidecar(
    state: &ServerState,
    engine: &str,
    req: &SpeakRequest,
    text: &str,
) -> Result<Vec<u8>, String> {
    let url = format!(
        "{}/generate",
        crate::sidecar::providers::ryutts::tts_base_url()
    );
    let mut body = json!({ "text": text, "engine": engine });
    if let Some(v) = &req.voice {
        body["voice"] = json!(v);
    }
    if let Some(s) = req.speed {
        body["speed"] = json!(s);
    }
    if let Some(l) = &req.language {
        body["language"] = json!(l);
    }
    if let Some(r) = &req.reference_audio {
        body["reference_audio"] = json!(r);
    }

    let resp = state
        .client
        .post(&url)
        .bearer_auth(crate::sidecar::providers::ryutts::bearer())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ryu Audio sidecar not reachable at {url}: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!(
            "Audio engine '{engine}' returned {status}: {detail}"
        ));
    }

    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("reading Audio output failed: {e}"))
}

/// Build the audio.cpp OpenAI-compatible TTS request. Model-specific options
/// belong under `options`; `speaking_rate` is the PocketTTS option documented by
/// audio.cpp, while voice/reference fields stay at the request top level.
fn audio_cpp_tts_payload(req: &SpeakRequest, text: &str) -> Value {
    let voice = req
        .voice
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(crate::sidecar::providers::audiocpp::DEFAULT_TTS_VOICE);
    let mut payload = json!({
        "model": crate::sidecar::providers::audiocpp::tts_model_id(),
        "input": text,
        "voice": voice,
        "response_format": "wav",
    });
    if let Some(speed) = req.speed {
        payload["options"] = json!({ "speaking_rate": speed });
    }
    if let Some(language) = req
        .language
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload["language"] = json!(language);
    }
    if let Some(reference_audio) = req
        .reference_audio
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        payload["voice_ref"] = json!(reference_audio);
    }
    payload
}

/// Send one synthesis request to the Core-managed audio.cpp server.
pub(crate) async fn synth_via_audio_cpp(
    client: &reqwest::Client,
    req: &SpeakRequest,
    text: &str,
) -> Result<Vec<u8>, String> {
    let base = crate::sidecar::providers::audiocpp::base_url();
    synth_via_audio_cpp_at(client, &base, req, text).await
}

async fn synth_via_audio_cpp_at(
    client: &reqwest::Client,
    base: &str,
    req: &SpeakRequest,
    text: &str,
) -> Result<Vec<u8>, String> {
    let url = format!("{}/v1/audio/speech", base.trim_end_matches('/'));
    let response = client
        .post(&url)
        .json(&audio_cpp_tts_payload(req, text))
        .send()
        .await
        .map_err(|error| format!("audio.cpp server not reachable at {url}: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(format!("audio.cpp returned {status}: {detail}"));
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !content_type.is_empty() && !content_type.starts_with("audio/wav") {
        return Err(format!(
            "audio.cpp returned unexpected content type {content_type}"
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("reading audio.cpp output failed: {error}"))?;
    if bytes.is_empty() {
        return Err("audio.cpp returned an empty audio body".to_string());
    }
    Ok(bytes.to_vec())
}

/// The voice sent to the Gateway when the caller supplies none. OpenAI's
/// `/v1/audio/speech` **requires** `voice`, and the stored preference is empty
/// for anyone who picked the cloud engine before a voice list existed — so a
/// default here is what keeps read-aloud from 400ing into the OuteTTS fallback.
pub(crate) const DEFAULT_GATEWAY_TTS_VOICE: &str = "alloy";

/// The model Core asks the Gateway for when `RYU_TTS_GATEWAY_MODEL` is unset.
/// It is only a routing hint: with no slot header and no `modality_map[Tts]`
/// entry the Gateway falls through to model-based routing, and the provider
/// overwrites `model` with whatever the route resolved to.
pub(crate) const DEFAULT_GATEWAY_TTS_MODEL: &str = "tts-1";

/// The operator's explicit Audio slot pins, if any.
///
/// Empty means "do not send the slot headers at all" — and that is the point.
/// The Gateway resolves slot override → `modality_map` → model routing, so a
/// header sent unconditionally would win over the Audio provider the user chose
/// in Settings → Providers and make that setting permanently inert.
fn gateway_tts_slot_overrides() -> (Option<String>, Option<String>) {
    let read = |key: &str| {
        std::env::var(key)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    (
        read("RYU_TTS_GATEWAY_PROVIDER"),
        read("RYU_TTS_GATEWAY_MODEL"),
    )
}

/// Build the `/v1/audio/speech` body. `input` (not `text`) is load-bearing: the
/// Gateway's inbound firewall scans `body["input"]` for Tts, so any other key
/// would route fine and silently skip the scan. `voice` is always populated
/// because OpenAI rejects the request without one.
fn gateway_tts_payload(model: &str, voice: Option<&str>, speed: Option<f32>, text: &str) -> Value {
    let voice = voice
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_GATEWAY_TTS_VOICE);
    let mut payload = json!({
        "model": model,
        "input": text,
        "voice": voice,
        "response_format": "wav",
    });
    if let Some(s) = speed {
        payload["speed"] = json!(s);
    }
    payload
}

/// Assemble the outbound request, attaching the per-attribute slot headers only
/// when the operator actually pinned them (see [`gateway_tts_slot_overrides`]).
fn build_gateway_tts_request(
    client: &reqwest::Client,
    url: &str,
    bearer: &str,
    payload: &Value,
    slot_provider: Option<&str>,
    slot_model: Option<&str>,
) -> reqwest::RequestBuilder {
    let mut request = client.post(url).bearer_auth(bearer);
    if let Some(provider) = slot_provider {
        request = request.header("x-ryu-slot-tts-provider", provider);
    }
    if let Some(model) = slot_model {
        request = request.header("x-ryu-slot-tts-model", model);
    }
    request.json(payload)
}

/// The synthetic `gateway` row in the Audio engine list — the one thing that makes
/// the cloud engine selectable from every picker without a client-side list edit.
fn gateway_tts_engine_row() -> Value {
    json!({
        "id": "gateway",
        "display_name": "Cloud (via gateway)",
        "description": "Routed to this node's audio provider · no local model",
        // OpenAI's voices, because model-based routing resolves `tts-1` to
        // openai when the node has pinned no Audio provider. They are not
        // meaningful if `modality_map[Tts]` points elsewhere; the voice is
        // forwarded as-is and the provider judges it.
        "voices": ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
        "default_voice": DEFAULT_GATEWAY_TTS_VOICE,
        "sample_rate": 24000,
        "supports_cloning": false,
        "languages": ["en"],
        "size_mb": 0,
        // Deliberate: a cloud engine installs nothing locally. Same reasoning as
        // the Voice Recognition `gateway` row.
        "installed": true,
        "loaded": false,
    })
}

/// Synthesize one utterance through the Gateway's `/v1/audio/speech` — the
/// swappable cloud Audio slot. Returns the audio bytes and the content type to
/// serve them under. Mirrors `transcribe_via_gateway` (the Voice Recognition leg) in
/// `crates/core/stt`, with two deliberate differences:
///
/// * The per-attribute slot headers (`x-ryu-slot-tts-*`) are sent **only** when
///   the operator set `RYU_TTS_GATEWAY_PROVIDER` / `RYU_TTS_GATEWAY_MODEL`.
///   The Gateway resolves slot override → `modality_map` → model routing, so
///   always sending them would pin every read-aloud to openai/tts-1 and make
///   the node's configured Audio provider (Settings → Providers, "Serves POST
///   /v1/audio/speech") permanently inert.
/// * The prompt goes under the key `input`, not `text`: the Gateway's inbound
///   firewall scans `body["input"]` for Audio, so `text` would route fine and
///   silently skip the scan.
///
/// Takes a bare `reqwest::Client` rather than the `ServerState` so the realtime
/// voice session (`crate::voice::session`) can reuse it — shipping read-aloud
/// with a cloud voice while voice mode silently stayed local would be exactly
/// the half-landed pattern this repo keeps getting burned by.
pub(crate) async fn synth_via_gateway(
    client: &reqwest::Client,
    voice: Option<&str>,
    speed: Option<f32>,
    text: &str,
) -> Result<(Vec<u8>, String), String> {
    use base64::Engine as _;

    let (slot_provider, slot_model) = gateway_tts_slot_overrides();
    let model = slot_model
        .clone()
        .unwrap_or_else(|| DEFAULT_GATEWAY_TTS_MODEL.to_string());

    let base = crate::sidecar::gateway::gateway_url();
    let base = base.trim_end_matches('/');
    let url = format!("{base}/v1/audio/speech");
    let bearer = crate::sidecar::gateway::gateway_bearer()
        .map_err(|e| format!("no gateway credential for audio: {e:#}"))?;

    let payload = gateway_tts_payload(&model, voice, speed, text);
    let resp = build_gateway_tts_request(
        client,
        &url,
        &bearer,
        &payload,
        slot_provider.as_deref(),
        slot_model.as_deref(),
    )
    .send()
    .await
    .map_err(|e| format!("gateway audio unreachable at {url}: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("gateway audio returned {status}: {detail}"));
    }

    let value: Value = resp
        .json()
        .await
        .map_err(|e| format!("could not parse gateway audio response: {e}"))?;

    // Inline bytes (openai and any provider that answers with audio).
    if let Some(b64) = value["data"][0]["b64_json"].as_str() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .map_err(|e| format!("gateway audio is not valid base64: {e}"))?;
        let content_type = value["data"][0]["content_type"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("audio/wav")
            .to_string();
        return Ok((bytes, content_type));
    }

    // Hosted URL (fal/replicate are job-based and can only ever return a link).
    // This is a second, un-gatewayed egress from Core, straight to a provider CDN.
    if let Some(link) = value["data"][0]["url"].as_str() {
        let media = client
            .get(link)
            .send()
            .await
            .map_err(|e| format!("gateway audio URL unreachable: {e}"))?;
        if !media.status().is_success() {
            return Err(format!("gateway audio URL returned {}", media.status()));
        }
        let content_type = media
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .filter(|s| !s.is_empty())
            .unwrap_or("audio/mpeg")
            .to_string();
        let bytes = media
            .bytes()
            .await
            .map_err(|e| format!("reading gateway audio failed: {e}"))?;
        return Ok((bytes.to_vec(), content_type));
    }

    Err(format!(
        "gateway audio response carried no audio (expected data[0].b64_json or data[0].url), got keys: {}",
        value
            .as_object()
            .map(|o| o.keys().cloned().collect::<Vec<_>>().join(", "))
            .unwrap_or_else(|| "<not an object>".to_string())
    ))
}

/// `GET /api/voice/tts-engines` — list available Audio engines for the desktop
/// picker. Always includes the built-in `outetts`, the native `audiocpp` runtime,
/// and the cloud slot, then mirrors the Ryu TTS sidecar's `/engines` catalog when
/// it is reachable.
#[utoipa::path(
    get,
    path = "/api/voice/tts-engines",
    tag = "Voice",
    summary = "list available Audio engines for the desktop",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn tts_engines(State(state): State<ServerState>) -> impl IntoResponse {
    let builtin = json!({
        "id": "outetts",
        "display_name": "OuteTTS (built-in)",
        "description": "Local OuteTTS + WavTokenizer on llama.cpp · CPU-friendly",
        "voices": [],
        "default_voice": "",
        "sample_rate": 24000,
        "supports_cloning": false,
        "languages": ["en"],
        "size_mb": 0,
        "installed": true,
        "loaded": false,
    });

    // Both alternate slots are listed independently of the Ryu TTS sidecar call
    // so every picker can select them before the Python sidecar is installed.
    let audio_cpp_loaded =
        crate::sidecar::providers::audiocpp::server_reachable(&state.client).await;
    let audio_cpp = crate::sidecar::providers::audiocpp::tts_engine_row(
        crate::sidecar::providers::audiocpp::tts_runtime_installed(),
        audio_cpp_loaded && crate::sidecar::providers::audiocpp::tts_model_present(),
    );
    let mut engines = vec![builtin, gateway_tts_engine_row(), audio_cpp];
    if let Ok(Value::Array(sidecar_engines)) =
        crate::sidecar::providers::ryutts::list_engines(&state.client).await
    {
        engines.extend(sidecar_engines);
    }
    (
        StatusCode::OK,
        Json(json!({ "object": "list", "data": engines })),
    )
        .into_response()
}

/// `GET /api/voice/tts-models` — the curated, installable Audio model catalog (the
/// voicebox-style known-good set, each model bound to its engine + cache state).
/// Distinct from the raw HF `pipeline_tag=text-to-speech` browse in the Models
/// tab: these are the models Core can actually install + run. The native
/// audio.cpp row is available even when its server is not running.
#[utoipa::path(
    get,
    path = "/api/voice/tts-models",
    tag = "Voice",
    summary = "the curated, installable Audio model catalog",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn tts_models(State(state): State<ServerState>) -> impl IntoResponse {
    let mut models = vec![crate::sidecar::providers::audiocpp::tts_model_row()];
    if let Ok(Value::Array(rows)) =
        crate::sidecar::providers::ryutts::list_models(&state.client).await
    {
        models.extend(rows);
    }
    (
        StatusCode::OK,
        Json(json!({ "object": "list", "data": models })),
    )
        .into_response()
}

/// Request body for installing a curated Audio model.
#[derive(Debug, Deserialize)]
pub struct InstallTtsModelRequest {
    /// Engine id the model belongs to (from `/api/voice/tts-models`).
    pub engine: String,
    /// Curated `model_name` to install.
    pub model_name: String,
}

/// `POST /api/voice/tts-models/install` — download a curated model into the
/// Core-managed HF cache (`HF_HOME` under `~/.ryu`) via the sidecar's
/// `snapshot_download`. The download is registered with the DownloadCenter (a
/// spinner entry, since HF reports no byte total here) so it shows in the global
/// download overlay. Idempotent — a cache hit returns immediately.
#[utoipa::path(
    post,
    path = "/api/voice/tts-models/install",
    tag = "Voice",
    summary = "download a curated model into the",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn tts_models_install(
    State(state): State<ServerState>,
    Json(req): Json<InstallTtsModelRequest>,
) -> impl IntoResponse {
    let engine = req.engine.clone();
    let model_name = req.model_name.clone();
    let client = state.client.clone();
    if engine == "audiocpp" && model_name != "pocket_tts_english_q8_0" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "unsupported audio.cpp model; use pocket_tts_english_q8_0"
            })),
        )
            .into_response();
    }
    let label = format!("Audio model: {model_name}");

    let result = if engine == "audiocpp" {
        let downloads = state.downloads.clone();
        state
            .downloads
            .register_indeterminate_as(
                format!("tts-model:{engine}:{model_name}"),
                crate::downloads::DownloadKind::Model,
                crate::downloads::DownloadRole::VoiceModel,
                label,
                async move {
                    let version = crate::sidecar::providers::audiocpp::AudioCppDownloader::new()
                        .ensure_installed(&downloads)
                        .await?;
                    Ok(json!({
                        "engine": "audiocpp",
                        "model_name": "pocket_tts_english_q8_0",
                        "version": version,
                        "installed": true,
                    }))
                },
            )
            .await
    } else {
        state
            .downloads
            .register_indeterminate_as(
                format!("tts-model:{engine}:{model_name}"),
                crate::downloads::DownloadKind::Model,
                crate::downloads::DownloadRole::VoiceModel,
                label,
                async move {
                    crate::sidecar::providers::ryutts::install_model(&client, &engine, &model_name)
                        .await
                },
            )
            .await
    };

    match result {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("installing Audio model failed: {e:#}") })),
        )
            .into_response(),
    }
}

/// Transcribe an uploaded audio file. Routes to the in-process parakeet engine
/// (default) or the whisper.cpp voice server (`?engine=whisper`, HTTP proxy).
#[utoipa::path(
    post,
    path = "/api/voice/transcribe",
    tag = "Voice",
    summary = "Transcribe an uploaded audio file",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn transcribe(
    State(state): State<ServerState>,
    Query(query): Query<TranscribeQuery>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    // Pull the `file` field (the audio bytes) out of the multipart upload.
    let mut audio: Option<(String, Vec<u8>)> = None;
    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name() == Some("file") {
            let filename = field
                .file_name()
                .map(str::to_string)
                .unwrap_or_else(|| "audio.wav".to_string());
            match field.bytes().await {
                Ok(bytes) => audio = Some((filename, bytes.to_vec())),
                Err(e) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(json!({ "error": format!("could not read audio field: {e}") })),
                    );
                }
            }
        }
    }

    let Some((filename, bytes)) = audio else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing `file` field (the audio to transcribe)" })),
        );
    };

    match transcribe_wav_detailed(&state.client, bytes, filename, query.engine.as_deref()).await {
        Ok(t) => (
            StatusCode::OK,
            Json(json!({ "text": t.text, "segments": t.segments })),
        ),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

#[cfg(test)]
mod gateway_tts_tests {
    use super::*;

    use axum::{http::header::CONTENT_TYPE, routing::post, Router};
    use tokio::net::TcpListener;

    /// The prompt must ride under `input`. The Gateway's inbound firewall scans
    /// `body["input"]` for Tts, so sending Core's own field name (`text`) would
    /// route correctly and silently skip the scan.
    #[test]
    fn payload_uses_input_not_text() {
        let p = gateway_tts_payload("tts-1", Some("nova"), None, "hello there");
        assert_eq!(p["input"], "hello there");
        assert!(
            p.get("text").is_none(),
            "`text` bypasses the gateway firewall scan: {p}"
        );
        assert_eq!(p["voice"], "nova");
        assert_eq!(p["response_format"], "wav");
        assert_eq!(p["model"], "tts-1");
        assert!(p.get("speed").is_none());
    }

    /// OpenAI's `/v1/audio/speech` 400s without a `voice`, and the stored
    /// preference is `""` for anyone who picked the engine before a voice list
    /// existed. Both "absent" and "empty" must therefore resolve to a real voice.
    #[test]
    fn payload_always_carries_a_voice() {
        for voice in [None, Some(""), Some("   ")] {
            let p = gateway_tts_payload("tts-1", voice, None, "hi");
            assert_eq!(
                p["voice"], DEFAULT_GATEWAY_TTS_VOICE,
                "empty voice must fall back, got {p}"
            );
        }
        let p = gateway_tts_payload("tts-1", Some("shimmer"), Some(1.25), "hi");
        assert_eq!(p["voice"], "shimmer");
        assert_eq!(p["speed"], 1.25);
    }

    #[test]
    fn audio_cpp_payload_uses_native_model_and_request_options() {
        let request = SpeakRequest {
            text: "hello".to_string(),
            engine: Some("audiocpp".to_string()),
            voice: Some("alba".to_string()),
            speed: Some(1.15),
            language: Some("en".to_string()),
            reference_audio: Some("/tmp/reference.wav".to_string()),
        };
        let payload = audio_cpp_tts_payload(&request, "hello");
        assert_eq!(
            payload["model"],
            crate::sidecar::providers::audiocpp::DEFAULT_TTS_MODEL_ID
        );
        assert_eq!(payload["input"], "hello");
        assert_eq!(payload["voice"], "alba");
        let speaking_rate = payload["options"]["speaking_rate"]
            .as_f64()
            .expect("speaking_rate should be numeric");
        assert!((speaking_rate - 1.15).abs() < 0.000_001);
        assert_eq!(payload["language"], "en");
        assert_eq!(payload["voice_ref"], "/tmp/reference.wav");
        assert!(payload.get("text").is_none());
    }

    #[test]
    fn audio_cpp_payload_defaults_to_alba() {
        let request = SpeakRequest {
            text: "hello".to_string(),
            engine: Some("audiocpp".to_string()),
            voice: Some("   ".to_string()),
            speed: None,
            language: None,
            reference_audio: None,
        };
        let payload = audio_cpp_tts_payload(&request, "hello");
        assert_eq!(
            payload["voice"],
            crate::sidecar::providers::audiocpp::DEFAULT_TTS_VOICE
        );
        assert!(payload.get("options").is_none());
    }

    #[tokio::test]
    async fn audio_cpp_http_adapter_accepts_wav_output() {
        let app = Router::new().route(
            "/v1/audio/speech",
            post(|| async { ([(CONTENT_TYPE, "audio/wav")], b"RIFF-test-wav".to_vec()) }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let request = SpeakRequest {
            text: "hello".to_string(),
            engine: Some("audiocpp".to_string()),
            voice: None,
            speed: None,
            language: None,
            reference_audio: None,
        };
        let audio = synth_via_audio_cpp_at(
            &reqwest::Client::new(),
            &format!("http://{address}"),
            &request,
            "hello",
        )
        .await
        .expect("audio.cpp adapter should accept WAV output");
        assert_eq!(audio, b"RIFF-test-wav");
    }

    /// The default install must NOT pin a provider: the Gateway resolves slot
    /// override → modality_map → model routing, so an unconditional slot header
    /// would silently override the TTS provider the user picked in Settings.
    #[test]
    fn slot_headers_are_sent_only_when_explicitly_pinned() {
        let client = reqwest::Client::new();
        let payload = gateway_tts_payload("tts-1", Some("alloy"), None, "hi");

        let unpinned = build_gateway_tts_request(
            &client,
            "http://127.0.0.1:1/v1/audio/speech",
            "ryu-local",
            &payload,
            None,
            None,
        )
        .build()
        .expect("request builds");
        assert!(
            unpinned.headers().get("x-ryu-slot-tts-provider").is_none(),
            "an unpinned node must let modality_map decide the TTS provider"
        );
        assert!(unpinned.headers().get("x-ryu-slot-tts-model").is_none());
        assert!(unpinned.headers().get("authorization").is_some());

        let pinned = build_gateway_tts_request(
            &client,
            "http://127.0.0.1:1/v1/audio/speech",
            "ryu-local",
            &payload,
            Some("groq"),
            Some("playai-tts"),
        )
        .build()
        .expect("request builds");
        assert_eq!(
            pinned.headers()["x-ryu-slot-tts-provider"],
            "groq",
            "an explicit RYU_TTS_GATEWAY_PROVIDER must still win"
        );
        assert_eq!(pinned.headers()["x-ryu-slot-tts-model"], "playai-tts");
    }

    /// Env-driven pins, asserted in one test because the vars are process-global
    /// and parallel tests would race each other over them.
    #[test]
    fn slot_overrides_read_env_and_ignore_blanks() {
        std::env::remove_var("RYU_TTS_GATEWAY_PROVIDER");
        std::env::remove_var("RYU_TTS_GATEWAY_MODEL");
        assert_eq!(gateway_tts_slot_overrides(), (None, None));

        std::env::set_var("RYU_TTS_GATEWAY_PROVIDER", "   ");
        assert_eq!(
            gateway_tts_slot_overrides().0,
            None,
            "a blank pin must not count as pinned"
        );

        std::env::set_var("RYU_TTS_GATEWAY_PROVIDER", "groq");
        std::env::set_var("RYU_TTS_GATEWAY_MODEL", "playai-tts");
        assert_eq!(
            gateway_tts_slot_overrides(),
            (Some("groq".into()), Some("playai-tts".into()))
        );

        std::env::remove_var("RYU_TTS_GATEWAY_PROVIDER");
        std::env::remove_var("RYU_TTS_GATEWAY_MODEL");
    }

    /// The row is what makes `engine=gateway` selectable at all, and its
    /// `default_voice` is what the desktop stores when the engine is picked
    /// (`handleTtsEngine` writes `next?.default_voice ?? ""`). An empty one ships
    /// a request OpenAI rejects.
    #[test]
    fn engine_row_offers_a_real_default_voice() {
        let row = gateway_tts_engine_row();
        assert_eq!(row["id"], "gateway");
        assert_eq!(row["installed"], true);
        let default_voice = row["default_voice"].as_str().unwrap();
        assert!(!default_voice.is_empty(), "default_voice must not be empty");
        let voices = row["voices"].as_array().unwrap();
        assert!(!voices.is_empty(), "an empty list renders an empty picker");
        assert!(
            voices.iter().any(|v| v == default_voice),
            "the default voice must be one of the offered voices"
        );
    }
}

#[cfg(test)]
mod speech_processing_tests {
    use super::*;

    #[test]
    fn s1_payload_matches_the_published_input_contract() {
        let request = SpeechProcessingRequest {
            text: "so um send the report by uh friday".to_owned(),
            engine: None,
            styling: Some("semi-formal".to_owned()),
            structure: Some("prose".to_owned()),
            context: Some("general".to_owned()),
        };
        let payload = s1_payload("s1-mini-q4_k_m", &request).expect("valid S1 request");
        assert_eq!(payload["model"], "s1-mini-q4_k_m");
        assert_eq!(payload["temperature"], 0);
        assert_eq!(payload["stream"], false);
        assert_eq!(payload["chat_template_kwargs"]["enable_thinking"], false);
        assert_eq!(payload["messages"][0]["content"], S1_MINI_SYSTEM_PROMPT);
        assert_eq!(
            payload["messages"][1]["content"],
            "[Styling: semi-formal] [Structure: prose] [Context: general]\nso um send the report by uh friday"
        );
    }

    #[test]
    fn s1_payload_applies_defaults_and_rejects_unknown_controls() {
        let defaults = SpeechProcessingRequest {
            text: "hello".to_owned(),
            engine: Some("s1-mini".to_owned()),
            styling: None,
            structure: None,
            context: None,
        };
        let payload = s1_payload("s1-mini-q4_k_m", &defaults).expect("defaults are valid");
        assert_eq!(
            payload["messages"][1]["content"],
            "[Styling: semi-formal] [Structure: prose] [Context: general]\nhello"
        );

        let mut invalid = defaults;
        invalid.styling = Some("creative".to_owned());
        assert!(s1_payload("s1-mini-q4_k_m", &invalid)
            .unwrap_err()
            .contains("unsupported S1-mini styling"));

        let mut unknown_engine = invalid;
        unknown_engine.styling = None;
        unknown_engine.engine = Some("chat".to_owned());
        assert!(s1_payload("s1-mini-q4_k_m", &unknown_engine)
            .unwrap_err()
            .contains("unknown Speech Processing engine"));
    }

    #[test]
    fn s1_payload_rejects_empty_transcripts() {
        let request = SpeechProcessingRequest {
            text: "   ".to_owned(),
            engine: None,
            styling: None,
            structure: None,
            context: None,
        };
        assert_eq!(
            s1_payload("s1-mini-q4_k_m", &request).unwrap_err(),
            "missing `text` (the raw transcript to clean)"
        );
    }
}
