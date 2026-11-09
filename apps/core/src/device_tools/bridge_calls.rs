//! Bridge-side correlation of ACP device calls (design §0.9, §3.1).
//!
//! On the ACP plane the agent, not Core, renders its own `tool_call` frames,
//! with `rawInput` / `rawOutput` echoing the device arguments and result. The
//! title is the agent's choice, so recognizing a device call by its tool name
//! (`agent_events::device_tool_in_title`) is not enough. The in-process MCP
//! bridge therefore records every device call it dispatches on the turn's
//! offer: the raw arguments the agent sent, then the envelope it returned.
//! The turn's `AgentToolFilter` matches the agent's frames against this
//! ledger, so a device call is redacted whatever the agent titles it.

use std::sync::Mutex;

use serde_json::Value;

use super::catalog::CatalogTool;

/// Device calls per turn are capped at 10 (`offer::MAX_CALLS_PER_TURN`); the
/// ledger keeps a little more in case calls are refused before counting.
const MAX_CALLS: usize = 32;
/// How deep a wrapped argument object is looked for in an agent's `rawInput`.
const MAX_DEPTH: usize = 4;

#[derive(Debug)]
struct BridgeCall {
    tool: &'static CatalogTool,
    args: Value,
    envelope: Option<Value>,
}

/// What the bridge dispatched on one turn.
#[derive(Debug, Default)]
pub(crate) struct BridgeCallLedger {
    calls: Mutex<Vec<BridgeCall>>,
}

/// Arguments that say nothing (`{}` / `null`) never correlate: they would
/// match every argument-free tool, and there is nothing in them to redact.
fn informative(args: &Value) -> bool {
    match args {
        Value::Object(map) => !map.is_empty(),
        Value::Null => false,
        _ => true,
    }
}

fn contains(haystack: &Value, needle: &Value, depth: usize) -> bool {
    if haystack == needle {
        return true;
    }
    if depth >= MAX_DEPTH {
        return false;
    }
    match haystack {
        Value::Object(map) => map.values().any(|child| contains(child, needle, depth + 1)),
        Value::Array(items) => items.iter().any(|child| contains(child, needle, depth + 1)),
        // An agent may echo its arguments as a JSON string.
        Value::String(text) if text.trim_start().starts_with('{') => {
            serde_json::from_str::<Value>(text)
                .is_ok_and(|parsed| contains(&parsed, needle, depth + 1))
        }
        _ => false,
    }
}

impl BridgeCallLedger {
    /// Record a call the bridge is about to dispatch; returns its slot.
    pub(crate) fn record_args(&self, tool: &'static CatalogTool, args: &Value) -> Option<usize> {
        let mut calls = self.calls.lock().ok()?;
        if calls.len() >= MAX_CALLS {
            return None;
        }
        calls.push(BridgeCall {
            tool,
            args: args.clone(),
            envelope: None,
        });
        Some(calls.len() - 1)
    }

    /// Record the envelope the bridge returned for a slot.
    pub(crate) fn record_result(&self, slot: Option<usize>, envelope: &Value) {
        let Some(slot) = slot else {
            return;
        };
        if let Ok(mut calls) = self.calls.lock() {
            if let Some(call) = calls.get_mut(slot) {
                call.envelope = Some(envelope.clone());
            }
        }
    }

    /// The device tool whose recorded arguments an agent's `rawInput` holds
    /// (as is, wrapped in another object, or as a JSON string).
    pub(crate) fn match_input(&self, input: &Value) -> Option<&'static CatalogTool> {
        let calls = self.calls.lock().ok()?;
        calls
            .iter()
            .find(|call| informative(&call.args) && contains(input, &call.args, 0))
            .map(|call| call.tool)
    }

    /// The device tool whose recorded envelope an agent's output carries.
    pub(crate) fn match_output(&self, envelope: &Value) -> Option<&'static CatalogTool> {
        let calls = self.calls.lock().ok()?;
        calls
            .iter()
            .find(|call| call.envelope.as_ref() == Some(envelope))
            .map(|call| call.tool)
    }
}
