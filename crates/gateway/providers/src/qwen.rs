//! Qwen chat/embeddings plus native Qwen-ASR transcription translation.

use std::pin::Pin;
use std::sync::Arc;

use axum::body::Body;
use base64::Engine as _;
use serde_json::{json, Value};

use crate::account_pool::AccountPool;
use crate::egress::send_with_egress;
use crate::openai::audio_content_type;
use crate::{ProviderError, ProviderQuotas};

use super::{
    chat_completions_url, check_service_response, EgressClientPool, OpenAiProvider, Provider,
};

pub struct QwenProvider {
    chat: OpenAiProvider,
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    keys: Vec<String>,
    accounts: Arc<AccountPool>,
    base_url: String,
    quota: Arc<ProviderQuotas>,
}

impl QwenProvider {
    pub fn new(
        client: reqwest::Client,
        egress: Option<Arc<EgressClientPool>>,
        keys: Vec<String>,
        base_url: String,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        let accounts = Arc::new(AccountPool::new(keys.len()));
        let chat = OpenAiProvider::new_named_with_egress(
            "qwen",
            client.clone(),
            egress.clone(),
            keys.clone(),
            base_url.clone(),
            Arc::clone(&quota),
        )
        .with_shared_account_pool(Arc::clone(&accounts));
        Self {
            chat,
            client,
            egress,
            keys,
            accounts,
            base_url,
            quota,
        }
    }

    async fn transcribe(&self, model: &str, body: &Value) -> Result<Value, ProviderError> {
        let payload = transcription_body(model, body)?;
        let url = chat_completions_url(&self.base_url);
        let mut last_limit = None;
        for index in self.accounts.candidates(None) {
            let key = &self.keys[index];
            let response = send_with_egress(
                &self.client,
                self.egress.as_deref(),
                None,
                "qwen",
                0,
                |client| client.post(&url).bearer_auth(key).json(&payload),
            )
            .await?;
            if response.status().is_server_error()
                || response.status() == reqwest::StatusCode::REQUEST_TIMEOUT
            {
                return Err(ProviderError::DeliveryUncertain(
                    "Qwen transcription failed without a definitive rejection".to_owned(),
                ));
            }
            match check_service_response(response, "qwen", Some(&self.quota)).await {
                Ok(upstream) => {
                    let text = upstream
                        .pointer("/choices/0/message/content")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            ProviderError::DeliveryUncertain(
                                "Qwen ASR returned no transcript text".to_owned(),
                            )
                        })?;
                    return Ok(json!({ "text": text, "usage": upstream.get("usage") }));
                }
                Err(ProviderError::RateLimited {
                    retry_after,
                    reset_at,
                    ..
                }) => {
                    self.accounts.record_rate_limit(index, retry_after);
                    last_limit = Some(ProviderError::RateLimited {
                        provider: "qwen".to_owned(),
                        retry_after,
                        reset_at,
                    });
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_limit.unwrap_or_else(|| ProviderError::RateLimited {
            provider: "qwen".to_owned(),
            retry_after: None,
            reset_at: None,
        }))
    }
}

fn transcription_body(model: &str, body: &Value) -> Result<Value, ProviderError> {
    if !model.starts_with("qwen3-asr-flash") || model.contains("filetrans") {
        return Err(ProviderError::Provider(
            "Qwen synchronous STT requires a qwen3-asr-flash model".to_owned(),
        ));
    }
    if body
        .get("response_format")
        .is_some_and(|value| !value.is_null() && value.as_str() != Some("json"))
    {
        return Err(ProviderError::Provider(
            "Qwen STT supports the JSON text response, without timestamped segments".to_owned(),
        ));
    }
    let encoded = body["file"].as_str().ok_or_else(|| {
        ProviderError::Provider("STT request missing base64 `file` field".to_owned())
    })?;
    if encoded.len() > 10_000_000 {
        return Err(ProviderError::Provider(
            "Qwen STT encoded audio exceeds 10 MB".to_owned(),
        ));
    }
    let audio = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|_| ProviderError::Provider("STT `file` is not valid base64".to_owned()))?;
    if audio.is_empty() {
        return Err(ProviderError::Provider(
            "STT audio file is empty".to_owned(),
        ));
    }
    let mime = audio_content_type(body["filename"].as_str().unwrap_or("audio.wav"));
    if mime == "application/octet-stream" {
        return Err(ProviderError::Provider(
            "Qwen STT needs a supported audio filename extension".to_owned(),
        ));
    }
    let data = format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(audio)
    );
    if data.len() > 10_000_000 {
        return Err(ProviderError::Provider(
            "Qwen STT encoded audio exceeds 10 MB".to_owned(),
        ));
    }
    let mut messages = Vec::new();
    if let Some(prompt) = body["prompt"].as_str().filter(|value| !value.is_empty()) {
        messages.push(json!({"role":"system","content":prompt}));
    }
    messages.push(
        json!({"role":"user","content":[{"type":"input_audio","input_audio":{"data":data}}]}),
    );
    let mut options = json!({"enable_itn":false});
    if let Some(language) = body["language"].as_str().filter(|value| !value.is_empty()) {
        options["language"] = json!(language);
    }
    Ok(json!({"model":model,"messages":messages,"stream":false,"asr_options":options}))
}

