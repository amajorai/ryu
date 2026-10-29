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

/// The preference key suffix (`engine.transcription.<name>`) for an engine
/// selector, resolving an empty selector to the cross-surface default.
fn preference_engine(engine: Option<&str>) -> Option<&'static str> {
    let default_engine = ryu_stt::default_stt_engine();
    let engine = engine
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(default_engine.as_str());
    match engine.to_ascii_lowercase().as_str() {
        "whisper" | "whispercpp" => Some("whispercpp"),
        "audiocpp" => Some("audiocpp"),
        "parakeet" => Some("parakeet"),
        "gateway" => Some("gateway"),
        _ => None,
    }
}

/// Apply a per-request language hint over the engine preference. A BCP-47 tag
/// forces that language. An explicit `auto` also overrides a saved language:
/// whisper.cpp accepts `language=auto`, and the other engines detect when no
/// language is sent. No hint (or an empty one) keeps the saved preference.
fn apply_language_hint(
    config: &mut ryu_stt::TranscriptionConfig,
    engine: Option<&str>,
    language: Option<&str>,
) {
    let Some(hint) = language.map(str::trim).filter(|hint| !hint.is_empty()) else {
        return;
    };
    config.language = if hint.eq_ignore_ascii_case("auto") {
        (preference_engine(engine) == Some("whispercpp")).then(|| "auto".to_string())
    } else {
        Some(hint.to_string())
    };
}

async fn engine_transcription_config(engine: Option<&str>) -> ryu_stt::TranscriptionConfig {
    let Some(preference_engine) = preference_engine(engine) else {
        return ryu_stt::TranscriptionConfig::default();
    };
    let key = format!("engine.transcription.{preference_engine}");
    let preferences = match crate::server::preferences::PreferencesStore::open_default() {
        Ok(preferences) => preferences,
        Err(error) => {
            tracing::warn!(%error, engine = preference_engine, "could not read transcription settings");
            return ryu_stt::TranscriptionConfig::default();
        }
    };
    match preferences.get(&key).await {
        Ok(Some(value)) => serde_json::from_str(&value).unwrap_or_default(),
        Ok(None) => ryu_stt::TranscriptionConfig::default(),
        Err(error) => {
            tracing::warn!(%error, engine = preference_engine, "could not read transcription settings");
            ryu_stt::TranscriptionConfig::default()
        }
    }
}

impl SttHost for CoreSttHost {
    fn whisper_base_url(&self) -> String {
        crate::sidecar::providers::whispercpp::whisper_base_url()
    }

    fn audio_cpp_base_url(&self) -> String {
        crate::sidecar::providers::audiocpp::base_url()
    }

    /// Must match the id Core writes into the audio.cpp server config, which
    /// honours `RYU_AUDIOCPP_STT_MODEL_ID`; the crate default would 404 there.
    fn audio_cpp_stt_model(&self) -> String {
        crate::sidecar::providers::audiocpp::stt_model_id()
    }

    fn gateway_url(&self) -> String {
        crate::sidecar::gateway::gateway_url()
    }

    fn gateway_bearer(&self) -> Result<String, String> {
        crate::sidecar::gateway::required_gateway_inference_token().map_err(|e| e.to_string())
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
    let config = engine_transcription_config(engine).await;
    ryu_stt::transcribe_wav_detailed_with_config(
        client,
        &CoreSttHost,
        bytes,
        filename,
        engine,
        config,
    )
    .await
    .map(|result| result.text)
}

/// Like [`transcribe_wav`] but also returns timestamped segments when the engine
/// provides them. A per-request `language` hint (BCP-47, `auto` = detect)
/// overrides the engine preference for engines that accept one.
pub async fn transcribe_wav_detailed(
    client: &reqwest::Client,
    bytes: Vec<u8>,
    filename: String,
    engine: Option<&str>,
    language: Option<&str>,
) -> Result<ryu_stt::Transcription, String> {
    let mut config = engine_transcription_config(engine).await;
    apply_language_hint(&mut config, engine, language);
    ryu_stt::transcribe_wav_detailed_with_config(
        client,
        &CoreSttHost,
        bytes,
        filename,
        engine,
        config,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_cpp_stt_model_matches_the_configured_server_model_id() {
        assert_eq!(
            CoreSttHost.audio_cpp_stt_model(),
            crate::sidecar::providers::audiocpp::stt_model_id()
        );
        let previous = std::env::var("RYU_AUDIOCPP_STT_MODEL_ID").ok();
        std::env::set_var("RYU_AUDIOCPP_STT_MODEL_ID", "custom-parakeet");
        let resolved = CoreSttHost.audio_cpp_stt_model();
        match previous {
            Some(value) => std::env::set_var("RYU_AUDIOCPP_STT_MODEL_ID", value),
            None => std::env::remove_var("RYU_AUDIOCPP_STT_MODEL_ID"),
        }
        assert_eq!(resolved, "custom-parakeet");
    }

    fn saved(language: &str) -> ryu_stt::TranscriptionConfig {
        ryu_stt::TranscriptionConfig {
            language: Some(language.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn explicit_auto_overrides_a_saved_language() {
        let mut whisper = saved("en");
        apply_language_hint(&mut whisper, Some("whispercpp"), Some("auto"));
        assert_eq!(whisper.language.as_deref(), Some("auto"));

        let mut gateway = saved("en");
        apply_language_hint(&mut gateway, Some("gateway"), Some("AUTO"));
        assert_eq!(gateway.language, None);

        let mut audio_cpp = saved("en");
        apply_language_hint(&mut audio_cpp, Some("audiocpp"), Some(" auto "));
        assert_eq!(audio_cpp.language, None);
    }

    #[test]
    fn a_tag_forces_its_language_and_no_hint_keeps_the_preference() {
        let mut forced = saved("en");
        apply_language_hint(&mut forced, Some("whisper"), Some("fr"));
        assert_eq!(forced.language.as_deref(), Some("fr"));

        for hint in [None, Some(""), Some("  ")] {
            let mut kept = saved("en");
            apply_language_hint(&mut kept, Some("whispercpp"), hint);
            assert_eq!(kept.language.as_deref(), Some("en"));
        }
    }
}
