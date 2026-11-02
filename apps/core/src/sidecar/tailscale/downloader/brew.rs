//! The macOS Homebrew fallback leg of the mesh client installer.
//!
//! test-exempt: macOS-only leg that shells out to Homebrew and mutates the host;
//! it cannot run on the Linux CI hosts that run these tests.

use anyhow::{Context, Result};

use super::{CLI_BIN, DAEMON_BIN};
use crate::sidecar::download_manager::VersionStore;

/// macOS leg: adopt an existing pair, else `brew install tailscale`.
///
/// Modelled on `providers/apfel/installer.rs` for the same reason it exists there —
/// the artifact is distributed through Homebrew, not as a downloadable archive (see
/// the module doc). Brew's `tailscale` formula ships BOTH `tailscale` and
/// `tailscaled`; the GUI `Tailscale-<ver>-macos.zip` ships neither in a form we can
/// extract.
///
/// Records the **`"brew"` sentinel** rather than a real version, and that is
/// load-bearing rather than laziness: `registry::SENTINEL_VERSIONS` contains
/// `"brew"`, and `is_comparable_version` uses that list to suppress update
/// comparisons. `github::fetch_latest_version` returns `tag_name` VERBATIM
/// (`"v1.104.4"`, with the `v`), while `tailscale version` prints `1.104.4` — so the
/// moment someone "improves" this to record the real version, the two differ
/// forever and the entry shows a permanent "Update available" with a button that
/// cannot possibly clear it.
#[cfg(target_os = "macos")]
pub async fn ensure_installed_via_brew() -> Result<String> {
    use crate::win_process::NoWindow;
    use tokio::process::Command;

    const SENTINEL: &str = "brew";

    // Adopt first — the user may already have the client, and re-brewing it would
    // be a pointless (and slow) mutation of a machine we do not own.
    if super::super::resolve_mesh_pair().is_ok() {
        tracing::info!("tailscale: an existing client pair is already resolvable — adopting");
        if let Err(e) = VersionStore::set_version_persisted("tailscale", SENTINEL) {
            tracing::warn!("could not persist the tailscale version marker: {e}");
        }
        return Ok(SENTINEL.to_owned());
    }

    let brew_ok = Command::new("brew")
        .arg("--version")
        .no_window()
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !brew_ok {
        anyhow::bail!(
            "the Tailscale client is not installed and Homebrew was not found. Upstream's \
             macOS download is the GUI app bundle, which ships no `{DAEMON_BIN}` for Ryu's \
             userspace daemon — so Homebrew is the install route here. Install Homebrew \
             (https://brew.sh) then run `brew install tailscale`, or install the client \
             yourself and point RYU_TAILSCALED_BIN/RYU_TAILSCALE_BIN at it."
        );
    }

    tracing::info!("installing the Tailscale client via `brew install tailscale`");
    let status = Command::new("brew")
        .args(["install", "tailscale"])
        .no_window()
        .status()
        .await
        .context("running `brew install tailscale`")?;
    if !status.success() {
        anyhow::bail!("`brew install tailscale` failed with {status}");
    }

    // NEVER `brew services start tailscale` — see the module doc. Ryu spawns its
    // own userspace daemon against its own socket; brew's service block requires
    // root and binds the default one.
    if super::super::resolve_mesh_pair().is_err() {
        anyhow::bail!(
            "`brew install tailscale` succeeded but no complete `{DAEMON_BIN}` + `{CLI_BIN}` \
             pair is resolvable on PATH. If Homebrew's prefix is not on this process's PATH, \
             point RYU_TAILSCALED_BIN/RYU_TAILSCALE_BIN at the installed binaries."
        );
    }
    if let Err(e) = VersionStore::set_version_persisted("tailscale", SENTINEL) {
        tracing::warn!("could not persist the tailscale version marker: {e}");
    }
    Ok(SENTINEL.to_owned())
}
