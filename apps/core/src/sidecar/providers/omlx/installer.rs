//! oMLX installer — Apple-Silicon, **PATH-adopt + best-effort install**.
//!
//! Unlike mlx-lm / mlx-vlm, oMLX (jundot/omlx) is **not on PyPI as a plain
//! package**: the documented installs are Homebrew (`brew tap jundot/omlx … &&
//! brew install omlx`), a `.dmg`, or `git clone … && pip install -e .`. It ships
//! an `omlx` **console-script binary** (`omlx serve`), not a `python -m` module.
//!
//! So this installer follows the Tailscale pattern (#478): it primarily *adopts*
//! an `omlx` binary the user already installed, and only *attempts* an install as
//! a best-effort fallback (Homebrew if present, else `pip install git+…`). On a
//! non-Apple-Silicon node it refuses outright. Because we cannot run oMLX here to
//! verify its exact CLI, the auto-install path is best-effort and the binary is
//! resolved defensively across the usual install locations.

use anyhow::{bail, Result};
use tokio::process::Command;

use crate::catalog::registry;
use crate::sidecar::download_manager::VersionStore;
use crate::win_process::NoWindow;

/// Key under which the installed/adopted version is recorded in `versions.json`.
pub const VERSION_KEY: &str = "omlx";

/// The upstream git repo used for the best-effort `pip install git+…` fallback.
pub const GIT_URL: &str = "https://github.com/jundot/omlx.git";

/// Bail unless this node is Apple Silicon. Shared by `ensure_installed` and the
/// provider's `start()` so the node-gate holds regardless of entry path.
pub fn ensure_supported() -> Result<()> {
    if registry::supported_on_node(VERSION_KEY) {
        return Ok(());
    }
    bail!(
        "oMLX requires Apple Silicon (arm64 macOS); this node is {}/{}",
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

/// Resolve the `omlx` console-script binary. Tries the bare name first (so a
/// `PATH` entry wins), then the usual install locations — Homebrew on Apple
/// Silicon (`/opt/homebrew/bin`) and Intel (`/usr/local/bin`), a pip `--user`
/// console script (`~/.local/bin`), and Ryu's own bin dir. Returns the first
/// candidate whose `omlx --help` exits successfully.
pub async fn omlx_binary() -> Option<String> {
    let mut candidates = vec!["omlx".to_string()];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin/omlx").to_string_lossy().into_owned());
    }
    candidates.push("/opt/homebrew/bin/omlx".to_string());
    candidates.push("/usr/local/bin/omlx".to_string());

    for cand in candidates {
        if let Ok(out) = Command::new(&cand).arg("--help").no_window().output().await {
            if out.status.success() {
                return Some(cand);
            }
        }
    }
    None
}

/// Returns `true` when `brew` is available on this node.
async fn brew_available() -> bool {
    Command::new("brew")
        .arg("--version")
        .no_window()
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Locate a usable Python interpreter (python3 or python) for the pip fallback.
async fn python_cmd() -> Option<String> {
    for candidate in ["python3", "python"] {
        if let Ok(output) = Command::new(candidate)
            .args(["--version"])
            .no_window()
            .output()
            .await
        {
            if output.status.success() {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

pub async fn ensure_installed() -> Result<()> {
    ensure_supported()?;

    // 1. Already present (adopted or recorded) → done.
    if let Some(bin) = omlx_binary().await {
        tracing::info!("oMLX adopted at {bin} — skipping install");
        VersionStore::set_version_persisted(VERSION_KEY, "adopted").ok();
        return Ok(());
    }
    if VersionStore::load().versions.contains_key(VERSION_KEY) {
        // Recorded previously but the binary moved/uninstalled — fall through to
        // re-install rather than trusting a stale record.
        tracing::warn!("oMLX recorded but binary not found — attempting (re)install");
    }

    // 2. Best-effort install: prefer Homebrew (the documented happy path).
    if brew_available().await {
        tracing::info!("installing oMLX via Homebrew");
        let _ = Command::new("brew")
            .args(["tap", "jundot/omlx", GIT_URL])
            .no_window()
            .status()
            .await;
        let status = Command::new("brew")
            .args(["install", "omlx"])
            .no_window()
            .status()
            .await;
        if matches!(status, Ok(s) if s.success()) {
            if let Some(bin) = omlx_binary().await {
                tracing::info!("oMLX installed via Homebrew at {bin}");
                VersionStore::set_version_persisted(VERSION_KEY, "brew").ok();
                return Ok(());
            }
        }
        tracing::warn!("Homebrew install of oMLX did not produce a usable binary");
    }

    // 3. Fallback: pip install from the git repo (console script lands in the
    //    interpreter's bin dir, which `omlx_binary()` searches).
    if let Some(python) = python_cmd().await {
        tracing::info!("installing oMLX via pip from {GIT_URL}");
        let status = Command::new(&python)
            .args(["-m", "pip", "install", &format!("git+{GIT_URL}")])
            .no_window()
            .status()
            .await;
        if matches!(status, Ok(s) if s.success()) {
            if let Some(bin) = omlx_binary().await {
                tracing::info!("oMLX installed via pip at {bin}");
                VersionStore::set_version_persisted(VERSION_KEY, "pip-git").ok();
                return Ok(());
            }
        }
    }

    bail!(
        "Could not install oMLX automatically. Install it manually on this Mac \
         (Homebrew: `brew tap jundot/omlx {GIT_URL} && brew install omlx`, or download \
         the .dmg from https://github.com/jundot/omlx/releases), then it will be adopted."
    )
}
