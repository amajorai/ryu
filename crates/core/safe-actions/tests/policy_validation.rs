//! `validate_policy` rule checks: tool patterns, resource patterns, and rule-set size.
//!
//! Core's safe-actions policy save path rejects a policy whenever these findings are
//! non-empty, so each malformed shape must produce its specific finding code and path.

use ryu_safe_actions::{
    validate_policy, EffectKind, FindingCode, FindingSeverity, Policy, PolicyLimits,
    VerificationFinding,
};
use std::collections::BTreeSet;

fn strings<'a>(items: impl IntoIterator<Item = &'a str>) -> BTreeSet<String> {
    items.into_iter().map(str::to_owned).collect()
}

fn valid_policy() -> Policy {
    Policy {
        allow_tools: strings(["files.read", "files.*", "mcp:server/tool-name_1"]),
        deny_tools: strings(["files.delete", "shell.*"]),
        allowed_effects: [EffectKind::Read, EffectKind::Write].into_iter().collect(),
        allowed_resources: strings(["space://alpha/*", "space://alpha/docs/readme.md", "a/*"]),
        review_tools: strings(["mail.send", "mail.*"]),
        review_effects: BTreeSet::new(),
        allow_parallel_reads: true,
        limits: PolicyLimits::default(),
    }
}

fn findings_for(code: FindingCode, findings: &[VerificationFinding]) -> Vec<&VerificationFinding> {
    findings
        .iter()
        .filter(|finding| finding.code == code)
        .collect()
}

/// Assert the policy yields exactly one finding, with the given code and path.
fn assert_single(policy: &Policy, code: FindingCode, path: &str, offending: &str) {
    let findings = validate_policy(policy);
    assert_eq!(
        findings.len(),
        1,
        "expected one {code:?} for `{offending}`, got {findings:?}"
    );
    let finding = &findings[0];
    assert_eq!(finding.code, code, "wrong code for `{offending}`");
    assert_eq!(finding.severity, FindingSeverity::Error);
    assert_eq!(finding.path, path, "wrong path for `{offending}`");
    assert!(
        finding.message.contains(offending),
        "message `{}` should name `{offending}`",
        finding.message
    );
}

const INVALID_TOOL_PATTERNS: &[&str] = &[
    "*",
    ".*",
    "files*",
    "fi*les.read",
    "files.*.read",
    "files.**",
    "*.read",
    "files.",
    ".files",
    "files..read",
    "files read",
    "files.read!",
    "bad name.*",
    ".hidden.*",
    "files..*",
    "a..b.*",
    "tool$.*",
    "",
];

const INVALID_RESOURCE_PATTERNS: &[&str] = &[
    "",
    "*",
    "/*",
    "space://alpha*",
    "space://*/docs",
    "space://alpha/**",
    "space://*/*",
    "space://alpha/../beta/*",
    "space://alpha/./docs",
    "space://alpha/%2e%2e/beta",
    "space://alpha/%2E%2E/beta",
    "space://alpha%2fbeta",
    "space://alpha%5cbeta",
    "space://alpha\\beta",
    "space://alpha/has space",
    "space://alpha/tab\there",
    "space://alpha/caf\u{e9}",
];

#[test]
fn valid_policy_has_no_findings() {
    assert_eq!(validate_policy(&valid_policy()), Vec::new());
    assert_eq!(validate_policy(&Policy::default()), Vec::new());
}

#[test]
fn invalid_tool_patterns_are_reported_for_each_rule_set() {
    for &pattern in INVALID_TOOL_PATTERNS {
        let mut allow = valid_policy();
        allow.allow_tools.insert(pattern.to_owned());
        assert_single(
            &allow,
            FindingCode::InvalidToolPattern,
            "$.policy.allow_tools",
            pattern,
        );

        let mut deny = valid_policy();
        deny.deny_tools.insert(pattern.to_owned());
        assert_single(
            &deny,
            FindingCode::InvalidToolPattern,
            "$.policy.deny_tools",
            pattern,
        );

        let mut review = valid_policy();
        review.review_tools.insert(pattern.to_owned());
        assert_single(
            &review,
            FindingCode::InvalidToolPattern,
            "$.policy.review_tools",
            pattern,
        );
    }
}

