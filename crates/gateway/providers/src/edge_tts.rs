//! Opt-in, unofficial anonymous Microsoft consumer TTS. This is not Azure Speech.
//! Protocol grounding: maintained rany2/edge-tts consumer WebSocket implementation.
//! Fixed host/headers; no accounts, ambient keys, user cookies or caller SSML.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_tungstenite::{
    tungstenite::{
        handshake::{client::generate_key, derive_accept_key},
        protocol::{Role, WebSocketConfig},
        Message,
    },
    WebSocketStream,
};

use crate::egress::send_with_egress_captured;
use crate::{EgressClientPool, Provider, ProviderError, ProviderQuotas};

pub const EDGE_TTS_CLASSIFICATION: &str = "unofficial_anonymous_consumer";
const BASE_URL: &str =
    "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
// Public consumer protocol identifier, not a secret or an operator API key.
const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const GEC_VERSION: &str = "1-143.0.3650.75";
const ORIGIN: &str = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
const USER_AGENT:&str="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
const DEFAULT_VOICE: &str = "en-US-EmmaMultilingualNeural";
const OUTPUT_FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";
const MAX_INPUT_BYTES: usize = 8192;
const MAX_CHUNK_BYTES: usize = 4096;
const MAX_CHUNKS: usize = 16;
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_AUDIO_BYTES: usize = 16 * 1024 * 1024;
const MAX_HEADERS_BYTES: usize = 8192;
const MAX_SESSION_FRAMES: usize = 2048;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const IDLE_TIMEOUT: Duration = Duration::from_secs(10);
const SESSION_TIMEOUT: Duration = Duration::from_secs(30);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(90);

fn invalid(message: &'static str) -> ProviderError {
    ProviderError::Provider(message.into())
}
fn uncertain(message: &'static str) -> ProviderError {
    ProviderError::DeliveryUncertain(message.into())
}

fn sec_ms_gec(unix_seconds: i64) -> Result<String, ProviderError> {
    let seconds = unix_seconds
        .checked_add(11_644_473_600)
        .filter(|seconds| *seconds >= 0)
        .ok_or_else(|| invalid("Edge consumer clock is invalid"))?;
    let rounded = seconds - seconds % 300;
    let ticks = u64::try_from(rounded)
        .ok()
        .and_then(|seconds| seconds.checked_mul(10_000_000))
        .ok_or_else(|| invalid("Edge consumer clock is invalid"))?;
    let mut hash = Sha256::new();
    hash.update(ticks.to_string().as_bytes());
    hash.update(TRUSTED_CLIENT_TOKEN.as_bytes());
    Ok(format!("{:X}", hash.finalize()))
}

fn timestamp(unix_seconds: i64) -> Result<String, ProviderError> {
    let date = chrono::DateTime::<chrono::Utc>::from_timestamp(unix_seconds, 0)
        .ok_or_else(|| invalid("Edge consumer clock is invalid"))?;
    Ok(date
        .format("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)")
        .to_string())
}

fn corrected_time(now: i64, date: &str) -> Result<i64, ProviderError> {
    chrono::DateTime::parse_from_rfc2822(date)
        .ok()
        .map(|date| date.timestamp())
        .filter(|server| server.abs_diff(now) <= 86_400)
        .ok_or_else(|| invalid("Edge consumer clock correction is unavailable"))
}

fn valid_voice(voice: &str) -> bool {
    if voice.len() > 100
        || !voice
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return false;
    }
    let parts = voice.split('-').collect::<Vec<_>>();
    parts.len() >= 3
        && (2..=3).contains(&parts[0].len())
        && parts[0].bytes().all(|byte| byte.is_ascii_lowercase())
        && parts[1].len() == 2
        && parts[1].bytes().all(|byte| byte.is_ascii_uppercase())
        && parts[2..].iter().all(|part| !part.is_empty())
        && parts
            .last()
            .is_some_and(|name| name.ends_with("Neural") && name.len() > 6)
}

fn xml_escape(value: &str) -> String {
    let mut result = String::new();
    for character in value.chars() {
        match character {
            '&' => result.push_str("&amp;"),
            '<' => result.push_str("&lt;"),
            '>' => result.push_str("&gt;"),
            '\'' => result.push_str("&apos;"),
            '"' => result.push_str("&quot;"),
            other => result.push(other),
        }
    }
    result
}

