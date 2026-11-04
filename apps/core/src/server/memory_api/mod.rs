//! Retrieval handlers and the memory management API.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod retrieval;
pub(in crate::server) use retrieval::*;
mod search_retrieval;
pub(in crate::server) use search_retrieval::*;
mod memory_management_api;
pub(crate) use memory_management_api::*;
mod memory_refresh;
pub(in crate::server) use memory_refresh::*;
