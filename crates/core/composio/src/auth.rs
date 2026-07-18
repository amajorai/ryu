//! Composio API key resolution.
//!
//! A process-global Composio API key, resolved **preferences-first** — the user
//! sets it in desktop Settings → Integrations, persisted to
//! `~/.ryu/preferences.db` under [`COMPOSIO_API_KEY_PREF_KEY`] — then falls back
//! to the `RYU_COMPOSIO_API_KEY` / `COMPOSIO_API_KEY` environment variables for
//! headless setups. Mirrors [`crate::hf_auth`].
//!
//! Two consumers share this resolver:
//!   1. [`crate::sidecar::gateway`] injects the resolved key into the gateway
//!      sidecar's environment (`COMPOSIO_API_KEY`) at spawn, which flips the
//!      gateway's `ComposioConfig.enabled` and turns on its tool loop. The spawn
//!      path is synchronous, so it reads from the in-process cache here (not the
//!      async `PreferencesStore`).
//!   2. [`crate::composio_catalog`] uses it to browse the user's toolkits.
//!
//! Placement note (Core vs Gateway): this is a user-supplied credential for
//! reaching the user's own Composio account — *what the user picked*, not org
//! policy — so it lives in Core. The key is never logged.

use std::sync::RwLock;

/// Preferences key the desktop writes; Core loads it on startup and on change.
pub const COMPOSIO_API_KEY_PREF_KEY: &str = "composio-api-key";

/// Crate-local serialization for tests that mutate the process-global key cache
/// and the `RYU_COMPOSIO_API_KEY` / `COMPOSIO_API_KEY` env (auth + execute run in
/// one test binary in parallel). Poison-tolerant. Formerly Core's
/// `sidecar::gateway::lock_managed_node_env`; the two crates run in separate test
/// binaries now, so an intra-crate lock is sufficient.
#[cfg(test)]
pub(crate) fn test_env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// In-process key cache, populated from preferences. `None` falls back to env.
static COMPOSIO_KEY: RwLock<Option<String>> = RwLock::new(None);

/// Set (or clear, when empty) the in-process key from a preferences value.
pub fn set_key(key: &str) {
    let trimmed = key.trim();
    if let Ok(mut guard) = COMPOSIO_KEY.write() {
        *guard = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
    }
}

/// Resolve the active key: preferences (in-process) first, then env
/// (`RYU_COMPOSIO_API_KEY` preferred so an operator override beats a stray
/// `COMPOSIO_API_KEY`).
pub fn key() -> Option<String> {
    if let Ok(guard) = COMPOSIO_KEY.read() {
        if let Some(k) = guard.as_ref() {
            return Some(k.clone());
        }
    }
    std::env::var("RYU_COMPOSIO_API_KEY")
        .or_else(|_| std::env::var("COMPOSIO_API_KEY"))
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

/// True when a Composio key is configured (preferences or env).
pub fn is_configured() -> bool {
    key().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_then_clear_key() {
        // The auth key cache + RYU_COMPOSIO_API_KEY/COMPOSIO_API_KEY env are
        // process-global and touched by tests in other modules (gateway
        // managed-node, mcp catalog/composio); serialize on the shared lock so
        // none reads another's transient value.
        let _lock = test_env_lock();
        set_key("  comp_abc123  ");
        assert_eq!(key().as_deref(), Some("comp_abc123"));
        set_key("   ");
        // Falls back to env (unset in tests) → None.
        std::env::remove_var("RYU_COMPOSIO_API_KEY");
        std::env::remove_var("COMPOSIO_API_KEY");
        assert_eq!(key(), None);
    }
}
