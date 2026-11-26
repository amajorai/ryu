//! Reads the node's "Credit Ryu in git commits" preference for the commits
//! Core itself makes. The trailer and the parsing rule live in
//! `ryu_workspace::git`; this is only the lookup in Core's preference store.

use ryu_workspace::git::{git_credit_ryu, DEFAULT_GIT_CREDIT_RYU, GIT_CREDIT_RYU_PREF_KEY};

use crate::server::preferences::PreferencesStore;

/// Whether commits Ryu makes on this node carry the co-author trailer. A
/// missing preference reads as on; so does a store that cannot be read, so a
/// transient read failure never silently changes what a commit says.
pub(crate) async fn git_credit_enabled(preferences: &PreferencesStore) -> bool {
    match preferences.get(GIT_CREDIT_RYU_PREF_KEY).await {
        Ok(value) => git_credit_ryu(value.as_deref()),
        Err(error) => {
            tracing::warn!(
                error = %error,
                "could not read the git credit preference; using the default"
            );
            DEFAULT_GIT_CREDIT_RYU
        }
    }
}

/// The same lookup for commit sites that hold no `ServerState` (the Box finish
/// path): it reads through the process-wide preference store.
pub(crate) async fn git_credit_enabled_for_node() -> bool {
    match PreferencesStore::open_default() {
        Ok(preferences) => git_credit_enabled(&preferences).await,
        Err(error) => {
            tracing::warn!(
                error = %error,
                "could not open the preference store for git credit; using the default"
            );
            DEFAULT_GIT_CREDIT_RYU
        }
    }
}

#[cfg(test)]
#[path = "credit_tests.rs"]
mod tests;
