//! Native window backdrop for the Desktop shell (main Ryu and the standalone
//! Ryu Bot build share this code).
//!
//! The web layer owns the "Liquid Glass" appearance preference
//! (`ryu:liquid-glass`) and reports it through [`set_liquid_glass`]. On macOS 26+
//! an enabled preference installs AppKit's `NSGlassEffectView` below the webview;
//! older macOS, or a disabled preference, keeps the semantic `NSVisualEffectView`
//! Sidebar vibrancy, so the independent sidebar/window transparency toggles keep
//! revealing a native backdrop either way. Disabling Liquid Glass only removes the
//! glass material.
//!
//! The current mode and each window's last corner radius live in process globals
//! so [`set_window_corner_radius`] and window creation re-apply the right material.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

/// Corner radius a window's backdrop uses until the web shell reports its own.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const DEFAULT_CORNER_RADIUS: f64 = 32.0;

/// Liquid Glass is on unless the web layer reports the preference as disabled.
static LIQUID_GLASS_ENABLED: AtomicBool = AtomicBool::new(true);

fn corner_radii() -> &'static Mutex<HashMap<String, f64>> {
    static RADII: OnceLock<Mutex<HashMap<String, f64>>> = OnceLock::new();
    RADII.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn liquid_glass_enabled() -> bool {
    LIQUID_GLASS_ENABLED.load(Ordering::SeqCst)
}

/// Store the preference and report whether it differs from the previous value.
fn store_liquid_glass(enabled: bool) -> bool {
    LIQUID_GLASS_ENABLED.swap(enabled, Ordering::SeqCst) != enabled
}

fn validate_corner_radius(radius: f64) -> Result<(), String> {
    if !radius.is_finite() || !(0.0..=256.0).contains(&radius) {
        return Err("invalid window corner radius".to_owned());
    }
    Ok(())
}

fn remember_corner_radius(label: &str, radius: f64) {
    if let Ok(mut radii) = corner_radii().lock() {
        radii.insert(label.to_owned(), radius);
    }
}

/// Drop a destroyed window's remembered corner radius.
pub(crate) fn forget_window(label: &str) {
    if let Ok(mut radii) = corner_radii().lock() {
        radii.remove(label);
    }
}

/// The last corner radius the web shell reported for `label`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn corner_radius_for(label: &str) -> f64 {
    corner_radii()
        .lock()
        .ok()
        .and_then(|radii| radii.get(label).copied())
        .unwrap_or(DEFAULT_CORNER_RADIUS)
}

