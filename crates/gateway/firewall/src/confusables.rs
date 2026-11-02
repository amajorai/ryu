//! Cross-script Latin-lookalike fold table used by [`crate::normalize_for_scan`].

/// Fold the common Latin-lookalike confusables (Cyrillic + Greek) to ASCII. NFKC
/// does NOT do this (different scripts are not compatibility-equivalent), so this
/// manual table is load-bearing for the homoglyph bypass class. Codepoints are the
/// exact ones the red-team payloads use, plus their obvious siblings.
pub(crate) fn fold_confusable(c: char) -> char {
    match c {
        // Cyrillic lowercase → Latin.
        '\u{0430}' => 'a',
        '\u{0435}' => 'e',
        '\u{043E}' => 'o',
        '\u{0440}' => 'p',
        '\u{0441}' => 'c',
        '\u{0443}' => 'y',
        '\u{0445}' => 'x',
        '\u{0456}' => 'i',
        '\u{0455}' => 's',
        '\u{0458}' => 'j',
        '\u{043A}' => 'k',
        '\u{0501}' => 'd',
        '\u{051B}' => 'q',
        '\u{051D}' => 'w',
        '\u{0432}' => 'v',
        '\u{04CF}' => 'l',
        // Cyrillic uppercase → Latin.
        '\u{0410}' => 'A',
        '\u{0412}' => 'B',
        '\u{0415}' => 'E',
        '\u{041A}' => 'K',
        '\u{041C}' => 'M',
        '\u{041D}' => 'H',
        '\u{041E}' => 'O',
        '\u{0420}' => 'P',
        '\u{0421}' => 'C',
        '\u{0422}' => 'T',
        '\u{0423}' => 'Y',
        '\u{0425}' => 'X',
        '\u{0406}' => 'I',
        '\u{0405}' => 'S',
        '\u{0408}' => 'J',
        // Greek lowercase → Latin.
        '\u{03BF}' => 'o',
        '\u{03B1}' => 'a',
        '\u{03C1}' => 'p',
        '\u{03BD}' => 'v',
        '\u{03B5}' => 'e',
        '\u{03B9}' => 'i',
        '\u{03BA}' => 'k',
        '\u{03C5}' => 'y',
        // Greek uppercase → Latin.
        '\u{0391}' => 'A',
        '\u{0392}' => 'B',
        '\u{0395}' => 'E',
        '\u{0397}' => 'H',
        '\u{0399}' => 'I',
        '\u{039A}' => 'K',
        '\u{039C}' => 'M',
        '\u{039D}' => 'N',
        '\u{039F}' => 'O',
        '\u{03A1}' => 'P',
        '\u{03A4}' => 'T',
        '\u{03A5}' => 'Y',
        '\u{03A7}' => 'X',
        '\u{0396}' => 'Z',
        _ => c,
    }
}

/// Fold the compatibility forms NFKC maps to one ASCII character and that
/// render as that character: superscript and subscript digits, circled digits
/// and letters, the small form variants (`\u{FE6B}` is a small `@`), the one
/// dot leader, and the ideographic full stops used to spell `.` in an address.
/// `None` when `c` is not one of them.
pub(crate) fn fold_compat(c: char) -> Option<char> {
    let cp = c as u32;
    let digit = |offset: u32| char::from_digit(offset, 10);
    let letter = |base: u8, offset: u32| u8::try_from(offset).ok().map(|o| char::from(base + o));
    match cp {
        0x00B9 => Some('1'),
        0x00B2 => Some('2'),
        0x00B3 => Some('3'),
        0x2070 => Some('0'),
        0x2074..=0x2079 => digit(cp - 0x2070),
        0x2080..=0x2089 => digit(cp - 0x2080),
        0x2460..=0x2468 => digit(cp - 0x245F),
        0x24EA => Some('0'),
        0x24B6..=0x24CF => letter(b'A', cp - 0x24B6),
        0x24D0..=0x24E9 => letter(b'a', cp - 0x24D0),
        0x2024 | 0x3002 | 0xFF61 => Some('.'),
        0xFE50..=0xFE6B => small_form(cp),
        _ => None,
    }
}

/// ASCII for the small form variants block (`U+FE50..=U+FE6B`).
fn small_form(cp: u32) -> Option<char> {
    let ascii = match cp {
        0xFE50 => ',',
        0xFE52 => '.',
        0xFE54 => ';',
        0xFE55 => ':',
        0xFE56 => '?',
        0xFE57 => '!',
        0xFE59 => '(',
        0xFE5A => ')',
        0xFE5B => '{',
        0xFE5C => '}',
        0xFE5F => '#',
        0xFE60 => '&',
        0xFE61 => '*',
        0xFE62 => '+',
        0xFE64 => '<',
        0xFE65 => '>',
        0xFE66 => '=',
        0xFE68 => '\\',
        0xFE69 => '$',
        0xFE6A => '%',
        0xFE6B => '@',
        _ => return None,
    };
    Some(ascii)
}
