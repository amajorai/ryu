//! Claude Code gateway-routing toggle (subscription-preserving egress
//! governance).
//!
//! Claude Code (`acp:claude`) speaks the Anthropic Messages wire format and, on a
//! Pro/Max **subscription**, authenticates with the user's own OAuth bearer — not
//! an API key. Its LLM egress therefore bypasses the Ryu gateway by default
//! (`gateway_bypass: true`). This toggle opts the user into routing that egress
//! through the gateway's **transparent passthrough proxy**
//! (`apps/gateway/src/passthrough`): Core injects `ANTHROPIC_BASE_URL` at spawn so
//! Claude Code's internal HTTP client points at the gateway, which forwards the
//! caller's own subscription bearer upstream UNCHANGED while applying request-side
//! DLP + audit.
//!
//! **Subscription-preservation rule:** we inject ONLY `ANTHROPIC_BASE_URL`. We
//! must never set `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` — either would take
//! precedence over the subscription OAuth and flip Claude Code onto API-key
//! billing. The injection is in [`crate::sidecar::adapters::acp::claude_gateway_cmd`].
//!
//! Off by default (opt-in): unlike the managed Pi (which defaults to gateway-
//! routed), enabling this changes how the user's subscription credential flows, so
//! the user must choose it explicitly. Mirrors [`crate::composio_auth`]: a
//! process-global flag seeded from the `claude-gateway-routing` preference at
//! startup and on change, read synchronously on the (sync) spawn path.

use std::sync::atomic::{AtomicBool, Ordering};

/// Preferences key the desktop writes; Core loads it on startup and on change.
pub const CLAUDE_GATEWAY_ROUTING_PREF_KEY: &str = "claude-gateway-routing";

/// In-process flag, populated from preferences. Defaults to `false` (opt-in).
static GATEWAY_ROUTING: AtomicBool = AtomicBool::new(false);

/// Set the in-process flag from a preferences value. Accepts the common truthy
/// string forms the desktop may persist (`"true"`, `"1"`, `"on"`).
pub fn set_enabled(value: &str) {
    let on = matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "true" | "1" | "on" | "yes"
    );
    GATEWAY_ROUTING.store(on, Ordering::Relaxed);
}

/// Whether Claude Code should route its egress through the Ryu gateway passthrough
/// proxy. Read on the synchronous spawn path.
pub fn is_gateway_routing() -> bool {
    GATEWAY_ROUTING.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggle_parses_truthy_forms() {
        set_enabled("true");
        assert!(is_gateway_routing());
        set_enabled("false");
        assert!(!is_gateway_routing());
        set_enabled("  ON ");
        assert!(is_gateway_routing());
        set_enabled("0");
        assert!(!is_gateway_routing());
    }
}
