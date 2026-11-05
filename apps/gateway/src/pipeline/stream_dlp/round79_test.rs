//! Rounds 79-82 (output evaluators and token mirrors).
//!
//! - Round 79: a choice's `message` beside a `delta` is judged, and the
//!   strings outside the rendered text follow every choice's text without
//!   piling up protocol values or token mirrors.
//! - Round 80: an evaluator Sanitize replays the provider's frames with each
//!   string sanitized, so a join across a field switch or a choice boundary
//!   can neither make a value nor break one apart.
//! - Round 81: the non-stream evaluator Sanitize drops token mirrors too.
//! - Round 82: logprob token lanes are never joined across frames, so
//!   tokens or alternatives at the same position in different frames do not
//!   block or mask a clean reply.
//! - Round 83: those token sequences (and a choice's own text) are not
//!   envelope lanes, so a value split in them never masks `object`/`model`.
//! - Round 85: evaluators judge `choices` sent as an object, and every
//!   fragment of a field a client concatenates (a repeat counts once only
//!   when every frame repeats the whole value).
//! - Round 86: the evaluator reads each string a client builds (every path
//!   joined across frames, tool calls by `index`); a value repeated whole in
//!   every frame outside the text is judged once and joined; token sequences
//!   read object `choices`; streamed evaluator outcomes are audited.
//! - Round 87: evaluators judge logprob strings one by one (and the sampled
//!   tokens in order), a choice's own `id`/`model`/`object` and a
//!   non-numeric `index`; the audit skips Azure's empty first-chunk model.

use serde_json::{json, Value};

use super::scan_test::scanner;
use crate::config::FirewallPolicy;

#[path = "round89_test.rs"]
mod round89_test;

fn sse(frames: &[Value]) -> String {
    let mut raw: String = frames
        .iter()
        .map(|frame| format!("data: {frame}\n\n"))
        .collect();
    raw.push_str("data: [DONE]\n\n");
    raw
}

fn evaluated(raw: &str) -> String {
    let scanner = scanner();
    super::super::rewrite_sse_for_dlp(raw, &scanner, &FirewallPolicy::WarnAndContinue)
        .unwrap()
        .1
}

#[test]
fn an_evaluator_sanitize_replay_keeps_strings_apart() {
    let scanner = scanner();
    let content = json!({ "choices": [{ "index": 0, "delta": { "content": "password" } }] });
    let call = json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{ "index": 0,
        "id": "call_1", "type": "function",
        "function": { "name": "f", "arguments": "=hunter22" } }] } }] });
    let other = json!({ "choices": [{ "index": 1, "delta": { "content": " " } }] });
    let replay = |frames: &[Value]| {
        super::super::evaluator_sanitized(&scanner, &sse(frames), &FirewallPolicy::WarnAndContinue)
    };
    let body = replay(&[content.clone(), other, call.clone()]);
    // The strings stay apart, as in the non-stream reply: no joined secret.
    assert!(!body.contains("password=hunter22"), "{body}");
    // Since round 89 each choice is its own scan text, so choice 1's space no
    // longer sits between choice 0's content and its arguments: choice 0 is
    // judged as it is alone. Since round 91 its content and its arguments
    // are separate texts there too (a field separator between them), as they
    // are separate strings in the non-stream reply: nothing forms across
    // them, so each string goes out as it is, never joined and never masked.
    for body in [body, replay(&[content.clone(), call.clone()])] {
        assert!(!body.contains("password=hunter22"), "{body}");
        assert!(body.contains("\"content\":\"password\""), "{body}");
        assert!(body.contains("\"arguments\":\"=hunter22\""), "{body}");
        assert!(!body.contains("[REDACTED]"), "{body}");
    }
    // Text of choice 0 between them keeps them apart, and the replay keeps
    // each string as it is.
    let spaced = json!({ "choices": [{ "index": 0, "delta": { "content": " " } }] });
    let body = replay(&[content, spaced, call]);
    assert!(body.contains("\"arguments\":\"=hunter22\""), "{body}");
}

#[test]
fn a_message_beside_a_delta_is_judged() {
    for delta in [json!({}), Value::Null] {
        let raw = sse(&[
            json!({ "choices": [{ "index": 0,
                "delta": { "role": "assistant", "content": "Done." } }] }),
            json!({ "choices": [{ "index": 0, "delta": delta,
                "message": { "role": "assistant", "content": "Reach me at jane@corp.com" },
                "finish_reason": "stop" }] }),
        ]);
        let assembled = evaluated(&raw);
        assert_eq!(assembled, "Done.\nReach me at jane@corp.com", "{delta}");
    }
}

