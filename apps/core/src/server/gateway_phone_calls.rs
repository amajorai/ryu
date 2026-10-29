//! Owner-only proxy for Gateway PSTN call controls.
//!
//! The mobile client talks to Core with its normal identity. Core enforces
//! `gateway.configure` and adds the Gateway admin credential server-side, so
//! neither Twilio nor Gateway secrets enter the app.

use super::ServerState;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use reqwest::Method;
use serde_json::{json, Value};

const INTERNAL_CALL_SUMMARY_PREFIX: &str = "RYU_PHONE_CALL_SUMMARY:";
const INTERNAL_CALL_CONTEXT_PREFIX: &str = "RYU_PHONE_CALL_CONTEXT:";

fn is_internal_call_message(content: &str) -> bool {
    content.starts_with(INTERNAL_CALL_SUMMARY_PREFIX)
        || content.starts_with(INTERNAL_CALL_CONTEXT_PREFIX)
}

#[utoipa::path(
    get,
    path = "/api/gateway/phone-calls",
    tag = "Gateway",
    summary = "List recent PSTN assistant calls",
    responses((status = 200, description = "Recent call records", body = serde_json::Value))
)]
pub(crate) async fn list(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> (StatusCode, Json<Value>) {
    proxy(
        State(state),
        caller,
        Method::GET,
        String::new(),
        Vec::new(),
        None,
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/gateway/phone-calls",
    tag = "Gateway",
    summary = "Start an outbound PSTN assistant call",
    request_body = serde_json::Value,
    responses((status = 201, description = "Call created", body = serde_json::Value))
)]
pub(crate) async fn start(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    proxy(
        State(state),
        caller,
        Method::POST,
        String::new(),
        Vec::new(),
        Some(body),
    )
    .await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AvailableNumbersQuery {
    country_code: String,
    area_code: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/gateway/phone-calls/numbers/available",
    tag = "Gateway",
    summary = "Search available Twilio voice numbers",
    params(
        ("countryCode" = String, Query, description = "Two-letter ISO country code"),
        ("areaCode" = Option<String>, Query, description = "Optional area code")
    ),
    responses((status = 200, description = "Available numbers", body = serde_json::Value))
)]
pub(crate) async fn available_numbers(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Query(query): Query<AvailableNumbersQuery>,
) -> (StatusCode, Json<Value>) {
    let mut query_pairs = vec![("countryCode".to_owned(), query.country_code)];
    if let Some(area_code) = query.area_code {
        query_pairs.push(("areaCode".to_owned(), area_code));
    }
    proxy(
        State(state),
        caller,
        Method::GET,
        "/numbers/available".to_owned(),
        query_pairs,
        None,
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/gateway/phone-calls/numbers",
    tag = "Gateway",
    summary = "Purchase a Twilio voice number",
    request_body = serde_json::Value,
    responses((status = 201, description = "Number purchased", body = serde_json::Value))
)]
pub(crate) async fn purchase_number(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    proxy(
        State(state),
        caller,
        Method::POST,
        "/numbers".to_owned(),
        Vec::new(),
        Some(body),
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/gateway/phone-calls/caller-id-verifications",
    tag = "Gateway",
    summary = "Start verification of an existing caller ID",
    request_body = serde_json::Value,
    responses((status = 200, description = "Caller-ID verification started", body = serde_json::Value))
)]
pub(crate) async fn verify_caller_id(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    proxy(
        State(state),
        caller,
        Method::POST,
        "/caller-id-verifications".to_owned(),
        Vec::new(),
        Some(body),
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/gateway/phone-calls/{call_sid}/control",
    tag = "Gateway",
    summary = "Guide or interrupt a live PSTN assistant call",
    params(("call_sid" = String, Path, description = "Twilio Call SID")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Live-call instruction accepted", body = serde_json::Value))
)]
pub(crate) async fn control(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(call_sid): Path<String>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    if !valid_call_sid(&call_sid) {
        return (StatusCode::BAD_REQUEST, json_body("invalid Twilio call id"));
    }
    proxy(
        State(state),
        caller,
        Method::POST,
        format!("/{call_sid}/control"),
        Vec::new(),
        Some(body),
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/gateway/phone-calls/{call_sid}/handoff",
    tag = "Gateway",
    summary = "Transfer a live PSTN call to its configured human contact",
    params(("call_sid" = String, Path, description = "Twilio Call SID")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Call transferred", body = serde_json::Value))
)]
pub(crate) async fn handoff(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(call_sid): Path<String>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    if !valid_call_sid(&call_sid) {
        return (StatusCode::BAD_REQUEST, json_body("invalid Twilio call id"));
    }
    proxy(
        State(state),
        caller,
        Method::POST,
        format!("/{call_sid}/handoff"),
        Vec::new(),
        Some(body),
    )
    .await
}

#[utoipa::path(
    post,
    path = "/api/gateway/phone-calls/{call_sid}/hangup",
    tag = "Gateway",
    summary = "End a live PSTN assistant call",
    params(("call_sid" = String, Path, description = "Twilio Call SID")),
    responses((status = 200, description = "Call ended", body = serde_json::Value))
)]
pub(crate) async fn hangup(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(call_sid): Path<String>,
) -> (StatusCode, Json<Value>) {
    if !valid_call_sid(&call_sid) {
        return (StatusCode::BAD_REQUEST, json_body("invalid Twilio call id"));
    }
    proxy(
        State(state),
        caller,
        Method::POST,
        format!("/{call_sid}/hangup"),
        Vec::new(),
        None,
    )
    .await
}

#[utoipa::path(
    get,
    path = "/api/gateway/phone-calls/{call_sid}/transcript",
    tag = "Gateway",
    summary = "Read the Core conversation attached to a phone call",
    params(("call_sid" = String, Path, description = "Twilio Call SID")),
    responses((status = 200, description = "Phone call transcript and summary", body = serde_json::Value))
)]
pub(crate) async fn transcript(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(call_sid): Path<String>,
) -> (StatusCode, Json<Value>) {
    if !valid_call_sid(&call_sid) {
        return (StatusCode::BAD_REQUEST, json_body("invalid Twilio call id"));
    }
    let (status, Json(calls)) = proxy(
        State(state.clone()),
        caller.clone(),
        Method::GET,
        String::new(),
        Vec::new(),
        None,
    )
    .await;
    if !status.is_success() {
        return (status, Json(calls));
    }
    let conversation_id = calls
        .get("calls")
        .and_then(Value::as_array)
        .and_then(|calls| {
            calls
                .iter()
                .find(|call| call.get("callSid").and_then(Value::as_str) == Some(call_sid.as_str()))
        })
        .and_then(|call| call.get("conversationId"))
        .and_then(Value::as_str);
    let Some(conversation_id) = conversation_id else {
        return (StatusCode::NOT_FOUND, json_body("phone call was not found"));
    };
    let mut messages = match state.conversations.get_messages(conversation_id).await {
        Ok(messages) => messages,
        Err(error) => {
            tracing::warn!(%error, "phone-call transcript load failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                json_body("phone-call transcript is unavailable"),
            );
        }
    };
    messages.retain(|message| !is_internal_call_message(&message.content));
    (
        StatusCode::OK,
        Json(json!({"conversationId": conversation_id, "messages": messages})),
    )
}

