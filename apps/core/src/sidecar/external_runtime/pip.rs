//! The pip security constraints: the constraints file, the pip argument lists and the
//! repair of an installed floor. The pip tests stay in this file (see the note in
//! `pip_install_call_sites_go_through_the_constraint_helper` - this is the one file that
//! may spell out a pip install argument list).

use super::*;

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

#[cfg(test)]
mod tests {
    use super::*;

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
        let helper =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("src/sidecar/external_runtime/pip.rs");
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
}
