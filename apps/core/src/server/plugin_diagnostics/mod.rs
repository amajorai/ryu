//! The installed-app projection, plugin doctor and plugin eval runs.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod apps_projection;
pub(in crate::server) use apps_projection::*;
mod plugin_doctor;
pub(in crate::server) use plugin_doctor::*;
mod plugin_eval;
pub(in crate::server) use plugin_eval::*;
mod eval_grade;
pub(in crate::server) use eval_grade::*;
mod plugin_evals;
pub(in crate::server) use plugin_evals::*;
