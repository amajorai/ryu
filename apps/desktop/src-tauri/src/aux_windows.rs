//! Auxiliary windows: the companion overlay, live-media PiP, and Agent Browser stream status.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Create the companion overlay window if it does not exist, then show it.
/// If it already exists and is visible, hide it (toggle behaviour).
pub(crate) fn toggle_companion_window(app: &tauri::AppHandle) {
    match app.get_webview_window("companion") {
        Some(win) => {
            let visible = win.is_visible().unwrap_or(false);
            if visible {
                win.hide().ok();
            } else {
                win.show().ok();
                win.set_focus().ok();
            }
        }
        None => {
            // Companion window URL: the React app detects the window label and renders
            // the overlay shell. In dev we load from the Vite dev server; in production
            // from the embedded dist bundle.
            let url = if cfg!(debug_assertions) {
                WebviewUrl::External(
                    "http://localhost:5173"
                        .parse()
                        .expect("companion dev URL is valid"),
                )
            } else {
                WebviewUrl::App("index.html".into())
            };

            // Center the companion horizontally on the primary monitor. Display
            // widths vary widely (MacBook panels are 1512/1728/1800 wide, not
            // 1920), so a hardcoded 1920 mis-centers the window on most Macs.
            // Monitor size is in physical pixels but `position` is logical, so
            // divide by the scale factor. Fall back to the 1920 assumption if the
            // monitor can't be queried, anchoring near top-center either way.
            const COMPANION_WIDTH: f64 = 400.0;
            let companion_x = app
                .primary_monitor()
                .ok()
                .flatten()
                .map(|monitor| {
                    let logical_width = monitor.size().width as f64 / monitor.scale_factor();
                    (logical_width - COMPANION_WIDTH) / 2.0
                })
                .unwrap_or((1920.0 - COMPANION_WIDTH) / 2.0);

            match WebviewWindowBuilder::new(app, "companion", url)
                // English fallback until the webview mounts; `useAuxWindowTitle` localizes it.
                .title("Ryu Companion")
                .inner_size(COMPANION_WIDTH, 80.0)
                .position(companion_x, 40.0)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .zoom_hotkeys_enabled(true)
                .build()
            {
                Ok(win) => {
                    win.show().ok();
                    win.set_focus().ok();
                }
                Err(e) => {
                    tracing::error!("Failed to create companion window: {}", e);
                }
            }
        }
    }
}

/// Open the live-media picture-in-picture surface as a real OS window.
///
/// Browser Picture-in-Picture is intentionally limited to video elements and is
/// not consistently available in embedded webviews. A Tauri window gives the
/// browser-tab screenshots and the VNC canvas the same always-on-top behaviour as
/// a recording, while the renderer keeps all three sources in one shared channel.
#[tauri::command]
pub(crate) fn open_media_pip(app: tauri::AppHandle) -> Result<(), String> {
    const LABEL: &str = "media-pip";

    if let Some(win) = app.get_webview_window(LABEL) {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = if cfg!(debug_assertions) {
        WebviewUrl::External(
            "http://localhost:5173/?window=media-pip"
                .parse()
                .map_err(|e| format!("bad media PiP URL: {e}"))?,
        )
    } else {
        WebviewUrl::App("index.html?window=media-pip".into())
    };

    let win = WebviewWindowBuilder::new(&app, LABEL, url)
        // English fallback until the webview mounts; `useAuxWindowTitle` localizes it.
        .title("Ryu Live Media")
        .inner_size(420.0, 280.0)
        .min_inner_size(280.0, 180.0)
        .center()
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .zoom_hotkeys_enabled(true)
        .build()
        .map_err(|e| e.to_string())?;

    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// Close the live-media picture-in-picture surface, if it is open.
#[tauri::command]
pub(crate) fn close_media_pip(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("media-pip") {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub(crate) struct AgentBrowserStreamStatus {
    connected: bool,
    enabled: bool,
    port: Option<u16>,
    screencasting: bool,
}

/// Read Agent Browser's session-scoped stream status. The CLI is the supported
/// control surface for the daemon; the renderer only receives the localhost
/// WebSocket frames after this fixed, read-only probe says a port is available.
#[tauri::command]
pub(crate) fn agent_browser_stream_status() -> Result<AgentBrowserStreamStatus, String> {
    let binary =
        which::which("agent-browser").map_err(|e| format!("agent-browser is unavailable: {e}"))?;
    let output = std::process::Command::new(binary)
        .args(["stream", "status", "--json"])
        .output()
        .map_err(|e| format!("couldn't query Agent Browser streaming: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let envelope: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Agent Browser returned invalid stream status: {e}"))?;
    let data = envelope
        .get("data")
        .ok_or_else(|| "Agent Browser stream status did not include data".to_string())?;
    Ok(AgentBrowserStreamStatus {
        connected: data
            .get("connected")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        enabled: data
            .get("enabled")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        port: data
            .get("port")
            .and_then(serde_json::Value::as_u64)
            .and_then(|port| u16::try_from(port).ok()),
        screencasting: data
            .get("screencasting")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}
