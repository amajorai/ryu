//! Hugging Face authentication token resolution.
//!
//! A process-global HF access token used to raise Hub rate limits and unlock
//! gated/private repos for both the model catalog (search + detail) and the
//! GGUF downloader. The token is resolved **preferences-first** — the user sets
//! it in desktop Settings, persisted to `~/.ryu/preferences.db` under the key
//! [`HF_TOKEN_PREF_KEY`] — then falls back to the `HF_TOKEN` environment
//! variable for headless setups.
//!
//! Placement note (Core vs Gateway): this is a user-supplied credential for
//! fetching weights — *what the user picked*, not org policy — so it lives in
//! Core. The token is never logged and is attached only to Hugging Face hosts.

use std::sync::RwLock;

/// Preferences key the desktop writes; Core loads it on startup and on change.
pub const HF_TOKEN_PREF_KEY: &str = "hf-token";

/// In-process token cache, populated from preferences. `None` falls back to env.
static HF_TOKEN: RwLock<Option<String>> = RwLock::new(None);

/// Set (or clear, when empty) the in-process token from a preferences value.
pub fn set_token(token: &str) {
    let trimmed = token.trim();
    if let Ok(mut guard) = HF_TOKEN.write() {
        *guard = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
    }
}

/// Resolve the active token: preferences (in-process) first, then `HF_TOKEN` env.
pub fn token() -> Option<String> {
    if let Ok(guard) = HF_TOKEN.read() {
        if let Some(t) = guard.as_ref() {
            return Some(t.clone());
        }
    }
    std::env::var("HF_TOKEN")
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// True when `url` targets the Hugging Face Hub host. The host is parsed (not
/// substring-matched) so look-alikes like `huggingface.co.evil.com` do not
/// receive the bearer token.
pub fn is_hf_url(url: &str) -> bool {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .map(|h| h == "huggingface.co" || h.ends_with(".huggingface.co"))
        .unwrap_or(false)
}

/// Attach HF bearer auth to a request when a token is available; otherwise pass
/// the builder through unchanged.
pub fn authorize(req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    match token() {
        Some(t) => req.bearer_auth(t),
        None => req,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_match_is_strict() {
        assert!(is_hf_url(
            "https://huggingface.co/foo/bar/resolve/main/x.gguf"
        ));
        assert!(is_hf_url("https://cdn-lfs.huggingface.co/repos/x"));
        assert!(!is_hf_url("https://huggingface.co.evil.com/x"));
        assert!(!is_hf_url("https://example.com/x.gguf"));
        assert!(!is_hf_url("not a url"));
    }

    #[test]
    fn set_then_clear_token() {
        set_token("  hf_abc123  ");
        assert_eq!(token().as_deref(), Some("hf_abc123"));
        set_token("   ");
        // Falls back to env (unset in tests) → None.
        std::env::remove_var("HF_TOKEN");
        assert_eq!(token(), None);
    }
}