#[test]
fn a_reasoning_details_mirror_is_judged() {
    let raw = sse(&[json!({ "choices": [{ "index": 0, "delta": {
        "reasoning": "think",
        "reasoning_details": [{ "type": "reasoning.text", "text": "think",
            "signature": "sig-123", "format": "fmt-x" }] } }] })]);
    let assembled = evaluated(&raw);
    for expected in ["sig-123", "fmt-x"] {
        assert!(assembled.contains(expected), "{}", assembled);
    }
}

#[test]
fn later_choices_stay_in_the_judged_head() {
    let mut frames: Vec<Value> = (0..400)
        .map(|_| {
            json!({ "choices": [{ "index": 0, "delta": { "role": "assistant", "content": "ok " },
                "logprobs": { "content": [{ "token": "ok ",
                    "top_logprobs": [{ "token": "x@y" }, { "token": ".io" }] }] },
                "content_filter_results": { "hate": { "filtered": false, "severity": "safe" } } }] })
        })
        .collect();
    frames.push(json!({ "choices": [{ "index": 1,
        "delta": { "role": "assistant", "content": "second choice" } }] }));
    let assembled = evaluated(&sse(&frames));
    let second = assembled.find("second choice").unwrap();
    assert_eq!(second, 1201, "choice 1 follows choice 0's text directly");
    assert!(!assembled.contains("assistant"));
    // Alternatives are judged one by one, after every choice's text.
    assert!(assembled.find("x@y").unwrap() > second);
    assert!(!assembled.contains("x@yx@y"));
    // A value every frame repeats is judged once on its own, after the text.
    assert!(assembled.lines().any(|line| line == "safe"), "{assembled}");
}

fn replayed(frames: &[Value]) -> String {
    super::super::evaluator_sanitized(&scanner(), &sse(frames), &FirewallPolicy::WarnAndContinue)
}

/// No card digit survives: the card is replaced whole, or (when the joined
/// text redacts differently from the strings apart, as the DLP's own
/// Sanitize decides) each string is masked, failing closed.
fn assert_card_redacted(body: &str) {
    assert!(!body.contains("1111"), "{body}");
    assert!(body.contains("[REDACTED"), "{body}");
}

#[test]
fn a_card_after_a_reasoning_switch_is_redacted_whole() {
    let body = replayed(&[
        json!({ "choices": [{ "index": 0, "delta": { "role": "assistant", "content": null,
            "reasoning_content": "Their office line is 555 123" } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "content": "4111 1111 1111 1111",
            "reasoning_content": null }, "finish_reason": "stop" }] }),
    ]);
    assert_card_redacted(&body);
}

#[test]
fn a_card_in_another_choice_is_redacted_whole() {
    let body = replayed(&[
        json!({ "choices": [{ "index": 0, "delta": { "content": "call 555 123" } }] }),
        json!({ "choices": [{ "index": 1, "delta": { "content": "4111 1111 1111 1111" } }] }),
    ]);
    assert_card_redacted(&body);
}

#[test]
fn a_card_split_across_frames_is_redacted_whole() {
    let body = replayed(&[
        json!({ "choices": [{ "index": 0, "delta": { "content": "card 4111 1111 " } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "content": "1111 1111 thanks" } }] }),
    ]);
    assert!(!body.contains("1111"), "{body}");
    assert!(body.contains("thanks"), "{body}");
}

#[test]
fn a_non_stream_evaluator_sanitize_drops_token_mirrors() {
    let token = |text: &str| {
        json!({ "token": text, "logprob": -0.1,
        "bytes": text.bytes().collect::<Vec<u8>>(), "top_logprobs": [] })
    };
    let mut response = json!({ "choices": [{ "index": 0,
        "message": { "role": "assistant", "content": "Call 555-123-4567" },
        "logprobs": { "content": [token("Call"), token(" 555"), token("-123"), token("-4567")] },
        "finish_reason": "stop" }] });
    crate::pipeline::sanitize_response(&mut response, &scanner());
    assert_eq!(
        response["choices"][0]["message"]["content"],
        "Call [REDACTED:PHONE_US]"
    );
    assert!(response["choices"][0]["logprobs"].is_null(), "{response}");
    assert!(!response.to_string().contains("4567"), "{response}");
}

fn logprob_frame(content: &str, tokens: &[(&str, &str)]) -> Value {
    let entries: Vec<Value> = tokens
        .iter()
        .map(|(token, alternative)| {
            json!({ "token": token, "logprob": -0.1, "bytes": [],
                "top_logprobs": [{ "token": token, "logprob": -0.1, "bytes": [] },
                    { "token": alternative, "logprob": -2.0, "bytes": [] }] })
        })
        .collect();
    json!({ "choices": [{ "index": 0, "delta": { "content": content },
        "logprobs": { "content": entries }, "finish_reason": null }] })
}

