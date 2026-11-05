//! The scanner's precomputed state: the curated `RegexSet` prefilters of
//! `scan_outbound` and the redaction placeholders `sanitize` splices in.

use super::*;
use crate::config::{CustomPattern, CustomPatternKind, FirewallConfig, FirewallPolicy};
use ryu_gw_firewall::{is_credit_card_number, is_public_ipv4};

fn default_scanner() -> FirewallScanner {
    FirewallScanner::new(FirewallConfig::default())
}

fn scanner_with(redact_pii: bool, redact_secrets: bool) -> FirewallScanner {
    FirewallScanner::new(FirewallConfig {
        policy: FirewallPolicy::Sanitize,
        redact_pii,
        redact_secrets,
        ..FirewallConfig::default()
    })
}

/// Texts for the `scan_outbound` set and hoist parity checks: a positive for
/// each curated PII and secret kind, validator rejects, near-misses, stream
/// DLP style frames, and non-ASCII text that folds or keeps a boundary.
const SCAN_CORPUS: &[&str] = &[
    "",
    "Hello! Here is the summary you asked for.",
    "mail user@example.com now",
    "call (555) 123-4567 or 555.123.4567",
    "ssn 123-45-6789 and 123 45 6789",
    "card 4111 1111 1111 1111",
    "card 4111-1111-1111-1112 fails Luhn",
    "dns 8.8.8.8",
    "private 192.168.1.1 and mask 255.255.255.0",
    "Passport No. X12345678",
    "order AB1234567",
    "GB29 NWBK 6016 1331 9268 19",
    "sk-abcdefghijklmnopqrstuvwxyz",
    "sk-ant-api03-abcdefghijklmnopqrstuv",
    concat!("AKIA", "ABCDEFGHIJKLMNOP"),
    concat!(
        "aws_secret = 'abcdefghijABCDEFGHIJ",
        "0123456789abcdefghij'"
    ),
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFG0123456789_abcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghij",
    "Bearer abcdefghijklmnopqrstuvwxyzabcdefghijklmnop",
    "-----BEGIN RSA PRIVATE KEY-----",
    "api_key: 'ABCDEFGH12345678abcdefgh'",
    "postgres://admin:pw@db",
    "sk-short ghp_short AKIA123 user@ example.com 1234567890",
    "{\"choices\":[{\"delta\":{\"content\":\"The key is sk-\"}}]}",
    "data: {\"choices\":[{\"delta\":{\"content\":\"abcdefghijklmnopqrstu\"}}]}",
    "\u{201C}quoted\u{201D} \u{2014} sk-abcdefghijklmnopqrstuvwxyz",
    "\u{FF53}\u{FF4B}-abcdefghijklmnopqrstuvwxyz",
    "s\u{200B}k-abcdefghijklmnopqrstuvwxyz",
    "\u{0430}123-45-6789 and \u{0410}KIAABCDEFGHIJKLMNOP",
    "\u{201C}plain prose\u{201D} with no secrets \u{2014} caf\u{E9}",
    "\u{5BC6}\u{94A5}sk-abcdefghijklmnopqrstuvwxyz",
];

fn outbound_result(scanner: &FirewallScanner, text: &str) -> String {
    format!("{:?}", scanner.scan_outbound(text))
}

#[test]
fn scan_sets_never_hide_a_match() {
    let on = default_scanner();
    let mut off = default_scanner();
    assert!(on.scan_set.is_some() && on.secret_set.is_some());
    off.scan_set = None;
    off.secret_set = None;
    let mut texts: Vec<String> = SCAN_CORPUS.iter().map(|t| (*t).to_owned()).collect();
    for (left, right) in SCAN_CORPUS.iter().zip(SCAN_CORPUS.iter().rev()) {
        texts.push(format!("{left}\n{right}"));
    }
    let mut found = 0;
    for text in &texts {
        let result = outbound_result(&on, text);
        assert_eq!(result, outbound_result(&off, text), "on {text:?}");
        // The un-hoisted scan: each list normalizes the text on its own.
        let fresh = off
            .find_match(text, &off.secret_patterns, DetectionKind::Secret)
            .or_else(|| off.find_match(text, &off.pii_patterns, DetectionKind::Pii));
        assert_eq!(result, format!("{fresh:?}"), "fresh on {text:?}");
        found += usize::from(fresh.is_some());
    }
    assert!(found > texts.len() / 2, "only {found} matches");
}

