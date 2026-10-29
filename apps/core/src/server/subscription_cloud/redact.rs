//! Scrubbing for anything Ryu keeps from a provider CLI's output.
//!
//! Ryu never persists or logs a CLI's raw stdout/stderr. The only text it keeps is a short
//! error message for the user, and that goes through [`scrub`] first so a token the CLI
//! echoed (an expired-token error, a debug line) can never reach a record, a response or
//! a log.

use std::sync::LazyLock;

/// Longest scrubbed message kept.
pub(super) const MAX_KEPT_CHARS: usize = 600;

const MASK: &str = "[redacted]";

static SECRET_PATTERNS: LazyLock<Vec<regex::Regex>> = LazyLock::new(|| {
    [
        // Anthropic API keys and OAuth tokens (`sk-ant-api…`, `sk-ant-oat…`).
        r"sk-ant-[A-Za-z0-9_\-]{8,}",
        // OpenAI keys (`sk-…`, `sk-proj-…`) and session tokens.
        r"\bsk-[A-Za-z0-9_\-]{16,}",
        r"\bsess-[A-Za-z0-9_\-]{16,}",
        // Bearer headers, whatever follows.
        r"(?i)bearer\s+[A-Za-z0-9._~+/=\-]{8,}",
        // JWTs (ChatGPT access and id tokens).
        r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]*",
        // `key=value` / `"key": "value"` for token-like keys.
        r#"(?i)(access_token|refresh_token|id_token|session_key|api_key|apikey|x-api-key|authorization|cookie|password|secret|token)("?\s*[:=]\s*"?)[^\s",}]+"#,
        // Long opaque hex or base64 runs (refresh tokens, cookies).
        r"\b[A-Fa-f0-9]{40,}\b",
        r"[A-Za-z0-9+/_\-]{48,}={0,2}",
    ]
    .iter()
    .map(|pattern| regex::Regex::new(pattern).expect("static redaction pattern"))
    .collect()
});

/// Mask every secret-shaped run in `text`, flatten control characters, and cap the
/// length at [`MAX_KEPT_CHARS`].
pub(super) fn scrub(text: &str) -> String {
    let mut scrubbed = text.to_owned();
    for pattern in SECRET_PATTERNS.iter() {
        scrubbed = pattern
            .replace_all(&scrubbed, |captures: &regex::Captures<'_>| {
                // Keep the key name of a `key=value` pair so the message stays readable.
                match (captures.get(1), captures.get(2)) {
                    (Some(key), Some(separator)) => {
                        format!("{}{}{MASK}", key.as_str(), separator.as_str())
                    }
                    _ => MASK.to_owned(),
                }
            })
            .into_owned();
    }
    let flattened: String = scrubbed
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    let trimmed = flattened.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.chars().count() > MAX_KEPT_CHARS {
        let mut kept: String = trimmed.chars().take(MAX_KEPT_CHARS).collect();
        kept.push('…');
        kept
    } else {
        trimmed
    }
}
