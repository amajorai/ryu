//! Writing the Node bridge into the managed Pi prefix and finding a runtime for it.

use super::*;

/// Write the Node bridge into the managed Pi prefix, refreshing it whenever the
/// embedded copy differs (a Core upgrade must not leave a stale bridge behind).
pub(super) fn ensure_bridge() -> Result<std::path::PathBuf> {
    let _write_guard = BRIDGE_WRITE_LOCK.lock().expect("OAuth bridge write lock");
    let dir = crate::sidecar::adapters::acp::managed_pi_dir();
    if !dir.join("node_modules").is_dir() {
        return Err(anyhow!(
            "the managed Pi engine is not installed yet, so there is no OAuth flow to run — install it from Settings first"
        ));
    }
    // The module the bridge imports goes first, so a new bridge never runs
    // beside a missing or stale one.
    for (name, source) in [
        (BRIDGE_PROXY_FILE, BRIDGE_PROXY_SOURCE),
        (BRIDGE_FILE, BRIDGE_SOURCE),
    ] {
        let path = dir.join(name);
        if std::fs::read_to_string(&path).unwrap_or_default() != source {
            std::fs::write(&path, source)?;
        }
    }
    Ok(dir.join(BRIDGE_FILE))
}

/// The runtimes that can host the bridge, in priority order. Node first,
/// deliberately: the flow modules reach `node:http` / `node:crypto` through an
/// indirection that exists to defeat bundlers, and Node is what pi-ai targets.
const JS_RUNTIMES: [&str; 2] = ["node", "bun"];

/// Resolve a JavaScript runtime for the bridge, as an **absolute path**.
///
/// A bare `PATH` scan for the literal name is not enough, and got this wrong in
/// both directions:
/// - on Windows the interpreter is `node.exe` / `bun.exe`, so probing
///   `<dir>/node` matched nothing on every Windows host — a user with Node
///   installed was told to install Node, and the login 400'd before it started.
///   [`crate::sidecar::manifest_sidecar::which_on_path`] already knows the
///   extension rule (and why `Command::new` cannot spawn a bare `.cmd`), so this
///   reuses it rather than keeping a third, subtly-different copy;
/// - a macOS app launched from Finder inherits a minimal
///   `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) that contains no Node install, so
///   the GUI case fails where a terminal launch works. The common install
///   prefixes are probed explicitly, mirroring
///   `skills_catalog::from_source::install_from_source`.
///
/// PATH still wins over the well-known prefixes — a user who put a specific
/// runtime on their PATH meant it.
pub(super) fn js_runtime() -> Option<std::path::PathBuf> {
    for candidate in JS_RUNTIMES {
        if let Some(found) = crate::sidecar::manifest_sidecar::which_on_path(candidate) {
            return Some(found);
        }
    }
    for candidate in JS_RUNTIMES {
        if let Some(found) = well_known_runtime(candidate) {
            return Some(found);
        }
    }
    None
}

/// Install prefixes a process that did not inherit a login shell's `PATH` still
/// has to look in.
#[cfg(windows)]
fn well_known_runtime(binary: &str) -> Option<std::path::PathBuf> {
    let exe = format!("{binary}.exe");
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        roots.push(
            std::path::PathBuf::from(program_files)
                .join("nodejs")
                .join(&exe),
        );
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = std::path::PathBuf::from(local);
        roots.push(local.join("Programs").join("nodejs").join(&exe));
        // winget shims every package it installs into this one directory.
        roots.push(
            local
                .join("Microsoft")
                .join("WinGet")
                .join("Links")
                .join(&exe),
        );
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".bun").join("bin").join(&exe));
    }
    roots.into_iter().find(|p| p.is_file())
}

#[cfg(not(windows))]
fn well_known_runtime(binary: &str) -> Option<std::path::PathBuf> {
    let mut roots: Vec<std::path::PathBuf> = vec![
        std::path::PathBuf::from("/opt/homebrew/bin").join(binary),
        std::path::PathBuf::from("/usr/local/bin").join(binary),
        std::path::PathBuf::from("/usr/bin").join(binary),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join(".bun").join("bin").join(binary));
        roots.push(home.join(".volta").join("bin").join(binary));
        roots.push(home.join(".local").join("bin").join(binary));
        // nvm keeps one bin dir per installed Node version.
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm").join("versions").join("node")) {
            for entry in entries.flatten() {
                roots.push(entry.path().join("bin").join(binary));
            }
        }
    }
    roots.into_iter().find(|p| p.is_file())
}
