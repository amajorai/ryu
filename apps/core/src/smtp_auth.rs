//! SMTP password (BYOK) resolution for the Core email sink.
//!
//! Mirrors [`crate::hf_auth`] byte-for-byte: a process-global secret resolved
//! **preferences-first** — the user sets it in desktop Settings, persisted to
//! `~/.ryu/preferences.db` under [`SMTP_PASSWORD_PREF_KEY`] — then falls back to
//! the `RYU_SMTP_PASSWORD` environment variable for headless / self-host setups.
//!
//! Placement note (Core vs Gateway): this is a user-supplied credential for the
//! node's own mail transport — *what the user picked*, not org policy — so it
//! lives in Core alongside the other `*_auth.rs` BYO-key siblings. It is never
//! logged.

use std::sync::RwLock;

/// Preferences key the desktop writes; Core loads it on startup and on change.
pub const SMTP_PASSWORD_PREF_KEY: &str = "smtp-password";

/// In-process secret cache, populated from preferences. `None` falls back to env.
static SMTP_PASSWORD: RwLock<Option<String>> = RwLock::new(None);

/// Set (or clear, when empty) the in-process password from a preferences value.
pub fn set_password(password: &str) {
    let trimmed = password.trim();
    if let Ok(mut guard) = SMTP_PASSWORD.write() {
        *guard = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
    }
}

/// Resolve the active password: preferences (in-process) first, then
/// `RYU_SMTP_PASSWORD` env.
pub fn password() -> Option<String> {
    if let Ok(guard) = SMTP_PASSWORD.read() {
        if let Some(p) = guard.as_ref() {
            return Some(p.clone());
        }
    }
    std::env::var("RYU_SMTP_PASSWORD")
        .ok()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_then_clear_password() {
        set_password("  s3cret  ");
        assert_eq!(password().as_deref(), Some("s3cret"));
        set_password("   ");
        std::env::remove_var("RYU_SMTP_PASSWORD");
        assert_eq!(password(), None);
    }
}
