mod app_icons;
mod app_update;
mod core;
mod hardware;
mod identifier_migration;
mod keep_awake;
mod midnight_wipe;
mod nodes;
mod permissions;
mod profile;
mod quick_capture;
mod secrets;
mod shadow_auth;
mod standalone;
mod startup;
mod tray;
mod update_schedule;
mod win_process;
mod window_registry;
use std::sync::Mutex;

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_decorum::WebviewWindowExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

use crate::core::process::RyuCoreProcess;

/// Restore the macOS native title-bar buttons for the transparent shell.
///
/// Our windows use `decorations: false` so Windows/Linux can draw decorum's
/// custom HTML window controls. On macOS, a borderless window otherwise has no
/// native controls, so re-add the titled style mask and hide the title bar's
/// title/background. The native traffic lights then remain the only macOS shell
/// layer; decorum is not loaded on this platform.
///
/// `ns_window` is the raw `NSWindow` pointer from `WebviewWindow::ns_window()`.

#[cfg(target_os = "macos")]
fn apply_macos_titlebar_mask(ns_window: *mut std::ffi::c_void) {
    use cocoa::appkit::{NSWindow, NSWindowStyleMask, NSWindowTitleVisibility};
    use cocoa::base::{id, YES};

    if ns_window.is_null() {
        return;
    }
    let ns_window = ns_window as id;
    // SAFETY: `ns_window` is the live `NSWindow` owned by this Tauri window, and
    // window-ready callbacks run on the main thread.
    unsafe {
        let mask = NSWindowStyleMask::NSTitledWindowMask
            | NSWindowStyleMask::NSClosableWindowMask
            | NSWindowStyleMask::NSMiniaturizableWindowMask
            | NSWindowStyleMask::NSResizableWindowMask
            | NSWindowStyleMask::NSFullSizeContentViewWindowMask;
        ns_window.setStyleMask_(mask);
        ns_window.setTitlebarAppearsTransparent_(YES);
        ns_window.setTitleVisibility_(NSWindowTitleVisibility::NSWindowTitleHidden);
    }
}

/// Tauri plugin that restores the native macOS title bar mask on every window
/// as soon as it is ready. See [`apply_macos_titlebar_mask`].
#[cfg(target_os = "macos")]
fn macos_titlebar_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("ryu-macos-titlebar")
        .on_window_ready(|win| {
            if let Ok(ns_window) = win.ns_window() {
                apply_macos_titlebar_mask(ns_window);
            }
        })
        .build()
}

struct CoreState {
    process: Mutex<Option<RyuCoreProcess>>,
}

/// Stop the managed `ryu-core` child, if one is running.
///
/// Exists because the tray's Quit is now the ONLY path that reliably ends the
/// app: with "stay in tray on close" on by default, closing the window no longer
/// destroys it, so the `WindowEvent::Destroyed` arm below — which used to be
/// where Core was stopped — does not run. A quit that left `ryu-core` alive would
/// leave it holding its port, which this repo has already paid for once (a stale
/// Core squatting 8980 with a pile of hung probes).
///
/// Idempotent: `try_stop` runs against an `Option` that the Destroyed arm may
/// also have taken, so calling both is safe.
pub(crate) fn stop_managed_core<R: tauri::Runtime, M: Manager<R>>(app: &M) {
    let state = app.state::<CoreState>();
    let mut guard = match state.process.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    if let Some(ref mut process) = *guard {
        if let Err(e) = process.try_stop() {
            tracing::error!("Failed to stop Ryu Core on quit: {}", e);
        }
    }
}

pub(crate) struct HttpClient(pub reqwest::Client);

fn resolve_core_binary() -> Option<std::path::PathBuf> {
    let bin_name = if cfg!(windows) {
        "ryu-core.exe"
    } else {
        "ryu-core"
    };

    // 1. Explicit env var override
    std::env::var("RYU_CORE_BIN")
        .ok()
        .map(std::path::PathBuf::from)
        .filter(|p| p.exists())
        // 2. ~/.ryu{profile}/bin (installed) — profile-aware so a dev app resolves its
        //    OWN binary under ~/.ryu-dev/bin, never the release app's ~/.ryu/bin exe.
        .or_else(|| Some(profile::ryu_home_dir().join("bin").join(bin_name)).filter(|p| p.exists()))
        // 3. PATH — but never another profile's installed binary. Installers put
        //    `~/.ryu/bin` AND `~/.ryu-dev/bin` on PATH, so a dev profile whose own
        //    `~/.ryu-dev/bin/ryu-core` is missing would otherwise fall through to the
        //    RELEASE exe here and silently run a Core of a different (usually older)
        //    build against the dev data dir — the exact leak step 2's comment forbids.
        //    Rejecting it here is only safe because `install::is_installed` rejects the
        //    same hit, so the missing binary is downloaded rather than left unresolved.
        .or_else(|| {
            let hit = which::which(bin_name.strip_suffix(".exe").unwrap_or(bin_name)).ok()?;
            if profile::is_foreign_profile_bin(&hit) {
                tracing::warn!(
                    "ignoring {} on PATH — it belongs to another Ryu profile, not {}",
                    hit.display(),
                    profile::name()
                );
                return None;
            }
            Some(hit)
        })
        // 4. Dev build: navigate from exe to workspace root
        .or_else(|| {
            if !cfg!(debug_assertions) {
                return None;
            }
            std::env::current_exe().ok().and_then(|exe| {
                // exe: <workspace>/apps/desktop/src-tauri/target/debug/<app>
                // go up 6 levels to reach workspace root
                let workspace = exe
                    .parent()? // debug/
                    .parent()? // target/
                    .parent()? // src-tauri/
                    .parent()? // desktop/
                    .parent()? // apps/
                    .parent()?; // workspace root
                let core = workspace
                    .join("apps")
                    .join("core")
                    .join("target")
                    .join("debug")
                    .join(bin_name);
                Some(core).filter(|p| p.exists())
            })
        })
}

#[tauri::command]
async fn start_ryu_core(state: tauri::State<'_, CoreState>) -> Result<String, String> {
    // Check if we already have a running process we own
    {
        let mut guard = state.process.lock().map_err(|e| e.to_string())?;
        if let Some(ref mut process) = *guard {
            if process.is_running() {
                return Ok("already running".to_string());
            }
        }
    }

    // In dev builds, ryu-core is normally owned by the `core#dev` turbo task
    // (`cargo run`). Spawning a second copy would lock the binary and block
    // recompilation — so when Core is healthy we just report "connecting" and
    // let the frontend health-poll. But after a node reset Core exits itself
    // (and turbo's cargo run dies with it), so when health is down we MUST
    // spawn for recovery or reset would leave the node permanently stopped.
    #[cfg(debug_assertions)]
    if !standalone::enabled() {
        let probe = RyuCoreProcess::new(std::path::PathBuf::from("ryu-core"));
        if probe.is_already_running().await {
            return Ok("connecting".to_string());
        }
        tracing::warn!(
            "dev: Core is down — spawning for recovery (turbo may have exited after a reset)"
        );
    }

    let binary = match resolve_core_binary() {
        Some(p) => p,
        None => return Err("Could not find ryu-core binary. Install it to ~/.ryu/bin/ or set RYU_CORE_BIN env var.".to_string()),
    };

    // Create new process manager
    let mut process = RyuCoreProcess::new(binary);

    // Start the process (will connect to existing instance if already running)
    match process.start().await {
        Ok(()) => {
            // Check if we connected to an existing instance
            let message = if process.has_child() {
                "started".to_string()
            } else {
                "already running".to_string()
            };

            // Store the process in state
            let mut guard = state.process.lock().map_err(|e| e.to_string())?;
            *guard = Some(process);

            Ok(message)
        }
        Err(e) => Err(format!("Failed to start Ryu Core: {}", e)),
    }
}

/// Ensure the `ryu-core` binary is installed, downloading it from the release hub
/// if missing. Returns the binary path. A no-op in dev (turbo owns the binary).
#[tauri::command]
async fn ensure_core_installed(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        return Ok("dev".to_string());
    }
    #[cfg(not(debug_assertions))]
    {
        // The public one-line installer is the single binary/bootstrap path for
        // Desktop as well as headless users. It installs Core, Gateway, and CLI,
        // starts Core, and tells Core to begin its bundled defaults. Desktop then
        // keeps ownership of agent detection and the preferences below this step.
        let p = crate::core::install::ensure_unified_installed(&app).await?;
        Ok(p.to_string_lossy().to_string())
    }
}

