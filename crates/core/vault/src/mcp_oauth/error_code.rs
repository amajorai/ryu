//! Stable codes for why a pending OAuth flow failed.
//!
//! `FlowView::error` stays the English sentence Core has always sent, so older
//! desktops keep working; `FlowView::error_code` (and the `code` of the confirm
//! route's 400 body) lets a client word the failure in the user's language.

use serde::{Deserialize, Serialize};

pub(super) const CODE_MISMATCH_MESSAGE: &str = "OAuth confirmation code did not match";
pub(super) const TOO_MANY_ATTEMPTS_MESSAGE: &str = "Too many incorrect confirmation codes";
pub(super) const EXPIRED_MESSAGE: &str = "OAuth flow expired";
pub(super) const CANCELLED_MESSAGE: &str = "OAuth flow was cancelled before it could connect";
pub(super) const NO_LONGER_PENDING_MESSAGE: &str = "OAuth flow is no longer pending";
pub(super) const NOT_AWAITING_MESSAGE: &str = "OAuth flow is not awaiting confirmation";
pub(super) const ISSUER_MISMATCH_MESSAGE: &str = "OAuth issuer did not match";
pub(super) const ISSUER_MISSING_MESSAGE: &str = "OAuth callback omitted the required issuer";
pub(super) const HOSTED_ISSUER_MISSING_MESSAGE: &str =
    "OAuth callback omitted the required issuer: hosted callbacks need an \
     authorization server that returns the RFC 9207 `iss` parameter; \
     use a local desktop connection instead";
pub(super) const MISSING_CODE_MESSAGE: &str = "OAuth callback did not contain a code";
pub(super) const INVALID_STATE_MESSAGE: &str = "OAuth callback state is invalid or already used";
pub(super) const STATE_MISMATCH_MESSAGE: &str = "OAuth state did not match";
pub(super) const CALLBACK_USED_MESSAGE: &str = "OAuth callback was already used";
pub(super) const STATE_OMITTED_MESSAGE: &str = "OAuth callback omitted state";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FlowErrorCode {
    CodeMismatch,
    TooManyAttempts,
    Expired,
    Cancelled,
    NotAwaiting,
    IssuerMismatch,
    MissingCode,
    InvalidState,
    // Any other provider or token-exchange failure.
    Protocol,
}

/// Every English sentence the flow code sends, with its code.
const KNOWN_MESSAGES: &[(&str, FlowErrorCode)] = &[
    (CODE_MISMATCH_MESSAGE, FlowErrorCode::CodeMismatch),
    (TOO_MANY_ATTEMPTS_MESSAGE, FlowErrorCode::TooManyAttempts),
    (EXPIRED_MESSAGE, FlowErrorCode::Expired),
    (CANCELLED_MESSAGE, FlowErrorCode::Cancelled),
    (NO_LONGER_PENDING_MESSAGE, FlowErrorCode::NotAwaiting),
    (NOT_AWAITING_MESSAGE, FlowErrorCode::NotAwaiting),
    (ISSUER_MISMATCH_MESSAGE, FlowErrorCode::IssuerMismatch),
    (ISSUER_MISSING_MESSAGE, FlowErrorCode::IssuerMismatch),
    (HOSTED_ISSUER_MISSING_MESSAGE, FlowErrorCode::IssuerMismatch),
    (MISSING_CODE_MESSAGE, FlowErrorCode::MissingCode),
    (INVALID_STATE_MESSAGE, FlowErrorCode::InvalidState),
    (STATE_MISMATCH_MESSAGE, FlowErrorCode::InvalidState),
    (CALLBACK_USED_MESSAGE, FlowErrorCode::InvalidState),
    (STATE_OMITTED_MESSAGE, FlowErrorCode::InvalidState),
];

impl FlowErrorCode {
    /// The wire form, as serialized (`code_mismatch`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CodeMismatch => "code_mismatch",
            Self::TooManyAttempts => "too_many_attempts",
            Self::Expired => "expired",
            Self::Cancelled => "cancelled",
            Self::NotAwaiting => "not_awaiting",
            Self::IssuerMismatch => "issuer_mismatch",
            Self::MissingCode => "missing_code",
            Self::InvalidState => "invalid_state",
            Self::Protocol => "protocol",
        }
    }

    /// The code of a flow failure from its English message. Messages the
    /// flow code does not word itself (provider and token-endpoint errors)
    /// are `Protocol`.
    pub fn classify(message: &str) -> Self {
        KNOWN_MESSAGES
            .iter()
            .find(|(known, _)| *known == message)
            .map_or(Self::Protocol, |(_, code)| *code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_known_message_has_its_code_and_others_are_protocol() {
        assert_eq!(
            FlowErrorCode::classify(TOO_MANY_ATTEMPTS_MESSAGE),
            FlowErrorCode::TooManyAttempts
        );
        assert_eq!(
            FlowErrorCode::classify(HOSTED_ISSUER_MISSING_MESSAGE),
            FlowErrorCode::IssuerMismatch
        );
        assert_eq!(
            FlowErrorCode::classify(STATE_OMITTED_MESSAGE),
            FlowErrorCode::InvalidState
        );
        assert_eq!(
            FlowErrorCode::classify("token exchange failed: invalid_grant"),
            FlowErrorCode::Protocol
        );
    }

    #[test]
    fn the_wire_form_matches_serde() {
        for (_, code) in KNOWN_MESSAGES {
            assert_eq!(
                serde_json::to_value(code).unwrap(),
                serde_json::json!(code.as_str())
            );
        }
        assert_eq!(
            serde_json::to_value(FlowErrorCode::Protocol).unwrap(),
            serde_json::json!("protocol")
        );
    }
}
