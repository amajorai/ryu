//! Round 70: a fixed value released past the path cap is still kept, an
//! envelope past its path cap masks every envelope string, and a repeated
//! envelope value is joined once on both paths.

use serde_json::{json, Map, Value};

use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn offsets(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

fn sse(frames: &[Value]) -> String {
    let mut raw: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
    raw.push_str("data: [DONE]\n\n");
    raw
}

#[test]
fn a_fixed_value_released_past_the_cap_still_heads_its_lane() {
    let scanner = scanner();
    let mut first = json!({ "choices": [{ "index": 0,
        "delta": { "role": "assistant", "content": "Hi " } }] });
    for index in 0..64 {
        first[format!("a{index:02}")] = json!({ "severity": "x" });
    }
    let second = json!({ "choices": [{ "index": 0, "delta": { "content": "there " } }] });
    let third = json!({ "choices": [{ "index": 0, "delta": { "role": "@example.com" } }] });
    // The first two frames arrive in one chunk, so both are released together.
    let raw = format!("data: {first}\n\ndata: {second}\n\ndata: {third}\n\ndata: [DONE]\n\n");
    let chunks = [0, raw.find(&format!("data: {third}")).unwrap()];
    let (streamed, blocked) =
        run_streaming(&raw, &chunks, FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked, "{streamed}");
}

#[test]
fn an_envelope_past_its_path_cap_masks_every_envelope_string() {
    let scanner = scanner();
    let pad: Map<String, Value> = (0..4096)
        .map(|index| (format!("k{index}"), json!("v")))
        .collect();
    let raw = sse(&[
        json!({ "pad": pad, "choices": [{ "index": 0, "delta": { "content": "a " } }] }),
        json!({ "x": "AKIAIOSF", "choices": [{ "index": 0, "delta": { "content": "b " } }] }),
        json!({ "x": "ODNN7EXAMPLE", "choices": [{ "index": 0, "delta": { "content": "c " } }] }),
    ]);
    for policy in [FirewallPolicy::WarnAndContinue, FirewallPolicy::Sanitize] {
        let (streamed, _) = run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        let (buffered, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        for out in [&streamed, &buffered] {
            assert!(
                !out.contains("AKIAIOSF") && !out.contains("ODNN7EXAMPLE"),
                "{policy:?}"
            );
        }
    }
}

#[test]
fn a_repeated_envelope_value_is_joined_once() {
    let scanner = scanner();
    let raw = sse(&[
        json!({ "system_fingerprint": "b.cc@x",
            "choices": [{ "index": 0, "delta": { "content": "Hi " } }] }),
        json!({ "system_fingerprint": "b.cc@x",
            "choices": [{ "index": 0, "delta": { "content": "there " } }] }),
    ]);
    let (streamed, blocked) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Block, &scanner).unwrap();
    let (buffered, _, violation) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert!(!blocked && violation.is_none(), "{streamed}");
    assert_eq!(streamed, buffered);
}
