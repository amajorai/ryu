//! Authenticated phone-assistant control API.
//!
//! Twilio remains the PSTN carrier. Gateway owns the account credential, maps
//! configured phone lines to Core agents, and proxies only bounded live-call
//! controls to the corresponding authenticated media session.

use std::{collections::HashSet, net::SocketAddr};

use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, Method, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    api::{config::require_local_admin, voice_calls},
    config::{GatewayConfig, PhoneCallLineConfig, PhoneCallsConfig},
    error::GatewayError,
    pipeline::{authenticate, AuthInputs},
    state::SharedState,
};

mod calls;
mod numbers;
mod support;

pub use calls::{control_call, handoff_call, hangup_call, start_call};
pub use numbers::{available_numbers, purchase_number, verify_caller_id};
pub(crate) use support::authorize;
use support::*;

const TWILIO_ACCOUNT_SID_ENV: &str = "RYU_TWILIO_ACCOUNT_SID";
const TWILIO_AUTH_TOKEN_ENV: &str = "RYU_TWILIO_AUTH_TOKEN";
const TWILIO_CALLS_PATH: &str = "Calls";
/// The 503 answer to an outbound call on a line at its simultaneous-call cap.
pub(crate) const PHONE_LINE_BUSY: &str = "phone line is at its simultaneous-call limit";
const TWILIO_API_ORIGIN: &str = "https://api.twilio.com";
/// Points Twilio REST requests at a local fake in tests; other builds always
/// use [`TWILIO_API_ORIGIN`].
#[cfg(test)]
pub(crate) const TWILIO_API_ORIGIN_TEST_ENV: &str = "RYU_TEST_TWILIO_API_ORIGIN";

#[derive(Clone)]
struct TwilioCredentials {
    account_sid: String,
    auth_token: String,
}

#[derive(Debug, Deserialize)]
struct TwilioCallsResponse {
    #[serde(default)]
    calls: Vec<TwilioCallRecord>,
}

#[derive(Debug, Deserialize)]
struct TwilioCallerIdsResponse {
    #[serde(default)]
    outgoing_caller_ids: Vec<TwilioCallerId>,
}

#[derive(Debug, Deserialize)]
struct TwilioCallerId {
    phone_number: String,
}

#[derive(Debug, Deserialize)]
struct TwilioCallRecord {
    sid: String,
    status: String,
    direction: String,
    from: String,
    to: String,
    start_time: Option<String>,
    end_time: Option<String>,
    duration: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TwilioAvailableNumbersResponse {
    #[serde(default)]
    available_phone_numbers: Vec<TwilioAvailableNumber>,
}

#[derive(Debug, Deserialize)]
struct TwilioAvailableNumber {
    phone_number: String,
    friendly_name: String,
    locality: Option<String>,
    region: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TwilioPurchasedNumber {
    sid: String,
    phone_number: String,
}

#[derive(Debug, Deserialize)]
struct TwilioCallerIdVerification {
    call_sid: String,
    phone_number: String,
    validation_code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PhoneCallRecordView {
    call_sid: String,
    conversation_id: String,
    line_id: Option<String>,
    status: String,
    direction: String,
    from: String,
    to: String,
    start_time: Option<String>,
    end_time: Option<String>,
    duration: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PhoneCallLineView {
    id: String,
    label: String,
    twilio_number: String,
    caller_id: String,
    agent_id: Option<String>,
    tts_engine: Option<String>,
    tts_voice: Option<String>,
    transfer_to: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneCallsResponse {
    enabled: bool,
    twilio_configured: bool,
    provider_configured: bool,
    webhook_url: Option<String>,
    lines: Vec<PhoneCallLineView>,
    calls: Vec<PhoneCallRecordView>,
    verified_caller_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartPhoneCallRequest {
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: String,
    pub line_id: String,
    pub to: String,
    pub goal: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartPhoneCallResponse {
    call_sid: Option<String>,
    conversation_id: Option<String>,
    idempotency_key: String,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPhoneCallRequest {
    pub content: Option<String>,
    pub action: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneCallLineRequest {
    pub line_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneCallActionResponse {
    ok: bool,
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AvailableNumbersQuery {
    pub country_code: String,
    pub area_code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurchasePhoneNumberRequest {
    pub phone_number: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifyCallerIdRequest {
    pub phone_number: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AvailablePhoneNumberView {
    friendly_name: String,
    locality: Option<String>,
    phone_number: String,
    region: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailablePhoneNumbersView {
    numbers: Vec<AvailablePhoneNumberView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchasedPhoneNumberView {
    phone_number: String,
    sid: String,
    voice_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyCallerIdView {
    call_sid: String,
    phone_number: String,
    validation_code: String,
}

pub async fn list_calls(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<PhoneCallsResponse>, GatewayError> {
    authorize(&state, &peer, &headers, "Phone call access").await?;
    let config = load_phone_config()?;
    let lines = config
        .lines
        .iter()
        .map(line_view)
        .collect::<Vec<PhoneCallLineView>>();
    let webhook_url = voice_calls::public_url("/voice/twilio/answer")
        .ok()
        .filter(|url| url.starts_with("https://"));
    let Ok(credentials) = TwilioCredentials::from_env() else {
        return Ok(Json(PhoneCallsResponse {
            enabled: config.enabled,
            twilio_configured: false,
            provider_configured: false,
            webhook_url,
            lines,
            calls: Vec::new(),
            verified_caller_ids: Vec::new(),
        }));
    };

    let response: TwilioCallsResponse = twilio_request(
        &state,
        &credentials,
        Method::GET,
        TWILIO_CALLS_PATH,
        &[("PageSize", "100".to_owned())],
    )
    .await?;
    let phone_numbers = config
        .lines
        .iter()
        .flat_map(|line| {
            [
                line.twilio_number.as_str(),
                line.caller_id.as_str(),
                line.transfer_to.as_deref().unwrap_or_default(),
            ]
        })
        .collect::<HashSet<_>>();
    let mut calls = Vec::new();
    for call in response.calls {
        if !(phone_numbers.contains(call.from.as_str()) || phone_numbers.contains(call.to.as_str()))
        {
            continue;
        }
        let line_id = state
            .phone_calls
            .get_intent_for_call(&call.sid)
            .await
            .map(|intent| intent.line_id)
            .or_else(|| {
                config
                    .lines
                    .iter()
                    .find(|line| line.twilio_number == call.to || line.twilio_number == call.from)
                    .map(|line| line.id.clone())
            })
            .or_else(|| {
                config
                    .lines
                    .iter()
                    .find(|line| line.caller_id == call.from)
                    .map(|line| line.id.clone())
            });
        let Some(conversation_id) =
            voice_calls::conversation_id(&credentials.account_sid, &call.sid)
        else {
            continue;
        };
        calls.push(PhoneCallRecordView {
            conversation_id,
            line_id,
            call_sid: call.sid,
            status: call.status,
            direction: call.direction,
            from: call.from,
            to: call.to,
            start_time: call.start_time,
            end_time: call.end_time,
            duration: call.duration,
        });
    }
    let verified_caller_ids = load_verified_caller_ids(&state, &credentials).await?;
    Ok(Json(PhoneCallsResponse {
        enabled: config.enabled,
        twilio_configured: true,
        provider_configured: voice_provider_ready(),
        webhook_url,
        lines,
        calls,
        verified_caller_ids: verified_caller_ids.into_iter().collect(),
    }))
}

#[cfg(test)]
mod tests;
