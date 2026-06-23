//! Gateway configuration + egress enforcement — the BYOK-at-the-gateway rule
//! expressed once in Rust.
//!
//! Ports `packages/sdk/src/model/gateway.ts` (and matches the contract in
//! `apps/core/src/sidecar/gateway.rs`): every model call routes through the Ryu
//! gateway; direct provider base URLs are rejected so SDK user code can never
//! leak provider credentials or bypass policy.

use std::sync::OnceLock;

use regex::Regex;

/// Default base URL for the local Ryu gateway — matches Core's
/// `DEFAULT_GATEWAY_URL`. (Ryu port scheme: Core 7980, Gateway 7981.)
pub const DEFAULT_GATEWAY_URL: &str = "http://127.0.0.1:7981";

/// Env var pointing the SDK at the gateway base URL (no trailing `/v1`).
pub const ENV_GATEWAY_URL: &str = "RYU_GATEWAY_URL";

/// Env var carrying an optional bearer token for the gateway.
pub const ENV_GATEWAY_TOKEN: &str = "RYU_GATEWAY_TOKEN";

/// Well-known provider base-URL substrings the SDK refuses to route to directly.
/// Conservative blocklist: anything that looks like a public AI-provider API is
/// rejected so the gateway stays the sole egress point.
const BLOCKED_PROVIDER_PATTERNS: &[&str] = &[
    r"api\.openai\.com",
    r"api\.anthropic\.com",
    r"generativelanguage\.googleapis\.com",
    r"api\.cohere\.ai",
    r"api\.mistral\.ai",
    r"openrouter\.ai",
    r"api\.groq\.com",
    r"api\.together\.xyz",
    r"api\.replicate\.com",
    r"api\.perplexity\.ai",
];

/// Compiled blocklist, built once. The patterns are crate constants, so the
/// regexes are valid by construction.
fn blocked_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        BLOCKED_PROVIDER_PATTERNS
            .iter()
            .map(|p| Regex::new(&format!("(?i){p}")).expect("blocklist pattern is a valid regex"))
            .collect()
    })
}

/// Error returned when a base URL points at a blocked direct-provider endpoint.
#[derive(Debug, thiserror::Error)]
#[error(
    "[ryu-sdk] direct provider egress is not allowed: \"{url}\". All model calls must route \
     through the Ryu gateway. Set {ENV_GATEWAY_URL} to your gateway base URL, or omit baseUrl to \
     use the default ({DEFAULT_GATEWAY_URL}). Provider credentials belong in the gateway, not in \
     SDK config."
)]
pub struct EgressNotAllowed {
    /// The offending URL.
    pub url: String,
}

/// Resolve the effective gateway base URL: `RYU_GATEWAY_URL` (when non-empty),
/// else [`DEFAULT_GATEWAY_URL`].
pub fn resolve_gateway_url() -> String {
    std::env::var(ENV_GATEWAY_URL)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_GATEWAY_URL.to_string())
}

/// Resolve the optional gateway bearer token: `RYU_GATEWAY_TOKEN` when present
/// and non-empty, else `None`.
pub fn resolve_gateway_token() -> Option<String> {
    std::env::var(ENV_GATEWAY_TOKEN)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Validate that `base_url` is an allowed egress target (not a known direct
/// provider). Returns [`EgressNotAllowed`] otherwise.
pub fn assert_allowed_egress(base_url: &str) -> Result<(), EgressNotAllowed> {
    for pattern in blocked_patterns() {
        if pattern.is_match(base_url) {
            return Err(EgressNotAllowed { url: base_url.to_string() });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_known_providers() {
        for blocked in [
            "https://api.openai.com",
            "https://API.OpenAI.com/v1",
            "https://api.anthropic.com",
            "https://openrouter.ai/api",
            "https://generativelanguage.googleapis.com",
        ] {
            assert!(assert_allowed_egress(blocked).is_err(), "should block {blocked}");
        }
    }

    #[test]
    fn allows_gateway_and_loopback() {
        for ok in [
            "http://127.0.0.1:7981",
            "http://localhost:7981",
            "https://gateway.internal.example",
            "http://192.168.1.50:7981",
        ] {
            assert!(assert_allowed_egress(ok).is_ok(), "should allow {ok}");
        }
    }

    #[test]
    fn default_url_matches_core() {
        assert_eq!(DEFAULT_GATEWAY_URL, "http://127.0.0.1:7981");
    }
}
