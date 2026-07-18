use anyhow::Result;

/// Type Unicode text into the focused element.
pub fn type_text(text: &str, clear: bool) -> Result<()> {
    #[cfg(target_os = "windows")]
    return windows_type(text, clear);

    #[cfg(target_os = "macos")]
    return macos_type(text, clear);

    #[cfg(target_os = "linux")]
    return crate::linux::type_text(text, clear);

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        tracing::debug!("type_text: {text}");
        Ok(())
    }
}

/// Press a single key with optional modifiers.
/// Key names: return, tab, escape, space, delete, up, down, left, right, f1-f12, or a single char.
pub fn press_key(key: &str, modifiers: &[&str]) -> Result<()> {
    #[cfg(target_os = "windows")]
    return windows_press_key(key, modifiers);

    #[cfg(target_os = "macos")]
    return macos_press_key(key, modifiers);

    #[cfg(target_os = "linux")]
    return crate::linux::press_key(key, modifiers);

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        tracing::debug!("press_key: {key} {:?}", modifiers);
        Ok(())
    }
}

/// Press a key combination, e.g. send_hotkey(&["ctrl", "c"]).
pub fn send_hotkey(keys: &[&str]) -> Result<()> {
    #[cfg(target_os = "windows")]
    return windows_hotkey(keys);

    #[cfg(target_os = "macos")]
    return macos_hotkey(keys);

    #[cfg(target_os = "linux")]
    return crate::linux::hotkey(keys);

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        tracing::debug!("send_hotkey: {:?}", keys);
        Ok(())
    }
}

// ─── Windows ──────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn windows_type(text: &str, clear: bool) -> Result<()> {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;

    if clear {
        // Select all + delete
        windows_hotkey(&["ctrl", "a"])?;
        std::thread::sleep(std::time::Duration::from_millis(50));
        windows_press_key("delete", &[])?;
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    let chars: Vec<u16> = text.encode_utf16().collect();
    let inputs: Vec<INPUT> = chars
        .iter()
        .flat_map(|&ch| {
            [
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VIRTUAL_KEY(0),
                            wScan: ch,
                            dwFlags: KEYEVENTF_UNICODE,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VIRTUAL_KEY(0),
                            wScan: ch,
                            dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
            ]
        })
        .collect();

    if !inputs.is_empty() {
        unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32); }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn name_to_vk(name: &str) -> Option<windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY> {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    Some(match name.to_uppercase().as_str() {
        "CTRL" | "CONTROL" => VK_CONTROL,
        "ALT" | "OPTION"   => VK_MENU,
        "SHIFT"            => VK_SHIFT,
        "WIN" | "CMD" | "META" | "SUPER" => VK_LWIN,
        "RETURN" | "ENTER" => VK_RETURN,
        "ESCAPE" | "ESC"   => VK_ESCAPE,
        "TAB"              => VK_TAB,
        "SPACE"            => VK_SPACE,
        "BACKSPACE"        => VK_BACK,
        "DELETE" | "DEL"   => VK_DELETE,
        "HOME"             => VK_HOME,
        "END"              => VK_END,
        "PAGEUP"           => VK_PRIOR,
        "PAGEDOWN"         => VK_NEXT,
        "LEFT"             => VK_LEFT,
        "RIGHT"            => VK_RIGHT,
        "UP"               => VK_UP,
        "DOWN"             => VK_DOWN,
        "F1"  => VK_F1,  "F2"  => VK_F2,  "F3"  => VK_F3,  "F4"  => VK_F4,
        "F5"  => VK_F5,  "F6"  => VK_F6,  "F7"  => VK_F7,  "F8"  => VK_F8,
        "F9"  => VK_F9,  "F10" => VK_F10, "F11" => VK_F11, "F12" => VK_F12,
        s if s.len() == 1 => VIRTUAL_KEY(s.chars().next()? as u16),
        _ => return None,
    })
}

