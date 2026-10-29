//! Locate the `lean`, `bend` and `baml-cli` executables on the host.
//!
//! Resolution order: the tool's `RYU_*_BIN` override, the installer's default
//! home location (`~/.elan/bin`, `~/.bend/bin`), then `PATH`. The executable
//! names are fixed here; a workflow cannot choose which binary runs.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Absolute path override for `lean` (the same variable family as the formal
/// verification gate's `RYU_LAKE_BIN` / `RYU_BEND_BIN`).
pub const ENV_LEAN_BIN: &str = "RYU_LEAN_BIN";
/// Absolute path override for `bend`.
pub const ENV_BEND_BIN: &str = "RYU_BEND_BIN";
/// Absolute path override for `baml-cli`.
pub const ENV_BAML_BIN: &str = "RYU_BAML_BIN";

/// A toolchain executable a code step can run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Tool {
    Lean,
    Bend,
    Baml,
}

impl Tool {
    /// Executable name, without a platform suffix.
    pub(crate) fn binary(self) -> &'static str {
        match self {
            Self::Lean => "lean",
            Self::Bend => "bend",
            Self::Baml => "baml-cli",
        }
    }

    fn env_var(self) -> &'static str {
        match self {
            Self::Lean => ENV_LEAN_BIN,
            Self::Bend => ENV_BEND_BIN,
            Self::Baml => ENV_BAML_BIN,
        }
    }

    /// The installer's default bin directory, relative to the home directory.
    fn home_bin_dir(self) -> Option<&'static str> {
        match self {
            Self::Lean => Some(".elan/bin"),
            Self::Bend => Some(".bend/bin"),
            Self::Baml => None,
        }
    }

    /// One-line install hint for the "not found" error.
    pub(crate) fn install_hint(self) -> &'static str {
        match self {
            Self::Lean => "install Lean 4 with elan (https://lean-lang.org/install)",
            Self::Bend => "install Bend with `curl -fsSL https://bend-lang.com/install.sh | sh`",
            Self::Baml => {
                "install baml-cli with `pip install baml-py` or `npm install -g @boundaryml/baml`"
            }
        }
    }
}

/// Resolve `tool` against the live environment.
pub(crate) fn resolve(tool: Tool) -> Result<PathBuf, String> {
    resolve_with(
        tool,
        std::env::var_os(tool.env_var()),
        home_dir(),
        std::env::var_os("PATH"),
    )
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn executable_name(binary: &str) -> String {
    if cfg!(windows) {
        format!("{binary}.exe")
    } else {
        binary.to_string()
    }
}

/// [`resolve`] with every environment input injected, so the order is testable.
pub(crate) fn resolve_with(
    tool: Tool,
    override_path: Option<OsString>,
    home: Option<PathBuf>,
    path_var: Option<OsString>,
) -> Result<PathBuf, String> {
    if let Some(raw) = override_path.filter(|value| !value.is_empty()) {
        let candidate = PathBuf::from(raw);
        if candidate.is_file() {
            return Ok(candidate);
        }
        return Err(format!(
            "{} points at {}, which is not a file",
            tool.env_var(),
            candidate.display()
        ));
    }
    let name = executable_name(tool.binary());
    if let (Some(home), Some(dir)) = (home, tool.home_bin_dir()) {
        let candidate = home.join(dir).join(&name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    if let Some(found) = path_var
        .as_ref()
        .and_then(|paths| find_on_path(paths, &name))
    {
        return Ok(found);
    }
    Err(format!(
        "`{}` was not found on this machine; {}, or set {} to its absolute path",
        tool.binary(),
        tool.install_hint(),
        tool.env_var()
    ))
}

fn find_on_path(paths: &OsString, name: &str) -> Option<PathBuf> {
    std::env::split_paths(paths)
        .filter(|dir| !dir.as_os_str().is_empty() && dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable_file(candidate))
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}
