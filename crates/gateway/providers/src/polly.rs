//! Direct AWS Polly with explicit credentials and AWS-maintained SigV4 signing.
//! No environment, profile, IMDS, STS, browser auth or automatic credential refresh.
//! https://docs.aws.amazon.com/polly/latest/APIReference/API_SynthesizeSpeech.html
//! https://docs.aws.amazon.com/general/latest/gr/pol.html
//! Reviewed dependencies: aws-sigv4 =1.5.1 sign-http + http1, aws-credential-types =1.3.0;
//! both declare Rust 1.94.1. Shared dependency/export wiring is coordinated separately.

use std::{
    fmt,
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use aws_credential_types::Credentials;
use aws_sigv4::{
    http_request::{sign, SignableBody, SignableRequest, SigningSettings},
    sign::v4,
};
use base64::Engine as _;
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    account_pool::AccountPool, egress::send_with_egress_captured, parse_rate_limit, BoundSpeech,
    EgressClientPool, Provider, ProviderAccountPolicy, ProviderError, ProviderQuotas,
};

const PROVIDER: &str = "polly";
const MAX_AUDIO_BYTES: usize = 8 * 1024 * 1024;
const EXPIRY_MARGIN_SECONDS: u64 = 60;
// Explicit documented regional endpoints, commercial AWS partition only in this unit.
const REGIONS: &[&str] = &[
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    "af-south-1",
    "ap-east-1",
    "ap-southeast-5",
    "ap-south-1",
    "ap-northeast-3",
    "ap-northeast-2",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-southeast-7",
    "ap-northeast-1",
    "ca-central-1",
    "eu-central-1",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-south-2",
    "eu-north-1",
    "eu-central-2",
    "me-south-1",
    "sa-east-1",
];
const VOICES: &[&str] = &[
    "Aditi",
    "Amy",
    "Astrid",
    "Bianca",
    "Brian",
    "Camila",
    "Carla",
    "Carmen",
    "Celine",
    "Chantal",
    "Conchita",
    "Cristiano",
    "Dora",
    "Emma",
    "Enrique",
    "Ewa",
    "Filiz",
    "Gabrielle",
    "Geraint",
    "Giorgio",
    "Gwyneth",
    "Hans",
    "Ines",
    "Ivy",
    "Jacek",
    "Jan",
    "Joanna",
    "Joey",
    "Justin",
    "Karl",
    "Kendra",
    "Kevin",
    "Kimberly",
    "Lea",
    "Liv",
    "Lotte",
    "Lucia",
    "Lupe",
    "Mads",
    "Maja",
    "Marlene",
    "Mathieu",
    "Matthew",
    "Maxim",
    "Mia",
    "Miguel",
    "Mizuki",
    "Naja",
    "Nicole",
    "Olivia",
    "Penelope",
    "Raveena",
    "Ricardo",
    "Ruben",
    "Russell",
    "Salli",
    "Seoyeon",
    "Takumi",
    "Tatyana",
    "Vicki",
    "Vitoria",
    "Zeina",
    "Zhiyu",
    "Aria",
    "Ayanda",
    "Arlet",
    "Hannah",
    "Arthur",
    "Daniel",
    "Liam",
    "Pedro",
    "Kajal",
    "Hiujin",
    "Laura",
    "Elin",
    "Ida",
    "Suvi",
    "Ola",
    "Hala",
    "Andres",
    "Sergio",
    "Remi",
    "Adriano",
    "Thiago",
    "Ruth",
    "Stephen",
    "Kazuha",
    "Tomoko",
    "Niamh",
    "Sofie",
    "Lisa",
    "Isabelle",
    "Zayd",
    "Danielle",
    "Gregory",
    "Burcu",
    "Jitka",
    "Sabrina",
    "Jasmine",
    "Jihye",
    "Ambre",
    "Beatrice",
    "Florian",
    "Lennart",
    "Lorenzo",
    "Tiffany",
];
const LANGUAGES: &[&str] = &[
    "arb",
    "cmn-CN",
    "cy-GB",
    "da-DK",
    "de-DE",
    "en-AU",
    "en-GB",
    "en-GB-WLS",
    "en-IN",
    "en-US",
    "es-ES",
    "es-MX",
    "es-US",
    "fr-CA",
    "fr-FR",
    "is-IS",
    "it-IT",
    "ja-JP",
    "hi-IN",
    "ko-KR",
    "nb-NO",
    "nl-NL",
    "pl-PL",
    "pt-BR",
    "pt-PT",
    "ro-RO",
    "ru-RU",
    "sv-SE",
    "tr-TR",
    "en-NZ",
    "en-ZA",
    "ca-ES",
    "de-AT",
    "yue-CN",
    "ar-AE",
    "fi-FI",
    "en-IE",
    "nl-BE",
    "fr-BE",
    "cs-CZ",
    "de-CH",
    "en-SG",
];

