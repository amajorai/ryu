//! macOS virtual key codes (`kVK_*`, US ANSI layout positions) for the names the
//! macOS dispatcher accepts. Pure data: compiled on every OS under test so the
//! table can be checked on Linux CI too.

/// Resolve a key name to its `kVK_*` code. Case-insensitive.
pub(crate) fn macos_keycode(name: &str) -> Option<u16> {
    Some(match name.to_lowercase().as_str() {
        "return" | "enter" => 0x24,
        "tab" => 0x30,
        "space" => 0x31,
        // Historically `delete` is Backspace on macOS (kVK_Delete).
        "delete" | "backspace" => 0x33,
        "forwarddelete" => 0x75,
        "escape" | "esc" => 0x35,
        "cmd" | "command" => 0x37,
        "shift" => 0x38,
        "option" | "alt" => 0x3A,
        "ctrl" | "control" => 0x3B,
        "home" => 0x73,
        "pageup" => 0x74,
        "end" => 0x77,
        "pagedown" => 0x79,
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
        "f13" => 0x69,
        "f14" => 0x6B,
        "f15" => 0x71,
        "f16" => 0x6A,
        "f17" => 0x40,
        "f18" => 0x4F,
        "f19" => 0x50,
        "f20" => 0x5A,
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
        "=" => 0x18,
        "-" => 0x1B,
        "]" => 0x1E,
        "[" => 0x21,
        "'" => 0x27,
        ";" => 0x29,
        "\\" => 0x2A,
        "," => 0x2B,
        "/" => 0x2C,
        "." => 0x2F,
        "`" => 0x32,
        _ => return None,
    })
}

/// The ANSI positions of the character-producing keys (`kVK_ANSI_*`, excluding
/// Return, Tab and Space), searched for a character on the active layout.
const CHARACTER_KEYCODES: std::ops::RangeInclusive<u16> = 0x00..=0x32;

fn is_character_keycode(code: u16) -> bool {
    CHARACTER_KEYCODES.contains(&code) && !matches!(code, 0x24 | 0x30 | 0x31)
}

/// The keycode that types `name` on the active layout, where `produced(code)` is
/// the character the layout gives that keycode without modifiers (`None` when it
/// cannot tell).
///
/// macOS matches a Cmd shortcut on the character the layout produces, not on the
/// key position, so a US position would send another shortcut on AZERTY or Dvorak
/// (Cmd+A posts Cmd+Q on AZERTY). Named keys (Return, arrows, F-keys) are
/// position-independent and keep their code. A character key uses the ANSI
/// position when the layout produces it there, else the first key that produces
/// it. When no key produces it and the ANSI key gives a non-ASCII character or
/// nothing readable (a non-Latin layout, where macOS resolves Cmd shortcuts
/// through the ASCII-capable layout), the ANSI position is kept. Otherwise the key
/// is refused (`None`): this layout would turn it into a different character.
pub(crate) fn layout_keycode(name: &str, produced: impl Fn(u16) -> Option<char>) -> Option<u16> {
    let ansi = macos_keycode(name)?;
    let mut chars = name.chars();
    let (Some(wanted), None) = (chars.next(), chars.next()) else {
        return Some(ansi);
    };
    if !is_character_keycode(ansi) {
        return Some(ansi);
    }
    let wanted = wanted.to_ascii_lowercase();
    let gives = |code: u16| produced(code).map(|c| c.to_lowercase().next().unwrap_or(c));
    let at_ansi = gives(ansi);
    if at_ansi == Some(wanted) {
        return Some(ansi);
    }
    if let Some(code) = CHARACTER_KEYCODES
        .filter(|&code| is_character_keycode(code) && code != ansi)
        .find(|&code| gives(code) == Some(wanted))
    {
        return Some(code);
    }
    match at_ansi {
        None => Some(ansi),
        Some(c) if !c.is_ascii() => Some(ansi),
        Some(_) => None,
    }
}
