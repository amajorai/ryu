//! Bounded standard audio wire conversion; provider execution stays in the pipeline.
use crate::error::GatewayError;
use axum::extract::Multipart;
use base64::Engine as _;
use serde_json::{json, Value};

pub const MAX_AUDIO_UPLOAD_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_AUDIO_MULTIPART_BYTES: usize = MAX_AUDIO_UPLOAD_BYTES + 64 * 1024;
pub const MAX_SPEECH_BYTES: usize = 8 * 1024 * 1024;

fn invalid(message: &str) -> GatewayError {
    GatewayError::BadRequest(message.to_owned())
}

fn undelivered(message: &str) -> GatewayError {
    GatewayError::ProviderDeliveryUncertain(message.to_owned())
}

pub fn validate_speech_request(body: &Value) -> Result<(), GatewayError> {
    body["model"]
        .as_str()
        .filter(|text| !text.is_empty() && text.len() <= 256)
        .ok_or_else(|| invalid("Speech requires a bounded model"))?;
    if body["input"]
        .as_str()
        .is_none_or(|text| text.trim().is_empty() || text.len() > 64 * 1024)
    {
        return Err(invalid("Speech requires bounded nonempty input"));
    }
    // `input` and `instructions` are the speech text the firewall and locked
    // guardrails inspect; a chat conversation belongs on the chat route.
    if body.get("messages").is_some() {
        return Err(invalid(
            "Speech takes its text from input; messages are not accepted",
        ));
    }
    // Only string instructions are inspected, so no other shape may reach a
    // provider.
    if body
        .get("instructions")
        .is_some_and(|instructions| !instructions.is_string() && !instructions.is_null())
    {
        return Err(invalid("Speech instructions must be a string"));
    }
    if body
        .get("stream_format")
        .is_some_and(|format| format.as_str() != Some("audio"))
    {
        return Err(invalid(
            "Speech supports the binary audio stream format only",
        ));
    }
    if body.get("response_format").is_some_and(|format| {
        !matches!(
            format.as_str(),
            Some("mp3" | "wav" | "aac" | "flac" | "opus" | "pcm")
        )
    }) {
        return Err(invalid("Unsupported speech response format"));
    }
    Ok(())
}

pub fn inline_speech(value: &Value) -> Result<(Vec<u8>, String), GatewayError> {
    let entries = value["data"]
        .as_array()
        .filter(|rows| rows.len() == 1)
        .ok_or_else(|| undelivered("Speech output has no single audio payload"))?;
    let encoded = entries[0]["b64_json"]
        .as_str()
        .filter(|text| text.len() <= MAX_SPEECH_BYTES.div_ceil(3) * 4)
        .ok_or_else(|| undelivered("Speech output is missing bounded inline audio"))?;
    let content_type = entries[0]["content_type"].as_str().unwrap_or("").trim();
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        mime.as_str(),
        "audio/mpeg"
            | "audio/wav"
            | "audio/x-wav"
            | "audio/aac"
            | "audio/ogg"
            | "audio/opus"
            | "audio/flac"
            | "audio/pcm"
            | "audio/l16"
            | "audio/mp4"
            | "audio/webm"
    ) || content_type.len() > 200
        || content_type.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(undelivered("Speech output has an unsupported content type"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| undelivered("Speech output has invalid audio encoding"))?;
    if bytes.is_empty() || bytes.len() > MAX_SPEECH_BYTES {
        return Err(undelivered("Speech output exceeds the audio limit"));
    }
    Ok((bytes, content_type.to_owned()))
}

/// Transcription response formats the gateway serves. `text`, `srt`, and
/// `vtt` are projected here from the provider's normalized JSON; `srt`/`vtt`
/// need timestamped segments, so they are requested as `verbose_json`.
const TRANSCRIPTION_FORMATS: &[&str] = &["json", "verbose_json", "text", "srt", "vtt"];

