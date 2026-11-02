//! English sources for ACP agent failure cards.
//!
//! Same shape as the templates in [`super`]: each `*_MESSAGE` is a
//! [`Template`](crate::i18n::Template) built with `format!` and one named
//! argument per placeholder, written as a whole sentence. They are re-exported
//! from [`super`], so callers keep using `i18n::messages::NAME_MESSAGE`.
//!
//! `AcpFailure` (`sidecar/adapters/acp/failure_usage.rs`) carries these as its
//! `i18n` wire, and the chat error card renders them in the reader's locale.
//! `{detail}`, `{error}`, `{reason}` and `{runner}` are raw values (an agent's
//! error chain, a command name) and are never translated.
#![allow(clippy::useless_format)]

use super::Template;

// ---- titles ------------------------------------------------------------------

pub const ACP_CLAUDE_USAGE_TITLE_MESSAGE: Template = |_| format!("Claude usage unavailable");
pub const ACP_RYU_CREDITS_TITLE_MESSAGE: Template = |_| format!("Ryu credits exhausted");
pub const ACP_OPENROUTER_CREDITS_TITLE_MESSAGE: Template =
    |_| format!("OpenRouter credits exhausted");
pub const ACP_REQUEST_FAILED_TITLE_MESSAGE: Template = |_| format!("Request failed");
pub const ACP_LOGIN_EXPIRED_TITLE_MESSAGE: Template = |_| format!("Agent login expired");
pub const ACP_START_FAILED_TITLE_MESSAGE: Template = |_| format!("Agent failed to start");
pub const ACP_GATEWAY_STARTING_TITLE_MESSAGE: Template = |_| format!("Gateway still starting");
pub const ACP_SANDBOX_REQUIRED_TITLE_MESSAGE: Template =
    |_| format!("Agent not started: its account access needs a sandbox");
pub const ACP_CONNECTION_LOST_TITLE_MESSAGE: Template = |_| format!("Agent connection lost");
pub const ACP_EXECUTION_PAUSED_TITLE_MESSAGE: Template = |_| format!("Execution paused");
pub const ACP_PI_ACCOUNT_TITLE_MESSAGE: Template = |_| format!("Pi account unavailable");
pub const ACP_NATIVE_ACCOUNT_TITLE_MESSAGE: Template = |_| format!("Native account unavailable");
pub const ACP_SCOPE_FAILED_TITLE_MESSAGE: Template = |_| format!("Agent tools unavailable");
pub const ACP_UNTRUSTED_FOLDER_TITLE_MESSAGE: Template =
    |_| format!("Agent not started in an untrusted folder");

// ---- bodies: the model provider refused the turn -----------------------------

pub const ACP_CLAUDE_USAGE_MESSAGE: Template = |_| {
    format!(
        "Your Claude account is connected, but Anthropic rejected this third-party request. Check your Claude Usage settings and any required usage credits, or choose another connected provider."
    )
};
pub const ACP_RYU_CREDITS_MESSAGE: Template = |_| {
    format!(
        "Your organization's Ryu credits are exhausted. Open Credits in Settings to top up, or choose a BYOK or local model, then retry."
    )
};
pub const ACP_OPENROUTER_CREDITS_MESSAGE: Template = |_| {
    format!(
        "The OpenRouter API key on this node has no prepaid credits left. Add credits to your OpenRouter account or choose another provider, then retry."
    )
};
pub const ACP_REQUEST_FAILED_MESSAGE: Template = |arg| {
    format!(
        "The agent could not complete the turn because its model provider is unavailable or misconfigured. Check Engines in Settings, then retry. (details: {detail})",
        detail = arg("detail")
    )
};

// ---- bodies: the agent could not start or keep its connection ---------------

pub const ACP_LOGIN_EXPIRED_MESSAGE: Template =
    |_| format!("Your agent login expired. Log in again, then re-send your message.");
pub const ACP_START_FAILED_MESSAGE: Template = |arg| {
    format!(
        "The agent could not start, so the message was not sent. Send it again to retry. (details: {detail})",
        detail = arg("detail")
    )
};
pub const ACP_GATEWAY_STARTING_MESSAGE: Template = |_| {
    format!(
        "The local Gateway is still verifying readiness; retry the agent after startup completes"
    )
};
pub const ACP_CONNECTION_LOST_BEFORE_SEND_MESSAGE: Template = |arg| {
    format!(
        "The agent connection ended before this message was sent: {error}",
        error = arg("error")
    )
};
pub const ACP_CONNECTION_LOST_MID_TURN_MESSAGE: Template = |arg| {
    format!(
        "The agent connection ended before the turn completed: {error}",
        error = arg("error")
    )
};
pub const ACP_EXECUTION_PAUSED_MESSAGE: Template =
    |_| format!("Chats and bots are paused by Kill Switch. Resume execution to start new work.");
