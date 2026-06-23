//! Generic per-agent gateway-routing toggle (the "point any agent at the Ryu
//! gateway via the OpenAI base-URL swap" lever).
//!
//! The three first-class agents that can route through the gateway each have a
//! dedicated config module: the managed Pi ([`crate::pi_config`], default ON),
//! Claude Code ([`crate::claude_config`], opt-in, Anthropic passthrough) and
//! Codex ([`crate::codex_config`], opt-in, ChatGPT-login passthrough). This
//! module is the *generic* equivalent for **any other ACP agent** — most
//! importantly a BYO OpenAI-compatible agent the user added themselves
//! (`engine = "acp-exec:<command>"`).
//!
//! When enabled for an agent, Core injects `OPENAI_BASE_URL` (the local gateway
//! `/v1`) + `OPENAI_API_KEY` (the gateway token) into that agent's spawn command
//! (see [`crate::sidecar::adapters::acp::openai_gateway_cmd`]), so an agent whose
//! HTTP client honours the OpenAI base URL sends its model calls through the
//! gateway's firewall/budget/audit pipeline instead of straight to a provider.
//!
//! **Honest scope:** this is a genuine no-op for ACP agents that do NOT read
//! `OPENAI_BASE_URL` (Gemini CLI speaks Google format; OpenClaw talks to its own
//! WebSocket gateway; Hermes uses its own creds; even the managed Pi ignores the
//! env var and is routed via its `models.json` instead). The toggle is therefore
//! surfaced primarily for the `acp-exec:` BYO path, where it does exactly what the
//! user asked: swap the agent's OpenAI-compatible endpoint to ours, automatically,
//! with no manual env wiring.
//!
//! Storage mirrors the claude/codex toggles but, because the key is per-agent,
//! the whole set lives under ONE preference (`agent-gateway-routing`) holding a
//! JSON object `{ "<agent_id>": true, ... }`. Core seeds an in-process map from it
//! at startup and on change, read synchronously on the (sync) spawn path.

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

/// Preferences key the desktop writes; Core loads it on startup and on change.
/// The value is a JSON object mapping agent id → enabled boolean.
pub const AGENT_GATEWAY_ROUTING_PREF_KEY: &str = "agent-gateway-routing";

/// In-process map of agent id → gateway-routing enabled, populated from the
/// preference. A missing entry means OFF (opt-in), matching the claude/codex
/// defaults.
fn routing_map() -> &'static RwLock<HashMap<String, bool>> {
    static MAP: OnceLock<RwLock<HashMap<String, bool>>> = OnceLock::new();
    MAP.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Coerce one of the truthy string forms the desktop may persist into a bool.
fn truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "true" | "1" | "on" | "yes"
    )
}

/// Replace the in-process map from the persisted preference value (a JSON object
/// of agent id → boolean, or one of the truthy string forms per value). A blank
/// or unparseable value clears the map (everything reverts to OFF) rather than
/// erroring — the spawn path must never panic.
pub fn set_from_json(value: &str) {
    let mut next: HashMap<String, bool> = HashMap::new();
    let trimmed = value.trim();
    if !trimmed.is_empty() {
        if let Ok(serde_json::Value::Object(obj)) = serde_json::from_str(trimmed) {
            for (id, raw) in obj {
                let on = match raw {
                    serde_json::Value::Bool(b) => b,
                    serde_json::Value::String(s) => truthy(&s),
                    serde_json::Value::Number(n) => n.as_i64().is_some_and(|v| v != 0),
                    _ => false,
                };
                next.insert(id, on);
            }
        }
    }
    if let Ok(mut guard) = routing_map().write() {
        *guard = next;
    }
}

/// Whether `agent_id` should route its egress through the Ryu gateway via the
/// OpenAI base-URL swap. Read on the synchronous spawn path; defaults to OFF.
pub fn is_gateway_routing(agent_id: &str) -> bool {
    routing_map()
        .read()
        .ok()
        .and_then(|m| m.get(agent_id).copied())
        .unwrap_or(false)
}

/// Serializes every test that mutates the process-global routing map (one map is
/// shared across the whole test binary, including `sidecar::adapters`' wiring
/// test). Without it, parallel `set_from_json` calls clobber each other's state
/// between a set and its assert. Poison-tolerant: a panic mid-test must not wedge
/// the rest.
#[cfg(test)]
pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_map_toggles_per_agent() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_from_json(r#"{"my-byo-agent": true, "other": false, "truthy": "on"}"#);
        assert!(is_gateway_routing("my-byo-agent"));
        assert!(is_gateway_routing("truthy"));
        assert!(!is_gateway_routing("other"));
        // Unknown agents default to OFF.
        assert!(!is_gateway_routing("never-seen"));
    }

    #[test]
    fn blank_or_garbage_clears_to_off() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_from_json(r#"{"x": true}"#);
        assert!(is_gateway_routing("x"));
        set_from_json("");
        assert!(!is_gateway_routing("x"));
        set_from_json("not json at all");
        assert!(!is_gateway_routing("x"));
    }
}