fn invalid(message: &'static str) -> ProviderError {
    ProviderError::Provider(format!("polly {message}"))
}
fn region_endpoint(region: &str) -> Result<String, ProviderError> {
    if !REGIONS.contains(&region) {
        return Err(invalid("configured region is unsupported"));
    }
    Ok(format!("https://polly.{region}.amazonaws.com/v1/speech"))
}

/// Explicit supplied AWS material. Credentials owns and zeroizes its secret bytes.
#[derive(Clone)]
pub struct PollyAccount {
    credentials: Credentials,
    expires_at_unix_secs: Option<u64>,
}
impl fmt::Debug for PollyAccount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PollyAccount")
            .field("credentials", &"[REDACTED]")
            .field("has_session_token", &self.has_session_token())
            .field("expires_at_unix_secs", &self.expires_at_unix_secs)
            .finish()
    }
}
impl PollyAccount {
    pub fn explicit(
        access_key_id: String,
        secret_access_key: String,
        session_token: Option<String>,
        expires_at_unix_secs: Option<u64>,
    ) -> Result<Self, ProviderError> {
        if !(16..=128).contains(&access_key_id.len())
            || !access_key_id
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
            || !(16..=128).contains(&secret_access_key.len())
            || !secret_access_key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"/+=_-".contains(&byte))
            || session_token.as_ref().is_some_and(|token| {
                token.is_empty()
                    || token.len() > 16384
                    || !token
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"/+=_.-".contains(&byte))
            })
        {
            return Err(invalid("explicit AWS credentials are invalid"));
        }
        let expiry = expires_at_unix_secs
            .map(|seconds| {
                UNIX_EPOCH
                    .checked_add(Duration::from_secs(seconds))
                    .ok_or_else(|| invalid("credential expiry is invalid"))
            })
            .transpose()?;
        Ok(Self {
            credentials: Credentials::new(
                access_key_id,
                secret_access_key,
                session_token,
                expiry,
                "ryu-explicit-polly",
            ),
            expires_at_unix_secs,
        })
    }
    pub fn account_id(&self, region: &str) -> Result<String, ProviderError> {
        region_endpoint(region)?;
        let mut digest = Sha256::new();
        digest.update(b"ryu:polly:explicit:v1\0");
        for value in [
            region,
            self.credentials.access_key_id(),
            self.credentials.secret_access_key(),
            self.credentials.session_token().unwrap_or(""),
        ] {
            digest.update((value.len() as u64).to_be_bytes());
            digest.update(value.as_bytes());
        }
        Ok(format!("{:x}", digest.finalize()))
    }
    pub fn has_session_token(&self) -> bool {
        self.credentials.session_token().is_some()
    }
    pub fn expires_at_unix_secs(&self) -> Option<u64> {
        self.expires_at_unix_secs
    }
    pub fn eligible_at(&self, now: u64) -> bool {
        self.expires_at_unix_secs
            .is_none_or(|expiry| expiry > now.saturating_add(EXPIRY_MARGIN_SECONDS))
    }
    pub fn expiry_diagnostic(&self, now: u64) -> Option<&'static str> {
        if !self.eligible_at(now) {
            Some("supplied_credentials_expired_or_expiring")
        } else if self.has_session_token() && self.expires_at_unix_secs.is_none() {
            Some("supplied_session_expiry_unknown")
        } else {
            None
        }
    }
}

