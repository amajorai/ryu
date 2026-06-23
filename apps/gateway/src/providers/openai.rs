use std::pin::Pin;

use axum::body::Body;
use serde_json::Value;
use tracing::debug;

use crate::error::GatewayError;

use super::{
    audio_speech_url, audio_transcriptions_url, chat_completions_url, check_response_status,
    check_stream_status, images_url, send_with_retry, Provider,
};

pub struct OpenAiProvider {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
}

impl OpenAiProvider {
    pub fn new(client: reqwest::Client, api_key: String, base_url: String) -> Self {
        Self {
            client,
            api_key,
            base_url,
        }
    }
}

impl Provider for OpenAiProvider {
    fn name(&self) -> &'static str {
        "openai"
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
            let resp = send_with_retry(
                || {
                    let req = self
                        .client
                        .post(&url)
                        .bearer_auth(&self.api_key)
                        .json(&payload);
                    Box::pin(async move { req.send().await })
                },
                "openai",
                3,
            )
            .await?;

            check_response_status(resp, "openai").await
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
            let resp = send_with_retry(
                || {
                    let req = self
                        .client
                        .post(&url)
                        .bearer_auth(&self.api_key)
                        .json(&payload);
                    Box::pin(async move { req.send().await })
                },
                "openai",
                3,
            )
            .await?;

            let resp = check_stream_status(resp, "openai").await?;
            Ok(Body::from_stream(resp.bytes_stream()))
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
                        .bearer_auth(&self.api_key)
                        .json(&payload);
                    Box::pin(async move { req.send().await })
                },
                "openai",
                2,
            )
            .await?;

            check_response_status(resp, "openai").await
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
                        .bearer_auth(&self.api_key)
                        .json(&payload);
                    Box::pin(async move { req.send().await })
                },
                "openai",
                2,
            )
            .await?;

            check_response_status(resp, "openai").await
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
                        .bearer_auth(&self.api_key)
                        .json(&payload);
                    Box::pin(async move { req.send().await })
                },
                "openai",
                2,
            )
            .await?;

            check_response_status(resp, "openai").await
        })
    }
}
