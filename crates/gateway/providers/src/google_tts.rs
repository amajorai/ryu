//! Direct Google Cloud TTS using explicitly supplied expiring OAuth tokens.
//! No ADC, environment lookup, browser OAuth, token minting or refresh.
//! REST: https://docs.cloud.google.com/text-to-speech/docs/reference/rest/v1/text/synthesize
//! Auth: https://docs.cloud.google.com/text-to-speech/docs/authentication
//! Input quota: https://docs.cloud.google.com/text-to-speech/quotas

use std::{fmt, future::Future, pin::Pin, sync::Arc, time::Duration};

use base64::Engine as _;
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    account_pool::AccountPool, egress::send_with_egress_captured, parse_rate_limit,
    EgressClientPool, Provider, ProviderAccountPolicy, ProviderError, ProviderQuotas,
};

const PROVIDER: &str = "google-tts";
const ENDPOINT: &str = "https://texttospeech.googleapis.com/v1/text:synthesize";
const MAX_TEXT_BYTES: usize = 5000;
const MAX_AUDIO_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 12 * 1024 * 1024;
const EXPIRY_MARGIN_SECONDS: u64 = 60;
pub const GOOGLE_TTS_REQUIRED_SCOPE: &str = "https://www.googleapis.com/auth/cloud-platform";

fn invalid(message: &'static str) -> ProviderError {
    ProviderError::Provider(format!("google-tts {message}"))
}

/// Temporary source-local credential type pending coordinated credentials-module wiring.
/// Scope is a documented requirement; an opaque supplied token cannot prove its scope locally.
#[derive(Clone)]
pub struct GoogleTtsAccount {
    access_token: String,
    quota_project: String,
    expires_at_unix_secs: Option<u64>,
    account_id: String,
}

impl fmt::Debug for GoogleTtsAccount {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GoogleTtsAccount")
            .field("access_token", &"[REDACTED]")
            .field("account_id", &self.account_id)
            .field("expires_at_unix_secs", &self.expires_at_unix_secs)
            .finish_non_exhaustive()
    }
}

impl GoogleTtsAccount {
    pub fn supplied_oauth(
        access_token: String,
        quota_project: String,
        expires_at_unix_secs: Option<u64>,
    ) -> Result<Self, ProviderError> {
        // Bearer token syntax: RFC6750 b64token. Never normalize secret bytes.
        if access_token.is_empty()
            || access_token.len() > 8192
            || !access_token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-._~+/=".contains(&byte))
        {
            return Err(invalid("supplied OAuth token is invalid"));
        }
        let quota_project = quota_project.trim().to_owned();
        // Explicit project ID or numeric project number; no caller header injection.
        let project_id = (6..=30).contains(&quota_project.len())
            && quota_project
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_lowercase)
            && quota_project
                .as_bytes()
                .last()
                .is_some_and(u8::is_ascii_alphanumeric)
            && quota_project
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
        let project_number = !quota_project.is_empty()
            && quota_project.len() <= 20
            && quota_project.bytes().all(|byte| byte.is_ascii_digit());
        if !project_id && !project_number {
            return Err(invalid("quota project or token expiry is invalid"));
        }
        let mut digest = Sha256::new();
        digest.update(b"ryu:google-tts:supplied-oauth:v1\0");
        digest.update((access_token.len() as u64).to_be_bytes());
        digest.update(access_token.as_bytes());
        digest.update(quota_project.as_bytes());
        let account_id = format!("{:x}", digest.finalize());
        Ok(Self {
            access_token,
            quota_project,
            expires_at_unix_secs,
            account_id,
        })
    }
    pub fn account_id(&self) -> &str {
        &self.account_id
    }
    pub fn quota_project(&self) -> &str {
        &self.quota_project
    }
    pub fn expires_at_unix_secs(&self) -> Option<u64> {
        self.expires_at_unix_secs
    }
    pub fn expiry_diagnostic(&self, now: u64) -> Option<&'static str> {
        match self.expires_at_unix_secs {
            None => Some("supplied_token_expiry_unknown"),
            Some(_) if !self.eligible_at(now) => Some("supplied_token_expired_or_expiring"),
            Some(_) => None,
        }
    }
    pub fn eligible_at(&self, now: u64) -> bool {
        self.expires_at_unix_secs
            .is_none_or(|expiry| expiry > now.saturating_add(EXPIRY_MARGIN_SECONDS))
    }
}

struct SpeechRequest {
    payload: Value,
    content_type: &'static str,
}

