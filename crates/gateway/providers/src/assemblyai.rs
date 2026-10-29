//! AssemblyAI prerecorded transcription through upload, submit, and poll.

use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};

use crate::account_pool::AccountPool;
use crate::egress::send_with_egress;
use crate::error::ProviderError;
use crate::quota::ProviderQuotas;

use super::{check_response_status, check_service_response, EgressClientPool, Provider};

pub struct AssemblyAiProvider {
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    keys: Vec<String>,
    accounts: AccountPool,
    base_url: String,
    poll_interval: Duration,
    poll_timeout: Duration,
    quota: Arc<ProviderQuotas>,
}

impl AssemblyAiProvider {
    pub fn new_with_egress(
        client: reqwest::Client,
        egress: Option<Arc<EgressClientPool>>,
        keys: Vec<String>,
        base_url: String,
        poll_interval_ms: u64,
        poll_timeout_secs: u64,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self {
            client,
            egress,
            accounts: AccountPool::new(keys.len()),
            keys,
            base_url,
            poll_interval: Duration::from_millis(poll_interval_ms.clamp(250, 60_000)),
            poll_timeout: Duration::from_secs(poll_timeout_secs.clamp(1, 3600)),
            quota,
        }
    }

    fn endpoint(&self, path: &str) -> String {
        format!("{}/v2/{path}", self.base_url.trim_end_matches('/'))
    }

    async fn upload(&self, session: &str, key: &str, audio: &[u8]) -> Result<Value, ProviderError> {
        let url = self.endpoint("upload");
        let response = send_with_egress(
            &self.client,
            self.egress.as_deref(),
            Some(session),
            "assemblyai",
            0,
            |client| {
                client
                    .post(&url)
                    .header("authorization", key)
                    .header("content-type", "application/octet-stream")
                    .body(audio.to_vec())
            },
        )
        .await?;
        check_response_status(response, "assemblyai", Some(&self.quota)).await
    }

    async fn submit(
        &self,
        session: &str,
        key: &str,
        audio_url: &str,
        model: &str,
        body: &Value,
    ) -> Result<Value, ProviderError> {
        let url = self.endpoint("transcript");
        let mut payload = json!({ "audio_url": audio_url, "speech_models": [model] });
        if let Some(language) = body["language"].as_str().filter(|value| !value.is_empty()) {
            payload["language_code"] = json!(language);
        }
        if model.starts_with("universal-3-") {
            if let Some(prompt) = body["prompt"].as_str().filter(|value| !value.is_empty()) {
                payload["prompt"] = json!(prompt);
            }
        }
        let response = send_with_egress(
            &self.client,
            self.egress.as_deref(),
            Some(session),
            "assemblyai",
            0,
            |client| {
                client
                    .post(&url)
                    .header("authorization", key)
                    .json(&payload)
            },
        )
        .await?;
        check_service_response(response, "assemblyai", Some(&self.quota)).await
    }

    async fn poll(&self, session: &str, key: &str, id: &str) -> Result<Value, ProviderError> {
        let url = self.endpoint(&format!("transcript/{id}"));
        let response = send_with_egress(
            &self.client,
            self.egress.as_deref(),
            Some(session),
            "assemblyai",
            0,
            |client| client.get(&url).header("authorization", key),
        )
        .await?;
        check_response_status(response, "assemblyai", Some(&self.quota)).await
    }