fn escaped_chunks(text: &str) -> Result<Vec<String>, ProviderError> {
    if text.trim().is_empty()
        || text.len() > MAX_INPUT_BYTES
        || text.chars().any(|character| {
            (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
                || matches!(character, '\u{fffe}' | '\u{ffff}')
        })
    {
        return Err(invalid(
            "Edge TTS input text is invalid or exceeds its limit",
        ));
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    for character in text.chars() {
        let atom = xml_escape(&character.to_string());
        if current.len() + atom.len() > MAX_CHUNK_BYTES {
            chunks.push(std::mem::take(&mut current));
        }
        current.push_str(&atom);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    if chunks.len() > MAX_CHUNKS {
        return Err(invalid("Edge TTS input exceeds chunk limit"));
    }
    Ok(chunks)
}

fn prosody(
    value: Option<&Value>,
    suffix: &str,
    minimum: i32,
    maximum: i32,
) -> Result<String, ProviderError> {
    let Some(value) = value else {
        return Ok(format!("+0{suffix}"));
    };
    let value = value
        .as_str()
        .ok_or_else(|| invalid("Edge TTS prosody must be signed bounded text"))?;
    let number = value
        .strip_suffix(suffix)
        .ok_or_else(|| invalid("Edge TTS prosody unit is invalid"))?;
    if !matches!(number.as_bytes().first(), Some(b'+' | b'-'))
        || number.len() < 2
        || !number[1..].bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(invalid("Edge TTS prosody is invalid"));
    }
    let number = number
        .parse::<i32>()
        .map_err(|_| invalid("Edge TTS prosody is invalid"))?;
    if !(minimum..=maximum).contains(&number) {
        return Err(invalid("Edge TTS prosody exceeds limit"));
    }
    Ok(format!("{number:+}{suffix}"))
}

struct SpeechRequest {
    voice: String,
    rate: String,
    pitch: String,
    volume: String,
    chunks: Vec<String>,
}
impl SpeechRequest {
    fn parse(model: &str, body: &Value) -> Result<Self, ProviderError> {
        let object = body
            .as_object()
            .ok_or_else(|| invalid("Edge TTS request must be an object"))?;
        if object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "model"
                    | "input"
                    | "voice"
                    | "response_format"
                    | "speed"
                    | "rate"
                    | "pitch"
                    | "volume"
            )
        }) {
            return Err(invalid("Edge TTS request contains unsupported fields"));
        }
        if body
            .get("response_format")
            .is_some_and(|value| value.as_str() != Some("mp3"))
        {
            return Err(invalid("Edge TTS currently returns MP3 only"));
        }
        if body
            .get("model")
            .is_some_and(|value| value.as_str().is_none())
        {
            return Err(invalid("Edge TTS requested model must be text"));
        }
        let model_voice = if model == "edge-tts" {
            None
        } else {
            let voice = model.strip_prefix("edge-tts::").unwrap_or(model);
            if !valid_voice(voice) {
                return Err(invalid("Edge TTS model or voice is invalid"));
            }
            Some(voice)
        };
        let requested_voice = body
            .get("voice")
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| invalid("Edge TTS voice must be text"))
            })
            .transpose()?;
        if model_voice
            .zip(requested_voice)
            .is_some_and(|(model, voice)| model != voice)
        {
            return Err(invalid("Edge TTS model and voice disagree"));
        }
        let voice = requested_voice.or(model_voice).unwrap_or(DEFAULT_VOICE);
        if !valid_voice(voice) {
            return Err(invalid("Edge TTS voice is invalid"));
        }
        let text = body["input"]
            .as_str()
            .ok_or_else(|| invalid("Edge TTS input text is required"))?;
        let rate = if let Some(speed) = body.get("speed") {
            if body.get("rate").is_some() {
                return Err(invalid("choose Edge TTS speed or rate"));
            }
            let speed = speed
                .as_f64()
                .filter(|speed| speed.is_finite() && (0.5..=2.0).contains(speed))
                .ok_or_else(|| invalid("Edge TTS speed exceeds limit"))?;
            format!("{:+}%", ((speed - 1.0) * 100.0).round() as i32)
        } else {
            prosody(body.get("rate"), "%", -50, 100)?
        };
        Ok(Self {
            voice: voice.into(),
            rate,
            pitch: prosody(body.get("pitch"), "Hz", -50, 50)?,
            volume: prosody(body.get("volume"), "%", -100, 100)?,
            chunks: escaped_chunks(text)?,
        })
    }
    fn ssml(&self, escaped_text: &str) -> String {
        format!("<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='{}'><prosody pitch='{}' rate='{}' volume='{}'>{escaped_text}</prosody></voice></speak>",xml_escape(&self.voice),xml_escape(&self.pitch),xml_escape(&self.rate),xml_escape(&self.volume))
    }
}

fn config_message(now: i64) -> Result<String, ProviderError> {
    let payload = json!({"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":OUTPUT_FORMAT}}}});
    Ok(format!("X-Timestamp:{}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{payload}\r\n",timestamp(now)?))
}
fn ssml_message(request_id: &str, now: i64, ssml: &str) -> Result<String, ProviderError> {
    Ok(format!("X-RequestId:{request_id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{}Z\r\nPath:ssml\r\n\r\n{ssml}",timestamp(now)?))
}

