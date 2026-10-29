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

// ── Denylist (security-critical; reviewable, one comment per entry) ───────────

/// Path prefixes excluded for **every** verb. Non-negotiable.
const DENIED_PREFIXES: &[&str] = &[
    // Auth / session — an agent must never drive login/logout/device flow.
    "/api/auth/",
    // Credential vault — never expose stored secrets or their lifecycle.
    "/api/identity/",
    "/api/identities",
    "/api/vault",
    // Capability broker — cross-app privilege escalation surface.
    "/api/host/",
    // Mesh/node control — loopback self-API must not mint or expose peer
    // credentials on behalf of the calling agent.
    "/api/mesh/",
    // The unified tool routes themselves — recursion (search/describe/exec).
    "/api/tools/",
    // Rule discovery accepts a filesystem root. It remains available to the
    // authenticated desktop route, but must not become an agent-controlled
    // loopback file browser through CoreApi.
    "/api/rules/",
];

/// Exact paths excluded for every verb.
const DENIED_EXACT: &[&str] = &[
    // The spec route — an agent enumerating the spec to self-expand is pointless
    // recursion and leaks the full surface in one call.
    "/api/openapi.json",
    // The generic MCP tool-invoke route — recursion into tool dispatch.
    "/api/mcp/tools/call",
    // Live Gateway traffic is an SSE feed; a request/response loopback would
    // hang until the timeout.
    "/api/gateway/traffic",
    // Pruning the audit log would let an agent erase the record of what it did.
    "/api/gateway/audit/prune",
    // Provider API keys and the web/speech service accounts are credentials.
    // Like the vault, their lifecycle stays in Settings, where the user types
    // the secret into a field instead of into a chat transcript.
    "/api/gateway/providers",
    "/api/gateway/web-accounts",
    "/api/gateway/cloud-speech-accounts",
    // Hook policy overrides can switch off safety hooks (DLP, approvals). Git
    // and worktree governance stay reachable; this resolved path is caught at
    // dispatch, after the `{kind}` parameter is substituted.
    "/api/gateway/governance/hooks",
    "/api/hooks/overrides",
    // The widget tool bridge runs a tool as the widget instance's agent, and the
    // per-agent MCP endpoint runs one as the agent in its path: both are tool
    // dispatch recursion that would skip the calling agent's own policy. Opening
    // an MCP App runs its entrypoint tool as the agent named in the body, so it
    // is the same recursion.
    "/api/widgets/tools/call",
    "/api/widgets/open",
    "/mcp/{agent_id}",
    // Answers an in-chat permission prompt. On an unbound node an agent could
    // otherwise grant its own pending request (the same self-approval the
    // `/api/approvals/` rule below closes).
    "/api/chat/permission",
];

/// Exact paths whose create/update verbs (POST/PUT/PATCH) are excluded. They
/// write an agent's identity mode and account allowlist, or attach one of the
/// user's connected accounts to an agent. The loopback runs with node power, so
/// an agent limited to its own identity (or to some accounts) could otherwise
/// widen its own access, mint an unrestricted agent, or bind itself to the
/// user's account events, all without the review `configure_agent` requires.
const DENIED_AGENT_ACCESS_WRITES: &[&str] = &[
    "/api/agents",
    "/api/agents/{id}",
    "/api/agents/import",
    "/api/agents/published/install",
    "/api/composio/targets",
    "/api/composio/triggers",
    "/api/composio/triggers/subscribe",
];

/// Path prefixes whose writes (every verb but GET) manage the user's account
/// connections or credentials. A prefix matches the path itself or anything
/// below it at a segment boundary. The loopback carries no verified user, so
/// these would connect, re-key or tear down the user's own accounts (the
/// default Composio entity, provider keys and sign-ins, sealed vault values)
/// with node power, for every agent including one that acts as the user. The
/// sanctioned way to connect an account is the `consent.connect_app` card,
/// which the user completes from the desktop. Reads (status, lists) stay.
const DENIED_CREDENTIAL_WRITE_PREFIXES: &[&str] = &[
    // Composio connections on the user's entity: initiate, complete, any `/{id}`.
    "/api/composio/connections",
    // Model-provider keys, accounts, pools, checks, sign-ins.
    "/api/pi-config/providers",
    // Provider sign-in sessions.
    "/api/pi-config/login",
    // Gateway BYOK provider keys.
    "/api/gateway/providers",
    // Seals a GitHub token, or imported shell variables, into the user's vault.
    "/api/cloud-environments/github",
    "/api/cloud-environments/import",
    // Pairs a managed chat bot to the user's channels.
    "/api/channels/managed-bot",
    // Mints the backup recovery credential.
    "/api/backups/recovery-key",
];

/// Exact paths whose writes manage credentials (see
/// [`DENIED_CREDENTIAL_WRITE_PREFIXES`]). `/api/pi-config` writes the managed
/// Pi `auth.json` in direct-provider mode; `/api/cloud-environments` replaces
/// templates together with their sealed vault values.
const DENIED_CREDENTIAL_WRITE_EXACT: &[&str] = &["/api/pi-config", "/api/cloud-environments"];

/// `(method, path)` writes under a denied prefix that change a setting, not a
/// credential, and so stay available. Toggling whether one of a provider's
/// models is offered stores no key or sign-in. The method is part of the match
/// so a resolved `DELETE /api/pi-config/providers/{id}` can never reach it.
const ALLOWED_SETTING_WRITES: &[(&str, &str)] = &[
    ("post", "/api/pi-config/providers/model-enabled"),
    // Re-applies the saved provider revision to the running Gateway without
    // changing any credential bytes.
    ("post", "/api/gateway/providers/apply"),
];

/// Segments after `/api/plugins/<id>/` (and its `/api/apps/<id>/` alias)
/// whose writes manage a plugin's MCP sign-ins (`auth`), stored secrets
/// (`secrets`) or the permissions the user granted it (`grants`).
const DENIED_PLUGIN_CREDENTIAL_SEGMENTS: &[&str] = &["auth", "secrets", "grants"];

/// Segments after `/api/agents/<id>/` whose writes sign an agent runtime in or
/// out, or switch or remove its accounts.
const DENIED_AGENT_LOGIN_SEGMENTS: &[&str] = &["accounts", "native-accounts", "authenticate"];

/// Whether `(path, method)` is a write that connects, re-keys or removes one of
/// the user's accounts or credentials. GET is never a credential write. Works on
/// route templates and on resolved paths alike.
fn is_credential_write(path: &str, method: &str) -> bool {
    if method.eq_ignore_ascii_case("get") {
        return false;
    }
    if ALLOWED_SETTING_WRITES
        .iter()
        .any(|(verb, allowed)| method.eq_ignore_ascii_case(verb) && path == *allowed)
    {
        return false;
    }
    if DENIED_CREDENTIAL_WRITE_EXACT.contains(&path) {
        return true;
    }
    let under = |prefix: &str| {
        path.strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    };
    if DENIED_CREDENTIAL_WRITE_PREFIXES.iter().any(|p| under(p)) {
        return true;
    }
    let after_id_has = |prefix: &str, segments: &[&str]| {
        path.strip_prefix(prefix).is_some_and(|rest| {
            rest.split('/')
                .skip(1)
                .any(|segment| segments.contains(&segment))
        })
    };
    after_id_has("/api/plugins/", DENIED_PLUGIN_CREDENTIAL_SEGMENTS)
        || after_id_has("/api/apps/", DENIED_PLUGIN_CREDENTIAL_SEGMENTS)
        || after_id_has("/api/agents/", DENIED_AGENT_LOGIN_SEGMENTS)
}

/// Substrings marking non-request/response routes (WebSocket upgrades + SSE
/// streams). A blocking loopback call to these hangs until timeout, so they are
/// never useful as request/response tools and are excluded at generation time.
const DENIED_STREAMING_SUBSTRINGS: &[&str] = &[
    "/ws", // websocket upgrade routes (…_ws, /ws/…)
    "_ws", "stream",  // SSE stream routes (…/stream, …_stream)
    "/events", // SSE event feeds
];

