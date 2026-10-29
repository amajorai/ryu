//! In-process MCP server that bridges Ryu's registry tools into an ACP session.
//!
//! `acp_mcp_over_acp` injects this MCP server into the ACP `session/new`
//! handshake so the agent discovers and calls Ryu's registered tools
//! (Ghost, Shadow, and any user-configured servers) during its own tool loop,
//! rather than only seeing its built-in tools. `tool_search` uses the same
//! unified catalog as the OpenAI-compatible plane, whose default selector is
//! Core's Needle 2-backed ranker.
//!
//! Every call is routed through `McpRegistry::call_tool`, which enforces the
//! per-agent allowlist before dispatching. There is no direct-egress path that
//! bypasses Core's allowlist (governance requirement U68).
//!
//! # ACP parity (#477, P3)
//!
//! The bridge surfaces the **same meta-tools** the gateway / openai-compat plane
//! offers so a model behaves identically on either plane: `tool_search` and
//! `describe` (always on — discovery is open), plus `execute` and `resume`
//! (programmatic tool calling, gated on `tool_exec::is_available()`). It also
//! threads the per-agent **Composio** action allowlist (`composio_actions`) so
//! Composio actions selected for an ACP-bound agent are both offered (as shallow
//! function defs) and **callable** (their canonical `composio.<slug>` ids are
//! merged into the effective allowlist `call_tool` enforces). The function
//! definitions use the legal `composio__<slug>` aliases; dispatch normalizes
//! them back to the canonical ids. Composio reaches the ACP plane
//! through this bridge — the ACP subprocess carries no `x-ryu-tools` header, so
//! there is no second, gateway-side tool loop and no double execution.
//!
//! Discovery is open while **execution stays allowlist-gated**: `tool_search` /
//! `describe` are always offered, but executing any tool the search surfaced
//! still passes through `McpRegistry::call_tool`'s allowlist check (search ≠
//! grant). An empty static allowlist therefore still offers the meta-tools.
//!
//! # Injection (AC5)
//!
//! The server is advertised in `session/new.mcpServers` as
//! `{"type":"http","name":"ryu-registry","url":"acp:<uuid>"}`, and the agent's
//! MCP client reaches it back over the ACP connection through the `_mcp/connect`,
//! `_mcp/message` and `_mcp/disconnect` extension methods. That is the wire
//! `agent-client-protocol` 0.11.1's `SessionBuilder::with_mcp_server` spoke; 3.x
//! replaced it with an unstable `type: "acp"` binding, so Ryu now owns the 0.11
//! wire in `acp_mcp_over_acp` and keeps it unchanged. Every `_mcp/connect` gets a
//! fresh [`RyuMcpServer::serve_connection`], and each tool call routes through
//! `call_tool` here before the result is returned to the agent.
//!
//! # The NETWORK transport (`POST /mcp/:agent_id`) — Goal C
//!
//! [`serve_http_jsonrpc`] serves the *same* handler over a stateless JSON-RPC
//! POST, so an external MCP client (Claude Desktop, Cursor, another Ryu node)
//! reaches Core's live [`McpRegistry`] instead of a hand-written REST wrapper.
//! `server::mod` mounts it; this module owns the protocol.
//!
//! **Hand-rolled rather than rmcp's `transport-streamable-http-server`.** Nothing
//! in the dispatch path touches rmcp's request plumbing — both `list_tools` and
//! `call_tool` take `_context: RequestContext<..>` and ignore it — so the meta-tool
//! logic lifts out cleanly and the protocol surface needs only stateless discovery,
//! `tools/list`, `tools/call`, and authenticated Events. Legacy `initialize` and
//! `ping` remain available only to older clients. Modelled on
//! `apps/web/src/lib/mcp-server.ts`, which is already proven against real MCP
//! hosts. No new dependency and no cargo-feature trap: enabling rmcp's `local`
//! feature ANYWHERE in the workspace silently deletes `StreamableHttpService`, and
//! rmcp 1.x ships no SSE-server transport at all, so the feature route would have
//! been a standing hazard for a surface this small.
//!
//! ## An external client's `tools/list` is SHORT, and that is the design
//!
//! It shows the offered registry tools plus `tool_search` / `describe` (and
//! `execute` / `resume` when code mode is available) — **not** hundreds of tools.
//! Two whole planes are deliberately *searchable but not listed*: Composio actions
//! and the ext-API tools derived from an installed app's OpenAPI document
//! ([`crate::ext_api`]). They are reachable through `tool_search` → `describe` →
//! call by exact id, and `McpRegistry::call_tool` enforces the allowlist on the
//! way through. This is progressive disclosure, not a missing feature: a node with
//! a dozen apps installed derives hundreds of operations, and pushing all of them
//! into every client's context window is precisely what the meta-tools exist to
//! avoid. If you are here because "my derived tools don't show up in tools/list" —
//! they are not supposed to; search for them.
//!
//! ## Canonical surface
//!
//! `POST /mcp/:agent_id` is the canonical MCP surface for external clients. The
//! separate `apps/mcp` stdio server is ~24 hand-written REST wrappers that bypass
//! [`McpRegistry`] entirely, so nothing registered at runtime — every app tool,
//! every derived ext-API operation — can ever appear in its `tools/list`. Treat it
//! as legacy: new tools belong in the registry, and the registry is served here.

