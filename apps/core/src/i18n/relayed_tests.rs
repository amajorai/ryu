//! Unit tests for relayed text ([`super::render`]) and its template matcher.

use serde_json::json;

use super::*;
use crate::i18n::{AlertText, Message};

fn relayed_wire(text: &str) -> serde_json::Value {
    json!({ "message": "{text}", "args": { "text": text }, "relay": true })
}

#[test]
fn a_relayed_catalogued_sentence_renders_in_the_reader_language() {
    let message = Message::from_wire(&relayed_wire("dataset has no samples")).unwrap();
    assert_eq!(message.render("ja"), "データセットにサンプルがありません");
    assert_eq!(message.render("de-AT"), "Datensatz enthält keine Beispiele");
    assert_eq!(message.render("en"), "dataset has no samples");
    // The relay flag survives the wire round-trip.
    assert_eq!(Message::from_wire(&message.to_wire()).unwrap(), message);
}

#[test]
fn a_relayed_template_keeps_its_dynamic_part_verbatim() {
    let message =
        Message::from_wire(&relayed_wire("dataset path not found: /tmp/rows.jsonl")).unwrap();
    assert_eq!(
        message.render("ja"),
        "データセットのパスが見つかりません: /tmp/rows.jsonl"
    );
    assert_eq!(
        message.render("ar"),
        "لم يتم العثور على مسار مجموعة البيانات: \u{2068}/tmp/rows.jsonl\u{2069}"
    );
    assert_eq!(
        message.render("de"),
        "Datensatzpfad nicht gefunden: /tmp/rows.jsonl"
    );
    assert_eq!(
        message.render("en"),
        "dataset path not found: /tmp/rows.jsonl"
    );
}

#[test]
fn a_relayed_finetune_failure_push_is_localized_end_to_end() {
    // The exact `i18n` object `ryu-finetune`'s `job_failed` hint sends.
    let alert = AlertText::from_wire(&json!({
        "title": {
            "message": "Fine-tune “{name}” failed",
            "args": { "name": "support-bot" },
        },
        "body": [relayed_wire("dataset has no samples")],
    }))
    .unwrap();
    let (_, body) = alert.render("ar");
    assert_eq!(body, "لا تحتوي مجموعة البيانات على عينات");
    let (_, body) = alert.render("en");
    assert_eq!(body, "dataset has no samples");
}

#[test]
fn unknown_relayed_text_and_verbatim_text_are_shown_as_is() {
    let unknown = Message::from_wire(&relayed_wire("CUDA out of memory")).unwrap();
    assert_eq!(unknown.render("ja"), "CUDA out of memory");
    // Without the relay flag (an older satellite, or a person's own words) the
    // text is never swapped for a catalog sentence.
    let verbatim = Message::from_wire(&json!({
        "message": "{text}",
        "args": { "text": "dataset has no samples" },
    }))
    .unwrap();
    assert_eq!(verbatim.render("ja"), "dataset has no samples");
}

#[test]
fn a_relayed_body_renders_in_a_push() {
    let alert = AlertText::from_wire(&json!({
        "title": { "message": "Fine-tune job failed", "args": {} },
        "body": [relayed_wire("Training failed.")],
        "join": "sentences",
    }))
    .unwrap();
    let (_, body) = alert.render("en");
    assert_eq!(body, "Training failed.");
    let (_, body) = alert.render("de");
    assert_ne!(body, "Training failed.");
    assert!(!body.is_empty());
}

#[test]
fn segments_split_literals_and_placeholders() {
    assert_eq!(
        segments("Now '{x}' at {price}, it''s {when}").unwrap(),
        vec![
            Segment::Literal("Now {x} at ".to_owned()),
            Segment::Placeholder("price".to_owned()),
            Segment::Literal(", it's ".to_owned()),
            Segment::Placeholder("when".to_owned()),
        ]
    );
    assert!(segments("{a}{b}").is_none());
    assert!(segments("{n, plural, one {#} other {#}}").is_none());
    assert!(segments("unbalanced }").is_none());
}

#[test]
fn capture_backtracks_to_the_match_that_spells_the_text() {
    let template = segments("Failed: {error} (code {code})").unwrap();
    assert_eq!(
        capture(&template, "Failed: a (b) c (code 7)").unwrap(),
        vec![("error", "a (b) c"), ("code", "7")]
    );
    assert!(capture(&template, "Failed:  (code 7)").is_none());
    assert!(capture(&template, "Failed: x (code )").is_none());
    assert!(capture(&template, "Other: x (code 7)").is_none());
}

#[test]
fn a_template_needs_enough_literal_text_to_match() {
    assert!(literal_letters(&segments("{name}: {detail}").unwrap()) < MIN_TEMPLATE_LETTERS);
    assert!(
        literal_letters(&segments("dataset path not found: {path}").unwrap())
            >= MIN_TEMPLATE_LETTERS
    );
    // Braces in relayed text are never read as placeholders.
    assert_eq!(render("dataset has no samples {x}", "ja"), None);
}
