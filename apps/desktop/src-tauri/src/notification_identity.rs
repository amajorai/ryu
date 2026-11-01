//! Registers the app's notification identity on Windows so toasts carry the
//! same icon and name as the taskbar.
//!
//! A Windows toast draws its header icon and app name from whatever the
//! AppUserModelID it is sent under resolves to. For an unpackaged app that is
//! either a Start-menu shortcut stamped with the ID or the
//! `HKCU\Software\Classes\AppUserModelId\<id>` registry key. The NSIS installer
//! stamps shortcuts only on a fresh install (update mode skips them), so
//! installs that predate the `dev.ryu.desktop` → `ai.amajor.ryu.desktop`
//! identifier rename still carry the old ID, and toasts under the new one
//! render with a blank generic icon. `target/` dev builds have no shortcut at
//! all and fell back to PowerShell's identity.
//!
//! At startup this writes the window icon (the exact image the taskbar shows)
//! to a PNG in the app cache and registers it, with the product name, under
//! the bundle identifier. The registration is per-user and idempotent, so it
//! is refreshed on every launch and follows an icon change.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use sha2::{Digest, Sha256};

/// Set once the identity is registered, so notifications can use the bundle
/// identifier even from a build that has no installer shortcut.
#[cfg_attr(not(windows), allow(dead_code))]
static REGISTERED: AtomicBool = AtomicBool::new(false);

/// Whether this process registered its AppUserModelID with the OS.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn is_registered() -> bool {
    REGISTERED.load(Ordering::Relaxed)
}

/// Registry key (under `HKEY_CURRENT_USER`) Windows reads for an unpackaged
/// app's toast name and icon.
pub(crate) fn registry_subkey(identifier: &str) -> String {
    format!(r"Software\Classes\AppUserModelId\{identifier}")
}

/// Encode an RGBA8 image as PNG.
pub(crate) fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let expected = (width as usize) * (height as usize) * 4;
    if width == 0 || height == 0 || rgba.len() != expected {
        return Err("Icon pixel data does not match its dimensions.".to_string());
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Write the icon PNG under a content-addressed name. Windows caches toast
/// icons by URI, so a changed icon must land at a new path to show up.
pub(crate) fn write_icon(cache_dir: &Path, png_bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = cache_dir.join("notification-identity");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let digest = Sha256::digest(png_bytes);
    let path = dir.join(format!("app-icon-{}.png", hex::encode(&digest[..8])));
    if !path.exists() {
        std::fs::write(&path, png_bytes).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

#[cfg(windows)]
fn set_registry_string(subkey: &str, name: &str, value: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};

    let data: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    let byte_len = u32::try_from(data.len() * 2).map_err(|e| e.to_string())?;
    // SAFETY: `data` is a live, NUL-terminated UTF-16 buffer of `byte_len`
    // bytes; RegSetKeyValueW copies it and creates the subkey if missing.
    unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            &HSTRING::from(subkey),
            &HSTRING::from(name),
            REG_SZ.0,
            Some(data.as_ptr().cast()),
            byte_len,
        )
    }
    .ok()
    .map_err(|e| e.to_string())
}

/// Register the app's toast name and icon. Never fails startup: on error the
/// notification falls back to the installer shortcut, as before.
pub(crate) fn register(app: &tauri::AppHandle) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let result = (|| -> Result<(), String> {
            let icon = app
                .default_window_icon()
                .ok_or_else(|| "No window icon is bundled.".to_string())?;
            let png_bytes = encode_png(icon.rgba(), icon.width(), icon.height())?;
            let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
            let icon_path = write_icon(&cache_dir, &png_bytes)?;
            let config = app.config();
            let subkey = registry_subkey(&config.identifier);
            let display_name = config
                .product_name
                .clone()
                .unwrap_or_else(|| "Ryu".to_string());
            set_registry_string(&subkey, "DisplayName", &display_name)?;
            set_registry_string(&subkey, "IconUri", &icon_path.to_string_lossy())?;
            Ok(())
        })();
        match result {
            Ok(()) => REGISTERED.store(true, Ordering::Relaxed),
            Err(error) => log::warn!("Could not register the notification identity: {error}"),
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_subkey_is_keyed_by_identifier() {
        assert_eq!(
            registry_subkey("ai.amajor.ryu.desktop"),
            r"Software\Classes\AppUserModelId\ai.amajor.ryu.desktop"
        );
    }

    #[test]
    fn encodes_rgba_as_a_decodable_png() {
        let rgba = [255, 0, 0, 255, 0, 255, 0, 128];
        let bytes = encode_png(&rgba, 2, 1).unwrap();
        let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (2, 1));
        assert_eq!(&buf[..info.buffer_size()], &rgba);
    }

    #[test]
    fn rejects_mismatched_pixel_data() {
        assert!(encode_png(&[0; 4], 2, 1).is_err());
        assert!(encode_png(&[], 0, 0).is_err());
    }

    #[test]
    fn icon_file_is_content_addressed() {
        let dir = tempfile::tempdir().unwrap();
        let first = write_icon(dir.path(), b"one").unwrap();
        let again = write_icon(dir.path(), b"one").unwrap();
        let other = write_icon(dir.path(), b"two").unwrap();
        assert_eq!(first, again);
        assert_ne!(first, other);
        assert_eq!(std::fs::read(&first).unwrap(), b"one");
    }
}
