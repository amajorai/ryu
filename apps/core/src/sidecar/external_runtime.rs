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

/// Write `constraints` to `path` unless it already holds exactly that content.
/// Never reports success for a file that is not there: a caller that is handed a
/// path can rely on `pip -c <path>` being able to open it.
fn ensure_constraints_file(path: &Path, constraints: &str) -> std::io::Result<()> {
    if fs::read_to_string(path).is_ok_and(|existing| existing == constraints) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, constraints)
}

/// Materialize [`PIP_SECURITY_CONSTRAINTS`] under the data-dir cache and return
/// its path. Re-checked (and re-written when the embedded content changed or the
/// file vanished) on every call, so upgrades pick up new floors and a transient
/// write failure is never cached: the error is returned and the next call retries.
pub fn pip_security_constraints_path() -> std::io::Result<PathBuf> {
    let path = crate::paths::cache_path("pip-security-constraints.txt");
    ensure_constraints_file(&path, PIP_SECURITY_CONSTRAINTS)?;
    Ok(path)
}

/// Extra pip CLI args (`-c <path>`) for every Core-managed `pip install`.
pub fn pip_security_constraint_args() -> std::io::Result<Vec<String>> {
    Ok(vec![
        "-c".to_owned(),
        pip_security_constraints_path()?
            .to_string_lossy()
            .into_owned(),
    ])
}

/// `PIP_CONSTRAINT` for Python processes Core spawns (plugin sidecars). pip reads
/// it, so a sidecar that runs `python -m pip install` itself (the voice sidecar's
/// engine installer) honours the Brotli floor without depending on Core. `None`
/// when the file cannot be written; the caller logs and carries on, because
/// refusing to start a sidecar over a constraint it may never use is worse.
pub fn pip_constraint_env() -> Option<(String, String)> {
    match pip_security_constraints_path() {
        Ok(path) => Some((
            "PIP_CONSTRAINT".to_owned(),
            path.to_string_lossy().into_owned(),
        )),
        Err(error) => {
            tracing::warn!("pip security constraints file is unavailable: {error}");
            None
        }
    }
}

/// Pip argv tail shared by manifest provisioning and engine installers:
/// `["-m", "pip", "install", "-c", …, <packages…>]`.
pub fn pip_install_package_args(packages: &[&str]) -> std::io::Result<Vec<String>> {
    let mut args = vec!["-m".to_owned(), "pip".to_owned(), "install".to_owned()];
    args.extend(pip_security_constraint_args()?);
    args.extend(packages.iter().map(|p| (*p).to_owned()));
    Ok(args)
}

/// The pip-install argument vector for a config (after the venv interpreter):
/// `["-m", "pip", "install", "-c", …, <requirements…> | "-e", ".[extra]"]`. Returned as a
/// plan so it is unit-testable without spawning a process.
pub fn pip_install_args(cfg: &ExternalRuntimeConfig) -> std::io::Result<Vec<String>> {
    let mut tail = Vec::new();
    if let Some(extra) = &cfg.pyproject_extra {
        tail.push("-e".to_owned());
        tail.push(format!(".[{extra}]"));
    }
    tail.extend(cfg.requirements.iter().cloned());
    if tail.is_empty() {
        // No packages — skip `-c` so provision does not run a no-op `pip install`.
        return Ok(vec![
            "-m".to_owned(),
            "pip".to_owned(),
            "install".to_owned(),
        ]);
    }
    let packages: Vec<&str> = tail.iter().map(String::as_str).collect();
    pip_install_package_args(&packages)
}

/// Content stamp of [`PIP_SECURITY_CONSTRAINTS`]; changes whenever a floor does.
fn pip_security_constraints_stamp() -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(PIP_SECURITY_CONSTRAINTS.as_bytes()))
}

/// Brotli distributions the constraints file bounds (the names on its lines).
fn constrained_distributions() -> Vec<&'static str> {
    PIP_SECURITY_CONSTRAINTS
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| line.split(['>', '<', '=', '!', '~', ' ']).next())
        .filter(|name| !name.is_empty())
        .collect()
}

/// Bring an engine that was installed before the current Brotli floor up to it.
///
/// The engine installers return early once `versions.json` records the engine, so
/// the `-c` constraint only ever reached fresh installs. This runs on that early
/// path: when the stamp for `engine` is older than the shipped constraints, it
/// upgrades only the constrained distributions that are already present
/// (`pip show`), never installing them. The stamp is written only after a clean
/// pass, so a failure is retried on the next start. Best effort: it never fails
/// the engine start.
pub async fn remediate_installed_pip_floor(engine: &str, python: &str) {
    let stamp_path = crate::paths::state_path(&format!("pip-security-floor-{engine}.stamp"));
    let stamp = pip_security_constraints_stamp();
    if fs::read_to_string(&stamp_path).is_ok_and(|existing| existing.trim() == stamp) {
        return;
    }
    let mut present = Vec::new();
    for name in constrained_distributions() {
        let shown = tokio::process::Command::new(python)
            .args(["-m", "pip", "show", "--quiet", name])
            .no_window()
            .output()
            .await;
        match shown {
            Ok(output) if output.status.success() => present.push(name),
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(
                    engine,
                    "could not inspect {name} for the pip security floor: {error}"
                );
                return;
            }
        }
    }
    if !present.is_empty() {
        let mut args = match pip_install_package_args(&["--upgrade"]) {
            Ok(args) => args,
            Err(error) => {
                tracing::warn!(engine, "pip security constraints are unavailable: {error}");
                return;
            }
        };
        args.extend(present.iter().map(|name| (*name).to_owned()));
        match tokio::process::Command::new(python)
            .args(&args)
            .no_window()
            .output()
            .await
        {
            Ok(output) if output.status.success() => {
                tracing::info!(
                    engine,
                    "upgraded {} to the pip security floor",
                    present.join(", ")
                );
            }
            Ok(output) => {
                tracing::warn!(
                    engine,
                    "upgrading {} to the pip security floor failed: {}",
                    present.join(", "),
                    String::from_utf8_lossy(&output.stderr).trim()
                );
                return;
            }
            Err(error) => {
                tracing::warn!(
                    engine,
                    "upgrading to the pip security floor failed: {error}"
                );
                return;
            }
        }
    }
    if let Some(parent) = stamp_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(error) = fs::write(&stamp_path, &stamp) {
        tracing::warn!(
            engine,
            "recording the pip security floor stamp failed: {error}"
        );
    }
}

