//! Round 39: a long-token scan start never splits a keyword (its value
//! would no longer be carried), and the per-string fail-closed check drops
//! token mirrors with the same batch rule as the release.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use crate::config::FirewallPolicy;

fn sse(parts: &[String]) -> String {
    let mut raw = String::new();
    for part in parts {
        let frame = json!({ "choices": [{ "index": 0, "delta": { "content": part },
            "finish_reason": null }] });
        raw.push_str(&format!("data: {frame}\n\n"));
    }
    raw.push_str("data: [DONE]\n\n");
    raw
}

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
fn a_long_token_cut_never_splits_a_passport_keyword() {
    let scanner = scanner();
    let hashes = |count: usize| "#".repeat(count);
    let mut sweep = vec![format!("{}passport{} ", hashes(4200), hashes(300))];
    sweep.extend(std::iter::repeat_n("# ".to_owned(), 2500));
    sweep.push("AB1234567".to_owned());
    let cases = [
        vec![
            format!("{}passport{} ", hashes(4200), hashes(4347)),
            "AB1234567".to_owned(),
        ],
        vec![
            format!("{}passport#number{} ", hashes(4200), hashes(4347)),
            "AB1234567".to_owned(),
        ],
        sweep,
        // Letters before the keyword that the ASCII word boundary ignores,
        // and a keyword the scan folds from fullwidth letters (round 40).
        vec![
            format!("{}éééééééépassport{} ", hashes(4200), hashes(4347)),
            "AB1234567".to_owned(),
        ],
        vec![
            format!("{}éépassport{} ", hashes(4200), hashes(4350)),
            "AB1234567".to_owned(),
        ],
        vec![
            format!("{}üüüüüüüüüpassport{} ", hashes(4200), hashes(4340)),
            "AB1234567".to_owned(),
        ],
        vec![
            format!(
                "{}\u{FF50}\u{FF41}\u{FF53}\u{FF53}port{} ",
                hashes(4200),
                hashes(4347)
            ),
            "AB1234567".to_owned(),
        ],
    ];
    for (case, parts) in cases.iter().enumerate() {
        let raw = sse(parts);
        for policy in [FirewallPolicy::Block, FirewallPolicy::Sanitize] {
            let (streamed, _) =
                run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
            let (buffered, _, _) =
                super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
            // Never released under Block, nor under Sanitize: the Sanitize
            // rewrite fails closed, so a keyword only the scan folds from
            // fullwidth letters (case 6) is redacted on both paths too.
            let released = visible(&streamed).contains("AB1234567");
            let buffered_released = visible(&buffered).contains("AB1234567");
            if policy == FirewallPolicy::Block {
                assert!(!released, "case {case}: released under Block");
            } else {
                assert!(!released, "case {case}: released");
                assert!(!buffered_released, "case {case}: buffered");
            }
        }
    }
}

#[test]
fn unchanged_frames_drop_their_mirrors_with_the_batch_in_the_mask_check() {
    let scanner = scanner();
    let frame = |content: &str, tokens: &[&str], finish: Value| {
        let entries: Vec<Value> = tokens
            .iter()
            .map(|token| {
                json!({ "token": token, "logprob": -0.1, "bytes": [],
                "top_logprobs": [] })
            })
            .collect();
        json!({ "choices": [{ "index": 0, "delta": { "content": content },
            "logprobs": { "content": entries }, "finish_reason": finish }] })
    };
    let frames = [
        frame("Use ", &["Use", " "], Value::Null),
        frame("passwd=hunter22 ", &["passwd", "=hunter22 "], Value::Null),
        frame("ok", &["ok"], json!("stop")),
    ];
    let mut raw: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
    raw.push_str("data: [DONE]\n\n");
    for policy in [FirewallPolicy::Block, FirewallPolicy::WarnAndContinue] {
        let (streamed, _) = run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        let (buffered, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert_eq!(visible(&streamed), visible(&buffered), "{policy:?}");
        assert_eq!(visible(&streamed), "Use [REDACTED:secret_param] ok");
        assert!(!streamed.contains("hunter22"), "{streamed}");
    }
}
