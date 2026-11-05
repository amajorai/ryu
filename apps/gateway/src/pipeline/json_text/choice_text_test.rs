//! Per-choice scan text: one lane per choice, the primary lane unchanged.

use serde_json::{json, Value};

use super::super::{sse_scan_text, FIELD_SEPARATOR};
use super::{choice_scan_texts, primary_scan_text, primary_text_key, ChoiceTexts};

fn content(index: Value, text: &str) -> Value {
    json!({"id": "c", "choices": [{"index": index, "delta": {"content": text}}]})
}

fn field(index: u64, key: &str, text: &str) -> Value {
    json!({"choices": [{"index": index, "delta": {key: text}}]})
}

/// Frames whose entries are all choice 0 (or that carry no `choices`).
fn single_choice_frames() -> Vec<Vec<Value>> {
    vec![
        vec![
            field(0, "reasoning_content", "think "),
            field(0, "reasoning_content", "more"),
            field(0, "content", "answer "),
            field(0, "content", "done"),
        ],
        vec![
            json!({"choices": [{"delta": {"content": "no index "}}]}),
            json!({"choices": [{"index": null, "delta": {"content": "null"}}]}),
        ],
        vec![
            json!({"usage": {"total_tokens": 3}, "note": "text"}),
            json!({"choices": []}),
            json!({"choices": {"0": {"delta": {"content": "object"}}}}),
            json!({"choices": null}),
            json!("a bare string"),
        ],
        vec![
            json!([
                field(0, "content", "in an "),
                field(0, "reasoning", "array")
            ]),
            field(0, "content", " after"),
        ],
        vec![
            content(json!(0.0), "float "),
            content(json!("0"), "string "),
            content(json!(0), "integer"),
        ],
        vec![
            json!({"choices": [{"index": 0, "message": {"content": "whole"}}]}),
            json!({"choices": [
                {"index": 0, "delta": {"content": "two "}},
                {"index": 0, "delta": {"reasoning_content": "repeats"}}
            ]}),
        ],
    ]
}

#[test]
fn single_choice_payloads_keep_the_scan_text_they_had() {
    for frames in single_choice_frames() {
        let texts = choice_scan_texts(&frames);
        let expected = sse_scan_text(&frames).0;
        assert_eq!(texts.len(), 1, "{frames:?}");
        assert_eq!(texts.get("0"), Some(&expected), "{frames:?}");
        let mut alone = String::new();
        for frame in &frames {
            primary_scan_text(frame, &mut alone);
        }
        let mut choices = ChoiceTexts::default();
        let mut pushed = String::new();
        for frame in &frames {
            choices.push_frame(frame, &mut pushed);
        }
        assert!(choices.is_empty());
        assert_eq!(choices.bytes(), 0);
        assert_eq!(alone, pushed);
    }
}

#[test]
fn the_primary_text_key_is_the_first_choice_zero_entry() {
    let frame = json!({"choices": [
        {"index": 1, "delta": {"reasoning_content": "other"}},
        {"index": 0, "delta": {"content": "mine"}}
    ]});
    assert_eq!(primary_text_key(&frame), Some("content"));
    let odd = json!({"choices": [{"index": "a", "delta": {"content": "x"}}]});
    assert_eq!(primary_text_key(&odd), None);
    let array = json!([field(0, "content", "x")]);
    assert_eq!(primary_text_key(&array), None);
    let object = json!({"choices": {"0": {"delta": {"content": "x"}}}});
    assert_eq!(primary_text_key(&object), None);
}

#[test]
fn each_choice_is_its_own_lane() {
    let frames = vec![
        content(json!(0), "key: sk-"),
        content(json!(1), "ABCDEFGHIJKLMNOPQRSTUVWX"),
        content(json!(0), " ok"),
        content(json!("1"), " more"),
        content(json!("a"), "odd"),
        content(json!(0.0), " float"),
        json!({"choices": [
            {"delta": {"content": " pos0"}},
            {"delta": {"content": " pos1"}}
        ]}),
    ];
    let texts = choice_scan_texts(&frames);
    assert_eq!(texts["0"], "key: sk- ok float pos0");
    assert_eq!(texts["1"], "ABCDEFGHIJKLMNOPQRSTUVWX more pos1");
    assert_eq!(texts["~\"a\""], "odd");
    assert_eq!(texts.len(), 3);
    assert_eq!(texts.keys().next().map(String::as_str), Some("0"));
}

