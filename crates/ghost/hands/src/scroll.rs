use anyhow::Result;

/// Scroll at (x, y) in the given direction for `amount` scroll units.
pub fn scroll(x: i32, y: i32, direction: &str, amount: i32) -> Result<()> {
    #[cfg(target_os = "windows")]
    return windows_scroll(x, y, direction, amount);

    #[cfg(target_os = "macos")]
    return macos_scroll(x, y, direction, amount);

    #[cfg(target_os = "linux")]
    return crate::linux::scroll(x, y, direction, amount);

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        tracing::debug!("scroll({}, {}, {}, {})", x, y, direction, amount);
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn windows_scroll(x: i32, y: i32, direction: &str, amount: i32) -> Result<()> {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;

    let (flags, wheel_delta) = match direction {
        "up"    => (MOUSEEVENTF_WHEEL,  120 * amount),
        "down"  => (MOUSEEVENTF_WHEEL, -120 * amount),
        "left"  => (MOUSEEVENTF_HWHEEL, -120 * amount),
        "right" => (MOUSEEVENTF_HWHEEL,  120 * amount),
        _ => return Err(anyhow::anyhow!("Unknown scroll direction '{}'; use up, down, left, or right", direction)),
    };

    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: x, dy: y,
                mouseData: wheel_delta as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32); }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_scroll(_x: i32, _y: i32, direction: &str, amount: i32) -> Result<()> {
    use core_graphics::event::*;
    use core_graphics::event_source::*;

    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| anyhow::anyhow!("CGEventSource"))?;

    let (dx, dy) = match direction {
        "up"    => (0i32, amount),
        "down"  => (0i32, -amount),
        "left"  => (-amount, 0i32),
        "right" => (amount, 0i32),
        _ => return Err(anyhow::anyhow!("Unknown scroll direction '{}'; use up, down, left, or right", direction)),
    };

    if let Ok(ev) = CGEvent::new_scroll_event(source, ScrollEventUnit::LINE, 2, dy, dx, 0) {
        ev.post(CGEventTapLocation::HID);
    }
    Ok(())
}
