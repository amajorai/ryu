//! Replicate API key resolution.
//!
//! A process-global Replicate API token, resolved **preferences-first** — the
//! user (or, on a managed node, the operator) sets it in desktop Settings →
//! Integrations, persisted to `~/.ryu/preferences.db` under
//! [`REPLICATE_API_KEY_PREF_KEY`] — then falls back to the
//! `RYU_REPLICATE_API_KEY` / `REPLICATE_API_KEY` environment variables for
//! headless / managed-node setups. Mirrors [`crate::openrouter_auth`].
//!
//! Key presence alone activates the gateway's `replicate` provider
//! (`apps/gateway/src/config.rs`), so the whole cloud image/video path lights up
//! from one credential. The key is never logged.

use std::sync::RwLock;

/// Preferences key the desktop writes; Core loads it on startup and on change.
pub const REPLICATE_API_KEY_PREF_KEY: &str = "replicate-api-key";

/// In-process key cache, populated from preferences. `None` falls back to env.
static REPLICATE_KEY: RwLock<Option<String>> = RwLock::new(None);

/// Set (or clear, when empty) the in-process key from a preferences value.
pub fn set_key(key: &str) {
    let trimmed = key.trim();
    if let Ok(mut guard) = REPLICATE_KEY.write() {
        *guard = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
    }
}

/// Resolve the active key: preferences (in-process) first, then env
/// (`RYU_REPLICATE_API_KEY` preferred so an operator override beats a stray
/// `REPLICATE_API_KEY`).
pub fn key() -> Option<String> {
    if let Ok(guard) = REPLICATE_KEY.read() {
        if let Some(k) = guard.as_ref() {
            return Some(k.clone());
        }
    }
    std::env::var("RYU_REPLICATE_API_KEY")
        .or_else(|_| std::env::var("REPLICATE_API_KEY"))
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

/// True when a Replicate key is configured (preferences or env).
pub fn is_configured() -> bool {
    key().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_then_clear_key() {
        set_key("  r8_abc123  ");
        assert_eq!(key().as_deref(), Some("r8_abc123"));
        set_key("   ");
        std::env::remove_var("RYU_REPLICATE_API_KEY");
        std::env::remove_var("REPLICATE_API_KEY");
        assert_eq!(key(), None);
    }
}
