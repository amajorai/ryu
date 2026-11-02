//! English sources for the provider sign-in dialog (`/api/pi-config/providers/:id/login`),
//! the ChatGPT-plan browser callback page, and native CLI account errors
//! (`/api/agents/:id/native-accounts`).
//!
//! Same shape as the templates in [`super`]: each `*_MESSAGE` is a
//! [`Template`](crate::i18n::Template) built with `format!` and one named
//! argument per placeholder, written as a whole sentence. They are re-exported
//! from [`super`], so callers keep using `i18n::messages::NAME_MESSAGE`.
//!
//! Core's native ChatGPT-plan and Kiro flows send each sentence on the login
//! stream twice: the English text (`instructions` or `message`) and `i18n`, the
//! same sentence as a Core message, which the desktop renders in the reader's
//! language. `{code}` is a device code and is never translated.
#![allow(clippy::useless_format)]

use super::Template;

// ---- ChatGPT plan ---------------------------------------------------------------

pub const LOGIN_CHATGPT_PLAN_INSTRUCTIONS_MESSAGE: Template = |_| {
    format!("Review identity and ChatGPT plan permissions in the browser. Complete sign-in on the host running Core.")
};
pub const LOGIN_CODE_EXPIRED_MESSAGE: Template = |_| {
    format!("The code expired. Continue authorization again; your issued registration is retained.")
};
pub const LOGIN_FRESH_ATTEMPT_MESSAGE: Template =
    |_| format!("Complete the fresh authorization attempt in your browser.");
pub const LOGIN_CHATGPT_OTHER_REGISTRATION_MESSAGE: Template = |_| {
    format!("ChatGPT returned another account registration, so the saved account was not changed.")
};
pub const LOGIN_CHATGPT_ACCOUNT_REMOVED_MESSAGE: Template =
    |_| format!("The saved ChatGPT account was removed during sign-in.");
pub const LOGIN_CHATGPT_REGISTRATION_CHANGED_MESSAGE: Template =
    |_| format!("The saved ChatGPT registration changed during sign-in. Try signing in again.");

pub const LOGIN_CHATGPT_TIMED_OUT_MESSAGE: Template =
    |_| format!("ChatGPT sign-in timed out. Start again.");
pub const LOGIN_CHATGPT_DECLINED_MESSAGE: Template =
    |_| format!("ChatGPT authorization was declined or could not be completed.");
pub const LOGIN_CHATGPT_OTHER_CLIENT_MESSAGE: Template =
    |_| format!("ChatGPT returned another client registration. Start a new connection.");
pub const LOGIN_CHATGPT_CALLBACK_STOPPED_MESSAGE: Template =
    |_| format!("The ChatGPT sign-in listener stopped. Start again.");
pub const LOGIN_CHATGPT_NOT_SAVED_MESSAGE: Template =
    |_| format!("This ChatGPT account registration is not saved.");
pub const LOGIN_CHATGPT_FAILED_MESSAGE: Template =
    |_| format!("ChatGPT sign-in could not be completed. Start again.");
pub const LOGIN_VAULT_REQUIRED_MESSAGE: Template =
    |_| format!("The sealed account vault must be available before signing in.");

// ---- ChatGPT plan browser callback page ------------------------------------------

pub const LOGIN_CHATGPT_CALLBACK_TITLE_MESSAGE: Template = |_| format!("Sign in with ChatGPT");
pub const LOGIN_CHATGPT_CALLBACK_RECEIVED_MESSAGE: Template =
    |_| format!("Authorization received. Return to Ryu to check the connection.");
pub const LOGIN_CHATGPT_CALLBACK_UNVERIFIED_MESSAGE: Template =
    |_| format!("This sign-in attempt could not be verified.");
pub const LOGIN_CHATGPT_CALLBACK_UNAVAILABLE_MESSAGE: Template =
    |_| format!("Sign-in is unavailable.");
