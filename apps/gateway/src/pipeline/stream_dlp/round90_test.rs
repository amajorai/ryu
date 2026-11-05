//! Round 90: a delta carrying both reasoning and answer text that is not
//! split into two frames (it carries token mirrors, or it belongs to a choice
//! other than 0) is scanned as the split frames are: the reasoning, a field
//! separator, then the answer. The reasoning tail is never joined onto the
//! answer, so neither path blocks or masks a reply the non-stream path
//! passes, and the answer still continues into its next frame.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::config::FirewallPolicy;
use crate::pipeline::stream_dlp::round15_test::sse;
use crate::pipeline::stream_dlp::scan_test::{run_streaming, scanner, splits};
use crate::pipeline::{
    choice_scan_texts, json_string_projection, rewrite_sse_for_dlp, FIELD_SEPARATOR,
};

fn token(text: &str) -> Value {
    json!({ "token": text, "logprob": -0.1, "bytes": null, "top_logprobs": [] })
}

/// The finding's n=1 repro: vLLM with `logprobs: true`, `</think>` inside a
/// multi-token step.
fn logprob_frames() -> Vec<Value> {
    vec![
        json!({ "id": "c", "object": "chat.completion.chunk", "model": "m",
            "choices": [{ "index": 0,
                "delta": { "role": "assistant", "reasoning_content": "Note" },
                "logprobs": { "content": [token("Note")] }, "finish_reason": null }] }),
        json!({ "id": "c", "object": "chat.completion.chunk", "model": "m",
            "choices": [{ "index": 0,
                "delta": { "content": "Ext 555-", "reasoning_content": "123-4567." },
                "logprobs": { "content": [token("123-4567."), token("Ext 555-")] },
                "finish_reason": null }] }),
        json!({ "id": "c", "object": "chat.completion.chunk", "model": "m",
            "choices": [{ "index": 0, "delta": { "content": "0199." },
                "logprobs": { "content": [token("0199.")] }, "finish_reason": "stop" }] }),
    ]
}

fn entry(index: u64, delta: Value) -> Value {
    json!({ "id": "c", "object": "chat.completion.chunk", "model": "m",
        "choices": [{ "index": index, "delta": delta, "finish_reason": null }] })
}

/// The n=2 variant: the same deltas on choice 1, beside a plain choice 0.
fn second_choice_frames() -> Vec<Value> {
    vec![
        entry(0, json!({ "role": "assistant", "content": "Hello" })),
        entry(
            1,
            json!({ "role": "assistant", "reasoning_content": "Note" }),
        ),
        entry(0, json!({ "content": " there." })),
        entry(
            1,
            json!({ "content": "Ext 555-", "reasoning_content": "123-4567." }),
        ),
        entry(1, json!({ "content": "0199." })),
    ]
}

/// Each choice's delta text fields as a client builds them, by lane and
/// field.
fn fields_by_choice(raw: &str) -> BTreeMap<(u64, String), String> {
    let mut fields = BTreeMap::<(u64, String), String>::new();
    for frame in raw
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
    {
        for choice in frame["choices"].as_array().into_iter().flatten() {
            let index = choice["index"].as_u64().unwrap_or_default();
            for key in ["content", "reasoning_content"] {
                if let Some(text) = choice["delta"][key].as_str() {
                    fields
                        .entry((index, key.to_owned()))
                        .or_default()
                        .push_str(text);
                }
            }
        }
    }
    fields
}

/// The non-stream response carrying the same text: one message per choice.
fn non_stream_passes(fields: &BTreeMap<(u64, String), String>) {
    let mut choices = BTreeMap::<u64, serde_json::Map<String, Value>>::new();
    for ((index, key), text) in fields {
        choices
            .entry(*index)
            .or_default()
            .insert(key.clone(), json!(text));
    }
    let choices: Vec<Value> = choices
        .into_iter()
        .map(|(index, message)| json!({ "index": index, "message": message }))
        .collect();
    let response = json!({ "choices": choices });
    let projection = json_string_projection(&response);
    assert!(
        scanner().scan_outbound(&projection).is_none(),
        "{projection}"
    );
}

