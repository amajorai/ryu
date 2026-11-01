//! Tauri plugin registration for the desktop builder.

use tauri::Manager;

#[cfg(target_os = "macos")]
use crate::macos_window::macos_titlebar_plugin;
use crate::startup;

/// Register every Tauri plugin, in the order the desktop shell depends on.
pub(crate) fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let mut builder = builder
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
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .max_file_size(1_048_576)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
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

    builder
}