/// Ensure the Island Electron companion is installed under `~/.ryu/island/`, then
/// launch it, returning the launched bundle path. Dev is a no-op (`"dev"`): turbo
/// owns Island in development (`bun run dev` starts electron-vite), so downloading a
/// release build would fight it — same `debug_assertions` gate as
/// [`ensure_core_installed`]. Invoked from the node selector's Island row ("Install /
/// Launch" when the local island isn't reachable) and from onboarding.
#[tauri::command]
async fn install_and_launch_island(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        return Ok("dev".to_string());
    }
    #[cfg(not(debug_assertions))]
    {
        let path = crate::core::install::ensure_island_installed(&app).await?;
        crate::core::install::launch_island()?;
        Ok(path.to_string_lossy().to_string())
    }
}

#[tauri::command]
async fn get_ryu_status() -> String {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    match client
        .get(format!("{}/api/health", profile::core_base_url()))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => "running".to_string(),
        _ => "stopped".to_string(),
    }
}

// ── Safe Mode sentinel (`~/.ryu<suffix>/safe-mode`) ──────────────────────────
//
// Core owns Safe Mode and normally the desktop drives it over `PUT /api/safe-mode`.
// These two commands exist for the case that motivates the feature: a Core that
// will not come up. HTTP is unavailable exactly then, and reading the flag out of
// `preferences.db` is circular when the boot path or the store is what is wedged —
// so the sentinel FILE is the tier that always works, and the desktop must be able
// to write it without Core's help.
//
// Profile-aware via `profile::ryu_home_dir`, so arming safe mode from a dev build
// never reaches into the release node's `~/.ryu`.

fn safe_mode_sentinel_path() -> std::path::PathBuf {
    profile::ryu_home_dir().join("safe-mode")
}

/// Whether the next Core boot will enter Safe Mode because of the sentinel.
///
/// Only the sentinel tier — `RYU_SAFE_MODE` and the stored preference are Core's to
/// resolve, and Core reports the effective answer over `GET /api/safe-mode`.
#[tauri::command]
async fn get_safe_mode_sentinel() -> bool {
    safe_mode_sentinel_path().exists()
}

/// Arm or clear the sentinel. Returns the resulting state.
///
/// Does NOT restart Core: the caller decides when (the preflight page already owns
/// that button), and a command that restarted as a side effect would be impossible
/// to use from a crash screen where the process is already down.
#[tauri::command]
async fn set_safe_mode_sentinel(enabled: bool) -> Result<bool, String> {
    let path = safe_mode_sentinel_path();
    if enabled {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(
			&path,
			b"safe mode: this node boots with apps, plugins, skills and user MCP servers disabled. Delete this file to boot normally.\n",
		)
		.map_err(|e| e.to_string())?;
    } else if let Err(e) = std::fs::remove_file(&path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            return Err(e.to_string());
        }
    }
    Ok(enabled)
}

#[tauri::command]
async fn stop_ryu_core(state: tauri::State<'_, CoreState>) -> Result<(), String> {
    // Extract the process from the state to avoid holding lock across await
    let process = {
        let mut guard = state.process.lock().map_err(|e| e.to_string())?;
        guard.take()
    };

    // Always run stop — even without an owned child handle it kills via PID file
    // and by profile port, which is what makes reset work against turbo-owned Core.
    let mut process =
        process.unwrap_or_else(|| RyuCoreProcess::new(std::path::PathBuf::from("ryu-core")));
    process
        .stop()
        .await
        .map_err(|e| format!("Failed to stop Ryu Core: {}", e))?;

    Ok(())
}

#[tauri::command]
fn get_ryu_core_url() -> String {
    profile::core_localhost_url()
}

/// Build/runtime profile for the frontend badge. `dev = true` when this is the
/// dev variant (RYU_PROFILE=dev or the `dev-variant` build), so the sidebar can
/// show a "Dev" badge. Release builds return `false`.
///
/// `dev` is the DEV VARIANT specifically, not `profile::is_dev()` ("any
/// non-release profile"). Since a canary/nightly bundle activates its own profile
/// from its version, `is_dev()` is true there too — and the frontend uses this
/// flag to label the native window as a dev build, which a canary build is not.
/// `profile` carries the actual profile for anything that wants it.
#[derive(serde::Serialize)]
struct BuildProfile {
    dev: bool,
    profile: String,
}

#[tauri::command]
fn get_build_profile() -> BuildProfile {
    let profile = profile::name();
    BuildProfile {
        dev: profile == "dev",
        profile,
    }
}

// ── Data folder relocation / import (offline, runs while Core is stopped) ─────────

/// Stop the Core we manage, then wait until its HTTP server is actually down.
/// Refuses (rather than copying a live database) if Core stays up — this covers
/// dev, where Core is owned by the `core#dev` turbo task and we can't stop it.
async fn stop_core_and_wait(state: &tauri::State<'_, CoreState>) -> Result<(), String> {
    let process = {
        let mut guard = state.process.lock().map_err(|e| e.to_string())?;
        guard.take()
    };
    if let Some(mut process) = process {
        process.stop().await.map_err(|e| e.to_string())?;
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1))
        .build()
        .map_err(|e| e.to_string())?;
    for _ in 0..8 {
        let up = client
            .get(format!("{}/api/health", profile::core_base_url()))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        if !up {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    Err("Ryu Core is still running and could not be stopped. In dev, stop the core dev task before relocating the data folder.".to_string())
}

/// Run `ryu-core data-path …`, forwarding `@@PROGRESS {json}` lines to the
/// `data-folder-progress` frontend event. Returns the subcommand's stderr on
/// failure.
async fn run_data_path_subcommand(
    app: &tauri::AppHandle,
    binary: &std::path::Path,
    args: &[String],
) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::process::Command;

    use crate::win_process::NoWindow;

    let mut child = Command::new(binary)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .no_window()
        .spawn()
        .map_err(|e| format!("failed to launch ryu-core: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ryu-core stdout was not captured".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "ryu-core stderr was not captured".to_string())?;
    let progress_app = app.clone();
    let read_stdout = async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(rest) = line.strip_prefix("@@PROGRESS ") {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(rest) {
                    let _ = progress_app.emit("data-folder-progress", value);
                }
            }
        }
        Ok::<(), String>(())
    };
    let read_stderr = async move {
        let mut err = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
            err.push_str(&line);
            err.push('\n');
        }
        Ok::<String, String>(err)
    };
    let (stdout_result, stderr_result, status_result) =
        tokio::join!(read_stdout, read_stderr, child.wait());
    stdout_result?;
    let err = stderr_result?;
    let status = status_result.map_err(|e| e.to_string())?;
    if status.success() {
        return Ok(());
    }
    Err(if err.trim().is_empty() {
        format!("ryu-core exited with {status}")
    } else {
        err.trim().to_string()
    })
}

/// Remove the auxiliary roots a node reset never reaches — `~/.shadow`,
/// `~/.ghost`, and the OS config dir holding `gateway.toml` + the data-path
/// pointer.
///
/// Separate from `reset_data_path` because two of those are NOT profile-scoped:
/// shadow and ghost use a plain `~/.shadow` / `~/.ghost` for every profile, so
/// clearing them from one profile clears them for all. The confirm copy says so.
///
/// Stops Core first, and does not restart: the data dir is untouched, so there is
/// nothing for the running node to re-resolve.
#[tauri::command]
async fn deep_clean_node(
    app: tauri::AppHandle,
    state: tauri::State<'_, CoreState>,
    profile: Option<String>,
    depth: Option<String>,
    shared: Option<bool>,
) -> Result<(), String> {
    let binary =
        resolve_core_binary().ok_or_else(|| "Could not find ryu-core binary.".to_string())?;
    stop_core_and_wait(&state).await?;
    let mut args = vec!["data-path".to_string(), "deep-clean".to_string()];
    // Passed EXPLICITLY rather than letting the child infer the profile from its
    // inherited env — the same trap `copy_data_folder_to_profile` avoids. A user
    // cleaning `canary` from a release app must not have the child resolve
    // `release` because that is what RYU_PROFILE happened to say.
    args.push("--profile".to_string());
    args.push(profile.unwrap_or_else(crate::profile::name));
    args.push("--depth".to_string());
    args.push(depth.unwrap_or_else(|| "none".to_string()));
    // Shared roots default to INCLUDED, matching the previous behaviour; an
    // explicit false opts out.
    if shared == Some(false) {
        args.push("--no-shared".to_string());
    }
    run_data_path_subcommand(&app, &binary, &args).await
}

