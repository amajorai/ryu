//! Managed Ryu Core process lifecycle: state, binary resolution, start/stop
//! commands, and the Safe Mode sentinel.

use std::sync::Mutex;

use tauri::Manager;

use crate::core::process::RyuCoreProcess;
use crate::profile;
#[cfg(debug_assertions)]
use crate::standalone;

pub(crate) struct CoreState {
    pub(crate) process: Mutex<Option<RyuCoreProcess>>,
    pub(crate) operation: tokio::sync::Mutex<()>,
}

/// Finish Desktop's Core lifecycle: stop packaged runtimes and detach local dev
/// runtimes so a native rebuild cannot interrupt their active turns.
///
/// Exists because the tray's Quit is now the ONLY path that reliably ends the
/// app: with "stay in tray on close" on by default, closing the window no longer
/// destroys it, so the `WindowEvent::Destroyed` arm below — which used to be
/// where Core was stopped — does not run. A quit that left `ryu-core` alive would
/// leave it holding its port, which this repo has already paid for once (a stale
/// Core squatting 8980 with a pile of hung probes).
///
/// Idempotent: `exit_desktop` runs against an `Option` that the Destroyed arm may
/// also have taken, so calling both is safe.
pub(crate) fn stop_managed_core<R: tauri::Runtime, M: Manager<R>>(app: &M) {
    let state = app.state::<CoreState>();
    let mut guard = match state.process.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    if let Some(ref mut process) = *guard {
        if let Err(e) = process.exit_desktop() {
            tracing::error!("Failed to stop Ryu Core on quit: {}", e);
        }
    }
}

pub(crate) struct HttpClient(pub reqwest::Client);

pub(crate) fn resolve_core_binary() -> Option<std::path::PathBuf> {
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
        .or_else(crate::core::install::managed_core_path)
        // 3. PATH — but never another profile's installed binary. Installers put
        //    `~/.ryu/bin` AND `~/.ryu-dev/bin` on PATH, so a dev profile whose own
        //    `~/.ryu-dev/bin/ryu-core` is missing would otherwise fall through to the
        //    RELEASE exe here and silently run a Core of a different (usually older)
        //    build against the dev data dir — the exact leak step 2's comment forbids.
        //    Rejecting it here is only safe because `install::is_installed` rejects the
        //    same hit, so the missing binary is downloaded rather than left unresolved.
        .or_else(|| {
            let hit = which::which(bin_name.strip_suffix(".exe").unwrap_or(bin_name)).ok()?;
            if hit.starts_with(ryu_sidecar_runtime::layout::bin_dir(
                &profile::ryu_home_dir(),
            )) {
                return None;
            }
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
pub(crate) async fn start_ryu_core(
    app: tauri::AppHandle,
    state: tauri::State<'_, CoreState>,
) -> Result<String, String> {
    let _operation = state.operation.lock().await;
    if crate::app_update::runtime_update_in_progress() {
        return Err(
            "Ryu is installing an app update; the local runtime will start after restart"
                .to_owned(),
        );
    }
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
    let mut process = RyuCoreProcess::new_for_app(&app, binary);

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
pub(crate) async fn ensure_core_installed(app: tauri::AppHandle) -> Result<String, String> {
    if crate::app_update::runtime_update_in_progress() {
        return Err("Ryu is installing an app update; wait for the restart".to_owned());
    }
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

/// Ensure the Island Electron companion is installed under `<data dir>/bin/island/`, then
/// launch it, returning the launched bundle path. Dev is a no-op (`"dev"`): turbo
/// owns Island in development (`bun run dev` starts electron-vite), so downloading a
/// release build would fight it — same `debug_assertions` gate as
/// [`ensure_core_installed`]. Invoked from the node selector's Island row ("Install /
/// Launch" when the local island isn't reachable) and from onboarding.
#[tauri::command]
pub(crate) async fn install_and_launch_island(app: tauri::AppHandle) -> Result<String, String> {
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
pub(crate) async fn get_ryu_status() -> String {
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

// ── Safe Mode sentinel (`<data dir>/state/safe-mode`) ──────────────────────────
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
    ryu_sidecar_runtime::layout::state_path(&profile::ryu_home_dir(), "safe-mode")
}

/// Whether the next Core boot will enter Safe Mode because of the sentinel.
///
/// Only the sentinel tier — `RYU_SAFE_MODE` and the stored preference are Core's to
/// resolve, and Core reports the effective answer over `GET /api/safe-mode`.
#[tauri::command]
pub(crate) async fn get_safe_mode_sentinel() -> bool {
    safe_mode_sentinel_path().exists()
}

/// Arm or clear the sentinel. Returns the resulting state.
///
/// Does NOT restart Core: the caller decides when (the preflight page already owns
/// that button), and a command that restarted as a side effect would be impossible
/// to use from a crash screen where the process is already down.
#[tauri::command]
pub(crate) async fn set_safe_mode_sentinel(enabled: bool) -> Result<bool, String> {
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
pub(crate) async fn stop_ryu_core(state: tauri::State<'_, CoreState>) -> Result<(), String> {
    let _operation = state.operation.lock().await;
    if crate::app_update::runtime_update_in_progress() {
        return Err("Ryu is installing an app update; wait for the restart".to_owned());
    }
    // Extract the process from the state to avoid holding lock across await
    let process = {
        let mut guard = state.process.lock().map_err(|e| e.to_string())?;
        guard.take()
    };

    // Always run stop — even without an owned child handle it kills via PID file
    // and by profile port, which is what makes reset work against turbo-owned Core.
    let mut process =
        process.unwrap_or_else(|| RyuCoreProcess::new(std::path::PathBuf::from("ryu-core")));
    if let Err(error) = process.stop().await {
        // A failed stop can leave a verified execution host alive. Retain the
        // manager and its ownership evidence so status and retry remain honest.
        let mut guard = state.process.lock().map_err(|e| e.to_string())?;
        *guard = Some(process);
        return Err(format!("Failed to stop Ryu Core: {error}"));
    }

    Ok(())
}

#[tauri::command]
pub(crate) fn get_ryu_core_url() -> String {
    profile::core_localhost_url()
}
