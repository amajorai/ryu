//! Speech-to-text (STT) modality primitive: `transcribe(audio) -> text` behind a
//! swappable engine seam.
//!
//! Three engines, one dispatch ([`transcribe_wav_detailed`]):
//! - **parakeet** (default where the `voice-parakeet` feature is compiled): the
//!   in-process ONNX engine — the genuinely in-process hot path, never IPC (see
//!   [`parakeet`]).
//! - **whisper**: forwarded to a local whisper.cpp voice server's `/inference`
//!   (a thin HTTP proxy).
//! - **gateway**: the swappable cloud STT slot, routed through the Gateway's
//!   `/v1/audio/transcriptions` with the per-attribute `x-ryu-slot-stt-*` headers
//!   (a thin HTTP proxy).
//!
//! Per the Core-vs-Gateway rule the *dispatch* is a Core concern (it decides
//! *what runs* — which local voice engine handles the audio); this crate owns the
//! reusable transcription logic + result types, while the host couplings it
//! cannot own — the whisper base-url, the Gateway url/bearer, and the parakeet
//! model directory — are injected via the narrow [`SttHost`] trait. The crate has
//! ZERO dependency on `apps/core` (mirrors `ryu-search`'s `SearchEmbedder` seam).

use std::path::PathBuf;

use serde_json::{json, Value};

pub mod parakeet;

/// Narrow host seam for the STT dispatch: the couplings the crate cannot own
/// because they read Core config/paths (the whisper sidecar base-url, the Gateway
/// url + bearer, and the extracted parakeet model directory). Core implements
/// this in `apps/core/src/stt_host.rs`.
pub trait SttHost: Send + Sync {
    /// Base URL of the local whisper.cpp voice server (`{base}/inference`).
    fn whisper_base_url(&self) -> String;
    /// Base URL of the Gateway (`{base}/v1/audio/transcriptions`).
    fn gateway_url(&self) -> String;
    /// The Gateway bearer token slot (never a raw provider API key).
    fn gateway_bearer(&self) -> Result<String, String>;
    /// The extracted parakeet ONNX model directory (a `~/.ryu` path Core owns).
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

/// The cross-surface default STT engine, resolved as a swappable default (never
/// a hardcoded literal). Parakeet v3 (in-process ONNX) is the default whenever
/// this build compiled the `voice-parakeet` feature — the shipped dev and
/// release binaries do, so the installed app transcribes with parakeet out of the
/// box. Lean CI/`cargo test` builds omit the feature and fall back to whisper.cpp
/// so transcription still works there. `RYU_STT_ENGINE` overrides both, so one
/// env var re-points every surface.
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
/// provides them (Whisper `verbose_json` via the Gateway or local whisper.cpp).
/// Parakeet (the in-process default) returns text only, so its segments are empty.
pub async fn transcribe_wav_detailed(
    client: &reqwest::Client,
    host: &dyn SttHost,
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
        return parakeet::transcribe(bytes, host.parakeet_model_dir())
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
        return transcribe_via_gateway(client, host, bytes).await;
    }

    // Default: forward to whisper.cpp's `/inference` multipart endpoint. Request
    // `verbose_json` so the response carries per-segment timings (whisper.cpp
    // degrades to a plain `{ "text": ... }` when it can't, which parses to no
    // segments — never an error).
    let part = reqwest::multipart::Part::bytes(bytes).file_name(filename);
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("response_format", "verbose_json");

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
/// multipart file, but `providers/openai.rs` currently forwards JSON verbatim.
/// The Gateway owner must also point `modality_map[Stt]`/`base_url` at Groq. Until
/// then, set `RYU_CLIP_STT_ENGINE=whisper` (local whisper.cpp) to ship without
/// waiting — and captions-first means most YouTube ingests never hit Whisper.
async fn transcribe_via_gateway(
    client: &reqwest::Client,
    host: &dyn SttHost,
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

    let base = host.gateway_url();
    let base = base.trim_end_matches('/');
    let url = format!("{base}/v1/audio/transcriptions");
    let bearer = host.gateway_bearer()?;

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
