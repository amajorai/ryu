//! Protected-brand guard for unreviewed community listings, ported from
//! `packages/db/src/brand-guard.ts` (the web store's guard) so Core's
//! GitHub-topic shelf cannot present a listing under a vendor's or Ryu's own name
//! either. Both suites read `packages/db/fixtures/brand-guard-v1.json`, so the two
//! guards cannot drift.
//!
//! A name is reduced to a skeleton before matching: NFKC (with the lunate sigma
//! read as `c` first); lowercase, NFD and every format character, combining mark
//! and blank filler dropped; Cyrillic / Greek / Armenian / Cherokee / small-capital
//! homoglyphs and leetspeak folded to ASCII, with `i`, `l`, `1`, `|` and `!`
//! written as `l`; split into words (camel case too), with runs of one-letter
//! words re-joined. Vendor marks match anywhere in the squashed skeleton; the
//! house marks `ryu` and `amajor` only as a whole word or fused with an
//! official-sounding qualifier (`RyuHQ`). Only the `display` mode is ported: it is
//! the one a community card needs.

use std::sync::OnceLock;

use regex::Regex;
use unicode_normalization::UnicodeNormalization;

/// Vendor marks matched anywhere in a name's skeleton.
const VENDOR_MARKS: [&str; 8] = [
    "anthropic",
    "claude",
    "openai",
    "chatgpt",
    "gemini",
    "google",
    "copilot",
    "microsoft",
];

/// Short vendor marks matched only at the start or end of a word (`gpt4`).
const SHORT_VENDOR_MARKS: [&str; 1] = ["gpt"];

/// Ryu's own marks: also an ordinary given name / phrase, so word-level only.
const HOUSE_MARKS: [&str; 2] = ["ryu", "amajor"];

/// Words that make a house mark read as an official account or product.
const OFFICIAL_QUALIFIERS: &[&str] = &[
    "admin",
    "agent",
    "ai",
    "app",
    "apps",
    "assistant",
    "beta",
    "client",
    "cloud",
    "desktop",
    "dev",
    "enterprise",
    "hq",
    "inc",
    "labs",
    "marketplace",
    "max",
    "official",
    "plugins",
    "plus",
    "premium",
    "pro",
    "security",
    "staff",
    "store",
    "studio",
    "support",
    "team",
    "verified",
];