fn headers(block: &[u8]) -> Result<HashMap<&str, &str>, ProviderError> {
    if block.len() > MAX_HEADERS_BYTES {
        return Err(uncertain("Edge audio frame headers exceed limit"));
    }
    let text =
        std::str::from_utf8(block).map_err(|_| uncertain("Edge frame headers are invalid"))?;
    let mut result = HashMap::new();
    for line in text.split("\r\n").filter(|line| !line.is_empty()) {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| uncertain("Edge frame headers are invalid"))?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || result
                .keys()
                .any(|key: &&str| key.eq_ignore_ascii_case(name))
        {
            return Err(uncertain("Edge frame headers are invalid"));
        }
        result.insert(name, value.trim());
    }
    Ok(result)
}
fn header<'a>(values: &HashMap<&'a str, &'a str>, name: &str) -> Option<&'a str> {
    values
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| *value)
}
enum Frame<'a> {
    Audio(&'a [u8]),
    End,
    Ignore,
}
fn parse_binary(frame: &[u8]) -> Result<Frame<'_>, ProviderError> {
    if frame.len() < 2 || frame.len() > MAX_FRAME_BYTES {
        return Err(uncertain("Edge binary audio frame size is invalid"));
    }
    let length = usize::from(u16::from_be_bytes([frame[0], frame[1]]));
    let end = 2_usize
        .checked_add(length)
        .filter(|end| *end <= frame.len())
        .ok_or_else(|| uncertain("Edge binary audio header length is invalid"))?;
    let values = headers(&frame[2..end])?;
    if header(&values, "Path") != Some("audio") {
        return Err(uncertain("Edge binary frame is not audio"));
    }
    let data = &frame[end..];
    match header(&values, "Content-Type") {
        Some("audio/mpeg") if !data.is_empty() => Ok(Frame::Audio(data)),
        None if data.is_empty() => Ok(Frame::Ignore),
        _ => Err(uncertain("Edge audio frame content is invalid")),
    }
}
fn parse_text(frame: &str) -> Result<Frame<'_>, ProviderError> {
    if frame.len() > MAX_FRAME_BYTES {
        return Err(uncertain("Edge text frame exceeds limit"));
    }
    let (block, _) = frame
        .split_once("\r\n\r\n")
        .ok_or_else(|| uncertain("Edge text frame delimiter is missing"))?;
    let values = headers(block.as_bytes())?;
    match header(&values, "Path") {
        Some("turn.end") => Ok(Frame::End),
        Some("turn.start" | "response" | "audio.metadata") => Ok(Frame::Ignore),
        _ => Err(uncertain("Edge text frame path is invalid")),
    }
}

struct AudioAccumulator {
    bytes: Vec<u8>,
    ended: bool,
    frames: usize,
}
impl AudioAccumulator {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            ended: false,
            frames: 0,
        }
    }
    fn apply(&mut self, frame: Frame<'_>) -> Result<(), ProviderError> {
        self.frames += 1;
        if self.frames > MAX_SESSION_FRAMES || self.ended {
            return Err(uncertain("Edge session frame sequence is invalid"));
        }
        match frame {
            Frame::Audio(data) => {
                if data.len() > MAX_AUDIO_BYTES.saturating_sub(self.bytes.len()) {
                    return Err(uncertain("Edge session audio exceeds limit"));
                }
                self.bytes.extend_from_slice(data);
            }
            Frame::End => self.ended = true,
            Frame::Ignore => {}
        }
        Ok(())
    }
    fn finish(self) -> Result<Vec<u8>, ProviderError> {
        if !self.ended || self.bytes.is_empty() {
            Err(uncertain("Edge session ended without completed audio"))
        } else {
            Ok(self.bytes)
        }
    }
}

