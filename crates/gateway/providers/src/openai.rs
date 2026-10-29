use std::pin::Pin;
use std::sync::Arc;

use axum::body::Body;
use serde_json::Value;
use tracing::debug;

use crate::{error::ProviderError, quota::ProviderQuotas};

use super::{
    account_pool::AccountPool, audio_speech_url, audio_transcriptions_url, chat_completions_url,
    check_completion_response, check_service_response, check_stream_status, discover_openai_models,
    egress::send_with_egress, embeddings_url, images_url, is_credential_status,
    models_from_response, parse_account_quota, parse_quota_domain, read_credential_refusal,
    rerank_url, service_audio_response, streaming_request, EgressClientPool, Provider,
};

/// A 402 carries no retry-after; keep the out-of-credit key out of rotation as
/// long as the gateway cools a payment-rejected pool member.
const PAYMENT_REQUIRED_COOLDOWN_SECS: u64 = 300;

/// A definitive pre-acceptance rejection of the account rather than the
/// request: its rate limit (429) or its credit (402). The next key may serve.
fn is_account_rejection(error: &ProviderError) -> bool {
    matches!(
        error,
        ProviderError::RateLimited { .. } | ProviderError::PaymentRequired { .. }
    )
}

/// Remember the most actionable error across accounts: a 402 ("refill or
/// switch provider") is not replaced by a later account's 429.
fn keep_account_error(last: &mut Option<ProviderError>, error: ProviderError) {
    let keep_payment = matches!(last, Some(ProviderError::PaymentRequired { .. }))
        && matches!(error, ProviderError::RateLimited { .. });
    if !keep_payment {
        *last = Some(error);
    }
}

pub struct OpenAiProvider {
    provider_id: &'static str,
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    /// Account rotation set (#4). One or more API keys; every path rotates on a
    /// 429 or 402, and the chat paths also on a refused key (401/403), before
    /// surfacing the error to the tier fallback. Never empty (see
    /// `OpenAiProviderConfig::all_keys`).
    keys: Vec<String>,
    account_pool: Arc<AccountPool>,
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
        Self::new_with_egress(client, None, keys, base_url, quota)
    }

    pub fn new_with_egress(
        client: reqwest::Client,
        egress: Option<Arc<EgressClientPool>>,
        keys: Vec<String>,
        base_url: String,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self::new_named_with_egress("openai", client, egress, keys, base_url, quota)
    }

    pub fn new_named_with_egress(
        provider_id: &'static str,
        client: reqwest::Client,
        egress: Option<Arc<EgressClientPool>>,
        keys: Vec<String>,
        base_url: String,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self {
            provider_id,
            client,
            egress,
            account_pool: Arc::new(AccountPool::new(keys.len())),
            keys,
            base_url,
            quota,
        }
    }

    pub(crate) fn with_shared_account_pool(mut self, pool: Arc<AccountPool>) -> Self {
        self.account_pool = pool;
        self
    }

    /// The next account key in round-robin order. Single-key providers always
    /// return the one key.
    #[cfg(test)]
    fn next_key(&self) -> String {
        self.account_pool
            .candidates(None)
            .first()
            .and_then(|index| self.keys.get(*index))
            .cloned()
            .unwrap_or_default()
    }

    /// The primary account key, used for model discovery.
    #[cfg(test)]
    fn primary_key(&self) -> &str {
        self.keys.first().map(String::as_str).unwrap_or("")
    }

    fn egress_client(
        &self,
        session: Option<&str>,
    ) -> Result<(Option<usize>, &reqwest::Client), ProviderError> {
        if let Some(pool) = &self.egress {
            let (index, client) = pool.candidates(session).into_iter().next().ok_or_else(|| {
                ProviderError::Transport(
                    "all configured egress endpoints are cooling down".to_owned(),
                )
            })?;
            Ok((Some(index), client))
        } else {
            Ok((None, &self.client))
        }
    }

    /// Cool `index` after an [`is_account_rejection`] error. A 402 never cools
    /// the last usable key, so a single key (or the last funded one) keeps
    /// surfacing its real PaymentRequired instead of a synthetic rate limit.
    fn cool_rejected_account(&self, index: usize, error: &ProviderError) {
        match error {
            ProviderError::RateLimited { retry_after, .. } => {
                self.account_pool.record_rate_limit(index, *retry_after);
            }
            _ => self.account_pool.record_account_rejection(
                index,
                std::time::Duration::from_secs(PAYMENT_REQUIRED_COOLDOWN_SECS),
            ),
        }
    }

    fn record_account_headers(&self, index: usize, headers: &reqwest::header::HeaderMap) {
        if let Some(domain) = parse_quota_domain(headers) {
            self.account_pool.record_quota_domain(index, domain);
        }
        if let Some(info) = parse_account_quota(headers) {
            self.account_pool.record_quota(index, &info);
        }
    }

    async fn send_request(
        &self,
        session: Option<&str>,
        max_retries: u32,
        make_request: impl Fn(&reqwest::Client) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, ProviderError> {
        let response = send_with_egress(
            &self.client,
            self.egress.as_deref(),
            session,
            self.provider_id,
            max_retries,
            make_request,
        )
        .await?;
        if max_retries == 0
            && (response.status().is_server_error()
                || response.status() == reqwest::StatusCode::REQUEST_TIMEOUT)
        {
            return Err(ProviderError::DeliveryUncertain(format!(
                "{} service request failed without a definitive rejection",
                self.provider_id
            )));
        }
        Ok(response)
    }
}

impl Provider for OpenAiProvider {
    fn configure_account_policies(&self, policies: &[crate::ProviderAccountPolicy]) {
        self.account_pool.configure(policies);
    }

    fn configure_account_strategy(&self, strategy: crate::AccountSelectionStrategy) {
        self.account_pool.configure_strategy(strategy);
    }

    fn configure_fill_first_drain_percent(&self, percent: u8) {
        self.account_pool
            .configure_fill_first_drain_percent(percent);
    }