/// Whether `(path, method)` must be excluded from the CoreApi catalog.
///
/// `method` is lowercase (`get`/`post`/…). Besides the prefix/exact/streaming
/// rules, **mutating** verbs under `/api/approvals/` are denied: an agent must
/// never be able to approve or reject its own approvals (that would defeat the
/// entire HITL gate). Approvals *reads* (GET) remain allowed.
pub fn is_denied(path: &str, method: &str) -> bool {
    if DENIED_EXACT.contains(&path) {
        return true;
    }
    if DENIED_PREFIXES.iter().any(|p| path.starts_with(p)) {
        return true;
    }
    if DENIED_STREAMING_SUBSTRINGS.iter().any(|s| path.contains(s)) {
        return true;
    }
    // Webhook signing secrets are credentials even though the registry/list
    // routes themselves are metadata-only.
    if path.starts_with("/api/webhooks/") && path.ends_with("/secret") {
        return true;
    }
    // The app host-capability bridge (`/api/plugins/:id/host`, and its `/stream`
    // sibling) is the trusted desktop's channel for Companion frames. It carries
    // user-aware operations (Safe Actions plan review, webhook signing secrets)
    // that a node-token loopback with no user would run as `local-operator` on an
    // unbound node: self-approval and credential exposure. `/host/stream` is also
    // caught by the streaming rule; this names both on purpose. Any `host` segment
    // after the id counts, so a scoped id resolved into the path (`@scope/name`)
    // cannot shift the bridge segment out of reach.
    if let Some(rest) = path.strip_prefix("/api/plugins/") {
        if rest.split('/').skip(1).any(|segment| segment == "host") {
            return true;
        }
    }
    // An agent's own Composio accounts (`/api/agents/{id}/composio/…`) are
    // operator-only for every verb: connecting one adds it to that agent's
    // allowlist, and listing or disconnecting them manages the agent's
    // identity. The loopback runs with node power, so an agent could otherwise
    // grow, inspect or tear down its own accounts without the user. A
    // `composio` segment anywhere after the id counts.
    if let Some(rest) = path.strip_prefix("/api/agents/") {
        if rest.split('/').skip(1).any(|segment| segment == "composio") {
            return true;
        }
    }
    if DENIED_AGENT_ACCESS_WRITES.contains(&path)
        && ["post", "put", "patch"]
            .iter()
            .any(|verb| method.eq_ignore_ascii_case(verb))
    {
        return true;
    }
    // Account connections and credentials: reads OK, writes forbidden for every
    // agent (see `DENIED_CREDENTIAL_WRITE_PREFIXES`).
    if is_credential_write(path, method) {
        return true;
    }
    // Removing a trigger subscription tears down the user's event binding,
    // which only the user may do (creating one is in
    // `DENIED_AGENT_ACCESS_WRITES`).
    if path.starts_with("/api/composio/trigger-subscriptions/")
        && method.eq_ignore_ascii_case("delete")
    {
        return true;
    }
    // Approvals: reads OK, mutations forbidden (self-approval bypass).
    if path.starts_with("/api/approvals/") && !method.eq_ignore_ascii_case("get") {
        return true;
    }
    false
}

// ── Restricted-account agents (reviewed write allowlist) ──────────────────────

/// The only write routes (`METHOD`, OpenAPI path template) an agent with a
/// restricted account policy (an "Its own identity" or "Both" agent, or any
/// agent with an account allowlist) may call through the self-API.
///
/// The loopback runs with the node's full power, not the agent's account
/// policy, so every write not listed here is refused for those agents, and so
/// is every route added later until someone reviews it. Each entry edits
/// workspace content only. Deliberately left out, even under these prefixes:
/// - credentials, connections, accounts, the vault, plugins and their secrets,
///   agents and their records, triggers and automations;
/// - sharing (`…/access`, `…/visibility`, `…/export`, `/api/spaces/import`);
/// - anything that runs an agent, a tool or a workflow (conversation
///   participants, fork, regenerate, edit, pull requests, goal start/resume,
///   chat forms/questions/follow-ups);
/// - anything that spends on a model provider outside the agent's
///   `provider:` allowlist (retitle, model selection, retrieval, search,
///   suggestions, prompt-suite runs, learning score/merge/cycle);
/// - node settings (memory and download settings, new model downloads).
const RESTRICTED_SAFE_WRITES: &[(&str, &str)] = &[
    // Spaces: notes, documents, pages, whiteboards, databases, files.
    ("POST", "/api/spaces"),
    ("DELETE", "/api/spaces/{id}"),
    ("POST", "/api/spaces/{id}/name"),
    ("POST", "/api/spaces/{id}/icon"),
    ("POST", "/api/spaces/{id}/documents"),
    ("PUT", "/api/spaces/{id}/documents/{doc_id}"),
    ("DELETE", "/api/spaces/{id}/documents/{doc_id}"),
    ("PUT", "/api/spaces/{id}/documents/{doc_id}/blob"),
    ("POST", "/api/spaces/{id}/documents/{doc_id}/icon"),
    ("POST", "/api/spaces/{id}/documents/{doc_id}/versions"),
    (
        "POST",
        "/api/spaces/{id}/documents/{doc_id}/versions/{version_id}/restore",
    ),
    ("POST", "/api/spaces/{id}/pages"),
    ("POST", "/api/spaces/{id}/whiteboards"),
    ("POST", "/api/spaces/{id}/databases"),
    ("POST", "/api/spaces/{id}/databases/{doc_id}/query"),
    ("POST", "/api/spaces/{id}/files"),
    // Memory entries and Dream proposals (not memory settings).
    ("PUT", "/api/memory/{id}"),
    ("POST", "/api/memory/dream/review/proposals/{id}/accept"),
    ("POST", "/api/memory/dream/review/proposals/{id}/reject"),
    // Conversation housekeeping.
    ("POST", "/api/conversations/{id}/title"),
    ("POST", "/api/conversations/{id}/icon"),
    ("POST", "/api/conversations/{id}/pinned"),
    ("POST", "/api/conversations/{id}/archived"),
    ("POST", "/api/conversations/{id}/folder"),
    ("POST", "/api/conversations/{id}/read"),
    ("POST", "/api/conversations/{id}/save"),
    ("POST", "/api/conversations/{id}/goal/pause"),
    ("DELETE", "/api/conversations/{id}/goal"),
    ("POST", "/api/conversations/{id}/history-preview"),
    ("POST", "/api/conversations/{id}/git-history"),
    ("PUT", "/api/conversations/{id}/ui-state/{tool_call_id}"),
    (
        "POST",
        "/api/conversations/{id}/messages/{message_id}/feedback",
    ),
    (
        "POST",
        "/api/conversations/{id}/messages/{message_id}/reactions",
    ),
    (
        "DELETE",
        "/api/conversations/{id}/messages/{message_id}/reactions",
    ),
    (
        "POST",
        "/api/conversations/{id}/messages/{message_id}/select",
    ),
    (
        "POST",
        "/api/conversations/{id}/checkpoints/{checkpoint_id}/restore",
    ),
    ("POST", "/api/chat/cancel"),
    // Notifications.
    ("POST", "/api/notifications/{id}/ack"),
    ("POST", "/api/notifications/{id}/read"),
    ("POST", "/api/notifications/{id}/archive"),
    ("POST", "/api/notifications/{id}/unarchive"),
    // Prompt-suite authoring and review (not runs).
    ("POST", "/api/prompt-suites"),
    ("PUT", "/api/prompt-suites/{id}"),
    ("DELETE", "/api/prompt-suites/{id}"),
    ("POST", "/api/prompt-suites/{id}/versions"),
    (
        "POST",
        "/api/prompt-suites/{id}/versions/{version_id}/restore",
    ),
    ("POST", "/api/prompt-suites/{id}/traces"),
    ("PUT", "/api/prompt-suites/{id}/runs/{run_id}"),
    ("DELETE", "/api/prompt-suites/{id}/runs/{run_id}"),
    ("POST", "/api/prompt-suites/{id}/runs/{run_id}/reviews"),
    // Learning capture, improvements, activity and presence.
    ("POST", "/api/learn/exclude"),
    ("POST", "/api/learn/sweep"),
    ("POST", "/api/improvements"),
    ("POST", "/api/improvements/{id}/transition"),
    ("POST", "/api/activity"),
    ("PUT", "/api/presence"),
    ("PUT", "/api/presence/gaming"),
    // Uploads and workspace folders.
    ("POST", "/api/uploads"),
    ("POST", "/api/media/upload"),
    ("POST", "/api/workspace/new-folder"),
    // Widget state (not the widget tool bridge, app opens or follow-ups).
    ("POST", "/api/widgets/state"),
    // Downloads already queued (not new model downloads or settings).
    ("POST", "/api/downloads/{id}/pause"),
    ("POST", "/api/downloads/{id}/resume"),
    ("POST", "/api/downloads/{id}/cancel"),
    ("POST", "/api/downloads/{id}/retry"),
    ("DELETE", "/api/downloads/{id}"),
    ("DELETE", "/api/downloads/history"),
];

/// Whether an agent with a restricted account policy may call this route
/// through the self-API. Reads are always allowed (they pass the same
/// denylist as everyone); a write must be on [`RESTRICTED_SAFE_WRITES`].
pub fn restricted_agent_may_write(path_template: &str, method: &str) -> bool {
    if method.eq_ignore_ascii_case("get") {
        return true;
    }
    RESTRICTED_SAFE_WRITES
        .iter()
        .any(|(m, p)| m.eq_ignore_ascii_case(method) && *p == path_template)
}

