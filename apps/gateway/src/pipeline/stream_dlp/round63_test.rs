//! Round 63: the buffered verdict judges each provider string once (not the
//! copies a reasoning/answer split makes) and judges envelope split
//! candidates joined, as the stream does.

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

fn verdicts_agree(raw: &str) {
    let scanner = scanner();
    let (streamed, blocked) =
        run_streaming(raw, &offsets(raw), FirewallPolicy::Block, &scanner).unwrap();
    let (_, _, violation) =
        super::super::rewrite_sse_for_dlp(raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert_eq!(blocked, violation.is_some(), "{streamed}");
}

#[test]
fn a_split_frame_does_not_double_a_one_shot_string() {
    verdicts_agree(&sse(&[
        json!({ "id": "c", "object": "chat.completion.chunk", "model": "m",
            "choices": [{ "index": 0, "delta": { "role": "assistant", "content": "" } }] }),
        json!({ "id": "c", "object": "chat.completion.chunk", "model": "m",
            "choices": [{ "index": 0, "delta": { "reasoning_content": "Done. ", "content": "OK." },
                "finish_reason": "stop", "stop_reason": "AAAAAAAAAAAAAAAAAAAAAsk-B" }] }),
    ]));
}

#[test]
fn an_envelope_value_split_across_frames_gets_one_verdict() {
    for field in ["model", "object"] {
        let mut first = json!({ "choices": [{ "index": 0, "delta": { "content": "Hi " } }] });
        first[field] = json!("sk-abcdefghij");
        let mut second = json!({ "choices": [{ "index": 0, "delta": { "content": "there." } }] });
        second[field] = json!("klmnopqrstuvwxyz1234");
        verdicts_agree(&sse(&[first, second]));
    }
}
