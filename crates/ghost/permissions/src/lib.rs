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
/// permission at all. This classifies the permission mechanism, not device or
/// session availability; callers must still check `granted` and try the operation.
pub fn required(cap: Capability) -> bool {
    platform::required(cap)
}

/// Whether the capability is currently granted to this process. Never prompts —
/// safe to poll (e.g. on a settings screen). Linux also checks that the required
/// session and input-device access exist. A clear gate does not prove capture.
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

// ── Cross-platform API tests ────────────────────────────────────────────────
// These exercise the platform-independent surface (labels, the capability list,
// and the derived traits). They never call `granted`/`request`, which on macOS
// read/prompt real TCC — the per-platform `platform::tests` module covers the
// gating logic behind fakes instead.

#[cfg(test)]
mod api_tests {
    use super::{required, Capability, ALL};

    #[test]
    fn labels_match_the_system_settings_pane_names() {
        assert_eq!(Capability::Accessibility.label(), "Accessibility");
        assert_eq!(Capability::ScreenRecording.label(), "Screen Recording");
        assert_eq!(Capability::InputMonitoring.label(), "Input Monitoring");
    }

    #[test]
    fn labels_are_all_distinct() {
        let labels: Vec<&str> = ALL.iter().map(|c| c.label()).collect();
        for (i, a) in labels.iter().enumerate() {
            for b in labels.iter().skip(i + 1) {
                assert_ne!(a, b);
            }
        }
    }

    #[test]
    fn all_holds_every_variant_in_declared_order() {
        assert_eq!(ALL.len(), 3);
        assert_eq!(ALL[0], Capability::Accessibility);
        assert_eq!(ALL[1], Capability::ScreenRecording);
        assert_eq!(ALL[2], Capability::InputMonitoring);
        // No duplicates.
        for (i, a) in ALL.iter().enumerate() {
            for b in ALL.iter().skip(i + 1) {
                assert_ne!(a, b);
            }
        }
    }

    #[test]
    fn granted_wrappers_delegate_to_the_generic_reader() {
        // `granted` is poll-safe (never prompts, no state change), so exercising the
        // read path is hermetic: a test binary is never TCC-trusted, so each read
        // returns a deterministic value with no dialog. We assert the named wrappers
        // agree with `granted(cap)` rather than pinning a granted/denied verdict, so
        // the test never depends on the host's real permission state.
        use super::screen_recording_granted;
        use super::{accessibility_granted, granted, input_monitoring_granted};
        let ax = accessibility_granted() == granted(Capability::Accessibility);
        let sc = screen_recording_granted() == granted(Capability::ScreenRecording);
        let im = input_monitoring_granted() == granted(Capability::InputMonitoring);
        assert!(ax);
        assert!(sc);
        assert!(im);
    }

    #[test]
    fn required_is_consistent_across_repeated_calls() {
        // Whatever the host platform decides, `required` is a stable, side-effect
        // free classification — polling it twice agrees.
        for cap in ALL {
            let stable = required(cap) == required(cap);
            assert!(stable);
        }
    }

