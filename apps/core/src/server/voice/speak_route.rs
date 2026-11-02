//! `POST /api/voice/speak`: engine selection, the OuteTTS fallback rule, and
//! synthesis through the Ryu TTS sidecar.

use super::*;
use crate::i18n::{messages, Message};

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
    authorization: Option<axum::Extension<crate::server::ResolvedAuthorization>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    if let Err(response) =
        crate::server::media::enforce_host_media_permission(&state, &caller, &headers).await
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
            return speak_message(
                StatusCode::FORBIDDEN,
                Message::new(messages::VOICE_SPEAK_OWNER_ONLY_MESSAGE),
            );
        }
        if req.text.chars().count() > MAX_MEMBER_SPEAK_TEXT_CHARS {
            return speak_error(
                StatusCode::BAD_REQUEST,
                speak_text_limit(MAX_MEMBER_SPEAK_TEXT_CHARS),
            );
        }
    }
    if req.reference_audio.is_some() && req.reference_audio_data_url.is_some() {
        return speak_message(
            StatusCode::BAD_REQUEST,
            Message::new(messages::VOICE_SPEAK_ONE_REFERENCE_MESSAGE),
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
        return speak_message(
            StatusCode::BAD_REQUEST,
            Message::new(messages::VOICE_SPEAK_MISSING_TEXT_MESSAGE),
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
            Err(e) => speak_message(
                StatusCode::BAD_GATEWAY,
                Message::new(messages::VOICE_SPEAK_OUTETTS_FAILED_MESSAGE)
                    .text("error", format!("{e:#}")),
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
                voice_text(
                    Message::new(messages::VOICE_SPEAK_GATEWAY_FAILED_MESSAGE).text("error", error),
                ),
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
                    voice_text(
                        Message::new(messages::VOICE_SPEAK_AUDIOCPP_FAILED_MESSAGE)
                            .text("error", error),
                    ),
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
        Err(fallback_err) => {
            // One whole sentence for the reader; both causes go to the log.
            tracing::warn!(engine = %engine, %error, "OuteTTS fallback failed too: {fallback_err:#}");
            speak_message(
                StatusCode::BAD_GATEWAY,
                Message::new(messages::VOICE_SPEAK_FALLBACK_FAILED_MESSAGE).text("engine", &engine),
            )
        }
    }
}

/// OuteTTS may stand in only for plain read-aloud on the node's default engine:
/// `engine` unset, equal to the default (desktop read-aloud always sends its
/// stored preference, which is the default on a fresh install), or the
/// `gateway` cloud slot. A different named engine, a cloning request, or any
/// studio option (seed, instruction, effects, a non-WAV container, ...) means
/// the caller wants *that* output; substituting OuteTTS, which honours none of
/// it, would be wrong output, not graceful degradation.
pub(super) fn fallback_allowed(
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
pub(super) fn requests_studio_options(req: &SpeakRequest) -> bool {
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
pub(super) async fn synth_via_sidecar(
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
pub(super) fn unknown_tts_engine_response(unknown: &UnknownTtsEngine) -> axum::response::Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": unknown.to_string(), "code": "tts_engine_unknown" })),
    )
        .into_response()
}

pub(super) async fn synth_via_sidecar_at(
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
pub(super) async fn post_sidecar_generate(
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
            tracing::warn!(engine, %url, "Ryu Audio sidecar not reachable: {e}");
            SidecarSynthError::transport(voice_text(Message::new(
                messages::VOICE_SIDECAR_UNREACHABLE_MESSAGE,
            )))
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
        // Relay the sidecar's own sentence alone (as the engine install route
        // does), so its catalog entry matches; status and raw body go to the log.
        let status = resp.status();
        let raw = resp.text().await.unwrap_or_default();
        let detail: String = raw.chars().take(4000).collect();
        tracing::warn!(engine, %status, %detail, "Audio engine synthesis failed");
        let message = sidecar_sentence(&raw).unwrap_or_else(|| {
            voice_text(
                Message::new(messages::VOICE_ENGINE_FAILED_MESSAGE)
                    .text("engine", engine)
                    .text("status", status.as_u16().to_string()),
            )
        });
        return Err(SidecarSynthError {
            status: Some(status),
            message,
            unknown: None,
        });
    }

    let raw_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let engine_error = |template: crate::i18n::Template| {
        SidecarSynthError::transport(voice_text(Message::new(template).text("engine", engine)))
    };
    let content_type = sidecar_audio_mime(raw_type.as_deref()).ok_or_else(|| {
        let raw_type = raw_type.as_deref().unwrap_or("");
        tracing::warn!(
            engine,
            content_type = raw_type,
            "Audio engine returned non-audio"
        );
        engine_error(messages::VOICE_ENGINE_CONTENT_TYPE_MESSAGE)
    })?;
    let bytes = resp.bytes().await.map_err(|e| {
        tracing::warn!(engine, "reading Audio output failed: {e}");
        engine_error(messages::VOICE_ENGINE_READ_FAILED_MESSAGE)
    })?;
    if bytes.is_empty() {
        return Err(engine_error(messages::VOICE_ENGINE_EMPTY_AUDIO_MESSAGE));
    }
    Ok((bytes.to_vec(), content_type))
}
