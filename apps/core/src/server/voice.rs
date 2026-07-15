//! Voice engine data path — speech-to-text transcription.
//!
//! `POST /api/voice/transcribe` accepts a multipart upload with a `file` field
//! (the audio) and proxies it to the running whisper.cpp voice sidecar's
//! `/inference` endpoint, returning `{ "text": "..." }`. This is the consumer
//! that makes the voice engine callable: install + start `whispercpp` from the
//! Store, then POST audio here.
//!
//! Per the Core-vs-Gateway rule this is **Core** (it decides *what runs* — which
//! local voice engine handles the audio). Routing STT through per-attribute
//! Gateway slots (`x-ryu-slot-stt-*`) is a separate, future enhancement.

use axum::{
    extract::{Multipart, Query, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::sidecar::providers::whispercpp::whisper_base_url;

use super::ServerState;

/// One timestamped transcript segment. Serialized camelCase
/// (`startMs`/`endMs`/`text`) so it matches the cross-surface clip contract.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// A transcription result: the full text plus optional timestamped segments.
/// Segments are populated whenever the engine returns them (Whisper
/// `verbose_json` via the Gateway or local whisper.cpp); parakeet returns text
/// only, so its `segments` is empty.
#[derive(Debug, Clone, Default)]
pub struct Transcription {
    pub text: String,
    pub segments: Vec<TranscriptSegment>,
}

/// Parse OpenAI/whisper `verbose_json` `segments` (each with `start`/`end` in
/// seconds and `text`) into millisecond [`TranscriptSegment`]s. An absent or
/// malformed array yields an empty vec.
fn parse_verbose_segments(body: &Value) -> Vec<TranscriptSegment> {
    body.get("segments")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|s| {
                    let start = s.get("start").and_then(Value::as_f64)?;
                    let end = s.get("end").and_then(Value::as_f64)?;
                    let text = s
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    Some(TranscriptSegment {
                        start_ms: (start.max(0.0) * 1000.0) as u64,
                        end_ms: (end.max(0.0) * 1000.0) as u64,
                        text,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Optional `?engine=` selector for the transcription engine.
#[derive(Debug, Deserialize)]
pub struct TranscribeQuery {
    /// `"parakeet"` (default), `"whisper"` (local whisper.cpp), or `"gateway"`
    /// (Gateway-routed Whisper — the swappable cloud STT slot, default Groq).
    /// When omitted, the cross-surface default from [`default_stt_engine`] is used.
    #[serde(default)]
    pub engine: Option<String>,
}

/// The cross-surface default STT engine, resolved as a swappable default (never
/// a hardcoded literal). Parakeet v3 (in-process ONNX) is the default whenever
/// this Core build compiled the `voice-parakeet` feature — the shipped dev and
/// release binaries do (see `apps/core/package.json` + `scripts/dev.js`), so the
/// installed app transcribes with parakeet out of the box. Lean CI/`cargo test`
/// builds omit the feature and fall back to whisper.cpp so transcription still
/// works there. `RYU_STT_ENGINE` overrides both, so one env var re-points every
/// surface (mirrors [`crate::sidecar::providers::ryutts::default_tts_engine`]).
pub fn default_stt_engine() -> String {
    if let Ok(env_engine) = std::env::var("RYU_STT_ENGINE") {
        let trimmed = env_engine.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    #[cfg(feature = "voice-parakeet")]
    {
        "parakeet".to_string()
    }
    #[cfg(not(feature = "voice-parakeet"))]
    {
        "whisper".to_string()
    }
}

/// Request body for text-to-speech synthesis.
#[derive(Debug, Deserialize)]
pub struct SpeakRequest {
    /// The text to speak.
    pub text: String,
    /// Engine selector. Omitted or `"outetts"` → the built-in OuteTTS engine
    /// (backward compatible). Any other id (e.g. `"kitten"`, `"pocket"`) is
    /// served by the universal Ryu TTS sidecar (`apps/tts-sidecar`).
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

/// `POST /api/voice/speak` — synthesize speech from text, returning a `audio/wav`
/// body. Engine selection mirrors `/api/voice/transcribe`'s `?engine=` pattern:
/// omitted (or `"outetts"`) runs the built-in OuteTTS `llama-tts` path; any other
/// engine id is proxied to the universal Ryu TTS sidecar's `/generate`. Nothing
/// is hardcoded — the available engines are whatever the sidecar registry serves.
#[utoipa::path(
    post,
    path = "/api/voice/speak",
    tag = "Voice",
    summary = "synthesize speech from text, returning a `audio/wav",
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
                Json(json!({ "error": format!("text-to-speech failed: {e:#}") })),
            )
                .into_response(),
        };
    }

    // Everything else (incl. the Kokoro default): proxy to the Ryu TTS sidecar's
    // normalized /generate. If the sidecar is down or the engine can't render (e.g.
    // the sidecar runtime isn't provisioned yet on this node), degrade gracefully to
    // the always-available OuteTTS fallback so spoken output never hard-fails.
    match synth_via_sidecar(&state, &engine, &req, text).await {
        Ok(wav) => (StatusCode::OK, [(header::CONTENT_TYPE, "audio/wav")], wav).into_response(),
        Err(sidecar_err) => {
            tracing::warn!(
                engine = %engine,
                "TTS sidecar synthesis failed ({sidecar_err}); falling back to OuteTTS"
            );
            match crate::sidecar::providers::outetts::synthesize(text).await {
                Ok(wav) => {
                    (StatusCode::OK, [(header::CONTENT_TYPE, "audio/wav")], wav).into_response()
                }
                Err(fallback_err) => (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({
                        "error": format!(
                            "TTS engine '{engine}' failed ({sidecar_err}) and the OuteTTS \
                             fallback also failed ({fallback_err:#})."
                        )
                    })),
                )
                    .into_response(),
            }
        }
    }
}

/// Proxy one synthesis request to the Ryu TTS sidecar's `/generate`, returning the
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
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ryu TTS sidecar not reachable at {url}: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!(
            "ryu-tts engine '{engine}' returned {status}: {detail}"
        ));
    }

    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("reading ryu-tts audio failed: {e}"))
}