/// Resolve an [`AssetSpec::source`] to a concrete https download URL.
///
/// - `https://…` passes through unchanged (http and other schemes are rejected,
///   matching the AssetSpec contract).
/// - `hf:<owner>/<repo>/<path…>` maps to the Hub resolve URL
///   `https://huggingface.co/<owner>/<repo>/resolve/main/<path…>`. A **file path**
///   is required; a repo-only ref (`hf:<owner>/<repo>`) is rejected — full-repo
///   snapshot needs Hub tree-listing that is not wired here.
///
/// Pure (no I/O), so it is unit-testable without a network.
fn resolve_asset_url(source: &str) -> Result<String, ProvisionError> {
    let s = source.trim();
    if let Some(rest) = s.strip_prefix("hf:") {
        let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
        if parts.len() < 3 {
            return Err(ProvisionError::UnsupportedAssetSource(format!(
                "{source} (hf refs need a file path: hf:<owner>/<repo>/<path>; \
                 repo-only snapshot is not supported)"
            )));
        }
        let owner = parts[0];
        let repo = parts[1];
        let file_path = parts[2..].join("/");
        return Ok(format!(
            "{HF_RESOLVE_HOST}/{owner}/{repo}/resolve/main/{file_path}"
        ));
    }
    if s.starts_with("https://") {
        return Ok(s.to_owned());
    }
    Err(ProvisionError::UnsupportedAssetSource(source.to_owned()))
}

/// A path component is a plain filename: non-empty, not `.`/`..`, and free of any
/// path separators or NUL.
fn is_safe_filename(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

/// A relative dir is traversal-safe: not absolute, no drive/UNC prefix, and every
/// component is a normal name (no `..`). `.` segments are tolerated.
fn is_safe_rel_dir(rel: &Path) -> bool {
    if rel.is_absolute() {
        return false;
    }
    rel.components().all(|c| {
        matches!(
            c,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    })
}

/// Derive the destination path for an asset: `<runtime_dir>/assets/<dest>/<file>`,
/// where `<file>` is the last path segment of `url`. Rejects a traversing
/// destination or an unsafe derived filename (fail-closed). Pure.
fn asset_dest(
    runtime_dir: &Path,
    dest_under_runtime: &str,
    url: &str,
) -> Result<PathBuf, ProvisionError> {
    let rel = Path::new(dest_under_runtime.trim());
    if !is_safe_rel_dir(rel) {
        return Err(ProvisionError::UnsafeAssetPath(format!(
            "asset destination '{dest_under_runtime}' must be a traversal-safe relative path"
        )));
    }
    let parsed = url::Url::parse(url)
        .map_err(|e| ProvisionError::UnsupportedAssetSource(format!("{url} ({e})")))?;
    let filename = parsed
        .path_segments()
        .and_then(|segs| segs.last())
        .map(str::to_owned)
        .unwrap_or_default();
    if !is_safe_filename(&filename) {
        return Err(ProvisionError::UnsafeAssetPath(format!(
            "cannot derive a safe filename from '{url}'"
        )));
    }
    Ok(runtime_dir.join("assets").join(rel).join(filename))
}

/// A repository-relative model path is allowed to contain normal directory
/// components, but never absolute, parent, Windows-prefix, or hidden path
/// components. The allowlist is a write boundary: every component becomes an
/// on-disk path under the sidecar-owned runtime directory.
fn is_safe_model_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let filename = lower.rsplit('/').next().unwrap_or_default();
    let license_file = matches!(filename, "license" | "license.txt" | "license.md");
    let known_model_file = license_file
        || [
            ".bin",
            ".cact",
            ".gguf",
            ".json",
            ".model",
            ".msgpack",
            ".onnx",
            ".pt",
            ".pth",
            ".safetensors",
            ".txt",
            ".yaml",
            ".yml",
        ]
        .iter()
        .any(|extension| lower.ends_with(extension));
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.contains('\\')
        && known_model_file
        && path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-'))
        && Path::new(path)
            .components()
            .all(|component| match component {
                Component::Normal(value) => !value.to_string_lossy().starts_with('.'),
                _ => false,
            })
}

fn is_safe_hf_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment.len() <= 96
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn validate_model_revision(revision: &str) -> bool {
    !revision.is_empty()
        && revision.len() <= 128
        && revision
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn parse_model_source(source: &str) -> Result<(String, String), ProvisionError> {
    let Some(rest) = source.trim().strip_prefix("hf:") else {
        return Err(ProvisionError::InvalidModelSnapshot(format!(
            "'{source}' must use hf:<owner>/<repo>"
        )));
    };
    let parts: Vec<&str> = rest.split('/').filter(|part| !part.is_empty()).collect();
    if parts.len() != 2 || parts.iter().any(|part| !is_safe_hf_segment(part)) {
        return Err(ProvisionError::InvalidModelSnapshot(format!(
            "'{source}' must name exactly one owner and repository"
        )));
    }
    Ok((parts[0].to_owned(), parts[1].to_owned()))
}

fn safe_package_path(package_root: &Path, relative: &str) -> Result<PathBuf, ProvisionError> {
    let rel = Path::new(relative.trim());
    if !is_safe_rel_dir(rel) || relative.trim().is_empty() {
        return Err(ProvisionError::UnsafePackagePath(relative.to_owned()));
    }
    let root = fs::canonicalize(package_root)
        .map_err(|error| ProvisionError::UnsafePackagePath(error.to_string()))?;
    let candidate = root.join(rel);
    let resolved = fs::canonicalize(&candidate)
        .map_err(|error| ProvisionError::UnsafePackagePath(error.to_string()))?;
    if !resolved.starts_with(&root) {
        return Err(ProvisionError::UnsafePackagePath(relative.to_owned()));
    }
    Ok(resolved)
}

fn copy_package_tree(source: &Path, destination: &Path) -> Result<(), ProvisionError> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| ProvisionError::UnsafePackagePath(error.to_string()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ProvisionError::UnsafePackagePath(format!(
            "source '{}' must be a directory without symlinks",
            source.display()
        )));
    }

    for entry in fs::read_dir(source)
        .map_err(|error| ProvisionError::UnsafePackagePath(error.to_string()))?
    {
        let entry = entry.map_err(|error| ProvisionError::UnsafePackagePath(error.to_string()))?;
        let source_path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| ProvisionError::UnsafePackagePath(error.to_string()))?;
        let destination_path = destination.join(entry.file_name());
        if file_type.is_symlink() {
            return Err(ProvisionError::UnsafePackagePath(format!(
                "source tree contains symlink '{}'",
                source_path.display()
            )));
        }
        if file_type.is_dir() {
            fs::create_dir_all(&destination_path).map_err(|error| ProvisionError::Mkdir(error))?;
            copy_package_tree(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path)
                .map_err(|error| ProvisionError::UnsafePackagePath(error.to_string()))?;
        } else {
            return Err(ProvisionError::UnsafePackagePath(format!(
                "source tree contains unsupported entry '{}'",
                source_path.display()
            )));
        }
    }
    Ok(())
}

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

