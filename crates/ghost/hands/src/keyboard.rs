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
        unsafe {
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn name_to_vk(name: &str) -> Option<windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY> {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    Some(match name.to_uppercase().as_str() {
        "CTRL" | "CONTROL" => VK_CONTROL,
        "ALT" | "OPTION" => VK_MENU,
        "SHIFT" => VK_SHIFT,
        "WIN" | "CMD" | "META" | "SUPER" => VK_LWIN,
        "RETURN" | "ENTER" => VK_RETURN,
        "ESCAPE" | "ESC" => VK_ESCAPE,
        "TAB" => VK_TAB,
        "SPACE" => VK_SPACE,
        "BACKSPACE" => VK_BACK,
        "DELETE" | "DEL" => VK_DELETE,
        "HOME" => VK_HOME,
        "END" => VK_END,
        "PAGEUP" => VK_PRIOR,
        "PAGEDOWN" => VK_NEXT,
        "LEFT" => VK_LEFT,
        "RIGHT" => VK_RIGHT,
        "UP" => VK_UP,
        "DOWN" => VK_DOWN,
        "F1" => VK_F1,
        "F2" => VK_F2,
        "F3" => VK_F3,
        "F4" => VK_F4,
        "F5" => VK_F5,
        "F6" => VK_F6,
        "F7" => VK_F7,
        "F8" => VK_F8,
        "F9" => VK_F9,
        "F10" => VK_F10,
        "F11" => VK_F11,
        "F12" => VK_F12,
        s if s.len() == 1 => VIRTUAL_KEY(s.chars().next()? as u16),
        _ => return None,
    })
}

#[cfg(target_os = "windows")]
fn windows_press_key(key: &str, modifiers: &[&str]) -> Result<()> {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;

    let mut vks: Vec<VIRTUAL_KEY> = modifiers.iter().filter_map(|m| name_to_vk(m)).collect();

    if let Some(vk) = name_to_vk(key) {
        vks.push(vk);
    }

    let down: Vec<INPUT> = vks
        .iter()
        .map(|&vk| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: KEYBD_EVENT_FLAGS(0),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        })
        .collect();

    let up: Vec<INPUT> = vks
        .iter()
        .rev()
        .map(|&vk| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        })
        .collect();

    let mut all = down;
    all.extend(up);
    if !all.is_empty() {
        unsafe {
            SendInput(&all, std::mem::size_of::<INPUT>() as i32);
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_hotkey(keys: &[&str]) -> Result<()> {
    // Split into modifiers + final key: all-but-last are modifiers
    if keys.is_empty() {
        return Ok(());
    }
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
        "tab" => 0x30,
        "space" => 0x31,
        "delete" | "backspace" => 0x33,
        "escape" | "esc" => 0x35,
        "cmd" | "command" => 0x37,
        "shift" => 0x38,
        "option" | "alt" => 0x3A,
        "ctrl" | "control" => 0x3B,
        "left" => 0x7B,
        "right" => 0x7C,
        "down" => 0x7D,
        "up" => 0x7E,
        "f1" => 0x7A,
        "f2" => 0x78,
        "f3" => 0x63,
        "f4" => 0x76,
        "f5" => 0x60,
        "f6" => 0x61,
        "f7" => 0x62,
        "f8" => 0x64,
        "f9" => 0x65,
        "f10" => 0x6D,
        "f11" => 0x67,
        "f12" => 0x6F,
        "a" => 0x00,
        "b" => 0x0B,
        "c" => 0x08,
        "d" => 0x02,
        "e" => 0x0E,
        "f" => 0x03,
        "g" => 0x05,
        "h" => 0x04,
        "i" => 0x22,
        "j" => 0x26,
        "k" => 0x28,
        "l" => 0x25,
        "m" => 0x2E,
        "n" => 0x2D,
        "o" => 0x1F,
        "p" => 0x23,
        "q" => 0x0C,
        "r" => 0x0F,
        "s" => 0x01,
        "t" => 0x11,
        "u" => 0x20,
        "v" => 0x09,
        "w" => 0x0D,
        "x" => 0x07,
        "y" => 0x10,
        "z" => 0x06,
        "0" => 0x1D,
        "1" => 0x12,
        "2" => 0x13,
        "3" => 0x14,
        "4" => 0x15,
        "5" => 0x17,
        "6" => 0x16,
        "7" => 0x1A,
        "8" => 0x1C,
        "9" => 0x19,
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
            "shift" => flags |= CGEventFlags::CGEventFlagShift,
            "alt" | "option" => flags |= CGEventFlags::CGEventFlagAlternate,
            "ctrl" | "control" => flags |= CGEventFlags::CGEventFlagControl,
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
    if keys.is_empty() {
        return Ok(());
    }
    let (modifiers, key) = keys.split_at(keys.len() - 1);
    macos_press_key(key[0], modifiers)
}

// ─── Tests (macOS pure logic: keycode + modifier mapping, dispatch error paths) ──
//
// These exercise only FFI-free logic: the kVK keycode table, the CGEventFlags
// modifier map, and the early-return / error branches of the public dispatchers
// that resolve *before* any CGEvent is created or posted. No synthetic key event
// ever reaches the OS here — a valid `press_key`/`send_hotkey` (which would post)
// is deliberately never called.
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use core_graphics::event::CGEventFlags;

    #[test]
    fn keycode_table_maps_every_named_key_to_its_kvk() {
        // Exact kVK_* values — a transposed code is a real bug, so pin the number.
        let expected: &[(&str, u16)] = &[
            ("return", 0x24),
            ("enter", 0x24),
            ("tab", 0x30),
            ("space", 0x31),
            ("delete", 0x33),
            ("backspace", 0x33),
            ("escape", 0x35),
            ("esc", 0x35),
            ("cmd", 0x37),
            ("command", 0x37),
            ("shift", 0x38),
            ("option", 0x3A),
            ("alt", 0x3A),
            ("ctrl", 0x3B),
            ("control", 0x3B),
            ("left", 0x7B),
            ("right", 0x7C),
            ("down", 0x7D),
            ("up", 0x7E),
            ("f1", 0x7A),
            ("f2", 0x78),
            ("f3", 0x63),
            ("f4", 0x76),
            ("f5", 0x60),
            ("f6", 0x61),
            ("f7", 0x62),
            ("f8", 0x64),
            ("f9", 0x65),
            ("f10", 0x6D),
            ("f11", 0x67),
            ("f12", 0x6F),
            ("a", 0x00),
            ("b", 0x0B),
            ("c", 0x08),
            ("d", 0x02),
            ("e", 0x0E),
            ("f", 0x03),
            ("g", 0x05),
            ("h", 0x04),
            ("i", 0x22),
            ("j", 0x26),
            ("k", 0x28),
            ("l", 0x25),
            ("m", 0x2E),
            ("n", 0x2D),
            ("o", 0x1F),
            ("p", 0x23),
            ("q", 0x0C),
            ("r", 0x0F),
            ("s", 0x01),
            ("t", 0x11),
            ("u", 0x20),
            ("v", 0x09),
            ("w", 0x0D),
            ("x", 0x07),
            ("y", 0x10),
            ("z", 0x06),
            ("0", 0x1D),
            ("1", 0x12),
            ("2", 0x13),
            ("3", 0x14),
            ("4", 0x15),
            ("5", 0x17),
            ("6", 0x16),
            ("7", 0x1A),
            ("8", 0x1C),
            ("9", 0x19),
        ];
        for &(name, code) in expected {
            assert_eq!(macos_keycode(name), Some(code), "keycode for {name:?}");
        }
    }

    #[test]
    fn keycode_lookup_is_case_insensitive() {
        assert_eq!(macos_keycode("RETURN"), Some(0x24));
        assert_eq!(macos_keycode("Cmd"), Some(0x37));
        assert_eq!(macos_keycode("F12"), Some(0x6F));
        assert_eq!(macos_keycode("Z"), Some(0x06));
    }

    #[test]
    fn keycode_unknown_names_are_none() {
        assert_eq!(macos_keycode(""), None);
        assert_eq!(macos_keycode("-"), None);
        assert_eq!(macos_keycode("f13"), None);
        assert_eq!(macos_keycode("ab"), None);
        assert_eq!(macos_keycode("pageup"), None); // not in the macOS table
    }

    #[test]
    fn modifier_flags_empty_is_null() {
        assert_eq!(macos_modifier_flags(&[]).bits(), CGEventFlags::CGEventFlagNull.bits());
    }

    #[test]
    fn modifier_flags_map_each_alias() {
        assert!(macos_modifier_flags(&["cmd"]).contains(CGEventFlags::CGEventFlagCommand));
        assert!(macos_modifier_flags(&["command"]).contains(CGEventFlags::CGEventFlagCommand));
        assert!(macos_modifier_flags(&["shift"]).contains(CGEventFlags::CGEventFlagShift));
        assert!(macos_modifier_flags(&["alt"]).contains(CGEventFlags::CGEventFlagAlternate));
        assert!(macos_modifier_flags(&["option"]).contains(CGEventFlags::CGEventFlagAlternate));
        assert!(macos_modifier_flags(&["ctrl"]).contains(CGEventFlags::CGEventFlagControl));
        assert!(macos_modifier_flags(&["control"]).contains(CGEventFlags::CGEventFlagControl));
    }

    #[test]
    fn modifier_flags_combine_and_ignore_unknown() {
        let combo = macos_modifier_flags(&["cmd", "shift"]);
        assert!(combo.contains(CGEventFlags::CGEventFlagCommand));
        assert!(combo.contains(CGEventFlags::CGEventFlagShift));
        // Unknown modifiers are silently dropped, not errored.
        let ignored = macos_modifier_flags(&["hyperspace"]);
        assert_eq!(ignored.bits(), CGEventFlags::CGEventFlagNull.bits());
        // Case-insensitive.
        assert!(macos_modifier_flags(&["CMD"]).contains(CGEventFlags::CGEventFlagCommand));
    }

    #[test]
    fn press_key_unknown_key_errors_before_any_event() {
        // macos_keycode returns None ⇒ the `?` bails before a CGEventSource is made,
        // so nothing is ever posted to the OS.
        let err = press_key("definitely-not-a-key", &[]).unwrap_err();
        assert!(err.to_string().contains("Unknown key"), "got: {err}");
    }

    #[test]
    fn send_hotkey_empty_is_noop_ok() {
        // Empty combo returns Ok early — no key resolution, no event.
        assert!(send_hotkey(&[]).is_ok());
    }

    #[test]
    fn send_hotkey_splits_modifiers_and_surfaces_unknown_final_key() {
        // Non-empty ⇒ all-but-last are modifiers, last is the key. An unknown final
        // key errors out of macos_press_key before any post, exercising the split.
        assert!(send_hotkey(&["cmd", "not-a-key"]).is_err());
        assert!(send_hotkey(&["not-a-key"]).is_err());
    }

    #[test]
    fn type_empty_string_is_ok_and_posts_nothing() {
        // clear=false + empty text: the char loop runs zero times, so no key event
        // is synthesised; the function just resolves to Ok.
        assert!(type_text("", false).is_ok());
    }
}
