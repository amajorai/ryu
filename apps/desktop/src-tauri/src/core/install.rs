//! Production-only auto-install of the out-of-process Ryu sidecar binaries from the
//! public download hub (amajorai/ryu) into `~/.ryu/bin/`. In dev the binaries are
//! owned by turbo (`bun run dev:core` / `dev:gateway`), so this path never runs
//! there — `lib.rs` gates every call on `not(debug_assertions)`.
//!
//! The binaries are resolved by Core the same way (env override else bare command
//! name on a PATH that includes `~/.ryu/bin`), split into two policy classes:
//!
//! **Required (loud on failure):**
//!   - `ryu-core`     — the orchestration engine (auto-installed since day one).
//!   - `ryu-gateway`  — the control layer Core spawns as a managed sidecar.
//!                      Core hands every model call to it (`sidecar/gateway.rs`,
//!                      `DEFAULT_GATEWAY_BIN = "ryu-gateway"`, resolved on PATH). Nothing
//!                      installed it before this module — that was the real gap.
//!
//! **App sidecars (opt-in feature backends) are NOT installed here.** This desktop
//! layer only fetches the two required bins above. Each apps-store app's `ryu-<app>`
//! binary (mail/teams/research/clips/finetune/quests/healing/meetings/recipes/
//! dashboards/monitors) is downloaded by **Core on-demand the first time the app is
//! enabled**, and removed on uninstall — tying the binary to the app lifecycle
//! instead of a blanket boot-prefetch. See
//! `apps/core/src/sidecar/manifest_sidecar.rs` (`ensure_local_sidecar_present` /
//! `remove_local_sidecar_binaries`) and `plans/019-sidecar-binary-lifecycle.md`.
//! (`ryu-browser` is an Electron bundle, never a single-file spawnable, and still
//! resolves only when already on PATH via `RYU_BROWSER_BIN`.)

use std::io::Write as _;
use std::path::PathBuf;
use std::process::Stdio;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::win_process::NoWindow;

const RELEASE_BASE: &str = "https://github.com/amajorai/ryu/releases/latest/download";
const INSTALL_EVENT_PREFIX: &str = "RYU_INSTALL_EVENT:";
const DESKTOP_INSTALLER_START_CORE: &str = "0";

/// The canonical installers are compiled into the signed Desktop bundle.
///
/// Fetching `main/install.{sh,ps1}` and executing it made a mutable branch an
/// unsigned remote-code path. `include_bytes!` pins the exact reviewed script to
/// this build; the normal Tauri updater signature authenticates the bundle that
/// carries it. Headless users still download the public mirror, while Desktop
/// executes only the copy shipped with itself.
fn bundled_install_script() -> &'static [u8] {
    if cfg!(windows) {
        include_bytes!("../../../../../mirror/overlay/install.ps1")
    } else {
        include_bytes!("../../../../../mirror/overlay/install.sh")
    }
}

/// The running desktop app's version (e.g. `"0.0.8"`), used to stamp downloaded
/// sidecars and to decide whether an already-installed one is stale. The release
/// hub publishes core/gateway/etc under `/releases/latest/download`, so their
/// contents track this same train — a mismatch means the app self-updated (via
/// the Tauri updater) while a sidecar from the old version lingered in
/// `~/.ryu/bin/`, and must be re-fetched.
fn app_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Path to the version marker written next to an installed binary:
/// `~/.ryu/bin/<bin_name>.version`. Records which app version installed it so a
/// later launch can detect and replace a stale binary.
fn version_marker_path(bin_name: &str) -> Option<PathBuf> {
    install_path(bin_name).map(|path| {
        let mut marker = path.into_os_string();
        marker.push(".version");
        PathBuf::from(marker)
    })
}

/// Whether the managed `~/.ryu/bin/<bin>` was installed by the currently-running
/// app version. A missing marker (legacy binary predating this scheme) counts as
/// a mismatch, so it is re-downloaded once and gains a marker.
fn installed_version_matches(bin_name: &str, expected: &str) -> bool {
    version_marker_path(bin_name)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|v| v.trim() == expected)
        .unwrap_or(false)
}

/// Whether the managed `~/.ryu/bin/<bin>` exists but was installed by a *different*
/// app version — i.e. it should be re-downloaded. An explicit `RYU_<X>_BIN`
/// override is user-managed, so it is never treated as stale. A binary that isn't
/// in `~/.ryu/bin/` at all returns `false` here (that's an "install", not an
/// "upgrade" — handled by [`is_installed`] / the `None` path in `lib.rs`).
fn is_managed_stale(spec: &SidecarBinary, expected: &str) -> bool {
    if std::env::var(spec.env_var)
        .ok()
        .map(PathBuf::from)
        .is_some_and(|p| p.exists())
    {
        return false;
    }
    match install_path(spec.bin_name) {
        Some(p) if p.exists() => !installed_version_matches(spec.bin_name, expected),
        _ => false,
    }
}

