//! Secret leak scanning.
//!
//! Two detectors run over text (a file, a diff, a log):
//!
//! * **Patterns** for well-known credential shapes (cloud keys, VCS and chat
//!   tokens, private keys, model-provider keys) and a generic
//!   `password=…`-style assignment rule with an entropy floor;
//! * **Known values**: exact occurrences of values currently stored in the
//!   vault (8+ characters), matched by the caller-supplied set so a leaked
//!   Ryu secret is found even when it has no recognizable shape.
//!
//! Findings never include the matched value; they carry a short redacted
//! preview (`AKIA…WXYZ`) and a SHA-256 fingerprint so duplicates can be
//! grouped and allow-listed.

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::sha256_hex;

/// Largest input scanned in one call.
pub const MAX_SCAN_BYTES: usize = 2 * 1024 * 1024;
/// Shortest stored value considered for known-value matching.
pub const MIN_KNOWN_VALUE_LEN: usize = 8;

/// One finding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// Rule id, e.g. `aws-access-key-id` or `vault-value`.
    pub rule: String,
    /// Human description.
    pub description: String,
    /// Source label (file path) when the caller supplied one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// 1-based line and column.
    pub line: usize,
    pub column: usize,
    /// Redacted preview of the match.
    pub preview: String,
    /// SHA-256 of the matched text (for allow-lists).
    pub fingerprint: String,
    /// For `vault-value` findings, the `ENV/folder/NAME` that leaked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
}

struct Rule {
    id: &'static str,
    description: &'static str,
    pattern: &'static str,
    /// Capture group holding the secret (0 = whole match).
    group: usize,
    /// Minimum Shannon entropy (bits/char) of the captured text.
    min_entropy: f64,
}

const RULES: &[Rule] = &[
    Rule {
        id: "aws-access-key-id",
        description: "AWS access key id",
        pattern: r"\b((?:AKIA|ASIA)[0-9A-Z]{16})\b",
        group: 1,
        min_entropy: 0.0,
    },
    Rule {
        id: "github-token",
        description: "GitHub token",
        pattern: r"\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255})\b",
        group: 1,
        min_entropy: 0.0,
    },
    Rule {
        id: "github-fine-grained-token",
        description: "GitHub fine-grained token",
        pattern: r"\b(github_pat_[A-Za-z0-9_]{22,255})\b",
        group: 1,
        min_entropy: 0.0,
    },
    Rule {
        id: "gitlab-token",
        description: "GitLab personal access token",
        pattern: r"\b(glpat-[A-Za-z0-9_\-]{20,})\b",
        group: 1,
        min_entropy: 0.0,
    },
    Rule {
        id: "slack-token",
        description: "Slack token",
        pattern: r"\b(xox[abprs]-[A-Za-z0-9-]{10,})\b",
        group: 1,
        min_entropy: 0.0,
    },
    Rule {
        id: "stripe-secret-key",
        description: "Stripe secret key",
        pattern: r"\b((?:sk|rk)_live_[A-Za-z0-9]{20,})\b",
        group: 1,
        min_entropy: 0.0,
    },
    Rule {
        id: "google-api-key",
        description: "Google API key",
        pattern: r"\b(AIza[0-9A-Za-z\-_]{35})\b",
        group: 1,
        min_entropy: 0.0,
    },
    Rule {
        id: "anthropic-api-key",
        description: "Anthropic API key",
        pattern: r"\b(sk-ant-[A-Za-z0-9_\-]{20,})\b",
        group: 1,
        min_entropy: 0.0,
    },
    Rule {
        id: "openai-api-key",
        description: "OpenAI API key",
        pattern: r"\b(sk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{32,})\b",
        group: 1,
        min_entropy: 3.5,
    },
    Rule {
        id: "private-key",
        description: "Private key block",
        pattern: r"(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----)",
        group: 1,
        min_entropy: 0.0,
    },
    Rule {
        id: "jwt",
        description: "JSON Web Token",
        pattern: r"\b(eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})\b",
        group: 1,
        min_entropy: 0.0,
    },
    Rule {
        id: "ryu-vault-token",
        description: "Ryu vault token",
        pattern: r"\b(rvt_[A-Za-z0-9_\-]{40,})\b",
        group: 1,
        min_entropy: 0.0,
    },
    Rule {
        id: "url-credentials",
        description: "Credentials in a URL",
        pattern: r"\b[a-z][a-z0-9+.\-]*://[^\s:/@]+:([^\s@/]{6,})@",
        group: 1,
        min_entropy: 2.5,
    },
    Rule {
        id: "generic-assignment",
        description: "Secret-looking assignment",
        pattern: r#"(?i)\b[a-z0-9_]*(?:secret|token|passwd|password|api_?key|private_?key)[a-z0-9_]*\s*[:=]\s*["']?([^\s"'`]{12,})"#,
        group: 1,
        min_entropy: 3.5,
    },
];

