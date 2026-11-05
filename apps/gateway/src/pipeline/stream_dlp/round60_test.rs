//! Round 60: a released fixed protocol field (`delta.role`, `finish_reason`)
//! heads the lane a later held frame completes, as on the buffered path.

use serde_json::json;

use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn offsets(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

#[test]
fn a_value_completing_a_released_protocol_field_is_blocked() {
    let scanner = scanner();
    let cases = [
        [
            json!({ "id": "c1", "choices": [{ "index": 0,
                "delta": { "role": "assistant", "content": "Hi " } }] }),
            json!({ "id": "c1", "choices": [{ "index": 0,
                "delta": { "role": "@example.com", "content": "there" } }] }),
        ],
        [
            json!({ "id": "c1", "choices": [{ "index": 0, "delta": { "content": "Hi " },
                "finish_reason": "stop" }] }),
            json!({ "id": "c1", "choices": [{ "index": 0, "delta": { "content": "there" },
                "finish_reason": "@corp.example.com" }] }),
        ],
    ];
    for frames in cases {
        let mut raw: String = frames
            .iter()
            .map(|frame| format!("data: {frame}\n\n"))
            .collect();
        raw.push_str("data: [DONE]\n\n");
        let (_, _, violation) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
        assert!(violation.is_some(), "buffered");
        let (streamed, blocked) =
            run_streaming(&raw, &offsets(&raw), FirewallPolicy::Block, &scanner).unwrap();
        assert!(blocked, "{streamed}");
    }
}
