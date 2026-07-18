use anyhow::Result;

use crate::mode::{cursor_undisturbed, ClickPlan};

/// Tolerance (px) for deciding the cursor "stayed where we left it" after a HID
/// action — small enough to catch a real user move, large enough for OS jitter.
const RESTORE_TOL: i32 = 3;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

// ─── AX-first click + cursor courtesy ──────────────────────────────────────────

/// Execute a click at (x, y) according to `plan` (see [`crate::mode`]).
///
/// Returns the method actually used — `"ax"` (the element was pressed via the
/// accessibility API, so the physical cursor never moved) or `"hid"` (a synthetic
/// pointer event). In the courteous plans the physical cursor is restored to its
/// pre-click position when the user did not move it mid-action.
pub fn execute_click(
    x: i32,
    y: i32,
    button: MouseButton,
    count: u32,
    plan: ClickPlan,
) -> Result<&'static str> {
    match plan {
        ClickPlan::HidPlain => {
            mouse_click(x, y, button, count)?;
            Ok("hid")
        }
        ClickPlan::AxOnly => {
            if ax_press_at(x, y) {
                Ok("ax")
            } else {
                Err(anyhow::anyhow!(
                    "AX press failed: no pressable accessibility element at ({x}, {y})"
                ))
            }
        }
        ClickPlan::AxThenHidRestore => {
            if ax_press_at(x, y) {
                return Ok("ax");
            }
            hid_click_restore(x, y, button, count)?;
            Ok("hid")
        }
        ClickPlan::HidRestore => {
            hid_click_restore(x, y, button, count)?;
            Ok("hid")
        }
    }
}

/// HID click that restores the physical cursor to where it started, but only if the
/// user did not grab the mouse during the action (best-effort; a failed read/warp
/// simply leaves the cursor at the target, i.e. today's behaviour).
fn hid_click_restore(x: i32, y: i32, button: MouseButton, count: u32) -> Result<()> {
    let saved = cursor_position();
    mouse_click(x, y, button, count)?;
    restore_if_undisturbed(saved, (x, y));
    Ok(())
}

/// Drag according to today's semantics, optionally restoring the cursor afterwards
/// (courteous, auto-mode) when it was left undisturbed at the drop point.
pub fn execute_drag(
    from_x: i32,
    from_y: i32,
    to_x: i32,
    to_y: i32,
    duration_ms: u64,
    hold_duration_ms: u64,
    restore: bool,
) -> Result<()> {
    let saved = if restore { cursor_position() } else { None };
    drag(from_x, from_y, to_x, to_y, duration_ms, hold_duration_ms)?;
    if restore {
        restore_if_undisturbed(saved, (to_x, to_y));
    }
    Ok(())
}

/// Warp the cursor back to `saved` iff it is still within tolerance of `left_at`
/// (the point our synthetic action moved it to). No-op when `saved` is `None`.
fn restore_if_undisturbed(saved: Option<(i32, i32)>, left_at: (i32, i32)) {
    let Some(origin) = saved else {
        return;
    };
    let Some(now) = cursor_position() else {
        return;
    };
    if cursor_undisturbed(left_at, now, RESTORE_TOL) {
        warp_cursor(origin.0, origin.1);
    }
}

/// AXPress the accessibility element at screen (x, y), falling back to AXConfirm.
/// Returns `false` when no element resolves or neither action succeeds (and on any
/// non-macOS platform, which has no equivalent AX press). The caller then decides
/// whether to fall back to a HID click.
pub fn ax_press_at(x: i32, y: i32) -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { macos_ax_press::ax_press_at(x, y) }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (x, y);
        false
    }
}

/// Read the current physical cursor position in screen coordinates, if available.
pub fn cursor_position() -> Option<(i32, i32)> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut p = POINT::default();
        unsafe {
            if GetCursorPos(&mut p).is_ok() {
                return Some((p.x, p.y));
            }
        }
        None
    }
    #[cfg(target_os = "macos")]
    {
        unsafe { macos_ax_press::cursor_position() }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        None
    }
}

