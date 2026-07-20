// macOS permission gates for the automation stack (Ghost, Shadow). These live in
// the desktop app — not Core or the sidecars — on purpose: the desktop app is the
// signed, user-installed entry point, and the only process in the spawn chain
// (app → Core → ghost/shadow sidecars) that can reliably show the system
// permission dialogs. Because macOS attributes Screen Recording / Accessibility /
// Input Monitoring to the responsible process at the top of that chain, a grant
// made here covers the sidecars' captures too.
//
// The actual TCC checks live in the shared `ghost-permissions` crate (one
// implementation across the desktop app, the `ghost` CLI, Core, and the
// sidecars). These commands are thin Tauri wrappers the frontend onboarding step
// and Privacy settings row call. `check_*` never prompts (safe to poll);
// `request_*` surfaces the system prompt and registers the app in System
// Settings. A freshly granted permission only takes effect after the app
// restarts — the UI tells the user.

use ghost_permissions::Capability;

/// Whether Accessibility is currently granted. Never prompts.
#[tauri::command]
pub fn check_accessibility_permission() -> bool {
	ghost_permissions::granted(Capability::Accessibility)
}

/// Surface the Accessibility prompt and register the app in System Settings.
#[tauri::command]
pub fn request_accessibility_permission() -> bool {
	ghost_permissions::request(Capability::Accessibility)
}

/// Whether Screen Recording is currently granted. Never prompts.
#[tauri::command]
pub fn check_screen_recording_permission() -> bool {
	ghost_permissions::granted(Capability::ScreenRecording)
}

/// Surface the Screen Recording prompt and register the app in System Settings.
#[tauri::command]
pub fn request_screen_recording_permission() -> bool {
	ghost_permissions::request(Capability::ScreenRecording)
}

/// Whether Input Monitoring is currently granted. Never prompts.
#[tauri::command]
pub fn check_input_monitoring_permission() -> bool {
	ghost_permissions::granted(Capability::InputMonitoring)
}

/// Surface the Input Monitoring prompt and register the app in System Settings.
#[tauri::command]
pub fn request_input_monitoring_permission() -> bool {
	ghost_permissions::request(Capability::InputMonitoring)
}

/// Whether the current OS gates these capabilities behind a user-grantable
/// permission at all. False on Windows and Linux/X11, where the frontend should
/// show "no setup needed" instead of Grant buttons.
#[tauri::command]
pub fn automation_permissions_required() -> bool {
	ghost_permissions::required(Capability::ScreenRecording)
}