/// The refusal for a restricted-account agent calling `tool_id`, or `None`
/// when the call may proceed. Reads pass. A write passes only when it resolves
/// to a reviewed workspace-content route; an id that resolves to no route is
/// refused, so this fails closed.
pub fn restricted_write_refusal(tool_id: &str) -> Option<String> {
    if !is_mutating(tool_id) {
        return None;
    }
    let allowed = route_for(tool_id)
        .is_some_and(|route| restricted_agent_may_write(&route.path_template, &route.method));
    if allowed {
        return None;
    }
    Some(format!(
        "tool '{tool_id}' can reach accounts, credentials, connections, agents, plugins, \
         providers or automations with your full access, which this agent's account access \
         does not allow. It may still edit workspace content (Spaces, memory, conversations, \
         notifications)."
    ))
}

/// Creating a Space is on [`RESTRICTED_SAFE_WRITES`] only as private content: an
/// org- or team-visible Space would share what the agent then writes into it,
/// and sharing is not workspace housekeeping. `None` when the call may go ahead.
pub fn restricted_sharing_refusal(tool_id: &str, arguments: &serde_json::Value) -> Option<String> {
    let route = route_for(tool_id)?;
    if route.method != "POST" || route.path_template != "/api/spaces" {
        return None;
    }
    let visibility = arguments
        .get("body")
        .and_then(|body| body.get("visibility"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .unwrap_or("private");
    (visibility != "private").then(|| {
        format!(
            "this agent's account access is limited, so it may create only private Spaces, \
             not a '{visibility}' one; share it yourself if you want others to see it"
        )
    })
}

// ── Route model ───────────────────────────────────────────────────────────────

/// One CoreApi tool: an OpenAPI operation reduced to what dispatch needs.
#[derive(Debug, Clone)]
pub struct CoreApiRoute {
    /// `ryu_api.<method>_<path_slug>`.
    pub id: String,
    /// Uppercase HTTP method (`GET`/`POST`/…).
    pub method: String,
    /// The OpenAPI path template, e.g. `/api/quests/{id}`.
    pub path_template: String,
    /// Human summary (from the operation summary/description).
    pub summary: String,
    /// Path-parameter names (all required by construction).
    pub path_params: Vec<String>,
    /// Query-parameter names.
    pub query_params: Vec<String>,
    /// Whether the operation takes a request body (sent as the `body` arg).
    pub has_body: bool,
    /// A JSON-schema `object` describing the args (path + query + `body`), reused
    /// for both the descriptor arg summary and the full `describe` output.
    pub input_schema: Value,
}

/// Build the route table once from the generated OpenAPI spec. Cached: the spec
/// is stable for a build. Walks the serialized JSON (version-robust) rather than
/// the utoipa Rust type API.
pub fn routes() -> &'static [CoreApiRoute] {
    static ROUTES: OnceLock<Vec<CoreApiRoute>> = OnceLock::new();
    ROUTES.get_or_init(|| {
        let spec = serde_json::to_value(crate::server::openapi::api_doc()).unwrap_or(Value::Null);
        build_routes(&spec)
    })
}

/// Pure route extraction from an OpenAPI JSON value (unit-testable).
pub fn build_routes(spec: &Value) -> Vec<CoreApiRoute> {
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let Some(paths) = spec.get("paths").and_then(Value::as_object) else {
        return out;
    };
    for (path, item) in paths {
        for &method in METHODS {
            let Some(op) = item.get(method) else {
                continue;
            };
            if is_denied(path, method) {
                continue;
            }

            let summary = op
                .get("summary")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .or_else(|| op.get("description").and_then(Value::as_str))
                .unwrap_or_default()
                .to_string();

            let mut path_params = Vec::new();
            let mut query_params = Vec::new();
            let mut props = serde_json::Map::new();
            let mut required: Vec<String> = Vec::new();

            if let Some(params) = op.get("parameters").and_then(Value::as_array) {
                for p in params {
                    let Some(name) = p.get("name").and_then(Value::as_str) else {
                        continue;
                    };
                    let loc = p.get("in").and_then(Value::as_str).unwrap_or_default();
                    let req = p.get("required").and_then(Value::as_bool).unwrap_or(false);
                    let desc = p
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let ty = p
                        .get("schema")
                        .and_then(|s| s.get("type"))
                        .and_then(Value::as_str)
                        .unwrap_or("string");
                    match loc {
                        "path" => {
                            path_params.push(name.to_string());
                            required.push(name.to_string()); // path params are always required
                        }
                        "query" => {
                            query_params.push(name.to_string());
                            if req {
                                required.push(name.to_string());
                            }
                        }
                        // header/cookie params are not agent-controllable — skip.
                        _ => continue,
                    }
                    props.insert(name.to_string(), json!({ "type": ty, "description": desc }));
                }
            }

            let has_body = op.get("requestBody").is_some();
            if has_body {
                props.insert(
                    "body".to_string(),
                    json!({
                        "type": "object",
                        "description": "JSON request body (shallow: the whole body as one argument)."
                    }),
                );
                let body_required = op
                    .get("requestBody")
                    .and_then(|b| b.get("required"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if body_required {
                    required.push("body".to_string());
                }
            }

            let id = format!("{ID_PREFIX}{method}_{}", slug(path));
            if !seen.insert(id.clone()) {
                // Two operations slugged to the same id — keep the first, warn.
                // Deterministic (METHODS order + IndexMap path order) so the same
                // one always wins.
                debug_assert!(false, "duplicate core-api tool id: {id} ({method} {path})");
                tracing::warn!(
                    "self_api: duplicate core-api tool id {id} ({method} {path}); keeping first"
                );
                continue;
            }

            let input_schema = json!({
                "type": "object",
                "properties": Value::Object(props),
                "required": required,
            });

            out.push(CoreApiRoute {
                id,
                method: method.to_ascii_uppercase(),
                path_template: path.clone(),
                summary,
                path_params,
                query_params,
                has_body,
                input_schema,
            });
        }
    }
    out
}

/// Slugify an OpenAPI path into the id tail: lowercase, non-alphanumerics → `_`,
/// runs of `_` collapsed, edges trimmed. `/api/quests/{id}` → `api_quests_id`.
fn slug(path: &str) -> String {
    let mut s = String::with_capacity(path.len());
    let mut prev_us = false;
    for c in path.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
            prev_us = false;
        } else if !prev_us {
            s.push('_');
            prev_us = true;
        }
    }
    s.trim_matches('_').to_string()
}

// ── Catalog surface (search / describe) ───────────────────────────────────────

/// Every CoreApi tool as a [`ToolDescriptor`] for the unified catalog. Merged
/// into `McpRegistry::search_scoped`'s `builtins` so it ranks with everything else.
pub fn descriptors() -> Vec<ToolDescriptor> {
    routes()
        .iter()
        .map(|r| {
            let (arg_names, arg_descriptions) = arg_summary(Some(&r.input_schema));
            ToolDescriptor {
                id: r.id.clone(),
                name: format!("{} {}", r.method, r.path_template),
                description: r.summary.clone(),
                kind: ToolKind::CoreApi,
                arg_names,
                arg_descriptions,
                score: None,
                meta: None,
                widget_accessible: false,
                output_template: None,
            }
        })
        .collect()
}

/// Describe one CoreApi tool by id (`None` when the id is unknown / not CoreApi).
pub fn describe(id: &str) -> Option<DescribedTool> {
    let normalized_id = crate::sidecar::mcp::canonical_tool_id(id);
    let r = routes().iter().find(|r| r.id == normalized_id)?;
    Some(describe_from_parts(
        &r.id,
        &format!("{} {}", r.method, r.path_template),
        &r.summary,
        ToolKind::CoreApi,
        Some(&r.input_schema),
    ))
}

/// The route behind a CoreApi tool id (`None` when unknown / not CoreApi). Used
/// to show the user which endpoint an in-chat permission prompt would call.
pub fn route_for(id: &str) -> Option<&'static CoreApiRoute> {
    let normalized_id = crate::sidecar::mcp::canonical_tool_id(id);
    routes().iter().find(|r| r.id == normalized_id)
}

// ── Method / kind helpers (for the approval policy + dispatch gate) ────────────

/// Whether a tool id belongs to the CoreApi plane.
pub fn is_core_api(tool_id: &str) -> bool {
    tool_id.starts_with(ID_PREFIX) || tool_id.starts_with(LEGACY_ID_PREFIX)
}

/// The lowercase HTTP method encoded in a CoreApi tool id (`ryu_api.get_…` →
/// `get`). `None` for non-CoreApi ids. HTTP verbs contain no `_`, so the method
/// is exactly the segment between the prefix and the first `_`.
pub fn method_of(tool_id: &str) -> Option<&str> {
    let rest = tool_id
        .strip_prefix(ID_PREFIX)
        .or_else(|| tool_id.strip_prefix(LEGACY_ID_PREFIX))?;
    rest.split('_').next()
}

