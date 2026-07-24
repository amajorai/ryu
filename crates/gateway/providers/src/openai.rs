use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use serde_json::Value;
use tracing::debug;

use crate::{error::ProviderError, quota::ProviderQuotas};

use super::{
    audio_speech_url, audio_transcriptions_url, chat_completions_url, check_response_status,
    check_stream_status, discover_openai_models, images_url, models_from_response, send_with_retry,
    Provider,
};

pub struct OpenAiProvider {
    client: reqwest::Client,
    /// Account rotation set (#4). One or more API keys; the chat paths rotate on
    /// a 429 before surfacing [`ProviderError::RateLimited`] to the tier
    /// fallback. Never empty (see `OpenAiProviderConfig::all_keys`).
    keys: Vec<String>,
    cursor: AtomicUsize,
    base_url: String,
    quota: Arc<ProviderQuotas>,
}

impl OpenAiProvider {
    pub fn new(
        client: reqwest::Client,
        keys: Vec<String>,
        base_url: String,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self {
            client,
            keys,
            cursor: AtomicUsize::new(0),
            base_url,
            quota,
        }
    }

    /// The next account key in round-robin order. Single-key providers always
    /// return the one key.
    fn next_key(&self) -> String {
        let n = self.keys.len();
        if n <= 1 {
            return self.keys.first().cloned().unwrap_or_default();
        }
        let i = self.cursor.fetch_add(1, Ordering::Relaxed) % n;
        self.keys[i].clone()
    }

    /// The primary account key, used for non-rotating calls (model discovery,
    /// media generation).
    fn primary_key(&self) -> &str {
        self.keys.first().map(String::as_str).unwrap_or("")
    }
}