pub const LOGIN_CHATGPT_CALLBACK_USED_MESSAGE: Template =
    |_| format!("This sign-in attempt has already been used.");

// ---- Kiro (AWS Builder ID) ------------------------------------------------------

pub const LOGIN_KIRO_INSTRUCTIONS_MESSAGE: Template = |arg| {
    format!(
        "Sign in with AWS Builder ID. Enter code {code} if requested.",
        code = arg("code")
    )
};
pub const LOGIN_KIRO_SAVE_FAILED_MESSAGE: Template =
    |_| format!("Kiro sign-in could not be saved. Try signing in again.");
pub const LOGIN_KIRO_LOGIN_CHANGED_MESSAGE: Template =
    |_| format!("The saved Kiro login changed during sign-in. Try signing in again.");
pub const LOGIN_KIRO_OTHER_PROFILE_MESSAGE: Template =
    |_| format!("Kiro returned another profile, so the saved account was not changed.");

// ---- Native CLI accounts (Settings > agent accounts) ----------------------------

pub const NATIVE_ACCOUNT_FAILED_MESSAGE: Template =
    |_| format!("Ryu could not update this native account. Try again.");
pub const NATIVE_ACCOUNT_UNSUPPORTED_MESSAGE: Template =
    |_| format!("This agent does not support native account custody");
pub const NATIVE_ACCOUNT_LOGIN_FAILED_MESSAGE: Template =
    |_| format!("Native sign-in failed. Try signing in again.");
pub const NATIVE_ACCOUNT_LOGIN_INCOMPLETE_MESSAGE: Template =
    |_| format!("Native sign-in did not complete. Try signing in again.");
pub const NATIVE_ACCOUNT_LOGIN_TIMED_OUT_MESSAGE: Template =
    |_| format!("Native sign-in timed out. Try signing in again.");
pub const NATIVE_ACCOUNT_LOGIN_CANCELLED_MESSAGE: Template =
    |_| format!("Native sign-in was cancelled.");
pub const NATIVE_ACCOUNT_LOGIN_START_FAILED_MESSAGE: Template =
    |_| format!("Ryu could not start the native sign-in.");
pub const NATIVE_ACCOUNT_DISCONNECT_FIRST_MESSAGE: Template =
    |_| format!("Disconnect this native account before signing in again.");
pub const NATIVE_ACCOUNT_CHANGED_MESSAGE: Template =
    |_| format!("This native account changed while Ryu was updating it. Try again.");
pub const NATIVE_ACCOUNT_IDENTITY_CHANGED_MESSAGE: Template =
    |_| format!("The native CLI identity changed. Reconnect the account.");
pub const NATIVE_ACCOUNT_IDENTITY_UNVERIFIED_MESSAGE: Template = |_| {
    format!("Ryu could not verify the native CLI identity, so the account remains disconnected.")
};
pub const NATIVE_ACCOUNT_OPERATION_FAILED_MESSAGE: Template =
    |_| format!("The native CLI operation failed. Reconnect the selected account.");
pub const NATIVE_ACCOUNT_OPERATION_RUNNING_MESSAGE: Template =
    |_| format!("An authorization operation is already running for this account.");
pub const NATIVE_ACCOUNT_TOO_MANY_OPERATIONS_MESSAGE: Template =
    |_| format!("Too many authorization operations are running. Try again later.");
pub const NATIVE_ACCOUNT_LABEL_INVALID_MESSAGE: Template =
    |_| format!("The account label must be 1 to 200 printable bytes long.");
pub const NATIVE_ACCOUNT_NOT_VERIFIED_MESSAGE: Template =
    |_| format!("This native account is not verified. Finish signing in before launching.");
pub const NATIVE_ACCOUNT_REMOVED_MESSAGE: Template =
    |_| format!("This native account was removed.");
pub const NATIVE_ACCOUNT_NOT_SELECTED_MESSAGE: Template =
    |_| format!("No native account is selected.");
