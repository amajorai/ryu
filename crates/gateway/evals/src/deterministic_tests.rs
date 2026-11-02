use serde_json::json;

use crate::*;

// ── Deterministic assertion evaluation ───────────────────────────────────

#[test]
fn assertion_contains_case_insensitive() {
    let a = Assertion::Contains {
        value: "Hello".to_string(),
        options: AssertionOptions::default(),
    };
    let r = eval_assertion_deterministic(&a, "well, hello there");
    assert!(r.pass);
    assert_eq!(r.kind, "contains");
    assert!((r.score - 1.0).abs() < 1e-6);
}

#[test]
fn assertion_not_contains() {
    let a = Assertion::NotContains {
        value: "error".to_string(),
        options: AssertionOptions::default(),
    };
    assert!(eval_assertion_deterministic(&a, "all good").pass);
    assert!(!eval_assertion_deterministic(&a, "an error occurred").pass);
}

#[test]
fn assertion_equals_trims_and_is_case_sensitive() {
    let a = Assertion::Equals {
        value: "42".to_string(),
        options: AssertionOptions::default(),
    };
    assert!(eval_assertion_deterministic(&a, "  42 ").pass);
    assert!(!eval_assertion_deterministic(&a, "forty-two").pass);
}

#[test]
fn assertion_regex_valid_and_invalid() {
    let ok = Assertion::Regex {
        value: "^foo".to_string(),
        options: AssertionOptions::default(),
    };
    assert!(eval_assertion_deterministic(&ok, "foobar").pass);
    assert!(!eval_assertion_deterministic(&ok, "barfoo").pass);

    let bad = Assertion::Regex {
        value: "(".to_string(),
        options: AssertionOptions::default(),
    };
    let r = eval_assertion_deterministic(&bad, "anything");
    assert!(!r.pass);
    assert!(r.detail.contains("invalid regex"));
}

#[test]
fn assertion_json_valid() {
    let a = Assertion::JsonValid {
        options: AssertionOptions::default(),
    };
    assert!(eval_assertion_deterministic(&a, "{\"k\": 1}").pass);
    assert!(!eval_assertion_deterministic(&a, "not json").pass);
}

#[test]
fn promptfoo_common_deterministic_assertions() {
    assert!(
        eval_assertion_deterministic(
            &Assertion::Icontains {
                value: "hello".into(),
                options: AssertionOptions::default(),
            },
            "Hello there"
        )
        .pass
    );
    assert!(
        eval_assertion_deterministic(
            &Assertion::StartsWith {
                value: "Hello".into(),
                options: AssertionOptions::default(),
            },
            "  Hello there"
        )
        .pass
    );
    assert!(
        eval_assertion_deterministic(
            &Assertion::ContainsAny {
                value: "Paris,London".into(),
                options: AssertionOptions::default(),
            },
            "The answer is London"
        )
        .pass
    );
    assert!(
        !eval_assertion_deterministic(
            &Assertion::ContainsAll {
                value: "Paris,France".into(),
                options: AssertionOptions::default(),
            },
            "The answer is Paris"
        )
        .pass
    );
    assert!(
        eval_assertion_deterministic(
            &Assertion::IcontainsAll {
                value: "paris,france".into(),
                options: AssertionOptions::default(),
            },
            "Paris is in France"
        )
        .pass
    );
    assert!(
        eval_assertion_deterministic(
            &Assertion::ContainsJson {
                value: "{\"ok\":true}".into(),
                options: AssertionOptions::default(),
            },
            "Result: {\"ok\":true}"
        )
        .pass
    );
}

#[test]
fn promptfoo_assertion_options_round_trip_and_format_checks() {
    let parsed: Assertion = serde_json::from_value(json!({
        "kind": "contains",
        "value": "safe",
        "threshold": 0.8,
        "weight": 2.0,
        "metric": "quality"
    }))
    .unwrap();
    match &parsed {
        Assertion::Contains { options, .. } => {
            assert_eq!(options.threshold, Some(0.8));
            assert_eq!(options.weight, Some(2.0));
            assert_eq!(options.metric.as_deref(), Some("quality"));
        }
        _ => panic!("expected contains assertion"),
    }
    let wire = serde_json::to_value(&parsed).unwrap();
    assert!((wire["threshold"].as_f64().unwrap() - 0.8).abs() < 1e-6);
    assert!(
        eval_assertion_deterministic(
            &Assertion::IsHtml {
                options: AssertionOptions::default()
            },
            "<p>ok</p>"
        )
        .pass
    );
    assert!(
        eval_assertion_deterministic(
            &Assertion::IsSql {
                options: AssertionOptions::default()
            },
            "SELECT 1"
        )
        .pass
    );
}

#[test]
fn extended_promptfoo_assertions_use_safe_metrics_and_nested_sets() {
    let metrics = AssertionMetrics {
        latency_ms: Some(120),
        cost_micro_usd: Some(2500),
    };
    let html = Assertion::ContainsHtml {
        value: "<p>hello</p>".to_owned(),
        options: AssertionOptions::default(),
    };
    assert!(
        eval_assertion_deterministic_with_metrics(&html, "<main><p>hello</p></main>", metrics).pass
    );
    let similarity = Assertion::Levenshtein {
        value: "hello".to_owned(),
        options: AssertionOptions {
            threshold: Some(0.8),
            ..Default::default()
        },
    };
    assert!(eval_assertion_deterministic(&similarity, "hello").pass);
    let latency = Assertion::Latency {
        value: "200".to_owned(),
        options: AssertionOptions::default(),
    };
    assert!(eval_assertion_deterministic_with_metrics(&latency, "ignored", metrics).pass);
    let cost = Assertion::Cost {
        value: "0.003".to_owned(),
        options: AssertionOptions::default(),
    };
    assert!(eval_assertion_deterministic_with_metrics(&cost, "ignored", metrics).pass);
    let nested = Assertion::AssertSet {
        assertions: vec![
            Assertion::Contains {
                value: "hello".to_owned(),
                options: AssertionOptions::default(),
            },
            Assertion::NotContains {
                value: "goodbye".to_owned(),
                options: AssertionOptions::default(),
            },
        ],
        options: AssertionOptions::default(),
    };
    assert!(eval_assertion_deterministic(&nested, "hello").pass);
    let negated = Assertion::Contains {
        value: "hello".to_owned(),
        options: AssertionOptions {
            not: Some(true),
            ..Default::default()
        },
    };
    let negated_result = eval_assertion_deterministic(&negated, "hello");
    assert!(!negated_result.pass);
    assert_eq!(negated_result.score, 0.0);
    assert!(negated_result.executed);
    let missing_latency = Assertion::Latency {
        value: "200".to_owned(),
        options: AssertionOptions::default(),
    };
    let missing_latency_result = eval_assertion_deterministic(&missing_latency, "ignored");
    assert!(!missing_latency_result.executed);
}

#[test]
fn oversized_levenshtein_inputs_are_skipped_before_quadratic_work() {
    let assertion = Assertion::Levenshtein {
        value: "x".repeat(2_049),
        options: AssertionOptions::default(),
    };
    let result = eval_assertion_deterministic(&assertion, "x");
    assert!(!result.executed);
    assert!(result.detail.contains("limited to 2048"));
}
