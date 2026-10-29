//! Speech-to-text (STT) modality primitive: `transcribe(audio) -> text` behind a
//! swappable engine seam.
//!
//! Four local/cloud engines, one dispatch ([`transcribe_wav_detailed`]):
//! - **parakeet** (default where the `voice-parakeet` feature is compiled): the
//!   in-process ONNX engine — the genuinely in-process hot path, never IPC (see
//!   [`parakeet`]).
//! - **whisper**: forwarded to a local whisper.cpp voice server's `/inference`
//!   (a thin HTTP proxy).
//! - **audiocpp**: forwarded to audio.cpp's OpenAI-shaped multipart transcription
//!   endpoint (a thin HTTP proxy; the server can also host TTS).
//! - **gateway**: the swappable cloud STT slot, routed through the Gateway's
//!   `/v1/audio/transcriptions` with the per-attribute `x-ryu-slot-stt-*` headers
//!   (a thin HTTP proxy).
//!
//! Per the Core-vs-Gateway rule the *dispatch* is a Core concern (it decides
//! *what runs* — which local voice engine handles the audio); this crate owns the
//! reusable transcription logic + result types, while the host couplings it
//! cannot own — the whisper/audio.cpp base-urls, the Gateway url/bearer, and the
//! parakeet model directory — are injected via the narrow [`SttHost`] trait. The crate has
//! ZERO dependency on `apps/core` (mirrors `ryu-search`'s `SearchEmbedder` seam).

use std::{collections::BTreeMap, path::PathBuf};

use serde_json::{json, Value};

pub mod parakeet;

/// Per-engine request options for the multipart STT adapters. Engines that do
/// not accept these request fields (currently the in-process Parakeet path)
/// continue to use their own defaults. `extra` is a bounded raw field escape
/// hatch for upstream options not represented here.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct TranscriptionConfig {
    pub language: Option<String>,
    pub translate: Option<bool>,
    pub temperature: Option<f64>,
    pub temperature_inc: Option<f64>,
    pub best_of: Option<u32>,
    pub beam_size: Option<u32>,
    pub prompt: Option<String>,
    pub no_context: Option<bool>,
    pub suppress_nst: Option<bool>,
    pub max_context: Option<i32>,
    pub max_len: Option<u32>,
    pub extra: BTreeMap<String, String>,
}

impl TranscriptionConfig {
    fn multipart_fields(&self) -> Vec<(String, String)> {
        let mut fields = Vec::new();
        macro_rules! add {
            ($key:literal, $value:expr) => {
                if let Some(value) = $value {
                    fields.push(($key.to_owned(), value.to_string()));
                }
            };
        }
        add!("language", self.language.as_deref());
        add!("translate", self.translate);
        add!("temperature", self.temperature);
        add!("temperature_inc", self.temperature_inc);
        add!("best_of", self.best_of);
        add!("beam_size", self.beam_size);
        add!("prompt", self.prompt.as_deref());
        add!("no_context", self.no_context);
        add!("suppress_nst", self.suppress_nst);
        add!("max_context", self.max_context);
        add!("max_len", self.max_len);
        fields.extend(self.extra.iter().take(32).filter_map(|(key, value)| {
            let key = key.trim();
            let value = value.trim();
            (!key.is_empty()
                && key.len() <= 64
                && value.len() <= 4096
                && !matches!(key, "file" | "model"))
            .then(|| (key.to_owned(), value.to_owned()))
        }));
        fields
    }
}

/// Narrow host seam for the STT dispatch: the couplings the crate cannot own
/// because they read Core config/paths (the whisper sidecar base-url, the Gateway
/// url + bearer, and the extracted parakeet model directory). Core implements
/// this in `apps/core/src/stt_host.rs`.
pub trait SttHost: Send + Sync {
    /// Base URL of the local whisper.cpp voice server (`{base}/inference`).
    fn whisper_base_url(&self) -> String;
    /// Base URL of the local audio.cpp server (`{base}/v1/audio/transcriptions`).
    fn audio_cpp_base_url(&self) -> String {
        // Mirrors Core's `audiocpp::AUDIOCPP_PORT_BASE` (release profile).
        "http://127.0.0.1:8091".to_string()
    }
    /// Model id declared in Ryu's generated audio.cpp server config.
    fn audio_cpp_stt_model(&self) -> String {
        "ryu-audiocpp-stt".to_string()
    }
    /// Base URL of the Gateway (`{base}/v1/audio/transcriptions`).
    fn gateway_url(&self) -> String;
    /// The Gateway bearer token slot (never a raw provider API key).
    fn gateway_bearer(&self) -> Result<String, String>;
    /// The extracted parakeet ONNX model directory
    /// (`models/speech-to-text/parakeet/parakeet-tdt-0.6b-v3-int8`, which Core owns).
    fn parakeet_model_dir(&self) -> PathBuf;
}

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
    pub words: Vec<TranscriptSegment>,
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

