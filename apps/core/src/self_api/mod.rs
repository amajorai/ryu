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
//! tenancy-refused on org-bound nodes (see [`refuse_reason_if_tenant_bound`]).
//!
//! ## Security invariants (non-negotiable)
//! - **Denylist** ([`is_denied`]): security-critical routes (auth, identity,
//!   capability-broker, the approvals *mutations*, the tool routes themselves —
//!   recursion — and the spec route) are NEVER exposed. Reviewable const below.
//! - **Loopback carries the node token = full power.** On an org-bound node the
//!   loopback request would run as the node, not as the calling agent's
//!   principal — a tenancy bypass. So CoreApi tools are **refused** whenever the
//!   node is org-bound (principal is not `Unrestricted`). Personal/unbound nodes
//!   get the full power (there is exactly one principal).
//! - **Mutations (non-GET) default to approval-gated** (see
//!   `crate::approvals::policy`) whenever the approval mode is not `off`.

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
/// Fully-qualified id prefix (`<server>__`). Every CoreApi tool id starts here.
pub const ID_PREFIX: &str = "ryu_api__";

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
    // Capability broker — cross-app privilege escalation surface.
    "/api/host/",
    // The unified tool routes themselves — recursion (search/describe/exec).
    "/api/tools/",
];

/// Exact paths excluded for every verb.
const DENIED_EXACT: &[&str] = &[
    // The spec route — an agent enumerating the spec to self-expand is pointless
    // recursion and leaks the full surface in one call.
    "/api/openapi.json",
    // The generic MCP tool-invoke route — recursion into tool dispatch.
    "/api/mcp/tools/call",
];

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
    // Approvals: reads OK, mutations forbidden (self-approval bypass).
    if path.starts_with("/api/approvals/") && !method.eq_ignore_ascii_case("get") {
        return true;
    }
    false
}

// ── Route model ───────────────────────────────────────────────────────────────

/// One CoreApi tool: an OpenAPI operation reduced to what dispatch needs.
#[derive(Debug, Clone)]
pub struct CoreApiRoute {
    /// `ryu_api__<method>_<path_slug>`.
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
/// into `McpRegistry::search`'s `builtins` so it ranks with everything else.
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
    let r = routes().iter().find(|r| r.id == id)?;
    Some(describe_from_parts(
        &r.id,
        &format!("{} {}", r.method, r.path_template),
        &r.summary,
        ToolKind::CoreApi,
        Some(&r.input_schema),
    ))
}

// ── Method / kind helpers (for the approval policy + dispatch gate) ────────────

/// Whether a tool id belongs to the CoreApi plane.
pub fn is_core_api(tool_id: &str) -> bool {
    tool_id.starts_with(ID_PREFIX)
}

/// The lowercase HTTP method encoded in a CoreApi tool id (`ryu_api__get_…` →
/// `get`). `None` for non-CoreApi ids. HTTP verbs contain no `_`, so the method
/// is exactly the segment between the prefix and the first `_`.
pub fn method_of(tool_id: &str) -> Option<&str> {
    tool_id
        .strip_prefix(ID_PREFIX)
        .map(|rest| rest.split('_').next().unwrap_or(rest))
}

/// Whether this is a **mutating** CoreApi tool (any non-GET verb). The approval
/// policy treats these as risky regardless of the risk-name heuristic, and gates
/// them by default (under the unset approval mode) — only an explicit `off` opts
/// out. See [`crate::approvals::policy::should_require_approval_local`].
pub fn is_mutating(tool_id: &str) -> bool {
    is_core_api(tool_id) && !matches!(method_of(tool_id), Some("get"))
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
        std::env::var("RYU_TOKEN").ok().filter(|t| !t.is_empty()),
    )
}

/// Execute a CoreApi tool by id: resolve the route, then loop back over HTTP to
/// this Core with its own token. The tenancy refusal is enforced by the caller
/// (`sidecar/mcp/mod.rs`) *before* this runs.
pub async fn dispatch(http: &reqwest::Client, tool_id: &str, args: Value) -> Result<Value> {
    let route = routes()
        .iter()
        .find(|r| r.id == tool_id)
        .ok_or_else(|| anyhow!("unknown core-api tool '{tool_id}'"))?;
    let (base, token) = self_target();
    send_request(http, &base, token.as_deref(), route, &args).await
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
                 (path separators, '..', '%', or control characters are rejected)",
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
        && !v.contains("..")
        && !v.contains('%')
        && !v.chars().any(|c| c.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(get.id, "ryu_api__get_api_quests");
        assert_eq!(method_of(&get.id), Some("get"));
        assert!(!is_mutating(&get.id));

        let del = routes.iter().find(|r| r.method == "DELETE").unwrap();
        assert_eq!(del.id, "ryu_api__delete_api_quests_id");
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
        // Streaming/WS routes are excluded.
        assert!(is_denied("/api/chat/stream", "post"));
        assert!(is_denied("/api/realtime_ws", "get"));
        assert!(is_denied("/api/notifications/stream", "get"));
        assert!(is_denied("/api/events/all", "get"));
        // Approvals: reads allowed, mutations denied (no self-approval).
        assert!(!is_denied("/api/approvals", "get"));
        assert!(is_denied("/api/approvals/approve", "post"));
        assert!(is_denied("/api/approvals/reject", "post"));
        // Sanity: an ordinary route is allowed.
        assert!(!is_denied("/api/quests", "get"));
        assert!(!is_denied("/api/quests", "post"));
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
        assert!(!is_safe_path_segment(".."));
        assert!(!is_safe_path_segment("..%2fauth"));
        assert!(!is_safe_path_segment("%2e%2e"));
        assert!(!is_safe_path_segment("a\nb"));
        assert!(!is_safe_path_segment("a\0b"));
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

    #[test]
    fn method_of_is_none_for_non_core_api() {
        assert_eq!(method_of("exa__search"), None);
        assert!(!is_core_api("exa__search"));
        assert!(!is_mutating("exa__search"));
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
            id: "ryu_api__get_api_quests".to_string(),
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
            id: "ryu_api__get_api_quests_id".to_string(),
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
