//! The canonical one-line installer, bundled into the signed app and run as a
//! supervised child that streams `RYU_INSTALL_EVENT:` progress to the webview.

use std::io::Write as _;
use std::process::Stdio;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::stack::release_tag_for_version;
use crate::win_process::NoWindow;

pub(super) const INSTALL_EVENT_PREFIX: &str = "RYU_INSTALL_EVENT:";
pub(super) const DESKTOP_INSTALLER_START_CORE: &str = "0";

/// The canonical installers are compiled into the signed Desktop bundle.
///
/// Fetching `main/install.{sh,ps1}` and executing it made a mutable branch an
/// unsigned remote-code path. `include_bytes!` pins the exact reviewed script to
/// this build; the normal Tauri updater signature authenticates the bundle that
/// carries it. Headless users still download the public mirror, while Desktop
/// executes only the copy shipped with itself.
pub(super) fn bundled_install_script() -> &'static [u8] {
    if cfg!(windows) {
        include_bytes!("../../../../../../mirror/overlay/install.ps1")
    } else {
        include_bytes!("../../../../../../mirror/overlay/install.sh")
    }
}

/// The Ryu-owned scratch folder the installer script runs from:
/// `<data dir>/tmp/desktop-installer`. Never the shared system temp directory,
/// where any process the user runs can plant files beside what Ryu executes.
pub(super) fn installer_scratch_dir() -> std::path::PathBuf {
    ryu_sidecar_runtime::layout::tmp_dir_for(&crate::profile::ryu_home_dir(), "desktop-installer")
}

/// Write `script` to a fresh, uniquely named file inside `directory` and return
/// a guard that removes it on drop. On Windows the file gets a UTF-8 BOM and a
/// `.ps1` suffix: Windows PowerShell 5 otherwise reads the script in the ANSI
/// code page, and PowerShell 7 accepts the BOM without changing semantics.
pub(super) fn write_installer_script(
    directory: &std::path::Path,
    script: &[u8],
    windows: bool,
) -> Result<tempfile::TempPath, String> {
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("create installer scratch folder: {error}"))?;
    let suffix = if windows { ".ps1" } else { ".sh" };
    let mut script_file = tempfile::Builder::new()
        .prefix("ryu-installer-")
        .suffix(suffix)
        .tempfile_in(directory)
        .map_err(|e| format!("create installer script: {e}"))?;
    if windows {
        script_file
            .write_all(&[0xef, 0xbb, 0xbf])
            .map_err(|error| format!("write installer encoding marker: {error}"))?;
    }
    script_file
        .write_all(script)
        .map_err(|e| format!("write installer script: {e}"))?;
    script_file
        .as_file()
        .sync_all()
        .map_err(|e| format!("sync installer script: {e}"))?;
    // Close the write handle before PowerShell/sh opens it, while retaining a
    // TempPath guard that removes the file on every return path.
    Ok(script_file.into_temp_path())
}

/// Forward one machine-readable line from the canonical one-line installer to
/// the webview. Human output remains in the child process log; only the stable
/// `RYU_INSTALL_EVENT:` envelope crosses the Tauri boundary.
pub(super) fn forward_installer_event(app: &AppHandle, line: &str) {
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
/// inside this signed bundle. A private file in Ryu's own scratch folder (see
/// [`installer_scratch_dir`]) lets the shell process be supervised and its stdout streamed without introducing a mutable network
/// script. The installer owns Core, Gateway, and CLI installation; Desktop starts
/// Core itself afterwards so it retains the child handle and owns shutdown.
pub(super) async fn run_unified_installer(
    app: &AppHandle,
    install_dir: &std::path::Path,
    expected: &str,
) -> Result<(), String> {
    let script_path = write_installer_script(
        &installer_scratch_dir(),
        bundled_install_script(),
        cfg!(windows),
    )?;

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
