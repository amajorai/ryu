//! Unicode-obfuscation pre-pass for the ASCII-oriented regex detection sets.
//!
//! Attacker-controlled text (prompts, tool output, model output) can render as
//! an intact email, card number or instruction while its code points defeat a
//! plain regex: invisible characters split the run, lookalike or fullwidth
//! characters replace ASCII, native-script digits replace `0-9`, and Unicode
//! TAG characters spell a whole instruction that a model reads as ASCII but a
//! human never sees. [`normalize_for_scan`] folds all of these to the ASCII
//! form the patterns expect. It feeds detection only; see
//! [`fold_for_redaction`] for the single-view fold redaction paths can rewrite.

use std::borrow::Cow;
use std::sync::OnceLock;

use regex::Regex;

use crate::confusables::{fold_compat, fold_confusable};

/// Joins the extra views [`normalize_for_scan`] appends when TAG characters are
/// present. Neither `\s` nor `\w` matches NUL and the newlines stop `[^\s]+`
/// runs, so no built-in pattern spans two views.
const VIEW_SEPARATOR: &str = "\n\0\n";

/// Code points of the Unicode TAG block that encode printable ASCII
/// (`U+E0020..=U+E007E` is `' '..='~'` offset by `0xE0000`).
const TAG_ASCII: std::ops::RangeInclusive<u32> = 0xE0020..=0xE007E;
/// The whole TAG block, including the begin/cancel tags that carry no ASCII.
const TAG_BLOCK: std::ops::RangeInclusive<u32> = 0xE0000..=0xE007F;

/// What to do with a TAG character while folding.
#[derive(Clone, Copy, PartialEq)]
enum TagMode {
    /// Decode it to the ASCII character it encodes.
    Decode,
    /// Drop it, keeping only the visible text.
    Strip,
}

/// Normalize `text` for regex scanning so Unicode obfuscation cannot evade the
/// ASCII-oriented pattern sets:
///
/// - strips every `Default_Ignorable_Code_Point` (zero-width joiners and
///   spaces, soft hyphen, CGJ, bidi marks, embeddings, overrides and isolates,
///   Hangul fillers, Mongolian free variation selectors, all variation
///   selectors, the invisible math operators and the rest of `U+E0000..E0FFF`)
///   and the combining marks of the generic combining blocks (underlines,
///   overlays, diacritics stacked on ASCII),
/// - decodes Unicode TAG characters (`U+E0020..E007E`) to the ASCII they
///   encode, because a model reads TAG-spelled text as ASCII,
/// - folds fullwidth ASCII, every Unicode space separator, dash punctuation and
///   minus signs, every Unicode decimal digit (`Nd`), mathematical alphanumeric
///   letters, the single-character compatibility forms (superscript, subscript
///   and circled digits and letters, small form variants such as `﹫`,
///   ideographic full stops), and the common Cyrillic/Greek Latin lookalikes to
///   ASCII.
///
/// When TAG characters are present the result is the in-place fold followed by
/// two more views joined by [`VIEW_SEPARATOR`]: the visible text with the TAG
/// characters dropped, and each decoded TAG run on its own. A TAG run glued to
/// a visible word (`hello` + TAG `ignore previous instructions`) or TAG
/// characters inserted inside visible PII therefore cannot hide a match.
///
/// ASCII is never altered, so ASCII whitespace stays the only boundary the
/// streaming DLP relies on and NUL separators between joined leaves are kept.
/// The all-ASCII common case returns the input borrowed. Encoded payload
/// bodies (base64, hex) and leetspeak stay out of scope for regex.
pub fn normalize_for_scan(text: &str) -> Cow<'_, str> {
    if text.is_ascii() {
        return Cow::Borrowed(text);
    }
    let folded = fold_text(text, TagMode::Decode);
    let runs = tag_runs(text);
    if runs.is_empty() {
        return folded;
    }
    let mut out = folded.into_owned();
    out.push_str(VIEW_SEPARATOR);
    out.push_str(&fold_text(text, TagMode::Strip));
    for run in runs {
        out.push_str(VIEW_SEPARATOR);
        out.push_str(&run);
    }
    Cow::Owned(out)
}

/// The single in-place view of [`normalize_for_scan`]: the same folds, with
/// TAG characters decoded where they stand. Redaction paths that must rewrite
/// the text a provider receives use this when a match survives the raw pass.
pub fn fold_for_redaction(text: &str) -> Cow<'_, str> {
    if text.is_ascii() {
        return Cow::Borrowed(text);
    }
    fold_text(text, TagMode::Decode)
}