pub struct EdgeTtsProvider {
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    quota: Arc<ProviderQuotas>,
    #[cfg(test)]
    endpoint: Option<String>,
    #[cfg(test)]
    clock: Option<i64>,
}
impl EdgeTtsProvider {
    pub fn new(
        anonymous_consumer_opt_in: bool,
        egress: Option<Arc<EgressClientPool>>,
        quota: Arc<ProviderQuotas>,
    ) -> Result<Self, ProviderError> {
        if !anonymous_consumer_opt_in {
            return Err(invalid(
                "Edge TTS requires explicit unofficial anonymous opt-in",
            ));
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .http1_only()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| invalid("Edge consumer HTTP client initialization failed"))?;
        Ok(Self {
            client,
            egress,
            quota,
            #[cfg(test)]
            endpoint: None,
            #[cfg(test)]
            clock: None,
        })
    }
    fn now(&self) -> i64 {
        #[cfg(test)]
        if let Some(now) = self.clock {
            return now;
        }
        chrono::Utc::now().timestamp()
    }
    fn endpoint(&self) -> &str {
        #[cfg(test)]
        if let Some(endpoint) = &self.endpoint {
            return endpoint;
        }
        BASE_URL
    }
    fn handshake(
        &self,
        client: &reqwest::Client,
        now: i64,
        key: &str,
        connection: &str,
    ) -> Result<reqwest::RequestBuilder, ProviderError> {
        Ok(client
            .get(self.endpoint())
            .version(reqwest::Version::HTTP_11)
            .query(&[
                ("TrustedClientToken", TRUSTED_CLIENT_TOKEN.to_owned()),
                ("ConnectionId", connection.to_owned()),
                ("Sec-MS-GEC", sec_ms_gec(now)?),
                ("Sec-MS-GEC-Version", GEC_VERSION.to_owned()),
            ])
            .header("Origin", ORIGIN)
            .header("User-Agent", USER_AGENT)
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Pragma", "no-cache")
            .header("Cache-Control", "no-cache")
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header("Sec-WebSocket-Key", key)
            .header(
                "Cookie",
                format!(
                    "muid={};",
                    uuid::Uuid::new_v4().simple().to_string().to_uppercase()
                ),
            )
            .timeout(CONNECT_TIMEOUT))
    }
    async fn connect(
        &self,
        selected: Option<&reqwest::Client>,
        allow_skew_retry: bool,
    ) -> Result<(WebSocketStream<reqwest::Upgraded>, reqwest::Client, i64), ProviderError> {
        let mut now = self.now();
        let mut selected = selected.cloned();
        for attempt in 0..2 {
            let key = generate_key();
            let connection = uuid::Uuid::new_v4().simple().to_string();
            let template = self
                .handshake(
                    selected.as_ref().unwrap_or(&self.client),
                    now,
                    &key,
                    &connection,
                )?
                .build()
                .map_err(|_| invalid("Edge consumer handshake could not be constructed"))?;
            let (response, client) = if let Some(client) = &selected {
                let response = reqwest::RequestBuilder::from_parts(client.clone(), template)
                    .send()
                    .await
                    .map_err(|_| uncertain("Edge consumer connection delivery is uncertain"))?;
                (response, client.clone())
            } else {
                send_with_egress_captured(
                    &self.client,
                    self.egress.as_deref(),
                    Some(&connection),
                    "edge-tts",
                    0,
                    |client| {
                        reqwest::RequestBuilder::from_parts(
                            client.clone(),
                            template.try_clone().expect("buffered Edge handshake"),
                        )
                    },
                )
                .await?
            };
            let status = response.status();
            if status == reqwest::StatusCode::FORBIDDEN && attempt == 0 && allow_skew_retry {
                let date = response
                    .headers()
                    .get(reqwest::header::DATE)
                    .and_then(|date| date.to_str().ok())
                    .ok_or_else(|| invalid("Edge consumer clock correction is unavailable"))?;
                now = corrected_time(now, date)?;
                selected = Some(client);
                continue;
            }
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let limit = crate::parse_rate_limit(response.headers());
                let retry_after = limit.as_ref().and_then(|limit| limit.retry_after);
                let reset_at = limit.as_ref().and_then(|limit| limit.reset_at);
                self.quota
                    .record_rate_limited("edge-tts", retry_after, reset_at);
                return Err(ProviderError::RateLimited {
                    provider: "edge-tts".into(),
                    retry_after,
                    reset_at,
                });
            }
            if status != reqwest::StatusCode::SWITCHING_PROTOCOLS {
                return Err(invalid("Edge consumer WebSocket handshake was rejected"));
            }
            let upgrade = response
                .headers()
                .get(reqwest::header::UPGRADE)
                .and_then(|value| value.to_str().ok());
            let connection = response
                .headers()
                .get(reqwest::header::CONNECTION)
                .and_then(|value| value.to_str().ok());
            let accept = response
                .headers()
                .get("Sec-WebSocket-Accept")
                .and_then(|value| value.to_str().ok());
            if !upgrade.is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
                || !connection.is_some_and(|value| {
                    value
                        .split(',')
                        .any(|value| value.trim().eq_ignore_ascii_case("upgrade"))
                })
                || accept != Some(derive_accept_key(key.as_bytes()).as_str())
            {
                return Err(invalid(
                    "Edge consumer WebSocket handshake validation failed",
                ));
            }
            let upgraded = response
                .upgrade()
                .await
                .map_err(|_| uncertain("Edge consumer connection upgrade failed"))?;
            let config = WebSocketConfig {
                write_buffer_size: 8192,
                max_write_buffer_size: 65536,
                max_message_size: Some(MAX_FRAME_BYTES),
                max_frame_size: Some(MAX_FRAME_BYTES),
                ..Default::default()
            };
            return Ok((
                WebSocketStream::from_raw_socket(upgraded, Role::Client, Some(config)).await,
                client,
                now,
            ));
        }
        Err(invalid("Edge consumer clock correction was rejected"))
    }
    async fn session(
        &self,
        request: &SpeechRequest,
        chunk: &str,
        selected: Option<&reqwest::Client>,
        allow_skew_retry: bool,
    ) -> Result<(Vec<u8>, reqwest::Client), ProviderError> {
        let (mut socket, client, now) = self.connect(selected, allow_skew_retry).await?;
        socket
            .send(Message::Text(config_message(now)?))
            .await
            .map_err(|_| uncertain("Edge speech configuration delivery failed"))?;
        let id = uuid::Uuid::new_v4().simple().to_string();
        socket
            .send(Message::Text(ssml_message(&id, now, &request.ssml(chunk))?))
            .await
            .map_err(|_| uncertain("Edge speech request delivery failed"))?;
        let mut audio = AudioAccumulator::new();
        let mut frames_received = 0;
        loop {
            let message = tokio::time::timeout(IDLE_TIMEOUT, socket.next())
                .await
                .map_err(|_| uncertain("Edge audio receive deadline exceeded"))?
                .ok_or_else(|| uncertain("Edge session closed before turn end"))?
                .map_err(|_| uncertain("Edge audio receive failed"))?;
            frames_received += 1;
            if frames_received > MAX_SESSION_FRAMES {
                return Err(uncertain("Edge session frame count exceeds limit"));
            }
            match message {
                Message::Binary(bytes) => audio.apply(parse_binary(&bytes)?)?,
                Message::Text(text) => audio.apply(parse_text(&text)?)?,
                Message::Ping(bytes) => socket
                    .send(Message::Pong(bytes))
                    .await
                    .map_err(|_| uncertain("Edge session keepalive failed"))?,
                Message::Pong(_) => {}
                Message::Close(_) => return Err(uncertain("Edge session closed before turn end")),
                _ => return Err(uncertain("Edge session message is invalid")),
            }
            if audio.ended {
                break;
            }
        }
        let bytes = audio.finish()?;
        let _ = tokio::time::timeout(Duration::from_secs(1), socket.close(None)).await;
        Ok((bytes, client))
    }
    async fn speech(&self, model: &str, body: &Value) -> Result<Value, ProviderError> {
        let request = SpeechRequest::parse(model, body)?;
        let run = async {
            let mut audio = Vec::new();
            let mut selected = None;
            for chunk in &request.chunks {
                let result = tokio::time::timeout(
                    SESSION_TIMEOUT,
                    self.session(&request, chunk, selected.as_ref(), audio.is_empty()),
                )
                .await
                .map_err(|_| uncertain("Edge speech session deadline exceeded"))?;
                let (bytes, client) = match result {
                    Ok(result) => result,
                    Err(_) if !audio.is_empty() => {
                        return Err(uncertain(
                            "Edge utterance delivery is uncertain after audio",
                        ))
                    }
                    Err(error) => return Err(error),
                };
                if bytes.len() > MAX_AUDIO_BYTES.saturating_sub(audio.len()) {
                    return Err(uncertain("Edge utterance audio exceeds limit"));
                }
                audio.extend_from_slice(&bytes);
                selected = Some(client);
            }
            Ok(
                json!({"object":"audio","data":[{"b64_json":base64::engine::general_purpose::STANDARD.encode(audio),"content_type":"audio/mpeg"}],"raw":Value::Null}),
            )
        };
        tokio::time::timeout(TOTAL_TIMEOUT, run)
            .await
            .map_err(|_| uncertain("Edge utterance deadline exceeded"))?
    }
}

