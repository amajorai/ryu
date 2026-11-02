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
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

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
    /// Optional BCP-47 language hint (`auto` = detect) for engines that accept
    /// one (whisper.cpp, audio.cpp, Gateway); others ignore it.
    #[serde(default)]
    pub language: Option<String>,
}

/// Request body for Audio synthesis.
///
/// Everything past `reference_audio_data_url` is the optional studio contract
/// (seed, delivery instruction, reference transcript, post effects, loudness
/// normalization, output container). Core validates the bounds here and
/// forwards them verbatim to the Ryu Audio sidecar's `/generate`. The built-in
/// OuteTTS, native audio.cpp, and Gateway paths cannot honor them, so they
/// ignore them and keep returning their native container (WAV for the local
/// engines, the provider's MIME for the Gateway) under a truthful
/// `Content-Type` rather than pretending to transcode.
#[derive(Debug, Default, Deserialize)]
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
    /// A bounded WAV data URL submitted by the Voice Studio host bridge.
    /// Core stages it under the private voice reference directory for one request.
    #[serde(default)]
    pub reference_audio_data_url: Option<String>,
    /// Deterministic sampling seed for engines that accept one.
    #[serde(default)]
    pub seed: Option<u32>,
    /// Delivery/style instruction, or the voice description for voice-design
    /// engines. Ignored by engines without `supports_instruct`.
    #[serde(default)]
    pub instruct: Option<String>,
    /// Transcript of the reference sample, for cloning engines that use it.
    #[serde(default)]
    pub reference_text: Option<String>,
    /// Post-synthesis effect chain, applied in order by the sidecar.
    #[serde(default)]
    pub effects: Option<Vec<SpeakEffect>>,
    /// Loudness normalization target applied after effects.
    #[serde(default)]
    pub normalize: Option<SpeakNormalize>,
    /// Output container; `wav` when omitted.
    #[serde(default)]
    pub format: Option<SpeakFormat>,
}

/// Upper bounds for the optional studio fields. Mirrored by the host bridge's
/// `media.tts` schema so a frame gets the same answer at either boundary.
/// Longest script one request may carry; the Studio splits longer scripts
/// itself. Matches the sidecar's `/generate` bound so a long take is refused
/// here instead of being proxied and rejected there.
const MAX_SPEAK_TEXT_CHARS: usize = 50_000;
/// Read-aloud length for a managed member: a long reply, not a bulk job.
const MAX_MEMBER_SPEAK_TEXT_CHARS: usize = 8_000;

