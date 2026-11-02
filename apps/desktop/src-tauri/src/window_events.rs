//! Window- and app-level event handlers: tray close behaviour, the quit guard,
//! window-registry bookkeeping, and macOS traffic-light / dock-reopen handling.

use tauri::{Manager, WindowEvent};

use crate::core_lifecycle::CoreState;
#[cfg(target_os = "macos")]
use crate::window_chrome::position_macos_traffic_lights;
use crate::{macos_glass, tray, window_registry};

/// The handler passed to `Builder::on_window_event`.
pub(crate) fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    #[cfg(target_os = "macos")]
    if matches!(event, WindowEvent::Resized(_) | WindowEvent::Focused(true)) {
        if let Ok(ns_window) = window.ns_window() {
            position_macos_traffic_lights(ns_window);
        }
    }
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
        macos_glass::forget_window(window.label());
        // Only finish the Core lifecycle when the main window is destroyed.
        // Destroying the companion overlay must not kill the backend.
        if window.label() != "main" {
            return;
        }
        let state = window.state::<CoreState>();
        if let Ok(mut guard) = state.process.lock() {
            if let Some(ref mut process) = *guard {
                if let Err(e) = process.exit_desktop() {
                    tracing::error!("Failed to stop Ryu Core: {}", e);
                }
            }
        };
    }
}

/// The callback passed to `App::run`.
pub(crate) fn on_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    // App-level Quit (Cmd/Ctrl-Q, OS shutdown, or another native menu) can
    // arrive without a main-window CloseRequested event. Send it through
    // the same local-run guard so every real quit has one consistent
    // warning before the managed Core child is stopped.
    if let tauri::RunEvent::ExitRequested { api, .. } = event {
        if !tray::is_quitting() {
            api.prevent_exit();
            tray::request_quit(app.app_handle());
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
    } = event
    {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
    }
}
