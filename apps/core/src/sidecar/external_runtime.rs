//! Declarative **external-runtime** provisioning (M3 / #449).
//!
//! A plugin can declare that one of its runnables needs an external language
//! runtime — today a **Python venv** with pip dependencies and fetched assets —
//! exactly like the `apps-store/voice/sidecar` (`RyuTtsManager`) precedent, but as a
//! reusable, *declarative* spec instead of bespoke per-engine code.
//!
//! ## What exists today vs. this scaffold
//!
//! The TTS sidecar's `python_program()` only *uses* a `.venv` if one already
//! exists and otherwise falls back to a bare `python3` — nothing creates the
//! venv or runs pip; the doc tells the user to `python -m venv` + `pip install`
//! by hand. The four engine installers (`mlx`/`mlx_vlm`/`vllm`/`sglang`) each
//! shell `python -m pip install <pkg>` in their own `installer.rs`. This module
//! is the **single declarative shape** those bespoke paths converge on.
//!
//! ## Scope
//!
//! The config type, OS-correct path derivation, and a best-effort [`provision`]
//! that fetches declared assets, creates the venv, and pip-installs are all real.
//! Assets are fetched through the shared [`crate::downloads::DownloadCenter`]
//! (streaming `.part` + resume + checksum) — never a hand-rolled fetcher — with
//! the source resolved by [`resolve_asset_url`] and the destination made
//! traversal-safe by [`asset_dest`]. The pure parts (URL/dest resolution, the
//! provisioning gate) are unit-tested. The working `RyuTtsManager` venv path is
//! deliberately **left untouched** here (it is live runtime we must not regress).
//!
//! ## Security gate (Core-vs-Gateway)
//!
//! Running `pip install` and fetching assets from a manifest is a network +
//! arbitrary-code surface. Provisioning is gated by [`may_provision`]: a
//! **Core-tier** (first-party) plugin is auto-allowed; a **Community-tier**
//! plugin may provision IFF the Gateway approved the [`GRANT_EXTERNAL_RUNTIME`]
//! (`runtime:external`) grant — read from the plugin's *approved* grants
//! (`PluginRecord.approved_grants`, post-Gateway-validation), never the manifest's
//! declared, unvalidated `permission_grants`. Deciding *what is allowed* is the
//! Gateway's call; this module only describes the gate + performs the install
//! once permitted. The gate is applied by the caller (see the enable path in
//! `server::provision_external_runtime`).

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use crate::win_process::NoWindow;

// The declaration types live in `plugin_manifest::schema` (so the manifest can
// carry them without depending on `sidecar`); re-exported here so callers of the
// provisioner have one import.
pub use crate::plugin_manifest::schema::{
    AssetSpec, ExternalRuntimeConfig, ModelSnapshotSpec, SourceArchiveSpec,
};

// The pip constraints, the path and name checks, the model snapshot fetch and the
// provision entry points live in `external_runtime/`. Each file there starts with
// `use super::*;`, so the imports above and the items of this file reach them exactly
// as they did in the single file.
mod model_snapshots;
mod paths;
mod pip;
mod provision;
#[cfg(test)]
mod tests;

use model_snapshots::*;
use paths::*;
pub use pip::*;
pub use provision::*;

/// The kind of external runtime a plugin declares. Open-ended (a `String`) so a
/// future `"node"`/`"deno"` runtime is a data change, not a code change —
/// "nothing hardcoded". Only `"python"` is provisionable today.
pub const RUNTIME_PYTHON: &str = "python";

/// Pip constraints for CVE-2026-111497 (Brotli / brotlicffi minimum versions).
const PIP_SECURITY_CONSTRAINTS: &str =
    include_str!("../../resources/python/pip-security-constraints.txt");

/// The Hugging Face Hub host `hf:` asset refs resolve against.
const HF_RESOLVE_HOST: &str = "https://huggingface.co";
/// The Hub tree API defaults to 50 entries, which omits allowlisted files in
/// larger repositories. Keep each metadata page and the total scan bounded.
const HF_TREE_PAGE_SIZE: usize = 100;
const MAX_HF_TREE_PAGES: usize = 10;
const MAX_HF_TREE_PAGE_BYTES: usize = 1024 * 1024;

