//! Released text is compared only where it went out at text level, and a
//! keyword whose value already went out is not carried again.

use serde_json::Value;

use super::round15_test::{assert_parity, content, sse};
use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn per_frame(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

fn contents(sse: &str) -> Vec<String> {
    sse.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .filter_map(|frame| {
            frame
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

fn frames(parts: &[&str], tail: &str, count: usize) -> String {
    let mut frames: Vec<_> = parts.iter().map(|part| content(part)).collect();
    frames.extend((0..count).map(|_| content(tail)));
    sse(&frames)
}

/// Every policy's streamed text equals the buffered rewrite's.
fn assert_warn_parity(raw: &str) {
    assert_parity(raw);
    let scanner = scanner();
    let (oracle, _, _) =
        super::super::rewrite_sse_for_dlp(raw, &scanner, &FirewallPolicy::WarnAndContinue).unwrap();
    let (streamed, _) = run_streaming(
        raw,
        &per_frame(raw),
        FirewallPolicy::WarnAndContinue,
        &scanner,
    )
    .unwrap();
    assert_eq!(contents(&streamed).concat(), contents(&oracle).concat());
}

#[test]
fn a_released_keyword_value_is_not_carried_again() {
    assert_warn_parity(&frames(
        &[
            "Use",
            " Authorization:",
            " Bearer",
            " abcdefghijklmnopqrstuvwx",
        ],
        " word",
        120,
    ));
    assert_warn_parity(&frames(
        &[
            "Use ",
            "Authorization: ",
            "Bearer ",
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN ",
        ],
        "word ",
        120,
    ));
}

#[test]
fn frames_continuing_a_redacted_value_do_not_fail_the_check() {
    assert_warn_parity(&frames(
        &[
            "Call",
            " (555)",
            " 123",
            "-4567",
            " or",
            " email",
            " bob@example.com",
            &format!(" {}", "x".repeat(40)),
        ],
        " word",
        120,
    ));
}

#[test]
fn a_masked_frame_does_not_mask_the_text_after_it() {
    let scanner = scanner();
    let raw = frames(
        &[
            "Authorization: Bearer",
            &" ".repeat(200),
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN ",
        ],
        "word ",
        80,
    );
    for policy in [FirewallPolicy::WarnAndContinue, FirewallPolicy::Sanitize] {
        let (streamed, _) =
            run_streaming(&raw, &per_frame(&raw), policy.clone(), &scanner).unwrap();
        let texts = contents(&streamed);
        assert!(
            texts.iter().rev().take(60).all(|text| text == "word "),
            "{policy:?}: {texts:?}"
        );
    }
}
