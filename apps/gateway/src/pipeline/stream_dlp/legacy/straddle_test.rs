//! A released frame straddling the scan start: its rewritten tail must not
//! make the per-string check mask a tool call that follows.

use serde_json::{json, Value};

use super::super::scan_test::scanner;
use super::super::StreamingDlp;
use crate::config::FirewallPolicy;
use crate::firewall::FirewallScanner;
use crate::pipeline::stream_dlp::redact::Transform;

const ARGUMENTS: &str = "{\"city\":\"Paris\"}";

fn content_frame(text: &str) -> Value {
    json!({ "choices": [{ "index": 0, "delta": { "content": text } }] })
}

fn tool_frame() -> Value {
    json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{ "index": 0, "function": { "name": "get_weather", "arguments": ARGUMENTS } }] } }] })
}

/// A digit- and keyword-free filler with a leading space, so it never glues
/// onto the token before it.
fn filler(index: usize) -> String {
    let letter = char::from(b'a' + u8::try_from(index % 26).unwrap_or(0));
    format!(" w{letter}")
}

fn data(frame: &Value) -> String {
    format!("data: {frame}\n\n")
}

fn frames_of(sse: &str) -> Vec<Value> {
    sse.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .collect()
}

fn joined(sse: &str, pointer: &str) -> String {
    frames_of(sse)
        .iter()
        .filter_map(|frame| frame.pointer(pointer).and_then(Value::as_str))
        .collect()
}

fn policies() -> [FirewallPolicy; 2] {
    [FirewallPolicy::WarnAndContinue, FirewallPolicy::Sanitize]
}

fn new_dlp(policy: &FirewallPolicy) -> StreamingDlp {
    StreamingDlp::new(
        policy.clone(),
        !matches!(policy, FirewallPolicy::WarnAndContinue),
    )
}

/// Whether a released frame straddles the scan start with the part after it
/// rewritten (sent differently from the raw tail).
fn straddles_rewritten(dlp: &StreamingDlp) -> bool {
    dlp.recent.iter().any(|frame| {
        frame.start < dlp.scan_from
            && dlp.scan_from < frame.end
            && !frame
                .sent
                .ends_with(&dlp.text[dlp.scan_from - dlp.base..frame.end - dlp.base])
    })
}

/// Feed `content` one frame at a time, then the tool frame and the end.
/// Returns the output and whether the straddle state held before the tool
/// frame.
fn run(
    content: &[String],
    after: &[&str],
    policy: &FirewallPolicy,
    scanner: &FirewallScanner,
    tamper: bool,
) -> (String, bool) {
    let mut dlp = new_dlp(policy);
    let mut out = String::new();
    for part in content {
        let step = dlp
            .push(data(&content_frame(part)).as_bytes(), scanner)
            .unwrap();
        out.push_str(&step.bytes);
    }
    let straddled = straddles_rewritten(&dlp);
    if tamper && straddled {
        // Claim the straddler went out raw: the claim no longer ends its
        // sent text, so the check falls back to the raw tail and masks.
        let (scan_from, base) = (dlp.scan_from, dlp.base);
        let text = dlp.text.clone();
        if let Some(frame) = dlp
            .recent
            .iter_mut()
            .find(|frame| frame.start < scan_from && scan_from < frame.end)
        {
            frame.sent = text[scan_from - base..frame.end - base].to_owned();
        }
    }
    out.push_str(
        &dlp.push(data(&tool_frame()).as_bytes(), scanner)
            .unwrap()
            .bytes,
    );
    for part in after {
        out.push_str(
            &dlp.push(data(&content_frame(part)).as_bytes(), scanner)
                .unwrap()
                .bytes,
        );
    }
    out.push_str(&dlp.push(b"data: [DONE]\n\n", scanner).unwrap().bytes);
    out.push_str(&dlp.finish(scanner).unwrap().bytes);
    (out, straddled)
}

