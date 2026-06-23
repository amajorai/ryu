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

/// Optional `?engine=` selector for the transcription engine.
#[derive(Debug, Deserialize)]
pub struct TranscribeQuery {
    /// `"whisper"` (default) or `"parakeet"`. When omitted, whisper is used.
    #[serde(default)]
    pub engine: Option<String>,
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

    let engine = req.engine.as_deref().unwrap_or("outetts");

    // Built-in default: OuteTTS via the shared llama-tts binary (no sidecar).
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

    // Everything else: proxy to the Ryu TTS sidecar's normalized /generate.
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

    let resp = match state.client.post(&url).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "error": format!(
                        "Ryu TTS sidecar not reachable at {url}: {e}. Install + start the \
                         \"Ryu TTS\" voice engine from the Store (or run `bun run dev:tts`)."
                    )
                })),
            )
                .into_response();
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return (
            StatusCode::BAD_GATEWAY,
            Json(
                json!({ "error": format!("ryu-tts engine '{engine}' returned {status}: {detail}") }),
            ),
        )
            .into_response();
    }

    match resp.bytes().await {
        Ok(wav) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "audio/wav")],
            wav.to_vec(),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("reading ryu-tts audio failed: {e}") })),
        )
            .into_response(),
    }
}

/// `GET /api/voice/tts-engines` — list available TTS engines for the desktop
/// picker. Always includes the built-in `outetts`, then mirrors the Ryu TTS
/// sidecar's `/engines` catalog when it is reachable (so the set is whatever the
/// sidecar registry serves — nothing hardcoded). When the sidecar is down, only
/// the built-in is returned.
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
/// (`engine == Some("parakeet")`) or the whisper.cpp voice server (default).
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
    // Route to the parakeet engine when explicitly requested.
    if engine == Some("parakeet") {
        return crate::sidecar::providers::parakeet::transcribe(bytes, filename)
            .await
            .map_err(|e| format!("parakeet transcription failed: {e:#}"));
    }

    // Default: forward to whisper.cpp's `/inference` multipart endpoint.
    let part = reqwest::multipart::Part::bytes(bytes).file_name(filename);
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("response_format", "json");

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

    // whisper.cpp returns `{ "text": "..." }`; tolerate either a JSON object or a
    // raw string body.
    let value: Value = resp
        .json()
        .await
        .map_err(|e| format!("could not parse whisper response: {e}"))?;
    Ok(value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string())
}

/// Transcribe an uploaded audio file. Routes to the whisper.cpp voice server
/// (HTTP proxy, default) or the in-process parakeet engine (`?engine=parakeet`).
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

    match transcribe_wav(&state.client, bytes, filename, query.engine.as_deref()).await {
        Ok(text) => (StatusCode::OK, Json(json!({ "text": text }))),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}
