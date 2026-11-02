//! The failure shape the app-update commands hand to the webview.
//!
//! Same contract as `quick_capture/native_error.rs`: the native layer never
//! words a user-facing sentence. `prepare_app_update` and
//! `install_prepared_app_update` reject with a stable [`AppUpdateErrorCode`],
//! the raw `values` a sentence interpolates (versions), and the underlying
//! technical cause in `detail`, which is logged, never shown as the sentence.
//! The webview maps each code to one whole translated sentence
//! (`apps/desktop/src/components/updater/app-update-error.ts`). Codes are wire
//! names (`snake_case`), so renaming a variant is a breaking change there.

use std::collections::BTreeMap;

use serde::Serialize;

/// Why an app-update preparation or install failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppUpdateErrorCode {
    /// Another app update already waits for the restart.
    AlreadyWaiting,
    /// A window other than the main one asked to change app updates.
    NotMainWindow,
    /// The build has no updater key, or the request names an invalid version
    /// or release source.
    NotConfigured,
    /// The signed feed could not be checked or the artifact not downloaded.
    DownloadFailed,
    /// The downloaded or cached artifact failed signature verification.
    SignatureInvalid,
    /// The signed feed offers another version than the one being prepared
    /// (`values.expected`, `values.offered`).
    FeedMoved,
    /// The prepared update no longer matches the signed feed.
    PreparedMismatch,
    /// The prepared update could not be read, stored or cleared.
    CacheFailed,
    /// The runtime bundled with the release could not be prepared.
    RuntimePrepareFailed,
    /// The release cannot be installed with supervised recovery from here.
    HandoffUnavailable,
    /// The local runtime could not be stopped for the update.
    RuntimeStopFailed,
    /// The local runtime (or another profile's) is still running.
    RuntimeStillRunning,
    /// The update failed and the previous runtime could not restart.
    RuntimeRestartFailed,
    /// The recovery guard did not take over the install.
    HandoffFailed,
    /// The install confirmation could not be shown or answered.
    ConfirmFailed,
}

/// A coded failure: `{ "code": "...", "values"?: {...}, "detail"?: "..." }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppUpdateError {
    pub code: AppUpdateErrorCode,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub values: BTreeMap<&'static str, String>,
    /// The raw technical cause, never a sentence meant for the user.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AppUpdateError {
    pub fn new(code: AppUpdateErrorCode) -> Self {
        Self {
            code,
            values: BTreeMap::new(),
            detail: None,
        }
    }

    pub fn with_detail(code: AppUpdateErrorCode, detail: impl ToString) -> Self {
        Self {
            detail: Some(detail.to_string()),
            ..Self::new(code)
        }
    }

    pub fn value(mut self, name: &'static str, value: impl ToString) -> Self {
        self.values.insert(name, value.to_string());
        self
    }

    /// Append a secondary technical cause (a failed cleanup) to `detail`.
    pub fn also(mut self, more: impl std::fmt::Display) -> Self {
        self.detail = Some(match self.detail.take() {
            Some(detail) => format!("{detail}. {more}"),
            None => more.to_string(),
        });
        self
    }

    pub fn feed_moved(expected: impl ToString, offered: impl ToString) -> Self {
        Self::new(AppUpdateErrorCode::FeedMoved)
            .value("expected", expected)
            .value("offered", offered)
    }
}

/// `result.coded(code)`: keep the raw error as `detail` under a stable code.
pub trait Coded<T> {
    fn coded(self, code: AppUpdateErrorCode) -> Result<T, AppUpdateError>;
}

impl<T, E: std::fmt::Display> Coded<T> for Result<T, E> {
    fn coded(self, code: AppUpdateErrorCode) -> Result<T, AppUpdateError> {
        self.map_err(|error| AppUpdateError::with_detail(code, error))
    }
}

impl std::fmt::Display for AppUpdateError {
    /// Log form only; the webview words the user-facing sentence.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = serde_json::to_value(self.code).unwrap_or_default();
        f.write_str(code.as_str().unwrap_or("unknown"))?;
        for (name, value) in &self.values {
            write!(f, " {name}={value}")?;
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

    #[test]
    fn errors_serialize_to_a_code_values_and_detail_never_a_sentence() {
        let moved = AppUpdateError::feed_moved("1.2.0", "1.3.0");
        assert_eq!(
            serde_json::to_value(&moved).unwrap(),
            serde_json::json!({
                "code": "feed_moved",
                "values": { "expected": "1.2.0", "offered": "1.3.0" }
            })
        );
        let waiting = AppUpdateError::new(AppUpdateErrorCode::AlreadyWaiting);
        assert_eq!(
            serde_json::to_value(&waiting).unwrap(),
            serde_json::json!({ "code": "already_waiting" })
        );
        let failed: Result<(), _> =
            Err::<(), _>("io: denied").coded(AppUpdateErrorCode::HandoffFailed);
        let failed = failed.unwrap_err().also("fence busy");
        assert_eq!(
            serde_json::to_value(&failed).unwrap(),
            serde_json::json!({ "code": "handoff_failed", "detail": "io: denied. fence busy" })
        );
        assert_eq!(failed.to_string(), "handoff_failed: io: denied. fence busy");
    }

    #[test]
    fn every_code_has_a_snake_case_wire_name() {
        use AppUpdateErrorCode::*;
        for (code, wire) in [
            (AlreadyWaiting, "already_waiting"),
            (NotMainWindow, "not_main_window"),
            (NotConfigured, "not_configured"),
            (DownloadFailed, "download_failed"),
            (SignatureInvalid, "signature_invalid"),
            (FeedMoved, "feed_moved"),
            (PreparedMismatch, "prepared_mismatch"),
            (CacheFailed, "cache_failed"),
            (RuntimePrepareFailed, "runtime_prepare_failed"),
            (HandoffUnavailable, "handoff_unavailable"),
            (RuntimeStopFailed, "runtime_stop_failed"),
            (RuntimeStillRunning, "runtime_still_running"),
            (RuntimeRestartFailed, "runtime_restart_failed"),
            (HandoffFailed, "handoff_failed"),
            (ConfirmFailed, "confirm_failed"),
        ] {
            assert_eq!(serde_json::to_value(code).unwrap(), wire);
        }
    }
}
