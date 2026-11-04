//! Tests for the export redactor's Unicode fold (`redaction::fold`).

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

#[test]
fn folds_look_alikes_full_stops_and_marks_in_mixed_tokens() {
    assert_eq!(fold("ava@\u{0435}xample\u{3002}com"), "ava@example.com");
    assert_eq!(fold("a\u{0301}va 4\u{20E3}"), "ava 4");
    // Prose without an ASCII letter keeps its script and its marks.
    assert_eq!(
        fold("\u{043F}\u{0440}\u{0438}\u{0306}"),
        "\u{043F}\u{0440}\u{0438}\u{0306}"
    );
}

#[test]
fn folds_all_look_alike_addresses_and_credential_keys() {
    // No ASCII letter or digit: the `@`, `_` or `=` marks the token as PII-shaped.
    assert_eq!(
        fold("\u{0430}\u{0441}\u{0435}@\u{0435}\u{0445}\u{0430}\u{0441}\u{0435}\u{3002}\u{0441}\u{043E}"),
        "ace@exace.co"
    );
    assert_eq!(
        fold("\u{0410}\u{0420}\u{0406}_\u{041A}\u{0415}\u{03A5}"),
        "API_KEY"
    );
    assert_eq!(fold("\u{03A4}\u{039F}\u{039A}\u{0395}\u{039D}="), "TOKEN=");
}

#[test]
fn folds_credential_names_and_pem_labels_spelled_wholly_in_look_alikes() {
    // No `@`, `_` or `=` in the token: the look-alike word is the key name.
    assert_eq!(
        fold("\u{03A4}\u{039F}\u{039A}\u{0395}\u{039D} = v"),
        "TOKEN = v"
    );
    assert_eq!(
        fold("\u{0410}\u{0420}\u{0406}-\u{041A}\u{0415}\u{03A5}:"),
        "API-KEY:"
    );
    assert_eq!(
        fold("\"\u{0440}\u{0430}\u{0455}\u{0455}\u{051D}\u{0501}\":"),
        "\"passwd\":"
    );
    assert_eq!(
        fold("\u{0415}\u{0421} \u{039A}\u{0395}\u{03A5}-----"),
        "EC KEY-----"
    );
    // A look-alike word that is not a key name, or a key name with another
    // letter in it, keeps its script.
    assert_eq!(
        fold("\u{0430}\u{0441}\u{0435}:"),
        "\u{0430}\u{0441}\u{0435}:"
    );
    assert_eq!(
        fold("\u{0422}\u{041E}\u{041A}\u{0415}\u{041D}\u{042B}"),
        "\u{0422}\u{041E}\u{041A}\u{0415}\u{041D}\u{042B}"
    );
}

#[test]
fn russian_prose_without_pii_is_unchanged() {
    // "Vot primer: kto-to skazal <<ura>>." Colons, hyphens and quotes are prose.
    let prose = "\u{0412}\u{043E}\u{0442} \u{043F}\u{0440}\u{0438}\u{043C}\u{0435}\u{0440}: \u{043A}\u{0442}\u{043E}-\u{0442}\u{043E} \u{0441}\u{043A}\u{0430}\u{0437}\u{0430}\u{043B} \u{00AB}\u{0443}\u{0440}\u{0430}\u{00BB}.";
    assert!(matches!(fold(prose), std::borrow::Cow::Borrowed(_)));
}

#[test]
fn confusables_are_sorted_for_the_binary_search() {
    assert!(super::CONFUSABLES
        .windows(2)
        .all(|pair| pair[0].0 < pair[1].0));
}

/// Every spelling of a credential name: each `[_-]?` written as `-` or left out.
fn spellings(name: &str) -> Vec<String> {
    let mut parts = name.split("[_-]?");
    let mut out = vec![parts.next().unwrap_or_default().to_owned()];
    for part in parts {
        out = out
            .iter()
            .flat_map(|s| [format!("{s}{part}"), format!("{s}-{part}")])
            .collect();
    }
    out
}

/// Lowercased letter runs a pattern keys on: escapes, classes, lookarounds
/// and flag groups dropped.
fn pattern_words(pattern: &str) -> Vec<String> {
    let mut text = pattern.to_owned();
    for strip in [r"\\.", r"\[[^\]]*\]", r"\(\?<?[!=][^)]*\)", r"\(\?[a-z]+\)"] {
        text = regex::Regex::new(strip)
            .expect("strip")
            .replace_all(&text, " ")
            .into_owned();
    }
    let word = regex::Regex::new("[A-Za-z]{2,}").expect("word");
    word.find_iter(&text)
        .map(|m| m.as_str().to_ascii_lowercase())
        .collect()
}

