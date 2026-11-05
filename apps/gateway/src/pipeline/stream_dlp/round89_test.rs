//! Round 89: each choice of an `n` > 1 stream is scanned on its own, as a
//! client merges choices by `index` (and as the non-stream projection keeps
//! each choice's strings apart). A value that forms only where two choices'
//! deltas meet in wire order is no match on either path; one inside a choice
//! is still caught however its chunks interleave with another choice's.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::super::round15_test::{assert_parity, sse};
use super::super::scan_test::{run_streaming, scanner, splits};
use super::super::StreamingDlp;
use crate::config::FirewallPolicy;
use crate::pipeline::{choice_scan_texts, lane_segment, split_boundary, sse_scan_text};

#[path = "round90_test.rs"]
mod round90_test;

const KEY_TAIL: &str = "ABCDEFGHIJKLMNOPQRSTUVWX";

fn delta(index: Value, text: &str) -> Value {
    json!({ "choices": [{ "index": index, "delta": { "content": text } }] })
}

fn c0(text: &str) -> Value {
    delta(json!(0), text)
}

fn c1(text: &str) -> Value {
    delta(json!(1), text)
}

fn per_frame(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

/// Each choice's `delta.content`, grouped by lane (`index` as a client
/// reads it), not by position as `content_of` reads it.
fn content_by_choice(raw: &str) -> BTreeMap<String, String> {
    let mut lanes = BTreeMap::<String, String>::new();
    for frame in raw
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
    {
        let Some(entries) = frame.get("choices").and_then(Value::as_array) else {
            continue;
        };
        for (position, entry) in entries.iter().enumerate() {
            let text = entry.pointer("/delta/content").and_then(Value::as_str);
            lanes
                .entry(lane_segment(entry, position))
                .or_default()
                .push_str(text.unwrap_or_default());
        }
    }
    lanes
}

fn buffered(raw: &str, policy: &FirewallPolicy) -> (String, Option<(String, String)>) {
    let (body, _, found) =
        super::super::super::rewrite_sse_for_dlp(raw, &scanner(), policy).unwrap();
    (body, found)
}

#[test]
fn a_value_formed_only_across_two_choices_passes_on_both_paths() {
    let streams = [
        vec![c0("key: sk-"), c1(KEY_TAIL), c0(" ok")],
        // Both in one frame, by position.
        vec![
            json!({ "choices": [{ "delta": { "content": "key: sk-" } },
                { "delta": { "content": KEY_TAIL } }] }),
            json!({ "choices": [{ "delta": { "content": " ok" } }] }),
        ],
        // Choice 1 before choice 0 in one frame.
        vec![
            c0("key: sk-"),
            json!({ "choices": [{ "index": 1, "delta": { "content": KEY_TAIL } },
                { "index": 0, "delta": { "content": " ok" } }] }),
        ],
        vec![c0("key: sk-"), delta(json!("1"), KEY_TAIL), c0(" ok")],
        vec![c0("key: sk-"), delta(json!("a"), KEY_TAIL), c0(" ok")],
        vec![delta(json!(0.0), "key: sk-"), c1(KEY_TAIL), c0(" ok")],
    ];
    let scanner = scanner();
    for frames in streams {
        super::assert_clean_on_both_paths(&frames);
        let raw = sse(&frames);
        let (oracle, _) = buffered(&raw, &FirewallPolicy::Block);
        for seed in 0..8 {
            let (streamed, blocked) = run_streaming(
                &raw,
                &splits(&raw, seed, 12),
                FirewallPolicy::Block,
                &scanner,
            )
            .unwrap();
            assert!(!blocked, "{raw}");
            assert_eq!(streamed, oracle, "{raw}");
        }
        // Every choice's text goes out verbatim.
        assert_eq!(content_by_choice(&oracle), content_by_choice(&raw), "{raw}");
        let evaluator = super::super::super::evaluator_sanitized(
            &scanner,
            &raw,
            &FirewallPolicy::WarnAndContinue,
        );
        assert!(!evaluator.contains("REDACTED"), "{evaluator}");
    }
}

#[test]
fn a_value_inside_one_choice_is_still_caught() {
    let scanner = scanner();
    let raw = sse(&[c0("key: sk-"), c1("hello "), c0(KEY_TAIL)]);
    assert!(buffered(&raw, &FirewallPolicy::Block).1.is_some());
    let (_, blocked) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked);
    assert_parity(&raw);
    // Choice 0 released before choice 1 latched the stream whole.
    let key = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123";
    let raw = sse(&[
        c0("my key is "),
        c0("sk-ABCDEFGHIJ"),
        c1("x"),
        c0("KLMNOPQRSTUVWXYZ0123 ok"),
    ]);
    assert!(buffered(&raw, &FirewallPolicy::Block).1.is_some());
    let (_, blocked) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked);
    for policy in [FirewallPolicy::Sanitize, FirewallPolicy::WarnAndContinue] {
        let (oracle, _) = buffered(&raw, &policy);
        let (streamed, _) = run_streaming(&raw, &per_frame(&raw), policy, &scanner).unwrap();
        for body in [oracle, streamed] {
            let texts = content_by_choice(&body);
            assert!(!texts["0"].contains(key), "{body}");
        }
    }
}