/// Whether a stale managed `ryu-core` is sitting in `~/.ryu/bin/` (installed by an
/// older app version). Called from `lib.rs`'s core-start path to trigger a
/// re-download after the app self-updates. Kept public since `CORE` is private.
pub fn is_managed_core_stale(app: &AppHandle) -> bool {
    is_managed_stale(&CORE, &app_version(app))
}

/// A binary this module can install: the release-asset base name (before the
/// `-<os>-<arch>` platform suffix), the file name to write under `~/.ryu/bin/`, and
/// the env var Core reads to override the binary path (kept in sync with Core's own
/// resolvers so [`is_installed`] agrees with what Core will actually spawn).
#[derive(Clone, Copy)]
struct SidecarBinary {
    /// Release-asset base, e.g. `"ryu-gateway"`. The platform suffix + any `.exe`
    /// is appended by [`platform_asset`].
    asset_base: &'static str,
    /// File name written under `~/.ryu/bin/`, e.g. `"ryu-gateway"` (`.exe` on
    /// Windows added by [`install_path`]). This is the bare command name Core
    /// resolves on PATH.
    bin_name: &'static str,
    /// Env var Core reads to override the binary path (e.g. `RYU_GATEWAY_BIN`);
    /// `RYU_CORE_BIN` for core. If set to an existing file, the binary counts as
    /// installed and we skip the download.
    env_var: &'static str,
}

const CORE: SidecarBinary = SidecarBinary {
    asset_base: "ryu-core",
    bin_name: "ryu-core",
    env_var: "RYU_CORE_BIN",
};
const GATEWAY: SidecarBinary = SidecarBinary {
    asset_base: "ryu-gateway",
    bin_name: "ryu-gateway",
    env_var: "RYU_GATEWAY_BIN",
};
const CLI: SidecarBinary = SidecarBinary {
    asset_base: "ryu-cli",
    bin_name: "ryu-cli",
    env_var: "RYU_CLI_BIN",
};
// NOTE: the per-app opt-in sidecar consts (MAIL/TEAMS/RESEARCH/… ) and the
// `OPTIONAL_SIDECARS` boot-prefetch that used to live here have been REMOVED. The
// desktop no longer downloads app bins up-front; Core now fetches each app's
// `ryu-<app>` binary on-demand the first time the app is *enabled* (and removes it
// on uninstall) — see `apps/core/src/sidecar/manifest_sidecar.rs`
// (`ensure_local_sidecar_present` / `remove_local_sidecar_binaries`) and
// `plans/019-sidecar-binary-lifecycle.md`. Only the REQUIRED core+gateway bins below
// are installed by this desktop layer.
//
// `ryu-browser` was likewise never prefetched (Electron bundle, not a single-file
// spawnable) and still resolves only when already on PATH via `RYU_BROWSER_BIN`.

/// The `<os>-<arch>` fragment shared by every asset name, or `None` on an
/// unsupported platform. Matches the published release assets: `linux-x86_64`,
/// `macos-aarch64`, `windows-x86_64`.
fn platform_slug() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("linux-x86_64"),
        ("macos", "aarch64") => Some("macos-aarch64"),
        ("windows", "x86_64") => Some("windows-x86_64"),
        _ => None,
    }
}

/// The release asset name for `base` on the running platform, or `None` if no
/// prebuilt is published for it. e.g. `ryu-gateway` → `ryu-gateway-macos-aarch64`
/// (or `ryu-gateway-windows-x86_64.exe` on Windows). The `.exe` matches how the
/// release publishes Windows executables (see the core asset naming).
fn platform_asset(base: &str) -> Option<String> {
    let slug = platform_slug()?;
    let ext = if cfg!(windows) { ".exe" } else { "" };
    Some(format!("{base}-{slug}{ext}"))
}

/// Destination for an installed binary: `~/.ryu{profile}/bin/<bin_name>[.exe]`. This
/// is the second path Core's resolvers probe (after the env override), so a download
/// here is picked up on the next spawn. Profile-aware so a dev app installs its OWN
/// binaries under `~/.ryu-dev/bin` instead of overwriting the release app's `~/.ryu/bin`.
fn install_path(bin_name: &str) -> Option<PathBuf> {
    let file = if cfg!(windows) {
        format!("{bin_name}.exe")
    } else {
        bin_name.to_string()
    };
    let root = ryu_sidecar_runtime::layout::bin_dir(&crate::profile::ryu_home_dir());
    ryu_runtime_install::RuntimeGenerations::new(root)
        .active_dir()
        .ok()
        .map(|directory| directory.join(file))
}

