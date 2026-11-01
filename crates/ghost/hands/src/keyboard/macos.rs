//! macOS keyboard backend: Core Graphics `CGEvent` keyboard events.

use anyhow::Result;
use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

use super::macos_keymap::layout_keycode;
use crate::policy::{KeyCombo, KeyError, TargetOs};

/// Map modifier names to `CGEventFlags`. Unknown names are ignored; callers pass
/// only `Modifier::dispatch_name(TargetOs::Mac)` values.
pub(crate) fn macos_modifier_flags(modifiers: &[&str]) -> CGEventFlags {
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

fn event_source() -> Result<CGEventSource> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| anyhow::anyhow!("CGEventSource"))
}

mod ffi {
    use std::ffi::{c_ulong, c_void};

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGEventCreateKeyboardEvent(
            source: *const c_void,
            keycode: u16,
            keydown: bool,
        ) -> *mut c_void;
        pub fn CGEventKeyboardGetUnicodeString(
            event: *mut c_void,
            max_len: c_ulong,
            actual_len: *mut c_ulong,
            buf: *mut u16,
        );
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFRelease(cf: *const c_void);
    }
}

/// The character `keycode` types on the active layout without modifiers, read
/// from an unposted key-down event (Core Graphics translates it through the
/// current layout). `None` when the event or its string cannot be read.
fn produced_char(keycode: u16) -> Option<char> {
    let mut buf = [0u16; 4];
    let mut len: std::ffi::c_ulong = 0;
    // SAFETY: the event is created here, never posted, and released below; the
    // buffer and length outlive the call.
    unsafe {
        let event = ffi::CGEventCreateKeyboardEvent(std::ptr::null(), keycode, true);
        if event.is_null() {
            return None;
        }
        ffi::CGEventKeyboardGetUnicodeString(event, buf.len() as _, &mut len, buf.as_mut_ptr());
        ffi::CFRelease(event);
    }
    let len = usize::try_from(len).ok()?.min(buf.len());
    char::decode_utf16(buf[..len].iter().copied())
        .next()?
        .ok()
        .filter(|c| !c.is_control())
}

/// The keycode for key `name` on the active layout (see [`layout_keycode`]).
fn keycode_for(name: &str) -> Option<u16> {
    layout_keycode(name, produced_char)
}

/// Dispatch a policy-checked combo. A key the macOS keymap cannot send, or a
/// character the active layout would turn into another one, is
/// `KeyError::UnknownKey`, raised before any event is posted: the key sent is the
/// key the policy checked.
pub(crate) fn press_combo(combo: &KeyCombo) -> Result<()> {
    let keycode = keycode_for(&combo.dispatch_key)
        .ok_or_else(|| anyhow::Error::new(KeyError::UnknownKey(combo.key.clone())))?;
    let mods: Vec<&str> = combo
        .modifiers
        .iter()
        .map(|m| m.dispatch_name(TargetOs::Mac))
        .collect();
    post_key(keycode, macos_modifier_flags(&mods))
}

/// Post a key down (with `flags`) and key up. Bypasses the policy; internal use
/// only (`press_combo` and the select-all in `type_text`).
fn post_key(keycode: u16, flags: CGEventFlags) -> Result<()> {
    let source = event_source()?;
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

/// Type `text` character by character with `CGEventKeyboardSetUnicodeString`.
pub(crate) fn type_text(text: &str, clear: bool) -> Result<()> {
    if clear {
        // Internal select-all (cmd+a): bypasses the policy via the unchecked path, but
        // still uses the layout's "a" key (on AZERTY the ANSI A position is Q).
        let select_all = keycode_for("a").ok_or_else(|| {
            anyhow::anyhow!("select-all is not available on the active keyboard layout")
        })?;
        post_key(select_all, CGEventFlags::CGEventFlagCommand)?;
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    let source = event_source()?;
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