#[cfg(target_os = "windows")]
fn windows_press_key(key: &str, modifiers: &[&str]) -> Result<()> {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;

    let mut vks: Vec<VIRTUAL_KEY> = modifiers.iter()
        .filter_map(|m| name_to_vk(m))
        .collect();

    if let Some(vk) = name_to_vk(key) {
        vks.push(vk);
    }

    let down: Vec<INPUT> = vks.iter().map(|&vk| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: KEYBD_EVENT_FLAGS(0), time: 0, dwExtraInfo: 0 },
        },
    }).collect();

    let up: Vec<INPUT> = vks.iter().rev().map(|&vk| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 },
        },
    }).collect();

    let mut all = down;
    all.extend(up);
    if !all.is_empty() {
        unsafe { SendInput(&all, std::mem::size_of::<INPUT>() as i32); }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_hotkey(keys: &[&str]) -> Result<()> {
    // Split into modifiers + final key: all-but-last are modifiers
    if keys.is_empty() { return Ok(()); }
    let (modifiers, key) = keys.split_at(keys.len() - 1);
    windows_press_key(key[0], modifiers)
}

// ─── macOS ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn macos_type(text: &str, clear: bool) -> Result<()> {
    use core_graphics::event::*;
    use core_graphics::event_source::*;

    if clear {
        macos_hotkey(&["cmd", "a"])?;
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| anyhow::anyhow!("CGEventSource"))?;

    for ch in text.chars() {
        let s = ch.to_string();
        if let Ok(ev) = CGEvent::new_keyboard_event(source.clone(), 0, true) {
            ev.set_string(&s);
            ev.post(CGEventTapLocation::HID);
        }
        if let Ok(ev) = CGEvent::new_keyboard_event(source.clone(), 0, false) {
            ev.set_string(&s);
            ev.post(CGEventTapLocation::HID);
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_keycode(name: &str) -> Option<u16> {
    // macOS virtual key codes (kVK_*)
    Some(match name.to_lowercase().as_str() {
        "return" | "enter" => 0x24,
        "tab"              => 0x30,
        "space"            => 0x31,
        "delete" | "backspace" => 0x33,
        "escape" | "esc"   => 0x35,
        "cmd" | "command"  => 0x37,
        "shift"            => 0x38,
        "option" | "alt"   => 0x3A,
        "ctrl" | "control" => 0x3B,
        "left"             => 0x7B,
        "right"            => 0x7C,
        "down"             => 0x7D,
        "up"               => 0x7E,
        "f1"  => 0x7A, "f2"  => 0x78, "f3"  => 0x63, "f4"  => 0x76,
        "f5"  => 0x60, "f6"  => 0x61, "f7"  => 0x62, "f8"  => 0x64,
        "f9"  => 0x65, "f10" => 0x6D, "f11" => 0x67, "f12" => 0x6F,
        "a" => 0x00, "b" => 0x0B, "c" => 0x08, "d" => 0x02, "e" => 0x0E,
        "f" => 0x03, "g" => 0x05, "h" => 0x04, "i" => 0x22, "j" => 0x26,
        "k" => 0x28, "l" => 0x25, "m" => 0x2E, "n" => 0x2D, "o" => 0x1F,
        "p" => 0x23, "q" => 0x0C, "r" => 0x0F, "s" => 0x01, "t" => 0x11,
        "u" => 0x20, "v" => 0x09, "w" => 0x0D, "x" => 0x07, "y" => 0x10,
        "z" => 0x06,
        "0" => 0x1D, "1" => 0x12, "2" => 0x13, "3" => 0x14, "4" => 0x15,
        "5" => 0x17, "6" => 0x16, "7" => 0x1A, "8" => 0x1C, "9" => 0x19,
        _ => return None,
    })
}

#[cfg(target_os = "macos")]
fn macos_modifier_flags(modifiers: &[&str]) -> core_graphics::event::CGEventFlags {
    use core_graphics::event::CGEventFlags;
    let mut flags = CGEventFlags::CGEventFlagNull;
    for &m in modifiers {
        match m.to_lowercase().as_str() {
            "cmd" | "command" => flags |= CGEventFlags::CGEventFlagCommand,
            "shift"           => flags |= CGEventFlags::CGEventFlagShift,
            "alt" | "option"  => flags |= CGEventFlags::CGEventFlagAlternate,
            "ctrl" | "control"=> flags |= CGEventFlags::CGEventFlagControl,
            _ => {}
        }
    }
    flags
}

#[cfg(target_os = "macos")]
fn macos_press_key(key: &str, modifiers: &[&str]) -> Result<()> {
    use core_graphics::event::*;
    use core_graphics::event_source::*;

    let keycode = macos_keycode(key).ok_or_else(|| anyhow::anyhow!("Unknown key: {key}"))?;
    let flags = macos_modifier_flags(modifiers);
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| anyhow::anyhow!("CGEventSource"))?;

    if let Ok(ev) = CGEvent::new_keyboard_event(source.clone(), keycode, true) {
        ev.set_flags(flags);
        ev.post(CGEventTapLocation::HID);
    }
    if let Ok(ev) = CGEvent::new_keyboard_event(source, keycode, false) {
        ev.set_flags(CGEventFlags::CGEventFlagNull);
        ev.post(CGEventTapLocation::HID);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_hotkey(keys: &[&str]) -> Result<()> {
    if keys.is_empty() { return Ok(()); }
    let (modifiers, key) = keys.split_at(keys.len() - 1);
    macos_press_key(key[0], modifiers)
}
