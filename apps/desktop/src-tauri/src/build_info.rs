//! Build/profile introspection, the Safe Mode sentinel, and the webview content key.

use crate::{deep_link_profile, desktop_seal, profile};

/// The webview's content keys for one of its own stores (Yjs snapshots, sealed
/// localStorage values), derived from the desktop key: the current key plus the
/// keys derived from desktop keys the app used earlier, which only open. See
/// `desktop_seal::webview_content_key`. Keychain access may block, so it runs
/// off the async runtime.
#[tauri::command]
pub(crate) async fn desktop_content_key(
    store: String,
) -> Result<desktop_seal::WebviewContentKeys, String> {
    tokio::task::spawn_blocking(move || desktop_seal::webview_content_key(&store))
        .await
        .map_err(|error| format!("The desktop encryption key is unavailable: {error}"))?
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

pub(crate) fn safe_mode_sentinel_path() -> std::path::PathBuf {
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
pub(crate) struct BuildProfile {
    dev: bool,
    profile: String,
    #[serde(rename = "deepLinkProfile")]
    deep_link_profile: Option<String>,
}

/// Launch flag that boots the window into the default chat, whatever
/// interface was last open (a recovery path for a stuck interface).
pub(crate) const RESET_INTERFACE_ARG: &str = "--reset-interface";
/// Environment equivalent of [`RESET_INTERFACE_ARG`] (`RYU_RESET_INTERFACE=1`).
pub(crate) const RESET_INTERFACE_ENV: &str = "RYU_RESET_INTERFACE";

/// Whether this launch asked to start in the default chat.
#[tauri::command]
pub(crate) fn interface_reset_requested() -> bool {
    std::env::args_os().any(|arg| arg == RESET_INTERFACE_ARG)
        || std::env::var(RESET_INTERFACE_ENV).is_ok_and(|value| value == "1")
}

#[tauri::command]
pub(crate) fn get_build_profile(app: tauri::AppHandle) -> BuildProfile {
    let profile = profile::name();
    BuildProfile {
        dev: profile == "dev",
        deep_link_profile: deep_link_profile::link_profile_for_bundle(
            &app.config().identifier,
            &profile,
            cfg!(debug_assertions),
        ),
        profile,
    }
}
