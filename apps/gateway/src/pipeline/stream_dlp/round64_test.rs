//! Round 64: a reasoning/answer split leaves one-shot strings on the answer
//! half only, so a held-whole stream judges them once too.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn offsets(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

#[test]
fn a_held_whole_stream_judges_a_split_frames_stop_reason_once() {
    let scanner = scanner();
    let frame = |delta: Value, extra: Value| {
        let mut frame = json!({ "id": "c", "object": "chat.completion.chunk", "model": "m",
            "choices": [{ "index": 0, "delta": delta }] });
        if let Value::Object(extra) = extra {
            for (key, value) in extra {
                frame["choices"][0][key] = value;
            }
        }
        frame
    };
    let frames = [
        frame(
            json!({ "role": "assistant", "reasoning_content": "Plan. " }),
            Value::Null,
        ),
        frame(json!({ "content": "Hi. " }), Value::Null),
        frame(
            json!({ "reasoning_content": "Done. ", "content": "OK." }),
            json!({ "finish_reason": "stop", "stop_reason": "AAAAAAAAAAAAAAAAAAAAAsk-B" }),
        ),
    ];
    let mut raw: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
    raw.push_str("data: [DONE]\n\n");
    for policy in [
        FirewallPolicy::Block,
        FirewallPolicy::Sanitize,
        FirewallPolicy::WarnAndContinue,
    ] {
        let (streamed, blocked) =
            run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        let (buffered, _, violation) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert!(!blocked && violation.is_none(), "{policy:?}: {streamed}");
        assert_eq!(streamed, buffered, "{policy:?}");
        assert_eq!(
            streamed.matches("AAAAAAAAAAAAAAAAAAAAAsk-B").count(),
            1,
            "{streamed}"
        );
    }
}
