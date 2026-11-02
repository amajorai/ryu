//! `POST /api/voice/speak` request options: studio effects, output format and
//! normalisation, their validation, and the sidecar request/response shapes.

use super::*;
use crate::i18n::{messages, Message};

pub(super) const MAX_SPEAK_INSTRUCT_CHARS: usize = 500;
pub(super) const MAX_SPEAK_REFERENCE_TEXT_CHARS: usize = 1000;
pub(super) const MAX_SPEAK_EFFECTS: usize = 12;
pub(super) const MAX_SPEAK_EFFECT_PARAMS: usize = 16;
pub(super) const MAX_SPEAK_EFFECT_PARAM_NAME: usize = 40;

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
pub(super) fn parse_speak_request(body: Value) -> Result<SpeakRequest, String> {
    let req: SpeakRequest =
        serde_json::from_value(body).map_err(|error| format!("invalid speak request: {error}"))?;
    validate_speak_options(&req)?;
    Ok(req)
}

pub(super) fn validate_speak_options(req: &SpeakRequest) -> Result<(), String> {
    if req.text.chars().count() > MAX_SPEAK_TEXT_CHARS {
        return Err(speak_text_limit(MAX_SPEAK_TEXT_CHARS));
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
pub(super) fn sidecar_generate_body(engine: &str, req: &SpeakRequest, text: &str) -> Value {
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
pub(super) fn sidecar_audio_mime(value: Option<&str>) -> Option<&'static str> {
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
pub(super) struct SidecarSynthError {
    pub(super) status: Option<StatusCode>,
    pub(super) message: String,
    /// Set when the sidecar answered 404 `unknown engine`: a configuration
    /// error that must surface as `tts_engine_unknown`, never degrade.
    pub(super) unknown: Option<UnknownTtsEngine>,
}

impl std::fmt::Display for SidecarSynthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl SidecarSynthError {
    pub(super) fn transport(message: String) -> Self {
        Self {
            status: None,
            message,
            unknown: None,
        }
    }

    /// Client-correctable upstream statuses pass through; everything else
    /// (unreachable, 5xx, an unexpected container) is a 502.
    pub(super) fn response_status(&self) -> StatusCode {
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
pub(super) fn sidecar_error_detail(body: &str) -> String {
    sidecar_sentence(body).unwrap_or_else(|| body.chars().take(500).collect())
}

/// The sentence a sidecar wrote in its JSON error body, if any: the per-field
/// messages of a 422 `{"error": "invalid request", "detail": [{"msg": ...}]}`
/// (they tell the caller which knob was wrong), else `detail`, else `error`.
/// Core relays it alone so the sidecar's own catalog entry still matches.
pub(super) fn sidecar_sentence(body: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    if let Some(items) = value.get("detail").and_then(Value::as_array) {
        let messages: Vec<&str> = items
            .iter()
            .filter_map(|item| item.get("msg").and_then(Value::as_str))
            .collect();
        if !messages.is_empty() {
            return Some(messages.join("; "));
        }
    }
    ["detail", "error"].into_iter().find_map(|key| {
        let text = value.get(key)?.as_str()?.trim();
        (!text.is_empty()).then(|| text.chars().take(500).collect())
    })
}

/// Build a successful audio response with the engine provenance headers.
/// `fallback_from` names the engine that failed when OuteTTS stood in.
pub(super) fn speak_audio_response(
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

pub(super) fn speak_error(status: StatusCode, message: String) -> axum::response::Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/// A Core voice message in English (the Companion's localizer matches it).
pub(super) fn voice_text(message: Message) -> String {
    message.render("en")
}

/// [`speak_error`] for one of the `VOICE_*_MESSAGE` templates.
pub(super) fn speak_message(status: StatusCode, message: Message) -> axum::response::Response {
    speak_error(status, voice_text(message))
}

/// "Text must be at most {limit} characters." The limit is plain digits, not
/// English-grouped ("8,000"), because the Companion relays it verbatim into
/// every locale's sentence.
pub(super) fn speak_text_limit(limit: usize) -> String {
    voice_text(
        Message::new(messages::VOICE_SPEAK_TEXT_LIMIT_MESSAGE).text("limit", limit.to_string()),
    )
}