#[test]
fn every_invalid_tool_pattern_is_reported_individually() {
    let mut policy = valid_policy();
    policy
        .allow_tools
        .extend(["a*b", "x.*.y"].map(str::to_owned));
    let findings = validate_policy(&policy);
    let invalid = findings_for(FindingCode::InvalidToolPattern, &findings);
    assert_eq!(invalid.len(), 2, "{findings:?}");
    assert!(invalid.iter().any(|f| f.message.contains("`a*b`")));
    assert!(invalid.iter().any(|f| f.message.contains("`x.*.y`")));
}

#[test]
fn invalid_resource_patterns_are_reported() {
    for &pattern in INVALID_RESOURCE_PATTERNS {
        let mut policy = valid_policy();
        policy.allowed_resources.insert(pattern.to_owned());
        assert_single(
            &policy,
            FindingCode::InvalidResourcePattern,
            "$.policy.allowed_resources",
            pattern,
        );
    }
}

#[test]
fn overlong_resource_pattern_is_rejected_at_the_boundary() {
    let at_limit = format!("space://{}", "a".repeat(1024 - "space://".len()));
    let mut ok = valid_policy();
    ok.allowed_resources.insert(at_limit.clone());
    assert_eq!(validate_policy(&ok), Vec::new());

    let over = format!("{at_limit}b");
    let mut policy = valid_policy();
    policy.allowed_resources.insert(over.clone());
    assert_single(
        &policy,
        FindingCode::InvalidResourcePattern,
        "$.policy.allowed_resources",
        &over,
    );
}

fn tool_rules(count: usize) -> BTreeSet<String> {
    (0..count).map(|index| format!("tool.n{index}")).collect()
}

#[test]
fn rule_sets_over_256_entries_are_too_complex() {
    for field in [
        "allow_tools",
        "deny_tools",
        "review_tools",
        "allowed_resources",
    ] {
        let mut at_limit = Policy::default();
        let mut over = Policy::default();
        match field {
            "allow_tools" => {
                at_limit.allow_tools = tool_rules(256);
                over.allow_tools = tool_rules(257);
            }
            "deny_tools" => {
                at_limit.deny_tools = tool_rules(256);
                over.deny_tools = tool_rules(257);
            }
            "review_tools" => {
                at_limit.review_tools = tool_rules(256);
                over.review_tools = tool_rules(257);
            }
            _ => {
                at_limit.allowed_resources = (0..256)
                    .map(|index| format!("space://r{index}/*"))
                    .collect();
                over.allowed_resources = (0..257)
                    .map(|index| format!("space://r{index}/*"))
                    .collect();
            }
        }
        assert_eq!(
            validate_policy(&at_limit),
            Vec::new(),
            "256 entries in `{field}` must be accepted"
        );
        let findings = validate_policy(&over);
        let complex = findings_for(FindingCode::PolicyTooComplex, &findings);
        assert_eq!(complex.len(), 1, "`{field}` over limit: {findings:?}");
        assert_eq!(complex[0].path, format!("$.policy.{field}"));
        assert!(complex[0].message.contains("257"));
        assert_eq!(findings.len(), 1, "only the size finding: {findings:?}");
    }
}

#[test]
fn findings_accumulate_across_rule_kinds() {
    let mut policy = valid_policy();
    policy.limits.max_depth = 0;
    policy.deny_tools.insert("bad*".to_owned());
    policy.allowed_resources.insert("../*".to_owned());
    policy.review_tools = tool_rules(300);
    let codes: BTreeSet<FindingCode> = validate_policy(&policy)
        .into_iter()
        .map(|finding| finding.code)
        .collect();
    let expected = BTreeSet::from([
        FindingCode::InvalidPolicyLimits,
        FindingCode::InvalidToolPattern,
        FindingCode::InvalidResourcePattern,
        FindingCode::PolicyTooComplex,
    ]);
    assert_eq!(codes, expected);
}
