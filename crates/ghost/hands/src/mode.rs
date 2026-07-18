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
}
