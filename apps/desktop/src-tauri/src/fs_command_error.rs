//! The failure shape the workspace-move and data-folder commands hand to the
//! webview.
//!
//! Same contract as `quick_capture/native_error.rs` and `update_error.rs`: the
//! native layer never words a user-facing sentence. `list_workspace_files`,
//! `move_workspace_item`, `open_workspace_item`, `reveal_workspace_item`,
//! `open_in_editor` and the data-folder commands (`migrate_data_folder`,
//! `import_data_folder`, `copy_data_folder_to_profile`, `deep_clean_node`)
//! reject with a stable [`FsCommandErrorCode`] and keep the raw OS error or
//! `ryu-core` stderr in `detail`, which is logged, never shown as the sentence.
//! The webview maps each code to one whole translated sentence
//! (`apps/desktop/src/lib/fs-command-error.ts`). Codes are wire names
//! (`snake_case`), so renaming a variant is a breaking change there.

use serde::Serialize;

/// Why a workspace-item or data-folder command failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FsCommandErrorCode {
    /// The item name is empty, traverses, or is reserved by the platform.
    InvalidName,
    /// A folder would move into itself or one of its own subfolders.
    IntoDescendant,
    /// The path leaves the project folder (a symlink, junction or escape).
    OutsideProject,
    /// The item or one of its parent folders no longer exists.
    ItemUnavailable,
    /// Only regular files and folders can be moved.
    UnsupportedItem,
    /// An item with the destination name already exists there.
    DestinationExists,
    /// The project folder itself is missing or not a folder.
    WorkspaceUnavailable,
    /// The project's files could not be listed.
    ListFailed,
    /// The move failed for another reason (see `detail`).
    MoveFailed,
    /// An app update is in progress, so the data folder cannot change.
    UpdatePending,
    /// Ryu Core is still running and could not be stopped.
    CoreRunning,
    /// Ryu Core could not be stopped before the data-folder change.
    CoreStopFailed,
    /// The `ryu-core` binary was not found.
    CoreMissing,
    /// The backup is encrypted and no passphrase was given.
    PassphraseRequired,
    /// The passphrase did not decrypt the backup (or the file is damaged).
    WrongPassphrase,
    /// The `ryu-core data-path` subcommand failed (stderr in `detail`).
    DataCommandFailed,
    /// The path to open is malformed (absolute, flag-like or a URL).
    InvalidPath,
    /// The requested editor or launcher is unknown or not on this platform.
    EditorUnavailable,
    /// The editor, opener or file manager could not be started (see `detail`).
    LaunchFailed,
}

/// A coded failure: `{ "code": "...", "detail"?: "..." }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FsCommandError {
    pub code: FsCommandErrorCode,
    /// The raw technical cause, never a sentence meant for the user.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl FsCommandError {
    pub fn new(code: FsCommandErrorCode) -> Self {
        Self { code, detail: None }
    }

    pub fn with_detail(code: FsCommandErrorCode, detail: impl ToString) -> Self {
        Self {
            code,
            detail: Some(detail.to_string()),
        }
    }

    /// Classify an OS error from a rename or lookup. `fallback` is the code for
    /// any error that is not a collision, a missing item or a symlink.
    pub fn from_io(error: &std::io::Error, fallback: FsCommandErrorCode) -> Self {
        use std::io::ErrorKind;
        let code = match error.kind() {
            ErrorKind::AlreadyExists | ErrorKind::DirectoryNotEmpty => {
                FsCommandErrorCode::DestinationExists
            }
            ErrorKind::NotFound => FsCommandErrorCode::ItemUnavailable,
            // `O_DIRECTORY | O_NOFOLLOW` on a symlinked parent reports ENOTDIR
            // on Linux (ELOOP elsewhere, which the caller matches since it owns
            // the platform constants): the path leaves the project.
            ErrorKind::NotADirectory => FsCommandErrorCode::OutsideProject,
            _ => fallback,
        };
        Self::with_detail(code, error)
    }

    /// Classify the stderr of a failed `ryu-core data-path` subcommand. The two
    /// passphrase failures the user can fix get their own codes; Core words
    /// them in `data_path.rs` (`open_data_archive`).
    pub fn from_data_command(stderr: String) -> Self {
        let code = if stderr.contains("wrong passphrase or damaged file") {
            FsCommandErrorCode::WrongPassphrase
        } else if stderr.contains("supply its passphrase") {
            FsCommandErrorCode::PassphraseRequired
        } else {
            FsCommandErrorCode::DataCommandFailed
        };
        Self::with_detail(code, stderr)
    }
}