/// The Gateway grant a Community-tier plugin must hold (approved) before it may
/// provision an external runtime. Follows the existing `category:name` grant
/// convention (`mcp:`, `hook:`, `storage:`). Core-tier plugins are auto-allowed
/// and need no grant.
pub const GRANT_EXTERNAL_RUNTIME: &str = "runtime:external";

/// Whether a plugin of `tier` holding `approved_grants` may provision an external
/// runtime. Core-tier (first-party) is always allowed; Community-tier is allowed
/// IFF the Gateway approved the [`GRANT_EXTERNAL_RUNTIME`] grant.
///
/// `approved_grants` MUST be the Gateway-approved set
/// (`crate::plugins::PluginRecord::approved_grants`), never the manifest's
/// declared, unvalidated `permission_grants` — the latter would bypass the
/// Gateway. Fail-closed: an unknown/Community plugin without the approved grant
/// does not provision. Pure so the gate is unit-tested without a live enable.
pub fn may_provision(tier: crate::plugin_manifest::PluginTier, approved_grants: &[String]) -> bool {
    match tier {
        crate::plugin_manifest::PluginTier::Core => true,
        crate::plugin_manifest::PluginTier::Community => {
            approved_grants.iter().any(|g| g == GRANT_EXTERNAL_RUNTIME)
        }
    }
}

/// The OS-correct path to the venv's Python interpreter under `dir`.
///
/// Mirrors the TTS sidecar's derivation exactly: `.venv/Scripts/python.exe` on
/// Windows, `.venv/bin/python` elsewhere. The single source of truth so a future
/// consumer never re-derives it wrong.
pub fn venv_python(dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        dir.join(".venv").join("bin").join("python")
    }
}

/// The base Python interpreter to bootstrap a venv with when none exists.
/// `python` on Windows, `python3` elsewhere (matching the TTS sidecar fallback).
pub fn bootstrap_python() -> &'static str {
    if cfg!(target_os = "windows") {
        "python"
    } else {
        "python3"
    }
}

/// Whether a venv already exists under `dir` (its interpreter is present).
pub fn venv_exists(dir: &Path) -> bool {
    venv_python(dir).exists()
}

/// Errors a provisioning attempt can surface. Provisioning is best-effort: the
/// caller logs and surfaces these, never panics, and never blocks Core startup.
#[derive(Debug)]
pub enum ProvisionError {
    /// The declared runtime kind is not provisionable (only `"python"` today).
    UnsupportedKind(String),
    /// Creating the runtime directory failed.
    Mkdir(std::io::Error),
    /// The pip security constraints file could not be written, so `pip install -c`
    /// has nothing to read. Provisioning stops rather than installing unconstrained.
    Constraints(std::io::Error),
    /// Spawning the provisioning command failed (interpreter not found, etc.).
    Spawn { cmd: String, source: std::io::Error },
    /// The provisioning command ran but exited non-zero.
    NonZeroExit {
        cmd: String,
        status: i32,
        stderr: String,
    },
    /// An asset `source` is neither an `https://` URL nor a resolvable
    /// `hf:<owner>/<repo>/<path>` reference.
    UnsupportedAssetSource(String),
    /// An asset's resolved destination would escape the runtime's dedicated
    /// `assets/` directory (traversal / absolute path or unsafe filename).
    UnsafeAssetPath(String),
    /// A package-owned source directory or model snapshot path is unsafe or
    /// unavailable.
    UnsafePackagePath(String),
    /// A model snapshot declaration is malformed or does not contain one of its
    /// requested files in the Hub tree.
    InvalidModelSnapshot(String),
    /// Fetching a declared asset failed (SSRF screen rejected it, or the download
    /// errored / mismatched its checksum).
    AssetFetch { source: String, reason: String },
}

impl std::fmt::Display for ProvisionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProvisionError::UnsupportedKind(k) => write!(
                f,
                "unsupported runtime kind '{k}' (only 'python' is provisionable today)"
            ),
            ProvisionError::Mkdir(e) => write!(f, "creating the runtime directory failed: {e}"),
            ProvisionError::Constraints(e) => {
                write!(f, "writing the pip security constraints file failed: {e}")
            }
            ProvisionError::Spawn { cmd, source } => {
                write!(f, "running '{cmd}' failed: {source}")
            }
            ProvisionError::NonZeroExit {
                cmd,
                status,
                stderr,
            } => write!(f, "'{cmd}' exited with status {status}: {stderr}"),
            ProvisionError::UnsupportedAssetSource(s) => write!(
                f,
                "unsupported asset source '{s}' (need an https:// URL or hf:<owner>/<repo>/<path>)"
            ),
            ProvisionError::UnsafeAssetPath(s) => {
                write!(f, "unsafe asset destination: {s}")
            }
            ProvisionError::UnsafePackagePath(s) => {
                write!(f, "unsafe package path: {s}")
            }
            ProvisionError::InvalidModelSnapshot(s) => {
                write!(f, "invalid model snapshot: {s}")
            }
            ProvisionError::AssetFetch { source, reason } => {
                write!(f, "fetching asset '{source}' failed: {reason}")
            }
        }
    }
}

