//! English sources for chat turns that fail on the Gateway (OpenAI-compatible)
//! plane, and for the few turn rejections Core raises before a plane runs.
//!
//! Same shape as the templates in [`super`]: each `*_MESSAGE` is a
//! [`Template`](crate::i18n::Template) built with `format!` and one named
//! argument per placeholder, written as a whole sentence. They are re-exported
//! from [`super`], so callers keep using `i18n::messages::NAME_MESSAGE`.
//!
//! `sidecar/adapters/adapter_core/openai_failure.rs` classifies the Gateway's
//! typed `error.type`/`error.code` (and transport errors) into these, and the
//! chat error card renders them in the reader's locale. `{detail}`, `{error}`,
//! `{primary}`, `{fallback}` and `{status}` are raw values (a transport error
//! chain, an HTTP status) and are never translated.
#![allow(clippy::useless_format)]

use super::Template;

// ---- titles ------------------------------------------------------------------

pub const GATEWAY_BUDGET_TITLE_MESSAGE: Template = |_| format!("Spend budget reached");
pub const GATEWAY_RATE_LIMIT_TITLE_MESSAGE: Template = |_| format!("Rate limit reached");
pub const GATEWAY_PROVIDER_RATE_LIMIT_TITLE_MESSAGE: Template =
    |_| format!("Provider rate limit reached");
pub const GATEWAY_NO_PROVIDER_TITLE_MESSAGE: Template = |_| format!("Model unavailable");
pub const GATEWAY_CIRCUIT_OPEN_TITLE_MESSAGE: Template =
    |_| format!("Provider temporarily unavailable");
pub const GATEWAY_ABUSE_THROTTLED_TITLE_MESSAGE: Template =
    |_| format!("Requests temporarily limited");
pub const GATEWAY_ACCOUNT_RESTRICTED_TITLE_MESSAGE: Template = |_| format!("Account restricted");
pub const MODEL_UNREACHABLE_TITLE_MESSAGE: Template = |_| format!("Couldn't reach the model");
pub const MODEL_STALLED_TITLE_MESSAGE: Template = |_| format!("Model stopped responding");
pub const MODEL_CONNECTION_LOST_TITLE_MESSAGE: Template = |_| format!("Model connection lost");

// ---- bodies: the Gateway refused the request ----------------------------------

pub const GATEWAY_BUDGET_MESSAGE: Template = |_| {
    format!(
        "This request would go over the spend budget set for this period. Raise the budget in Settings or wait for the next period, then retry."
    )
};
pub const GATEWAY_RATE_LIMIT_MESSAGE: Template =
    |_| format!("Too many requests were sent in a short time. Wait a moment, then retry.");
pub const GATEWAY_PROVIDER_RATE_LIMIT_MESSAGE: Template = |_| {
    format!(
        "The model provider is limiting requests right now. Wait a moment or choose another model, then retry."
    )
};
pub const GATEWAY_NO_PROVIDER_MESSAGE: Template = |_| {
    format!(
        "No connected provider serves this model. Choose another model or connect a provider in Settings, then retry."
    )
};
pub const GATEWAY_CIRCUIT_OPEN_MESSAGE: Template = |_| {
    format!(
        "The model provider failed several times in a row, so requests to it are paused briefly. Retry in a moment or choose another model."
    )
};
// Same wording as the Gateway's abuse-ladder notices (`apps/gateway/src/error.rs`).
pub const GATEWAY_ABUSE_THROTTLED_MESSAGE: Template = |_| {
    format!(
        "Requests on this account are temporarily limited by Ryu's abuse protections. Please retry after a moment."
    )
};
pub const GATEWAY_ACCOUNT_RESTRICTED_MESSAGE: Template = |_| {
    format!(
        "This account is restricted by Ryu's abuse protections, so this request is not available."
    )
};
pub const MODEL_HTTP_STATUS_MESSAGE: Template =
    |arg| format!("The model returned HTTP {status}.", status = arg("status"));

// ---- bodies: the model could not be reached or went silent --------------------

