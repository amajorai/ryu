//! Agent **teams**: a persisted, ordered collection of agents that can be
//! addressed as one unit (`@team` in chat) so a single message fans out to every
//! member — an extracted Core capability crate (SQLite store + `/api/teams/*`
//! HTTP surface).
//!
//! In-process default; Core consumes it as a path dependency. This crate has ZERO
//! dependency on `apps/core`: the store's only cross-cutting need — the data-dir
//! path — is injected by the host at [`store::TeamStore::open`], and the `@team`
//! chat orchestration (which is welded to Core's streaming session loop) stays in
//! Core as a *consumer* of this crate's [`TeamRecord`]/[`Coordination`] types
//! rather than being pulled in here. That coupling is genuinely inseparable from
//! the chat kernel (see `apps/core/src/sidecar/adapters/mod.rs`), so — unlike
//! quests/clips — there is no `TeamsHost` trait: nothing in the moved store+CRUD
//! surface reaches back into Core.

pub mod api;
pub mod store;

pub use api::{openapi, routes, TeamsCtx};
pub use store::{Coordination, CreateTeam, TeamRecord, TeamStore, UpdateTeam};