#[test]
fn a_field_switch_separates_only_its_own_choice() {
    let frames = vec![
        content(json!(0), "card 4111 1111"),
        field(1, "reasoning_content", "x"),
        content(json!(0), " 1111 1111"),
        field(1, "content", "y"),
        json!([field(1, "reasoning_content", "z")]),
    ];
    let texts = choice_scan_texts(&frames);
    assert_eq!(texts["0"], "card 4111 1111 1111 1111");
    // An array frame neither separates nor changes the lane's field.
    assert_eq!(texts["1"], format!("x{FIELD_SEPARATOR}yz"));
    // A lane is created on first sight, even without text.
    let empty = choice_scan_texts(&[json!({"choices": [
        {"index": 0, "delta": {"content": "a"}},
        {"index": 2, "delta": {}}
    ]})]);
    assert_eq!(empty.get("2").map(String::as_str), Some(""));
}

#[test]
fn bytes_count_every_other_choice_text() {
    let mut choices = ChoiceTexts::default();
    let mut primary = String::new();
    choices.push_frame(&field(1, "reasoning_content", "abc"), &mut primary);
    choices.push_frame(&field(1, "content", "de"), &mut primary);
    choices.push_frame(&field(2, "content", "f"), &mut primary);
    assert!(primary.is_empty());
    assert_eq!(choices.bytes(), 3 + FIELD_SEPARATOR.len() + 2 + 1);
    let first = format!("abc{FIELD_SEPARATOR}de");
    let texts: Vec<_> = choices.texts().collect();
    assert_eq!(texts, [("1", first.as_str()), ("2", "f")]);
}

#[test]
fn a_boundary_delta_is_reasoning_then_a_separator_then_the_answer() {
    let boundary = |index: u64| {
        json!({"choices": [{"index": index, "delta": {
            "content": "Ext 555-", "reasoning_content": "123-4567.",
            "reasoning": "123-4567."
        }}]})
    };
    for index in [0, 1] {
        let frames = vec![
            field(index, "reasoning_content", "Note"),
            boundary(index),
            field(index, "content", "0199."),
            field(index, "reasoning_content", " again"),
        ];
        let texts = choice_scan_texts(&frames);
        let lane = texts[&index.to_string()].clone();
        // vLLM's mirrored `reasoning` counts once; the answer goes on into
        // the next content frame, and a later reasoning frame is separated.
        assert_eq!(
            lane,
            format!("Note123-4567.{FIELD_SEPARATOR}Ext 555-0199.{FIELD_SEPARATOR} again")
        );
    }
    assert_eq!(primary_text_key(&boundary(0)), Some("reasoning_content"));
    assert_eq!(
        super::primary_text_keys(&boundary(0)),
        Some(("reasoning_content", "content"))
    );
    // An answer alone, or reasoning alone, is no boundary.
    let mut alone = String::new();
    primary_scan_text(
        &json!({"choices": [{"delta": {"content": "a", "reasoning_content": ""}}]}),
        &mut alone,
    );
    assert_eq!(alone, "a");
}

#[test]
fn a_frame_with_many_choice_entries_is_walked_in_linear_time() {
    let entries: Vec<Value> = (1..=50_000)
        .map(|index| json!({"index": index, "delta": {"content": "x"}}))
        .collect();
    let frame = json!({"choices": entries});
    let started = std::time::Instant::now();
    let texts = choice_scan_texts(std::slice::from_ref(&frame));
    let mut choices = ChoiceTexts::default();
    let mut primary = String::new();
    choices.push_frame(&frame, &mut primary);
    let elapsed = started.elapsed();
    assert_eq!(texts.len(), 50_001);
    assert_eq!(choices.bytes(), 50_000);
    assert!(
        elapsed < std::time::Duration::from_secs(1),
        "walked in {elapsed:?}"
    );
}
