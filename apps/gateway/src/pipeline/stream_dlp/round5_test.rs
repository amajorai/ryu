//! Field switches, envelope split candidates, OpenRouter / Azure shapes.

use serde_json::{json, Value};

use super::scan_test::{run_streaming, scanner};
use super::StreamingDlp;
use crate::config::FirewallPolicy;

fn field(sse: &str, key: &str) -> String {
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

fn per_frame(raw: &str) -> Vec<usize> {
    raw.match_indices("data: ").map(|(at, _)| at).collect()
}

fn reasoning(part: &str) -> Value {
    json!({ "choices": [{ "index": 0, "delta": { "content": null, "reasoning_content": part } }] })
}

fn answer(part: &str) -> Value {
    json!({ "choices": [{ "index": 0, "delta": { "content": part, "reasoning_content": null } }] })
}

/// A value ending the reasoning right before the answer starts is still a
/// whole value: the field switch is a word boundary.
#[test]
fn a_reasoning_to_answer_switch_is_a_text_boundary() {
    let scanner = scanner();
    let mut frames: Vec<Value> = ["The user's SSN is ", "123", "-45", "-6789"]
        .iter()
        .map(|part| reasoning(part))
        .collect();
    frames.extend(["Sure", ", done. "].iter().map(|part| answer(part)));
    let raw = sse(&frames);
    let (streamed, blocked) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked && !streamed.contains("6789"));
    let (streamed, _) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Sanitize, &scanner).unwrap();
    assert_eq!(
        field(&streamed, "reasoning_content"),
        "The user's SSN is [REDACTED:SSN]"
    );
    assert_eq!(field(&streamed, "content"), "Sure, done. ");
    let (buffered, _, _) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
    assert_eq!(
        field(&buffered, "reasoning_content"),
        "The user's SSN is [REDACTED:SSN]"
    );

    let mut frames: Vec<Value> = ["I will share the key"]
        .iter()
        .map(|part| reasoning(part))
        .collect();
    frames.extend(
        ["sk-abcdefghij", "klmnopqrstuvwxyz ", "now. "]
            .iter()
            .map(|part| answer(part)),
    );
    let raw = sse(&frames);
    let (streamed, _) = run_streaming(
        &raw,
        &per_frame(&raw),
        FirewallPolicy::WarnAndContinue,
        &scanner,
    )
    .unwrap();
    assert_eq!(field(&streamed, "content"), "[REDACTED:openai_key] now. ");
}

/// OpenRouter mirrors reasoning into `reasoning_details`; such frames stream,
/// and the mirror is rewritten with the reasoning.
#[test]
fn openrouter_reasoning_details_stream_and_follow_the_redaction() {
    let scanner = scanner();
    let frame = |text: &str| {
        json!({ "choices": [{ "index": 0, "delta": {
            "content": "", "role": "assistant", "reasoning": text,
            "reasoning_details": [{ "type": "reasoning.text", "text": text, "format": "unknown", "index": 0 }]
        } }] })
    };
    let frames: Vec<Value> = [
        "Thinking ",
        "about ",
        "sk-abcdefghij",
        "klmnopqrstuvwxyz0123",
        " now. ",
    ]
    .iter()
    .map(|part| frame(part))
    .collect();
    let raw = sse(&frames);
    let mut dlp = StreamingDlp::new(FirewallPolicy::WarnAndContinue, true);
    let early = dlp.push(raw.as_bytes(), &scanner).unwrap();
    assert!(field(&early.bytes, "reasoning").starts_with("Thinking about"));
    let streamed = format!("{}{}", early.bytes, dlp.finish(&scanner).unwrap().bytes);
    assert_eq!(
        field(&streamed, "reasoning"),
        "Thinking about [REDACTED:openai_key] now. "
    );
    assert!(!streamed.contains("sk-abcdefghij") && !streamed.contains("klmnopq"));
}

