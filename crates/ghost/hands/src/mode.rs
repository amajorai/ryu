// Click-mode selection + cursor-courtesy decision — pure logic, no platform FFI.
//
// Ghost's pointer actions historically warped the user's physical cursor to the
// target and left it there (a HID click posts a CGEvent/SendInput at the point).
// The "ghost cursor" work adds an AX-first path: when a target resolves to a real
// accessibility element, we can AXPress it WITHOUT moving the physical cursor at
// all. This module owns the (testable, FFI-free) decision of *how* a given click
// should be performed, and *whether* the physical cursor may be restored after a
// HID fallback.

/// How a click should be attempted, chosen by the caller (tool param `mode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClickMode {
    /// AXPress when the target resolved to an AX element and no explicit x/y was
    /// given; otherwise a courteous HID click (cursor restored if undisturbed).
    /// This is the default — it never hijacks the user's cursor when it can help it.
    Auto,
    /// Always a plain HID click that leaves the cursor at the target (legacy).
    Hid,
    /// AXPress only; error if the target cannot be pressed via accessibility.
    Ax,
}

impl ClickMode {
    /// Parse the tool's `mode` param. Unknown / absent ⇒ [`ClickMode::Auto`].
    pub fn parse(mode: Option<&str>) -> Self {
        match mode.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
            Some("hid") => ClickMode::Hid,
            Some("ax") => ClickMode::Ax,
            _ => ClickMode::Auto,
        }
    }
}

/// The concrete plan for a single click, resolved from the mode + what the caller
/// knows about the target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClickPlan {
    /// Try AXPress; on failure, HID-click and restore the cursor if undisturbed.
    AxThenHidRestore,
    /// AXPress only; the caller errors if it fails.
    AxOnly,
    /// HID-click, then restore the physical cursor if it stayed where we left it.
    HidRestore,
    /// Plain HID click; leave the cursor at the target (legacy behaviour).
    HidPlain,
}

/// Resolve the plan for a click.
///
/// - `resolved_via_ax` — the target was matched to a real AX element (the AX-query
///   branch), so an AXPress can be attempted against the element under its centre.
/// - `has_explicit_xy` — the caller passed raw x/y coordinates (no element), so an
///   AXPress in `Auto` is not attempted (we honour the exact pixel the caller asked
///   for), but a courteous restore still applies.
pub fn plan_click(mode: ClickMode, resolved_via_ax: bool, has_explicit_xy: bool) -> ClickPlan {
    match mode {
        ClickMode::Hid => ClickPlan::HidPlain,
        ClickMode::Ax => ClickPlan::AxOnly,
        ClickMode::Auto => {
            if resolved_via_ax && !has_explicit_xy {
                ClickPlan::AxThenHidRestore
            } else {
                ClickPlan::HidRestore
            }
        }
    }
}

/// Whether the physical cursor may be restored to its pre-action position.
///
/// After a HID click the OS cursor is warped to the target `T`. We only restore the
/// user's original position when the cursor is *still* at `T` (within `tol` pixels)
/// right before we restore — i.e. the user did not grab the mouse mid-action. If it
/// has moved away from `T`, the user is driving; we leave their cursor alone.
///
/// Note: this deliberately compares the observed position against **where we left
/// the cursor** (`T`), not against the saved origin. Comparing against the saved
/// origin would be a no-op gate — a HID click always moves the cursor away from the
/// origin, so it would never (or only coincidentally) restore.
pub fn cursor_undisturbed(left_at: (i32, i32), observed_now: (i32, i32), tol: i32) -> bool {
    (left_at.0 - observed_now.0).abs() <= tol && (left_at.1 - observed_now.1).abs() <= tol
}

/// A click plan was refused by the caller's input policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanError {
    /// The plan needs physical (HID) input and the caller disallowed it.
    HidNotAllowed,
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::HidNotAllowed => f.write_str("POLICY_DENIED: physical input is not allowed here"),
        }
    }
}

impl std::error::Error for PlanError {}

/// [`plan_click`] with a physical-input gate. With `allow_hid = false`, `Hid` is
/// refused and `Auto`/`Ax` press through accessibility only (no HID fallback).
pub fn plan_click_with(
    mode: ClickMode,
    resolved_via_ax: bool,
    has_explicit_xy: bool,
    allow_hid: bool,
) -> Result<ClickPlan, PlanError> {
    if allow_hid {
        return Ok(plan_click(mode, resolved_via_ax, has_explicit_xy));
    }
    match mode {
        ClickMode::Hid => Err(PlanError::HidNotAllowed),
        ClickMode::Auto | ClickMode::Ax => Ok(ClickPlan::AxOnly),
    }
}

/// Env flag that marks a session as headless (no physical input).
pub const HEADLESS_ENV: &str = "RYU_GHOST_HEADLESS";