/// Gateway config sections an agent may not write through the self-API. Each
/// carries credentials or decides where traffic and secrets go, what is
/// filtered, or what is recorded: `egress` proxy credentials can name any
/// environment variable (a provider key sent to a proxy the agent chose),
/// `auth` mints API keys, the `firewall` sections switch off DLP and
/// prompt-injection checks, and `audit` controls the record of what the agent
/// did. Like provider keys, they stay in Settings.
const GATEWAY_CONFIG_SETTINGS_ONLY: &[&str] = &[
    "auth",
    "audit",
    "bind",
    "channels",
    "composio",
    "control_plane",
    "egress",
    "firewall",
    "firewall_agent_overlays",
    "firewall_org_overlays",
    "providers",
];

/// The first settings-only section a Gateway config write would touch, if any.
fn gateway_config_settings_only_section(
    path: &str,
    method: &str,
    args: &Value,
) -> Option<&'static str> {
    if path != "/api/gateway/config" || method.eq_ignore_ascii_case("get") {
        return None;
    }
    let Some(Value::Object(patch)) = args.get("body") else {
        return None;
    };
    GATEWAY_CONFIG_SETTINGS_ONLY
        .iter()
        .copied()
        .find(|section| patch.contains_key(*section))
}

/// Whether this is a **mutating** CoreApi tool (any non-GET verb). The approval
/// policy gates these in every approval mode, including an explicit `off`. See
/// [`crate::approvals::policy::should_require_approval_local`].
pub fn is_mutating(tool_id: &str) -> bool {
    is_core_api(tool_id) && !matches!(method_of(tool_id), Some("get"))
}

// ── Role gate (org-bound nodes) ───────────────────────────────────────────────

/// The organization permission a person needs before an agent may call this
/// route for them on an org-bound node. `None` means the route has no declared
/// permission, so agents cannot call it on a shared node at all.
///
/// The table exists because the loopback request passes Core's route policy as
/// the node owner. Handlers that check `enforce_permission` would refuse a
/// person without the permission anyway, but several Gateway handlers rely on
/// the route policy alone (audit, batches, evals, routing policy). Checking
/// here, before dispatch, gives every reachable route the same role check.
pub fn required_permission(path_template: &str, method: &str) -> Option<&'static str> {
    use crate::identity_verify::permissions as perm;
    let read = method.eq_ignore_ascii_case("get");
    let gateway =
        path_template.starts_with("/api/gateway/") || path_template.starts_with("/api/routing/");
    if path_template.starts_with("/api/gateway/audit") || path_template == "/api/usage/me" {
        return read.then_some(perm::AUDIT_VIEW);
    }
    if gateway {
        return Some(if read {
            perm::GATEWAY_VIEW
        } else {
            perm::GATEWAY_CONFIGURE
        });
    }
    None
}

/// Who an agent is acting for on an org-bound node, and what Core knows about
/// the conversation it was asked in.
pub struct ActingUser<'a> {
    pub user_id: &'a str,
    pub org_id: Option<&'a str>,
    /// Only the asker can answer the in-chat permission card in a private chat
    /// with no collaborators. In a shared chat another person could prompt the
    /// agent to act with the owner's role, so shared chats are refused.
    pub private_conversation: bool,
}

/// Decide whether an agent may call `route` for `user` on an org-bound node.
/// `node_owner` is the owner of a Personal-scope node, and `permissions` is the
/// person's effective permission set from the control plane (empty on any
/// lookup failure, which refuses).
pub fn acting_user_refusal(
    route: &CoreApiRoute,
    user: &ActingUser<'_>,
    node_org: &str,
    node_owner: Option<&str>,
    permissions: &HashSet<String>,
) -> Option<String> {
    let Some(permission) = required_permission(&route.path_template, &route.method) else {
        return Some(format!(
            "{} {} is not available to agents on a shared node. Use Settings instead.",
            route.method, route.path_template
        ));
    };
    if !user.private_conversation {
        return Some(
            "Agents only change Ryu settings from a private chat on a shared node. Start a new \
             chat that is not shared and ask again."
                .to_owned(),
        );
    }
    if user.org_id != Some(node_org) {
        return Some("You are not a member of the organization this node belongs to.".to_owned());
    }
    if node_owner == Some(user.user_id) || permissions.contains(permission) {
        return None;
    }
    Some(format!(
        "Your role does not include `{permission}`, which {} {} needs. Ask an organization \
         admin to make this change or to grant you that permission.",
        route.method, route.path_template
    ))
}

// ── Tenancy gate ──────────────────────────────────────────────────────────────

/// The tenancy invariant, as a pure decision so it can be unit-tested.
///
/// `unrestricted` is `true` iff the calling principal is
/// [`crate::sidecar::mcp::ToolPrincipal::Unrestricted`] — i.e. the node is
/// **unbound/personal**. On any org-bound node the loopback request would carry
/// the node's own `RYU_TOKEN` (full power, not the agent's principal scope), so
/// CoreApi tools must refuse. Returns the refusal message when they must, else
/// `None`.
pub fn refuse_reason_if_tenant_bound(unrestricted: bool) -> Option<String> {
    if unrestricted {
        None
    } else {
        Some(
            "Core self-API tools are disabled on shared (org-bound) nodes: a loopback call would \
             run with the node's own credentials rather than your scoped identity. Use them on a \
             personal node."
                .to_string(),
        )
    }
}

// ── Dispatch (loopback HTTP) ──────────────────────────────────────────────────

/// This node's own base URL + admittance token for the loopback call.
fn self_target() -> (String, Option<String>) {
    (
        crate::sidecar::gateway::core_self_url(),
        crate::node_token::active_token().filter(|token| !token.is_empty()),
    )
}

/// Header carrying [`self_call_proof`] on a loopback that acts for a person.
pub const SELF_CALL_PROOF_HEADER: &str = "x-ryu-self-call-proof";
/// Header naming the person a proven loopback acts for.
pub const SELF_CALL_USER_HEADER: &str = "x-ryu-self-call-user";

/// A random secret that exists only in this Core process. A loopback carrying
/// it alongside the node token runs as the named person instead of as the node
/// owner, so handlers apply that person's role. Nothing outside this process
/// can mint it, so holding the node token alone never lets a client claim to be
/// a particular member.
pub fn self_call_proof() -> &'static str {
    static PROOF: OnceLock<String> = OnceLock::new();
    PROOF.get_or_init(|| {
        let bytes: [u8; 32] = rand::random();
        hex::encode(bytes)
    })
}

/// The person a node-token request acts for, when it carries a self-call proof.
pub enum SelfCallIdentity {
    /// No proof header: an ordinary node-token request.
    Absent,
    /// A valid proof naming this person.
    Acting(String),
    /// A proof header that does not match, or names nobody.
    Invalid,
}

/// Read the self-call headers. Only meaningful after the node token checked out.
pub fn self_call_identity(headers: &axum::http::HeaderMap) -> SelfCallIdentity {
    let Some(proof) = headers.get(SELF_CALL_PROOF_HEADER) else {
        return SelfCallIdentity::Absent;
    };
    let proof_matches = proof
        .to_str()
        .is_ok_and(|proof| crate::server::ct_eq(proof, self_call_proof()));
    let user = headers
        .get(SELF_CALL_USER_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|user| !user.is_empty());
    match (proof_matches, user) {
        (true, Some(user)) => SelfCallIdentity::Acting(user.to_owned()),
        _ => SelfCallIdentity::Invalid,
    }
}

/// Execute a CoreApi tool by id: resolve the route, then loop back over HTTP to
/// this Core with its own token. The tenancy and role checks are enforced by the
/// caller (`sidecar/mcp/mod.rs`) *before* this runs. `acting_user` is set on an
/// org-bound node, so the handlers see that person rather than the node owner.
pub async fn dispatch(
    http: &reqwest::Client,
    tool_id: &str,
    args: Value,
    acting_user: Option<&str>,
) -> Result<Value> {
    let route = routes()
        .iter()
        .find(|r| r.id == tool_id)
        .ok_or_else(|| anyhow!("unknown core-api tool '{tool_id}'"))?;
    let (base, token) = self_target();
    send_request_as(http, &base, token.as_deref(), route, &args, acting_user).await
}

/// The pure request builder + sender (base/token injected, so tests can point it
/// at an ephemeral server without touching process env).
pub async fn send_request(
    http: &reqwest::Client,
    base: &str,
    token: Option<&str>,
    route: &CoreApiRoute,
    args: &Value,
) -> Result<Value> {
    send_request_as(http, base, token, route, args, None).await
}

