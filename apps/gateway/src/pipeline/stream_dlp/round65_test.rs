//! Round 65: the buffered envelope pass observes the provider frames whole
//! (a split frame's reasoning_details included), and a mask covers a string
//! choice `index` that a lane joined.

use serde_json::{json, Value};

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

const POLICIES: [FirewallPolicy; 2] = [FirewallPolicy::Sanitize, FirewallPolicy::WarnAndContinue];

#[test]
fn a_split_frames_details_signature_is_masked_on_both_paths() {
    let scanner = scanner();
    let details = |text: &str, signature: &str| json!([{ "type": "reasoning.text", "text": text, "signature": signature, "index": 0 }]);
    let raw = sse(&[
        json!({ "id": "g", "choices": [{ "index": 0, "delta": { "role": "assistant",
            "reasoning": "Plan. ", "reasoning_details": details("Plan. ", "sk-abcdefghij") } }] }),
        json!({ "id": "g", "choices": [{ "index": 0, "delta": { "reasoning": "Done. ",
            "content": "Hi.", "reasoning_details": details("Done. ", "klmnopqrstuvwxyz") } }] }),
    ]);
    for policy in POLICIES {
        let (streamed, _) = run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        let (buffered, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert_eq!(streamed, buffered, "{policy:?}");
        for out in [&streamed, &buffered] {
            assert!(!out.contains("sk-abcdefghij"), "{policy:?}: {out}");
            assert!(!out.contains("klmnopqrstuvwxyz"), "{policy:?}: {out}");
        }
    }
}

/// A string `index` a client merges by keys its own lane (round 68), so the
/// two entries here are two choices to a client and nothing joins across
/// them: both paths agree, and a mask, when one applies, covers the index.
#[test]
fn a_string_choice_index_a_lane_joins_is_masked() {
    let scanner = scanner();
    let raw = sse(&[
        json!({ "id": "c", "object": "chat.completion.chunk",
            "choices": [{ "index": "sk-ABCDEFGHIJ", "delta": { "content": "Hi " } }] }),
        json!({ "id": "c", "object": "chat.completion.chunk",
            "choices": [{ "index": "KLMNOPQRSTUVWXYZ", "delta": { "content": "there" } }] }),
    ]);
    for policy in [
        POLICIES[0].clone(),
        POLICIES[1].clone(),
        FirewallPolicy::Block,
    ] {
        let (streamed, blocked) =
            run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        let (buffered, _, violation) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert_eq!(
            blocked,
            policy == FirewallPolicy::Block && violation.is_some()
        );
        assert_eq!(
            streamed.contains("[REDACTED]"),
            buffered.contains("[REDACTED]"),
            "{policy:?}"
        );
    }
    // Masked, a string index goes with the text (`mask_sse_payload_text`).
    let mut frame =
        json!({ "choices": [{ "index": "sk-ABCDEFGHIJ", "delta": { "content": "x" } }] });
    super::super::mask_sse_payload_text(&mut frame);
    assert!(!frame.to_string().contains("sk-ABCDEFGHIJ"), "{frame}");
}