#[derive(Debug, Deserialize)]
struct HfTreeEntry {
    #[serde(rename = "type")]
    kind: String,
    path: String,
    #[serde(default)]
    lfs: Option<HfLfsEntry>,
}

#[derive(Debug, Deserialize)]
struct HfLfsEntry {
    oid: String,
}

fn model_snapshot_tree_path(owner: &str, repo: &str, revision: &str) -> String {
    format!("/api/models/{owner}/{repo}/tree/{revision}")
}

fn model_snapshot_tree_url(owner: &str, repo: &str, revision: &str) -> String {
    format!(
        "{HF_RESOLVE_HOST}{}?recursive=true&expand=true&limit={HF_TREE_PAGE_SIZE}",
        model_snapshot_tree_path(owner, repo, revision)
    )
}

fn next_hf_tree_page_url(
    link_header: &str,
    expected_path: &str,
) -> Result<Option<url::Url>, &'static str> {
    for link in link_header.split(',') {
        let Some((target, parameters)) = link.split_once('>') else {
            continue;
        };
        let Some(target) = target.trim().strip_prefix('<') else {
            continue;
        };
        let is_next = parameters.split(';').any(|parameter| {
            let parameter = parameter.trim();
            parameter.eq_ignore_ascii_case("rel=next")
                || parameter.eq_ignore_ascii_case("rel=\"next\"")
        });
        if !is_next {
            continue;
        }

        let page = url::Url::parse(target.trim()).map_err(|_| "invalid next-page URL")?;
        if page.scheme() != "https"
            || page.host_str() != Some("huggingface.co")
            || page.port().is_some()
            || !page.username().is_empty()
            || page.password().is_some()
            || page.path() != expected_path
        {
            return Err("next-page URL left the pinned Hugging Face tree endpoint");
        }
        return Ok(Some(page));
    }
    Ok(None)
}

/// Fetch the exact files named by each model snapshot declaration. The Hub tree
/// listing is metadata only; every model byte still goes through DownloadCenter
/// for resume, progress, and checksum verification when the Hub exposes an LFS
/// digest.
fn model_snapshot_download_spec(
    snapshot: &ModelSnapshotSpec,
    repository: (&str, &str),
    relative: &str,
    destination_path: PathBuf,
    checksum: Option<String>,
) -> crate::downloads::DownloadSpec {
    let (owner, repo) = repository;
    crate::downloads::DownloadSpec {
        kind: crate::downloads::DownloadKind::Model,
        role: crate::downloads::DownloadRole::PluginModel,
        label: format!("{} ({relative})", snapshot.source),
        url: format!(
            "{HF_RESOLVE_HOST}/{owner}/{repo}/resolve/{}/{relative}",
            snapshot.revision
        ),
        dest: destination_path,
        sha256: checksum,
        version_record: Some(crate::downloads::VersionRecord {
            store_key: format!("plugin-model:{}:{relative}", snapshot.source),
            version: snapshot.revision.clone(),
        }),
    }
}