/// `frames` through the incremental path without `finish`.
fn pushed(frames: &[Value]) -> (StreamingDlp, bool) {
    let scanner = scanner();
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    let mut blocked = false;
    for frame in frames {
        let step = dlp.push(format!("data: {frame}\n\n").as_bytes(), &scanner);
        blocked |= step.unwrap().blocked;
    }
    (dlp, blocked)
}

#[test]
fn a_field_switch_separates_only_its_own_choice() {
    let frames = [
        c0("card 4111 1111"),
        json!({ "choices": [{ "index": 1, "delta": { "reasoning_content": "x" } }] }),
        c0(" 1111 1111"),
    ];
    let primary = "card 4111 1111 1111 1111";
    assert_eq!(choice_scan_texts(&frames)["0"], primary);
    let (dlp, _) = pushed(&frames);
    assert!(primary.ends_with(dlp.text.as_str()), "{:?}", dlp.text);
    assert_eq!(dlp.len(), primary.len());
    let raw = sse(&frames);
    assert!(buffered(&raw, &FirewallPolicy::Block).1.is_some());
    assert_parity(&raw);
    // Choice 1's own reasoning-to-answer switch, across frames: the same
    // verdict as that choice streamed alone.
    let reason = |index: u64, text: &str| json!({ "choices": [{ "index": index, "delta": { "reasoning_content": text } }] });
    for (reasoning, answer) in [("key: sk-", KEY_TAIL), ("ok ", "key: sk-ABCDEFGHIJ")] {
        let answer_tail = [delta(json!(1), "KLMNOPQRSTUVWX"), c1(" done")];
        let alone = sse(&[
            reason(0, reasoning),
            c0(answer),
            c0("KLMNOPQRSTUVWX"),
            c0(" done"),
        ]);
        let mut both = vec![c0("hi "), reason(1, reasoning), c0("there "), c1(answer)];
        both.extend(answer_tail);
        let both = sse(&both);
        let expected = buffered(&alone, &FirewallPolicy::Block).1.is_some();
        assert_eq!(
            buffered(&both, &FirewallPolicy::Block).1.is_some(),
            expected
        );
        let (_, blocked) =
            run_streaming(&both, &per_frame(&both), FirewallPolicy::Block, &scanner()).unwrap();
        assert_eq!(blocked, expected, "{both}");
    }
}

/// Interleave two frame lists, keeping each one's order.
fn interleave(first: &[Value], second: &[Value], seed: u64) -> Vec<Value> {
    let mut state = seed.wrapping_mul(6364136223846793005).wrapping_add(7);
    let (mut a, mut b) = (first.iter(), second.iter());
    let (mut left_a, mut left_b) = (first.len(), second.len());
    let mut out = Vec::with_capacity(left_a + left_b);
    while left_a + left_b > 0 {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
        let take_a = left_b == 0 || (left_a > 0 && (state >> 33) % 2 == 0);
        if take_a {
            out.extend(a.next().cloned());
            left_a -= 1;
        } else {
            out.extend(b.next().cloned());
            left_b -= 1;
        }
    }
    out
}