/// Look-alike characters and the ASCII letter each one reads as. Same table as
/// `HOMOGLYPHS` in `brand-guard.ts`.
const HOMOGLYPHS: &[(char, char)] = &[
    // Cyrillic
    ('\u{0430}', 'a'),
    ('\u{0432}', 'b'),
    ('\u{0435}', 'e'),
    ('\u{0451}', 'e'),
    ('\u{043a}', 'k'),
    ('\u{043c}', 'm'),
    ('\u{043d}', 'h'),
    ('\u{043e}', 'o'),
    ('\u{0440}', 'p'),
    ('\u{0441}', 'c'),
    ('\u{0442}', 't'),
    ('\u{0443}', 'y'),
    ('\u{0445}', 'x'),
    ('\u{0456}', 'i'),
    ('\u{0458}', 'j'),
    ('\u{0455}', 's'),
    ('\u{0501}', 'd'),
    ('\u{051b}', 'q'),
    ('\u{051d}', 'w'),
    ('\u{04bb}', 'h'),
    ('\u{0491}', 'r'),
    // Greek
    ('\u{03b1}', 'a'),
    ('\u{03b2}', 'b'),
    ('\u{03b3}', 'y'),
    ('\u{03b5}', 'e'),
    ('\u{03b7}', 'n'),
    ('\u{03b9}', 'i'),
    ('\u{03ba}', 'k'),
    ('\u{03bd}', 'v'),
    ('\u{03bf}', 'o'),
    ('\u{03c1}', 'p'),
    ('\u{03c4}', 't'),
    ('\u{03c5}', 'u'),
    ('\u{03c7}', 'x'),
    // Armenian
    ('\u{0570}', 'h'),
    ('\u{0578}', 'n'),
    ('\u{057d}', 'u'),
    ('\u{0585}', 'o'),
    ('\u{04cf}', 'l'),
    ('\u{050d}', 'g'),
    ('\u{04af}', 'y'),
    ('\u{04bd}', 'e'),
    // Greek yot (the lunate sigma `ϲ` is handled before NFKC turns it into `ς`)
    ('\u{03f3}', 'j'),
    // Latin small capitals and lookalikes NFKC/NFD leave alone
    ('\u{0131}', 'i'),
    ('\u{0142}', 'l'),
    ('\u{0251}', 'a'),
    ('\u{0261}', 'g'),
    ('\u{0262}', 'g'),
    ('\u{0269}', 'i'),
    ('\u{026a}', 'i'),
    ('\u{0274}', 'n'),
    ('\u{0280}', 'r'),
    ('\u{028b}', 'u'),
    ('\u{028f}', 'y'),
    ('\u{0299}', 'b'),
    ('\u{029c}', 'h'),
    ('\u{029f}', 'l'),
    ('\u{1d00}', 'a'),
    ('\u{1d04}', 'c'),
    ('\u{1d05}', 'd'),
    ('\u{1d07}', 'e'),
    ('\u{1d0a}', 'j'),
    ('\u{1d0b}', 'k'),
    ('\u{1d0d}', 'm'),
    ('\u{1d0f}', 'o'),
    ('\u{1d18}', 'p'),
    ('\u{1d1b}', 't'),
    ('\u{1d1c}', 'u'),
    ('\u{1d20}', 'v'),
    ('\u{1d21}', 'w'),
    ('\u{1d22}', 'z'),
    ('\u{a731}', 's'),
    // Cherokee capitals (their lowercase forms are looked up through these)
    ('\u{13a0}', 'd'),
    ('\u{13a1}', 'r'),
    ('\u{13a2}', 't'),
    ('\u{13a5}', 'i'),
    ('\u{13a9}', 'y'),
    ('\u{13aa}', 'a'),
    ('\u{13ab}', 'j'),
    ('\u{13ac}', 'e'),
    ('\u{13b3}', 'w'),
    ('\u{13b7}', 'm'),
    ('\u{13bb}', 'h'),
    ('\u{13c0}', 'g'),
    ('\u{13c3}', 'z'),
    ('\u{13d9}', 'v'),
    ('\u{13da}', 's'),
    ('\u{13de}', 'l'),
    ('\u{13df}', 'c'),
    ('\u{13e2}', 'p'),
    ('\u{13e6}', 'k'),
    ('\u{13eb}', 'o'),
    ('\u{13f4}', 'b'),
    // Leetspeak
    ('0', 'o'),
    ('3', 'e'),
    ('4', 'a'),
    ('5', 's'),
    ('7', 't'),
    ('8', 'b'),
    ('9', 'g'),
    ('$', 's'),
    ('@', 'a'),
];

fn homoglyph(c: char) -> Option<char> {
    HOMOGLYPHS
        .iter()
        .find(|(from, _)| *from == c)
        .map(|(_, to)| *to)
}

/// `i`, `l`, `1`, `|` and `!` are interchangeable at a glance, so the skeleton
/// writes every one of them as `l`.
fn fold_char(c: char) -> char {
    let mut upper = c.to_uppercase();
    let upper = match (upper.next(), upper.next()) {
        (Some(single), None) => Some(single),
        _ => None,
    };
    let folded = homoglyph(c)
        .or_else(|| upper.and_then(homoglyph))
        .unwrap_or(c);
    if matches!(folded, 'i' | 'l' | '1' | '|' | '!') {
        'l'
    } else {
        folded
    }
}

fn fold(text: &str) -> String {
    text.chars().map(fold_char).collect()
}

/// Format characters (zero-width, bidi, tags, BOM, soft hyphen), combining
/// marks, and blank fillers that render as nothing.
fn is_invisible(c: char) -> bool {
    static INVISIBLE: OnceLock<Regex> = OnceLock::new();
    let invisible = INVISIBLE.get_or_init(|| {
        Regex::new(r"\A[\p{Cf}\p{Mn}\p{Me}\x{115F}\x{1160}\x{3164}\x{FFA0}\x{2800}]\z")
            .expect("static invisible regex")
    });
    let mut buf = [0u8; 4];
    invisible.is_match(c.encode_utf8(&mut buf))
}

/// `RyuMail` -> `Ryu Mail`, `MyGPTHelper` -> `My GPT Helper`.
fn split_camel_case(text: &str) -> String {
    static LOWER_UPPER: OnceLock<Regex> = OnceLock::new();
    static UPPER_WORD: OnceLock<Regex> = OnceLock::new();
    let lower_upper =
        LOWER_UPPER.get_or_init(|| Regex::new(r"(\p{Ll})(\p{Lu})").expect("static camel regex"));
    let upper_word = UPPER_WORD
        .get_or_init(|| Regex::new(r"(\p{Lu})(\p{Lu}\p{Ll})").expect("static camel regex"));
    let spaced = lower_upper.replace_all(text, "$1 $2");
    upper_word.replace_all(&spaced, "$1 $2").into_owned()
}

