//! OpenRouter API key resolution.
//!
//! A process-global OpenRouter API key, resolved **preferences-first** — the
//! user (or, on a managed node, the operator) sets it in desktop Settings →
//! Integrations, persisted to `~/.ryu/preferences.db` under
//! [`OPENROUTER_API_KEY_PREF_KEY`] — then falls back to the
//! `RYU_OPENROUTER_API_KEY` / `OPENROUTER_API_KEY` environment variables for
//! headless / managed-node setups. Mirrors [`crate::composio_auth`].
//!
//! Why a resolver and not a bare env read (A4 / #501): the gateway child
//! inherits Core's environment, so a plain `OPENROUTER_API_KEY` already flows
//! through. The resolver adds the **preference** source — a key set in the UI
//! and persisted (never on Core's process env) still reaches the gateway — and
//! gives the spawn path one place to ask. On a managed Ryu Cloud node the
//! operator sets the env once and every end user gets OpenRouter routing with
//! zero setup; the key presence alone activates the gateway's `openrouter`
//! provider (`apps/gateway/src/config.rs`).
//!
//! Placement note (Core vs Gateway): this is a credential for reaching a
//! provider account — *what is configured to run*, supplied to the data-plane
//! gateway — so it lives in Core. The key is never logged.

use std::sync::RwLock;

/// Preferences key the desktop writes; Core loads it on startup and on change.
pub const OPENROUTER_API_KEY_PREF_KEY: &str = "openrouter-api-key";

/// In-process key cache, populated from preferences. `None` falls back to env.
static OPENROUTER_KEY: RwLock<Option<String>> = RwLock::new(None);

/// Set (or clear, when empty) the in-process key from a preferences value.
pub fn set_key(key: &str) {
    let trimmed = key.trim();
    if let Ok(mut guard) = OPENROUTER_KEY.write() {
        *guard = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
    }
}

/// Resolve the active key: preferences (in-process) first, then env
/// (`RYU_OPENROUTER_API_KEY` preferred so an operator override beats a stray
/// `OPENROUTER_API_KEY`).
pub fn key() -> Option<String> {
    if let Ok(guard) = OPENROUTER_KEY.read() {
        if let Some(k) = guard.as_ref() {
            return Some(k.clone());
        }
    }
    std::env::var("RYU_OPENROUTER_API_KEY")
        .or_else(|_| std::env::var("OPENROUTER_API_KEY"))
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

/// True when an OpenRouter key is configured (preferences or env).
pub fn is_configured() -> bool {
    key().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_then_clear_key() {
        set_key("  sk-or-abc123  ");
        assert_eq!(key().as_deref(), Some("sk-or-abc123"));
        set_key("   ");
        // Falls back to env (cleared here) → None.
        std::env::remove_var("RYU_OPENROUTER_API_KEY");
        std::env::remove_var("OPENROUTER_API_KEY");
        assert_eq!(key(), None);
    }
}
