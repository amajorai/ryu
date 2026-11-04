//! Gateway config write, status and control-plane proxies.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod gateway_config_write;
pub(crate) use gateway_config_write::*;
mod gateway_write;
pub(crate) use gateway_write::*;
mod gateway_redaction;
pub(in crate::server) use gateway_redaction::*;
mod gateway_doctor;
pub(in crate::server) use gateway_doctor::*;
mod gateway_doctor_fix;
pub(in crate::server) use gateway_doctor_fix::*;