#[test]
fn scan_sets_are_off_with_custom_patterns() {
    let custom = |kind| {
        FirewallScanner::new_scoped(FirewallConfig {
            custom_patterns: vec![CustomPattern {
                name: "employee_id".into(),
                regex: r"\bEMP-\d{6}\b".into(),
                kind,
            }],
            ..FirewallConfig::default()
        })
    };
    let pii = custom(CustomPatternKind::Pii);
    assert!(pii.scan_set.is_none() && pii.secret_set.is_some());
    let secret = custom(CustomPatternKind::Secret);
    assert!(secret.scan_set.is_none() && secret.secret_set.is_none());
    assert!(pii.scan_outbound("id EMP-123456").is_some());
    assert!(secret.scan_outbound("id EMP-123456").is_some());
}

// ── Precomputed placeholders and the validating splice ────────────────────

/// `sanitize` before placeholders were precomputed (per-pattern `format!`,
/// closure `replace_all`, a copy per pattern); the live code must agree.
fn reference_sanitize(scanner: &FirewallScanner, text: &str) -> String {
    let mut result = text.to_string();
    let validated = |re: &regex::Regex, text: &str, mark: &str, valid: fn(&str) -> bool| {
        re.replace_all(text, |caps: &regex::Captures| {
            if valid(&caps[0]) {
                mark.to_string()
            } else {
                caps[0].to_string()
            }
        })
        .to_string()
    };
    if scanner.config.redact_pii {
        for (name, re) in &scanner.pii_patterns {
            let mark = format!("[REDACTED:{}]", name.to_uppercase());
            result = match name.as_str() {
                "credit_card" => validated(re, &result, &mark, is_credit_card_number),
                "ipv4" => validated(re, &result, &mark, is_public_ipv4),
                _ => re.replace_all(&result, mark.as_str()).to_string(),
            };
        }
    }
    if scanner.config.redact_secrets {
        for (name, re) in &scanner.secret_patterns {
            let mark = format!("[REDACTED:{}]", name.to_uppercase());
            result = re.replace_all(&result, mark.as_str()).to_string();
        }
    }
    result
}

fn scanner_with_custom(redact_pii: bool, redact_secrets: bool) -> FirewallScanner {
    let custom = |name: &str, regex: &str, kind| CustomPattern {
        name: name.to_string(),
        regex: regex.to_string(),
        kind,
    };
    FirewallScanner::new(FirewallConfig {
        policy: FirewallPolicy::Sanitize,
        redact_pii,
        redact_secrets,
        // A `$` in a name expands against the match, as `replace_all` does.
        custom_patterns: vec![
            custom("acct_${1}", r"ACCT-(\d{4})", CustomPatternKind::Pii),
            custom("tok$x", r"tk_[a-z]{6}", CustomPatternKind::Secret),
        ],
        ..FirewallConfig::default()
    })
}

#[test]
fn placeholders_are_the_formatted_pattern_names() {
    let scanner = scanner_with_custom(true, true);
    let marks = |names: Vec<String>| -> Vec<String> {
        names
            .iter()
            .map(|name| format!("[REDACTED:{name}]"))
            .collect()
    };
    let upper = |set: &[(String, regex::Regex)]| set.iter().map(|p| p.0.to_uppercase()).collect();
    assert_eq!(
        scanner.pii_placeholders,
        marks(upper(&scanner.pii_patterns))
    );
    assert_eq!(
        scanner.secret_placeholders,
        marks(upper(&scanner.secret_patterns))
    );
    let outbound = scanner.outbound_patterns.iter().map(|p| p.0.to_string());
    assert_eq!(scanner.outbound_placeholders, marks(outbound.collect()));
}

#[test]
fn sanitize_matches_the_reference_replace_all() {
    let texts = [
        "",
        "nothing sensitive here at all",
        "card 4111 1111 1111 1111 and 1234 5678 9012 3456 then 4111-1111-1111-1111",
        "hosts 8.8.8.8, 10.0.0.1, 192.168.1.20 and 1.1.1.1.",
        "mail user@example.com, key sk-abcdefghijklmnopqrstu, ACCT-1234 ACCT-99",
        "tk_abcdef tk_ABCDEF ACCT-0001ACCT-0002 \u{e000}8.8.4.4\u{e001} cafe\u{301}",
        "4111111111111111 4111111111111112 phone 415-555-0100 ssn 123-45-6789",
    ];
    for (pii, secrets) in [(true, true), (true, false), (false, true), (false, false)] {
        for scanner in [
            scanner_with(pii, secrets),
            scanner_with_custom(pii, secrets),
        ] {
            for text in texts {
                let expected = reference_sanitize(&scanner, text);
                assert_eq!(scanner.sanitize(text), expected, "text {text:?}");
            }
        }
    }
}
