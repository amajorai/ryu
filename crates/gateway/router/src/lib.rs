//! Ryu Gateway model-routing core (Plane A) — the pure decision logic.
//!
//! **Decomposition (W6): the routing algorithm moved out.** This crate owns the
//! model→provider *resolution*, keyed on provider **strings** (the
//! `ProviderKind`→string opening): the full [`RoutingTables::route`] order
//! (exact map → longest user prefix → built-in prefix table → default), the
//! zero-config [`builtin_prefixes`] table, the modality-slot resolution
//! ([`RoutingTables::route_modality`]), the cost-tier [`RoutingTables::fallback_chain`]
//! sort, the eval-driven A/B [`RoutingTables::eval_route`] explore/exploit picker,
//! and the classifier ("smart routing") text helpers ([`build_prompt`],
//! [`parse_choice`], [`last_user_message`], [`keyword_match`], [`truncate`]).
//! Everything here is pure — it operates over `&str` / `String` /
//! `serde_json::Value` / `usize` with no gateway config-types, no async, and no
//! process/network state.
//!
//! What stays in `apps/gateway` (`src/router/`) — "engine moves, wiring stays":
//! the `ModelRouter` / `SmartRouter` structs that hold the config snapshot and
//! build these tables once, the `RouterRegistry` / `SmartRouterBackend` traits +
//! registration, the `RouteDecision` + config value-types, the `AtomicU64` A/B
//! counter (passed in via a closure so its increment timing is preserved), and
//! SmartRouter's async provider/embedding orchestration (bound to the gateway's
//! `ProviderRegistry` + `semantic_cache`). The gateway wrappers resolve config →
//! these string tables and map the returned provider strings back to
//! `ProviderId` / `RouteDecision`, so every call site is behavior-identical.

mod classify;
pub mod own_supply;
pub mod pool;
mod pool_routes;
mod prefixes;
mod tables;

pub use classify::*;
pub use pool_routes::*;
pub use prefixes::*;
pub use tables::*;

use std::collections::HashMap;

use serde_json::Value;
use tracing::debug;

/// Cap the user message sent to the classifier so a huge paste stays cheap.
pub const MAX_CLASSIFIER_INPUT_CHARS: usize = 2000;

#[cfg(test)]
mod tests;
