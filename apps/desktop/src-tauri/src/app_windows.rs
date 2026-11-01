//! App-first and tear-off tab windows plus per-window view commands.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_decorum::WebviewWindowExt;

#[cfg(target_os = "macos")]
use crate::macos_window::apply_macos_titlebar_mask;
use crate::{tab_transfer, window_registry};

/// Monotonic counter for tear-off window labels, unique for the lifetime of the
/// process. A new window per increment (`tab-1`, `tab-2`, …) — labels must be
/// unique and Tauri rejects reuse of a live one.
static TAB_WINDOW_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Percent-encode a query-param value (UTF-8 bytes → %XX for anything outside the
/// RFC 3986 unreserved set). Dependency-free; the renderer's `URLSearchParams`
/// decodes it back to the original UTF-8 string.
fn encode_param(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn standalone_window_label(app_id: &str) -> String {
    use std::hash::{Hash, Hasher};

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    app_id.hash(&mut hasher);
    format!("standalone-app-{:016x}", hasher.finish())
}

fn valid_standalone_app_id(app_id: &str) -> bool {
    !app_id.is_empty()
        && app_id.len() <= 200
        && !app_id.starts_with('/')
        && !app_id.ends_with('/')
        && !app_id.contains("//")
        && app_id
            .split('/')
            .all(|segment| segment != "." && segment != "..")
        && app_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"@._/-".contains(&byte))
}

/// Open an app-first window backed by the current Desktop node. This is a host
/// projection only: it never installs, enables, disables, or uninstalls the
/// plugin, so its Companion keeps using the same Core-owned data as the main
/// Ryu interface.
#[tauri::command]
pub(crate) async fn open_standalone_app_window(
    app: tauri::AppHandle,
    app_id: String,
    title: String,
) -> Result<(), String> {
    let app_id = app_id.trim();
    if !valid_standalone_app_id(app_id) {
        return Err("invalid standalone app id".to_owned());
    }

    let label = standalone_window_label(app_id);
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let safe_title: String = title
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(120)
        .collect();
    let window_title = if safe_title.is_empty() {
        "Ryu App"
    } else {
        safe_title.as_str()
    };
    let query = format!("window=standalone-app&appId={}", encode_param(app_id));
    let url = if cfg!(debug_assertions) {
        let raw = format!("http://localhost:5173/?{query}");
        WebviewUrl::External(
            raw.parse()
                .map_err(|error| format!("bad standalone app url: {error}"))?,
        )
    } else {
        WebviewUrl::App(format!("index.html?{query}").into())
    };

    let window = WebviewWindowBuilder::new(&app, &label, url)
        .title(window_title)
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .center()
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .disable_drag_drop_handler()
        .zoom_hotkeys_enabled(true)
        .build()
        .map_err(|error| error.to_string())?;

    #[cfg(not(target_os = "macos"))]
    window
        .create_overlay_titlebar()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    if let Ok(ns_window) = window.ns_window() {
        apply_macos_titlebar_mask(ns_window);
    }

    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

/// Close the current app-first window without touching the app lifecycle.
#[tauri::command]
pub(crate) fn close_current_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

/// Open a tab in a separate OS window (browser-style "open in new window").
/// The new window loads the same app shell; the `window=tab` query seeds a single
/// tab focused on `conversation_id` and pinned to `node` (so a tab targeting a
/// remote node keeps targeting it). Conversation state is server-side, so the new
/// window simply re-fetches history by id. Closing this window never stops Core —
/// that is gated to the `main` window label in `on_window_event`.
#[tauri::command]
pub(crate) async fn open_tab_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    registry: tauri::State<'_, window_registry::WindowRegistry>,
    path: Option<String>,
    conversation_id: Option<String>,
    entity_key: Option<String>,
    node: Option<String>,
    title: Option<String>,
    transfer: Option<serde_json::Value>,
    drag_out: Option<bool>,
) -> Result<bool, String> {
    use std::sync::atomic::Ordering;

    let drop_position = if drag_out.unwrap_or(false) {
        let Some(position) = tab_transfer::outside_window(&window)? else {
            return Ok(false);
        };
        Some(position)
    } else {
        None
    };
    transfer
        .as_ref()
        .map(tab_transfer::validate_transfer)
        .transpose()?;
    let n = TAB_WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("tab-{n}");

    let mut params: Vec<String> = vec!["window=tab".to_string()];
    if transfer.is_some() {
        params.push("detached=1".to_string());
    }
    if let Some(ref p) = path {
        params.push(format!("path={}", encode_param(p)));
    }
    if let Some(ref c) = conversation_id {
        params.push(format!("conv={}", encode_param(c)));
    }
    if let Some(ref nd) = node {
        params.push(format!("node={}", encode_param(nd)));
    }
    if let Some(ref t) = title {
        params.push(format!("title={}", encode_param(t)));
    }
    let query = params.join("&");

    // Dev loads the Vite server (same origin as the main window, so the bearer
    // token in localStorage carries over); production loads the bundled shell.
    let url = if cfg!(debug_assertions) {
        let raw = format!("http://localhost:5173/?{query}");
        WebviewUrl::External(raw.parse().map_err(|e| format!("bad tab url: {e}"))?)
    } else {
        WebviewUrl::App(format!("index.html?{query}").into())
    };

    let mut builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(title.as_deref().unwrap_or("Ryu"))
        .inner_size(1100.0, 780.0)
        .min_inner_size(800.0, 600.0)
        .center()
        .decorations(false)
        .transparent(true)
        // Let the webview's own HTML5 drag-and-drop work (tab reordering in the
        // title bar) instead of Tauri intercepting it — mirrors the main window's
        // `dragDropEnabled: false` in tauri.conf.json.
        .disable_drag_drop_handler()
        .zoom_hotkeys_enabled(true)
        .on_navigation(tab_transfer::is_shell_navigation);
    if transfer.is_some() {
        builder = builder.visible(false);
    }
    let transfers = app.state::<tab_transfer::TabTransfers>();
    let ready = if let Some(payload) = transfer.as_ref() {
        Some(transfers.begin(&label, payload.clone())?)
    } else {
        None
    };
    let win = match builder.build() {
        Ok(win) => win,
        Err(error) => {
            transfers.remove(&label);
            return Err(error.to_string());
        }
    };
    let mut transfer_guard = transfer
        .as_ref()
        .map(|_| tab_transfer::TransferWindowGuard::new(&win));
    if let Some(position) = drop_position {
        // Position using native physical coordinates, so mixed DPI and displays
        // to the left of the primary screen do not inherit CSS-coordinate drift.
        tab_transfer::position_at_drop(&win, position);
    }

    // Mirror the main window's frameless overlay window controls on
    // Windows/Linux. macOS keeps its native traffic lights and does not need a
    // second injected titlebar layer.
    #[cfg(not(target_os = "macos"))]
    win.create_overlay_titlebar().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        // The titlebar plugin normally applies this on window-ready. Apply it
        // here too for freshly-created tear-off windows.
        if let Ok(ns_window) = win.ns_window() {
            apply_macos_titlebar_mask(ns_window);
        }
    }

    // Claim a seeded conversation before the renderer's first React effect. The
    // renderer replaces this revision-1 snapshot once it has mounted; this
    // shortens the duplicate-open race during a slow webview startup.
    if let Some(key) = entity_key.filter(|key| !key.is_empty()) {
        let seed_renderer_id = format!("native-seed:{label}");
        registry.register(
            &label,
            &seed_renderer_id,
            1,
            vec![window_registry::WindowTabRegistration { active: true, key }],
        )?;
    }

    if let Some(receiver) = ready {
        tab_transfer::wait_for_renderer(&win, receiver).await?;
    }

    // A newly-created WebviewWindow is not guaranteed to become the foreground
    // window on every platform, especially when the command was invoked from a
    // background tab renderer. Make the browser-style tear-off deterministic.
    win.show().map_err(|e| e.to_string())?;
    win.unminimize().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;

    if let Some(guard) = &mut transfer_guard {
        guard.commit();
    }
    Ok(true)
}

