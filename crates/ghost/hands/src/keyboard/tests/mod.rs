//! Keyboard tests. The keymap table checks are pure and run on every OS; the
//! macOS dispatcher tests exercise only paths that resolve *before* any CGEvent is
//! created or posted. No synthetic key event ever reaches the OS here: a valid
//! `press_key`/`send_hotkey` (which would post) is deliberately never called.

use super::macos_keymap::{layout_keycode, macos_keycode};
use super::*;
use crate::policy::{KeyError, TargetOs};

#[test]
fn keycode_table_maps_every_named_key_to_its_kvk() {
    // Exact kVK_* values: a transposed code is a real bug, so pin the number.
    let expected: &[(&str, u16)] = &[
        ("return", 0x24),
        ("enter", 0x24),
        ("tab", 0x30),
        ("space", 0x31),
        ("delete", 0x33),
        ("backspace", 0x33),
        ("forwarddelete", 0x75),
        ("escape", 0x35),
        ("esc", 0x35),
        ("cmd", 0x37),
        ("command", 0x37),
        ("shift", 0x38),
        ("option", 0x3A),
        ("alt", 0x3A),
        ("ctrl", 0x3B),
        ("control", 0x3B),
        ("home", 0x73),
        ("pageup", 0x74),
        ("end", 0x77),
        ("pagedown", 0x79),
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
        ("f13", 0x69),
        ("f20", 0x5A),
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
        ("-", 0x1B),
        ("=", 0x18),
        (",", 0x2B),
        ("/", 0x2C),
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
    assert_eq!(macos_keycode("f21"), None);
    assert_eq!(macos_keycode("ab"), None);
    assert_eq!(macos_keycode("+"), None);
    assert_eq!(macos_keycode("meta"), None); // never dispatched: Meta => "cmd"
}

#[test]
fn every_canonical_named_key_dispatches_on_macos() {
    for name in [
        "return",
        "enter",
        "escape",
        "esc",
        "tab",
        "space",
        "backspace",
        "delete",
        "del",
        "forwarddelete",
        "home",
        "end",
        "pageup",
        "pagedown",
        "left",
        "right",
        "up",
        "down",
        "cmd",
        "ctrl",
        "alt",
        "shift",
        "super",
        "f1",
        "f12",
        "f20",
    ] {
        let combo = crate::policy::KeyCombo::parse_for(name, &[], TargetOs::Mac).unwrap();
        assert!(
            macos_keycode(&combo.dispatch_key).is_some(),
            "{name} => {}",
            combo.dispatch_key
        );
    }
}

#[test]
fn send_hotkey_empty_is_noop_ok() {
    // Empty combo returns Ok early: no key resolution, no event.
    assert!(send_hotkey(&[]).is_ok());
}

#[test]
fn invalid_keys_and_modifiers_error_before_any_event() {
    let err = press_key("definitely-not-a-key", &[]).unwrap_err();
    assert!(err.to_string().contains("Unknown key"), "got: {err}");
    assert!(matches!(
        err.downcast_ref::<KeyError>(),
        Some(KeyError::UnknownKey(_))
    ));
    let err = press_key("a", &["hyperspace"]).unwrap_err();
    assert!(matches!(
        err.downcast_ref::<KeyError>(),
        Some(KeyError::UnknownModifier(_))
    ));
    assert!(send_hotkey(&["cmd", "not-a-key"]).is_err());
    assert!(send_hotkey(&["not-a-key"]).is_err());
}

#[test]
fn blocked_combos_are_refused_before_any_event() {
    let keys: &[&str] = match TargetOs::current() {
        TargetOs::Mac => &["cmd", "shift", "q"],
        _ => &["alt", "f4"],
    };
    let err = send_hotkey(keys).unwrap_err();
    let key_err = err.downcast_ref::<KeyError>().expect("KeyError");
    assert_eq!(key_err.code(), "POLICY_DENIED");
    assert!(err.to_string().starts_with("POLICY_DENIED: "));
    let (key, mods) = keys.split_last().unwrap();
    assert!(press_key(key, mods).is_err());
    assert!(press_key_with(key, mods, KeyOptions::default()).is_err());
}

#[cfg(target_os = "macos")]
mod macos_flags {
    use super::super::macos::macos_modifier_flags;
    use core_graphics::event::CGEventFlags;

    #[test]
    fn modifier_flags_empty_is_null() {
        assert_eq!(
            macos_modifier_flags(&[]).bits(),
            CGEventFlags::CGEventFlagNull.bits()
        );
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
        let ignored = macos_modifier_flags(&["hyperspace"]);
        assert_eq!(ignored.bits(), CGEventFlags::CGEventFlagNull.bits());
        assert!(macos_modifier_flags(&["CMD"]).contains(CGEventFlags::CGEventFlagCommand));
    }

    #[test]
    fn modifier_dispatch_names_all_map_to_flags() {
        use crate::policy::{Modifier, TargetOs};
        for m in [
            Modifier::Meta,
            Modifier::Ctrl,
            Modifier::Alt,
            Modifier::Shift,
        ] {
            let flags = macos_modifier_flags(&[m.dispatch_name(TargetOs::Mac)]);
            assert_ne!(flags.bits(), CGEventFlags::CGEventFlagNull.bits(), "{m:?}");
        }
    }

    #[test]
    fn type_empty_string_is_ok_and_posts_nothing() {
        // clear=false + empty text: the char loop runs zero times.
        assert!(super::type_text("", false).is_ok());
    }
}

/// A layout as "character per ANSI keycode" for the pure lookup.
fn layout(pairs: &'static [(u16, char)]) -> impl Fn(u16) -> Option<char> {
    move |code| pairs.iter().find(|(c, _)| *c == code).map(|(_, ch)| *ch)
}

#[test]
fn character_keys_follow_the_active_layout() {
    // AZERTY: the ANSI A position (0x00) types "q"; "a" sits at 0x0C.
    let azerty = layout(&[(0x00, 'q'), (0x0C, 'a'), (0x0D, 'z'), (0x06, 'w')]);
    assert_eq!(layout_keycode("a", &azerty), Some(0x0C));
    assert_eq!(layout_keycode("q", &azerty), Some(0x00));
    // Dvorak: "x" is at the ANSI B position; the ANSI X position (0x07) types "q".
    let dvorak = layout(&[(0x07, 'q'), (0x0B, 'x')]);
    assert_eq!(layout_keycode("x", &dvorak), Some(0x0B));
    // US: the ANSI position is used as is.
    let us = layout(&[(0x00, 'a')]);
    assert_eq!(layout_keycode("a", &us), Some(0x00));
}

#[test]
fn a_character_the_layout_turns_into_another_is_refused() {
    // The ANSI A position types a different ASCII letter and no key types "a".
    let odd = layout(&[(0x00, 'q')]);
    assert_eq!(layout_keycode("a", &odd), None);
}

#[test]
fn non_latin_layouts_and_named_keys_keep_their_position() {
    // Russian: no key types "a"; macOS resolves Cmd shortcuts through the
    // ASCII-capable layout, so the ANSI position stays.
    let russian = layout(&[(0x00, 'ф')]);
    assert_eq!(layout_keycode("a", &russian), Some(0x00));
    // Nothing readable: the ANSI position stays.
    assert_eq!(layout_keycode("c", |_| None), Some(0x08));
    // Named keys never depend on the layout.
    let azerty = layout(&[(0x24, 'q')]);
    assert_eq!(layout_keycode("enter", &azerty), Some(0x24));
    assert_eq!(layout_keycode("f5", |_| Some('x')), Some(0x60));
    assert_eq!(layout_keycode("nope", |_| None), None);
}