/// [`send_request`] acting for a person (see [`self_call_proof`]).
pub async fn send_request_as(
    http: &reqwest::Client,
    base: &str,
    token: Option<&str>,
    route: &CoreApiRoute,
    args: &Value,
    acting_user: Option<&str>,
) -> Result<Value> {
    // Substitute path params. SECURITY: a path parameter is a SINGLE path
    // segment. The denylist ([`is_denied`]) is evaluated once, at descriptor
    // build time, against the route *template* — so an unsanitized value like
    // `../auth/x` or `..%2f..` would reshape the resolved path past the denylist
    // and hit an arbitrary Core endpoint under the node token (traversal / IDOR).
    // Reject any value that could escape its segment, then re-run the denylist on
    // the fully-resolved path as defense-in-depth.
    let mut path = route.path_template.clone();
    for p in &route.path_params {
        let v = args
            .get(p)
            .filter(|v| !v.is_null())
            .map(value_to_string)
            .ok_or_else(|| {
                anyhow!(
                    "core-api tool '{}' is missing required path parameter '{p}'",
                    route.id
                )
            })?;
        if !is_safe_path_segment(&v) {
            return Err(anyhow!(
                "core-api tool '{}' path parameter '{p}' has an unsafe value \
				 (path separators, URL delimiters, '..', '%', or control characters are rejected)",
                route.id
            ));
        }
        path = path.replace(&format!("{{{p}}}"), &v);
    }
    // Defense-in-depth: the resolved path must still clear the denylist.
    if is_denied(&path, &route.method) {
        return Err(anyhow!(
            "core-api tool '{}' resolved to a denied path '{path}'",
            route.id
        ));
    }
    if let Some(section) = gateway_config_settings_only_section(&path, &route.method, args) {
        return Err(anyhow!(
            "core-api tool '{}' cannot change the Gateway's `{section}` settings. They carry \
             credentials, network egress, safety filters, or the audit trail; change them in \
             Settings instead",
            route.id
        ));
    }
    let url = format!("{}{}", base.trim_end_matches('/'), path);

    let method = reqwest::Method::from_bytes(route.method.as_bytes())
        .map_err(|e| anyhow!("core-api tool '{}' has a bad method: {e}", route.id))?;
    let mut req = http.request(method, &url).timeout(LOOPBACK_TIMEOUT);

    // Query params (reqwest handles the encoding).
    let query: Vec<(String, String)> = route
        .query_params
        .iter()
        .filter_map(|q| {
            args.get(q)
                .filter(|v| !v.is_null())
                .map(|v| (q.clone(), value_to_string(v)))
        })
        .collect();
    if !query.is_empty() {
        req = req.query(&query);
    }
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    if let Some(user) = acting_user {
        req = req
            .header(SELF_CALL_PROOF_HEADER, self_call_proof())
            .header(SELF_CALL_USER_HEADER, user);
    }
    if route.has_body {
        req = req.json(&args.get("body").cloned().unwrap_or(Value::Null));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| anyhow!("core-api loopback to {} failed: {e}", route.path_template))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    // Return the parsed JSON body when possible, else the raw text.
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    Ok(json!({
        "status": status.as_u16(),
        "ok": status.is_success(),
        "body": body,
    }))
}

