//! Text-level redaction of fragmented content deltas (see `redact.rs`).

use serde_json::Value;

use super::scan_test::{bare_stream, provider_frame, run_streaming, scanner, splits};
use super::StreamingDlp;
use crate::config::FirewallPolicy;

/// The client-visible answer: every `choices[0].delta.content`, in order.
fn visible_content(sse: &str) -> String {
    let mut text = String::new();
    for line in sse.lines() {
        let Some(data) = line.strip_prefix("data: ") else {
            continue;
        };
        let Ok(frame) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if let Some(content) = frame
            .pointer("/choices/0/delta/content")
            .and_then(Value::as_str)
        {
            text.push_str(content);
        }
    }
    text
}

/// `text` as provider deltas of 1-6 bytes (on char boundaries), OpenAI-shaped,
/// with the real first chunk (`role`, empty `content`, `refusal: null`).
fn token_stream(text: &str, seed: u64) -> String {
    let first = serde_json::json!({
        "id": "chatcmpl-9x7Yq2LmN4pQ",
        "object": "chat.completion.chunk",
        "model": "gpt-4o-mini-2024-07-18",
        "choices": [{ "index": 0, "delta": { "role": "assistant", "content": "", "refusal": null }, "logprobs": null, "finish_reason": null }]
    });
    let mut raw = format!("data: {first}\n\n");
    let mut state = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
    let mut rest = text;
    let mut index = 0;
    while !rest.is_empty() {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let mut take = 1 + (state >> 33) as usize % 6;
        take = take.min(rest.len());
        while !rest.is_char_boundary(take) {
            take += 1;
        }
        raw.push_str(&provider_frame(index, &rest[..take]));
        rest = &rest[take..];
        index += 1;
    }
    let usage = serde_json::json!({ "id": "chatcmpl-9x7Yq2LmN4pQ", "choices": [], "usage": { "total_tokens": 9 } });
    raw.push_str(&format!("data: {usage}\n\ndata: [DONE]\n\n"));
    raw
}

#[test]
fn openai_first_chunk_with_null_refusal_still_streams_incrementally() {
    let scanner = scanner();
    let answer =
        "Streaming keeps responses responsive while the firewall reads every frame. ".repeat(30);
    let raw = token_stream(&answer, 3);
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    let half = raw.len() / 2;
    let early = dlp.push(&raw.as_bytes()[..half], &scanner).unwrap();
    assert!(
        !visible_content(&early.bytes).is_empty(),
        "OpenAI's `refusal: null` first chunk latched the stream into buffering"
    );
    let rest = dlp.push(&raw.as_bytes()[half..], &scanner).unwrap();
    let done = dlp.finish(&scanner).unwrap();
    let streamed = format!("{}{}{}", early.bytes, rest.bytes, done.bytes);
    assert_eq!(visible_content(&streamed), answer);
}

#[test]
fn a_non_null_refusal_still_buffers() {
    let frame =
        serde_json::json!({ "choices": [{ "index": 0, "delta": { "refusal": "I can't help" } }] });
    assert!(!super::super::simple_content_delta(&frame));
    let tool = serde_json::json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{ "index": 0 }] } }] });
    assert!(!super::super::simple_content_delta(&tool));
    let empty = serde_json::json!({ "choices": [{ "index": 0, "delta": { "content": "x", "tool_calls": [], "refusal": null } }] });
    assert!(super::super::simple_content_delta(&empty));
}