fn valid_language(language: &str) -> bool {
    let mut parts = language.split('-');
    let Some(primary) = parts.next() else {
        return false;
    };
    if !(2..=3).contains(&primary.len()) || !primary.bytes().all(|byte| byte.is_ascii_alphabetic())
    {
        return false;
    }
    let valid_region = parts.next().is_none_or(|region| {
        (region.len() == 2 && region.bytes().all(|byte| byte.is_ascii_alphabetic()))
            || (region.len() == 3 && region.bytes().all(|byte| byte.is_ascii_digit()))
    });
    valid_region && parts.next().is_none()
}

fn speech_request(model: &str, body: &Value) -> Result<SpeechRequest, ProviderError> {
    if !matches!(model, "google-tts" | "google-tts::synthesize") {
        return Err(invalid("model is unsupported"));
    }
    let input = body
        .get("input")
        .and_then(Value::as_str)
        .filter(|text| {
            !text.trim().is_empty() && text.len() <= MAX_TEXT_BYTES && !text.contains('\0')
        })
        .ok_or_else(|| invalid("plain text must contain 1 to 5000 UTF-8 bytes"))?;
    if body.get("ssml").is_some() {
        return Err(invalid("caller SSML is unsupported"));
    }
    let voice = body
        .get("voice")
        .and_then(Value::as_str)
        .filter(|voice| {
            !voice.is_empty()
                && voice.len() <= 128
                && voice
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
        .ok_or_else(|| invalid("native voice name is required"))?;
    let language = body
        .get("language_code")
        .and_then(Value::as_str)
        .filter(|language| valid_language(language))
        .ok_or_else(|| invalid("language_code is invalid"))?;
    // Voice names start with the native language code, followed by a family/name.
    if !voice
        .strip_prefix(language)
        .is_some_and(|rest| rest.starts_with('-') && rest.len() > 1)
    {
        return Err(invalid("voice and language_code do not match"));
    }
    let (encoding, content_type) = match body
        .get("response_format")
        .and_then(Value::as_str)
        .unwrap_or("mp3")
    {
        "mp3" => ("MP3", "audio/mpeg"),
        "wav" => ("LINEAR16", "audio/wav"),
        // Google returns Opus in an Ogg container, never raw PCM or AAC.
        "ogg" | "opus" => ("OGG_OPUS", "audio/ogg"),
        _ => return Err(invalid("response_format is unsupported")),
    };
    let speed = match body.get("speed") {
        None => 1.0,
        Some(value) => value
            .as_f64()
            .filter(|speed| speed.is_finite() && (0.25..=2.0).contains(speed))
            .ok_or_else(|| invalid("speed must be between 0.25 and 2"))?,
    };
    Ok(SpeechRequest {
        payload: json!({"input":{"text":input},
        "voice":{"languageCode":language,"name":voice},
        "audioConfig":{"audioEncoding":encoding,"speakingRate":speed}}),
        content_type,
    })
}

pub struct GoogleTtsProvider {
    rows: Vec<GoogleTtsAccount>,
    accounts: AccountPool,
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    quota: Arc<ProviderQuotas>,
    #[cfg(test)]
    test_endpoint: Option<String>,
    #[cfg(test)]
    test_now: Option<u64>,
}

impl GoogleTtsProvider {
    pub fn new(
        rows: Vec<GoogleTtsAccount>,
        policies: &[ProviderAccountPolicy],
        egress: Option<Arc<EgressClientPool>>,
        quota: Arc<ProviderQuotas>,
    ) -> Result<Self, ProviderError> {
        if rows.is_empty()
            || rows.len() > 32
            || rows.len() != policies.len()
            || rows.iter().enumerate().any(|(index, row)| {
                rows[..index]
                    .iter()
                    .any(|old| old.account_id == row.account_id)
            })
        {
            return Err(invalid("account configuration is invalid"));
        }
        let accounts = AccountPool::new(rows.len());
        accounts.configure(policies);
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|_| invalid("HTTP client initialization failed"))?;
        Ok(Self {
            rows,
            accounts,
            client,
            egress,
            quota,
            #[cfg(test)]
            test_endpoint: None,
            #[cfg(test)]
            test_now: None,
        })
    }
    pub fn account_ids(&self) -> Vec<&str> {
        self.rows.iter().map(GoogleTtsAccount::account_id).collect()
    }
    fn now(&self) -> u64 {
        #[cfg(test)]
        if let Some(now) = self.test_now {
            return now;
        }
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }
    pub async fn speech_for_session(
        &self,
        model: &str,
        body: &Value,
        session: Option<&str>,
    ) -> Result<Value, ProviderError> {
        let request = speech_request(model, body)?;
        let endpoint = ENDPOINT;
        #[cfg(test)]
        let endpoint = self.test_endpoint.as_deref().unwrap_or(endpoint);
        let session = session.map(|session| format!("{PROVIDER}:speech:{session}"));
        let mut last_limit = None;
        for index in self.accounts.candidates(session.as_deref()) {
            let row = &self.rows[index];
            if !row.eligible_at(self.now()) {
                continue;
            }
            // Zero retry budget: rotate only an authoritative 429. Any ambiguous
            // delivery or malformed/truncated success returns immediately.
            let (response, _captured_client) = send_with_egress_captured(
                &self.client,
                self.egress.as_deref(),
                session.as_deref(),
                PROVIDER,
                0,
                |client| {
                    client
                        .post(endpoint)
                        .bearer_auth(&row.access_token)
                        .header("x-goog-user-project", &row.quota_project)
                        .timeout(Duration::from_secs(60))
                        .json(&request.payload)
                },
            )
            .await?;
            let status = response.status();
            let rate = parse_rate_limit(response.headers());
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = rate.as_ref().and_then(|info| info.retry_after);
                let reset_at = rate.as_ref().and_then(|info| info.reset_at);
                self.accounts.record_rate_limit(index, retry_after);
                self.quota
                    .record_rate_limited(PROVIDER, retry_after, reset_at);
                last_limit = Some(ProviderError::RateLimited {
                    provider: PROVIDER.into(),
                    retry_after,
                    reset_at,
                });
                continue;
            }
            if status == reqwest::StatusCode::PAYMENT_REQUIRED {
                return Err(ProviderError::PaymentRequired {
                    provider: PROVIDER.into(),
                    message: "upstream payment required".into(),
                });
            }
            if !status.is_success() {
                return Err(crate::upstream_status_error(
                    status,
                    "google-tts upstream rejected synthesis".to_owned(),
                ));
            }
            if response
                .content_length()
                .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
            {
                return Err(invalid("audio response exceeds limit"));
            }
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| {
                    ProviderError::DeliveryUncertain("google-tts audio response interrupted".into())
                })?;
                if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) {
                    return Err(invalid("audio response exceeds limit"));
                }
                bytes.extend_from_slice(&chunk);
            }
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|_| invalid("audio response is malformed"))?;
            let audio = value
                .get("audioContent")
                .and_then(Value::as_str)
                .ok_or_else(|| invalid("audio response is missing content"))?;
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(audio)
                .map_err(|_| invalid("audio response has invalid base64"))?;
            if decoded.is_empty() || decoded.len() > MAX_AUDIO_BYTES {
                return Err(invalid("audio content is empty or oversized"));
            }
            self.accounts.record_success(session.as_deref(), index);
            if let Some(rate) = rate {
                self.quota.record_success(PROVIDER, &rate);
            }
            return Ok(
                json!({"object":"audio","data":[{"b64_json":base64::engine::general_purpose::STANDARD.encode(decoded),"content_type":request.content_type}],"raw":Value::Null}),
            );
        }
        Err(last_limit.unwrap_or_else(|| invalid("no eligible supplied OAuth account")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockResponse, MockServer};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn row(token: &str, project: &str, expiry: Option<u64>) -> GoogleTtsAccount {
        GoogleTtsAccount::supplied_oauth(token.into(), project.into(), expiry).unwrap()
    }
    fn request() -> Value {
        json!({"input":"Hello 世界","voice":"en-US-Neural2-F","language_code":"en-US","response_format":"mp3"})
    }
    fn success() -> MockResponse {
        MockResponse::ok_json(r#"{"audioContent":"AQID"}"#)
    }
    fn provider(
        server: &MockServer,
        rows: Vec<GoogleTtsAccount>,
        policies: Vec<ProviderAccountPolicy>,
    ) -> GoogleTtsProvider {
        let mut provider =
            GoogleTtsProvider::new(rows, &policies, None, Arc::new(ProviderQuotas::new())).unwrap();
        provider.test_endpoint = Some(format!("{}/v1/text:synthesize", server.base_url()));
        provider.test_now = Some(100);
        provider
    }
    fn policies(count: usize) -> Vec<ProviderAccountPolicy> {
        vec![ProviderAccountPolicy::default(); count]
    }

    #[test]
    fn supplied_identity_pairs_project_and_token_but_excludes_expiry() {
        let account = row("token-one", "project-one", Some(200));
        assert_eq!(
            account.account_id(),
            row("token-one", " project-one ", None).account_id()
        );
        assert_ne!(
            account.account_id(),
            row("token-one", "project-two", Some(200)).account_id()
        );
        assert_ne!(
            account.account_id(),
            row("token-two", "project-one", Some(200)).account_id()
        );
        assert!(!format!("{account:?}").contains("token-one"));
        assert!(!format!("{account:?}").contains("project-one"));
    }
    #[test]
    fn supplied_auth_and_project_validation_has_safe_errors() {
        for (token, project) in [
            ("token\r\nsecret", "project-one"),
            (" token", "project-one"),
            ("token", "https://secret.test"),
            ("token", ""),
        ] {
            let error =
                GoogleTtsAccount::supplied_oauth(token.into(), project.into(), None).unwrap_err();
            assert!(!error.to_string().contains("secret"));
        }
    }
    #[test]
    fn expiry_unknown_is_explicit_and_known_boundary_is_clock_testable() {
        let known = row("token", "project-one", Some(160));
        assert!(!known.eligible_at(100));
        assert!(known.eligible_at(99));
        assert!(!known.eligible_at(u64::MAX));
        let unknown = row("token", "project-one", None);
        assert!(unknown.eligible_at(100));
        assert_eq!(
            unknown.expiry_diagnostic(100),
            Some("supplied_token_expiry_unknown")
        );
    }
    #[test]
    fn exact_utf8_limit_and_native_formats_are_validated() {
        let mut body = request();
        body["input"] = "é".repeat(2500).into();
        assert!(speech_request(PROVIDER, &body).is_ok());
        body["input"] = "é".repeat(2501).into();
        assert!(speech_request(PROVIDER, &body).is_err());
        body = request();
        for (format, encoding, content_type) in [
            ("mp3", "MP3", "audio/mpeg"),
            ("wav", "LINEAR16", "audio/wav"),
            ("ogg", "OGG_OPUS", "audio/ogg"),
        ] {
            body["response_format"] = format.into();
            let parsed = speech_request(PROVIDER, &body).unwrap();
            assert_eq!(parsed.payload["audioConfig"]["audioEncoding"], encoding);
            assert_eq!(parsed.content_type, content_type);
        }
        for format in ["pcm", "aac"] {
            body["response_format"] = format.into();
            assert!(speech_request(PROVIDER, &body).is_err());
        }
    }
    #[tokio::test]
    async fn native_rest_wire_and_audio_envelope_keep_selected_token_project_pair() {
        let server = MockServer::always(success()).await;
        let mut policies = policies(2);
        policies[0].priority = 9;
        policies[1].priority = 1;
        let provider = provider(
            &server,
            vec![
                row("token-one", "project-one", None),
                row("token-two", "project-two", Some(1000)),
            ],
            policies,
        );
        let result = provider
            .synthesize_speech(PROVIDER, &request())
            .await
            .unwrap();
        assert_eq!(
            result,
            json!({"object":"audio","data":[{"b64_json":"AQID","content_type":"audio/mpeg"}],"raw":null})
        );
        let wire = &server.requests()[0];
        assert_eq!(wire.method, "POST");
        assert_eq!(wire.path, "/v1/text:synthesize");
        assert_eq!(
            wire.header("authorization").as_deref(),
            Some("Bearer token-two")
        );
        assert_eq!(
            wire.header("x-goog-user-project").as_deref(),
            Some("project-two")
        );
        assert_eq!(
            wire.json(),
            json!({"input":{"text":"Hello 世界"},"voice":{"languageCode":"en-US","name":"en-US-Neural2-F"},"audioConfig":{"audioEncoding":"MP3","speakingRate":1.0}})
        );
    }
    #[tokio::test]
    async fn expired_and_disabled_rows_never_send_credentials() {
        let server = MockServer::always(success()).await;
        let mut policy = policies(3);
        policy[1].enabled = false;
        let provider = provider(
            &server,
            vec![
                row("expired", "project-one", Some(100)),
                row("disabled", "project-two", None),
                row("live", "project-three", None),
            ],
            policy,
        );
        provider
            .synthesize_speech(PROVIDER, &request())
            .await
            .unwrap();
        assert_eq!(
            server.requests()[0].header("authorization").as_deref(),
            Some("Bearer live")
        );
        assert_eq!(server.request_count(), 1);
    }
    #[tokio::test]
    async fn all_expired_is_rejected_before_io_and_cannot_fake_an_account() {
        let server = MockServer::always(success()).await;
        let provider = provider(
            &server,
            vec![row("expired", "project-one", Some(120))],
            policies(1),
        );
        assert!(provider
            .synthesize_speech(PROVIDER, &request())
            .await
            .is_err());
        assert_eq!(server.request_count(), 0);
        assert!(
            GoogleTtsProvider::new(vec![], &[], None, Arc::new(ProviderQuotas::new())).is_err()
        );
    }
    #[tokio::test]
    async fn bound_speech_trait_preserves_affinity_and_returns_inline_audio() {
        let server = MockServer::always(success()).await;
        let provider = provider(
            &server,
            vec![
                row("token-one", "project-one", None),
                row("token-two", "project-two", None),
            ],
            policies(2),
        );
        let provider: &dyn Provider = &provider;
        for session in ["first", "second", "first"] {
            let bound = provider
                .synthesize_speech_bound(PROVIDER, &request(), Some(session))
                .await
                .unwrap();
            let (response, origin) = bound.into_parts();
            assert!(origin.is_none());
            assert_eq!(response["data"][0]["b64_json"], "AQID");
        }
        let requests = server.requests();
        assert_eq!(
            requests[0].header("authorization"),
            requests[2].header("authorization")
        );
        assert_ne!(
            requests[0].header("authorization"),
            requests[1].header("authorization")
        );
        assert_eq!(
            requests[0].header("x-goog-user-project"),
            requests[2].header("x-goog-user-project")
        );
    }

    #[tokio::test]
    async fn authoritative_429_rotates_complete_context_and_preserves_session() {
        let server = MockServer::start(vec![
            MockResponse::json(429, r#"{"error":"token-one secret"}"#)
                .with_header("retry-after", "300"),
            success(),
        ])
        .await;
        let provider = provider(
            &server,
            vec![
                row("token-one", "project-one", None),
                row("token-two", "project-two", None),
            ],
            policies(2),
        );
        provider
            .speech_for_session(PROVIDER, &request(), Some("sticky"))
            .await
            .unwrap();
        provider
            .speech_for_session(PROVIDER, &request(), Some("sticky"))
            .await
            .unwrap();
        let requests = server.requests();
        for (wire, token, project) in [
            (&requests[0], "Bearer token-one", "project-one"),
            (&requests[1], "Bearer token-two", "project-two"),
            (&requests[2], "Bearer token-two", "project-two"),
        ] {
            assert_eq!(wire.header("authorization").as_deref(), Some(token));
            assert_eq!(wire.header("x-goog-user-project").as_deref(), Some(project));
        }
    }
    #[tokio::test]
    async fn auth_payment_server_errors_and_redirects_are_not_replayed_or_echoed() {
        for status in [401, 403, 402, 500, 302] {
            let destination = MockServer::always(success()).await;
            let server = MockServer::always(
                MockResponse::json(
                    status,
                    r#"{"error":"private-token raw-input https://private.test"}"#,
                )
                .with_header("location", destination.base_url()),
            )
            .await;
            let provider = provider(
                &server,
                vec![
                    row("private-token", "project-one", None),
                    row("other", "project-two", None),
                ],
                policies(2),
            );
            let error = provider
                .synthesize_speech(PROVIDER, &request())
                .await
                .unwrap_err();
            if status == 402 {
                assert!(matches!(error, ProviderError::PaymentRequired { .. }));
            }
            assert!(!format!("{error:?}").contains("private"));
            assert!(!error.to_string().contains("raw-input"));
            assert_eq!(server.request_count(), 1);
            assert_eq!(destination.request_count(), 0);
        }
    }
    #[tokio::test]
    async fn malformed_empty_or_invalid_audio_never_replays_successful_work() {
        for body in [
            "not-json",
            r#"{}"#,
            r#"{"audioContent":""}"#,
            r#"{"audioContent":"SECRET?"}"#,
        ] {
            let server = MockServer::always(MockResponse::ok_json(body)).await;
            let provider = provider(
                &server,
                vec![
                    row("token-one", "project-one", None),
                    row("token-two", "project-two", None),
                ],
                policies(2),
            );
            let error = provider
                .synthesize_speech(PROVIDER, &request())
                .await
                .unwrap_err();
            assert!(!error.to_string().contains("SECRET"));
            assert_eq!(server.request_count(), 1);
        }
    }
    #[tokio::test]
    async fn oversized_success_is_bounded_without_account_replay() {
        let server=MockServer::always(MockResponse::ok_json(json!({"audioContent":base64::engine::general_purpose::STANDARD.encode(vec![1;MAX_AUDIO_BYTES+1])}).to_string())).await;
        let provider = provider(
            &server,
            vec![
                row("token-one", "project-one", None),
                row("token-two", "project-two", None),
            ],
            policies(2),
        );
        assert!(provider
            .synthesize_speech(PROVIDER, &request())
            .await
            .is_err());
        assert_eq!(server.request_count(), 1);
    }
    #[tokio::test]
    async fn malformed_native_input_and_cross_kind_model_fail_before_io() {
        let server = MockServer::always(success()).await;
        let provider = provider(
            &server,
            vec![row("token", "project-one", None)],
            policies(1),
        );
        for change in [
            json!({"voice":"alloy"}),
            json!({"language_code":"en-US\r\n"}),
            json!({"voice":"ja-JP-Neural2-C"}),
            json!({"ssml":"<speak>bad</speak>"}),
            json!({"speed":3}),
        ] {
            let mut body = request();
            body.as_object_mut()
                .unwrap()
                .extend(change.as_object().unwrap().clone());
            assert!(provider.synthesize_speech(PROVIDER, &body).await.is_err());
        }
        assert!(provider
            .synthesize_speech("edge-tts", &request())
            .await
            .is_err());
        assert_eq!(server.request_count(), 0);
    }
    #[tokio::test]
    async fn configured_egress_uses_actual_proxy_client_and_selected_auth_context() {
        let direct = MockServer::always(success()).await;
        let proxy = MockServer::always(success()).await;
        let proxy_client = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(proxy.base_url()).unwrap())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let egress = Arc::new(EgressClientPool::new(vec![proxy_client]).unwrap());
        let mut provider = GoogleTtsProvider::new(
            vec![row("proxy-token", "project-proxy", None)],
            &policies(1),
            Some(egress),
            Arc::new(ProviderQuotas::new()),
        )
        .unwrap();
        provider.test_endpoint = Some(format!("{}/v1/text:synthesize", direct.base_url()));
        provider
            .speech_for_session(PROVIDER, &request(), Some("session"))
            .await
            .unwrap();
        assert_eq!(direct.request_count(), 0);
        assert_eq!(proxy.request_count(), 1);
        assert_eq!(
            proxy.requests()[0].header("authorization").as_deref(),
            Some("Bearer proxy-token")
        );
        assert_eq!(
            proxy.requests()[0].header("x-goog-user-project").as_deref(),
            Some("project-proxy")
        );
    }

    #[tokio::test]
    async fn truncated_delivery_is_uncertain_and_never_replayed() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut incoming = vec![0; 8192];
            let _ = socket.read(&mut incoming).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{\"audioContent\":\"").await.unwrap();
        });
        let mut provider = GoogleTtsProvider::new(
            vec![
                row("token-one", "project-one", None),
                row("token-two", "project-two", None),
            ],
            &policies(2),
            None,
            Arc::new(ProviderQuotas::new()),
        )
        .unwrap();
        provider.test_endpoint = Some(format!("http://{addr}/v1/text:synthesize"));
        let error = provider
            .synthesize_speech(PROVIDER, &request())
            .await
            .unwrap_err();
        assert!(matches!(error, ProviderError::DeliveryUncertain(_)));
        task.await.unwrap();
    }
}

impl Provider for GoogleTtsProvider {
    fn name(&self) -> &'static str {
        PROVIDER
    }
    fn configure_account_policies(&self, policies: &[ProviderAccountPolicy]) {
        self.accounts.configure(policies);
    }
    fn has_rotating_accounts(&self) -> bool {
        self.accounts.has_restrictions()
            || self.rows.len() > 1
            || self.egress.as_ref().is_some_and(|pool| pool.len() > 1)
    }
    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async { Err(invalid("supports speech synthesis only")) })
    }
    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<axum::body::Body, ProviderError>> + Send + 'a>> {
        Box::pin(async { Err(invalid("supports speech synthesis only")) })
    }
    fn synthesize_speech<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(self.speech_for_session(model, body, None))
    }
    fn synthesize_speech_bound<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        session: Option<&'a str>,
    ) -> Pin<Box<dyn Future<Output = Result<crate::BoundSpeech, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            self.speech_for_session(model, body, session)
                .await
                .map(crate::BoundSpeech::inline)
        })
    }
}