#[test]
fn azure_custom_blocklist_annotations_keep_frames_simple() {
    let frame = json!({ "choices": [{
        "content_filter_results": {
            "custom_blocklists": { "filtered": false, "details": [{ "filtered": false, "id": "my-blocklist" }] },
            "hate": { "filtered": false, "severity": "safe" }
        },
        "delta": { "content": "Hello" }, "finish_reason": null, "index": 0
    }] });
    assert!(super::super::simple_content_delta(&frame));
    let leaky = json!({ "choices": [{
        "content_filter_results": { "custom_blocklists": [{ "filtered": true, "id": "sk-abc def" }] },
        "delta": { "content": "Hello" }, "index": 0
    }] });
    assert!(!super::super::simple_content_delta(&leaky));
}

#[test]
fn a_non_ascii_letter_before_a_keyword_is_kept_in_scan_context() {
    let scanner = scanner();
    let mut parts: Vec<String> =
        "Renew your \u{e9}Passport A1234567 reference number belongs elsewhere "
            .split_inclusive(' ')
            .map(str::to_owned)
            .collect();
    parts.extend(std::iter::repeat_n(
        "and then some more ordinary words follow here ".to_owned(),
        12,
    ));
    let frames: Vec<Value> = parts.iter().map(|part| answer(part)).collect();
    let raw = sse(&frames);
    let (_, _, oracle) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    let (_, blocked) =
        run_streaming(&raw, &per_frame(&raw), FirewallPolicy::Block, &scanner).unwrap();
    // The stream judges the keyword with the same left context as the whole
    // text, so it agrees with the buffered oracle either way.
    assert_eq!(blocked, oracle.is_some());
}

/// A value's head ending the reasoning and its tail starting the answer, and
/// keyword-padding forms whose keyword ends the reasoning: in a non-streamed
/// response the two fields are separate strings and none of these match.
const SPLIT_VALUES: [(&str, &str); 5] = [
    ("Room 555-123", "4567 is the code. "),
    ("ref 123-45", "6789 units. "),
    (
        "Authorization: Bearer",
        "abcdefghijklmnopqrstuvwxyzabcdefghijklmn ok ",
    ),
    ("api_key:", "abcdefghijklmnopqrstuv ok "),
    ("passport no.", "AB1234567 is mine. "),
];

const POLICIES: [FirewallPolicy; 3] = [
    FirewallPolicy::Block,
    FirewallPolicy::Sanitize,
    FirewallPolicy::WarnAndContinue,
];

/// `text` as two frames' parts, split at its middle character.
fn halves(text: &str) -> [&str; 2] {
    let middle = text
        .char_indices()
        .map(|(at, _)| at)
        .find(|at| *at >= text.len() / 2)
        .unwrap_or(text.len());
    [&text[..middle], &text[middle..]]
}

/// The stream at every byte offset and the buffered path both pass `frames`
/// unchanged: no block, no violation, the provider's fields as sent.
fn assert_passes(frames: &[Value], expected: &[(&str, String)]) {
    let scanner = scanner();
    let raw = sse(frames);
    for policy in POLICIES {
        for offset in 0..=raw.len() {
            let (streamed, blocked) =
                run_streaming(&raw, &[offset], policy.clone(), &scanner).unwrap();
            assert!(!blocked, "{policy:?} blocked at {offset}: {raw}");
            for (key, text) in expected {
                assert_eq!(field(&streamed, key), *text, "{policy:?} at {offset}");
            }
        }
        let (buffered, _, violation) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert!(violation.is_none(), "{policy:?}: {violation:?}");
        for (key, text) in expected {
            assert_eq!(field(&buffered, key), *text, "{policy:?} buffered");
        }
    }
}

#[test]
fn values_split_across_a_field_switch_pass_unchanged() {
    let scanner = scanner();
    for (reasoning_text, answer_text) in SPLIT_VALUES {
        let mut frames: Vec<Value> = halves(reasoning_text).map(reasoning).to_vec();
        frames.extend(halves(answer_text).map(answer));
        assert_passes(
            &frames,
            &[
                ("reasoning_content", reasoning_text.to_owned()),
                ("content", answer_text.to_owned()),
            ],
        );
        // The non-streamed response: each field its own string.
        let message = json!({ "choices": [{ "index": 0, "message": {
            "role": "assistant", "content": answer_text, "reasoning_content": reasoning_text
        } }] });
        let projection = super::super::json_string_projection(&message);
        assert!(scanner.scan_outbound(&projection).is_none(), "{projection}");
        // One vLLM delta carrying both fields (`split_boundary`).
        let both = json!({ "choices": [{ "index": 0, "delta": {
            "reasoning_content": reasoning_text, "content": answer_text
        } }] });
        assert_passes(
            &[both],
            &[
                ("reasoning_content", reasoning_text.to_owned()),
                ("content", answer_text.to_owned()),
            ],
        );
    }
}

