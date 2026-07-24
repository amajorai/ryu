//! Declarative **external-runtime** provisioning (M3 / #449).
//!
//! A plugin can declare that one of its runnables needs an external language
//! runtime — today a **Python venv** with pip dependencies and fetched assets —
//! exactly like the `apps/tts-sidecar` (`RyuTtsManager`) precedent, but as a
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

use std::path::{Path, PathBuf};

use crate::win_process::NoWindow;

// The declaration types live in `plugin_manifest::schema` (so the manifest can
// carry them without depending on `sidecar`); re-exported here so callers of the
// provisioner have one import.
pub use crate::plugin_manifest::schema::{AssetSpec, ExternalRuntimeConfig, SourceArchiveSpec};

/// The kind of external runtime a plugin declares. Open-ended (a `String`) so a
/// future `"node"`/`"deno"` runtime is a data change, not a code change —
/// "nothing hardcoded". Only `"python"` is provisionable today.
pub const RUNTIME_PYTHON: &str = "python";

/// The Hugging Face Hub host `hf:` asset refs resolve against.
const HF_RESOLVE_HOST: &str = "https://huggingface.co";

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
    /// An asset's resolved destination would escape `~/.ryu` (traversal / absolute
    /// path in `dest_under_ryu` or an unsafe derived filename). Fail-closed.
    UnsafeAssetPath(String),
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
            ProvisionError::AssetFetch { source, reason } => {
                write!(f, "fetching asset '{source}' failed: {reason}")
            }
        }
    }
}

impl std::error::Error for ProvisionError {}

/// The pip-install argument vector for a config (after the venv interpreter):
/// `["-m", "pip", "install", <requirements…> | "-e", ".[extra]"]`. Returned as a
/// plan so it is unit-testable without spawning a process.
pub fn pip_install_args(cfg: &ExternalRuntimeConfig) -> Vec<String> {
    let mut args = vec!["-m".to_owned(), "pip".to_owned(), "install".to_owned()];
    if let Some(extra) = &cfg.pyproject_extra {
        args.push("-e".to_owned());
        args.push(format!(".[{extra}]"));
    }
    args.extend(cfg.requirements.iter().cloned());
    args
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

/// Derive the destination path for an asset: `<ryu_dir>/<dest_under_ryu>/<file>`,
/// where `<file>` is the last path segment of `url`. Rejects a traversing
/// `dest_under_ryu` or an unsafe derived filename (fail-closed). Pure.
fn asset_dest(ryu_dir: &Path, dest_under_ryu: &str, url: &str) -> Result<PathBuf, ProvisionError> {
    let rel = Path::new(dest_under_ryu.trim());
    if !is_safe_rel_dir(rel) {
        return Err(ProvisionError::UnsafeAssetPath(format!(
            "dest_under_ryu '{dest_under_ryu}' must be a traversal-safe relative path"
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
    Ok(ryu_dir.join(rel).join(filename))
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

/// Fetch every declared asset into `<ryu_dir>/<dest_under_ryu>/<file>` via the
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
    ryu_dir: &Path,
    downloads: &crate::downloads::DownloadCenter,
) -> Result<(), ProvisionError> {
    for asset in &cfg.assets {
        let url = resolve_asset_url(&asset.source)?;
        let dest = asset_dest(ryu_dir, &asset.dest_under_ryu, &url)?;
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
    if cfg.kind != RUNTIME_PYTHON {
        return Err(ProvisionError::UnsupportedKind(cfg.kind.clone()));
    }

    tokio::fs::create_dir_all(dir)
        .await
        .map_err(ProvisionError::Mkdir)?;

    // Extract the plugin's source tree into `dir` first (before venv/pip), so a
    // `pip install -e ".[extra]"` finds the package's `pyproject.toml` at the root.
    fetch_and_extract_source(cfg, dir, downloads).await?;

    // Fetch declared single-file assets (models, etc.) into `~/.ryu`.
    fetch_assets(cfg, &crate::paths::ryu_dir(), downloads).await?;

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
    let args = pip_install_args(cfg);
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
                dest_under_ryu: "models/hf".to_owned(),
                sha256: None,
            }],
            port: Some(8085),
            health_path: Some("/health".to_owned()),
            source: Some(SourceArchiveSpec {
                url: "https://example.com/pkg.tar.gz".to_owned(),
                sha256: None,
                format: "tar.gz".to_owned(),
            }),
            env: std::collections::BTreeMap::from([(
                "HF_HOME".to_owned(),
                "${RYU_DIR}/models/hf".to_owned(),
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
    fn pip_args_with_extra() {
        let cfg = ExternalRuntimeConfig {
            kind: "python".to_owned(),
            entry: "x".to_owned(),
            pyproject_extra: Some("kitten".to_owned()),
            ..Default::default()
        };
        let args = pip_install_args(&cfg);
        assert_eq!(args, vec!["-m", "pip", "install", "-e", ".[kitten]"]);
    }

    #[test]
    fn pip_args_with_requirements() {
        let cfg = ExternalRuntimeConfig {
            kind: "python".to_owned(),
            entry: "x".to_owned(),
            requirements: vec!["fastapi".to_owned(), "uvicorn".to_owned()],
            ..Default::default()
        };
        let args = pip_install_args(&cfg);
        assert_eq!(args, vec!["-m", "pip", "install", "fastapi", "uvicorn"]);
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
        fetch_and_extract_source(&cfg, &tmp, &downloads)
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
            }),
            ..Default::default()
        };
        let downloads = crate::downloads::DownloadCenter::with_default_client();
        fetch_and_extract_source(&cfg, &dir, &downloads)
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
        let base = Path::new("/ryu");
        let dest = asset_dest(base, "models/hf", "https://example.com/a/model.gguf").unwrap();
        assert_eq!(dest, Path::new("/ryu").join("models/hf").join("model.gguf"));
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