fn check_sweep(head: &[&str]) {
    let scanner = scanner();
    for policy in policies() {
        let transform = Transform::new(&scanner, matches!(policy, FirewallPolicy::Sanitize));
        let mut reached = false;
        for count in 60..160 {
            let mut content: Vec<String> = head.iter().map(|part| (*part).to_owned()).collect();
            content.extend((0..count).map(filler));
            let (out, straddled) = run(&content, &[], &policy, &scanner, false);
            reached |= straddled;
            assert!(!out.contains("[REDACTED]"), "{policy:?} {count}: {out}");
            assert!(!out.contains("sk-abcdefghij"), "{policy:?} {count}: {out}");
            assert_eq!(
                joined(&out, "/choices/0/delta/content"),
                transform.apply(&content.concat()),
                "{policy:?} {count}"
            );
            let name = "/choices/0/delta/tool_calls/0/function/name";
            assert_eq!(joined(&out, name), "get_weather", "{policy:?} {count}");
            let arguments = "/choices/0/delta/tool_calls/0/function/arguments";
            assert_eq!(
                joined(&out, arguments),
                transform.apply(ARGUMENTS),
                "{policy:?} {count}"
            );
        }
        assert!(reached, "{policy:?}: no filler count reached a straddle");
    }
}

/// A rewritten value whose frame straddles the scan start, then a tool call:
/// the tool call and the content after the value go out unmasked.
#[test]
fn a_rewritten_straddler_does_not_mask_a_following_tool_call() {
    check_sweep(&["Use", " key", " sk-abcdefghij", "klmnopqrstuvwxyz0123"]);
}

/// The same with the value inside one multi-token frame, so the scan start
/// can land on any of its tokens.
#[test]
fn a_multi_token_straddler_does_not_mask_a_following_tool_call() {
    check_sweep(&[" Your key is sk-abcdefghijklmnopqrstuvwxyz0123 ok"]);
}

/// A second value that starts before the tool call and continues after it
/// is never released, raw or in part.
#[test]
fn a_value_continuing_past_the_tool_call_still_masks() {
    let scanner = scanner();
    for policy in policies() {
        for count in [60, 90, 120, 150] {
            let mut content: Vec<String> =
                ["Use", " key", " sk-abcdefghij", "klmnopqrstuvwxyz0123"]
                    .iter()
                    .map(|part| (*part).to_owned())
                    .collect();
            content.extend((0..count).map(filler));
            content.push(" sk-abc".to_owned());
            let (out, _) = run(
                &content,
                &["defghijklmnopqrstuvwxyz"],
                &policy,
                &scanner,
                false,
            );
            assert!(!out.contains("sk-abc"), "{policy:?} {count}: {out}");
            assert!(!out.contains("defghijklmnop"), "{policy:?} {count}: {out}");
        }
    }
}

/// When the straddler's sent text does not end with the claimed tail, the
/// check falls back to the raw tail and masks the tool call.
#[test]
fn an_unverified_straddler_falls_back_to_masking() {
    let scanner = scanner();
    let policy = FirewallPolicy::WarnAndContinue;
    let mut reached = false;
    for count in 60..160 {
        let mut content: Vec<String> = ["Use", " key", " sk-abcdefghij", "klmnopqrstuvwxyz0123"]
            .iter()
            .map(|part| (*part).to_owned())
            .collect();
        content.extend((0..count).map(filler));
        let (out, straddled) = run(&content, &[], &policy, &scanner, true);
        if straddled {
            reached = true;
            assert!(!out.contains("get_weather"), "{count}: {out}");
            assert!(!out.contains("Paris"), "{count}: {out}");
        }
    }
    assert!(reached, "no filler count reached a straddle");
}

/// A letters-only bearer value: the straddler sent nothing of its own, so no
/// claim is made, and the stream still passes as the joined transform.
#[test]
fn a_continued_straddler_still_passes() {
    let scanner = scanner();
    for policy in policies() {
        let transform = Transform::new(&scanner, matches!(policy, FirewallPolicy::Sanitize));
        for count in 60..160 {
            let mut content: Vec<String> = ["Use Bearer", " abcdefghijklmnopqrst"]
                .iter()
                .map(|part| (*part).to_owned())
                .collect();
            content.extend((0..count).map(filler));
            let (out, _) = run(&content, &[], &policy, &scanner, false);
            assert!(!out.contains("[REDACTED]"), "{policy:?} {count}: {out}");
            assert_eq!(
                joined(&out, "/choices/0/delta/content"),
                transform.apply(&content.concat()),
                "{policy:?} {count}"
            );
            let arguments = "/choices/0/delta/tool_calls/0/function/arguments";
            assert_eq!(joined(&out, arguments), ARGUMENTS, "{policy:?} {count}");
        }
    }
}

