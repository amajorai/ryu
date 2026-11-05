//! Round 35: the order-free Sanitize rewrite aligns every raw byte, so a
//! literal that also occurs inside a replaced value cannot end its span
//! early and release the rest of the value.

use serde_json::json;

use super::round15_test::{content, sse};
use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn splits(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

#[test]
fn a_trailing_literal_inside_the_value_does_not_shorten_its_span() {
    let scanner = scanner();
    let cases = [
        ("secret=4111 1111 1111 1111 ", "[REDACTED:secret_param] "),
        (
            "password=GB29 NWBK 6016 1331 9268 19 ",
            "[REDACTED:secret_param] ",
        ),
    ];
    for (text, expected) in cases {
        assert_eq!(super::redact::sanitize_text(&scanner, text), expected);
    }
}

#[test]
fn the_union_of_both_orders_covers_a_dotted_email() {
    let scanner = scanner();
    let text =
        "key sk-proj-4111-1111-1111-1111-abcd and secret=4111 1111 1111 1111 for john.doe@example.com.";
    let out = super::redact::sanitize_text(&scanner, text);
    for fragment in ["doe", "example", "4111", "1111", "abcd"] {
        assert!(!out.contains(fragment), "{out}");
    }
    assert!(out.starts_with("key "), "{out}");
}

#[test]
fn a_streamed_iban_after_a_secret_keyword_is_never_released() {
    let scanner = scanner();
    let words = [
        "Use ",
        "password=",
        "GB29 ",
        "NWBK ",
        "6016 ",
        "1331 ",
        "9268 ",
        "19 ",
    ];
    let raw = sse(&words.iter().map(|word| content(word)).collect::<Vec<_>>());
    let (streamed, _) =
        run_streaming(&raw, &splits(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    let (rewritten, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
    let mut value = json!({ "content": words.concat() });
    super::super::sanitize_json_strings(&mut value, &scanner);
    for out in [streamed, rewritten, value.to_string()] {
        for fragment in ["NWBK", "6016", "1331", "9268"] {
            assert!(!out.contains(fragment), "{out}");
        }
    }
}
