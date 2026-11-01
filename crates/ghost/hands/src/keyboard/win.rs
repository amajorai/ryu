//! Windows keyboard backend: Win32 `SendInput`.
//!
//! Named after the platform, not the `windows` crate (a sibling module named
//! `windows` would shadow it); external paths are written `::windows::…`.

use ::windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN,
    VK_END, VK_ESCAPE, VK_HOME, VK_LEFT, VK_LWIN, VK_MENU, VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT,
    VK_SHIFT, VK_SPACE, VK_TAB, VK_UP,
};
use anyhow::Result;

use crate::policy::{
    enforce, function_key_number, KeyCombo, KeyError, KeyOptions, Modifier, TargetOs,
};

/// `VK_F1` is 0x70 and `VK_F1`..`VK_F24` are contiguous.
const VK_F1_CODE: u16 = 0x70;

/// Virtual key for a named key or modifier (the dispatcher's names). Single
/// characters are not handled here: they go through `VkKeyScanW`.
pub(crate) fn name_to_vk(name: &str) -> Option<VIRTUAL_KEY> {
    let lower = name.to_lowercase();
    if let Some(n) = function_key_number(&lower) {
        return Some(VIRTUAL_KEY(VK_F1_CODE + u16::from(n) - 1));
    }
    Some(match lower.as_str() {
        "ctrl" | "control" => VK_CONTROL,
        "alt" | "option" => VK_MENU,
        "shift" => VK_SHIFT,
        "win" | "cmd" | "meta" | "super" => VK_LWIN,
        "return" | "enter" => VK_RETURN,
        "escape" | "esc" => VK_ESCAPE,
        "tab" => VK_TAB,
        "space" => VK_SPACE,
        "backspace" => VK_BACK,
        "delete" | "del" | "forwarddelete" => VK_DELETE,
        "home" => VK_HOME,
        "end" => VK_END,
        "pageup" => VK_PRIOR,
        "pagedown" => VK_NEXT,
        "left" => VK_LEFT,
        "right" => VK_RIGHT,
        "up" => VK_UP,
        "down" => VK_DOWN,
        _ => return None,
    })
}

/// Map a single character with the active layout. `None` when the layout has no
/// key for it, or the key needs Ctrl or Alt; `Some((vk, needs_shift))` otherwise.
fn char_to_vk(ch: char) -> Option<(VIRTUAL_KEY, bool)> {
    let mut buf = [0u16; 2];
    let units = ch.encode_utf16(&mut buf);
    if units.len() != 1 {
        return None;
    }
    // SAFETY: VkKeyScanW reads only its by-value argument.
    let scan = unsafe { VkKeyScanW(units[0]) };
    if scan == -1 {
        return None;
    }
    let bits = scan as u16;
    let vk = bits & 0xFF;
    let shift_state = bits >> 8;
    // 1 = Shift, 2 = Ctrl, 4 = Alt; Ctrl/Alt-requiring characters are refused.
    if shift_state & 0b110 != 0 || vk == 0 {
        return None;
    }
    Some((VIRTUAL_KEY(vk), shift_state & 1 != 0))
}

fn key_input(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Press every vk down in order, then release in reverse. Bypasses the policy;
/// internal use only.
fn send_vks(vks: &[VIRTUAL_KEY]) {
    let mut all: Vec<INPUT> = vks
        .iter()
        .map(|&vk| key_input(vk, KEYBD_EVENT_FLAGS(0)))
        .collect();
    all.extend(vks.iter().rev().map(|&vk| key_input(vk, KEYEVENTF_KEYUP)));
    if !all.is_empty() {
        // SAFETY: `all` is a valid, initialized INPUT slice for the call's duration.
        unsafe {
            SendInput(&all, std::mem::size_of::<INPUT>() as i32);
        }
    }
}

/// Dispatch a policy-checked combo. An unknown key is `KeyError::UnknownKey` (it
/// is never dropped while the modifiers are sent alone). A character that needs
/// Shift on the active layout adds Shift, and the policy is re-checked for the
/// combo that is actually sent.
pub(crate) fn press_combo(combo: &KeyCombo, opts: KeyOptions) -> Result<()> {
    let unknown = || anyhow::Error::new(KeyError::UnknownKey(combo.key.clone()));
    let mut sent = combo.clone();
    let mut chars = combo.dispatch_key.chars();
    let key_vk = match (chars.next(), chars.next()) {
        (Some(ch), None) => {
            let (vk, needs_shift) = char_to_vk(ch).ok_or_else(unknown)?;
            if needs_shift {
                sent.modifiers.insert(Modifier::Shift);
            }
            vk
        }
        _ => name_to_vk(&combo.dispatch_key).ok_or_else(unknown)?,
    };
    if sent.modifiers != combo.modifiers {
        enforce(&sent, TargetOs::Windows, opts).map_err(anyhow::Error::new)?;
    }
    let mut vks: Vec<VIRTUAL_KEY> = Vec::with_capacity(sent.modifiers.len() + 1);
    for m in &sent.modifiers {
        vks.push(name_to_vk(m.dispatch_name(TargetOs::Windows)).ok_or_else(unknown)?);
    }
    vks.push(key_vk);
    send_vks(&vks);
    Ok(())
}

fn unicode_input(unit: u16, up: bool) -> INPUT {
    let flags = if up {
        KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
    } else {
        KEYEVENTF_UNICODE
    };
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: unit,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Type `text` as `KEYEVENTF_UNICODE` events.
pub(crate) fn type_text(text: &str, clear: bool) -> Result<()> {
    if clear {
        // Internal select-all + delete: bypasses the policy (unchecked path).
        send_vks(&[VK_CONTROL, VIRTUAL_KEY(u16::from(b'A'))]);
        std::thread::sleep(std::time::Duration::from_millis(50));
        send_vks(&[VK_DELETE]);
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    let inputs: Vec<INPUT> = text
        .encode_utf16()
        .flat_map(|unit| [unicode_input(unit, false), unicode_input(unit, true)])
        .collect();
    if !inputs.is_empty() {
        // SAFETY: `inputs` is a valid, initialized INPUT slice for the call's duration.
        unsafe {
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }
    Ok(())
}