/// `GET /api/voice/tts-engines` — list available TTS engines for the desktop
/// picker. Always includes the built-in `outetts`, then mirrors the Ryu TTS
/// sidecar's `/engines` catalog when it is reachable (so the set is whatever the
/// sidecar registry serves — nothing hardcoded). When the sidecar is down, only
/// the built-in is returned.
#[utoipa::path(
    get,
    path = "/api/voice/tts-engines",
    tag = "Voice",
    summary = "list available TTS engines for the desktop",
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

    let mut engines = vec![builtin];
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

/// `GET /api/voice/tts-models` — the curated, installable TTS model catalog (the
/// voicebox-style known-good set, each model bound to its engine + cache state).
/// Distinct from the raw HF `pipeline_tag=text-to-speech` browse in the Models
/// tab: these are the models Core can actually install + run. Empty when the Ryu
/// TTS sidecar is not running.
#[utoipa::path(
    get,
    path = "/api/voice/tts-models",
    tag = "Voice",
    summary = "the curated, installable TTS model catalog (the",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn tts_models(State(state): State<ServerState>) -> impl IntoResponse {
    let models = match crate::sidecar::providers::ryutts::list_models(&state.client).await {
        Ok(Value::Array(rows)) => rows,
        _ => Vec::new(),
    };
    (
        StatusCode::OK,
        Json(json!({ "object": "list", "data": models })),
    )
        .into_response()
}

/// Request body for installing a curated TTS model.
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
    let label = format!("TTS model: {model_name}");

    let result = state
        .downloads
        .register_indeterminate(
            format!("tts-model:{engine}:{model_name}"),
            crate::downloads::DownloadKind::Model,
            label,
            async move {
                crate::sidecar::providers::ryutts::install_model(&client, &engine, &model_name)
                    .await
            },
        )
        .await;

    match result {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("installing TTS model failed: {e:#}") })),
        )
            .into_response(),
    }
}

/// Transcribe raw audio bytes to text. Routes to the in-process parakeet engine
/// (the default — see [`default_stt_engine`]) or the whisper.cpp voice server
/// (`engine == Some("whisper")`).
///
/// This is the reusable core of [`transcribe`], factored out so other Core
/// callers (e.g. the meetings pipeline) can transcribe a WAV chunk without going
/// through an HTTP multipart handler. Returns the transcript or a human-readable
/// error string.
pub async fn transcribe_wav(
    client: &reqwest::Client,
    bytes: Vec<u8>,
    filename: String,
    engine: Option<&str>,
) -> Result<String, String> {
    transcribe_wav_detailed(client, bytes, filename, engine)
        .await
        .map(|t| t.text)
}

