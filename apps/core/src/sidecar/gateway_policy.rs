//! Gateway **policy plugin** flags (M2 / #447).
//!
//! Headroom compression proved the pattern: a Core `Policy` runnable is a thin
//! on/off switch that flips a process-global flag which `gateway_spawn_env`
//! reads to inject the corresponding `GATEWAY_*` env on the next gateway spawn,
//! and a `gateway.refresh()` respawns the gateway to apply it. The gateway owns
//! enforcement (firewall scanning, smart routing); Core only decides whether the
//! feature is active for this install — the Core-vs-Gateway rule.
//!
//! This module generalises that pattern to the other boolean-shaped gateway
//! policies so they can be declared as `Policy` runnables on the same contract:
//!
//! - **firewall** (`GATEWAY_FIREWALL_ENABLED`) — force the gateway firewall on.
//! - **routing** (`GATEWAY_SMART_ROUTING_ENABLED`) — force smart (classifier)
//!   routing on. The plugin is an on/off switch over the existing rich
//!   `RoutingConfig.smart_routing` (model_map + ordered rules), NOT a
//!   replacement for it — the rules stay owned by `/v1/config`.
//!
//! Each flag is a `OnceLock<AtomicBool>` lazily seeded from a dev env var so an
//! operator can still force the feature on out of the box; thereafter the
//! plugin's persisted enabled state owns it (set at startup from the
//! `PluginStore`, and on plugin enable/disable). One source of truth, so a
//! gateway restart never silently reverts what the plugin set.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

/// Plugin id of the built-in gateway-firewall policy plugin.
pub const FIREWALL_PLUGIN_ID: &str = "io.ryu.firewall";
/// Plugin id of the built-in smart-routing policy plugin.
pub const ROUTING_PLUGIN_ID: &str = "io.ryu.routing";

/// Dev seed env var for the firewall policy (default off — opt-in).
const ENV_FIREWALL_SEED: &str = "GATEWAY_FIREWALL_ENABLED";
/// Dev seed env var for the smart-routing policy (default off — opt-in).
const ENV_ROUTING_SEED: &str = "GATEWAY_SMART_ROUTING_ENABLED";

static FIREWALL_ENABLED: OnceLock<AtomicBool> = OnceLock::new();
static ROUTING_ENABLED: OnceLock<AtomicBool> = OnceLock::new();

fn env_truthy(name: &str) -> bool {
    matches!(
        std::env::var(name)
            .map(|v| v.trim().to_ascii_lowercase())
            .as_deref(),
        Ok("1" | "true" | "yes" | "on")
    )
}

fn firewall_flag() -> &'static AtomicBool {
    FIREWALL_ENABLED.get_or_init(|| AtomicBool::new(env_truthy(ENV_FIREWALL_SEED)))
}

fn routing_flag() -> &'static AtomicBool {
    ROUTING_ENABLED.get_or_init(|| AtomicBool::new(env_truthy(ENV_ROUTING_SEED)))
}

/// Whether the gateway-firewall policy plugin is currently active.
pub fn firewall_enabled() -> bool {
    firewall_flag().load(Ordering::Relaxed)
}

/// Set whether the gateway-firewall policy is active. The caller is responsible
/// for refreshing the gateway so `gateway_spawn_env` re-reads this flag.
pub fn set_firewall_enabled(active: bool) {
    firewall_flag().store(active, Ordering::Relaxed);
}

/// Whether the smart-routing policy plugin is currently active.
pub fn routing_enabled() -> bool {
    routing_flag().load(Ordering::Relaxed)
}

/// Set whether smart routing is active. The caller refreshes the gateway so
/// `gateway_spawn_env` re-reads this flag.
pub fn set_routing_enabled(active: bool) {
    routing_flag().store(active, Ordering::Relaxed);
}

/// Shared, poison-tolerant lock serializing EVERY test — in ANY module — that
/// mutates or reads the process-global gateway-policy flags (firewall / routing
/// here, plus `headroom::is_enabled` and `sandbox::is_enabled`, which
/// `gateway_spawn_env` folds into the same surface). cargo runs tests in one
/// process in parallel, so a test that flips a flag ON can be observed by another
/// mid-assertion unless both hold this one lock.
#[cfg(test)]
pub(crate) static POLICY_FLAGS_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Acquire [`POLICY_FLAGS_TEST_LOCK`], recovering a poisoned guard.
#[cfg(test)]
pub(crate) fn lock_policy_flags() -> std::sync::MutexGuard<'static, ()> {
    POLICY_FLAGS_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn firewall_flag_toggles() {
        let _lock = lock_policy_flags();
        let prev = firewall_enabled();
        set_firewall_enabled(true);
        assert!(firewall_enabled());
        set_firewall_enabled(false);
        assert!(!firewall_enabled());
        set_firewall_enabled(prev);
    }

    #[test]
    fn routing_flag_toggles() {
        let _lock = lock_policy_flags();
        let prev = routing_enabled();
        set_routing_enabled(true);
        assert!(routing_enabled());
        set_routing_enabled(false);
        assert!(!routing_enabled());
        set_routing_enabled(prev);
    }
}
