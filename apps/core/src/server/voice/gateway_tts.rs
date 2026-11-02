//! Synthesis through the native audio.cpp runtime and the Gateway's Audio slot.

use super::*;

/// Build the audio.cpp OpenAI-compatible TTS request. Model-specific options
/// belong under `options`; `speaking_rate` is the PocketTTS option documented by
/// audio.cpp, while voice/reference fields stay at the request top level.
pub(super) fn audio_cpp_tts_payload(req: &SpeakRequest, text: &str) -> Value {
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

pub(super) async fn synth_via_audio_cpp_at(
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
pub(super) fn gateway_tts_slot_overrides() -> (Option<String>, Option<String>) {
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

pub(super) fn gateway_tts_provider_from_config<'a>(
    root: &'a toml::Value,
    model: &str,
) -> Option<&'a str> {
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

pub(super) fn gateway_tts_provider_hint(slot_provider: Option<&str>, model: &str) -> String {
    if let Some(provider) = slot_provider {
        return provider.to_owned();
    }
    let mut default_provider = None;
    if let Some(path) = crate::server::gateway_config_path() {
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

pub(super) fn gateway_tts_native_default(provider: &str) -> Option<&'static str> {
    match provider {
        "edge-tts" => Some("en-US-EmmaMultilingualNeural"),
        "google-tts" => Some("en-US-Neural2-F"),
        "google-translate-tts" => Some("en"),
        "polly" => Some("Joanna"),
        _ => None,
    }
}

pub(super) fn gateway_tts_payload_for_provider(
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
pub(super) fn gateway_tts_payload(
    model: &str,
    voice: Option<&str>,
    speed: Option<f32>,
    text: &str,
) -> Value {
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
pub(super) fn build_gateway_tts_request(
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
pub(super) fn gateway_tts_engine_row() -> Value {
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
pub(super) const MAX_TTS_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

pub(super) async fn read_tts_response_bytes(
    mut response: reqwest::Response,
) -> Result<Vec<u8>, String> {
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

pub(super) async fn decode_gateway_audio_response(
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

pub(super) fn gateway_audio_mime(value: &str) -> Option<&'static str> {
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
pub(super) fn gateway_tts_request_payload(
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

pub(super) async fn send_gateway_tts_request(
    request: reqwest::RequestBuilder,
) -> Result<(Vec<u8>, String), String> {
    let response = request
        .send()
        .await
        .map_err(|_| "gateway audio transport unavailable".to_owned())?;
    decode_gateway_audio_response(response).await
}
