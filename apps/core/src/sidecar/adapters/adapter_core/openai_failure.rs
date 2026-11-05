//! Failed turns on the Gateway (OpenAI-compatible) plane, as Core messages.
//!
//! Mirrors the ACP plane ([`acp::AcpFailure::localized`] and
//! [`acp::AcpFailure::relayed`]): a refusal the Gateway names in its typed
//! `error.type` / `error.code` (budget, credits, rate limits, no provider, an
//! open circuit, the abuse ladder) and a transport failure (unreachable,
//! timed out, stalled) become a localized title and body. Anything else keeps
//! the Gateway's own text as a relayed body under a localized title.
//!
//! The English `message` stays the stream's `errorText` (older clients, the
//! DOM localizer); the `i18n` wire rides a transient `data-ryu-error` frame
//! and the persisted `error` part, the same shape the ACP plane stores.
//! Failover classification is untouched: it still runs on
//! `routing_policy::reactive::gateway_failure_kind` over the same body.

use super::*;

use crate::i18n::{messages as m, Message, Template};
use acp::AcpFailure;

/// A Core-side error string raised before or around the upstream hop (a
/// missing credential, a refused proof). Its text is already a sentence, so
/// the card relays it under the generic title.
impl From<String> for AcpFailure {
    fn from(message: String) -> Self {
        AcpFailure::relayed("agent_error", m::ACP_REQUEST_FAILED_TITLE_MESSAGE, message)
    }
}

fn localized(code: &str, title: Template, body: Message) -> AcpFailure {
    AcpFailure::localized(code, title, vec![body])
}

/// The Gateway's `{ "error": { "message", "type", "code" } }` envelope fields.
struct GatewayErrorFields {
    kind: Option<String>,
    code: Option<String>,
    message: Option<String>,
}