#[test]
fn interleaving_never_changes_the_verdict() {
    let scanner = scanner();
    let clean = ["The ", "quick ", "brown ", "fox ", "jumps."];
    let mut cases: Vec<Vec<&str>> = super::super::scan_test::secret_cases()
        .into_iter()
        .map(|(_, parts)| parts)
        .collect();
    cases.push(clean.to_vec());
    for (number, zero) in cases.iter().enumerate() {
        for one in &cases {
            let as_choice = |parts: &[&str], index: u64| -> Vec<Value> {
                parts.iter().map(|part| delta(json!(index), part)).collect()
            };
            let alone = |parts: &[&str]| {
                let raw = sse(&as_choice(parts, 0));
                buffered(&raw, &FirewallPolicy::Block).1.is_some()
            };
            let expected = alone(zero) || alone(one);
            let mut sanitized = None;
            for seed in 0..6 {
                let frames = interleave(&as_choice(zero, 0), &as_choice(one, 1), seed);
                let raw = sse(&frames);
                let found = buffered(&raw, &FirewallPolicy::Block).1.is_some();
                assert_eq!(found, expected, "{number}/{seed}: {raw}");
                let (_, blocked) =
                    run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
                assert_eq!(blocked, expected, "{number}/{seed}: {raw}");
                let (oracle, _) = buffered(&raw, &FirewallPolicy::Sanitize);
                let texts = content_by_choice(&oracle);
                assert_eq!(*sanitized.get_or_insert_with(|| texts.clone()), texts);
                let (streamed, _) =
                    run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Sanitize, &scanner)
                        .unwrap();
                // Released choice 0 text went out at text level, the rest
                // per string, so only check that no secret went out raw.
                let sent = content_by_choice(&streamed);
                for (lane, parts) in [("0", zero), ("1", one)] {
                    let secret = parts.concat();
                    let leaked = sent.get(lane).is_some_and(|text| text.contains(&secret));
                    assert!(!(alone(parts) && leaked), "{streamed}");
                }
            }
        }
    }
}

/// Frames as the buffered rewrite holds them (`split_boundary`).
fn split_frames(raw: &str) -> Vec<Value> {
    raw.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .flat_map(|frame| match split_boundary(&frame) {
            Some(halves) => halves.to_vec(),
            None => vec![frame],
        })
        .collect()
}

#[test]
fn single_choice_streams_keep_their_scan_text() {
    let mut streams: Vec<String> = (0..6)
        .map(|seed| super::super::scan_test::long_clean_stream(seed, 120))
        .collect();
    streams.push(sse(&[
        json!({ "choices": [{ "index": 0, "delta": { "reasoning_content": "think " } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "reasoning_content": "on",
            "content": "answer" } }] }),
        c0(" more"),
        json!({ "usage": { "total_tokens": 4 } }),
        json!({ "choices": [] }),
        json!([c0(" in an array")]),
        json!({ "choices": { "0": { "delta": { "content": "object" } } } }),
        delta(json!(0.0), " float"),
        delta(json!("0"), " string"),
    ]));
    for raw in streams {
        let frames = split_frames(&raw);
        let full = sse_scan_text(&frames).0;
        let texts = choice_scan_texts(&frames);
        assert_eq!(texts, BTreeMap::from([("0".to_owned(), full.clone())]));
        // Incrementally, `dlp.text` is the tail of the same text.
        let scanner = scanner();
        let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
        let mut fed = Vec::new();
        for line in raw.split_inclusive("\n\n") {
            dlp.push(line.as_bytes(), &scanner).unwrap();
            fed.extend(split_frames(line));
            let so_far = sse_scan_text(&fed).0;
            assert_eq!(dlp.len(), so_far.len());
            assert_eq!(dlp.text, so_far[dlp.base..], "{line}");
            assert!(dlp.fields.choices.is_empty());
        }
    }
}

