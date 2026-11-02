//! Custom patterns written for non-ASCII text keep matching: the scanner
//! checks the raw text as well as the Unicode-folded view, so folding Cyrillic
//! lookalikes, dashes or native digits cannot hide what the pattern targets.

use super::*;
use crate::config::{CustomPattern, CustomPatternKind, FirewallConfig};

fn scanner(name: &str, regex: &str) -> FirewallScanner {
    FirewallScanner::new(FirewallConfig {
        custom_patterns: vec![CustomPattern {
            name: name.to_owned(),
            regex: regex.to_owned(),
            kind: CustomPatternKind::Pii,
        }],
        ..FirewallConfig::default()
    })
}

#[test]
fn non_ascii_custom_patterns_match_the_raw_text() {
    let cases = [
        // Cyrillic `секрет`: the fold rewrites с, е and р to Latin.
        ("ru_secret", "секрет", "это секрет проекта"),
        // An en dash the fold rewrites to `-`.
        ("proj_code", "PROJ\u{2013}\\d{4}", "see PROJ\u{2013}1234"),
        // Arabic-Indic digits the fold rewrites to ASCII.
        (
            "ar_id",
            "[\u{0660}-\u{0669}]{6}",
            "id \u{0661}\u{0662}\u{0663}\u{0664}\u{0665}\u{0666}",
        ),
    ];
    for (name, regex, text) in cases {
        let hit = scanner(name, regex).scan_inbound(text);
        assert_eq!(
            hit.map(|m| m.pattern_name).as_deref(),
            Some(name),
            "{name} on {text}"
        );
    }
}

#[test]
fn the_folded_view_still_catches_obfuscated_ascii_targets() {
    let fw = scanner("proj_code", r"\bPROJ-\d{4}\b");
    for text in [
        "PROJ\u{200B}-1234",
        "PROJ\u{2011}\u{0661}\u{0662}\u{0663}\u{0664}",
    ] {
        assert_eq!(
            fw.scan_inbound(text).map(|m| m.pattern_name).as_deref(),
            Some("proj_code"),
            "{text}"
        );
    }
    assert!(fw.scan_inbound("PROJ-12 only").is_none());
}