/// Stringify a JSON value for use in a path/query position (strings unquoted).
fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// True when `v` is safe to substitute into a single path segment. Rejects the
/// separators and encodings an attacker would use to escape the segment and
/// reshape the resolved path (`/`, `\`, `..`, `%`-encoding) plus ASCII control
/// characters. Empty is rejected too — a required path param must have a value.
fn is_safe_path_segment(v: &str) -> bool {
    !v.is_empty()
        && !v.contains('/')
        && !v.contains('\\')
        && !v.contains('?')
        && !v.contains('#')
        && !v.contains("..")
        && !v.contains('%')
        && !v.chars().any(|c| c.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agents_cannot_write_credential_or_safety_sections_of_the_gateway_config() {
        let write = |body: Value| {
            gateway_config_settings_only_section(
                "/api/gateway/config",
                "PUT",
                &json!({ "body": body }),
            )
        };
        assert_eq!(write(json!({ "egress": { "pools": [] } })), Some("egress"));
        assert_eq!(write(json!({ "auth": { "api_keys": [] } })), Some("auth"));
        assert_eq!(
            write(json!({ "firewall": { "dlp": false } })),
            Some("firewall")
        );
        assert_eq!(
            write(json!({ "budgets": {}, "firewall_org_overlays": {} })),
            Some("firewall_org_overlays")
        );
        assert_eq!(
            write(json!({ "routing": {}, "budgets": {}, "cache": {} })),
            None
        );
        // Reads, and other routes, are not affected.
        assert_eq!(
            gateway_config_settings_only_section(
                "/api/gateway/config",
                "GET",
                &json!({ "body": { "egress": {} } })
            ),
            None
        );
        assert_eq!(
            gateway_config_settings_only_section(
                "/api/routing/policy",
                "PUT",
                &json!({ "body": { "egress": {} } })
            ),
            None
        );
    }

    fn sample_spec() -> Value {
        json!({
            "paths": {
                "/api/quests": {
                    "get": { "summary": "List quests" },
                    "post": {
                        "summary": "Create a quest",
                        "requestBody": { "required": true }
                    }
                },
                "/api/quests/{id}": {
                    "delete": {
                        "summary": "Delete a quest",
                        "parameters": [
                            { "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }
                        ]
                    }
                },
                "/api/memory": {
                    "get": {
                        "summary": "List memory",
                        "parameters": [
                            { "name": "scope", "in": "query", "required": false, "schema": { "type": "string" } }
                        ]
                    }
                }
            }
        })
    }

    #[test]
    fn slug_shape() {
        assert_eq!(slug("/api/quests"), "api_quests");
        assert_eq!(slug("/api/quests/{id}"), "api_quests_id");
        assert_eq!(slug("/api/mcp/servers/{name}"), "api_mcp_servers_name");
    }

    #[test]
    fn ids_encode_method_and_slug() {
        let routes = build_routes(&sample_spec());
        let get = routes
            .iter()
            .find(|r| r.path_template == "/api/quests" && r.method == "GET")
            .unwrap();
        assert_eq!(get.id, "ryu_api.get_api_quests");
        assert_eq!(method_of(&get.id), Some("get"));
        assert!(!is_mutating(&get.id));

        let del = routes.iter().find(|r| r.method == "DELETE").unwrap();
        assert_eq!(del.id, "ryu_api.delete_api_quests_id");
        assert_eq!(method_of(&del.id), Some("delete"));
        assert!(is_mutating(&del.id));
        assert_eq!(del.path_params, vec!["id".to_string()]);
    }

    #[test]
    fn post_carries_body_arg() {
        let routes = build_routes(&sample_spec());
        let post = routes.iter().find(|r| r.method == "POST").unwrap();
        assert!(post.has_body);
        let (names, _) = arg_summary(Some(&post.input_schema));
        assert!(names.iter().any(|n| n == "body"));
    }

    #[test]
    fn query_param_becomes_arg_not_path() {
        let routes = build_routes(&sample_spec());
        let mem = routes
            .iter()
            .find(|r| r.path_template == "/api/memory")
            .unwrap();
        assert_eq!(mem.query_params, vec!["scope".to_string()]);
        assert!(mem.path_params.is_empty());
    }

    /// EVERY denylist entry must be absent from the generated catalog, at every
    /// verb — this is the security contract.
    #[test]
    fn denylist_is_enforced_for_every_entry() {
        for prefix in DENIED_PREFIXES {
            for m in METHODS {
                assert!(is_denied(&format!("{prefix}whatever"), m), "{prefix} {m}");
            }
        }
        for exact in DENIED_EXACT {
            for m in METHODS {
                assert!(is_denied(exact, m), "{exact} {m}");
            }
        }
        assert!(is_denied("/api/mesh/peers", "get"));
        assert!(is_denied("/api/identities", "get"));
        assert!(is_denied("/api/identities/connections", "get"));
        assert!(is_denied("/api/vault/secrets", "get"));
        assert!(is_denied("/api/vault/secrets/name", "post"));
        assert!(is_denied("/api/rules/discover", "get"));
        assert!(is_denied("/api/webhooks/workflow-1/secret", "get"));
        assert!(is_denied("/api/webhooks/workflow-1/secret", "post"));
        // Streaming/WS routes are excluded.
        assert!(is_denied("/api/chat/stream", "post"));
        assert!(is_denied("/api/realtime_ws", "get"));
        assert!(is_denied("/api/notifications/stream", "get"));
        assert!(is_denied("/api/events/all", "get"));
        // Approvals: reads allowed, mutations denied (no self-approval).
        assert!(!is_denied("/api/approvals", "get"));
        assert!(is_denied("/api/approvals/approve", "post"));
        assert!(is_denied("/api/approvals/reject", "post"));
        // Agent-record and trigger-binding writes are denied: an agent must not
        // widen its own account access or bind itself to the user's accounts.
        for path in DENIED_AGENT_ACCESS_WRITES {
            for m in ["post", "put", "patch"] {
                assert!(is_denied(path, m), "{path} {m}");
            }
            assert!(!is_denied(path, "get"), "{path} get");
        }
        assert!(is_denied("/api/agents/{id}", "put"));
        assert!(is_denied("/api/agents", "post"));
        assert!(is_denied("/api/composio/targets", "post"));
        assert!(!is_denied("/api/agents/{id}/usage", "get"));
        // An agent's own Composio accounts are operator-only for every verb.
        for path in [
            "/api/agents/{id}/composio/connections",
            "/api/agents/{id}/composio/connections/initiate",
            "/api/agents/{id}/composio/connections/{cid}",
            "/api/agents/@scope/name/composio/connections",
        ] {
            for m in METHODS {
                assert!(is_denied(path, m), "{path} {m}");
            }
        }
        // Self-approval of chat permission prompts and tool-dispatch recursion
        // through the widget bridge or the per-agent MCP endpoint are denied.
        for path in [
            "/api/chat/permission",
            "/api/widgets/tools/call",
            "/api/widgets/open",
            "/mcp/{agent_id}",
        ] {
            for m in METHODS {
                assert!(is_denied(path, m), "{path} {m}");
            }
        }
        // Account connection and credential writes are denied for every
        // agent; their reads stay available.
        for prefix in DENIED_CREDENTIAL_WRITE_PREFIXES {
            for m in ["post", "put", "patch", "delete"] {
                assert!(is_denied(prefix, m), "{prefix} {m}");
                assert!(is_denied(&format!("{prefix}/x"), m), "{prefix}/x {m}");
            }
        }
        for exact in DENIED_CREDENTIAL_WRITE_EXACT {
            for m in ["post", "put", "patch", "delete"] {
                assert!(is_denied(exact, m), "{exact} {m}");
            }
        }
        for (method, path) in [
            ("post", "/api/composio/connections/initiate"),
            ("post", "/api/composio/connections/complete"),
            (
                "post",
                "/api/plugins/{plugin_id}/auth/{server_name}/connect",
            ),
            ("post", "/api/plugins/notion/auth/notion/connect"),
            ("delete", "/api/plugins/{plugin_id}/auth/{server_name}"),
            ("put", "/api/plugins/{id}/secrets/{key}"),
            ("delete", "/api/plugins/notion/secrets/token"),
            ("post", "/api/plugins/{id}/grants"),
            ("post", "/api/apps/{id}/grants"),
            ("post", "/api/apps/notion/grants"),
            ("put", "/api/pi-config"),
            ("post", "/api/pi-config/providers"),
            ("delete", "/api/pi-config/providers/model-enabled"),
            ("put", "/api/pi-config/providers/model-enabled"),
            ("put", "/api/pi-config/providers/{id}/account-pool"),
            ("post", "/api/pi-config/providers/openai/accounts/switch"),
            ("post", "/api/pi-config/providers/{id}/login"),
            ("post", "/api/pi-config/login/s1/complete"),
            ("put", "/api/gateway/providers"),
            ("post", "/api/agents/{id}/accounts/switch"),
            ("post", "/api/agents/{id}/accounts/remove"),
            ("post", "/api/agents/{id}/authenticate"),
            ("post", "/api/agents/{id}/native-accounts"),
            ("post", "/api/agents/a1/native-accounts/k1/login"),
            (
                "delete",
                "/api/agents/{id}/native-accounts/operations/{operation_id}",
            ),
            ("put", "/api/cloud-environments"),
            ("post", "/api/cloud-environments/github"),
            ("post", "/api/cloud-environments/import"),
            ("post", "/api/channels/managed-bot/pair"),
            ("post", "/api/channels/managed-bot/{nonce}/confirm"),
            ("delete", "/api/channels/managed-bot/{nonce}"),
            ("post", "/api/backups/recovery-key"),
            ("delete", "/api/composio/trigger-subscriptions/{id}"),
        ] {
            assert!(is_denied(path, method), "{method} {path}");
        }
        for path in [
            "/api/composio/connections",
            "/api/composio/connections/{id}",
            "/api/plugins/{plugin_id}/auth",
            "/api/plugins/{plugin_id}/auth/flows/{flow_id}",
            "/api/plugins/{id}/secrets",
            "/api/pi-config",
            "/api/pi-config/providers/{id}/accounts",
            "/api/agents/{id}/accounts",
            "/api/agents/{id}/native-accounts",
            "/api/cloud-environments",
            "/api/cloud-environments/github",
            "/api/composio/trigger-subscriptions",
        ] {
            assert!(!is_denied(path, "get"), "{path} get");
        }
        // Near misses stay available.
        assert!(!is_denied("/api/agents/{id}/usage", "get"));
        assert!(!is_denied("/api/pi-config/providers-extra", "post"));
        assert!(!is_denied("/api/pi-config/discover-models", "post"));
        // Toggling a model on or off is a setting, not a credential.
        assert!(!is_denied("/api/pi-config/providers/model-enabled", "post"));
        assert!(!is_denied("/api/apps/{id}/enable", "post"));
        assert!(!is_denied("/api/cloud-environments/{id}/launch", "post"));
        assert!(!is_denied(
            "/api/cloud-environments/shared/{id}/import",
            "post"
        ));
        assert!(!is_denied("/api/plugins/{id}/enable", "post"));
        assert!(!is_denied("/api/plugins/auth/enable", "post"));
        assert!(!is_denied("/api/agents/accounts/x", "post"));
        assert!(!is_denied("/api/composio/toolkits", "get"));
        assert!(!is_denied("/api/composio/status", "get"));
        // Sanity: an ordinary route is allowed.
        assert!(!is_denied("/api/quests", "get"));
        assert!(!is_denied("/api/quests", "post"));
    }

    /// No agent, restricted or not, can connect, re-key or remove one of the
    /// user's accounts through the catalog. Guards against a refactor quietly
    /// bringing one back.
    #[test]
    fn credential_writes_are_absent_from_the_catalog() {
        for r in routes() {
            assert!(
                !is_credential_write(&r.path_template, &r.method),
                "credential write in the catalog: {} {}",
                r.method,
                r.path_template
            );
        }
        for id in [
            "ryu_api.post_api_composio_connections_initiate",
            "ryu_api.post_api_composio_connections_complete",
            "ryu_api.post_api_plugins_plugin_id_auth_server_name_connect",
            "ryu_api.delete_api_plugins_plugin_id_auth_server_name",
            "ryu_api.put_api_plugins_id_secrets_key",
            "ryu_api.delete_api_plugins_id_secrets_key",
            "ryu_api.post_api_plugins_id_grants",
            "ryu_api.post_api_apps_id_grants",
            "ryu_api.post_api_pi_config_providers",
            "ryu_api.put_api_pi_config",
            "ryu_api.put_api_gateway_providers",
            "ryu_api.post_api_agents_id_native_accounts",
            "ryu_api.post_api_agents_id_accounts_switch",
            "ryu_api.post_api_agents_id_authenticate",
            "ryu_api.put_api_cloud_environments",
            "ryu_api.post_api_cloud_environments_github",
            "ryu_api.post_api_cloud_environments_import",
            "ryu_api.post_api_channels_managed_bot_pair",
            "ryu_api.post_api_backups_recovery_key",
            "ryu_api.delete_api_composio_trigger_subscriptions_id",
        ] {
            assert!(route_for(id).is_none(), "{id} is in the catalog");
        }
        // Their reads are still offered.
        for id in [
            "ryu_api.get_api_composio_connections",
            "ryu_api.get_api_pi_config",
            "ryu_api.get_api_plugins_plugin_id_auth",
            "ryu_api.get_api_agents_id_native_accounts",
            "ryu_api.post_api_pi_config_providers_model_enabled",
        ] {
            assert!(route_for(id).is_some(), "{id} is not in the catalog");
        }
    }

    /// The resolved-path re-check refuses a credential write even when a route
    /// is handed to the sender directly, before any request is made.
    #[tokio::test]
    async fn send_request_refuses_resolved_credential_paths() {
        let route = CoreApiRoute {
            id: "ryu_api.post_api_plugins_plugin_id_auth_server_name_connect".to_owned(),
            method: "POST".to_owned(),
            path_template: "/api/plugins/{plugin_id}/auth/{server_name}/connect".to_owned(),
            summary: String::new(),
            path_params: vec!["plugin_id".to_owned(), "server_name".to_owned()],
            query_params: Vec::new(),
            has_body: false,
            input_schema: json!({ "type": "object" }),
        };
        let error = send_request(
            &reqwest::Client::new(),
            "http://127.0.0.1:9",
            None,
            &route,
            &json!({ "plugin_id": "notion", "server_name": "notion" }),
        )
        .await
        .unwrap_err();
        assert!(
            error.to_string().contains("resolved to a denied path"),
            "{error}"
        );
    }

    /// Every reviewed safe write is a real catalog route, so the list cannot
    /// silently drift from the routes it names, and none of them reaches a
    /// sharing, credential, connection, agent or run surface.
    #[test]
    fn restricted_safe_writes_are_real_reviewed_routes() {
        const FORBIDDEN_SEGMENTS: &[&str] = &[
            "access",
            "visibility",
            "export",
            "import",
            "secrets",
            "auth",
            "accounts",
            "connections",
            "participants",
            "fork",
            "regenerate",
            "edit",
            "pull-requests",
            "duplicate",
            "settings",
            "tools",
        ];
        let mut seen = HashSet::new();
        for (method, path) in RESTRICTED_SAFE_WRITES {
            assert!(
                seen.insert((*method, *path)),
                "duplicate entry {method} {path}"
            );
            assert_ne!(*method, "GET", "{path}: reads need no entry");
            assert!(
                routes()
                    .iter()
                    .any(|r| r.method == *method && r.path_template == *path),
                "{method} {path} is not a CoreApi route; remove or fix the entry"
            );
            // Editing a stored run record is fine; starting a run is not.
            assert!(!path.ends_with("/runs"), "{method} {path} starts a run");
            for segment in path.split('/') {
                assert!(
                    !FORBIDDEN_SEGMENTS.contains(&segment),
                    "{method} {path} reaches a refused category ({segment})"
                );
            }
        }
    }

    /// The real catalog: a restricted agent may make exactly the reviewed writes,
    /// and every other write (including any route added later) is refused.
    #[test]
    fn restricted_agents_are_held_to_the_reviewed_writes() {
        let mut allowed = 0;
        for r in routes() {
            let listed = RESTRICTED_SAFE_WRITES
                .iter()
                .any(|(m, p)| *m == r.method && *p == r.path_template);
            let refusal = restricted_write_refusal(&r.id);
            if r.method == "GET" {
                assert!(refusal.is_none(), "read refused: {}", r.path_template);
            } else if listed {
                allowed += 1;
                assert!(
                    refusal.is_none(),
                    "reviewed write refused: {} {}",
                    r.method,
                    r.path_template
                );
            } else {
                assert!(
                    refusal.is_some(),
                    "unreviewed write allowed: {} {}",
                    r.method,
                    r.path_template
                );
            }
        }
        assert_eq!(allowed, RESTRICTED_SAFE_WRITES.len());
    }

    #[test]
    fn restricted_agents_keep_workspace_writes() {
        for id in [
            "ryu_api.post_api_spaces_id_documents",
            "ryu_api.put_api_memory_id",
            "ryu_api.post_api_conversations_id_title",
            "ryu_api.post_api_notifications_id_ack",
            "ryu_api.get_api_composio_connections",
        ] {
            assert!(route_for(id).is_some(), "{id} is not in the catalog");
            assert_eq!(restricted_write_refusal(id), None, "{id}");
        }
    }

    #[test]
    fn restricted_agents_are_refused_access_routes() {
        for id in [
            "ryu_api.post_v1_chat_completions",
            "ryu_api.post_api_actions_action_id",
            "ryu_api.post_api_conversations_id_participants",
            "ryu_api.put_api_spaces_id_documents_doc_id_access",
            "ryu_api.post_api_spaces_id_visibility",
            "ryu_api.post_heartbeat_jobs",
            "ryu_api.post_api_images_generate",
            "ryu_api.put_api_memory_settings",
        ] {
            assert!(route_for(id).is_some(), "{id} is not in the catalog");
            let reason = restricted_write_refusal(id).unwrap_or_else(|| panic!("{id} allowed"));
            assert!(reason.contains("account access does not allow"), "{reason}");
        }
        // Denied for everyone, so absent from the catalog; still refused here.
        for (method, path) in [
            ("POST", "/mcp/{agent_id}"),
            ("POST", "/api/widgets/tools/call"),
            ("POST", "/api/widgets/open"),
            ("PUT", "/api/agents/{id}"),
            ("PUT", "/api/plugins/{id}/secrets/{key}"),
            ("DELETE", "/api/plugins/{id}/secrets/{key}"),
            ("POST", "/api/pi-config/providers"),
            ("POST", "/api/composio/connections/initiate"),
        ] {
            assert!(!restricted_agent_may_write(path, method), "{method} {path}");
        }
    }

    #[test]
    fn restricted_agents_create_only_private_spaces() {
        let Some(route) = routes()
            .iter()
            .find(|r| r.method == "POST" && r.path_template == "/api/spaces")
        else {
            panic!("POST /api/spaces is in the spec");
        };
        for body in [
            json!({}),
            json!({ "body": { "name": "n" } }),
            json!({ "body": { "visibility": "private" } }),
        ] {
            assert_eq!(restricted_sharing_refusal(&route.id, &body), None, "{body}");
        }
        for visibility in ["org", "team"] {
            let arguments = json!({ "body": { "name": "n", "visibility": visibility } });
            assert!(restricted_sharing_refusal(&route.id, &arguments).is_some());
        }
    }

    #[test]
    fn restricted_write_refusal_unknown_tool_fails_closed() {
        assert!(restricted_write_refusal("ryu_api.post_nope").is_some());
        assert!(restricted_write_refusal("ryu_api.delete_api_spaces_nope").is_some());
        assert!(restricted_write_refusal("ryu_api__post_nope").is_some());
        // Reads and non-CoreApi ids are not this gate's business.
        assert!(restricted_write_refusal("ryu_api.get_nope").is_none());
    }

    #[test]
    fn path_segment_rejects_traversal_and_encoding() {
        // Safe: ordinary ids.
        assert!(is_safe_path_segment("abc123"));
        assert!(is_safe_path_segment("conv-42_x.y"));
        // Unsafe: separators, traversal, percent-encoding, control chars, empty.
        assert!(!is_safe_path_segment(""));
        assert!(!is_safe_path_segment("../auth/token"));
        assert!(!is_safe_path_segment("a/b"));
        assert!(!is_safe_path_segment("a\\b"));
        assert!(!is_safe_path_segment("conversation#"));
        assert!(!is_safe_path_segment("conversation?view=messages"));
        assert!(!is_safe_path_segment(".."));
        assert!(!is_safe_path_segment("..%2fauth"));
        assert!(!is_safe_path_segment("%2e%2e"));
        assert!(!is_safe_path_segment("a\nb"));
        assert!(!is_safe_path_segment("a\0b"));
    }

    /// The app host-capability bridge carries user-aware operations (Safe Actions
    /// review, webhook secrets); a node-token loopback must never reach it.
    #[test]
    fn host_bridge_is_denied() {
        for path in [
            "/api/plugins/{id}/host",
            "/api/plugins/{plugin_id}/host",
            "/api/plugins/{id}/host/stream",
            "/api/plugins/@ryu/safe-actions/host",
            "/api/plugins/@ryu/webhooks/host/stream",
            "/api/plugins/com.ryu.webhooks/host",
        ] {
            for m in METHODS {
                assert!(is_denied(path, m), "{path} {m}");
            }
        }
        // Unrelated plugin routes stay available (taken from the real spec).
        assert!(!is_denied("/api/plugins/{id}/ui-bundle", "get"));
        assert!(!is_denied("/api/plugins/{id}/enable", "post"));
        assert!(!is_denied("/api/plugins/catalog", "get"));
        // A plugin whose id is literally `host` keeps its own lifecycle routes.
        assert!(!is_denied("/api/plugins/host/enable", "post"));
    }

    /// The real generated catalog must never contain a denylisted route.
    #[test]
    fn generated_catalog_excludes_denylisted_routes() {
        for r in routes() {
            let m = r.method.to_ascii_lowercase();
            assert!(
                !is_denied(&r.path_template, &m),
                "denylisted route leaked into catalog: {} {}",
                r.method,
                r.path_template
            );
            // And no id collides.
        }
        // The app host bridge is in the OpenAPI document; it must never become a
        // CoreApi tool, whatever its path parameter is named.
        assert!(
            !routes()
                .iter()
                .any(|r| r.path_template.starts_with("/api/plugins/")
                    && (r.path_template.ends_with("/host") || r.path_template.contains("/host/"))),
            "the app host bridge leaked into the CoreApi catalog"
        );
        // An agent's own Composio accounts are in the OpenAPI document but must
        // never become CoreApi tools an agent could call on itself.
        assert!(
            !routes()
                .iter()
                .any(|r| r.path_template.starts_with("/api/agents/")
                    && r.path_template
                        .split('/')
                        .any(|segment| segment == "composio")),
            "an agent's own Composio routes leaked into the CoreApi catalog"
        );
        // No duplicate ids.
        let mut ids: Vec<&str> = routes().iter().map(|r| r.id.as_str()).collect();
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(
            ids.len(),
            n,
            "duplicate core-api tool ids in generated catalog"
        );
    }

    #[test]
    fn tenancy_refuses_when_bound() {
        // Unbound / personal (Unrestricted principal) → allowed.
        assert!(refuse_reason_if_tenant_bound(true).is_none());
        // Org-bound (not Unrestricted) → refused.
        assert!(refuse_reason_if_tenant_bound(false).is_some());
    }

    fn route(method: &str, path: &str) -> CoreApiRoute {
        CoreApiRoute {
            id: format!("ryu_api.{}_x", method.to_lowercase()),
            method: method.to_owned(),
            path_template: path.to_owned(),
            summary: String::new(),
            path_params: vec![],
            query_params: vec![],
            has_body: false,
            input_schema: json!({ "type": "object" }),
        }
    }

    #[test]
    fn gateway_routes_need_view_to_read_and_configure_to_change() {
        assert_eq!(
            required_permission("/api/gateway/config", "GET"),
            Some("gateway.view")
        );
        assert_eq!(
            required_permission("/api/gateway/config", "PUT"),
            Some("gateway.configure")
        );
        assert_eq!(
            required_permission("/api/routing/policy", "PUT"),
            Some("gateway.configure")
        );
        assert_eq!(
            required_permission("/api/gateway/audit", "GET"),
            Some("audit.view")
        );
        // Anything without a declared permission is closed on shared nodes.
        assert_eq!(
            required_permission("/api/gateway/audit/usage", "POST"),
            None
        );
        assert_eq!(required_permission("/api/preferences/{key}", "PUT"), None);
        assert_eq!(
            required_permission("/api/models/{id}/launch-config", "PUT"),
            None
        );
    }

    #[test]
    fn an_org_member_acts_only_within_their_own_role_and_from_a_private_chat() {
        let put = route("PUT", "/api/gateway/config");
        let get = route("GET", "/api/gateway/config");
        let member = |private_conversation| ActingUser {
            user_id: "u-member",
            org_id: Some("org-1"),
            private_conversation,
        };
        let viewer_set: HashSet<String> = ["gateway.view".to_owned()].into();
        let admin_set: HashSet<String> =
            ["gateway.view".to_owned(), "gateway.configure".to_owned()].into();

        // A member who can view but not configure may read, not change.
        assert!(acting_user_refusal(&get, &member(true), "org-1", None, &viewer_set).is_none());
        let refusal = acting_user_refusal(&put, &member(true), "org-1", None, &viewer_set)
            .expect("no gateway.configure, no change");
        assert!(refusal.contains("gateway.configure"));

        // An admin may change it, but only from a private chat.
        assert!(acting_user_refusal(&put, &member(true), "org-1", None, &admin_set).is_none());
        assert!(acting_user_refusal(&put, &member(false), "org-1", None, &admin_set).is_some());

        // A person from another organization holds nothing here.
        let outsider = ActingUser {
            user_id: "u-other",
            org_id: Some("org-2"),
            private_conversation: true,
        };
        assert!(acting_user_refusal(&get, &outsider, "org-1", None, &admin_set).is_some());

        // A failed permission lookup is an empty set, which refuses.
        assert!(acting_user_refusal(&get, &member(true), "org-1", None, &HashSet::new()).is_some());

        // The owner of a Personal-scope node keeps full trust on their own node.
        assert!(acting_user_refusal(
            &put,
            &member(true),
            "org-1",
            Some("u-member"),
            &HashSet::new()
        )
        .is_none());

        // Routes with no declared permission stay closed, whatever the role.
        let preference = route("PUT", "/api/preferences/{key}");
        assert!(
            acting_user_refusal(&preference, &member(true), "org-1", None, &admin_set).is_some()
        );
    }

    #[test]
    fn only_the_in_process_proof_names_who_a_self_call_acts_for() {
        use axum::http::{HeaderMap, HeaderValue};
        let mut headers = HeaderMap::new();
        assert!(matches!(
            self_call_identity(&headers),
            SelfCallIdentity::Absent
        ));

        headers.insert(SELF_CALL_PROOF_HEADER, HeaderValue::from_static("guess"));
        headers.insert(SELF_CALL_USER_HEADER, HeaderValue::from_static("u-1"));
        assert!(matches!(
            self_call_identity(&headers),
            SelfCallIdentity::Invalid
        ));

        headers.insert(
            SELF_CALL_PROOF_HEADER,
            HeaderValue::from_str(self_call_proof()).unwrap(),
        );
        assert!(matches!(
            self_call_identity(&headers),
            SelfCallIdentity::Acting(user) if user == "u-1"
        ));

        headers.insert(SELF_CALL_USER_HEADER, HeaderValue::from_static("  "));
        assert!(matches!(
            self_call_identity(&headers),
            SelfCallIdentity::Invalid
        ));
        assert_eq!(self_call_proof().len(), 64);
    }

    #[test]
    fn credential_audit_and_hook_override_routes_are_denied() {
        for path in [
            "/api/gateway/providers",
            "/api/gateway/web-accounts",
            "/api/gateway/cloud-speech-accounts",
            "/api/gateway/audit/prune",
            "/api/gateway/traffic",
            "/api/gateway/governance/hooks",
            "/api/hooks/overrides",
        ] {
            for method in ["get", "put", "post"] {
                assert!(is_denied(path, method), "{method} {path}");
            }
        }
        // Git and worktree governance stay reachable.
        assert!(!is_denied("/api/gateway/governance/git", "put"));
        assert!(!is_denied("/api/gateway/governance/worktrees", "put"));
        assert!(!is_denied("/api/gateway/providers/apply", "post"));
    }

    #[tokio::test]
    async fn an_acting_loopback_carries_the_proof_and_the_person() {
        use axum::{http::HeaderMap, routing::get, Json, Router};
        let app = Router::new().route(
            "/api/gateway/status",
            get(|headers: HeaderMap| async move {
                let read = |name: &str| {
                    headers
                        .get(name)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned)
                };
                Json(json!({
                    "proof": read(SELF_CALL_PROOF_HEADER),
                    "user": read(SELF_CALL_USER_HEADER),
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let status = route("GET", "/api/gateway/status");
        let base = format!("http://{addr}");
        let client = reqwest::Client::new();

        let acting = send_request_as(&client, &base, None, &status, &json!({}), Some("u-1"))
            .await
            .unwrap();
        assert_eq!(acting["body"]["proof"], json!(self_call_proof()));
        assert_eq!(acting["body"]["user"], json!("u-1"));

        let owner = send_request(&client, &base, None, &status, &json!({}))
            .await
            .unwrap();
        assert_eq!(owner["body"]["proof"], Value::Null);
        assert_eq!(owner["body"]["user"], Value::Null);
    }

    #[test]
    fn method_of_is_none_for_non_core_api() {
        assert_eq!(method_of("exa.search"), None);
        assert!(!is_core_api("exa.search"));
        assert!(!is_mutating("exa.search"));
    }

    #[test]
    fn legacy_core_api_ids_are_accepted_at_the_boundary() {
        let canonical = routes()
            .first()
            .map(|route| route.id.as_str())
            .expect("the generated Core API has at least one exposed route");
        let (server, method) = canonical
            .split_once('.')
            .expect("Core API ids use the canonical dotted separator");
        let legacy = format!("{server}__{method}");
        assert!(is_core_api(canonical));
        assert!(is_core_api(&legacy));
        assert_eq!(
            method_of(canonical),
            Some(method.split('_').next().unwrap())
        );
        assert_eq!(method_of(&legacy), Some(method.split('_').next().unwrap()));
        assert!(describe(&legacy).is_some());
    }

    #[tokio::test]
    async fn loopback_get_happy_path() {
        use axum::{routing::get, Json, Router};
        // Spin a tiny axum server standing in for Core on an ephemeral port.
        let app = Router::new().route(
            "/api/quests",
            get(|| async { Json(json!({ "quests": [], "ok": true })) }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let route = CoreApiRoute {
            id: "ryu_api.get_api_quests".to_string(),
            method: "GET".to_string(),
            path_template: "/api/quests".to_string(),
            summary: "List quests".to_string(),
            path_params: vec![],
            query_params: vec![],
            has_body: false,
            input_schema: json!({ "type": "object", "properties": {}, "required": [] }),
        };
        let base = format!("http://{addr}");
        let client = reqwest::Client::new();
        let out = send_request(&client, &base, None, &route, &json!({}))
            .await
            .expect("loopback GET succeeds");
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["status"], json!(200));
        assert_eq!(out["body"]["quests"], json!([]));
    }

    #[tokio::test]
    async fn loopback_substitutes_path_param() {
        use axum::{routing::get, Router};
        // axum 0.7 route-param syntax is `:id`; the CoreApi path template stays
        // OpenAPI-style `{id}` (what `send_request` substitutes into).
        let app = Router::new().route(
            "/api/quests/:id",
            get(|axum::extract::Path(id): axum::extract::Path<String>| async move { id }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let route = CoreApiRoute {
            id: "ryu_api.get_api_quests_id".to_string(),
            method: "GET".to_string(),
            path_template: "/api/quests/{id}".to_string(),
            summary: String::new(),
            path_params: vec!["id".to_string()],
            query_params: vec![],
            has_body: false,
            input_schema: json!({ "type": "object", "properties": {}, "required": ["id"] }),
        };
        let base = format!("http://{addr}");
        let client = reqwest::Client::new();
        let out = send_request(&client, &base, None, &route, &json!({ "id": "q_42" }))
            .await
            .expect("loopback with path param succeeds");
        assert_eq!(out["status"], json!(200));
        assert_eq!(out["body"], json!("q_42"));

        // A missing required path param is a clean error, not a bad request.
        let err = send_request(&client, &base, None, &route, &json!({}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("missing required path parameter"));
    }
}
