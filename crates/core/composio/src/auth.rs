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
//!
//! Managed nodes (D8): a Ryu-managed node never holds a Ryu Composio key. Its
//! process env is provisioned by Ryu, so a key found there would be Ryu's, and
//! the env fallback is therefore ignored when [`MANAGED_NODE_ENV`] is truthy.
//! Composio on a managed node runs through the Connect service
//! ([`crate::service`]), which holds the tenant credential off the node. A key
//! the tenant saved in Settings (the preference cache) is the tenant's own and
//! still resolves.

use std::sync::RwLock;

/// Env flag marking this Core as a Ryu-managed node. Same name and truthy rule
/// as Core's `sidecar::gateway::managed_node`; this crate cannot depend on
/// `apps/core`, so it reads the flag itself.
pub const MANAGED_NODE_ENV: &str = "RYU_MANAGED_NODE";

/// Whether [`MANAGED_NODE_ENV`] is truthy (`1` / `true` / `yes`, any case).
pub fn managed_node() -> bool {
    matches!(
        std::env::var(MANAGED_NODE_ENV)
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

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
/// `COMPOSIO_API_KEY`). On a managed node only the preference source counts;
/// an env key there is Ryu's and is never used (see the module docs).
pub fn key() -> Option<String> {
    if let Ok(guard) = COMPOSIO_KEY.read() {
        if let Some(k) = guard.as_ref() {
            return Some(k.clone());
        }
    }
    if managed_node() {
        return None;
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

    type KeyEnv = (Option<String>, Option<String>, Option<String>);

    /// Snapshot + restore the two key env vars and the managed-node flag so a
    /// test that mutates them does not leak into another test in the same
    /// binary. The flag is cleared on capture so a runner that exports it
    /// cannot flip the self-hosted assertions below.
    fn take_key_env() -> KeyEnv {
        let prev = (
            std::env::var("RYU_COMPOSIO_API_KEY").ok(),
            std::env::var("COMPOSIO_API_KEY").ok(),
            std::env::var(MANAGED_NODE_ENV).ok(),
        );
        std::env::remove_var(MANAGED_NODE_ENV);
        prev
    }
    fn restore_key_env(prev: KeyEnv) {
        for (name, value) in [
            ("RYU_COMPOSIO_API_KEY", prev.0),
            ("COMPOSIO_API_KEY", prev.1),
            (MANAGED_NODE_ENV, prev.2),
        ] {
            match value {
                Some(v) => std::env::set_var(name, v),
                None => std::env::remove_var(name),
            }
        }
    }

    #[test]
    fn managed_node_ignores_ryu_env_key_and_keeps_tenant_preference() {
        let _lock = test_env_lock();
        let prev = take_key_env();
        set_key("");
        std::env::set_var("RYU_COMPOSIO_API_KEY", "env_prefixed_key");
        std::env::set_var("COMPOSIO_API_KEY", "env_plain_key");
        std::env::set_var(MANAGED_NODE_ENV, " Yes ");
        assert!(managed_node());
        // Env keys on a managed node are Ryu's: never resolved, never configured,
        // so every Core-direct Composio path falls through to Connect.
        assert_eq!(key(), None);
        assert!(!is_configured());
        // A key the tenant saved in Settings is the tenant's own and resolves.
        set_key("tenant_pref_key");
        assert_eq!(key().as_deref(), Some("tenant_pref_key"));
        set_key("");
        // Falsy flag values leave the self-hosted env fallback in place.
        std::env::set_var(MANAGED_NODE_ENV, "0");
        assert!(!managed_node());
        assert_eq!(key().as_deref(), Some("env_prefixed_key"));
        restore_key_env(prev);
    }

    #[test]
    fn set_then_clear_key() {
        // The auth key cache + RYU_COMPOSIO_API_KEY/COMPOSIO_API_KEY env are
        // process-global and touched by tests in other modules (gateway
        // managed-node, mcp catalog/composio); serialize on the shared lock so
        // none reads another's transient value.
        let _lock = test_env_lock();
        let prev = take_key_env();
        set_key("  comp_abc123  ");
        assert_eq!(key().as_deref(), Some("comp_abc123"));
        set_key("   ");
        // Falls back to env (unset in tests) → None.
        std::env::remove_var("RYU_COMPOSIO_API_KEY");
        std::env::remove_var("COMPOSIO_API_KEY");
        assert_eq!(key(), None);
        assert!(!is_configured());
        restore_key_env(prev);
    }

    #[test]
    fn env_fallback_prefers_ryu_prefixed_and_trims() {
        let _lock = test_env_lock();
        let prev = take_key_env();
        // Clear the in-process cache so the env branch is what resolves.
        set_key("");
        std::env::set_var("RYU_COMPOSIO_API_KEY", "  ryu_key  ");
        std::env::set_var("COMPOSIO_API_KEY", "plain_key");
        // RYU_-prefixed wins over the plain env, and surrounding space is trimmed.
        assert_eq!(key().as_deref(), Some("ryu_key"));
        assert!(is_configured());

        // With only the plain env set, it resolves.
        std::env::remove_var("RYU_COMPOSIO_API_KEY");
        assert_eq!(key().as_deref(), Some("plain_key"));

        // An all-whitespace env value is filtered back to None (not configured).
        std::env::set_var("COMPOSIO_API_KEY", "   ");
        assert_eq!(key(), None);
        assert!(!is_configured());
        restore_key_env(prev);
    }

    #[test]
    fn preferences_cache_beats_env() {
        let _lock = test_env_lock();
        let prev = take_key_env();
        std::env::set_var("COMPOSIO_API_KEY", "env_key");
        set_key("pref_key");
        // The in-process (preferences) cache is consulted first.
        assert_eq!(key().as_deref(), Some("pref_key"));
        // Clearing it falls through to env.
        set_key("");
        assert_eq!(key().as_deref(), Some("env_key"));
        set_key("");
        restore_key_env(prev);
    }
}