/// Normalize an OpenAI array field name (`timestamp_granularities[]`) to its
/// base name; the SDKs send the bracketed spelling, curl users often omit it.
fn transcription_field_name(raw: &str) -> &str {
    match raw {
        "timestamp_granularities[]" => "timestamp_granularities",
        "include[]" => "include",
        other => other,
    }
}

pub async fn transcription_body(mut multipart: Multipart) -> Result<(Value, String), GatewayError> {
    let mut body = serde_json::Map::new();
    let mut seen = std::collections::HashSet::new();
    let mut format = "json".to_owned();
    let mut granularities: Vec<String> = Vec::new();
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|_| invalid("Invalid audio multipart upload"))?
    {
        let name = transcription_field_name(
            field
                .name()
                .ok_or_else(|| invalid("Audio multipart field has no name"))?,
        )
        .to_owned();
        // Array fields repeat; every other field may appear once.
        let repeatable = matches!(name.as_str(), "timestamp_granularities" | "include");
        if !matches!(
            name.as_str(),
            "file"
                | "model"
                | "language"
                | "prompt"
                | "response_format"
                | "temperature"
                | "timestamp_granularities"
                | "include"
                | "stream"
        ) || (!seen.insert(name.clone()) && !repeatable)
        {
            return Err(invalid("Unsupported or duplicate audio multipart field"));
        }
        let filename = if name == "file" {
            let filename = field
                .file_name()
                .ok_or_else(|| invalid("Audio file needs a filename"))?;
            if filename.is_empty()
                || filename.len() > 200
                || filename
                    .chars()
                    .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
            {
                return Err(invalid("Audio filename must be a bounded leaf name"));
            }
            let extension = filename
                .rsplit('.')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            if !matches!(
                extension.as_str(),
                "wav" | "mp3" | "mpga" | "mpeg" | "mp4" | "m4a" | "ogg" | "oga" | "webm" | "flac"
            ) {
                return Err(invalid("Unsupported audio filename extension"));
            }
            Some(filename.to_owned())
        } else {
            if field.file_name().is_some() {
                return Err(invalid("Only file may contain an upload"));
            }
            None
        };
        let limit = if filename.is_some() {
            MAX_AUDIO_UPLOAD_BYTES
        } else if name == "prompt" {
            4096
        } else {
            256
        };
        let mut bytes = Vec::new();
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|_| invalid("Invalid audio multipart upload"))?
        {
            if chunk.len() > limit.saturating_sub(bytes.len()) {
                return Err(invalid("Audio multipart field exceeds its limit"));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err(invalid("Audio multipart fields must not be empty"));
        }
        if let Some(filename) = filename {
            body.insert("filename".into(), Value::String(filename));
            body.insert(
                "file".into(),
                Value::String(base64::engine::general_purpose::STANDARD.encode(bytes)),
            );
            continue;
        }
        let text =
            String::from_utf8(bytes).map_err(|_| invalid("Audio text field must be UTF-8"))?;
        let value = match name.as_str() {
            "temperature" => {
                let value: f64 = text
                    .parse()
                    .map_err(|_| invalid("Audio temperature must be between zero and one"))?;
                if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                    return Err(invalid("Audio temperature must be between zero and one"));
                }
                json!(value)
            }
            "response_format" => {
                if !TRANSCRIPTION_FORMATS.contains(&text.as_str()) {
                    return Err(invalid(
                        "Supported transcription formats are json, verbose_json, text, srt, and vtt",
                    ));
                }
                format = text.clone();
                // Text is projected from normalized JSON; subtitles are rendered
                // from the provider's own segment timings, never invented ones.
                Value::String(match text.as_str() {
                    "text" => "json".to_owned(),
                    "srt" | "vtt" => "verbose_json".to_owned(),
                    _ => text,
                })
            }
            "timestamp_granularities" => {
                if !matches!(text.as_str(), "word" | "segment") {
                    return Err(invalid(
                        "timestamp_granularities[] values must be word or segment",
                    ));
                }
                if granularities.contains(&text) {
                    return Err(invalid("Duplicate timestamp_granularities[] value"));
                }
                granularities.push(text);
                continue;
            }
            "stream" => {
                match text.as_str() {
                    // Non-streaming is what this endpoint does anyway.
                    "false" => continue,
                    "true" => return Err(invalid(
                        "Streaming transcription is not supported; omit stream or set it to false",
                    )),
                    _ => return Err(invalid("stream must be true or false")),
                }
            }
            "include" => {
                return Err(invalid(if text == "logprobs" {
                    "include[]=logprobs is not supported; transcription log probabilities are not available through the gateway"
                } else {
                    "Unsupported include[] value"
                }))
            }
            "language" => {
                if text.len() > 32
                    || !text
                        .bytes()
                        .all(|byte| byte.is_ascii_alphabetic() || byte == b'-')
                {
                    return Err(invalid("Invalid transcription language"));
                }
                Value::String(text)
            }
            _ => Value::String(text),
        };
        body.insert(name, value);
    }
    if !seen.contains("file") || !seen.contains("model") {
        return Err(invalid("Audio transcription requires file and model"));
    }
    if !granularities.is_empty() {
        // OpenAI's contract: timestamps ride on verbose_json only.
        if format != "verbose_json" {
            return Err(invalid(
                "timestamp_granularities[] requires response_format verbose_json",
            ));
        }
        body.insert("timestamp_granularities".into(), json!(granularities));
    }
    body.entry("response_format")
        .or_insert_with(|| json!("json"));
    Ok((Value::Object(body), format))
}

