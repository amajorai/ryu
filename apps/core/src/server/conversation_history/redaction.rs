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
///
/// The patterns run on the text as written and, separately, on the folded view
/// of the input (NFKC per code point, invisible characters dropped, dash, space
/// and digit variants to ASCII; see [`fold`]). When the folded scan redacts
/// exactly what the as-written pass did, the text keeps its original form.
/// Otherwise (PII typed in fullwidth, split by zero-width characters, written
/// with native-script digits, or an invisible character that hid the head of an
/// address from the as-written pass) the folded, redacted view is returned, and
/// any as-written match the folded scan no longer recognises is redacted in it
/// as well. Mirrors `redactShareText` in the public-share guard.
pub fn redact_text(input: &str, counts: &mut RedactionCounts) -> String {
    let mut raw_counts = RedactionCounts::default();
    let mut raw_matches = Vec::new();
    let raw = apply_rules(input, &mut raw_counts, Some(&mut raw_matches));
    let folded = fold::fold(input);
    let mut folded_counts = RedactionCounts::default();
    let rescanned = (folded != input).then(|| apply_rules(&folded, &mut folded_counts, None));
    let Some(mut rescanned) = rescanned.filter(|r| fold::fold(&raw) != r.as_str()) else {
        counts.pii += raw_counts.pii;
        counts.secrets += raw_counts.secrets;
        return raw;
    };
    for (kind, label, text) in raw_matches {
        let residue = fold::fold(&text);
        let found = rescanned.matches(&*residue).count();
        if residue.is_empty() || found == 0 {
            continue;
        }
        match kind {
            Kind::Pii => folded_counts.pii += found,
            Kind::Secret => folded_counts.secrets += found,
        }
        rescanned = rescanned.replace(&*residue, &format!("[REDACTED:{label}]"));
    }
    counts.pii += folded_counts.pii;
    counts.secrets += folded_counts.secrets;
    rescanned
}

#[path = "redaction_fold.rs"]
mod fold;

type RuleMatch = (Kind, &'static str, String);

fn apply_rules(
    input: &str,
    counts: &mut RedactionCounts,
    mut matches: Option<&mut Vec<RuleMatch>>,
) -> String {
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
                if let Some(matches) = matches.as_deref_mut() {
                    matches.push((rule.kind, rule.label, capture[0].to_owned()));
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
    fn obfuscated_pii_is_redacted_on_the_folded_view() {
        for (input, expected) in [
            (
                "card ４１１１ １１１１ １１１１ １１１１",
                "card [REDACTED:CARD]",
            ),
            ("mail ava＠example.com", "mail [REDACTED:EMAIL]"),
            ("ssn 123\u{200B}-45-6789", "ssn [REDACTED:SSN]"),
            ("call ５５５‑１２３‑４５６７", "call [REDACTED:PHONE]"),
        ] {
            let mut counts = RedactionCounts::default();
            assert_eq!(redact_text(input, &mut counts), expected, "{input}");
            assert_eq!(counts.pii, 1, "{input}");
        }
    }

    #[test]
    fn an_invisible_character_cannot_hide_the_head_of_an_address() {
        for input in [
            "mail jane.doe\u{200B}1@gmail.com",
            "mail a\u{200B}va@example.com",
            "mail jane\u{00AD}doe@example.com",
        ] {
            let mut counts = RedactionCounts::default();
            assert_eq!(
                redact_text(input, &mut counts),
                "mail [REDACTED:EMAIL]",
                "{input}"
            );
            assert_eq!(counts.pii, 1, "{input}");
        }
    }

    #[test]
    fn an_as_written_match_stays_redacted_when_folding_lengthens_its_run() {
        // Dropping the zero-width space joins the key to the next letter, so the
        // folded scan alone no longer sees a 20-character key.
        let mut counts = RedactionCounts::default();
        assert_eq!(
            redact_text("key AKIAABCDEFGHIJKLMNOP\u{200B}Q \u{FF11}", &mut counts),
            "key [REDACTED:AWS_KEY]Q 1"
        );
        assert_eq!(counts.secrets, 1);
    }

    #[test]
    fn text_without_obfuscated_pii_keeps_its_original_form() {
        let mut counts = RedactionCounts::default();
        let input = "（メモ）ｶﾀｶﾅ ava@example.com";
        assert_eq!(
            redact_text(input, &mut counts),
            "（メモ）ｶﾀｶﾅ [REDACTED:EMAIL]"
        );
        assert_eq!(counts.pii, 1);
        let mut clean = RedactionCounts::default();
        assert_eq!(redact_text("ﬁle ①", &mut clean), "ﬁle ①");
        assert_eq!(clean.total(), 0);
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
