//! The Tauri `setup` hook: main-window chrome, tray, deep-link registration,
//! global shortcuts, the nodes.json watcher, and Core auto-start.

use tauri::{Emitter, Manager};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_decorum::WebviewWindowExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

use crate::aux_windows::toggle_companion_window;
use crate::core::process::RyuCoreProcess;
use crate::core_lifecycle::{resolve_core_binary, CoreState};
#[cfg(target_os = "macos")]
use crate::window_chrome::apply_macos_titlebar_mask;
use crate::{
    clips_quick_attach, notification_identity, profile, quick_capture, standalone, startup, tray,
    update_recovery,
};

/// Runs once the app is built, before the event loop starts.
pub(crate) fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
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
    notification_identity::register(app.handle());
    update_recovery::schedule_retention(app.handle());

    // Register the `ryu://` scheme with the OS at runtime. Production
    // Windows builds register it via the NSIS installer (from the
    // tauri.conf.json scheme list), but dev builds and Linux need a
    // runtime call. Non-fatal: a registration failure must not abort
    // startup (the app still runs, deep links just won't route).
    #[cfg(all(
        any(debug_assertions, target_os = "linux"),
        any(target_os = "windows", target_os = "linux")
    ))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        let configured: Vec<String> = app
            .config()
            .plugins
            .0
            .get("deep-link")
            .and_then(|config| config.get("desktop"))
            .and_then(|desktop| desktop.get("schemes"))
            .and_then(serde_json::Value::as_array)
            .map(|schemes| {
                schemes
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        for scheme in crate::deep_link_profile::registration_schemes(
            &app.config().identifier,
            &profile::name(),
            cfg!(debug_assertions),
            &configured,
        ) {
            if let Err(err) = app.deep_link().register(&scheme) {
                eprintln!("warning: failed to register {scheme}:// deep-link scheme: {err}");
            }
        }
    }

    // Register global hotkey to toggle the companion overlay window.
    // Default: Ctrl+Shift+Space (all platforms). Readable via settings in future units.
    let companion_shortcut =
        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
    let shortcut_handle = app.handle().clone();
    // Non-fatal: another app (e.g. the Island companion) may already own this
    // hotkey. Log and continue rather than aborting the whole setup hook.
    if let Err(err) =
        app.global_shortcut()
            .on_shortcut(companion_shortcut, move |_app, _shortcut, _event| {
                let handle = shortcut_handle.clone();
                tauri::async_runtime::spawn(async move {
                    toggle_companion_window(&handle);
                });
            })
    {
        eprintln!(
            "warning: failed to register companion hotkey (Ctrl+Shift+Space), it may already be in use: {err}"
        );
    }

    // Clips' Appshots-style bare-modifier gesture. It is opt-in from
    // Keyboard Shortcuts because macOS needs Input Monitoring and both
    // platforms observe modifier keys outside the Ryu window.
    clips_quick_attach::init(app.handle());

    // Quick Capture (double-tap Shift → keep the selection on the Quests
    // board). A no-op unless the user has already switched it on: starting
    // the tap is what triggers the Input Monitoring prompt, and prompting
    // at launch would mostly get denied.
    quick_capture::init(app.handle());

    // Watch <data dir>/state/nodes.json and emit "nodes-changed" when it
    // changes. Profile-aware so the dev variant watches ~/.ryu-dev/state/nodes.json.
    let watcher_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let path = ryu_sidecar_runtime::layout::state_path(&profile::ryu_home_dir(), "nodes.json");

        // Seed the baseline so the first poll doesn't fire spuriously on startup.
        let mut last_modified: Option<std::time::SystemTime> = std::fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok());

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
        if (binary.is_none()
            && (crate::nodes::default_node_is_local()
                || crate::core::install::has_prepared_runtime()))
            || (binary.is_some() && crate::core::install::is_managed_core_stale(&handle))
        {
            match crate::core::install::ensure_unified_installed(&handle).await {
                Ok(p) => binary = Some(p),
                Err(e) => {
                    binary = None;
                    tracing::error!(
                        "Failed to install the matching Ryu stack; previous binaries retained: {}",
                        e
                    );
                }
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
                binary = None;
                tracing::error!(
                    "Failed to auto-install ryu-gateway (chat will be degraded until it is installed to ~/.ryu/bin/ or RYU_GATEWAY_BIN is set): {}",
                    e
                );
            }
        }
        if let Some(binary) = binary {
            let lifecycle_state = handle.state::<CoreState>();
            let _operation = lifecycle_state.operation.lock().await;
            if crate::app_update::runtime_update_in_progress() {
                return;
            }
            let mut process = RyuCoreProcess::new_for_app(&handle, binary);
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
            tracing::warn!(
                "Ryu Core binary not found — install to ~/.ryu/bin/ or set RYU_CORE_BIN"
            );
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
        // bundle installed and current. The install is routed through Core's
        // global DownloadCenter, so a disabled companion still receives the
        // same resumable/progress-visible update treatment as every other
        // managed artifact. It is only launched when the `ISLAND_ENABLED`
        // release gate is on; the desktop UI entry points (NodeSelector row,
        // Preflight item, onboarding install, Keyboard Shortcuts rows, tray
        // Show/Hide Companion, and the User Nav Show/Hide Island control)
        // follow the same gate.
        #[cfg(not(debug_assertions))]
        {
            let island_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                match crate::core::install::ensure_island_installed(&island_handle).await {
                    Ok(_) if crate::ISLAND_ENABLED => {
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
}
