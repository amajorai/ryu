//! apfel installer — node-gate + PATH detection + best-effort `brew install`.
//!
//! [apfel](https://github.com/Arthur-Ficial/apfel) exposes Apple's on-device
//! Foundation Models (Apple Intelligence) as an **OpenAI-compatible HTTP server**
//! (`apfel --serve` on `http://localhost:11434/v1`). It is therefore adopted like
//! Ollama — a binary Ryu drives, not a weight file it downloads. Apple FM runs
//! ONLY on Apple Silicon Macs on macOS 26+ with Apple Intelligence enabled, so
//! every entry point gates on [`registry::supported_on_node("apfel")`] first —
//! the check is on the CORE NODE's own OS/arch/version (authoritative because the
//! desktop driving it may be a remote machine).
//!
//! Unlike a pip/download engine, apfel is distributed via Homebrew
//! (`brew install apfel`). We PATH-detect an existing install first and only fall
//! back to a best-effort `brew install`; a missing Homebrew is a clear, actionable
//! error rather than a silent failure.

use anyhow::{bail, Context, Result};
use tokio::process::Command;

use crate::catalog::registry;
use crate::sidecar::download_manager::VersionStore;
use crate::win_process::NoWindow;

/// Version-store key recording that apfel is present on this node.
pub const VERSION_KEY: &str = "apfel";

/// Bail unless this node can run Apple Foundation Models (Apple Silicon macOS
/// 26+). Shared by `ensure_installed` and the provider's `start()` so the
/// node-gate holds regardless of entry path.
pub fn ensure_supported() -> Result<()> {
    if registry::supported_on_node("apfel") {
        return Ok(());
    }
    bail!(
        "Apple Foundation Models require an Apple Silicon Mac on macOS 26+; this node is {}/{}",
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

/// Whether the `apfel` binary is resolvable on PATH (includes `~/.ryu/bin` and
/// the Homebrew prefix). `apfel --version` is the cheapest liveness probe.
pub async fn is_installed() -> bool {
    Command::new("apfel")
        .arg("--version")
        .no_window()
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Ensure apfel is available: PATH-detect first, else attempt a best-effort
/// `brew install apfel`. Records presence in the version store so the catalog
/// reports it installed. Never downloads model weights — Apple FM is a built-in
/// OS model with nothing to fetch.
pub async fn ensure_installed() -> Result<()> {
    ensure_supported()?;

    // Fast path: already recorded, and still resolvable.
    let store = VersionStore::load();
    if store.versions.contains_key(VERSION_KEY) && is_installed().await {
        tracing::info!("apfel already installed — skipping");
        return Ok(());
    }

    if is_installed().await {
        record_version().await;
        return Ok(());
    }

    // Not on PATH — try Homebrew. `brew` is near-universal on Mac dev machines
    // and is apfel's documented install path (`brew install apfel`).
    let brew_ok = Command::new("brew")
        .arg("--version")
        .no_window()
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !brew_ok {
        bail!(
            "apfel is not installed and Homebrew was not found. Install Homebrew \
             (https://brew.sh) then run `brew install apfel`, or install apfel manually."
        );
    }

    tracing::info!("installing apfel via `brew install apfel`");
    let status = Command::new("brew")
        .args(["install", "apfel"])
        .no_window()
        .status()
        .await
        .context("running `brew install apfel`")?;
    if !status.success() {
        bail!(
            "`brew install apfel` failed with {status}. Install it manually per \
             https://github.com/Arthur-Ficial/apfel"
        );
    }

    if !is_installed().await {
        bail!("apfel installed but is still not resolvable on PATH");
    }
    record_version().await;
    Ok(())
}

/// Query `apfel --version` and persist it (best-effort; falls back to "latest").
async fn record_version() {
    let version = Command::new("apfel")
        .arg("--version")
        .no_window()
        .output()
        .await
        .ok()
        .and_then(|o| {
            let text = String::from_utf8_lossy(&o.stdout);
            text.split_whitespace()
                .find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit()))
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "latest".to_string());

    if let Err(e) = VersionStore::set_version_persisted(VERSION_KEY, &version) {
        tracing::warn!("could not persist apfel version: {e}");
    } else {
        tracing::info!("apfel {version} recorded");
    }
}
