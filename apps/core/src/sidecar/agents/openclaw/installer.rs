//! OpenClaw installer — resolves the openclaw binary at `<data dir>/bin/openclaw`
//! without running onboarding.

use std::path::PathBuf;

use anyhow::Result;

use crate::sidecar::download_manager::VersionStore;

fn bin_path() -> PathBuf {
    // npm creates a `.cmd` wrapper on Windows, a plain script on Unix.
    let name = if cfg!(target_os = "windows") {
        "openclaw.cmd"
    } else {
        "openclaw"
    };
    crate::paths::bin_dir().join(name)
}

/// Returns the path to the openclaw binary under `<data dir>/bin`.
pub fn binary_path() -> PathBuf {
    bin_path()
}

/// Serializes concurrent installs. Two surfaces can ask for OpenClaw at once —
/// the Agents tab (`POST /api/agents/catalog/install`) and the Engines tab
/// (`POST /api/setup/openclaw/install`) — and both register the SAME download-center
/// id, which shares the row but does NOT dedup the work: `register_indeterminate`
/// cannot hand a second caller the first one's result, so both futures run. Two
/// simultaneous `npm install --prefix <npm prefix> openclaw@latest` into one prefix is a
/// corrupt `node_modules`, not a wasted download. Holding this lock makes the
/// second caller wait and then take the fast path below.
static INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub async fn ensure_installed() -> Result<()> {
    let _guard = INSTALL_LOCK.lock().await;
    let dest = bin_path();

    // Fast path: binary present and version recorded. Re-checked under the lock, so
    // a caller that queued behind a completed install does no work.
    let store = VersionStore::load();
    if dest.exists() && store.versions.contains_key("openclaw") {
        tracing::info!(
            "openclaw already installed at {} — skipping",
            dest.display()
        );
        return Ok(());
    }

    anyhow::bail!(
        "OpenClaw is not installed; the moving npm@latest installer is disabled. Install a pinned, independently verified OpenClaw release and retry"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_path_uses_npm_wrapper_under_ryu_bin() {
        let p = binary_path();
        assert_eq!(p, bin_path());
        // npm drops a `.cmd` wrapper on Windows, a plain shim elsewhere — both in bin/.
        assert!(p.ends_with(if cfg!(target_os = "windows") {
            "openclaw.cmd"
        } else {
            "openclaw"
        }));
        assert_eq!(p.parent().unwrap().file_name().unwrap(), "bin");
    }
}