impl Provider for OpenAiProvider {
    fn name(&self) -> &'static str {
        "openai"
    }

    fn discover_models<'a>(
        &'a self,
    ) -> Pin<Box<dyn std::future::Future<Output = Option<Vec<Value>>> + Send + 'a>> {
        Box::pin(async move {
            let json =
                discover_openai_models(&self.client, &self.base_url, self.primary_key()).await?;
            models_from_response(json)
        })
    }

    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            debug!(provider = "openai", model, "sending non-streaming request");

            let url = chat_completions_url(&self.base_url);
            // Account rotation (#4): try each key; on a 429 rotate to the next
            // before surfacing the rate-limit to the cost-tier fallback.
            let attempts = self.keys.len().max(1);
            let mut last_err: Option<ProviderError> = None;
            for _ in 0..attempts {
                let key = self.next_key();
                let resp = send_with_retry(
                    || {
                        let req = self.client.post(&url).bearer_auth(&key).json(&payload);
                        Box::pin(async move { req.send().await })
                    },
                    "openai",
                    3,
                )
                .await?;

                match check_response_status(resp, "openai", Some(&self.quota)).await {
                    Err(e @ ProviderError::RateLimited { .. }) if attempts > 1 => {
                        last_err = Some(e);
                        continue;
                    }
                    other => return other,
                }
            }
            Err(last_err.unwrap_or_else(|| ProviderError::RateLimited {
                provider: "openai".to_string(),
                retry_after: None,
                reset_at: None,
            }))
        })
    }

    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            payload["stream"] = Value::Bool(true);
            debug!(provider = "openai", model, "sending streaming request");

            let url = chat_completions_url(&self.base_url);
            let attempts = self.keys.len().max(1);
            let mut last_err: Option<ProviderError> = None;
            for _ in 0..attempts {
                let key = self.next_key();
                let resp = send_with_retry(
                    || {
                        let req = self.client.post(&url).bearer_auth(&key).json(&payload);
                        Box::pin(async move { req.send().await })
                    },
                    "openai",
                    3,
                )
                .await?;

                match check_stream_status(resp, "openai", Some(&self.quota)).await {
                    Err(e @ ProviderError::RateLimited { .. }) if attempts > 1 => {
                        last_err = Some(e);
                        continue;
                    }
                    Err(e) => return Err(e),
                    Ok(resp) => return Ok(Body::from_stream(resp.bytes_stream())),
                }
            }
            Err(last_err.unwrap_or_else(|| ProviderError::RateLimited {
                provider: "openai".to_string(),
                retry_after: None,
                reset_at: None,
            }))
        })
    }

    fn generate_image<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            debug!(
                provider = "openai",
                model, "sending image generation request"
            );

            let url = images_url(&self.base_url);
            let resp = send_with_retry(
                || {
                    let req = self
                        .client
                        .post(&url)
                        .bearer_auth(self.primary_key())
                        .json(&payload);
                    Box::pin(async move { req.send().await })
                },
                "openai",
                2,
            )
            .await?;

            check_response_status(resp, "openai", None).await
        })
    }

    fn synthesize_speech<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            debug!(provider = "openai", model, "sending TTS request");

            let url = audio_speech_url(&self.base_url);
            let resp = send_with_retry(
                || {
                    let req = self
                        .client
                        .post(&url)
                        .bearer_auth(self.primary_key())
                        .json(&payload);
                    Box::pin(async move { req.send().await })
                },
                "openai",
                2,
            )
            .await?;

            check_response_status(resp, "openai", None).await
        })
    }

    fn transcribe_audio<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            use base64::Engine as _;

            // Core carries the audio to the Gateway as base64 inside a JSON body
            // (it holds no multipart), but real Groq/OpenAI `/audio/transcriptions`
            // (Whisper STT) require `multipart/form-data`. Re-multipart here.
            let audio_b64 = body.get("file").and_then(Value::as_str).ok_or_else(|| {
                ProviderError::Provider("STT request missing base64 `file` field".to_string())
            })?;
            let audio_bytes = base64::engine::general_purpose::STANDARD
                .decode(audio_b64.trim())
                .map_err(|e| {
                    ProviderError::Provider(format!("STT `file` is not valid base64: {e}"))
                })?;

            let filename = body
                .get("filename")
                .and_then(Value::as_str)
                .unwrap_or("audio.wav")
                .to_string();
            let content_type = audio_content_type(&filename).to_string();

            // Text parts to forward alongside the file. `model` is the routed model
            // (never the caller's), and we preserve whatever the caller set for the
            // optional Whisper params — including `response_format: verbose_json`,
            // which is how the caller opts into timestamped segments.
            let mut text_parts: Vec<(String, String)> =
                vec![("model".to_string(), model.to_string())];
            for key in ["language", "response_format", "temperature", "prompt"] {
                if let Some(val) = body.get(key) {
                    if let Some(s) = value_to_form_string(val) {
                        text_parts.push((key.to_string(), s));
                    }
                }
            }

            debug!(provider = "openai", model, "sending STT multipart request");

            let url = audio_transcriptions_url(&self.base_url);
            let resp = send_with_retry(
                || {
                    let mut form = reqwest::multipart::Form::new().part(
                        "file",
                        reqwest::multipart::Part::bytes(audio_bytes.clone())
                            .file_name(filename.clone())
                            .mime_str(&content_type)
                            .unwrap_or_else(|_| {
                                reqwest::multipart::Part::bytes(audio_bytes.clone())
                                    .file_name(filename.clone())
                            }),
                    );
                    for (key, val) in &text_parts {
                        form = form.text(key.clone(), val.clone());
                    }
                    let req = self
                        .client
                        .post(&url)
                        .bearer_auth(self.primary_key())
                        .multipart(form);
                    Box::pin(async move { req.send().await })
                },
                "openai",
                2,
            )
            .await?;

            check_response_status(resp, "openai", None).await
        })
    }
}

/// Guess an audio MIME type from a filename extension so the STT provider parses
/// the uploaded `file` part correctly. Defaults to `application/octet-stream`.
fn audio_content_type(filename: &str) -> &'static str {
    match filename
        .rsplit('.')
        .next()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        Some("m4a" | "mp4") => "audio/mp4",
        Some("ogg" | "oga") => "audio/ogg",
        Some("webm") => "audio/webm",
        Some("flac") => "audio/flac",
        Some("aac") => "audio/aac",
        Some("mpga") => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

