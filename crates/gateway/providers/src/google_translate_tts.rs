//! Explicit opt-in anonymous Google Translate consumer speech, distinct from Cloud TTS.
//! Protocol: decolua/9router 4a57df8, ttsProviders/googleTts.js (bootstrap + jQ1olc RPC).
//! Fixed origins, no accounts/cookies/ambient credentials, no synthesis replay.

use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use base64::Engine as _;
use futures_util::StreamExt as _;
use serde_json::{json, Value};

use crate::{egress::send_with_egress_captured, EgressClientPool, Provider, ProviderError};

pub const CLASSIFICATION: &str = "unofficial_anonymous_consumer";
const ID: &str = "google-translate-tts";
const ORIGIN: &str = "https://translate.google.com";
const RPC_PATH: &str = "/_/TranslateWebserverUi/data/batchexecute";
const RPC_ID: &str = "jQ1olc";
const MAX_BOOTSTRAP: usize = 2 * 1024 * 1024;
const MAX_RESPONSE: usize = 12 * 1024 * 1024;
const MAX_AUDIO: usize = 8 * 1024 * 1024;

fn invalid(message: &str) -> ProviderError {
    ProviderError::Provider(format!("Google Translate TTS {message}"))
}

fn uncertain(message: &str) -> ProviderError {
    ProviderError::DeliveryUncertain(format!("Google Translate TTS {message}"))
}

fn language(value: &str) -> bool {
    (2..=20).contains(&value.len())
        && value.split('-').all(|part| {
            (2..=8).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_alphabetic())
        })
}

fn speech_input(model: &str, body: &Value) -> Result<(String, String), ProviderError> {
    let object = body
        .as_object()
        .ok_or_else(|| invalid("request must be an object"))?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "model" | "input" | "voice" | "language_code" | "response_format" | "speed"
        )
    }) {
        return Err(invalid("unsupported speech option"));
    }
    let default_language = if model == ID {
        "en"
    } else {
        model
            .strip_prefix("google-translate-tts::")
            .filter(|value| language(value))
            .ok_or_else(|| invalid("unsupported model"))?
    };
    let lang = object
        .get("language_code")
        .or_else(|| object.get("voice"))
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| invalid("language must be a string"))
        })
        .transpose()?
        .unwrap_or(default_language);
    let lang = if lang == "alloy" {
        default_language
    } else {
        lang
    };
    if !language(lang) {
        return Err(invalid("invalid language code"));
    }
    if object
        .get("response_format")
        .is_some_and(|value| value != "mp3")
    {
        return Err(invalid("only mp3 output is supported"));
    }
    if object
        .get("speed")
        .is_some_and(|value| value.as_f64() != Some(1.0))
    {
        return Err(invalid("only the default speech speed is supported"));
    }
    let text = object
        .get("input")
        .and_then(Value::as_str)
        .filter(|text| {
            !text.trim().is_empty()
                && text.len() <= 8192
                && !text
                    .chars()
                    .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
        })
        .ok_or_else(|| invalid("input is empty, invalid or exceeds 8192 bytes"))?;
    // Preserve the reference consumer's punctuation normalization.
    let cleaned: String = text
        .chars()
        .map(|ch| {
            if "@^*()\\/-_+=><\"'\u{201c}\u{201d}\u{3010}\u{3011}".contains(ch) {
                ' '
            } else {
                ch
            }
        })
        .collect();
    if cleaned.trim().is_empty() {
        return Err(invalid("input contains no spoken text"));
    }
    Ok((cleaned.replace(", ", ". "), lang.to_owned()))
}

fn bootstrap_field(html: &str, name: &str) -> Result<String, ProviderError> {
    let marker = format!("\"{name}\":");
    let value = html
        .split_once(&marker)
        .map(|(_, tail)| tail.trim_start())
        .ok_or_else(|| invalid("bootstrap metadata is unavailable"))?;
    let mut decoder = serde_json::Deserializer::from_str(value).into_iter::<String>();
    decoder
        .next()
        .and_then(Result::ok)
        .filter(|value| {
            !value.is_empty() && value.len() <= 2048 && !value.chars().any(char::is_control)
        })
        .ok_or_else(|| invalid("bootstrap metadata is malformed"))
}

