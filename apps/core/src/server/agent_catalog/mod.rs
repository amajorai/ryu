//! Engines, personas, the agent catalog and runtime installs, and agent/prompt versioning.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod engine_models;
pub(in crate::server) use engine_models::*;
mod agent_listing;
pub(in crate::server) use agent_listing::*;
mod agent_catalog;
pub(in crate::server) use agent_catalog::*;
mod agent_install;
pub(in crate::server) use agent_install::*;
mod agent_crud;
pub(in crate::server) use agent_crud::*;
mod agent_version;
pub(in crate::server) use agent_version::*;