use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::{Arc, LazyLock, Mutex};

use rmcp::{
    model::{
        CallToolResult, ContentBlock, Implementation, ListToolsResult, ProtocolVersion, ServerInfo,
        Tool,
    },
    service::RequestContext,
    ErrorData as McpError, ServiceExt,
};
use serde_json::{json, Map, Value};

use crate::sidecar::adapters::acp::{AcpEvent, ToolWidgetEvent};
use crate::sidecar::mcp::catalog::ToolKind;
use crate::sidecar::mcp::client::McpToolResult;
use crate::sidecar::mcp::McpRegistry;
use crate::sidecar::untrusted;
use crate::tool_exec;

/// Default `tool_search` result cap (Contract 3).
const TOOL_SEARCH_DEFAULT_LIMIT: usize = 8;
const TOOL_SEARCH_MAX_LIMIT: usize = 25;
static AGENT_BUILDER_CONFIGURE_APPROVALS: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Build an in-process MCP server for `agent_id` offering the Ryu meta-tools plus
/// the registry + Composio tools it is allowed to use.
///
/// The offered set is the union of:
/// - the allowlisted registry tools (`tools_for_agent`),
/// - one shallow function def per per-agent Composio action (`composio_actions`),
/// - the always-on meta-tools `tool_search` / `describe`, and
/// - `execute` / `resume` when `tool_exec::is_available()` (a JS backend is built
///   and runnable).
///
/// Unlike the pre-#477 behaviour, this **always** returns `Some` — even for an
/// empty static allowlist — because tool *discovery* is open while *execution*
/// stays allowlist-gated in `call_tool`. (`mcp = None` legacy callers simply do
/// not call this.)
///
/// `composio_actions` are bare Composio action slugs (e.g. `GITHUB_CREATE_ISSUE`).
/// Their fully-qualified `composio.<slug>` ids are merged into the effective
/// allowlist so they are callable; when `allowlist` is `None` the agent is
/// unrestricted and no merge is needed.
pub async fn build_ryu_mcp_server(
    mcp: Arc<McpRegistry>,
    allowlist: Option<Vec<String>>,
    composio_actions: Vec<String>,
    agent_id: String,
    identity_profile_ids: Vec<String>,
    composio_connection_scope: Option<Vec<crate::sidecar::adapters::ComposioConnectionBinding>>,
    conversation_scope: Option<Vec<String>>,
    permission_tx: Option<tokio::sync::mpsc::UnboundedSender<AcpEvent>>,
    permission_scope_id: Option<String>,
) -> Option<RyuMcpServer> {
    // Withhold capability-gated tools this agent is not permitted: the
    // delegation/discovery providers when its `orchestrator` capability is off,
    // and the agent-creation tool when `can_create_agents` is off. Resolved from
    // the agent's config record (defaults: delegation on, creation off).
    //
    // NOTE: the TOOL LIST is deliberately *not* resolved here — see
    // [`RyuMcpHandler::build_tool_list`] for why a build-time snapshot was a bug.
    // `caps` stays a build-time value: it is one agent-config field that does not
    // change mid-session, and re-reading it per request would add an agent-store
    // hit to every `tools/list` for no observable difference.
    let caps = mcp.agent_capabilities(&agent_id).await;

    // Effective allowlist used by `call_tool`: when restricted, the agent's
    // selected Composio ids must be callable, so merge `composio.<slug>` in.
    // When unrestricted (`None`) everything is already permitted. Do not add
    // agent-control here: an explicit empty/narrow allowlist is an intentional
    // capability boundary, and the built-in is only available when the agent
    // already allows its server/tool.
    let effective_allowlist = allowlist.map(|mut list| {
        for slug in &composio_actions {
            let id = format!("composio.{slug}");
            if !list.contains(&id) {
                list.push(id);
            }
        }
        list
    });

    let server = RyuMcpServer {
        mcp,
        allowlist: effective_allowlist,
        composio_actions,
        agent_id,
        identity_profile_ids,
        composio_connection_scope,
        conversation_scope,
        caps,
        permission_tx,
        permission_scope_id,
    };
    Some(server)
}

