//! Direct Deepgram speech adapter for the Gateway's OpenAI-shaped audio routes.

use std::{future::Future, pin::Pin, sync::Arc};

use base64::Engine as _;
use serde_json::{json, Value};

use crate::{error::ProviderError, quota::ProviderQuotas};

use super::{
    account_pool::AccountPool, check_service_response, egress::send_with_egress, parse_rate_limit,
    service_audio_response, EgressClientPool, Provider,
};

pub struct DeepgramProvider {
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    keys: Vec<String>,
    accounts: AccountPool,
    base_url: String,
    quota: Arc<ProviderQuotas>,
}

impl DeepgramProvider {
    pub fn new(
        client: reqwest::Client,
        keys: Vec<String>,
        base_url: String,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self::new_with_egress(client, None, keys, base_url, quota)
    }

    pub fn new_with_egress(
        client: reqwest::Client,
        egress: Option<Arc<EgressClientPool>>,
        keys: Vec<String>,
        base_url: String,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self {
            client,
            egress,
            accounts: AccountPool::new(keys.len()),
            keys,
            base_url,
            quota,
        }
    }

    async fn send_request(
        &self,
        make_request: impl Fn(&reqwest::Client) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, ProviderError> {
        let response = send_with_egress(
            &self.client,
            self.egress.as_deref(),
            None,
            "deepgram",
            0,
            make_request,
        )
        .await?;
        if response.status().is_server_error()
            || response.status() == reqwest::StatusCode::REQUEST_TIMEOUT
        {
            return Err(ProviderError::DeliveryUncertain(
                "Deepgram audio request failed without a definitive rejection".to_owned(),
            ));
        }
        Ok(response)
    }

    async fn send_speech(&self, model: &str, body: &Value) -> Result<Value, ProviderError> {
        let text = body
            .get("input")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| {
                ProviderError::Provider("TTS request missing `input` text".to_owned())
            })?;
        let url = format!("{}/v1/speak", self.base_url.trim_end_matches('/'));
        let payload = json!({"text": text});
        let mut last_limit = None;
        for index in self.accounts.candidates(None) {
            let key = &self.keys[index];
            let response = self
                .send_request(|client| {
                    client
                        .post(&url)
                        .header(reqwest::header::AUTHORIZATION, format!("Token {key}"))
                        .query(&[
                            ("model", model),
                            ("encoding", "linear16"),
                            ("container", "wav"),
                        ])
                        .json(&payload)
                })
                .await?;
            if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let rate_limit = parse_rate_limit(response.headers());
                let retry_after = rate_limit.as_ref().and_then(|info| info.retry_after);
                let reset_at = rate_limit.as_ref().and_then(|info| info.reset_at);
                self.accounts.record_rate_limit(index, retry_after);
                self.quota
                    .record_rate_limited("deepgram", retry_after, reset_at);
                last_limit = Some(ProviderError::RateLimited {
                    provider: "deepgram".to_owned(),
                    retry_after,
                    reset_at,
                });
                continue;
            }
            return service_audio_response(response, "deepgram", Some(&self.quota)).await;
        }
        Err(last_limit.unwrap_or_else(|| {
            ProviderError::Provider("Deepgram has no configured key".to_owned())
        }))
    }

    async fn send_transcription(&self, model: &str, body: &Value) -> Result<Value, ProviderError> {
        let encoded = body.get("file").and_then(Value::as_str).ok_or_else(|| {
            ProviderError::Provider("STT request missing base64 `file` field".to_owned())
        })?;
        let audio = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|error| {
                ProviderError::Provider(format!("STT `file` is not valid base64: {error}"))
            })?;
        let url = format!("{}/v1/listen", self.base_url.trim_end_matches('/'));
        let content_type = body
            .get("filename")
            .and_then(Value::as_str)
            .and_then(|name| name.rsplit('.').next())
            .map(|extension| match extension.to_ascii_lowercase().as_str() {
                "wav" => "audio/wav",
                "mp3" | "mpga" => "audio/mpeg",
                "m4a" | "mp4" => "audio/mp4",
                "ogg" | "oga" => "audio/ogg",
                "webm" => "audio/webm",
                "flac" => "audio/flac",
                _ => "application/octet-stream",
            })
            .unwrap_or("application/octet-stream");
        let mut last_limit = None;
        for index in self.accounts.candidates(None) {
            let key = &self.keys[index];
            let response = self
                .send_request(|client| {
                    client
                        .post(&url)
                        .header(reqwest::header::AUTHORIZATION, format!("Token {key}"))
                        .header(reqwest::header::CONTENT_TYPE, content_type)
                        .query(&[("model", model), ("smart_format", "true")])
                        .body(audio.clone())
                })
                .await?;
            if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let rate_limit = parse_rate_limit(response.headers());
                let retry_after = rate_limit.as_ref().and_then(|info| info.retry_after);
                let reset_at = rate_limit.as_ref().and_then(|info| info.reset_at);
                self.accounts.record_rate_limit(index, retry_after);
                self.quota
                    .record_rate_limited("deepgram", retry_after, reset_at);
                last_limit = Some(ProviderError::RateLimited {
                    provider: "deepgram".to_owned(),
                    retry_after,
                    reset_at,
                });
                continue;
            }
            let upstream = check_service_response(response, "deepgram", Some(&self.quota)).await?;
            let transcript = upstream
                .pointer("/results/channels/0/alternatives/0/transcript")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ProviderError::DeliveryUncertain(
                        "Deepgram accepted response has no transcript".to_owned(),
                    )
                })?;
            return Ok(json!({"text": transcript}));
        }
        Err(last_limit.unwrap_or_else(|| {
            ProviderError::Provider("Deepgram has no configured key".to_owned())
        }))
    }
}