pub(crate) fn managed_core_path() -> Option<PathBuf> {
    install_path(CORE.bin_name).filter(|path| path.is_file())
}

pub(crate) fn managed_gateway_path() -> Option<PathBuf> {
    install_path(GATEWAY.bin_name).filter(|path| path.is_file())
}

/// Whether `spec` already resolves to a real file — mirroring how Core resolves it
/// (env override → `~/.ryu/bin/<bin>` → bare name on PATH). Used to skip a redundant
/// download on every launch. `~/.ryu/bin` is on the PATH Core builds, so the
/// `~/.ryu/bin` and PATH checks usually coincide; both are kept for env-less setups.
fn resolved_installed_path(spec: &SidecarBinary, expected_version: &str) -> Option<PathBuf> {
    // 1. Explicit env override pointing at an existing file — user-managed, so we
    //    respect it regardless of version.
    if let Some(path) = std::env::var(spec.env_var)
        .ok()
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Some(path);
    }
    // 2. Our install target under ~/.ryu/bin. Only "installed" when its version
    //    marker matches the running app: a binary left over from an older app
    //    version is treated as absent so it is re-downloaded (and NOT rescued by
    //    the PATH check below, since ~/.ryu/bin is on PATH — this branch returns).
    let p = install_path(spec.bin_name)?;
    if p.exists() {
        return installed_version_matches(spec.bin_name, expected_version).then_some(p);
    }
    // 3. Anywhere else on PATH — an external install we don't manage; respect it.
    //    EXCEPT another profile's install: `~/.ryu/bin` and `~/.ryu-dev/bin` are both
    //    on PATH, so counting the release binary as "installed" here is what leaves a
    //    dev profile with no `ryu-core` of its own (and silently running the release
    //    one against `~/.ryu-dev`). Treat it as absent so it gets downloaded — this
    //    must stay in lockstep with the same rejection in `resolve_core_binary`.
    which::which(spec.bin_name)
        .ok()
        .filter(|hit| !crate::profile::is_foreign_profile_bin(hit))
        .filter(|hit| {
            !hit.starts_with(ryu_sidecar_runtime::layout::bin_dir(
                &crate::profile::ryu_home_dir(),
            ))
        })
}

fn is_installed(spec: &SidecarBinary, expected_version: &str) -> bool {
    resolved_installed_path(spec, expected_version).is_some()
}

/// Forward one machine-readable line from the canonical one-line installer to
/// the webview. Human output remains in the child process log; only the stable
/// `RYU_INSTALL_EVENT:` envelope crosses the Tauri boundary.
fn forward_installer_event(app: &AppHandle, line: &str) {
    let Some(json) = line.trim().strip_prefix(INSTALL_EVENT_PREFIX) else {
        return;
    };
    match serde_json::from_str::<serde_json::Value>(json) {
        Ok(payload) => {
            let _ = app.emit("installer-progress", payload);
        }
        Err(error) => {
            tracing::warn!(%error, line, "canonical installer emitted invalid progress JSON");
        }
    }
}

