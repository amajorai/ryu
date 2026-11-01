mod app_events;
mod app_icons;
mod app_info;
mod app_plugins;
mod app_setup;
mod app_update;
mod app_windows;
mod aux_windows;
mod cli_setup;
mod clips_quick_attach;
mod cloud_environment_import;
mod core;
mod core_autostart;
mod core_lifecycle;
mod data_folder;
mod deep_link_profile;
mod desktop_seal;
mod distribution;
mod editors;
mod external_links;
mod hardware;
mod hardware_acceleration;
mod identifier_migration;
mod installer_retention;
mod keep_awake;
mod macos_glass;
#[cfg(target_os = "macos")]
mod macos_window;
mod midnight_wipe;
mod nodes;
mod os_notifications;
mod permissions;
mod plugin_file_resource;
mod profile;
mod project_files;
mod projectless_task_folder;
mod quick_capture;
mod secrets;
mod shadow_auth;
mod shell_exec;
mod standalone;
mod startup;
mod tab_transfer;
mod tray;
mod update_handoff;
mod update_install_worker;
mod update_recovery;
mod update_schedule;
mod win_process;
mod window_registry;
mod workspace_items;
mod workspace_move;

use std::sync::Mutex;

pub(crate) use core_lifecycle::{resolve_core_binary, stop_managed_core, CoreState, HttpClient};

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
    // Before the builder: the webview engines read their GPU switches when the
    // first webview starts, so a later toggle would have no effect.
    hardware_acceleration::apply_before_webview();

    let builder = tauri::Builder::default()
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
        .manage(app_update::AppUpdateState::default());
    let builder = app_plugins::register(builder);

    builder
        .setup(app_setup::setup)
        .invoke_handler(tauri::generate_handler![
            core_lifecycle::start_ryu_core,
            core_lifecycle::stop_ryu_core,
            core_lifecycle::ensure_core_installed,
            core_lifecycle::install_and_launch_island,
            projectless_task_folder::get_default_projectless_task_folder,
            cloud_environment_import::cloud_environment_variable_names,
            cloud_environment_import::cloud_environment_selected_variables,
            core_lifecycle::get_ryu_status,
            core_lifecycle::get_safe_mode_sentinel,
            core_lifecycle::set_safe_mode_sentinel,
            hardware_acceleration::get_hardware_acceleration,
            hardware_acceleration::set_hardware_acceleration,
            core_lifecycle::get_ryu_core_url,
            app_info::get_build_profile,
            app_info::interface_reset_requested,
            standalone::get_standalone_app_bundle,
            standalone::bootstrap_standalone_app,
            app_icons::resolve_timeline_app_icons,
            app_update::get_app_update_download_preference,
            app_update::set_app_update_download_preference,
            app_update::get_prepared_app_update,
            app_update::prepare_app_update,
            app_update::install_prepared_app_update,
            update_recovery::get_update_startup_health,
            update_recovery::acknowledge_update_startup,
            app_update::clear_prepared_app_update,
            data_folder::copy_data_folder_to_profile,
            data_folder::deep_clean_node,
            midnight_wipe::get_midnight_wipe,
            midnight_wipe::set_midnight_wipe,
            update_schedule::get_pending_app_update,
            update_schedule::set_pending_app_update,
            update_schedule::clear_pending_app_update,
            update_schedule::due_app_update,
            data_folder::migrate_data_folder,
            data_folder::import_data_folder,
            external_links::open_external,
            external_links::preview_link_metadata,
            editors::get_editor_availability,
            editors::open_in_editor,
            workspace_items::open_workspace_item,
            workspace_items::move_workspace_item,
            workspace_items::list_workspace_files,
            workspace_items::reveal_workspace_item,
            aux_windows::open_media_pip,
            aux_windows::close_media_pip,
            aux_windows::agent_browser_stream_status,
            app_windows::open_standalone_app_window,
            app_windows::close_current_window,
            app_windows::open_tab_window,
            tab_transfer::tab_transfer_ready,
            tab_transfer::claim_tab_transfer,
            tab_transfer::watch_tab_drag,
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
            shell_exec::shell_execute,
            app_windows::toggle_devtools,
            app_windows::toggle_fullscreen,
            app_windows::is_fullscreen,
            project_files::read_project_file,
            project_files::read_project_file_binary,
            project_files::read_git_project_file,
            project_files::write_project_file,
            project_files::write_project_file_binary,
            project_files::write_project_markdown,
            project_files::list_project_markdown,
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
            secrets::desktop_secret_get,
            secrets::desktop_secret_set,
            secrets::desktop_secret_delete,
            app_info::desktop_content_key,
            cli_setup::apply_gateway_cli_setup,
            cli_setup::reset_gateway_cli_setup,
            cli_setup::gateway_cli_setup_status,
            permissions::check_accessibility_permission,
            permissions::request_accessibility_permission,
            permissions::check_screen_recording_permission,
            permissions::request_screen_recording_permission,
            permissions::check_input_monitoring_permission,
            permissions::request_input_monitoring_permission,
            permissions::automation_permissions_required,
            permissions::open_privacy_settings,
            os_notifications::show_os_notification,
            // Quick Capture: the double-Shift keep gesture (macOS; no-ops elsewhere).
            macos_glass::set_window_corner_radius,
            macos_glass::set_liquid_glass,
            quick_capture::quick_capture_status,
            quick_capture::quick_capture_set_enabled,
            quick_capture::quick_capture_set_binding,
            clips_quick_attach::clips_quick_attach_status,
            clips_quick_attach::clips_quick_attach_set_enabled,
            clips_quick_attach::clips_quick_attach_set_destination,
            clips_quick_attach::clips_quick_attach_focus,
        ])
        .on_window_event(app_events::on_window_event)
        .build(context)
        .expect("error while running tauri application")
        .run(app_events::on_run_event);
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