/// Ryu's registry + meta tools for one ACP session. Each MCP connection the
/// agent opens gets its own [`RyuMcpHandler`] (see [`RyuMcpServer::serve_connection`]);
/// the ACP wire binding lives in `acp_mcp_over_acp`.
pub struct RyuMcpServer {
    mcp: Arc<McpRegistry>,
    /// Effective allowlist (registry grants + merged Composio ids), or `None`
    /// for an unrestricted agent.
    allowlist: Option<Vec<String>>,
    /// Bare Composio action slugs offered to this agent.
    composio_actions: Vec<String>,
    /// Effective agent id (used to scope programmatic-tool-calling execution).
    agent_id: String,
    /// Bound Identity Vault profiles (epic #517). Threaded into `call_tool` so a
    /// tool call targeting a NEEDS_AUTH bound domain elicits, and an AUTHENTICATED
    /// one reads the credential under the gateway grant. Empty = no vault consult.
    identity_profile_ids: Vec<String>,
    /// Optional server-validated connected accounts for a profile run.
    composio_connection_scope: Option<Vec<crate::sidecar::adapters::ComposioConnectionBinding>>,
    /// Optional server-validated conversation ids for a profile run.
    conversation_scope: Option<Vec<String>>,
    /// This agent's orchestration capabilities, enforced again at dispatch time
    /// (defense in depth) so a model cannot call a gated tool it was not offered.
    caps: crate::sidecar::mcp::AgentCapabilities,
    /// Optional stream back-channel for interactive permission prompts.
    permission_tx: Option<tokio::sync::mpsc::UnboundedSender<AcpEvent>>,
    /// Stable chat-session key for one-time interactive approvals.
    permission_scope_id: Option<String>,
}

impl RyuMcpServer {
    /// The MCP server name advertised in `session/new.mcpServers`.
    pub fn name(&self) -> String {
        "ryu-registry".to_owned()
    }

    fn new_handler(&self) -> RyuMcpHandler {
        RyuMcpHandler {
            mcp: Arc::clone(&self.mcp),
            allowlist: self.allowlist.clone(),
            composio_actions: self.composio_actions.clone(),
            agent_id: self.agent_id.clone(),
            identity_profile_ids: self.identity_profile_ids.clone(),
            composio_connection_scope: self.composio_connection_scope.clone(),
            conversation_scope: self.conversation_scope.clone(),
            caps: self.caps,
            permission_tx: self.permission_tx.clone(),
            permission_scope_id: self.permission_scope_id.clone(),
        }
    }

    /// Serve one MCP connection (newline-delimited JSON-RPC, starting with the
    /// client's `initialize`) over `stream` until the client side closes it.
    pub(crate) async fn serve_connection<S>(&self, stream: S) -> anyhow::Result<()>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static,
    {
        let (read, write) = tokio::io::split(stream);
        let running = self.new_handler().serve((read, write)).await?;
        running.waiting().await?;
        Ok(())
    }
}

/// `rmcp::ServerHandler` that dispatches through `McpRegistry::call_tool` plus the
/// always-on Ryu meta-tools.
struct RyuMcpHandler {
    mcp: Arc<McpRegistry>,
    allowlist: Option<Vec<String>>,
    composio_actions: Vec<String>,
    agent_id: String,
    /// Bound Identity Vault profiles (epic #517); see [`RyuMcpServer`].
    identity_profile_ids: Vec<String>,
    /// Optional server-validated connected accounts for a profile run.
    composio_connection_scope: Option<Vec<crate::sidecar::adapters::ComposioConnectionBinding>>,
    /// Optional server-validated conversation ids for a profile run.
    conversation_scope: Option<Vec<String>>,
    /// This agent's orchestration capabilities; gated tools are refused here even
    /// if a model emits a call to one that was never advertised (defense in depth).
    caps: crate::sidecar::mcp::AgentCapabilities,
    /// Optional stream back-channel for interactive permission prompts.
    permission_tx: Option<tokio::sync::mpsc::UnboundedSender<AcpEvent>>,
    /// Stable chat-session key for one-time interactive approvals.
    permission_scope_id: Option<String>,
}

mod handler_catalog;
mod handler_consent;
mod handler_dispatch;
mod jsonrpc;
mod permissions;
mod result_bound;
mod tool_defs;
mod widget;

#[cfg(test)]
use handler_dispatch::*;
pub(crate) use jsonrpc::*;
use permissions::*;
pub(crate) use result_bound::*;
pub(crate) use tool_defs::*;
pub(crate) use widget::*;

#[cfg(test)]
#[path = "mcp_bridge_tests.rs"]
mod tests;