fn skeleton_variants(text: &str) -> Vec<String> {
    let compatible: String = text
        .chars()
        .map(|c| match c {
            '\u{03F2}' | '\u{03F9}' => 'c',
            _ => c,
        })
        .collect::<String>()
        .nfkc()
        .collect();
    let mut variants: Vec<String> = Vec::new();
    for form in [compatible.clone(), split_camel_case(&compatible)] {
        let visible: String = form
            .to_lowercase()
            .nfd()
            .filter(|c| !is_invisible(*c))
            .collect();
        let folded = fold(&visible);
        let merged = folded.replace("rn", "m");
        for variant in [folded, merged] {
            if !variants.contains(&variant) {
                variants.push(variant);
            }
        }
    }
    variants
}

/// Words of a skeleton, with runs of one-letter words re-joined (`g p t`).
fn skeleton_words(skeleton: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut run = String::new();
    for word in skeleton
        .split(|c: char| !c.is_ascii_lowercase())
        .filter(|word| !word.is_empty())
    {
        if word.len() == 1 {
            run.push_str(word);
            continue;
        }
        if !run.is_empty() {
            words.push(std::mem::take(&mut run));
        }
        words.push(word.to_owned());
    }
    if !run.is_empty() {
        words.push(run);
    }
    words
}

/// `ryu`, `ryuhq`, `ryuofficial`: the mark alone or fused with qualifiers.
fn house_mark_word(word: &str, mark: &str) -> bool {
    let Some(mut rest) = word.strip_prefix(mark) else {
        return false;
    };
    while !rest.is_empty() {
        let Some(qualifier) = OFFICIAL_QUALIFIERS
            .iter()
            .map(|qualifier| fold(qualifier))
            .find(|qualifier| rest.starts_with(qualifier.as_str()))
        else {
            return false;
        };
        rest = &rest[qualifier.len()..];
    }
    true
}

fn match_words(words: &[String]) -> Option<&'static str> {
    let squashed = words.concat();
    if let Some(mark) = VENDOR_MARKS
        .iter()
        .find(|mark| squashed.contains(fold(mark).as_str()))
    {
        return Some(mark);
    }
    if let Some(mark) = SHORT_VENDOR_MARKS.iter().find(|mark| {
        let folded = fold(mark);
        words
            .iter()
            .any(|word| word.starts_with(folded.as_str()) || word.ends_with(folded.as_str()))
    }) {
        return Some(mark);
    }
    HOUSE_MARKS.iter().copied().find(|mark| {
        let folded = fold(mark);
        squashed == folded || words.iter().any(|word| house_mark_word(word, &folded))
    })
}

/// The protected mark a name impersonates (`display` mode), or `None`.
pub(crate) fn protected_brand_match(text: &str) -> Option<&'static str> {
    if text.trim().is_empty() {
        return None;
    }
    skeleton_variants(text)
        .iter()
        .find_map(|skeleton| match_words(&skeleton_words(skeleton)))
}

/// True when a name reads as a protected vendor's or Ryu's own.
pub(crate) fn is_protected_brand_name(text: &str) -> bool {
    protected_brand_match(text).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shared_web_fixture_matches_in_display_mode() {
        let fixture = include_str!("../../../../packages/db/fixtures/brand-guard-v1.json");
        let rows: Vec<serde_json::Value> = serde_json::from_str(fixture).expect("fixture json");
        let mut checked = 0;
        for row in rows.iter().filter(|row| row["mode"] == "display") {
            let name = row["name"].as_str().expect("name");
            let expected = row["match"].as_str();
            assert_eq!(protected_brand_match(name), expected, "{name:?}");
            checked += 1;
        }
        assert!(checked > 50, "fixture lost its display rows");
    }

    #[test]
    fn lookalike_vendor_and_house_names_match_and_ordinary_names_pass() {
        assert_eq!(protected_brand_match("Cl\u{0430}ude Opus"), Some("claude"));
        assert_eq!(protected_brand_match("RyuMail"), Some("ryu"));
        assert!(is_protected_brand_name("svgl:claude-ai"));
        assert!(!is_protected_brand_name("lucide:brain"));
        assert!(!is_protected_brand_name("Ryuichi Sakamoto tribute"));
        assert!(!is_protected_brand_name("   "));
    }
}
