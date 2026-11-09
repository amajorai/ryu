//! Self-API: Core's own HTTP endpoints exposed as agent-discoverable tools.
//!
//! "Agents can drive Ryu itself." This module turns the OpenAPI spec that Core
//! already generates (`server::openapi::api_doc`) into a catalog of
//! [`ToolKind::CoreApi`] tools an agent can `tool_search` → `describe` →
//! `execute`, exactly like any MCP/built-in tool. Execution loops back over
//! HTTP to *this* Core with the node's own `RYU_TOKEN`.
//!
//! ## Placement (CLAUDE.md §1)
//! Discovering *what Core can do* and offering it as a tool is orchestration →
//! Core. The mutating calls are HITL-gated at the shared approval chokepoint and
//! role-checked on org-bound nodes (see [`acting_user_refusal`]).
//!
//! ## Security invariants (non-negotiable)
//! - **Denylist** ([`is_denied`]): security-critical routes (auth, identity,
//!   capability-broker, the app host-capability bridge `/api/plugins/:id/host`,
//!   webhook signing secrets, Gateway provider keys and service accounts, hook
//!   overrides, audit pruning, the approvals *mutations*, the tool routes
//!   themselves — recursion — and the spec route) are NEVER exposed. Reviewable
//!   const below.
//! - **Loopback carries the node token = full power.** On an unbound node there
//!   is exactly one principal, so that is the right identity. On an org-bound
//!   node the loopback must not run as the node: the agent may only call a route
//!   with a declared permission ([`required_permission`]) that the person in the
//!   chat holds, from a private chat, and the loopback then carries an
//!   in-process proof ([`self_call_proof`]) so every handler sees that person
//!   instead of the node owner. A principal that cannot be resolved is refused.
//! - **Mutations (non-GET) always need the person's approval** (see
//!   `crate::approvals::policy`), in every approval mode including `off`.
//! - **No agent manages accounts or credentials.** Writes that connect,
//!   complete, re-key or remove the user's accounts (Composio connections, MCP
//!   sign-ins, plugin secrets and grants, model-provider keys and sign-ins,
//!   agent runtime logins, sealed cloud-environment values, managed-bot
//!   pairing, the backup recovery key) are denied for every agent, including
//!   one that acts as the user. The loopback has no verified user, and approval
//!   mode `off` would otherwise leave them ungated. The sanctioned path is the
//!   `consent.connect_app` card, which the user completes. Reads stay.
//! - **Restricted-account agents write only workspace content.** An agent whose
//!   account policy is restricted (its own identity, both, or any account
//!   allowlist) may call a mutating CoreApi tool only when its route is on the
//!   reviewed [`RESTRICTED_SAFE_WRITES`] list (Spaces, memory entries,
//!   conversation housekeeping, notifications, …). Everything else, including
//!   any route added later, is refused for them ([`restricted_write_refusal`]).

use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use ryu_tool_registry::{
    arg_summary, describe_from_parts, DescribedTool, ToolDescriptor, ToolKind,
};

/// The synthetic MCP "server" segment for every CoreApi tool id.
pub const SERVER_NAME: &str = "ryu_api";
/// Fully-qualified id prefix (`<server>.`). Every newly generated CoreApi tool
/// id starts here. The legacy spelling remains accepted at the call boundary.
pub const ID_PREFIX: &str = "ryu_api.";
const LEGACY_ID_PREFIX: &str = "ryu_api__";

/// Bound on a single loopback call so a slow/streaming endpoint can never wedge
/// the tool loop (SSE/WS routes are denylisted, but this is the backstop).
const LOOPBACK_TIMEOUT: Duration = Duration::from_secs(30);

/// HTTP verbs we surface, in a stable order (so tool ids are deterministic).
const METHODS: &[&str] = &["get", "post", "put", "patch", "delete"];

mod denylist;
mod gates;
mod loopback;
mod restricted;
mod routes;
#[cfg(test)]
mod tests;

pub use denylist::*;
pub use gates::*;
pub use loopback::*;
pub use restricted::*;
pub use routes::*;
