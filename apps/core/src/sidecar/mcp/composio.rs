//! Composio dispatch adapter for the unified tool catalog (#474).
//!
//! The composio-specific logic — key resolution, base-URL pinning, the
//! `POST /tools/execute/{slug}` request, and connection-required detection —
//! lives in the extracted [`ryu_composio::execute`] crate module. This file is
//! the thin Core-side adapter that (1) re-exports the id/config surface the MCP
//! registry resolves against, and (2) turns the crate's typed
//! [`ryu_composio::execute::ExecOutcome`] into the shared `__ryu_elicitation__`
//! envelope.
//!
//! **Why the envelope construction stays in Core (adjudication):** the
//! `__ryu_elicitation__` shape is single-sourced by the identity-vault builder
//! [`crate::identity::to_envelope`] over a Core [`crate::tool_exec::Elicitation`]
//! — the same builder the vault (domain-keyed) detector funnels through. Keeping
//! it here preserves that one-builder invariant; the crate stays free of any
//! Core type. This is glue, not composio business logic.
//!
//! Placement (CLAUDE.md §1): running a Composio action is *what runs* → Core.
//! The allowlist verdict / budget / audit is *what's allowed/measured* → Gateway
//! (the unified [`super::McpRegistry::call_tool_with_user`] path emits those).

use anyhow::Result;
use reqwest::Client;
use serde_json::Value;

pub use ryu_composio::execute::SERVER_NAME;

/// True when a Composio key is configured (preferences or env).
pub fn is_configured() -> bool {
    ryu_composio::auth::is_configured()
}

/// Execute a Composio action (`tool` = the action slug, e.g. `GITHUB_CREATE_ISSUE`).
///
/// Delegates to [`ryu_composio::execute::dispatch`] and maps a
/// [`ryu_composio::execute::ExecOutcome::NeedsConnection`] into the
/// `__ryu_elicitation__` envelope the PTC invoker pauses on (so the HITL connect
/// flow can fire). A normal result is returned as its unwrapped `data` value.
pub async fn dispatch(
    http: &Client,
    tool: &str,
    arguments: Value,
    user_id: Option<&str>,
) -> Result<Value> {
    match ryu_composio::execute::dispatch(http, tool, arguments, user_id).await? {
        ryu_composio::execute::ExecOutcome::Ok(v) => Ok(v),
        ryu_composio::execute::ExecOutcome::NeedsConnection { message, url } => {
            let elicit = crate::tool_exec::Elicitation {
                kind: "url".to_owned(),
                message,
                url,
                requested_schema: None,
            };
            Ok(crate::identity::to_envelope(&elicit))
        }
    }
}
