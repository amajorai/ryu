//! The network MCP surface (`POST /mcp/:agent_id`).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── The network MCP surface (`POST /mcp/:agent_id`) ──────────────────────────
//
// Core's live `McpRegistry`, spoken as MCP over a stateless JSON-RPC POST, so an
// external MCP client (Claude Desktop, Cursor, another node) reaches the SAME
// tools an in-process ACP agent does — app tools registered at runtime and the
// operations derived from installed apps' OpenAPI documents included. The
// protocol lives in `sidecar::adapters::mcp_bridge::serve_http_jsonrpc`; this is
// the mount, the principal, and the one auth rule that differs from every other
// route.
//
// Note the tool listing an external client sees is SHORT on purpose — the agent's
// granted tools plus `tool_search`/`describe`. Composio and the derived ext-API
// plane are searchable-not-listed. See the `mcp_bridge` module docs; it is the
// design, and it is filed as a bug about once per reader.

/// Wire ceiling on a `POST /mcp*` body.
///
/// 2 MiB — the same figure axum applies implicitly when a route declares nothing.
/// Stated rather than inherited: an implicit limit is invisible to a reader and to
/// a future edit of the layer stack, and this is the one route on the protected
/// chain whose body is a general-purpose tool-call envelope arriving from the
/// network. A `tools/call` carrying a document's text is the case that sets the
/// floor, so it is not tightened below the implicit default without a measurement.
pub(in crate::server) const MCP_MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

/// Why `agent_id` is required with no default, and why a missing node token is
/// refused HERE when `require_auth` would have waved it through.
///
/// Returns `Some((status, message))` to refuse, `None` to proceed.
///
/// # 1. No node token ⇒ 401, and this route is the ONLY one that says so
///
/// [`require_auth`] short-circuits to `next.run(req)` when the auth-token
/// extension is `None` — i.e. on a node with no `RYU_TOKEN` configured, every
/// protected route is open. That is a deliberate, long-standing posture for a
/// loopback dev node: the surfaces behind it are the desktop's own, and requiring
/// a token nobody minted would brick a fresh checkout.
///
/// It is the wrong posture for *this* route. `/mcp` is a general-purpose tool
/// dispatcher: it executes registry tools — shell-adjacent app tools, credentialed
/// ext-API calls, the Identity Vault consult — for whoever can POST to it. Core
/// binds beyond loopback (`RYU_BIND`, the mesh), and the process CORS layer
/// deliberately admits `https://app.ryuhq.com` and the Tauri origins with
/// `allow_private_network(true)` so a hosted page can talk to a local Core. An
/// unauthenticated tool-dispatch endpoint on a bindable port is not a dev
/// convenience; it is remote code execution waiting for a network change or a
/// malicious page on an allowed origin. So this route refuses rather than
/// inheriting the carve-out, and the message says how to fix it.
///
/// # 2. The agent principal is required, must be EXACT, and has no default
///
/// The bearer authenticates the NODE. It does not say which agent is asking, and
/// this route has no conversation to infer one from. Requiring a resolvable id is
/// not primarily about narrowing the tool set — on a stock node
/// [`crate::sidecar::adapters::acp::AcpAgentRegistry::allowlist_for`] returns
/// `None` (no `RYU_MCP_ALLOWLIST*` is set), so a known agent is unrestricted too.
/// It is about pinning the call to ONE agent's posture: its tool allowlist, its
/// orchestrator/agent-creation capabilities, its `approval_tools` policy, its
/// skill scoping, its Identity Vault bindings. A caller that may invent a
/// principal is authorized as nobody, and "nobody" is exactly the value that means
/// *unrestricted* on the paths downstream.
///
/// "Resolvable" here means **exactly equal** to a registry entry id or to a stored
/// agent record's id — see [`mcp_principal_resolves`]. It deliberately does NOT
/// use [`crate::sidecar::adapters::acp::AcpAgentRegistry::find_by_prefix`], whose
/// rule is `agent_id == e.id || agent_id.starts_with(&e.id)`: prefix matching is a
/// convenience for humans typing an id at a CLI, and it cannot be an authorization
/// primitive. Under it a caller who POSTs `ryu-anything` is admitted by the `ryu`
/// entry, i.e. the caller picks which principal it is scored against by choosing a
/// string — which is the *forgeable* principal this section claims is impossible.
/// The exact rule is why the claim above is true.
///
/// This is deliberately **stricter than [`call_mcp_tool`]**, which still admits on
/// a prefix. Tightening here costs nothing: this route is new, so no client has
/// ever been admitted by a prefix on it, and an MCP client configures its endpoint
/// URL once from a copied id rather than typing it.
pub(in crate::server) fn mcp_admission(
    token_configured: bool,
    agent_id: &str,
    agent_known: bool,
) -> Option<(StatusCode, String)> {
    if !token_configured {
        return Some((
            StatusCode::UNAUTHORIZED,
            "the MCP endpoint requires a node token; set RYU_TOKEN (or pair a device) and \
             present it as `Authorization: Bearer <token>`"
                .to_owned(),
        ));
    }
    if agent_id.is_empty() {
        return Some((
            StatusCode::BAD_REQUEST,
            "POST /mcp/<agent_id>: the MCP endpoint is scoped to one agent, which must be \
             named in the path"
                .to_owned(),
        ));
    }
    if !agent_known {
        return Some((
            StatusCode::FORBIDDEN,
            // Echoed back so a misconfigured client sees WHICH id it sent — but
            // bounded and stripped first: this is unauthenticated-caller input on
            // its way into the log line and the response body, and a megabyte of
            // control characters is not a diagnostic.
            format!("unknown agent '{}'", echoable_principal(agent_id)),
        ));
    }
    None
}

