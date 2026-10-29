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

const MAX_SPEAK_INSTRUCT_CHARS: usize = 500;
const MAX_SPEAK_REFERENCE_TEXT_CHARS: usize = 1000;
const MAX_SPEAK_EFFECTS: usize = 12;
const MAX_SPEAK_EFFECT_PARAMS: usize = 16;
const MAX_SPEAK_EFFECT_PARAM_NAME: usize = 40;

/// One post-synthesis effect. `params` are effect-specific numeric knobs
/// (e.g. `{"gain_db": -3}` for gain); the sidecar owns their names, ranges, and
/// defaults, and rejects unknown names with a 422 that Core passes through.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SpeakEffect {
    #[serde(rename = "type")]
    pub kind: SpeakEffectKind,
    #[serde(default)]
    pub params: BTreeMap<String, f64>,
}

/// The closed effect vocabulary the sidecar implements.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeakEffectKind {
    Gain,
    Highpass,
    Lowpass,
    Compressor,
    Reverb,
    Echo,
    PitchShift,
}

/// Loudness targets: `peak` is -1 dBFS peak, `podcast` -16 LUFS, `acx` the
/// audiobook RMS window with a -3 dBFS peak cap.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SpeakNormalize {
    Off,
    Peak,
    Podcast,
    Acx,
}

/// Output containers the sidecar can encode.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SpeakFormat {
    Wav,
    Mp3,
    Ogg,
    Flac,
}

/// Parse and bound-check a `/api/voice/speak` body. Serde rejects unknown
/// enum values and out-of-range seeds; the explicit checks cover lengths,
/// counts, and non-finite effect parameters. Every failure is a caller error.
fn parse_speak_request(body: Value) -> Result<SpeakRequest, String> {
    let req: SpeakRequest =
        serde_json::from_value(body).map_err(|error| format!("invalid speak request: {error}"))?;
    validate_speak_options(&req)?;
    Ok(req)
}

fn validate_speak_options(req: &SpeakRequest) -> Result<(), String> {
    if req.text.chars().count() > MAX_SPEAK_TEXT_CHARS {
        return Err(format!(
            "text must be at most {MAX_SPEAK_TEXT_CHARS} characters"
        ));
    }
    if req
        .instruct
        .as_deref()
        .is_some_and(|value| value.chars().count() > MAX_SPEAK_INSTRUCT_CHARS)
    {
        return Err(format!(
            "instruct must be at most {MAX_SPEAK_INSTRUCT_CHARS} characters"
        ));
    }
    if req
        .reference_text
        .as_deref()
        .is_some_and(|value| value.chars().count() > MAX_SPEAK_REFERENCE_TEXT_CHARS)
    {
        return Err(format!(
            "reference_text must be at most {MAX_SPEAK_REFERENCE_TEXT_CHARS} characters"
        ));
    }
    if let Some(speed) = req.speed {
        if !speed.is_finite() || speed < 0.0 {
            return Err("speed must be a finite, non-negative number".to_owned());
        }
    }
    let Some(effects) = &req.effects else {
        return Ok(());
    };
    if effects.len() > MAX_SPEAK_EFFECTS {
        return Err(format!("at most {MAX_SPEAK_EFFECTS} effects are allowed"));
    }
    for effect in effects {
        if effect.params.len() > MAX_SPEAK_EFFECT_PARAMS {
            return Err(format!(
                "an effect may carry at most {MAX_SPEAK_EFFECT_PARAMS} params"
            ));
        }
        for (name, value) in &effect.params {
            let valid_name = !name.is_empty()
                && name.len() <= MAX_SPEAK_EFFECT_PARAM_NAME
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_');
            if !valid_name {
                return Err("effect param names must be short snake_case keys".to_owned());
            }
            if !value.is_finite() {
                return Err(format!("effect param `{name}` must be a finite number"));
            }
        }
    }
    Ok(())
}

/// Copy the optional studio fields into the sidecar `/generate` body. Kept
/// separate from transport so the forwarding contract is unit-testable.
fn sidecar_generate_body(engine: &str, req: &SpeakRequest, text: &str) -> Value {
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
    if let Some(seed) = req.seed {
        body["seed"] = json!(seed);
    }
    if let Some(instruct) = req.instruct.as_deref().filter(|v| !v.trim().is_empty()) {
        body["instruct"] = json!(instruct);
    }
    if let Some(reference_text) = req
        .reference_text
        .as_deref()
        .filter(|v| !v.trim().is_empty())
    {
        body["reference_text"] = json!(reference_text);
    }
    if let Some(effects) = req.effects.as_ref().filter(|e| !e.is_empty()) {
        body["effects"] = json!(effects);
    }
    if let Some(normalize) = req.normalize {
        body["normalize"] = json!(normalize);
    }
    if let Some(format) = req.format {
        body["format"] = json!(format);
    }
    body
}

/// The audio containers Core will serve from the sidecar. A missing header is
/// a pre-format sidecar, which only ever produced WAV.
fn sidecar_audio_mime(value: Option<&str>) -> Option<&'static str> {
    let Some(value) = value else {
        return Some("audio/wav");
    };
    match value
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "" | "audio/wav" | "audio/x-wav" | "audio/wave" => Some("audio/wav"),
        "audio/mpeg" | "audio/mp3" => Some("audio/mpeg"),
        "audio/ogg" => Some("audio/ogg"),
        "audio/flac" | "audio/x-flac" => Some("audio/flac"),
        _ => None,
    }
}

/// A sidecar failure, keeping the upstream status when it is a caller error
/// (bad params, an unencodable format) so Core can answer with the same class.
#[derive(Debug)]
struct SidecarSynthError {
    status: Option<StatusCode>,
    message: String,
    /// Set when the sidecar answered 404 `unknown engine`: a configuration
    /// error that must surface as `tts_engine_unknown`, never degrade.
    unknown: Option<UnknownTtsEngine>,
}

impl std::fmt::Display for SidecarSynthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl SidecarSynthError {
    fn transport(message: String) -> Self {
        Self {
            status: None,
            message,
            unknown: None,
        }
    }

    /// Client-correctable upstream statuses pass through; everything else
    /// (unreachable, 5xx, an unexpected container) is a 502.
    fn response_status(&self) -> StatusCode {
        match self.status {
            Some(
                status @ (StatusCode::BAD_REQUEST
                | StatusCode::PAYLOAD_TOO_LARGE
                | StatusCode::UNSUPPORTED_MEDIA_TYPE
                | StatusCode::UNPROCESSABLE_ENTITY),
            ) => status,
            _ => StatusCode::BAD_GATEWAY,
        }
    }
}

/// Pull the human message out of a FastAPI-style `{"detail": ...}` or
/// `{"error": ...}` body, falling back to the raw (bounded) text.
fn sidecar_error_detail(body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        // A 422 carries `{"error": "invalid request", "detail": [{"msg": ...}]}`;
        // the per-field messages are what tell the caller which knob was wrong.
        if let Some(items) = value.get("detail").and_then(Value::as_array) {
            let messages: Vec<&str> = items
                .iter()
                .filter_map(|item| item.get("msg").and_then(Value::as_str))
                .collect();
            if !messages.is_empty() {
                return messages.join("; ");
            }
        }
        for key in ["detail", "error"] {
            if let Some(text) = value.get(key).and_then(Value::as_str) {
                return text.to_owned();
            }
        }
    }
    body.chars().take(500).collect()
}

/// Build a successful audio response with the engine provenance headers.
/// `fallback_from` names the engine that failed when OuteTTS stood in.
fn speak_audio_response(
    audio: Vec<u8>,
    content_type: &str,
    engine: &str,
    fallback_from: Option<&str>,
) -> axum::response::Response {
    let mut response = (StatusCode::OK, audio).into_response();
    let headers = response.headers_mut();
    if let Ok(value) = header::HeaderValue::from_str(content_type) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    if let Ok(value) = header::HeaderValue::from_str(engine) {
        headers.insert("x-ryu-tts-engine", value);
    }
    if let Some(failed) = fallback_from {
        let value = header::HeaderValue::from_str(failed)
            .unwrap_or_else(|_| header::HeaderValue::from_static("1"));
        headers.insert("x-ryu-tts-fallback", value);
    }
    response
}

fn speak_error(status: StatusCode, message: String) -> axum::response::Response {
    (status, Json(json!({ "error": message }))).into_response()
}

const MAX_REFERENCE_AUDIO_BYTES: usize = 512 * 1024;

