//! Direct Inworld synchronous TTS, normalized into Gateway's audio envelope.

use std::{future::Future, pin::Pin, sync::Arc};

use base64::Engine as _;
use serde_json::{json, Value};

use super::{egress::send_with_egress, parse_rate_limit, EgressClientPool, Provider};
use crate::{
    account_pool::AccountPool,
    error::{ProviderError, PAYMENT_REQUIRED_COOLDOWN},
    quota::ProviderQuotas,
};

pub struct InworldProvider {
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    keys: Vec<String>,
    accounts: AccountPool,
    base_url: String,
    quota: Arc<ProviderQuotas>,
}

fn uncertain(message: &str) -> ProviderError {
    ProviderError::DeliveryUncertain(format!("Inworld accepted synthesis: {message}"))
}

impl InworldProvider {
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
        let invalid = |message: &str| ProviderError::Provider(format!("inworld: {message}"));
        let input = body["input"]
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| invalid("TTS request requires input text"))?;
        if input.encode_utf16().count() > 2000 {
            return Err(invalid(
                "synchronous TTS input exceeds 2,000 UTF-16 code units",
            ));
        }
        let voice = body["voice"]
            .as_str()
            .filter(|voice| {
                !voice.trim().is_empty()
                    && voice.len() <= 256
                    && !voice.chars().any(char::is_control)
            })
            .ok_or_else(|| invalid("choose an Inworld voice ID"))?;
        if model.is_empty() || model.len() > 256 || model.chars().any(char::is_control) {
            return Err(invalid("choose an Inworld TTS model ID"));
        }
        let (encoding, content_type) = match body.get("response_format") {
            None => ("MP3", "audio/mpeg"),
            Some(Value::String(format)) => match format.as_str() {
                "mp3" => ("MP3", "audio/mpeg"),
                "wav" => ("WAV", "audio/wav"),
                "opus" => ("OGG_OPUS", "audio/ogg"),
                "flac" => ("FLAC", "audio/flac"),
                "pcm" => ("PCM", "audio/pcm"),
                _ => {
                    return Err(invalid(
                        "supported response formats are mp3, wav, opus, flac, and pcm",
                    ))
                }
            },
            Some(_) => return Err(invalid("response_format must be a string")),
        };
        let mut payload = json!({"text":input,"voiceId":voice,"modelId":model,"audioConfig":{"audioEncoding":encoding}});
        if let Some(speed) = body.get("speed") {
            let speed = speed
                .as_f64()
                .filter(|speed| (0.5..=1.5).contains(speed))
                .ok_or_else(|| invalid("speed must be between 0.5 and 1.5"))?;
            payload["audioConfig"]["speakingRate"] = json!(speed);
        }
        if let Some(instructions) = body.get("instructions") {
            payload["instruction"] = instructions
                .as_str()
                .ok_or_else(|| invalid("instructions must be text"))?
                .into();
        }
        let url = format!("{}/tts/v1/voice", self.base_url.trim_end_matches('/'));
        let mut last_error = None;
        for index in self.accounts.candidates(None) {
            let mut response = send_with_egress(
                &self.client,
                self.egress.as_deref(),
                None,
                "inworld",
                0,
                |client| {
                    client
                        .post(&url)
                        .header(
                            reqwest::header::AUTHORIZATION,
                            format!("Basic {}", self.keys[index]),
                        )
                        .json(&payload)
                },
            )
            .await?;
            let status = response.status();
            let limits = parse_rate_limit(response.headers());
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = limits.as_ref().and_then(|limit| limit.retry_after);
                let reset_at = limits.as_ref().and_then(|limit| limit.reset_at);
                self.accounts.record_rate_limit(index, retry_after);
                self.quota
                    .record_rate_limited("inworld", retry_after, reset_at);
                last_error = Some(ProviderError::RateLimited {
                    provider: "inworld".to_owned(),
                    retry_after,
                    reset_at,
                });
                continue;
            }
            if status == reqwest::StatusCode::PAYMENT_REQUIRED {
                self.accounts
                    .record_account_rejection(index, PAYMENT_REQUIRED_COOLDOWN);
                last_error = Some(ProviderError::PaymentRequired {
                    provider: "inworld".to_owned(),
                    message: "Inworld account credits are required".to_owned(),
                });
                continue;
            }
            if status.is_server_error() || status == reqwest::StatusCode::REQUEST_TIMEOUT {
                return Err(uncertain("upstream failed without a definitive rejection"));
            }
            if !status.is_success() {
                return Err(crate::upstream_status_error(
                    status,
                    format!("inworld: TTS upstream returned HTTP {}", status.as_u16()),
                ));
            }
            // Upstream caps decoded audio at 16 MB. Bound the JSON before allocation/decoding.
            const MAX_AUDIO_BYTES: usize = 16 * 1024 * 1024;
            const MAX_JSON_BYTES: usize = MAX_AUDIO_BYTES.div_ceil(3) * 4 + 1024 * 1024;
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| uncertain("could not read audio response"))?
            {
                if chunk.len() > MAX_JSON_BYTES.saturating_sub(bytes.len()) {
                    return Err(uncertain("audio response exceeds the size limit"));
                }
                bytes.extend_from_slice(&chunk);
            }
            let result: Value = serde_json::from_slice(&bytes)
                .map_err(|_| uncertain("audio response is invalid JSON"))?;
            let audio = result["audioContent"]
                .as_str()
                .ok_or_else(|| uncertain("audio response has no audioContent"))?;
            if audio.len() > MAX_AUDIO_BYTES.div_ceil(3) * 4 {
                return Err(uncertain("audio response exceeds the size limit"));
            }
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(audio)
                .map_err(|_| uncertain("audio response contains invalid base64"))?;
            if decoded.is_empty() || decoded.len() > MAX_AUDIO_BYTES {
                return Err(uncertain(
                    "audio response is empty or exceeds the size limit",
                ));
            }
            self.accounts.record_success(None, index);
            if let Some(limits) = limits.as_ref() {
                self.quota.record_success("inworld", limits);
            }
            return Ok(
                json!({"object":"audio","data":[{"b64_json":audio,"content_type":content_type}],"usage":result["usage"],"raw":null}),
            );
        }
        Err(last_error.unwrap_or_else(|| {
            if self.keys.is_empty() {
                invalid("no configured API-key account")
            } else {
                ProviderError::RateLimited {
                    provider: "inworld".to_owned(),
                    retry_after: None,
                    reset_at: None,
                }
            }
        }))
    }
}