impl std::error::Error for ProvisionError {}

/// Marker file whose presence means the source tree is already extracted into the
/// runtime dir (idempotency: a re-provision skips the download + extract).
const SOURCE_MARKER: &str = "pyproject.toml";

/// Fetch and extract the runtime's declared [`SourceArchiveSpec`] into `dir` (its
/// package root) BEFORE the venv/pip step, so an editable install (`pip install -e
/// .`) finds `pyproject.toml`. No-op when `cfg.source` is `None`.
///
/// Idempotent: skips when `dir/pyproject.toml` already exists. The archive is
/// fetched through the shared [`crate::downloads::DownloadCenter`] (SSRF-screened,
/// https-only, checksum-verified) and extracted whole-tree with the same extractors
/// the binary-sidecar path uses. Fails closed on any error.
async fn fetch_and_extract_source(
    cfg: &ExternalRuntimeConfig,
    dir: &Path,
    downloads: &crate::downloads::DownloadCenter,
    package_root: &Path,
) -> Result<(), ProvisionError> {
    let Some(source) = &cfg.source else {
        return Ok(());
    };
    if dir.join(SOURCE_MARKER).exists() {
        tracing::info!(
            "external-runtime source already extracted, skipping: {}",
            dir.display()
        );
        return Ok(());
    }

    if let Some(relative) = source
        .path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
    {
        crate::plugin_manifest::PluginManifestLoader::materialize_builtin_plugin_source(
            package_root,
            relative,
        )
        .map_err(|error| {
            ProvisionError::UnsafePackagePath(format!(
                "embedded plugin source could not be materialized: {error}"
            ))
        })?;
        let source_dir = safe_package_path(package_root, relative)?;
        fs::create_dir_all(dir).map_err(ProvisionError::Mkdir)?;
        copy_package_tree(&source_dir, dir)?;
        if !dir.join(SOURCE_MARKER).exists() {
            return Err(ProvisionError::UnsafePackagePath(format!(
                "source directory '{}' does not contain a '{SOURCE_MARKER}' at its root",
                source_dir.display()
            )));
        }
        tracing::info!(
            "external-runtime package source copied from {} into {}",
            source_dir.display(),
            dir.display()
        );
        return Ok(());
    }

    if source.url.trim().is_empty() {
        return Err(ProvisionError::AssetFetch {
            source: "<empty source url>".to_owned(),
            reason: "source must declare either 'url' or package-relative 'path'".to_owned(),
        });
    }

    // SSRF-screen the (plugin-controlled) URL, then require https.
    let parsed = crate::server::screen_agent_egress_url(&source.url)
        .await
        .map_err(|e| ProvisionError::AssetFetch {
            source: source.url.clone(),
            reason: e.to_string(),
        })?;
    if parsed.scheme() != "https" {
        return Err(ProvisionError::AssetFetch {
            source: source.url.clone(),
            reason: format!("source URL must use https, got '{}'", parsed.scheme()),
        });
    }

    // Download the archive to a temp path under `dir`, then extract it whole-tree.
    let sha = source.sha256.clone().filter(|s| !s.is_empty());
    let archive_path = dir.join(".source-archive");
    downloads
        .download_blocking(crate::downloads::DownloadSpec {
            kind: crate::downloads::DownloadKind::Other,
            role: crate::downloads::DownloadRole::Plugin,
            label: format!("plugin runtime source: {}", source.url),
            url: source.url.clone(),
            dest: archive_path.clone(),
            sha256: sha,
            version_record: None,
        })
        .await
        .map_err(|e| ProvisionError::AssetFetch {
            source: source.url.clone(),
            reason: e.to_string(),
        })?;

    let fmt = source.format.clone();
    let dest = dir.to_owned();
    let archive = archive_path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let data = std::fs::read(&archive).map_err(|e| format!("reading source archive: {e}"))?;
        use crate::sidecar::download_manager::{extract_tar_gz_to_dir, extract_zip_to_dir};
        match fmt.as_str() {
            "tar.gz" => extract_tar_gz_to_dir(&data, &dest, None).map_err(|e| e.to_string())?,
            "zip" => extract_zip_to_dir(&data, &dest, None).map_err(|e| e.to_string())?,
            other => {
                return Err(format!(
                    "unsupported source format '{other}' (need tar.gz|zip)"
                ))
            }
        };
        Ok(())
    })
    .await
    .map_err(|e| ProvisionError::AssetFetch {
        source: source.url.clone(),
        reason: format!("extraction task panicked: {e}"),
    })?
    .map_err(|reason| ProvisionError::AssetFetch {
        source: source.url.clone(),
        reason,
    })?;

    let _ = tokio::fs::remove_file(&archive_path).await;
    if !dir.join(SOURCE_MARKER).exists() {
        return Err(ProvisionError::AssetFetch {
            source: source.url.clone(),
            reason: format!("archive did not contain a '{SOURCE_MARKER}' at its root"),
        });
    }
    tracing::info!("external-runtime source extracted into {}", dir.display());
    Ok(())
}

