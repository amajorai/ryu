//! Unicode fold for the export redactor's second pass.
//!
//! The redaction patterns are ASCII-oriented, so PII typed with a CJK IME
//! (fullwidth digits, `＠`), split by zero-width or bidi characters, or written
//! with native-script digits or dash variants slips past them. [`fold`] maps that
//! text to the ASCII form the patterns expect. It must stay identical to
//! `foldShareText` in `packages/api/src/lib/conversation-share-redaction.ts`; the
//! shared fixture `packages/core-client/fixtures/portable-history-redaction-v1.json`
//! pins the parity.
//!
//! The steps, in order: NFKC applied to each character on its own; drop every
//! default-ignorable code point (soft hyphen, CGJ, zero-width and bidi controls,
//! fillers, variation selectors, the TAG block); fold Unicode space separators to a space, dash punctuation and
//! minus signs to `-`, and Unicode decimal digits (`Nd`) to ASCII.

use std::borrow::Cow;
use std::sync::OnceLock;

use regex::Regex;
use unicode_normalization::UnicodeNormalization;

/// The folded view of `text`, borrowed when nothing changes.
pub(super) fn fold(text: &str) -> Cow<'_, str> {
    if text.is_ascii() {
        return Cow::Borrowed(text);
    }
    // NFKC per character, so an ASCII character never composes with a
    // following combining mark: an ASCII run stays an ASCII run.
    let folded: String = text
        .chars()
        .flat_map(|c| std::iter::once(c).nfkc())
        .filter(|c| !is_default_ignorable(*c))
        .map(fold_char)
        .collect();
    if folded == text {
        Cow::Borrowed(text)
    } else {
        Cow::Owned(folded)
    }
}

/// `Default_Ignorable_Code_Point` characters that split a matched run.
fn is_default_ignorable(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{115F}' | '\u{1160}'
        | '\u{17B4}' | '\u{17B5}' | '\u{180B}'..='\u{180F}'
        | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{206F}'
        | '\u{3164}' | '\u{FE00}'..='\u{FE0F}' | '\u{FEFF}' | '\u{FFA0}'
        | '\u{1BCA0}'..='\u{1BCA3}' | '\u{1D173}'..='\u{1D17A}'
        | '\u{E0000}'..='\u{E0FFF}')
}

fn fold_char(c: char) -> char {
    if c.is_ascii() {
        return c;
    }
    if is_space_separator(c) {
        return ' ';
    }
    if is_dash(c) {
        return '-';
    }
    fold_digit(c).unwrap_or(c)
}

fn is_space_separator(c: char) -> bool {
    matches!(
        c,
        '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}'
    )
}

fn is_dash(c: char) -> bool {
    matches!(
        c,
        '\u{02D7}' | '\u{058A}' | '\u{05BE}' | '\u{1400}' | '\u{1806}' | '\u{2010}'
            ..='\u{2015}'
                | '\u{2043}'
                | '\u{2212}'
                | '\u{2796}'
                | '\u{2E17}'
                | '\u{2E1A}'
                | '\u{2E3A}'
                | '\u{2E3B}'
                | '\u{2E40}'
                | '\u{2E5D}'
                | '\u{301C}'
                | '\u{3030}'
                | '\u{30A0}'
                | '\u{FE31}'
                | '\u{FE32}'
                | '\u{FE58}'
                | '\u{FE63}'
                | '\u{10EAD}'
    )
}

/// `Nd` digits come in runs of ten ordered `0..=9`, and adjacent runs each
/// start at zero, so the value is the offset from the start of the contiguous
/// `Nd` block modulo ten.
fn fold_digit(c: char) -> Option<char> {
    if !is_decimal_digit(c) {
        return None;
    }
    let cp = c as u32;
    let mut start = cp;
    for _ in 0..64 {
        match char::from_u32(start - 1) {
            Some(prev) if is_decimal_digit(prev) => start -= 1,
            _ => break,
        }
    }
    char::from_digit((cp - start) % 10, 10)
}

fn is_decimal_digit(c: char) -> bool {
    static ND: OnceLock<Regex> = OnceLock::new();
    let nd = ND.get_or_init(|| Regex::new(r"\A\p{Nd}\z").expect("static Nd regex"));
    let mut buf = [0u8; 4];
    nd.is_match(c.encode_utf8(&mut buf))
}

#[cfg(test)]
mod tests {
    use super::fold;

    #[test]
    fn ascii_is_borrowed_unchanged() {
        assert!(matches!(fold("plain 123"), std::borrow::Cow::Borrowed(_)));
    }

    #[test]
    fn folds_fullwidth_ignorable_dash_and_native_digits() {
        assert_eq!(fold("５５５－１２３"), "555-123");
        assert_eq!(fold("ava＠example.com"), "ava@example.com");
        assert_eq!(fold("123\u{200B}-45\u{2011}6789"), "123-45-6789");
        assert_eq!(fold("١٢٣ ۴۵۶ ४५६"), "123 456 456");
        assert_eq!(fold("a\u{E0041}b\u{2063}c"), "abc");
        assert_eq!(fold("1\u{2212}2\u{00A0}3"), "1-2 3");
    }
}
