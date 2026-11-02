//! The copy Core's native sign-in flows put on the login stream.
//!
//! Each sentence goes out twice, like a cloud-task routing notice: the English
//! text in `instructions` (an `auth_url` event) or `message` (`info`, `error`),
//! for clients that do not read `i18n`, and `i18n`, the same sentence as a Core
//! message `{ message: <English ICU source>, args }` that the desktop renders in
//! the reader's language. Every failure also carries a stable `code`.
//!
//! Only failures the user can act on get their own sentence. Anything else
//! (an OpenAI protocol or validation error, a vault write) is reported as one
//! generic coded sentence; its raw detail is logged, never sent.

use serde_json::{json, Value};

use crate::i18n::messages::{
    LOGIN_CHATGPT_ACCOUNT_REMOVED_MESSAGE, LOGIN_CHATGPT_FAILED_MESSAGE,
    LOGIN_CHATGPT_NOT_SAVED_MESSAGE, LOGIN_CHATGPT_OTHER_REGISTRATION_MESSAGE,
    LOGIN_CHATGPT_REGISTRATION_CHANGED_MESSAGE, LOGIN_KIRO_LOGIN_CHANGED_MESSAGE,
    LOGIN_KIRO_OTHER_PROFILE_MESSAGE, LOGIN_KIRO_SAVE_FAILED_MESSAGE, LOGIN_VAULT_REQUIRED_MESSAGE,
};
use crate::i18n::{Message, Template};
use crate::pi_config::chatgpt_plan::SignInFailure;

/// An `auth_url` event whose guidance is a Core message.
pub(super) fn auth_url_event(url: &str, instructions: &Message) -> Value {
    json!({
        "type": "auth_url",
        "url": url,
        "instructions": instructions.render("en"),
        "i18n": instructions.to_wire(),
    })
}

/// An `info` or `error` event whose text is a Core message.
pub(super) fn message_event(kind: &str, message: &Message) -> Value {
    json!({ "type": kind, "message": message.render("en"), "i18n": message.to_wire() })
}

/// A native (ChatGPT-plan or Kiro) sign-in failure the user can act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PlanLoginFailure {
    /// The browser signed in a different registration than the one reconnecting.
    OtherRegistration,
    /// The account being reconnected was deleted while the browser was open.
    AccountRemoved,
    /// The saved registration was rewritten while the browser was open.
    RegistrationChanged,
    /// The account chosen for a reconnect is not saved.
    RegistrationNotSaved,
    /// The sealed account vault is not available on this node.
    VaultRequired,
    /// Any other ChatGPT-plan failure.
    ChatGptFailed,
    /// Kiro signed in a different profile than the one reconnecting.
    KiroOtherProfile,
    /// The saved Kiro login was rewritten while the browser was open.
    KiroLoginChanged,
    /// Any other Kiro failure.
    KiroSaveFailed,
}

impl PlanLoginFailure {
    pub(super) fn code(self) -> &'static str {
        match self {
            Self::OtherRegistration => "chatgpt_plan_other_registration",
            Self::AccountRemoved => "chatgpt_plan_account_removed",
            Self::RegistrationChanged => "chatgpt_plan_registration_changed",
            Self::RegistrationNotSaved => "chatgpt_plan_registration_not_saved",
            Self::VaultRequired => "login_vault_required",
            Self::ChatGptFailed => "chatgpt_plan_sign_in_failed",
            Self::KiroOtherProfile => "kiro_other_profile",
            Self::KiroLoginChanged => "kiro_login_changed",
            Self::KiroSaveFailed => "kiro_sign_in_failed",
        }
    }

    fn template(self) -> Template {
        match self {
            Self::OtherRegistration => LOGIN_CHATGPT_OTHER_REGISTRATION_MESSAGE,
            Self::AccountRemoved => LOGIN_CHATGPT_ACCOUNT_REMOVED_MESSAGE,
            Self::RegistrationChanged => LOGIN_CHATGPT_REGISTRATION_CHANGED_MESSAGE,
            Self::RegistrationNotSaved => LOGIN_CHATGPT_NOT_SAVED_MESSAGE,
            Self::VaultRequired => LOGIN_VAULT_REQUIRED_MESSAGE,
            Self::ChatGptFailed => LOGIN_CHATGPT_FAILED_MESSAGE,
            Self::KiroOtherProfile => LOGIN_KIRO_OTHER_PROFILE_MESSAGE,
            Self::KiroLoginChanged => LOGIN_KIRO_LOGIN_CHANGED_MESSAGE,
            Self::KiroSaveFailed => LOGIN_KIRO_SAVE_FAILED_MESSAGE,
        }
    }
}

impl std::fmt::Display for PlanLoginFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&Message::new(self.template()).render("en"))
    }
}

impl std::error::Error for PlanLoginFailure {}

fn coded_event(code: &str, template: Template) -> Value {
    let mut event = message_event("error", &Message::new(template));
    event["code"] = json!(code);
    event
}

/// The terminal `error` event for a failed native flow. A known failure keeps
/// its own coded message; any other error becomes `fallback`, and its detail
/// goes to the log only.
pub(super) fn error_event_or(error: &anyhow::Error, fallback: PlanLoginFailure) -> Value {
    if let Some(failure) = error.downcast_ref::<PlanLoginFailure>() {
        return coded_event(failure.code(), failure.template());
    }
    if let Some(failure) = error.downcast_ref::<SignInFailure>() {
        return coded_event(failure.code(), failure.template());
    }
    tracing::warn!(error = %format!("{error:#}"), code = fallback.code(), "native sign-in failed");
    coded_event(fallback.code(), fallback.template())
}

/// The terminal `error` event for a failed ChatGPT-plan flow.
pub(super) fn error_event(error: &anyhow::Error) -> Value {
    error_event_or(error, PlanLoginFailure::ChatGptFailed)
}

/// The error a failed ChatGPT-plan start answers with: a known failure as is,
/// anything else as the generic coded failure, its detail logged only.
pub(super) fn plan_start_failure(error: anyhow::Error) -> anyhow::Error {
    if error.downcast_ref::<PlanLoginFailure>().is_some()
        || error.downcast_ref::<SignInFailure>().is_some()
    {
        return error;
    }
    tracing::warn!(error = %format!("{error:#}"), "ChatGPT sign-in could not start");
    PlanLoginFailure::ChatGptFailed.into()
}
