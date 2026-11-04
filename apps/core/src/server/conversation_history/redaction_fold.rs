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
//! minus signs to `-`, and Unicode decimal digits (`Nd`) to ASCII; inside every
//! token (split on ASCII whitespace, NEL and the line/paragraph separators) that
//! holds an ASCII letter or digit, an `@`, an `_` or an `=`, or that spells a
//! credential name or PEM label wholly in look-alikes ([`folds_look_alikes`]),
//! fold Cyrillic and Greek look-alike letters
//! ([`CONFUSABLES`]) and the ideographic full stop `U+3002` to ASCII; finally
//! drop combining marks (`Mn`, `Me`) that sit on an ASCII character. The second
//! shared fixture, `packages/core-client/fixtures/portable-history-fold-v1.json`,
//! pins the fold itself.

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
    let spaced: String = text
        .chars()
        .flat_map(|c| std::iter::once(c).nfkc())
        .filter(|c| !is_default_ignorable(*c))
        .map(fold_char)
        .collect();
    let folded = drop_marks_on_ascii(&fold_mixed_script_tokens(&spaced));
    if folded == text {
        Cow::Borrowed(text)
    } else {
        Cow::Owned(folded)
    }
}

/// Cyrillic and Greek letters drawn like an ASCII letter, sorted by code point.
/// Folded only inside a token that [`folds_look_alikes`], so a mixed-script or
/// all-look-alike address reads as ASCII while Russian or Greek prose is left
/// alone. Same table as `CONFUSABLES` beside `foldShareText` and `foldRedactionText`.
const CONFUSABLES: &[(char, char)] = &[
    ('\u{0391}', 'A'),
    ('\u{0392}', 'B'),
    ('\u{0395}', 'E'),
    ('\u{0396}', 'Z'),
    ('\u{0397}', 'H'),
    ('\u{0399}', 'I'),
    ('\u{039A}', 'K'),
    ('\u{039C}', 'M'),
    ('\u{039D}', 'N'),
    ('\u{039F}', 'O'),
    ('\u{03A1}', 'P'),
    ('\u{03A4}', 'T'),
    ('\u{03A5}', 'Y'),
    ('\u{03A7}', 'X'),
    ('\u{03B1}', 'a'),
    ('\u{03B9}', 'i'),
    ('\u{03BA}', 'k'),
    ('\u{03BD}', 'v'),
    ('\u{03BF}', 'o'),
    ('\u{03C1}', 'p'),
    ('\u{03C5}', 'u'),
    ('\u{03C7}', 'x'),
    ('\u{0405}', 'S'),
    ('\u{0406}', 'I'),
    ('\u{0408}', 'J'),
    ('\u{0410}', 'A'),
    ('\u{0412}', 'B'),
    ('\u{0415}', 'E'),
    ('\u{041A}', 'K'),
    ('\u{041C}', 'M'),
    ('\u{041D}', 'H'),
    ('\u{041E}', 'O'),
    ('\u{0420}', 'P'),
    ('\u{0421}', 'C'),
    ('\u{0422}', 'T'),
    ('\u{0423}', 'Y'),
    ('\u{0425}', 'X'),
    ('\u{0430}', 'a'),
    ('\u{0435}', 'e'),
    ('\u{043E}', 'o'),
    ('\u{0440}', 'p'),
    ('\u{0441}', 'c'),
    ('\u{0443}', 'y'),
    ('\u{0445}', 'x'),
    ('\u{0455}', 's'),
    ('\u{0456}', 'i'),
    ('\u{0458}', 'j'),
    ('\u{04AE}', 'Y'),
    ('\u{04BB}', 'h'),
    ('\u{04C0}', 'I'),
    ('\u{04CF}', 'l'),
    ('\u{0501}', 'd'),
    ('\u{051A}', 'Q'),
    ('\u{051B}', 'q'),
    ('\u{051C}', 'W'),
    ('\u{051D}', 'w'),
];

fn confusable(c: char) -> Option<char> {
    CONFUSABLES
        .binary_search_by_key(&c, |&(from, _)| from)
        .ok()
        .map(|index| CONFUSABLES[index].1)
}

/// ASCII whitespace plus NEL and the line and paragraph separators: what ends a
/// token once space separators have been folded to a space.
fn is_token_separator(c: char) -> bool {
    matches!(c, '\t'..='\r' | ' ' | '\u{85}' | '\u{2028}' | '\u{2029}')
}