#[test]
fn look_alike_keywords_cover_every_credential_name_and_pem_label() {
    let listed = |word: &str| super::LOOK_ALIKE_KEYWORDS.contains(&word);
    let pattern = |label: &str| {
        let rule = super::super::rules()
            .iter()
            .find(|rule| rule.label == label);
        rule.expect("redaction rule").pattern.as_str()
    };
    let names =
        regex::Regex::new(r"\(\?:([a-z]+(?:\[_-\]\?[a-z]+)*(?:\|[a-z]+(?:\[_-\]\?[a-z]+)*)+)\)")
            .expect("alternation")
            .captures(pattern("CREDENTIAL"))
            .expect("credential names")[1]
            .to_owned();
    let mut uncovered: Vec<String> = names
        .split('|')
        .flat_map(spellings)
        .filter(|spelling| !spelling.split('-').any(listed))
        .collect();
    for label in ["PRIVATE_KEY", "BEARER"] {
        let words = pattern_words(pattern(label));
        assert!(!words.is_empty(), "{label} keys on no word");
        uncovered.extend(words.into_iter().filter(|word| !listed(word)));
    }
    assert_eq!(uncovered, Vec::<String>::new());
}

#[test]
fn look_alike_keywords_match_the_shared_list() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../packages/core-client/fixtures/look-alike-keywords-v1.json"
    ))
    .expect("keyword fixture json");
    let shared: Vec<&str> = fixture["keywords"]
        .as_array()
        .expect("keywords")
        .iter()
        .filter_map(|k| k.as_str())
        .collect();
    assert_eq!(super::LOOK_ALIKE_KEYWORDS, shared.as_slice());
}

#[test]
fn shared_fold_fixture_matches_core() {
    let fixture =
        include_str!("../../../../../packages/core-client/fixtures/portable-history-fold-v1.json");
    let rows: Vec<serde_json::Value> = serde_json::from_str(fixture).expect("fixture json");
    assert!(!rows.is_empty());
    for row in rows {
        let note = row["note"].as_str().expect("note");
        let input = row["input"].as_str().expect("input");
        let expected = row["folded"].as_str().expect("folded");
        assert_eq!(fold(input), expected, "{note}");
        assert_eq!(fold(expected), expected, "idempotent: {note}");
    }
}

#[test]
fn folds_secret_prefixes_spelled_wholly_in_look_alikes() {
    // No digit, `@`, `_` or `=`: the look-alike prefix marks the token.
    assert_eq!(
        fold("\u{0455}\u{03BA}-\u{0430}\u{0435}\u{043E}\u{0440}\u{0441}\u{0443}\u{0445}\u{0455}\u{0456}\u{0458}\u{04BB}\u{04CF}\u{0501}\u{051B}\u{051D}\u{0410}\u{0412}\u{0415}\u{041A}\u{041C}\u{041D}\u{041E}"),
        concat!("s", "k-aeopcyxsijhldqwABEKMHO") // Test vector, not a credential. gitleaks:allow skipcq
    );
    assert_eq!(
        fold("\u{0410}\u{039A}\u{0406}\u{0410}\u{0412}\u{0415}\u{0396}\u{0397}\u{0406}\u{039A}\u{039C}\u{039D}\u{041E}\u{0420}\u{0422}\u{03A5}\u{0425}\u{0405}\u{0408}\u{0421}"),
        concat!("AK", "IABEZHIKMNOPTYXSJC") // Test vector, not a credential. gitleaks:allow skipcq
    );
    assert_eq!(
        fold("\u{0445}\u{043E}\u{0445}\u{0440}-\u{0430}\u{0441}\u{0435} \"\u{0435}\u{0443}\u{0408}.\u{0430}\u{0441}\u{0435}\""),
        "xoxp-ace \"eyJ.ace\""
    );
}

#[test]
fn folds_look_alike_secrets_in_non_ascii_quotes_or_under_marks() {
    // Curly quotes, guillemets, a combining mark or U+3002 around or inside an
    // all-look-alike key do not keep it in its script.
    assert_eq!(
        fold("\u{201C}\u{0455}\u{03BA}-\u{0430}\u{0435}\u{043E}\u{0440}\u{0441}\u{0443}\u{0445}\u{0455}\u{0456}\u{0458}\u{04BB}\u{04CF}\u{0501}\u{051B}\u{051D}\u{201D}"),
        concat!("\u{201C}s", "k-aeopcyxsijhldqw\u{201D}") // Test vector, not a credential. gitleaks:allow skipcq
    );
    assert_eq!(
        fold("\u{00AB}\u{0410}\u{039A}\u{0406}\u{0410}\u{0412}\u{0415}\u{0396}\u{0397}\u{0406}\u{039A}\u{039C}\u{039D}\u{041E}\u{0420}\u{0422}\u{03A5}\u{0425}\u{0405}\u{0408}\u{0421}\u{00BB}"),
        concat!("\u{00AB}AK", "IABEZHIKMNOPTYXSJC\u{00BB}") // Test vector, not a credential. gitleaks:allow skipcq
    );
    assert_eq!(
        fold("\u{0455}\u{0301}\u{03BA}-\u{0430}\u{0441}\u{0435}\u{3002} \u{00AB}\u{03A4}\u{039F}\u{039A}\u{0395}\u{039D}\u{00BB}:"),
        "sk-ace. \u{00AB}TOKEN\u{00BB}:"
    );
}

