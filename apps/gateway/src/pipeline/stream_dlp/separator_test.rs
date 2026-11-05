//! The reasoning-to-answer separator (`FIELD_SEPARATOR`): no built-in pattern
//! matches across it, so the joined scan text judges and redacts each field as
//! its own string, and released text is read back by position.

use std::collections::BTreeMap;

use regex::Regex;
use ryu_gw_firewall::{
    build_outbound_patterns_with_twins, build_pii_patterns_with_twins, build_secret_patterns,
    normalize_for_scan,
};
use serde_json::{json, Value};

use super::super::records::SentFrame;
use super::super::redact::sanitize_text;
use super::super::scan_test::scanner;
use super::super::StreamingDlp;
use crate::config::FirewallPolicy;
use crate::pipeline::FIELD_SEPARATOR as SEP;

/// Ends of a reasoning field that a value or keyword form could continue from.
const TAILS: [&str; 13] = [
    "555-123",
    "123-45",
    "Bearer",
    "api_key:",
    "passport no.",
    "aws secret '",
    "postgres://u",
    "password=",
    "4111 1111 1111",
    "call 1",
    "see sk-abc",
    "\u{7535}\u{8bdd} 555-123",
    "\u{ff15}\u{ff15}\u{ff15}-\u{ff11}\u{ff12}\u{ff13}",
];

/// Starts of an answer field that could complete them.
const HEADS: [&str; 9] = [
    "4567",
    "6789",
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0123 ok",
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN' ok",
    "AB1234567",
    "x:y@host",
    "1111 ok",
    "-555-123-4567",
    "\u{ff14}\u{ff15}\u{ff16}\u{ff17}",
];

fn every_pattern() -> Vec<Regex> {
    let mut patterns = Vec::new();
    for (_, regex, twin) in build_pii_patterns_with_twins() {
        patterns.push(regex);
        patterns.extend(twin);
    }
    for (_, regex, twin) in build_outbound_patterns_with_twins() {
        patterns.push(regex);
        patterns.extend(twin);
    }
    patterns.extend(build_secret_patterns().into_iter().map(|(_, regex)| regex));
    patterns
}

/// Whether any built-in match in `text` touches `at..at + SEP.len()`.
fn crosses(patterns: &[Regex], text: &str, at: usize) -> Option<String> {
    patterns.iter().find_map(|pattern| {
        pattern
            .find_iter(text)
            .find(|found| found.start() < at + SEP.len() && found.end() > at)
            .map(|found| format!("{pattern} matched {:?}", found.as_str()))
    })
}

#[test]
fn no_built_in_pattern_matches_across_the_field_separator() {
    let scanner = scanner();
    let patterns = every_pattern();
    for tail in TAILS {
        for head in HEADS {
            let joined = format!("{tail}{SEP}{head}");
            assert_eq!(
                scanner.scan_outbound(&joined).is_some(),
                scanner.scan_outbound(tail).is_some() || scanner.scan_outbound(head).is_some(),
                "{joined:?}"
            );
            assert_eq!(
                scanner.redact_outbound(&joined).0,
                format!(
                    "{}{SEP}{}",
                    scanner.redact_outbound(tail).0,
                    scanner.redact_outbound(head).0
                ),
                "{joined:?}"
            );
            // Valid here because no side holds both a secret and a PII value
            // in conflicting order: `sanitize_text` picks one order per text,
            // so the joined text's placeholder labels can differ from the
            // per-field ones when the two sides would pick differently (the
            // spans replaced are the same either way).
            assert_eq!(
                sanitize_text(&scanner, &joined),
                format!(
                    "{}{SEP}{}",
                    sanitize_text(&scanner, tail),
                    sanitize_text(&scanner, head)
                ),
                "{joined:?}"
            );
            let normalized = normalize_for_scan(&joined);
            assert_eq!(
                normalized,
                format!(
                    "{}{SEP}{}",
                    normalize_for_scan(tail),
                    normalize_for_scan(head)
                ),
            );
            let crossing = crosses(&patterns, &joined, tail.len())
                .or_else(|| crosses(&patterns, &normalized, normalize_for_scan(tail).len()));
            assert!(crossing.is_none(), "{joined:?}: {crossing:?}");
        }
    }
}

#[test]
fn normalization_keeps_the_field_separator() {
    assert!(normalize_for_scan(&format!("\u{e9}{SEP}x")).contains(SEP));
    assert!(normalize_for_scan(&format!("a{SEP}b")).contains(SEP));
}