/// Every secret / PII shape, fragmented into realistic 1-6 byte deltas inside
/// a longer answer: no fragment of the value reaches the client, the answer
/// around it survives, and the visible text equals what the non-streaming
/// path produces for the same answer.
#[test]
fn split_values_are_redacted_once_and_the_answer_survives() {
    let scanner = scanner();
    let values = [
        ("openai key", "sk-proj-abcdEFGH1234ijklMNOP5678qrstUVWX"),
        ("github pat", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
        ("email", "jane.doe@example.com"),
        ("ssn", "123-45-6789"),
        ("card", "4111 1111 1111 1111"),
        ("phone", "415-555-0134"),
    ];
    let lead = "The quarterly report shows steady growth across all regions. ".repeat(6);
    let tail = " Thanks, and let me know if anything else is needed. ".repeat(6);
    for policy in [FirewallPolicy::WarnAndContinue, FirewallPolicy::Sanitize] {
        let transform =
            super::redact::Transform::new(&scanner, matches!(policy, FirewallPolicy::Sanitize));
        for (name, value) in values {
            let answer = format!("{lead}Contact: {value} today.{tail}");
            let expected = transform.apply(&answer);
            for seed in 0..12u64 {
                let raw = token_stream(&answer, seed);
                let (streamed, blocked) =
                    run_streaming(&raw, &splits(&raw, seed, 30), policy.clone(), &scanner).unwrap();
                assert!(!blocked);
                let visible = visible_content(&streamed);
                let (buffered, _, _) =
                    super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
                if expected == answer {
                    // Not a protected shape under this policy (PII under warn).
                    assert_eq!(visible, answer, "{name}/{seed}: clean text changed");
                    continue;
                }
                assert!(!visible.contains(value), "{name}/{seed}: value leaked");
                assert_eq!(visible, expected, "{name}/{seed}: streamed text differs");
                assert_eq!(
                    visible_content(&buffered),
                    expected,
                    "{name}/{seed}: buffered text differs"
                );
                assert!(
                    !streamed.contains("\"[REDACTED]\""),
                    "{name}/{seed}: masked"
                );
            }
        }
    }
}

/// A protected value whose start was released before it was recognisable
/// (keyword-padding forms) still never releases the secret: the text-level
/// split is refused and the frames are masked.
#[test]
fn a_match_reaching_into_released_text_falls_back_to_masking() {
    let scanner = scanner();
    let padding = " ".repeat(600);
    let parts: Vec<String> = vec![
        "intro ".repeat(40),
        "Authorization: Bearer".into(),
        padding,
        "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH".into(),
        " trailing".into(),
    ];
    let refs: Vec<&str> = parts.iter().map(String::as_str).collect();
    let raw = bare_stream(&refs);
    for split_seed in 0..6u64 {
        let (streamed, _) = run_streaming(
            &raw,
            &splits(&raw, split_seed, 40),
            FirewallPolicy::WarnAndContinue,
            &scanner,
        )
        .unwrap();
        assert!(!streamed.contains("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"));
    }
}

#[test]
fn split_transformed_merges_frames_a_match_crosses() {
    let scanner = scanner();
    let transform = super::redact::Transform::new(&scanner, true);
    let text = "Contact jane.doe@example.com now";
    // Boundaries: 0 | "Contact jane." | "doe@example.com" | " now"
    let bounds = [0, 13, 28, text.len()];
    let segments = super::redact::split_transformed(text, 0, &bounds, &transform).unwrap();
    assert_eq!(segments.concat(), transform.apply(text));
    assert_eq!(segments[0], "Contact [REDACTED:EMAIL]");
    assert_eq!(segments[1], "");
    assert_eq!(segments[2], " now");
    // A clean region keeps its raw slices.
    let clean = super::redact::split_transformed("abc def", 0, &[0, 3, 7], &transform).unwrap();
    assert_eq!(clean, vec!["abc".to_owned(), " def".to_owned()]);
}

/// Per-frame stream of `parts` with OpenAI-shaped envelopes.
fn frames_of(parts: &[String]) -> String {
    let mut raw = String::new();
    for (index, part) in parts.iter().enumerate() {
        raw.push_str(&provider_frame(index, part));
    }
    raw.push_str("data: [DONE]\n\n");
    raw
}

/// Padding made of many separate tokens (`#`, non-ASCII spaces) between a
/// keyword and its value must not push the keyword out of the scan reach.
#[test]
fn multi_token_keyword_padding_never_releases_the_value() {
    let scanner = scanner();
    let token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";
    let mut passport: Vec<String> = vec!["My passport".into()];
    passport.extend(std::iter::repeat_n(" #".to_owned(), 150));
    passport.extend([" AB1234567".to_owned(), " end.".to_owned()]);
    let mut bearer: Vec<String> = vec!["intro ".repeat(10), "Authorization: Bearer".into()];
    bearer.extend(std::iter::repeat_n(" \u{3000}".to_owned(), 100));
    bearer.push(format!(" {token}"));
    bearer.extend(std::iter::repeat_n(" trailing".to_owned(), 60));
    for (value, parts) in [("AB1234567", passport), (token, bearer)] {
        let raw = frames_of(&parts);
        for policy in [FirewallPolicy::Block, FirewallPolicy::Sanitize] {
            // One frame per chunk, the shape that reached the narrow window.
            let offsets: Vec<usize> = raw.match_indices("data: ").map(|(at, _)| at).collect();
            let (streamed, _) = run_streaming(&raw, &offsets, policy.clone(), &scanner).unwrap();
            assert!(
                !visible_content(&streamed).contains(value),
                "{value:?} released under {policy:?}"
            );
        }
    }
}

/// Under Sanitize, secret rules run before PII rules, so an IP inside a
/// bearer token cannot break the token apart and leak the rest of it.
#[test]
fn sanitize_redacts_secrets_before_pii_inside_them() {
    let scanner = scanner();
    let tail = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
    let answer = format!("Use Bearer 8.8.8.8/{tail} for the call. Contact jane.doe@example.com.");
    let raw = token_stream(&answer, 4);
    let (buffered, _, violation) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
    assert!(violation.is_some());
    assert!(!visible_content(&buffered).contains(tail));
    let (streamed, _) = run_streaming(
        &raw,
        &splits(&raw, 9, 20),
        FirewallPolicy::Sanitize,
        &scanner,
    )
    .unwrap();
    assert!(!visible_content(&streamed).contains(tail));
}

#[test]
fn non_protocol_role_or_finish_reason_keeps_the_per_string_path() {
    let role = serde_json::json!({ "choices": [{ "index": 0, "delta": { "role": "sk-abc", "content": "x" } }] });
    assert!(!super::redact::content_eligible(&role));
    let finish =
        serde_json::json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "ghp_x" }] });
    assert!(!super::redact::content_eligible(&finish));
    let normal = serde_json::json!({ "choices": [{ "index": 0, "delta": { "role": "assistant", "content": "" }, "finish_reason": "stop" }] });
    assert!(super::redact::content_eligible(&normal));
}

