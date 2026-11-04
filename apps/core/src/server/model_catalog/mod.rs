//! Vault route builders, shared JSON helpers, the model catalog and Composio integrations.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod vault_routes_and_helpers;
pub(in crate::server) use vault_routes_and_helpers::*;
mod health_and_catalog;
pub(in crate::server) use health_and_catalog::*;
mod merged_integrations;
pub(crate) use merged_integrations::*;
mod composio_integrations;
pub(in crate::server) use composio_integrations::*;
mod composio_connection;
pub(in crate::server) use composio_connection::*;
mod composio_trigger;
pub(in crate::server) use composio_trigger::*;
mod composio_webhooks;
pub(in crate::server) use composio_webhooks::*;
mod models_catalog;
pub(in crate::server) use models_catalog::*;
mod models_updates;
pub(in crate::server) use models_updates::*;
