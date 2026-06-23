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
//! ## Scope (honest)
//!
//! This is **scaffold-and-spec**: the config type, OS-correct path derivation,
//! and a best-effort [`provision`] that creates the venv + pip-installs are real
//! and unit-tested for the pure parts. The full asset-fetch wiring into the
//! `DownloadCenter`, the per-plugin enable→provision→spawn flow, and migrating
//! the four existing engine installers onto this are the documented follow-on.
//! The working `RyuTtsManager` venv path is deliberately **left untouched** here
//! (it is live runtime we must not regress) — it becomes the first consumer
//! once provisioning is wired into the plugin enable lifecycle.
//!
//! ## Security gate (Core-vs-Gateway)
//!
//! Running `pip install` from a manifest is a network + arbitrary-code surface.
//! Provisioning MUST be gated on the plugin's **tier** (Core-tier only, per
//! #444) plus a Gateway **grant** (e.g. a `runtime.provision` / `network.fetch`
//! scope) before a Community plugin may install packages. That gate is the
//! Gateway's call (what is *allowed*); this module only describes + performs the
//! install once permitted. The gate is enforced by the caller, not here.

use std::path::{Path, PathBuf};

// The declaration types live in `plugin_manifest::schema` (so the manifest can
// carry them without depending on `sidecar`); re-exported here so callers of the
// provisioner have one import.
pub use crate::plugin_manifest::schema::{AssetSpec, ExternalRuntimeConfig};

/// The kind of external runtime a plugin declares. Open-ended (a `String`) so a
/// future `"node"`/`"deno"` runtime is a data change, not a code change —
/// "nothing hardcoded". Only `"python"` is provisionable today.
pub const RUNTIME_PYTHON: &str = "python";

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

/// Provision a Python runtime for `cfg` under `dir`: create the venv (if absent)
/// then pip-install the declared requirements/extra. Asset fetch is **not** done
/// here yet (the documented follow-on wires it through `DownloadCenter`).
///
/// Best-effort and idempotent: an existing venv is reused. The caller is
/// responsible for the tier + grant gate (see the module security note) BEFORE
/// calling this — by the time we are here, provisioning is permitted.
pub async fn provision(cfg: &ExternalRuntimeConfig, dir: &Path) -> Result<PathBuf, ProvisionError> {
    if cfg.kind != RUNTIME_PYTHON {
        return Err(ProvisionError::UnsupportedKind(cfg.kind.clone()));
    }

    tokio::fs::create_dir_all(dir)
        .await
        .map_err(ProvisionError::Mkdir)?;

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
    async fn provision_rejects_unsupported_kind() {
        let cfg = ExternalRuntimeConfig {
            kind: "node".to_owned(),
            entry: "x".to_owned(),
            ..Default::default()
        };
        let err = provision(&cfg, Path::new("/tmp/does-not-matter"))
            .await
            .unwrap_err();
        assert!(matches!(err, ProvisionError::UnsupportedKind(_)));
    }
}
