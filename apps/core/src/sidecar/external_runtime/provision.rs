//! The provision entry points: create the folder, fetch source, assets and models, then
//! the venv and the pip install.
// test-exempt: moved verbatim out of sidecar/external_runtime.rs by the module split; covered by sidecar/external_runtime/tests.rs.

use super::*;

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
    // Before the first file system call: the folder must be the package folder
    // or lie below it. A sidecar named like a drive-relative path (`C:x`) drops
    // the package folder in its caller's join, and the runtime would be built
    // in the current folder of that drive.
    if let Some(why) = crate::sidecar::extract_guard::names::runtime_dir_refusal(dir, package_root)
    {
        return Err(ProvisionError::UnsafePackagePath(format!(
            "runtime folder '{}' is refused: it {why}",
            dir.display()
        )));
    }
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
#[path = "provision_tests.rs"]
mod tests;
