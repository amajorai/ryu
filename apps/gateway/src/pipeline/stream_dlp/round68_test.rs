//! Round 68: a choice index clients merge by but that is not a lane number
//! keys its own lane, and the standing guard's refusal frame is judged on
//! its own, after the model's frames.

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

#[test]
fn a_value_split_over_an_odd_choice_index_meets_in_one_lane() {
    let scanner = scanner();
    for index in [json!(-1), json!("a"), json!(0.5)] {
        let raw = sse(&[
            json!({ "id": "c", "choices": [{ "index": index, "delta": { "content": "sk-proj" } }] }),
            json!({ "id": "c", "choices": [{ "index": 0, "delta": { "content": " " } },
                { "index": index, "delta": { "content": "1234567890abcdefghijklmnop" } }] }),
        ]);
        let (streamed, blocked) =
            run_streaming(&raw, &offsets(&raw), FirewallPolicy::Block, &scanner).unwrap();
        assert!(blocked, "{index}: {streamed}");
        let (_, _, violation) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
        assert!(violation.is_some(), "{index}: buffered");
    }
}

#[test]
fn a_standing_refusal_is_not_joined_to_the_held_text() {
    let scanner = scanner();
    let refusal = json!({ "error": { "message": "This organization is suspended.",
        "type": "policy_violation", "code": "org_suspended", "layer": "platform",
        "remedy": "appeal" } });
    let mut raw = format!(
        "data: {}\n\n",
        json!({ "choices": [{ "index": 0,
            "delta": { "content": "Use https://db.example/login?user=bob&password=" } }] })
    );
    raw.push_str(&format!("data: {refusal}\n\n"));
    for policy in [
        FirewallPolicy::WarnAndContinue,
        FirewallPolicy::Sanitize,
        FirewallPolicy::Block,
    ] {
        let (streamed, _) = run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        let (buffered, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        for out in [&streamed, &buffered] {
            assert!(
                out.contains("\"code\":\"org_suspended\""),
                "{policy:?}: {out}"
            );
            assert!(out.contains("password="), "{policy:?}: {out}");
        }
        assert_eq!(streamed, buffered, "{policy:?}");
    }
}
