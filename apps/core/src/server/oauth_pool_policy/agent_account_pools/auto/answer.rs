//! What one account's answer means for the next step, and the answers Core
//! gives itself when no account can serve.
//!
//! Only three kinds of answer move a request on to the next account: a usage
//! or rate limit (429), "this account has no access to this model", and an
//! account that cannot be used right now (401, 403, or the proxy's own 409
//! for a disabled account). Every other answer belongs to the request, not to
//! the account, and goes back to the caller as it is.

use std::time::Duration;

use axum::{
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

/// The longest a limited account is skipped, as in the proxies.
pub(crate) const MAX_WAIT: Duration = Duration::from_secs(32 * 24 * 60 * 60);

/// Reset deadlines in RFC 3339, as the Claude proxy reads them.
const RESET_HEADERS: [&str; 4] = [
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-reset",
    "anthropic-ratelimit-input-tokens-reset",
    "anthropic-ratelimit-output-tokens-reset",
];

/// The reset of a Claude subscription's five hour or weekly limit, in epoch
/// seconds.
const UNIFIED_RESET_HEADER: &str = "anthropic-ratelimit-unified-reset";

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Answer {
    /// The account served the request.
    Served,
    /// The account is at a limit, until the reset when the answer says.
    Limited(Option<Duration>),
    /// The account has no access to the requested model.
    NoModel,
    /// The account cannot be used right now (login, disabled); the proxy
    /// keeps its own memory of that.
    Skip,
    /// An answer about the request itself.
    Final,
}

/// The two wire formats Auto runs on, for the answers Core writes itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Vendor {
    Anthropic,
    OpenAi,
}

/// What an account's answer to a request for `model` means.
pub(crate) fn classify(
    status: StatusCode,
    headers: &HeaderMap,
    body: &[u8],
    model: &str,
) -> Answer {
    classify_at(status, headers, body, model, Utc::now())
}

pub(crate) fn classify_at(
    status: StatusCode,
    headers: &HeaderMap,
    body: &[u8],
    model: &str,
    now: DateTime<Utc>,
) -> Answer {
    if status.is_success() {
        return Answer::Served;
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Answer::Limited(limited_wait(headers, body, now));
    }
    if names_missing_model(status, body, model) {
        return Answer::NoModel;
    }
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::CONFLICT => Answer::Skip,
        _ => Answer::Final,
    }
}

fn until(deadline: DateTime<Utc>, now: DateTime<Utc>) -> Option<Duration> {
    (deadline - now).to_std().ok()
}

fn epoch(seconds: i64) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp(seconds, 0)
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// How long the answer says the account stays limited: the latest of
/// Retry-After, the subscription reset, the RFC 3339 reset headers and the
/// reset a ChatGPT limit answer carries in its body. `None` when it says
/// nothing.
pub(crate) fn limited_wait(
    headers: &HeaderMap,
    body: &[u8],
    now: DateTime<Utc>,
) -> Option<Duration> {
    let mut waits = Vec::new();
    waits.extend(
        header(headers, "retry-after")
            .and_then(|value| value.trim().parse::<u64>().ok())
            .map(Duration::from_secs),
    );
    waits.extend(header(headers, UNIFIED_RESET_HEADER).and_then(|value| {
        let value = value.trim();
        match value.parse::<i64>() {
            Ok(seconds) => epoch(seconds).and_then(|deadline| until(deadline, now)),
            Err(_) => DateTime::parse_from_rfc3339(value)
                .ok()
                .and_then(|deadline| until(deadline.with_timezone(&Utc), now)),
        }
    }));
    waits.extend(RESET_HEADERS.iter().filter_map(|name| {
        DateTime::parse_from_rfc3339(header(headers, name)?.trim())
            .ok()
            .and_then(|deadline| until(deadline.with_timezone(&Utc), now))
    }));
    if let Ok(body) = serde_json::from_slice::<Value>(body) {
        let error = body.get("error").unwrap_or(&body);
        waits.extend(
            error
                .get("resets_in_seconds")
                .and_then(Value::as_u64)
                .map(Duration::from_secs),
        );
        waits.extend(
            error
                .get("resets_at")
                .and_then(Value::as_i64)
                .and_then(epoch)
                .and_then(|deadline| until(deadline, now)),
        );
    }
    waits
        .into_iter()
        .filter(|wait| !wait.is_zero())
        .max()
        .map(|wait| wait.min(MAX_WAIT))
}

