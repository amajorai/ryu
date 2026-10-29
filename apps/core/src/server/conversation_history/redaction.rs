//! Locked export redaction for conversation history leaving Core's sealed store.
//!
//! This is an export policy, independent of Gateway's configurable model-egress
//! firewall. It always runs for Git checkpoints and public-share previews.

use std::sync::OnceLock;

use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RedactionCounts {
    pub pii: usize,
    pub secrets: usize,
    #[serde(default)]
    pub custom: usize,
}

impl RedactionCounts {
    pub fn total(&self) -> usize {
        self.pii + self.secrets + self.custom
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Pii,
    Secret,
}

struct Rule {
    label: &'static str,
    kind: Kind,
    pattern: Regex,
    validator: Option<fn(&str) -> bool>,
}

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let definitions: &[(&str, Kind, &str, Option<fn(&str) -> bool>)] = &[
            (
                "PRIVATE_KEY",
                Kind::Secret,
                r"(?s)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)",
                None,
            ),
            ("GITHUB_TOKEN", Kind::Secret, r"\bgh[pousr]_[A-Za-z0-9]{20,255}\b", None),
            ("GITHUB_TOKEN", Kind::Secret, r"\bgithub_pat_[A-Za-z0-9_]{22,255}\b", None),
            ("GITLAB_TOKEN", Kind::Secret, r"\bglpat-[A-Za-z0-9_-]{20,}\b", None),
            ("STRIPE_KEY", Kind::Secret, r"\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b", None),
            ("SLACK_TOKEN", Kind::Secret, r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b", None),
            ("GOOGLE_KEY", Kind::Secret, r"\bAIza[0-9A-Za-z_-]{35}\b", None),
            ("HF_TOKEN", Kind::Secret, r"\bhf_[A-Za-z0-9]{20,}\b", None),
            ("PYPI_TOKEN", Kind::Secret, r"\bpypi-[A-Za-z0-9_-]{20,}\b", None),
            ("AWS_KEY", Kind::Secret, r"\bAKIA[0-9A-Z]{16}\b", None),
            ("API_KEY", Kind::Secret, r"\bsk-[A-Za-z0-9_-]{20,}\b", None),
            (
                "JWT",
                Kind::Secret,
                r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b",
                None,
            ),
            ("BEARER", Kind::Secret, r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*", None),
            (
                "DATABASE_URL",
                Kind::Secret,
                r#"(?i)\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://[^\s"']+"#,
                None,
            ),
            (
                "CREDENTIAL",
                Kind::Secret,
                r#"(?i)(?:["']?)(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|database[_-]?url|private[_-]?key|connection[_-]?string|password|passwd|secret|token)(?:["']?)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)"#,
                None,
            ),
            (
                "EMAIL",
                Kind::Pii,
                r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
                None,
            ),
            (
                "PHONE",
                Kind::Pii,
                r"\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)\s?|\d{3}[-.\s])\d{3}[-.\s]\d{4}\b",
                None,
            ),
            ("SSN", Kind::Pii, r"\b\d{3}[-\s]\d{2}[-\s]\d{4}\b", None),
            (
                "PASSPORT",
                Kind::Pii,
                r"(?i)\bpassport\b[\s:#-]*(?:(?:no|num|number)\.?[\s:#-]*)?[A-Z]{1,2}[0-9]{6,9}\b",
                None,
            ),
            (
                "CARD",
                Kind::Pii,
                r"\b(?:\d[ -]?){12,18}\d\b",
                Some(is_credit_card_number),
            ),
            (
                "IP_ADDRESS",
                Kind::Pii,
                r"\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b",
                Some(is_public_ipv4),
            ),
        ];
        definitions
            .iter()
            .map(|(label, kind, expression, validator)| Rule {
                label,
                kind: *kind,
                pattern: Regex::new(expression).expect("built-in redaction pattern"),
                validator: *validator,
            })
            .collect()
    })
}

fn is_credit_card_number(candidate: &str) -> bool {
    let digits: Vec<u32> = candidate.chars().filter_map(|c| c.to_digit(10)).collect();
    if !(13..=19).contains(&digits.len()) {
        return false;
    }
    let mut sum = 0;
    for (index, digit) in digits.iter().rev().enumerate() {
        let mut value = *digit;
        if index % 2 == 1 {
            value *= 2;
            if value > 9 {
                value -= 9;
            }
        }
        sum += value;
    }
    sum % 10 == 0
}

