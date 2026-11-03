//! Install and launch Ryu Island, the Electron companion overlay.

use std::path::PathBuf;

use tauri::AppHandle;

use super::binaries::app_version;

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
pub(super) fn island_dir() -> Option<PathBuf> {
    Some(ryu_sidecar_runtime::layout::bin_dir(&crate::profile::ryu_home_dir()).join("island"))
}

/// The installed Island launch target under `<data dir>/bin/island/`:
///   - Windows: `ryu-island.exe` (the renamed portable single-exe)
///   - Linux:   `ryu-island.AppImage`
///   - macOS:   `Ryu Island.app` (a bundle *directory*, launched via `open`)
pub(super) fn island_install_path() -> Option<PathBuf> {
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
pub(super) fn island_version_marker() -> Option<PathBuf> {
    island_dir().map(|d| d.join(".version"))
}

/// Whether the installed Island bundle was placed by the currently-running app
/// version. A missing/mismatched marker counts as stale (re-download once).
pub(super) fn island_version_matches(expected: &str) -> bool {
    island_version_marker()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|v| v.trim() == expected)
        .unwrap_or(false)
}

/// Whether Island is installed AND matches the running app version. A bundle left by
/// an older app version is treated as absent so [`ensure_island_installed`] re-fetches
/// it. Unlike the sidecars there is no env override — Island has no `RYU_*_BIN` hook.
pub(super) fn is_island_installed(expected: &str) -> bool {
    match island_install_path() {
        Some(p) if p.exists() => island_version_matches(expected),
        _ => false,
    }
}

/// Ask the local Core to install Island through its global DownloadCenter. The
/// response waits for extraction so this function never reports a path before the
/// bundle is launchable. Current Desktop/Core releases always take this path.
pub(super) async fn ensure_island_via_core(expected: &str) -> Result<PathBuf, String> {
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
