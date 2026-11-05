//! Round 61: the gateway's own Anthropic translator's `pause_turn` finish is
//! protocol metadata on both paths.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

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
fn a_pause_turn_finish_keeps_the_text_level_rewrite() {
    let scanner = scanner();
    let envelope = |choice: Value| {
        json!({ "id": "chatcmpl-x", "object": "chat.completion.chunk", "created": 1,
            "model": "claude", "choices": [choice] })
    };
    let mut last = envelope(json!({ "index": 0, "delta": {}, "finish_reason": "pause_turn" }));
    last["usage"] = json!({ "prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8 });
    let frames = [
        envelope(
            json!({ "index": 0, "delta": { "content": "Mail jane.d" }, "finish_reason": null }),
        ),
        envelope(
            json!({ "index": 0, "delta": { "content": "oe@example.com for details." },
            "finish_reason": null }),
        ),
        last,
    ];
    let mut raw: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
    raw.push_str("data: [DONE]\n\n");
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
    let (streamed, _) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    for out in [&buffered, &streamed] {
        assert_eq!(visible(out), "Mail [REDACTED:EMAIL] for details.", "{out}");
        assert!(out.contains("\"finish_reason\":\"pause_turn\""), "{out}");
    }
}