fn is_public_ipv4(candidate: &str) -> bool {
    let Ok(address) = candidate.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    !(address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_broadcast()
        || address.is_unspecified()
        || address.is_multicast()
        || address.octets()[0] >= 240)
}

/// Replace recognized sensitive spans. The caller must still offer a review
/// before the resulting content is pushed or shared: pattern matching cannot
/// identify every person's name, novel credential, or confidential document.
pub fn redact_text(input: &str, counts: &mut RedactionCounts) -> String {
    let mut result = input.to_owned();
    for rule in rules() {
        let placeholder = format!("[REDACTED:{}]", rule.label);
        result = rule
            .pattern
            .replace_all(&result, |capture: &Captures| {
                if rule
                    .validator
                    .is_some_and(|validate| !validate(&capture[0]))
                {
                    return capture[0].to_owned();
                }
                match rule.kind {
                    Kind::Pii => counts.pii += 1,
                    Kind::Secret => counts.secrets += 1,
                }
                placeholder.clone()
            })
            .into_owned();
    }
    result
}

/// Apply reviewed literal phrases after the built-in scanner. The expressions
/// are compiled from escaped text, so users cannot supply a costly regex.
pub fn redact_custom(input: &str, counts: &mut RedactionCounts, phrases: &[Regex]) -> String {
    let mut result = redact_text(input, counts);
    for pattern in phrases {
        result = pattern
            .replace_all(&result, |_capture: &Captures| {
                counts.custom += 1;
                "[REDACTED:CUSTOM]".to_owned()
            })
            .into_owned();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_v1_redaction_fixture_matches_core() {
        let fixture = include_str!(
            "../../../../../packages/core-client/fixtures/portable-history-redaction-v1.json"
        );
        let rows: Vec<serde_json::Value> = serde_json::from_str(fixture).expect("fixture json");
        for row in rows {
            let mut counts = RedactionCounts::default();
            let output = redact_text(row["input"].as_str().expect("input"), &mut counts);
            assert_eq!(output, row["expected"].as_str().expect("expected"));
            assert_eq!(counts.pii, row["pii"].as_u64().expect("pii") as usize);
            assert_eq!(
                counts.secrets,
                row["secrets"].as_u64().expect("secrets") as usize
            );
        }
    }

    #[test]
    fn export_redacts_sensitive_values_and_preserves_safe_text() {
        let mut counts = RedactionCounts::default();
        let source = "Email ava@example.com, card 4111 1111 1111 1111, phone 415-555-1212, password='hunter2', token=abc123, git HEAD abc123, local 127.0.0.1";
        let redacted = redact_text(source, &mut counts);
        for secret in [
            "ava@example.com",
            "4111 1111 1111 1111",
            "415-555-1212",
            "hunter2",
        ] {
            assert!(!redacted.contains(secret), "sensitive value escaped");
        }
        assert!(redacted.contains("git HEAD abc123"));
        assert!(redacted.contains("127.0.0.1"));
        assert!(counts.pii >= 3);
        assert!(counts.secrets >= 1);
    }

    #[test]
    fn entire_private_key_block_is_removed() {
        let mut counts = RedactionCounts::default();
        let source = "-----BEGIN PRIVATE KEY-----\nvery-secret-body\n-----END PRIVATE KEY-----";
        assert_eq!(redact_text(source, &mut counts), "[REDACTED:PRIVATE_KEY]");
        assert_eq!(counts.secrets, 1);
    }

    #[test]
    fn reviewed_custom_phrase_is_case_insensitive_and_not_written() {
        let phrase = regex::RegexBuilder::new(&regex::escape("Project Cobalt"))
            .case_insensitive(true)
            .build()
            .expect("phrase");
        let mut counts = RedactionCounts::default();
        let output = redact_custom("Discuss project cobalt today", &mut counts, &[phrase]);
        assert_eq!(output, "Discuss [REDACTED:CUSTOM] today");
        assert_eq!(counts.custom, 1);
    }
}
