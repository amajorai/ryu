//! Direct ElevenLabs text-to-speech adapter.

use std::{future::Future, pin::Pin, sync::Arc};

use serde_json::{json, Value};

use crate::{error::ProviderError, quota::ProviderQuotas};

use super::{
    account_pool::AccountPool, egress::send_with_egress, parse_rate_limit, service_audio_response,
    EgressClientPool, Provider,
};

pub struct ElevenLabsProvider {
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    keys: Vec<String>,
    accounts: AccountPool,
    base_url: String,
    quota: Arc<ProviderQuotas>,
}

impl ElevenLabsProvider {
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

    async fn speech(&self, model: &str, body: &Value) -> Result<Value, ProviderError> {
        let input = body
            .get("input")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                ProviderError::Provider("TTS request missing `input` text".to_owned())
            })?;
        let voice = body
            .get("voice")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                ProviderError::Provider("ElevenLabs requires a `voice` ID".to_owned())
            })?;
        if !voice
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
        {
            return Err(ProviderError::Provider(
                "ElevenLabs `voice` ID must be alphanumeric".to_owned(),
            ));
        }
        let url = format!(
            "{}/v1/text-to-speech/{voice}",
            self.base_url.trim_end_matches('/')
        );
        let payload = json!({"text": input, "model_id": model});
        let mut last_limit = None;
        for index in self.accounts.candidates(None) {
            let key = &self.keys[index];
            let response = send_with_egress(
                &self.client,
                self.egress.as_deref(),
                None,
                "elevenlabs",
                0,
                |client| {
                    client
                        .post(&url)
                        .header("xi-api-key", key)
                        .query(&[("output_format", "mp3_44100_128")])
                        .json(&payload)
                },
            )
            .await?;
            if response.status().is_server_error()
                || response.status() == reqwest::StatusCode::REQUEST_TIMEOUT
            {
                return Err(ProviderError::DeliveryUncertain(
                    "ElevenLabs synthesis failed without a definitive rejection".to_owned(),
                ));
            }
            if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let rate_limit = parse_rate_limit(response.headers());
                let retry_after = rate_limit.as_ref().and_then(|info| info.retry_after);
                let reset_at = rate_limit.as_ref().and_then(|info| info.reset_at);
                self.accounts.record_rate_limit(index, retry_after);
                self.quota
                    .record_rate_limited("elevenlabs", retry_after, reset_at);
                last_limit = Some(ProviderError::RateLimited {
                    provider: "elevenlabs".to_owned(),
                    retry_after,
                    reset_at,
                });
                continue;
            }
            return service_audio_response(response, "elevenlabs", Some(&self.quota)).await;
        }
        Err(last_limit.unwrap_or_else(|| {
            ProviderError::Provider("ElevenLabs has no configured key".to_owned())
        }))
    }
}

impl Provider for ElevenLabsProvider {
    fn configure_account_policies(&self, policies: &[crate::ProviderAccountPolicy]) {
        self.accounts.configure(policies);
    }

    fn name(&self) -> &'static str {
        "elevenlabs"
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
                "ElevenLabs supports speech on this route".to_owned(),
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
                "ElevenLabs supports speech on this route".to_owned(),
            ))
        })
    }
    fn synthesize_speech<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(self.speech(model, body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockResponse, MockServer};

    #[tokio::test]
    async fn speech_posts_voice_and_model_to_direct_api() {
        let server = MockServer::always(MockResponse::ok_bytes("audio/mpeg", vec![1, 2, 3])).await;
        let provider = ElevenLabsProvider::new(
            reqwest::Client::new(),
            vec!["secret".to_owned()],
            server.base_url().to_owned(),
            Arc::new(ProviderQuotas::new()),
        );
        let response = provider
            .synthesize_speech(
                "eleven_multilingual_v2",
                &json!({"input":"Hello", "voice":"JBFqnCBsd6RMkjVDRZzb"}),
            )
            .await
            .unwrap();
        assert_eq!(response["data"][0]["b64_json"], "AQID");
        let request = &server.requests()[0];
        assert_eq!(request.path, "/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb");
        assert_eq!(request.header("xi-api-key").as_deref(), Some("secret"));
        assert_eq!(
            request.json(),
            json!({"text":"Hello", "model_id":"eleven_multilingual_v2"})
        );
    }

    #[tokio::test]
    async fn ambiguous_synthesis_does_not_replay_or_rotate_accounts() {
        for status in [408, 500, 503] {
            let server = MockServer::always(MockResponse::json(status, "{}")).await;
            let provider = ElevenLabsProvider::new(
                reqwest::Client::new(),
                vec!["first".to_owned(), "second".to_owned()],
                server.base_url().to_owned(),
                Arc::new(ProviderQuotas::new()),
            );
            let result = provider
                .synthesize_speech(
                    "eleven_multilingual_v2",
                    &json!({"input":"Hello", "voice":"JBFqnCBsd6RMkjVDRZzb"}),
                )
                .await;
            assert!(matches!(result, Err(ProviderError::DeliveryUncertain(_))));
            assert_eq!(server.requests().len(), 1);
        }
    }
}
