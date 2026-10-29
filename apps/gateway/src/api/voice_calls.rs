//! Authenticated inbound PSTN voice bridge.
//!
//! Twilio owns the phone number and sends a bidirectional Media Streams
//! WebSocket. Gateway verifies the Twilio signature, translates μ-law/8 kHz
//! frames through the shared channel codec, and proxies the normalized audio to
//! Core's existing `/api/voice/ws` session. Provider credentials remain
//! environment-backed until the phone connection has a control-plane owner.

use std::collections::BTreeMap;

use axum::{
    extract::{
        ws::{WebSocket, WebSocketUpgrade},
        Form, Path, State,
    },
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use tokio_tungstenite::{connect_async, tungstenite::Message as CoreMessage};

use crate::{config::GatewayConfig, state::SharedState};
use ryu_gw_channels::voice_call::{
    decode_twilio_audio, parse_twilio_event, twilio_clear_message, twilio_media_payload_message,
    validate_twilio_start, wav_to_twilio_audio, TwilioMediaEvent, TWILIO_MULAW_FRAME_BYTES,
};

mod stream;
mod support;

use stream::handle_twilio_stream;
use support::*;
pub(crate) use support::{conversation_id, core_voice_configured, public_url, stream_twiml};

const TWILIO_AUTH_TOKEN_ENV: &str = "RYU_TWILIO_AUTH_TOKEN";
const PUBLIC_URL_ENV: &str = "RYU_VOICE_CALL_PUBLIC_URL";
/// The Core origin and bearer the voice bridge dials: the same `CORE_URL` and
/// `CORE_TOKEN` Core injects for `providers.core`.
const CORE_URL_ENV: &str = "CORE_URL";
const CORE_TOKEN_ENV: &str = "CORE_TOKEN";
/// Retired: the agent comes only from the line's `agent_id`. Nothing reads this;
/// the security fixture still sets it to prove the line value alone is used.
#[cfg(test)]
const AGENT_ID_ENV: &str = "RYU_VOICE_CALL_AGENT_ID";
const ANSWER_PATH: &str = "/voice/twilio/answer";
const STREAM_PATH: &str = "/voice/twilio/stream";

type HmacSha1 = Hmac<Sha1>;
type HmacSha256 = Hmac<Sha256>;

/// Twilio's inbound voice webhook. It returns `<Connect><Stream>` only after
/// signature verification and a complete public/core configuration is present.
pub async fn twilio_answer(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Form(params): Form<BTreeMap<String, String>>,
) -> Response {
    let answer_url = match public_url(ANSWER_PATH) {
        Ok(url) => url,
        Err(message) => return service_unavailable(message),
    };
    let Some(auth_token) = env_value(TWILIO_AUTH_TOKEN_ENV) else {
        return service_unavailable("Twilio voice is not configured");
    };
    if !verify_twilio_signature(
        &answer_url,
        &params,
        headers.get("x-twilio-signature"),
        &auth_token,
    ) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if core_voice_config().is_err() {
        return service_unavailable("Core voice bridge credentials are not configured");
    }

    let config = match GatewayConfig::load() {
        Ok(config) => config,
        Err(error) => {
            tracing::warn!(%error, "phone-call config could not be loaded");
            return service_unavailable("phone-call routing is unavailable");
        }
    };
    let Some(to_number) = params.get("To") else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Some(line) = config
        .channels
        .phone_calls
        .lines
        .iter()
        .find(|line| line.twilio_number == *to_number)
    else {
        tracing::warn!(
            to_number,
            "inbound Twilio call has no configured phone line"
        );
        return StatusCode::NOT_FOUND.into_response();
    };
    if !config.channels.phone_calls.enabled {
        return service_unavailable("phone assistant is disabled");
    }

    let stream_url = match public_url(STREAM_PATH).and_then(|url| websocket_url(&url)) {
        Ok(url) => url,
        Err(message) => return service_unavailable(message),
    };
    let remote_identity = params
        .get("From")
        .map(String::as_str)
        .filter(|value| is_e164_phone_number(value))
        .unwrap_or("unknown");
    // Caller controls run before any speech, model or voice work starts: an
    // unlisted caller (when the line has an allowlist) is rejected, and a line
    // already at its simultaneous-call cap answers busy.
    if !line.accepts_caller(remote_identity) {
        tracing::warn!(line = %line.id, "inbound call from a caller outside the line allowlist rejected");
        return reject_twiml("rejected");
    }
    let account_id = params.get("AccountSid").map(String::as_str).unwrap_or("");
    let call_id = params.get("CallSid").map(String::as_str).unwrap_or("");
    if conversation_id(account_id, call_id).is_none() {
        return (StatusCode::BAD_REQUEST, "invalid Twilio call identity").into_response();
    }
    // Take the call's slot now, atomically, before the TwiML promises it a
    // stream: counting only live streams here would let every call that rings
    // before an earlier stream opens past the cap. The media stream takes over
    // this slot; a call whose stream never starts gives it back shortly.
    if !state
        .phone_calls
        .try_reserve(call_id, &line.id, line.concurrent_call_limit())
        .await
    {
        tracing::warn!(line = %line.id, "phone line is at its simultaneous-call limit; answering busy");
        return reject_twiml("busy");
    }
    let xml = bound_stream_twiml(
        &stream_url,
        &line.id,
        "inbound",
        Some(remote_identity),
        account_id,
        call_id,
        &auth_token,
    );

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
        .body(axum::body::Body::from(xml))
        .expect("static TwiML response headers are valid")
        .into_response()
}

/// Outbound calls arrive here after Twilio accepts the call and requests TwiML.
/// The private intent id exists before the Calls API request, so this works even
/// when Twilio answers before the REST call returns. Retries with the same Call
/// SID return the same TwiML context.
pub async fn twilio_outbound_answer(
    State(state): State<SharedState>,
    Path(intent_id): Path<String>,
    headers: HeaderMap,
    Form(params): Form<BTreeMap<String, String>>,
) -> Response {
    if !valid_intent_id(&intent_id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let answer_url = match public_url(&format!("{OUTBOUND_ANSWER_PATH}/{intent_id}")) {
        Ok(url) => url,
        Err(message) => return service_unavailable(message),
    };
    let Some(auth_token) = env_value(TWILIO_AUTH_TOKEN_ENV) else {
        return service_unavailable("Twilio voice is not configured");
    };
    if !verify_twilio_signature(
        &answer_url,
        &params,
        headers.get("x-twilio-signature"),
        &auth_token,
    ) {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let Some(intent) = state.phone_calls.get_intent(&intent_id).await else {
        return StatusCode::GONE.into_response();
    };
    let call_id = params
        .get("CallSid")
        .map(String::as_str)
        .unwrap_or("unknown-call");
    if !valid_call_sid(call_id)
        || !state
            .phone_calls
            .record_call_sid(&intent_id, call_id)
            .await
            .unwrap_or(false)
    {
        return StatusCode::CONFLICT.into_response();
    }
    let config = match GatewayConfig::load() {
        Ok(config) => config,
        Err(error) => {
            tracing::warn!(%error, "phone-call config could not be loaded for outbound call");
            return service_unavailable("phone-call routing is unavailable");
        }
    };
    let Some(line) = config
        .channels
        .phone_calls
        .lines
        .iter()
        .find(|line| line.id == intent.line_id)
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !config.channels.phone_calls.enabled {
        return service_unavailable("phone assistant is disabled");
    }

    let stream_url = match public_url(STREAM_PATH).and_then(|url| websocket_url(&url)) {
        Ok(url) => url,
        Err(message) => return service_unavailable(message),
    };
    let account_id = params.get("AccountSid").map(String::as_str).unwrap_or("");
    if conversation_id(account_id, call_id).is_none() {
        return (StatusCode::BAD_REQUEST, "invalid Twilio call identity").into_response();
    }
    if core_voice_config().is_err() {
        return service_unavailable("Core voice bridge credentials are not configured");
    }
    let xml = bound_stream_twiml(
        &stream_url,
        &line.id,
        "outbound",
        None,
        account_id,
        call_id,
        &auth_token,
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/xml; charset=utf-8")
        .body(axum::body::Body::from(xml))
        .expect("static TwiML response headers are valid")
        .into_response()
}

/// Twilio status callbacks reconcile an outbound request if Gateway lost the
/// response to the Calls API. They are signed and idempotently bind the Call SID
/// to the already-persisted outbound intent. A call that ends before its media
/// stream starts gives back the line slot it held while it rang.
pub async fn twilio_status(
    State(state): State<SharedState>,
    Path(intent_id): Path<String>,
    headers: HeaderMap,
    Form(params): Form<BTreeMap<String, String>>,
) -> Response {
    if !valid_intent_id(&intent_id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let status_url = match public_url(&format!("{OUTBOUND_STATUS_PATH}/{intent_id}")) {
        Ok(url) => url,
        Err(message) => return service_unavailable(message),
    };
    let Some(auth_token) = env_value(TWILIO_AUTH_TOKEN_ENV) else {
        return service_unavailable("Twilio voice is not configured");
    };
    if !verify_twilio_signature(
        &status_url,
        &params,
        headers.get("x-twilio-signature"),
        &auth_token,
    ) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(call_sid) = params.get("CallSid") else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if !valid_call_sid(call_sid)
        || !state
            .phone_calls
            .record_call_sid(&intent_id, call_sid)
            .await
            .unwrap_or(false)
    {
        return StatusCode::CONFLICT.into_response();
    }
    if params
        .get("CallStatus")
        .is_some_and(|status| is_terminal_call_status(status))
    {
        state.phone_calls.release_reservation(call_sid).await;
    }
    StatusCode::NO_CONTENT.into_response()
}

/// Twilio call statuses after which the call can no longer start a stream.
fn is_terminal_call_status(status: &str) -> bool {
    matches!(
        status,
        "completed" | "busy" | "failed" | "no-answer" | "canceled"
    )
}

/// Twilio's bidirectional media stream. This route is public at the HTTP layer
/// because Twilio initiates it; the handler performs the provider signature and
/// configuration checks before upgrading.
pub async fn twilio_stream(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if uri.path() != STREAM_PATH || uri.query().is_some() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let stream_http_url = match public_url(STREAM_PATH) {
        Ok(url) => url,
        Err(message) => return service_unavailable(message),
    };
    let stream_url = match websocket_url(&stream_http_url) {
        Ok(url) => url,
        Err(message) => return service_unavailable(message),
    };
    let Some(auth_token) = env_value(TWILIO_AUTH_TOKEN_ENV) else {
        return service_unavailable("Twilio voice is not configured");
    };
    let signature = headers.get("x-twilio-signature");
    if !verify_twilio_signature(&stream_url, &BTreeMap::new(), signature, &auth_token)
        && !verify_twilio_signature(
            &format!("{stream_url}/"),
            &BTreeMap::new(),
            signature,
            &auth_token,
        )
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if core_voice_config().is_err() {
        return service_unavailable("Core voice bridge credentials are not configured");
    }

    ws.on_upgrade(move |socket| handle_twilio_stream(socket, state, auth_token))
        .into_response()
}

#[cfg(test)]
mod tests;

#[cfg(test)]
#[path = "voice_calls_security_tests.rs"]
mod security_tests;