pub const NATIVE_ACCOUNT_EXECUTABLE_CHANGED_MESSAGE: Template =
    |_| format!("The native CLI executable changed. Restart Core to reconnect the account.");

/// Every template in this module, for the catalog round-trip test; add each
/// new `*_MESSAGE` here too.
#[cfg(test)]
pub(super) const ALL: &[Template] = &[
    LOGIN_CHATGPT_PLAN_INSTRUCTIONS_MESSAGE,
    LOGIN_CODE_EXPIRED_MESSAGE,
    LOGIN_FRESH_ATTEMPT_MESSAGE,
    LOGIN_CHATGPT_OTHER_REGISTRATION_MESSAGE,
    LOGIN_CHATGPT_ACCOUNT_REMOVED_MESSAGE,
    LOGIN_CHATGPT_REGISTRATION_CHANGED_MESSAGE,
    LOGIN_CHATGPT_TIMED_OUT_MESSAGE,
    LOGIN_CHATGPT_DECLINED_MESSAGE,
    LOGIN_CHATGPT_OTHER_CLIENT_MESSAGE,
    LOGIN_CHATGPT_CALLBACK_STOPPED_MESSAGE,
    LOGIN_CHATGPT_NOT_SAVED_MESSAGE,
    LOGIN_CHATGPT_FAILED_MESSAGE,
    LOGIN_VAULT_REQUIRED_MESSAGE,
    LOGIN_CHATGPT_CALLBACK_TITLE_MESSAGE,
    LOGIN_CHATGPT_CALLBACK_RECEIVED_MESSAGE,
    LOGIN_CHATGPT_CALLBACK_UNVERIFIED_MESSAGE,
    LOGIN_CHATGPT_CALLBACK_UNAVAILABLE_MESSAGE,
    LOGIN_CHATGPT_CALLBACK_USED_MESSAGE,
    LOGIN_KIRO_INSTRUCTIONS_MESSAGE,
    LOGIN_KIRO_SAVE_FAILED_MESSAGE,
    LOGIN_KIRO_LOGIN_CHANGED_MESSAGE,
    LOGIN_KIRO_OTHER_PROFILE_MESSAGE,
    NATIVE_ACCOUNT_FAILED_MESSAGE,
    NATIVE_ACCOUNT_UNSUPPORTED_MESSAGE,
    NATIVE_ACCOUNT_LOGIN_FAILED_MESSAGE,
    NATIVE_ACCOUNT_LOGIN_INCOMPLETE_MESSAGE,
    NATIVE_ACCOUNT_LOGIN_TIMED_OUT_MESSAGE,
    NATIVE_ACCOUNT_LOGIN_CANCELLED_MESSAGE,
    NATIVE_ACCOUNT_LOGIN_START_FAILED_MESSAGE,
    NATIVE_ACCOUNT_DISCONNECT_FIRST_MESSAGE,
    NATIVE_ACCOUNT_CHANGED_MESSAGE,
    NATIVE_ACCOUNT_IDENTITY_CHANGED_MESSAGE,
    NATIVE_ACCOUNT_IDENTITY_UNVERIFIED_MESSAGE,
    NATIVE_ACCOUNT_OPERATION_FAILED_MESSAGE,
    NATIVE_ACCOUNT_OPERATION_RUNNING_MESSAGE,
    NATIVE_ACCOUNT_TOO_MANY_OPERATIONS_MESSAGE,
    NATIVE_ACCOUNT_LABEL_INVALID_MESSAGE,
    NATIVE_ACCOUNT_NOT_VERIFIED_MESSAGE,
    NATIVE_ACCOUNT_REMOVED_MESSAGE,
    NATIVE_ACCOUNT_NOT_SELECTED_MESSAGE,
    NATIVE_ACCOUNT_EXECUTABLE_CHANGED_MESSAGE,
];