/// Move the physical cursor to (x, y) without synthesising a click.
pub fn warp_cursor(x: i32, y: i32) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;
        unsafe {
            let _ = SetCursorPos(x, y);
        }
    }
    #[cfg(target_os = "macos")]
    {
        unsafe { macos_ax_press::warp_cursor(x, y) }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (x, y);
    }
}

// macOS AX-press + cursor read/warp. The pressed element is re-resolved BY POSITION
// (AXUIElementCopyElementAtPosition) rather than carried from the AX-tree walk that
// matched it — `find_element` returns an owned, cloned node and every raw element is
// released during the walk, so plumbing the live handle across the ghost-eyes → ghost
// → ghost-hands boundary would be far from a minimal change. In the common case the
// element under the target's centre IS the matched element; with overlapping or
// transparent elements they can differ (a known limitation).
#[cfg(target_os = "macos")]
mod macos_ax_press {
    use std::ffi::{c_char, c_void, CString};

    const UTF8: u32 = 0x0800_0100;

    #[repr(C)]
    struct CgPoint {
        x: f64,
        y: f64,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn AXUIElementCreateSystemWide() -> *const c_void;
        fn AXUIElementCopyElementAtPosition(
            application: *const c_void,
            x: f32,
            y: f32,
            element: *mut *const c_void,
        ) -> i32;
        fn AXUIElementPerformAction(element: *const c_void, action: *const c_void) -> i32;
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> *const c_void;
        fn CFRelease(cf: *const c_void);
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWarpMouseCursorPosition(new_position: CgPoint) -> i32;
        fn CGEventCreate(source: *const c_void) -> *const c_void;
        fn CGEventGetLocation(event: *const c_void) -> CgPoint;
    }

    unsafe fn cfstr(s: &str) -> *const c_void {
        let c = CString::new(s).unwrap_or_default();
        CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), UTF8)
    }

    /// Generalised form of the window.rs `ax_press`: AXPress an arbitrary element,
    /// falling back to AXConfirm. Does not consume `element` (caller releases it).
    unsafe fn ax_press_element(element: *const c_void) -> bool {
        let press = cfstr("AXPress");
        let err = AXUIElementPerformAction(element, press);
        CFRelease(press);
        if err == 0 {
            return true;
        }
        let confirm = cfstr("AXConfirm");
        let err2 = AXUIElementPerformAction(element, confirm);
        CFRelease(confirm);
        err2 == 0
    }

    pub unsafe fn ax_press_at(x: i32, y: i32) -> bool {
        let sys = AXUIElementCreateSystemWide();
        if sys.is_null() {
            return false;
        }
        let mut el: *const c_void = std::ptr::null();
        let err = AXUIElementCopyElementAtPosition(sys, x as f32, y as f32, &mut el);
        CFRelease(sys);
        if err != 0 || el.is_null() {
            return false;
        }
        let ok = ax_press_element(el);
        CFRelease(el);
        ok
    }

    pub unsafe fn cursor_position() -> Option<(i32, i32)> {
        let ev = CGEventCreate(std::ptr::null());
        if ev.is_null() {
            return None;
        }
        let p = CGEventGetLocation(ev);
        CFRelease(ev);
        Some((p.x as i32, p.y as i32))
    }

    pub unsafe fn warp_cursor(x: i32, y: i32) {
        let _ = CGWarpMouseCursorPosition(CgPoint {
            x: x as f64,
            y: y as f64,
        });
    }
}

/// Move cursor to position and click.
pub fn mouse_click(x: i32, y: i32, button: MouseButton, count: u32) -> Result<()> {
    #[cfg(target_os = "windows")]
    return windows_click(x, y, button, count);

    #[cfg(target_os = "macos")]
    return macos_click(x, y, button, count);

    #[cfg(target_os = "linux")]
    return crate::linux::click(x, y, crate::linux::button_detail(button), count);

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        tracing::debug!("mouse_click({}, {}, {:?}, {})", x, y, button, count);
        Ok(())
    }
}

/// Move cursor to position without clicking.
pub fn hover(x: i32, y: i32) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::SetCursorPos;
        unsafe { let _ = SetCursorPos(x, y); }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    return macos_move_cursor(x, y);

    #[cfg(target_os = "linux")]
    return crate::linux::move_pointer(x, y);

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        tracing::debug!("hover({}, {})", x, y);
        Ok(())
    }
}