#[test]
fn only_choice_zero_frames_are_simple() {
    let mut shapes = super::super::round72_test::choice_shapes();
    shapes.extend([
        c0("a"),
        c1("a"),
        delta(json!(0.0), "a"),
        delta(json!("0"), "a"),
        delta(json!("a"), "a"),
        json!({ "choices": [{ "delta": { "content": "a" } }, { "delta": { "content": "b" } }] }),
        json!({ "choices": [c0("x")["choices"][0].clone(), c1("y")["choices"][0].clone()] }),
    ]);
    for frame in shapes {
        let mut primary = String::new();
        let mut choices = crate::pipeline::ChoiceTexts::default();
        choices.push_frame(&frame, &mut primary);
        if crate::pipeline::simple_content_delta(&frame) {
            assert!(choices.is_empty(), "{frame}");
        }
        // Collecting only appends, whatever came before.
        let mut alone = String::new();
        crate::pipeline::primary_scan_text(&frame, &mut alone);
        assert_eq!(alone, primary, "{frame}");
        for prefix in ["", "earlier text", "caf\u{e9}\n"] {
            let mut text = format!("{prefix}\n");
            crate::pipeline::primary_scan_text(&frame, &mut text);
            assert_eq!(text[prefix.len() + 1..], alone, "{frame}");
            let mut text = format!("{prefix}\n");
            let mut fresh = crate::pipeline::ChoiceTexts::default();
            fresh.push_frame(&frame, &mut text);
            assert_eq!(text[prefix.len() + 1..], alone, "{frame}");
        }
    }
}

#[test]
fn a_redacted_index_masks_the_payload() {
    let scanner = scanner();
    let index = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123";
    let raw = sse(&[c0("hello "), delta(json!(index), "hi"), c0("there")]);
    for policy in [FirewallPolicy::Sanitize, FirewallPolicy::WarnAndContinue] {
        let (oracle, _) = buffered(&raw, &policy);
        let (streamed, _) = run_streaming(&raw, &per_frame(&raw), policy, &scanner).unwrap();
        for body in [&oracle, &streamed] {
            assert!(!body.contains(index), "{body}");
            assert!(!body.contains("\"hi\""), "{body}");
        }
    }
}

/// The block notice the stream sends when nothing was released before.
fn notice(found: &(String, String)) -> String {
    super::super::super::sse_content_frames(&format!(
        "[Ryu firewall] Response blocked by policy: {} ({}).",
        found.0, found.1
    ))
}

#[test]
fn choice_zero_blocks_early_and_another_choice_at_the_end() {
    let (_, blocked) = pushed(&[
        c1("hello"),
        c0("key: sk-ABCDEFGHIJ"),
        c0("KLMNOPQRSTUVWX"),
        c0(" "),
        c0("and more "),
    ]);
    assert!(blocked, "choice 0 blocks before the stream ends");
    // A value split across choice 1's frames is judged at the end, with
    // the buffered path's notice.
    let frames = [
        c1("key: sk-ABCDEFGHIJ"),
        c0("fine "),
        c1("KLMNOPQRSTUVWX"),
        c1(" ok "),
    ];
    let (mut dlp, blocked) = pushed(&frames);
    assert!(!blocked);
    let end = dlp.finish(&scanner()).unwrap();
    assert!(end.blocked);
    let found = buffered(&sse(&frames), &FirewallPolicy::Block).1.unwrap();
    assert_eq!(end.bytes, notice(&found));
    // A choice text is judged before the token sequences, on both paths.
    let tokens = json!({ "choices": [{ "index": 0, "delta": { "content": "ok " },
        "logprobs": { "content": [{ "token": "sk-ABCDEFGHIJ" }, { "token": "KLMNOPQRSTUVWX" }] } }] });
    let frames = [c1("mail jane.doe@"), tokens.clone(), c1("example.com now")];
    let raw = sse(&frames);
    let found = buffered(&raw, &FirewallPolicy::Block).1.unwrap();
    let token_only = buffered(&sse(&[tokens]), &FirewallPolicy::Block).1.unwrap();
    assert_ne!(found.0, token_only.0);
    let (streamed, blocked) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner()).unwrap();
    assert!(blocked);
    assert_eq!(streamed, notice(&found));
    // Other choices' text counts towards the held limit.
    let (dlp, _) = pushed(&frames);
    let held: usize = choice_scan_texts(&split_frames(&raw))
        .values()
        .map(String::len)
        .sum();
    assert_eq!(dlp.text.len() + dlp.fields.choices.bytes(), held);
}
