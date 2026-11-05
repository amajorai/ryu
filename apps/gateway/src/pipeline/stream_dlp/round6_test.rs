//! Frame-shape tightening, keep-alives, space-free scripts and mirrors.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use super::StreamingDlp;
use crate::config::FirewallPolicy;

fn field(sse: &str, pointer: &str) -> String {
    sse.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .filter_map(|frame| {
            frame
                .pointer(pointer)
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

fn content(part: &str) -> Value {
    json!({ "choices": [{ "index": 0, "delta": { "content": part } }] })
}

fn per_frame(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

#[test]
fn text_outside_the_scan_text_keeps_a_frame_out_of_the_simple_path() {
    let string_index = json!({ "choices": [{ "index": "sk-abc", "delta": { "content": "x" } }] });
    assert!(!super::super::simple_content_delta(&string_index));
    let parts = json!({ "choices": [{ "index": 0, "delta": { "content": [{ "type": "text", "text": "x" }] } }] });
    assert!(!super::super::simple_content_delta(&parts));
}

#[test]
fn comments_become_a_fixed_keep_alive_while_nothing_else_is_sent() {
    let scanner = scanner();
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    let out = dlp
        .push(
            b": OPENROUTER PROCESSING sk-abcdefghijklmnopqrstuvwxyz\n\n",
            &scanner,
        )
        .unwrap();
    assert_eq!(out.bytes, ": keep-alive\n\n");
    let out = dlp
        .push(format!("data: {}\n\n", content("Hi ")).as_bytes(), &scanner)
        .unwrap();
    assert!(!out.bytes.contains("keep-alive") && !out.bytes.contains("sk-abc"));
}

#[test]
fn space_free_scripts_stream_and_spanning_forms_are_still_held() {
    let scanner = scanner();
    let raw = sse(&["\u{4f60}\u{597d}", "\u{4e16}\u{754c}", "\u{4eca}\u{5929}"].map(content));
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    let early = dlp.push(raw.as_bytes(), &scanner).unwrap();
    assert!(field(&early.bytes, "/choices/0/delta/content").starts_with("\u{4f60}\u{597d}"));

    // A connection string whose credentials are CJK must not stream in parts.
    let frames = [
        "\u{8fde}\u{63a5}",
        "postgres://\u{7528}\u{6237}",
        ":\u{5bc6}\u{7801}",
        "@db \u{3002}",
        "\u{5b8c}\u{6210}",
    ]
    .map(content);
    let raw = sse(&frames);
    let (_, _, oracle) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert!(oracle.is_some());
    let (streamed, blocked) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked);
    assert!(!field(&streamed, "/choices/0/delta/content").contains("postgres://"));
}

#[test]
fn choice_text_and_reasoning_mirrors_follow_the_redaction() {
    let scanner = scanner();
    let together = |part: &str| json!({ "choices": [{ "index": 0, "text": part, "delta": { "content": part } }] });
    let raw = sse(&["key ", "sk-abcdefghij", "klmnopqrstuvwxyz0123", " now. "].map(together));
    let (streamed, _) =
        run_streaming(&raw, &[], FirewallPolicy::WarnAndContinue, &scanner).unwrap();
    assert_eq!(
        field(&streamed, "/choices/0/delta/content"),
        "key [REDACTED:openai_key] now. "
    );
    assert_eq!(
        field(&streamed, "/choices/0/text"),
        "key [REDACTED:openai_key] now. "
    );

    let vllm = |part: &str| json!({ "choices": [{ "index": 0, "delta": { "content": null, "reasoning_content": part, "reasoning": part } }] });
    let raw = sse(&["key ", "sk-abcdefghij", "klmnopqrstuvwxyz0123", " now. "].map(vllm));
    let mut dlp = StreamingDlp::new(FirewallPolicy::WarnAndContinue, true);
    let early = dlp.push(raw.as_bytes(), &scanner).unwrap();
    assert!(
        !early.bytes.is_empty(),
        "mirrored reasoning held the stream"
    );
    let streamed = format!("{}{}", early.bytes, dlp.finish(&scanner).unwrap().bytes);
    assert_eq!(
        field(&streamed, "/choices/0/delta/reasoning_content"),
        "key [REDACTED:openai_key] now. "
    );
    assert_eq!(
        field(&streamed, "/choices/0/delta/reasoning"),
        "key [REDACTED:openai_key] now. "
    );
}

#[test]
fn a_carried_keyword_keeps_its_left_context() {
    let scanner = scanner();
    let token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";
    let mut parts = vec!["see xbearer".to_owned()];
    parts.extend(std::iter::repeat_n(" \u{3000}".to_owned(), 3000));
    parts.push(format!(" {token} tail"));
    let frames: Vec<Value> = parts.iter().map(|part| content(part)).collect();
    let raw = sse(&frames);
    let (streamed, _) = run_streaming(
        &raw,
        &per_frame(&raw),
        FirewallPolicy::WarnAndContinue,
        &scanner,
    )
    .unwrap();
    assert!(
        field(&streamed, "/choices/0/delta/content").contains(token),
        "masked a clean xbearer stream"
    );
}