/// Like [`transcribe_wav`] but also returns timestamped segments when the engine
/// provides them (Whisper `verbose_json` via the Gateway or local whisper.cpp).
/// Parakeet (the in-process default) returns text only, so its segments are empty.
pub async fn transcribe_wav_detailed(
    client: &reqwest::Client,
    bytes: Vec<u8>,
    filename: String,
    engine: Option<&str>,
) -> Result<Transcription, String> {
    // Resolve the engine: an explicit non-empty selector wins; otherwise fall
    // back to the swappable cross-surface default (parakeet where compiled in).
    let engine = engine
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(default_stt_engine);

    // Route to the in-process parakeet engine (default). Text only — no segments.
    if engine == "parakeet" {
        return crate::sidecar::providers::parakeet::transcribe(bytes, filename)
            .await
            .map(|text| Transcription {
                text,
                segments: Vec::new(),
            })
            .map_err(|e| format!("parakeet transcription failed: {e:#}"));
    }

    // Gateway-routed Whisper: the swappable cloud STT slot (default provider
    // OpenAI, default model Groq's `whisper-large-v3`). Core emits only the
    // per-attribute slot headers + a bearer to the Gateway — never a raw provider
    // key (CLAUDE.md §1: routing/measuring the model call is a Gateway concern).
    if engine == "gateway" {
        return transcribe_via_gateway(client, bytes).await;
    }

    // Default: forward to whisper.cpp's `/inference` multipart endpoint. Request
    // `verbose_json` so the response carries per-segment timings (whisper.cpp
    // degrades to a plain `{ "text": ... }` when it can't, which parses to no
    // segments — never an error).
    let part = reqwest::multipart::Part::bytes(bytes).file_name(filename);
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("response_format", "verbose_json");

    let url = format!("{}/inference", whisper_base_url());
    let resp = client
        .post(&url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            format!(
                "whisper voice engine not reachable at {url}: {e}. \
             Install + start `whispercpp` from the Store first."
            )
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("whisper returned {status}: {body}"));
    }

    // whisper.cpp returns `{ "text": "...", "segments": [...] }` for verbose_json.
    let value: Value = resp
        .json()
        .await
        .map_err(|e| format!("could not parse whisper response: {e}"))?;
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let segments = parse_verbose_segments(&value);
    Ok(Transcription { text, segments })
}

/// Transcribe audio through the Gateway's `/v1/audio/transcriptions`, the
/// swappable cloud STT slot. The audio is base64-encoded into a JSON body (Core
/// carries no multipart to the Gateway) with the per-attribute slot headers that
/// tell the Gateway which provider/model to route to. Bearer is the Gateway
/// token slot — never a raw provider API key.
///
/// FLAG (whisper-gateway, pre-existing gap owned by `apps/gateway`, out of scope
/// here): for true end-to-end the Gateway's OpenAI provider must re-multipart
/// this base64 audio upstream — real Groq/OpenAI `/audio/transcriptions` need a
/// multipart file, but `providers/openai.rs:166` currently forwards JSON verbatim.
/// The Gateway owner must also point `modality_map[Stt]`/`base_url` at Groq. Until
/// then, set `RYU_CLIP_STT_ENGINE=whisper` (local whisper.cpp) to ship without
/// waiting — and captions-first means most YouTube ingests never hit Whisper.
async fn transcribe_via_gateway(
    client: &reqwest::Client,
    bytes: Vec<u8>,
) -> Result<Transcription, String> {
    use base64::Engine as _;

    let audio_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    let provider = std::env::var("RYU_STT_GATEWAY_PROVIDER")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "openai".to_string());
    let model = std::env::var("RYU_STT_GATEWAY_MODEL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "whisper-large-v3".to_string());

    let base = crate::sidecar::gateway::gateway_url();
    let base = base.trim_end_matches('/');
    let url = format!("{base}/v1/audio/transcriptions");
    let bearer = crate::sidecar::gateway::gateway_bearer().map_err(|e| e.to_string())?;

    let payload = json!({
        "model": model,
        "file": audio_b64,
        "response_format": "verbose_json",
    });

    let resp = client
        .post(&url)
        .bearer_auth(bearer)
        .header("x-ryu-slot-stt-provider", &provider)
        .header("x-ryu-slot-stt-model", &model)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("gateway STT unreachable at {url}: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("gateway STT returned {status}: {detail}"));
    }

    let value: Value = resp
        .json()
        .await
        .map_err(|e| format!("could not parse gateway STT response: {e}"))?;
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let segments = parse_verbose_segments(&value);
    Ok(Transcription { text, segments })
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
