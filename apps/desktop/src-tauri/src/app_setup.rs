//! The builder `setup` hook: main window chrome, tray, deep links, global
//! shortcuts, watchers, and the Core auto-start.

use tauri::{Emitter, Manager};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_decorum::WebviewWindowExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

use crate::aux_windows::toggle_companion_window;
#[cfg(all(
    any(debug_assertions, target_os = "linux"),
    any(target_os = "windows", target_os = "linux")
))]
use crate::deep_link_profile;
#[cfg(target_os = "macos")]
use crate::macos_window::apply_macos_titlebar_mask;
use crate::{
    clips_quick_attach, core_autostart, profile, quick_capture, standalone, startup, tray,
    update_recovery,
};

/// Desktop setup hook passed to `tauri::Builder::setup`.
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
        for scheme in deep_link_profile::registration_schemes(
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
    core_autostart::spawn(handle);

    Ok(())
}