async fn fetch_model_snapshots(
    cfg: &ExternalRuntimeConfig,
    runtime_dir: &Path,
    downloads: &crate::downloads::DownloadCenter,
) -> Result<(), ProvisionError> {
    for snapshot in &cfg.model_snapshots {
        let (owner, repo) = parse_model_source(&snapshot.source)?;
        if !validate_model_revision(&snapshot.revision) {
            return Err(ProvisionError::InvalidModelSnapshot(format!(
                "revision '{}' is not a safe immutable Hub revision",
                snapshot.revision
            )));
        }
        let destination = Path::new(snapshot.dest_under_runtime.trim());
        if !is_safe_rel_dir(destination) || snapshot.dest_under_runtime.trim().is_empty() {
            return Err(ProvisionError::UnsafePackagePath(format!(
                "model destination '{}' is not traversal-safe",
                snapshot.dest_under_runtime
            )));
        }
        if snapshot.files.is_empty() {
            return Err(ProvisionError::InvalidModelSnapshot(format!(
                "{} declares no files",
                snapshot.source
            )));
        }

        let snapshot_root = runtime_dir.join(destination);
        let marker = snapshot_root.join(".ryu-model-snapshot");
        let marker_value = format!(
            "{}\n{}",
            snapshot.revision,
            snapshot
                .files
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        );
        let marker_matches = tokio::fs::read_to_string(&marker)
            .await
            .map(|contents| contents == marker_value)
            .unwrap_or(false);
        if marker_matches
            && snapshot
                .files
                .iter()
                .all(|relative| snapshot_root.join(relative).is_file())
        {
            tracing::info!(
                "model snapshot already provisioned, skipping Hub metadata: {}",
                snapshot.source
            );
            continue;
        }

        let tree_path = model_snapshot_tree_path(&owner, &repo, &snapshot.revision);
        let mut next_page = Some(model_snapshot_tree_url(&owner, &repo, &snapshot.revision));
        let mut page_count = 0;
        let mut files: HashMap<String, Option<String>> = HashMap::new();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| ProvisionError::AssetFetch {
                source: snapshot.source.clone(),
                reason: error.to_string(),
            })?;
        while let Some(api_url) = next_page.take() {
            page_count += 1;
            let parsed = crate::server::screen_agent_egress_url(&api_url)
                .await
                .map_err(|error| ProvisionError::AssetFetch {
                    source: snapshot.source.clone(),
                    reason: error.to_string(),
                })?;
            if parsed.scheme() != "https"
                || parsed.host_str() != Some("huggingface.co")
                || parsed.port().is_some()
                || parsed.path() != tree_path
            {
                return Err(ProvisionError::AssetFetch {
                    source: snapshot.source.clone(),
                    reason: "model snapshot metadata must stay on the expected https://huggingface.co tree endpoint".to_owned(),
                });
            }

            let response = crate::hf_auth::authorize(&api_url, client.get(&api_url))
                .send()
                .await
                .map_err(|error| ProvisionError::AssetFetch {
                    source: snapshot.source.clone(),
                    reason: error.to_string(),
                })?;
            if !response.status().is_success() {
                return Err(ProvisionError::AssetFetch {
                    source: snapshot.source.clone(),
                    reason: format!("Hub tree listing returned {}", response.status()),
                });
            }
            if response
                .content_length()
                .is_some_and(|length| length > MAX_HF_TREE_PAGE_BYTES as u64)
            {
                return Err(ProvisionError::AssetFetch {
                    source: snapshot.source.clone(),
                    reason: "Hub tree metadata page exceeds the 1 MiB limit".to_owned(),
                });
            }
            let link_header = response
                .headers()
                .get(reqwest::header::LINK)
                .and_then(|header| header.to_str().ok())
                .map(str::to_owned);
            let mut response = response;
            let mut body = Vec::new();
            while let Some(chunk) =
                response
                    .chunk()
                    .await
                    .map_err(|error| ProvisionError::AssetFetch {
                        source: snapshot.source.clone(),
                        reason: error.to_string(),
                    })?
            {
                if body.len().saturating_add(chunk.len()) > MAX_HF_TREE_PAGE_BYTES {
                    return Err(ProvisionError::AssetFetch {
                        source: snapshot.source.clone(),
                        reason: "Hub tree metadata page exceeds the 1 MiB limit".to_owned(),
                    });
                }
                body.extend_from_slice(&chunk);
            }
            let entries: Vec<HfTreeEntry> =
                serde_json::from_slice(&body).map_err(|error| ProvisionError::AssetFetch {
                    source: snapshot.source.clone(),
                    reason: format!("invalid Hub tree listing: {error}"),
                })?;
            for entry in entries {
                if entry.kind != "file" || !snapshot.files.contains(&entry.path) {
                    continue;
                }
                let checksum = entry
                    .lfs
                    .filter(|lfs| {
                        lfs.oid.len() == 64 && lfs.oid.bytes().all(|b| b.is_ascii_hexdigit())
                    })
                    .map(|lfs| lfs.oid);
                files.insert(entry.path, checksum);
            }
            if snapshot
                .files
                .iter()
                .all(|relative| files.contains_key(relative))
            {
                break;
            }
            if page_count >= MAX_HF_TREE_PAGES {
                return Err(ProvisionError::InvalidModelSnapshot(format!(
                    "Hub tree listing exceeded the {MAX_HF_TREE_PAGES}-page limit before all requested files were found"
                )));
            }
            next_page = match link_header.as_deref() {
                Some(header) => next_hf_tree_page_url(header, &tree_path)
                    .map_err(|reason| ProvisionError::AssetFetch {
                        source: snapshot.source.clone(),
                        reason: reason.to_owned(),
                    })?
                    .map(|url| url.to_string()),
                None => None,
            };
        }

        let mut seen = BTreeMap::new();
        for relative in &snapshot.files {
            if !is_safe_model_path(relative) {
                return Err(ProvisionError::InvalidModelSnapshot(format!(
                    "unsafe model file path '{relative}'"
                )));
            }
            if seen.insert(relative, ()).is_some() {
                return Err(ProvisionError::InvalidModelSnapshot(format!(
                    "duplicate model file path '{relative}'"
                )));
            }
            let Some(checksum) = files.get(relative) else {
                return Err(ProvisionError::InvalidModelSnapshot(format!(
                    "Hub repository does not contain '{relative}' at revision '{}'",
                    snapshot.revision
                )));
            };
            let destination_path = snapshot_root.join(relative);
            if let Some(parent) = destination_path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(ProvisionError::Mkdir)?;
            }
            if checksum.is_none() && destination_path.exists() {
                continue;
            }
            downloads
                .download_blocking(model_snapshot_download_spec(
                    snapshot,
                    (&owner, &repo),
                    relative,
                    destination_path,
                    checksum.clone(),
                ))
                .await
                .map_err(|error| ProvisionError::AssetFetch {
                    source: format!("{}:{relative}", snapshot.source),
                    reason: error.to_string(),
                })?;
        }

        let marker_tmp = marker.with_extension("part");
        tokio::fs::write(&marker_tmp, marker_value.as_bytes())
            .await
            .map_err(ProvisionError::Mkdir)?;
        tokio::fs::rename(&marker_tmp, &marker)
            .await
            .map_err(ProvisionError::Mkdir)?;
    }
    Ok(())
}