impl Provider for EdgeTtsProvider {
    fn name(&self) -> &'static str {
        "edge-tts"
    }
    fn has_rotating_accounts(&self) -> bool {
        self.egress.as_ref().is_some_and(|pool| pool.len() > 1)
    }
    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async { Err(invalid("Edge consumer TTS does not support chat")) })
    }
    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<axum::body::Body, ProviderError>> + Send + 'a>> {
        Box::pin(async { Err(invalid("Edge consumer TTS does not support chat")) })
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn provider(endpoint: &str) -> EdgeTtsProvider {
        let mut provider =
            EdgeTtsProvider::new(true, None, Arc::new(ProviderQuotas::new())).unwrap();
        provider.endpoint = Some(endpoint.into());
        provider.clock = Some(1_700_000_000);
        provider
    }
    fn binary(headers: &str, audio: &[u8]) -> Vec<u8> {
        let mut frame = (headers.len() as u16).to_be_bytes().to_vec();
        frame.extend_from_slice(headers.as_bytes());
        frame.extend_from_slice(audio);
        frame
    }
    fn audio(bytes: &[u8]) -> Message {
        Message::Binary(binary(
            "X-RequestId:fixture\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n",
            bytes,
        ))
    }

    #[test]
    fn sec_ms_gec_has_fixed_integer_vectors_and_five_minute_boundaries() {
        assert_eq!(
            sec_ms_gec(0).unwrap(),
            "7ECB79D14E3AA576D2D79E6D487A1388156D91E614B1BE11C64226A29BC8DD8C"
        );
        assert_eq!(
            sec_ms_gec(1_700_000_000).unwrap(),
            "42301B335578FEFDAE2637DED1ABD614505D432559EC08032B82048483726AFF"
        );
        assert_eq!(
            sec_ms_gec(1_700_000_099).unwrap(),
            sec_ms_gec(1_700_000_000).unwrap()
        );
        assert_eq!(
            sec_ms_gec(1_700_000_100).unwrap(),
            "AE4CF72E466874182A75878E20EADA83D29A1C12CAD9C3E0E014CCE0BFA55880"
        );
        assert!(sec_ms_gec(i64::MAX).is_err());
        assert!(sec_ms_gec(i64::MIN).is_err());
        assert!(timestamp(0)
            .unwrap()
            .ends_with("GMT+0000 (Coordinated Universal Time)"));
    }

    #[test]
    fn ssml_escapes_text_attributes_and_never_splits_utf8_or_entities() {
        let text = "&<>'\"🙂".repeat(700);
        let chunks = escaped_chunks(&text).unwrap();
        assert_eq!(chunks.concat(), xml_escape(&text));
        assert!(chunks.iter().all(|chunk| chunk.len() <= MAX_CHUNK_BYTES));
        assert!(chunks
            .iter()
            .all(|chunk| !chunk.ends_with('&') && !chunk.ends_with("&amp")));
        let mut request=SpeechRequest::parse("edge-tts",&json!({"input":"<&hello> \"world\"","voice":"vi-VN-HoaiMyNeural","rate":"+20%","pitch":"-10Hz","volume":"+0%"})).unwrap();
        let ssml = request.ssml(&request.chunks[0]);
        assert!(ssml.contains("&lt;&amp;hello&gt; &quot;world&quot;"));
        assert!(ssml.contains("pitch='-10Hz' rate='+20%'"));
        request.voice = "voice' attribute=\"injection\"".into();
        assert!(request
            .ssml("safe")
            .contains("voice&apos; attribute=&quot;injection&quot;"));
    }

    #[test]
    fn bounded_request_rejects_raw_ssml_headers_arbitrary_routes_and_voice_mismatch() {
        for body in [
            json!({"input":"text","ssml":"<speak>raw</speak>"}),
            json!({"input":"text","url":"https://private.example"}),
            json!({"input":"text","headers":{}}),
            json!({"input":"text","voice":"en-US-X'InjectedNeural"}),
            json!({"input":"text","rate":"+999%"}),
            json!({"input":"text","pitch":"+1Hz'"}),
            json!({"input":"text","volume":"100%"}),
            json!({"input":"text","speed":0.1}),
            json!({"input":"text","speed":1,"rate":"+0%"}),
            json!({"input":"text","response_format":"wav"}),
            json!({"input":"x".repeat(MAX_INPUT_BYTES+1)}),
            json!({"input":"bad\u{0000}text"}),
        ] {
            assert!(SpeechRequest::parse("edge-tts", &body).is_err());
        }
        assert!(SpeechRequest::parse("tts-1", &json!({"input":"text"})).is_err());
        assert!(SpeechRequest::parse(
            "edge-tts::en-US-AriaNeural",
            &json!({"input":"text","voice":"vi-VN-HoaiMyNeural"})
        )
        .is_err());
        assert_eq!(
            SpeechRequest::parse("vi-VN-HoaiMyNeural", &json!({"input":"text"}))
                .unwrap()
                .voice,
            "vi-VN-HoaiMyNeural"
        );
        assert_eq!(
            SpeechRequest::parse("edge-tts", &json!({"input":"text","speed":1.5}))
                .unwrap()
                .rate,
            "+50%"
        );
        assert!(EdgeTtsProvider::new(false, None, Arc::new(ProviderQuotas::new())).is_err());
    }

    #[test]
    fn binary_and_turn_parsers_require_bounded_audio_and_complete_turn_end() {
        let mut accumulator = AudioAccumulator::new();
        accumulator
            .apply(
                parse_binary(&binary(
                    "Path:audio\r\nContent-Type:audio/mpeg\r\n",
                    &[1, 2],
                ))
                .unwrap(),
            )
            .unwrap();
        accumulator
            .apply(
                parse_binary(&binary("Path:audio\r\nContent-Type:audio/mpeg\r\n", &[3])).unwrap(),
            )
            .unwrap();
        accumulator
            .apply(parse_text("Path:turn.end\r\n\r\n").unwrap())
            .unwrap();
        assert_eq!(accumulator.finish().unwrap(), vec![1, 2, 3]);
        for frame in [
            vec![0],
            vec![255, 255, 1],
            binary("Path:not-audio\r\n", &[1]),
            binary("Path:audio\r\n", &[1]),
            binary("Path:audio\r\nContent-Type:audio/mpeg\r\n", &[]),
            binary("Path:audio\r\nContent-Type:text/plain\r\n", &[1]),
            binary("Path:audio\r\nPath:audio\r\n", &[]),
        ] {
            assert!(parse_binary(&frame).is_err());
        }
        assert!(matches!(
            parse_binary(&binary("Path:audio\r\n", &[])).unwrap(),
            Frame::Ignore
        ));
        let mut no_audio = AudioAccumulator::new();
        no_audio.apply(Frame::End).unwrap();
        assert!(no_audio.finish().is_err());
        let mut incomplete = AudioAccumulator::new();
        incomplete.apply(Frame::Audio(&[1])).unwrap();
        assert!(incomplete.finish().is_err());
        assert!(parse_text("Path:turn.end").is_err());
        assert!(parse_text("Path:secret\r\n\r\n").is_err());
    }

    #[test]
    fn clock_skew_is_bounded_and_invalid_server_date_is_never_echoed() {
        let date = chrono::DateTime::<chrono::Utc>::from_timestamp(1_700_000_300, 0)
            .unwrap()
            .to_rfc2822();
        assert_eq!(corrected_time(1_700_000_000, &date).unwrap(), 1_700_000_300);
        assert!(corrected_time(0, &date).is_err());
        let error = corrected_time(1_700_000_000, "private-secret-date").unwrap_err();
        assert!(!error.to_string().contains("private-secret"));
    }

    #[test]
    fn production_handshake_has_only_fixed_consumer_host_origin_and_protocol_identifiers() {
        let provider = EdgeTtsProvider::new(true, None, Arc::new(ProviderQuotas::new())).unwrap();
        let request = provider
            .handshake(
                &provider.client,
                1_700_000_000,
                "synthetic-websocket-key",
                "synthetic-connection",
            )
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(request.url().scheme(), "https");
        assert_eq!(request.url().host_str(), Some("speech.platform.bing.com"));
        assert_eq!(request.headers().get("Origin").unwrap(), ORIGIN);
        assert_eq!(
            request.headers().get("Sec-WebSocket-Version").unwrap(),
            "13"
        );
        assert!(request.headers().get("Authorization").is_none());
        assert!(
            request
                .url()
                .query_pairs()
                .any(|(key, value)| key == "Sec-MS-GEC"
                    && value == sec_ms_gec(1_700_000_000).unwrap())
        );
        assert_eq!(EDGE_TTS_CLASSIFICATION, "unofficial_anonymous_consumer");
    }

    async fn serve_completed(stream: tokio::net::TcpStream) -> Vec<String> {
        let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        let mut sent = Vec::new();
        for _ in 0..2 {
            let message = socket.next().await.unwrap().unwrap();
            let Message::Text(text) = message else {
                panic!("expected speech text");
            };
            sent.push(text);
        }
        socket.send(audio(&[1, 2])).await.unwrap();
        socket.send(audio(&[3, 4])).await.unwrap();
        socket
            .send(Message::Text("Path:turn.end\r\n\r\n".into()))
            .await
            .unwrap();
        sent
    }

    #[tokio::test]
    async fn actual_websocket_emits_config_then_escaped_ssml_and_normalizes_mp3() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "http://{}/consumer/speech/synthesize/readaloud/edge/v1",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            serve_completed(stream).await
        });
        let response = provider(&endpoint)
            .synthesize_speech(
                "edge-tts",
                &json!({"input":"<hello &world>","voice":"en-US-AriaNeural"}),
            )
            .await
            .unwrap();
        assert_eq!(response["object"], "audio");
        assert_eq!(response["data"][0]["b64_json"], "AQIDBA==");
        assert_eq!(response["data"][0]["content_type"], "audio/mpeg");
        assert!(response["raw"].is_null());
        let messages = server.await.unwrap();
        assert!(messages[0].contains("Path:speech.config"));
        assert!(messages[0].contains(OUTPUT_FORMAT));
        assert!(messages[1].contains("Path:ssml"));
        assert!(messages[1].contains("&lt;hello &amp;world&gt;"));
        assert!(messages[1].contains(
            "X-Timestamp:Tue Nov 14 2023 22:13:20 GMT+0000 (Coordinated Universal Time)Z\r\n"
        ));
    }

    #[tokio::test]
    async fn malformed_no_audio_and_partial_audio_close_never_open_second_session() {
        for message in [
            Message::Text("Path:turn.end\r\n\r\n".into()),
            Message::Binary(vec![0]),
            audio(&[1, 2]),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let seen = Arc::new(AtomicUsize::new(0));
            let server_seen = Arc::clone(&seen);
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                server_seen.fetch_add(1, Ordering::SeqCst);
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                socket.next().await.unwrap().unwrap();
                socket.next().await.unwrap().unwrap();
                socket.send(message).await.unwrap();
                socket.close(None).await.unwrap();
                assert!(
                    tokio::time::timeout(Duration::from_millis(150), listener.accept())
                        .await
                        .is_err()
                );
            });
            let error = provider(&endpoint)
                .synthesize_speech("edge-tts", &json!({"input":"hello"}))
                .await
                .unwrap_err();
            assert!(matches!(error, ProviderError::DeliveryUncertain(_)));
            server.await.unwrap();
            assert_eq!(seen.load(Ordering::SeqCst), 1);
        }
    }

    async fn reject_http(mut stream: tokio::net::TcpStream, status: u16, date: Option<&str>) {
        let mut input = vec![0; 8192];
        let mut used = 0;
        loop {
            let read = stream.read(&mut input[used..]).await.unwrap();
            assert!(read > 0);
            used += read;
            if input[..used].windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
            assert!(used < input.len());
        }
        let header = date
            .map(|date| format!("Date: {date}\r\n"))
            .unwrap_or_default();
        let response = format!(
            "HTTP/1.1 {status} Rejected\r\n{header}Content-Length: 0\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    }

    #[tokio::test]
    async fn forbidden_valid_date_retries_once_without_speech_before_acceptance() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let date = chrono::DateTime::<chrono::Utc>::from_timestamp(1_700_000_300, 0)
            .unwrap()
            .to_rfc2822();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            reject_http(stream, 403, Some(&date)).await;
            let (stream, _) = listener.accept().await.unwrap();
            serve_completed(stream).await
        });
        assert!(provider(&endpoint)
            .synthesize_speech("edge-tts", &json!({"input":"hello"}))
            .await
            .is_ok());
        let sent = server.await.unwrap();
        assert!(sent[1].contains("22:18:20"));
    }

    #[tokio::test]
    async fn forbidden_invalid_date_and_rate_limit_do_not_repeat_handshake_or_echo_protocol_tokens()
    {
        for status in [403, 429, 503] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                reject_http(stream, status, Some("private-invalid-date")).await;
                assert!(
                    tokio::time::timeout(Duration::from_millis(150), listener.accept())
                        .await
                        .is_err()
                );
            });
            let error = provider(&endpoint)
                .synthesize_speech("edge-tts", &json!({"input":"hello"}))
                .await
                .unwrap_err();
            assert!(!error.to_string().contains(TRUSTED_CLIENT_TOKEN));
            assert!(!error.to_string().contains("private-invalid"));
            if status == 429 {
                assert!(matches!(error, ProviderError::RateLimited { .. }));
            }
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn later_chunk_rejection_after_audio_has_no_skew_retry_and_is_uncertain() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let date = chrono::DateTime::<chrono::Utc>::from_timestamp(1_700_000_300, 0)
            .unwrap()
            .to_rfc2822();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            serve_completed(stream).await;
            let (stream, _) = listener.accept().await.unwrap();
            reject_http(stream, 403, Some(&date)).await;
            assert!(
                tokio::time::timeout(Duration::from_millis(150), listener.accept())
                    .await
                    .is_err()
            );
        });
        let error = provider(&endpoint)
            .synthesize_speech("edge-tts", &json!({"input":"a".repeat(MAX_CHUNK_BYTES+1)}))
            .await
            .unwrap_err();
        assert!(matches!(error, ProviderError::DeliveryUncertain(_)));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn all_chunks_keep_the_actual_submit_proxy_even_after_its_pool_binding_cools() {
        let first = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backup = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let clients = [first.local_addr().unwrap(), backup.local_addr().unwrap()]
            .into_iter()
            .map(|address| {
                reqwest::Client::builder()
                    .no_proxy()
                    .http1_only()
                    .proxy(reqwest::Proxy::all(format!("http://{address}")).unwrap())
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_secs(5))
                    .build()
                    .unwrap()
            })
            .collect();
        let pool = Arc::new(EgressClientPool::new(clients).unwrap());
        let shared_pool = Arc::clone(&pool);
        let server = tokio::spawn(async move {
            let (stream, _) = first.accept().await.unwrap();
            serve_completed(stream).await;
            shared_pool.record_failure(0, Some(300));
            let (stream, _) = first.accept().await.unwrap();
            serve_completed(stream).await;
        });
        let untouched = tokio::spawn(async move {
            assert!(
                tokio::time::timeout(Duration::from_millis(400), backup.accept())
                    .await
                    .is_err()
            );
        });
        let mut provider =
            provider("http://consumer.invalid/consumer/speech/synthesize/readaloud/edge/v1");
        provider.egress = Some(pool);
        let response = provider
            .synthesize_speech("edge-tts", &json!({"input":"a".repeat(MAX_CHUNK_BYTES+1)}))
            .await
            .unwrap();
        assert_eq!(
            response["data"][0]["b64_json"],
            base64::engine::general_purpose::STANDARD.encode([1, 2, 3, 4, 1, 2, 3, 4])
        );
        server.await.unwrap();
        untouched.await.unwrap();
    }
}
