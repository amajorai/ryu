//! Assistant-first opening, channel bot runs, the channel command registry and background processes.
//!
//! Split out of `server/mod.rs`; every item is re-exported from `crate::server`.

mod assistant_first_opening;
pub(in crate::server) use assistant_first_opening::*;
mod channel_bot_run;
pub(in crate::server) use channel_bot_run::*;
mod channel_run;
pub(in crate::server) use channel_run::*;
mod channel_command_registry;
pub(in crate::server) use channel_command_registry::*;
mod worktree_diff;
pub(in crate::server) use worktree_diff::*;
#[cfg(test)]
mod assistant_first_opening_tests;