fn fold_text(text: &str, tags: TagMode) -> Cow<'_, str> {
    let mut out = String::with_capacity(text.len());
    let mut changed = false;
    for c in text.chars() {
        let cp = c as u32;
        if TAG_ASCII.contains(&cp) {
            changed = true;
            if tags == TagMode::Decode {
                out.push(char::from(u8::try_from(cp - 0xE0000).unwrap_or(b' ')));
            }
            continue;
        }
        if is_default_ignorable(c) || is_combining_mark(c) {
            changed = true;
            continue;
        }
        let folded = fold_char(c);
        changed |= folded != c;
        out.push(folded);
    }
    if changed {
        Cow::Owned(out)
    } else {
        Cow::Borrowed(text)
    }
}

/// Each maximal run of TAG characters decoded to ASCII. Invisible characters
/// between TAG characters do not end a run; any visible character does.
fn tag_runs(text: &str) -> Vec<String> {
    let mut runs = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        let cp = c as u32;
        if TAG_ASCII.contains(&cp) {
            current.push(char::from(u8::try_from(cp - 0xE0000).unwrap_or(b' ')));
        } else if TAG_BLOCK.contains(&cp) || is_default_ignorable(c) || is_combining_mark(c) {
            continue;
        } else if !current.is_empty() {
            runs.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        runs.push(current);
    }
    runs
}

/// `Default_Ignorable_Code_Point` (Unicode `DerivedCoreProperties.txt`): code
/// points with no visible glyph that still split regex-matched runs.
fn is_default_ignorable(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{115F}' | '\u{1160}'
        | '\u{17B4}' | '\u{17B5}' | '\u{180B}'..='\u{180F}'
        | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{206F}'
        | '\u{3164}' | '\u{FE00}'..='\u{FE0F}' | '\u{FEFF}' | '\u{FFA0}'
        | '\u{1BCA0}'..='\u{1BCA3}' | '\u{1D173}'..='\u{1D17A}'
        | '\u{E0000}'..='\u{E0FFF}')
}

/// Combining marks from the generic combining blocks: diacritics, the
/// overlays and underlines (`U+0332` low line, `U+0336` long stroke), the
/// enclosing keycap and circle, and the half marks. Stacked on an ASCII digit
/// or letter they leave it readable (`1̲2̲3̲`) while splitting the regex run.
/// Script-specific vowel signs and viramas are not in these blocks, so Indic
/// and other scripts keep their marks.
fn is_combining_mark(c: char) -> bool {
    matches!(c,
        '\u{0300}'..='\u{036F}' | '\u{0483}'..='\u{0489}' | '\u{1AB0}'..='\u{1AFF}'
        | '\u{1DC0}'..='\u{1DFF}' | '\u{20D0}'..='\u{20FF}' | '\u{FE20}'..='\u{FE2F}')
}

/// Fold one visible character to the ASCII form the patterns expect.
fn fold_char(c: char) -> char {
    let cp = c as u32;
    if c.is_ascii() {
        return c;
    }
    if (0xFF01..=0xFF5E).contains(&cp) {
        // Fullwidth ASCII → ASCII.
        return char::from_u32(cp - 0xFEE0).unwrap_or(c);
    }
    if is_space_separator(c) {
        return ' ';
    }
    if is_dash(c) {
        return '-';
    }
    if let Some(digit) = fold_digit(c) {
        return digit;
    }
    if let Some(ascii) = fold_compat(c) {
        return ascii;
    }
    if (0x1D400..=0x1D6A3).contains(&cp) {
        // Mathematical alphanumeric letters: 13 styles of `A-Z` then `a-z`.
        let index = u8::try_from((cp - 0x1D400) % 52).unwrap_or(0);
        return char::from(if index < 26 {
            b'A' + index
        } else {
            b'a' + index - 26
        });
    }
    fold_confusable(c)
}

/// Unicode space separators (`Zs`) other than the ASCII space.
fn is_space_separator(c: char) -> bool {
    matches!(
        c,
        '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}'
    )
}

/// Dash punctuation (`Pd`) plus the minus signs that render as a hyphen.
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

/// The ASCII digit for a non-ASCII Unicode decimal digit (`Nd`), else `None`.
///
/// `Nd` digits always come in runs of ten ordered `0..=9`, and adjacent runs
/// (the mathematical digits) each start at zero, so the value is the offset
/// from the start of the contiguous `Nd` block modulo ten. Membership uses the
/// regex engine's own `\p{Nd}` table, the same one `\d` matches, so the fold
/// never lags the patterns it feeds.
pub fn fold_digit(c: char) -> Option<char> {
    if c.is_ascii() || !c.is_numeric() || !is_decimal_digit(c) {
        return None;
    }
    let cp = c as u32;
    let mut start = cp;
    // The longest contiguous `Nd` block is the 50 mathematical digits.
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
