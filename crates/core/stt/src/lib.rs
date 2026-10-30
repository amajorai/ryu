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

use serde_json::Value;

mod http_engines;
pub mod parakeet;

use http_engines::{transcribe_via_audio_cpp, transcribe_via_gateway};

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
/// this build compiled the `voice-parakeet` feature on a target ONNX Runtime
/// ships for. Lean builds omit the feature, and Intel macOS has no ONNX Runtime
/// (see [`parakeet`]); both default to whisper.cpp so transcription still works
/// there. `RYU_STT_ENGINE` overrides both, so one env var re-points every surface.
///
/// Which builds carry the feature is a *release-pipeline* fact, and it has been
/// wrong before: the flag lived only in `apps/core/package.json` (`dev`/
/// `dev:watch`/`build`), so every developer had parakeet while the three binaries
/// users actually install — `.github/workflows/release.yml`,
/// `scripts/release/release-local.sh`, `Dockerfile` — were built featureless and
/// silently defaulted to whisper. Every build site listed in
/// `apps/core/DEPENDENCIES.md` now passes
/// `--features sandbox-wasmtime,voice-parakeet,voice-vad`; keep them in sync (the
/// release workflows assert the resolved feature graph).
pub fn default_stt_engine() -> String {
    if let Ok(env_engine) = std::env::var("RYU_STT_ENGINE") {
        let trimmed = env_engine.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    #[cfg(all(
        feature = "voice-parakeet",
        not(all(target_os = "macos", target_arch = "x86_64"))
    ))]
    {
        "parakeet".to_string()
    }
    #[cfg(not(all(
        feature = "voice-parakeet",
        not(all(target_os = "macos", target_arch = "x86_64"))
    )))]
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

#[cfg(test)]
mod tests;
