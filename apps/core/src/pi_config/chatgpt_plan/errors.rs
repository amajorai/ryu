//! The ChatGPT-plan sign-in failures a user can act on.
//!
//! Each carries a stable `code` and a Core message, so the sign-in dialog shows
//! it in the reader's language (see `oauth_login::login_text::error_event`).
//! Every other failure (discovery, token, signature or scope validation) is
//! reported as one generic coded message; its detail goes to the log only.

use crate::i18n::messages::{
    LOGIN_CHATGPT_CALLBACK_STOPPED_MESSAGE, LOGIN_CHATGPT_DECLINED_MESSAGE,
    LOGIN_CHATGPT_OTHER_CLIENT_MESSAGE, LOGIN_CHATGPT_OTHER_REGISTRATION_MESSAGE,
    LOGIN_CHATGPT_TIMED_OUT_MESSAGE,
};
use crate::i18n::{Message, Template};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignInFailure {
    /// No browser callback arrived within the sign-in window.
    TimedOut,
    /// The browser returned an OAuth `error` (the user declined, or OpenAI refused).
    Declined,
    /// A reconnect came back with a different client registration.
    OtherAccountRegistration,
    /// A retried registration came back with a different client ID.
    OtherClientRegistration,
    /// The loopback callback listener ended before the browser returned.
    CallbackStopped,
}

impl SignInFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::TimedOut => "chatgpt_plan_timed_out",
            Self::Declined => "chatgpt_plan_declined",
            Self::OtherAccountRegistration => "chatgpt_plan_other_registration",
            Self::OtherClientRegistration => "chatgpt_plan_other_client",
            Self::CallbackStopped => "chatgpt_plan_callback_stopped",
        }
    }

    pub fn template(self) -> Template {
        match self {
            Self::TimedOut => LOGIN_CHATGPT_TIMED_OUT_MESSAGE,
            Self::Declined => LOGIN_CHATGPT_DECLINED_MESSAGE,
            Self::OtherAccountRegistration => LOGIN_CHATGPT_OTHER_REGISTRATION_MESSAGE,
            Self::OtherClientRegistration => LOGIN_CHATGPT_OTHER_CLIENT_MESSAGE,
            Self::CallbackStopped => LOGIN_CHATGPT_CALLBACK_STOPPED_MESSAGE,
        }
    }
}

impl std::fmt::Display for SignInFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&Message::new(self.template()).render("en"))
    }
}

impl std::error::Error for SignInFailure {}