    async fn transcribe(&self, model: &str, body: &Value) -> Result<Value, ProviderError> {
        let encoded = body["file"].as_str().ok_or_else(|| {
            ProviderError::Provider("STT request missing base64 `file` field".to_owned())
        })?;
        if encoded.len() > 134_000_000 {
            return Err(ProviderError::Provider("STT file is too large".to_owned()));
        }
        let audio = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|error| {
                ProviderError::Provider(format!("STT `file` is not valid base64: {error}"))
            })?;
        if audio.is_empty() || audio.len() > 100_000_000 {
            return Err(ProviderError::Provider(
                "STT file is empty or too large".to_owned(),
            ));
        }
        if model.is_empty()
            || !model
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(ProviderError::Provider(
                "AssemblyAI speech model ID is invalid".to_owned(),
            ));
        }

        let session = format!("assemblyai:{}", uuid::Uuid::new_v4());
        let mut last_limit = None;
        for index in self.accounts.candidates(Some(&session)) {
            let key = &self.keys[index];
            let upload = match self.upload(&session, key, &audio).await {
                Err(ProviderError::RateLimited {
                    retry_after,
                    reset_at,
                    ..
                }) => {
                    self.accounts.record_rate_limit(index, retry_after);
                    last_limit = Some(ProviderError::RateLimited {
                        provider: "assemblyai".to_owned(),
                        retry_after,
                        reset_at,
                    });
                    continue;
                }
                result => result?,
            };
            let audio_url = upload["upload_url"]
                .as_str()
                .filter(|url| !url.is_empty())
                .ok_or_else(|| {
                    ProviderError::Provider("AssemblyAI upload returned no upload_url".to_owned())
                })?;
            let deadline = Instant::now() + self.poll_timeout;
            let mut transcript = loop {
                match self.submit(&session, key, audio_url, model, body).await {
                    Ok(transcript) => break transcript,
                    Err(ProviderError::RateLimited {
                        retry_after,
                        reset_at,
                        ..
                    }) => {
                        self.accounts.record_rate_limit(index, retry_after);
                        let wait = Duration::from_secs(retry_after.unwrap_or(1).clamp(1, 30));
                        if Instant::now() + wait >= deadline {
                            return Err(ProviderError::RateLimited {
                                provider: "assemblyai".to_owned(),
                                retry_after,
                                reset_at,
                            });
                        }
                        tokio::time::sleep(wait).await;
                    }
                    Err(error) => return Err(error),
                }
            };
            let id = transcript["id"].as_str().ok_or_else(|| {
                ProviderError::DeliveryUncertain(
                    "AssemblyAI submit returned no transcript ID".to_owned(),
                )
            })?;
            uuid::Uuid::parse_str(id).map_err(|_| {
                ProviderError::DeliveryUncertain(
                    "AssemblyAI returned an invalid transcript ID".to_owned(),
                )
            })?;
            let id = id.to_owned();
            loop {
                match transcript["status"].as_str() {
                    Some("completed") => {
                        let text = transcript["text"].as_str().ok_or_else(|| {
                            ProviderError::DeliveryUncertain(
                                "AssemblyAI completed without transcript text".to_owned(),
                            )
                        })?;
                        self.accounts.record_success(Some(&session), index);
                        return Ok(json!({ "text": text }));
                    }
                    Some("error") => {
                        let message = transcript["error"]
                            .as_str()
                            .unwrap_or("transcription failed");
                        return Err(ProviderError::DeliveryUncertain(format!(
                            "AssemblyAI accepted transcription failed: {message}"
                        )));
                    }
                    Some("queued" | "processing") => {}
                    _ => {
                        return Err(ProviderError::DeliveryUncertain(
                            "AssemblyAI returned an unknown transcript status".to_owned(),
                        ));
                    }
                }
                if Instant::now() >= deadline {
                    return Err(ProviderError::DeliveryUncertain(
                        "AssemblyAI transcription timed out".to_owned(),
                    ));
                }
                tokio::time::sleep(self.poll_interval).await;
                match self.poll(&session, key, &id).await {
                    Ok(next) => transcript = next,
                    Err(ProviderError::RateLimited {
                        retry_after,
                        reset_at: _,
                        ..
                    }) => {
                        self.accounts.record_rate_limit(index, retry_after);
                        let wait = Duration::from_secs(retry_after.unwrap_or(1).clamp(1, 30));
                        if Instant::now() + wait >= deadline {
                            return Err(ProviderError::DeliveryUncertain(
                                "AssemblyAI accepted transcription polling remained rate limited"
                                    .to_owned(),
                            ));
                        }
                        tokio::time::sleep(wait).await;
                    }
                    Err(_) => {
                        return Err(ProviderError::DeliveryUncertain(
                            "AssemblyAI accepted transcription could not be polled".to_owned(),
                        ))
                    }
                }
            }
        }
        Err(last_limit.unwrap_or_else(|| {
            ProviderError::Provider("AssemblyAI has no configured API key".to_owned())
        }))
    }
}

impl Provider for AssemblyAiProvider {
    fn configure_account_policies(&self, policies: &[crate::ProviderAccountPolicy]) {
        self.accounts.configure(policies);
    }