/// The buffered path's rewrite of `frames` (as one SSE body) under `policy`.
fn buffered(frames: &[Value], policy: &FirewallPolicy, scanner: &FirewallScanner) -> String {
    let mut raw: String = frames.iter().map(data).collect();
    raw.push_str("data: [DONE]\n\n");
    crate::pipeline::rewrite_sse_for_dlp(&raw, scanner, policy)
        .unwrap()
        .0
}

/// The buffered path releases the content before a tool call at text level
/// too, so a redacted value no longer masks the tool call there either:
/// buffered equals streamed for the redacted-value frames of
/// `tool_calls_after_a_redacted_value_are_not_masked`.
#[test]
fn buffered_tool_calls_after_a_redacted_value_match_the_stream() {
    let scanner = scanner();
    let content: Vec<String> = [
        "Use ",
        "key ",
        "sk-abcdefghij",
        "klmnopqrstuvwxyz0123",
        " now. ",
    ]
    .iter()
    .map(|part| (*part).to_owned())
    .collect();
    for policy in policies() {
        let (streamed, _) = run(&content, &[], &policy, &scanner, false);
        let mut frames: Vec<Value> = content.iter().map(|part| content_frame(part)).collect();
        frames.push(tool_frame());
        let buffered = buffered(&frames, &policy, &scanner);
        assert!(!buffered.contains("[REDACTED]"), "{policy:?}: {buffered}");
        assert!(
            !buffered.contains("sk-abcdefghij"),
            "{policy:?}: {buffered}"
        );
        assert!(buffered.contains("get_weather") && buffered.contains("Paris"));
        assert_eq!(buffered, streamed, "{policy:?}");
    }
}

/// The same for every straddle sweep frame set: the buffered path matches
/// the stream, which no longer masks after a straddled value.
#[test]
fn buffered_straddle_sweep_matches_the_stream() {
    let scanner = scanner();
    let heads: [&[&str]; 2] = [
        &["Use", " key", " sk-abcdefghij", "klmnopqrstuvwxyz0123"],
        &[" Your key is sk-abcdefghijklmnopqrstuvwxyz0123 ok"],
    ];
    for head in heads {
        for policy in policies() {
            for count in 60..160 {
                let mut content: Vec<String> = head.iter().map(|part| (*part).to_owned()).collect();
                content.extend((0..count).map(filler));
                let (streamed, _) = run(&content, &[], &policy, &scanner, false);
                let mut frames: Vec<Value> =
                    content.iter().map(|part| content_frame(part)).collect();
                frames.push(tool_frame());
                let buffered = buffered(&frames, &policy, &scanner);
                assert!(!buffered.contains("[REDACTED]"), "{policy:?} {count}");
                assert_eq!(buffered, streamed, "{policy:?} {count}");
            }
        }
    }
}

/// A value continuing from the content past the tool call, or split across
/// tool-call arguments, is never released by the buffered path, raw or in
/// part; in the second case only the frames from the tool call on are
/// masked, as the stream masks only its tail.
#[test]
fn buffered_head_split_never_leaks_a_value_across_the_boundary() {
    let scanner = scanner();
    let arguments = |text: &str| json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": text } }] } }] });
    for policy in policies() {
        let continuing = [
            content_frame("Use sk-abc"),
            arguments(ARGUMENTS),
            content_frame("defghijklmnopqrstuvwxyz"),
        ];
        let out = buffered(&continuing, &policy, &scanner);
        assert!(!out.contains("sk-abc"), "{policy:?}: {out}");
        assert!(!out.contains("defghijklmnop"), "{policy:?}: {out}");

        let split = [
            content_frame("Hello there."),
            arguments("{\"key\":\"sk-abcdefghij"),
            arguments("klmnopqrstuvwxyz0123\"}"),
        ];
        let out = buffered(&split, &policy, &scanner);
        assert!(!out.contains("sk-abcdefghij"), "{policy:?}: {out}");
        assert!(!out.contains("klmnopqrstuvwxyz"), "{policy:?}: {out}");
        assert_eq!(joined(&out, "/choices/0/delta/content"), "Hello there.");
        let mut raw: String = split.iter().map(data).collect();
        raw.push_str("data: [DONE]\n\n");
        let (streamed, _) =
            super::super::scan_test::run_streaming(&raw, &[], policy.clone(), &scanner).unwrap();
        assert_eq!(out, streamed, "{policy:?}");
    }
}
