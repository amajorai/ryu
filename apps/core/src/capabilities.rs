//! Node capability advertisement.
//!
//! Clients negotiate features by asking a node what it supports (via `/api/health`)
//! rather than maintaining a version-compatibility matrix. A new desktop degrades
//! gracefully against an older node by checking these flags instead of version numbers.
//!
//! Rule: this list is **additive**. Add a flag when you ship a feature clients should
//! gate on; never remove one an older client may still check.

/// Stable feature flags this Core build supports.
pub const CAPABILITIES: &[&str] = &[
    "chat",
    "agents",
    "teams",
    "threads",
    "workflows",
    "spaces",
    "memory",
    "auto-recall",
    "monitors",
    "meetings",
    "quests",
    "approvals",
    "tools-exec",
    "mcp",
    "mesh",
    "webhook-ingress",
    "recipes",
    "predict",
    "skills",
    "models-catalog",
    "voice",
    "images",
];

/// Core's own version (`CARGO_PKG_VERSION`), surfaced in `/api/health` so a client
/// can apply a minimum-version floor without a second round-trip.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_are_unique_and_nonempty() {
        assert!(!CAPABILITIES.is_empty());
        let mut seen = std::collections::HashSet::new();
        for c in CAPABILITIES {
            assert!(!c.is_empty(), "empty capability flag");
            assert!(seen.insert(*c), "duplicate capability: {c}");
        }
    }

    #[test]
    fn version_matches_cargo() {
        assert_eq!(version(), env!("CARGO_PKG_VERSION"));
    }
}
