//! Round 73: a second choice's envelope values stay in the joined lanes, the
//! per-string check sees every lane, and an unmatched envelope joins only
//! split candidates (consecutive single values), as `EnvelopeLanes` does,
//! whichever frame the hold started at.

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

const ALL: [FirewallPolicy; 3] = [
    FirewallPolicy::Block,
    FirewallPolicy::Sanitize,
    FirewallPolicy::WarnAndContinue,
];

#[test]
fn a_split_value_in_a_second_choices_envelope_is_caught() {
    let scanner = scanner();
    let raw = sse(&[
        json!({ "choices": [{ "index": 0, "delta": { "content": "Hi " } },
            { "index": 1, "delta": { "content": "Yo " }, "stop_reason": "AKIAIOSF" }] }),
        json!({ "choices": [{ "index": 0, "delta": { "content": "there" } },
            { "index": 1, "delta": { "content": "man" }, "stop_reason": "ODNN7EXAMPLE" }] }),
    ]);
    for policy in ALL {
        let (streamed, _) = run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        let (buffered, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        for out in [&streamed, &buffered] {
            assert!(
                !out.contains("AKIAIOSF") && !out.contains("ODNN7EXAMPLE"),
                "{policy:?}: {out}"
            );
        }
    }
}

#[test]
fn an_unmatched_envelope_joins_only_split_candidates_on_both_paths() {
    let scanner = scanner();
    let content = |text: &str| json!({ "choices": [{ "index": 0, "delta": { "content": text } }] });
    let mut first = content("Hi ");
    first["system_fingerprint"] = json!("AKIAIOSF");
    let mut third = content("ok");
    third["system_fingerprint"] = json!("ODNN7EXAMPLE");
    third["x"] = json!([{ "index": 1, "v": "q" }]);
    let raw = sse(&[first, content("there "), third]);
    for policy in ALL {
        let (streamed, blocked) =
            run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        let (buffered, _, violation) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert_eq!(
            blocked,
            policy == FirewallPolicy::Block && violation.is_some(),
            "{policy:?}"
        );
        assert_eq!(streamed, buffered, "{policy:?}");
    }
}