fn assert_passes_as_non_stream(frames: &[Value]) {
    let raw = sse(frames);
    let expected = fields_by_choice(&raw);
    non_stream_passes(&expected);
    // No violation, no mask, the same bytes on both paths, every policy.
    super::super::assert_clean_on_both_paths(frames);
    let scanner = scanner();
    for policy in [FirewallPolicy::Block, FirewallPolicy::Sanitize] {
        let (buffered, _, violation) = rewrite_sse_for_dlp(&raw, &scanner, &policy).unwrap();
        assert!(violation.is_none(), "{policy:?}: {violation:?}");
        // The non-stream result: every string goes out as sent.
        assert_eq!(fields_by_choice(&buffered), expected, "{policy:?}");
        for seed in 0..8 {
            let (streamed, blocked) =
                run_streaming(&raw, &splits(&raw, seed, 16), policy.clone(), &scanner).unwrap();
            assert!(!blocked, "{policy:?}/{seed}: {streamed}");
            assert_eq!(streamed, buffered, "{policy:?}/{seed}");
        }
    }
}

#[test]
fn an_unsplit_boundary_delta_with_logprobs_passes_on_both_paths() {
    let frames = logprob_frames();
    // The boundary frame carries token mirrors, so it stays whole.
    assert!(crate::pipeline::split_boundary(&frames[1]).is_none());
    let texts = choice_scan_texts(&frames);
    assert_eq!(
        texts["0"],
        format!("Note123-4567.{FIELD_SEPARATOR}Ext 555-0199.")
    );
    assert_passes_as_non_stream(&frames);
}

#[test]
fn a_boundary_delta_of_another_choice_passes_on_both_paths() {
    let frames = second_choice_frames();
    assert!(crate::pipeline::split_boundary(&frames[3]).is_none());
    let texts = choice_scan_texts(&frames);
    assert_eq!(texts["0"], "Hello there.");
    assert_eq!(
        texts["1"],
        format!("Note123-4567.{FIELD_SEPARATOR}Ext 555-0199.")
    );
    assert_passes_as_non_stream(&frames);
}

#[test]
fn the_answer_of_a_boundary_delta_still_runs_into_its_next_frame() {
    let scanner = scanner();
    let streams = [
        {
            let mut frames = logprob_frames();
            frames[1]["choices"][0]["delta"]["content"] = json!("Call 555-123-");
            frames[2]["choices"][0]["delta"]["content"] = json!("4567 now.");
            frames
        },
        {
            let mut frames = second_choice_frames();
            frames[3]["choices"][0]["delta"]["content"] = json!("Call 555-123-");
            frames[4]["choices"][0]["delta"]["content"] = json!("4567 now.");
            frames
        },
    ];
    for frames in streams {
        let raw = sse(&frames);
        let (buffered, _, violation) =
            rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Block).unwrap();
        assert!(violation.is_some(), "{buffered}");
        let per_frame: Vec<usize> = raw.match_indices("data: ").map(|(at, _)| at).collect();
        let (streamed, blocked) =
            run_streaming(&raw, &per_frame, FirewallPolicy::Block, &scanner).unwrap();
        assert!(blocked, "{streamed}");
        // Under Sanitize the value never goes out whole.
        for (streamed, _) in [
            run_streaming(&raw, &per_frame, FirewallPolicy::Sanitize, &scanner).unwrap(),
            (
                rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize)
                    .unwrap()
                    .0,
                false,
            ),
        ] {
            let sent = fields_by_choice(&streamed);
            assert!(
                !sent.values().any(|text| text.contains("555-123-4567")),
                "{streamed}"
            );
        }
    }
}

#[path = "round91_test.rs"]
mod round91_test;
