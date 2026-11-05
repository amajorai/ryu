//! Round 51: a long-token cut never lands right after `bearer`, Azure's
//! protected-material citation and more providers' finish reasons are
//! protocol metadata, and case folding keeps `İ` as written.

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

fn content(text: &str) -> Value {
    json!({ "choices": [{ "index": 0, "delta": { "content": text }, "finish_reason": null }] })
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

const ALL: [FirewallPolicy; 3] = [
    FirewallPolicy::Block,
    FirewallPolicy::Sanitize,
    FirewallPolicy::WarnAndContinue,
];

#[test]
fn a_long_token_cut_right_after_bearer_keeps_the_keyword() {
    let scanner = scanner();
    let value = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
    let raw = sse(&[
        content(&format!(
            "{}#bearer{}",
            "x".repeat(5000),
            "\u{000B}".repeat(4351)
        )),
        content(" "),
        content(&format!("{value} done ")),
    ]);
    for policy in ALL {
        let (streamed, _) = run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        assert!(!visible(&streamed).contains(value), "{policy:?}: released");
    }
}

#[test]
fn an_azure_citation_annotation_keeps_the_text_level_rewrite() {
    let scanner = scanner();
    let mut frames = vec![content("Here"), content(" is"), content(" code")];
    frames.push(json!({ "choices": [{
        "content_filter_offsets": { "check_offset": 0, "start_offset": 0, "end_offset": 40 },
        "content_filter_results": { "protected_material_code": {
            "citation": { "URL": "https://github.com/a/b/blob/main/x.py", "license": "MIT" },
            "detected": true, "filtered": false } },
        "finish_reason": null, "index": 0 }] }));
    frames.extend([" set", " token=abcd", "efgh1234", " ok", " and", " more"].map(content));
    let raw = sse(&frames);
    for policy in ALL {
        let (streamed, _) = run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        let (buffered, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert!(!visible(&streamed).contains("efgh1234"), "{policy:?}");
        assert!(
            visible(&buffered).ends_with(" ok and more"),
            "{policy:?}: {buffered}"
        );
        assert_eq!(visible(&streamed), visible(&buffered), "{policy:?}");
    }
}

#[test]
fn more_provider_finish_reasons_keep_the_text_level_rewrite() {
    let scanner = scanner();
    let last = [
        json!({ "choices": [{ "index": 0, "delta": { "content": "" },
            "finish_reason": "stop", "native_finish_reason": "COMPLETE" }] }),
        json!({ "choices": [{ "index": 0, "delta": { "content": "" },
            "finish_reason": "insufficient_system_resource" }] }),
    ];
    for last in last {
        let mut frames = ["set ", "token=abcd", "efgh1234", " now"]
            .map(content)
            .to_vec();
        frames.push(last);
        let raw = sse(&frames);
        let (buffered, _, _) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
        let text = visible(&buffered);
        assert!(text.starts_with("set [REDACTED:"), "{text}");
        assert!(text.ends_with(" now"), "{text}");
    }
}

#[test]
fn a_dotted_capital_i_is_not_folded_into_a_carried_keyword() {
    let scanner = scanner();
    let mut frames = vec![content("APİ_KEY:")];
    frames.extend(std::iter::repeat_n(content("    "), 1100));
    frames.extend([content("ABCDEFGHIJKLMNOPQRSTUVWX"), content(" done")]);
    let raw = sse(&frames);
    for policy in [FirewallPolicy::Block, FirewallPolicy::Sanitize] {
        let (streamed, blocked) =
            run_streaming(&raw, &offsets(&raw), policy.clone(), &scanner).unwrap();
        let (buffered, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert!(!blocked, "{policy:?}: falsely blocked");
        assert_eq!(visible(&streamed), visible(&buffered), "{policy:?}");
    }
}
