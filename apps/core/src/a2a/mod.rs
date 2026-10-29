//! A2A v1 inbound server and outbound peer-management surface.
//!
//! Public protocol routes authenticate with per-peer A2A credentials inside
//! their handlers. Management routes are merged into Core's existing protected
//! router and therefore use the node's normal authentication middleware.

mod api;
#[cfg(test)]
mod api_tests;
mod card_assets;
mod outbound;
mod runtime;

pub use api::{management_routes, public_routes};
pub(crate) use outbound::{request_cancel, request_cancel_all, route_peer_chat};
#[cfg(test)]
pub(crate) use runtime::test_support;
