use super::super::{evaluate, evaluate_with, validate, Policy};
use super::*;
use crate::vault::policy_ext::TemplateContext;

fn caps(list: &[Capability]) -> CapabilitySet {
    list.iter().copied().collect()
}

fn wrapped_rule(path: &str, min: Option<i64>, max: Option<i64>) -> PolicyRule {
    PolicyRule {
        path: path.into(),
        capabilities: vec![Capability::Read],
        min_wrapping_ttl_secs: min,
        max_wrapping_ttl_secs: max,
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
fn bounds_accept_only_wrap_ttls_inside_them() {
    let both = Bounds {
        min_secs: Some(60),
        max_secs: Some(600),
    };
    assert!(!both.satisfied_by(None));
    assert!(!both.satisfied_by(Some(59)));
    assert!(both.satisfied_by(Some(60)));
    assert!(both.satisfied_by(Some(600)));
    assert!(!both.satisfied_by(Some(601)));
    // A maximum alone caps a wrapped request but does not require wrapping.
    let max_only = Bounds {
        min_secs: None,
        max_secs: Some(600),
    };
    assert!(max_only.satisfied_by(None));
    assert!(!max_only.satisfied_by(Some(3600)));
}

#[test]
fn rules_parse_seconds_durations_and_vault_names() {
    let rule: PolicyRule = serde_json::from_value(serde_json::json!({
        "path": "prod/**",
        "capabilities": ["read"],
        "minWrappingTtlSecs": 60,
        "maxWrappingTtlSecs": "1h",
    }))
    .unwrap();
    assert_eq!(rule.min_wrapping_ttl_secs, Some(60));
    assert_eq!(rule.max_wrapping_ttl_secs, Some(3600));
    let vault_style: PolicyRule = serde_json::from_value(serde_json::json!({
        "path": "prod/**",
        "capabilities": ["read"],
        "min_wrapping_ttl": "5m",
    }))
    .unwrap();
    assert_eq!(vault_style.min_wrapping_ttl_secs, Some(300));
    assert!(serde_json::from_value::<PolicyRule>(serde_json::json!({
        "path": "prod/**",
        "capabilities": ["read"],
        "minWrappingTtl": "soon",
    }))
    .is_err());
    // Unset bounds stay off the wire.
    let plain = serde_json::to_value(wrapped_rule("prod/**", None, None)).unwrap();
    assert!(plain.get("minWrappingTtlSecs").is_none());
    let set = serde_json::to_value(&rule).unwrap();
    assert_eq!(set["minWrappingTtlSecs"], 60);
}

#[test]
fn invalid_wrapping_bounds_are_rejected() {
    let check = |rule: PolicyRule| validate(&policy("p", vec![rule]));
    assert!(check(wrapped_rule("prod/**", Some(60), Some(600))).is_ok());
    assert!(check(wrapped_rule("prod/**", Some(0), None)).is_err());
    assert!(check(wrapped_rule("prod/**", None, Some(2 * 24 * 3600))).is_err());
    assert!(check(wrapped_rule("prod/**", Some(600), Some(60))).is_err());
    let mut deny = wrapped_rule("prod/**", Some(60), None);
    deny.deny = true;
    assert!(check(deny).is_err());
}

#[tokio::test]
async fn outside_a_request_wrapping_is_not_enforced() {
    let policies = [policy("w", vec![wrapped_rule("prod/**", Some(60), None)])];
    assert_eq!(
        evaluate(&CapabilitySet::new(), &policies, "prod/KEY"),
        caps(&[Capability::Read])
    );
}

#[tokio::test]
async fn an_unwrapped_request_loses_the_capability_and_records_why() {
    let policies = [policy(
        "w",
        vec![
            wrapped_rule("prod/**", Some(60), None),
            PolicyRule {
                path: "prod/**".into(),
                capabilities: vec![Capability::List],
                ..PolicyRule::default()
            },
        ],
    )];
    // The baseline grant of `read` does not bypass the requirement.
    let baseline = caps(&[Capability::Read]);
    let (got, violations) = scope(None, async {
        evaluate_with(
            &baseline,
            &policies,
            "prod/KEY",
            &TemplateContext::default(),
        )
    })
    .await;
    assert_eq!(got, caps(&[Capability::List]));
    assert_eq!(violations.len(), 1);
    assert_eq!(violations[0].path, "prod/KEY");
    assert_eq!(violations[0].capability, Capability::Read);
    assert!(violations[0].message().contains("at least 60s"));
    // Other paths are untouched.
    let (got, violations) = scope(None, async {
        evaluate(&CapabilitySet::new(), &policies, "staging/KEY")
    })
    .await;
    assert!(got.is_empty());
    assert!(violations.is_empty());
}

#[tokio::test]
async fn a_wrapped_request_within_bounds_keeps_the_capability() {
    let policies = [policy(
        "w",
        vec![wrapped_rule("prod/**", Some(60), Some(600))],
    )];
    let read_caps = || evaluate(&CapabilitySet::new(), &policies, "prod/KEY");
    let (got, violations) = scope(Some(300), async { read_caps() }).await;
    assert_eq!(got, caps(&[Capability::Read]));
    assert!(violations.is_empty());
    let (got, violations) = scope(Some(3600), async { read_caps() }).await;
    assert!(got.is_empty());
    assert!(violations[0].message().contains("between 60s and 600s"));
}

#[tokio::test]
async fn the_strictest_bounds_win_across_rules() {
    let policies = [
        policy("a", vec![wrapped_rule("prod/**", Some(60), Some(3600))]),
        policy("b", vec![wrapped_rule("prod/db/*", Some(300), Some(600))]),
        // An allow without bounds does not relax the others.
        policy("c", vec![wrapped_rule("**", None, None)]),
    ];
    let read_caps = || evaluate(&CapabilitySet::new(), &policies, "prod/db/KEY");
    assert!(scope(Some(120), async { read_caps() }).await.0.is_empty());
    assert!(scope(Some(1200), async { read_caps() }).await.0.is_empty());
    let (got, _) = scope(Some(300), async { read_caps() }).await;
    assert_eq!(got, caps(&[Capability::Read]));
    // Conflicting rules leave no wrap TTL that satisfies both.
    let conflicting = [
        policy("a", vec![wrapped_rule("prod/**", Some(600), None)]),
        policy("b", vec![wrapped_rule("prod/**", None, Some(60))]),
    ];
    for ttl in [None, Some(60), Some(600)] {
        let (got, violations) = scope(ttl, async {
            evaluate(&CapabilitySet::new(), &conflicting, "prod/KEY")
        })
        .await;
        assert!(got.is_empty(), "{ttl:?}");
        assert!(violations[0].message().contains("conflict"), "{ttl:?}");
    }
}

#[tokio::test]
async fn a_suspended_check_ignores_the_callers_wrap_ttl() {
    let policies = [policy("w", vec![wrapped_rule("prod/**", Some(60), None)])];
    let read_caps = || evaluate(&CapabilitySet::new(), &policies, "prod/KEY");
    let (got, violations) = scope(None, async {
        let other = suspended(read_caps);
        // Enforcement resumes once the suspended check returns.
        (other, read_caps())
    })
    .await;
    assert_eq!(got.0, caps(&[Capability::Read]));
    assert!(got.1.is_empty());
    assert_eq!(violations.len(), 1, "only the caller's own check records");
    // Nested suspensions restore enforcement only after the outermost one.
    let (nested, violations) = scope(None, async {
        suspended(|| {
            suspended(read_caps)
                .union(&read_caps())
                .copied()
                .collect::<CapabilitySet>()
        })
    })
    .await;
    assert_eq!(nested, caps(&[Capability::Read]));
    assert!(violations.is_empty());
}
