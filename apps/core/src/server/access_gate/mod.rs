//! The App route gate, verified-caller extraction, permission enforcement and marketplace package routes.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod app_route_gate;
pub(crate) use app_route_gate::*;
mod enforce_permission;
pub(crate) use enforce_permission::*;
mod app_lifecycle_permissions;
pub(in crate::server) use app_lifecycle_permissions::*;
mod marketplace_package;
pub(in crate::server) use marketplace_package::*;
