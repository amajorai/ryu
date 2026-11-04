//! The unified tool catalog (search and describe) and programmatic tool calling.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod unified_tool_catalog;
pub(in crate::server) use unified_tool_catalog::*;
mod programmatic_tool_calling;
pub(in crate::server) use programmatic_tool_calling::*;
