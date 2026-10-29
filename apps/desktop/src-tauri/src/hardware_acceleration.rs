//! "Use hardware acceleration" — the desktop's GPU rendering preference.
//!
//! The webview engines read their GPU switches when the first webview starts, so
//! the choice is a sentinel FILE (`state/hardware-acceleration-disabled` under the
//! profile's data dir, built through the data-dir layout)
//! applied in `run()` before the Tauri builder exists. A preference held in the
//! webview's own storage or in Core would be read too late: the renderer is
//! already up by the time either answers. Changing it therefore takes a restart,
//! and the settings row says so.
//!
//! Profile-aware via `profile::ryu_home_dir`, so a dev build's choice never
//! reaches the release install's `~/.ryu`.
//!
//! Per platform:
//! - Windows: WebView2 reads `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, which
//!   replaces the configured `additionalBrowserArgs`, so the configured flags are
//!   repeated here alongside `--disable-gpu`. The variable is process-wide, which
//!   keeps every webview in the shared WebView2 environment on identical
//!   arguments (mismatched arguments make later webview creation fail).
//! - Linux: WebKitGTK reads `WEBKIT_DISABLE_COMPOSITING_MODE` and
//!   `WEBKIT_DISABLE_DMABUF_RENDERER`.
//! - macOS: WKWebView exposes no supported switch, so the setting is reported as
//!   unsupported and the row is disabled.
//!
//! The variables are process-wide, so child processes would inherit them. Core
//! (and everything it launches: agents, terminals) is spawned with the values
//! this module overrode restored to the user's own (`restore_child_env`).
//! Commands the desktop shell launches directly (an external editor or terminal)
//! still inherit them.

use serde::Serialize;

use crate::profile;

const SENTINEL_FILE: &str = "hardware-acceleration-disabled";

/// Mirrors `app.windows[].additionalBrowserArgs` in the `tauri*.conf.json` files.
/// The environment variable replaces that value, so it must carry it too. A test
/// keeps the two in sync.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const CONFIGURED_WEBVIEW2_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareAccelerationStatus {
    /// The saved preference, applied on the next launch.
    enabled: bool,
    /// What this running process actually started with.
    active: bool,
    /// Whether this platform's webview can turn GPU rendering off.
    supported: bool,
}

fn sentinel_path() -> std::path::PathBuf {
    ryu_sidecar_runtime::layout::state_path(&profile::ryu_home_dir(), SENTINEL_FILE)
}

fn supported() -> bool {
    cfg!(any(target_os = "windows", target_os = "linux"))
}

fn preference_enabled() -> bool {
    !sentinel_path().exists()
}

static ACTIVE_AT_LAUNCH: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Each variable this process overrode, with the value it had before (`None`
/// when it was unset), so child processes can be given the user's own value.
static OVERRIDDEN_ENV: std::sync::OnceLock<Vec<(&'static str, Option<std::ffi::OsString>)>> =
    std::sync::OnceLock::new();

/// The variables to restore in a child process's environment: `Some` to set the
/// user's original value, `None` to remove one this process added. Empty while
/// hardware acceleration is on.
pub fn restore_child_env() -> &'static [(&'static str, Option<std::ffi::OsString>)] {
    OVERRIDDEN_ENV.get().map(Vec::as_slice).unwrap_or(&[])
}


/// Apply the saved preference to this process. Must run before any webview is
/// created; `run()` calls it before the Tauri builder.
pub fn apply_before_webview() {
    let enabled = !supported() || preference_enabled();
    // `active` is the preference this launch applied, so the settings row's
    // restart prompt clears after a restart even when the user's own
    // environment already disabled compositing.
    let _ = ACTIVE_AT_LAUNCH.set(enabled);
    if enabled {
        return;
    }
    #[allow(unused_mut)]
    let mut overridden = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let original = std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        let base = if existing.trim().is_empty() {
            CONFIGURED_WEBVIEW2_ARGS.to_owned()
        } else {
            existing
        };
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            format!("{base} --disable-gpu --disable-gpu-compositing"),
        );
        overridden.push(("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", original));
    }

    #[cfg(target_os = "linux")]
    {
        // An explicit value from the user's environment wins over the setting.
        for name in [
            "WEBKIT_DISABLE_COMPOSITING_MODE",
            "WEBKIT_DISABLE_DMABUF_RENDERER",
        ] {
            if std::env::var_os(name).is_none() {
                std::env::set_var(name, "1");
                overridden.push((name, None));
            }
        }
    }
    let _ = OVERRIDDEN_ENV.set(overridden);
}

#[tauri::command]
pub async fn get_hardware_acceleration() -> HardwareAccelerationStatus {
    HardwareAccelerationStatus {
        enabled: !supported() || preference_enabled(),
        active: ACTIVE_AT_LAUNCH.get().copied().unwrap_or(true),
        supported: supported(),
    }
}

/// Save the preference for the next launch. Does not restart: the caller owns
/// that prompt, so the user can finish what they were doing first.
#[tauri::command]
pub async fn set_hardware_acceleration(enabled: bool) -> Result<bool, String> {
    if !supported() {
        return Err("Hardware acceleration can't be turned off on this platform".to_owned());
    }
    let path = sentinel_path();
    if enabled {
        if let Err(error) = std::fs::remove_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(error.to_string());
            }
        }
    } else {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(
            &path,
            b"Ryu starts with hardware acceleration off while this file exists. Delete it to turn GPU rendering back on.\n",
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentinel_lives_in_the_state_dir() {
        let path = sentinel_path();
        assert_eq!(path.file_name().and_then(|name| name.to_str()), Some(SENTINEL_FILE));
        assert_eq!(
            path,
            ryu_sidecar_runtime::layout::state_path(&profile::ryu_home_dir(), SENTINEL_FILE)
        );
    }

    #[test]
    fn configured_webview2_args_match_every_tauri_config() {
        for config in [
            include_str!("../tauri.conf.json"),
            include_str!("../tauri.bot.conf.json"),
            include_str!("../tauri.standalone.conf.json"),
        ] {
            let parsed: serde_json::Value = serde_json::from_str(config).expect("tauri config");
            let windows = parsed["app"]["windows"].as_array().expect("app.windows");
            for window in windows {
                if let Some(args) = window.get("additionalBrowserArgs") {
                    assert_eq!(args.as_str(), Some(CONFIGURED_WEBVIEW2_ARGS));
                }
            }
        }
    }

    #[test]
    fn child_env_is_untouched_while_acceleration_is_on() {
        // `apply_before_webview` records overrides only when it turns GPU
        // rendering off; a process that never ran it restores nothing.
        if OVERRIDDEN_ENV.get().is_none() {
            assert!(restore_child_env().is_empty());
        }
    }
}
