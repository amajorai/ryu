//! TwiML, URL, signature and Core-session helpers for the voice bridge.
use super::*;

pub(super) const OUTBOUND_ANSWER_PATH: &str = "/voice/twilio/outbound";
pub(super) const OUTBOUND_STATUS_PATH: &str = "/voice/twilio/status";
pub(super) const PHONE_CALL_SUMMARY_PREFIX: &str = "RYU_PHONE_CALL_SUMMARY:";

pub(crate) fn stream_twiml(
    stream_url: &str,
    line_id: &str,
    call_kind: &str,
    caller_number: Option<&str>,
) -> String {
    let mut xml =
        String::from(r#"<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url=""#);
    xml.push_str(&xml_escape(stream_url));
    xml.push_str(r#"">"#);
    xml.push_str(&format!(
        r#"<Parameter name="lineId" value="{}"/><Parameter name="callKind" value="{}"/>"#,
        xml_escape(line_id),
        xml_escape(call_kind),
    ));
    if let Some(caller_number) = caller_number {
        xml.push_str(&format!(
            r#"<Parameter name="callerNumber" value="{}"/>"#,
            xml_escape(caller_number),
        ));
    }
    xml.push_str("</Stream></Connect></Response>");
    xml
}

pub(super) fn stream_binding(
    account: &str,
    call: &str,
    token: &str,
    line: &str,
    kind: &str,
    caller: Option<&str>,
) -> String {
    let mut mac =
        HmacSha256::new_from_slice(token.as_bytes()).expect("HMAC accepts any key length");
    mac.update(b"ryu:twilio-stream-routing:v1\0");
    let identity_binding = call_binding(account, call, token);
    for value in [identity_binding.as_str(), line, kind, caller.unwrap_or("")] {
        mac.update(&(value.len() as u64).to_be_bytes());
        mac.update(value.as_bytes());
    }
    hex::encode(mac.finalize().into_bytes())
}

pub(super) fn bound_stream_twiml(
    stream_url: &str,
    line: &str,
    kind: &str,
    caller: Option<&str>,
    account: &str,
    call: &str,
    token: &str,
) -> String {
    let xml = stream_twiml(stream_url, line, kind, caller);
    let binding = stream_binding(account, call, token, line, kind, caller);
    let conversation = conversation_id(account, call).expect("validated call identity");
    xml.replace("</Stream>", &format!(r#"<Parameter name="conversationId" value="{conversation}"/><Parameter name="callBinding" value="{binding}"/></Stream>"#))
}

pub(super) fn valid_intent_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn valid_call_sid(value: &str) -> bool {
    value.len() == 34
        && value.starts_with("CA")
        && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn is_e164_phone_number(value: &str) -> bool {
    value.strip_prefix('+').is_some_and(|digits| {
        (8..=15).contains(&digits.len()) && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

pub(super) fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub(crate) fn public_url(path: &str) -> Result<String, &'static str> {
    let base = env_value(PUBLIC_URL_ENV).ok_or("public voice-call URL is not configured")?;
    if !(base.starts_with("https://") || base.starts_with("http://"))
        || base.contains('?')
        || base.contains('#')
    {
        return Err("public voice-call URL must be an http(s) origin without query or fragment");
    }
    Ok(format!("{}{}", base.trim_end_matches('/'), path))
}

pub(super) fn websocket_url(http_url: &str) -> Result<String, &'static str> {
    if let Some(rest) = http_url.strip_prefix("https://") {
        return Ok(format!("wss://{rest}"));
    }
    Err("Twilio Media Streams require an https public URL for wss")
}

/// True when the Core URL and bearer the voice bridge dials are both set.
pub(crate) fn core_voice_configured() -> bool {
    env_value(CORE_URL_ENV).is_some() && env_value(CORE_TOKEN_ENV).is_some()
}

pub(super) fn core_voice_config() -> anyhow::Result<(reqwest::Url, String)> {
    let base = env_value(CORE_URL_ENV)
        .ok_or_else(|| anyhow::anyhow!("Core voice URL is not configured"))?;
    let token = env_value(CORE_TOKEN_ENV)
        .ok_or_else(|| anyhow::anyhow!("Core voice token is not configured"))?;
    let url = reqwest::Url::parse(&base)?;
    match url.scheme() {
        "http" | "https" => {}
        _ => anyhow::bail!("Core voice URL must use http(s)"),
    }
    if !url.username().is_empty() || url.password().is_some() {
        anyhow::bail!("Core voice URL cannot contain credentials");
    }
    Ok((url, token))
}

pub(super) async fn core_ws_url(conversation: &str) -> anyhow::Result<String> {
    let (mut url, token) = core_voice_config()?;
    url.set_path("/api/ws/ticket");
    url.set_query(None);
    url.set_fragment(None);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    let mut response = client
        .post(url.clone())
        .bearer_auth(token)
        .json(&serde_json::json!({ "route": "voice", "roomId": conversation }))
        .send()
        .await?
        .error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len().saturating_add(chunk.len()) > 16 * 1024 {
            anyhow::bail!("Core voice ticket response exceeded limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    let response: Value = serde_json::from_slice(&bytes)?;
    let ticket = response["ticket"]
        .as_str()
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 256
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
        .ok_or_else(|| anyhow::anyhow!("Core voice ticket was invalid"))?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme)
        .map_err(|_| anyhow::anyhow!("Core voice URL scheme could not be changed"))?;
    url.set_path("/api/voice/ws");
    url.set_query(None);
    url.query_pairs_mut().append_pair("ticket", ticket);
    Ok(url.to_string())
}

pub(super) fn verify_twilio_signature(
    url: &str,
    params: &BTreeMap<String, String>,
    provided: Option<&axum::http::HeaderValue>,
    auth_token: &str,
) -> bool {
    let Some(provided) = provided.and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let mut input = url.to_owned();
    for (key, value) in params {
        input.push_str(key);
        input.push_str(value);
    }
    let Ok(mut mac) = HmacSha1::new_from_slice(auth_token.as_bytes()) else {
        return false;
    };
    mac.update(input.as_bytes());
    let expected = BASE64.encode(mac.finalize().into_bytes());
    constant_time_equal(expected.as_bytes(), provided.as_bytes())
}

pub(super) fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (a, b) in left.iter().zip(right) {
        difference |= a ^ b;
    }
    difference == 0
}

pub(super) fn valid_twilio_sid(value: &str, prefix: &str) -> bool {
    value.len() == 34
        && value.starts_with(prefix)
        && value.as_bytes()[2..].iter().all(u8::is_ascii_hexdigit)
}

pub(crate) fn conversation_id(account_id: &str, call_id: &str) -> Option<String> {
    if !valid_twilio_sid(account_id, "AC") || !valid_twilio_sid(call_id, "CA") {
        return None;
    }
    let mut hash = Sha256::new();
    hash.update(b"ryu:twilio-call:v1\0");
    hash.update(account_id.to_ascii_lowercase());
    hash.update(call_id.to_ascii_lowercase());
    Some(format!("phone_call_v1_{}", hex::encode(hash.finalize())))
}

pub(super) fn call_binding(account_id: &str, call_id: &str, token: &str) -> String {
    let mut mac =
        HmacSha256::new_from_slice(token.as_bytes()).expect("HMAC accepts any key length");
    mac.update(b"ryu:twilio-stream-call:v1\0");
    mac.update(account_id.to_ascii_lowercase().as_bytes());
    mac.update(call_id.to_ascii_lowercase().as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// The `start` frame that opens Core's voice session for one call. An
/// unverified caller's frame says so explicitly with `caller_trusted: false`,
/// which makes Core run that session under its restricted tool profile. The
/// owner's sessions omit the field, as every other voice client does; Core
/// treats absent and `true` alike, so the field can only ever restrict.
pub(super) fn core_start_frame(
    conversation: &str,
    agent_id: Option<&str>,
    tts_engine: Option<&str>,
    tts_voice: Option<&str>,
    caller_trusted: bool,
) -> Value {
    let mut frame = serde_json::json!({
        "type": "start", "sample_rate": 8_000,
        "conversation_id": conversation,
        "agent_id": agent_id,
        "tts_engine": tts_engine,
        "tts_voice": tts_voice,
    });
    if !caller_trusted {
        frame["caller_trusted"] = Value::Bool(false);
    }
    frame
}

pub(super) fn inbound_opening_prompt(
    label: &str,
    greeting: &str,
    caller_number: &str,
    transfer_to: Option<&str>,
    caller_trusted: bool,
) -> String {
    let mut prompt = format!(
        "RYU_PHONE_CALL_CONTEXT: Answer an inbound call for {label}. Greet the caller naturally, say you are the AI assistant, and ask how you can help. The caller's number is {caller_number}."
    );
    if !caller_trusted {
        // Caller ID is spoofable and this line has no allowlist entry for the
        // caller: they are an outside party, not the account owner.
        prompt.push_str(
            " This caller is not on the owner's trusted-caller list and has not been verified as the owner. Do not reveal the owner's private information (memories, messages, contacts, calendar, files or account details) and do not take actions on the owner's accounts or devices for them; take a message or offer a transfer instead.",
        );
    }
    if let Some(transfer_to) = transfer_to {
        prompt.push_str(&format!(
            " If the caller needs the account owner, offer a live transfer to {transfer_to}."
        ));
    }
    if !greeting.trim().is_empty() {
        prompt.push_str(" Follow this owner's greeting preference: ");
        prompt.push_str(greeting.trim());
    }
    prompt
}

pub(super) fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub(super) fn pcm_bytes(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

/// TwiML that refuses the call without answering it (`rejected` or `busy`), so
/// no speech, model or voice session starts.
pub(super) fn reject_twiml(reason: &'static str) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
        .body(axum::body::Body::from(format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Reject reason=\"{reason}\"/></Response>"
        )))
        .expect("static TwiML response headers are valid")
}

pub(super) fn service_unavailable(message: &'static str) -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, message).into_response()
}
