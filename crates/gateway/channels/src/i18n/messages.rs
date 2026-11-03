//! English sources of the replies the channel bridge writes itself.
//!
//! Each `*_MESSAGE` is a [`Template`]: `format!` with one named argument per
//! placeholder, the argument named after it (`code = arg("code")`), so the i18n
//! extractor catalogs the ICU source (`"Your pairing code is {code}."`) that
//! [`super::render`] looks up. `tools/generate-gateway-channels-i18n.mjs
//! --check` fails when a template breaks that shape or the extractor would skip
//! it. Every message is a whole sentence; never assemble one from fragments.
#![allow(clippy::useless_format)]

use super::Template;

// ---- pairing (every unknown DM sender) -------------------------------------

pub const PAIRING_PRIVATE_MESSAGE: Template = |_| format!("This assistant is private.");
pub const PAIRING_CODE_MESSAGE: Template =
    |arg| format!("Your pairing code is {code}.", code = arg("code"));
pub const PAIRING_APPROVE_MESSAGE: Template = |_| {
    format!(
        "Ask the owner to approve this code on the Ryu Gateway. Once approved, just send your message again."
    )
};

// ---- turn replies ------------------------------------------------------------

pub const TURN_FAILED_MESSAGE: Template =
    |_| format!("Sorry, something went wrong while running that request.");
/// The direct pipeline refused the turn because a rate limit was hit.
pub const TURN_RATE_LIMITED_MESSAGE: Template =
    |_| format!("Too many requests right now. Wait a moment, then try again.");
/// A spending budget for this assistant is used up.
pub const TURN_BUDGET_EXCEEDED_MESSAGE: Template = |_| {
    format!(
        "This assistant has reached its spending limit. Ask the owner to raise it, then try again."
    )
};
/// The managed credit balance behind this assistant is empty.
pub const TURN_NO_CREDITS_MESSAGE: Template =
    |_| format!("This assistant is out of credits. Ask the owner to add credits, then try again.");
/// No configured provider serves the requested model.
pub const TURN_NO_PROVIDER_MESSAGE: Template = |arg| {
    format!(
        "No provider is available for the model {model}. Ask the owner to check the Gateway's providers.",
        model = arg("model")
    )
};
pub const NO_RESPONSE_MESSAGE: Template = |_| format!("The agent sent no response.");

// ---- command help (WhatsApp, OpenWA and iMessage have no command menu) -------

pub const NO_COMMANDS_MESSAGE: Template = |_| format!("No commands are available right now.");
pub const COMMANDS_HEADING_MESSAGE: Template = |_| format!("Available commands");
pub const COMMANDS_SEND_AS_SHOWN_MESSAGE: Template = |_| format!("Send one exactly as shown.");

// ---- platform chrome ---------------------------------------------------------

/// Slack shows it after the app name in the assistant thread status.
pub const SLACK_THINKING_MESSAGE: Template = |_| format!("is thinking…");
pub const SLACK_HELPFUL_MESSAGE: Template = |_| format!("Helpful answer");
pub const SLACK_NEEDS_WORK_MESSAGE: Template = |_| format!("Needs work");
/// Discord thread name when the message that opened it had no text.
pub const DISCORD_THREAD_FALLBACK_MESSAGE: Template = |_| format!("Ryu reply");
/// Title of the card a Telegram guest (inline mode) taps to see the answer.
pub const TELEGRAM_GUEST_REPLY_TITLE_MESSAGE: Template = |_| format!("Ryu reply");

// ---- phone calls -------------------------------------------------------------

/// Spoken to a caller (Twilio `<Say>`) before a phone line hands the call to
/// the account owner.
pub const PHONE_HANDOFF_MESSAGE: Template = |_| format!("Connecting you with the account owner.");