/// Copy THIS profile's data folder into another profile's, carrying the master
/// key, so a canary (or any) profile can be tested against real state instead of
/// one rebuilt by hand.
///
/// Deliberately does NOT restart: neither profile's pointer file is touched, so
/// the running app's own data dir is unchanged and there is nothing to re-resolve.
/// The target profile picks the copy up the next time it starts.
///
/// `--from-profile` is passed EXPLICITLY rather than letting the child infer it.
/// `run_data_path_subcommand` spawns with inherited env only, so a child would
/// otherwise resolve whatever `RYU_PROFILE` this process happens to carry — which
/// is right by luck today and wrong the moment a dev build drives the copy.
#[tauri::command]
async fn copy_data_folder_to_profile(
    app: tauri::AppHandle,
    state: tauri::State<'_, CoreState>,
    to_profile: String,
) -> Result<(), String> {
    let binary =
        resolve_core_binary().ok_or_else(|| "Could not find ryu-core binary.".to_string())?;
    // WAL is on for every store, so a live copy captures a torn snapshot.
    stop_core_and_wait(&state).await?;
    let args = vec![
        "data-path".to_string(),
        "copy-profile".to_string(),
        "--from-profile".to_string(),
        crate::profile::name(),
        "--to-profile".to_string(),
        to_profile,
    ];
    run_data_path_subcommand(&app, &binary, &args).await
}

/// Copy-relocate the data folder to `to`, then restart the app to apply.
#[tauri::command]
async fn migrate_data_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, CoreState>,
    to: String,
    move_source: bool,
) -> Result<(), String> {
    let binary =
        resolve_core_binary().ok_or_else(|| "Could not find ryu-core binary.".to_string())?;
    stop_core_and_wait(&state).await?;
    let mut args = vec![
        "data-path".to_string(),
        "migrate".to_string(),
        "--to".to_string(),
        to,
    ];
    if move_source {
        args.push("--move".to_string());
    }
    run_data_path_subcommand(&app, &binary, &args).await?;
    app.restart();
}

/// Restore the data folder from a backup zip, then restart the app to apply.
#[tauri::command]
async fn import_data_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, CoreState>,
    archive: String,
    to: Option<String>,
) -> Result<(), String> {
    let binary =
        resolve_core_binary().ok_or_else(|| "Could not find ryu-core binary.".to_string())?;
    stop_core_and_wait(&state).await?;
    let mut args = vec![
        "data-path".to_string(),
        "import".to_string(),
        "--archive".to_string(),
        archive,
    ];
    if let Some(to) = to {
        args.push("--to".to_string());
        args.push(to);
    }
    run_data_path_subcommand(&app, &binary, &args).await?;
    app.restart();
}

/// Open a URL with the OS default handler. Only web/mail schemes are allowed:
/// callers pass backend-supplied URLs, and a hand-rolled command bypasses the
/// shell plugin's scope validation, so a `file://`/`smb://` URL from a spoofed
/// backend must never reach the opener.
#[tauri::command]
async fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err(format!(
            "Refusing to open URL with disallowed scheme '{}'.",
            parsed.scheme()
        ));
    }
    app.shell().open(&url, None).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkMetadataPreview {
    description: Option<String>,
    image: Option<String>,
    site_name: Option<String>,
    title: Option<String>,
    url: String,
}

fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            let octets = ip.octets();
            let is_shared_carrier_space = octets[0] == 100 && (64..=127).contains(&octets[1]);
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_unspecified()
                || is_shared_carrier_space)
        }
        std::net::IpAddr::V6(ip) => {
            if let Some(ipv4) = ip.to_ipv4_mapped() {
                return is_public_ip(std::net::IpAddr::V4(ipv4));
            }
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_multicast())
        }
    }
}

async fn public_url_client(url: &reqwest::Url) -> Result<reqwest::Client, String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only http and https links can be previewed.".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Link has no host.".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Link has no usable port.".to_string())?;
    let addresses: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("Could not resolve link host: {e}"))?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|addr| !is_public_ip(addr.ip())) {
        return Err("Private and local network links are not previewed.".to_string());
    }
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("Ryu-Link-Preview/1.0");
    if host.parse::<std::net::IpAddr>().is_err() {
        builder = builder.resolve(host, addresses[0]);
    }
    builder.build().map_err(|e| e.to_string())
}

async fn fetch_public_bytes(
    mut url: reqwest::Url,
    max_bytes: usize,
) -> Result<(reqwest::Url, reqwest::header::HeaderMap, Vec<u8>), String> {
    for _ in 0..4 {
        let client = public_url_client(&url).await?;
        let mut response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "Preview redirect had no location.".to_string())?;
            url = url.join(location).map_err(|e| e.to_string())?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("Preview request failed: {}", response.status()));
        }
        let headers = response.headers().clone();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > max_bytes {
                return Err("Preview response was too large.".to_string());
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok((url, headers, bytes));
    }
    Err("Preview followed too many redirects.".to_string())
}

fn html_attribute(tag: &str, name: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let needle = format!("{name}={quote}");
        let Some(start_offset) = tag.find(&needle) else {
            continue;
        };
        let start = start_offset + needle.len();
        let Some(end_offset) = tag[start..].find(quote) else {
            continue;
        };
        let end = end_offset + start;
        return Some(tag[start..end].trim().to_string());
    }
    None
}

fn metadata_content(html: &str, keys: &[&str]) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(offset) = lower[cursor..].find("<meta") {
        let start = cursor + offset;
        let Some(relative_end) = lower[start..].find('>') else {
            break;
        };
        let end = start + relative_end + 1;
        let tag = &html[start..end];
        let tag_lower = &lower[start..end];
        let property =
            html_attribute(tag_lower, "property").or_else(|| html_attribute(tag_lower, "name"));
        if property
            .as_deref()
            .is_some_and(|value| keys.iter().any(|key| value == *key))
        {
            return html_attribute(tag, "content");
        }
        cursor = end;
    }
    None
}

fn html_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title>")? + "<title>".len();
    let end = lower[start..].find("</title>")? + start;
    Some(html[start..end].trim().to_string()).filter(|value| !value.is_empty())
}

