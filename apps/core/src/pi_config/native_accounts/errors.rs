//! The native-account failures a user can act on, as coded Core messages.
//!
//! Settings > agent accounts shows these in the reader's language: each route
//! answers `{ error, code, i18n }` (English text, a stable code, and the same
//! sentence as a Core message), and a failed login's progress carries
//! `errorCode` and `errorI18n`. Internal custody, lock and file-system failures
//! become [`NativeAccountError::Failed`]; their detail is logged, never sent.

use serde_json::{json, Value};

use crate::i18n::messages::{
    NATIVE_ACCOUNT_CHANGED_MESSAGE, NATIVE_ACCOUNT_DISCONNECT_FIRST_MESSAGE,
    NATIVE_ACCOUNT_EXECUTABLE_CHANGED_MESSAGE, NATIVE_ACCOUNT_FAILED_MESSAGE,
    NATIVE_ACCOUNT_IDENTITY_CHANGED_MESSAGE, NATIVE_ACCOUNT_IDENTITY_UNVERIFIED_MESSAGE,
    NATIVE_ACCOUNT_LABEL_INVALID_MESSAGE, NATIVE_ACCOUNT_LOGIN_CANCELLED_MESSAGE,
    NATIVE_ACCOUNT_LOGIN_FAILED_MESSAGE, NATIVE_ACCOUNT_LOGIN_INCOMPLETE_MESSAGE,
    NATIVE_ACCOUNT_LOGIN_START_FAILED_MESSAGE, NATIVE_ACCOUNT_LOGIN_TIMED_OUT_MESSAGE,
    NATIVE_ACCOUNT_NOT_SELECTED_MESSAGE, NATIVE_ACCOUNT_NOT_VERIFIED_MESSAGE,
    NATIVE_ACCOUNT_OPERATION_FAILED_MESSAGE, NATIVE_ACCOUNT_OPERATION_RUNNING_MESSAGE,
    NATIVE_ACCOUNT_REMOVED_MESSAGE, NATIVE_ACCOUNT_TOO_MANY_OPERATIONS_MESSAGE,
    NATIVE_ACCOUNT_UNSUPPORTED_MESSAGE,
};
use crate::i18n::{Message, Template};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeAccountError {
    /// Any failure without its own sentence.
    Failed,
    /// The agent is not a native CLI agent with account custody.
    Unsupported,
    LoginFailed,
    LoginIncomplete,
    LoginTimedOut,
    LoginCancelled,
    LoginStartFailed,
    DisconnectFirst,
    /// The account record was rewritten while an operation ran.
    AccountChanged,
    IdentityChanged,
    IdentityUnverified,
    OperationFailed,
    OperationRunning,
    TooManyOperations,
    LabelInvalid,
    NotVerified,
    AccountRemoved,
    NotSelected,
    ExecutableChanged,
}

impl NativeAccountError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Failed => "native_account_failed",
            Self::Unsupported => "native_account_unsupported",
            Self::LoginFailed => "native_account_login_failed",
            Self::LoginIncomplete => "native_account_login_incomplete",
            Self::LoginTimedOut => "native_account_login_timed_out",
            Self::LoginCancelled => "native_account_login_cancelled",
            Self::LoginStartFailed => "native_account_login_start_failed",
            Self::DisconnectFirst => "native_account_disconnect_first",
            Self::AccountChanged => "native_account_changed",
            Self::IdentityChanged => "native_account_identity_changed",
            Self::IdentityUnverified => "native_account_identity_unverified",
            Self::OperationFailed => "native_account_operation_failed",
            Self::OperationRunning => "native_account_operation_running",
            Self::TooManyOperations => "native_account_too_many_operations",
            Self::LabelInvalid => "native_account_label_invalid",
            Self::NotVerified => "native_account_not_verified",
            Self::AccountRemoved => "native_account_removed",
            Self::NotSelected => "native_account_not_selected",
            Self::ExecutableChanged => "native_account_executable_changed",
        }
    }

    fn template(self) -> Template {
        match self {
            Self::Failed => NATIVE_ACCOUNT_FAILED_MESSAGE,
            Self::Unsupported => NATIVE_ACCOUNT_UNSUPPORTED_MESSAGE,
            Self::LoginFailed => NATIVE_ACCOUNT_LOGIN_FAILED_MESSAGE,
            Self::LoginIncomplete => NATIVE_ACCOUNT_LOGIN_INCOMPLETE_MESSAGE,
            Self::LoginTimedOut => NATIVE_ACCOUNT_LOGIN_TIMED_OUT_MESSAGE,
            Self::LoginCancelled => NATIVE_ACCOUNT_LOGIN_CANCELLED_MESSAGE,
            Self::LoginStartFailed => NATIVE_ACCOUNT_LOGIN_START_FAILED_MESSAGE,
            Self::DisconnectFirst => NATIVE_ACCOUNT_DISCONNECT_FIRST_MESSAGE,
            Self::AccountChanged => NATIVE_ACCOUNT_CHANGED_MESSAGE,
            Self::IdentityChanged => NATIVE_ACCOUNT_IDENTITY_CHANGED_MESSAGE,
            Self::IdentityUnverified => NATIVE_ACCOUNT_IDENTITY_UNVERIFIED_MESSAGE,
            Self::OperationFailed => NATIVE_ACCOUNT_OPERATION_FAILED_MESSAGE,
            Self::OperationRunning => NATIVE_ACCOUNT_OPERATION_RUNNING_MESSAGE,
            Self::TooManyOperations => NATIVE_ACCOUNT_TOO_MANY_OPERATIONS_MESSAGE,
            Self::LabelInvalid => NATIVE_ACCOUNT_LABEL_INVALID_MESSAGE,
            Self::NotVerified => NATIVE_ACCOUNT_NOT_VERIFIED_MESSAGE,
            Self::AccountRemoved => NATIVE_ACCOUNT_REMOVED_MESSAGE,
            Self::NotSelected => NATIVE_ACCOUNT_NOT_SELECTED_MESSAGE,
            Self::ExecutableChanged => NATIVE_ACCOUNT_EXECUTABLE_CHANGED_MESSAGE,
        }
    }

    pub fn message(self) -> Message {
        Message::new(self.template())
    }

    /// The coded failure behind `error`, or [`Self::Failed`] (logging the
    /// detail) when it has no sentence of its own.
    pub fn of(error: &anyhow::Error) -> Self {
        if let Some(known) = error.downcast_ref::<Self>() {
            return *known;
        }
        tracing::warn!(error = %format!("{error:#}"), "native account operation failed");
        Self::Failed
    }

    /// `{ error, code, i18n }`: the body of a failed native-account route.
    pub fn body(self) -> Value {
        let message = self.message();
        json!({ "error": message.render("en"), "code": self.code(), "i18n": message.to_wire() })
    }
}

impl std::fmt::Display for NativeAccountError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message().render("en"))
    }
}

impl std::error::Error for NativeAccountError {}