fn decode_reference_audio_data_url(value: &str) -> Result<Vec<u8>, String> {
    let encoded = value
        .strip_prefix("data:audio/wav;base64,")
        .ok_or_else(|| "voice sample must be a WAV data URL".to_owned())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "voice sample is not valid base64".to_owned())?;
    if bytes.is_empty() || bytes.len() > MAX_REFERENCE_AUDIO_BYTES {
        return Err(format!(
            "voice sample must be between 1 byte and {MAX_REFERENCE_AUDIO_BYTES} bytes"
        ));
    }
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("voice sample must contain a valid WAV header".to_owned());
    }
    Ok(bytes)
}

/// Where a voice sample sent inline (`reference_audio_data_url`) is staged for
/// the length of one synthesis call: an owner-only scratch directory (0700, file
/// 0600) under the data dir's `tmp/voice`, never the persistent reference
/// directory. The voice engines need a path, so the sample is plaintext on disk
/// only while that request runs; a crash leaves an orphan that
/// [`sweep_voice_staging_at_boot`] removes when Core next starts.
fn reference_audio_staging_dir() -> PathBuf {
    crate::paths::tmp_dir_for("voice").join("reference-audio")
}

/// Remove, once per process, every voice sample a previous process left
/// staged (crash orphans in the staging directory, and the plaintext `.tmp*.wav`
/// samples earlier builds staged in the persistent reference directory). Core
/// runs it while starting; staging also runs it first, as a backstop. The sweep
/// sits behind a `Once`, so it finishes before this process stages any sample
/// and never removes one in use. Returns how many files the sweep removed (0 on
/// every call after the first).
pub(crate) fn sweep_voice_staging_at_boot() -> usize {
    static SWEPT: std::sync::Once = std::sync::Once::new();
    let mut removed = 0;
    SWEPT.call_once(|| {
        removed = sweep_staged_reference_audio(
            &reference_audio_staging_dir(),
            &crate::paths::files_path("voice").join("reference-audio"),
            std::time::Duration::ZERO,
        );
        if removed > 0 {
            tracing::info!(removed, "voice: removed orphaned staged voice samples");
        }
    });
    removed
}

fn stage_reference_audio_data_url(value: &str) -> Result<NamedTempFile, String> {
    sweep_voice_staging_at_boot();
    stage_reference_audio_data_url_in(value, &reference_audio_staging_dir())
}

