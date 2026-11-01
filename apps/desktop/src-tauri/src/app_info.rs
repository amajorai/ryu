//! Small app-identity commands: build profile, interface reset flag, and
//! webview content keys.

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