/// Fetch every declared asset into `<runtime_dir>/assets/<dest>/<file>` via the
/// shared [`crate::downloads::DownloadCenter`] (streaming `.part` + resume +
/// checksum). Runs BEFORE the venv/pip step. Fails closed on the first error.
///
/// Idempotent: a checksum-less asset already on disk is skipped (DownloadCenter's
/// fast-path cannot skip without a checksum); a checksummed asset relies on that
/// fast-path — it skips on a matching hash and re-downloads on a mismatch, so a
/// tampered file is fail-closed rather than trusted.
///
/// Residual: the SSRF screen resolves the host but DownloadCenter re-resolves when
/// it streams, so the connection is not IP-pinned (the same TOCTOU window as the
/// shell-out crawler egress). Acceptable for provisioning; noted so it is not
/// mistaken for a pinned fetch.
async fn fetch_assets(
    cfg: &ExternalRuntimeConfig,
    runtime_dir: &Path,
    downloads: &crate::downloads::DownloadCenter,
) -> Result<(), ProvisionError> {
    for asset in &cfg.assets {
        let url = resolve_asset_url(&asset.source)?;
        let dest = asset_dest(runtime_dir, &asset.dest_under_runtime, &url)?;
        let sha = asset.sha256.clone().filter(|s| !s.is_empty());

        // Idempotency: without a checksum, an already-present file is left as-is
        // (DownloadCenter's fast-path can only skip when it has a checksum to
        // compare). With a checksum, hand to DownloadCenter — it verifies the
        // on-disk file and skips or re-downloads.
        if sha.is_none() && dest.exists() {
            tracing::info!(
                "external-runtime asset already present, skipping: {}",
                dest.display()
            );
            continue;
        }

        // SSRF screen for the (Community-plugin-controlled) URL, then require
        // https per the AssetSpec contract (the screen also permits http).
        let parsed = crate::server::screen_agent_egress_url(&url)
            .await
            .map_err(|e| ProvisionError::AssetFetch {
                source: asset.source.clone(),
                reason: e.to_string(),
            })?;
        if parsed.scheme() != "https" {
            return Err(ProvisionError::AssetFetch {
                source: asset.source.clone(),
                reason: format!("asset URL must use https, got '{}'", parsed.scheme()),
            });
        }

        let spec = crate::downloads::DownloadSpec {
            kind: crate::downloads::DownloadKind::Other,
            role: crate::downloads::DownloadRole::Plugin,
            label: format!("plugin asset: {}", asset.source),
            url: url.clone(),
            dest: dest.clone(),
            sha256: sha,
            version_record: None,
        };
        downloads
            .download_blocking(spec)
            .await
            .map_err(|e| ProvisionError::AssetFetch {
                source: asset.source.clone(),
                reason: e.to_string(),
            })?;
        tracing::info!(
            "external-runtime asset fetched: {} -> {}",
            asset.source,
            dest.display()
        );
    }
    Ok(())
}
