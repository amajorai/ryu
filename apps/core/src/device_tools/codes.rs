//! Stable device-lane error codes (design §1.7) with user-safe messages.
//!
//! The codes are the wire contract every client switches on; the messages are
//! what the model sees in `{"ok":false,"code","message"}`. Device-lane strings
//! never say "browser".

use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum DeviceErrorCode {
    DeviceUnavailable,
    DeviceNotPaired,
    ForegroundRequired,
    DeviceLocked,
    PermissionDenied,
    PermissionLimited,
    PermissionPending,
    UserDisabled,
    AdminBlocked,
    UnsupportedPlatform,
    UnsupportedOs,
    NotOwnChat,
    RecurringEvent,
    HasAttendees,
    OutOfRange,
    NotFound,
    QuotaExceeded,
    ApprovalRequired,
    ApprovalTimeout,
    AlreadyClaimed,
    InputMismatch,
    DeviceTimeout,
    PendingOnDevice,
    CancelledByUser,
    OsError,
    /// The input does not match the catalog schema.
    InvalidInput,
    /// A device-lane request whose signature, timestamp or identity is wrong.
    InvalidSignature,
}

const ALL: &[DeviceErrorCode] = &[
    DeviceErrorCode::DeviceUnavailable,
    DeviceErrorCode::DeviceNotPaired,
    DeviceErrorCode::ForegroundRequired,
    DeviceErrorCode::DeviceLocked,
    DeviceErrorCode::PermissionDenied,
    DeviceErrorCode::PermissionLimited,
    DeviceErrorCode::PermissionPending,
    DeviceErrorCode::UserDisabled,
    DeviceErrorCode::AdminBlocked,
    DeviceErrorCode::UnsupportedPlatform,
    DeviceErrorCode::UnsupportedOs,
    DeviceErrorCode::NotOwnChat,
    DeviceErrorCode::RecurringEvent,
    DeviceErrorCode::HasAttendees,
    DeviceErrorCode::OutOfRange,
    DeviceErrorCode::NotFound,
    DeviceErrorCode::QuotaExceeded,
    DeviceErrorCode::ApprovalRequired,
    DeviceErrorCode::ApprovalTimeout,
    DeviceErrorCode::AlreadyClaimed,
    DeviceErrorCode::InputMismatch,
    DeviceErrorCode::DeviceTimeout,
    DeviceErrorCode::PendingOnDevice,
    DeviceErrorCode::CancelledByUser,
    DeviceErrorCode::OsError,
    DeviceErrorCode::InvalidInput,
    DeviceErrorCode::InvalidSignature,
];

impl DeviceErrorCode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::DeviceUnavailable => "device_unavailable",
            Self::DeviceNotPaired => "device_not_paired",
            Self::ForegroundRequired => "foreground_required",
            Self::DeviceLocked => "device_locked",
            Self::PermissionDenied => "permission_denied",
            Self::PermissionLimited => "permission_limited",
            Self::PermissionPending => "permission_pending",
            Self::UserDisabled => "user_disabled",
            Self::AdminBlocked => "admin_blocked",
            Self::UnsupportedPlatform => "unsupported_platform",
            Self::UnsupportedOs => "unsupported_os",
            Self::NotOwnChat => "not_own_chat",
            Self::RecurringEvent => "recurring_event",
            Self::HasAttendees => "has_attendees",
            Self::OutOfRange => "out_of_range",
            Self::NotFound => "not_found",
            Self::QuotaExceeded => "quota_exceeded",
            Self::ApprovalRequired => "approval_required",
            Self::ApprovalTimeout => "approval_timeout",
            Self::AlreadyClaimed => "already_claimed",
            Self::InputMismatch => "input_mismatch",
            Self::DeviceTimeout => "device_timeout",
            Self::PendingOnDevice => "pending_on_device",
            Self::CancelledByUser => "cancelled_by_user",
            Self::OsError => "os_error",
            Self::InvalidInput => "invalid_input",
            Self::InvalidSignature => "invalid_signature",
        }
    }

    pub(crate) fn parse(code: &str) -> Option<Self> {
        ALL.iter()
            .copied()
            .find(|candidate| candidate.as_str() == code)
    }

    /// The user-safe sentence the model (and a card) may show.
    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::DeviceUnavailable => {
                "The phone is not available. Open Ryu on the phone and try again."
            }
            Self::DeviceNotPaired => "This phone is not set up to let Ryu use its apps.",
            Self::ForegroundRequired => "Open Ryu on the phone to let it use the phone's apps.",
            Self::DeviceLocked => "Unlock the phone to let Ryu use its apps.",
            Self::PermissionDenied => "The app's permission is turned off on the phone.",
            Self::PermissionLimited => "The phone only gave Ryu limited access to this app.",
            Self::PermissionPending => "The phone has not answered the permission request yet.",
            Self::UserDisabled => "The user turned this app off for Ryu.",
            Self::AdminBlocked => "Your organization does not allow this phone action.",
            Self::UnsupportedPlatform => "This app is not available on the user's phone.",
            Self::UnsupportedOs => "This phone's system version does not support this action.",
            Self::NotOwnChat => "Phone apps are only available in your own chats.",
            Self::RecurringEvent => "Repeating items cannot be changed from Ryu.",
            Self::HasAttendees => "Events with other people cannot be changed from Ryu.",
            Self::OutOfRange => "A value is outside the allowed range.",
            Self::NotFound => "The item was not found on the phone.",
            Self::QuotaExceeded => "Too many phone actions in a short time. Try again later.",
            Self::ApprovalRequired => "This action needs the user's approval.",
            Self::ApprovalTimeout => "The approval request expired.",
            Self::AlreadyClaimed => "This phone action was already started.",
            Self::InputMismatch => "The action changed after it was approved.",
            Self::DeviceTimeout => "The phone did not finish in time.",
            Self::PendingOnDevice => "Waiting for the phone.",
            Self::CancelledByUser => "The user declined this phone action.",
            Self::OsError => "The phone could not complete the action.",
            Self::InvalidInput => "The action's input is not valid.",
            Self::InvalidSignature => "The phone's request could not be verified.",
        }
    }

    /// The `{"ok":false,...}` result envelope the model receives.
    pub(crate) fn envelope(self) -> Value {
        serde_json::json!({ "ok": false, "code": self.as_str(), "message": self.message() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_round_trips_and_never_mentions_the_browser() {
        for code in ALL {
            assert_eq!(DeviceErrorCode::parse(code.as_str()), Some(*code));
            assert!(!code.message().to_ascii_lowercase().contains("browser"));
            let envelope = code.envelope();
            assert_eq!(envelope["ok"], false);
            assert_eq!(envelope["code"], code.as_str());
        }
        assert_eq!(DeviceErrorCode::parse("flag_off"), None);
    }
}
