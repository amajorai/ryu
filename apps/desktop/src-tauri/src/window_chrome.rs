//! Native window chrome: the macOS titlebar mask, traffic-light placement,
//! and the AppKit backdrop installed on every window.

#[cfg(target_os = "macos")]
use crate::{macos_glass, standalone};

/// Restore the macOS native title-bar buttons for the transparent shell.
///
/// Our windows use `decorations: false` so Windows/Linux can draw decorum's
/// custom HTML window controls. On macOS, a borderless window otherwise has no
/// native controls, so re-add the titled style mask and hide the title bar's
/// title/background. The native traffic lights then remain the only macOS shell
/// layer; decorum is not loaded on this platform.
///
/// `ns_window` is the raw `NSWindow` pointer from `WebviewWindow::ns_window()`.

#[cfg(target_os = "macos")]
pub(crate) fn apply_macos_titlebar_mask(ns_window: *mut std::ffi::c_void) {
    use cocoa::appkit::{NSColor, NSWindow, NSWindowStyleMask, NSWindowTitleVisibility};
    use cocoa::base::{id, nil, NO, YES};
    if ns_window.is_null() {
        return;
    }
    let ns_window = ns_window as id;
    // SAFETY: `ns_window` is the live `NSWindow` owned by this Tauri window, and
    // window-ready callbacks run on the main thread.
    unsafe {
        let mask = NSWindowStyleMask::NSTitledWindowMask
            | NSWindowStyleMask::NSClosableWindowMask
            | NSWindowStyleMask::NSMiniaturizableWindowMask
            | NSWindowStyleMask::NSResizableWindowMask
            | NSWindowStyleMask::NSFullSizeContentViewWindowMask;
        ns_window.setStyleMask_(mask);
        ns_window.setTitlebarAppearsTransparent_(YES);
        ns_window.setTitleVisibility_(NSWindowTitleVisibility::NSWindowTitleHidden);
        ns_window.setOpaque_(NO);
        ns_window.setBackgroundColor_(NSColor::clearColor(nil));
        ns_window.setHasShadow_(NO);
    }
    position_macos_traffic_lights(ns_window.cast());
}

#[cfg(target_os = "macos")]
pub(crate) fn position_macos_traffic_lights(ns_window: *mut std::ffi::c_void) {
    use cocoa::appkit::{NSView, NSWindow, NSWindowButton, NSWindowStyleMask};
    use cocoa::base::id;
    use cocoa::foundation::NSRect;
    use objc::{msg_send, sel, sel_impl};
    if ns_window.is_null() {
        return;
    }
    let ns_window = ns_window as id;
    // AppKit owns the titlebar during fullscreen; preserve its style and layout.
    unsafe {
        if ns_window
            .styleMask()
            .contains(NSWindowStyleMask::NSFullScreenWindowMask)
        {
            return;
        }
        let buttons = [
            ns_window.standardWindowButton_(NSWindowButton::NSWindowCloseButton),
            ns_window.standardWindowButton_(NSWindowButton::NSWindowMiniaturizeButton),
            ns_window.standardWindowButton_(NSWindowButton::NSWindowZoomButton),
        ];
        if buttons.iter().any(|button| button.is_null()) {
            return;
        }
        let parent = buttons[0].superview();
        if parent.is_null() || parent.superview().is_null() {
            return;
        }
        let container = parent.superview();
        let (x, y) = if standalone::enabled() {
            (12.0, 16.0)
        } else {
            (28.0, 39.4)
        };
        let button_height = NSView::frame(buttons[0]).size.height;
        let height = button_height + y;
        let mut frame = NSView::frame(container);
        frame.size.height = height;
        frame.origin.y = NSView::frame(ns_window).size.height - height;
        let _: () = msg_send![container, setFrame: frame];
        for (index, button) in buttons.into_iter().enumerate() {
            let mut frame: NSRect = NSView::frame(button);
            frame.origin.x = x + index as f64 * 20.0;
            frame.origin.y = (height - button_height) / 2.0 - 4.0;
            button.setFrameOrigin(frame.origin);
        }
    }
}

/// Install one semantic AppKit backdrop below the webview. The web shell stays
/// opaque by default; the frontend's independent sidebar/window attributes
/// decide which surfaces reveal this layer. `macos_glass` picks Liquid Glass
/// (macOS 26+, preference on) or the Sidebar vibrancy fallback.
#[cfg(target_os = "macos")]
pub(crate) fn apply_macos_vibrancy<R: tauri::Runtime>(window: &tauri::Window<R>) {
    macos_glass::apply_backdrop(window);
}

/// Tauri plugin that restores the native macOS title bar mask on every window
/// as soon as it is ready. See [`apply_macos_titlebar_mask`].
#[cfg(target_os = "macos")]
pub(crate) fn macos_titlebar_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("ryu-macos-titlebar")
        .on_window_ready(|win| {
            if let Ok(ns_window) = win.ns_window() {
                apply_macos_titlebar_mask(ns_window);
            }
            apply_macos_vibrancy(&win);
        })
        .build()
}
