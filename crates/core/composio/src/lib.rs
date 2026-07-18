//! Composio integration orchestration (Core side).
//!
//! Extracted from `apps/core/src/{composio_auth,composio_catalog,composio_connect,
//! composio_triggers}` and `apps/core/src/sidecar/mcp/composio.rs` into a
//! standalone capability crate (program §3 library-crate mechanism). In-process
//! default — every hot path is a direct function call, no IPC.
//!
//! The crate owns the whole composio surface:
//!   - [`auth`] — the preferences-first API-key resolver.
//!   - [`catalog`] — the toolkit/action/trigger browse client.
//!   - [`connect`] — connection initiate/status.
//!   - [`triggers`] — the persisted trigger-subscription store, poll loop, and
//!     fail-closed HMAC-SHA256 webhook verification.
//!   - [`execute`] — the MCP execute-action HTTP path + connection-required
//!     elicitation detection (envelope construction stays in Core; see below).
//!
//! The only kernel couplings — starting a workflow run / an agent run when a
//! trigger fires — are inverted through the [`ComposioHost`] trait, installed by
//! Core at boot. The `__ryu_elicitation__` envelope is built Core-side (from the
//! shared identity builder) around [`execute::ExecOutcome`]; the crate does the
//! composio-specific detection and hands back a typed outcome.

pub mod auth;
pub mod catalog;
pub mod connect;
pub mod execute;
pub mod host;
pub mod triggers;

pub use host::{set_global_host, ComposioHost};
pub use triggers::{
    set_global, ComposioTriggerStore, TriggerSubscription,
};