/// A built-in voice name (`alba`, `en_US-amy-medium`), never a path or URL.
/// Some engines treat `voice` as an audio prompt they load or fetch, which is
/// voice cloning (and a fetch from the speech sidecar), so only the node owner
/// may pass anything else.
pub(crate) fn is_plain_voice_id(voice: &str) -> bool {
    // A bare audio file name (`owner.wav`) could resolve against the speech
    // sidecar's working directory, so it is not a voice name either.
    const AUDIO_EXTENSIONS: [&str; 6] = [".wav", ".mp3", ".flac", ".ogg", ".m4a", ".opus"];
    let lower = voice.to_ascii_lowercase();
    !voice.is_empty()
        && voice.len() <= 64
        && !voice.starts_with('.')
        && voice
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
        && !AUDIO_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// A managed member's voice request (not the owner's boundary) must pass the
/// same `agent.run` RBAC as typed chat, since dictation and read-aloud are part
/// of chatting. The owner token, with or without an identity header, keeps its
/// existing trust.
async fn enforce_member_voice_permission(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    member: bool,
) -> Result<(), (StatusCode, Json<Value>)> {
    if !member {
        return Ok(());
    }
    super::enforce_permission(
        state,
        caller,
        crate::identity_verify::permissions::AGENT_RUN,
    )
    .await
    .map_err(|status| {
        (
            status,
            Json(json!({ "error": "insufficient permissions: agent.run" })),
        )
    })
}

fn is_member_request(
    authorization: Option<&axum::Extension<super::ResolvedAuthorization>>,
) -> bool {
    !authorization.is_some_and(|axum::Extension(value)| value.context.is_owner())
}

/// Why a managed member is refused the node's Gateway audio slots. The node's
/// Gateway credential carries no per-member attribution or budget, so the
/// cloud STT/TTS slots stay owner-only; members use the local engines.
pub(crate) const MEMBER_GATEWAY_AUDIO_REFUSAL: &str =
    "cloud (gateway) audio is available to the node owner only; choose a local engine";

/// Whether `requested` (or, when it is unset or blank, `default_engine`)
/// names the Gateway slot. Case-insensitive so a differently cased selector
/// cannot slip past the owner-only check.
fn selects_gateway_engine(
    requested: Option<&str>,
    default_engine: impl FnOnce() -> String,
) -> bool {
    let requested = requested.map(str::trim).filter(|value| !value.is_empty());
    match requested {
        Some(engine) => engine.eq_ignore_ascii_case("gateway"),
        None => default_engine().trim().eq_ignore_ascii_case("gateway"),
    }
}

/// Whether an STT engine selector resolves to the Gateway slot, including when
/// it is unset and the node default (`RYU_STT_ENGINE`) points there.
pub(crate) fn stt_engine_uses_gateway(requested: Option<&str>) -> bool {
    selects_gateway_engine(requested, default_stt_engine)
}

/// Whether a TTS engine selector resolves to the Gateway slot, including when
/// it is unset and the node's default TTS engine points there.
pub(crate) fn tts_engine_uses_gateway(requested: Option<&str>) -> bool {
    selects_gateway_engine(
        requested,
        crate::sidecar::providers::ryutts::default_tts_engine,
    )
}

mod engines;
mod gateway_tts;
mod reference_audio;
mod speak_options;
mod speak_route;
mod speech_processing;

pub use engines::*;
pub(crate) use gateway_tts::*;
pub(crate) use reference_audio::*;
pub use speak_options::*;
pub use speak_route::*;
pub use speech_processing::*;

/// Transcribe an uploaded audio file. Routes to the in-process parakeet engine
/// (default) or the whisper.cpp voice server (`?engine=whisper`, HTTP proxy).
/// `auto` or a BCP-47-shaped tag (`en`, `pt-BR`, `zh-Hant`), at most 35 bytes.
fn is_language_hint(hint: &str) -> bool {
    if hint == "auto" {
        return true;
    }
    let mut parts = hint.split('-');
    let primary_ok = parts.next().is_some_and(|primary| {
        (2..=3).contains(&primary.len()) && primary.bytes().all(|b| b.is_ascii_alphabetic())
    });
    hint.len() <= 35
        && primary_ok
        && parts.all(|part| {
            (2..=8).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_alphanumeric())
        })
}

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
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    authorization: Option<axum::Extension<super::ResolvedAuthorization>>,
    Query(query): Query<TranscribeQuery>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let member = is_member_request(authorization.as_ref());
    if let Err(response) = enforce_member_voice_permission(&state, &caller, member).await {
        return response;
    }
    // The Gateway STT slot is owner-only (no per-member attribution or budget),
    // whether named by `?engine=` or reached through the node default.
    if member && stt_engine_uses_gateway(query.engine.as_deref()) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": MEMBER_GATEWAY_AUDIO_REFUSAL })),
        );
    }
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

    let language = query
        .language
        .as_deref()
        .filter(|hint| is_language_hint(hint));
    match transcribe_wav_detailed(
        &state.client,
        bytes,
        filename,
        query.engine.as_deref(),
        language,
    )
    .await
    {
        Ok(t) => (
            StatusCode::OK,
            Json(json!({ "text": t.text, "segments": t.segments, "words": t.words })),
        ),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

#[cfg(test)]
mod gateway_tts_tests;
#[cfg(test)]
mod member_gateway_audio_tests;
#[cfg(test)]
mod speak_contract_tests;
#[cfg(test)]
mod speech_processing_tests;
#[cfg(test)]
mod transcribe_language_tests;
#[cfg(test)]
mod tts_engine_tests;