/// Values around each switch of answer, reasoning, answer pass too; the
/// resumed answer joins its earlier text without forming a value.
#[test]
fn values_around_every_switch_pass_unchanged() {
    for parts in [
        ["Room 555-123", "4567 ok. ref 123-45", "6789 units. "],
        [
            "Authorization: Bearer",
            "abcdefghijklmnopqrstuvwxyzabcdefghijklmn then passport no.",
            "AB1234567 done. ",
        ],
    ] {
        let frames = [answer(parts[0]), reasoning(parts[1]), answer(parts[2])];
        assert_passes(
            &frames,
            &[
                ("reasoning_content", parts[1].to_owned()),
                ("content", format!("{}{}", parts[0], parts[2])),
            ],
        );
    }
}

/// A field that resumes after another is still judged whole: the separator
/// stops matches across the switch, not across the field's own text.
#[test]
fn a_value_split_by_a_resumed_field_is_still_caught() {
    let scanner = scanner();
    for (parts, value, pii) in [
        (
            ["Call 555-123", "thinking ", "-4567 ok "],
            "555-123-4567",
            true,
        ),
        (
            ["key sk-abcdefghij", "thinking ", "klmnopqrstuvwxyz ok "],
            "sk-abcdefghijklmnopqrstuvwxyz",
            false,
        ),
    ] {
        let frames = [answer(parts[0]), reasoning(parts[1]), answer(parts[2])];
        let raw = sse(&frames);
        for offset in 0..=raw.len() {
            let (streamed, blocked) =
                run_streaming(&raw, &[offset], FirewallPolicy::Block, &scanner).unwrap();
            assert!(blocked && !field(&streamed, "content").contains(value));
            // Warn-only leaves PII as it is, as the buffered path does.
            let policies: &[FirewallPolicy] = if pii {
                &[FirewallPolicy::Sanitize]
            } else {
                &[FirewallPolicy::Sanitize, FirewallPolicy::WarnAndContinue]
            };
            for policy in policies {
                let (streamed, _) =
                    run_streaming(&raw, &[offset], policy.clone(), &scanner).unwrap();
                assert!(!field(&streamed, "content").contains(value), "{streamed}");
            }
        }
    }
}

/// vLLM mirrors `reasoning_content` into `reasoning`, then sends `reasoning`
/// alone: the key switch puts a separator in the scan text, yet the client
/// reads one `reasoning` string, so its lane still judges it whole.
#[test]
fn a_mirrored_reasoning_field_continuing_alone_is_judged_whole() {
    let scanner = scanner();
    let mirrored = |text: &str| json!({ "choices": [{ "index": 0, "delta": { "reasoning_content": text, "reasoning": text } }] });
    let alone = |text: &str| json!({ "choices": [{ "index": 0, "delta": { "reasoning": text } }] });
    let token = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0123";
    let frames = [
        mirrored("Use "),
        mirrored("Bearer"),
        alone(&format!(" {token}")),
        alone(" ok "),
    ];
    let raw = sse(&frames);
    for offset in 0..=raw.len() {
        let (streamed, blocked) =
            run_streaming(&raw, &[offset], FirewallPolicy::Block, &scanner).unwrap();
        assert!(blocked && !streamed.contains(token), "{offset}: {streamed}");
        for policy in [FirewallPolicy::Sanitize, FirewallPolicy::WarnAndContinue] {
            let (streamed, _) = run_streaming(&raw, &[offset], policy, &scanner).unwrap();
            assert!(!streamed.contains(token), "{offset}: {streamed}");
        }
    }
    let (buffered, _, violation) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
    assert!(violation.is_some() && !buffered.contains(token));
}
