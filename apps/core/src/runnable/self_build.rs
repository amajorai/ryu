//! Self-building agent tools: scaffold_runnable, write_ryu_json, install_app,
//! write_tool, verify_tool, install_tool.
//!
//! These tools let an agent in chat author or modify a Runnable or App manifest
//! and hot-install it via the loader so it appears in `GET /api/apps` without
//! restart. They are exposed through the MCP registry using the same in-process
//! built-in pattern as the Shadow provider.
//!
//! # The deterministic-tool pipeline (write → verify → install)
//!
//! The last three tools are the runtime twin of `tools/toolsmith`: they let an
//! agent author a deterministic tool in chat. `write_tool` lays down the body +
//! case table + sealed manifest and **never hot-reloads**; `verify_tool` runs
//! the gate (purity scan → manifest contract → drift → every case twice in the
//! deny-all JS sandbox, see [`crate::runnable::tool_build`]); `install_tool`
//! re-runs the gate and refuses unless it passes — the ONLY path that makes an
//! AI-authored tool callable. Nothing an agent writes becomes live unverified.
//!
//! # Core-vs-Gateway placement
//!
//! Deciding *what runs* (scaffold, write, install) is Core. Deciding *whether an
//! agent is allowed* to write a new Runnable is a Gateway grant — mirrors the
//! `enable_app` pattern where Core calls `/v1/grants/validate`. Until the
//! Gateway endpoint exists, the grant check is stubbed behind
//! `RYU_STUB_SELF_BUILD_GRANTS=1` (same pattern as `RYU_STUB_GRANT_VALIDATION`).
//!
//! # Write confinement
//!
//! All writes are canonicalized and confined to the Ryu apps dir (resolved via
//! `PluginManifestLoader::plugins_dir()`). Any path that escapes confinement (traversal,
//! absolute ids, symlink escape) is rejected with a 403-equivalent error. See
//! `validate_write_target` for the exact checks.
//!
//! # Spike AC#2 finding (ACP tool-loop integration)
//!
//! See `docs/spikes/0171-self-building-agents.md` for the full validation.
//! Short form: the MCP bridge (`sidecar/adapters/mcp_bridge.rs`) successfully
//! injects these tools into ACP sessions (the `_mcp/*` MCP-over-ACP wire of ACP
//! 0.11's `with_mcp_server`, now Ryu's own `acp_mcp_over_acp`). The ACP agent
//! calls them through the standard `SessionUpdate::ToolCall` / `ToolCallUpdate`
//! path — `call_tool` here is invoked from `McpRegistry::call_tool` which is
//! invoked by the bridge's `call_tool` handler. The round-trip (call → execute →
//! result → continue) works provided the ACP agent chooses to call an injected
//! tool rather than a built-in. The remaining gap (#17) is that ACP agents may
//! prefer their own native tools; surfacing self-build tools in agent instructions
//! is a UX concern, not a wiring gap.

use std::sync::Arc;

use anyhow::{anyhow, Result};
use serde_json::Value;
use tokio::sync::RwLock;

use crate::plugin_manifest::PluginManifest;

mod disk;
mod grant;
mod manifest_tools;
mod schema;
mod tool_pipeline;

pub use disk::*;
use grant::*;
use manifest_tools::*;
pub use schema::*;
use tool_pipeline::*;

/// Reserved server name for the self-build tool provider. Must not contain
/// `.` (the tool-id namespace separator). A user MCP config entry with this name
/// would collide, so the registry treats it as reserved.
pub const SERVER_NAME: &str = "ryu_self_build";

/// Env var that stubs the Gateway grant check for self-build operations.
/// Set to `1` or `true` in environments where the Gateway is not yet available.
const ENV_STUB_GRANTS: &str = "RYU_STUB_SELF_BUILD_GRANTS";

// ── Dispatch ──────────────────────────────────────────────────────────────────

/// Dispatch a tool call from the MCP registry to the correct self-build handler.
///
/// `hot_manifests` is the shared mutable manifest store — mutations here are
/// immediately visible to `GET /api/apps` without restarting Core.
pub async fn dispatch(
    tool: &str,
    arguments: Value,
    hot_manifests: Arc<RwLock<Vec<PluginManifest>>>,
    app_store: Arc<crate::plugins::PluginStore>,
) -> Result<Value> {
    match tool {
        "scaffold_runnable" => scaffold_runnable(arguments, hot_manifests).await,
        "install_app" => install_app_tool(arguments, hot_manifests, app_store).await,
        "write_ryu_json" => write_ryu_json(arguments, hot_manifests).await,
        "write_tool" => write_tool(arguments).await,
        "verify_tool" => verify_tool(arguments).await,
        "install_tool" => install_tool(arguments, hot_manifests, app_store).await,
        other => Err(anyhow!("unknown self-build tool: '{other}'")),
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests;