async fn proxy(
    State(state): State<ServerState>,
    caller: Option<crate::identity_verify::VerifiedCaller>,
    method: Method,
    suffix: String,
    query: Vec<(String, String)>,
    body: Option<Value>,
) -> (StatusCode, Json<Value>) {
    if enforce_phone_permission(&state, &caller).await.is_err() {
        return (
            StatusCode::FORBIDDEN,
            json_body("insufficient permissions: gateway.configure"),
        );
    }

    use crate::sidecar::gateway::{gateway_admin_key, gateway_url};
    let raw_url = format!(
        "{}/v1/phone-calls{}",
        gateway_url().trim_end_matches('/'),
        suffix
    );
    let mut url = match reqwest::Url::parse(&raw_url) {
        Ok(url) => url,
        Err(_) => {
            return (
                StatusCode::BAD_GATEWAY,
                json_body("Gateway phone service URL is invalid"),
            );
        }
    };
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    let mut request = state
        .client
        .request(method, url)
        .timeout(std::time::Duration::from_secs(30));
    if let Some(token) = gateway_admin_key() {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }

    match request.send().await {
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({"reachable": false, "error": "Gateway phone service is unavailable"})),
        ),
        Ok(response) => {
            let status =
                StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let body = response
                .json::<Value>()
                .await
                .unwrap_or_else(|_| json!({"error": "Gateway returned invalid JSON"}));
            (status, Json(body))
        }
    }
}

async fn enforce_phone_permission(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> Result<(), ()> {
    crate::server::enforce_permission(
        state,
        caller,
        crate::identity_verify::permissions::GATEWAY_CONFIGURE,
    )
    .await
    .map_err(|_| ())
}

fn valid_call_sid(value: &str) -> bool {
    value.len() == 34
        && value.starts_with("CA")
        && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn json_body(message: &str) -> Json<Value> {
    Json(json!({ "error": message }))
}

#[cfg(test)]
mod tests {
    use super::is_internal_call_message;

    #[test]
    fn transcript_hides_gateway_context_and_summary_instructions() {
        assert!(is_internal_call_message(
            "RYU_PHONE_CALL_CONTEXT: Ask about the delivery date"
        ));
        assert!(is_internal_call_message(
            "RYU_PHONE_CALL_SUMMARY: Summarize the call"
        ));
        assert!(!is_internal_call_message("I can help you with that."));
    }
}
