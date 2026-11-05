//! Data-leak detection patterns: PII, secrets and outbound secret egress.
//!
//! Word boundaries accept either a Unicode or an ASCII boundary
//! (`(?:\b|(?-u:\b))`): with Unicode boundaries alone a value written next to
//! CJK, kana or hangul text (`密钥sk-...`) never matched, because those are
//! word characters; ASCII boundaries alone would miss values in non-ASCII
//! digits. Two ASCII word characters still never have a boundary between them.

use regex::Regex;

use crate::patterns::compile_patterns;

/// The either-boundary group every curated PII and outbound pattern uses.
pub const EITHER_BOUNDARY: &str = r"(?:\b|(?-u:\b))";
/// The ASCII word boundary a twin uses in place of [`EITHER_BOUNDARY`].
const ASCII_BOUNDARY: &str = r"(?-u:\b)";

/// A curated pattern with its ASCII-boundary twin: the same pattern with each
/// [`EITHER_BOUNDARY`] replaced by `(?-u:\b)`, or `None` when it has none.
/// The twin finds the same matches as the original on any text for which
/// [`ascii_boundaries_agree`] holds, and it stays on the regex crate's lazy
/// DFA there, while a Unicode `\b` sends non-ASCII text to a slower engine.
pub type Twinned<N> = (N, Regex, Option<Regex>);

/// Unicode and ASCII `\b` agree at every boundary of `text`: every non-ASCII
/// character is private-use (General_Category Co, never a word character, as
/// the stream DLP's boundary sentinels are). Unicode `\w` restricted to ASCII
/// is `[0-9A-Za-z_]`, and the UTF-8 bytes of a private-use character are
/// non-word under ASCII rules, so both boundaries hold at the same positions.
///
/// Skips ASCII eight bytes at a time and decodes only the non-ASCII
/// characters. `at` advances over whole ASCII bytes or whole characters, so it
/// always sits on a char boundary.
pub fn ascii_boundaries_agree(text: &str) -> bool {
    const HIGH: u64 = 0x8080_8080_8080_8080;
    let bytes = text.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if let Some(chunk) = bytes.get(at..at + 8) {
            let word = u64::from_ne_bytes(chunk.try_into().expect("8 bytes"));
            if word & HIGH == 0 {
                at += 8;
                continue;
            }
        }
        if bytes[at] < 0x80 {
            at += 1;
            continue;
        }
        let Some(c) = text[at..].chars().next() else {
            return true;
        };
        if !matches!(
            u32::from(c),
            0xE000..=0xF8FF | 0xF_0000..=0xF_FFFD | 0x10_0000..=0x10_FFFD
        ) {
            return false;
        }
        at += c.len_utf8();
    }
    true
}

/// Compile `pattern` and its ASCII-boundary twin in one pass.
fn compile_twinned<N: Copy + std::fmt::Display>(raw: &[(N, &str)]) -> Vec<Twinned<N>> {
    raw.iter()
        .filter_map(|(name, pattern)| match Regex::new(pattern) {
            Ok(re) => {
                let twin = if pattern.contains(EITHER_BOUNDARY) {
                    Regex::new(&pattern.replace(EITHER_BOUNDARY, ASCII_BOUNDARY)).ok()
                } else {
                    None
                };
                Some((*name, re, twin))
            }
            Err(e) => {
                tracing::error!("Failed to compile firewall pattern '{name}': {e}");
                None
            }
        })
        .collect()
}

pub fn build_pii_patterns() -> Vec<(String, Regex)> {
    build_pii_patterns_with_twins()
        .into_iter()
        .map(|(name, re, _)| (name, re))
        .collect()
}

/// [`build_pii_patterns`] with each pattern's ASCII-boundary twin.
pub fn build_pii_patterns_with_twins() -> Vec<Twinned<String>> {
    compile_twinned(&PII_PATTERNS)
        .into_iter()
        .map(|(name, re, twin)| (name.to_string(), re, twin))
        .collect()
}

/// (name, regex) for the curated PII set, in redaction order.
const PII_PATTERNS: [(&str, &str); 7] = [
    // Email addresses
    ("email", r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}"),
    // US phone numbers. At least one separator (or a parenthesized area code)
    // is required so a bare 10-digit run (unix timestamps, order IDs) is NOT
    // misflagged as a phone number (red-team FP). International/E.164 formats
    // are a documented US-scoped coverage gap, not covered here.
    (
        "phone_us",
        r"(?:\b|(?-u:\b))(?:\+?1[-.\s]?)?(?:\(\d{3}\)\s?|\d{3}[-.\s])\d{3}[-.\s]\d{4}(?:\b|(?-u:\b))",
    ),
    // US Social Security Numbers — dash OR space separated (both are common
    // presentations). Bare 9-digit contiguous is intentionally NOT matched
    // (high false-positive risk without a keyword anchor).
    (
        "ssn",
        r"(?:\b|(?-u:\b))\d{3}[-\s]\d{2}[-\s]\d{4}(?:\b|(?-u:\b))",
    ),
    // Credit card CANDIDATE: 13–19 digits in optional space/dash-separated
    // groups (the near-universal printed form). Precision comes from the Luhn
    // + prefix + length validator in `is_credit_card_number` (applied in
    // find_match / sanitize), so the spaced form `4111 1111 1111 1111` is
    // caught while arbitrary long digit runs are not.
    (
        "credit_card",
        r"(?:\b|(?-u:\b))(?:\d[ -]?){12,18}\d(?:\b|(?-u:\b))",
    ),
    // IPv4 addresses. `is_public_ipv4` post-filters out loopback / RFC1918 /
    // link-local / multicast / subnet-mask shapes so benign technical output
    // (e.g. `255.255.255.0`, `127.0.0.1`, `192.168.1.1`) is not flagged.
    (
        "ipv4",
        r"(?:\b|(?-u:\b))(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?:\b|(?-u:\b))",
    ),
    // Passport numbers — keyword-anchored to the word "passport" so the
    // generic letter+digits shape stops false-positiving on order/SKU/invoice
    // codes (`AB1234567`), the red-team's biggest PII FP source.
    (
        "passport",
        r"(?i)(?:\b|(?-u:\b))passport(?:\b|(?-u:\b))[\s:#-]*(?:(?:no|num|number)\.?[\s:#-]*)?[A-Z]{1,2}[0-9]{6,9}(?:\b|(?-u:\b))",
    ),
    // IBAN — 2 letters + 2 check digits + up to 30 alphanumerics, printed in
    // optional space-separated groups of 4 (the conventional form), so
    // `GB29 NWBK 6016 1331 9268 19` is caught, not just the contiguous form.
    (
        "iban",
        r"(?:\b|(?-u:\b))[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?(?:\b|(?-u:\b))",
    ),
];