/// Run the same canonical installer used by headless users from the copy pinned
/// inside this signed bundle. A private temporary file lets the shell process be
/// supervised and its stdout streamed without introducing a mutable network
/// script. The installer owns Core, Gateway, and CLI installation; Desktop starts
/// Core itself afterwards so it retains the child handle and owns shutdown.
async fn run_unified_installer(
    app: &AppHandle,
    install_dir: &std::path::Path,
    expected: &str,
) -> Result<(), String> {
    let suffix = if cfg!(windows) { ".ps1" } else { ".sh" };
    let mut script_file = tempfile::Builder::new()
        .prefix("ryu-installer-")
        .suffix(suffix)
        .tempfile()
        .map_err(|e| format!("create temporary installer script: {e}"))?;
    // Windows PowerShell 5 otherwise interprets the UTF-8 script as its ANSI
    // code page. PowerShell 7 accepts the same BOM without changing semantics.
    if cfg!(windows) {
        script_file
            .write_all(&[0xef, 0xbb, 0xbf])
            .map_err(|error| format!("write installer encoding marker: {error}"))?;
    }
    script_file
        .write_all(bundled_install_script())
        .map_err(|e| format!("write temporary installer script: {e}"))?;
    script_file
        .as_file()
        .sync_all()
        .map_err(|e| format!("sync temporary installer script: {e}"))?;
    // Close the write handle before PowerShell/sh opens it, while retaining a
    // TempPath guard that removes the file on every return path.
    let script_path = script_file.into_temp_path();

    let mut command = if cfg!(windows) {
        let shell = which::which("pwsh")
            .or_else(|_| which::which("powershell"))
            .map_err(|_| "could not find PowerShell (pwsh or powershell)".to_string())?;
        let mut command = tokio::process::Command::new(shell);
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ]);
        command.arg(script_path.as_os_str());
        command
            .arg("-ReleaseBase")
            .arg(crate::distribution::release_base(app)?);
        command
    } else {
        let mut command = tokio::process::Command::new("sh");
        command.arg(script_path.as_os_str());
        command
            .arg("--release-base")
            .arg(crate::distribution::release_base(app)?);
        command
    };

    let core_bind = format!("127.0.0.1:{}", crate::profile::core_port());
    let core_url = crate::profile::core_base_url();
    let core_log =
        ryu_sidecar_runtime::layout::logs_dir(&crate::profile::ryu_home_dir()).join("ryu-core.log");
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("RYU_INSTALL_DIR", install_dir)
        .env("RYU_VERSION", release_tag_for_version(expected)?)
        .env("RYU_SKIP_CHECKSUM", "0")
        .env("RYU_NO_MODIFY_PATH", "1")
        .env("RYU_PROGRESS_FORMAT", "json")
        .env("RYU_INSTALL_MARKER", expected)
        // Desktop must own the Core child. If the installer starts it detached,
        // RyuCoreProcess observes a healthy port but has no handle to stop on Quit.
        .env("RYU_START_CORE", DESKTOP_INSTALLER_START_CORE)
        .env("RYU_CORE_BIND", core_bind)
        .env("RYU_CORE_URL", core_url)
        .env("RYU_CORE_LOG", core_log)
        .env("RYU_PROFILE", crate::profile::name())
        .no_window();

    let mut child = command
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("start canonical installer: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "canonical installer stdout was not captured".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "canonical installer stderr was not captured".to_string())?;
    let mut stdout_lines = BufReader::new(stdout).lines();
    let mut stderr_lines = BufReader::new(stderr).lines();
    let mut stdout_done = false;
    let mut stderr_done = false;

    while !stdout_done || !stderr_done {
        tokio::select! {
            result = stdout_lines.next_line(), if !stdout_done => {
                match result {
                    Ok(Some(line)) => forward_installer_event(app, &line),
                    Ok(None) => stdout_done = true,
                    Err(error) => {
                        tracing::warn!(%error, "read canonical installer stdout failed");
                        stdout_done = true;
                    }
                }
            }
            result = stderr_lines.next_line(), if !stderr_done => {
                match result {
                    Ok(Some(line)) => tracing::info!(target: "ryu_installer", "{line}"),
                    Ok(None) => stderr_done = true,
                    Err(error) => {
                        tracing::warn!(%error, "read canonical installer stderr failed");
                        stderr_done = true;
                    }
                }
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("wait for canonical installer: {e}"))?;
    if !status.success() {
        let error = format!("canonical installer exited with {status}");
        let _ = app.emit(
            "installer-progress",
            serde_json::json!({
                "version": 1,
                "phase": "error",
                "component": "installer",
                "status": "failed",
                "percent": 0,
                "error": error,
            }),
        );
        return Err(error);
    }
    Ok(())
}

/// Ensure the managed Core/Gateway/CLI stack through the canonical public
/// installer. A matching managed pair is already standardized and needs no
/// installer run; otherwise the bundled script is the only binary installer used
/// by Desktop. Core is deliberately started later by `RyuCoreProcess`, which owns
/// its handle and shutdown lifecycle.
static STACK_INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(serde::Serialize, serde::Deserialize)]
struct PreparedStack {
    version: String,
    directory: PathBuf,
    digests: [String; 3],
}

fn stack_digests(directory: &std::path::Path) -> Result<[String; 3], String> {
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
fn default_runtime_root(home: PathBuf, version: &str) -> PathBuf {
    let profile = crate::profile::profile_for_version(version).unwrap_or("release");
    ryu_sidecar_runtime::layout::bin_dir(
        &home.join(format!(".ryu{}", crate::profile::suffix_of(profile))),
    )
}

fn runtime_root_for_version(version: &str) -> PathBuf {
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
fn release_tag_for_version(expected: &str) -> Result<String, String> {
    let version = semver::Version::parse(expected).map_err(|error| error.to_string())?;
    Ok(format!("v{version}"))
}

async fn validate_release_stack(directory: &std::path::Path, expected: &str) -> Result<(), String> {
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

async fn prepare_release_stack_locked(app: &AppHandle, expected: &str) -> Result<PathBuf, String> {
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

/// Download `asset` from the release hub into `~/.ryu/bin/<dest_file>` and return
/// its path. Writes to a temp path then renames, so an interrupted download never
/// leaves a truncated binary that looks installed; sets `0o755` on unix. Emits
/// `<event>` progress events with a `phase` of
/// `downloading` | `installing` | `done` | `error` so the UI can show status.
///
/// The `downloading` phase is emitted repeatedly as the body streams, carrying
/// `received` / `total` byte counts. It used to fire ONCE and then sit on a
/// `resp.bytes()` that buffers the whole asset — 119 MB for core, 40 MB for the
/// gateway — so onboarding showed "Downloading Ryu Core…" and then nothing at all
/// for minutes, which is what reads as "stuck forever". Streaming is what makes
/// the wait legible; `RESPONSE_TIMEOUT` now bounds the *headers* rather than the
/// whole transfer, so a slow-but-alive download is no longer killed at 600s while
/// a dead connection still fails fast.
///
/// This is the shared core of every installer — `download_core_binary` and the
/// gateway/optional-app installers all funnel through it, parameterised by
/// (`asset`, `dest_file`, `event`).
async fn download_release_binary(
    app: &AppHandle,
    asset: &str,
    dest: PathBuf,
    event: &str,
) -> Result<PathBuf, String> {
    use std::io::Write as _;

    let url = format!("{RELEASE_BASE}/{asset}");

    let _ = app.emit(
        event,
        serde_json::json!({ "phase": "downloading", "asset": asset, "received": 0 }),
    );

    let client = reqwest::Client::builder()
        // Bounds the connect + response-headers phase only, NOT the body stream:
        // a 119 MB asset on a slow link legitimately outruns any whole-request
        // budget, while an unreachable host still fails in seconds.
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download {url}: {e}"))?;
    if !resp.status().is_success() {
        let err = format!("download {url}: HTTP {}", resp.status());
        let _ = app.emit(event, serde_json::json!({ "phase": "error", "error": err }));
        return Err(err);
    }

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    // Write to a temp path then rename, so an interrupted download never leaves a
    // truncated binary that looks installed.
    let tmp = dest.with_extension("download");
    let total = resp.content_length();
    let mut received: u64 = 0;
    // Emit at most one event per 1 MB so a fast download doesn't flood the webview
    // with thousands of IPC messages.
    const PROGRESS_STEP: u64 = 1024 * 1024;
    let mut next_emit = PROGRESS_STEP;
    let mut resp = resp;
    {
        let mut file =
            std::fs::File::create(&tmp).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        loop {
            let chunk = match resp.chunk().await {
                Ok(Some(c)) => c,
                Ok(None) => break,
                Err(e) => {
                    let err = format!("download {url}: {e}");
                    let _ = app.emit(event, serde_json::json!({ "phase": "error", "error": err }));
                    let _ = std::fs::remove_file(&tmp);
                    return Err(err);
                }
            };
            file.write_all(&chunk)
                .map_err(|e| format!("write {}: {e}", tmp.display()))?;
            received += chunk.len() as u64;
            if received >= next_emit {
                next_emit = received + PROGRESS_STEP;
                let _ = app.emit(
                    event,
                    serde_json::json!({
                        "phase": "downloading",
                        "asset": asset,
                        "received": received,
                        "total": total,
                    }),
                );
            }
        }
        file.flush()
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    }

    let _ = app.emit(event, serde_json::json!({ "phase": "installing" }));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod {}: {e}", tmp.display()))?;
    }
    std::fs::rename(&tmp, &dest).map_err(|e| format!("install {}: {e}", dest.display()))?;

    let _ = app.emit(
        event,
        serde_json::json!({ "phase": "done", "path": dest.to_string_lossy() }),
    );
    Ok(dest)
}

/// Resolve `(asset, dest)` for `spec`, then download it. Shared by every named
/// installer below; returns a clear error on an unsupported platform or missing
/// home dir so callers can decide whether the miss is fatal.
async fn install_sidecar(
    app: &AppHandle,
    spec: &SidecarBinary,
    event: &str,
) -> Result<PathBuf, String> {
    let asset = platform_asset(spec.asset_base).ok_or_else(|| {
        format!(
            "no prebuilt {} for {}-{}",
            spec.asset_base,
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let dest = install_path(spec.bin_name).ok_or("could not resolve home directory")?;
    let path = download_release_binary(app, &asset, dest, event).await?;
    // Stamp the version so a future launch can tell whether this binary is stale
    // after the app self-updates. Best-effort: a missing marker just forces one
    // redundant re-download next time, never a broken install.
    if let Some(marker) = version_marker_path(spec.bin_name) {
        let _ = std::fs::write(marker, app_version(app));
    }
    Ok(path)
}

/// Download the platform `ryu-core` binary into `~/.ryu/bin/` and return its path.
/// Emits `core-install-progress` events. (Signature preserved — called from
/// `lib.rs` first-launch orchestration and `ensure_core_installed`.)
pub async fn download_core_binary(app: &AppHandle) -> Result<PathBuf, String> {
    ensure_unified_installed(app).await
}

/// Download the platform `ryu-gateway` binary into `~/.ryu/bin/` and return its
/// path. **Required**: Core spawns `ryu-gateway` as a managed sidecar and hands it
/// every model call, so a missing gateway degrades chat. Emits
/// `gateway-install-progress` events. The caller treats a failure as loud-but-non-fatal
/// (warn, still let the app open) and — critically — awaits this *before* starting
/// Core so the gateway is on disk when Core's spawn resolves it on PATH.
pub async fn download_gateway_binary(app: &AppHandle) -> Result<PathBuf, String> {
    ensure_unified_installed(app).await
}

/// Ensure `ryu-gateway` is installed, downloading it if absent. Skips the download
/// when it already resolves. **Required** sidecar — the caller awaits this *before*
/// starting Core (Core spawns the gateway at boot) and logs a loud warning on
/// failure, but the app still opens (degraded chat beats no app).
pub async fn ensure_gateway_installed(app: &AppHandle) -> Result<PathBuf, String> {
    ensure_unified_installed(app).await
}

// The opt-in app-sidecar prefetch (`progress_event`, `ensure_optional_installed`,
// `spawn_optional_sidecar_installs`) was REMOVED — Core now downloads each app's
// `ryu-<app>` binary on-demand at enable-time (see the note by the const block above
// and `plans/019-sidecar-binary-lifecycle.md`). Only core + gateway are installed by
// this desktop layer; `install_sidecar` / `is_installed` / `install_path` remain,
// shared by the required-bin installers above.

// ---------------------------------------------------------------------------
// Island (the Electron companion overlay)
// ---------------------------------------------------------------------------
//
// Island is NOT a `SidecarBinary`: its release assets follow electron-builder's
// naming, not the `<base>-<slug>[.exe]` scheme every single-file sidecar shares,
// and it installs into its OWN directory (`<data dir>/bin/island/`, kept apart
// from the flat `bin/` sidecars so the bundle — a whole `.app` on macOS — never
// mingles with the command binaries). So it gets a dedicated resolver + installer +
// launcher below rather than an entry in the sidecar tables.
//
// The tray already drives an *already-running* island through its loopback
// control server (`tray::island_control`); this module supplies the missing
// "download it and start it in the first place" half. Island self-guards with an
// Electron single-instance lock (`app.requestSingleInstanceLock()` in
// `apps/island/src/main/index.ts`), so a redundant `launch_island` on a restart
// where island is already up self-exits — the launch path can stay unconditional.

/// The dedicated install directory for Island: `<data dir>/bin/island/`. A
/// subfolder of `bin/` because the Electron bundle is more than one file (a whole
/// `.app` tree on macOS) and should not clutter the flat command-binary dir.
fn island_dir() -> Option<PathBuf> {
    Some(ryu_sidecar_runtime::layout::bin_dir(&crate::profile::ryu_home_dir()).join("island"))
}

/// The installed Island launch target under `<data dir>/bin/island/`:
///   - Windows: `ryu-island.exe` (the renamed portable single-exe)
///   - Linux:   `ryu-island.AppImage`
///   - macOS:   `Ryu Island.app` (a bundle *directory*, launched via `open`)
fn island_install_path() -> Option<PathBuf> {
    let dir = island_dir()?;
    let file = if cfg!(target_os = "windows") {
        "ryu-island.exe"
    } else if cfg!(target_os = "macos") {
        "Ryu Island.app"
    } else {
        "ryu-island.AppImage"
    };
    Some(dir.join(file))
}

/// Version marker for the installed Island bundle: `<data dir>/bin/island/.version`. Mirrors
/// the sidecar markers — records which app version installed it so a later launch can
/// re-download after the app self-updates and leaves a stale bundle behind.
fn island_version_marker() -> Option<PathBuf> {
    island_dir().map(|d| d.join(".version"))
}

/// Whether the installed Island bundle was placed by the currently-running app
/// version. A missing/mismatched marker counts as stale (re-download once).
fn island_version_matches(expected: &str) -> bool {
    island_version_marker()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|v| v.trim() == expected)
        .unwrap_or(false)
}

/// Whether Island is installed AND matches the running app version. A bundle left by
/// an older app version is treated as absent so [`ensure_island_installed`] re-fetches
/// it. Unlike the sidecars there is no env override — Island has no `RYU_*_BIN` hook.
fn is_island_installed(expected: &str) -> bool {
    match island_install_path() {
        Some(p) if p.exists() => island_version_matches(expected),
        _ => false,
    }
}

/// Ask the local Core to install Island through its global DownloadCenter. The
/// response waits for extraction so this function never reports a path before the
/// bundle is launchable. Current Desktop/Core releases always take this path.
async fn ensure_island_via_core(expected: &str) -> Result<PathBuf, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(30 * 60))
        .build()
        .map_err(|error| format!("create Island installer client: {error}"))?;
    let mut url = reqwest::Url::parse(&format!(
        "{}/api/setup/island/install",
        crate::profile::core_base_url()
    ))
    .map_err(|error| format!("build Island install URL: {error}"))?;
    url.query_pairs_mut()
        .append_pair("wait", "true")
        .append_pair("version", expected);
    let mut request = client.post(url);
    if let Some(token) = std::env::var("RYU_TOKEN")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(crate::nodes::read_local_node_token)
    {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("request Island install through Core: {error}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(
            "the running Core does not support the verified Island installer; update Core and retry"
                .to_owned(),
        );
    }
    let status = response.status();
    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("read Island install response: {error}"))?;
    if !status.is_success() || body.get("success").and_then(|value| value.as_bool()) != Some(true) {
        let error = body
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or("Core could not install Ryu Island");
        return Err(format!("{error} (HTTP {status})"));
    }
    let path = body
        .get("path")
        .and_then(|value| value.as_str())
        .map(PathBuf::from)
        .or_else(island_install_path)
        .ok_or_else(|| "Core installed Island but returned no launch path".to_string())?;
    if !path.exists() || !is_island_installed(expected) {
        return Err(
            "Core reported Island installed, but its version marker is missing".to_string(),
        );
    }
    Ok(path)
}

/// Ensure the Island companion is installed under `<data dir>/bin/island/`. Current Core
/// handles the artifact through the global DownloadCenter (#456), including resume,
/// verification, progress, and atomic materialization. Desktop deliberately has no
/// second downloader: a missing endpoint is an actionable compatibility error rather
/// than an integrity downgrade.
pub async fn ensure_island_installed(app: &AppHandle) -> Result<PathBuf, String> {
    let expected = app_version(app);
    if is_island_installed(&expected) {
        return island_install_path().ok_or("could not resolve home directory".to_string());
    }

    ensure_island_via_core(&expected).await
}

/// Launch the installed Island companion DETACHED, so it runs as an independent
/// process that outlives this call. Returns `Err` (loudly) when Island isn't
/// installed. Island self-guards with an Electron single-instance lock, so calling
/// this while an island is already running self-exits — safe to call unconditionally
/// on startup.
pub fn launch_island() -> Result<(), String> {
    let target = island_install_path().ok_or("could not resolve home directory")?;
    if !target.exists() {
        return Err(format!("Ryu Island not installed at {}", target.display()));
    }

    #[cfg(target_os = "macos")]
    {
        // `open` launches the `.app` bundle detached and returns immediately.
        std::process::Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("launch Ryu Island: {e}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        use crate::win_process::NoWindow;
        // Windows portable `.exe` self-extracts on launch; the Linux AppImage runs
        // directly. Spawn and drop the child handle — it runs detached. `no_window()`
        // suppresses a stray console window on Windows (no-op elsewhere).
        std::process::Command::new(&target)
            .no_window()
            .spawn()
            .map_err(|e| format!("launch Ryu Island: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::sync::Mutex;

    use super::*;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvRestore {
        key: &'static str,
        previous: Option<OsString>,
    }

    impl EnvRestore {
        fn set(key: &'static str, value: &std::path::Path) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.take() {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    #[test]
    fn desktop_executes_the_canonical_script_bundled_with_the_signed_app() {
        let script = std::str::from_utf8(bundled_install_script()).expect("installer is UTF-8");
        assert!(script.contains("RYU_INSTALL_EVENT:"));
        assert!(script.contains("RYU_START_CORE"));
        assert!(script.len() > 1_000, "a truncated installer must not ship");
    }

    #[test]
    fn desktop_installer_leaves_core_startup_to_the_process_manager() {
        assert_eq!(DESKTOP_INSTALLER_START_CORE, "0");
    }

    #[test]
    fn release_sources_are_pinned_and_rolling_builds_require_version_validation() {
        assert_eq!(release_tag_for_version("0.4.1").unwrap(), "v0.4.1");
        assert_eq!(
            release_tag_for_version("0.4.1-canary.123").unwrap(),
            "v0.4.1-canary.123"
        );
        assert_eq!(
            release_tag_for_version("0.4.1-nightly.123").unwrap(),
            "v0.4.1-nightly.123"
        );
        assert!(release_tag_for_version("../../foreign").is_err());
    }

    #[test]
    fn preparation_uses_the_profile_of_the_target_build() {
        let home = PathBuf::from("home");
        assert_eq!(
            default_runtime_root(home.clone(), "0.4.1"),
            home.join(".ryu/bin")
        );
        assert_eq!(
            default_runtime_root(home.clone(), "0.4.1-canary.123"),
            home.join(".ryu-canary/bin")
        );
        assert_eq!(
            default_runtime_root(home.clone(), "0.4.1-nightly.123"),
            home.join(".ryu-nightly/bin")
        );
    }

    #[tokio::test]
    async fn executable_validation_rejects_partial_and_mixed_sets_before_activation() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("fixture.rs");
        std::fs::write(&source, r#"fn main() {
            let exe = std::env::current_exe().unwrap();
            let name = exe.file_name().unwrap().to_string_lossy();
            let version = std::fs::read_to_string(exe.with_file_name(format!("{name}.reported-version"))).unwrap();
            println!("{name} {}", version.trim());
        }"#).unwrap();
        let fixture = root.path().join(if cfg!(windows) {
            "fixture.exe"
        } else {
            "fixture"
        });
        let compiler = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
        let built = std::process::Command::new(compiler)
            .arg(&source)
            .arg("--crate-name")
            .arg("update_fixture")
            .arg("-o")
            .arg(&fixture)
            .no_window()
            .output()
            .unwrap();
        assert!(
            built.status.success(),
            "{}",
            String::from_utf8_lossy(&built.stderr)
        );
        let store = ryu_runtime_install::RuntimeGenerations::new(root.path().join("runtime"));
        let old = store.stage().unwrap();
        let old = store.activate(old).unwrap();
        let candidate = store.stage().unwrap();
        for spec in [&CORE, &GATEWAY, &CLI] {
            let name = if cfg!(windows) {
                format!("{}.exe", spec.bin_name)
            } else {
                spec.bin_name.to_owned()
            };
            std::fs::copy(&fixture, candidate.path().join(&name)).unwrap();
            std::fs::write(candidate.path().join(format!("{name}.version")), "0.4.1").unwrap();
            std::fs::write(
                candidate.path().join(format!("{name}.reported-version")),
                "0.4.1",
            )
            .unwrap();
        }
        validate_release_stack(candidate.path(), "0.4.1")
            .await
            .unwrap();
        let trusted = stack_digests(candidate.path()).unwrap();
        let gateway = if cfg!(windows) {
            "ryu-gateway.exe"
        } else {
            "ryu-gateway"
        };
        let gateway_path = candidate.path().join(gateway);
        std::fs::write(
            candidate.path().join(format!("{gateway}.reported-version")),
            "0.4.0",
        )
        .unwrap();
        assert!(validate_release_stack(candidate.path(), "0.4.1")
            .await
            .is_err());
        assert_eq!(store.active_dir().unwrap(), old);
        // Byte corruption must fail the cache check even if its version marker
        // and executable's reported version remain unchanged.
        let original = std::fs::read(&gateway_path).unwrap();
        let mut changed = original.clone();
        changed.push(0);
        std::fs::write(&gateway_path, changed).unwrap();
        assert_ne!(stack_digests(candidate.path()).unwrap(), trusted);
        std::fs::write(&gateway_path, original).unwrap();
        std::fs::remove_file(candidate.path().join(format!("{gateway}.version"))).unwrap();
        assert!(validate_release_stack(candidate.path(), "0.4.1")
            .await
            .is_err());
        assert_eq!(store.active_dir().unwrap(), old);
    }

    #[test]
    fn explicit_core_override_is_the_path_returned_to_the_caller() {
        let _lock = ENV_LOCK.lock().expect("environment lock");
        let directory = tempfile::tempdir().expect("temporary directory");
        let override_path = directory.path().join(if cfg!(windows) {
            "custom-core.exe"
        } else {
            "custom-core"
        });
        std::fs::write(&override_path, b"test executable").expect("override file");
        let _restore = EnvRestore::set(CORE.env_var, &override_path);

        assert_eq!(
            resolved_installed_path(&CORE, "does-not-matter"),
            Some(override_path)
        );
    }
}
