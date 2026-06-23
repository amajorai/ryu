use anyhow::Result;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

/// Move cursor to position and click.
pub fn mouse_click(x: i32, y: i32, button: MouseButton, count: u32) -> Result<()> {
    #[cfg(target_os = "windows")]
    return windows_click(x, y, button, count);

    #[cfg(target_os = "macos")]
    return macos_click(x, y, button, count);

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
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

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
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
    #[cfg(not(target_os = "windows"))]
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
    #[cfg(not(target_os = "windows"))]
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