pub fn build_secret_patterns() -> Vec<(String, Regex)> {
    let raw = [
        // OpenAI API key
        ("openai_key", r"sk-[A-Za-z0-9]{20,}"),
        // Anthropic API key
        ("anthropic_key", r"sk-ant-[A-Za-z0-9\-_]{20,}"),
        // AWS Access Key ID
        ("aws_access_key", r"AKIA[0-9A-Z]{16}"),
        // AWS Secret Access Key
        (
            "aws_secret_key",
            r#"(?i)aws.{0,20}secret.{0,20}['"][0-9a-zA-Z/+]{40}['"]"#,
        ),
        // GitHub personal access tokens (classic)
        ("github_token_classic", r"ghp_[A-Za-z0-9]{36}"),
        // GitHub fine-grained PAT
        ("github_token_fg", r"github_pat_[A-Za-z0-9_]{82}"),
        // Generic high-entropy bearer tokens
        ("bearer_token", r"(?i)bearer\s+[A-Za-z0-9\-._~+/]{40,}"),
        // Private keys (PEM)
        (
            "pem_private_key",
            r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
        ),
        // Generic API key assignment patterns
        (
            "generic_api_key",
            r#"(?i)(?:api_key|apikey|api-key)\s*[:=]\s*['"]?[A-Za-z0-9\-_]{20,}['"]?"#,
        ),
        // Database connection strings
        (
            "db_connection",
            r"(?i)(?:mongodb|postgres|postgresql|mysql|redis):\/\/[^\s]+:[^\s]+@",
        ),
    ];

    compile_patterns(&raw)
}

/// Compiled outbound secret-egress patterns with STABLE `&'static str` markers.
///
/// Distinct from `build_secret_patterns` (which returns owned `String` names and
/// feeds the config-gated inbound/outbound scan). These markers are the stable
/// redaction labels (`[REDACTED:gh_pat]`, …) surfaced to callers, so they must
/// stay `&'static str` and not route through `compile_patterns`.
pub fn build_outbound_patterns() -> Vec<(&'static str, Regex)> {
    build_outbound_patterns_with_twins()
        .into_iter()
        .map(|(marker, re, _)| (marker, re))
        .collect()
}

/// [`build_outbound_patterns`] with each pattern's ASCII-boundary twin.
pub fn build_outbound_patterns_with_twins() -> Vec<Twinned<&'static str>> {
    compile_twinned(&OUTBOUND_PATTERNS)
}

/// (marker, regex). Order matters: more specific token shapes first so a
/// GitHub PAT is not partially eaten by a generic param rule.
const OUTBOUND_PATTERNS: [(&str, &str); 7] = [
    // GitHub PATs: ghp_ (classic), gho_/ghu_/ghs_/ghr_ (OAuth/user/server/refresh)
    (
        "gh_pat",
        r"(?:\b|(?-u:\b))gh[pousr]_[A-Za-z0-9]{20,255}(?:\b|(?-u:\b))",
    ),
    // GitHub fine-grained PAT
    (
        "gh_pat",
        r"(?:\b|(?-u:\b))github_pat_[A-Za-z0-9_]{22,255}(?:\b|(?-u:\b))",
    ),
    // OpenAI-style sk- keys (incl. sk-proj-, sk-ant-)
    (
        "openai_key",
        r"(?:\b|(?-u:\b))sk-[A-Za-z0-9_\-]{20,}(?:\b|(?-u:\b))",
    ),
    // AWS access key id
    (
        "aws_akid",
        r"(?:\b|(?-u:\b))AKIA[0-9A-Z]{16}(?:\b|(?-u:\b))",
    ),
    // Bearer <token>
    (
        "bearer",
        r"(?i)(?:\b|(?-u:\b))bearer\s+[A-Za-z0-9\-._~+/]{16,}=*",
    ),
    // token= / api_key= / apikey= / access_token= query-or-form params
    (
        "token_param",
        r"(?i)(?:\b|(?-u:\b))(?:api[_-]?key|access[_-]?token|token)=[A-Za-z0-9\-._~+/]{8,}",
    ),
    // password= / secret= / passwd= query-or-form params
    (
        "secret_param",
        r#"(?i)(?:\b|(?-u:\b))(?:password|passwd|secret)=[^&\s"']{4,}"#,
    ),
];

#[cfg(test)]
#[path = "leak_patterns_test.rs"]
mod tests;