/// Press and hold at position, then release after `duration_ms` milliseconds.
pub fn long_press(x: i32, y: i32, duration_ms: u64, button: MouseButton) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::*;
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::SetCursorPos(x, y);
            let (down_flag, up_flag) = match button {
                MouseButton::Left   => (MOUSEEVENTF_LEFTDOWN,   MOUSEEVENTF_LEFTUP),
                MouseButton::Right  => (MOUSEEVENTF_RIGHTDOWN,  MOUSEEVENTF_RIGHTUP),
                MouseButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            };
            send_mouse_event(x, y, down_flag);
            std::thread::sleep(std::time::Duration::from_millis(duration_ms));
            send_mouse_event(x, y, up_flag);
        }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    return macos_long_press(x, y, duration_ms, button);

    #[cfg(target_os = "linux")]
    return crate::linux::long_press(x, y, duration_ms, crate::linux::button_detail(button));

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        tracing::debug!("long_press({}, {}, {}ms, {:?})", x, y, duration_ms, button);
        Ok(())
    }
}

/// Drag from (from_x, from_y) to (to_x, to_y).
pub fn drag(
    from_x: i32, from_y: i32,
    to_x: i32, to_y: i32,
    duration_ms: u64,
    hold_duration_ms: u64,
) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::*;
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::SetCursorPos(from_x, from_y);
            std::thread::sleep(std::time::Duration::from_millis(50));
            send_mouse_event(from_x, from_y, MOUSEEVENTF_LEFTDOWN);
            std::thread::sleep(std::time::Duration::from_millis(hold_duration_ms));

            // Interpolate move
            let steps = (duration_ms / 10).max(10) as i32;
            for i in 1..=steps {
                let t = i as f64 / steps as f64;
                let cx = from_x + ((to_x - from_x) as f64 * t) as i32;
                let cy = from_y + ((to_y - from_y) as f64 * t) as i32;
                let _ = windows::Win32::UI::WindowsAndMessaging::SetCursorPos(cx, cy);
                std::thread::sleep(std::time::Duration::from_millis(10));
            }

            send_mouse_event(to_x, to_y, MOUSEEVENTF_LEFTUP);
        }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    return macos_drag(from_x, from_y, to_x, to_y, duration_ms, hold_duration_ms);

    #[cfg(target_os = "linux")]
    return crate::linux::drag(from_x, from_y, to_x, to_y, duration_ms, hold_duration_ms);

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        tracing::debug!("drag({},{} -> {},{}, {}ms)", from_x, from_y, to_x, to_y, duration_ms);
        Ok(())
    }
}

