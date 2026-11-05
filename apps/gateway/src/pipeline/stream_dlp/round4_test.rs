//! Provider shapes, carried keyword forms and envelope timing.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use super::StreamingDlp;
use crate::config::FirewallPolicy;

fn text(sse: &str, key: &str) -> String {
    sse.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .filter_map(|frame| {
            frame
                .pointer(&format!("/choices/0/delta/{key}"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}

fn sse(frames: &[Value]) -> String {
    let mut raw: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
    raw.push_str("data: [DONE]\n\n");
    raw
}

fn content_frames(parts: &[String]) -> Vec<Value> {
    parts
        .iter()
        .map(|part| json!({ "choices": [{ "index": 0, "delta": { "content": part } }] }))
        .collect()
}

fn per_frame(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

#[test]
fn keyword_forms_drained_over_several_steps_stay_carried() {
    let scanner = scanner();
    let forms: Vec<(&str, Vec<String>)> = vec![
        ("AB1234567", vec!["My passport".into(), " no.".into()]),
        ("AB1234567", vec!["Passport: No.".into()]),
        ("AB1234567", vec!["Passport number:".into()]),
        ("AB1234567", vec!["passport#".into()]),
    ];
    for (value, head) in forms {
        let mut parts = head.clone();
        parts.extend(std::iter::repeat_n(" #".to_owned(), 3000));
        parts.extend([format!(" {value}"), " end.".to_owned()]);
        let raw = sse(&content_frames(&parts));
        for policy in [FirewallPolicy::Block, FirewallPolicy::Sanitize] {
            let (streamed, _) =
                run_streaming(&raw, &per_frame(&raw), policy.clone(), &scanner).unwrap();
            assert!(
                !text(&streamed, "content").contains(value),
                "{head:?} under {policy:?}"
            );
        }
    }
    let mut parts = vec!["api_key".to_owned(), " =".to_owned()];
    parts.extend(std::iter::repeat_n(" \u{3000}".to_owned(), 3000));
    parts.push(" abcdefghijklmnopqrstuvwxyz".to_owned());
    let raw = sse(&content_frames(&parts));
    let (streamed, _) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(!text(&streamed, "content").contains("abcdefghijklmnopqrstuvwxyz"));
}

#[test]
fn a_word_ending_in_a_keyword_is_not_carried_as_the_keyword() {
    let scanner = scanner();
    let mut parts: Vec<String> =
        "Renew your ePassport\nA1234567 reference number belongs elsewhere "
            .split_inclusive(' ')
            .map(str::to_owned)
            .collect();
    parts.extend(std::iter::repeat_n(
        "and then some more ordinary words follow here ".to_owned(),
        12,
    ));
    let raw = sse(&content_frames(&parts));
    let (_, _, oracle) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert!(oracle.is_none());
    let (_, blocked) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(!blocked, "false block on clean prose");
}

#[test]
fn an_envelope_value_split_over_two_frames_never_releases_its_head() {
    let scanner = scanner();
    let frames = [
        json!({ "system_fingerprint": "sk-abcdefghij", "choices": [{ "index": 0, "delta": { "content": "hello " } }] }),
        json!({ "system_fingerprint": "klmnopqrstuvwxyz", "choices": [{ "index": 0, "delta": { "content": "world " } }] }),
    ];
    let raw = sse(&frames);
    let (streamed, blocked) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked);
    assert!(!streamed.contains("sk-abcdefghij"));
    let (streamed, _) = run_streaming(
        &raw,
        &per_frame(&raw),
        FirewallPolicy::WarnAndContinue,
        &scanner,
    )
    .unwrap();
    assert!(!streamed.contains("sk-abcdefghij") && !streamed.contains("klmnopqrstuvwxyz"));
    assert_eq!(
        text(&streamed, "content"),
        "hello world ",
        "content must not be masked"
    );
}

#[test]
fn non_string_padding_is_dropped() {
    let scanner = scanner();
    let frames = [
        json!({ "obfuscation": ["sk-abcdefghij"], "choices": [{ "index": 0, "delta": { "content": "hello " } }] }),
        json!({ "obfuscation": ["klmnopqrstuvwxyz"], "choices": [{ "index": 0, "delta": { "content": "world " } }] }),
    ];
    let raw = sse(&frames);
    let (streamed, _) = run_streaming(&raw, &[], FirewallPolicy::Block, &scanner).unwrap();
    assert!(!streamed.contains("sk-abcdefghij") && !streamed.contains("klmnopq"));
}

#[test]
fn azure_streams_release_incrementally() {
    let scanner = scanner();
    let filters = json!({ "hate": { "filtered": false, "severity": "safe" }, "violence": { "filtered": false, "severity": "safe" } });
    let mut frames = vec![json!({
        "choices": [], "created": 0, "id": "", "model": "", "object": "",
        "prompt_filter_results": [{ "prompt_index": 0, "content_filter_results": filters }]
    })];
    for word in ["Hello ", "there, ", "how ", "are ", "you ", "today "] {
        frames.push(json!({
            "choices": [{ "content_filter_results": filters, "delta": { "content": word }, "finish_reason": null, "index": 0, "logprobs": null }],
            "id": "chatcmpl-1", "model": "gpt-4o-2024-08-06", "object": "chat.completion.chunk", "system_fingerprint": "fp_1"
        }));
    }
    let raw = sse(&frames);
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    let early = dlp.push(raw.as_bytes(), &scanner).unwrap();
    assert!(
        text(&early.bytes, "content").starts_with("Hello there,"),
        "{}",
        early.bytes
    );
}

#[test]
fn sse_comment_lines_are_ignored_on_both_paths() {
    let scanner = scanner();
    let raw = format!(
        ": OPENROUTER PROCESSING\n\ndata: {}\n\n: OPENROUTER PROCESSING\n\ndata: [DONE]\n\n",
        json!({ "choices": [{ "index": 0, "delta": { "content": "Hi " } }] })
    );
    let (streamed, blocked) = run_streaming(&raw, &[], FirewallPolicy::Block, &scanner).unwrap();
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert!(!blocked);
    assert_eq!(streamed, buffered);
    assert!(streamed.contains("Hi ") && streamed.ends_with("data: [DONE]\n\n"));
}

#[test]
fn reasoning_lanes_stream_and_redact_at_text_level() {
    let scanner = scanner();
    let mut frames: Vec<Value> = ["Thinking ", "about ", "the ", "key ", "sk-abcdefghij", "klmnopqrstuvwxyz0123", " now. "]
        .iter()
        .map(|part| json!({ "choices": [{ "index": 0, "delta": { "content": null, "reasoning_content": part } }] }))
        .collect();
    frames.extend(["The ", "answer ", "is ", "short. "].iter().map(
        |part| json!({ "choices": [{ "index": 0, "delta": { "content": part, "reasoning_content": null } }] }),
    ));
    let raw = sse(&frames);
    let mut dlp = StreamingDlp::new(FirewallPolicy::WarnAndContinue, true);
    let early = dlp.push(raw.as_bytes(), &scanner).unwrap();
    assert!(text(&early.bytes, "reasoning_content").starts_with("Thinking about"));
    let streamed = format!("{}{}", early.bytes, dlp.finish(&scanner).unwrap().bytes);
    assert_eq!(
        text(&streamed, "reasoning_content"),
        "Thinking about the key [REDACTED:openai_key] now. "
    );
    assert_eq!(text(&streamed, "content"), "The answer is short. ");
}
