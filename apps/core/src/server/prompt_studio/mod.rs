//! Promptfoo-compatible Prompt Studio suites.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod studio_suites;
pub(in crate::server) use studio_suites::*;
mod suite_versions;
pub(in crate::server) use suite_versions::*;
mod studio_runs;
pub(in crate::server) use studio_runs::*;