/// A buffered payload with more frames than the BMP private-use block still
/// gets one sentinel per boundary instead of masking.
#[test]
fn long_buffered_streams_still_split_at_text_level() {
    let scanner = scanner();
    let mut answer = "word ".repeat(7000);
    answer.push_str("key sk-proj-abcdEFGH1234ijklMNOP5678qrstUVWX done");
    let mut raw = String::new();
    for (index, piece) in answer.split_inclusive(' ').enumerate() {
        raw.push_str(&provider_frame(index, piece));
    }
    raw.push_str("data: [DONE]\n\n");
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::WarnAndContinue)
            .unwrap();
    let visible = visible_content(&buffered);
    assert!(
        visible.ends_with("key [REDACTED:openai_key] done"),
        "{}",
        &visible[visible.len() - 80..]
    );
    assert!(!buffered.contains("\"[REDACTED]\""));
}

/// The built-in scanner, counting `redact_outbound` calls.
pub(super) struct RedactCount {
    pub(super) inner: crate::firewall::FirewallScanner,
    pub(super) calls: std::sync::atomic::AtomicUsize,
}

impl crate::firewall::FirewallBackend for RedactCount {
    fn config(&self) -> &crate::config::FirewallConfig {
        self.inner.config()
    }
    fn policy(&self) -> &FirewallPolicy {
        self.inner.policy()
    }
    fn outbound_enabled(&self) -> bool {
        self.inner.outbound_enabled()
    }
    fn scan_inbound(&self, text: &str) -> Option<crate::firewall::FirewallMatch> {
        self.inner.scan_inbound(text)
    }
    fn scan_outbound(&self, text: &str) -> Option<crate::firewall::FirewallMatch> {
        self.inner.scan_outbound(text)
    }
    fn scan_locked_guardrails(
        &self,
        text: &str,
        guardrails: &[String],
    ) -> Option<crate::firewall::FirewallMatch> {
        self.inner.scan_locked_guardrails(text, guardrails)
    }
    fn sanitize(&self, text: &str) -> String {
        crate::firewall::FirewallBackend::sanitize(&self.inner, text)
    }
    fn redact_outbound(&self, text: &str) -> (String, Vec<&'static str>) {
        self.calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.inner.redact_outbound(text)
    }
}

