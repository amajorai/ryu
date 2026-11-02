//! The failure shape Quick Capture and Clips quick attach hand to the webview.
//!
//! The native layer never words a user-facing sentence. It reports a stable
//! [`NativeErrorCode`] (plus the HTTP `status` where one applies) and keeps any
//! underlying technical cause in `detail`; the webview maps the code to a whole,
//! translated sentence and shows `detail` only as a secondary technical line.
//! Codes are wire names (`snake_case`), so renaming a variant is a breaking
//! change for `apps/desktop/src/lib/native-capture-error.ts`.

use serde::Serialize;

/// Why a Quick Capture or Clips quick attach action failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeErrorCode {
    /// The keyboard event tap could not be created: Input Monitoring is not
    /// granted to Ryu.
    InputMonitoringDenied,
    /// Core answered 404 for the Quests mount: the Quests app is off.
    QuestsDisabled,
    /// The capture request never reached Core.
    CoreUnreachable,
    /// Core answered with a non-success status (carried in `status`).
    CoreRejected,
    /// Core accepted the capture but its reply could not be read.
    InvalidResponse,
    /// A listener or worker thread, hook, or HTTP client failed to start.
    WorkerFailed,
    /// The setting could not be written to the data directory.
    SettingsSaveFailed,
    /// The platform has no implementation of the gesture.
    UnsupportedPlatform,
}

impl NativeErrorCode {
    fn wire_name(self) -> &'static str {
        match self {
            Self::InputMonitoringDenied => "input_monitoring_denied",
            Self::QuestsDisabled => "quests_disabled",
            Self::CoreUnreachable => "core_unreachable",
            Self::CoreRejected => "core_rejected",
            Self::InvalidResponse => "invalid_response",
            Self::WorkerFailed => "worker_failed",
            Self::SettingsSaveFailed => "settings_save_failed",
            Self::UnsupportedPlatform => "unsupported_platform",
        }
    }
}

/// A coded failure: `{ "code": "...", "status"?: 503, "detail"?: "..." }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NativeError {
    pub code: NativeErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// The raw technical cause (an OS or HTTP client error), never a sentence
    /// meant for the user.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Prefix of the macOS tap-creation failure in `quick_capture/mac.rs`. Matching
/// it here keeps that platform file unchanged while still reporting the one
/// listener failure the user can fix (granting Input Monitoring) by its code.
const TAP_CREATE_FAILURE: &str = "couldn't create the keyboard event tap";

impl NativeError {
    pub fn new(code: NativeErrorCode) -> Self {
        Self {
            code,
            status: None,
            detail: None,
        }
    }

    pub fn with_detail(code: NativeErrorCode, detail: impl ToString) -> Self {
        Self {
            code,
            status: None,
            detail: Some(detail.to_string()),
        }
    }

    /// Classify an error string from a platform listener (`mac.rs`,
    /// `clips_quick_attach/windows.rs`).
    pub fn from_listener(message: String) -> Self {
        if message.starts_with(TAP_CREATE_FAILURE) {
            Self::new(NativeErrorCode::InputMonitoringDenied)
        } else {
            Self::with_detail(NativeErrorCode::WorkerFailed, message)
        }
    }

    pub fn settings_save(message: String) -> Self {
        Self::with_detail(NativeErrorCode::SettingsSaveFailed, message)
    }

    /// Classify Core's answer to `POST /api/quests/capture`. `None` means the
    /// status is a success.
    pub fn from_capture_status(status: u16) -> Option<Self> {
        match status {
            200..=299 => None,
            404 => Some(Self::new(NativeErrorCode::QuestsDisabled)),
            _ => Some(Self {
                code: NativeErrorCode::CoreRejected,
                status: Some(status),
                detail: None,
            }),
        }
    }
}

impl std::fmt::Display for NativeError {
    /// Log form only; the webview words the user-facing sentence.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code.wire_name())?;
        if let Some(status) = self.status {
            write!(f, " ({status})")?;
        }
        if let Some(detail) = &self.detail {
            write!(f, ": {detail}")?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codes_serialize_as_snake_case_wire_names() {
        for code in [
            NativeErrorCode::InputMonitoringDenied,
            NativeErrorCode::QuestsDisabled,
            NativeErrorCode::CoreUnreachable,
            NativeErrorCode::CoreRejected,
            NativeErrorCode::InvalidResponse,
            NativeErrorCode::WorkerFailed,
            NativeErrorCode::SettingsSaveFailed,
            NativeErrorCode::UnsupportedPlatform,
        ] {
            assert_eq!(serde_json::to_value(code).unwrap(), json!(code.wire_name()));
        }
    }

    #[test]
    fn an_error_without_status_or_detail_is_just_its_code() {
        assert_eq!(
            serde_json::to_value(NativeError::new(NativeErrorCode::QuestsDisabled)).unwrap(),
            json!({ "code": "quests_disabled" })
        );
    }

    #[test]
    fn core_rejection_carries_the_status_and_detail_carries_the_cause() {
        assert_eq!(
            serde_json::to_value(NativeError::from_capture_status(503).unwrap()).unwrap(),
            json!({ "code": "core_rejected", "status": 503 })
        );
        assert_eq!(
            serde_json::to_value(NativeError::with_detail(
                NativeErrorCode::CoreUnreachable,
                "connection refused"
            ))
            .unwrap(),
            json!({ "code": "core_unreachable", "detail": "connection refused" })
        );
    }

    #[test]
    fn capture_statuses_classify_success_quests_off_and_rejection() {
        assert_eq!(NativeError::from_capture_status(201), None);
        assert_eq!(
            NativeError::from_capture_status(404).unwrap().code,
            NativeErrorCode::QuestsDisabled
        );
        assert_eq!(
            NativeError::from_capture_status(500).unwrap().code,
            NativeErrorCode::CoreRejected
        );
    }

    #[test]
    fn the_tap_creation_failure_is_reported_as_input_monitoring_denied() {
        let tap = NativeError::from_listener(format!(
            "{TAP_CREATE_FAILURE} — grant Input Monitoring to Ryu in System Settings"
        ));
        assert_eq!(
            tap,
            NativeError::new(NativeErrorCode::InputMonitoringDenied)
        );

        let other = NativeError::from_listener("couldn't find Ryu module: 126".into());
        assert_eq!(other.code, NativeErrorCode::WorkerFailed);
        assert_eq!(
            other.detail.as_deref(),
            Some("couldn't find Ryu module: 126")
        );
    }

    #[test]
    fn display_is_a_log_line_with_status_and_detail() {
        let error = NativeError {
            code: NativeErrorCode::CoreRejected,
            status: Some(502),
            detail: Some("bad gateway".into()),
        };
        assert_eq!(error.to_string(), "core_rejected (502): bad gateway");
    }
}