const NO_ACCESS: [&str; 10] = [
    "not supported",
    "not available",
    "not found",
    "does not exist",
    "do not have access",
    "does not have access",
    "no access",
    "not allowed",
    "not enabled",
    "unavailable",
];

fn texts(body: &Value) -> Vec<String> {
    let error = body.get("error").unwrap_or(body);
    let mut texts = Vec::new();
    for value in [error, body] {
        for key in ["message", "detail", "type", "code"] {
            if let Some(text) = value.get(key).and_then(Value::as_str) {
                texts.push(text.to_lowercase());
            }
        }
    }
    if let Some(text) = error.as_str() {
        texts.push(text.to_lowercase());
    }
    texts
}

/// Whether an error says this account cannot use the requested model, as
/// Anthropic (`not_found_error`, "model: <id>") and OpenAI and ChatGPT
/// (`model_not_found`, "The '<id>' model is not supported when using Codex
/// with a ChatGPT account") phrase it. The error must name the requested model
/// itself, so a request the vendor refuses for another reason ("temperature is
/// not supported with this model") never marks the account.
pub(crate) fn names_missing_model(status: StatusCode, body: &[u8], model: &str) -> bool {
    let model = model.trim().to_lowercase();
    if !matches!(status.as_u16(), 400 | 403 | 404) || model.is_empty() {
        return false;
    }
    let Ok(body) = serde_json::from_slice::<Value>(body) else {
        return false;
    };
    let texts = texts(&body);
    let names_model = texts.iter().any(|text| text.contains(&model));
    if names_model && texts.iter().any(|text| text == "model_not_found") {
        return true;
    }
    let not_found =
        status == StatusCode::NOT_FOUND && texts.iter().any(|text| text == "not_found_error");
    names_model
        && (not_found
            || texts
                .iter()
                .any(|text| NO_ACCESS.iter().any(|phrase| text.contains(phrase))))
}

fn about(wait: Duration) -> String {
    let minutes = wait.as_secs().div_ceil(60).max(1);
    match minutes {
        1 => "about 1 minute".to_owned(),
        2..=119 => format!("about {minutes} minutes"),
        _ => format!("about {} hours", (minutes + 30) / 60),
    }
}

fn error(vendor: Vendor, status: StatusCode, kind: &str, message: &str) -> Response {
    let body = match vendor {
        Vendor::Anthropic => json!({
            "type": "error",
            "error": { "type": kind, "message": message },
        }),
        Vendor::OpenAi => json!({
            "error": { "type": kind, "code": kind, "message": message },
        }),
    };
    (status, Json(body)).into_response()
}

/// Every account the agent can use is at its limit: one clear answer, with
/// Retry-After at the first reset.
pub(crate) fn all_limited(vendor: Vendor, wait: Duration) -> Response {
    let wait = wait.max(Duration::from_secs(1)).min(MAX_WAIT);
    let kind = match vendor {
        Vendor::Anthropic => "rate_limit_error",
        Vendor::OpenAi => "usage_limit_reached",
    };
    let message = format!(
        "Every account this agent can use is at its usage limit. The first one resets in {}.",
        about(wait)
    );
    let mut response = error(vendor, StatusCode::TOO_MANY_REQUESTS, kind, &message);
    if let Ok(value) = HeaderValue::from_str(&wait.as_secs().to_string()) {
        response.headers_mut().insert("retry-after", value);
    }
    response
}

/// No account the agent can use has access to the model, nor to a backup.
pub(crate) fn no_account_for(vendor: Vendor, model: &str) -> Response {
    let (kind, message) = (
        match vendor {
            Vendor::Anthropic => "not_found_error",
            Vendor::OpenAi => "model_not_found",
        },
        format!("No account this agent can use has access to model {model}, and no backup model could serve the request."),
    );
    error(vendor, StatusCode::NOT_FOUND, kind, &message)
}

pub(crate) fn too_large(vendor: Vendor) -> Response {
    error(
        vendor,
        StatusCode::PAYLOAD_TOO_LARGE,
        "request_too_large",
        "request body is too large",
    )
}