async fn preview_image_data_url(page_url: &reqwest::Url, raw: &str) -> Option<String> {
    use base64::Engine;
    let url = page_url.join(raw).ok()?;
    let (_, headers, bytes) = fetch_public_bytes(url, 2 * 1024 * 1024).await.ok()?;
    let content_type = headers
        .get(reqwest::header::CONTENT_TYPE)?
        .to_str()
        .ok()?
        .split(';')
        .next()?
        .trim();
    if !content_type.starts_with("image/") {
        return None;
    }
    Some(format!(
        "data:{content_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Fetch Open Graph metadata for a hover preview. The shell performs the request
/// because the webview is CORS-bound; every hop is pinned to a public DNS result.
#[tauri::command]
async fn preview_link_metadata(url: String) -> Result<LinkMetadataPreview, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    let (final_url, headers, bytes) = fetch_public_bytes(parsed, 512 * 1024).await?;
    let content_type = headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !content_type.contains("text/html") {
        return Ok(LinkMetadataPreview {
            description: None,
            image: None,
            site_name: None,
            title: None,
            url: final_url.to_string(),
        });
    }
    let html = String::from_utf8_lossy(&bytes);
    let image_raw = metadata_content(&html, &["og:image", "twitter:image"]);
    let image = match image_raw {
        Some(raw) => preview_image_data_url(&final_url, &raw).await,
        None => None,
    };
    Ok(LinkMetadataPreview {
        description: metadata_content(
            &html,
            &["og:description", "twitter:description", "description"],
        ),
        image,
        site_name: metadata_content(&html, &["og:site_name"]),
        title: metadata_content(&html, &["og:title", "twitter:title"])
            .or_else(|| html_title(&html)),
        url: final_url.to_string(),
    })
}

fn command_exists(command: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| {
        let candidate = dir.join(command);
        if candidate.is_file() {
            return true;
        }
        #[cfg(windows)]
        {
            let candidate = dir.join(format!("{command}.exe"));
            if candidate.is_file() {
                return true;
            }
        }
        false
    })
}

#[cfg(target_os = "macos")]
fn mac_app_exists(name: &str) -> bool {
    [
        format!("/Applications/{name}.app"),
        format!("/System/Applications/{name}.app"),
        format!("/System/Applications/Utilities/{name}.app"),
    ]
    .iter()
    .any(|path| std::path::Path::new(path).exists())
}

fn editor_is_available(editor: &str) -> bool {
    match editor {
        "vscode" => {
            command_exists("code") || {
                #[cfg(target_os = "macos")]
                {
                    mac_app_exists("Visual Studio Code")
                }
                #[cfg(not(target_os = "macos"))]
                {
                    false
                }
            }
        }
        "zed" => {
            command_exists("zed") || {
                #[cfg(target_os = "macos")]
                {
                    mac_app_exists("Zed")
                }
                #[cfg(not(target_os = "macos"))]
                {
                    false
                }
            }
        }
        "cursor" => {
            command_exists("cursor") || {
                #[cfg(target_os = "macos")]
                {
                    mac_app_exists("Cursor")
                }
                #[cfg(not(target_os = "macos"))]
                {
                    false
                }
            }
        }
        "terminal" => {
            if cfg!(windows) {
                command_exists("wt") || command_exists("cmd")
            } else if cfg!(target_os = "macos") {
                true
            } else {
                command_exists("x-terminal-emulator")
            }
        }
        "gitbash" => {
            if cfg!(windows) {
                std::path::Path::new("C:\\Program Files\\Git\\bin\\bash.exe").exists()
                    || command_exists("bash")
            } else {
                command_exists("bash")
            }
        }
        "powershell" => cfg!(windows) && (command_exists("powershell") || command_exists("pwsh")),
        "cmd" => cfg!(windows) && command_exists("cmd"),
        "explorer" | "finder" => true,
        _ => false,
    }
}

#[derive(serde::Serialize)]
struct EditorAvailability {
    id: String,
    available: bool,
}

#[tauri::command]
async fn get_editor_availability(editors: Vec<String>) -> Result<Vec<EditorAvailability>, String> {
    Ok(editors
        .into_iter()
        .map(|id| {
            let available = editor_is_available(&id);
            EditorAvailability { id, available }
        })
        .collect())
}

/// Open a project folder in an external editor or file manager.
/// `editor` is one of: vscode, zed, cursor, terminal, gitbash, explorer/finder.
/// `path` defaults to "." when omitted.
#[tauri::command]
async fn open_in_editor(
    app: tauri::AppHandle,
    editor: String,
    path: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let raw_path = path.as_deref().unwrap_or(".");

    // Reject flag-like paths (argument injection) and URL-scheme paths (e.g. javascript:, file://).
    if raw_path.starts_with('-') {
        return Err("Invalid path: must not start with '-'".to_string());
    }
    if raw_path.contains("://") {
        return Err("Invalid path: URL schemes are not allowed".to_string());
    }

    // Canonicalize so symlinks and `..` traversal are resolved to an absolute path.
    // Fall back to the raw value only for paths that don't exist yet (e.g. ".").
    let owned;
    let path = match std::fs::canonicalize(raw_path) {
        Ok(p) => {
            owned = p.to_string_lossy().into_owned();
            owned.as_str()
        }
        Err(_) => raw_path,
    };

    let result = match editor.as_str() {
        // `--` terminates option parsing for editors that support it (code, zed, cursor).
        "vscode" => app
            .shell()
            .command("code")
            .args(["--", path])
            .spawn()
            .or_else(|_| {
                if cfg!(target_os = "macos") {
                    app.shell()
                        .command("open")
                        .args(["-a", "Visual Studio Code", path])
                        .spawn()
                } else {
                    app.shell().command("code").args(["--", path]).spawn()
                }
            }),
        "zed" => app
            .shell()
            .command("zed")
            .args(["--", path])
            .spawn()
            .or_else(|_| {
                if cfg!(target_os = "macos") {
                    app.shell()
                        .command("open")
                        .args(["-a", "Zed", path])
                        .spawn()
                } else {
                    app.shell().command("zed").args(["--", path]).spawn()
                }
            }),
        "cursor" => app
            .shell()
            .command("cursor")
            .args(["--", path])
            .spawn()
            .or_else(|_| {
                if cfg!(target_os = "macos") {
                    app.shell()
                        .command("open")
                        .args(["-a", "Cursor", path])
                        .spawn()
                } else {
                    app.shell().command("cursor").args(["--", path]).spawn()
                }
            }),
        "terminal" => {
            if cfg!(windows) {
                app.shell()
                    .command("wt")
                    .args(["-d", path])
                    .spawn()
                    .or_else(|_| {
                        app.shell()
                            .command("cmd")
                            .args(["/c", "start", "cmd"])
                            .spawn()
                    })
            } else if cfg!(target_os = "macos") {
                app.shell()
                    .command("open")
                    .args(["-a", "Terminal", path])
                    .spawn()
            } else {
                app.shell().command("x-terminal-emulator").spawn()
            }
        }
        "gitbash" => {
            if cfg!(windows) {
                app.shell()
                    .command("C:\\Program Files\\Git\\bin\\bash.exe")
                    .args(["--login", "-i"])
                    .spawn()
                    .or_else(|_| app.shell().command("bash").args(["--login", "-i"]).spawn())
            } else {
                app.shell().command("bash").args(["--login"]).spawn()
            }
        }
        // New console windows must be launched via `start`; a bare `cmd`/`powershell`
        // spawned by Tauri has no attached console. The new window inherits the parent
        // working directory, so set it via `current_dir` rather than embedding the path
        // in the command string (avoids quoting/space/injection issues).
        "powershell" => {
            if cfg!(windows) {
                app.shell()
                    .command("cmd")
                    .args(["/c", "start", "powershell"])
                    .current_dir(path)
                    .spawn()
            } else {
                return Err("PowerShell launcher is only available on Windows".to_string());
            }
        }
        "cmd" => {
            if cfg!(windows) {
                app.shell()
                    .command("cmd")
                    .args(["/c", "start", "cmd"])
                    .current_dir(path)
                    .spawn()
            } else {
                return Err("Command Prompt is only available on Windows".to_string());
            }
        }
        "explorer" | "finder" => {
            if cfg!(windows) {
                app.shell().command("explorer").args([path]).spawn()
            } else if cfg!(target_os = "macos") {
                app.shell().command("open").args([path]).spawn()
            } else {
                app.shell().command("xdg-open").args([path]).spawn()
            }
        }
        _ => return Err(format!("Unknown editor: {editor}")),
    };

    result.map(|_| ()).map_err(|e| e.to_string())
}

/// Resolve a file-tree item beneath its workspace root. Both paths must already
/// exist: canonicalization is what closes symlink and `..` traversal escapes.
fn resolve_workspace_item_path(
    workspace_root: &std::path::Path,
    relative_path: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    if relative_path.is_absolute() {
        return Err("Workspace item path must be relative".to_string());
    }

    let canonical_root = std::fs::canonicalize(workspace_root)
        .map_err(|e| format!("Invalid workspace root: {e}"))?;
    let canonical_item = std::fs::canonicalize(canonical_root.join(relative_path))
        .map_err(|e| format!("Workspace item not found: {e}"))?;
    if !canonical_item.starts_with(&canonical_root) {
        return Err("Workspace item escapes the project folder".to_string());
    }
    Ok(canonical_item)
}

fn launch_default_app(app: &tauri::AppHandle, path: &std::path::Path) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;

    let path = path.to_string_lossy().into_owned();
    let result = if cfg!(windows) {
        app.shell().command("explorer").args([path]).spawn()
    } else if cfg!(target_os = "macos") {
        app.shell().command("open").args([path]).spawn()
    } else {
        app.shell().command("xdg-open").args([path]).spawn()
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}

/// Open an existing file-tree item in its OS-default app or a detected editor.
/// Shell-like targets receive the containing directory when the item is a file.
#[tauri::command]
async fn open_workspace_item(
    app: tauri::AppHandle,
    root: String,
    path: String,
    editor: Option<String>,
) -> Result<(), String> {
    let item =
        resolve_workspace_item_path(std::path::Path::new(&root), std::path::Path::new(&path))?;
    let Some(editor) = editor else {
        return launch_default_app(&app, &item);
    };

    let is_shell = matches!(
        editor.as_str(),
        "terminal" | "gitbash" | "powershell" | "cmd"
    );
    let target = if is_shell && item.is_file() {
        item.parent().unwrap_or(&item)
    } else {
        &item
    };
    open_in_editor(app, editor, Some(target.to_string_lossy().into_owned())).await
}

/// Reveal an existing file-tree item in the platform file manager.
#[tauri::command]
async fn reveal_workspace_item(
    app: tauri::AppHandle,
    root: String,
    path: String,
) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;

    let item =
        resolve_workspace_item_path(std::path::Path::new(&root), std::path::Path::new(&path))?;
    let item_string = item.to_string_lossy().into_owned();
    let result = if cfg!(windows) {
        app.shell()
            .command("explorer")
            .args([format!("/select,{item_string}")])
            .spawn()
    } else if cfg!(target_os = "macos") {
        app.shell()
            .command("open")
            .args(["-R".to_string(), item_string])
            .spawn()
    } else {
        let target = if item.is_dir() {
            &item
        } else {
            item.parent().unwrap_or(&item)
        };
        app.shell()
            .command("xdg-open")
            .args([target.to_string_lossy().into_owned()])
            .spawn()
    };
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod workspace_item_path_tests {
    use super::resolve_workspace_item_path;

    fn test_root(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("ryu-{name}-{}", std::process::id()))
    }

    #[test]
    fn resolves_an_existing_item_beneath_the_workspace() {
        let root = test_root("workspace-item-inside");
        let nested = root.join("src");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("main.rs"), "fn main() {}\n").unwrap();

        let resolved =
            resolve_workspace_item_path(&root, std::path::Path::new("src/main.rs")).unwrap();

        assert_eq!(
            resolved,
            std::fs::canonicalize(nested.join("main.rs")).unwrap()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_parent_traversal_outside_the_workspace() {
        let container = test_root("workspace-item-escape");
        let root = container.join("project");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(container.join("outside.txt"), "outside\n").unwrap();

        let error =
            resolve_workspace_item_path(&root, std::path::Path::new("../outside.txt")).unwrap_err();

        assert_eq!(error, "Workspace item escapes the project folder");
        std::fs::remove_dir_all(container).unwrap();
    }
}

#[derive(serde::Serialize)]
struct ShellOutput {
    stdout: String,
    stderr: String,
    code: i32,
}

/// Execute a shell command and return its stdout/stderr/exit code.
/// Used by the embedded terminal panel in the desktop UI.
///
/// SECURITY: This is an intentional full-shell exec primitive — a terminal emulator
/// requires shell semantics (pipes, redirects, compound commands). Mitigations in place:
/// 1. cwd is canonicalized to a real existing directory before use.
/// 2. The iframe panels that load external URLs run with `sandbox="allow-scripts
///    allow-forms allow-popups"` (no `allow-same-origin`), so iframe scripts cannot
///    reach `window.parent.__TAURI__` and call this command across the iframe boundary.
/// 3. Tauri's webview does not navigate to external URLs; the renderer is trusted
///    local content only.
/// Resolve a caller-requested shell name to a concrete (binary, command-flag)
/// pair through a FIXED ALLOWLIST. The caller's string is NEVER passed through
/// as the binary directly — that would be arbitrary-binary execution. Any
/// unrecognized, empty, or absent value falls back to the OS default, so a
/// garbage value can never spawn something outside this list.
fn default_shell() -> (&'static str, &'static str) {
    if cfg!(windows) {
        return ("powershell", "-Command");
    }

    // `$SHELL` is the user's login-shell choice on Unix. Only accept the same
    // fixed names exposed by the settings UI; an arbitrary environment path must
    // never become an executable here.
    let configured = std::env::var_os("SHELL").and_then(|value| {
        std::path::Path::new(&value)
            .file_name()
            .map(|name| name.to_owned())
    });
    match configured.as_deref().and_then(|name| name.to_str()) {
        Some("bash") => ("bash", "-c"),
        Some("zsh") => ("zsh", "-c"),
        Some("sh") => ("sh", "-c"),
        Some("fish") => ("fish", "-c"),
        _ if cfg!(target_os = "macos") => ("zsh", "-c"),
        _ => ("bash", "-c"),
    }
}

fn resolve_shell(requested: Option<&str>) -> (&'static str, &'static str) {
    match requested.map(str::trim).filter(|s| !s.is_empty()) {
        Some("bash") => ("bash", "-c"),
        Some("zsh") => ("zsh", "-c"),
        Some("sh") => ("sh", "-c"),
        Some("fish") => ("fish", "-c"),
        Some("powershell") => ("powershell", "-Command"),
        Some("pwsh") => ("pwsh", "-Command"),
        Some("cmd") => ("cmd", "/C"),
        // None or any unrecognized value → the OS default.
        _ => default_shell(),
    }
}

#[tauri::command]
async fn shell_execute(
    app: tauri::AppHandle,
    command: String,
    cwd: Option<String>,
    shell: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<ShellOutput, String> {
    use tauri_plugin_shell::ShellExt;

    let (shell, flag) = resolve_shell(shell.as_deref());

    // Canonicalize cwd: reject non-existent paths and resolve symlinks / `..` traversal.
    let resolved_cwd: Option<std::path::PathBuf> = if let Some(ref dir) = cwd {
        let canonical =
            std::fs::canonicalize(dir).map_err(|_| format!("Invalid working directory: {dir}"))?;
        if !canonical.is_dir() {
            return Err(format!("Working directory is not a directory: {dir}"));
        }
        Some(canonical)
    } else {
        None
    };

    let mut cmd = app.shell().command(shell).args([flag, command.as_str()]);
    if let Some(ref dir) = resolved_cwd {
        cmd = cmd.current_dir(dir);
    }
    if let Some(environment) = env {
        for (key, value) in environment {
            let mut chars = key.chars();
            let valid = chars
                .next()
                .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
                && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric());
            if !valid {
                return Err(format!("Invalid environment variable name: {key}"));
            }
            cmd = cmd.env(key, value);
        }
    }

    // The plugin's `output()` helper reads line-oriented events and appends a
    // newline to each event. That changes the bytes for commands such as
    // `git diff` and corrupts file contents that contain blank lines. Raw
    // events preserve stdout/stderr exactly while keeping the same async
    // process lifecycle.
    let (mut events, _child) = cmd.set_raw_out(true).spawn().map_err(|e| e.to_string())?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut code = 1;

    use tauri_plugin_shell::process::CommandEvent;
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => stdout.extend(bytes),
            CommandEvent::Stderr(bytes) => stderr.extend(bytes),
            CommandEvent::Terminated(payload) => {
                code = payload.code.unwrap_or(1);
            }
            CommandEvent::Error(message) => stderr.extend(message.into_bytes()),
            _ => {}
        }
    }

    Ok(ShellOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        code,
    })
}