/// The longest client-supplied agent id worth echoing in a refusal. Real ids are
/// short (`ryu`, `claude`, a uuid at worst); anything longer is not a typo being
/// reported back to its author.
pub(in crate::server) const MAX_ECHOED_PRINCIPAL_CHARS: usize = 64;

/// Bound and sanitize a client-supplied principal for inclusion in an error string.
///
/// Control characters (newlines above all) are dropped rather than escaped: the
/// refusal is formatted into a `tracing` line as well as a JSON body, and a
/// newline in caller-controlled text is how a log gets forged extra rows.
pub(in crate::server) fn echoable_principal(agent_id: &str) -> String {
    let cleaned: String = agent_id
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_ECHOED_PRINCIPAL_CHARS)
        .collect();
    if agent_id.chars().filter(|c| !c.is_control()).count() > MAX_ECHOED_PRINCIPAL_CHARS {
        format!("{cleaned}…")
    } else {
        cleaned
    }
}

/// Does `agent_id` name an EXISTING agent, exactly?
///
/// The whole authorization value of the principal on `POST /mcp/:agent_id` is that
/// the caller cannot choose which agent's posture it is evaluated against. That
/// requires equality, not containment: with prefix matching a caller who has never
/// heard of any agent can send `r` and be admitted as `ryu`.
///
/// Two sources, both exact, because an agent may exist in either:
/// - `registry_ids` — the built-in/ACP registry entries (`AcpAgentRegistry::entries`);
/// - `record_exists` — a row in the agent store (user-created agents).
///
/// Pure so the rule itself is testable; `ServerState` is not constructible in a
/// unit test (~40 fields of live stores and sidecar managers).
pub(in crate::server) fn mcp_principal_resolves<'a>(
    agent_id: &str,
    record_exists: bool,
    mut registry_ids: impl Iterator<Item = &'a str>,
) -> bool {
    if agent_id.is_empty() {
        return false;
    }
    record_exists || registry_ids.any(|id| id == agent_id)
}

/// The JSON-RPC refusal for a top-level array, or `None` for a single message.
///
/// Batching is **not supported**, deliberately. The endpoint advertises protocol
/// revision `2025-06-18`, which REMOVED JSON-RPC batching from MCP, so refusing it
/// is spec-conformant rather than a limitation. It also closes an amplification
/// lever: a batch is one authenticated request that fans out into N registry tool
/// dispatches, and bounding that would need an element cap *and* a whole-batch
/// deadline *and* a per-handler timeout — three knobs to maintain for a feature the
/// current revision does not have. One request, one message, one dispatch.
///
/// The refusal is a JSON-RPC error object (not an HTTP 4xx) because a JSON-RPC
/// client can read it; `id` is `null` since a batch has no single id to answer to.
pub(in crate::server) fn mcp_batch_refusal(
    parsed: &serde_json::Value,
) -> Option<serde_json::Value> {
    parsed.is_array().then(|| {
        json!({
            "jsonrpc": "2.0",
            "id": serde_json::Value::Null,
            "error": {
                "code": -32_600,
                "message": "JSON-RPC batching is not supported — MCP revision 2025-06-18 removed \
                            it. Send one request per POST.",
            },
        })
    })
}

pub(in crate::server) fn mcp_message_capability(body: &str) -> crate::authorization::Capability {
    use crate::authorization::Capability;
    let Ok(message) = serde_json::from_str::<serde_json::Value>(body) else {
        return Capability::ToolsExec;
    };
    let Some(method) = message
        .as_object()
        .and_then(|object| object.get("method"))
        .and_then(serde_json::Value::as_str)
        .filter(|method| !method.trim().is_empty())
    else {
        return Capability::ToolsExec;
    };
    match method {
        "initialize"
        | "ping"
        | "notifications/initialized"
        | "server/discover"
        | "tools/list"
        | "events/list" => Capability::ToolsRead,
        "tools/call" => Capability::ToolsExec,
        "events/subscribe" | "events/unsubscribe" => Capability::ToolsExec,
        method if method.starts_with("resources/") => Capability::FilesRead,
        method if method.starts_with("prompts/") => Capability::WorkflowsRead,
        _ => Capability::ToolsExec,
    }
}

pub(in crate::server) fn authorize_mcp_message(
    resolved: &ResolvedAuthorization,
    body: &str,
    now: u64,
) -> crate::authorization::AuthorizationDecision {
    resolved.context.authorize(
        &crate::authorization::RoutePolicy::requires([mcp_message_capability(body)]),
        &resolved.bindings,
        now,
    )
}

pub(in crate::server) fn mcp_message_has_method(parsed: &serde_json::Value) -> bool {
    parsed
        .as_object()
        .and_then(|object| object.get("method"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|method| !method.trim().is_empty())
}

pub(in crate::server) const MCP_UNSUPPORTED_PROTOCOL_VERSION: i64 = -32_022;
pub(in crate::server) const MCP_INVALID_REQUEST: i64 = -32_600;
pub(in crate::server) const MCP_HEADER_MISMATCH: i64 = -32_020;
pub(in crate::server) const MCP_PROTOCOL_VERSION_KEY: &str =
    "io.modelcontextprotocol/protocolVersion";
pub(in crate::server) const MCP_CLIENT_CAPABILITIES_KEY: &str =
    "io.modelcontextprotocol/clientCapabilities";