impl Provider for QwenProvider {
    fn configure_account_strategy(&self, strategy: crate::AccountSelectionStrategy) {
        self.accounts.configure_strategy(strategy);
    }

    fn configure_fill_first_drain_percent(&self, percent: u8) {
        self.accounts.configure_fill_first_drain_percent(percent);
    }

    fn configure_account_policies(&self, policies: &[crate::ProviderAccountPolicy]) {
        self.accounts.configure(policies);
    }

    fn name(&self) -> &'static str {
        "qwen"
    }
    fn has_rotating_accounts(&self) -> bool {
        self.accounts.has_restrictions() || self.chat.has_rotating_accounts()
    }
    fn discover_models<'a>(
        &'a self,
    ) -> Pin<Box<dyn std::future::Future<Output = Option<Vec<Value>>> + Send + 'a>> {
        self.chat.discover_models()
    }
    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        self.chat.complete(model, body)
    }
    fn complete_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        session: Option<&'a str>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        self.chat.complete_for_session(model, body, session)
    }
    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        self.chat.complete_stream(model, body)
    }
    fn complete_stream_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        session: Option<&'a str>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        self.chat.complete_stream_for_session(model, body, session)
    }
    fn embed<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        self.chat.embed(model, body)
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

    fn provider(server: &MockServer) -> QwenProvider {
        QwenProvider::new(
            reqwest::Client::new(),
            None,
            vec!["first".to_owned(), "second".to_owned()],
            server.base_url().to_owned(),
            Arc::new(ProviderQuotas::new()),
        )
    }

    #[tokio::test]
    async fn transcription_uses_chat_audio_and_normalizes_text() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"choices":[{"message":{"content":"hello"}}]}"#,
        ))
        .await;
        let result = provider(&server)
            .transcribe_audio(
                "qwen3-asr-flash",
                &json!({"file":"AQID","filename":"audio.mp3","language":"en","prompt":"names"}),
            )
            .await
            .unwrap();
        assert_eq!(result["text"], "hello");
        let request = &server.requests()[0];
        assert_eq!(request.path, "/chat/completions");
        assert_eq!(request.json()["messages"][0]["role"], "system");
        assert_eq!(
            request.json()["messages"][1]["content"][0]["input_audio"]["data"],
            "data:audio/mpeg;base64,AQID"
        );
        assert_eq!(request.json()["asr_options"]["language"], "en");
        assert_eq!(
            request.header("authorization").as_deref(),
            Some("Bearer first")
        );
    }

    #[tokio::test]
    async fn stt_cooldown_is_shared_with_chat_accounts() {
        let server = MockServer::start(vec![
            MockResponse::json(429, "quota"),
            MockResponse::ok_json(r#"{"choices":[{"message":{"content":"ok"}}]}"#),
        ])
        .await;
        let provider = provider(&server);
        provider
            .transcribe_audio("qwen3-asr-flash", &json!({"file":"AQID"}))
            .await
            .unwrap();
        provider
            .complete_for_session("qwen-plus", &json!({"messages":[]}), Some("session"))
            .await
            .unwrap();
        let requests = server.requests();
        assert_eq!(requests.len(), 3);
        assert_eq!(
            requests[1].header("authorization").as_deref(),
            Some("Bearer second")
        );
        assert_eq!(
            requests[2].header("authorization").as_deref(),
            Some("Bearer second")
        );
    }

    #[tokio::test]
    async fn configured_fill_first_controls_chat_and_shared_asr_pool() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"choices":[{"message":{"content":"ok"}}]}"#,
        ))
        .await;
        let provider = provider(&server);
        provider.configure_account_strategy(crate::AccountSelectionStrategy::FillFirst);
        provider.configure_fill_first_drain_percent(60);
        for session in ["first-session", "second-session"] {
            provider
                .complete_for_session("qwen-plus", &json!({"messages":[]}), Some(session))
                .await
                .unwrap();
        }
        provider
            .transcribe_audio("qwen3-asr-flash", &json!({"file":"AQID"}))
            .await
            .unwrap();
        let requests = server.requests();
        assert_eq!(requests.len(), 3);
        for request in requests {
            assert_eq!(
                request.header("authorization").as_deref(),
                Some("Bearer first")
            );
        }
    }

    #[tokio::test]
    async fn ambiguous_transcription_is_not_replayed_or_rotated() {
        let server = MockServer::always(MockResponse::json(503, "{}")).await;
        let result = provider(&server)
            .transcribe_audio("qwen3-asr-flash", &json!({"file":"AQID"}))
            .await;
        assert!(matches!(result, Err(ProviderError::DeliveryUncertain(_))));
        assert_eq!(server.requests().len(), 1);
    }

    #[test]
    fn invalid_audio_and_async_models_are_rejected() {
        assert!(transcription_body("qwen3-asr-flash", &json!({"file":"bad-base64"})).is_err());
        assert!(transcription_body("qwen3-asr-flash-filetrans", &json!({"file":"AQID"})).is_err());
    }
}