/// Create the companion overlay window if it does not exist, then show it.
/// If it already exists and is visible, hide it (toggle behaviour).
fn toggle_companion_window(app: &tauri::AppHandle) {
    match app.get_webview_window("companion") {
        Some(win) => {
            let visible = win.is_visible().unwrap_or(false);
            if visible {
                win.hide().ok();
            } else {
                win.show().ok();
                win.set_focus().ok();
            }
        }
        None => {
            // Companion window URL: the React app detects the window label and renders
            // the overlay shell. In dev we load from the Vite dev server; in production
            // from the embedded dist bundle.
            let url = if cfg!(debug_assertions) {
                WebviewUrl::External(
                    "http://localhost:5173"
                        .parse()
                        .expect("companion dev URL is valid"),
                )
            } else {
                WebviewUrl::App("index.html".into())
            };

            // Center the companion horizontally on the primary monitor. Display
            // widths vary widely (MacBook panels are 1512/1728/1800 wide, not
            // 1920), so a hardcoded 1920 mis-centers the window on most Macs.
            // Monitor size is in physical pixels but `position` is logical, so
            // divide by the scale factor. Fall back to the 1920 assumption if the
            // monitor can't be queried, anchoring near top-center either way.
            const COMPANION_WIDTH: f64 = 400.0;
            let companion_x = app
                .primary_monitor()
                .ok()
                .flatten()
                .map(|monitor| {
                    let logical_width = monitor.size().width as f64 / monitor.scale_factor();
                    (logical_width - COMPANION_WIDTH) / 2.0
                })
                .unwrap_or((1920.0 - COMPANION_WIDTH) / 2.0);

            match WebviewWindowBuilder::new(app, "companion", url)
                .title("Ryu Companion")
                .inner_size(COMPANION_WIDTH, 80.0)
                .position(companion_x, 40.0)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .zoom_hotkeys_enabled(true)
                .build()
            {
                Ok(win) => {
                    win.show().ok();
                    win.set_focus().ok();
                }
                Err(e) => {
                    tracing::error!("Failed to create companion window: {}", e);
                }
            }
        }
    }
}