async fn bounded_body(
    response: reqwest::Response,
    limit: usize,
    accepted: bool,
) -> Result<Vec<u8>, ProviderError> {
    let failure = || {
        if accepted {
            uncertain("accepted response is malformed or oversized")
        } else {
            invalid("bootstrap response is malformed or oversized")
        }
    };
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(failure());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| failure())?;
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err(failure());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn decode_audio(bytes: &[u8]) -> Result<Vec<u8>, ProviderError> {
    let text = std::str::from_utf8(bytes).map_err(|_| uncertain("RPC response is invalid"))?;
    for line in text
        .lines()
        .filter(|line| line.trim_start().starts_with('['))
    {
        let rows: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        for row in rows.as_array().into_iter().flatten() {
            if row.get(1).and_then(Value::as_str) != Some(RPC_ID) {
                continue;
            }
            let encoded = row
                .get(2)
                .and_then(Value::as_str)
                .ok_or_else(|| uncertain("RPC audio is missing"))?;
            let payload: Value =
                serde_json::from_str(encoded).map_err(|_| uncertain("RPC audio is malformed"))?;
            let audio = payload
                .get(0)
                .and_then(Value::as_str)
                .ok_or_else(|| uncertain("RPC audio is missing"))?;
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(audio)
                .map_err(|_| uncertain("RPC audio has invalid base64"))?;
            if decoded.is_empty() || decoded.len() > MAX_AUDIO {
                return Err(uncertain("RPC audio is empty or oversized"));
            }
            return Ok(decoded);
        }
    }
    Err(uncertain("RPC response has no matching audio result"))
}

pub struct GoogleTranslateTtsProvider {
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    #[cfg(test)]
    test_origin: Option<String>,
}

impl GoogleTranslateTtsProvider {
    pub fn new(
        opt_in: bool,
        client: reqwest::Client,
        egress: Option<Arc<EgressClientPool>>,
    ) -> Result<Self, ProviderError> {
        if !opt_in {
            return Err(invalid("requires explicit anonymous consumer opt-in"));
        }
        Ok(Self {
            client,
            egress,
            #[cfg(test)]
            test_origin: None,
        })
    }

    async fn speech(&self, model: &str, body: &Value) -> Result<Value, ProviderError> {
        let (text, lang) = speech_input(model, body)?;
        let origin = ORIGIN;
        #[cfg(test)]
        let origin = self.test_origin.as_deref().unwrap_or(origin);
        let operation = async {
            let bootstrap_url = format!("{origin}/");
            let (response, captured_client) = send_with_egress_captured(
                &self.client,
                self.egress.as_deref(),
                None,
                ID,
                0,
                |client| {
                    client
                        .get(&bootstrap_url)
                        .header("user-agent", "Mozilla/5.0")
                        .timeout(Duration::from_secs(10))
                },
            )
            .await?;
            if !response.status().is_success() {
                return Err(invalid("bootstrap was rejected"));
            }
            let bytes = bounded_body(response, MAX_BOOTSTRAP, false).await?;
            let html = std::str::from_utf8(&bytes).map_err(|_| invalid("bootstrap is invalid"))?;
            let sid = bootstrap_field(html, "FdrFJe")?;
            let build = bootstrap_field(html, "cfb2h")?;
            let payload = json!([text, lang, null, "undefined", [0]]).to_string();
            let request = json!([[[RPC_ID, payload, null, "generic"]]]).to_string();
            // The same selected transport owns bootstrap and RPC; no fallback after bootstrap.
            let response = captured_client
                .post(format!("{origin}{RPC_PATH}"))
                .header("user-agent", "Mozilla/5.0")
                .query(&[
                    ("rpcids", RPC_ID),
                    ("f.sid", sid.as_str()),
                    ("bl", build.as_str()),
                    ("hl", lang.as_str()),
                    ("soc-app", "1"),
                    ("soc-platform", "1"),
                    ("soc-device", "1"),
                    ("_reqid", "100001"),
                    ("rt", "c"),
                ])
                .header("referer", &bootstrap_url)
                .timeout(Duration::from_secs(30))
                .form(&[("f.req", request)])
                .send()
                .await
                .map_err(|_| uncertain("RPC delivery is uncertain"))?;
            if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                return Err(ProviderError::RateLimited {
                    provider: ID.into(),
                    retry_after: crate::parse_rate_limit(response.headers())
                        .and_then(|rate| rate.retry_after),
                    reset_at: None,
                });
            }
            if !response.status().is_success() {
                return Err(uncertain("RPC did not produce a confirmed result"));
            }
            let audio = decode_audio(&bounded_body(response, MAX_RESPONSE, true).await?)?;
            Ok(
                json!({"object":"audio", "data":[{"b64_json":base64::engine::general_purpose::STANDARD.encode(audio), "content_type":"audio/mpeg"}]}),
            )
        };
        tokio::time::timeout(Duration::from_secs(45), operation)
            .await
            .map_err(|_| uncertain("operation timed out"))?
    }
}

