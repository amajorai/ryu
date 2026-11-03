//! The coded failures `shell_execute` rejects with.
//!
//! Same rule as `fs_command_error.rs`: the native layer never words a
//! user-facing sentence. `shell_execute` rejects with a plain `code[:detail]`
//! string; the webview maps the code to one whole translated sentence and
//! interpolates the detail (a folder path) as a value
//! (`apps/desktop/src/lib/desktop-command-error-messages.ts`). Codes are wire
//! names, so renaming one is a breaking change there.

/// The requested working directory does not exist (detail: the folder).
pub const INVALID_CWD: &str = "invalid_cwd";
/// The requested working directory is not a folder (detail: the path).
pub const CWD_NOT_DIR: &str = "cwd_not_dir";
/// An environment variable name is not a portable shell name (detail: name).
pub const INVALID_ENV_NAME: &str = "invalid_env_name";
/// The shell process could not be started (detail: the raw spawn error).
pub const SPAWN_FAILED: &str = "spawn_failed";

/// `invalid_cwd:<dir>`.
pub fn invalid_cwd(dir: &str) -> String {
    format!("{INVALID_CWD}:{dir}")
}

/// `cwd_not_dir:<dir>`.
pub fn cwd_not_dir(dir: &str) -> String {
    format!("{CWD_NOT_DIR}:{dir}")
}

/// `invalid_env_name:<key>`.
pub fn invalid_env_name(key: &str) -> String {
    format!("{INVALID_ENV_NAME}:{key}")
}

/// `spawn_failed:<raw error>`.
pub fn spawn_failed(error: &impl std::fmt::Display) -> String {
    format!("{SPAWN_FAILED}:{error}")
}

/// Canonicalize a requested working directory, rejecting a missing path or a
/// non-folder with its code (symlinks and `..` traversal are resolved).
pub fn resolve_cwd(cwd: Option<&str>) -> Result<Option<std::path::PathBuf>, String> {
    let Some(dir) = cwd else {
        return Ok(None);
    };
    let canonical = std::fs::canonicalize(dir).map_err(|_| invalid_cwd(dir))?;
    if !canonical.is_dir() {
        return Err(cwd_not_dir(dir));
    }
    Ok(Some(canonical))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_carry_their_value_after_the_first_colon() {
        assert_eq!(invalid_cwd("/gone"), "invalid_cwd:/gone");
        assert_eq!(cwd_not_dir("/tmp/a.txt"), "cwd_not_dir:/tmp/a.txt");
        assert_eq!(invalid_env_name("1BAD"), "invalid_env_name:1BAD");
        assert_eq!(spawn_failed(&"no shell"), "spawn_failed:no shell");
        assert_eq!(
            invalid_cwd("C:\\work").split_once(':'),
            Some(("invalid_cwd", "C:\\work"))
        );
    }

    #[test]
    fn resolve_cwd_codes_a_missing_folder_and_a_file() {
        assert_eq!(resolve_cwd(None), Ok(None));
        let directory = tempfile::tempdir().unwrap();
        let folder = directory.path().to_string_lossy().into_owned();
        assert!(resolve_cwd(Some(&folder)).unwrap().unwrap().is_dir());
        let missing = directory.path().join("gone").to_string_lossy().into_owned();
        assert_eq!(
            resolve_cwd(Some(&missing)),
            Err(format!("invalid_cwd:{missing}"))
        );
        let file = directory.path().join("note.txt");
        std::fs::write(&file, b"x").unwrap();
        let file = file.to_string_lossy().into_owned();
        assert_eq!(resolve_cwd(Some(&file)), Err(format!("cwd_not_dir:{file}")));
    }
}