/// Retain provider word alignment only when explicit, finite timestamps exist.
fn parse_verbose_words(body: &Value) -> Vec<TranscriptSegment> {
    let rows: Vec<&Value> = if let Some(words) = body.get("words").and_then(Value::as_array) {
        words.iter().collect()
    } else {
        body.get("segments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|segment| segment.get("words").and_then(Value::as_array))
            .flatten()
            .collect()
    };
    rows.into_iter()
        .take(50_000)
        .filter_map(|word| {
            let start = word.get("start")?.as_f64()?;
            let end = word.get("end")?.as_f64()?;
            let text = word
                .get("word")
                .or_else(|| word.get("text"))?
                .as_str()?
                .trim();
            if !start.is_finite()
                || !end.is_finite()
                || start < 0.0
                || end <= start
                || end > 7200.0
                || text.is_empty()
                || text.len() > 2000
            {
                return None;
            }
            Some(TranscriptSegment {
                start_ms: (start * 1000.0).round() as u64,
                end_ms: (end * 1000.0).round() as u64,
                text: text.to_owned(),
            })
        })
        .collect()
}

/// The cross-surface default STT engine, resolved as a swappable default (never
/// a hardcoded literal). Parakeet v3 (in-process ONNX) is the default whenever
/// this build compiled the `voice-parakeet` feature. Lean builds omit the feature
/// and default to whisper.cpp so transcription still works there.
/// `RYU_STT_ENGINE` overrides both, so one env var re-points every surface.
///
/// Which builds carry the feature is a *release-pipeline* fact, and it has been
/// wrong before: the flag lived only in `apps/core/package.json` (`dev`/
/// `dev:watch`/`build`), so every developer had parakeet while the three binaries
/// users actually install — `.github/workflows/release.yml`,
/// `scripts/release/release-local.sh`, `Dockerfile` — were built featureless and
/// silently defaulted to whisper. All four sites now pass
/// `--features sandbox-wasmtime,voice-parakeet,voice-vad`; keep them in sync (the
/// release workflow asserts the resolved feature graph).
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

/// The STT engine ids this crate can route to. Anything else is a
/// configuration error (a typo in a stored preference, `RYU_STT_ENGINE`, or a
/// per-request selector), never a silent reroute to a different engine.
pub const STT_ENGINES: &[&str] = &["parakeet", "whisper", "audiocpp", "gateway"];

/// Resolve an STT engine selector: an explicit non-empty selector wins,
/// otherwise the swappable cross-surface default. Unknown ids are refused with
/// an error naming the valid choices (and logged), so a typo surfaces instead
/// of quietly running whisper.cpp.
pub fn resolve_stt_engine(engine: Option<&str>) -> Result<String, String> {
    let engine = engine
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(default_stt_engine);
    if STT_ENGINES.contains(&engine.as_str()) {
        return Ok(engine);
    }
    tracing::warn!(engine = %engine, "unknown STT engine requested; refusing to fall back");
    Err(format!(
        "unknown STT engine '{engine}'; expected one of: {}",
        STT_ENGINES.join(", ")
    ))
}

/// Transcribe raw audio bytes to text. Routes to the in-process parakeet engine
/// (the default — see [`default_stt_engine`]) or the whisper.cpp voice server
/// (`engine == Some("whisper")`).
///
/// The reusable core of the `/api/voice/transcribe` route, factored out so other
/// Core callers (e.g. the meetings pipeline) can transcribe a WAV chunk without
/// going through an HTTP multipart handler. Returns the transcript or a
/// human-readable error string.
pub async fn transcribe_wav(
    client: &reqwest::Client,
    host: &dyn SttHost,
    bytes: Vec<u8>,
    filename: String,
    engine: Option<&str>,
) -> Result<String, String> {
    transcribe_wav_detailed(client, host, bytes, filename, engine)
        .await
        .map(|t| t.text)
}

/// Like [`transcribe_wav`] but also returns timestamped segments when the engine
/// provides them (Whisper `verbose_json` via the Gateway or local whisper.cpp,
/// and audio.cpp's segment/sample offsets). Parakeet (the in-process default)
/// returns text only, so its `segments` is empty.
pub async fn transcribe_wav_detailed(
    client: &reqwest::Client,
    host: &dyn SttHost,
    bytes: Vec<u8>,
    filename: String,
    engine: Option<&str>,
) -> Result<Transcription, String> {
    transcribe_wav_detailed_with_config(
        client,
        host,
        bytes,
        filename,
        engine,
        TranscriptionConfig::default(),
    )
    .await
}

/// Like [`transcribe_wav_detailed`] with node-wide request options for engines
/// that accept multipart tuning fields (whisper.cpp and audio.cpp).
pub async fn transcribe_wav_detailed_with_config(
    client: &reqwest::Client,
    host: &dyn SttHost,
    bytes: Vec<u8>,
    filename: String,
    engine: Option<&str>,
    config: TranscriptionConfig,
) -> Result<Transcription, String> {
    // Resolve the engine: an explicit non-empty selector wins; otherwise fall
    // back to the swappable cross-surface default (parakeet where compiled in).
    // An unknown id is an error, not a silent route to whisper.cpp.
    let engine = resolve_stt_engine(engine)?;

    // Route to the in-process parakeet engine (default). Text only — no segments.
    //
    // No silent fallback to whisper on a lean build. `parakeet::transcribe` hard-
    // errors when `voice-parakeet` is off, and that error is surfaced verbatim on
    // purpose: reaching here at all means parakeet was *named* — either explicitly
    // per-request, via `RYU_STT_ENGINE`, or by a stored preference — because
    // [`default_stt_engine`] already picks whisper when the feature is absent.
    // Honouring a named engine by quietly running a different one is the silent
    // swap `ryu_sandbox::select_backend` refuses for the same reason: the caller
    // would get whisper's accuracy/latency while believing it measured parakeet.
    // The error text names both remedies (switch to whisper, or rebuild).
    if engine == "parakeet" {
        return parakeet::transcribe(bytes, host.parakeet_model_dir())
            .await
            .map(|text| Transcription {
                text,
                segments: Vec::new(),
                words: Vec::new(),
            })
            .map_err(|e| format!("parakeet transcription failed: {e:#}"));
    }

    // audio.cpp's server accepts the same multipart shape as OpenAI's
    // transcription API. Its Parakeet response includes segment sample offsets;
    // `parse_audio_cpp_segments` normalizes those to the shared millisecond
    // clip contract.
    if engine == "audiocpp" {
        return transcribe_via_audio_cpp(client, host, bytes, filename, &config).await;
    }

    // Gateway-routed Whisper: the swappable cloud STT slot (default provider
    // OpenAI, default model Groq's `whisper-large-v3`). Core emits only the
    // per-attribute slot headers + a bearer to the Gateway — never a raw provider
    // key (CLAUDE.md §1: routing/measuring the model call is a Gateway concern).
    if engine == "gateway" {
        return transcribe_via_gateway(client, host, bytes, filename, &config).await;
    }

    // `whisper`: forward to whisper.cpp's `/inference` multipart endpoint. Request
    // `verbose_json` so the response carries per-segment timings (whisper.cpp
    // degrades to a plain `{ "text": ... }` when it can't, which parses to no
    // segments — never an error).
    let part = reqwest::multipart::Part::bytes(bytes).file_name(filename);
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("response_format", "verbose_json");
    let form = config
        .multipart_fields()
        .into_iter()
        .fold(form, |form, (key, value)| form.text(key, value));

    let url = format!("{}/inference", host.whisper_base_url());
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
    Ok(Transcription {
        text,
        segments,
        words: parse_verbose_words(&value),
    })
}

/// Parse audio.cpp segment timings. Current responses may provide both seconds
/// (`start`/`end`) and sample offsets (`start_sample`/`end_sample`); prefer the
/// seconds because they are already normalized, and fall back to samples for
/// Parakeet-TDT responses that only expose the latter.
fn parse_audio_cpp_segments(body: &Value) -> Vec<TranscriptSegment> {
    let sample_rate = body
        .get("timing")
        .and_then(|timing| timing.get("sample_rate"))
        .and_then(Value::as_f64)
        .or_else(|| body.get("sample_rate").and_then(Value::as_f64))
        .filter(|rate| *rate > 0.0)
        .unwrap_or(16_000.0);

    body.get("segments")
        .and_then(Value::as_array)
        .map(|segments| {
            segments
                .iter()
                .filter_map(|segment| {
                    let (start_ms, end_ms) = if let (Some(start), Some(end)) = (
                        segment.get("start").and_then(Value::as_f64),
                        segment.get("end").and_then(Value::as_f64),
                    ) {
                        (
                            (start.max(0.0) * 1000.0) as u64,
                            (end.max(0.0) * 1000.0) as u64,
                        )
                    } else {
                        let start = segment.get("start_sample").and_then(Value::as_f64)?;
                        let end = segment.get("end_sample").and_then(Value::as_f64)?;
                        (
                            (start.max(0.0) * 1000.0 / sample_rate) as u64,
                            (end.max(0.0) * 1000.0 / sample_rate) as u64,
                        )
                    };
                    let text = segment
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    Some(TranscriptSegment {
                        start_ms,
                        end_ms,
                        text,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn transcribe_via_audio_cpp(
    client: &reqwest::Client,
    host: &dyn SttHost,
    bytes: Vec<u8>,
    filename: String,
    config: &TranscriptionConfig,
) -> Result<Transcription, String> {
    let part = reqwest::multipart::Part::bytes(bytes).file_name(filename);
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", host.audio_cpp_stt_model());
    let form = config
        .multipart_fields()
        .into_iter()
        .filter(|(key, _)| {
            matches!(
                key.as_str(),
                "language" | "temperature" | "prompt" | "response_format"
            ) || config.extra.contains_key(key)
        })
        .fold(form, |form, (key, value)| form.text(key, value));
    let base = host.audio_cpp_base_url();
    let url = format!("{}/v1/audio/transcriptions", base.trim_end_matches('/'));
    let response = client
        .post(&url)
        .multipart(form)
        .send()
        .await
        .map_err(|error| {
            format!(
                "audio.cpp voice engine not reachable at {url}: {error}. Install + start `audiocpp` from the Store first."
            )
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(format!("audio.cpp returned {status}: {detail}"));
    }

    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("could not parse audio.cpp response: {error}"))?;
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let segments = parse_audio_cpp_segments(&value);
    Ok(Transcription {
        text,
        segments,
        words: parse_verbose_words(&value),
    })
}

/// The subset of [`TranscriptionConfig`] the Gateway's strict OpenAI multipart
/// accepts (`language`, `prompt`, `temperature`), bounded the way the Gateway
/// validates them. A value the Gateway would reject is dropped here so a stale
/// preference degrades to the provider default instead of failing every request.
fn gateway_multipart_fields(config: &TranscriptionConfig) -> Vec<(&'static str, String)> {
    let mut fields = Vec::new();
    if let Some(language) = config
        .language
        .as_deref()
        .map(str::trim)
        .filter(|language| {
            !language.is_empty()
                && language.len() <= 32
                && language
                    .bytes()
                    .all(|byte| byte.is_ascii_alphabetic() || byte == b'-')
        })
    {
        fields.push(("language", language.to_owned()));
    }
    if let Some(prompt) = config
        .prompt
        .as_deref()
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty() && prompt.len() <= 4096)
    {
        fields.push(("prompt", prompt.to_owned()));
    }
    if let Some(temperature) = config
        .temperature
        .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
    {
        fields.push(("temperature", temperature.to_string()));
    }
    fields
}

/// Transcribe audio through the Gateway's `/v1/audio/transcriptions`, the
/// swappable cloud STT slot. Standard multipart carries the original audio;
/// explicit slot pins are optional so node modality routing remains authoritative.
/// The bearer authenticates Core to the Gateway, never to an upstream provider.
async fn transcribe_via_gateway(
    client: &reqwest::Client,
    host: &dyn SttHost,
    bytes: Vec<u8>,
    filename: String,
    config: &TranscriptionConfig,
) -> Result<Transcription, String> {
    if bytes.is_empty() || bytes.len() > 25 * 1024 * 1024 {
        return Err("gateway STT requires nonempty audio no larger than 25 MiB".to_owned());
    }
    if filename.is_empty()
        || filename.len() > 200
        || filename
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\' | ':'))
    {
        return Err("gateway STT requires a bounded leaf filename".to_owned());
    }

    let provider = std::env::var("RYU_STT_GATEWAY_PROVIDER")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let slot_model = std::env::var("RYU_STT_GATEWAY_MODEL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let model = slot_model.clone().unwrap_or_else(|| {
        if provider.as_deref() == Some("groq") {
            "whisper-large-v3".to_owned()
        } else if provider.as_deref() == Some("qwen") {
            "qwen3-asr-flash".to_owned()
        } else {
            "whisper-1".to_owned()
        }
    });

    let base = host.gateway_url();
    let base = base.trim_end_matches('/');
    let url = format!("{base}/v1/audio/transcriptions");
    let bearer = host.gateway_bearer()?;

    let part = reqwest::multipart::Part::bytes(bytes).file_name(filename);
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", model.clone())
        .text("response_format", "json");
    let form = gateway_multipart_fields(config)
        .into_iter()
        .fold(form, |form, (key, value)| form.text(key, value));

    let mut request = client.post(&url).bearer_auth(bearer);
    if let Some(provider) = &provider {
        request = request.header("x-ryu-slot-stt-provider", provider);
    }
    if let Some(model) = &slot_model {
        request = request.header("x-ryu-slot-stt-model", model);
    }
    let mut resp = request
        .multipart(form)
        .send()
        .await
        .map_err(|_| "gateway STT transport unavailable".to_owned())?;

    if !resp.status().is_success() {
        let status = resp.status();
        return Err(format!("gateway STT returned {status}"));
    }

    const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
    if resp
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err("gateway STT response exceeds its size limit".to_owned());
    }
    let mut response_body = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|_| "gateway STT response unavailable".to_owned())?
    {
        if response_body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("gateway STT response exceeds its size limit".to_owned());
        }
        response_body.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&response_body)
        .map_err(|_| "could not parse gateway STT response".to_owned())?;
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let segments = parse_verbose_segments(&value);
    Ok(Transcription {
        text,
        segments,
        words: parse_verbose_words(&value),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcription_config_emits_typed_and_safe_raw_multipart_fields() {
        let config = TranscriptionConfig {
            language: Some("fr".to_owned()),
            translate: Some(true),
            temperature: Some(0.25),
            extra: BTreeMap::from([
                ("vad".to_owned(), "true".to_owned()),
                ("file".to_owned(), "override.wav".to_owned()),
                ("model".to_owned(), "other-model".to_owned()),
            ]),
            ..Default::default()
        };
        let fields = config.multipart_fields();
        assert!(fields.contains(&("language".to_owned(), "fr".to_owned())));
        assert!(fields.contains(&("translate".to_owned(), "true".to_owned())));
        assert!(fields.contains(&("temperature".to_owned(), "0.25".to_owned())));
        assert!(fields.contains(&("vad".to_owned(), "true".to_owned())));
        assert!(!fields
            .iter()
            .any(|(key, _)| key == "file" || key == "model"));
    }

    #[test]
    fn measured_words_are_normalized_without_guessing_timing() {
        let body = serde_json::json!({"segments":[{"words":[{"word":" Hello ","start":0.1,"end":0.42},{"word":"invalid","start":1.0,"end":0.5},{"word":"untimed"}]}]});
        let words = parse_verbose_words(&body);
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].text, "Hello");
        assert_eq!((words[0].start_ms, words[0].end_ms), (100, 420));
        assert!(parse_verbose_words(&serde_json::json!({"text":"Hello"})).is_empty());
        let top = parse_verbose_words(
            &serde_json::json!({"words":[{"word":"world","start":0.5,"end":0.8}]}),
        );
        assert_eq!(top[0].text, "world");
    }

    #[test]
    fn parses_verbose_segments_seconds_to_ms() {
        let body = json!({
            "text": "hello world",
            "segments": [
                { "start": 0.0, "end": 1.5, "text": " hello" },
                { "start": 1.5, "end": 2.25, "text": " world " },
            ]
        });
        let segs = parse_verbose_segments(&body);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].start_ms, 0);
        assert_eq!(segs[0].end_ms, 1500);
        assert_eq!(segs[0].text, "hello");
        assert_eq!(segs[1].start_ms, 1500);
        assert_eq!(segs[1].end_ms, 2250);
        assert_eq!(segs[1].text, "world");
    }

    #[test]
    fn missing_or_malformed_segments_yield_empty() {
        assert!(parse_verbose_segments(&json!({ "text": "x" })).is_empty());
        assert!(parse_verbose_segments(&json!({ "segments": "not-an-array" })).is_empty());
        // An entry missing start/end is skipped, not an error.
        let partial = json!({ "segments": [ { "text": "no timings" } ] });
        assert!(parse_verbose_segments(&partial).is_empty());
    }

    #[test]
    fn default_engine_env_override_wins() {
        // Save/restore to avoid leaking into other tests in the same process.
        let prev = std::env::var("RYU_STT_ENGINE").ok();
        std::env::set_var("RYU_STT_ENGINE", "gateway");
        assert_eq!(default_stt_engine(), "gateway");
        std::env::set_var("RYU_STT_ENGINE", "   ");
        // Blank falls through to the compiled default (parakeet or whisper).
        let compiled = default_stt_engine();
        assert!(compiled == "parakeet" || compiled == "whisper");
        match prev {
            Some(v) => std::env::set_var("RYU_STT_ENGINE", v),
            None => std::env::remove_var("RYU_STT_ENGINE"),
        }
    }

    #[test]
    fn resolve_stt_engine_accepts_known_ids_and_refuses_typos() {
        for engine in STT_ENGINES {
            assert_eq!(resolve_stt_engine(Some(engine)).unwrap(), *engine);
        }
        assert_eq!(resolve_stt_engine(Some("  whisper ")).unwrap(), "whisper");
        let error = resolve_stt_engine(Some("whsiper")).unwrap_err();
        assert!(error.contains("unknown STT engine 'whsiper'"), "{error}");
        assert!(
            error.contains("parakeet, whisper, audiocpp, gateway"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn unknown_engine_errors_instead_of_routing_to_whisper() {
        struct NoHost;
        impl SttHost for NoHost {
            fn whisper_base_url(&self) -> String {
                panic!("an unknown engine must not reach whisper.cpp")
            }
            fn audio_cpp_base_url(&self) -> String {
                panic!("an unknown engine must not reach audio.cpp")
            }
            fn gateway_url(&self) -> String {
                panic!("an unknown engine must not reach the Gateway")
            }
            fn gateway_bearer(&self) -> Result<String, String> {
                Err("unused".into())
            }
            fn parakeet_model_dir(&self) -> PathBuf {
                PathBuf::new()
            }
        }
        let error = transcribe_wav_detailed(
            &reqwest::Client::new(),
            &NoHost,
            vec![0; 8],
            "a.wav".into(),
            Some("parakeat"),
        )
        .await
        .unwrap_err();
        assert!(error.contains("unknown STT engine 'parakeat'"), "{error}");
    }

    #[test]
    fn transcript_segment_serializes_camel_case() {
        let seg = TranscriptSegment {
            start_ms: 10,
            end_ms: 20,
            text: "hi".into(),
        };
        let v = serde_json::to_value(&seg).unwrap();
        assert_eq!(v["startMs"], 10);
        assert_eq!(v["endMs"], 20);
        assert_eq!(v["text"], "hi");
    }

    // ── negative / clamp edge cases for the parser ────────────────────────────

    #[test]
    fn verbose_segments_clamp_negative_timestamps_to_zero() {
        // A defensive engine could emit a negative offset; the parser clamps to 0
        // rather than underflowing the u64 cast.
        let body = json!({
            "segments": [ { "start": -1.0, "end": -0.5, "text": "  neg  " } ]
        });
        let segs = parse_verbose_segments(&body);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].start_ms, 0);
        assert_eq!(segs[0].end_ms, 0);
        assert_eq!(segs[0].text, "neg");
    }

    #[test]
    fn verbose_segment_missing_text_defaults_empty_but_keeps_timing() {
        // start/end present but no `text` → kept with an empty string, not dropped.
        let body = json!({ "segments": [ { "start": 1.0, "end": 2.0 } ] });
        let segs = parse_verbose_segments(&body);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].start_ms, 1000);
        assert_eq!(segs[0].end_ms, 2000);
        assert_eq!(segs[0].text, "");
    }

    #[test]
    fn transcription_and_segment_defaults_are_empty() {
        let t = Transcription::default();
        assert!(t.text.is_empty());
        assert!(t.segments.is_empty());
        let s = TranscriptSegment::default();
        assert_eq!(s.start_ms, 0);
        assert_eq!(s.end_ms, 0);
        assert!(s.text.is_empty());
        // Clone/Debug are derived — exercise them so they count.
        let _ = format!("{:?}", t.clone());
        let _ = format!("{:?}", s.clone());
    }

    // ── HTTP-proxy engine dispatch (whisper.cpp + Gateway) ────────────────────
    //
    // These stand up a loopback axum server so the success / non-2xx / bad-body
    // branches run deterministically without any real voice server or network.

    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use axum::{http::HeaderMap, http::StatusCode, Router};
    use tokio::net::TcpListener;

    /// Serializes the few tests that read/write process-global env vars
    /// (`RYU_STT_ENGINE`, `RYU_STT_GATEWAY_PROVIDER`, `RYU_STT_GATEWAY_MODEL`).
    static ENV_LOCK: Mutex<()> = Mutex::new(());
    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    struct FakeHost {
        whisper: String,
        audio_cpp: String,
        gateway: String,
        bearer: Result<String, String>,
    }

    impl Default for FakeHost {
        fn default() -> Self {
            Self {
                whisper: "http://127.0.0.1:0".to_string(),
                audio_cpp: "http://127.0.0.1:0".to_string(),
                gateway: "http://127.0.0.1:0".to_string(),
                bearer: Ok("testtoken".to_string()),
            }
        }
    }

    impl SttHost for FakeHost {
        fn whisper_base_url(&self) -> String {
            self.whisper.clone()
        }
        fn audio_cpp_base_url(&self) -> String {
            self.audio_cpp.clone()
        }
        fn gateway_url(&self) -> String {
            self.gateway.clone()
        }
        fn gateway_bearer(&self) -> Result<String, String> {
            self.bearer.clone()
        }
        fn parakeet_model_dir(&self) -> PathBuf {
            PathBuf::from("/nonexistent/parakeet-model")
        }
    }

    #[derive(Clone, Default)]
    struct Captured {
        provider: Option<String>,
        model: Option<String>,
        authorization: Option<String>,
        content_type: Option<String>,
        body: Vec<u8>,
    }

    struct TestServer {
        addr: std::net::SocketAddr,
        captured: Arc<Mutex<Vec<Captured>>>,
        _handle: tokio::task::JoinHandle<()>,
    }

    impl TestServer {
        fn url(&self) -> String {
            format!("http://{}", self.addr)
        }
        fn last(&self) -> Captured {
            self.captured
                .lock()
                .unwrap()
                .last()
                .cloned()
                .unwrap_or_default()
        }
    }

    /// A loopback HTTP server that records the request headers of each call and
    /// replies with a fixed status + body on every path (fallback route).
    async fn spawn_server(status: StatusCode, resp_body: &'static str) -> TestServer {
        let captured: Arc<Mutex<Vec<Captured>>> = Arc::new(Mutex::new(Vec::new()));
        let cap = captured.clone();
        let app = Router::new().fallback(move |headers: HeaderMap, body: axum::body::Bytes| {
            let cap = cap.clone();
            async move {
                let get = |k: &str| {
                    headers
                        .get(k)
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string)
                };
                cap.lock().unwrap().push(Captured {
                    provider: get("x-ryu-slot-stt-provider"),
                    model: get("x-ryu-slot-stt-model"),
                    authorization: get("authorization"),
                    content_type: get("content-type"),
                    body: body.to_vec(),
                });
                (status, resp_body)
            }
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        TestServer {
            addr,
            captured,
            _handle: handle,
        }
    }

    /// A bound-then-dropped loopback address: connecting to it refuses instantly.
    async fn dead_url() -> String {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        format!("http://{addr}")
    }

    // ── whisper.cpp engine ────────────────────────────────────────────────────

    #[tokio::test]
    async fn whisper_success_parses_text_and_segments() {
        let server = spawn_server(
            StatusCode::OK,
            r#"{"text":"  hello there  ","segments":[{"start":0.0,"end":1.0,"text":" hello"},{"start":1.0,"end":2.0,"text":" there"}]}"#,
        )
        .await;
        let host = FakeHost {
            whisper: server.url(),
            ..FakeHost::default()
        };
        let client = reqwest::Client::new();
        let out = transcribe_wav_detailed(
            &client,
            &host,
            b"fakeaudio".to_vec(),
            "clip.wav".to_string(),
            Some("whisper"),
        )
        .await
        .expect("whisper transcription should succeed");
        assert_eq!(out.text, "hello there");
        assert_eq!(out.segments.len(), 2);
        assert_eq!(out.segments[0].text, "hello");
        assert_eq!(out.segments[1].end_ms, 2000);
    }

    #[tokio::test]
    async fn audiocpp_success_parses_sample_segments() {
        let server = spawn_server(
            StatusCode::OK,
            r#"{"text":"  hello from audio cpp  ","timing":{"sample_rate":16000},"segments":[{"start_sample":0,"end_sample":24000,"text":" hello "},{"start_sample":24000,"end_sample":40000,"text":" from audio cpp "}]}"#,
        )
        .await;
        let host = FakeHost {
            audio_cpp: server.url(),
            ..FakeHost::default()
        };
        let client = reqwest::Client::new();
        let out = transcribe_wav_detailed(
            &client,
            &host,
            b"fakeaudio".to_vec(),
            "clip.wav".to_string(),
            Some("audiocpp"),
        )
        .await
        .expect("audio.cpp transcription should succeed");
        assert_eq!(out.text, "hello from audio cpp");
        assert_eq!(out.segments.len(), 2);
        assert_eq!(out.segments[0].end_ms, 1500);
        assert_eq!(out.segments[1].start_ms, 1500);
        assert_eq!(out.segments[1].end_ms, 2500);
    }

    #[test]
    fn audiocpp_segment_parser_prefers_seconds_when_both_exist() {
        let body = json!({
            "timing": { "sample_rate": 16000 },
            "segments": [{
                "start": 0.25,
                "end": 0.75,
                "start_sample": 0,
                "end_sample": 32000,
                "text": "hello"
            }]
        });
        let segments = parse_audio_cpp_segments(&body);
        assert_eq!(segments[0].start_ms, 250);
        assert_eq!(segments[0].end_ms, 750);
    }

    #[tokio::test]
    async fn whisper_text_only_wrapper_returns_string() {
        let server = spawn_server(StatusCode::OK, r#"{"text":"just text"}"#).await;
        let host = FakeHost {
            whisper: server.url(),
            ..FakeHost::default()
        };
        let client = reqwest::Client::new();
        // The text-only wrapper `transcribe_wav` drops segments.
        let text = transcribe_wav(
            &client,
            &host,
            b"a".to_vec(),
            "c.wav".to_string(),
            Some("whisper"),
        )
        .await
        .unwrap();
        assert_eq!(text, "just text");
    }

    #[tokio::test]
    async fn whisper_non_success_status_is_error() {
        let server = spawn_server(StatusCode::INTERNAL_SERVER_ERROR, "model exploded").await;
        let host = FakeHost {
            whisper: server.url(),
            ..FakeHost::default()
        };
        let client = reqwest::Client::new();
        let err = transcribe_wav_detailed(
            &client,
            &host,
            b"a".to_vec(),
            "c.wav".to_string(),
            Some("whisper"),
        )
        .await
        .unwrap_err();
        assert!(err.contains("whisper returned 500"), "got: {err}");
        assert!(err.contains("model exploded"), "got: {err}");
    }

    #[tokio::test]
    async fn whisper_unparseable_body_is_error() {
        let server = spawn_server(StatusCode::OK, "this is not json").await;
        let host = FakeHost {
            whisper: server.url(),
            ..FakeHost::default()
        };
        let client = reqwest::Client::new();
        let err = transcribe_wav_detailed(
            &client,
            &host,
            b"a".to_vec(),
            "c.wav".to_string(),
            Some("whisper"),
        )
        .await
        .unwrap_err();
        assert!(
            err.contains("could not parse whisper response"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn whisper_unreachable_host_is_error() {
        let host = FakeHost {
            whisper: dead_url().await,
            ..FakeHost::default()
        };
        let client = reqwest::Client::new();
        let err = transcribe_wav_detailed(
            &client,
            &host,
            b"a".to_vec(),
            "c.wav".to_string(),
            Some("whisper"),
        )
        .await
        .unwrap_err();
        assert!(err.contains("not reachable"), "got: {err}");
        assert!(
            err.contains("whispercpp"),
            "actionable hint expected: {err}"
        );
    }

    #[cfg(not(feature = "voice-parakeet"))]
    #[tokio::test]
    async fn empty_engine_selector_falls_through_to_compiled_default() {
        // Without `voice-parakeet` (the cargo-test build), the compiled default is
        // whisper, so a blank selector must hit the whisper arm. Hold ENV_LOCK
        // because this path reads `RYU_STT_ENGINE`.
        let _g = env_guard();
        let prev = std::env::var("RYU_STT_ENGINE").ok();
        std::env::remove_var("RYU_STT_ENGINE");
        let server = spawn_server(StatusCode::OK, r#"{"text":"fallback"}"#).await;
        let host = FakeHost {
            whisper: server.url(),
            ..FakeHost::default()
        };
        let client = reqwest::Client::new();
        let out = transcribe_wav_detailed(
            &client,
            &host,
            b"a".to_vec(),
            "c.wav".to_string(),
            Some("   "),
        )
        .await
        .unwrap();
        assert_eq!(out.text, "fallback");
        if let Some(v) = prev {
            std::env::set_var("RYU_STT_ENGINE", v);
        }
    }

    // ── Gateway engine ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn gateway_success_uses_multipart_without_overriding_node_routing() {
        let _g = env_guard();
        std::env::remove_var("RYU_STT_GATEWAY_PROVIDER");
        std::env::remove_var("RYU_STT_GATEWAY_MODEL");
        let server = spawn_server(
            StatusCode::OK,
            r#"{"text":" gw text ","segments":[{"start":0.0,"end":0.5,"text":"gw"}]}"#,
        )
        .await;
        let host = FakeHost {
            gateway: server.url(),
            bearer: Ok("secret-slot-token".to_string()),
            ..FakeHost::default()
        };
        let client = reqwest::Client::new();
        let out = transcribe_wav_detailed(
            &client,
            &host,
            vec![0, 255, 1],
            "c.wav".to_string(),
            Some("gateway"),
        )
        .await
        .unwrap();
        assert_eq!(out.text, "gw text");
        assert_eq!(out.segments.len(), 1);
        let cap = server.last();
        assert_eq!(cap.provider, None);
        assert_eq!(cap.model, None);
        assert!(cap
            .content_type
            .as_deref()
            .unwrap()
            .starts_with("multipart/form-data; boundary="));
        assert!(cap.body.windows(3).any(|bytes| bytes == [0, 255, 1]));
        let filename = b"filename=\"c.wav\"";
        assert!(cap
            .body
            .windows(filename.len())
            .any(|bytes| bytes == filename));
        assert_eq!(
            cap.authorization.as_deref(),
            Some("Bearer secret-slot-token")
        );
    }

    #[test]
    fn gateway_fields_forward_only_values_the_gateway_accepts() {
        let config = TranscriptionConfig {
            language: Some(" fr ".to_owned()),
            prompt: Some("Ryu, Parakeet".to_owned()),
            temperature: Some(0.2),
            translate: Some(true),
            extra: BTreeMap::from([("vad".to_owned(), "true".to_owned())]),
            ..Default::default()
        };
        assert_eq!(
            gateway_multipart_fields(&config),
            vec![
                ("language", "fr".to_owned()),
                ("prompt", "Ryu, Parakeet".to_owned()),
                ("temperature", "0.2".to_owned()),
            ]
        );
        let rejected = TranscriptionConfig {
            language: Some("en_US".to_owned()),
            prompt: Some("  ".to_owned()),
            temperature: Some(1.5),
            ..Default::default()
        };
        assert!(gateway_multipart_fields(&rejected).is_empty());
    }

    #[tokio::test]
    async fn gateway_forwards_configured_language() {
        let _g = env_guard();
        std::env::remove_var("RYU_STT_GATEWAY_PROVIDER");
        std::env::remove_var("RYU_STT_GATEWAY_MODEL");
        let server = spawn_server(StatusCode::OK, r#"{"text":"bonjour"}"#).await;
        let host = FakeHost {
            gateway: server.url(),
            ..FakeHost::default()
        };
        let config = TranscriptionConfig {
            language: Some("fr".to_owned()),
            ..Default::default()
        };
        let out = transcribe_wav_detailed_with_config(
            &reqwest::Client::new(),
            &host,
            b"a".to_vec(),
            "c.wav".to_string(),
            Some("gateway"),
            config,
        )
        .await
        .unwrap();
        assert_eq!(out.text, "bonjour");
        let body = String::from_utf8_lossy(&server.last().body).into_owned();
        assert!(body.contains("name=\"language\"\r\n\r\nfr\r\n"), "{body}");
    }

    #[tokio::test]
    async fn gateway_env_overrides_provider_and_model() {
        let _g = env_guard();
        std::env::set_var("RYU_STT_GATEWAY_PROVIDER", "groq");
        std::env::set_var("RYU_STT_GATEWAY_MODEL", "whisper-turbo");
        let server = spawn_server(StatusCode::OK, r#"{"text":"x"}"#).await;
        // Trailing slash on the gateway base must be trimmed before the path join.
        let host = FakeHost {
            gateway: format!("{}/", server.url()),
            ..FakeHost::default()
        };
        let client = reqwest::Client::new();
        let out = transcribe_wav_detailed(
            &client,
            &host,
            b"a".to_vec(),
            "c.wav".to_string(),
            Some("gateway"),
        )
        .await
        .unwrap();
        assert_eq!(out.text, "x");
        let cap = server.last();
        assert_eq!(cap.provider.as_deref(), Some("groq"));
        assert_eq!(cap.model.as_deref(), Some("whisper-turbo"));
        std::env::remove_var("RYU_STT_GATEWAY_PROVIDER");
        std::env::remove_var("RYU_STT_GATEWAY_MODEL");
    }

    #[tokio::test]
    async fn gateway_bearer_error_short_circuits() {
        let _g = env_guard();
        std::env::remove_var("RYU_STT_GATEWAY_PROVIDER");
        std::env::remove_var("RYU_STT_GATEWAY_MODEL");
        // No server is contacted — the bearer failure must propagate before the POST.
        let host = FakeHost {
            gateway: "http://127.0.0.1:0".to_string(),
            bearer: Err("no gateway token configured".to_string()),
            ..FakeHost::default()
        };
        let client = reqwest::Client::new();
        let err = transcribe_wav_detailed(
            &client,
            &host,
            b"a".to_vec(),
            "c.wav".to_string(),
            Some("gateway"),
        )
        .await
        .unwrap_err();
        assert_eq!(err, "no gateway token configured");
    }

    #[tokio::test]
    async fn gateway_non_success_status_is_error() {
        let _g = env_guard();
        std::env::remove_var("RYU_STT_GATEWAY_PROVIDER");
        std::env::remove_var("RYU_STT_GATEWAY_MODEL");
        let server = spawn_server(StatusCode::UNAUTHORIZED, "bad key").await;
        let host = FakeHost {
            gateway: server.url(),
            ..FakeHost::default()
        };
        let client = reqwest::Client::new();
        let err = transcribe_wav_detailed(
            &client,
            &host,
            b"a".to_vec(),
            "c.wav".to_string(),
            Some("gateway"),
        )
        .await
        .unwrap_err();
        assert!(err.contains("gateway STT returned 401"), "got: {err}");
        assert!(
            !err.contains("bad key"),
            "upstream details must stay private: {err}"
        );
    }

    #[tokio::test]
    async fn gateway_unparseable_body_is_error() {
        let _g = env_guard();
        std::env::remove_var("RYU_STT_GATEWAY_PROVIDER");
        std::env::remove_var("RYU_STT_GATEWAY_MODEL");
        let server = spawn_server(StatusCode::OK, "<html>not json</html>").await;
        let host = FakeHost {
            gateway: server.url(),
            ..FakeHost::default()
        };
        let client = reqwest::Client::new();
        let err = transcribe_wav_detailed(
            &client,
            &host,
            b"a".to_vec(),
            "c.wav".to_string(),
            Some("gateway"),
        )
        .await
        .unwrap_err();
        assert!(
            err.contains("could not parse gateway STT response"),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn gateway_unreachable_host_is_error() {
        let _g = env_guard();
        std::env::remove_var("RYU_STT_GATEWAY_PROVIDER");
        std::env::remove_var("RYU_STT_GATEWAY_MODEL");
        let host = FakeHost {
            gateway: dead_url().await,
            ..FakeHost::default()
        };
        let client = reqwest::Client::new();
        let err = transcribe_wav_detailed(
            &client,
            &host,
            b"a".to_vec(),
            "c.wav".to_string(),
            Some("gateway"),
        )
        .await
        .unwrap_err();
        assert_eq!(err, "gateway STT transport unavailable");
    }

    #[tokio::test]
    async fn gateway_qwen_pin_uses_json_and_its_native_model() {
        let _g = env_guard();
        std::env::set_var("RYU_STT_GATEWAY_PROVIDER", "qwen");
        std::env::remove_var("RYU_STT_GATEWAY_MODEL");
        let server = spawn_server(StatusCode::OK, r#"{"text":"native"}"#).await;
        let host = FakeHost {
            gateway: server.url(),
            ..FakeHost::default()
        };
        let out = transcribe_wav_detailed(
            &reqwest::Client::new(),
            &host,
            b"a".to_vec(),
            "clip.wav".to_owned(),
            Some("gateway"),
        )
        .await
        .unwrap();
        std::env::remove_var("RYU_STT_GATEWAY_PROVIDER");
        assert_eq!(out.text, "native");
        assert!(out.segments.is_empty() && out.words.is_empty());
        let captured = server.last();
        assert_eq!(captured.provider.as_deref(), Some("qwen"));
        assert_eq!(captured.model, None);
        let body = String::from_utf8(captured.body).unwrap();
        assert!(body.contains("qwen3-asr-flash"));
        assert!(body.contains("name=\"response_format\"\r\n\r\njson"));
        assert!(!body.contains("verbose_json"));
    }

    #[tokio::test]
    async fn gateway_rejects_empty_audio_and_path_filenames_before_http() {
        let server = spawn_server(StatusCode::OK, r#"{"text":"unused"}"#).await;
        let host = FakeHost {
            gateway: server.url(),
            ..FakeHost::default()
        };
        let client = reqwest::Client::new();
        for (audio, filename) in [
            (Vec::new(), "clip.wav"),
            (vec![1], "../private.wav"),
            (vec![1], "private\\clip.wav"),
        ] {
            assert!(transcribe_via_gateway(
                &client,
                &host,
                audio,
                filename.to_owned(),
                &TranscriptionConfig::default()
            )
            .await
            .is_err());
        }
        assert!(server.captured.lock().unwrap().is_empty());
    }

    // ── parakeet dispatch (feature off in `cargo test`) ───────────────────────

    #[cfg(not(feature = "voice-parakeet"))]
    #[tokio::test]
    async fn parakeet_engine_without_feature_reports_not_built() {
        let host = FakeHost::default();
        let client = reqwest::Client::new();
        let err = transcribe_wav_detailed(
            &client,
            &host,
            b"a".to_vec(),
            "c.wav".to_string(),
            Some("parakeet"),
        )
        .await
        .unwrap_err();
        assert!(err.contains("parakeet transcription failed"), "got: {err}");
        assert!(err.contains("not built"), "got: {err}");
    }
}