fn assert_clean_on_both_paths(frames: &[Value]) {
    let scanner = scanner();
    let raw = sse(frames);
    let splits: Vec<usize> = raw.match_indices("data: ").map(|(at, _)| at).collect();
    for policy in [
        FirewallPolicy::Block,
        FirewallPolicy::Sanitize,
        FirewallPolicy::WarnAndContinue,
    ] {
        let (buffered, _, violation) =
            super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert!(violation.is_none(), "{policy:?}: {violation:?}");
        assert!(!buffered.contains("REDACTED"), "{policy:?}: {buffered}");
        let (streamed, blocked) =
            super::scan_test::run_streaming(&raw, &splits, policy.clone(), &scanner).unwrap();
        assert!(!blocked, "{policy:?}: {streamed}");
        assert_eq!(streamed, buffered, "{policy:?}");
    }
}

#[test]
fn tokens_at_one_position_in_different_frames_are_not_joined() {
    assert_clean_on_both_paths(&[
        logprob_frame("a 555", &[("a", "x"), (" 555", "y")]),
        logprob_frame(" b 123", &[(" b", "x"), (" 123", "y")]),
        logprob_frame(" c 4567", &[(" c", "x"), (" 4567", "y")]),
        json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }] }),
    ]);
}

#[test]
fn runner_up_alternatives_are_not_joined() {
    assert_clean_on_both_paths(&[
        logprob_frame(" 515", &[(" 515", " 555")]),
        logprob_frame(" 1", &[(" 1", " 123")]),
        logprob_frame(" 4067", &[(" 4067", " 4567")]),
        json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }] }),
    ]);
}

#[test]
fn a_value_the_tokens_mirror_is_still_caught() {
    let scanner = scanner();
    let raw = sse(&[
        logprob_frame("call 555-123-", &[("call", "x"), (" 555-123-", "y")]),
        logprob_frame("4567 now", &[("4567", "x"), (" now", "y")]),
    ]);
    let (_, _, violation) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert!(violation.is_some());
}

#[test]
fn a_split_key_with_logprobs_keeps_the_envelope_of_an_n2_stream() {
    let scanner = scanner();
    let frame = |choice: Value| {
        json!({ "id": "c", "object": "chat.completion.chunk", "model": "gpt-4o-mini",
            "choices": [choice] })
    };
    let tokens = |tokens: &[&str]| {
        let entries: Vec<Value> = tokens
            .iter()
            .map(
                |token| json!({ "token": token, "logprob": -0.1, "bytes": [], "top_logprobs": [] }),
            )
            .collect();
        json!({ "content": entries })
    };
    let raw = sse(&[
        frame(
            json!({ "index": 0, "delta": { "role": "assistant", "content": "" },
            "logprobs": null, "finish_reason": null }),
        ),
        frame(
            json!({ "index": 1, "delta": { "role": "assistant", "content": "" },
            "logprobs": null, "finish_reason": null }),
        ),
        frame(
            json!({ "index": 0, "delta": { "content": "key sk-AbCdEfGhIj" },
            "logprobs": tokens(&["key", " sk-AbCdEfGhIj"]), "finish_reason": null }),
        ),
        frame(
            json!({ "index": 0, "delta": { "content": "KlMnOpQrStUvWx ok" },
            "logprobs": tokens(&["KlMnOpQrStUvWx", " ok"]), "finish_reason": null }),
        ),
        frame(json!({ "index": 0, "delta": {}, "finish_reason": "stop" })),
        frame(json!({ "index": 1, "delta": {}, "finish_reason": "stop" })),
    ]);
    let splits: Vec<usize> = raw.match_indices("data: ").map(|(at, _)| at).collect();
    let policy = FirewallPolicy::WarnAndContinue;
    let (buffered, _, _) = super::super::rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
    let (streamed, _) = super::scan_test::run_streaming(&raw, &splits, policy, &scanner).unwrap();
    for out in [&streamed, &buffered] {
        assert!(out.contains("\"model\":\"gpt-4o-mini\""), "{out}");
        assert!(
            out.contains("\"object\":\"chat.completion.chunk\""),
            "{out}"
        );
        assert!(!out.contains("KlMnOpQrStUvWx"), "{out}");
    }
}

