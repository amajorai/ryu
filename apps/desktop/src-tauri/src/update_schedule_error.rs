//! The coded failures `set_pending_app_update` hands to the webview.
//!
//! Same rule as `file_resource_error.rs` and `update_error.rs`: the native
//! layer never words a user-facing sentence. The command rejects with a plain
//! `code[:detail]` string and the webview maps the code to one whole
//! translated sentence (`apps/desktop/src/lib/desktop-command-error-messages.ts`).
//! The detail is the raw technical cause (OS text), shown only as secondary
//! text. Codes are wire names, so renaming one is a breaking change there.

use std::path::Path;

use serde::Serialize;

/// The booked update is missing its time, version, or time zone.
pub const INVALID_REQUEST: &str = "invalid_request";
/// This machine's config directory could not be resolved.
pub const NO_CONFIG_DIR: &str = "no_config_dir";
/// The record could not be written (OS text in the detail).
pub const WRITE_FAILED: &str = "write_failed";

/// `invalid_request`.
pub fn invalid_request() -> String {
    INVALID_REQUEST.to_owned()
}

/// `write_failed:<raw cause>`.
pub fn write_failed(detail: &impl std::fmt::Display) -> String {
    format!("{WRITE_FAILED}:{detail}")
}

/// Write `value` as the record at `path`, creating its folder, with every
/// failure coded: no path is `no_config_dir`, any I/O failure `write_failed`.
pub fn write_record(path: Option<&Path>, value: &impl Serialize) -> Result<(), String> {
    let path = path.ok_or_else(|| NO_CONFIG_DIR.to_owned())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| write_failed(&error))?;
    }
    ryu_runtime_install::handoff::write_json(path, value).map_err(|error| write_failed(&error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable_wire_names() {
        assert_eq!(invalid_request(), "invalid_request");
        assert_eq!(NO_CONFIG_DIR, "no_config_dir");
        assert_eq!(write_failed(&"denied"), "write_failed:denied");
    }

    #[test]
    fn a_missing_config_dir_is_coded() {
        assert_eq!(
            write_record(None, &serde_json::json!({})),
            Err("no_config_dir".to_owned())
        );
    }

    #[test]
    fn an_unwritable_dir_maps_to_write_failed() {
        let dir = tempfile::tempdir().expect("temp dir");
        // A regular file where the record's folder should be: neither creating
        // the folder nor writing inside it can succeed, on any platform.
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, b"not a folder").expect("blocker file");
        let path = blocker.join("nested").join("pending-app-update.json");

        let error = write_record(Some(&path), &serde_json::json!({ "v": 1 }))
            .expect_err("writing under a file must fail");
        let (code, detail) = error.split_once(':').expect("coded with a detail");
        assert_eq!(code, "write_failed");
        assert!(!detail.is_empty());
    }

    #[test]
    fn a_writable_dir_stores_the_record() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("config").join("pending-app-update.json");
        write_record(Some(&path), &serde_json::json!({ "v": 1 })).expect("written");
        let stored: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read back")).expect("json");
        assert_eq!(stored, serde_json::json!({ "v": 1 }));
    }
}
