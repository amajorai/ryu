// OS-level notifications for the desktop shell, with the sending agent's avatar.
//
// The webview `Notification` API is missing or inert in WKWebView (macOS) and
// WebView2 (Windows), and `tauri-plugin-notification` forwards its `icon` only to
// the freedesktop `app_icon` field, which macOS and Windows ignore. This command
// talks to `notify-rust` directly and passes the avatar as an image file, which
// each OS renders the way chat apps do: the image beside the text on macOS
// (`contentImage`), an inline toast image on Windows, and the leading icon plus
// the `image-path` hint on Linux.
//
// The frontend rasterises the avatar (uploaded image, emoji, icon, DiceBear…)
// to a PNG and sends its bytes; they are written to a content-addressed file in
// the app cache, so a repeat sender reuses one file. A click on the notification
// is reported back as the `os-notification-clicked` event carrying the caller's
// tag, so the shell can route to the conversation or inbox it came from.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};

/// Event emitted when the user clicks a notification shown by this module.
pub const CLICK_EVENT: &str = "os-notification-clicked";

/// Mirrors the webview limits in `packages/app-host` so a notification never
/// carries more text than the OS can show.
const MAX_TITLE_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 2000;
/// A 256px PNG avatar is well under this; anything larger is not an avatar.
const MAX_IMAGE_BYTES: usize = 512 * 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsNotificationInput {
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    /// Base64 PNG (no `data:` prefix) of the sender's avatar.
    #[serde(default)]
    pub image_png_base64: Option<String>,
    /// Opaque routing key echoed back in [`CLICK_EVENT`].
    #[serde(default)]
    pub tag: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
struct ClickPayload {
    tag: Option<String>,
}

fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// Decode and validate the avatar bytes. Only PNG is accepted: every OS
/// notification server reads it, and the signature check keeps arbitrary
/// payloads out of the cache directory.
fn decode_avatar_png(encoded: &str) -> Result<Vec<u8>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|_| "Notification image is not valid base64.".to_string())?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("Notification image is too large.".to_string());
    }
    if !bytes.starts_with(PNG_SIGNATURE) {
        return Err("Notification image must be a PNG.".to_string());
    }
    Ok(bytes)
}

/// Content-addressed file name, so the same avatar is written once.
fn avatar_file_name(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{}.png", hex::encode(&digest[..16]))
}

fn write_avatar(cache_dir: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = cache_dir.join("notification-avatars");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let path = dir.join(avatar_file_name(bytes));
    if !path.exists() {
        std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    }
    Ok(path)
}

fn build_notification(
    identifier: &str,
    input: &OsNotificationInput,
    image_path: Option<&Path>,
) -> notify_rust::Notification {
    let mut notification = notify_rust::Notification::new();
    notification.summary(&truncate_chars(&input.title, MAX_TITLE_CHARS));
    if let Some(body) = input.body.as_deref().filter(|body| !body.is_empty()) {
        notification.body(&truncate_chars(body, MAX_BODY_CHARS));
    }
    match image_path.and_then(Path::to_str) {
        Some(path) => {
            notification.image_path(path);
            // Linux notification servers draw `app_icon` as the leading
            // picture; macOS and Windows ignore it.
            notification.icon(path);
        }
        None => {
            notification.auto_icon();
        }
    }
    // A click is reported by the server only for a notification offering the
    // `default` action (Desktop Notifications Specification).
    #[cfg(all(unix, not(target_os = "macos")))]
    notification.action("default", "");
    #[cfg(windows)]
    {
        // Same rule as tauri-plugin-notification: the AppUserModelID only
        // resolves for the installed app, not a `target/` build.
        if let Ok(exe) = tauri::utils::platform::current_exe() {
            let in_target = exe.parent().is_some_and(|dir| {
                dir.ends_with(Path::new("target").join("debug"))
                    || dir.ends_with(Path::new("target").join("release"))
            });
            if !in_target {
                notification.app_id(identifier);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = notify_rust::set_application(if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            identifier
        });
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = identifier;
    notification
}

/// Show an OS notification. Never prompts: desktop OSes gate notifications in
/// their own settings, which the onboarding step links to.
#[tauri::command]
pub fn show_os_notification(
    app: tauri::AppHandle,
    input: OsNotificationInput,
) -> Result<(), String> {
    if input.title.trim().is_empty() {
        return Err("Notification title is required.".to_string());
    }
    let image_path = match input.image_png_base64.as_deref() {
        Some(encoded) if !encoded.is_empty() => {
            let bytes = decode_avatar_png(encoded)?;
            let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
            Some(write_avatar(&cache_dir, &bytes)?)
        }
        _ => None,
    };
    let identifier = app.config().identifier.clone();
    let notification = build_notification(&identifier, &input, image_path.as_deref());
    let tag = input.tag;
    // Waiting for the click blocks, so each notification gets its own thread.
    std::thread::Builder::new()
        .name("os-notification".into())
        .spawn(move || {
            let Ok(handle) = notification.show() else {
                return;
            };
            let _ = handle.wait_for_response(|response: &notify_rust::NotificationResponse| {
                if matches!(response, notify_rust::NotificationResponse::Default) {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    let _ = app.emit(CLICK_EVENT, ClickPayload { tag });
                }
            });
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(extra: &[u8]) -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend_from_slice(extra);
        bytes
    }

    #[test]
    fn avatar_must_be_a_bounded_png() {
        let ok = base64::engine::general_purpose::STANDARD.encode(png(b"data"));
        assert_eq!(decode_avatar_png(&ok).unwrap(), png(b"data"));

        let jpeg = base64::engine::general_purpose::STANDARD.encode(b"\xff\xd8\xff\xe0");
        assert!(decode_avatar_png(&jpeg).is_err());
        assert!(decode_avatar_png("not base64!").is_err());

        let huge =
            base64::engine::general_purpose::STANDARD.encode(png(&vec![0u8; MAX_IMAGE_BYTES]));
        assert!(decode_avatar_png(&huge).is_err());
    }

    #[test]
    fn avatar_files_are_content_addressed_and_reused() {
        let dir = tempfile::tempdir().unwrap();
        let first = write_avatar(dir.path(), &png(b"a")).unwrap();
        let again = write_avatar(dir.path(), &png(b"a")).unwrap();
        let other = write_avatar(dir.path(), &png(b"b")).unwrap();
        assert_eq!(first, again);
        assert_ne!(first, other);
        assert!(first.starts_with(dir.path().join("notification-avatars")));
        assert_eq!(std::fs::read(&first).unwrap(), png(b"a"));
    }

    #[test]
    fn text_is_truncated_to_os_limits() {
        assert_eq!(truncate_chars("héllo", 2), "hé");
        assert_eq!(truncate_chars(&"x".repeat(500), MAX_TITLE_CHARS).len(), 120);
    }
}