fn gateway_error(body: &str) -> GatewayErrorFields {
    let json = serde_json::from_str::<Value>(body).unwrap_or(Value::Null);
    let field = |name: &str| {
        json["error"][name]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    GatewayErrorFields {
        // Same field `routing_policy::reactive::error_type_of` reads.
        kind: field("type"),
        code: field("code"),
        message: field("message"),
    }
}

/// Classify a non-success upstream response (`status`, raw `body`).
pub(crate) fn upstream_failure(status: u16, body: &str) -> AcpFailure {
    let error = gateway_error(body);
    let kind = error.kind.as_deref().unwrap_or_default();
    // The abuse ladder shares `rate_limit_exceeded` / `policy_violation` with
    // other refusals; its `code` names the rung.
    match error.code.as_deref() {
        Some("abuse_throttled") => {
            return localized(
                "abuse_throttled",
                m::GATEWAY_ABUSE_THROTTLED_TITLE_MESSAGE,
                Message::new(m::GATEWAY_ABUSE_THROTTLED_MESSAGE),
            )
        }
        Some("account_restricted") => {
            return localized(
                "account_restricted",
                m::GATEWAY_ACCOUNT_RESTRICTED_TITLE_MESSAGE,
                Message::new(m::GATEWAY_ACCOUNT_RESTRICTED_MESSAGE),
            )
        }
        _ => {}
    }
    let coded = |title: Template, body: Template| localized(kind, title, Message::new(body));
    match kind {
        "budget_exceeded" => coded(m::GATEWAY_BUDGET_TITLE_MESSAGE, m::GATEWAY_BUDGET_MESSAGE),
        "insufficient_credits" => {
            coded(m::ACP_RYU_CREDITS_TITLE_MESSAGE, m::ACP_RYU_CREDITS_MESSAGE)
        }
        "provider_rate_limited" => coded(
            m::GATEWAY_PROVIDER_RATE_LIMIT_TITLE_MESSAGE,
            m::GATEWAY_PROVIDER_RATE_LIMIT_MESSAGE,
        ),
        "model_not_found" => coded(
            m::GATEWAY_NO_PROVIDER_TITLE_MESSAGE,
            m::GATEWAY_NO_PROVIDER_MESSAGE,
        ),
        "circuit_open" => coded(
            m::GATEWAY_CIRCUIT_OPEN_TITLE_MESSAGE,
            m::GATEWAY_CIRCUIT_OPEN_MESSAGE,
        ),
        _ if status == 429 || kind == "rate_limit_exceeded" => localized(
            "rate_limited",
            m::GATEWAY_RATE_LIMIT_TITLE_MESSAGE,
            Message::new(m::GATEWAY_RATE_LIMIT_MESSAGE),
        ),
        _ => match error.message {
            Some(message) => AcpFailure::relayed(
                if kind.is_empty() {
                    "upstream_error"
                } else {
                    kind
                },
                m::ACP_REQUEST_FAILED_TITLE_MESSAGE,
                message,
            ),
            None => localized(
                "upstream_error",
                m::ACP_REQUEST_FAILED_TITLE_MESSAGE,
                Message::new(m::MODEL_HTTP_STATUS_MESSAGE).text("status", status.to_string()),
            ),
        },
    }
}

/// A timeout on the streaming hop: the connection never opened, or the model
/// went silent for `read_timeout`.
fn timeout_failure(error: &reqwest::Error, read_timeout: std::time::Duration) -> AcpFailure {
    if error.is_connect() {
        return localized(
            "model_connect_timeout",
            m::MODEL_UNREACHABLE_TITLE_MESSAGE,
            Message::new(m::MODEL_CONNECT_TIMEOUT_MESSAGE),
        );
    }
    localized(
        "model_stalled",
        m::MODEL_STALLED_TITLE_MESSAGE,
        // A plain text arg: the chat card's renderer
        // (`packages/blocks/.../utils/core-error-text.ts`) takes only string
        // and bare-number args, and would drop a `{ number }` object back to
        // the English message.
        Message::new(m::MODEL_STALLED_MESSAGE).text("seconds", read_timeout.as_secs().to_string()),
    )
}

/// The request could not be sent, or no response head arrived.
pub(crate) fn connect_failure(
    error: &reqwest::Error,
    read_timeout: std::time::Duration,
) -> AcpFailure {
    if error.is_timeout() {
        return timeout_failure(error, read_timeout);
    }
    localized(
        "model_unreachable",
        m::MODEL_UNREACHABLE_TITLE_MESSAGE,
        Message::new(m::MODEL_UNREACHABLE_MESSAGE).text("detail", error.to_string()),
    )
}

/// The response body failed mid-stream.
pub(crate) fn stream_failure(
    error: &reqwest::Error,
    read_timeout: std::time::Duration,
) -> AcpFailure {
    if error.is_timeout() {
        return timeout_failure(error, read_timeout);
    }
    localized(
        "model_connection_lost",
        m::MODEL_CONNECTION_LOST_TITLE_MESSAGE,
        Message::new(m::MODEL_CONNECTION_LOST_MESSAGE).text("detail", error.to_string()),
    )
}

/// Both the primary hop and its single fallback failed.
pub(crate) fn fallback_failure(primary: &AcpFailure, fallback: &AcpFailure) -> AcpFailure {
    localized(
        "fallback_failed",
        m::MODEL_UNREACHABLE_TITLE_MESSAGE,
        Message::new(m::MODEL_FALLBACK_FAILED_MESSAGE)
            .text("primary", primary.message.as_str())
            .text("fallback", fallback.message.as_str()),
    )
}

/// The persisted `error` part (see `PartsAccumulator::error`).
pub(crate) fn failure_part(failure: &AcpFailure) -> Value {
    let mut part = serde_json::json!({
        "type": "error",
        "code": failure.code,
        "title": failure.title,
        "message": failure.message,
    });
    if let Some(i18n) = failure.i18n_wire() {
        part["i18n"] = i18n;
    }
    part
}

/// The frames that end a failed turn: a transient `data-ryu-error` carrying
/// the card (with its `i18n`), then the usual `error` + `finish` + `[DONE]`.
/// The AI SDK's `error` chunk takes only `errorText`, so the structured card
/// cannot ride on it.
pub(crate) fn error_ui_frames(failure: &AcpFailure) -> Vec<Vec<u8>> {
    let mut frames = vec![ui_chunk(&serde_json::json!({
        "type": "data-ryu-error",
        "data": failure_part(failure),
        "transient": true,
    }))];
    frames.extend(error_ui_lines(&failure.message));
    frames
}

/// A turn rejection rendered for the stream's `errorText`: English, which the
/// client's catalog (exact or template match) translates.
pub(crate) fn rejection_text(template: Template, error: Option<&str>) -> String {
    let message = Message::new(template);
    match error {
        Some(error) => message.text("error", error),
        None => message,
    }
    .render("en")
}

#[cfg(test)]
#[path = "openai_failure_tests.rs"]
mod tests;