struct SpeechRequest {
    bytes: Vec<u8>,
    content_type: &'static str,
    sample_rate: u64,
}
fn speech_request(model: &str, body: &Value) -> Result<SpeechRequest, ProviderError> {
    if !matches!(model, "polly" | "polly::synthesize") {
        return Err(invalid("model is unsupported"));
    }
    // All plain-text characters count toward the 3000 billed-character ceiling,
    // hence also satisfy the 6000 total-character limit. No SSML/lexicons here.
    let text = body
        .get("input")
        .and_then(Value::as_str)
        .filter(|text| {
            !text.trim().is_empty() && text.chars().count() <= 3000 && !text.contains('\0')
        })
        .ok_or_else(|| invalid("plain text must contain 1 to 3000 characters"))?;
    if body.get("ssml").is_some() || body.get("text_type").is_some_and(|kind| kind != "text") {
        return Err(invalid("caller SSML is unsupported"));
    }
    if body
        .get("speed")
        .is_some_and(|speed| speed.as_f64() != Some(1.0))
    {
        return Err(invalid("plain-text speed adjustment is unsupported"));
    }
    let voice = body
        .get("voice")
        .and_then(Value::as_str)
        .filter(|voice| VOICES.contains(voice))
        .ok_or_else(|| invalid("native voice ID is unsupported"))?;
    let engine = body
        .get("engine")
        .and_then(Value::as_str)
        .unwrap_or("standard");
    if !matches!(engine, "standard" | "neural" | "long-form" | "generative") {
        return Err(invalid("native engine is unsupported"));
    }
    let format = body
        .get("response_format")
        .and_then(Value::as_str)
        .unwrap_or("mp3");
    let (format, content_type, default_rate) = match format {
        "mp3" => (
            "mp3",
            "audio/mpeg",
            if engine == "standard" { 22050 } else { 24000 },
        ),
        "ogg" | "ogg_vorbis" => ("ogg_vorbis", "audio/ogg", 24000),
        "opus" | "ogg_opus" => ("ogg_opus", "audio/ogg", 48000),
        "pcm" => ("pcm", "audio/pcm", 16000),
        _ => return Err(invalid("response_format is unsupported")),
    };
    let sample_rate = match body.get("sample_rate") {
        None => default_rate,
        Some(rate) => rate
            .as_u64()
            .ok_or_else(|| invalid("sample_rate is invalid"))?,
    };
    let valid_rate = match format {
        "pcm" => matches!(sample_rate, 8000 | 16000),
        "ogg_opus" => sample_rate == 48000,
        _ => matches!(sample_rate, 8000 | 16000 | 22050 | 24000 | 44100 | 48000),
    };
    if !valid_rate {
        return Err(invalid("sample_rate is unsupported for encoding"));
    }
    let mut payload = json!({"Text":text,"TextType":"text","VoiceId":voice,"Engine":engine,"OutputFormat":format,"SampleRate":sample_rate.to_string()});
    if let Some(language) = body.get("language_code") {
        let language = language
            .as_str()
            .filter(|language| LANGUAGES.contains(language))
            .ok_or_else(|| invalid("language_code is unsupported"))?;
        payload["LanguageCode"] = language.into();
    }
    let bytes =
        serde_json::to_vec(&payload).map_err(|_| invalid("synthesis request cannot be encoded"))?;
    Ok(SpeechRequest {
        bytes,
        content_type,
        sample_rate,
    })
}

// All canonicalization, payload hashing, signing key derivation and authorization
// formatting belong to aws-sigv4. Never format signer errors or instructions.
fn signed_headers(
    row: &PollyAccount,
    region: &str,
    url: &str,
    bytes: &[u8],
    time: SystemTime,
) -> Result<reqwest::header::HeaderMap, ProviderError> {
    let identity = row.credentials.clone().into();
    let params = v4::SigningParams::builder()
        .identity(&identity)
        .region(region)
        .name("polly")
        .time(time)
        .settings(SigningSettings::default())
        .build()
        .map_err(|_| invalid("request signing parameters are invalid"))?
        .into();
    let signable = SignableRequest::new(
        "POST",
        url,
        std::iter::once(("content-type", "application/json")),
        SignableBody::Bytes(bytes),
    )
    .map_err(|_| invalid("request cannot be signed"))?;
    let (instructions, _signature) = sign(signable, &params)
        .map_err(|_| invalid("request signing failed"))?
        .into_parts();
    if !instructions.params().is_empty() {
        return Err(invalid("query signing is unsupported"));
    }
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        reqwest::header::HeaderValue::from_static("application/json"),
    );
    for (name, value) in instructions.headers() {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| invalid("signed header is invalid"))?;
        let mut value = reqwest::header::HeaderValue::from_str(value)
            .map_err(|_| invalid("signed header is invalid"))?;
        if name == reqwest::header::AUTHORIZATION || name.as_str() == "x-amz-security-token" {
            value.set_sensitive(true);
        }
        headers.insert(name, value);
    }
    Ok(headers)
}