/// Provision a Python runtime for `cfg` under `dir`: fetch declared assets (into
/// `~/.ryu`), create the venv (if absent), then pip-install the declared
/// requirements/extra.
///
/// Best-effort and idempotent: an existing venv is reused and an already-present
/// asset is not re-fetched. The caller is responsible for the tier + grant gate
/// ([`may_provision`], see the module security note) BEFORE calling this — by the
/// time we are here, provisioning is permitted.
pub async fn provision(
    cfg: &ExternalRuntimeConfig,
    dir: &Path,
    downloads: &crate::downloads::DownloadCenter,
) -> Result<PathBuf, ProvisionError> {
    provision_with_package_root(cfg, dir, downloads, dir).await
}

/// Provision a runtime whose source tree and model bundle are carried by the
/// owning plugin package. Manifest-declared sidecars pass their package root;
/// legacy callers use [`provision`] and keep the pre-existing runtime behavior.
pub async fn provision_with_package_root(
    cfg: &ExternalRuntimeConfig,
    dir: &Path,
    downloads: &crate::downloads::DownloadCenter,
    package_root: &Path,
) -> Result<PathBuf, ProvisionError> {
    if cfg.kind != RUNTIME_PYTHON {
        return Err(ProvisionError::UnsupportedKind(cfg.kind.clone()));
    }

    tokio::fs::create_dir_all(dir)
        .await
        .map_err(ProvisionError::Mkdir)?;

    // Extract the plugin's source tree into `dir` first (before venv/pip), so a
    // `pip install -e ".[extra]"` finds the package's `pyproject.toml` at the root.
    fetch_and_extract_source(cfg, dir, downloads, package_root).await?;

    // Fetch declared single-file assets into this plugin/sidecar's dedicated
    // runtime directory. A manifest can never overwrite shared Core data.
    fetch_assets(cfg, dir, downloads).await?;

    // Fetch exact Hugging Face model files into the same private runtime tree.
    // This runs before the venv install so a plugin can fail before spawning a
    // process if its declared model bundle is incomplete or tampered with.
    fetch_model_snapshots(cfg, dir, downloads).await?;

    let python = venv_python(dir);
    if !python.exists() {
        // python -m venv .venv
        run(
            bootstrap_python(),
            &[
                "-m".to_owned(),
                "venv".to_owned(),
                dir.join(".venv").to_string_lossy().to_string(),
            ],
            dir,
        )
        .await?;
    }

    // <venv python> -m pip install …
    let args = pip_install_args(cfg).map_err(ProvisionError::Constraints)?;
    if args.len() > 3 {
        // there is at least one requirement / extra to install
        run(&python.to_string_lossy(), &args, dir).await?;
    }

    Ok(python)
}

