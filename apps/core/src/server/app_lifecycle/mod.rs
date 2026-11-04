//! App lifecycle handlers: isolation, revocation, install, enable, activation, contributions and policies.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod isolation_revocation;
pub(in crate::server) use isolation_revocation::*;
mod install_app;
pub(in crate::server) use install_app::*;
mod enable_app;
pub(in crate::server) use enable_app::*;
mod activate_plugin;
pub(in crate::server) use activate_plugin::*;
mod runnable_registry;
pub(in crate::server) use runnable_registry::*;
mod fire_activation;
pub use fire_activation::*;
mod plugin_collect;
pub(in crate::server) use plugin_collect::*;
mod plugin_contributions;
pub(in crate::server) use plugin_contributions::*;
mod contribution_rows;
pub(in crate::server) use contribution_rows::*;
mod policy_apply;
pub(in crate::server) use policy_apply::*;
mod runtime_provision;
pub(in crate::server) use runtime_provision::*;
mod sidecars_apply;
pub use sidecars_apply::*;
mod app_grants;
pub(in crate::server) use app_grants::*;
