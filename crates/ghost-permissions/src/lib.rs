//! ghost-permissions: the single source of truth for the OS capabilities the
//! Ghost automation stack needs — **UI automation** (driving other apps via the
//! accessibility tree / synthetic input) and **screen capture** (visual
//! grounding). Every entry point — the desktop app, the `ghost` CLI, Core, and
//! the ghost sidecar — depends on this crate so there is exactly one
//! implementation per platform.
//!
//! Platform reality differs sharply, and this API is honest about it rather than
//! pretending every OS has macOS-style toggles:
//!
//! - **macOS** gates both behind TCC. `granted` maps to `AXIsProcessTrusted` /
//!   `CGPreflightScreenCaptureAccess`; `request` surfaces the system prompt and
//!   registers the app in System Settings. A fresh grant only applies after the
//!   process restarts. `required` is always true.
//! - **Windows** needs no per-app grant for DXGI/GDI capture or UI Automation, so
//!   `granted` is true and `required` is false. (Driving *elevated* windows still
//!   needs an elevated/UIAccess process, but that is not a TCC-style toggle.)
//! - **Linux/X11** needs no grant (XTEST + X11 capture), so `granted` is true and
//!   `required` is false. Under **Wayland** global capture and input are mediated
//!   by the compositor's portals, which the X11 backend cannot use, so `granted`
//!   is false and `required` is true — the user must approve through their
//!   compositor's screen-sharing UI (there is no universal deep-link to drive).

/// A capability the automation stack depends on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Capability {
    /// Driving other apps: accessibility tree reads + synthetic input.
    Accessibility,
    /// Capturing the screen for visual grounding.
    ScreenRecording,
    /// Observing global keyboard/mouse input — Shadow's input capture and Ghost's
    /// learn mode. (macOS: Input Monitoring / IOHID listen access.)
    InputMonitoring,
}

/// Every capability, in a stable order — for setup/doctor flows that iterate.
pub const ALL: [Capability; 3] = [
    Capability::Accessibility,
    Capability::ScreenRecording,
    Capability::InputMonitoring,
];

impl Capability {
    /// Human-readable name as it appears in the macOS System Settings pane.
    pub fn label(self) -> &'static str {
        match self {
            Capability::Accessibility => "Accessibility",
            Capability::ScreenRecording => "Screen Recording",
            Capability::InputMonitoring => "Input Monitoring",
        }
    }
}

/// Whether the current OS gates this capability behind a user-grantable
/// permission at all. When false, `granted` is always true and the UI should
/// show "no setup needed" instead of a Grant button.
pub fn required(cap: Capability) -> bool {
    platform::required(cap)
}

/// Whether the capability is currently granted to this process. Never prompts —
/// safe to poll (e.g. on a settings screen). Returns true on platforms that do
/// not gate the capability.
pub fn granted(cap: Capability) -> bool {
    platform::granted(cap)
}

/// Surface the OS permission prompt for this capability and register the process
/// in the relevant settings pane. Returns whether it is already granted. A fresh
/// grant only takes effect after the process restarts. No-op (returns `granted`)
/// where the OS exposes no programmatic request.
pub fn request(cap: Capability) -> bool {
    platform::request(cap)
}

// Ergonomic named wrappers — these are the names callers across the workspace
// use, kept stable so re-exports (e.g. from ghost-eyes) don't churn.
pub fn accessibility_granted() -> bool {
    granted(Capability::Accessibility)
}
pub fn request_accessibility() -> bool {
    request(Capability::Accessibility)
}
pub fn screen_recording_granted() -> bool {
    granted(Capability::ScreenRecording)
}
pub fn request_screen_recording() -> bool {
    request(Capability::ScreenRecording)
}
pub fn input_monitoring_granted() -> bool {
    granted(Capability::InputMonitoring)
}
pub fn request_input_monitoring() -> bool {
    request(Capability::InputMonitoring)
}