    fn name(&self) -> &'static str {
        "assemblyai"
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
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async {
            Err(ProviderError::Provider(
                "AssemblyAI does not provide chat on this route".to_owned(),
            ))
        })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<dyn std::future::Future<Output = Result<axum::body::Body, ProviderError>> + Send + 'a>,
    > {
        Box::pin(async {
            Err(ProviderError::Provider(
                "AssemblyAI does not provide chat streaming on this route".to_owned(),
            ))
        })
    }

    fn transcribe_audio<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(self.transcribe(model, body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockResponse, MockServer};

    fn provider(server: &MockServer, keys: Vec<&str>) -> AssemblyAiProvider {
        AssemblyAiProvider::new_with_egress(
            reqwest::Client::new(),
            None,
            keys.into_iter().map(str::to_owned).collect(),
            server.base_url().to_owned(),
            250,
            2,
            Arc::new(ProviderQuotas::new()),
        )
    }

    #[tokio::test]
    async fn upload_submit_and_poll_keep_one_key_and_return_transcript() {
        let id = "b3a2b12f-0eb1-4d3a-98b5-1f27aa3a39a1";
        let server = MockServer::start(vec![
            MockResponse::ok_json(r#"{"upload_url":"https://cdn.assemblyai.com/audio"}"#),
            MockResponse::ok_json(&format!(r#"{{"id":"{id}","status":"queued"}}"#)),
            MockResponse::ok_json(&format!(
                r#"{{"id":"{id}","status":"completed","text":"hello"}}"#
            )),
        ])
        .await;
        let result = provider(&server, vec!["one-key"])
            .transcribe_audio(
                "universal-3-pro",
                &json!({"file":"AQID","filename":"a.wav","language":"en","prompt":"Fox names"}),
            )
            .await
            .unwrap();
        assert_eq!(result["text"], "hello");
        let requests = server.requests();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].path, "/v2/upload");
        assert_eq!(requests[0].body, vec![1, 2, 3]);
        assert_eq!(requests[1].path, "/v2/transcript");
        assert_eq!(
            requests[1].json()["speech_models"],
            json!(["universal-3-pro"])
        );
        assert_eq!(requests[1].json()["language_code"], "en");
        assert_eq!(requests[1].json()["prompt"], "Fox names");
        assert_eq!(requests[2].path, format!("/v2/transcript/{id}"));
        assert!(requests
            .iter()
            .all(|request| request.header("authorization").as_deref() == Some("one-key")));
    }

    #[tokio::test]
    async fn accepted_transcription_failure_never_creates_another_job() {
        let id = "b3a2b12f-0eb1-4d3a-98b5-1f27aa3a39a1";
        for poll_response in [
            MockResponse::json(503, "{}"),
            MockResponse::json(401, "{}"),
            MockResponse::json(429, "{}").with_header("retry-after", "60"),
            MockResponse::ok_json("not-json"),
            MockResponse::ok_json(&format!(r#"{{"id":"{id}","status":"completed"}}"#)),
        ] {
            let server = MockServer::start(vec![
                MockResponse::ok_json(r#"{"upload_url":"https://cdn.assemblyai.com/audio"}"#),
                MockResponse::ok_json(&format!(r#"{{"id":"{id}","status":"queued"}}"#)),
                poll_response,
            ])
            .await;
            let result = provider(&server, vec!["first", "second"])
                .transcribe_audio("universal-3-pro", &json!({"file":"AQID"}))
                .await;
            assert!(matches!(result, Err(ProviderError::DeliveryUncertain(_))));
            let requests = server.requests();
            assert_eq!(requests.len(), 3);
            assert!(requests
                .iter()
                .all(|request| request.header("authorization").as_deref() == Some("first")));
            assert_eq!(
                requests
                    .iter()
                    .filter(|request| request.path == "/v2/transcript")
                    .count(),
                1
            );
        }
    }

    #[tokio::test]
    async fn rate_limited_upload_rotates_before_a_job_is_created() {
        let id = "b3a2b12f-0eb1-4d3a-98b5-1f27aa3a39a1";
        let server = MockServer::start(vec![
            MockResponse::json(429, r#"{"error":"quota"}"#),
            MockResponse::ok_json(r#"{"upload_url":"https://cdn.assemblyai.com/audio"}"#),
            MockResponse::ok_json(&format!(
                r#"{{"id":"{id}","status":"completed","text":"ok"}}"#
            )),
        ])
        .await;
        let result = provider(&server, vec!["first", "second"])
            .transcribe_audio("universal-2", &json!({"file":"AQID"}))
            .await
            .unwrap();
        assert_eq!(result["text"], "ok");
        let requests = server.requests();
        assert_eq!(requests.len(), 3);
        assert_eq!(
            requests[0].header("authorization").as_deref(),
            Some("first")
        );
        assert_eq!(
            requests[1].header("authorization").as_deref(),
            Some("second")
        );
        assert_eq!(
            requests[2].header("authorization").as_deref(),
            Some("second")
        );
    }

    #[tokio::test]
    async fn missing_audio_never_calls_upstream() {
        let server = MockServer::always(MockResponse::ok_json("{}")).await;
        let result = provider(&server, vec!["one-key"])
            .transcribe_audio("universal-2", &json!({}))
            .await;
        assert!(result.is_err());
        assert_eq!(server.request_count(), 0);
    }

    #[tokio::test]
    async fn upload_and_poll_stay_on_one_egress_proxy() {
        let id = "b3a2b12f-0eb1-4d3a-98b5-1f27aa3a39a1";
        let first = MockServer::start(vec![
            MockResponse::ok_json(r#"{"upload_url":"https://cdn.assemblyai.com/audio"}"#),
            MockResponse::ok_json(&format!(r#"{{"id":"{id}","status":"queued"}}"#)),
            MockResponse::ok_json(&format!(
                r#"{{"id":"{id}","status":"completed","text":"proxied"}}"#
            )),
        ])
        .await;
        let second = MockServer::always(MockResponse::ok_json("{}")).await;
        let clients = [first.base_url(), second.base_url()]
            .into_iter()
            .map(|url| {
                reqwest::Client::builder()
                    .no_proxy()
                    .proxy(reqwest::Proxy::http(url).unwrap())
                    .build()
                    .unwrap()
            })
            .collect();
        let pool = Arc::new(EgressClientPool::new(clients).unwrap());
        let provider = AssemblyAiProvider::new_with_egress(
            reqwest::Client::new(),
            Some(pool),
            vec!["test-key".to_owned()],
            "http://assemblyai.invalid".to_owned(),
            250,
            2,
            Arc::new(ProviderQuotas::new()),
        );
        let result = provider
            .transcribe_audio("universal-2", &json!({"file":"AQID"}))
            .await
            .unwrap();
        assert_eq!(result["text"], "proxied");
        assert_eq!(first.request_count(), 3);
        assert_eq!(second.request_count(), 0);
    }

    #[tokio::test]
    async fn poll_rate_limit_waits_and_uses_the_same_account() {
        let id = "b3a2b12f-0eb1-4d3a-98b5-1f27aa3a39a1";
        let server = MockServer::start(vec![
            MockResponse::ok_json(r#"{"upload_url":"https://cdn.assemblyai.com/audio"}"#),
            MockResponse::ok_json(&format!(r#"{{"id":"{id}","status":"queued"}}"#)),
            MockResponse::json(429, r#"{"error":"slow down"}"#).with_header("retry-after", "0"),
            MockResponse::ok_json(&format!(
                r#"{{"id":"{id}","status":"completed","text":"after wait"}}"#
            )),
        ])
        .await;
        let provider = AssemblyAiProvider::new_with_egress(
            reqwest::Client::new(),
            None,
            vec!["same-key".to_owned()],
            server.base_url().to_owned(),
            250,
            4,
            Arc::new(ProviderQuotas::new()),
        );
        let result = provider
            .transcribe_audio("universal-2", &json!({"file":"AQID"}))
            .await
            .unwrap();
        assert_eq!(result["text"], "after wait");
        assert_eq!(server.request_count(), 4);
        assert!(server
            .requests()
            .iter()
            .all(|request| request.header("authorization").as_deref() == Some("same-key")));
    }

    #[tokio::test]
    async fn submit_rate_limit_retries_without_uploading_again() {
        let id = "b3a2b12f-0eb1-4d3a-98b5-1f27aa3a39a1";
        let server = MockServer::start(vec![
            MockResponse::ok_json(r#"{"upload_url":"https://cdn.assemblyai.com/audio"}"#),
            MockResponse::json(429, r#"{"error":"slow down"}"#).with_header("retry-after", "0"),
            MockResponse::ok_json(&format!(
                r#"{{"id":"{id}","status":"completed","text":"once"}}"#
            )),
        ])
        .await;
        let provider = AssemblyAiProvider::new_with_egress(
            reqwest::Client::new(),
            None,
            vec!["same-key".to_owned()],
            server.base_url().to_owned(),
            250,
            4,
            Arc::new(ProviderQuotas::new()),
        );
        let result = provider
            .transcribe_audio("universal-2", &json!({"file":"AQID"}))
            .await
            .unwrap();
        assert_eq!(result["text"], "once");
        let requests = server.requests();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].path, "/v2/upload");
        assert_eq!(requests[1].path, "/v2/transcript");
        assert_eq!(requests[2].path, "/v2/transcript");
    }
}