impl Provider for GoogleTranslateTtsProvider {
    fn name(&self) -> &'static str {
        ID
    }
    fn has_rotating_accounts(&self) -> bool {
        self.egress.as_ref().is_some_and(|pool| pool.len() > 1)
    }
    fn discover_models<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = Option<Vec<Value>>> + Send + 'a>> {
        Box::pin(async {
            Some(vec![
                json!({"id":ID,"object":"model","owned_by":ID,"modality":"tts"}),
            ])
        })
    }
    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async { Err(invalid("does not support chat")) })
    }
    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<axum::body::Body, ProviderError>> + Send + 'a>> {
        Box::pin(async { Err(invalid("does not support chat")) })
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

    fn bootstrap() -> MockResponse {
        MockResponse::ok_json(
            r#"<script>{"FdrFJe":"public-session","cfb2h":"public-build"}</script>"#,
        )
    }
    fn audio() -> MockResponse {
        let encoded =
            json!([base64::engine::general_purpose::STANDARD.encode(b"ID3mock-mp3")]).to_string();
        MockResponse::ok_json(format!(
            ")]}}'\n\n123\n{}\n",
            json!([["wrb.fr", RPC_ID, encoded, null]])
        ))
    }
    fn provider(server: &MockServer) -> GoogleTranslateTtsProvider {
        let mut provider = GoogleTranslateTtsProvider::new(
            true,
            reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            None,
        )
        .unwrap();
        provider.test_origin = Some(server.base_url().into());
        provider
    }
    #[tokio::test]
    async fn native_bootstrap_rpc_and_mp3_round_trip_are_anonymous() {
        let server = MockServer::start(vec![bootstrap(), audio()]).await;
        let result = provider(&server)
            .synthesize_speech(
                ID,
                &json!({"input":"hello, world!","voice":"vi","response_format":"mp3"}),
            )
            .await
            .unwrap();
        assert_eq!(
            result["data"][0]["b64_json"],
            base64::engine::general_purpose::STANDARD.encode(b"ID3mock-mp3")
        );
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].method, "GET");
        assert_eq!(requests[0].path, "/");
        assert!(requests[1].path.starts_with(RPC_PATH));
        assert_eq!(requests[1].method, "POST");
        for request in &requests {
            assert!(request.header("authorization").is_none());
            assert!(request.header("cookie").is_none());
        }
        let mut form_url = reqwest::Url::parse("https://fixture.invalid/").unwrap();
        form_url.set_query(Some(std::str::from_utf8(&requests[1].body).unwrap()));
        let form: Vec<_> = form_url.query_pairs().collect();
        let value: Value = serde_json::from_str(&form[0].1).unwrap();
        assert_eq!(value[0][0][0], RPC_ID);
        let input: Value = serde_json::from_str(value[0][0][1].as_str().unwrap()).unwrap();
        assert_eq!(
            input,
            json!(["hello. world!", "vi", null, "undefined", [0]])
        );
        assert_eq!(result["data"][0]["content_type"], "audio/mpeg");
    }
    #[tokio::test]
    async fn invalid_input_and_failed_bootstrap_never_submit_synthesis() {
        let server = MockServer::always(MockResponse::ok_json("missing bootstrap metadata")).await;
        let provider = provider(&server);
        for request in [
            json!({"input":""}),
            json!({"input":"hello","language_code":"https://host"}),
            json!({"input":"hello","response_format":"wav"}),
            json!({"input":"hello","speed":2}),
        ] {
            assert!(provider.synthesize_speech(ID, &request).await.is_err());
        }
        assert_eq!(server.request_count(), 0);
        assert!(provider
            .synthesize_speech(ID, &json!({"input":"hello"}))
            .await
            .is_err());
        assert_eq!(server.request_count(), 1);
    }
    #[tokio::test]
    async fn accepted_malformed_or_rejected_rpc_never_replays() {
        for response in [
            MockResponse::ok_json("malformed"),
            MockResponse::json(503, "secret upstream diagnostic"),
        ] {
            let server = MockServer::start(vec![bootstrap(), response, audio()]).await;
            let error = provider(&server)
                .synthesize_speech(ID, &json!({"input":"hello"}))
                .await
                .unwrap_err();
            assert!(matches!(error, ProviderError::DeliveryUncertain(_)));
            assert!(!error.to_string().contains("secret"));
            assert_eq!(server.request_count(), 2);
        }
    }
    #[tokio::test]
    async fn bootstrap_and_rpc_keep_the_same_assigned_proxy_without_direct_fallback() {
        let proxy = MockServer::start(vec![bootstrap(), audio()]).await;
        let unused = MockServer::always(MockResponse::json(500, "must not run")).await;
        let direct = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let proxied = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(proxy.base_url()).unwrap())
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let other = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(unused.base_url()).unwrap())
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let mut provider = GoogleTranslateTtsProvider::new(
            true,
            direct,
            Some(Arc::new(
                EgressClientPool::new(vec![proxied, other]).unwrap(),
            )),
        )
        .unwrap();
        // Unresolvable origin: only the assigned HTTP proxy can serve this fixture.
        provider.test_origin = Some("http://google-translate-fixture.invalid".into());
        provider
            .synthesize_speech(ID, &json!({"input":"hello"}))
            .await
            .unwrap();
        assert_eq!(proxy.request_count(), 2);
        assert_eq!(unused.request_count(), 0);
        assert_eq!(
            proxy.requests()[0].header("host").as_deref(),
            Some("google-translate-fixture.invalid")
        );
        assert_eq!(
            proxy.requests()[1].header("host").as_deref(),
            Some("google-translate-fixture.invalid")
        );
    }
    #[test]
    fn explicit_opt_in_model_language_and_bounded_decode() {
        assert!(GoogleTranslateTtsProvider::new(false, reqwest::Client::new(), None).is_err());
        assert_eq!(
            speech_input("google-translate-tts::zh-CN", &json!({"input":"hi"}))
                .unwrap()
                .1,
            "zh-CN"
        );
        assert!(speech_input("google-tts", &json!({"input":"hi"})).is_err());
        assert!(decode_audio(
            json!([["wrb.fr", "wrong-rpc", "[\"AQID\"]"]])
                .to_string()
                .as_bytes()
        )
        .is_err());
        assert_eq!(
            bootstrap_field(r#"{"FdrFJe":"escaped\"token"}"#, "FdrFJe").unwrap(),
            "escaped\"token"
        );
    }
}