/// A reach starting inside a released frame's separator still has the
/// frame's whole body in view: it is compared as sent, not as raw text.
#[test]
fn a_reach_inside_the_separator_compares_the_body_as_sent() {
    let scanner = scanner();
    let before = "thinking ";
    let body = "key sk-abcdefghijklmnopqrstuvwxyz ok ";
    let redacted = scanner.redact_outbound(body).0;
    assert_ne!(redacted, body);
    let start = before.len();
    let mut dlp = StreamingDlp::new(FirewallPolicy::WarnAndContinue, false);
    dlp.text = format!("{before}{SEP}{body}");
    let end = dlp.text.len();
    let frame = |start, end, sent: String, key, separated| SentFrame {
        start,
        end,
        sent,
        key: Some(key),
        separated,
        text_level: true,
        continued: false,
    };
    dlp.recent.push_back(frame(
        0,
        start,
        before.to_owned(),
        "reasoning_content",
        false,
    ));
    dlp.recent.push_back(frame(
        start,
        end,
        format!("{SEP}{redacted}"),
        "content",
        true,
    ));
    dlp.released_end = end;
    for scan_from in start + 1..=start + SEP.len() {
        dlp.scan_from = scan_from;
        let (path, raw, sent) = dlp.released_lane(None).unwrap();
        assert_eq!(path, "/choices/0/delta/content");
        assert_eq!((raw.as_str(), sent.as_str()), (body, redacted.as_str()));
        assert!(!dlp.legacy_mask(end, &BTreeMap::new(), &scanner));
    }
}

fn sse(frames: &[Value]) -> String {
    let mut raw: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
    raw.push_str("data: [DONE]\n\n");
    raw
}

fn field(sse: &str, key: &str) -> String {
    sse.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .filter_map(|frame| {
            frame
                .pointer(&format!("/choices/0/delta/{key}"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

fn delta(key: &str, text: &str) -> Value {
    json!({ "choices": [{ "index": 0, "delta": { key: text } }] })
}

/// Streams whose scan reach comes to start inside the separator, behind a
/// value redacted right after the switch (and, in one variant, a reasoning
/// field that resumes before the answer returns): the stream sends what the
/// buffered path sends, and its record of a separated frame starts with the
/// separator.
#[test]
fn a_reach_starting_inside_the_separator_matches_the_buffered_path() {
    let scanner = scanner();
    let mut offsets = std::collections::BTreeSet::new();
    for (words, resumed) in (0..24).flat_map(|words| [(words, false), (words, true)]) {
        let mut frames: Vec<Value> = (0..words)
            .map(|_| delta("reasoning_content", "w "))
            .collect();
        frames.push(delta("content", "key sk-abcdefghijklmnopqrstuvwxyz ok "));
        frames.extend((0..words % 7).map(|_| delta("content", "a ")));
        if resumed {
            frames.push(delta("reasoning_content", "more thinking "));
            frames.push(delta("content", "and the answer "));
        }
        frames.extend((0..90).map(|_| delta("content", "goes on ")));
        let raw = sse(&frames);
        for policy in [FirewallPolicy::Sanitize, FirewallPolicy::WarnAndContinue] {
            let enforce = !matches!(policy, FirewallPolicy::WarnAndContinue);
            let mut dlp = StreamingDlp::new(policy.clone(), enforce);
            let mut out = String::new();
            for chunk in raw.split_inclusive("\n\n") {
                out.push_str(&dlp.push(chunk.as_bytes(), &scanner).unwrap().bytes);
                for frame in dlp.recent.iter().filter(|frame| frame.separated) {
                    assert!(frame.sent.starts_with(SEP));
                    assert!(!frame.continued);
                    if (frame.start..frame.end).contains(&dlp.scan_from) {
                        offsets.insert(dlp.scan_from - frame.start);
                    }
                }
            }
            out.push_str(&dlp.finish(&scanner).unwrap().bytes);
            let (buffered, _, _) =
                super::super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
            for key in ["content", "reasoning_content"] {
                assert_eq!(
                    field(&out, key),
                    field(&buffered, key),
                    "{policy:?} {words} {resumed}"
                );
            }
            assert!(!field(&out, "content").contains("sk-abc"));
        }
    }
    // At the NUL and at the body start, after it.
    assert!(
        offsets.contains(&1) && offsets.contains(&SEP.len()),
        "reach starts seen inside a separated frame: {offsets:?}"
    );
}
