//! Round 91: a choice's answer text and its tool calls' arguments are
//! separate strings in a non-streamed response, so the scan text puts
//! `FIELD_SEPARATOR` where a choice's text switches between a delta text
//! field and a tool call (or from one call to another). No pattern runs from
//! the answer into the arguments: neither path blocks, nor masks the tool
//! call of, a reply the non-stream path passes. A value split inside one
//! call's arguments is still one text, and still caught.

use serde_json::{json, Value};

use crate::config::FirewallPolicy;
use crate::pipeline::stream_dlp::round15_test::sse;
use crate::pipeline::stream_dlp::scan_test::{run_streaming, scanner, splits};
use crate::pipeline::{
    choice_scan_texts, json_string_projection, redact_with_mirrors, rewrite_sse_for_dlp,
    FIELD_SEPARATOR,
};

const POLICIES: [FirewallPolicy; 3] = [
    FirewallPolicy::Block,
    FirewallPolicy::Sanitize,
    FirewallPolicy::WarnAndContinue,
];

fn content(text: &str) -> Value {
    json!({ "id": "c", "object": "chat.completion.chunk", "model": "m",
        "choices": [{ "index": 0, "delta": { "role": "assistant", "content": text },
            "finish_reason": null }] })
}

fn tool_call(index: u64, name: Option<&str>, arguments: &str) -> Value {
    let mut call = json!({ "index": index, "function": { "arguments": arguments } });
    if let Some(name) = name {
        call["id"] = json!(format!("call_{index}"));
        call["type"] = json!("function");
        call["function"]["name"] = json!(name);
    }
    json!({ "id": "c", "object": "chat.completion.chunk", "model": "m",
        "choices": [{ "index": 0, "delta": { "tool_calls": [call] }, "finish_reason": null }] })
}

fn finish() -> Value {
    json!({ "id": "c", "object": "chat.completion.chunk", "model": "m",
        "choices": [{ "index": 0, "delta": {}, "finish_reason": "tool_calls" }] })
}

/// Choice 0's content and its first tool call's name and arguments, as a
/// client builds them from an SSE body.
fn assembled(raw: &str) -> (String, String, String) {
    let (mut text, mut name, mut arguments) = (String::new(), String::new(), String::new());
    for frame in raw
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
    {
        let delta = &frame["choices"][0]["delta"];
        text.push_str(delta["content"].as_str().unwrap_or_default());
        let function = &delta["tool_calls"][0]["function"];
        name.push_str(function["name"].as_str().unwrap_or_default());
        arguments.push_str(function["arguments"].as_str().unwrap_or_default());
    }
    (text, name, arguments)
}

/// What the non-stream path makes of the same reply: no violation, and
/// every string redacted on its own (`apply_outbound_json_dlp`).
fn non_stream(text: &str, name: &str, arguments: &str) -> (String, String, String) {
    let mut response = json!({ "choices": [{ "index": 0, "message": {
        "role": "assistant", "content": text,
        "tool_calls": [{ "id": "call_0", "type": "function",
            "function": { "name": name, "arguments": arguments } }] } }] });
    let projection = json_string_projection(&response);
    assert!(
        scanner().scan_outbound(&projection).is_none(),
        "{projection}"
    );
    redact_with_mirrors(&mut response, &scanner());
    let message = &response["choices"][0]["message"];
    let function = &message["tool_calls"][0]["function"];
    let field = |value: &Value| value.as_str().unwrap_or_default().to_owned();
    (
        field(&message["content"]),
        field(&function["name"]),
        field(&function["arguments"]),
    )
}

/// Both paths, every policy, per-frame and arbitrary chunking: no violation,
/// nothing masked, the same bytes, and the non-stream result.
fn assert_non_stream_parity(frames: &[Value], expected: &(String, String, String)) {
    let scanner = scanner();
    let raw = sse(frames);
    let (text, name, arguments) = assembled(&raw);
    assert_eq!(non_stream(&text, &name, &arguments), *expected);
    let per_frame: Vec<usize> = raw.match_indices("data: ").map(|(at, _)| at).collect();
    for policy in POLICIES {
        let (buffered, _, violation) = rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert!(violation.is_none(), "{policy:?}: {violation:?}");
        assert!(
            !buffered.contains("\"[REDACTED]\""),
            "{policy:?}: {buffered}"
        );
        assert_eq!(assembled(&buffered), *expected, "{policy:?}: {buffered}");
        let chunkings =
            std::iter::once(per_frame.clone()).chain((0..6).map(|seed| splits(&raw, seed, 12)));
        for (run, chunks) in chunkings.enumerate() {
            let (streamed, blocked) =
                run_streaming(&raw, &chunks, policy.clone(), &scanner).unwrap();
            assert!(!blocked, "{policy:?}/{run}: {streamed}");
            assert_eq!(streamed, buffered, "{policy:?}/{run}");
        }
    }
}