impl std::fmt::Display for FsCommandError {
    /// Log form only; the webview words the user-facing sentence.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = serde_json::to_value(self.code).unwrap_or_default();
        f.write_str(code.as_str().unwrap_or("unknown"))?;
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
    fn errors_serialize_to_a_code_and_detail_never_a_sentence() {
        assert_eq!(
            serde_json::to_value(FsCommandError::new(FsCommandErrorCode::IntoDescendant)).unwrap(),
            json!({ "code": "into_descendant" })
        );
        let exists = FsCommandError::from_io(
            &std::io::Error::from(std::io::ErrorKind::AlreadyExists),
            FsCommandErrorCode::MoveFailed,
        );
        assert_eq!(exists.code, FsCommandErrorCode::DestinationExists);
        assert!(exists.detail.is_some());
        let missing = FsCommandError::from_io(
            &std::io::Error::from(std::io::ErrorKind::NotFound),
            FsCommandErrorCode::MoveFailed,
        );
        assert_eq!(missing.code, FsCommandErrorCode::ItemUnavailable);
        let other = FsCommandError::from_io(
            &std::io::Error::from(std::io::ErrorKind::PermissionDenied),
            FsCommandErrorCode::MoveFailed,
        );
        assert_eq!(other.code, FsCommandErrorCode::MoveFailed);
        assert_eq!(
            FsCommandError::with_detail(FsCommandErrorCode::CoreMissing, "not on PATH").to_string(),
            "core_missing: not on PATH"
        );
    }

    #[test]
    fn data_command_stderr_keeps_the_passphrase_failures_apart() {
        let wrong = FsCommandError::from_data_command(
            "data-path import failed: could not decrypt the data backup: wrong passphrase or damaged file".into(),
        );
        assert_eq!(wrong.code, FsCommandErrorCode::WrongPassphrase);
        let required = FsCommandError::from_data_command(
            "data-path import failed: this data backup is encrypted; supply its passphrase to restore it".into(),
        );
        assert_eq!(required.code, FsCommandErrorCode::PassphraseRequired);
        let other = FsCommandError::from_data_command("disk full".into());
        assert_eq!(other.code, FsCommandErrorCode::DataCommandFailed);
        assert_eq!(other.detail.as_deref(), Some("disk full"));
    }

    #[test]
    fn every_code_has_a_snake_case_wire_name() {
        use FsCommandErrorCode::*;
        for (code, wire) in [
            (InvalidName, "invalid_name"),
            (IntoDescendant, "into_descendant"),
            (OutsideProject, "outside_project"),
            (ItemUnavailable, "item_unavailable"),
            (UnsupportedItem, "unsupported_item"),
            (DestinationExists, "destination_exists"),
            (WorkspaceUnavailable, "workspace_unavailable"),
            (ListFailed, "list_failed"),
            (MoveFailed, "move_failed"),
            (UpdatePending, "update_pending"),
            (CoreRunning, "core_running"),
            (CoreStopFailed, "core_stop_failed"),
            (CoreMissing, "core_missing"),
            (PassphraseRequired, "passphrase_required"),
            (WrongPassphrase, "wrong_passphrase"),
            (DataCommandFailed, "data_command_failed"),
            (InvalidPath, "invalid_path"),
            (EditorUnavailable, "editor_unavailable"),
            (LaunchFailed, "launch_failed"),
        ] {
            assert_eq!(serde_json::to_value(code).unwrap(), wire);
        }
    }
}
