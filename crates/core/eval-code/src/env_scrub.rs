//! Child-process environment scrubbing (security, defense-in-depth).
//!
//! This is a focused copy of the deny-list `scrub_child_env` from
//! `apps/core/src/sidecar/env_scrub.rs` — a generic, zero-drift credential
//! filter (a fixed marker list, not business logic). It is duplicated rather
//! than shared so this crate keeps ZERO dependency on `apps/core` (the
//! extracted-crate standard, matching `win_process.rs`); Core keeps its own copy
//! for its ~dozen other spawn sites. Only the deny-list strategy is carried here
//! (the un-sandboxed host `python` fallback needs a mostly-normal env minus
//! secrets); the MCP allow-list strategy is not used by code evaluators.

/// Case-insensitive substrings that mark an env KEY as secret-like. Matched as an
/// uppercase-contains check so we never compile a regex per call.
const SENSITIVE_MARKERS: [&str; 7] = [
    "KEY",
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "CREDENTIAL",
    "AUTH",
];

/// Whether an env KEY is secret-like (contains any [`SENSITIVE_MARKERS`] token,
/// case-insensitive).
fn is_sensitive_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    SENSITIVE_MARKERS.iter().any(|m| upper.contains(m))
}

/// Deny-list scrub: drop every var whose KEY matches (case-insensitive) any of
/// `KEY`/`TOKEN`/`SECRET`/`PASSWORD`/`PASSWD`/`CREDENTIAL`/`AUTH`, UNLESS the key
/// is in `extra_allow` (exact, case-insensitive). Everything non-secret-like is
/// kept, so the child gets a normal-looking env minus credentials.
pub fn scrub_child_env(
    base: impl IntoIterator<Item = (String, String)>,
    extra_allow: &[&str],
) -> Vec<(String, String)> {
    base.into_iter()
        .filter(|(key, _)| {
            if !is_sensitive_key(key) {
                return true;
            }
            // Secret-like, but the caller explicitly re-allows it (a var the child
            // genuinely needs whose name happens to trip a marker).
            extra_allow
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(key))
        })
        .collect()
}