/// Create `dir` (and parents) and restrict it to the owner.
fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn stage_reference_audio_data_url_in(value: &str, root: &Path) -> Result<NamedTempFile, String> {
    let bytes = decode_reference_audio_data_url(value)?;
    ensure_private_dir(root).map_err(|error| format!("voice reference directory: {error}"))?;
    // `tempfile` creates the file 0600 with a unique name and deletes it on drop.
    let mut file = tempfile::Builder::new()
        .prefix(STAGED_REFERENCE_PREFIX)
        .suffix(".wav")
        .tempfile_in(root)
        .map_err(|error| format!("creating temporary voice reference: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("staging voice reference: {error}"))?;
    file.flush()
        .map_err(|error| format!("staging voice reference: {error}"))?;
    Ok(file)
}

/// Name prefix of every staged sample (also the prefix earlier builds' staged
/// samples carried in the persistent reference directory: `tempfile`'s default).
const STAGED_REFERENCE_PREFIX: &str = ".tmp";

/// Remove staged samples left behind by a crash: every staged `.tmp*.wav` in
/// `staging` older than `min_age`, and the plaintext `.tmp*.wav` orphans earlier
/// builds staged inside the persistent reference directory `legacy` (files a user
/// placed there are never touched). Returns how many files were removed.
fn sweep_staged_reference_audio(
    staging: &Path,
    legacy: &Path,
    min_age: std::time::Duration,
) -> usize {
    let mut removed = 0;
    for (dir, min_age) in [(staging, min_age), (legacy, std::time::Duration::ZERO)] {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !(name.starts_with(STAGED_REFERENCE_PREFIX) && name.ends_with(".wav")) {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            let age = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .unwrap_or_default();
            if age < min_age {
                continue;
            }
            if std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/// Reference audio is a local-only, operator-mediated input. Do not forward raw
/// URLs or arbitrary absolute paths to a cloning backend: those backends may fetch
/// the value themselves. The narrow root also keeps voice references separate from
/// Core databases, tokens, and other node data.
fn validate_reference_audio(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(
            "reference_audio must be a file beneath the node voice reference directory".to_owned(),
        );
    }
    let root: PathBuf = crate::paths::files_path("voice").join("reference-audio");
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("voice reference directory: {error}"))?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "reference_audio file was not found".to_owned())?;
    if metadata.file_type().is_symlink() {
        return Err("reference_audio symbolic links are not allowed".to_owned());
    }
    let canonical_root = std::fs::canonicalize(&root)
        .map_err(|error| format!("voice reference directory: {error}"))?;
    // A sample sent inline is staged in the private scratch directory instead.
    let canonical_staging = std::fs::canonicalize(reference_audio_staging_dir()).ok();
    let canonical =
        std::fs::canonicalize(path).map_err(|_| "reference_audio file was not found".to_owned())?;
    let inside = canonical.starts_with(&canonical_root)
        || canonical_staging
            .as_ref()
            .is_some_and(|staging| canonical.starts_with(staging));
    if !inside || !canonical.is_file() {
        return Err(
            "reference_audio must be beneath the node voice reference directory".to_owned(),
        );
    }
    Ok(Some(canonical.to_string_lossy().into_owned()))
}

/// The exact system prompt S1-mini was trained with. Keep this literal stable:
/// the model card warns that changing it can produce empty or garbled output.
pub const S1_MINI_SYSTEM_PROMPT: &str = "You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text.";

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
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response();
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

/// `POST /api/voice/speak` — synthesize Audio from text. Engine selection mirrors
/// `/api/voice/transcribe`'s `?engine=` pattern: `"outetts"` runs the built-in
/// `llama-tts` path, `"gateway"` / `"audiocpp"` their slots, and any other engine
/// id is proxied to the universal Ryu Audio sidecar's `/generate`. Nothing is
/// hardcoded — the available engines are whatever the sidecar registry serves.
///
/// The body's `Content-Type` is the real container (`audio/wav`, `audio/mpeg`,
/// `audio/ogg`, `audio/flac`, or the Gateway provider's MIME). `x-ryu-tts-engine`
/// names the engine that rendered; `x-ryu-tts-fallback` (the failed engine id) is
/// present only when OuteTTS stood in. That fallback happens only for plain
/// read-aloud on the node's default engine (unset or named) or the `gateway`
/// slot, with no reference sample and no studio option: another named engine,
/// a clone request, or a studio take fails loudly instead of returning a
/// different voice.
#[utoipa::path(
    post,
    path = "/api/voice/speak",
    tag = "Voice",
    summary = "Synthesize audio from text (WAV by default; MP3, OGG or FLAC when requested)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn speak(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    authorization: Option<axum::Extension<super::ResolvedAuthorization>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    if let Err(response) =
        super::media::enforce_host_media_permission(&state, &caller, &headers).await
    {
        return response;
    }
    // Parse by hand so a bad enum value or an out-of-bounds field is a 400
    // with a readable message rather than axum's generic 422 rejection.
    let mut req = match parse_speak_request(body) {
        Ok(req) => req,
        Err(error) => return speak_error(StatusCode::BAD_REQUEST, error),
    };
    // Members may use read-aloud, but cloning is owner-only: a voice reference
    // (the node's stored samples or an uploaded one) or a `voice` that is a path
    // or URL rather than a built-in voice name.
    let member = is_member_request(authorization.as_ref());
    if member {
        if let Err(response) = enforce_member_voice_permission(&state, &caller, true).await {
            return response.into_response();
        }
        if req.reference_audio.is_some()
            || req.reference_audio_data_url.is_some()
            || req
                .voice
                .as_deref()
                .is_some_and(|voice| !is_plain_voice_id(voice))
        {
            return speak_error(
                StatusCode::FORBIDDEN,
                "custom and cloned voices are available to the node owner only".to_owned(),
            );
        }
        if req.text.chars().count() > MAX_MEMBER_SPEAK_TEXT_CHARS {
            return speak_error(
                StatusCode::BAD_REQUEST,
                format!("text must be at most {MAX_MEMBER_SPEAK_TEXT_CHARS} characters"),
            );
        }
    }
    if req.reference_audio.is_some() && req.reference_audio_data_url.is_some() {
        return speak_error(
            StatusCode::BAD_REQUEST,
            "provide one voice reference sample".to_owned(),
        );
    }
    let staged_reference = match req.reference_audio_data_url.as_deref() {
        Some(value) => match stage_reference_audio_data_url(value) {
            Ok(file) => Some(file),
            Err(error) => return speak_error(StatusCode::BAD_REQUEST, error),
        },
        None => None,
    };
    let staged_reference_path = staged_reference
        .as_ref()
        .map(|file| file.path().to_string_lossy().into_owned());
    let reference_input = req
        .reference_audio
        .as_deref()
        .or(staged_reference_path.as_deref());
    let reference_audio = match validate_reference_audio(reference_input) {
        Ok(value) => value,
        Err(error) => return speak_error(StatusCode::BAD_REQUEST, error),
    };
    req.reference_audio = reference_audio;
    req.reference_audio_data_url = None;
    let text = req.text.trim().to_owned();
    if text.is_empty() {
        return speak_error(
            StatusCode::BAD_REQUEST,
            "missing `text` (the words to speak)".to_owned(),
        );
    }

    // The cross-surface default engine (Kokoro 82M) is a swappable registry default,
    // not a hardcoded literal — resolved here so one env var re-points every surface.
    let requested_engine = req
        .engine
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let default_engine = crate::sidecar::providers::ryutts::default_tts_engine();
    let may_fallback = fallback_allowed(
        requested_engine.as_deref(),
        &default_engine,
        req.reference_audio.is_some(),
        requests_studio_options(&req),
    );
    let engine = requested_engine.unwrap_or(default_engine);
    // The Gateway slot spends the node's shared Gateway credential with no
    // per-member attribution or budget, so it is owner-only, including when the
    // node's default TTS engine is `gateway`.
    if member && engine.eq_ignore_ascii_case("gateway") {
        return speak_error(
            StatusCode::FORBIDDEN,
            MEMBER_GATEWAY_AUDIO_REFUSAL.to_owned(),
        );
    }
    // An id that cannot name any engine is a caller/configuration error, not an
    // outage: refuse it instead of silently speaking with OuteTTS (same policy
    // as the realtime voice session).
    if let Err(unknown) = check_tts_engine_id(&engine) {
        return unknown_tts_engine_response(&unknown);
    }

    // Built-in engine: OuteTTS via the shared llama-tts binary (no sidecar). It
    // only renders WAV, so a requested `format` is ignored and the header says so.
    if engine == "outetts" {
        return match crate::sidecar::providers::outetts::synthesize(&text).await {
            Ok(wav) => speak_audio_response(wav, "audio/wav", &engine, None),
            Err(e) => speak_error(
                StatusCode::BAD_GATEWAY,
                format!("audio generation failed: {e:#}"),
            ),
        };
    }

    // The cloud slot: route to the Gateway's Audio modality provider. The
    // content type comes from the provider, since it may hand back mp3.
    let attempt = if engine == "gateway" {
        synth_via_gateway(
            &state.client,
            req.voice.as_deref(),
            req.speed,
            &text,
            GATEWAY_TTS_FORMAT_READ_ALOUD,
        )
        .await
        .map_err(|error| {
            (
                StatusCode::BAD_GATEWAY,
                format!("gateway Audio failed ({error})"),
            )
        })
    } else if engine == "audiocpp" {
        // Native audio.cpp is an explicit runtime choice (WAV only).
        synth_via_audio_cpp(&state.client, &req, &text)
            .await
            .map(|wav| (wav, "audio/wav".to_owned()))
            .map_err(|error| {
                (
                    StatusCode::BAD_GATEWAY,
                    format!("audio.cpp synthesis failed: {error}"),
                )
            })
    } else {
        // Everything else (incl. the Kokoro default): the Ryu Audio sidecar's
        // normalized /generate, which honors the full studio contract.
        // An id RyuTTS answers 404 `unknown engine` for is a configuration
        // error: surface it as the `tts_engine_unknown` 400, never a fallback.
        match synth_via_sidecar(&state, &engine, &req, &text).await {
            Ok((audio, content_type)) => Ok((audio, content_type.to_owned())),
            Err(SidecarSynthError {
                unknown: Some(unknown),
                ..
            }) => {
                tracing::warn!(engine = %engine, "read-aloud TTS engine is unknown: {unknown}");
                return unknown_tts_engine_response(&unknown);
            }
            Err(error) => Err((error.response_status(), error.message)),
        }
    };

    let (status, error) = match attempt {
        Ok((audio, content_type)) => {
            return speak_audio_response(audio, &content_type, &engine, None);
        }
        Err(failure) => failure,
    };
    if !may_fallback {
        return speak_error(status, error);
    }
    // The node's default engine (or the cloud slot) that cannot render here
    // (e.g. the sidecar runtime isn't provisioned yet, or a cloud outage)
    // degrades to the always-available OuteTTS so plain read-aloud never
    // hard-fails. The `x-ryu-tts-fallback` header discloses it.
    tracing::warn!(engine = %engine, "default Audio engine failed ({error}); falling back to OuteTTS");
    match crate::sidecar::providers::outetts::synthesize(&text).await {
        Ok(wav) => speak_audio_response(wav, "audio/wav", "outetts", Some(&engine)),
        Err(fallback_err) => speak_error(
            StatusCode::BAD_GATEWAY,
            format!("{error}; the OuteTTS fallback also failed ({fallback_err:#})."),
        ),
    }
}

/// OuteTTS may stand in only for plain read-aloud on the node's default engine:
/// `engine` unset, equal to the default (desktop read-aloud always sends its
/// stored preference, which is the default on a fresh install), or the
/// `gateway` cloud slot. A different named engine, a cloning request, or any
/// studio option (seed, instruction, effects, a non-WAV container, ...) means
/// the caller wants *that* output; substituting OuteTTS, which honours none of
/// it, would be wrong output, not graceful degradation.
fn fallback_allowed(
    requested_engine: Option<&str>,
    default_engine: &str,
    has_reference: bool,
    has_studio_options: bool,
) -> bool {
    if has_reference || has_studio_options {
        return false;
    }
    match requested_engine {
        None => true,
        Some(engine) => engine == default_engine || engine == "gateway",
    }
}

/// Whether the request carries any option only the sidecar can honour.
fn requests_studio_options(req: &SpeakRequest) -> bool {
    let non_blank = |value: &Option<String>| value.as_deref().is_some_and(|v| !v.trim().is_empty());
    req.seed.is_some()
        || non_blank(&req.instruct)
        || non_blank(&req.reference_text)
        || req
            .effects
            .as_ref()
            .is_some_and(|effects| !effects.is_empty())
        || req
            .normalize
            .is_some_and(|mode| mode != SpeakNormalize::Off)
        || req.format.is_some_and(|format| format != SpeakFormat::Wav)
}

/// Proxy one synthesis request to the Ryu Audio sidecar's `/generate`, returning the
/// audio bytes plus their allowlisted MIME, or the failure with the upstream status.
/// A sidecar `unknown engine` (404) comes back with [`SidecarSynthError::unknown`]
/// set; [`speak`] answers it with a 400 and never degrades it to OuteTTS.
async fn synth_via_sidecar(
    state: &ServerState,
    engine: &str,
    req: &SpeakRequest,
    text: &str,
) -> Result<(Vec<u8>, &'static str), SidecarSynthError> {
    let base = crate::sidecar::providers::ryutts::tts_base_url();
    synth_via_sidecar_at(
        &state.client,
        &base,
        &crate::sidecar::providers::ryutts::bearer(),
        engine,
        req,
        text,
    )
    .await
}

/// POST one `/generate` request to the RyuTTS sidecar at `base`. A 404 is the
/// sidecar's `unknown engine` answer for an id outside its registry and comes
/// back as [`UnknownTtsEngine`] (a configuration error callers must surface);
/// unreachable sidecars and other non-2xx statuses are ordinary errors that
/// callers may degrade to OuteTTS. Shared by read-aloud and the voice session.
pub(crate) async fn ryutts_generate_at(
    client: &reqwest::Client,
    base: &str,
    engine: &str,
    body: &Value,
) -> anyhow::Result<Vec<u8>> {
    let bearer = crate::sidecar::providers::ryutts::bearer();
    match post_sidecar_generate(client, base, &bearer, engine, body).await {
        Ok((audio, _content_type)) => Ok(audio),
        Err(SidecarSynthError {
            unknown: Some(unknown),
            ..
        }) => Err(unknown.into()),
        Err(error) => Err(anyhow::anyhow!(error.message)),
    }
}

/// The requested TTS engine id is not one Core or the RyuTTS sidecar knows.
/// Surfaced as an error instead of silently synthesizing with OuteTTS, so a
/// typo in the engine setting is visible.
#[derive(Debug)]
pub(crate) struct UnknownTtsEngine {
    pub(crate) engine: String,
    pub(crate) detail: String,
}

impl std::fmt::Display for UnknownTtsEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "unknown TTS engine '{}'", self.engine)?;
        if !self.detail.is_empty() {
            write!(f, ": {}", self.detail)?;
        }
        Ok(())
    }
}

