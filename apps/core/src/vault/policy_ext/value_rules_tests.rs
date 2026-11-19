//! `valueRules`: rule validation, each violation, and evaluation across the
//! policies matching a path.

use super::*;
use crate::vault::policy::validate as validate_policy;
use crate::vault::policy_ext::has_parameter_constraints;

fn rules(value: serde_json::Value) -> ValueRules {
    serde_json::from_value(value).unwrap()
}

fn writer(path: &str, value_rules: ValueRules) -> PolicyRule {
    PolicyRule {
        path: path.into(),
        capabilities: vec![Capability::Write],
        value_rules: Some(value_rules),
        ..PolicyRule::default()
    }
}

fn policy(name: &str, rules: Vec<PolicyRule>) -> Policy {
    Policy {
        name: name.into(),
        description: String::new(),
        rules,
    }
}

#[test]
fn the_wire_form_is_camel_case_and_rejects_unknown_fields() {
    let parsed = rules(serde_json::json!({
        "minLength": 12, "maxLength": 64, "require": ["upper", "digit"], "forbid": ["whitespace"],
    }));
    assert_eq!(parsed.min_length, Some(12));
    assert_eq!(parsed.require, vec![CharClass::Upper, CharClass::Digit]);
    assert_eq!(parsed.forbid, vec![CharClass::Whitespace]);
    assert!(serde_json::from_value::<ValueRules>(serde_json::json!({ "minLen": 3 })).is_err());
    assert!(
        serde_json::from_value::<ValueRules>(serde_json::json!({ "require": ["emoji"] })).is_err()
    );
}

#[test]
fn rules_are_checked_when_a_policy_is_written() {
    for (bad, why) in [
        (serde_json::json!({}), "no rule"),
        (serde_json::json!({ "maxLength": 0 }), "at least 1"),
        (
            serde_json::json!({ "minLength": 9, "maxLength": 8 }),
            "greater than",
        ),
        (
            serde_json::json!({ "maxLength": MAX_VALUE_RULE_LENGTH + 1 }),
            "at most",
        ),
        (
            serde_json::json!({ "require": ["digit"], "forbid": ["digit"] }),
            "both",
        ),
    ] {
        let error = rules(bad).validate().unwrap_err().to_string();
        assert!(error.contains(why), "{error}");
    }
    let ok = rules(serde_json::json!({ "minLength": 8, "require": ["symbol"] }));
    assert!(validate_policy(&policy("p", vec![writer("prod/**", ok.clone())])).is_ok());

    let mut deny = writer("prod/**", ok.clone());
    deny.deny = true;
    assert!(validate_policy(&policy("p", vec![deny])).is_err());
    let mut read_only = writer("prod/**", ok);
    read_only.capabilities = vec![Capability::Read];
    assert!(validate_policy(&policy("p", vec![read_only])).is_err());
}

#[test]
fn each_rule_reports_its_violation() {
    let strict = rules(serde_json::json!({
        "minLength": 8, "maxLength": 12, "require": ["lower", "upper", "digit", "symbol"],
        "forbid": ["whitespace", "control", "non_ascii"],
    }));
    assert_eq!(strict.violation("Ab1!efgh"), None);
    let cases = [
        ("Ab1!", "at least 8"),
        ("Ab1!efghijklm", "at most 12"),
        ("AB1!EFGH", "`lower`"),
        ("ab1!efgh", "`upper`"),
        ("Abc!efgh", "`digit`"),
        ("Ab1cefgh", "`symbol`"),
        ("Ab1! fgh", "forbids `whitespace`"),
        ("Ab1!\nfgh", "forbids `whitespace`"),
        ("Ab1!éfgh", "forbids `non_ascii`"),
    ];
    for (value, why) in cases {
        let message = strict.violation(value).unwrap_or_default();
        assert!(message.contains(why), "{value:?}: {message}");
    }
    // Length counts characters, not bytes.
    let short = rules(serde_json::json!({ "maxLength": 3 }));
    assert_eq!(short.violation("äöü"), None);
    assert!(short.violation("äöüß").is_some());
    let control = rules(serde_json::json!({ "forbid": ["control"] }));
    assert!(control.violation("a\u{7}b").is_some());
}

#[test]
fn every_matching_write_rule_applies_and_others_do_not() {
    let context = TemplateContext::default();
    let policies = [
        policy(
            "length",
            vec![writer(
                "prod/**",
                rules(serde_json::json!({ "minLength": 10 })),
            )],
        ),
        policy(
            "digits",
            vec![writer(
                "prod/db/*",
                rules(serde_json::json!({ "require": ["digit"] })),
            )],
        ),
    ];
    let check = |path: &str, value: &str| check_value_rules(policies.iter(), path, &context, value);
    assert!(check("prod/db/PASSWORD", "longenough1").is_ok());
    let error = check("prod/db/PASSWORD", "short1").unwrap_err();
    assert!(
        error.starts_with("policy `length` needs at least 10"),
        "{error}"
    );
    let error = check("prod/db/PASSWORD", "longenoughx").unwrap_err();
    assert!(error.starts_with("policy `digits` requires"), "{error}");
    // Only the length rule matches outside `prod/db`, and nothing outside `prod`.
    assert!(check("prod/api/TOKEN", "longenoughx").is_ok());
    assert!(check("dev/db/PASSWORD", "x").is_ok());
    assert!(has_parameter_constraints(
        policies.iter(),
        "prod/api/TOKEN",
        Capability::Write,
        &context
    ));
    assert!(!has_parameter_constraints(
        policies.iter(),
        "dev/api/TOKEN",
        Capability::Write,
        &context
    ));
}
