//! A2A v1 protocol, persistence, trust, and transport-safety primitives.
//!
//! The crate deliberately has no dependency on `apps/core`. The Core server
//! supplies HTTP transport and agent execution while this crate keeps protocol
//! state and security invariants independently testable.

pub mod card_signing;
pub mod client;
pub mod model;
pub mod security;
pub mod store;

/// The Linux Foundation A2A v1 wire types used by Ryu's HTTP/JSON and JSON-RPC
/// bindings.
pub use a2a as protocol;
pub use card_signing::{
    canonicalize_json, sign_agent_card, verify_agent_card_signatures, CardSignatureStatus,
};
pub use client::*;
pub use model::*;
pub use security::*;
pub use store::{A2aStore, StoreError};
