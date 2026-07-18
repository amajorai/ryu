//! Core's kernel side of the extracted [`ryu_stt`] seam.
//!
//! The `ryu-stt` crate owns the speech-to-text primitive — the engine dispatch
//! (`transcribe_wav_detailed`), the `Transcription`/`TranscriptSegment` result
//! types + `verbose_json` parsing, the cross-surface `default_stt_engine`
//! resolver, and the genuinely in-process parakeet ONNX engine. What it cannot
//! own — because they read Core config/paths — are three couplings: the local
//! whisper.cpp base-url, the Gateway url + bearer, and the extracted parakeet
//! model directory (the downloader that computes it stays Core-side sidecar
//! lifecycle). This shim wires all three behind the crate's narrow
//! [`ryu_stt::SttHost`] trait, and re-exports thin wrappers so the existing
//! callers (`server::voice`, hardware/voice-session/meetings) keep their
//! signatures.
//!
//! Mirrors the `search_host`/`rag_host` precedent (kernel wiring the extracted
//! crate can't own).

use std::path::PathBuf;

use ryu_stt::SttHost;

/// Core's [`SttHost`] — resolves the whisper base-url, Gateway url/bearer, and
/// parakeet model directory from Core config/sidecar state.
pub struct CoreSttHost;

impl SttHost for CoreSttHost {
    fn whisper_base_url(&self) -> String {
        crate::sidecar::providers::whispercpp::whisper_base_url()
    }

    fn gateway_url(&self) -> String {
        crate::sidecar::gateway::gateway_url()
    }

    fn gateway_bearer(&self) -> Result<String, String> {
        crate::sidecar::gateway::gateway_bearer().map_err(|e| e.to_string())
    }

    fn parakeet_model_dir(&self) -> PathBuf {
        crate::sidecar::providers::parakeet::model_dir()
    }
}

/// Transcribe raw audio bytes to text (the reusable data-path entry, injecting
/// Core's [`CoreSttHost`]). Signature preserved so `hardware`, the voice session,
/// and the meetings pipeline call it unchanged.
pub async fn transcribe_wav(
    client: &reqwest::Client,
    bytes: Vec<u8>,
    filename: String,
    engine: Option<&str>,
) -> Result<String, String> {
    ryu_stt::transcribe_wav(client, &CoreSttHost, bytes, filename, engine).await
}

/// Like [`transcribe_wav`] but also returns timestamped segments when the engine
/// provides them.
pub async fn transcribe_wav_detailed(
    client: &reqwest::Client,
    bytes: Vec<u8>,
    filename: String,
    engine: Option<&str>,
) -> Result<ryu_stt::Transcription, String> {
    ryu_stt::transcribe_wav_detailed(client, &CoreSttHost, bytes, filename, engine).await
}
