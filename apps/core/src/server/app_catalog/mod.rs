//! App catalog browse, install-from-URL and hot reload.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod app_catalog_browse;
pub(in crate::server) use app_catalog_browse::*;
mod plugin_catalog;
pub(in crate::server) use plugin_catalog::*;
mod catalog_browse;
pub(in crate::server) use catalog_browse::*;
mod plugin_detail;
pub(in crate::server) use plugin_detail::*;
mod catalog_versions;
pub(crate) use catalog_versions::*;
mod plugin_manifest;
pub(in crate::server) use plugin_manifest::*;
mod merge_plugin;
pub(in crate::server) use merge_plugin::*;
mod plugin_marketplace;
pub(crate) use plugin_marketplace::*;
mod screen_guarded;
pub(in crate::server) use screen_guarded::*;
mod install_app;
pub(in crate::server) use install_app::*;
mod install_bundle;
pub(in crate::server) use install_bundle::*;
mod installed_plugin;
pub(in crate::server) use installed_plugin::*;
mod plugin_install;
pub(crate) use plugin_install::*;
mod install_plugin;
pub(in crate::server) use install_plugin::*;
mod official_plugins;
pub use official_plugins::*;
mod catalog_resolve;
pub(in crate::server) use catalog_resolve::*;