impl std::error::Error for UnknownTtsEngine {}

/// Engine ids Core handles itself; every other id must be a RyuTTS registry id.
pub(crate) const BUILTIN_TTS_ENGINES: &[&str] = &["outetts", "audiocpp", "gateway"];

/// Refuse ids that cannot name any engine (not a built-in, and not a
/// well-formed RyuTTS registry id) before any network call.
pub(crate) fn check_tts_engine_id(engine: &str) -> Result<(), UnknownTtsEngine> {
    if BUILTIN_TTS_ENGINES.contains(&engine) || valid_tts_engine_id(engine) {
        return Ok(());
    }
    Err(UnknownTtsEngine {
        engine: engine.to_owned(),
        detail: format!(
            "expected {} or an installed RyuTTS engine id",
            BUILTIN_TTS_ENGINES.join(", ")
        ),
    })
}

/// `400` with the same `tts_engine_unknown` code the voice session emits.
fn unknown_tts_engine_response(unknown: &UnknownTtsEngine) -> axum::response::Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": unknown.to_string(), "code": "tts_engine_unknown" })),
    )
        .into_response()
}

async fn synth_via_sidecar_at(
    client: &reqwest::Client,
    base: &str,
    bearer: &str,
    engine: &str,
    req: &SpeakRequest,
    text: &str,
) -> Result<(Vec<u8>, &'static str), SidecarSynthError> {
    let body = sidecar_generate_body(engine, req, text);
    post_sidecar_generate(client, base, bearer, engine, &body).await
}

/// The one RyuTTS `/generate` transport shared by read-aloud ([`speak`]) and
/// the realtime voice session ([`ryutts_generate_at`]): a 404 is the sidecar's
/// `unknown engine` answer and is tagged [`SidecarSynthError::unknown`]; other
/// failures keep the upstream status; a success must carry an allowlisted audio
/// MIME and a non-empty body.
async fn post_sidecar_generate(
    client: &reqwest::Client,
    base: &str,
    bearer: &str,
    engine: &str,
    body: &Value,
) -> Result<(Vec<u8>, &'static str), SidecarSynthError> {
    let url = format!("{}/generate", base.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .bearer_auth(bearer)
        .json(body)
        .send()
        .await
        .map_err(|e| {
            SidecarSynthError::transport(format!("Ryu Audio sidecar not reachable at {url}: {e}"))
        })?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        let raw = resp.text().await.unwrap_or_default();
        let unknown = UnknownTtsEngine {
            engine: engine.to_owned(),
            detail: sidecar_error_detail(&raw).chars().take(512).collect(),
        };
        return Err(SidecarSynthError {
            status: Some(StatusCode::NOT_FOUND),
            message: unknown.to_string(),
            unknown: Some(unknown),
        });
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let detail = sidecar_error_detail(&resp.text().await.unwrap_or_default());
        return Err(SidecarSynthError {
            status: Some(status),
            message: format!("Audio engine '{engine}' returned {status}: {detail}"),
            unknown: None,
        });
    }

    let raw_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let content_type = sidecar_audio_mime(raw_type.as_deref()).ok_or_else(|| {
        SidecarSynthError::transport(format!(
            "Audio engine '{engine}' returned an unsupported content type {}",
            raw_type.as_deref().unwrap_or("")
        ))
    })?;
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| SidecarSynthError::transport(format!("reading Audio output failed: {e}")))?;
    if bytes.is_empty() {
        return Err(SidecarSynthError::transport(format!(
            "Audio engine '{engine}' returned an empty audio body"
        )));
    }
    Ok((bytes.to_vec(), content_type))
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

fn gateway_tts_provider_from_config<'a>(root: &'a toml::Value, model: &str) -> Option<&'a str> {
    let routing = root.get("routing")?;
    routing
        .get("modality_map")
        .and_then(|map| map.get("tts"))
        .and_then(|route| route.get("provider"))
        .and_then(toml::Value::as_str)
        .or_else(|| {
            routing
                .get("model_map")
                .and_then(|map| map.get(model))
                .and_then(|route| route.get("provider"))
                .and_then(toml::Value::as_str)
        })
}

fn gateway_tts_provider_hint(slot_provider: Option<&str>, model: &str) -> String {
    if let Some(provider) = slot_provider {
        return provider.to_owned();
    }
    let mut default_provider = None;
    if let Some(path) = super::gateway_config_path() {
        if let Ok(contents) = std::fs::read_to_string(path) {
            if let Ok(root) = toml::from_str::<toml::Value>(&contents) {
                if let Some(provider) = gateway_tts_provider_from_config(&root, model) {
                    return provider.to_owned();
                }
                default_provider = root
                    .get("routing")
                    .and_then(|routing| routing.get("default_provider"))
                    .and_then(toml::Value::as_str)
                    .map(str::to_owned);
            }
        }
    }
    match model {
        "edge-tts" => "edge-tts".to_owned(),
        "google-tts" => "google-tts".to_owned(),
        model if model == "google-translate-tts" || model.starts_with("google-translate-tts::") => {
            "google-translate-tts".to_owned()
        }
        "polly" => "polly".to_owned(),
        _ => default_provider.unwrap_or_else(|| "openai".to_owned()),
    }
}

fn gateway_tts_native_default(provider: &str) -> Option<&'static str> {
    match provider {
        "edge-tts" => Some("en-US-EmmaMultilingualNeural"),
        "google-tts" => Some("en-US-Neural2-F"),
        "google-translate-tts" => Some("en"),
        "polly" => Some("Joanna"),
        _ => None,
    }
}

