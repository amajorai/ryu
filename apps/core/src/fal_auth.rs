//! Fal (fal.ai) API key resolution.
//!
//! A process-global Fal API key, resolved **preferences-first** (the user sets
//! it in desktop Settings > Integrations, persisted to `~/.ryu/preferences.db`
//! under [`FAL_API_KEY_PREF_KEY`]), then falling back to the `FAL_API_KEY`
//! environment variable for headless self-hosted setups. Mirrors
//! [`crate::openrouter_auth`].
//!
//! Key presence alone activates the gateway's `fal` provider
//! (`apps/gateway/src/config.rs`). The key is never logged.
//!
//! Managed nodes (D8): a Ryu-managed node never holds a Ryu provider key. The
//! env fallback is ignored there, and the node's managed traffic goes to the
//! hosted Gateway fleet with the node's own `rgw_` credential, so no local
//! gateway is spawned and nothing is injected (`sidecar::gateway`).

use std::sync::RwLock;

/// Preferences key the desktop writes; Core loads it on startup and on change.
pub const FAL_API_KEY_PREF_KEY: &str = "fal-api-key";

/// In-process key cache, populated from preferences. `None` falls back to env.
static FAL_KEY: RwLock<Option<String>> = RwLock::new(None);

/// Set (or clear, when empty) the in-process key from a preferences value.
pub fn set_key(key: &str) {
    let trimmed = key.trim();
    if let Ok(mut guard) = FAL_KEY.write() {
        *guard = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
    }
}

/// Resolve the active key: preferences (in-process) first, then the
/// `FAL_API_KEY` env var.
pub fn key() -> Option<String> {
    if let Ok(guard) = FAL_KEY.read() {
        if let Some(k) = guard.as_ref() {
            return Some(k.clone());
        }
    }
    // D8: a managed node never holds a Ryu provider key. Its env is provisioned
    // by Ryu, so a key there would be Ryu's; only a key the tenant saved in
    // Settings (the preference cache above) is the tenant's own.
    if crate::sidecar::gateway::managed_node() {
        return None;
    }
    std::env::var("FAL_API_KEY")
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

/// True when a Fal key is configured (preferences or env).
pub fn is_configured() -> bool {
    key().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_then_clear_key() {
        // The key cache and env are process-global and also touched by the
        // gateway managed-node tests; serialize on the shared lock.
        let _lock = crate::sidecar::gateway::lock_managed_node_env();
        set_key("  fal-abc123  ");
        assert_eq!(key().as_deref(), Some("fal-abc123"));
        set_key("   ");
        std::env::remove_var("FAL_API_KEY");
        assert_eq!(key(), None);
    }
}