const COMMIT: &str = "3f786850e387550fdab836ed7e6dc881de23001b";

#[test]
fn the_answer_and_a_tool_calls_arguments_are_separate_texts() {
    let arguments = format!(r#"{{"commit":"{COMMIT}"}}"#);
    let frames = [
        content("Rotating the AWS secret"),
        tool_call(0, Some("rotate"), &arguments),
        finish(),
    ];
    assert_eq!(
        choice_scan_texts(&frames)["0"],
        format!("Rotating the AWS secret{FIELD_SEPARATOR}{arguments}")
    );
    // Each call is its own text too; one call's chunks join.
    let calls = [
        tool_call(0, Some("a"), "{\"x\":"),
        tool_call(0, None, "1}"),
        tool_call(1, Some("b"), "{}"),
        content("done"),
    ];
    assert_eq!(
        choice_scan_texts(&calls)["0"],
        format!("{{\"x\":1}}{FIELD_SEPARATOR}{{}}{FIELD_SEPARATOR}done")
    );
    let one_delta = json!({ "choices": [{ "index": 0, "delta": {
        "content": "a", "tool_calls": [
            { "index": 0, "function": { "arguments": "b" } },
            { "index": 1, "function": { "arguments": "c" } }] } }] });
    assert_eq!(
        choice_scan_texts(&[one_delta])["0"],
        format!("a{FIELD_SEPARATOR}b{FIELD_SEPARATOR}c")
    );
}

#[test]
fn an_aws_keyword_in_the_answer_does_not_reach_a_commit_hash_argument() {
    let arguments = format!(r#"{{"commit":"{COMMIT}"}}"#);
    let frames = [
        content("Rotating the AWS secret"),
        tool_call(0, Some("rotate"), &arguments),
        finish(),
    ];
    let expected = (
        "Rotating the AWS secret".to_owned(),
        "rotate".to_owned(),
        arguments.clone(),
    );
    assert_non_stream_parity(&frames, &expected);
    // A connection string's scheme in the answer and an `@` in the
    // arguments.
    let frames = [
        content("Connect via postgres://admin"),
        tool_call(0, Some("connect"), r#"{"p":"x@y"}"#),
        finish(),
    ];
    let expected = (
        "Connect via postgres://admin".to_owned(),
        "connect".to_owned(),
        r#"{"p":"x@y"}"#.to_owned(),
    );
    assert_non_stream_parity(&frames, &expected);
}

#[test]
fn a_secret_param_ending_the_answer_leaves_the_tool_call_intact() {
    for text in ["Set password=hunter22", "Set password=hunter22."] {
        let frames = [
            content(text),
            tool_call(0, Some("save"), r#"{"ok":true}"#),
            finish(),
        ];
        let expected = (
            "Set [REDACTED:secret_param]".to_owned(),
            "save".to_owned(),
            r#"{"ok":true}"#.to_owned(),
        );
        assert_non_stream_parity(&frames, &expected);
    }
}

#[test]
fn a_value_split_inside_one_calls_arguments_is_still_caught() {
    let scanner = scanner();
    let frames = [
        content("Saving the credentials now."),
        tool_call(0, Some("save"), r#"{"aws_secret":""#),
        tool_call(0, None, r#"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}"#),
        finish(),
    ];
    // Neither chunk matches alone; joined in the call's text they do.
    for frame in &frames {
        assert!(scanner
            .scan_outbound(&json_string_projection(frame))
            .is_none());
    }
    let raw = sse(&frames);
    let (buffered, _, violation) =
        rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert!(violation.is_some(), "{buffered}");
    let per_frame: Vec<usize> = raw.match_indices("data: ").map(|(at, _)| at).collect();
    let (streamed, blocked) =
        run_streaming(&raw, &per_frame, FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked, "{streamed}");
    // Under Sanitize the key never goes out whole.
    let (buffered, _, _) = rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
    let (streamed, _) =
        run_streaming(&raw, &per_frame, FirewallPolicy::Sanitize, &scanner).unwrap();
    for out in [buffered, streamed] {
        assert!(
            !assembled(&out)
                .2
                .contains("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
            "{out}"
        );
    }
}