/// Regions with their offset in the stream and the bound sets split against
/// them, in `checked_split` order (held frames, then the released check).
pub(super) fn shared_whole_cases() -> Vec<(&'static str, usize, Vec<Vec<usize>>)> {
    vec![
        (
            "abc def ghi",
            5,
            vec![vec![5, 8, 16], vec![5, 9, 16], vec![7, 16]],
        ),
        (
            "Contact jane.doe@example.com now",
            0,
            vec![vec![0, 13, 28, 32], vec![0, 8, 32], vec![3, 13, 32]],
        ),
        (
            "key secret=4111 1111 1111 1111 and more",
            10,
            vec![vec![10, 16, 30, 49], vec![10, 21, 49], vec![12, 25, 49]],
        ),
        (
            "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok, Mail j@x.io",
            0,
            vec![vec![0, 12, 50, 62], vec![2, 40, 62], vec![0, 60, 62]],
        ),
        (
            "caf\u{e9} \u{E000} john@example.com \u{1F600} end",
            3,
            vec![vec![3, 8, 13, 23, 34], vec![4, 16, 34], vec![3, 3, 34]],
        ),
        ("ab", 0, vec![vec![1, 0], vec![0, 9], vec![0, 2]]),
    ]
}

/// A `whole` shared across one region's splits changes no result, whatever
/// the bounds or their order, and only ever holds `T(region)`.
#[test]
fn a_shared_whole_splits_exactly_as_fresh_ones() {
    let scanner = scanner();
    for sanitize in [false, true] {
        let transform = super::redact::Transform::new(&scanner, sanitize);
        for (region, start, sets) in shared_whole_cases() {
            for reverse in [false, true] {
                let whole = std::cell::OnceCell::new();
                let mut order: Vec<&Vec<usize>> = sets.iter().collect();
                if reverse {
                    order.reverse();
                }
                for bounds in order {
                    let fresh = super::redact::split_transformed(region, start, bounds, &transform);
                    let shared = super::redact::split_transformed_with(
                        region, start, bounds, &transform, &whole,
                    );
                    assert_eq!(shared, fresh, "{region} {bounds:?} {sanitize}");
                    if let Some(cached) = whole.get() {
                        assert_eq!(*cached, transform.apply(region), "{region}");
                    }
                }
            }
        }
    }
}

