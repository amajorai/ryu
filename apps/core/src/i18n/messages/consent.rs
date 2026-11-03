//! English sources for Ryu's own in-chat permission prompts.
//!
//! When one of Ryu's agents asks, in the chat, before it switches the
//! interface, changes a Ryu setting, runs a gated tool or reconfigures itself,
//! Core sends these messages beside the English `fields.title` so the desktop
//! renders the whole sentence and the choice labels in the reader's locale.
//! Same shape as the templates in [`super`]: one named `format!` argument per
//! placeholder, each a whole sentence. Arguments (interface names, tool ids)
//! are raw values and are never translated.
#![allow(clippy::useless_format)]

use super::Template;

// ---- what the agent wants to do ----------------------------------------------

pub const CONSENT_SWITCH_INTERFACE_MESSAGE: Template = |arg| {
    format!(
        "Switch your interface to {interface}",
        interface = arg("interface")
    )
};
pub const CONSENT_SWITCH_INTERFACE_UNNAMED_MESSAGE: Template = |_| format!("Switch your interface");
/// A gated Core self-API call; the endpoint goes in the prompt details.
pub const CONSENT_CHANGE_SETTING_MESSAGE: Template = |_| format!("Change a Ryu setting");
/// The name avoids `TOOL`, which the extractor reserves for model-facing copy.
pub const CONSENT_RUN_CALL_MESSAGE: Template =
    |arg| format!("Run the tool {tool}", tool = arg("tool"));
pub const CONSENT_CONFIGURE_AGENT_MESSAGE: Template = |_| format!("Let the agent configure itself");

// ---- the prompt's choices ------------------------------------------------------
// "Deny" is one word, which the extractor skips as a Core source; the desktop
// renders the `reject_once` choice of a Ryu prompt with its own catalogued label.

pub const CONSENT_ALLOW_ONCE_MESSAGE: Template = |_| format!("Allow once");
pub const CONSENT_ALLOW_FOR_CHAT_MESSAGE: Template = |_| format!("Allow for this chat");
pub const CONSENT_ALLOW_FOR_SESSION_MESSAGE: Template = |_| format!("Allow for session");

/// Every template in this module, for the catalog round-trip test; add each
/// new `*_MESSAGE` here too.
#[cfg(test)]
pub(super) const ALL: &[Template] = &[
    CONSENT_SWITCH_INTERFACE_MESSAGE,
    CONSENT_SWITCH_INTERFACE_UNNAMED_MESSAGE,
    CONSENT_CHANGE_SETTING_MESSAGE,
    CONSENT_RUN_CALL_MESSAGE,
    CONSENT_CONFIGURE_AGENT_MESSAGE,
    CONSENT_ALLOW_ONCE_MESSAGE,
    CONSENT_ALLOW_FOR_CHAT_MESSAGE,
    CONSENT_ALLOW_FOR_SESSION_MESSAGE,
];
