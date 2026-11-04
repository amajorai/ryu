//! Goals, context-window management, `/btw` side questions and multi-agent participants.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod goal;
pub(in crate::server) use goal::*;
mod recall_and_context;
pub(crate) use recall_and_context::*;
mod side_model;
pub(crate) use side_model::*;
mod side_questions;
pub(in crate::server) use side_questions::*;
mod btw_handlers;
pub(in crate::server) use btw_handlers::*;
