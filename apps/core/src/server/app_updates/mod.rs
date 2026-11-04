//! Per-plugin BYOK secrets, app update and uninstall, and update-time dependency installs.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod per_plugin_byok;
pub(in crate::server) use per_plugin_byok::*;
mod app_disable;
pub(crate) use app_disable::*;
mod uninstall_app;
pub(in crate::server) use uninstall_app::*;
mod deactivate_plugin;
pub(in crate::server) use deactivate_plugin::*;
mod update_app;
pub(in crate::server) use update_app::*;
mod update_dependencies;
pub(in crate::server) use update_dependencies::*;