pub const ACP_SCOPE_FAILED_MESSAGE: Template = |arg| {
    format!(
        "Could not limit this agent to its allowed tools: {error}",
        error = arg("error")
    )
};

// ---- bodies: Ryu refused to launch the agent ---------------------------------

pub const ACP_SANDBOX_REQUIRED_MESSAGE: Template = |arg| {
    format!(
        "This agent's account access is limited, or it has accounts of its own (Its own identity or Both), so Ryu runs its engine in a sandbox that hides your saved provider keys and sign-ins and Ryu's own tokens and databases. Ryu could not set that sandbox up on this computer ({reason}), so it did not start the agent.",
        reason = arg("reason")
    )
};
pub const ACP_SANDBOX_ADVICE_PROVIDERS_MESSAGE: Template = |_| {
    format!(
        "Ryu's own engine can still run it here, without its shell and file tools; or set the agent's Identity to Acts as you with Limit to selected accounts off."
    )
};
pub const ACP_SANDBOX_ADVICE_OTHER_MESSAGE: Template = |_| {
    format!(
        "To run it here, set the agent's Identity to Acts as you, or turn on Limit to selected accounts so that Ryu's own engine can run it without its shell and file tools."
    )
};
pub const ACP_PACKAGE_RUNNER_REFUSED_MESSAGE: Template = |arg| {
    format!(
        "Ryu did not start this agent: its launch ({runner}) goes through a package runner, which downloads code when it starts, so Ryu cannot cut its network access in a folder you have not trusted. Ryu installs npm agents in the background so they can start sandboxed; send your message again once that finishes. Otherwise, trust this folder if you trust its code, or open the chat in a trusted folder.",
        runner = arg("runner")
    )
};

/// Every template in this module, for the catalog round-trip test; add each
/// new `*_MESSAGE` here too.
#[cfg(test)]
pub(super) const ALL: &[super::Template] = &[
    ACP_CLAUDE_USAGE_TITLE_MESSAGE,
    ACP_RYU_CREDITS_TITLE_MESSAGE,
    ACP_OPENROUTER_CREDITS_TITLE_MESSAGE,
    ACP_REQUEST_FAILED_TITLE_MESSAGE,
    ACP_LOGIN_EXPIRED_TITLE_MESSAGE,
    ACP_START_FAILED_TITLE_MESSAGE,
    ACP_GATEWAY_STARTING_TITLE_MESSAGE,
    ACP_SANDBOX_REQUIRED_TITLE_MESSAGE,
    ACP_CONNECTION_LOST_TITLE_MESSAGE,
    ACP_EXECUTION_PAUSED_TITLE_MESSAGE,
    ACP_PI_ACCOUNT_TITLE_MESSAGE,
    ACP_NATIVE_ACCOUNT_TITLE_MESSAGE,
    ACP_SCOPE_FAILED_TITLE_MESSAGE,
    ACP_UNTRUSTED_FOLDER_TITLE_MESSAGE,
    ACP_CLAUDE_USAGE_MESSAGE,
    ACP_RYU_CREDITS_MESSAGE,
    ACP_OPENROUTER_CREDITS_MESSAGE,
    ACP_REQUEST_FAILED_MESSAGE,
    ACP_LOGIN_EXPIRED_MESSAGE,
    ACP_START_FAILED_MESSAGE,
    ACP_GATEWAY_STARTING_MESSAGE,
    ACP_CONNECTION_LOST_BEFORE_SEND_MESSAGE,
    ACP_CONNECTION_LOST_MID_TURN_MESSAGE,
    ACP_EXECUTION_PAUSED_MESSAGE,
    ACP_SCOPE_FAILED_MESSAGE,
    ACP_SANDBOX_REQUIRED_MESSAGE,
    ACP_SANDBOX_ADVICE_PROVIDERS_MESSAGE,
    ACP_SANDBOX_ADVICE_OTHER_MESSAGE,
    ACP_PACKAGE_RUNNER_REFUSED_MESSAGE,
];