/// Render a JSON value as a `multipart/form-data` text field. Strings pass
/// through as-is; numbers/bools are stringified; other shapes are skipped.
fn value_to_form_string(val: &Value) -> Option<String> {
    match val {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockResponse, MockServer};
    use base64::Engine as _;
    use serde_json::json;

    fn provider_with(base_url: String, keys: Vec<&str>) -> OpenAiProvider {
        OpenAiProvider::new(
            reqwest::Client::new(),
            keys.into_iter().map(String::from).collect(),
            base_url,
            Arc::new(ProviderQuotas::new()),
        )
    }

    #[test]
    fn audio_content_type_maps_known_extensions() {
        assert_eq!(audio_content_type("a.wav"), "audio/wav");
        assert_eq!(audio_content_type("a.mp3"), "audio/mpeg");
        assert_eq!(audio_content_type("a.MPGA"), "audio/mpeg");
        assert_eq!(audio_content_type("clip.m4a"), "audio/mp4");
        assert_eq!(audio_content_type("clip.MP4"), "audio/mp4");
        assert_eq!(audio_content_type("v.ogg"), "audio/ogg");
        assert_eq!(audio_content_type("v.webm"), "audio/webm");
        assert_eq!(audio_content_type("v.flac"), "audio/flac");
        assert_eq!(audio_content_type("v.aac"), "audio/aac");
        // Unknown / no extension → octet-stream.
        assert_eq!(audio_content_type("noext"), "application/octet-stream");
        assert_eq!(audio_content_type("a.xyz"), "application/octet-stream");
    }

    #[test]
    fn value_to_form_string_stringifies_scalars_only() {
        assert_eq!(value_to_form_string(&json!("hi")), Some("hi".to_string()));
        assert_eq!(value_to_form_string(&json!(3)), Some("3".to_string()));
        assert_eq!(value_to_form_string(&json!(0.5)), Some("0.5".to_string()));
        assert_eq!(value_to_form_string(&json!(true)), Some("true".to_string()));
        assert_eq!(value_to_form_string(&json!(["a"])), None);
        assert_eq!(value_to_form_string(&json!({ "k": 1 })), None);
        assert_eq!(value_to_form_string(&json!(null)), None);
    }

    #[test]
    fn next_key_rotates_and_primary_is_first() {
        let p = provider_with("http://x".into(), vec!["a", "b"]);
        assert_eq!(p.primary_key(), "a");
        assert_eq!(p.next_key(), "a");
        assert_eq!(p.next_key(), "b");
        assert_eq!(p.next_key(), "a");
    }

    #[test]
    fn primary_key_empty_when_no_keys() {
        let p = provider_with("http://x".into(), vec![]);
        assert_eq!(p.primary_key(), "");
        // next_key falls back to empty string rather than panicking on an empty set.
        assert_eq!(p.next_key(), "");
    }

    #[tokio::test]
    async fn complete_sends_bearer_and_injects_model() {
        let server =
            MockServer::always(MockResponse::ok_json(r#"{"id":"cmpl","choices":[]}"#)).await;
        let p = provider_with(server.base_url().to_string(), vec!["sk-abc"]);
        let body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
        let out = p.complete("gpt-4o", &body).await.unwrap();
        assert_eq!(out["id"], json!("cmpl"));

        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/chat/completions");
        assert_eq!(
            reqs[0].header("authorization").as_deref(),
            Some("Bearer sk-abc")
        );
        // The routed model overrides whatever the caller sent.
        assert_eq!(reqs[0].json()["model"], json!("gpt-4o"));
    }

    #[tokio::test]
    async fn complete_error_does_not_leak_key() {
        const SECRET: &str = "sk-openai-LEAKME-999";
        let server = MockServer::always(MockResponse::json(
            401,
            r#"{"error":{"message":"bad key"}}"#,
        ))
        .await;
        let p = provider_with(server.base_url().to_string(), vec![SECRET]);
        let err = p
            .complete("m", &json!({ "messages": [] }))
            .await
            .unwrap_err();
        let rendered = format!("{err}{err:?}");
        assert!(!rendered.contains(SECRET), "leaked: {rendered}");
        assert!(rendered.contains("bad key"));
    }

    #[tokio::test]
    async fn complete_rotates_on_429_then_succeeds() {
        let server = MockServer::start(vec![
            MockResponse::json(429, "slow"),
            MockResponse::ok_json(r#"{"id":"ok"}"#),
        ])
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["k1", "k2"]);
        let out = p
            .complete("m", &json!({ "messages": [] }))
            .await
            .unwrap();
        assert_eq!(out["id"], json!("ok"));
        let reqs = server.requests();
        assert_eq!(reqs.len(), 2);
        assert_eq!(
            reqs[0].header("authorization").as_deref(),
            Some("Bearer k1")
        );
        assert_eq!(
            reqs[1].header("authorization").as_deref(),
            Some("Bearer k2")
        );
    }

    #[tokio::test]
    async fn generate_image_posts_to_images_endpoint_with_primary_key() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"data":[{"url":"https://x/i.png"}]}"#,
        ))
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["primary", "secondary"]);
        let out = p
            .generate_image("dall-e-3", &json!({ "prompt": "a cat" }))
            .await
            .unwrap();
        assert_eq!(out["data"][0]["url"], json!("https://x/i.png"));
        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/images/generations");
        // Media uses the primary key, never the rotating cursor.
        assert_eq!(
            reqs[0].header("authorization").as_deref(),
            Some("Bearer primary")
        );
        assert_eq!(reqs[0].json()["model"], json!("dall-e-3"));
    }

    #[tokio::test]
    async fn synthesize_speech_posts_to_audio_speech_endpoint() {
        let server = MockServer::always(MockResponse::ok_json(r#"{"ok":true}"#)).await;
        let p = provider_with(server.base_url().to_string(), vec!["k"]);
        let _ = p
            .synthesize_speech("tts-1", &json!({ "input": "hi", "voice": "alloy" }))
            .await
            .unwrap();
        assert_eq!(server.requests()[0].path, "/audio/speech");
    }

    #[tokio::test]
    async fn transcribe_audio_rejects_missing_file() {
        let p = provider_with("http://127.0.0.1:1".to_string(), vec!["k"]);
        let err = p
            .transcribe_audio("whisper-1", &json!({ "model": "whisper-1" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("missing base64 `file`"));
    }

    #[tokio::test]
    async fn transcribe_audio_rejects_invalid_base64() {
        let p = provider_with("http://127.0.0.1:1".to_string(), vec!["k"]);
        let err = p
            .transcribe_audio("whisper-1", &json!({ "file": "!!!not base64!!!" }))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not valid base64"), "{err}");
    }

    #[tokio::test]
    async fn transcribe_audio_sends_multipart_with_decoded_file() {
        let server = MockServer::always(MockResponse::ok_json(r#"{"text":"hello"}"#)).await;
        let p = provider_with(server.base_url().to_string(), vec!["sk-stt"]);
        let audio = base64::engine::general_purpose::STANDARD.encode(b"RIFFfake-wav-bytes");
        let out = p
            .transcribe_audio(
                "whisper-1",
                &json!({ "file": audio, "filename": "clip.wav", "language": "en" }),
            )
            .await
            .unwrap();
        assert_eq!(out["text"], json!("hello"));

        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/audio/transcriptions");
        assert_eq!(
            reqs[0].header("authorization").as_deref(),
            Some("Bearer sk-stt")
        );
        let ct = reqs[0].header("content-type").unwrap_or_default();
        assert!(ct.starts_with("multipart/form-data"), "content-type={ct}");
        // The decoded audio + the routed model + forwarded language ride in the body.
        let raw = String::from_utf8_lossy(&reqs[0].body);
        assert!(raw.contains("RIFFfake-wav-bytes"), "decoded audio missing");
        assert!(raw.contains("whisper-1"));
        assert!(raw.contains("clip.wav"));
    }
}
