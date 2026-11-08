//! Host API contract — the single, versioned source of truth for the host↔plugin
//! RPC vocabulary: the semver [`HOST_API_VERSION`] plus [`HOST_API_METHODS`], the
//! canonical `method → capability → grant` table shared by every surface.
//!
//! Two independent surfaces used to hand-maintain this vocabulary and drift:
//!
//! - the TS app host (`packages/app-host/src/rpc.ts`) — `METHOD_CAPABILITY`,
//!   `GRANT_CAPABILITY`, `STREAMING_METHODS`, and
//! - Core's Rust plugin bridge (`apps/core/src/server/plugin_bridge_api.rs`
//!   `required_grant_for`).
//!
//! Both now DERIVE from this one table. The blessed-file test emits
//! `schemas/host-api.json` (same `RYU_REGEN_SCHEMAS=1` pattern as the manifest
//! schema); the TS host imports that JSON and derives its maps from it, and the
//! Rust bridge reads [`grant_for`]. A lockstep test on each side pins the derived
//! shapes to the old hand-written tables so nothing silently widens.
//!
//! # Surface coverage (documented divergence)
//!
//! The two surfaces cover DIFFERENT method subsets and agree only where they
//! overlap — this is by design, encoded in the [`HostApiMethod::ts_host`] flag:
//!
//! - Most methods are TS-app-host methods (`ts_host = true`). The bridge-backed
//!   families (`model.complete`, `agent.run`, `storage.*`, `spaces.*`,
//!   `finetune.*`) are dispatched by BOTH the TS host AND the Rust bridge and
//!   agree on their grant.
//! - `view.action` is a Rust-bridge-only relay (`ts_host = false`): it is NOT in
//!   `rpc.ts` `METHOD_CAPABILITY` (the task's ground-truth note was inaccurate on
//!   this point — it lives only in `plugin_bridge_api.rs` + the `capability_label`
//!   in `schema.rs`). The TS derivation skips `ts_host = false` entries, so it
//!   never leaks into the TS `Capability` union.
//!
//! This crate stays pure data (serde/schemars only, no I/O — the runtime charter);
//! the JSON file lives its lifecycle in the integration test, which is allowed I/O.

use serde::Serialize;

/// The version of the host↔plugin contract defined by this crate.
///
/// # Compatibility policy
///
/// Semver, **additive-only within a major**:
///
/// - **Patch/minor** bumps may only *add* — new optional manifest fields, new
///   enum variants behind `#[serde(other)]`-style tolerance, new constants, new
///   [`HOST_API_METHODS`] rows.
///   Nothing that exists may be removed, renamed, retyped, or made required.
/// - **Major** bumps are the only place a breaking change (removal, rename,
///   semantic change of an existing field) is allowed.
///
/// A plugin authored against host API `1.x` must therefore load on every later
/// `1.y` (y ≥ x) kernel unchanged. The `ryu-plugin-ready` handshake carries this
/// value as `hostApiVersion`; the host accepts a missing value (legacy) this
/// major and only annotates it (no rejection).
pub const HOST_API_VERSION: &str = "1.21.0";

/// One method in the host↔plugin RPC surface — the row type of the single-sourced
/// `method → capability → grant` table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostApiMethod {
    /// The RPC method key (e.g. `"model.complete"`).
    pub method: &'static str,
    /// The host capability the method requires (dotted, e.g. `"model.complete"`) —
    /// a member of the TS app host's `Capability` union.
    pub capability: &'static str,
    /// The manifest grant string that unlocks the capability (colon-form, e.g.
    /// `"hook:side-model"`). `None` for LOCAL host caps (`widget.state`,
    /// `ui.displayMode`) granted on mount and NEVER Gateway-sourced.
    pub grant: Option<&'static str>,
    /// Dispatched by the streaming path (many chunks + a terminal result) rather
    /// than the unary dispatch.
    pub streaming: bool,
    /// Exposed by the TS app-host RPC layer (`dispatchRpc` / streaming dispatch).
    /// `false` marks a Rust-bridge-only method (`view.action`) the TS host never
    /// dispatches; the TS derivation skips these.
    pub ts_host: bool,
}

/// Terse const constructor so the table reads as a dense grid.
const fn m(
    method: &'static str,
    capability: &'static str,
    grant: Option<&'static str>,
    streaming: bool,
    ts_host: bool,
) -> HostApiMethod {
    HostApiMethod {
        method,
        capability,
        grant,
        streaming,
        ts_host,
    }
}

/// The canonical host-API method table. The union of the TS app host's
/// `METHOD_CAPABILITY` (148 methods) and the Rust bridge's `view.action`
/// (Rust-only). Serialised to `schemas/host-api.json` for the TS host to consume.
///
/// The rows live in ordered parts under `host_api/methods/`; the join keeps the
/// single table's order, so the JSON file does not change when rows move between
/// parts.
pub const HOST_API_METHODS: &[HostApiMethod] = &methods::ALL;

mod methods;

/// The grant a host method requires, or `None` for an unknown method or a local
/// host cap (`widget.state` / `ui.displayMode`). Core's `required_grant_for`
/// reads this so the Rust bridge and the TS host share one grant vocabulary.
#[must_use]
pub fn grant_for(method: &str) -> Option<&'static str> {
    HOST_API_METHODS
        .iter()
        .find(|e| e.method == method)
        .and_then(|e| e.grant)
}

#[cfg(test)]
mod tests;