/// Run a command to completion, mapping failures into [`ProvisionError`].
async fn run(program: &str, args: &[String], cwd: &Path) -> Result<(), ProvisionError> {
    let display = format!("{program} {}", args.join(" "));
    let output = tokio::process::Command::new(program)
        .args(args)
        .current_dir(cwd)
        .no_window()
        .output()
        .await
        .map_err(|e| ProvisionError::Spawn {
            cmd: display.clone(),
            source: e,
        })?;
    if !output.status.success() {
        return Err(ProvisionError::NonZeroExit {
            cmd: display,
            status: output.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_roundtrips_through_json() {
        let cfg = ExternalRuntimeConfig {
            kind: "python".to_owned(),
            entry: "ryu_tts".to_owned(),
            port_env: None,
            python_version: Some("3.11".to_owned()),
            requirements: vec!["fastapi".to_owned()],
            pyproject_extra: Some("kitten".to_owned()),
            assets: vec![AssetSpec {
                source: "hf:KittenML/kitten-tts".to_owned(),
                dest_under_runtime: "models/hf".to_owned(),
                sha256: None,
            }],
            model_snapshots: vec![],
            port: Some(8085),
            health_path: Some("/health".to_owned()),
            source: Some(SourceArchiveSpec {
                url: "https://example.com/pkg.tar.gz".to_owned(),
                sha256: None,
                format: "tar.gz".to_owned(),
                path: None,
            }),
            env: std::collections::BTreeMap::from([(
                "HF_HOME".to_owned(),
                "${RYU_MODELS_DIR}/hf".to_owned(),
            )]),
        };
        let json = serde_json::to_string(&cfg).expect("serialise");
        let back: ExternalRuntimeConfig = serde_json::from_str(&json).expect("deserialise");
        assert_eq!(cfg, back);
    }

    #[test]
    fn config_defaults_minimal() {
        let json = r#"{ "kind": "python", "entry": "ryu_tts" }"#;
        let cfg: ExternalRuntimeConfig = serde_json::from_str(json).expect("deserialise minimal");
        assert_eq!(cfg.kind, "python");
        assert_eq!(cfg.entry, "ryu_tts");
        assert!(cfg.requirements.is_empty());
        assert!(cfg.pyproject_extra.is_none());
        assert!(cfg.assets.is_empty());
        assert!(cfg.model_snapshots.is_empty());
    }

    #[test]
    fn venv_python_is_os_correct() {
        let dir = Path::new("/tmp/plugin");
        let p = venv_python(dir);
        let s = p.to_string_lossy();
        if cfg!(target_os = "windows") {
            assert!(s.contains(".venv"));
            assert!(s.ends_with("python.exe"));
            assert!(s.contains("Scripts"));
        } else {
            assert!(s.contains(".venv"));
            assert!(s.ends_with("python"));
            assert!(s.contains("bin"));
        }
    }

    #[test]
    fn bootstrap_python_matches_platform() {
        let p = bootstrap_python();
        if cfg!(target_os = "windows") {
            assert_eq!(p, "python");
        } else {
            assert_eq!(p, "python3");
        }
    }

    #[test]
    fn pip_security_constraints_embed_brotli_floor() {
        assert!(PIP_SECURITY_CONSTRAINTS.contains("Brotli>=1.2.1"));
        assert!(PIP_SECURITY_CONSTRAINTS.contains("brotlicffi>=1.2.1.0"));
    }

    #[test]
    fn constraints_write_failure_is_reported_and_not_cached() {
        let dir = tempfile::tempdir().unwrap();
        // A regular file where the parent directory should be: both
        // `create_dir_all` and `write` must fail, and the error must surface.
        let blocker = dir.path().join("blocker");
        fs::write(&blocker, "x").unwrap();
        let path = blocker.join("pip-security-constraints.txt");
        assert!(ensure_constraints_file(&path, PIP_SECURITY_CONSTRAINTS).is_err());
        assert!(!path.exists());
        // Once the obstruction is gone the very next call writes the file.
        fs::remove_file(&blocker).unwrap();
        ensure_constraints_file(&path, PIP_SECURITY_CONSTRAINTS).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), PIP_SECURITY_CONSTRAINTS);
        // A vanished file is re-created rather than trusted from a cache.
        fs::remove_file(&path).unwrap();
        ensure_constraints_file(&path, PIP_SECURITY_CONSTRAINTS).unwrap();
        assert!(path.exists());
    }

    /// Every Core-managed `pip install` must carry the Brotli floor, so the argv is
    /// built only by [`pip_install_package_args`] (which adds `-c`). A call site that
    /// spells out the `-m pip install` sequence itself would bypass it.
    #[test]
    fn pip_install_call_sites_go_through_the_constraint_helper() {
        fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
            for entry in fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    rust_files(&path, out);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    out.push(path);
                }
            }
        }
        let needle = ["\"-m\", \"pip\", ", "\"install\""].concat();
        let helper = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/sidecar/external_runtime.rs");
        let mut files = Vec::new();
        rust_files(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut files,
        );
        let offenders: Vec<_> = files
            .into_iter()
            .filter(|path| *path != helper)
            .filter(|path| fs::read_to_string(path).is_ok_and(|text| text.contains(&needle)))
            .collect();
        assert!(
            offenders.is_empty(),
            "build pip install argv with pip_install_package_args: {offenders:?}"
        );
    }

    #[test]
    fn constrained_distributions_are_the_brotli_packages() {
        assert_eq!(constrained_distributions(), ["Brotli", "brotlicffi"]);
    }

    #[test]
    fn pip_constraint_env_points_at_the_constraints_file() {
        let (name, value) = pip_constraint_env().expect("constraints file is writable");
        assert_eq!(name, "PIP_CONSTRAINT");
        assert!(value.ends_with("pip-security-constraints.txt"));
        assert_eq!(fs::read_to_string(value).unwrap(), PIP_SECURITY_CONSTRAINTS);
    }

    #[test]
    fn pip_args_with_extra() {
        let cfg = ExternalRuntimeConfig {
            kind: "python".to_owned(),
            entry: "x".to_owned(),
            pyproject_extra: Some("kitten".to_owned()),
            ..Default::default()
        };
        let args = pip_install_args(&cfg).unwrap();
        assert_eq!(args[0..3], ["-m", "pip", "install"]);
        assert_eq!(args[3], "-c");
        assert!(args[4].ends_with("pip-security-constraints.txt"));
        assert_eq!(&args[5..], ["-e", ".[kitten]"]);
    }

    #[test]
    fn pip_args_with_requirements() {
        let cfg = ExternalRuntimeConfig {
            kind: "python".to_owned(),
            entry: "x".to_owned(),
            requirements: vec!["fastapi".to_owned(), "uvicorn".to_owned()],
            ..Default::default()
        };
        let args = pip_install_args(&cfg).unwrap();
        assert_eq!(args[0..3], ["-m", "pip", "install"]);
        assert_eq!(args[3], "-c");
        assert!(args[4].ends_with("pip-security-constraints.txt"));
        assert_eq!(&args[5..], ["fastapi", "uvicorn"]);
    }

    #[tokio::test]
    async fn source_extraction_is_noop_without_source() {
        // No `source` declared → returns Ok and touches nothing (no network).
        let cfg = ExternalRuntimeConfig {
            kind: "python".to_owned(),
            entry: "x".to_owned(),
            ..Default::default()
        };
        let downloads = crate::downloads::DownloadCenter::with_default_client();
        let tmp = std::env::temp_dir().join(format!("ryu-src-noop-{}", std::process::id()));
        fetch_and_extract_source(&cfg, &tmp, &downloads, &tmp)
            .await
            .expect("no-op with no source");
    }

    #[tokio::test]
    async fn source_extraction_skips_when_marker_present() {
        // An already-extracted source (marker present) short-circuits BEFORE any
        // download/SSRF work, so a bogus URL is never touched.
        let dir = std::env::temp_dir().join(format!("ryu-src-skip-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.expect("mkdir");
        tokio::fs::write(dir.join(SOURCE_MARKER), b"[project]\n")
            .await
            .expect("write marker");
        let cfg = ExternalRuntimeConfig {
            kind: "python".to_owned(),
            entry: "x".to_owned(),
            source: Some(SourceArchiveSpec {
                url: "https://never.invalid/should-not-fetch.tar.gz".to_owned(),
                sha256: None,
                format: "tar.gz".to_owned(),
                path: None,
            }),
            ..Default::default()
        };
        let downloads = crate::downloads::DownloadCenter::with_default_client();
        fetch_and_extract_source(&cfg, &dir, &downloads, &dir)
            .await
            .expect("skips when marker present");
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn provision_rejects_unsupported_kind() {
        let cfg = ExternalRuntimeConfig {
            kind: "node".to_owned(),
            entry: "x".to_owned(),
            ..Default::default()
        };
        // The kind check returns before any download work, so a default
        // DownloadCenter is never touched here.
        let downloads = crate::downloads::DownloadCenter::with_default_client();
        let err = provision(&cfg, Path::new("/tmp/does-not-matter"), &downloads)
            .await
            .unwrap_err();
        assert!(matches!(err, ProvisionError::UnsupportedKind(_)));
    }

    // ── provisioning gate (may_provision) ─────────────────────────────────────

    #[test]
    fn core_tier_always_provisions() {
        use crate::plugin_manifest::PluginTier;
        assert!(may_provision(PluginTier::Core, &[]));
        assert!(may_provision(
            PluginTier::Core,
            &["something:else".to_owned()]
        ));
    }

    #[test]
    fn community_tier_needs_approved_grant() {
        use crate::plugin_manifest::PluginTier;
        // No grant → denied (fail-closed).
        assert!(!may_provision(PluginTier::Community, &[]));
        // Unrelated grant → still denied.
        assert!(!may_provision(
            PluginTier::Community,
            &["mcp:web_search".to_owned()]
        ));
        // The external-runtime grant (Gateway-approved) → allowed.
        assert!(may_provision(
            PluginTier::Community,
            &[GRANT_EXTERNAL_RUNTIME.to_owned()]
        ));
    }

    // ── asset source resolution ───────────────────────────────────────────────

    #[test]
    fn resolve_hf_ref_with_file_path() {
        let url = resolve_asset_url("hf:KittenML/kitten-tts/model.onnx").unwrap();
        assert_eq!(
            url,
            "https://huggingface.co/KittenML/kitten-tts/resolve/main/model.onnx"
        );
    }

    #[test]
    fn resolve_hf_ref_with_nested_file_path() {
        let url = resolve_asset_url("hf:owner/repo/sub/dir/weights.bin").unwrap();
        assert_eq!(
            url,
            "https://huggingface.co/owner/repo/resolve/main/sub/dir/weights.bin"
        );
    }

    #[test]
    fn resolve_hf_repo_only_ref_is_rejected() {
        let err = resolve_asset_url("hf:KittenML/kitten-tts").unwrap_err();
        assert!(matches!(err, ProvisionError::UnsupportedAssetSource(_)));
    }

    #[test]
    fn model_snapshot_source_requires_one_hf_repository() {
        assert_eq!(
            parse_model_source("hf:convaiinnovations/laya").unwrap(),
            ("convaiinnovations".to_owned(), "laya".to_owned())
        );
        for source in [
            "https://huggingface.co/convaiinnovations/laya",
            "hf:convaiinnovations/laya/extra",
            "hf:../laya",
        ] {
            assert!(
                parse_model_source(source).is_err(),
                "model source should be rejected: {source}"
            );
        }
    }

    #[test]
    fn model_snapshot_tree_listing_uses_a_bounded_page_size() {
        let url = model_snapshot_tree_url("Cactus-Compute", "needle3", "b274efc");
        assert!(url.ends_with("?recursive=true&expand=true&limit=100"));
    }

    #[test]
    fn model_snapshot_tree_pagination_stays_on_the_hugging_face_endpoint() {
        let path = "/api/models/owner/repo/tree/revision";
        let link_header = concat!(
            "<https://huggingface.co/api/models/owner/repo/tree/revision?cursor=next>; rel=\"next\", ",
            "<https://huggingface.co/api/models/owner/repo/tree/revision?cursor=previous>; rel=\"prev\""
        );
        let next = next_hf_tree_page_url(link_header, path)
            .expect("valid next link")
            .expect("next link exists");
        assert_eq!(next.host_str(), Some("huggingface.co"));
        assert_eq!(next.path(), path);
        assert_eq!(
            next.query_pairs()
                .find(|(key, _)| key == "cursor")
                .map(|(_, value)| value.into_owned()),
            Some("next".to_owned())
        );
        assert!(next_hf_tree_page_url(
            "<https://evil.example/api/models/owner/repo/tree/revision?cursor=next>; rel=\"next\"",
            path
        )
        .is_err());
        assert!(next_hf_tree_page_url(
            "<https://huggingface.co/api/models/owner/other/tree/revision?cursor=next>; rel=\"next\"",
            path
        )
        .is_err());
    }

    #[test]
    fn plugin_model_snapshot_download_uses_the_local_model_role() {
        let snapshot = ModelSnapshotSpec {
            source: "hf:Cactus-Compute/needle3".to_owned(),
            revision: "b274efcb211a9eef48c9a88da4b43bd569696a39".to_owned(),
            dest_under_runtime: "models/needle3".to_owned(),
            files: vec!["needle3.cact".to_owned()],
        };
        let spec = model_snapshot_download_spec(
            &snapshot,
            ("Cactus-Compute", "needle3"),
            "needle3.cact",
            PathBuf::from("runtime/models/needle3/needle3.cact"),
            Some("c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38".to_owned()),
        );

        assert_eq!(
            serde_json::to_value(spec.role).expect("serialize role"),
            "plugin_model"
        );
        assert_eq!(spec.kind, crate::downloads::DownloadKind::Model);
        assert_eq!(
            spec.url,
            "https://huggingface.co/Cactus-Compute/needle3/resolve/b274efcb211a9eef48c9a88da4b43bd569696a39/needle3.cact"
        );
        assert_eq!(
            spec.sha256.as_deref(),
            Some("c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38")
        );
    }

    #[tokio::test]
    #[ignore = "live Hugging Face smoke; downloads the pinned 35 MB public Needle 3 snapshot"]
    async fn live_needle_snapshot_downloads_through_the_core_download_center() {
        use sha2::{Digest, Sha256};

        crate::downloads::install();
        let runtime_dir = std::env::temp_dir().join(format!(
            "ryu-hf-live-needle-snapshot-{}",
            std::process::id()
        ));
        assert!(
            !runtime_dir.exists(),
            "refusing to reuse the live smoke directory: {}",
            runtime_dir.display()
        );
        tokio::fs::create_dir_all(&runtime_dir)
            .await
            .expect("create isolated runtime directory");

        let cfg = ExternalRuntimeConfig {
            model_snapshots: vec![ModelSnapshotSpec {
                source: "hf:Cactus-Compute/needle3".to_owned(),
                revision: "b274efcb211a9eef48c9a88da4b43bd569696a39".to_owned(),
                dest_under_runtime: "models/needle3".to_owned(),
                files: vec!["LICENSE".to_owned(), "needle3.cact".to_owned()],
            }],
            ..Default::default()
        };
        let downloads = crate::downloads::DownloadCenter::with_default_client();
        let fetch_result = fetch_model_snapshots(&cfg, &runtime_dir, &downloads).await;
        let weights_path = runtime_dir.join("models/needle3/needle3.cact");
        let actual_digest = tokio::fs::read(&weights_path)
            .await
            .map(|bytes| hex::encode(Sha256::digest(bytes)));
        let cleanup_result = tokio::fs::remove_dir_all(&runtime_dir).await;

        fetch_result.expect("Ryu should provision the pinned Needle 3 snapshot");
        cleanup_result.expect("remove the isolated live-smoke runtime");
        assert_eq!(
            actual_digest.expect("read downloaded Needle 3 weights"),
            "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38"
        );
    }

    #[test]
    fn model_snapshot_paths_reject_traversal_and_hidden_files() {
        assert!(is_safe_model_path("tokenizer/tokenizer.json"));
        assert!(is_safe_model_path("LICENSE"));
        assert!(is_safe_model_path("licenses/LICENSE.md"));
        assert!(is_safe_model_path("needle3.cact"));
        assert!(!is_safe_model_path("README.md"));
        assert!(!is_safe_model_path("LICENSE.py"));
        for path in [
            "../model.safetensors",
            ".gitattributes",
            "/model.safetensors",
            "a\\b",
            "server.py",
        ] {
            assert!(
                !is_safe_model_path(path),
                "unsafe model path accepted: {path}"
            );
        }
    }

    #[test]
    fn model_revision_is_bounded_and_url_safe() {
        assert!(validate_model_revision(
            "1c5edc17a7acd8701df6fc341c0d179f1c62c982"
        ));
        assert!(validate_model_revision("main"));
        assert!(!validate_model_revision("refs/heads/main"));
        assert!(!validate_model_revision("../main"));
    }

    #[test]
    fn resolve_https_url_passes_through() {
        let url = resolve_asset_url("https://example.com/a/model.gguf").unwrap();
        assert_eq!(url, "https://example.com/a/model.gguf");
    }

    #[test]
    fn resolve_http_url_is_rejected() {
        let err = resolve_asset_url("http://example.com/x.bin").unwrap_err();
        assert!(matches!(err, ProvisionError::UnsupportedAssetSource(_)));
    }

    // ── asset destination (traversal safety) ──────────────────────────────────

    #[test]
    fn asset_dest_joins_dir_and_filename() {
        let base = Path::new("/ryu/plugins/example/runtime");
        let dest = asset_dest(base, "models/hf", "https://example.com/a/model.gguf").unwrap();
        assert_eq!(
            dest,
            Path::new("/ryu/plugins/example/runtime").join("assets/models/hf/model.gguf")
        );
        assert!(dest.starts_with(base.join("assets")));
    }

    #[test]
    fn asset_dest_rejects_parent_traversal() {
        let base = Path::new("/ryu");
        let err = asset_dest(base, "../../etc", "https://example.com/x.bin").unwrap_err();
        assert!(matches!(err, ProvisionError::UnsafeAssetPath(_)));
    }

    #[test]
    fn asset_dest_rejects_absolute_dest() {
        let base = Path::new("/ryu");
        let err = asset_dest(base, "/etc", "https://example.com/x.bin").unwrap_err();
        assert!(matches!(err, ProvisionError::UnsafeAssetPath(_)));
    }

    #[test]
    fn asset_dest_rejects_directory_url_with_no_filename() {
        let base = Path::new("/ryu");
        let err = asset_dest(base, "models", "https://example.com/dir/").unwrap_err();
        assert!(matches!(err, ProvisionError::UnsafeAssetPath(_)));
    }
}