impl Provider for DeepgramProvider {
    fn configure_account_policies(&self, policies: &[crate::ProviderAccountPolicy]) {
        self.accounts.configure(policies);
    }

    fn name(&self) -> &'static str {
        "deepgram"
    }
    fn has_rotating_accounts(&self) -> bool {
        self.accounts.has_restrictions()
            || self.keys.len() > 1
            || self.egress.as_ref().is_some_and(|pool| pool.len() > 1)
    }
    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async {
            Err(ProviderError::Provider(
                "Deepgram does not provide chat on this route".to_owned(),
            ))
        })
    }
    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<axum::body::Body, ProviderError>> + Send + 'a>> {
        Box::pin(async {
            Err(ProviderError::Provider(
                "Deepgram does not provide chat streaming on this route".to_owned(),
            ))
        })
    }
    fn synthesize_speech<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(self.send_speech(model, body))
    }
    fn transcribe_audio<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(self.send_transcription(model, body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockResponse, MockServer};

    fn provider(server: &MockServer) -> DeepgramProvider {
        DeepgramProvider::new(
            reqwest::Client::new(),
            vec!["test-secret".to_owned()],
            server.base_url().to_owned(),
            Arc::new(ProviderQuotas::new()),
        )
    }

    #[tokio::test]
    async fn speech_translates_openai_input_to_deepgram_audio() {
        let server =
            MockServer::always(MockResponse::ok_bytes("audio/wav", vec![82, 73, 70, 70])).await;
        let result = provider(&server)
            .synthesize_speech("aura-2-thalia-en", &json!({"input":"Hello"}))
            .await
            .unwrap();
        assert_eq!(result["data"][0]["b64_json"], "UklGRg==");
        let request = &server.requests()[0];
        assert_eq!(request.path, "/v1/speak");
        assert_eq!(
            request.header("authorization").as_deref(),
            Some("Token test-secret")
        );
        assert_eq!(request.json(), json!({"text":"Hello"}));
    }

    #[tokio::test]
    async fn transcription_sends_raw_audio_and_returns_openai_text() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"results":{"channels":[{"alternatives":[{"transcript":"Hello there"}]}]}}"#,
        ))
        .await;
        let result = provider(&server)
            .transcribe_audio("nova-3", &json!({"file":"AQID","filename":"sample.wav"}))
            .await
            .unwrap();
        assert_eq!(result, json!({"text":"Hello there"}));
        let request = &server.requests()[0];
        assert_eq!(request.path, "/v1/listen");
        assert_eq!(request.header("content-type").as_deref(), Some("audio/wav"));
        assert_eq!(request.body, vec![1, 2, 3]);
    }

    #[tokio::test]
    async fn ambiguous_audio_failures_are_not_replayed() {
        for status in [408, 500, 503] {
            for speech in [true, false] {
                let server = MockServer::always(MockResponse::json(status, "{}")).await;
                let provider = provider(&server);
                let result = if speech {
                    provider
                        .synthesize_speech("aura-2-thalia-en", &json!({"input":"Hello"}))
                        .await
                } else {
                    provider
                        .transcribe_audio("nova-3", &json!({"file":"AQID"}))
                        .await
                };
                assert!(matches!(result, Err(ProviderError::DeliveryUncertain(_))));
                assert_eq!(server.requests().len(), 1);
            }
        }
    }
}