/// Whether a token is shaped like PII or a credential rather than prose: it
/// holds an ASCII letter or digit, an `@` (an address written wholly in
/// look-alike letters), or an `_` or `=` (a credential key such as `API_KEY` or
/// `TOKEN=` written wholly in look-alike letters), or it is a look-alike
/// spelling of a credential name or PEM label ([`is_look_alike_keyword`]), such
/// as `TOKEN:` or `KEY-----`. Prose colons, hyphens and punctuation do not
/// qualify on their own, so ordinary Russian or Greek text keeps its script.
/// Same rule as `isPiiShapedToken` beside `foldShareText` and
/// `foldRedactionText`.
fn folds_look_alikes(token: &str) -> bool {
    token
        .bytes()
        .any(|b| b.is_ascii_alphanumeric() || matches!(b, b'@' | b'_' | b'='))
        || is_look_alike_keyword(token)
}

/// The credential names and PEM labels the redaction patterns key on,
/// lowercased, one word between punctuation: every spelling of a name, with
/// each optional `[_-]` separator written as `-` or left out, has a listed
/// word. Same list as `LOOK_ALIKE_KEYWORDS` beside `foldShareText` and
/// `foldRedactionText`; `packages/core-client/fixtures/look-alike-keywords-v1.json`
/// pins the parity.
const LOOK_ALIKE_KEYWORDS: &[&str] = &[
    "accesskey",
    "accesstoken",
    "apikey",
    "authorization",
    "authtoken",
    "awssecretaccesskey",
    "basic",
    "bearer",
    "begin",
    "clientsecret",
    "connection",
    "connectionstring",
    "database",
    "databaseurl",
    "ec",
    "end",
    "key",
    "openssh",
    "passwd",
    "password",
    "private",
    "privatekey",
    "refreshtoken",
    "rsa",
    "secret",
    "secretaccesskey",
    "token",
];

/// Whether a token is spelled wholly in look-alike letters ([`CONFUSABLES`])
/// and ASCII punctuation, and one of its punctuation-delimited words reads as a
/// [`LOOK_ALIKE_KEYWORDS`] entry: `TOKEN = value`, `"API-KEY": value` or a PEM
/// `KEY-----` armor line with every letter a look-alike, where no `@`, `_` or
/// `=` sits in the token. Its fold looks the same as the token, so a Russian
/// or Greek word that happens to match loses nothing visible.
fn is_look_alike_keyword(token: &str) -> bool {
    let mut found = false;
    let mut word = String::new();
    for c in token.chars().chain(std::iter::once(' ')) {
        if c == ' ' || c.is_ascii_punctuation() {
            found |= LOOK_ALIKE_KEYWORDS.contains(&word.as_str());
            word.clear();
        } else if let Some(ascii) = confusable(c) {
            word.push(ascii.to_ascii_lowercase());
        } else {
            return false;
        }
    }
    found
}

fn fold_token(token: &str, out: &mut String) {
    if !folds_look_alikes(token) {
        out.push_str(token);
        return;
    }
    out.extend(token.chars().map(|c| match c {
        '\u{3002}' => '.',
        _ => confusable(c).unwrap_or(c),
    }));
}

/// Fold look-alike letters and the ideographic full stop in every PII-shaped
/// token ([`folds_look_alikes`]).
fn fold_mixed_script_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut start = 0;
    for (index, c) in text.char_indices() {
        if is_token_separator(c) {
            fold_token(&text[start..index], &mut out);
            out.push(c);
            start = index + c.len_utf8();
        }
    }
    fold_token(&text[start..], &mut out);
    out
}

/// Drop combining marks (`Mn`, `Me`) that sit on an ASCII character, so an
/// accent stacked on an address or a number no longer splits the match.
fn drop_marks_on_ascii(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut on_ascii = false;
    for c in text.chars() {
        if on_ascii && is_combining_mark(c) {
            continue;
        }
        on_ascii = c.is_ascii();
        out.push(c);
    }
    out
}

fn is_combining_mark(c: char) -> bool {
    static MARK: OnceLock<Regex> = OnceLock::new();
    let mark = MARK.get_or_init(|| Regex::new(r"\A[\p{Mn}\p{Me}]\z").expect("static mark regex"));
    let mut buf = [0u8; 4];
    mark.is_match(c.encode_utf8(&mut buf))
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
#[path = "redaction_fold_tests.rs"]
mod tests;
