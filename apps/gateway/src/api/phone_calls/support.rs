//! Access checks, line lookup, validation and the Twilio REST client.
use super::*;

pub(crate) async fn authorize(
    state: &SharedState,
    peer: &SocketAddr,
    headers: &HeaderMap,
    action: &str,
) -> Result<(), GatewayError> {
    let raw_key = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    let context = authenticate(state, AuthInputs::with_key(raw_key)).await?;
    require_local_admin(state, peer, context.is_master_key, headers, action)
}

pub(super) fn load_phone_config() -> Result<PhoneCallsConfig, GatewayError> {
    let config = GatewayConfig::load().map_err(|error| {
        GatewayError::Internal(anyhow::anyhow!(
            "could not load Gateway phone settings: {error}"
        ))
    })?;
    config
        .channels
        .phone_calls
        .validate()
        .map_err(GatewayError::BadRequest)?;
    Ok(config.channels.phone_calls)
}

pub(super) fn find_line<'a>(
    config: &'a PhoneCallsConfig,
    line_id: &str,
) -> Result<&'a PhoneCallLineConfig, GatewayError> {
    config
        .lines
        .iter()
        .find(|line| line.id == line_id)
        .ok_or_else(|| GatewayError::BadRequest("phone line was not found".to_owned()))
}

pub(super) fn line_view(line: &PhoneCallLineConfig) -> PhoneCallLineView {
    PhoneCallLineView {
        id: line.id.clone(),
        label: line.label.clone(),
        twilio_number: line.twilio_number.clone(),
        caller_id: line.caller_id.clone(),
        agent_id: line.agent_id.clone(),
        tts_engine: line.tts_engine.clone(),
        tts_voice: line.tts_voice.clone(),
        transfer_to: line.transfer_to.clone(),
    }
}

pub(super) fn outbound_caller_id(line: &PhoneCallLineConfig) -> &str {
    if line.caller_id.is_empty() {
        &line.twilio_number
    } else {
        &line.caller_id
    }
}

/// Refuse a caller ID Twilio will not place outbound calls from: one that is
/// neither the line's Twilio number nor verified on the account.
pub(super) async fn require_usable_caller_id(
    state: &SharedState,
    credentials: &TwilioCredentials,
    line: &PhoneCallLineConfig,
    caller_id: &str,
) -> Result<(), GatewayError> {
    if caller_id == line.twilio_number
        || load_verified_caller_ids(state, credentials)
            .await?
            .contains(caller_id)
    {
        return Ok(());
    }
    Err(GatewayError::BadRequest(
        "verify this caller ID with Twilio before placing outbound calls".to_owned(),
    ))
}

pub(super) async fn load_verified_caller_ids(
    state: &SharedState,
    credentials: &TwilioCredentials,
) -> Result<HashSet<String>, GatewayError> {
    let response: TwilioCallerIdsResponse = twilio_request(
        state,
        credentials,
        Method::GET,
        "OutgoingCallerIds",
        &[("PageSize", "100".to_owned())],
    )
    .await?;
    Ok(response
        .outgoing_caller_ids
        .into_iter()
        .map(|caller_id| caller_id.phone_number)
        .collect())
}

pub(super) fn is_e164(value: &str) -> bool {
    let Some(digits) = value.strip_prefix('+') else {
        return false;
    };
    (8..=15).contains(&digits.len()) && digits.bytes().all(|byte| byte.is_ascii_digit())
}

pub(super) fn valid_call_sid(value: &str) -> bool {
    value.len() == 34
        && value.starts_with("CA")
        && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn valid_idempotency_key(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

pub(super) fn is_definitive_twilio_rejection(error: &GatewayError) -> bool {
    matches!(error, GatewayError::ProviderError(message) if message.contains("Twilio returned HTTP 4"))
}

pub(super) fn validate_call_sid(value: &str) -> Result<(), GatewayError> {
    if valid_call_sid(value) {
        Ok(())
    } else {
        Err(GatewayError::BadRequest(
            "invalid Twilio call id".to_owned(),
        ))
    }
}

pub(super) fn outbound_opening_prompt(line: &PhoneCallLineConfig, goal: &str) -> String {
    let mut prompt = format!(
        "RYU_PHONE_CALL_CONTEXT: Make this call on behalf of {}. You are the account owner's AI phone assistant; identify yourself as an AI assistant. Goal: {}. Be concise and conversational, confirm important details, and do not invent facts or commitments.",
        line.label, goal
    );
    if let Some(transfer_to) = line.transfer_to.as_deref() {
        prompt.push_str(&format!(
            " If a decision needs the account owner, tell the caller you will connect them, then hand off to {transfer_to}."
        ));
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

impl TwilioCredentials {
    pub(super) fn from_env() -> Result<Self, GatewayError> {
        let account_sid = env_value(TWILIO_ACCOUNT_SID_ENV)
            .filter(|value| {
                value.len() == 34
                    && value.starts_with("AC")
                    && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
            })
            .ok_or_else(|| {
                GatewayError::ProviderError(
                    "Twilio calling is not configured on this Gateway".to_owned(),
                )
            })?;
        let auth_token = env_value(TWILIO_AUTH_TOKEN_ENV).ok_or_else(|| {
            GatewayError::ProviderError(
                "Twilio calling is not configured on this Gateway".to_owned(),
            )
        })?;
        Ok(Self {
            account_sid,
            auth_token,
        })
    }
}

pub(super) fn voice_provider_ready() -> bool {
    TwilioCredentials::from_env().is_ok()
        && voice_calls::public_url("/voice/twilio/stream")
            .is_ok_and(|url| url.starts_with("https://"))
        && voice_calls::core_voice_configured()
}

pub(super) async fn twilio_request<T: for<'de> Deserialize<'de>>(
    state: &SharedState,
    credentials: &TwilioCredentials,
    method: Method,
    resource: &str,
    form: &[(&str, String)],
) -> Result<T, GatewayError> {
    let url = format!(
        "{}/2010-04-01/Accounts/{}/{}.json",
        twilio_api_origin(),
        credentials.account_sid,
        resource
    );
    let mut request = state
        .http
        .request(method.clone(), url)
        .basic_auth(&credentials.account_sid, Some(&credentials.auth_token))
        .timeout(std::time::Duration::from_secs(10));
    request = if method == Method::GET {
        request.query(form)
    } else {
        request.form(form)
    };
    let response = request
        .send()
        .await
        .map_err(|_| GatewayError::ProviderError("Twilio request failed".to_owned()))?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|_| {
        GatewayError::ProviderError("Twilio returned an invalid response".to_owned())
    })?;
    if !status.is_success() {
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Twilio rejected the request");
        return Err(GatewayError::ProviderError(format!(
            "Twilio returned HTTP {}: {message}",
            status.as_u16()
        )));
    }
    serde_json::from_value(body).map_err(|_| {
        GatewayError::ProviderError("Twilio response was missing required fields".to_owned())
    })
}

pub(super) fn twilio_api_origin() -> String {
    #[cfg(test)]
    if let Some(origin) = env_value(TWILIO_API_ORIGIN_TEST_ENV) {
        return origin;
    }
    TWILIO_API_ORIGIN.to_owned()
}

pub(super) fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}