fn gateway_tts_payload_for_provider(
    model: &str,
    voice: Option<&str>,
    speed: Option<f32>,
    text: &str,
    provider: &str,
) -> Value {
    let mut payload = gateway_tts_payload(model, voice, speed, text);
    if let Some(native_default) = gateway_tts_native_default(provider) {
        let native_default = if provider == "google-translate-tts" {
            model
                .strip_prefix("google-translate-tts::")
                .unwrap_or(native_default)
        } else {
            native_default
        };
        let selected = payload["voice"].as_str().unwrap_or_default();
        if matches!(
            selected,
            "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer"
        ) {
            payload["voice"] = json!(native_default);
        }
    }
    payload
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
        "response_format": "mp3",
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
    let (slot_provider, slot_model) = gateway_tts_slot_overrides();
    let model = slot_model.as_deref().unwrap_or(DEFAULT_GATEWAY_TTS_MODEL);
    let provider = gateway_tts_provider_hint(slot_provider.as_deref(), model);
    let (voices, default_voice): (&[&str], &str) = match provider.as_str() {
        "edge-tts" => (
            &["en-US-EmmaMultilingualNeural"],
            "en-US-EmmaMultilingualNeural",
        ),
        "google-tts" => (&["en-US-Neural2-F"], "en-US-Neural2-F"),
        "google-translate-tts" => (&["en", "zh-CN", "vi", "ja", "es", "fr", "de"], "en"),
        "polly" => (&["Joanna"], "Joanna"),
        _ => (
            &["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
            DEFAULT_GATEWAY_TTS_VOICE,
        ),
    };
    json!({
        "id": "gateway",
        "display_name": "Cloud (via gateway)",
        "description": "Routed to this node's audio provider · no local model",
        // Offer native defaults for the configured speech route. Existing
        // OpenAI voice selections are translated when the route changes.
        "voices": voices,
        "default_voice": default_voice,
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
const MAX_TTS_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

async fn read_tts_response_bytes(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_TTS_RESPONSE_BYTES as u64)
    {
        return Err(format!(
            "gateway audio response exceeds {MAX_TTS_RESPONSE_BYTES} bytes"
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("reading gateway audio failed: {error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_TTS_RESPONSE_BYTES {
            return Err(format!(
                "gateway audio response exceeds {MAX_TTS_RESPONSE_BYTES} bytes"
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn decode_gateway_audio_response(
    response: reqwest::Response,
) -> Result<(Vec<u8>, String), String> {
    if !response.status().is_success() {
        return Err(format!("gateway audio returned {}", response.status()));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(gateway_audio_mime)
        .ok_or_else(|| "gateway returned an unsupported audio content type".to_owned())?;
    let bytes = read_tts_response_bytes(response).await?;
    if bytes.is_empty() {
        return Err("gateway returned empty audio".to_owned());
    }
    Ok((bytes, content_type.to_owned()))
}

fn gateway_audio_mime(value: &str) -> Option<&'static str> {
    match value
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "audio/mpeg" | "audio/mp3" => Some("audio/mpeg"),
        "audio/wav" | "audio/x-wav" => Some("audio/wav"),
        "audio/ogg" | "audio/opus" => Some("audio/ogg"),
        "audio/flac" | "audio/x-flac" => Some("audio/flac"),
        "audio/aac" => Some("audio/aac"),
        "audio/pcm" => Some("audio/pcm"),
        _ => None,
    }
}

/// Container Core asks the Gateway for on the read-aloud path (any browser
/// `<audio>` element plays it, and it is the smallest wire format).
pub(crate) const GATEWAY_TTS_FORMAT_READ_ALOUD: &str = "mp3";
/// Container the realtime voice session asks for: its downlink is
/// self-describing WAV frames, so an mp3 reply would be rejected and every
/// sentence would silently degrade to OuteTTS.
pub(crate) const GATEWAY_TTS_FORMAT_VOICE_SESSION: &str = "wav";

/// The full outbound `/v1/audio/speech` body for `provider`, requesting
/// `response_format` instead of the read-aloud default.
fn gateway_tts_request_payload(
    model: &str,
    voice: Option<&str>,
    speed: Option<f32>,
    text: &str,
    provider: &str,
    response_format: &str,
) -> Value {
    let mut payload = gateway_tts_payload_for_provider(model, voice, speed, text, provider);
    payload["response_format"] = json!(response_format);
    payload
}

pub(crate) async fn synth_via_gateway(
    client: &reqwest::Client,
    voice: Option<&str>,
    speed: Option<f32>,
    text: &str,
    response_format: &str,
) -> Result<(Vec<u8>, String), String> {
    let (slot_provider, slot_model) = gateway_tts_slot_overrides();
    let model = slot_model
        .clone()
        .unwrap_or_else(|| DEFAULT_GATEWAY_TTS_MODEL.to_owned());
    let base = crate::sidecar::gateway::gateway_url();
    let url = format!("{}/v1/audio/speech", base.trim_end_matches('/'));
    let bearer = crate::sidecar::gateway::required_gateway_inference_token()
        .map_err(|_| "no gateway credential for audio".to_owned())?;
    let provider = gateway_tts_provider_hint(slot_provider.as_deref(), &model);
    let payload =
        gateway_tts_request_payload(&model, voice, speed, text, &provider, response_format);
    let request = build_gateway_tts_request(
        client,
        &url,
        &bearer,
        &payload,
        slot_provider.as_deref(),
        slot_model.as_deref(),
    );
    send_gateway_tts_request(request).await
}

async fn send_gateway_tts_request(
    request: reqwest::RequestBuilder,
) -> Result<(Vec<u8>, String), String> {
    let response = request
        .send()
        .await
        .map_err(|_| "gateway audio transport unavailable".to_owned())?;
    decode_gateway_audio_response(response).await
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

/// Request body for installing one optional Ryu TTS engine runtime.
#[derive(Debug, Deserialize)]
pub struct InstallTtsEngineRequest {
    /// Engine id from `/api/voice/tts-engines`.
    pub engine: String,
}

pub(crate) fn valid_tts_engine_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'_'
        })
}

/// `POST /api/voice/tts-engines/install` — install the selected engine's Python
/// dependencies into the managed Ryu TTS runtime. The engine id is resolved by
/// the sidecar's fixed registry; callers cannot supply package names or commands.
#[utoipa::path(
    post,
    path = "/api/voice/tts-engines/install",
    tag = "Voice",
    summary = "install a registered text-to-speech engine",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn tts_engines_install(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    headers: HeaderMap,
    Json(req): Json<InstallTtsEngineRequest>,
) -> impl IntoResponse {
    if let Err(response) =
        super::media::enforce_host_voice_models_permission(&state, &caller, &headers).await
    {
        return response;
    }
    let engine = req.engine.trim();
    if !valid_tts_engine_id(engine) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid text-to-speech engine id" })),
        )
            .into_response();
    }
    let url = format!(
        "{}/engines/install",
        crate::sidecar::providers::ryutts::tts_base_url()
    );
    match install_tts_engine_at(
        &state.client,
        &url,
        &crate::sidecar::providers::ryutts::bearer(),
        engine,
    )
    .await
    {
        Ok(value) if value["installed"] == true => (StatusCode::OK, Json(value)).into_response(),
        Ok(value) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "Audio installer did not confirm the engine is installed", "detail": value })),
        )
            .into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": error })),
        )
            .into_response(),
    }
}

async fn install_tts_engine_at(
    client: &reqwest::Client,
    base_url: &str,
    bearer: &str,
    engine: &str,
) -> Result<Value, String> {
    let response = build_tts_engine_install_request(client, base_url, bearer, engine)
        .send()
        .await
        .map_err(|error| format!("Audio engine installer is unreachable: {error}"))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("could not read Audio install result: {error}"))?;
    if !status.is_success() {
        let detail = String::from_utf8_lossy(&bytes)
            .chars()
            .take(4000)
            .collect::<String>();
        return Err(format!(
            "installing the text-to-speech engine failed: {detail}"
        ));
    }
    serde_json::from_slice(&bytes).map_err(|error| format!("invalid Audio install result: {error}"))
}

fn build_tts_engine_install_request(
    client: &reqwest::Client,
    base_url: &str,
    bearer: &str,
    engine: &str,
) -> reqwest::RequestBuilder {
    let url = format!("{}/engines/install", base_url.trim_end_matches('/'));
    client
        .post(url)
        .timeout(std::time::Duration::from_secs(15 * 60))
        .bearer_auth(bearer)
        .json(&tts_engine_install_body(engine))
}

