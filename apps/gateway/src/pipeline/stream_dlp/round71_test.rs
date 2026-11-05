//! Round 71: the fail-closed envelope mask covers the choice's envelope
//! lanes and array frames, an unmatched envelope lane that redacts joined is
//! masked, and detection joins a value repeated after a gap once.

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

const SOFT: [FirewallPolicy; 2] = [FirewallPolicy::WarnAndContinue, FirewallPolicy::Sanitize];

fn neither_half(raw: &str) {
    let scanner = scanner();
    for policy in SOFT {
        let (streamed, _) = run_streaming(raw, &offsets(raw), policy.clone(), &scanner).unwrap();
        let (buffered, _, _) = super::super::rewrite_sse_for_dlp(raw, &scanner, &policy).unwrap();
        for out in [&streamed, &buffered] {
            assert!(
                !out.contains("AKIAIOSF") && !out.contains("ODNN7EXAMPLE"),
                "{policy:?}: {out}"
            );
        }
    }
}

#[test]
fn an_overflowed_envelope_masks_the_choices_envelope_lanes() {
    let pad: Map<String, Value> = (0..4096)
        .map(|index| (format!("k{index}"), json!("v")))
        .collect();
    neither_half(&sse(&[
        json!({ "pad": pad, "choices": [{ "index": 0, "delta": { "content": "a " } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "content": "b " }, "stop_reason": "AKIAIOSF" }] }),
        json!({ "choices": [{ "index": 0, "delta": { "content": "c " },
            "stop_reason": "ODNN7EXAMPLE" }] }),
    ]));
}

#[test]
fn an_envelope_array_out_of_position_is_masked_when_it_redacts_joined() {
    neither_half(&sse(&[
        json!({ "x": [{ "index": 1, "v": "AKIAIOSF" }],
            "choices": [{ "index": 0, "delta": { "content": "a " } }] }),
        json!({ "x": [{ "index": 0, "v": "q" }, { "index": 1, "v": "ODNN7EXAMPLE" }],
            "choices": [{ "index": 0, "delta": { "content": "b " } }] }),
    ]));
}

#[test]
fn array_frames_mask_their_elements_envelope() {
    neither_half(&sse(&[
        json!([{ "choices": [{ "index": 0, "delta": { "content": "Hi " } }],
            "system_fingerprint": "AKIAIOSF" }]),
        json!([{ "choices": [], "system_fingerprint": "ODNN7EXAMPLE" }]),
    ]));
}

#[test]
fn a_value_repeated_after_a_gap_frame_is_joined_once() {
    let scanner = scanner();
    let raw = sse(&[
        json!({ "system_fingerprint": "b.cc@x",
            "choices": [{ "index": 0, "delta": { "content": "Hi " } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "content": "there " } }] }),
        json!({ "system_fingerprint": "b.cc@x",
            "choices": [{ "index": 0, "delta": { "content": "ok" } }] }),
    ]);
    let (streamed, blocked) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Block, &scanner).unwrap();
    let (buffered, _, violation) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert!(!blocked && violation.is_none(), "{streamed}");
    assert_eq!(streamed, buffered);
}
