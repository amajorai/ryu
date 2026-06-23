//! JSON-schema tool definitions for the programmatic-tool-calling (PTC)
//! meta-tools `execute` and `resume`.
//!
//! These are the single source of truth for both planes (Contract 4): the
//! gateway search-based loop (P2, via `/v1/exec/tool kind=execute|resume`) and
//! the ACP bridge (P3) surface the *same* defs so the model sees one consistent
//! contract regardless of which path runs it. Pure data — no I/O, fully unit
//! testable without a live Deno.

use serde_json::{json, Value};

/// The `execute` meta-tool definition. The model emits JavaScript that calls
/// tools through the injected `tools` proxy; only the final `return` value and
/// console logs come back (the context-saving PTC win — intermediate tool
/// results never re-enter the model).
pub fn execute_tool_def() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "execute",
            "description": "Run JavaScript that calls tools via the global `tools` proxy (e.g. await tools.composio.GITHUB_CREATE_ISSUE({...})). Compose many tool calls in one program; only your final `return` value and console logs are returned — intermediate tool results are NOT shown to you. Use tool_search first to discover tool paths. No fetch, no filesystem.",
            "parameters": {
                "type": "object",
                "required": ["code"],
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "JavaScript (async, top-level await ok). Plain JS preferred; light TS annotations are stripped."
                    }
                }
            }
        }
    })
}

/// The `resume` meta-tool definition. Continues a paused execution after the
/// user completed an auth/connection step or approved a gated call.
pub fn resume_tool_def() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "resume",
            "description": "Continue a paused execution after the user completed an auth/connection step or approved a gated call.",
            "parameters": {
                "type": "object",
                "required": ["executionId", "action"],
                "properties": {
                    "executionId": { "type": "string" },
                    "action": { "type": "string", "enum": ["accept", "decline", "cancel"] },
                    "content": {
                        "type": "object",
                        "description": "Form values when the pause requested a schema."
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execute_def_shape_is_stable() {
        let def = execute_tool_def();
        assert_eq!(def["type"], "function");
        assert_eq!(def["function"]["name"], "execute");
        // The single required param is `code`.
        assert_eq!(def["function"]["parameters"]["required"][0], "code");
        assert_eq!(
            def["function"]["parameters"]["properties"]["code"]["type"],
            "string"
        );
        // The description must steer the model to `tool_search` first and warn
        // that intermediate results are hidden — load-bearing for the PTC win.
        let desc = def["function"]["description"].as_str().unwrap();
        assert!(desc.contains("tool_search"));
        assert!(desc.contains("NOT shown"));
        assert!(desc.contains("No fetch"));
    }

    #[test]
    fn resume_def_shape_is_stable() {
        let def = resume_tool_def();
        assert_eq!(def["function"]["name"], "resume");
        let required = def["function"]["parameters"]["required"]
            .as_array()
            .unwrap();
        assert!(required.iter().any(|v| v == "executionId"));
        assert!(required.iter().any(|v| v == "action"));
        // The action enum is exactly accept|decline|cancel.
        let actions = def["function"]["parameters"]["properties"]["action"]["enum"]
            .as_array()
            .unwrap();
        let actions: Vec<&str> = actions.iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(actions, vec!["accept", "decline", "cancel"]);
    }
}