/// Toggle the WebView inspector (DevTools). Used by the global right-click menu.
/// Requires the `devtools` feature on the `tauri` dependency (enabled for
/// packaged builds so Settings → Developer Mode can open the inspector).
#[tauri::command]
pub(crate) fn toggle_devtools(window: tauri::WebviewWindow) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

/// Toggle the calling window between OS fullscreen and windowed — the Electron
/// `setFullScreen` analogue behind the global right-click menu's View group.
///
/// A command rather than the JS `WebviewWindow.setFullscreen()` API because
/// `core:window:allow-set-fullscreen` is not in `capabilities/default.json`, and
/// every capability there scopes to a fixed window label (`main`, `companion`),
/// so the `tab-{n}` windows `open_tab_window` spawns would be denied. Commands
/// registered in `generate_handler!` are not capability-gated (see
/// `toggle_devtools`), so this works from any window.
///
/// Returns the state the window ended up in, so callers do not need a second
/// (also gated) `is_fullscreen()` read to update their menu item.
#[tauri::command]
pub(crate) fn toggle_fullscreen(window: tauri::WebviewWindow) -> Result<bool, String> {
    let next = !window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(next).map_err(|e| e.to_string())?;
    Ok(next)
}

/// Read the calling window's fullscreen state. Same capability reasoning as
/// `toggle_fullscreen` — the JS `isFullscreen()` is granted for `main` only.
#[tauri::command]
pub(crate) fn is_fullscreen(window: tauri::WebviewWindow) -> Result<bool, String> {
    window.is_fullscreen().map_err(|e| e.to_string())
}
