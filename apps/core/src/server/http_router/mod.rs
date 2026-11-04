//! The HTTP router: `create_router`, the protected route table and the per-surface route builders.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod create_router;
pub use create_router::*;
mod public_table;
pub(in crate::server) use public_table::*;
mod protected_1;
pub(in crate::server) use protected_1::*;
mod protected_2;
pub(in crate::server) use protected_2::*;
mod protected_3;
pub(in crate::server) use protected_3::*;
mod protected_4;
pub(in crate::server) use protected_4::*;
mod protected_5;
pub(in crate::server) use protected_5::*;
mod protected_6;
pub(in crate::server) use protected_6::*;
mod spaces_skills_routes;
pub(in crate::server) use spaces_skills_routes::*;
mod output_styles;
pub(in crate::server) use output_styles::*;
mod agent_workflow_routes;
pub(in crate::server) use agent_workflow_routes::*;
mod feature_routes;
pub(in crate::server) use feature_routes::*;