impl Provider for InworldProvider {
    fn configure_account_policies(&self, policies: &[crate::ProviderAccountPolicy]) {
        self.accounts.configure(policies);
    }

    fn name(&self) -> &'static str {
        "inworld"
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
                "Inworld supports speech on this route".to_owned(),
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
                "Inworld supports speech on this route".to_owned(),
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

    fn provider(server: &MockServer, keys: Vec<String>) -> InworldProvider {
        InworldProvider::new_with_egress(
            reqwest::Client::new(),
            None,
            keys,
            server.base_url().to_owned(),
            Arc::new(ProviderQuotas::new()),
        )
    }

    #[tokio::test]
    async fn speech_translates_basic_auth_format_speed_and_audio_envelope() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"audioContent":"AQID","usage":{"processedCharactersCount":5}}"#,
        ))
        .await;
        let output = provider(&server, vec!["encoded-portal-key".to_owned()]).synthesize_speech("inworld-tts-2", &json!({"input":"Hello","voice":"Ashley","response_format":"wav","speed":1.2,"instructions":"Speak calmly"})).await.unwrap();
        assert_eq!(
            output["data"][0],
            json!({"b64_json":"AQID","content_type":"audio/wav"})
        );
        assert_eq!(output["usage"]["processedCharactersCount"], 5);
        let requests = server.requests();
        assert_eq!(requests[0].path, "/tts/v1/voice");
        assert_eq!(
            requests[0].header("authorization").as_deref(),
            Some("Basic encoded-portal-key")
        );
        assert_eq!(
            requests[0].json(),
            json!({"text":"Hello","voiceId":"Ashley","modelId":"inworld-tts-2","audioConfig":{"audioEncoding":"WAV","speakingRate":1.2},"instruction":"Speak calmly"})
        );
    }

    #[tokio::test]
    async fn accepted_malformed_audio_and_ambiguous_status_never_rotate() {
        for reply in [
            MockResponse::ok_json("not-json"),
            MockResponse::ok_json(r#"{"audioContent":"bad-base64"}"#),
            MockResponse::json(503, "{}"),
            MockResponse::json(408, "{}"),
        ] {
            let server = MockServer::always(reply).await;
            let result = provider(&server, vec!["first".to_owned(), "second".to_owned()])
                .synthesize_speech("inworld-tts-2", &json!({"input":"Hello","voice":"Ashley"}))
                .await;
            assert!(matches!(result, Err(ProviderError::DeliveryUncertain(_))));
            assert_eq!(server.requests().len(), 1);
        }
    }

    #[tokio::test]
    async fn selected_account_sends_native_basic_credentials_only_through_assigned_proxy() {
        let reply = MockResponse::ok_json(r#"{"audioContent":"AQID"}"#);
        let direct = MockServer::always(reply.clone()).await;
        let proxy = MockServer::always(reply).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(proxy.base_url()).unwrap())
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let provider = InworldProvider::new_with_egress(
            reqwest::Client::new(),
            Some(Arc::new(EgressClientPool::new(vec![client]).unwrap())),
            vec!["disabled".to_owned(), "selected".to_owned()],
            direct.base_url().to_owned(),
            Arc::new(ProviderQuotas::new()),
        );
        provider.configure_account_policies(&[
            crate::ProviderAccountPolicy {
                enabled: false,
                ..Default::default()
            },
            crate::ProviderAccountPolicy::default(),
        ]);
        let output = provider
            .synthesize_speech("inworld-tts-2", &json!({"input":"Hello","voice":"Ashley"}))
            .await
            .unwrap();
        assert_eq!(output["data"][0]["b64_json"], "AQID");
        assert_eq!(direct.requests().len(), 0);
        let requests = proxy.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/tts/v1/voice");
        assert_eq!(
            requests[0].header("authorization").as_deref(),
            Some("Basic selected")
        );
        assert_eq!(requests[0].json()["text"], "Hello");
    }

    #[tokio::test]
    async fn speech_rotates_accounts_after_quota_and_credit_rejection() {
        for status in [429, 402] {
            let server = MockServer::start(vec![
                MockResponse::json(status, "{}").with_header("retry-after", "60"),
                MockResponse::ok_json(r#"{"audioContent":"AQID"}"#),
                MockResponse::ok_json(r#"{"audioContent":"AQID"}"#),
            ])
            .await;
            let adapter = provider(&server, vec!["first".to_owned(), "second".to_owned()]);
            for _ in 0..2 {
                adapter
                    .synthesize_speech("inworld-tts-2", &json!({"input":"Hi","voice":"Ashley"}))
                    .await
                    .unwrap();
            }
            let requests = server.requests();
            assert_eq!(requests.len(), 3);
            assert_eq!(
                requests[0].header("authorization").as_deref(),
                Some("Basic first")
            );
            for request in &requests[1..] {
                assert_eq!(
                    request.header("authorization").as_deref(),
                    Some("Basic second")
                );
            }
        }
    }

    #[tokio::test]
    async fn speech_rejects_utf16_overflow_and_unsupported_options_before_calling() {
        let server = MockServer::always(MockResponse::ok_json("{}")).await;
        let adapter = provider(&server, vec!["key".to_owned()]);
        for body in [
            json!({"input":"🦊".repeat(1001),"voice":"Ashley"}),
            json!({"input":"Hi","voice":"Ashley","response_format":"aac"}),
            json!({"input":"Hi","voice":"Ashley","speed":2}),
            json!({"input":"Hi"}),
        ] {
            assert!(adapter
                .synthesize_speech("inworld-tts-2", &body)
                .await
                .is_err());
        }
        assert!(server.requests().is_empty());
    }

    #[tokio::test]
    async fn speech_rejects_invalid_or_missing_audio_data() {
        for body in [
            r#"{"audioContent":"invalid"}"#,
            r#"{"audioContent":""}"#,
            r#"{}"#,
        ] {
            let server = MockServer::always(MockResponse::ok_json(body)).await;
            assert!(provider(&server, vec!["key".to_owned()])
                .synthesize_speech("inworld-tts-2", &json!({"input":"Hi","voice":"Ashley"}))
                .await
                .is_err());
        }
    }

    #[tokio::test]
    async fn a_single_key_refused_for_credit_serves_again_once_refilled() {
        let server = MockServer::start(vec![
            MockResponse::json(402, "{}"),
            MockResponse::ok_json(r#"{"audioContent":"AQID"}"#),
        ])
        .await;
        let adapter = provider(&server, vec!["only".to_owned()]);
        let body = json!({"input":"Hi","voice":"Ashley"});
        let refused = adapter.synthesize_speech("inworld-tts-2", &body).await;
        assert!(matches!(
            refused,
            Err(ProviderError::PaymentRequired { .. })
        ));
        adapter
            .synthesize_speech("inworld-tts-2", &body)
            .await
            .unwrap();
        assert_eq!(server.requests().len(), 2);
    }
}