fn compiled() -> &'static Vec<(&'static Rule, Regex)> {
    static RULESET: OnceLock<Vec<(&'static Rule, Regex)>> = OnceLock::new();
    RULESET.get_or_init(|| {
        RULES
            .iter()
            .map(|rule| (rule, Regex::new(rule.pattern).expect("scan rule compiles")))
            .collect()
    })
}

/// Shannon entropy in bits per character.
pub fn entropy(text: &str) -> f64 {
    let mut counts = [0usize; 256];
    let mut total = 0usize;
    for byte in text.bytes() {
        counts[byte as usize] += 1;
        total += 1;
    }
    if total == 0 {
        return 0.0;
    }
    counts
        .iter()
        .filter(|count| **count > 0)
        .map(|count| {
            let p = *count as f64 / total as f64;
            -p * p.log2()
        })
        .sum()
}

fn redact(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 8 {
        return "…".to_owned();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

fn position(text: &str, offset: usize) -> (usize, usize) {
    let before = &text[..offset];
    let line = before.matches('\n').count() + 1;
    let column = before.rfind('\n').map_or(offset, |at| offset - at - 1) + 1;
    (line, column)
}

/// A stored value to look for, labelled by its `ENV/folder/NAME`.
pub struct KnownValue<'a> {
    pub label: &'a str,
    pub value: &'a str,
}

/// Values that mark a line as intentionally safe.
const IGNORE_MARKER: &str = "ryu-scan:ignore";

/// Scan `text`. `allow` holds fingerprints to suppress.
pub fn scan(
    text: &str,
    source: Option<&str>,
    known: &[KnownValue<'_>],
    allow: &[String],
) -> Vec<Finding> {
    let text = if text.len() > MAX_SCAN_BYTES {
        let mut end = MAX_SCAN_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        &text[..end]
    } else {
        text
    };
    let ignored_lines: Vec<usize> = text
        .lines()
        .enumerate()
        .filter(|(_, line)| line.contains(IGNORE_MARKER))
        .map(|(index, _)| index + 1)
        .collect();
    let mut findings = Vec::new();
    let mut push =
        |rule: &str, description: &str, start: usize, matched: &str, secret: Option<String>| {
            let fingerprint = sha256_hex(matched.as_bytes());
            if allow.contains(&fingerprint) {
                return;
            }
            let (line, column) = position(text, start);
            if ignored_lines.contains(&line) {
                return;
            }
            if findings.iter().any(|f: &Finding| {
                f.line == line && f.column == column && f.fingerprint == fingerprint
            }) {
                return;
            }
            findings.push(Finding {
                rule: rule.to_owned(),
                description: description.to_owned(),
                source: source.map(str::to_owned),
                line,
                column,
                preview: redact(matched),
                fingerprint,
                secret,
            });
        };
    for known_value in known {
        if known_value.value.len() < MIN_KNOWN_VALUE_LEN {
            continue;
        }
        for (start, matched) in text.match_indices(known_value.value) {
            push(
                "vault-value",
                "Value stored in the Ryu vault",
                start,
                matched,
                Some(known_value.label.to_owned()),
            );
        }
    }
    for (rule, regex) in compiled() {
        for captures in regex.captures_iter(text) {
            let Some(matched) = captures.get(rule.group) else {
                continue;
            };
            if rule.min_entropy > 0.0 && entropy(matched.as_str()) < rule.min_entropy {
                continue;
            }
            push(
                rule.id,
                rule.description,
                matched.start(),
                matched.as_str(),
                None,
            );
        }
    }
    findings.sort_by(|a, b| (a.line, a.column, &a.rule).cmp(&(b.line, b.column, &b.rule)));
    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_well_known_shapes_without_echoing_them() {
        // Assembled at runtime so repository secret scanners do not flag
        // these deliberately fake samples.
        let text = [
            format!("aws = \"{}{}\"", "AKIA", "IOSFODNN7EXAMPLE"),
            format!(
                "token: {}_{}",
                "ghp", "0123456789abcdefghijklmnopqrstuvwxyzAB"
            ),
            format!("-----BEGIN OPENSSH {} KEY-----", "PRIVATE"),
            String::new(),
        ]
        .join("\n");
        let findings = scan(&text, Some("config.toml"), &[], &[]);
        let rules: Vec<&str> = findings.iter().map(|f| f.rule.as_str()).collect();
        assert!(rules.contains(&"aws-access-key-id"), "{rules:?}");
        assert!(rules.contains(&"github-token"), "{rules:?}");
        assert!(rules.contains(&"private-key"), "{rules:?}");
        for finding in &findings {
            assert!(!finding.preview.contains("IOSFODNN7EXAM"));
        }
        assert_eq!(findings[0].line, 1);
        assert_eq!(findings[0].source.as_deref(), Some("config.toml"));
    }

    #[test]
    fn low_entropy_assignments_are_ignored() {
        assert!(scan("password = aaaaaaaaaaaaaaaa", None, &[], &[]).is_empty());
        assert!(!scan("password = Zq8!rT2#vL9@pX4m", None, &[], &[]).is_empty());
    }

    #[test]
    fn known_vault_values_are_found_and_labelled() {
        let known = [KnownValue {
            label: "prod/db/PASSWORD",
            value: "hunter2hunter2",
        }];
        let findings = scan("log: connecting with hunter2hunter2\n", None, &known, &[]);
        assert_eq!(findings[0].rule, "vault-value");
        assert_eq!(findings[0].secret.as_deref(), Some("prod/db/PASSWORD"));
        assert_eq!((findings[0].line, findings[0].column), (1, 22));
    }

    #[test]
    fn allow_lists_and_inline_markers_suppress() {
        let text = format!("{}{}", "AKIA", "IOSFODNN7EXAMPLE");
        let fingerprint = scan(&text, None, &[], &[])[0].fingerprint.clone();
        assert!(scan(&text, None, &[], &[fingerprint]).is_empty());
        let marked = format!("{text} # ryu-scan:ignore");
        assert!(scan(&marked, None, &[], &[]).is_empty());
    }
}