    // The host platform's `required` verdict follows the documented per-OS policy.
    // (Wayland Linux is the one dynamic case; it is covered in the Linux platform
    // tests. Here we pin the compile-time-constant platforms.)
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_requires_every_capability() {
        // macOS gates everything behind TCC.
        for cap in ALL {
            assert!(required(cap));
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_requires_nothing() {
        // Windows needs no per-app grant.
        for cap in ALL {
            assert!(!required(cap));
        }
    }
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

    /// Pure capability→probe dispatch for `granted`, isolated from the FFI so the
    /// routing and the IOHID access-type decode are unit-testable without invoking
    /// TCC. Each probe is `FnOnce` and only the arm matching `cap` is evaluated, so
    /// the real `granted` still performs exactly one OS read and never eagerly
    /// probes the other capabilities.
    // `&dyn Fn` (rather than `impl Fn`) keeps these dispatchers to a single,
    // non-generic instantiation shared by the real FFI callers and the unit tests —
    // so exercising them with fakes actually covers the same code the production
    // paths run. Each probe is still evaluated lazily and only for the matched arm.
    fn granted_with(
        cap: Capability,
        ax_trusted: &dyn Fn() -> bool,
        screen_ready: &dyn Fn() -> bool,
        iohid_access: &dyn Fn() -> u32,
    ) -> bool {
        match cap {
            Capability::Accessibility => ax_trusted(),
            Capability::ScreenRecording => screen_ready(),
            Capability::InputMonitoring => iohid_access() == IOHID_ACCESS_GRANTED,
        }
    }

    pub fn granted(cap: Capability) -> bool {
        granted_with(
            cap,
            &|| unsafe { AXIsProcessTrusted() },
            &|| unsafe { CGPreflightScreenCaptureAccess() },
            &|| unsafe { IOHIDCheckAccess(IOHID_REQUEST_LISTEN) },
        )
    }

    /// Pure capability→prompt dispatch for `request`, mirroring `granted_with`. Only
    /// the matched arm runs, so the real `request` surfaces exactly one prompt.
    fn request_with(
        cap: Capability,
        ax_prompt: &dyn Fn() -> bool,
        screen_prompt: &dyn Fn() -> bool,
        iohid_prompt: &dyn Fn() -> bool,
    ) -> bool {
        match cap {
            Capability::Accessibility => ax_prompt(),
            Capability::ScreenRecording => screen_prompt(),
            Capability::InputMonitoring => iohid_prompt(),
        }
    }

    pub fn request(cap: Capability) -> bool {
        // The Accessibility arm builds the `{kAXTrustedCheckOptionPrompt: true}`
        // options dictionary, asks, and releases it. The FFI stays inline in the
        // closure; `request_with` remains a pure, unit-tested dispatcher.
        request_with(
            cap,
            &|| unsafe {
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
            &|| unsafe { CGRequestScreenCaptureAccess() },
            &|| unsafe { IOHIDRequestAccess(IOHID_REQUEST_LISTEN) },
        )
    }

    #[cfg(test)]
    mod tests {
        use super::super::Capability;
        use super::{granted_with, request_with, required, IOHID_ACCESS_GRANTED};
        use std::cell::Cell;

        #[test]
        fn required_is_always_true_on_macos() {
            for cap in super::super::ALL {
                // macOS gates every capability behind TCC.
                assert!(required(cap));
            }
        }

        // Routing + laziness + the IOHID decode, all with fake probes so no real TCC
        // call is made. The three fake probes are each defined once (each captures a
        // `&Cell`, making the closure `Copy`) and reused across every capability, so
        // each probe body is exercised at least once — no dead test closures — while
        // the per-probe call counters prove that `granted_with` evaluates only the
        // arm matching `cap` (never eagerly probing the others).
        #[test]
        fn granted_with_routes_to_one_probe_and_decodes_iohid_access() {
            let ax_calls = Cell::new(0u32);
            let screen_calls = Cell::new(0u32);
            let iohid_calls = Cell::new(0u32);
            let ax_ret = Cell::new(true);
            let screen_ret = Cell::new(true);
            let raw = Cell::new(IOHID_ACCESS_GRANTED);

            let ax = || {
                ax_calls.set(ax_calls.get() + 1);
                ax_ret.get()
            };
            let screen = || {
                screen_calls.set(screen_calls.get() + 1);
                screen_ret.get()
            };
            let iohid = || {
                iohid_calls.set(iohid_calls.get() + 1);
                raw.get()
            };
            let is_granted = |cap| granted_with(cap, &ax, &screen, &iohid);

            // Accessibility routes to the ax probe verbatim.
            ax_ret.set(true);
            assert!(is_granted(Capability::Accessibility));
            ax_ret.set(false);
            assert!(!is_granted(Capability::Accessibility));

            // ScreenRecording routes to the screen probe verbatim.
            screen_ret.set(true);
            assert!(is_granted(Capability::ScreenRecording));
            screen_ret.set(false);
            assert!(!is_granted(Capability::ScreenRecording));

            // InputMonitoring is granted iff the IOHID access type is exactly 0
            // (kIOHIDAccessTypeGranted). 1 = denied, 2 = unknown, and any other
            // (future/out-of-range) value stays fail-closed.
            assert_eq!(IOHID_ACCESS_GRANTED, 0);
            for (value, want) in [(0u32, true), (1, false), (2, false), (99, false)] {
                raw.set(value);
                let got = is_granted(Capability::InputMonitoring);
                assert_eq!(got, want);
            }

            // Each probe ran only for its own capability, once per call.
            assert_eq!(ax_calls.get(), 2);
            assert_eq!(screen_calls.get(), 2);
            assert_eq!(iohid_calls.get(), 4);
        }

        // Same shape for the prompting path: `request_with` surfaces exactly one
        // prompt — the one matching `cap` — and returns its verdict unchanged.
        #[test]
        fn request_with_routes_to_one_prompt_and_returns_its_verdict() {
            let ax_calls = Cell::new(0u32);
            let screen_calls = Cell::new(0u32);
            let iohid_calls = Cell::new(0u32);
            let ax_ret = Cell::new(true);
            let screen_ret = Cell::new(true);
            let iohid_ret = Cell::new(true);

            let ax = || {
                ax_calls.set(ax_calls.get() + 1);
                ax_ret.get()
            };
            let screen = || {
                screen_calls.set(screen_calls.get() + 1);
                screen_ret.get()
            };
            let iohid = || {
                iohid_calls.set(iohid_calls.get() + 1);
                iohid_ret.get()
            };
            let do_request = |cap| request_with(cap, &ax, &screen, &iohid);

            ax_ret.set(true);
            assert!(do_request(Capability::Accessibility));
            ax_ret.set(false);
            assert!(!do_request(Capability::Accessibility));

            screen_ret.set(true);
            assert!(do_request(Capability::ScreenRecording));

            iohid_ret.set(false);
            assert!(!do_request(Capability::InputMonitoring));

            // Only the matching prompt fired, once per call.
            assert_eq!(ax_calls.get(), 2);
            assert_eq!(screen_calls.get(), 1);
            assert_eq!(iohid_calls.get(), 1);
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
use linux as platform;

#[cfg(any(target_os = "linux", test))]
mod linux {
    use super::Capability;

    fn is_wayland() -> bool {
        std::env::var("WAYLAND_DISPLAY").is_ok_and(|value| !value.trim().is_empty())
            || std::env::var("XDG_SESSION_TYPE")
                .is_ok_and(|value| value.eq_ignore_ascii_case("wayland"))
    }

    fn has_display() -> bool {
        std::env::var("DISPLAY").is_ok_and(|value| !value.trim().is_empty())
    }

    fn input_devices_readable() -> bool {
        std::fs::read_dir("/dev/input").is_ok_and(|entries| {
            entries.flatten().any(|entry| {
                entry.file_name().to_string_lossy().starts_with("event")
                    && std::fs::File::open(entry.path()).is_ok()
            })
        })
    }

    pub fn required(cap: Capability) -> bool {
        is_wayland() || cap == Capability::InputMonitoring
    }

    fn granted_with(cap: Capability, wayland: bool, display: bool, readable_input: bool) -> bool {
        if wayland || !display {
            return false;
        }
        cap != Capability::InputMonitoring || readable_input
    }

    pub fn granted(cap: Capability) -> bool {
        granted_with(
            cap,
            is_wayland(),
            has_display(),
            cap != Capability::InputMonitoring || input_devices_readable(),
        )
    }

    pub fn request(cap: Capability) -> bool {
        // A compositor portal or device-access change requires the user. Never
        // claim that asking this function has granted native capture access.
        granted(cap)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn headless_and_wayland_sessions_are_not_reported_ready() {
            for cap in super::super::ALL {
                assert!(!granted_with(cap, true, true, true));
                assert!(!granted_with(cap, false, false, true));
            }
        }

        #[test]
        fn x11_input_observation_requires_readable_devices() {
            assert!(granted_with(
                Capability::ScreenRecording,
                false,
                true,
                false
            ));
            assert!(granted_with(Capability::Accessibility, false, true, false));
            assert!(!granted_with(
                Capability::InputMonitoring,
                false,
                true,
                false
            ));
            assert!(granted_with(Capability::InputMonitoring, false, true, true));
        }
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
