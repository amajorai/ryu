//! Node init, sidecar install and status, support diagnostics and active engine/model selection.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod node_init;
pub(in crate::server) use node_init::*;
mod install_sidecar;
pub(in crate::server) use install_sidecar::*;
mod sidecar_downloaders;
pub(in crate::server) use sidecar_downloaders::*;
mod sidecar_lifecycle;
pub(in crate::server) use sidecar_lifecycle::*;
mod support_diagnostics;
pub(in crate::server) use support_diagnostics::*;
mod llamacpp_acceleration;
pub(in crate::server) use llamacpp_acceleration::*;
mod active_model;
pub(in crate::server) use active_model::*;