pub const MODEL_UNREACHABLE_MESSAGE: Template = |arg| {
    format!(
        "Couldn't reach the model. Check your connection and Engines in Settings, then retry. (details: {detail})",
        detail = arg("detail")
    )
};
pub const MODEL_CONNECT_TIMEOUT_MESSAGE: Template =
    |_| format!("Couldn't reach the model because the connection timed out. Retry in a moment.");
pub const MODEL_STALLED_MESSAGE: Template = |arg| {
    format!(
        "The model stopped responding after {seconds} seconds.",
        seconds = arg("seconds")
    )
};
pub const MODEL_CONNECTION_LOST_MESSAGE: Template = |arg| {
    format!(
        "The connection to the model was lost before the reply finished. (details: {detail})",
        detail = arg("detail")
    )
};
pub const MODEL_FALLBACK_FAILED_MESSAGE: Template = |arg| {
    format!(
        "The primary provider failed ({primary}), and the fallback also failed ({fallback}).",
        primary = arg("primary"),
        fallback = arg("fallback")
    )
};

// ---- turn rejections before a plane runs --------------------------------------

pub const TURN_NO_USER_MESSAGE_MESSAGE: Template =
    |_| format!("There is no user message to send to the agent.");
pub const TURN_PI_MODEL_SELECTION_FAILED_MESSAGE: Template = |arg| {
    format!(
        "Could not apply the Pi model selection: {error}",
        error = arg("error")
    )
};
pub const TURN_CONVERSATION_IDENTITY_UNAVAILABLE_MESSAGE: Template = |arg| {
    format!(
        "The conversation's identity is unavailable: {error}",
        error = arg("error")
    )
};
pub const TURN_GATEWAY_AGENT_PROOF_UNAVAILABLE_MESSAGE: Template = |arg| {
    format!(
        "The Gateway agent proof is unavailable: {error}",
        error = arg("error")
    )
};

/// Every template in this module, for the catalog round-trip test.
#[cfg(test)]
pub(super) const ALL: &[Template] = &[
    GATEWAY_BUDGET_TITLE_MESSAGE,
    GATEWAY_RATE_LIMIT_TITLE_MESSAGE,
    GATEWAY_PROVIDER_RATE_LIMIT_TITLE_MESSAGE,
    GATEWAY_NO_PROVIDER_TITLE_MESSAGE,
    GATEWAY_CIRCUIT_OPEN_TITLE_MESSAGE,
    GATEWAY_ABUSE_THROTTLED_TITLE_MESSAGE,
    GATEWAY_ACCOUNT_RESTRICTED_TITLE_MESSAGE,
    MODEL_UNREACHABLE_TITLE_MESSAGE,
    MODEL_STALLED_TITLE_MESSAGE,
    MODEL_CONNECTION_LOST_TITLE_MESSAGE,
    GATEWAY_BUDGET_MESSAGE,
    GATEWAY_RATE_LIMIT_MESSAGE,
    GATEWAY_PROVIDER_RATE_LIMIT_MESSAGE,
    GATEWAY_NO_PROVIDER_MESSAGE,
    GATEWAY_CIRCUIT_OPEN_MESSAGE,
    GATEWAY_ABUSE_THROTTLED_MESSAGE,
    GATEWAY_ACCOUNT_RESTRICTED_MESSAGE,
    MODEL_HTTP_STATUS_MESSAGE,
    MODEL_UNREACHABLE_MESSAGE,
    MODEL_CONNECT_TIMEOUT_MESSAGE,
    MODEL_STALLED_MESSAGE,
    MODEL_CONNECTION_LOST_MESSAGE,
    MODEL_FALLBACK_FAILED_MESSAGE,
    TURN_NO_USER_MESSAGE_MESSAGE,
    TURN_PI_MODEL_SELECTION_FAILED_MESSAGE,
    TURN_CONVERSATION_IDENTITY_UNAVAILABLE_MESSAGE,
    TURN_GATEWAY_AGENT_PROOF_UNAVAILABLE_MESSAGE,
];
