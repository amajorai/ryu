//! The audio.cpp and Gateway STT engines: thin HTTP proxies that
//! [`crate::transcribe_wav_detailed_with_config`] dispatches to. Kept out of the
//! crate root so `lib.rs` stays within the repository file-size limits.

use serde_json::Value;

use crate::{
    parse_verbose_segments, parse_verbose_words, SttHost, TranscriptSegment, Transcription,
    TranscriptionConfig,
};

/// Parse audio.cpp segment timings. Current responses may provide both seconds
/// (`start`/`end`) and sample offsets (`start_sample`/`end_sample`); prefer the
/// seconds because they are already normalized, and fall back to samples for
/// Parakeet-TDT responses that only expose the latter.
pub(crate) fn parse_audio_cpp_segments(body: &Value) -> Vec<TranscriptSegment> {
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

pub(crate) async fn transcribe_via_audio_cpp(
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
pub(crate) fn gateway_multipart_fields(
    config: &TranscriptionConfig,
) -> Vec<(&'static str, String)> {
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
pub(crate) async fn transcribe_via_gateway(
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
