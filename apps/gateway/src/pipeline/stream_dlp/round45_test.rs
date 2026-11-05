//! Round 45: a release never stops right at the end of a redacted value,
//! whose unbounded class would take that boundary's sentinel in; the
//! sentinel scan of a verified split matches its char-by-char form, and a
//! region cache shared across splits changes none of them.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use crate::config::{FirewallConfig, FirewallPolicy};
use crate::firewall::FirewallMatch;

fn offsets(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

fn visible(sse: &str) -> String {
    sse.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .filter_map(|value| {
            value["choices"][0]["delta"]["content"]
                .as_str()
                .map(str::to_owned)
        })
        .collect()
}

#[test]
fn a_value_ending_at_a_frame_boundary_is_redacted_not_masked() {
    let scanner = scanner();
    let cases: [&[&str]; 2] = [
        &["Use", " password", "=", "hunter", " now", " and", " more"],
        &[
            "Try",
            " secret",
            "=",
            "opensesame",
            " then",
            " stop",
            " here",
        ],
    ];
    for parts in cases {
        let mut raw = String::new();
        for part in parts {
            let frame = json!({ "choices": [{ "index": 0, "delta": { "content": part },
                "finish_reason": null }] });
            raw.push_str(&format!("data: {frame}\n\n"));
        }
        raw.push_str("data: [DONE]\n\n");
        for policy in [FirewallPolicy::WarnAndContinue, FirewallPolicy::Sanitize] {
            let (streamed, _) =
                run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
            let (buffered, _, _) =
                super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
            assert_eq!(visible(&streamed), visible(&buffered), "{policy:?}");
            assert!(visible(&streamed).contains("[REDACTED:secret_param] "));
        }
    }
}

/// The verified split's sentinel scan, char by char (the reference form).
fn reference_split(
    output: &str,
    lookup: &std::collections::HashMap<char, usize>,
) -> (Vec<usize>, Vec<String>) {
    let mut pieces = vec![String::new()];
    let mut seen = Vec::new();
    for character in output.chars() {
        if let Some(index) = lookup.get(&character) {
            seen.push(*index);
            pieces.push(String::new());
        } else if let Some(piece) = pieces.last_mut() {
            piece.push(character);
        }
    }
    (seen, pieces)
}

/// The range-tested, slice-copying scan finds the same sentinels and pieces
/// as the char-by-char one, around every range edge and with sentinels the
/// lookup does not hold.
#[test]
fn the_sentinel_scan_matches_the_char_by_char_reference() {
    let alphabet = [
        'a',
        '\u{e9}',
        '\u{D7FF}',
        '\u{E000}',
        '\u{E001}',
        '\u{F8FF}',
        '\u{F900}',
        '\u{FFFD}',
        '\u{EFFFF}',
        '\u{F0000}',
        '\u{FFFFD}',
        '\u{FFFFE}',
        '\u{10_0000}',
        '\u{10FFFD}',
        '\u{10FFFF}',
        '\u{1F600}',
        ' ',
        '@',
    ];
    let keys = [
        '\u{E000}',
        '\u{E001}',
        '\u{F8FF}',
        '\u{F0000}',
        '\u{10FFFD}',
    ];
    let mut state: u64 = 7;
    let mut next = |bound: usize| {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (state >> 33) as usize % bound
    };
    for _ in 0..2000 {
        let lookup: std::collections::HashMap<char, usize> = keys
            .iter()
            .enumerate()
            .filter(|_| next(3) != 0)
            .map(|(index, key)| (*key, index))
            .collect();
        let length = next(24);
        let output: String = (0..length)
            .map(|_| alphabet[next(alphabet.len())])
            .collect();
        let expected = next(4);
        let got = super::redact::sentinel::split_marked(&output, &lookup, expected);
        assert_eq!(
            got,
            reference_split(&output, &lookup),
            "{output:?} {lookup:?}"
        );
    }
}

/// Each span of `bounds` over `region` with every `(start, end, placeholder)`
/// match replaced in the span it starts in; a match's text past that span
/// is dropped.
fn spans_with(region: &str, bounds: &[usize], matches: &[(usize, usize, &str)]) -> Vec<String> {
    let mut spans = Vec::new();
    for pair in bounds.windows(2) {
        let (mut at, end) = (pair[0], pair[1]);
        let mut span = String::new();
        for (start, stop, placeholder) in matches {
            if *stop <= at || end <= *start {
                continue;
            }
            if at <= *start {
                span.push_str(&region[at..*start]);
                span.push_str(placeholder);
            }
            at = (*stop).min(end);
        }
        span.push_str(&region[at..end]);
        spans.push(span);
    }
    spans
}

/// Regions holding private-use characters (sentinels the alphabet skips),
/// characters either side of the sentinel ranges and multi-byte text split
/// exactly at every character and at every word.
#[test]
fn verified_splits_keep_private_use_and_multibyte_text_exact() {
    let scanner = scanner();
    let email = "[REDACTED:EMAIL]";
    let pat = "[REDACTED:gh_pat]";
    let cases: [(&str, &[(usize, usize, &str)]); 3] = [
        (
            "caf\u{e9} \u{E000}\u{E001} john@example.com \u{F8FF}\u{F900} end",
            &[(13, 29, email)],
        ),
        (
            "\u{D7FF}\u{FFFD} ghp_abcdefghijklmnopqrstuvwxyz0123456789 \u{F0000}\u{10FFFD} ok",
            &[(7, 47, pat)],
        ),
        (
            "Mail j@x.io \u{1F600} and \u{E002}x@y.io\u{E003} done",
            &[(5, 11, email), (24, 30, email)],
        ),
    ];
    for (region, matches) in cases {
        let all: Vec<usize> = region
            .char_indices()
            .map(|(at, _)| at)
            .chain([region.len()])
            .collect();
        let mut words: Vec<usize> = region.match_indices(' ').map(|(at, _)| at).collect();
        words.insert(0, 0);
        words.push(region.len());
        for sanitize in [false, true] {
            let transform = super::redact::Transform::new(&scanner, sanitize);
            // Without Sanitize only the token is a match.
            let found: Vec<_> = matches
                .iter()
                .copied()
                .filter(|m| sanitize || m.2 == pat)
                .collect();
            for bounds in [&all, &words] {
                let got = super::redact::split_transformed(region, 0, bounds, &transform);
                let want = spans_with(region, bounds, &found);
                assert_eq!(got, Some(want), "{region} {sanitize}");
            }
        }
    }
}

/// One region cache shared across a region's splits (as `checked_split`
/// shares it) changes no result, whatever the bounds or their order.
#[test]
fn a_shared_region_cache_splits_exactly_as_fresh_ones() {
    let scanner = scanner();
    for sanitize in [false, true] {
        let transform = super::redact::Transform::new(&scanner, sanitize);
        for (region, start, sets) in super::text_level_test::shared_whole_cases() {
            for reverse in [false, true] {
                let whole = std::cell::OnceCell::new();
                let cache = super::redact::RegionCache::new(&whole);
                let mut order: Vec<&Vec<usize>> = sets.iter().collect();
                if reverse {
                    order.reverse();
                }
                for bounds in order {
                    let fresh = super::redact::split_transformed(region, start, bounds, &transform);
                    let shared = super::redact::split_transformed_cached(
                        region, start, bounds, &transform, &cache,
                    );
                    assert_eq!(shared, fresh, "{region} {bounds:?} {sanitize}");
                }
            }
        }
    }
}

/// A shared cache never transforms more often than fresh splits do.
#[test]
fn a_shared_region_cache_transforms_no_more_than_fresh_splits() {
    use std::sync::atomic::Ordering;
    let counting = super::text_level_test::RedactCount {
        inner: scanner(),
        calls: std::sync::atomic::AtomicUsize::new(0),
    };
    let transform = super::redact::Transform::new(&counting, false);
    let region = "key secret=4111 1111 1111 1111 and more";
    let sets = [
        vec![0, 6, 20, 39],
        vec![0, 11, 39],
        vec![2, 15, 39],
        vec![0, 11, 39],
    ];
    let fresh: Vec<_> = sets
        .iter()
        .map(|bounds| super::redact::split_transformed(region, 0, bounds, &transform))
        .collect();
    let fresh_calls = counting.calls.swap(0, Ordering::Relaxed);
    let whole = std::cell::OnceCell::new();
    let cache = super::redact::RegionCache::new(&whole);
    let shared: Vec<_> = sets
        .iter()
        .map(|bounds| {
            super::redact::split_transformed_cached(region, 0, bounds, &transform, &cache)
        })
        .collect();
    assert_eq!(shared, fresh);
    let shared_calls = counting.calls.load(Ordering::Relaxed);
    assert!(shared_calls <= fresh_calls, "{shared_calls} {fresh_calls}");
}

/// Text around the sentinel ranges and their UTF-8 lead bytes.
const EDGE_CHARS: [char; 14] = [
    'a',
    '\u{e9}',
    '\u{4e2d}',
    '\u{D7FF}',
    '\u{E000}',
    '\u{E001}',
    '\u{F8FF}',
    '\u{F900}',
    '\u{FFFD}',
    '\u{F0000}',
    '\u{FFFFD}',
    '\u{FFFFE}',
    '\u{10FFFD}',
    '\u{1F600}',
];

/// The byte scan for present sentinels finds what the char filter finds.
#[test]
fn the_present_sentinel_scan_matches_the_char_filter() {
    let mut texts = vec![
        String::new(),
        "plain ascii".to_owned(),
        "\u{4e2d}\u{6587} text \u{D7FF}\u{E000}\u{F8FF}\u{F900}".to_owned(),
        "\u{F0000}\u{FFFFD}\u{FFFFE}\u{10FFFD}\u{10FFFF} \u{1F600}".to_owned(),
    ];
    texts.push(EDGE_CHARS.iter().collect());
    texts.push(EDGE_CHARS.iter().rev().collect());
    for text in texts {
        let want: std::collections::HashSet<char> = text
            .chars()
            .filter(|c| {
                let code = u32::from(*c);
                (0xE000..=0xF8FF).contains(&code)
                    || (0xF_0000..=0xF_FFFD).contains(&code)
                    || (0x10_0000..=0x10_FFFD).contains(&code)
            })
            .collect();
        assert_eq!(
            super::redact::sentinel::sentinels_in(&text),
            want,
            "{text:?}"
        );
    }
}

/// The range split finds the char-by-char reference's sentinels and pieces
/// with a sentinel at every offset of the surrounding text.
#[test]
fn the_range_split_matches_the_reference_at_every_offset() {
    let keys = ['\u{E000}', '\u{F8FF}', '\u{F0000}', '\u{10FFFD}'];
    let lookup: std::collections::HashMap<char, usize> = keys
        .iter()
        .enumerate()
        .map(|(index, key)| (*key, index))
        .collect();
    let text: String = EDGE_CHARS.iter().collect();
    let cuts: Vec<usize> = text.char_indices().map(|(at, _)| at).take(18).collect();
    for (number, at) in cuts.iter().enumerate() {
        let mut output = text.clone();
        output.insert(*at, keys[number % keys.len()]);
        let (seen, ranges) =
            super::redact::sentinel::split_marked_ranges(&output, |c| lookup.get(&c).copied(), 1);
        let pieces: Vec<String> = ranges.into_iter().map(|r| output[r].to_owned()).collect();
        assert_eq!((seen, pieces), reference_split(&output, &lookup), "{at}");
    }
}

/// The split check before the binary search and in-place compare: a hash
/// lookup, owned pieces and their concatenation.
fn reference_verify(
    output: &str,
    marks: &[(usize, usize)],
    keep: &[bool],
    whole: &str,
    alphabet: &[char],
    bound_count: usize,
) -> Option<Vec<String>> {
    let lookup: std::collections::HashMap<char, usize> = alphabet
        .iter()
        .enumerate()
        .filter(|(index, _)| keep.get(*index).copied().unwrap_or(false))
        .map(|(index, character)| (*character, index))
        .collect();
    let sentinels: Vec<usize> = marks.iter().map(|(_, index)| *index).collect();
    let (seen, mut pieces) = reference_split(output, &lookup);
    if seen != sentinels || pieces.concat() != whole {
        return None;
    }
    let mut segments = vec![String::new(); bound_count - 1];
    for (position, index) in sentinels.iter().enumerate() {
        if *index < segments.len() {
            segments[*index] = std::mem::take(&mut pieces[position + 1]);
        }
    }
    Some(segments)
}

/// `verify` accepts and splits exactly what the reference does, on exact
/// outputs and on ones with a sentinel missing, reordered or extra, an
/// extra byte, or a short piece.
#[test]
fn verify_agrees_with_the_concatenating_reference() {
    let alphabet = [
        '\u{E000}',
        '\u{E002}',
        '\u{F8FF}',
        '\u{F0000}',
        '\u{10FFFD}',
    ];
    let pool = [
        'a',
        'b',
        ' ',
        '\u{e9}',
        '\u{1F600}',
        '\u{E001}',
        '\u{E000}',
        '\u{F0000}',
    ];
    let mut state: u64 = 11;
    let mut next = |bound: usize| {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (state >> 33) as usize % bound
    };
    let mut accepted = 0;
    for _ in 0..4000 {
        let keep: Vec<bool> = (0..alphabet.len()).map(|_| next(4) != 0).collect();
        let marks: Vec<(usize, usize)> = (0..alphabet.len() - 1)
            .filter(|index| keep[*index] && next(3) != 0)
            .map(|index| (0, index))
            .collect();
        let whole: String = (0..next(10)).map(|_| pool[next(5)]).collect();
        let mut chars: Vec<char> = whole.chars().collect();
        let mut cuts: Vec<usize> = marks.iter().map(|_| next(chars.len() + 1)).collect();
        cuts.sort_unstable();
        for (position, (_, index)) in marks.iter().enumerate().rev() {
            chars.insert(cuts[position], alphabet[*index]);
        }
        let len = chars.len();
        match next(5) {
            0 if len > 0 => drop(chars.remove(next(len))),
            1 if len > 1 => chars.swap(next(len - 1), len - 1),
            2 => chars.insert(next(len + 1), pool[next(pool.len())]),
            3 => chars.insert(next(len + 1), alphabet[next(alphabet.len())]),
            _ => {}
        }
        let output: String = chars.into_iter().collect();
        let got = super::redact::sentinel::verify(&output, &marks, &keep, &whole, &alphabet, 5);
        let want = reference_verify(&output, &marks, &keep, &whole, &alphabet, 5);
        accepted += usize::from(want.is_some());
        assert_eq!(got, want, "{output:?} {whole:?} {marks:?} {keep:?}");
    }
    assert!(accepted > 500, "{accepted}");
}

/// `sanitize_text` as it was before it reused a `redact` result for an
/// unchanged or agreeing sanitize pass.
fn reference_sanitize_text(scanner: &dyn crate::firewall::FirewallBackend, text: &str) -> String {
    let redact = |text: &str| scanner.redact_outbound(text).0;
    let redacted = redact(text);
    if redacted == text {
        return redact(&scanner.sanitize(text));
    }
    let secrets_first = redact(&scanner.sanitize(&redacted));
    let pii_first = redact(&scanner.sanitize(text));
    if secrets_first == pii_first {
        return secrets_first;
    }
    let spans = super::spans::replaced_spans;
    let (Some(secrets), Some(pii)) = (spans(text, &secrets_first), spans(text, &pii_first)) else {
        return format!("{}]", super::redact::PLACEHOLDER);
    };
    let merge = |spans: Vec<(usize, usize)>| {
        let mut spans = spans;
        spans.sort_unstable();
        let mut merged: Vec<(usize, usize)> = Vec::new();
        for (start, end) in spans {
            match merged.last_mut() {
                Some(last) if start <= last.1 => last.1 = last.1.max(end),
                _ => merged.push((start, end)),
            }
        }
        merged
    };
    let union = merge(secrets.iter().chain(&pii).copied().collect());
    if union == merge(secrets.clone()) {
        return secrets_first;
    }
    if union == merge(pii.clone()) {
        return pii_first;
    }
    let mut out = String::new();
    let mut cursor = 0;
    for (start, end) in union {
        out.push_str(&text[cursor..start]);
        out.push_str(super::redact::PLACEHOLDER);
        out.push(']');
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    out
}

/// The built-in scanner, but its sanitize pass collapses any text with an
/// outbound secret or a placeholder into one value, so both sanitize passes
/// of a secret-bearing text agree.
struct Collapse(crate::firewall::FirewallScanner);

impl crate::firewall::FirewallBackend for Collapse {
    fn config(&self) -> &FirewallConfig {
        self.0.config()
    }
    fn policy(&self) -> &FirewallPolicy {
        self.0.policy()
    }
    fn outbound_enabled(&self) -> bool {
        self.0.outbound_enabled()
    }
    fn scan_inbound(&self, text: &str) -> Option<FirewallMatch> {
        self.0.scan_inbound(text)
    }
    fn scan_outbound(&self, text: &str) -> Option<FirewallMatch> {
        self.0.scan_outbound(text)
    }
    fn scan_locked_guardrails(&self, text: &str, guardrails: &[String]) -> Option<FirewallMatch> {
        self.0.scan_locked_guardrails(text, guardrails)
    }
    fn sanitize(&self, text: &str) -> String {
        if text.contains("[REDACTED") || self.0.redact_outbound(text).0 != text {
            return "[REDACTED:all] 10.0.0.1".to_owned();
        }
        self.0.sanitize(text)
    }
    fn redact_outbound(&self, text: &str) -> (String, Vec<&'static str>) {
        self.0.redact_outbound(text)
    }
}

/// Reusing `redact(input)` for an unchanged or agreeing sanitize pass gives
/// what running both orders in full gives, on every branch it can take.
#[test]
fn sanitize_text_reuses_redact_only_where_it_is_the_same_result() {
    use crate::firewall::FirewallBackend;
    let (scanner, collapse) = (scanner(), Collapse(scanner()));
    let texts = [
        "",
        "plain answer with nothing in it",
        "Mail john@example.com or call +1 415 555 0100",
        "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok",
        "Authorization: Bearer 10.0.0.1abcdefghijklmnop",
        "Authorization: Bearer abc.10.20.30.40.defghijklmnopqrstu end",
        "secret=4111 1111 1111 1111 ",
        "password=GB29 NWBK 6016 1331 9268 19 ",
        "key sk-proj-4111-1111-1111-1111-abcd and secret=4111 1111 1111 1111 for john.doe@example.com.",
        "[REDACTED:email] stays and \u{E000} private use",
        "card 4111 1111 1111 1111 from 10.0.0.1",
    ];
    let mut hits = [0_usize; 5];
    for backend in [&scanner as &dyn FirewallBackend, &collapse] {
        for text in texts {
            let redacted = backend.redact_outbound(text).0;
            let sanitized = backend.sanitize(text);
            let branch = match (redacted == text, sanitized == text) {
                (true, true) => 0,
                (true, false) => 1,
                (false, true) => 2,
                (false, false) => 3,
            };
            hits[branch] += 1;
            if redacted != text && sanitized == backend.sanitize(&redacted) {
                hits[4] += 1;
            }
            let got = super::redact::sanitize_text(backend, text);
            assert_eq!(got, reference_sanitize_text(backend, text), "{text}");
        }
    }
    assert!(hits.iter().all(|count| *count > 0), "{hits:?}");
}
