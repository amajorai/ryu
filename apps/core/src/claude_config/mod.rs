//! Claude Code gateway-routing toggle (subscription-preserving egress
//! governance) and process entrypoint labeling for Ryu-spawned runs.
//!
//! Claude Code (`acp:claude`) speaks the Anthropic Messages wire format and, on a
//! Pro/Max **subscription**, authenticates with the user's own OAuth bearer — not
//! an API key. Its LLM egress therefore bypasses the Ryu gateway unless the user
//! explicitly opts in. This toggle controls routing that egress
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
//! On by default for a newly installed ACP agent, matching the governed baseline
//! for routable agents. Because this changes how the user's subscription
//! credential flows, the UI keeps a clear per-agent direct-egress opt-out.
//! Mirrors [`crate::composio_auth`]: a process-global flag seeded from the
//! `claude-gateway-routing` preference at startup and on change, read
//! synchronously on the (sync) spawn path.

mod entrypoint;

#[cfg(test)]
pub use entrypoint::DEFAULT as DEFAULT_CLAUDE_CODE_ENTRYPOINT;
pub use entrypoint::{
    apply_to_provider_cli_command, config_dir_from_env, process_config_dir,
    resolve as resolve_entrypoint, ENV_VAR as CLAUDE_CODE_ENTRYPOINT_ENV,
};

use std::sync::atomic::{AtomicBool, Ordering};

/// Preferences key the desktop writes; Core loads it on startup and on change.
pub const CLAUDE_GATEWAY_ROUTING_PREF_KEY: &str = "claude-gateway-routing";

/// Shared default for ACP subscription egress: Gateway-governed traffic until
/// the user explicitly opts this agent out.
pub const DEFAULT_CLAUDE_GATEWAY_ROUTING: bool = crate::agent_routing::DEFAULT_GATEWAY_ROUTING;

/// In-process flag, populated from preferences. Defaults to `true`; an explicit
/// preference value of `false` is the user's direct-egress opt-out.
static GATEWAY_ROUTING: AtomicBool = AtomicBool::new(DEFAULT_CLAUDE_GATEWAY_ROUTING);

/// Set the in-process flag from a preferences value. Accepts the common truthy
/// string forms the desktop may persist (`"true"`, `"1"`, `"on"`).
pub fn set_enabled(value: &str) {
    let on = match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "on" | "yes" => true,
        "false" | "0" | "off" | "no" => false,
        _ => DEFAULT_CLAUDE_GATEWAY_ROUTING,
    };
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

    #[test]
    fn missing_or_unparseable_preference_keeps_governed_default() {
        set_enabled("");
        assert!(is_gateway_routing());
        set_enabled("not-a-boolean");
        assert!(is_gateway_routing());
    }
}
