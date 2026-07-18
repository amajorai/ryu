//! Audit stage — extracted to the `ryu-gw-audit` crate (decomposition W6).
//!
//! The SQLite-backed [`AuditLogger`], the swappable [`AuditBackend`] trait +
//! [`AuditRegistry`], the record/query/summary value-types, and the
//! [`AuditConfig`] serde shape all live in the `ryu-gw-audit` crate. Keeping
//! `crate::audit::…` re-exported here (so every call site — pipeline logging,
//! the `/audit` API handler, `state.rs` wiring) stays byte-unchanged means the
//! extraction is invisible to the rest of the gateway.
pub use ryu_gw_audit::*;
