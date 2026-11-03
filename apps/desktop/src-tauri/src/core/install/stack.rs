//! The Core/Gateway/CLI runtime release transaction: prepare a complete stack
//! in a staged generation, validate it, then activate it.

use std::io::Write as _;
use std::path::PathBuf;
use std::process::Stdio;

use tauri::{AppHandle, Emitter};

use super::binaries::{
    app_version, is_installed, managed_core_path, resolved_installed_path, CLI, CORE, GATEWAY,
};
use super::installer_script::run_unified_installer;
use super::release_digests::verify_staged_runtime;
use crate::win_process::NoWindow;

/// Ensure the managed Core/Gateway/CLI stack through the canonical public
/// installer. A matching managed pair is already standardized and needs no
/// installer run; otherwise the bundled script is the only binary installer used
/// by Desktop. Core is deliberately started later by `RyuCoreProcess`, which owns
/// its handle and shutdown lifecycle.
pub(super) static STACK_INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct PreparedStack {
    version: String,
    directory: PathBuf,
    digests: [String; 3],
}

pub(super) fn stack_digests(directory: &std::path::Path) -> Result<[String; 3], String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut digests = [String::new(), String::new(), String::new()];
    for (index, spec) in [&CORE, &GATEWAY, &CLI].into_iter().enumerate() {
        let file = if cfg!(windows) {
            format!("{}.exe", spec.bin_name)
        } else {
            spec.bin_name.to_owned()
        };
        let mut input =
            std::fs::File::open(directory.join(file)).map_err(|error| error.to_string())?;
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 65536];
        loop {
            let count = input.read(&mut buffer).map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        digests[index] = hex::encode(hash.finalize());
    }
    Ok(digests)
}

/// `bin/` under the target build's profile DEFAULT data dir (`~/.ryu<sfx>`).
/// Deliberately not pointer-resolved: an unscoped update prepares the runtime
/// for the profile the new version activates, not for the running one.
pub(super) fn default_runtime_root(home: PathBuf, version: &str) -> PathBuf {
    let profile = crate::profile::profile_for_version(version).unwrap_or("release");
    ryu_sidecar_runtime::layout::bin_dir(
        &home.join(format!(".ryu{}", crate::profile::suffix_of(profile))),
    )
}

pub(super) fn runtime_root_for_version(version: &str) -> PathBuf {
    let overridden = ["RYU_DIR", crate::profile::RYU_PROFILE_ENV]
        .iter()
        .any(|key| std::env::var(key).is_ok_and(|value| !value.trim().is_empty()));
    if overridden || cfg!(feature = "dev-variant") {
        return ryu_sidecar_runtime::layout::bin_dir(&crate::profile::ryu_home_dir());
    }
    default_runtime_root(
        dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")),
        version,
    )
}

pub(crate) fn has_prepared_runtime() -> bool {
    runtime_root_for_version(env!("CARGO_PKG_VERSION"))
        .join("prepared-stack.json")
        .is_file()
}

/// Every build, canary and nightly included, uploads its binaries to its own
/// `v<version>` tag; the rolling `canary`/`nightly` tags are deleted by CI. The
/// semver parse doubles as the path-traversal guard for the download URL.
pub(super) fn release_tag_for_version(expected: &str) -> Result<String, String> {
    let version = semver::Version::parse(expected).map_err(|error| error.to_string())?;
    Ok(format!("v{version}"))
}

pub(super) async fn validate_release_stack(
    directory: &std::path::Path,
    expected: &str,
) -> Result<(), String> {
    for spec in [&CORE, &GATEWAY, &CLI] {
        let file = if cfg!(windows) {
            format!("{}.exe", spec.bin_name)
        } else {
            spec.bin_name.to_owned()
        };
        let candidate = directory.join(&file);
        let marker = directory.join(format!("{file}.version"));
        if !candidate.is_file()
            || std::fs::metadata(&candidate)
                .map_err(|error| error.to_string())?
                .len()
                == 0
            || std::fs::read_to_string(marker)
                .map_err(|error| error.to_string())?
                .trim()
                != expected
        {
            return Err(format!(
                "{} failed staged release validation; the previous stack is unchanged",
                spec.bin_name
            ));
        }
        let mut probe = tokio::process::Command::new(&candidate);
        probe
            .arg("--version")
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .no_window();
        let output = tokio::time::timeout(std::time::Duration::from_secs(15), probe.output())
            .await
            .map_err(|_| format!("{} version check timed out", spec.bin_name))?
            .map_err(|error| error.to_string())?;
        if !output.status.success()
            || std::str::from_utf8(&output.stdout)
                .ok()
                .and_then(|value| value.split_whitespace().last())
                != Some(expected)
        {
            return Err(format!(
                "{} does not report v{expected}; refusing a mixed runtime release",
                spec.bin_name
            ));
        }
    }
    Ok(())
}

