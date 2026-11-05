//! Round 38: token mirrors are judged over the whole final batch even when a
//! held stream ends in a frame of another lane, and the per-string
//! fail-closed check skips the mirrors the release drops.

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
fn a_last_frame_of_another_lane_does_not_split_the_mirror_batch() {
    let scanner = scanner();
    let cases = [
        (
            "Key: ",
            "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx ok",
            "</END>",
            "104",
        ),
        ("Use", " passwd=hunt", "\nObservation:", "15"),
    ];
    for (head, tail, stop, last_id) in cases {
        let ids: Vec<u64> = if last_id == "104" {
            vec![101, 102, 103, 104]
        } else {
            vec![10, 11, 12, 13, 14, 15]
        };
        let raw = sse(&[
            json!({ "id": "c1", "object": "chat.completion.chunk", "model": "m",
                "choices": [{ "index": 0, "delta": { "role": "assistant", "content": head },
                    "logprobs": null, "finish_reason": null, "token_ids": ids }] }),
            json!({ "id": "c1", "object": "chat.completion.chunk", "model": "m",
                "choices": [{ "index": 0, "delta": { "content": tail }, "logprobs": null,
                    "finish_reason": "stop", "stop_reason": stop, "token_ids": [] }] }),
        ]);
        for policy in [
            FirewallPolicy::WarnAndContinue,
            FirewallPolicy::Sanitize,
            FirewallPolicy::Block,
        ] {
            let (streamed, _) =
                run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
            let (buffered, _, _) =
                super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
            for out in [&streamed, &buffered] {
                assert!(!out.contains(&format!("{last_id}]")), "{policy:?}: {out}");
            }
        }
    }
}

#[test]
fn dropped_logprobs_lanes_do_not_mask_a_sanitized_stream() {
    let scanner = scanner();
    let tokens = ["421", "118", "903", "247", "551", "6"];
    let runners = ["411", "123", "456", "789", "012", "7"];
    let mut frames: Vec<Value> = tokens
        .iter()
        .zip(runners)
        .map(|(token, runner)| {
            json!({ "choices": [{ "index": 0, "delta": { "content": token },
                "logprobs": { "content": [{ "token": token, "logprob": -0.1, "bytes": [],
                    "top_logprobs": [
                        { "token": token, "logprob": -0.1, "bytes": [] },
                        { "token": runner, "logprob": -2.3, "bytes": [] }] }],
                    "refusal": null },
                "finish_reason": null }] })
        })
        .collect();
    frames.push(json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }] }));
    let raw = sse(&frames);
    let (streamed, _) =
        run_streaming(&raw, &offsets(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
    assert_eq!(visible(&streamed), visible(&buffered));
    assert_eq!(visible(&streamed), "4211189032475516");
    // Runner-up alternatives are judged per entry, as the non-stream reply
    // judges them, never joined by position across frames (round 82), so
    // this clean reply keeps them on both paths.
    assert_eq!(streamed, buffered);
    assert!(streamed.contains("\"789\""), "{streamed}");
}