    fn name(&self) -> &'static str {
        self.provider_id
    }

    fn has_rotating_accounts(&self) -> bool {
        self.account_pool.has_restrictions()
            || self.keys.len() > 1
            || self.egress.as_ref().is_some_and(|pool| pool.len() > 1)
    }

    fn discover_models<'a>(
        &'a self,
    ) -> Pin<Box<dyn std::future::Future<Output = Option<Vec<Value>>> + Send + 'a>> {
        Box::pin(async move {
            let (_, client) = self.egress_client(None).ok()?;
            let index = self.account_pool.candidates(None).into_iter().next()?;
            let json = discover_openai_models(client, &self.base_url, &self.keys[index]).await?;
            models_from_response(json)
        })
    }

    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        self.complete_for_session(model, body, None)
    }

    fn complete_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        session: Option<&'a str>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            debug!(
                provider = self.provider_id,
                model, "sending non-streaming request"
            );

            let url = chat_completions_url(&self.base_url);
            // Account rotation (#4): try each key; on a 429, 402 or refused key
            // rotate to the next before surfacing the error to the cost-tier
            // fallback.
            let candidates = self.account_pool.candidates(session);
            let mut last_err: Option<ProviderError> = None;
            for index in candidates {
                if !self.account_pool.is_available(index) {
                    continue;
                }
                let key = &self.keys[index];
                let resp = self
                    .send_request(session, 3, |client| {
                        client.post(&url).bearer_auth(key).json(&payload)
                    })
                    .await?;
                if let Some(domain) = parse_quota_domain(resp.headers()) {
                    self.account_pool.record_quota_domain(index, domain);
                }

                let status = resp.status();
                if is_credential_status(status) {
                    let (error, key_refused) =
                        read_credential_refusal(resp, self.provider_id, false).await;
                    if !key_refused {
                        return Err(error);
                    }
                    self.account_pool.record_auth_failure(index);
                    keep_account_error(&mut last_err, error);
                    continue;
                }
                let account_quota = status
                    .is_success()
                    .then(|| parse_account_quota(resp.headers()))
                    .flatten();
                match check_completion_response(resp, self.provider_id, Some(&self.quota)).await {
                    Err(e) => {
                        if is_account_rejection(&e) {
                            self.cool_rejected_account(index, &e);
                        } else {
                            return Err(e);
                        }
                        keep_account_error(&mut last_err, e);
                        continue;
                    }
                    Ok(value) => {
                        if let Some(info) = account_quota.as_ref() {
                            self.account_pool.record_quota(index, info);
                        }
                        self.account_pool.record_success(session, index);
                        return Ok(value);
                    }
                }
            }
            Err(last_err.unwrap_or_else(|| ProviderError::RateLimited {
                provider: self.provider_id.to_string(),
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
        self.complete_stream_for_session(model, body, None)
    }

    fn complete_stream_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        session: Option<&'a str>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            payload["stream"] = Value::Bool(true);
            debug!(
                provider = self.provider_id,
                model, "sending streaming request"
            );

            let url = chat_completions_url(&self.base_url);
            let candidates = self.account_pool.candidates(session);
            let mut last_err: Option<ProviderError> = None;
            for index in candidates {
                if !self.account_pool.is_available(index) {
                    continue;
                }
                let key = &self.keys[index];
                let resp = self
                    .send_request(session, 3, |client| {
                        streaming_request(client.post(&url).bearer_auth(key).json(&payload))
                    })
                    .await?;
                if let Some(domain) = parse_quota_domain(resp.headers()) {
                    self.account_pool.record_quota_domain(index, domain);
                }

                let status = resp.status();
                if is_credential_status(status) {
                    let (error, key_refused) =
                        read_credential_refusal(resp, self.provider_id, true).await;
                    if !key_refused {
                        return Err(error);
                    }
                    self.account_pool.record_auth_failure(index);
                    keep_account_error(&mut last_err, error);
                    continue;
                }
                let account_quota = status
                    .is_success()
                    .then(|| parse_account_quota(resp.headers()))
                    .flatten();
                match check_stream_status(resp, self.provider_id, Some(&self.quota)).await {
                    Err(e) => {
                        if is_account_rejection(&e) {
                            self.cool_rejected_account(index, &e);
                        } else {
                            return Err(e);
                        }
                        keep_account_error(&mut last_err, e);
                        continue;
                    }
                    Ok(resp) => {
                        if let Some(info) = account_quota.as_ref() {
                            self.account_pool.record_quota(index, info);
                        }
                        self.account_pool.record_success(session, index);
                        return Ok(Body::from_stream(resp.bytes_stream()));
                    }
                }
            }
            Err(last_err.unwrap_or_else(|| ProviderError::RateLimited {
                provider: self.provider_id.to_string(),
                retry_after: None,
                reset_at: None,
            }))
        })
    }

    fn embed<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_owned());
            let url = embeddings_url(&self.base_url);
            let candidates = self.account_pool.candidates(None);
            let mut last_err = None;
            for index in candidates {
                if !self.account_pool.is_available(index) {
                    continue;
                }
                let key = &self.keys[index];
                let resp = self
                    .send_request(None, 0, |client| {
                        client.post(&url).bearer_auth(key).json(&payload)
                    })
                    .await?;
                let account_headers = resp.headers().clone();
                match check_service_response(resp, self.provider_id, Some(&self.quota)).await {
                    Err(e) if is_account_rejection(&e) => {
                        self.cool_rejected_account(index, &e);
                        keep_account_error(&mut last_err, e);
                    }
                    result => {
                        if result.is_ok() {
                            self.record_account_headers(index, &account_headers);
                        }
                        return result;
                    }
                }
            }
            Err(last_err.unwrap_or_else(|| ProviderError::RateLimited {
                provider: self.provider_id.to_owned(),
                retry_after: None,
                reset_at: None,
            }))
        })
    }

    fn rerank<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_owned());
            let url = rerank_url(&self.base_url);
            let mut last_limit = None;
            for index in self.account_pool.candidates(None) {
                if !self.account_pool.is_available(index) {
                    continue;
                }
                let key = &self.keys[index];
                let resp = self
                    .send_request(None, 0, |client| {
                        client.post(&url).bearer_auth(key).json(&payload)
                    })
                    .await?;
                let account_headers = resp.headers().clone();
                match check_service_response(resp, self.provider_id, Some(&self.quota)).await {
                    Err(error) if is_account_rejection(&error) => {
                        self.cool_rejected_account(index, &error);
                        keep_account_error(&mut last_limit, error);
                    }
                    result => {
                        if result.is_ok() {
                            self.record_account_headers(index, &account_headers);
                        }
                        return result;
                    }
                }
            }
            Err(last_limit.unwrap_or_else(|| ProviderError::RateLimited {
                provider: self.provider_id.to_owned(),
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
                provider = self.provider_id,
                model, "sending image generation request"
            );

            let url = images_url(&self.base_url);
            let mut last_limit = None;
            for index in self.account_pool.candidates(None) {
                if !self.account_pool.is_available(index) {
                    continue;
                }
                let key = &self.keys[index];
                let resp = self
                    .send_request(None, 0, |client| {
                        client.post(&url).bearer_auth(key).json(&payload)
                    })
                    .await?;
                let account_headers = resp.headers().clone();
                match check_service_response(resp, self.provider_id, Some(&self.quota)).await {
                    Err(error) if is_account_rejection(&error) => {
                        self.cool_rejected_account(index, &error);
                        keep_account_error(&mut last_limit, error);
                    }
                    result => {
                        if result.is_ok() {
                            self.record_account_headers(index, &account_headers);
                        }
                        return result;
                    }
                }
            }
            Err(last_limit.unwrap_or_else(|| ProviderError::RateLimited {
                provider: self.provider_id.to_owned(),
                retry_after: None,
                reset_at: None,
            }))
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
            // `/v1/audio/speech` answers with raw audio bytes, and its default
            // format is mp3. Ask for wav unless the caller chose otherwise, so
            // Core can serve the bytes under its own `audio/wav` content type
            // without transcoding.
            if payload.get("response_format").is_none() {
                payload["response_format"] = Value::String("wav".to_string());
            }
            debug!(provider = self.provider_id, model, "sending TTS request");

            let url = audio_speech_url(&self.base_url);
            let mut last_limit = None;
            for index in self.account_pool.candidates(None) {
                if !self.account_pool.is_available(index) {
                    continue;
                }
                let key = &self.keys[index];
                let resp = self
                    .send_request(None, 0, |client| {
                        client.post(&url).bearer_auth(key).json(&payload)
                    })
                    .await?;
                // This endpoint returns audio bytes rather than JSON.
                let account_headers = resp.headers().clone();
                match service_audio_response(resp, self.provider_id, Some(&self.quota)).await {
                    Err(error) if is_account_rejection(&error) => {
                        self.cool_rejected_account(index, &error);
                        keep_account_error(&mut last_limit, error);
                    }
                    result => {
                        if result.is_ok() {
                            self.record_account_headers(index, &account_headers);
                        }
                        return result;
                    }
                }
            }
            Err(last_limit.unwrap_or_else(|| ProviderError::RateLimited {
                provider: self.provider_id.to_owned(),
                retry_after: None,
                reset_at: None,
            }))
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
            // `timestamp_granularities` (word/segment) is an array field; the
            // multipart wire repeats `timestamp_granularities[]` per value.
            if let Some(values) = body
                .get("timestamp_granularities")
                .and_then(Value::as_array)
            {
                for granularity in values.iter().filter_map(Value::as_str) {
                    text_parts.push((
                        "timestamp_granularities[]".to_string(),
                        granularity.to_string(),
                    ));
                }
            }

            debug!(
                provider = self.provider_id,
                model, "sending STT multipart request"
            );

            let url = audio_transcriptions_url(&self.base_url);
            let mut last_limit = None;
            for index in self.account_pool.candidates(None) {
                if !self.account_pool.is_available(index) {
                    continue;
                }
                let key = &self.keys[index];
                let resp = self
                    .send_request(None, 0, |client| {
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
                        for (field, value) in &text_parts {
                            form = form.text(field.clone(), value.clone());
                        }
                        client.post(&url).bearer_auth(key).multipart(form)
                    })
                    .await?;
                let account_headers = resp.headers().clone();
                match check_service_response(resp, self.provider_id, Some(&self.quota)).await {
                    Err(error) if is_account_rejection(&error) => {
                        self.cool_rejected_account(index, &error);
                        keep_account_error(&mut last_limit, error);
                    }
                    result => {
                        if result.is_ok() {
                            self.record_account_headers(index, &account_headers);
                        }
                        return result;
                    }
                }
            }
            Err(last_limit.unwrap_or_else(|| ProviderError::RateLimited {
                provider: self.provider_id.to_owned(),
                retry_after: None,
                reset_at: None,
            }))
        })
    }
}