#[test]
fn evaluators_judge_object_shaped_choices() {
    let raw = sse(&[json!({ "id": "c1", "object": "chat.completion.chunk",
        "choices": { "0": { "index": 0, "delta": { "content": "My SSN is 123-45-6789" } } } })]);
    assert!(evaluated(&raw).contains("123-45-6789"));
    let response = json!({ "choices": { "0": { "message": {
        "content": "My SSN is 123-45-6789" } } } });
    assert!(crate::pipeline::response_to_text(&response).contains("123-45-6789"));
    let stray = sse(&[json!({ "choices": "My SSN is 123-45-6789" })]);
    assert!(evaluated(&stray).contains("123-45-6789"));
}

#[test]
fn repeated_fragments_of_a_concatenated_field_are_all_judged() {
    let name = |text: &str| {
        json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{ "index": 0,
            "function": { "name": text } }] } }] })
    };
    let raw = sse(&[name("4111"), name(" 1111"), name(" 1111"), name(" 1111")]);
    assert!(evaluated(&raw).contains("4111 1111 1111 1111"));
}

#[test]
fn identical_name_fragments_are_judged_joined() {
    let name = json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{ "index": 0,
        "function": { "name": " 4242" } }] } }] });
    let raw = sse(&[name.clone(), name.clone(), name.clone(), name]);
    assert!(evaluated(&raw).contains(" 4242 4242 4242 4242"));
}

#[test]
fn interleaved_tool_calls_are_judged_per_call() {
    let call = |index: u64, arguments: &str| {
        json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [{ "index": index,
            "function": { "arguments": arguments } }] } }] })
    };
    let raw = sse(&[
        call(0, "{\"card\":\"4111 1111"),
        call(1, "{}"),
        call(0, " 1111 1111\"}"),
    ]);
    assert!(evaluated(&raw).contains("{\"card\":\"4111 1111 1111 1111\"}"));
}

#[test]
fn a_reasoning_field_carrying_on_alone_is_judged_whole() {
    let raw = sse(&[
        json!({ "choices": [{ "index": 0, "delta": {
            "reasoning_content": "4111 1111", "reasoning": "4111 1111" } }] }),
        json!({ "choices": [{ "index": 0, "delta": { "reasoning": " 1111 1111" } }] }),
    ]);
    assert!(evaluated(&raw).contains("4111 1111 1111 1111"));
}

#[test]
fn object_choices_token_sequences_are_judged_on_both_paths() {
    let scanner = scanner();
    let frame = |content: &str, token: &str| {
        json!({ "choices": { "0": { "index": 0, "delta": { "content": content },
            "logprobs": { "content": [{ "token": token, "logprob": -0.1, "top_logprobs": [] }] } } } })
    };
    let raw = sse(&[frame("a", " 555"), frame("b", " 123"), frame("c", " 4567")]);
    let splits: Vec<usize> = raw.match_indices("data: ").map(|(at, _)| at).collect();
    let (_, _, violation) =
        super::super::rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
    assert!(violation.is_some());
    let (streamed, blocked) =
        super::scan_test::run_streaming(&raw, &splits, FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked && !streamed.contains(" 4567"), "{streamed}");
}

#[test]
fn a_streamed_evaluator_audit_names_the_provider_model() {
    let raw = sse(&[
        json!({ "id": "c", "model": "gpt-4o-mini", "choices": [] }),
        json!({ "model": "other", "choices": [] }),
    ]);
    assert_eq!(super::super::stream_model(&raw), "gpt-4o-mini");
    assert_eq!(super::super::stream_model("data: [DONE]\n\n"), "unknown");
    let azure = sse(&[
        json!({ "choices": [], "created": 0, "id": "", "model": "", "object": "" }),
        json!({ "model": "gpt-4o-2024-08-06", "choices": [] }),
    ]);
    assert_eq!(super::super::stream_model(&azure), "gpt-4o-2024-08-06");
}

#[test]
fn logprob_alternatives_are_judged_one_by_one() {
    let raw = sse(&[
        json!({ "choices": [{ "index": 0, "delta": { "content": " darn" },
        "logprobs": { "content": [{ "token": " darn", "logprob": -0.1,
            "top_logprobs": [{ "token": " darn", "logprob": -0.1 },
                { "token": " heck", "logprob": -2.4 }] }] } }] }),
    ]);
    let assembled = evaluated(&raw);
    assert!(assembled.lines().any(|line| line == " heck"), "{assembled}");
}

#[test]
fn a_choices_own_envelope_named_strings_are_judged() {
    let raw = sse(&[json!({ "object": "chat.completion.chunk", "model": "m",
        "choices": [{ "index": "go away", "model": "choice model text", "id": "choice id text",
            "delta": { "content": "ok" } }] })]);
    let assembled = evaluated(&raw);
    for expected in ["go away", "choice model text", "choice id text"] {
        assert!(assembled.contains(expected), "{assembled}");
    }
    assert!(!assembled.contains("chat.completion.chunk"), "{assembled}");
}