// ─── Windows helpers ──────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn windows_click(x: i32, y: i32, button: MouseButton, count: u32) -> Result<()> {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    unsafe {
        let _ = windows::Win32::UI::WindowsAndMessaging::SetCursorPos(x, y);
        let (down_flag, up_flag) = match button {
            MouseButton::Left   => (MOUSEEVENTF_LEFTDOWN,   MOUSEEVENTF_LEFTUP),
            MouseButton::Right  => (MOUSEEVENTF_RIGHTDOWN,  MOUSEEVENTF_RIGHTUP),
            MouseButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        };
        for _ in 0..count {
            send_mouse_event(x, y, down_flag);
            std::thread::sleep(std::time::Duration::from_millis(20));
            send_mouse_event(x, y, up_flag);
            if count > 1 {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
unsafe fn send_mouse_event(x: i32, y: i32, flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS) {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: x, dy: y,
                mouseData: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
}

// ─── macOS helpers ────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn macos_click(x: i32, y: i32, button: MouseButton, count: u32) -> Result<()> {
    use core_graphics::event::*;
    use core_graphics::event_source::*;
    use core_graphics::geometry::CGPoint;

    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| anyhow::anyhow!("CGEventSource failed"))?;
    let pt = CGPoint::new(x as f64, y as f64);

    let (mouse_down, mouse_up) = match button {
        MouseButton::Left   => (CGEventType::LeftMouseDown,  CGEventType::LeftMouseUp),
        MouseButton::Right  => (CGEventType::RightMouseDown, CGEventType::RightMouseUp),
        MouseButton::Middle => (CGEventType::OtherMouseDown, CGEventType::OtherMouseUp),
    };
    let mouse_button = match button {
        MouseButton::Left   => CGMouseButton::Left,
        MouseButton::Right  => CGMouseButton::Right,
        MouseButton::Middle => CGMouseButton::Center,
    };

    for i in 0..count {
        if let Ok(ev) = CGEvent::new_mouse_event(source.clone(), mouse_down, pt, mouse_button) {
            ev.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, (i + 1) as i64);
            ev.post(CGEventTapLocation::HID);
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        if let Ok(ev) = CGEvent::new_mouse_event(source.clone(), mouse_up, pt, mouse_button) {
            ev.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, (i + 1) as i64);
            ev.post(CGEventTapLocation::HID);
        }
        if count > 1 { std::thread::sleep(std::time::Duration::from_millis(50)); }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_move_cursor(x: i32, y: i32) -> Result<()> {
    use core_graphics::event::*;
    use core_graphics::event_source::*;
    use core_graphics::geometry::CGPoint;

    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| anyhow::anyhow!("CGEventSource failed"))?;
    let pt = CGPoint::new(x as f64, y as f64);
    if let Ok(ev) = CGEvent::new_mouse_event(source, CGEventType::MouseMoved, pt, CGMouseButton::Left) {
        ev.post(CGEventTapLocation::HID);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_long_press(x: i32, y: i32, duration_ms: u64, button: MouseButton) -> Result<()> {
    use core_graphics::event::*;
    use core_graphics::event_source::*;
    use core_graphics::geometry::CGPoint;

    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| anyhow::anyhow!("CGEventSource failed"))?;
    let pt = CGPoint::new(x as f64, y as f64);
    let (down, up) = match button {
        MouseButton::Left => (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp),
        MouseButton::Right => (CGEventType::RightMouseDown, CGEventType::RightMouseUp),
        MouseButton::Middle => (CGEventType::OtherMouseDown, CGEventType::OtherMouseUp),
    };
    let mouse_button = match button {
        MouseButton::Left => CGMouseButton::Left,
        MouseButton::Right => CGMouseButton::Right,
        MouseButton::Middle => CGMouseButton::Center,
    };
    if let Ok(ev) = CGEvent::new_mouse_event(source.clone(), down, pt, mouse_button) {
        ev.post(CGEventTapLocation::HID);
    }
    std::thread::sleep(std::time::Duration::from_millis(duration_ms));
    if let Ok(ev) = CGEvent::new_mouse_event(source, up, pt, mouse_button) {
        ev.post(CGEventTapLocation::HID);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_drag(
    from_x: i32,
    from_y: i32,
    to_x: i32,
    to_y: i32,
    duration_ms: u64,
    hold_duration_ms: u64,
) -> Result<()> {
    use core_graphics::event::*;
    use core_graphics::event_source::*;
    use core_graphics::geometry::CGPoint;

    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| anyhow::anyhow!("CGEventSource failed"))?;
    let from = CGPoint::new(from_x as f64, from_y as f64);
    if let Ok(ev) = CGEvent::new_mouse_event(source.clone(), CGEventType::LeftMouseDown, from, CGMouseButton::Left) {
        ev.post(CGEventTapLocation::HID);
    }
    std::thread::sleep(std::time::Duration::from_millis(hold_duration_ms));

    let steps = (duration_ms / 10).max(10) as i32;
    for i in 1..=steps {
        let t = i as f64 / steps as f64;
        let cx = from_x + ((to_x - from_x) as f64 * t) as i32;
        let cy = from_y + ((to_y - from_y) as f64 * t) as i32;
        let pt = CGPoint::new(cx as f64, cy as f64);
        if let Ok(ev) = CGEvent::new_mouse_event(source.clone(), CGEventType::LeftMouseDragged, pt, CGMouseButton::Left) {
            ev.post(CGEventTapLocation::HID);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    let to = CGPoint::new(to_x as f64, to_y as f64);
    if let Ok(ev) = CGEvent::new_mouse_event(source, CGEventType::LeftMouseUp, to, CGMouseButton::Left) {
        ev.post(CGEventTapLocation::HID);
    }
    Ok(())
}