#[test]
fn prose_that_only_resembles_a_secret_prefix_keeps_its_script() {
    // A prefix without its dash, a partial prefix, a prefix not at a word
    // start, and Russian and Greek sentences all keep their script.
    for prose in [
        "\u{0455}\u{03BA} \u{0410}\u{039A}\u{0406} \u{0435}\u{0443} \u{0430}\u{0455}\u{03BA}-\u{0430}\u{0441}\u{0435}",
        "\u{0440}\u{0443}\u{0440}\u{0430}-\u{0441}\u{0430}\u{0441}\u{043E}",
        "\u{042D}\u{0442}\u{043E} \u{0441}\u{043E}\u{043A}, \u{0430} \u{043D}\u{0435} \u{0432}\u{043E}\u{0434}\u{0430}: \u{0441}\u{043E}\u{0441}\u{0435}\u{0434} \u{0443}\u{0448}\u{0451}\u{043B}.",
        "\u{039A}\u{03B1}\u{03BB}\u{03B7}\u{03BC}\u{03AD}\u{03C1}\u{03B1} \u{03BA}\u{03CC}\u{03C3}\u{03BC}\u{03B5}, \u{03BF} \u{0386}\u{03BA}\u{03B7}\u{03C2} \u{03B5}\u{03AF}\u{03C0}\u{03B5} \u{03BD}\u{03B1}\u{03B9}.",
        "\u{00AB}\u{0420}\u{043E}\u{0301}\u{0437}\u{0430}\u{00BB}, \u{0441}\u{043A}\u{0430}\u{0437}\u{0430}\u{0301}\u{043B} \u{043E}\u{043D}. \u{201C}\u{0410}\u{039A}\u{0406}\u{201D} \u{0438} \u{00AB}\u{0455}\u{03BA}\u{00BB}, \u{00AB}\u{0441}\u{043E}\u{0441}\u{0435}\u{0301}\u{00BB}.",
    ] {
        assert!(matches!(fold(prose), std::borrow::Cow::Borrowed(_)), "{prose}");
    }
}

/// The literal prefixes a case-sensitive secret rule opens with, each
/// alternative and one-letter class written out; `None` when the prefix holds
/// an `_` (such a token folds already) or the rule opens otherwise.
fn literal_prefixes(pattern: &str) -> Option<Vec<String>> {
    let shape =
        regex::Regex::new(r"^\\b(?:\(\?:([A-Za-z|]+)\)|([A-Za-z]+))(?:\[([a-z]+)\])?([-_]?)")
            .expect("prefix shape");
    let captures = shape.captures(pattern)?;
    let separator = captures.get(4).map_or("", |m| m.as_str());
    if separator == "_" {
        return None;
    }
    let heads: Vec<&str> = match captures.get(1) {
        Some(alternatives) => alternatives.as_str().split('|').collect(),
        None => vec![captures.get(2)?.as_str()],
    };
    let tails: Vec<String> = captures.get(3).map_or_else(
        || vec![String::new()],
        |class| class.as_str().chars().map(String::from).collect(),
    );
    Some(
        heads
            .iter()
            .flat_map(|head| {
                tails
                    .iter()
                    .map(move |tail| format!("{head}{tail}{separator}"))
            })
            .collect(),
    )
}

#[test]
fn look_alike_secret_prefixes_cover_every_prefix_keyed_rule() {
    let prefixes: Vec<String> = super::super::rules()
        .iter()
        .filter(|rule| matches!(rule.kind, super::super::Kind::Secret))
        .filter_map(|rule| literal_prefixes(rule.pattern.as_str()))
        .flatten()
        .collect();
    assert!(
        prefixes.iter().any(|prefix| prefix == "sk-"),
        "{prefixes:?}"
    );
    let uncovered: Vec<&String> = prefixes
        .iter()
        .filter(|prefix| !super::LOOK_ALIKE_SECRET_PREFIXES.contains(&prefix.as_str()))
        .collect();
    assert_eq!(uncovered, Vec::<&String>::new());
}

#[test]
fn look_alike_secret_prefixes_match_the_shared_list() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../packages/core-client/fixtures/look-alike-keywords-v1.json"
    ))
    .expect("keyword fixture json");
    let shared: Vec<&str> = fixture["prefixes"]
        .as_array()
        .expect("prefixes")
        .iter()
        .filter_map(|p| p.as_str())
        .collect();
    assert_eq!(super::LOOK_ALIKE_SECRET_PREFIXES, shared.as_slice());
}