// ── macOS ─────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod platform {
    use super::Capability;
    use std::ffi::c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    #[link(name = "CoreGraphics", kind = "framework")]
    #[link(name = "CoreFoundation", kind = "framework")]
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
        fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            num_values: i64,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *const c_void;
        fn CFRelease(cf: *const c_void);
        // IOHID access (Input Monitoring). Check returns an IOHIDAccessType
        // (0 = granted, 1 = denied, 2 = unknown); Request prompts and registers
        // the app under System Settings > Privacy & Security > Input Monitoring.
        fn IOHIDCheckAccess(request: u32) -> u32;
        fn IOHIDRequestAccess(request: u32) -> bool;
        static kAXTrustedCheckOptionPrompt: *const c_void;
        static kCFBooleanTrue: *const c_void;
    }

    // kIOHIDRequestTypeListenEvent — observing input (not posting it).
    const IOHID_REQUEST_LISTEN: u32 = 1;
    // kIOHIDAccessTypeGranted.
    const IOHID_ACCESS_GRANTED: u32 = 0;

    pub fn required(_cap: Capability) -> bool {
        true
    }

    pub fn granted(cap: Capability) -> bool {
        match cap {
            Capability::Accessibility => unsafe { AXIsProcessTrusted() },
            Capability::ScreenRecording => unsafe { CGPreflightScreenCaptureAccess() },
            Capability::InputMonitoring => unsafe {
                IOHIDCheckAccess(IOHID_REQUEST_LISTEN) == IOHID_ACCESS_GRANTED
            },
        }
    }

    pub fn request(cap: Capability) -> bool {
        match cap {
            Capability::Accessibility => unsafe {
                let key = kAXTrustedCheckOptionPrompt;
                let value = kCFBooleanTrue;
                let options = CFDictionaryCreate(
                    std::ptr::null(),
                    &key,
                    &value,
                    1,
                    std::ptr::null(),
                    std::ptr::null(),
                );
                let trusted = AXIsProcessTrustedWithOptions(options);
                if !options.is_null() {
                    CFRelease(options);
                }
                trusted
            },
            Capability::ScreenRecording => unsafe { CGRequestScreenCaptureAccess() },
            Capability::InputMonitoring => unsafe { IOHIDRequestAccess(IOHID_REQUEST_LISTEN) },
        }
    }
}

// ── Windows ───────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod platform {
    use super::Capability;

    // DXGI/GDI screen capture and UI Automation require no per-app TCC-style
    // grant on Windows. (Automating elevated windows needs an elevated/UIAccess
    // process — a separate concern, not a user-toggled permission.)
    pub fn required(_cap: Capability) -> bool {
        false
    }
    pub fn granted(_cap: Capability) -> bool {
        true
    }
    pub fn request(_cap: Capability) -> bool {
        true
    }
}

// ── Linux ─────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod platform {
    use super::Capability;

    /// True when running under a Wayland session, where global screen capture and
    /// input go through compositor portals the X11 backend cannot use.
    fn is_wayland() -> bool {
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            return true;
        }
        std::env::var("XDG_SESSION_TYPE")
            .map(|t| t.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false)
    }

    // X11 needs no grant; Wayland mediates these through the compositor, which the
    // X11-based backend cannot satisfy — surface that as required-but-not-granted.
    pub fn required(_cap: Capability) -> bool {
        is_wayland()
    }
    pub fn granted(_cap: Capability) -> bool {
        !is_wayland()
    }
    pub fn request(cap: Capability) -> bool {
        // No universal programmatic portal trigger here; report current state so
        // callers can guide the user to their compositor's screen-sharing UI.
        granted(cap)
    }
}

// ── Other platforms ───────────────────────────────────────────────────────────

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod platform {
    use super::Capability;
    pub fn required(_cap: Capability) -> bool {
        false
    }
    pub fn granted(_cap: Capability) -> bool {
        true
    }
    pub fn request(_cap: Capability) -> bool {
        true
    }
}