/// Match the native backdrop to the one visible CSS window silhouette.
#[tauri::command]
pub(crate) fn set_window_corner_radius(window: tauri::Window, radius: f64) -> Result<(), String> {
    validate_corner_radius(radius)?;
    remember_corner_radius(window.label(), radius);
    #[cfg(target_os = "macos")]
    {
        let target = window.clone();
        window
            .run_on_main_thread(move || apply_backdrop(&target))
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    Ok(())
}

/// Record the "Liquid Glass" appearance preference and re-apply every open
/// window's backdrop. A no-op outside macOS.
#[tauri::command]
pub(crate) fn set_liquid_glass(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let changed = store_liquid_glass(enabled);
    #[cfg(target_os = "macos")]
    if changed {
        use tauri::Manager;
        for webview_window in app.webview_windows().into_values() {
            let window = webview_window.as_ref().window();
            let target = window.clone();
            // One window failing to schedule must not leave the rest stale.
            if let Err(error) = window.run_on_main_thread(move || apply_backdrop(&target)) {
                tracing::debug!("macOS backdrop refresh unavailable: {}", error);
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, changed);
    Ok(())
}

/// Install the backdrop the current mode calls for below `window`'s webview.
/// Must run on the main thread (window-ready callbacks and `run_on_main_thread`).
#[cfg(target_os = "macos")]
pub(crate) fn apply_backdrop<R: tauri::Runtime>(window: &tauri::Window<R>) {
    use window_vibrancy::{
        apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
    };

    let radius = corner_radius_for(window.label());
    let content_view = match window.ns_view() {
        Ok(view) if !view.is_null() => view as cocoa::base::id,
        _ => return,
    };
    // SAFETY: `content_view` is the live AppKit view behind this window's handle
    // and every caller runs on the main thread.
    unsafe { native::remove_glass_view(content_view) };
    let _ = clear_vibrancy(window);

    // SAFETY: as above.
    if liquid_glass_enabled() && unsafe { native::install_glass_view(content_view, radius) } {
        return;
    }
    if let Err(error) = apply_vibrancy(
        window,
        NSVisualEffectMaterial::Sidebar,
        Some(NSVisualEffectState::FollowsWindowActiveState),
        Some(radius),
    ) {
        tracing::debug!("macOS vibrancy backdrop unavailable: {}", error);
    }
}

#[cfg(target_os = "macos")]
mod native {
    use cocoa::base::{id, nil, BOOL, NO};
    use cocoa::foundation::{NSRect, NSString, NSUInteger};
    use objc::runtime::Class;
    use objc::{msg_send, sel, sel_impl};

    /// `NSView.identifier` the installed glass view carries, so it can be found
    /// and removed again without holding a pointer across windows.
    const GLASS_VIEW_IDENTIFIER: &str = "ryu-liquid-glass";
    /// `NSWindowOrderingMode.below`.
    const NS_WINDOW_BELOW: isize = -1;
    /// `NSViewWidthSizable | NSViewHeightSizable`.
    const AUTORESIZE_FILL: NSUInteger = 2 | 16;

    unsafe fn identifier() -> id {
        let value: id = NSString::alloc(nil).init_str(GLASS_VIEW_IDENTIFIER);
        msg_send![value, autorelease]
    }

    /// Remove every glass view previously installed in `content_view`.
    pub(super) unsafe fn remove_glass_view(content_view: id) {
        let subviews: id = msg_send![content_view, subviews];
        if subviews == nil {
            return;
        }
        // Copy so removal does not mutate the array being walked.
        let subviews: id = msg_send![subviews, copy];
        let wanted = identifier();
        let count: NSUInteger = msg_send![subviews, count];
        for index in 0..count {
            let view: id = msg_send![subviews, objectAtIndex: index];
            let current: id = msg_send![view, identifier];
            if current == nil {
                continue;
            }
            let matches: BOOL = msg_send![current, isEqualToString: wanted];
            if matches != NO {
                let () = msg_send![view, removeFromSuperview];
            }
        }
        let () = msg_send![subviews, release];
    }

    /// Install an `NSGlassEffectView` filling `content_view`, below the webview.
    /// Returns `false` when the class is missing (macOS before 26).
    pub(super) unsafe fn install_glass_view(content_view: id, radius: f64) -> bool {
        let Some(class) = Class::get("NSGlassEffectView") else {
            return false;
        };
        let bounds: NSRect = msg_send![content_view, bounds];
        let glass: id = msg_send![class, alloc];
        let glass: id = msg_send![glass, initWithFrame: bounds];
        if glass == nil {
            return false;
        }
        let () = msg_send![glass, setCornerRadius: radius];
        let () = msg_send![glass, setAutoresizingMask: AUTORESIZE_FILL];
        let () = msg_send![glass, setIdentifier: identifier()];
        let () = msg_send![
            content_view,
            addSubview: glass
            positioned: NS_WINDOW_BELOW
            relativeTo: nil
        ];
        // The superview retains it now.
        let () = msg_send![glass, release];
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corner_radius_validation_rejects_out_of_range_values() {
        assert!(validate_corner_radius(0.0).is_ok());
        assert!(validate_corner_radius(256.0).is_ok());
        assert!(validate_corner_radius(-1.0).is_err());
        assert!(validate_corner_radius(256.5).is_err());
        assert!(validate_corner_radius(f64::NAN).is_err());
        assert!(validate_corner_radius(f64::INFINITY).is_err());
    }

    #[test]
    fn corner_radius_is_remembered_per_window() {
        assert_eq!(
            corner_radius_for("macos-glass-test-unknown"),
            DEFAULT_CORNER_RADIUS
        );
        remember_corner_radius("macos-glass-test-a", 12.0);
        remember_corner_radius("macos-glass-test-b", 0.0);
        assert_eq!(corner_radius_for("macos-glass-test-a"), 12.0);
        assert_eq!(corner_radius_for("macos-glass-test-b"), 0.0);
        forget_window("macos-glass-test-a");
        assert_eq!(
            corner_radius_for("macos-glass-test-a"),
            DEFAULT_CORNER_RADIUS
        );
    }

    #[test]
    fn liquid_glass_mode_round_trips() {
        let original = liquid_glass_enabled();
        store_liquid_glass(false);
        assert!(!liquid_glass_enabled());
        assert!(!store_liquid_glass(false), "same value is not a change");
        assert!(store_liquid_glass(true), "flipping the value is a change");
        assert!(liquid_glass_enabled());
        store_liquid_glass(original);
    }
}
