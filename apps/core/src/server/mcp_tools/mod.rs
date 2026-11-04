//! MCP entries and tool calls from sidecars, ACP agents and host conversations.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod mcp_entry;
pub(in crate::server) use mcp_entry::*;
mod call_tool;
pub(crate) use call_tool::*;
mod host_conversation;
pub(crate) use host_conversation::*;
mod mcp_tool_call;
pub(in crate::server) use mcp_tool_call::*;