pub struct PollyProvider {
    region: String,
    endpoint: String,
    rows: Vec<PollyAccount>,
    account_ids: Vec<String>,
    accounts: AccountPool,
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    quota: Arc<ProviderQuotas>,
    #[cfg(test)]
    test_endpoint: Option<String>,
    #[cfg(test)]
    test_now: Option<u64>,
}
impl PollyProvider {
    pub fn new(
        region: String,
        rows: Vec<PollyAccount>,
        policies: &[ProviderAccountPolicy],
        egress: Option<Arc<EgressClientPool>>,
        quota: Arc<ProviderQuotas>,
    ) -> Result<Self, ProviderError> {
        let endpoint = region_endpoint(&region)?;
        let account_ids = rows
            .iter()
            .map(|row| row.account_id(&region))
            .collect::<Result<Vec<_>, _>>()?;
        if rows.is_empty()
            || rows.len() > 32
            || rows.len() != policies.len()
            || account_ids
                .iter()
                .enumerate()
                .any(|(index, id)| account_ids[..index].contains(id))
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
            region,
            endpoint,
            rows,
            account_ids,
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
    pub fn region(&self) -> &str {
        &self.region
    }
    pub fn account_ids(&self) -> &[String] {
        &self.account_ids
    }
    fn now(&self) -> u64 {
        #[cfg(test)]
        if let Some(now) = self.test_now {
            return now;
        }
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
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
        let endpoint = self.endpoint.as_str();
        #[cfg(test)]
        let endpoint = self.test_endpoint.as_deref().unwrap_or(endpoint);
        let session = session.map(|session| format!("polly:speech:{session}"));
        let mut last_limit = None;
        for index in self.accounts.candidates(session.as_deref()) {
            let row = &self.rows[index];
            let now = self.now();
            if !row.eligible_at(now) {
                continue;
            }
            let time = UNIX_EPOCH
                .checked_add(Duration::from_secs(now))
                .ok_or_else(|| invalid("signing clock is invalid"))?;
            let headers = signed_headers(row, &self.region, endpoint, &request.bytes, time)?;
            let (response, _captured_client) = send_with_egress_captured(
                &self.client,
                self.egress.as_deref(),
                session.as_deref(),
                PROVIDER,
                0,
                |client| {
                    client
                        .post(endpoint)
                        .headers(headers.clone())
                        .body(request.bytes.clone())
                        .timeout(Duration::from_secs(60))
                },
            )
            .await?;
            let status = response.status();
            let rate = parse_rate_limit(response.headers());
            let throttle_header = response
                .headers()
                .get("x-amzn-errortype")
                .and_then(|header| header.to_str().ok())
                .and_then(|value| value.split(':').next());
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS
                || (status == reqwest::StatusCode::BAD_REQUEST
                    && throttle_header == Some("ThrottlingException"))
            {
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
                    "polly upstream rejected synthesis".to_owned(),
                ));
            }
            let mime = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|header| header.to_str().ok())
                .and_then(|value| value.split(';').next())
                .map(str::trim);
            if mime != Some(request.content_type) {
                return Err(invalid("upstream audio MIME does not match encoding"));
            }
            if response
                .content_length()
                .is_some_and(|length| length > MAX_AUDIO_BYTES as u64)
            {
                return Err(invalid("audio response exceeds limit"));
            }
            let mut audio = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| {
                    ProviderError::DeliveryUncertain(
                        "polly accepted audio delivery interrupted".into(),
                    )
                })?;
                if chunk.len() > MAX_AUDIO_BYTES.saturating_sub(audio.len()) {
                    return Err(invalid("audio response exceeds limit"));
                }
                audio.extend_from_slice(&chunk);
            }
            if audio.is_empty() {
                return Err(invalid("audio response is empty"));
            }
            self.accounts.record_success(session.as_deref(), index);
            if let Some(rate) = rate {
                self.quota.record_success(PROVIDER, &rate);
            }
            return Ok(
                json!({"object":"audio","data":[{"b64_json":base64::engine::general_purpose::STANDARD.encode(audio),"content_type":request.content_type,"sample_rate":request.sample_rate}],"raw":null}),
            );
        }
        Err(last_limit.unwrap_or_else(|| invalid("no eligible explicit AWS account")))
    }
}
impl Provider for PollyProvider {
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
    ) -> Pin<Box<dyn Future<Output = Result<BoundSpeech, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            self.speech_for_session(model, body, session)
                .await
                .map(BoundSpeech::inline)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockResponse, MockServer};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const FIRST: &str = "AKIAAAAAAAAAAAAAAAAA";
    const SECOND: &str = "AKIABBBBBBBBBBBBBBBB";
    const SECRET: &str = "exampleSecretKeyMaterialNotReal1234567890";
    const NOW: u64 = 1_700_000_000;
    fn row(key: &str, session: Option<&str>, expiry: Option<u64>) -> PollyAccount {
        PollyAccount::explicit(
            key.into(),
            SECRET.into(),
            session.map(str::to_owned),
            expiry,
        )
        .unwrap()
    }
    fn request() -> Value {
        json!({"input":"Hello 世界","voice":"Joanna","engine":"neural","response_format":"mp3"})
    }
    fn success() -> MockResponse {
        MockResponse::ok_bytes("audio/mpeg", vec![1, 2, 3])
    }
    fn policies(count: usize) -> Vec<ProviderAccountPolicy> {
        vec![ProviderAccountPolicy::default(); count]
    }
    fn provider(
        server: &MockServer,
        rows: Vec<PollyAccount>,
        policies: Vec<ProviderAccountPolicy>,
    ) -> PollyProvider {
        let mut provider = PollyProvider::new(
            "us-east-1".into(),
            rows,
            &policies,
            None,
            Arc::new(ProviderQuotas::new()),
        )
        .unwrap();
        provider.test_endpoint = Some(format!("{}/v1/speech", server.base_url()));
        provider.test_now = Some(NOW);
        provider
    }

    #[test]
    fn explicit_identity_contains_region_and_all_credential_material_but_not_expiry() {
        let account = row(FIRST, Some("session-one"), Some(NOW + 1000));
        let id = account.account_id("us-east-1").unwrap();
        assert_eq!(
            id,
            row(FIRST, Some("session-one"), None)
                .account_id("us-east-1")
                .unwrap()
        );
        assert_ne!(id, account.account_id("eu-west-1").unwrap());
        assert_ne!(
            id,
            row(FIRST, Some("session-two"), None)
                .account_id("us-east-1")
                .unwrap()
        );
        assert_ne!(
            id,
            row(SECOND, Some("session-one"), None)
                .account_id("us-east-1")
                .unwrap()
        );
        let changed = PollyAccount::explicit(
            FIRST.into(),
            "differentSecretMaterial1234567890".into(),
            Some("session-one".into()),
            None,
        )
        .unwrap();
        assert_ne!(id, changed.account_id("us-east-1").unwrap());
        let debug = format!("{account:?}");
        for material in [FIRST, SECRET, "session-one"] {
            assert!(!debug.contains(material));
        }
    }
    #[test]
    fn expiry_is_clock_testable_and_unknown_session_is_honest() {
        let account = row(FIRST, Some("session-one"), Some(NOW + 60));
        assert!(!account.eligible_at(NOW));
        assert!(account.eligible_at(NOW - 1));
        assert!(!account.eligible_at(u64::MAX));
        let unknown = row(FIRST, Some("session-one"), None);
        assert!(unknown.eligible_at(NOW));
        assert_eq!(
            unknown.expiry_diagnostic(NOW),
            Some("supplied_session_expiry_unknown")
        );
        assert_eq!(row(FIRST, None, None).expiry_diagnostic(NOW), None);
    }
    #[test]
    fn rejects_injected_material_and_arbitrary_regions_without_echo() {
        for (key, secret, session) in [
            ("bad-secret", SECRET, None),
            (FIRST, "rawsecret\r\n", None),
            (FIRST, SECRET, Some("rawsecret\r\n")),
        ] {
            let error =
                PollyAccount::explicit(key.into(), secret.into(), session.map(str::to_owned), None)
                    .unwrap_err();
            assert!(!format!("{error:?}").contains("rawsecret"));
        }
        for region in [
            "",
            "https://secret.test",
            "us-east-1/secret",
            "cn-north-1",
            "us-gov-west-1",
        ] {
            assert!(region_endpoint(region).is_err());
        }
        assert_eq!(
            region_endpoint("ap-southeast-1").unwrap(),
            "https://polly.ap-southeast-1.amazonaws.com/v1/speech"
        );
    }
    #[test]
    fn signer_owns_fixed_clock_scope_payload_and_session_token_headers() {
        let account = row(FIRST, Some("session-one"), None);
        let endpoint = region_endpoint("us-east-1").unwrap();
        let first = signed_headers(
            &account,
            "us-east-1",
            &endpoint,
            b"{\"Text\":\"one\"}",
            UNIX_EPOCH + Duration::from_secs(NOW),
        )
        .unwrap();
        assert_eq!(first.get("x-amz-date").unwrap(), "20231114T221320Z");
        assert_eq!(first.get("x-amz-security-token").unwrap(), "session-one");
        assert!(first.get("x-amz-security-token").unwrap().is_sensitive());
        let authorization = first.get("authorization").unwrap();
        assert!(authorization.is_sensitive());
        let authorization = authorization.to_str().unwrap();
        assert!(authorization.starts_with("AWS4-HMAC-SHA256 "));
        assert!(authorization.contains(&format!(
            "Credential={FIRST}/20231114/us-east-1/polly/aws4_request"
        )));
        assert!(authorization
            .contains("SignedHeaders=content-type;host;x-amz-date;x-amz-security-token"));
        let changed = signed_headers(
            &account,
            "us-east-1",
            &endpoint,
            b"{\"Text\":\"two\"}",
            UNIX_EPOCH + Duration::from_secs(NOW),
        )
        .unwrap();
        assert_ne!(first.get("authorization"), changed.get("authorization"));
        let repeated = signed_headers(
            &account,
            "us-east-1",
            &endpoint,
            b"{\"Text\":\"one\"}",
            UNIX_EPOCH + Duration::from_secs(NOW),
        )
        .unwrap();
        assert_eq!(first, repeated);
        let permanent = signed_headers(
            &row(FIRST, None, None),
            "us-east-1",
            &endpoint,
            b"{}",
            UNIX_EPOCH + Duration::from_secs(NOW),
        )
        .unwrap();
        assert!(permanent.get("x-amz-security-token").is_none());
    }
    #[test]
    fn native_input_count_encoding_and_sample_rate_are_truthful() {
        let mut body = request();
        body["input"] = "界".repeat(3000).into();
        assert!(speech_request(PROVIDER, &body).is_ok());
        body["input"] = "界".repeat(3001).into();
        assert!(speech_request(PROVIDER, &body).is_err());
        body = request();
        for (format, mime, rate) in [
            ("mp3", "audio/mpeg", 24000),
            ("opus", "audio/ogg", 48000),
            ("ogg", "audio/ogg", 24000),
            ("pcm", "audio/pcm", 16000),
        ] {
            body["response_format"] = format.into();
            let parsed = speech_request(PROVIDER, &body).unwrap();
            assert_eq!(parsed.content_type, mime);
            assert_eq!(parsed.sample_rate, rate);
        }
        body["response_format"] = "pcm".into();
        body["sample_rate"] = 24000.into();
        assert!(speech_request(PROVIDER, &body).is_err());
        for format in ["wav", "aac", "json"] {
            body = request();
            body["response_format"] = format.into();
            assert!(speech_request(PROVIDER, &body).is_err());
        }
    }
    #[tokio::test]
    async fn exact_signed_native_wire_uses_selected_priority_account() {
        let server = MockServer::always(success()).await;
        let mut policy = policies(2);
        policy[0].priority = 9;
        policy[1].priority = 1;
        let provider = provider(
            &server,
            vec![
                row(FIRST, Some("session-one"), None),
                row(SECOND, Some("session-two"), None),
            ],
            policy,
        );
        let output = provider
            .synthesize_speech(PROVIDER, &request())
            .await
            .unwrap();
        assert_eq!(output["data"][0]["b64_json"], "AQID");
        assert_eq!(output["data"][0]["content_type"], "audio/mpeg");
        assert!(output["raw"].is_null());
        let wire = &server.requests()[0];
        assert_eq!(wire.method, "POST");
        assert_eq!(wire.path, "/v1/speech");
        assert_eq!(
            wire.header("x-amz-security-token").as_deref(),
            Some("session-two")
        );
        let authorization = wire.header("authorization").unwrap();
        assert!(authorization.contains(SECOND));
        assert!(!authorization.contains(FIRST));
        assert!(!authorization.contains(SECRET));
        assert!(!authorization.starts_with("Bearer"));
        assert_eq!(
            wire.json(),
            json!({"Text":"Hello 世界","TextType":"text","VoiceId":"Joanna","Engine":"neural","OutputFormat":"mp3","SampleRate":"24000"})
        );
        let headers = signed_headers(
            &provider.rows[1],
            "us-east-1",
            &format!("{}/v1/speech", server.base_url()),
            &wire.body,
            UNIX_EPOCH + Duration::from_secs(NOW),
        )
        .unwrap();
        assert_eq!(
            authorization,
            headers.get("authorization").unwrap().to_str().unwrap()
        );
    }
    #[tokio::test]
    async fn expired_disabled_and_empty_accounts_never_send() {
        let server = MockServer::always(success()).await;
        let mut policy = policies(3);
        policy[1].enabled = false;
        let provider = provider(
            &server,
            vec![
                row(FIRST, Some("expired"), Some(NOW)),
                row(SECOND, Some("disabled"), None),
                row("AKIACCCCCCCCCCCCCCCC", Some("live"), None),
            ],
            policy,
        );
        provider
            .synthesize_speech(PROVIDER, &request())
            .await
            .unwrap();
        assert_eq!(
            server.requests()[0]
                .header("x-amz-security-token")
                .as_deref(),
            Some("live")
        );
        assert_eq!(server.request_count(), 1);
        assert!(PollyProvider::new(
            "us-east-1".into(),
            vec![],
            &[],
            None,
            Arc::new(ProviderQuotas::new())
        )
        .is_err());
        let expired = self::provider(
            &server,
            vec![row(FIRST, Some("expired"), Some(NOW))],
            policies(1),
        );
        assert!(expired
            .synthesize_speech(PROVIDER, &request())
            .await
            .is_err());
        assert_eq!(server.request_count(), 1);
    }
    #[tokio::test]
    async fn throttle_rotates_whole_credential_tuple_and_cools_first_account() {
        for response in [
            MockResponse::json(429, "secret").with_header("retry-after", "300"),
            MockResponse::json(400, "secret")
                .with_header("x-amzn-errortype", "ThrottlingException"),
        ] {
            let server = MockServer::start(vec![response, success()]).await;
            let provider = provider(
                &server,
                vec![
                    row(FIRST, Some("session-one"), None),
                    row(SECOND, Some("session-two"), None),
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
            let wire = server.requests();
            assert_eq!(wire.len(), 3);
            assert!(wire[0].header("authorization").unwrap().contains(FIRST));
            for wire in &wire[1..] {
                assert!(wire.header("authorization").unwrap().contains(SECOND));
                assert_eq!(
                    wire.header("x-amz-security-token").as_deref(),
                    Some("session-two")
                );
            }
        }
    }
    #[tokio::test]
    async fn bound_trait_retains_affinity_and_has_no_hosted_origin() {
        let server = MockServer::always(success()).await;
        let provider = provider(
            &server,
            vec![row(FIRST, None, None), row(SECOND, None, None)],
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
    }
    #[tokio::test]
    async fn rejected_auth_payment_server_and_redirect_are_safe_and_never_replayed() {
        for status in [401, 403, 402, 500, 302, 400] {
            let destination = MockServer::always(success()).await;
            let server = MockServer::always(
                MockResponse::json(status, format!("{SECRET} rawinput https://private.test"))
                    .with_header("location", destination.base_url()),
            )
            .await;
            let provider = provider(
                &server,
                vec![
                    row(FIRST, Some("session-one"), None),
                    row(SECOND, Some("session-two"), None),
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
            for material in [FIRST, SECRET, "session-one", "rawinput", "private.test"] {
                assert!(!format!("{error:?}").contains(material));
            }
            assert_eq!(server.request_count(), 1);
            assert_eq!(destination.request_count(), 0);
        }
    }
    #[tokio::test]
    async fn empty_wrong_mime_and_oversized_success_do_not_replay() {
        for response in [
            MockResponse::ok_bytes("audio/mpeg", vec![]),
            MockResponse::ok_bytes("application/json", vec![1]),
            MockResponse::ok_bytes("audio/mpeg", vec![1; MAX_AUDIO_BYTES + 1]),
        ] {
            let server = MockServer::always(response).await;
            let provider = provider(
                &server,
                vec![row(FIRST, None, None), row(SECOND, None, None)],
                policies(2),
            );
            assert!(provider
                .synthesize_speech(PROVIDER, &request())
                .await
                .is_err());
            assert_eq!(server.request_count(), 1);
        }
    }
    #[tokio::test]
    async fn invalid_voice_engine_ssml_or_cross_kind_is_rejected_before_signing_io() {
        let server = MockServer::always(success()).await;
        let provider = provider(&server, vec![row(FIRST, None, None)], policies(1));
        for change in [
            json!({"voice":"alloy"}),
            json!({"engine":"secret"}),
            json!({"ssml":"<speak>bad</speak>"}),
            json!({"language_code":"en-US\r\n"}),
            json!({"speed":2}),
        ] {
            let mut body = request();
            body.as_object_mut()
                .unwrap()
                .extend(change.as_object().unwrap().clone());
            assert!(provider.synthesize_speech(PROVIDER, &body).await.is_err());
        }
        assert!(provider
            .synthesize_speech("google-tts", &request())
            .await
            .is_err());
        assert_eq!(server.request_count(), 0);
    }
    #[tokio::test]
    async fn actual_proxy_client_carries_selected_signed_headers_and_never_directs() {
        let direct = MockServer::always(success()).await;
        let proxy = MockServer::always(success()).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(proxy.base_url()).unwrap())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let mut provider = PollyProvider::new(
            "us-east-1".into(),
            vec![row(FIRST, Some("session-one"), None)],
            &policies(1),
            Some(Arc::new(EgressClientPool::new(vec![client]).unwrap())),
            Arc::new(ProviderQuotas::new()),
        )
        .unwrap();
        provider.test_endpoint = Some(format!("{}/v1/speech", direct.base_url()));
        provider.test_now = Some(NOW);
        provider
            .speech_for_session(PROVIDER, &request(), Some("session"))
            .await
            .unwrap();
        assert_eq!(direct.request_count(), 0);
        assert_eq!(proxy.request_count(), 1);
        assert!(proxy.requests()[0]
            .header("authorization")
            .unwrap()
            .contains(FIRST));
        assert_eq!(
            proxy.requests()[0]
                .header("x-amz-security-token")
                .as_deref(),
            Some("session-one")
        );
    }
    #[tokio::test]
    async fn accepted_partial_audio_is_uncertain_and_never_replays() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut incoming = vec![0; 8192];
            let _ = socket.read(&mut incoming).await.unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nContent-Length: 1000\r\nConnection: close\r\n\r\nabc").await.unwrap();
        });
        let mut provider = PollyProvider::new(
            "us-east-1".into(),
            vec![row(FIRST, None, None), row(SECOND, None, None)],
            &policies(2),
            None,
            Arc::new(ProviderQuotas::new()),
        )
        .unwrap();
        provider.test_endpoint = Some(format!("http://{addr}/v1/speech"));
        provider.test_now = Some(NOW);
        let error = provider
            .synthesize_speech(PROVIDER, &request())
            .await
            .unwrap_err();
        assert!(matches!(error, ProviderError::DeliveryUncertain(_)));
        task.await.unwrap();
    }
}
