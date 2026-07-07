//! Node-level entitlement gate for autonomous automation.
//!
//! The desktop hard paywall (epic #496) blocks the *app shell* when the trial
//! expires with no active subscription / license key. But a Core node keeps
//! running background automations (scheduled jobs → monitors, quests, workflows,
//! agent prompts) independently of any UI. Those autonomous runs consume the
//! same managed inference the paywall gates, so Core must also know the
//! entitlement state and **pause autonomous firing** when the node is not
//! entitled — otherwise a paywalled user's automations would keep spending in
//! the background.
//!
//! Mechanism mirrors [`crate::sidecar::untrusted`] and the auth resolvers
//! ([`crate::openrouter_auth`]): a process-global [`AtomicBool`] seeded from a
//! preference at startup and updated on change, read synchronously by the
//! scheduler tick. The desktop pushes the flag whenever its entitlement verdict
//! resolves (see `apps/desktop/src/hooks/useEntitlement.ts`).
//!
//! Default is **ON (active)**: a fresh node, a headless / self-hosted OSS Core,
//! or one that has never been told otherwise must run automations normally. The
//! paywall is a desktop product decision, not an OSS-Core lock — the desktop is
//! the only thing that ever writes `false` here (when its trial hard-expires).
//!
//! Placement note (Core vs Gateway): this pauses *what runs* (autonomous
//! automation) based on a state the desktop pushes; it enforces no billing
//! policy of its own and classifies nothing. It is Core orchestration config,
//! not a Gateway policy decision.

use std::sync::atomic::{AtomicBool, Ordering};

/// Preferences key the desktop writes on every entitlement verdict change; Core
/// loads it on startup and on change. Absent ⇒ the default-ON behaviour holds.
pub const ENTITLEMENT_ACTIVE_PREF_KEY: &str = "entitlement-active";

/// In-process flag, populated from preferences. Defaults to `true` (active): a
/// node with no signal must run automations normally (headless / OSS Core / a
/// desktop still within its trial or subscribed).
static ACTIVE: AtomicBool = AtomicBool::new(true);

/// Set the in-process flag from a preferences value. Accepts the common truthy
/// string forms the desktop may persist (`"true"`, `"1"`, `"on"`, `"yes"`);
/// anything else marks the node as NOT entitled (paused).
pub fn set_active(value: &str) {
    let on = matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "true" | "1" | "on" | "yes"
    );
    ACTIVE.store(on, Ordering::Relaxed);
}

/// Whether the node is currently entitled to run autonomous automations. Read on
/// the (sync) scheduler tick path. When `false`, the scheduler skips firing due
/// jobs until entitlement is restored.
pub fn is_active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_truthy_forms_and_defaults_active() {
        // Default (never set) is active.
        assert!(is_active());
        set_active("false");
        assert!(!is_active());
        set_active("true");
        assert!(is_active());
        set_active("  ON ");
        assert!(is_active());
        set_active("0");
        assert!(!is_active());
        // Anything unrecognized pauses (fail-safe toward not spending).
        set_active("paywalled");
        assert!(!is_active());
        // Restore the default-ON state so other tests are unaffected.
        set_active("true");
    }
}