/// The cell is what the split reads (the recursion too), so `T(region)` is
/// computed once per cell however many splits share it.
#[test]
fn a_shared_whole_is_computed_once() {
    use std::sync::atomic::Ordering;
    let counting = RedactCount {
        inner: scanner(),
        calls: std::sync::atomic::AtomicUsize::new(0),
    };
    let transform = super::redact::Transform::new(&counting, false);
    let clean = std::cell::OnceCell::new();
    for bounds in [[5, 8, 16], [5, 9, 16], [7, 9, 16]] {
        super::redact::split_transformed_with("abc def ghi", 5, &bounds, &transform, &clean);
    }
    assert_eq!(counting.calls.swap(0, Ordering::Relaxed), 1);
    let region = "key secret=4111 1111 1111 1111 and more";
    let sets = [vec![0, 6, 20, 39], vec![0, 11, 39], vec![2, 15, 39]];
    for bounds in &sets {
        super::redact::split_transformed(region, 0, bounds, &transform);
    }
    let fresh = counting.calls.swap(0, Ordering::Relaxed);
    let whole = std::cell::OnceCell::new();
    for bounds in &sets {
        super::redact::split_transformed_with(region, 0, bounds, &transform, &whole);
    }
    let shared = counting.calls.swap(0, Ordering::Relaxed);
    assert!(shared + sets.len() - 1 <= fresh, "{shared} {fresh}");
    // A planted value is used as is: no split recomputes it.
    let planted = std::cell::OnceCell::from(region.to_owned());
    let raw = super::redact::split_transformed_with(region, 0, &[2, 15, 39], &transform, &planted);
    assert_eq!(counting.calls.load(Ordering::Relaxed), 0);
    assert_eq!(
        raw,
        Some(vec![region[2..15].to_owned(), region[15..].to_owned()])
    );
}

/// Seeded regions and bound sets for the split golden (offset, bounds).
fn split_golden_cases() -> Vec<(String, usize, Vec<usize>)> {
    const WORDS: [&str; 12] = [
        "john@example.com",
        "password=hunter2",
        "4111 1111 1111 1111",
        "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH",
        "10.0.0.12",
        "and",
        "caf\u{e9}",
        "\u{E000}",
        "secret=opensesame",
        "x",
        "Mail",
        "(555) 123-4567",
    ];
    let mut seed = 0x2545_F491_4F6C_DD1D_u64;
    let mut next = |below: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % below as u64) as usize
    };
    let mut cases = Vec::new();
    for _ in 0..160 {
        let mut region = String::new();
        for _ in 0..1 + next(6) {
            region.push_str(WORDS[next(WORDS.len())]);
            region.push_str([" ", "", "\n", ", "][next(4)]);
        }
        let points: Vec<usize> = (0..=region.len())
            .filter(|at| region.is_char_boundary(*at))
            .collect();
        let start = 3 * next(3);
        let mut bounds: Vec<usize> = (0..2 + next(5))
            .map(|_| start + points[next(points.len())])
            .collect();
        bounds.sort_unstable();
        if next(2) == 0 {
            bounds.push(start + region.len());
        }
        cases.push((region, start, bounds));
    }
    cases
}

/// `split_transformed` output over seeded regions, as FNV-1a of every
/// result, matches the digest captured before the prefix loop skipped its
/// exact-repeat splits; those splits no longer run the transform.
#[test]
fn split_transformed_matches_its_golden_without_repeat_splits() {
    use std::sync::atomic::Ordering;
    let counting = RedactCount {
        inner: scanner(),
        calls: std::sync::atomic::AtomicUsize::new(0),
    };
    let mut digest = 0xCBF2_9CE4_8422_2325_u64;
    for sanitize in [false, true] {
        let transform = super::redact::Transform::new(&counting, sanitize);
        for (region, start, bounds) in split_golden_cases() {
            let split = super::redact::split_transformed(&region, start, &bounds, &transform);
            for byte in format!("{split:?};").bytes() {
                digest = (digest ^ u64::from(byte)).wrapping_mul(0x100_0000_01B3);
            }
        }
    }
    assert_eq!(digest, 0xC43B_A044_9551_E590);
    // 1,390 `redact_outbound` calls before the skip.
    let calls = counting.calls.load(Ordering::Relaxed);
    assert!(calls < 1_390, "{calls}");
}