fn tts_engine_install_body(engine: &str) -> Value {
    json!({ "engine": engine })
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
        assert_eq!(p["response_format"], "mp3");
        assert_eq!(p["model"], "tts-1");
        assert!(p.get("speed").is_none());
    }

    /// The realtime voice session only forwards WAV frames, so its Gateway
    /// request must ask for WAV; read-aloud keeps the mp3 default.
    #[test]
    fn voice_session_requests_wav_and_read_aloud_keeps_mp3() {
        let session = gateway_tts_request_payload(
            "tts-1",
            Some("nova"),
            None,
            "hi",
            "openai",
            GATEWAY_TTS_FORMAT_VOICE_SESSION,
        );
        assert_eq!(session["response_format"], "wav");
        assert_eq!(session["input"], "hi");
        assert_eq!(session["voice"], "nova");
        let read_aloud = gateway_tts_request_payload(
            "tts-1",
            None,
            None,
            "hi",
            "edge-tts",
            GATEWAY_TTS_FORMAT_READ_ALOUD,
        );
        assert_eq!(read_aloud["response_format"], "mp3");
        assert_eq!(read_aloud["voice"], "en-US-EmmaMultilingualNeural");
    }

    #[tokio::test]
    async fn gateway_binary_audio_preserves_bytes_and_actual_mime() {
        let audio = vec![0x49, 0x44, 0x33, 0, 0xff];
        let expected = audio.clone();
        let app = Router::new().route(
            "/speech",
            post(move || {
                let audio = audio.clone();
                async move { ([(CONTENT_TYPE, "audio/mpeg")], audio) }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(format!("http://{address}/speech"))
            .send()
            .await
            .unwrap();
        let (actual, mime) = decode_gateway_audio_response(response).await.unwrap();
        server.abort();
        assert_eq!(actual, expected);
        assert_eq!(mime, "audio/mpeg");
    }

    #[tokio::test]
    async fn core_speech_http_handoff_keeps_translate_cloud_and_default_routes_distinct() {
        for (provider, model, voice) in [
            ("openai", "tts-1", "alloy"),
            ("google-tts", "tts-1", "en-US-Neural2-F"),
            ("google-translate-tts", "google-translate-tts::vi", "vi"),
        ] {
            let audio = vec![0x49, 0x44, 0x33, 0, 0xff];
            let expected = audio.clone();
            let app = Router::new().route(
                "/v1/audio/speech",
                post(
                    move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                        let audio = audio.clone();
                        async move {
                            assert_eq!(headers["authorization"], "Bearer proof-gateway-relay");
                            assert_eq!(headers["x-ryu-slot-tts-provider"], provider);
                            assert_eq!(headers["x-ryu-slot-tts-model"], model);
                            assert_eq!(
                                body,
                                json!({
                                    "model": model,
                                    "input": "A real Core speech request",
                                    "voice": voice,
                                    "response_format": "mp3"
                                })
                            );
                            ([(CONTENT_TYPE, "audio/mpeg")], audio)
                        }
                    },
                ),
            );
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let payload = gateway_tts_payload_for_provider(
                model,
                None,
                None,
                "A real Core speech request",
                provider,
            );
            let request = build_gateway_tts_request(
                &client,
                &format!("http://{address}/v1/audio/speech"),
                "proof-gateway-relay",
                &payload,
                Some(provider),
                Some(model),
            );
            let result = send_gateway_tts_request(request).await;
            server.abort();
            let (bytes, mime) = result.unwrap();
            assert_eq!(bytes, expected);
            assert_eq!(mime, "audio/mpeg");
        }
    }

    #[tokio::test]
    async fn gateway_audio_rejects_legacy_json_empty_audio_and_private_error_details() {
        for (status, mime, body) in [
            (
                StatusCode::OK,
                "application/json",
                "private-response-material",
            ),
            (StatusCode::OK, "audio/wav", ""),
            (
                StatusCode::BAD_GATEWAY,
                "application/json",
                "private-response-material",
            ),
        ] {
            let app = Router::new().route(
                "/speech",
                post(move || async move { (status, [(CONTENT_TYPE, mime)], body) }),
            );
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let response = reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .post(format!("http://{address}/speech"))
                .send()
                .await
                .unwrap();
            let error = decode_gateway_audio_response(response).await.unwrap_err();
            server.abort();
            assert!(!error.contains("private-response-material"));
        }
    }

    #[test]
    fn gateway_audio_mime_rejects_unknown_values_and_normalizes_audio_aliases() {
        assert_eq!(
            gateway_audio_mime("audio/x-wav; codec=pcm"),
            Some("audio/wav")
        );
        assert_eq!(gateway_audio_mime("Audio/MPEG"), Some("audio/mpeg"));
        assert_eq!(gateway_audio_mime("audio/ogg"), Some("audio/ogg"));
        assert_eq!(gateway_audio_mime("application/json"), None);
        assert_eq!(gateway_audio_mime("text/html"), None);
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
    fn cloud_speech_defaults_follow_the_resolved_provider() {
        let config: toml::Value = toml::from_str(
            "[routing]\ndefault_provider='openai'\n[routing.model_map.'tts-1']\nprovider='polly'\n[routing.modality_map.tts]\nprovider='edge-tts'\n",
        )
        .unwrap();
        assert_eq!(
            gateway_tts_provider_from_config(&config, "tts-1"),
            Some("edge-tts")
        );
        for (provider, native) in [
            ("edge-tts", "en-US-EmmaMultilingualNeural"),
            ("google-tts", "en-US-Neural2-F"),
            ("polly", "Joanna"),
        ] {
            assert_eq!(
                gateway_tts_payload_for_provider("tts-1", None, None, "hello", provider)["voice"],
                native
            );
            assert_eq!(
                gateway_tts_payload_for_provider("tts-1", Some("alloy"), None, "hello", provider)
                    ["voice"],
                native,
                "older saved OpenAI defaults must migrate when the speech provider changes"
            );
            assert_eq!(
                gateway_tts_payload_for_provider("tts-1", Some(native), None, "hello", provider)
                    ["voice"],
                native
            );
        }
        assert_eq!(
            gateway_tts_payload_for_provider("tts-1", None, None, "hello", "openai")["voice"],
            "alloy"
        );
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
            reference_audio_data_url: None,
            ..Default::default()
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
    fn reference_audio_rejects_urls_and_relative_paths() {
        assert!(validate_reference_audio(Some("https://example.com/ref.wav")).is_err());
        assert!(validate_reference_audio(Some("../ref.wav")).is_err());
    }

    #[test]
    fn clone_sample_data_url_accepts_only_bounded_wav_bytes() {
        use base64::Engine as _;

        let mut wav = vec![0_u8; 44];
        wav[..4].copy_from_slice(b"RIFF");
        wav[8..12].copy_from_slice(b"WAVE");
        let data_url = format!(
            "data:audio/wav;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&wav)
        );
        assert_eq!(decode_reference_audio_data_url(&data_url).unwrap(), wav);
        assert!(decode_reference_audio_data_url("https://example.com/voice.wav").is_err());
        assert!(decode_reference_audio_data_url("data:audio/wav;base64,not_base64!").is_err());

        let oversized = vec![0_u8; MAX_REFERENCE_AUDIO_BYTES + 1];
        let oversized_url = format!(
            "data:audio/wav;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(oversized)
        );
        assert!(decode_reference_audio_data_url(&oversized_url).is_err());
    }

    #[test]
    fn clone_sample_data_url_rejects_a_non_wav_header() {
        use base64::Engine as _;

        let bytes = b"not a wave";
        let data_url = format!(
            "data:audio/wav;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        );
        assert!(decode_reference_audio_data_url(&data_url).is_err());
    }

    #[test]
    fn staged_clone_sample_is_private_temporary_data() {
        use base64::Engine as _;

        let mut wav = vec![0_u8; 44];
        wav[..4].copy_from_slice(b"RIFF");
        wav[8..12].copy_from_slice(b"WAVE");
        let data_url = format!(
            "data:audio/wav;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&wav)
        );
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("voice").join("reference-audio");
        let staged = stage_reference_audio_data_url_in(&data_url, &root).unwrap();
        let path = staged.path().to_path_buf();
        assert!(path.starts_with(&root));
        assert_eq!(std::fs::read(&path).unwrap(), wav);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&root), 0o700, "the staging directory is owner-only");
            assert_eq!(mode(&path), 0o600, "the staged sample is owner-only");
        }
        drop(staged);
        assert!(!path.exists());
    }

    #[test]
    fn inline_samples_are_staged_in_scratch_space_not_the_reference_directory() {
        let staging = reference_audio_staging_dir();
        assert!(staging.starts_with(crate::paths::tmp_dir_for("voice")));
        assert!(!staging.starts_with(crate::paths::files_path("voice")));
    }

    #[test]
    fn the_startup_sweep_removes_orphaned_samples_and_keeps_user_files() {
        let directory = tempfile::tempdir().unwrap();
        let staging = directory.path().join("tmp").join("reference-audio");
        let legacy = directory.path().join("files").join("reference-audio");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::create_dir_all(&legacy).unwrap();
        let orphan = staging.join(".tmpAbC123.wav");
        let legacy_orphan = legacy.join(".tmpXyZ789.wav");
        let user_sample = legacy.join("my-voice.wav");
        for file in [&orphan, &legacy_orphan, &user_sample] {
            std::fs::write(file, b"RIFF....WAVE").unwrap();
        }
        // A fresh staged sample survives an age-gated sweep (it may be in use).
        assert_eq!(
            sweep_staged_reference_audio(&staging, &legacy, std::time::Duration::from_secs(900)),
            1
        );
        assert!(orphan.exists());
        assert!(!legacy_orphan.exists());
        // The first staging after a start removes every orphan.
        assert_eq!(
            sweep_staged_reference_audio(&staging, &legacy, std::time::Duration::ZERO),
            1
        );
        assert!(!orphan.exists());
        assert!(
            user_sample.exists(),
            "a user's own reference file is never swept"
        );
    }

    #[test]
    fn engine_install_accepts_only_simple_registry_ids() {
        assert!(valid_tts_engine_id("pocket"));
        assert!(valid_tts_engine_id("audio_cpp"));
        assert!(!valid_tts_engine_id("../pocket"));
        assert!(!valid_tts_engine_id("Pocket"));
        assert!(!valid_tts_engine_id(&"a".repeat(81)));
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
            reference_audio_data_url: None,
            ..Default::default()
        };
        let payload = audio_cpp_tts_payload(&request, "hello");
        assert_eq!(
            payload["voice"],
            crate::sidecar::providers::audiocpp::DEFAULT_TTS_VOICE
        );
        assert!(payload.get("options").is_none());
    }

    async fn ryutts_stub(status: StatusCode) -> String {
        let app = Router::new().route(
            "/generate",
            post(move || async move { (status, "unknown engine 'kokoroo'; available: kokoro") }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{address}")
    }

    /// Read-aloud must not degrade a RyuTTS `unknown engine` (404) to OuteTTS:
    /// it is classified as [`UnknownTtsEngine`] and answered with a 400, while
    /// a sidecar 5xx stays an ordinary (fallback-eligible) error.
    #[tokio::test]
    async fn read_aloud_surfaces_unknown_ryutts_engine_and_degrades_outages() {
        let client = reqwest::Client::new();
        let body = json!({ "text": "hi", "engine": "kokoroo" });

        let base = ryutts_stub(StatusCode::NOT_FOUND).await;
        let error = ryutts_generate_at(&client, &base, "kokoroo", &body)
            .await
            .expect_err("404 is an unknown engine");
        let unknown = error
            .downcast_ref::<UnknownTtsEngine>()
            .expect("404 must classify as UnknownTtsEngine");
        assert!(
            unknown.to_string().contains("available: kokoro"),
            "{unknown}"
        );
        let response = unknown_tts_engine_response(unknown);
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let base = ryutts_stub(StatusCode::SERVICE_UNAVAILABLE).await;
        let error = ryutts_generate_at(&client, &base, "kokoro", &body)
            .await
            .expect_err("503 is an outage");
        assert!(
            !error.is::<UnknownTtsEngine>(),
            "outages must stay fallback-eligible"
        );

        let error = ryutts_generate_at(&client, "http://127.0.0.1:9", "kokoro", &body)
            .await
            .expect_err("unreachable sidecar");
        assert!(!error.is::<UnknownTtsEngine>());
    }

    /// Malformed engine ids are refused before any synthesis with a 4xx.
    #[test]
    fn read_aloud_refuses_malformed_engine_ids() {
        for engine in ["outetts", "audiocpp", "gateway", "kokoro", "audio_cpp"] {
            assert!(check_tts_engine_id(engine).is_ok(), "{engine}");
        }
        for engine in ["Kokoro", "kokoro ", "../pocket", ""] {
            let unknown = check_tts_engine_id(engine).expect_err(engine);
            assert_eq!(
                unknown_tts_engine_response(&unknown).status(),
                StatusCode::BAD_REQUEST
            );
        }
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
            reference_audio_data_url: None,
            ..Default::default()
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

    #[test]
    fn tts_engine_installer_uses_the_core_bearer_and_registry_id() {
        let request = build_tts_engine_install_request(
            &reqwest::Client::new(),
            "http://127.0.0.1:8085/",
            "node-token",
            "pocket",
        )
        .build()
        .expect("Core should build the sidecar install request");
        assert_eq!(request.method(), axum::http::Method::POST);
        assert_eq!(request.url().path(), "/engines/install");
        assert_eq!(
            request.headers()[header::AUTHORIZATION],
            "Bearer node-token"
        );
        assert_eq!(request.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(
            tts_engine_install_body("pocket"),
            json!({ "engine": "pocket" })
        );
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

#[cfg(test)]
mod speak_contract_tests {
    use super::*;

    use axum::{http::header::CONTENT_TYPE, routing::post, Router};
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    fn parse(body: Value) -> Result<SpeakRequest, String> {
        parse_speak_request(body)
    }

    #[test]
    fn studio_fields_parse_within_bounds() {
        let req = parse(json!({
            "text": "hi",
            "seed": 4_294_967_295_u64,
            "instruct": "warm, slow",
            "reference_text": "the sample says this",
            "effects": [
                { "type": "gain", "params": { "gain_db": -3 } },
                { "type": "pitch_shift", "params": { "semitones": 1.5 } },
                { "type": "reverb" }
            ],
            "normalize": "podcast",
            "format": "mp3"
        }))
        .expect("valid studio request should parse");
        assert_eq!(req.seed, Some(u32::MAX));
        assert_eq!(req.normalize, Some(SpeakNormalize::Podcast));
        assert_eq!(req.format, Some(SpeakFormat::Mp3));
        let effects = req.effects.expect("effects should parse");
        assert_eq!(effects[1].kind, SpeakEffectKind::PitchShift);
        assert!(effects[2].params.is_empty());
    }

    #[test]
    fn studio_fields_reject_out_of_bounds_and_unknown_values() {
        let long = |n: usize| "a".repeat(n);
        let too_many: Vec<Value> = (0..13).map(|_| json!({ "type": "gain" })).collect();
        let rejected = [
            json!({ "text": "hi", "instruct": long(501) }),
            json!({ "text": "hi", "reference_text": long(1001) }),
            json!({ "text": "hi", "effects": too_many }),
            json!({ "text": "hi", "effects": [{ "type": "speed" }] }),
            json!({ "text": "hi", "effects": [{ "type": "gain", "params": { "gain_db": "loud" } }] }),
            json!({ "text": "hi", "effects": [{ "type": "gain", "params": { "Bad Key": 1 } }] }),
            json!({ "text": "hi", "effects": [{ "type": "gain", "extra": 1 }] }),
            json!({ "text": "hi", "normalize": "loud" }),
            json!({ "text": "hi", "format": "aac" }),
            json!({ "text": "hi", "seed": -1 }),
            json!({ "text": "hi", "seed": 4_294_967_296_u64 }),
            json!({ "text": "hi", "speed": -1.0 }),
        ];
        for body in rejected {
            assert!(parse(body.clone()).is_err(), "{body} should be rejected");
        }
        assert!(parse(json!({ "text": long(MAX_SPEAK_TEXT_CHARS + 1) })).is_err());
        assert!(parse(json!({ "text": "é".repeat(MAX_SPEAK_TEXT_CHARS) })).is_ok());
        // Exactly at the bounds is fine; instruct counts characters, not bytes.
        assert!(parse(json!({ "text": "hi", "instruct": "é".repeat(500) })).is_ok());
        assert!(parse(json!({ "text": "hi", "reference_text": long(1000) })).is_ok());
    }

    #[test]
    fn non_finite_effect_params_are_rejected_after_parse() {
        let mut params = BTreeMap::new();
        params.insert("gain_db".to_owned(), f64::INFINITY);
        let req = SpeakRequest {
            text: "hi".to_owned(),
            effects: Some(vec![SpeakEffect {
                kind: SpeakEffectKind::Gain,
                params,
            }]),
            ..Default::default()
        };
        assert!(validate_speak_options(&req).is_err());
    }

    #[test]
    fn sidecar_body_forwards_every_studio_field() {
        let req = parse(json!({
            "text": "ignored",
            "voice": "af_heart",
            "seed": 7,
            "instruct": "whisper",
            "reference_text": "sample words",
            "effects": [{ "type": "highpass", "params": { "hz": 80 } }],
            "normalize": "acx",
            "format": "flac"
        }))
        .unwrap();
        let body = sidecar_generate_body("kokoro", &req, "hello");
        assert_eq!(body["text"], "hello");
        assert_eq!(body["engine"], "kokoro");
        assert_eq!(body["voice"], "af_heart");
        assert_eq!(body["seed"], 7);
        assert_eq!(body["instruct"], "whisper");
        assert_eq!(body["reference_text"], "sample words");
        assert_eq!(
            body["effects"],
            json!([{ "type": "highpass", "params": { "hz": 80.0 } }])
        );
        assert_eq!(body["normalize"], "acx");
        assert_eq!(body["format"], "flac");

        let bare = sidecar_generate_body("kokoro", &parse(json!({ "text": "x" })).unwrap(), "x");
        for key in [
            "seed",
            "instruct",
            "reference_text",
            "effects",
            "normalize",
            "format",
        ] {
            assert!(bare.get(key).is_none(), "{key} must be omitted when unset");
        }
    }

    #[test]
    fn sidecar_mime_is_allowlisted() {
        assert_eq!(sidecar_audio_mime(None), Some("audio/wav"));
        assert_eq!(sidecar_audio_mime(Some("audio/x-wav")), Some("audio/wav"));
        assert_eq!(sidecar_audio_mime(Some("audio/mpeg")), Some("audio/mpeg"));
        assert_eq!(
            sidecar_audio_mime(Some("audio/ogg; codecs=vorbis")),
            Some("audio/ogg")
        );
        assert_eq!(sidecar_audio_mime(Some("audio/flac")), Some("audio/flac"));
        assert_eq!(sidecar_audio_mime(Some("text/html")), None);
        assert_eq!(sidecar_audio_mime(Some("application/json")), None);
    }

    #[test]
    fn fallback_is_only_for_plain_read_aloud_on_the_default_engine() {
        // Desktop read-aloud always names its stored engine (the default on a
        // fresh install), so an explicit default must still degrade.
        assert!(fallback_allowed(None, "kokoro", false, false));
        assert!(fallback_allowed(Some("kokoro"), "kokoro", false, false));
        assert!(fallback_allowed(Some("gateway"), "kokoro", false, false));
        assert!(!fallback_allowed(None, "kokoro", true, false));
        assert!(!fallback_allowed(Some("kokoro"), "kokoro", false, true));
        assert!(!fallback_allowed(
            Some("chatterbox"),
            "kokoro",
            false,
            false
        ));
        assert!(!fallback_allowed(Some("chatterbox"), "kokoro", true, false));
    }

    #[test]
    fn sidecar_validation_messages_reach_the_caller() {
        let body = r#"{"error":"invalid request","detail":[{"loc":["body","effects",0],"msg":"Value error, unknown gain param(s) db; use gain_db"}]}"#;
        assert_eq!(
            sidecar_error_detail(body),
            "Value error, unknown gain param(s) db; use gain_db"
        );
        assert_eq!(sidecar_error_detail(r#"{"error":"boom"}"#), "boom");
    }

    #[test]
    fn studio_options_are_detected_for_the_fallback_rule() {
        let plain = SpeakRequest {
            text: "hi".to_owned(),
            normalize: Some(SpeakNormalize::Off),
            format: Some(SpeakFormat::Wav),
            instruct: Some("  ".to_owned()),
            ..SpeakRequest::default()
        };
        assert!(!requests_studio_options(&plain));
        let seeded = SpeakRequest {
            seed: Some(7),
            ..SpeakRequest::default()
        };
        assert!(requests_studio_options(&seeded));
        let mp3 = SpeakRequest {
            format: Some(SpeakFormat::Mp3),
            ..SpeakRequest::default()
        };
        assert!(requests_studio_options(&mp3));
    }

    #[test]
    fn audio_response_carries_engine_and_fallback_headers() {
        let response = speak_audio_response(b"ID3".to_vec(), "audio/mpeg", "kokoro", None);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "audio/mpeg");
        assert_eq!(response.headers()["x-ryu-tts-engine"], "kokoro");
        assert!(response.headers().get("x-ryu-tts-fallback").is_none());

        let fallback =
            speak_audio_response(b"RIFF".to_vec(), "audio/wav", "outetts", Some("kokoro"));
        assert_eq!(fallback.headers()["x-ryu-tts-engine"], "outetts");
        assert_eq!(fallback.headers()["x-ryu-tts-fallback"], "kokoro");
    }

    async fn serve(app: Router) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn sidecar_adapter_forwards_body_and_returns_the_sidecar_mime() {
        let seen: Arc<Mutex<Option<Value>>> = Arc::default();
        let captured = Arc::clone(&seen);
        let base = serve(Router::new().route(
            "/generate",
            post(move |Json(body): Json<Value>| {
                let captured = Arc::clone(&captured);
                async move {
                    *captured.lock().unwrap() = Some(body);
                    ([(CONTENT_TYPE, "audio/mpeg")], b"ID3-mp3".to_vec())
                }
            }),
        ))
        .await;
        let req = parse(json!({ "text": "x", "format": "mp3", "seed": 3 })).unwrap();
        let (audio, mime) = synth_via_sidecar_at(
            &reqwest::Client::new(),
            &base,
            "token",
            "kokoro",
            &req,
            "hello",
        )
        .await
        .expect("sidecar mp3 should be accepted");
        assert_eq!(audio, b"ID3-mp3");
        assert_eq!(mime, "audio/mpeg");
        let body = seen.lock().unwrap().clone().expect("sidecar saw a body");
        assert_eq!(body["format"], "mp3");
        assert_eq!(body["seed"], 3);
        assert_eq!(body["text"], "hello");
    }

    #[tokio::test]
    async fn sidecar_adapter_rejects_non_audio_and_keeps_client_error_status() {
        let base = serve(
            Router::new()
                .route(
                    "/html/generate",
                    post(|| async { ([(CONTENT_TYPE, "text/html")], b"<html>".to_vec()) }),
                )
                .route(
                    "/415/generate",
                    post(|| async {
                        (
                            StatusCode::UNSUPPORTED_MEDIA_TYPE,
                            Json(json!({ "detail": "mp3 needs ffmpeg" })),
                        )
                    }),
                )
                .route(
                    "/500/generate",
                    post(|| async { (StatusCode::INTERNAL_SERVER_ERROR, "boom") }),
                ),
        )
        .await;
        let client = reqwest::Client::new();
        let req = SpeakRequest::default();
        let call = |path: &'static str| {
            let client = client.clone();
            let base = format!("{base}/{path}");
            let req = &req;
            async move { synth_via_sidecar_at(&client, &base, "t", "kokoro", req, "hi").await }
        };

        let html = call("html").await.unwrap_err();
        assert_eq!(html.response_status(), StatusCode::BAD_GATEWAY);
        assert!(html.message.contains("unsupported content type"));

        let unsupported = call("415").await.unwrap_err();
        assert_eq!(
            unsupported.response_status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        assert!(unsupported.message.contains("mp3 needs ffmpeg"));

        let crashed = call("500").await.unwrap_err();
        assert_eq!(crashed.response_status(), StatusCode::BAD_GATEWAY);

        let unreachable = synth_via_sidecar_at(&client, "http://127.0.0.1:9", "t", "k", &req, "hi")
            .await
            .unwrap_err();
        assert_eq!(unreachable.response_status(), StatusCode::BAD_GATEWAY);
    }

    /// A sidecar 404 on the node's default engine is a configuration error:
    /// even though plain read-aloud on the default engine is fallback-eligible,
    /// the adapter tags it `unknown` so `speak` answers 400 `tts_engine_unknown`
    /// before it ever considers the OuteTTS fallback.
    #[tokio::test]
    async fn sidecar_unknown_engine_on_default_is_a_400_not_a_fallback() {
        let base = serve(Router::new().route(
            "/generate",
            post(|| async {
                (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "detail": "unknown engine 'kokoro'; available: kitten" })),
                )
            }),
        ))
        .await;
        let req = parse(json!({ "text": "hi" })).unwrap();
        assert!(
            fallback_allowed(None, "kokoro", false, requests_studio_options(&req)),
            "plain default read-aloud is fallback-eligible for outages"
        );
        let error = synth_via_sidecar_at(&reqwest::Client::new(), &base, "t", "kokoro", &req, "hi")
            .await
            .unwrap_err();
        let unknown = error.unknown.as_ref().expect("404 must be tagged unknown");
        assert!(
            unknown.to_string().contains("available: kitten"),
            "{unknown}"
        );
        let response = unknown_tts_engine_response(unknown);
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["code"], "tts_engine_unknown");
    }
}

#[cfg(test)]
mod transcribe_language_tests {
    use super::is_language_hint;

    #[test]
    fn accepts_auto_and_bcp47_tags_only() {
        for hint in ["auto", "en", "pt-BR", "zh-Hant", "yue"] {
            assert!(is_language_hint(hint), "{hint}");
        }
        let long = "a".repeat(40);
        for hint in [
            "",
            "e",
            "english",
            "en_US",
            "en-",
            "fr&engine=x",
            long.as_str(),
        ] {
            assert!(!is_language_hint(hint), "{hint}");
        }
    }
}

#[cfg(test)]
mod member_gateway_audio_tests {
    use super::*;

    #[test]
    fn an_explicit_gateway_selector_is_detected_whatever_the_default() {
        for requested in ["gateway", " gateway ", "Gateway", "GATEWAY"] {
            assert!(
                selects_gateway_engine(Some(requested), || "kokoro".to_owned()),
                "{requested}"
            );
        }
    }

    #[test]
    fn an_unset_or_blank_selector_follows_the_node_default() {
        for requested in [None, Some(""), Some("   ")] {
            assert!(selects_gateway_engine(requested, || "gateway".to_owned()));
            assert!(selects_gateway_engine(requested, || " Gateway ".to_owned()));
            assert!(!selects_gateway_engine(requested, || "parakeet".to_owned()));
        }
    }

    #[test]
    fn a_named_local_engine_ignores_a_gateway_default() {
        for requested in ["parakeet", "whisper", "audiocpp", "kokoro", "outetts"] {
            assert!(
                !selects_gateway_engine(Some(requested), || "gateway".to_owned()),
                "{requested}"
            );
        }
    }

    #[test]
    fn the_public_helpers_detect_an_explicit_gateway_engine() {
        assert!(stt_engine_uses_gateway(Some("gateway")));
        assert!(tts_engine_uses_gateway(Some("gateway")));
        assert!(!stt_engine_uses_gateway(Some("whisper")));
        assert!(!tts_engine_uses_gateway(Some("outetts")));
    }
}
