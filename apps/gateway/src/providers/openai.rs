use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use serde_json::Value;
use tracing::debug;

use crate::{error::GatewayError, quota::ProviderQuotas};

use super::{
    audio_speech_url, audio_transcriptions_url, chat_completions_url, check_response_status,
    check_stream_status, discover_openai_models, images_url, models_from_response, send_with_retry,
    Provider,
};

pub struct OpenAiProvider {
    client: reqwest::Client,
    /// Account rotation set (#4). One or more API keys; the chat paths rotate on
    /// a 429 before surfacing [`GatewayError::ProviderRateLimited`] to the tier
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
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, GatewayError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            debug!(provider = "openai", model, "sending non-streaming request");

            let url = chat_completions_url(&self.base_url);
            // Account rotation (#4): try each key; on a 429 rotate to the next
            // before surfacing the rate-limit to the cost-tier fallback.
            let attempts = self.keys.len().max(1);
            let mut last_err: Option<GatewayError> = None;
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
                    Err(e @ GatewayError::ProviderRateLimited { .. }) if attempts > 1 => {
                        last_err = Some(e);
                        continue;
                    }
                    other => return other,
                }
            }
            Err(
                last_err.unwrap_or_else(|| GatewayError::ProviderRateLimited {
                    provider: "openai".to_string(),
                    retry_after: None,
                    reset_at: None,
                }),
            )
        })
    }

    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, GatewayError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            payload["stream"] = Value::Bool(true);
            debug!(provider = "openai", model, "sending streaming request");

            let url = chat_completions_url(&self.base_url);
            let attempts = self.keys.len().max(1);
            let mut last_err: Option<GatewayError> = None;
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
                    Err(e @ GatewayError::ProviderRateLimited { .. }) if attempts > 1 => {
                        last_err = Some(e);
                        continue;
                    }
                    Err(e) => return Err(e),
                    Ok(resp) => return Ok(Body::from_stream(resp.bytes_stream())),
                }
            }
            Err(
                last_err.unwrap_or_else(|| GatewayError::ProviderRateLimited {
                    provider: "openai".to_string(),
                    retry_after: None,
                    reset_at: None,
                }),
            )
        })
    }

    fn generate_image<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, GatewayError>> + Send + 'a>> {
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
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, GatewayError>> + Send + 'a>> {
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
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, GatewayError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            debug!(provider = "openai", model, "sending STT request");

            let url = audio_transcriptions_url(&self.base_url);
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
}