fn env_set(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// Pure core of [`headless_session`]: the flag is `1`/`true` (case-insensitive),
/// or on Linux neither display variable is set.
pub(crate) fn headless_from(
    flag: Option<&str>,
    display: Option<&str>,
    wayland_display: Option<&str>,
    linux: bool,
) -> bool {
    let flagged = flag.is_some_and(|v| {
        let v = v.trim();
        v == "1" || v.eq_ignore_ascii_case("true")
    });
    flagged || (linux && display.is_none() && wayland_display.is_none())
}

/// True if env `RYU_GHOST_HEADLESS` is `1`/`true`, or (Linux) neither `DISPLAY`
/// nor `WAYLAND_DISPLAY` is set. Physical input is never synthesized then.
pub fn headless_session() -> bool {
    headless_from(
        env_set(HEADLESS_ENV).as_deref(),
        env_set("DISPLAY").as_deref(),
        env_set("WAYLAND_DISPLAY").as_deref(),
        cfg!(target_os = "linux"),
    )
}

/// `requested && !headless_session()`.
pub fn hid_permitted(requested: bool) -> bool {
    requested && !headless_session()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_defaults_to_auto() {
        assert_eq!(ClickMode::parse(None), ClickMode::Auto);
        assert_eq!(ClickMode::parse(Some("")), ClickMode::Auto);
        assert_eq!(ClickMode::parse(Some("nonsense")), ClickMode::Auto);
        assert_eq!(ClickMode::parse(Some("auto")), ClickMode::Auto);
    }

    #[test]
    fn parse_recognises_hid_and_ax_case_insensitively() {
        assert_eq!(ClickMode::parse(Some("hid")), ClickMode::Hid);
        assert_eq!(ClickMode::parse(Some("HID")), ClickMode::Hid);
        assert_eq!(ClickMode::parse(Some("  Ax ")), ClickMode::Ax);
        assert_eq!(ClickMode::parse(Some("AX")), ClickMode::Ax);
    }

    #[test]
    fn hid_mode_is_always_plain() {
        assert_eq!(plan_click(ClickMode::Hid, true, false), ClickPlan::HidPlain);
        assert_eq!(plan_click(ClickMode::Hid, false, true), ClickPlan::HidPlain);
    }

    #[test]
    fn ax_mode_is_always_ax_only() {
        assert_eq!(plan_click(ClickMode::Ax, true, false), ClickPlan::AxOnly);
        assert_eq!(plan_click(ClickMode::Ax, false, true), ClickPlan::AxOnly);
    }

    #[test]
    fn auto_presses_ax_only_for_resolved_elements_without_explicit_xy() {
        // AX element, no explicit coords → AX press with HID fallback.
        assert_eq!(
            plan_click(ClickMode::Auto, true, false),
            ClickPlan::AxThenHidRestore
        );
        // Explicit coords → honour the exact pixel, but restore courteously.
        assert_eq!(
            plan_click(ClickMode::Auto, true, true),
            ClickPlan::HidRestore
        );
        // No AX element (ref / dom / cdp branch) → courteous HID.
        assert_eq!(
            plan_click(ClickMode::Auto, false, false),
            ClickPlan::HidRestore
        );
    }

    #[test]
    fn undisturbed_within_tolerance_true_moved_false() {
        // Cursor still at the target (exactly, or within a pixel of jitter).
        assert!(cursor_undisturbed((500, 400), (500, 400), 2));
        assert!(cursor_undisturbed((500, 400), (501, 399), 2));
        // User grabbed the mouse and moved it away → do not restore.
        assert!(!cursor_undisturbed((500, 400), (520, 400), 2));
        assert!(!cursor_undisturbed((500, 400), (500, 430), 2));
    }

    #[test]
    fn plan_click_with_allow_hid_matches_plan_click() {
        for mode in [ClickMode::Auto, ClickMode::Hid, ClickMode::Ax] {
            for ax in [false, true] {
                for xy in [false, true] {
                    assert_eq!(
                        plan_click_with(mode, ax, xy, true),
                        Ok(plan_click(mode, ax, xy))
                    );
                }
            }
        }
    }

    #[test]
    fn plan_click_with_disallowed_hid_never_plans_hid() {
        for ax in [false, true] {
            for xy in [false, true] {
                assert_eq!(
                    plan_click_with(ClickMode::Hid, ax, xy, false),
                    Err(PlanError::HidNotAllowed)
                );
                assert_eq!(
                    plan_click_with(ClickMode::Auto, ax, xy, false),
                    Ok(ClickPlan::AxOnly)
                );
                assert_eq!(
                    plan_click_with(ClickMode::Ax, ax, xy, false),
                    Ok(ClickPlan::AxOnly)
                );
            }
        }
    }

    #[test]
    fn plan_error_display_has_one_code_prefix() {
        let text = PlanError::HidNotAllowed.to_string();
        assert_eq!(text, "POLICY_DENIED: physical input is not allowed here");
    }

    #[test]
    fn headless_from_honours_flag_and_linux_displays() {
        assert!(headless_from(Some("1"), Some(":0"), None, true));
        assert!(headless_from(Some("TRUE"), None, None, false));
        assert!(!headless_from(Some("0"), Some(":0"), None, true));
        assert!(!headless_from(None, Some(":0"), None, true));
        assert!(!headless_from(None, None, Some("wayland-0"), true));
        assert!(headless_from(None, None, None, true));
        // Off Linux, missing display variables mean nothing.
        assert!(!headless_from(None, None, None, false));
    }

    #[test]
    fn headless_session_honours_env_flag() {
        // The only test that touches this env var.
        std::env::set_var(HEADLESS_ENV, "1");
        let headless = headless_session();
        let permitted = hid_permitted(true);
        std::env::remove_var(HEADLESS_ENV);
        assert!(headless);
        assert!(!permitted);
        assert!(!hid_permitted(false));
    }
}