/// Guess an audio MIME type from a filename extension so the STT provider parses
/// the uploaded `file` part correctly. Defaults to `application/octet-stream`.
pub(crate) fn audio_content_type(filename: &str) -> &'static str {
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

    #[tokio::test]
    async fn compatible_provider_rate_limit_keeps_its_own_identity() {
        let server = MockServer::always(MockResponse::json(429, r#"{"error":"quota"}"#)).await;
        let provider = OpenAiProvider::new_named_with_egress(
            "mistral",
            reqwest::Client::new(),
            None,
            vec!["test-key".to_owned()],
            server.base_url().to_owned(),
            Arc::new(ProviderQuotas::new()),
        );
        assert_eq!(provider.name(), "mistral");
        let result = provider
            .complete(
                "mistral-small",
                &json!({"messages":[{"role":"user","content":"hi"}]}),
            )
            .await;
        assert!(
            matches!(result, Err(ProviderError::RateLimited { provider, .. }) if provider == "mistral")
        );
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
    async fn compatible_vision_preserves_images_in_buffered_and_streaming_requests() {
        for provider_id in ["mistral", "huggingface"] {
            let stream_reply =
                b"data: {\"choices\":[{\"delta\":{\"content\":\"a fox\"}}]}\n\ndata: [DONE]\n\n";
            let server = MockServer::start(vec![
                MockResponse::ok_json(r#"{"choices":[{"message":{"content":"a fox"}}]}"#),
                MockResponse::ok_bytes("text/event-stream", stream_reply.to_vec()),
            ])
            .await;
            let provider = OpenAiProvider::new_named_with_egress(
                provider_id,
                reqwest::Client::new(),
                None,
                vec!["vision-test-key".to_owned()],
                server.base_url().to_owned(),
                Arc::new(ProviderQuotas::new()),
            );
            let messages = json!([{"role":"user","content":[
                {"type":"text","text":"What is this?"},
                {"type":"image_url","image_url":{"url":"data:image/png;base64,AQID"}},
                {"type":"image_url","image_url":{"url":"https://images.example/fox.jpg"}}
            ]}]);
            let body = json!({"model":"caller-model","messages":messages});
            let answer = provider.complete("vision-model", &body).await.unwrap();
            assert_eq!(answer["choices"][0]["message"]["content"], "a fox");
            let stream = provider
                .complete_stream("vision-model", &body)
                .await
                .unwrap();
            assert_eq!(
                axum::body::to_bytes(stream, 65536).await.unwrap().as_ref(),
                stream_reply
            );
            let requests = server.requests();
            assert_eq!(requests.len(), 2);
            for request in requests {
                assert_eq!(request.path, "/chat/completions");
                assert_eq!(
                    request.header("authorization").as_deref(),
                    Some("Bearer vision-test-key")
                );
                assert_eq!(request.json()["messages"], messages);
                assert_eq!(request.json()["model"], "vision-model");
            }
        }
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
    async fn chat_accounts_rotate_between_sessions_but_stay_pinned_within_one() {
        let server = MockServer::always(MockResponse::ok_json(r#"{"choices":[]}"#)).await;
        let provider = provider_with(server.base_url().to_owned(), vec!["key-a", "key-b"]);
        let body = json!({ "messages": [] });
        provider
            .complete_for_session("m", &body, Some("session-a"))
            .await
            .unwrap();
        provider
            .complete_for_session("m", &body, Some("session-a"))
            .await
            .unwrap();
        provider
            .complete_for_session("m", &body, Some("session-b"))
            .await
            .unwrap();
        let keys: Vec<Option<String>> = server
            .requests()
            .iter()
            .map(|request| request.header("authorization"))
            .collect();
        assert_eq!(
            keys,
            vec![
                Some("Bearer key-a".to_owned()),
                Some("Bearer key-a".to_owned()),
                Some("Bearer key-b".to_owned())
            ]
        );
    }

    #[tokio::test]
    async fn quota_failure_rebinds_the_session_to_the_next_account() {
        let server = MockServer::start(vec![
            MockResponse::json(429, r#"{"error":{"message":"quota"}}"#),
            MockResponse::ok_json(r#"{"choices":[]}"#),
            MockResponse::ok_json(r#"{"choices":[]}"#),
        ])
        .await;
        let provider = provider_with(server.base_url().to_owned(), vec!["key-a", "key-b"]);
        let body = json!({ "messages": [] });
        provider
            .complete_for_session("m", &body, Some("session-a"))
            .await
            .unwrap();
        provider
            .complete_for_session("m", &body, Some("session-a"))
            .await
            .unwrap();
        let keys: Vec<Option<String>> = server
            .requests()
            .iter()
            .map(|request| request.header("authorization"))
            .collect();
        assert_eq!(
            keys,
            vec![
                Some("Bearer key-a".to_owned()),
                Some("Bearer key-b".to_owned()),
                Some("Bearer key-b".to_owned())
            ]
        );
    }

    #[tokio::test]
    async fn chat_quota_headers_are_attributed_to_the_key_that_answered() {
        let server = MockServer::start(vec![
            MockResponse::ok_json(r#"{"choices":[]}"#)
                .with_header("x-ratelimit-remaining-requests", "20")
                .with_header("x-ratelimit-limit-requests", "100"),
            MockResponse::ok_json(r#"{"choices":[]}"#)
                .with_header("x-ratelimit-remaining-requests", "90")
                .with_header("x-ratelimit-limit-requests", "100"),
        ])
        .await;
        let provider = provider_with(server.base_url().to_owned(), vec!["key-a", "key-b"]);
        let body = json!({ "messages": [] });
        provider
            .complete_for_session("m", &body, Some("first"))
            .await
            .unwrap();
        provider
            .complete_for_session("m", &body, Some("second"))
            .await
            .unwrap();
        assert_eq!(
            provider.account_pool.candidates_with_strategy(
                None,
                super::super::account_pool::AccountSelectionStrategy::QuotaFirst,
            )[0],
            1,
        );
    }

    #[tokio::test]
    async fn shared_organization_limit_does_not_retry_a_sibling_key() {
        let server = MockServer::start(vec![
            MockResponse::ok_json(r#"{"choices":[]}"#)
                .with_header("openai-organization", "org-shared"),
            MockResponse::ok_json(r#"{"choices":[]}"#)
                .with_header("openai-organization", "org-shared"),
            MockResponse::json(429, r#"{"error":{"message":"limit"}}"#)
                .with_header("openai-organization", "org-shared"),
        ])
        .await;
        let provider = provider_with(server.base_url().to_owned(), vec!["key-a", "key-b"]);
        let body = json!({ "messages": [] });
        provider
            .complete_for_session("m", &body, Some("first"))
            .await
            .unwrap();
        provider
            .complete_for_session("m", &body, Some("second"))
            .await
            .unwrap();
        assert!(matches!(
            provider
                .complete_for_session("m", &body, Some("first"))
                .await,
            Err(ProviderError::RateLimited { .. })
        ));
        assert_eq!(server.requests().len(), 3);
        assert!(provider.account_pool.candidates(None).is_empty());
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
    async fn embed_forwards_dimensions_and_routed_model() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"data":[{"embedding":[0.1,0.2]}]}"#,
        ))
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["sk-embed"]);
        p.embed(
            "text-embedding-3-small",
            &json!({ "input": "hello", "dimensions": 2 }),
        )
        .await
        .unwrap();

        let request = &server.requests()[0];
        assert_eq!(request.path, "/embeddings");
        assert_eq!(
            request.header("authorization").as_deref(),
            Some("Bearer sk-embed")
        );
        assert_eq!(request.json()["model"], json!("text-embedding-3-small"));
        assert_eq!(request.json()["dimensions"], json!(2));
    }

    #[tokio::test]
    async fn direct_embedding_aliases_preserve_native_models_options_and_key_rotation() {
        for (provider_id, model, options) in [
            (
                "voyage",
                "voyage-3-large",
                json!({"input_type":"query", "truncation":false}),
            ),
            (
                "jina",
                "jina-embeddings-v3",
                json!({"task":"retrieval.query", "dimensions":256}),
            ),
            (
                "openai",
                "text-embedding-3-small",
                json!({"dimensions":256}),
            ),
            (
                "mistral",
                "mistral-embed",
                json!({"encoding_format":"float"}),
            ),
            (
                "nvidia",
                "nvidia/nv-embedqa-e5-v5",
                json!({"input_type":"query", "truncate":"NONE"}),
            ),
            (
                "together",
                "BAAI/bge-large-en-v1.5",
                json!({"encoding_format":"float"}),
            ),
            (
                "fireworks",
                "nomic-ai/nomic-embed-text-v1.5",
                json!({"dimensions":256}),
            ),
        ] {
            let server = MockServer::start(vec![
                MockResponse::json(429, r#"{"error":{"message":"quota"}}"#)
                    .with_header("retry-after", "60"),
                MockResponse::ok_json(
                    r#"{"data":[{"index":0,"embedding":[0.1,0.2]}],"usage":{"total_tokens":2}}"#,
                ),
            ])
            .await;
            let provider = OpenAiProvider::new_named_with_egress(
                provider_id,
                reqwest::Client::new(),
                None,
                vec!["first".to_owned(), "second".to_owned()],
                format!("{}/v1", server.base_url()),
                Arc::new(ProviderQuotas::new()),
            );
            let mut body = options.clone();
            body["model"] = json!("caller-alias");
            body["input"] = json!(["query", "document"]);
            let result = provider.embed(model, &body).await.unwrap();
            assert_eq!(result["data"][0]["embedding"], json!([0.1, 0.2]));
            assert_eq!(result["usage"]["total_tokens"], 2);
            let requests = server.requests();
            assert_eq!(requests.len(), 2, "{provider_id}");
            for (index, request) in requests.iter().enumerate() {
                assert_eq!(request.path, "/v1/embeddings", "{provider_id}");
                assert_eq!(request.json()["model"], model, "{provider_id}");
                assert_eq!(request.json()["input"], json!(["query", "document"]));
                for (option, value) in options.as_object().unwrap() {
                    assert_eq!(&request.json()[option], value, "{provider_id}: {option}");
                }
                let key = if index == 0 {
                    "Bearer first"
                } else {
                    "Bearer second"
                };
                assert_eq!(request.header("authorization").as_deref(), Some(key));
            }
        }
    }

    #[tokio::test]
    async fn embedding_usage_drains_new_chat_sessions_without_moving_existing_session() {
        let reply = |domain: &str, remaining: &str| {
            MockResponse::ok_json(
                r#"{"data":[{"embedding":[0.1]}],"choices":[{"message":{"content":"ok"}}]}"#,
            )
            .with_header("openai-organization", domain)
            .with_header("x-ratelimit-remaining-tokens", remaining)
            .with_header("x-ratelimit-limit-tokens", "100")
            .with_header("x-ratelimit-reset-tokens", "60s")
        };
        let server = MockServer::start(vec![
            reply("org-first", "80"),
            reply("org-second", "80"),
            reply("org-first", "20"),
            reply("org-second", "80"),
            reply("org-first", "20"),
        ])
        .await;
        let provider = provider_with(server.base_url().to_owned(), vec!["first", "second"]);
        // Establish independent fresh headroom observations on the wire. An
        // unobserved account is not evidence that moving work improves quota.
        provider
            .complete_for_session("gpt-test", &json!({"messages":[]}), Some("existing"))
            .await
            .unwrap();
        provider
            .complete_for_session("gpt-test", &json!({"messages":[]}), Some("second-existing"))
            .await
            .unwrap();
        provider.configure_account_strategy(crate::AccountSelectionStrategy::FillFirst);
        provider.configure_fill_first_drain_percent(70);
        provider
            .embed("text-embedding-3-small", &json!({"input":"hello"}))
            .await
            .unwrap();
        provider
            .complete_for_session("gpt-test", &json!({"messages":[]}), Some("new"))
            .await
            .unwrap();
        provider
            .complete_for_session("gpt-test", &json!({"messages":[]}), Some("existing"))
            .await
            .unwrap();
        let requests = server.requests();
        assert_eq!(requests.len(), 5);
        assert_eq!(
            requests[2].header("authorization").as_deref(),
            Some("Bearer first")
        );
        assert_eq!(
            requests[3].header("authorization").as_deref(),
            Some("Bearer second")
        );
        assert_eq!(
            requests[4].header("authorization").as_deref(),
            Some("Bearer first")
        );
    }

    #[tokio::test]
    async fn rerank_forwards_documents_and_routed_model() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"results":[{"index":0,"relevance_score":0.9}]}"#,
        ))
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["sk-rerank"]);
        p.rerank(
            "bge-reranker",
            &json!({ "query": "hello", "documents": ["hello world"] }),
        )
        .await
        .unwrap();

        let request = &server.requests()[0];
        assert_eq!(request.path, "/rerank");
        assert_eq!(
            request.header("authorization").as_deref(),
            Some("Bearer sk-rerank")
        );
        assert_eq!(request.json()["model"], json!("bge-reranker"));
        assert_eq!(request.json()["documents"][0], json!("hello world"));
    }

    #[tokio::test]
    async fn complete_rotates_on_429_then_succeeds() {
        let server = MockServer::start(vec![
            MockResponse::json(429, "slow"),
            MockResponse::ok_json(r#"{"id":"ok"}"#),
        ])
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["k1", "k2"]);
        let out = p.complete("m", &json!({ "messages": [] })).await.unwrap();
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
    async fn chat_and_embed_rotate_past_an_out_of_credit_key_and_cool_it() {
        let server = MockServer::start(vec![
            MockResponse::json(402, r#"{"error":{"message":"no credit"}}"#),
            MockResponse::ok_json(r#"{"id":"ok"}"#),
            MockResponse::ok_json(r#"{"id":"ok"}"#),
        ])
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["empty", "funded"]);
        let out = p.complete("m", &json!({ "messages": [] })).await.unwrap();
        assert_eq!(out["id"], json!("ok"));
        assert!(!p.account_pool.is_available(0));
        p.embed("e", &json!({ "input": "hi" })).await.unwrap();
        let keys: Vec<_> = server
            .requests()
            .iter()
            .map(|request| request.header("authorization").unwrap())
            .collect();
        assert_eq!(keys, ["Bearer empty", "Bearer funded", "Bearer funded"]);

        let server = MockServer::start(vec![
            MockResponse::ok_json(r#"{"data":[]}"#),
            MockResponse::json(402, r#"{"error":{"message":"no credit"}}"#),
            MockResponse::ok_json(r#"{"data":[]}"#),
        ])
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["funded", "empty"]);
        p.embed("e", &json!({ "input": "hi" })).await.unwrap();
        p.embed("e", &json!({ "input": "hi" })).await.unwrap();
        assert_eq!(server.requests().len(), 3);
        assert!(!p.account_pool.is_available(1));
    }

    #[tokio::test]
    async fn an_out_of_credit_last_key_keeps_surfacing_payment_required() {
        let server = MockServer::always(MockResponse::json(
            402,
            r#"{"error":{"message":"no credit"}}"#,
        ))
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["only"]);
        for _ in 0..2 {
            let error = p
                .complete("m", &json!({ "messages": [] }))
                .await
                .unwrap_err();
            assert!(
                matches!(error, ProviderError::PaymentRequired { .. }),
                "{error:?}"
            );
        }
        assert_eq!(server.requests().len(), 2);
        assert!(p.account_pool.is_available(0));
    }

    #[tokio::test]
    async fn payment_required_outranks_a_later_keys_rate_limit() {
        let server = MockServer::start(vec![
            MockResponse::json(402, r#"{"error":{"message":"no credit"}}"#),
            MockResponse::json(429, r#"{"error":{"message":"slow down"}}"#),
            MockResponse::json(402, r#"{"error":{"message":"no credit"}}"#),
            MockResponse::json(429, r#"{"error":{"message":"slow down"}}"#),
        ])
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["empty", "busy"]);
        let error = p
            .complete("m", &json!({ "messages": [] }))
            .await
            .unwrap_err();
        assert!(
            matches!(error, ProviderError::PaymentRequired { .. }),
            "{error:?}"
        );
        let p = provider_with(server.base_url().to_string(), vec!["empty", "busy"]);
        let error = p.embed("e", &json!({ "input": "hi" })).await.unwrap_err();
        assert!(
            matches!(error, ProviderError::PaymentRequired { .. }),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn refused_key_moves_the_session_to_a_healthy_key() {
        for (status, stream) in [(401, false), (403, true)] {
            let server = MockServer::start(vec![
                MockResponse::json(
                    status,
                    r#"{"error":{"message":"invalid key","type":"invalid_request_error","code":"invalid_api_key"}}"#,
                ),
                MockResponse::ok_json(r#"{"id":"ok"}"#),
                MockResponse::ok_json(r#"{"id":"ok"}"#),
            ])
            .await;
            let p = provider_with(server.base_url().to_string(), vec!["revoked", "healthy"]);
            let body = json!({ "messages": [] });
            for _ in 0..2 {
                if stream {
                    p.complete_stream_for_session("m", &body, Some("conv"))
                        .await
                        .unwrap();
                } else {
                    p.complete_for_session("m", &body, Some("conv"))
                        .await
                        .unwrap();
                }
            }
            let keys: Vec<_> = server
                .requests()
                .iter()
                .map(|request| request.header("authorization").unwrap())
                .collect();
            assert_eq!(
                keys,
                ["Bearer revoked", "Bearer healthy", "Bearer healthy"],
                "{status}"
            );
        }
    }

    #[tokio::test]
    async fn an_upstream_refusal_neither_rotates_nor_cools_the_account() {
        // A 403 is how an upstream refuses one request's content. It is
        // returned with its status, is not retried on the next key (which
        // would shop the request to another account), and leaves the account
        // available for every other caller. A 401 (or a 403 naming a key
        // problem) refuses the credential instead and does rotate; see
        // `refused_key_moves_the_session_to_a_healthy_key`.
        for status in [403] {
            let server = MockServer::always(MockResponse::json(
                status,
                r#"{"error":{"message":"refused"}}"#,
            ))
            .await;
            let p = provider_with(server.base_url().to_string(), vec!["k1", "k2"]);
            let result = p
                .complete_for_session("m", &json!({ "messages": [] }), Some("s1"))
                .await;
            assert!(
                matches!(result, Err(ProviderError::Rejected { status: carried, .. }) if carried == status),
                "{status}"
            );
            assert_eq!(server.requests().len(), 1, "{status}");
            assert!(p.account_pool.is_available(0), "{status}");
            assert!(p.account_pool.is_available(1), "{status}");
        }
    }

    #[tokio::test]
    async fn a_request_refusal_403_neither_rotates_nor_cools_the_key() {
        let refusal = r#"{"error":{"message":"Country, region, or territory not supported","type":"request_forbidden","code":"unsupported_country_region_territory"}}"#;
        for stream in [false, true] {
            let server = MockServer::start(vec![
                MockResponse::json(403, refusal),
                MockResponse::ok_json(r#"{"id":"ok"}"#),
            ])
            .await;
            let p = provider_with(server.base_url().to_string(), vec!["first", "second"]);
            let body = json!({ "messages": [] });
            let refused = if stream {
                p.complete_stream_for_session("m", &body, Some("conv"))
                    .await
                    .err()
            } else {
                p.complete_for_session("m", &body, Some("conv")).await.err()
            };
            assert!(
                matches!(refused, Some(ProviderError::Rejected { status: 403, .. })),
                "stream={stream}: {refused:?}"
            );
            p.complete_for_session("m", &body, Some("conv"))
                .await
                .unwrap();
            let keys: Vec<_> = server
                .requests()
                .iter()
                .map(|request| request.header("authorization").unwrap())
                .collect();
            assert_eq!(keys, ["Bearer first", "Bearer first"], "stream={stream}");
        }
    }

    #[tokio::test]
    async fn a_safety_refusal_is_typed_and_never_tried_on_the_next_account() {
        let fixture = |raw: &str| {
            let json: Value = serde_json::from_str(raw).expect("fixture is JSON");
            json["body"].to_string()
        };
        let chat = fixture(include_str!(
            "../tests/fixtures/safety/openai_invalid_prompt.json"
        ));
        let image = fixture(include_str!(
            "../tests/fixtures/safety/openai_content_policy_violation.json"
        ));
        for (body, image_call) in [(chat, false), (image, true)] {
            let server = MockServer::always(MockResponse::json(400, &body)).await;
            let p = provider_with(server.base_url().to_string(), vec!["k1", "k2"]);
            let result = if image_call {
                p.generate_image("m", &json!({ "prompt": "RYU_TEST_FIXTURE" }))
                    .await
            } else {
                p.complete_for_session("m", &json!({ "messages": [] }), Some("s1"))
                    .await
            };
            assert!(
                matches!(
                    result,
                    Err(ProviderError::SafetyRefused {
                        status: 400,
                        scope: crate::SafetyScope::Content,
                        ..
                    })
                ),
                "{result:?}"
            );
            assert_eq!(server.requests().len(), 1, "no second account was tried");
            assert!(p.account_pool.is_available(0));
            assert!(p.account_pool.is_available(1));
        }
    }

    #[tokio::test]
    async fn a_refused_only_key_still_surfaces_its_401() {
        let server =
            MockServer::always(MockResponse::json(401, r#"{"error":{"message":"bad"}}"#)).await;
        let p = provider_with(server.base_url().to_string(), vec!["only"]);
        for _ in 0..2 {
            let error = p
                .complete("m", &json!({ "messages": [] }))
                .await
                .unwrap_err();
            assert!(
                matches!(error, ProviderError::Rejected { status: 401, .. }),
                "{error:?}"
            );
        }
        assert_eq!(server.requests().len(), 2);
    }

    #[tokio::test]
    async fn generate_image_posts_to_images_endpoint() {
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
        // The first request in a fresh pool begins with the primary key.
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
    async fn speech_rotates_to_a_second_account_after_rate_limit() {
        let server = MockServer::start(vec![
            MockResponse::json(429, r#"{"error":{"message":"quota"}}"#),
            MockResponse::ok_bytes("audio/wav", vec![1, 2, 3]),
        ])
        .await;
        let provider = provider_with(server.base_url().to_owned(), vec!["first", "second"]);
        let result = provider
            .synthesize_speech("tts-1", &json!({"input":"hello","voice":"alloy"}))
            .await
            .unwrap();
        assert_eq!(result["data"][0]["b64_json"], "AQID");
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].header("authorization").as_deref(),
            Some("Bearer first")
        );
        assert_eq!(
            requests[1].header("authorization").as_deref(),
            Some("Bearer second")
        );
    }

    #[tokio::test]
    async fn ambiguous_service_failures_never_replay_or_rotate_keys() {
        for status in [408, 500, 503] {
            for operation in ["embedding", "rerank", "image", "speech", "transcription"] {
                let server = MockServer::always(MockResponse::json(status, "{}")).await;
                let provider = provider_with(server.base_url().to_owned(), vec!["first", "second"]);
                let result = match operation {
                    "embedding" => {
                        provider
                            .embed("text-embedding-3-small", &json!({"input":"hello"}))
                            .await
                    }
                    "rerank" => {
                        provider
                            .rerank("reranker", &json!({"query":"hello","documents":["world"]}))
                            .await
                    }
                    "image" => {
                        provider
                            .generate_image("gpt-image-1", &json!({"prompt":"hello"}))
                            .await
                    }
                    "speech" => {
                        provider
                            .synthesize_speech("tts-1", &json!({"input":"hello","voice":"alloy"}))
                            .await
                    }
                    "transcription" => {
                        provider
                            .transcribe_audio("whisper-1", &json!({"file":"AQID"}))
                            .await
                    }
                    _ => unreachable!(),
                };
                assert!(
                    matches!(result, Err(ProviderError::DeliveryUncertain(_))),
                    "{operation}: {status}"
                );
                assert_eq!(server.requests().len(), 1, "{operation}: {status}");
            }
        }
    }

    #[tokio::test]
    async fn malformed_accepted_service_response_is_uncertain() {
        let server = MockServer::always(MockResponse::ok_json("not-json")).await;
        let provider = provider_with(server.base_url().to_owned(), vec!["first", "second"]);
        let result = provider
            .generate_image("gpt-image-1", &json!({"prompt":"hello"}))
            .await;
        assert!(matches!(result, Err(ProviderError::DeliveryUncertain(_))));
        assert_eq!(server.requests().len(), 1);
    }

    /// A chat completion that returned 2xx was generated (and billed); a body
    /// that cannot be decoded must not be replayed on a fallback provider, and
    /// a timed-out send must not be retried in place.
    #[tokio::test]
    async fn uncertain_chat_delivery_is_typed_and_never_replayed() {
        let body = json!({"messages":[]});
        let server = MockServer::always(MockResponse::ok_json("not-json")).await;
        let provider = provider_with(server.base_url().to_owned(), vec!["first", "second"]);
        let error = provider.complete("gpt-test", &body).await.unwrap_err();
        assert!(
            matches!(error, ProviderError::DeliveryUncertain(_)),
            "{error:?}"
        );
        assert_eq!(server.requests().len(), 1);

        let (url, seen, stalled) = crate::test_support::stalled_server().await;
        let provider = OpenAiProvider::new(
            // Streams lift the total timeout; the read timeout still fires.
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(200))
                .read_timeout(std::time::Duration::from_millis(200))
                .build()
                .unwrap(),
            vec!["first".to_owned(), "second".to_owned()],
            url,
            Arc::new(ProviderQuotas::new()),
        );
        for (expected, streaming) in [(1, false), (2, true)] {
            let error = if streaming {
                provider
                    .complete_stream("gpt-test", &body)
                    .await
                    .err()
                    .unwrap()
            } else {
                provider.complete("gpt-test", &body).await.unwrap_err()
            };
            assert!(
                matches!(error, ProviderError::DeliveryUncertain(_)),
                "streaming={streaming}: {error:?}"
            );
            assert_eq!(
                seen.load(std::sync::atomic::Ordering::SeqCst),
                expected,
                "streaming={streaming}"
            );
        }
        stalled.abort();
    }

    /// A streamed completion that is still producing tokens must outlive the
    /// client's non-streaming total timeout; the client's read timeout is what
    /// bounds a stalled stream.
    #[tokio::test]
    async fn active_stream_outlives_the_client_total_timeout() {
        use axum::{routing::post, Router};
        async fn sse() -> axum::response::Response {
            let chunks = futures_util::stream::unfold(0_u32, |index| async move {
                if index >= 12 {
                    return None;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                let chunk = bytes::Bytes::from(format!("data: {index}\n\n"));
                Some((Ok::<_, std::io::Error>(chunk), index + 1))
            });
            axum::response::Response::builder()
                .header("content-type", "text/event-stream")
                .body(Body::from_stream(chunks))
                .unwrap()
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, Router::new().fallback(post(sse))).await;
        });
        // 12 chunks x 50 ms runs past the 250 ms total; no gap reaches 200 ms.
        let provider = OpenAiProvider::new(
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(250))
                .read_timeout(std::time::Duration::from_millis(200))
                .build()
                .unwrap(),
            vec!["k".to_owned()],
            url,
            Arc::new(ProviderQuotas::new()),
        );
        let body = provider
            .complete_stream("gpt-test", &json!({"messages":[]}))
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(text.contains("data: 0\n\n"), "{text}");
        assert!(text.contains("data: 11\n\n"), "{text}");
        server.abort();
    }

    #[tokio::test]
    async fn transcription_rotates_to_a_second_account_after_rate_limit() {
        let server = MockServer::start(vec![
            MockResponse::json(429, r#"{"error":{"message":"quota"}}"#),
            MockResponse::ok_json(r#"{"text":"hello"}"#),
        ])
        .await;
        let provider = provider_with(server.base_url().to_owned(), vec!["first", "second"]);
        let result = provider
            .transcribe_audio("whisper-1", &json!({"file":"AQID","filename":"a.wav"}))
            .await
            .unwrap();
        assert_eq!(result["text"], "hello");
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].header("authorization").as_deref(),
            Some("Bearer first")
        );
        assert_eq!(
            requests[1].header("authorization").as_deref(),
            Some("Bearer second")
        );
    }

    // The three tests below cover what the one above structurally cannot: its
    // mock replies `application/json`, so it exercised the JSON pass-through and
    // never the real shape of `/v1/audio/speech`, which is raw audio bytes. That
    // is why "openai response parse error" was invisible to the suite until now.

    #[tokio::test]
    async fn synthesize_speech_wraps_audio_bytes_as_base64_envelope() {
        // Deliberately non-UTF-8, like a real mp3 frame header.
        let audio: Vec<u8> = vec![0xFF, 0xFB, 0x90, 0x00, 0x01, 0x02, 0xFE];
        let server = MockServer::always(MockResponse::ok_bytes("audio/mpeg", audio.clone())).await;
        let p = provider_with(server.base_url().to_string(), vec!["k"]);

        let out = p
            .synthesize_speech("tts-1", &json!({ "input": "hi", "voice": "alloy" }))
            .await
            .unwrap();

        assert_eq!(out["object"], "audio");
        assert_eq!(out["data"][0]["content_type"], "audio/mpeg");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(out["data"][0]["b64_json"].as_str().unwrap())
            .unwrap();
        assert_eq!(decoded, audio);
    }

    #[tokio::test]
    async fn synthesize_speech_defaults_response_format_to_wav() {
        let server = MockServer::always(MockResponse::ok_bytes("audio/wav", vec![1, 2, 3])).await;
        let p = provider_with(server.base_url().to_string(), vec!["k"]);
        let _ = p
            .synthesize_speech("tts-1", &json!({ "input": "hi", "voice": "alloy" }))
            .await
            .unwrap();
        assert_eq!(server.requests()[0].json()["response_format"], "wav");

        // …but never over the caller's own choice.
        let server2 = MockServer::always(MockResponse::ok_bytes("audio/mpeg", vec![1])).await;
        let p2 = provider_with(server2.base_url().to_string(), vec!["k"]);
        let _ = p2
            .synthesize_speech(
                "tts-1",
                &json!({ "input": "hi", "voice": "alloy", "response_format": "opus" }),
            )
            .await
            .unwrap();
        assert_eq!(server2.requests()[0].json()["response_format"], "opus");
    }

    #[tokio::test]
    async fn synthesize_speech_keeps_typed_rate_limit_and_json_errors() {
        // A 429 on the audio endpoint must still be the typed error the circuit
        // breaker and the fallback chain branch on.
        let server = MockServer::always(MockResponse::json(429, r#"{"error":{}}"#)).await;
        let p = provider_with(server.base_url().to_string(), vec!["k"]);
        let err = p
            .synthesize_speech("tts-1", &json!({ "input": "hi" }))
            .await
            .unwrap_err();
        assert!(
            matches!(err, ProviderError::RateLimited { .. }),
            "expected RateLimited, got {err:?}"
        );

        // A 400 JSON error body still surfaces `error.message`.
        let server = MockServer::always(MockResponse::json(
            400,
            r#"{"error":{"message":"'voice' is a required property"}}"#,
        ))
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["k"]);
        let err = p
            .synthesize_speech("tts-1", &json!({ "input": "hi" }))
            .await
            .unwrap_err();
        assert!(
            format!("{err:?}").contains("'voice' is a required property"),
            "error message not surfaced: {err:?}"
        );
    }

    #[tokio::test]
    async fn synthesize_speech_passes_json_replies_through_verbatim() {
        // Some OpenAI-compatible relays answer in JSON; that must not be
        // base64'd as if the JSON text were audio.
        let server = MockServer::always(MockResponse::ok_json(r#"{"audio":"AAAA"}"#)).await;
        let p = provider_with(server.base_url().to_string(), vec!["k"]);
        let out = p
            .synthesize_speech("tts-1", &json!({ "input": "hi" }))
            .await
            .unwrap();
        assert_eq!(out["audio"], "AAAA");
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

    #[tokio::test]
    async fn transcribe_audio_forwards_timestamp_granularities_as_repeated_fields() {
        let server = MockServer::always(MockResponse::ok_json(r#"{"text":"hello"}"#)).await;
        let p = provider_with(server.base_url().to_string(), vec!["sk-stt"]);
        let audio = base64::engine::general_purpose::STANDARD.encode(b"RIFF");
        p.transcribe_audio(
            "whisper-1",
            &json!({
                "file": audio,
                "response_format": "verbose_json",
                "timestamp_granularities": ["word", "segment"],
            }),
        )
        .await
        .unwrap();
        let raw = String::from_utf8_lossy(&server.requests()[0].body).to_string();
        assert_eq!(
            raw.matches("name=\"timestamp_granularities[]\"").count(),
            2,
            "{raw}"
        );
        assert!(raw.contains("verbose_json"));
    }
}