/// Open the live-media picture-in-picture surface as a real OS window.
///
/// Browser Picture-in-Picture is intentionally limited to video elements and is
/// not consistently available in embedded webviews. A Tauri window gives the
/// browser-tab screenshots and the VNC canvas the same always-on-top behaviour as
/// a recording, while the renderer keeps all three sources in one shared channel.
#[tauri::command]
fn open_media_pip(app: tauri::AppHandle) -> Result<(), String> {
    const LABEL: &str = "media-pip";

    if let Some(win) = app.get_webview_window(LABEL) {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = if cfg!(debug_assertions) {
        WebviewUrl::External(
            "http://localhost:5173/?window=media-pip"
                .parse()
                .map_err(|e| format!("bad media PiP URL: {e}"))?,
        )
    } else {
        WebviewUrl::App("index.html?window=media-pip".into())
    };

    let win = WebviewWindowBuilder::new(&app, LABEL, url)
        .title("Ryu Live Media")
        .inner_size(420.0, 280.0)
        .min_inner_size(280.0, 180.0)
        .center()
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .zoom_hotkeys_enabled(true)
        .build()
        .map_err(|e| e.to_string())?;

    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// Close the live-media picture-in-picture surface, if it is open.
#[tauri::command]
fn close_media_pip(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("media-pip") {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct AgentBrowserStreamStatus {
    connected: bool,
    enabled: bool,
    port: Option<u16>,
    screencasting: bool,
}

/// Read Agent Browser's session-scoped stream status. The CLI is the supported
/// control surface for the daemon; the renderer only receives the localhost
/// WebSocket frames after this fixed, read-only probe says a port is available.
#[tauri::command]
fn agent_browser_stream_status() -> Result<AgentBrowserStreamStatus, String> {
    let binary =
        which::which("agent-browser").map_err(|e| format!("agent-browser is unavailable: {e}"))?;
    let output = std::process::Command::new(binary)
        .args(["stream", "status", "--json"])
        .output()
        .map_err(|e| format!("couldn't query Agent Browser streaming: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let envelope: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Agent Browser returned invalid stream status: {e}"))?;
    let data = envelope
        .get("data")
        .ok_or_else(|| "Agent Browser stream status did not include data".to_string())?;
    Ok(AgentBrowserStreamStatus {
        connected: data
            .get("connected")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        enabled: data
            .get("enabled")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        port: data
            .get("port")
            .and_then(serde_json::Value::as_u64)
            .and_then(|port| u16::try_from(port).ok()),
        screencasting: data
            .get("screencasting")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}

/// Monotonic counter for tear-off window labels, unique for the lifetime of the
/// process. A new window per increment (`tab-1`, `tab-2`, …) — labels must be
/// unique and Tauri rejects reuse of a live one.
static TAB_WINDOW_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Percent-encode a query-param value (UTF-8 bytes → %XX for anything outside the
/// RFC 3986 unreserved set). Dependency-free; the renderer's `URLSearchParams`
/// decodes it back to the original UTF-8 string.
fn encode_param(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Open a tab in a separate OS window (browser-style "open in new window").
/// The new window loads the same app shell; the `window=tab` query seeds a single
/// tab focused on `conversation_id` and pinned to `node` (so a tab targeting a
/// remote node keeps targeting it). Conversation state is server-side, so the new
/// window simply re-fetches history by id. Closing this window never stops Core —
/// that is gated to the `main` window label in `on_window_event`.
#[tauri::command]
async fn open_tab_window(
    app: tauri::AppHandle,
    registry: tauri::State<'_, window_registry::WindowRegistry>,
    path: Option<String>,
    conversation_id: Option<String>,
    entity_key: Option<String>,
    node: Option<String>,
    title: Option<String>,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;

    let n = TAB_WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("tab-{n}");

    let mut params: Vec<String> = vec!["window=tab".to_string()];
    if let Some(ref p) = path {
        params.push(format!("path={}", encode_param(p)));
    }
    if let Some(ref c) = conversation_id {
        params.push(format!("conv={}", encode_param(c)));
    }
    if let Some(ref nd) = node {
        params.push(format!("node={}", encode_param(nd)));
    }
    if let Some(ref t) = title {
        params.push(format!("title={}", encode_param(t)));
    }
    let query = params.join("&");

    // Dev loads the Vite server (same origin as the main window, so the bearer
    // token in localStorage carries over); production loads the bundled shell.
    let url = if cfg!(debug_assertions) {
        let raw = format!("http://localhost:5173/?{query}");
        WebviewUrl::External(raw.parse().map_err(|e| format!("bad tab url: {e}"))?)
    } else {
        WebviewUrl::App(format!("index.html?{query}").into())
    };

    let win = WebviewWindowBuilder::new(&app, &label, url)
        .title(title.as_deref().unwrap_or("Ryu"))
        .inner_size(1100.0, 780.0)
        .min_inner_size(800.0, 600.0)
        .center()
        .decorations(false)
        .transparent(true)
        // Let the webview's own HTML5 drag-and-drop work (tab reordering in the
        // title bar) instead of Tauri intercepting it — mirrors the main window's
        // `dragDropEnabled: false` in tauri.conf.json.
        .disable_drag_drop_handler()
        .zoom_hotkeys_enabled(true)
        .build()
        .map_err(|e| e.to_string())?;

    // Mirror the main window's frameless overlay window controls on
    // Windows/Linux. macOS keeps its native traffic lights and does not need a
    // second injected titlebar layer.
    #[cfg(not(target_os = "macos"))]
    win.create_overlay_titlebar().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        // The titlebar plugin normally applies this on window-ready. Apply it
        // here too for freshly-created tear-off windows.
        if let Ok(ns_window) = win.ns_window() {
            apply_macos_titlebar_mask(ns_window);
        }
    }

    // Claim a seeded conversation before the renderer's first React effect. The
    // renderer replaces this revision-1 snapshot once it has mounted; this
    // shortens the duplicate-open race during a slow webview startup.
    if let Some(key) = entity_key.filter(|key| !key.is_empty()) {
        let seed_renderer_id = format!("native-seed:{label}");
        registry.register(
            &label,
            &seed_renderer_id,
            1,
            vec![window_registry::WindowTabRegistration { active: true, key }],
        )?;
    }

    // A newly-created WebviewWindow is not guaranteed to become the foreground
    // window on every platform, especially when the command was invoked from a
    // background tab renderer. Make the browser-style tear-off deterministic.
    win.show().map_err(|e| e.to_string())?;
    win.unminimize().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;

    Ok(())
}

/// Toggle the WebView inspector (DevTools). Used by the global right-click menu.
/// Requires the `devtools` feature on the `tauri` dependency (enabled for
/// packaged builds so Settings → Developer Mode can open the inspector).
#[tauri::command]
fn toggle_devtools(window: tauri::WebviewWindow) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

/// Toggle the calling window between OS fullscreen and windowed — the Electron
/// `setFullScreen` analogue behind the global right-click menu's View group.
///
/// A command rather than the JS `WebviewWindow.setFullscreen()` API because
/// `core:window:allow-set-fullscreen` is not in `capabilities/default.json`, and
/// every capability there scopes to a fixed window label (`main`, `companion`),
/// so the `tab-{n}` windows `open_tab_window` spawns would be denied. Commands
/// registered in `generate_handler!` are not capability-gated (see
/// `toggle_devtools`), so this works from any window.
///
/// Returns the state the window ended up in, so callers do not need a second
/// (also gated) `is_fullscreen()` read to update their menu item.
#[tauri::command]
fn toggle_fullscreen(window: tauri::WebviewWindow) -> Result<bool, String> {
    let next = !window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(next).map_err(|e| e.to_string())?;
    Ok(next)
}

/// Read the calling window's fullscreen state. Same capability reasoning as
/// `toggle_fullscreen` — the JS `isFullscreen()` is granted for `main` only.
#[tauri::command]
fn is_fullscreen(window: tauri::WebviewWindow) -> Result<bool, String> {
    window.is_fullscreen().map_err(|e| e.to_string())
}

/// Read a UTF-8 text file by absolute path — backs the in-app markdown editor
/// opening project files from the active workspace folder.
#[tauri::command]
async fn read_project_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}

/// Read one committed workspace file without passing its path through a shell.
/// Diff hydration handles repository-controlled paths, so keep the git refspec as
/// one discrete argument and reject traversal/control characters before spawning.
#[tauri::command]
async fn read_git_project_file(folder: String, path: String) -> Result<String, String> {
    use std::path::Component;

    let workspace = std::fs::canonicalize(&folder)
        .map_err(|e| format!("invalid workspace folder {folder}: {e}"))?;
    if !workspace.is_dir() {
        return Err(format!("workspace folder is not a directory: {folder}"));
    }
    if path.is_empty() || path.chars().any(|character| character.is_control()) {
        return Err("invalid committed file path".to_string());
    }
    let relative = std::path::Path::new(&path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("committed file path must stay inside the workspace".to_string());
    }

    let spec = format!("HEAD:{path}");
    let output = std::process::Command::new("git")
        .current_dir(workspace)
        .args(["show", spec.as_str()])
        .output()
        .map_err(|e| format!("read {path} from HEAD: {e}"))?;
    if !output.status.success() {
        return Err(format!("unable to read {path} from HEAD"));
    }
    String::from_utf8(output.stdout)
        .map_err(|e| format!("committed file {path} is not valid UTF-8: {e}"))
}

/// Write a UTF-8 text file by absolute path — the markdown editor's autosave.
#[tauri::command]
async fn write_project_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("write {path}: {e}"))
}

/// Write one Markdown file below a user-selected project folder. Memory's Git
/// source binding uses a relative path so the renderer cannot accidentally
/// write outside the folder it just granted to the app through the picker.
#[tauri::command]
async fn write_project_markdown(
    root: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    use std::path::Component;

    let root =
        std::fs::canonicalize(&root).map_err(|e| format!("invalid project folder {root}: {e}"))?;
    if !root.is_dir() {
        return Err("project folder is not a directory".to_string());
    }
    let relative = std::path::Path::new(&relative_path);
    if relative.is_absolute()
        || relative_path.is_empty()
        || relative_path
            .chars()
            .any(|character| character.is_control())
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
        || !relative_path.to_ascii_lowercase().ends_with(".md")
    {
        return Err("relative Markdown path must stay inside the project folder".to_string());
    }
    let destination = root.join(relative);
    let parent = destination
        .parent()
        .ok_or_else(|| "Markdown path has no parent".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("create Markdown folder {}: {e}", parent.display()))?;
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("resolve Markdown folder {}: {e}", parent.display()))?;
    if !canonical_parent.starts_with(&root) {
        return Err("Markdown path resolves outside the project folder".to_string());
    }
    if std::fs::symlink_metadata(&destination)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("refusing to overwrite a symlink".to_string());
    }
    std::fs::write(&destination, content)
        .map_err(|e| format!("write {}: {e}", destination.display()))
}

/// List markdown files under a canonical workspace without following symlinks.
fn collect_project_markdown(root: &std::path::Path) -> Result<Vec<String>, String> {
    let root = std::fs::canonicalize(root)
        .map_err(|error| format!("invalid workspace folder: {error}"))?;
    if !root.is_dir() {
        return Err("workspace folder is not a directory".to_string());
    }

    fn walk(root: &std::path::Path, dir: &std::path::Path, out: &mut Vec<String>, depth: usize) {
        if depth > 6 || out.len() >= 1000 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist"
            {
                continue;
            }
            if file_type.is_dir() {
                walk(root, &path, out, depth + 1);
            } else if file_type.is_file()
                && path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
                    e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown")
                })
            {
                if let Ok(canonical) = std::fs::canonicalize(&path) {
                    if canonical.starts_with(root) {
                        if let Some(s) = canonical.to_str() {
                            out.push(s.to_owned());
                        }
                    }
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(&root, &root, &mut out, 0);
    out.sort();
    Ok(out)
}

/// List markdown files under a folder (bounded recursion) for the file picker.
#[tauri::command]
async fn list_project_markdown(folder: String) -> Result<Vec<String>, String> {
    collect_project_markdown(std::path::Path::new(&folder))
}

#[cfg(test)]
mod project_markdown_tests {
    use super::collect_project_markdown;

    fn test_root(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("ryu-{name}-{}", std::process::id()))
    }

    #[test]
    fn returns_only_markdown_inside_the_workspace() {
        let root = test_root("markdown-inside");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/readme.md"), "inside\n").unwrap();
        std::fs::write(root.join("docs/ignore.txt"), "ignore\n").unwrap();

        let files = collect_project_markdown(&root).unwrap();

        assert_eq!(
            files,
            vec![std::fs::canonicalize(root.join("docs/readme.md"))
                .unwrap()
                .to_string_lossy()]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_a_symlinked_directory_outside_the_workspace() {
        use std::os::unix::fs::symlink;

        let container = test_root("markdown-symlink");
        let root = container.join("project");
        let outside = container.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), "outside\n").unwrap();
        symlink(&outside, root.join("linked")).unwrap();

        let files = collect_project_markdown(&root).unwrap();

        assert!(files.is_empty());
        std::fs::remove_dir_all(container).unwrap();
    }
}

pub fn run() {
    // Standalone app builds must choose their private data root and port namespace
    // before identifier migration, node loading, or Core startup observes defaults.
    standalone::configure_environment();
    // BEFORE the builder, deliberately: the bundle identifier keys the app-data
    // dir, so the 2026-08 rename would otherwise point a freshly-updated install
    // at an empty folder and silently sign the user out. Running here rather than
    // in `setup` removes the race against the webview, which can call
    // `load("auth.bin")` while `setup` is still executing.
    identifier_migration::migrate_app_data();

    let mut builder = tauri::Builder::default()
        .manage(CoreState {
            process: Mutex::new(None),
        })
        .manage(HttpClient(
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        ))
        .manage(keep_awake::KeepAwakeState::default())
        .manage(window_registry::WindowRegistry::default())
        .manage(app_update::AppUpdateState::default())
        // Single-instance MUST be the first plugin. On Windows/Linux a `ryu://`
        // link spawns a second process; this forwards the URL to the live
        // instance (the deep-link plugin's `onOpenUrl` fires there) and the
        // callback just surfaces the existing window. We do not hand-parse argv.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build());

    // macOS only: restore native traffic-light buttons for the transparent
    // shell. The macOS build deliberately does not load decorum; native AppKit
    // controls are the complete titlebar on this platform.
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(macos_titlebar_plugin());
    }

    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.plugin(tauri_plugin_decorum::init());
    }

    builder = builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // App updates are downloaded and signature-verified by the native
        // prepared-update cache, then installed only after an explicit frontend
        // action. plugin-process provides `relaunch()` after a successful install.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Launch at login. The registration carries `--autostart` so a
        // login-launched instance is distinguishable from a user-opened one —
        // that is what gates the "start hidden" preference (see `startup.rs`).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![startup::AUTOSTART_ARG]),
        ));

    builder.setup(|app| {
            let win = app.get_webview_window("main").unwrap();
            standalone::configure_embedded_sidecars(app);
            // Login-launched with "start hidden" on: take the window off screen
            // before anything else runs, so there is no flash of an empty frame.
            // Deliberately first: a manual launch never takes this branch, so no
            // later failure in setup can strand the user with no visible window.
            if startup::should_start_hidden(app) {
                let _ = win.hide();
            }
            #[cfg(not(target_os = "macos"))]
            win.create_overlay_titlebar().unwrap();
            #[cfg(target_os = "macos")]
            {
                // The titlebar plugin already restored the native buttons on
                // window-ready; re-apply defensively for the main window too.
                if let Ok(ns_window) = win.ns_window() {
                    apply_macos_titlebar_mask(ns_window);
                }
            }

            tray::setup_tray(app)?;

            // Register the `ryu://` scheme with the OS at runtime. Production
            // Windows builds register it via the NSIS installer (from the
            // tauri.conf.json scheme list), but dev builds and Linux need a
            // runtime call. Non-fatal: a registration failure must not abort
            // startup (the app still runs, deep links just won't route).
            #[cfg(any(debug_assertions, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(err) = app.deep_link().register_all() {
                    eprintln!("warning: failed to register ryu:// deep-link scheme: {err}");
                }
            }

            // Register global hotkey to toggle the companion overlay window.
            // Default: Ctrl+Shift+Space (all platforms). Readable via settings in future units.
            let companion_shortcut = Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::SHIFT),
                Code::Space,
            );
            let shortcut_handle = app.handle().clone();
            // Non-fatal: another app (e.g. the Island companion) may already own this
            // hotkey. Log and continue rather than aborting the whole setup hook.
            if let Err(err) = app.global_shortcut().on_shortcut(
                companion_shortcut,
                move |_app, _shortcut, _event| {
                    let handle = shortcut_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        toggle_companion_window(&handle);
                    });
                },
            ) {
                eprintln!(
                    "warning: failed to register companion hotkey (Ctrl+Shift+Space), it may already be in use: {err}"
                );
            }

            // Quick Capture (double-tap Shift → keep the selection on the Quests
            // board). A no-op unless the user has already switched it on: starting
            // the tap is what triggers the Input Monitoring prompt, and prompting
            // at launch would mostly get denied.
            quick_capture::init(app.handle());

            // Watch <ryu-home>/nodes.json and emit "nodes-changed" when it changes.
            // Profile-aware so the dev variant watches ~/.ryu-dev/nodes.json.
            let watcher_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let path = profile::ryu_home_dir().join("nodes.json");

                // Seed the baseline so the first poll doesn't fire spuriously on startup.
                let mut last_modified: Option<std::time::SystemTime> =
                    std::fs::metadata(&path).ok().and_then(|m| m.modified().ok());

                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    if let Ok(meta) = std::fs::metadata(&path) {
                        let modified = meta.modified().ok();
                        if modified != last_modified {
                            last_modified = modified;
                            watcher_handle.emit("nodes-changed", ()).ok();
                        }
                    }
                }
            });

            // Auto-start Ryu Core on app launch
            let handle = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                #[allow(unused_mut)]
                let mut binary = resolve_core_binary();
                // Production only: run the canonical one-line installer when the
                // managed local stack is missing or stale. The installer owns Core,
                // Gateway, CLI, and the start of Core's bundled defaults. In dev the
                // binary is owned by turbo (`bun run dev:core`), so this branch is
                // disabled — resolve_core_binary's dev fallback finds the debug build.
                //
                // The missing-binary half is now gated on the user having chosen
                // to run locally (`nodes.json` exists and its default node is this
                // machine's Core). The desktop no longer requires a local Core to
                // open — onboarding offers cloud and "connect to an existing node"
                // — so downloading one at boot would install a backend on behalf
                // of a user who may never want it. A fresh install therefore
                // downloads nothing until the local path is picked, which does it
                // through `ensure_core_installed`. The STALE half stays ungated: a
                // binary already on disk means this is a local user, and letting
                // an old core linger is the bug that check exists to prevent.
                #[cfg(not(debug_assertions))]
                if (binary.is_none() && crate::nodes::default_node_is_local())
                    || (binary.is_some() && crate::core::install::is_managed_core_stale(&handle))
                {
                    match crate::core::install::ensure_unified_installed(&handle).await {
                        Ok(p) => binary = Some(p),
                        // Keep whatever resolve_core_binary found on failure: a download
                        // error should degrade to the old-but-working core, not strand it.
                        Err(e) => tracing::error!("Failed to auto-install/upgrade Ryu Core: {}", e),
                    }
                }
                // Ensure the ryu-gateway sidecar is on disk BEFORE Core starts: Core
                // spawns it as a managed sidecar at boot and hands it every model
                // call, so a missing gateway degrades chat with no auto-retry. A
                // failure here is loud but non-fatal — the app still opens.
                //
                // Only when there IS a local Core to serve, though: the gateway is
                // that Core's sidecar, so downloading it for a user whose node is
                // in the cloud or on their company's server buys nothing.
                #[cfg(not(debug_assertions))]
                if binary.is_some() {
                    if let Err(e) = crate::core::install::ensure_gateway_installed(&handle).await {
                        tracing::error!(
                            "Failed to auto-install ryu-gateway (chat will be degraded until it is installed to ~/.ryu/bin/ or RYU_GATEWAY_BIN is set): {}",
                            e
                        );
                    }
                }
                if let Some(binary) = binary {
                    let mut process = RyuCoreProcess::new(binary);
                    if let Err(e) = process.start().await {
                        tracing::error!("Failed to auto-start Ryu Core: {}", e);
                    } else {
                        // Store the process in state after successful start
                        let state = handle.state::<CoreState>();
                        if let Ok(mut guard) = state.process.lock() {
                            *guard = Some(process);
                        }
                        tracing::info!("Ryu Core auto-started successfully");
                    }
                } else {
                    tracing::warn!("Ryu Core binary not found — install to ~/.ryu/bin/ or set RYU_CORE_BIN");
                }

                // NOTE: the desktop no longer prefetches the opt-in app sidecar bins
                // (mail/teams/research/…) at boot. Those binaries are now downloaded
                // by Core on-demand the first time their app is *enabled* (and removed
                // on uninstall) — see `apps/core/src/sidecar/manifest_sidecar.rs`
                // (`ensure_local_sidecar_present`) and `plans/019-sidecar-binary-lifecycle.md`.
                // The Tauri layer therefore fetches only core + gateway directly;
                // Core owns the default Shadow/Ghost/Island provisioning above.
                // An opt-in app's binary arrives when the user turns that app on,
                // not before.

                // Island (the Electron companion overlay, loopback :7989) — keep the
                // bundle installed and current, but do not launch it yet. The install
                // is routed through Core's global DownloadCenter, so a disabled
                // companion still receives the same resumable/progress-visible update
                // treatment as every other managed artifact.
                //
                // v1 / 0.1.0: island autostart is DISABLED to shrink the
                // shippable surface (the Electron island is deferred out of
                // the first release). Desktop UI entry points (NodeSelector row,
                // Settings tab, onboarding install, tray Show/Hide Companion, and
                // the User Nav Show/Hide Island control) are also
                // commented with `# 0.1.0: Island disabled` — uncomment those
                // and flip ISLAND_AUTOSTART to `true` to re-enable.
                // TO RE-ENABLE: flip ISLAND_AUTOSTART to `true`.
                #[cfg(not(debug_assertions))]
                {
                    const ISLAND_AUTOSTART: bool = false;
                    let island_handle = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        match crate::core::install::ensure_island_installed(&island_handle).await {
                            Ok(_) if ISLAND_AUTOSTART => {
                                if let Err(error) = crate::core::install::launch_island() {
                                    tracing::debug!("Ryu Island not launched: {}", error);
                                }
                            }
                            Ok(_) => tracing::debug!("Ryu Island installed and ready; autostart disabled"),
                            Err(error) => {
                                tracing::debug!("Ryu Island preinstall failed: {}", error)
                            }
                        }
                    });
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_ryu_core,
            stop_ryu_core,
            ensure_core_installed,
            install_and_launch_island,
            get_ryu_status,
            get_safe_mode_sentinel,
            set_safe_mode_sentinel,
            get_ryu_core_url,
            get_build_profile,
            standalone::get_standalone_app_bundle,
            standalone::bootstrap_standalone_app,
            app_icons::resolve_timeline_app_icons,
            app_update::get_app_update_download_preference,
            app_update::set_app_update_download_preference,
            app_update::get_prepared_app_update,
            app_update::prepare_app_update,
            app_update::install_prepared_app_update,
            app_update::clear_prepared_app_update,
            copy_data_folder_to_profile,
            deep_clean_node,
            midnight_wipe::get_midnight_wipe,
            midnight_wipe::set_midnight_wipe,
            update_schedule::get_pending_app_update,
            update_schedule::set_pending_app_update,
            update_schedule::clear_pending_app_update,
            update_schedule::due_app_update,
            migrate_data_folder,
            import_data_folder,
            open_external,
            preview_link_metadata,
            get_editor_availability,
            open_in_editor,
            open_workspace_item,
            reveal_workspace_item,
            open_media_pip,
            close_media_pip,
            agent_browser_stream_status,
            open_tab_window,
            window_registry::register_window_tabs,
            window_registry::route_entity_open,
            tray::get_hide_tray_icon,
            tray::set_hide_tray_icon,
            tray::get_island_visibility,
            tray::set_island_visibility,
            tray::get_close_to_tray,
            tray::set_close_to_tray,
            startup::get_start_hidden,
            startup::set_start_hidden,
            shell_execute,
            toggle_devtools,
            toggle_fullscreen,
            is_fullscreen,
            read_project_file,
            read_git_project_file,
            write_project_file,
            write_project_markdown,
            list_project_markdown,
            hardware::get_hardware_info,
            hardware::get_system_usage,
            keep_awake::set_keep_awake,
            nodes::list_nodes,
            nodes::add_node,
            nodes::update_node_token,
            nodes::local_node_token,
            nodes::remove_node,
            nodes::set_default_node,
            nodes::test_node,
            nodes::test_all_nodes,
            nodes::discover_lan_nodes,
            nodes::get_lan_ip,
            secrets::set_provider_key,
            secrets::get_provider_key,
            secrets::delete_provider_key,
            permissions::check_accessibility_permission,
            permissions::request_accessibility_permission,
            permissions::check_screen_recording_permission,
            permissions::request_screen_recording_permission,
            permissions::check_input_monitoring_permission,
            permissions::request_input_monitoring_permission,
            permissions::automation_permissions_required,
            // Quick Capture: the double-Shift keep gesture (macOS; no-ops elsewhere).
            quick_capture::quick_capture_status,
            quick_capture::quick_capture_set_enabled,
            quick_capture::quick_capture_set_binding,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(true) = event {
                window
                    .app_handle()
                    .state::<window_registry::WindowRegistry>()
                    .touch_window(window.label());
            }
            // "Stay in the tray on close": the main window hides instead of being
            // destroyed, so Core — and every turn running against it — survives.
            // Only the main window: destroying the companion overlay must stay a
            // real destroy, and only when a quit is not already under way, or the
            // tray's own Quit could never finish. `read_close_to_tray` reports
            // false whenever the tray icon is hidden, so this can never strand a
            // running app with neither a window nor an icon.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && !tray::is_quitting() {
                    if tray::read_close_to_tray(window.app_handle()) {
                        api.prevent_close();
                        let _ = window.hide();
                        return;
                    }
                    // A real close destroys the managed Core child. Prevent the
                    // native close while the tray guard checks for active local
                    // chat/workflow runs and asks before stopping them.
                    api.prevent_close();
                    tray::request_quit(window.app_handle());
                    return;
                }
            }
            if let WindowEvent::Destroyed = event {
                window
                    .app_handle()
                    .state::<window_registry::WindowRegistry>()
                    .remove_window(window.label());
                // Only stop Ryu Core when the main window is destroyed.
                // Destroying the companion overlay must not kill the backend.
                if window.label() != "main" {
                    return;
                }
                let state = window.state::<CoreState>();
                if let Ok(mut guard) = state.process.lock() {
                    if let Some(ref mut process) = *guard {
                        if let Err(e) = process.try_stop() {
                            tracing::error!("Failed to stop Ryu Core: {}", e);
                        }
                    }
                };
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, _event| {
            // App-level Quit (Cmd/Ctrl-Q, OS shutdown, or another native menu) can
            // arrive without a main-window CloseRequested event. Send it through
            // the same local-run guard so every real quit has one consistent
            // warning before the managed Core child is stopped.
            if let tauri::RunEvent::ExitRequested { api, .. } = _event {
                if !tray::is_quitting() {
                    api.prevent_exit();
                    tray::request_quit(_app.app_handle());
                }
                return;
            }
            // macOS: clicking the dock icon (or re-opening from Spotlight) does
            // not spawn a second process, so the single-instance handler never
            // fires. Without this, an instance started hidden at login — or one
            // whose window was closed to the tray — has no way back on screen if
            // the tray icon is also hidden. Windows/Linux recover through the
            // single-instance path instead.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = _event
            {
                if let Some(win) = _app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
        });
}
