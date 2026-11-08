use serde_json::json;

use crate::*;

fn options() -> AssertionOptions {
    AssertionOptions::default()
}

#[test]
fn contains_emits_found_and_missing_codes_with_the_value() {
    let assertion = Assertion::Contains {
        value: "Hello".to_owned(),
        options: options(),
    };
    let found = eval_assertion_deterministic(&assertion, "well, hello there");
    assert_eq!(found.code.as_deref(), Some("contains.found"));
    assert_eq!(found.values["value"], json!("Hello"));
    // `detail` stays the English fallback.
    assert_eq!(found.detail, "found \"Hello\"");

    let missing = eval_assertion_deterministic(&assertion, "goodbye");
    assert_eq!(missing.code.as_deref(), Some("contains.missing"));
    assert_eq!(missing.values["value"], json!("Hello"));
}

#[test]
fn regex_emits_matched_no_match_and_invalid_codes() {
    let ok = Assertion::Regex {
        value: "^foo".to_owned(),
        options: options(),
    };
    let matched = eval_assertion_deterministic(&ok, "foobar");
    assert_eq!(matched.code.as_deref(), Some("regex.matched"));
    assert_eq!(matched.values["pattern"], json!("^foo"));
    let missed = eval_assertion_deterministic(&ok, "barfoo");
    assert_eq!(missed.code.as_deref(), Some("regex.no_match"));

    let bad = Assertion::Regex {
        value: "(".to_owned(),
        options: options(),
    };
    let invalid = eval_assertion_deterministic(&bad, "anything");
    assert_eq!(invalid.code.as_deref(), Some("regex.invalid"));
    assert_eq!(invalid.values["pattern"], json!("("));
    let error = invalid.values["error"].as_str().expect("error text");
    assert!(!error.is_empty());
    assert!(invalid.detail.contains(error));
}

#[test]
fn similarity_emits_rounded_score_and_threshold() {
    let assertion = Assertion::Levenshtein {
        value: "kitten".to_owned(),
        options: AssertionOptions {
            threshold: Some(0.5),
            ..options()
        },
    };
    let result = eval_assertion_deterministic(&assertion, "sitting");
    assert_eq!(result.code.as_deref(), Some("similarity.score"));
    assert_eq!(result.values["score"], json!(0.571));
    assert_eq!(result.values["threshold"], json!(0.5));
    assert!(result.detail.contains("similarity 0.571"));

    let long = "x".repeat(2_049);
    let too_long = eval_assertion_deterministic(&assertion, &long);
    assert_eq!(too_long.code.as_deref(), Some("similarity.too_long"));
    assert_eq!(too_long.values["limit"], json!(2_048));
    assert!(too_long.detail.contains("2048"));
}

#[test]
fn negation_keeps_the_raw_code_and_flags_it() {
    let assertion = Assertion::Contains {
        value: "error".to_owned(),
        options: AssertionOptions {
            not: Some(true),
            ..options()
        },
    };
    let result = eval_assertion_deterministic(&assertion, "all good");
    assert!(result.pass);
    assert_eq!(result.code.as_deref(), Some("contains.missing"));
    assert_eq!(result.values["negated"], json!(true));
}

#[test]
fn kinds_without_a_code_serialize_as_before() {
    let assertion = Assertion::IsRefusal { options: options() };
    let result = eval_assertion_deterministic(&assertion, "Sure, here it is.");
    assert!(result.code.is_none());
    let wire = serde_json::to_value(&result).expect("serializes");
    assert!(wire.get("code").is_none());
    assert!(wire.get("values").is_none());

    let coded =
        eval_assertion_deterministic(&Assertion::JsonValid { options: options() }, "{\"k\": 1}");
    let wire = serde_json::to_value(&coded).expect("serializes");
    assert_eq!(wire["code"], json!("json.valid"));
    assert!(wire.get("values").is_none());
}
