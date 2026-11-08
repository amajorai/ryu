//! The network MCP surface and the command-approval exec scan.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod network_mcp_surface;
pub(in crate::server) use network_mcp_surface::*;
mod mcp_http;
pub(in crate::server) use mcp_http::*;
mod mcp_http_handler;
pub(in crate::server) use mcp_http_handler::*;
mod verified_dispatch;
mod command_approval_scan;
pub(in crate::server) use command_approval_scan::*;