pub(super) async fn prepare_release_stack_locked(
    app: &AppHandle,
    expected: &str,
) -> Result<PathBuf, String> {
    release_tag_for_version(expected)?;
    let root = runtime_root_for_version(expected);
    let generations = ryu_runtime_install::RuntimeGenerations::new(root.clone());
    let marker = root.join("prepared-stack.json");
    if let Some(prepared) = std::fs::read(&marker)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PreparedStack>(&bytes).ok())
    {
        if prepared.version == expected {
            if let Ok(directory) = generations.prepared_dir(&prepared.directory) {
                if stack_digests(&directory).ok().as_ref() == Some(&prepared.digests)
                    && validate_release_stack(&directory, expected).await.is_ok()
                {
                    return Ok(directory);
                }
            }
        }
    }
    let staged = generations.stage().map_err(|error| error.to_string())?;
    run_unified_installer(app, staged.path(), expected).await?;
    // Pin the staged bytes to the digests GitHub published for this release
    // before running any of them; the installer's same-origin `.sha256` files
    // cannot vouch for a binary on their own.
    verify_staged_runtime(
        staged.path(),
        &crate::distribution::release_base(app)?,
        &release_tag_for_version(expected)?,
    )
    .await?;
    validate_release_stack(staged.path(), expected).await?;
    let directory = staged.keep();
    let mut file = tempfile::NamedTempFile::new_in(&root).map_err(|error| error.to_string())?;
    let prepared = PreparedStack {
        version: expected.to_owned(),
        directory: directory.clone(),
        digests: stack_digests(&directory)?,
    };
    file.write_all(&serde_json::to_vec(&prepared).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    file.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    file.persist(marker)
        .map_err(|error| error.error.to_string())?;
    tracing::info!(version = %expected, directory = %directory.display(), "complete runtime release prepared; active stack unchanged");
    Ok(directory)
}

/// Prepare all managed binaries before the app installer can exit this process.
pub(crate) async fn prepare_app_runtime(app: &AppHandle, expected: &str) -> Result<(), String> {
    if cfg!(debug_assertions)
        || !(crate::nodes::default_node_is_local() || managed_core_path().is_some())
    {
        return Ok(());
    }
    let _guard = STACK_INSTALL.lock().await;
    prepare_release_stack_locked(app, expected)
        .await
        .map(|_| ())
}

pub(crate) async fn prepared_core_for_update(
    app: &AppHandle,
    expected: &str,
) -> Result<Option<PathBuf>, String> {
    if !(crate::nodes::default_node_is_local() || managed_core_path().is_some()) {
        return Ok(None);
    }
    let _guard = STACK_INSTALL.lock().await;
    let directory = prepare_release_stack_locked(app, expected).await?;
    Ok(Some(directory.join(if cfg!(windows) {
        "ryu-core.exe"
    } else {
        "ryu-core"
    })))
}

pub async fn ensure_unified_installed(app: &AppHandle) -> Result<PathBuf, String> {
    let _guard = STACK_INSTALL.lock().await;
    let expected = app_version(app);
    if !is_installed(&CORE, &expected)
        || !is_installed(&GATEWAY, &expected)
        || !is_installed(&CLI, &expected)
    {
        let _ = app.emit(
            "installer-progress",
            serde_json::json!({
                "version": 1,
                "phase": "installer",
                "component": "installer",
                "status": "started",
                "percent": 0,
            }),
        );
        let generations = ryu_runtime_install::RuntimeGenerations::new(
            ryu_sidecar_runtime::layout::bin_dir(&crate::profile::ryu_home_dir()),
        );
        let directory = prepare_release_stack_locked(app, &expected).await?;
        let directory = generations
            .activate_prepared(&directory)
            .map_err(|error| error.to_string())?;
        tracing::info!(version = %expected, directory = %directory.display(), "Core/Gateway/CLI release transaction committed");
    }
    // Return the path that actually satisfied resolution. An operator-provided
    // RYU_CORE_BIN or external PATH hit must not be rewritten to a nonexistent
    // managed ~/.ryu/bin path.
    let core = resolved_installed_path(&CORE, &expected).ok_or_else(|| {
        "the installer completed without a resolvable ryu-core binary".to_string()
    })?;
    resolved_installed_path(&GATEWAY, &expected).ok_or_else(|| {
        "the installer completed without a resolvable ryu-gateway binary".to_string()
    })?;
    Ok(core)
}

/// Ensure `ryu-gateway` is installed, downloading it if absent. Skips the download
/// when it already resolves. **Required** sidecar — the caller awaits this *before*
/// starting Core (Core spawns the gateway at boot) and logs a loud warning on
/// failure, but the app still opens (degraded chat beats no app).
pub async fn ensure_gateway_installed(app: &AppHandle) -> Result<PathBuf, String> {
    ensure_unified_installed(app).await
}