/// The caption cues of a normalized transcription: `(start_s, end_s, text)`.
/// Uses the provider's own `segments[]` timings only (subtitles are never
/// fabricated from untimed text).
fn subtitle_cues(response: &Value) -> Vec<(f64, f64, String)> {
    let Some(segments) = response.get("segments").and_then(Value::as_array) else {
        return Vec::new();
    };
    segments
        .iter()
        .filter_map(|segment| {
            let start = segment.get("start")?.as_f64()?;
            let end = segment.get("end")?.as_f64()?;
            let text = segment.get("text")?.as_str()?.trim();
            (start.is_finite()
                && end.is_finite()
                && start >= 0.0
                && end >= start
                && !text.is_empty())
            .then(|| (start, end, text.to_owned()))
        })
        .collect()
}

fn subtitle_timestamp(seconds: f64, fraction_separator: char) -> String {
    let millis = (seconds * 1000.0).round() as u64;
    format!(
        "{:02}:{:02}:{:02}{fraction_separator}{:03}",
        millis / 3_600_000,
        (millis / 60_000) % 60,
        (millis / 1000) % 60,
        millis % 1000
    )
}

/// Render a normalized transcription as SubRip (`srt`) or WebVTT (`vtt`).
/// Errors when the provider returned no timestamped segments for non-empty
/// speech, since cue timings cannot be produced honestly.
pub fn render_subtitles(response: &Value, format: &str) -> Result<String, GatewayError> {
    let has_text = response["text"]
        .as_str()
        .is_some_and(|text| !text.trim().is_empty());
    let cues = subtitle_cues(response);
    // Silence legitimately yields an empty subtitle file; speech without
    // timings does not.
    if cues.is_empty() && has_text {
        return Err(GatewayError::ProviderDeliveryUncertain(format!(
            "The routed transcription provider returned no timestamped segments, so {format} cannot be produced; use json or text"
        )));
    }
    let srt = format == "srt";
    let fraction_separator = if srt { ',' } else { '.' };
    let mut out = String::new();
    if format == "vtt" {
        out.push_str("WEBVTT\n\n");
    }
    for (index, (start, end, text)) in cues.iter().enumerate() {
        // SubRip numbers its cues; WebVTT cue identifiers are optional.
        if srt {
            out.push_str(&format!("{}\n", index + 1));
        }
        out.push_str(&format!(
            "{} --> {}\n{text}\n\n",
            subtitle_timestamp(*start, fraction_separator),
            subtitle_timestamp(*end, fraction_separator)
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn speech_requests_carry_text_only_in_inspected_fields() {
        let speech = json!({"model":"tts-1","input":"hello","instructions":"warmly"});
        assert!(validate_speech_request(&speech).is_ok());
        let mut chat = speech.clone();
        chat["messages"] = json!([{"role":"user","content":"uninspected"}]);
        assert!(matches!(
            validate_speech_request(&chat),
            Err(GatewayError::BadRequest(_))
        ));
        assert!(validate_speech_request(&json!({"model":"tts-1","input":["hello"]})).is_err());
        let mut structured = speech.clone();
        structured["instructions"] = json!([{"role":"system","content":"uninspected"}]);
        assert!(matches!(
            validate_speech_request(&structured),
            Err(GatewayError::BadRequest(_))
        ));
    }
    #[test]
    fn inline_speech_preserves_bytes_and_mime_and_rejects_malformed_payloads() {
        let audio = json!({"data":[{"b64_json":"AQID","content_type":"audio/mpeg"}]});
        assert_eq!(
            inline_speech(&audio).unwrap(),
            (vec![1, 2, 3], "audio/mpeg".to_owned())
        );
        for value in [
            json!({"data":[]}),
            json!({"data":[{"b64_json":"***","content_type":"audio/wav"}]}),
            json!({"data":[{"b64_json":"AQID","content_type":"text/html"}]}),
            json!({"data":[{"url":"https://vendor.invalid/audio"}]}),
        ] {
            assert!(inline_speech(&value).is_err());
        }
    }
    type ProviderFuture<'a, T> = std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<T, ryu_gw_providers::ProviderError>>
                + Send
                + 'a,
        >,
    >;
    struct Fixture(std::sync::Arc<std::sync::Mutex<Vec<Value>>>);
    impl ryu_gw_providers::Provider for Fixture {
        fn name(&self) -> &'static str {
            "openai"
        }
        fn complete<'a>(&'a self, _: &'a str, _: &'a Value) -> ProviderFuture<'a, Value> {
            Box::pin(async { unreachable!() })
        }
        fn complete_stream<'a>(
            &'a self,
            _: &'a str,
            _: &'a Value,
        ) -> ProviderFuture<'a, axum::body::Body> {
            Box::pin(async { unreachable!() })
        }
        fn synthesize_speech<'a>(
            &'a self,
            _: &'a str,
            body: &'a Value,
        ) -> ProviderFuture<'a, Value> {
            Box::pin(async move {
                self.0.lock().unwrap().push(body.clone());
                Ok(
                    json!({"object":"audio","data":[{"b64_json":"AQID","content_type":"audio/mpeg"}]}),
                )
            })
        }
        fn transcribe_audio<'a>(
            &'a self,
            _: &'a str,
            body: &'a Value,
        ) -> ProviderFuture<'a, Value> {
            Box::pin(async move {
                self.0.lock().unwrap().push(body.clone());
                Ok(
                    json!({"text":"spoken words","segments":[{"start":0.0,"end":1.0,"text":"spoken words"}]}),
                )
            })
        }
    }
    /// Serve both audio routes over real HTTP, with `Fixture` recording into
    /// `requests` as the only provider. Returns the base URL and server task.
    async fn serve_audio(
        requests: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        use axum::{routing::post, Router};
        use std::sync::Arc;
        let mut config = crate::config::GatewayConfig::default();
        config.auth = serde_json::from_value(
            json!({"require_auth":true,"api_keys":[{"key":"audio-client","name":"client"}]}),
        )
        .unwrap();
        config.firewall.enabled = false;
        config.routing.default_provider = crate::config::ProviderId::from("openai");
        config.routing.fallback_chain = vec![];
        let mut state = crate::state::AppState::new_for_test(
            config,
            crate::audit::AuditLogger::new(&crate::config::AuditConfig {
                enabled: false,
                db_path: String::new(),
            })
            .unwrap(),
            crate::evals::EvalsRunner::new(Default::default()),
        );
        state
            .provider_runtime
            .register_for_test(Arc::new(Fixture(requests)));
        let app = Router::new()
            .route(
                "/v1/audio/speech",
                post(super::super::multimodal::audio_speech),
            )
            .route(
                "/v1/audio/transcriptions",
                post(super::super::multimodal::audio_transcriptions).layer(
                    axum::extract::DefaultBodyLimit::max(MAX_AUDIO_MULTIPART_BYTES),
                ),
            )
            .with_state(Arc::new(state));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (base, server)
    }
    #[tokio::test]
    async fn actual_http_audio_returns_binary_and_accepts_strict_standard_multipart() {
        use std::sync::{Arc, Mutex};
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (base, server) = serve_audio(Arc::clone(&requests)).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let response = client
            .post(format!("{base}/v1/audio/speech"))
            .bearer_auth("audio-client")
            .json(&json!({"model":"tts-1","input":"Hello","voice":"alloy"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "audio/mpeg");
        assert_eq!(response.headers()["x-provider"], "openai");
        assert!(response.headers().contains_key("x-request-id"));
        assert_eq!(response.bytes().await.unwrap().as_ref(), &[1, 2, 3]);
        for format in ["json", "verbose_json", "text"] {
            let form = reqwest::multipart::Form::new()
                .part(
                    "file",
                    reqwest::multipart::Part::bytes(vec![1, 2, 3]).file_name("voice.wav"),
                )
                .text("model", "whisper-1")
                .text("response_format", format)
                .text("temperature", "0.5");
            let response = client
                .post(format!("{base}/v1/audio/transcriptions"))
                .bearer_auth("audio-client")
                .multipart(form)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::OK);
            assert_eq!(response.headers()["x-provider"], "openai");
            if format == "text" {
                assert_eq!(response.text().await.unwrap(), "spoken words");
            } else {
                assert_eq!(
                    response.json::<Value>().await.unwrap()["text"],
                    "spoken words"
                );
            }
        }
        let unauthorized = reqwest::multipart::Form::new()
            .text("unsupported_field", "must not be parsed without auth");
        let response = client
            .post(format!("{base}/v1/audio/transcriptions"))
            .multipart(unauthorized)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
        let recorded = requests.lock().unwrap().clone();
        assert_eq!(recorded.len(), 4);
        assert_eq!(recorded[1]["file"], "AQID");
        assert_eq!(recorded[1]["filename"], "voice.wav");
        assert_eq!(recorded[1]["temperature"], 0.5);
        assert_eq!(recorded[3]["response_format"], "json");
        for (name, value) in [
            ("response_format", "xml"),
            ("temperature", "NaN"),
            ("unknown", "secret"),
            ("model", "duplicate"),
        ] {
            let form = reqwest::multipart::Form::new()
                .part(
                    "file",
                    reqwest::multipart::Part::bytes(vec![1, 2, 3]).file_name("voice.wav"),
                )
                .text("model", "whisper-1")
                .text(name, value);
            let response = client
                .post(format!("{base}/v1/audio/transcriptions"))
                .bearer_auth("audio-client")
                .multipart(form)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
        }
        let response = client
            .post(format!("{base}/v1/audio/speech"))
            .bearer_auth("audio-client")
            .json(&json!({"model":"tts-1","input":"Hello","stream_format":"sse"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
        let response = client
            .post(format!("{base}/v1/audio/transcriptions"))
            .bearer_auth("audio-client")
            .json(&json!({"model":"whisper-1","file":"AQID"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
        assert_eq!(requests.lock().unwrap().len(), 4);
        server.abort();
    }

    #[test]
    fn subtitles_render_from_provider_segments_only() {
        let response = json!({"text":"hi there. bye","segments":[
            {"start":0.0,"end":1.5,"text":" hi there."},
            {"start":61.25,"end":3725.0,"text":"bye"}
        ]});
        assert_eq!(
            render_subtitles(&response, "srt").unwrap(),
            "1\n00:00:00,000 --> 00:00:01,500\nhi there.\n\n2\n00:01:01,250 --> 01:02:05,000\nbye\n\n"
        );
        assert_eq!(
            render_subtitles(&response, "vtt").unwrap(),
            "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nhi there.\n\n00:01:01.250 --> 01:02:05.000\nbye\n\n"
        );
        // Silence is an empty file; speech without timings is an error, never
        // a fabricated cue.
        assert_eq!(
            render_subtitles(&json!({"text":""}), "vtt").unwrap(),
            "WEBVTT\n\n"
        );
        assert!(render_subtitles(&json!({"text":"untimed"}), "srt").is_err());
    }

    #[tokio::test]
    async fn transcription_supports_timestamps_and_subtitles_and_rejects_stream_clearly() {
        use std::sync::{Arc, Mutex};
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (base, server) = serve_audio(Arc::clone(&requests)).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let send = |fields: Vec<(&'static str, &'static str)>| {
            let mut form = reqwest::multipart::Form::new()
                .part(
                    "file",
                    reqwest::multipart::Part::bytes(vec![1, 2, 3]).file_name("voice.wav"),
                )
                .text("model", "whisper-1");
            for (name, value) in fields {
                form = form.text(name, value);
            }
            client
                .post(format!("{base}/v1/audio/transcriptions"))
                .bearer_auth("audio-client")
                .multipart(form)
                .send()
        };

        // OpenAI SDK word timestamps: verbose_json + repeated granularities.
        let response = send(vec![
            ("response_format", "verbose_json"),
            ("timestamp_granularities[]", "word"),
            ("timestamp_granularities[]", "segment"),
            ("stream", "false"),
        ])
        .await
        .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(
            response.json::<Value>().await.unwrap()["segments"][0]["end"],
            1.0
        );
        let forwarded = requests.lock().unwrap().last().cloned().unwrap();
        assert_eq!(forwarded["response_format"], "verbose_json");
        assert_eq!(
            forwarded["timestamp_granularities"],
            json!(["word", "segment"])
        );
        assert!(forwarded.get("stream").is_none());

        for (format, content_type, body) in [
            (
                "srt",
                "application/x-subrip",
                "1\n00:00:00,000 --> 00:00:01,000\nspoken words\n\n",
            ),
            (
                "vtt",
                "text/vtt",
                "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nspoken words\n\n",
            ),
        ] {
            let response = send(vec![("response_format", format)]).await.unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::OK);
            assert!(response.headers()["content-type"]
                .to_str()
                .unwrap()
                .starts_with(content_type));
            assert_eq!(response.text().await.unwrap(), body);
            let forwarded = requests.lock().unwrap().last().cloned().unwrap();
            assert_eq!(forwarded["response_format"], "verbose_json");
        }

        let forwarded_before = requests.lock().unwrap().len();
        for (fields, message) in [
            (
                vec![("stream", "true")],
                "Streaming transcription is not supported",
            ),
            (
                vec![("include[]", "logprobs")],
                "include[]=logprobs is not supported",
            ),
            (
                vec![("timestamp_granularities[]", "word")],
                "requires response_format verbose_json",
            ),
            (
                vec![
                    ("response_format", "verbose_json"),
                    ("timestamp_granularities[]", "sentence"),
                ],
                "must be word or segment",
            ),
        ] {
            let response = send(fields).await.unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
            let error = response.json::<Value>().await.unwrap();
            assert_eq!(error["error"]["type"], "invalid_request_error", "{error}");
            assert!(
                error["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains(message),
                "{error}"
            );
        }
        assert_eq!(requests.lock().unwrap().len(), forwarded_before);
        server.abort();
    }
}
