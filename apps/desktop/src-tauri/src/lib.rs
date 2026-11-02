mod app_icons;
mod app_setup;
mod app_update;
mod aux_windows;
mod build_info;
mod cli_setup;
mod clips_quick_attach;
mod cloud_environment_import;
mod commands;
mod core;
mod core_lifecycle;
mod data_folder;
mod deep_link_profile;
mod desktop_seal;
mod distribution;
mod editors;
mod external_links;
mod fs_command_error;
mod hardware;
mod hardware_acceleration;
mod identifier_migration;
mod installer_retention;
mod keep_awake;
mod link_preview;
mod macos_glass;
mod midnight_wipe;
mod native_copy;
mod nodes;
mod notification_identity;
mod os_notifications;
mod permissions;
mod plugin_file_resource;
mod profile;
mod project_files;
mod projectless_task_folder;
mod quick_capture;
mod secrets;
mod security_key_commands;
mod shadow_auth;
mod shell_exec;
mod standalone;
mod startup;
mod tab_transfer;
mod tab_windows;
mod tray;
mod update_handoff;
mod update_install_worker;
mod update_recovery;
mod update_schedule;
mod webview_locale;
mod win_process;
mod window_chrome;
mod window_events;
mod window_registry;
mod workspace_items;
mod workspace_move;

use std::sync::Mutex;

use tauri::Manager;

#[cfg(target_os = "macos")]
use crate::window_chrome::macos_titlebar_plugin;

// Crate-root paths other modules reach through `crate::…`.
pub(crate) use crate::core_lifecycle::{
    resolve_core_binary, stop_managed_core, CoreState, HttpClient,
};

/// Release gate for Island, the Electron companion overlay (loopback :7989).
///
/// Island is not part of the current release. While this is `false` the bundle
/// is still kept installed and current (see the setup hook), but it is never
/// autostarted and the tray "Show/Hide Companion" item is not shown. The webview
/// side has the matching `ISLAND_ENABLED` in
/// `apps/desktop/src/lib/island-availability.ts`; flip both together.
pub(crate) const ISLAND_ENABLED: bool = false;

pub fn run() {
    // Standalone app builds must choose their private data root and port namespace
    // before identifier migration, node loading, or Core startup observes defaults.
    standalone::configure_environment();
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    if let Err(error) = deep_link_profile::before_boot(&context.config().identifier) {
        eprintln!("{error:#}");
        std::process::exit(64);
    }
    let update_startup = match update_recovery::before_boot(
        &context.config().identifier,
        &context.package_info().version.to_string(),
    ) {
        Ok(state) => state,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(78);
        }
    };
    // BEFORE the builder, deliberately: the bundle identifier keys the app-data
    // dir, so the 2026-08 rename would otherwise point a freshly-updated install
    // at an empty folder and silently sign the user out. Running here rather than
    // in `setup` removes the race against the webview, which can call
    // `load("auth.bin")` while `setup` is still executing.
    identifier_migration::migrate_app_data(&context.config().identifier);
    // The desktop's sealed stores (auth vault, license key, CLI-setup snapshots)
    // resolve their keychain-held key through this host: this profile's data dir
    // and keychain suffix. Before the builder, so no command can race it.
    desktop_seal::install_crypto_host(profile::ryu_home_dir(), profile::suffix());
    // Before the builder: the webview engines read their GPU switches (and, on
    // Windows, the saved UI language) when the first webview starts, so a later
    // change would have no effect.
    hardware_acceleration::apply_before_webview();

    let mut builder = tauri::Builder::default()
        .manage(update_startup)
        .manage(CoreState {
            process: Mutex::new(None),
            operation: tokio::sync::Mutex::new(()),
        })
        .manage(HttpClient(
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        ))
        .manage(keep_awake::KeepAwakeState::default())
        .manage(window_registry::WindowRegistry::default())
        .manage(tab_transfer::TabTransfers::default())
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
        // Tauri's default app menu with the standard roles, relabelled in the UI language.
        builder = builder.menu(|handle| native_copy::app_menu(handle));
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
        .setup(app_setup::setup)
        .invoke_handler(commands::invoke_handler())
        .on_window_event(window_events::on_window_event)
        .build(context)
        .expect("error while running tauri application")
        .run(window_events::on_run_event);
}

/// Recovery copies this known-good executable under a distinct filename and
/// enters this mode before any normal desktop initialization can open stores.
pub fn run_recovery_mode() -> Option<i32> {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let guard_mode = args.first().is_some_and(|arg| arg == "--ryu-update-guard");
    let install_mode = args
        .first()
        .is_some_and(|arg| arg == "--ryu-install-cached");
    if !guard_mode && !install_mode {
        return None;
    }
    let result = (|| -> anyhow::Result<()> {
        anyhow::ensure!(args.len() == 2, "expected one update handoff directory");
        if install_mode {
            return update_install_worker::run(std::path::PathBuf::from(&args[1]));
        }
        let directory = std::fs::canonicalize(std::path::PathBuf::from(&args[1]))?;
        let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
        let root = update_recovery::recovery_root(&context.config().identifier)
            .map_err(anyhow::Error::msg)?;
        let handoffs = std::fs::canonicalize(root.join("handoffs"))?;
        anyhow::ensure!(
            directory.parent() == Some(handoffs.as_path()),
            "handoff belongs to another application namespace"
        );
        ryu_runtime_install::handoff::run_handoff(directory)?;
        Ok(())
    })();
    Some(match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("Update recovery stopped: {error:#}");
            1
        }
    })
}
