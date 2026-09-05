//! Core tool-catalog client (#475, P2).
//!
//! The gateway's search-based tool loop reaches the unified tool catalog that
//! P1 built in Core (`GET /api/tools/search`, `GET /api/tools/describe`,
//! `POST /api/mcp/tools/call`). This module defines a small [`CoreCatalog`]
//! trait so the loop is testable with a mock, and a real HTTP implementation
//! [`ToolSearchClient`] keyed off the gateway's `providers.core` config.
//!
//! Placement (CLAUDE.md §1): discovering and executing tools is orchestration —
//! it lives in Core. The gateway only *governs* (allowlist, audit, budget) and
//! drives the loop, calling Core over HTTP for the privileged work.

use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::debug;

use crate::config::CoreProviderConfig;

/// Canonical prefix Core uses for Composio action ids.
pub const COMPOSIO_TOOL_PREFIX: &str = "composio.";

/// OpenAI-compatible function prefix for Composio action ids.
///
/// The catalog keeps the dotted id for search, allowlists, audit, and dispatch,
/// but dots are not legal in a Chat Completions function name. The alias is
/// reversible at the gateway boundary and is also accepted by Core's legacy
/// double-underscore id normalizer.
pub const COMPOSIO_FUNCTION_PREFIX: &str = "composio__";

/// Prefix for reversible aliases of every other dotted catalog id. Hex keeps
/// the alias within the provider-neutral function-name grammar without making
/// `.`/`/`/`:` escaping ambiguous.
pub const GENERIC_FUNCTION_PREFIX: &str = "ryu__";

fn encode_function_id(id: &str) -> String {
    id.as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn decode_function_id(value: &str) -> Option<String> {
    let encoded = value.strip_prefix(GENERIC_FUNCTION_PREFIX)?;
    if encoded.is_empty() || encoded.len() % 2 != 0 {
        return None;
    }
    let bytes = encoded
        .as_bytes()
        .chunks_exact(2)
        .map(|chunk| {
            let text = std::str::from_utf8(chunk).ok()?;
            u8::from_str_radix(text, 16).ok()
        })
        .collect::<Option<Vec<_>>>()?;
    let decoded = String::from_utf8(bytes).ok()?;
    decoded.contains('.').then_some(decoded)
}

/// Return the legal function name used for a canonical catalog id.
pub fn model_tool_name(id: &str) -> String {
    if let Some(slug) = id.strip_prefix(COMPOSIO_TOOL_PREFIX) {
        return format!("{}{}", COMPOSIO_FUNCTION_PREFIX, slug);
    }
    if id.contains('.') {
        return format!("{}{}", GENERIC_FUNCTION_PREFIX, encode_function_id(id));
    }
    id.to_owned()
}

/// Convert a model-facing Composio function alias back to Core's canonical id.
pub fn canonical_tool_id(name: &str) -> String {
    if let Some(slug) = name.strip_prefix(COMPOSIO_FUNCTION_PREFIX) {
        return format!("{}{}", COMPOSIO_TOOL_PREFIX, slug);
    }
    decode_function_id(name).unwrap_or_else(|| name.to_owned())
}

/// Source plane of a catalog entry — mirror of Core's `ToolKind` (Contract 1). Wire
/// values: `mcp|builtin|composio|app|core-api|command|skill`.
///
/// The gateway now reads this field in exactly one place, and it is load-bearing:
/// [`crate::tools::handle_search`] must not describe-and-inject a
/// [`ToolKind::Skill`] row as an OpenAI function definition. A skill is instruction
/// text the model loads with `skills.load`, not a function it calls; injecting one
/// would hand the model a callable named after a skill, and Core would then have to
/// refuse a call the gateway invited. The kind is also relayed to the model in the
/// `tool_search` result so it can tell the two apart.
///
/// It is still not an authorization input — execution is gated on the exact
/// fully-qualified tool id in [`crate::tools::ToolLoopContext::is_allowed`]. So the
/// injection skip is a UX/correctness guard on top of Core's refusal, not the
/// security boundary; see `skills_tool`'s "Discovery is unified, execution is not".
///
/// [`ToolKind::Unknown`] is the forward-compat catch-all: Core owns this enum
/// (`crates/core/tool-registry`) and has grown it twice already (`core-api`,
/// `command`). Before this variant existed, one row of a kind the gateway had
/// not been taught replaced the **entire** search result with a parse error
/// (`handle_search` turns an `Err` into `{"error": …}` for the model), so a
/// single self-API descriptor in the top-`limit` blinded the model to every
/// other hit — intermittently, since BM25 ranking is query-dependent.
///
/// Accepting an unrecognized kind grants nothing: the gateway never uses `kind`
/// as an authorization input. Execution is gated on the exact fully-qualified
/// tool id in [`crate::tools::ToolLoopContext::is_allowed`], and search ≠ grant.
/// So the widest thing a bogus `kind` can do is show the model a tool name it
/// still cannot call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolKind {
    Mcp,
    Builtin,
    Composio,
    App,
    /// A Core HTTP endpoint (OpenAPI-derived) exposed as an agent-drivable tool.
    /// Hyphenated on the wire, so it needs an explicit rename (the `lowercase`
    /// default would be `coreapi`) — matching Core's own rename.
    #[serde(rename = "core-api")]
    CoreApi,
    /// A declarative app tool that execs an allowlisted local CLI.
    Command,
    /// An Agent Skill: instruction text, loaded with `skills.load`, never called.
    Skill,
    /// A tool derived from an app sidecar's OpenAPI document (one row per
    /// operation), as opposed to [`ToolKind::App`]'s hand-declared runnables.
    /// Hyphenated on the wire like `core-api`, so it needs an explicit rename.
    #[serde(rename = "ext-api")]
    ExtApi,
    /// Any kind Core adds after this mirror was written.
    #[serde(other)]
    Unknown,
}

impl ToolKind {
    /// The wire spelling relayed back to the model in a `tool_search` result.
    ///
    /// A kind this mirror has not been taught reports `"unknown"` rather than the
    /// string Core actually sent: [`serde(other)`] discards the original, and the
    /// alternative (keeping a raw copy of every row) would buy a label the model
    /// cannot act on anyway. `"unknown"` is honest about that — what matters to the
    /// model is that the row is *not* `"skill"`, so it is something it may call.
    pub fn wire_name(self) -> &'static str {
        match self {
            ToolKind::Mcp => "mcp",
            ToolKind::Builtin => "builtin",
            ToolKind::Composio => "composio",
            ToolKind::App => "app",
            ToolKind::CoreApi => "core-api",
            ToolKind::Command => "command",
            ToolKind::Skill => "skill",
            ToolKind::ExtApi => "ext-api",
            ToolKind::Unknown => "unknown",
        }
    }
}

/// A descriptor returned by `GET /api/tools/search` (Contract 1, consumed here).
/// The gateway needs `id`/`name`/`description` to relay to the model via
/// `tool_search` results, plus `kind` to tell a callable tool from an Agent Skill
/// (see [`ToolKind`]); the remaining fields are deserialized for wire fidelity but
/// not read by the gateway.
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct ToolDescriptor {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub kind: ToolKind,
    #[serde(default)]
    pub arg_names: Vec<String>,
    #[serde(default)]
    pub arg_descriptions: Vec<String>,
    #[serde(default)]
    pub score: Option<f32>,
}

/// One canonical argument of a tool (Contract 1).
#[derive(Debug, Clone, Deserialize)]
pub struct DescribedArg {
    pub name: String,
    #[serde(rename = "type")]
    pub r#type: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub required: bool,
}

/// The full description of one tool (Contract 1) from `GET /api/tools/describe`.
/// `parameters` is the full OpenAI JSON-Schema when Core knows it; when `None`
/// (or `shallow`) the gateway synthesizes a permissive object schema from
/// `args` via [`DescribedTool::to_function_parameters`].
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct DescribedTool {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub args: Vec<DescribedArg>,
    #[serde(default)]
    pub shallow: bool,
    #[serde(default)]
    pub parameters: Option<Value>,
}

impl DescribedTool {
    /// Build the `function.parameters` JSON-Schema for an OpenAI tool definition.
    ///
    /// Prefers Core's `parameters` when present (Contract 1: P1 SHOULD populate
    /// it for mcp/builtin/app). When absent the gateway MUST synthesize one:
    ///   - `shallow` (no arg metadata, e.g. an unfetched Composio slug) ⇒
    ///     `{type:object,properties:{arguments:{type:object}}}`.
    ///   - otherwise an object schema built from `args` with their types and the
    ///     required-arg list.
    pub fn to_function_parameters(&self) -> Value {
        if let Some(params) = &self.parameters {
            if params.is_object() {
                return params.clone();
            }
        }
        if self.shallow || self.args.is_empty() {
            return json!({
                "type": "object",
                "properties": {
                    "arguments": {
                        "type": "object",
                        "description": "Tool-specific parameters"
                    }
                }
            });
        }
        let mut properties = serde_json::Map::new();
        let mut required: Vec<Value> = Vec::new();
        for arg in &self.args {
            let ty = normalize_json_type(&arg.r#type);
            properties.insert(
                arg.name.clone(),
                json!({ "type": ty, "description": arg.description }),
            );
            if arg.required {
                required.push(Value::String(arg.name.clone()));
            }
        }
        json!({
            "type": "object",
            "properties": Value::Object(properties),
            "required": Value::Array(required),
        })
    }

    /// The full OpenAI function-tool definition for this tool.
    ///
    /// Catalog ids remain canonical internally. Composio's dotted id is exposed
    /// as a legal reversible function alias so OpenAI-compatible providers accept
    /// the definition; the tool loop maps the emitted alias back before routing.
    pub fn to_tool_def(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": model_tool_name(&self.id),
                "description": self.description,
                "parameters": self.to_function_parameters(),
            }
        })
    }
}

/// Map a compact arg type to a JSON-Schema primitive; unknown ⇒ `string`.
fn normalize_json_type(t: &str) -> &str {
    match t {
        "number" | "integer" | "boolean" | "object" | "array" | "string" => t,
        _ => "string",
    }
}

/// The Core operations the gateway tool loop needs. Behind a trait so the loop
/// is unit-testable with a mock that returns canned descriptors/results, with no
/// live Core. The real impl is [`ToolSearchClient`].
#[async_trait]
pub trait CoreCatalog: Send + Sync {
    /// `GET /api/tools/search` — ranked descriptors for a capability query.
    async fn search(
        &self,
        query: &str,
        kind: Option<&str>,
        limit: usize,
        agent: Option<&str>,
    ) -> Result<Vec<ToolDescriptor>, String>;

    /// `GET /api/tools/describe` — one tool's argument schema by FQ id.
    async fn describe(&self, id: &str) -> Result<DescribedTool, String>;

    /// `POST /api/mcp/tools/call` — execute one tool. Maps Core's
    /// `{ok,output}` / `{ok,error}` to a `Result<output, error>`.
    ///
    /// `host_conversation_id` is the **server-derived** host conversation this
    /// exec runs on behalf of (threaded from the exec request body). Core lowers it
    /// to a `ToolPrincipal` so a gateway-exec'd tool resolves `Owned` instead of the
    /// fail-closed `Unresolved` on an org-bound node. It is NOT `user_id` (which is
    /// client-supplied and spoofable). `None` preserves the fail-closed default.
    /// `host_conversation_proof` is the process-local proof Core attaches before
    /// the Gateway forward; it is relayed separately so a direct node-token caller
    /// cannot opt into this internal context.
    async fn call_tool(
        &self,
        tool_id: &str,
        arguments: Value,
        agent_id: Option<&str>,
        user_id: Option<&str>,
        host_conversation_id: Option<&str>,
        host_conversation_proof: Option<&str>,
    ) -> Result<Value, String>;

    /// Forward a PTC `execute`/`resume` to Core (Contract 4, P4). `path` is the
    /// relative Core path (`/api/tools/exec` or `/api/tools/exec/resume`).
    async fn forward_exec(&self, path: &str, body: Value) -> Result<Value, String>;
}

/// Real HTTP client over Core's catalog endpoints. Built from the gateway's
/// `providers.core` config (populated from `CORE_URL`/`CORE_TOKEN`). When that
/// config is absent the gateway leaves `state.tools = None` and the loop is
/// inert — satisfying "without CORE_URL the front is inert."
pub struct ToolSearchClient {
    http: Client,
    base_url: String,
    token: Option<String>,
}

impl ToolSearchClient {
    pub fn new(cfg: &CoreProviderConfig, http: Client) -> Self {
        Self {
            http,
            base_url: cfg.base_url.trim_end_matches('/').to_string(),
            token: cfg.token.clone(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    fn with_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.token {
            Some(t) if !t.is_empty() => req.bearer_auth(t),
            _ => req,
        }
    }
}

#[async_trait]
impl CoreCatalog for ToolSearchClient {
    async fn search(
        &self,
        query: &str,
        kind: Option<&str>,
        limit: usize,
        agent: Option<&str>,
    ) -> Result<Vec<ToolDescriptor>, String> {
        let mut params: Vec<(&str, String)> =
            vec![("q", query.to_string()), ("limit", limit.to_string())];
        // "any" means no filter — Core treats an unknown/absent kind as any.
        if let Some(k) = kind {
            if !k.is_empty() && k != "any" {
                params.push(("kind", k.to_string()));
            }
        }
        if let Some(a) = agent {
            if !a.is_empty() {
                params.push(("agent", a.to_string()));
            }
        }
        let resp = self
            .with_auth(self.http.get(self.url("/api/tools/search")).query(&params))
            .send()
            .await
            .map_err(|e| format!("tools/search request failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("tools/search returned {}", resp.status()));
        }
        let body: Value = resp
            .json()
            .await
            .map_err(|e| format!("tools/search decode failed: {e}"))?;
        descriptors_from_envelope(body)
    }

    async fn describe(&self, id: &str) -> Result<DescribedTool, String> {
        let resp = self
            .with_auth(
                self.http
                    .get(self.url("/api/tools/describe"))
                    .query(&[("id", id)]),
            )
            .send()
            .await
            .map_err(|e| format!("tools/describe request failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!(
                "tools/describe returned {} for '{id}'",
                resp.status()
            ));
        }
        resp.json::<DescribedTool>()
            .await
            .map_err(|e| format!("tools/describe decode failed: {e}"))
    }

    async fn call_tool(
        &self,
        tool_id: &str,
        arguments: Value,
        agent_id: Option<&str>,
        user_id: Option<&str>,
        host_conversation_id: Option<&str>,
        host_conversation_proof: Option<&str>,
    ) -> Result<Value, String> {
        let body = json!({
            "tool": tool_id,
            "arguments": arguments,
            "agent_id": agent_id,
            "user_id": user_id,
            // Server-derived host conversation → Core's `ToolPrincipal`. Omitted-as-
            // null preserves the fail-closed default on a bound node.
            "host_conversation_id": host_conversation_id,
            "host_conversation_proof": host_conversation_proof,
        });
        let resp = self
            .with_auth(self.http.post(self.url("/api/mcp/tools/call")).json(&body))
            .send()
            .await
            .map_err(|e| format!("tools/call request failed: {e}"))?;
        let value: Value = resp
            .json()
            .await
            .map_err(|e| format!("tools/call decode failed: {e}"))?;
        map_core_ok(value)
    }

    async fn forward_exec(&self, path: &str, body: Value) -> Result<Value, String> {
        let resp = self
            .with_auth(self.http.post(self.url(path)).json(&body))
            .send()
            .await
            .map_err(|e| format!("exec forward to {path} failed: {e}"))?;
        let status = resp.status();
        let value: Value = resp
            .json()
            .await
            .map_err(|e| format!("exec forward decode failed: {e}"))?;
        if !status.is_success() {
            let err = value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("Core returned {status}"));
            return Err(err);
        }
        Ok(value)
    }
}

/// Decode a `GET /api/tools/search` body into descriptors, **row-tolerantly**.
///
/// Contract 1 envelope: `{ object:"list", data:[ToolDescriptor] }`; a bare array
/// is accepted too (some Core builds return one unwrapped).
///
/// Two failure modes are deliberately kept apart:
///
///  - **The envelope is not a list** (no `data` array and the body itself is not
///    an array) ⇒ `Err`. That is Core answering 200 with something else entirely
///    — an error object, an auth failure, a protocol change. Swallowing it as
///    "no tools found" would make a real outage look like an empty catalog, so
///    the error string must still reach the model and the logs.
///  - **A row inside the list does not deserialize** ⇒ drop that row only. One
///    bad descriptor must never cost the model the whole result list; before
///    this, a single row of an unmirrored `kind` did exactly that. Rows are
///    dropped, not defaulted, because a descriptor with no `id` cannot be called
///    and a descriptor we cannot parse is one we cannot describe either.
///
/// Fail-open is safe here for the same reason [`ToolKind::Unknown`] is: nothing
/// in the gateway authorizes on a descriptor. Execution is gated separately on
/// the exact tool id.
fn descriptors_from_envelope(body: Value) -> Result<Vec<ToolDescriptor>, String> {
    let data = body.get("data").unwrap_or(&body);
    let Some(rows) = data.as_array() else {
        return Err(format!(
            "tools/search parse failed: expected a list, got {}",
            type_name_of(data)
        ));
    };
    let total = rows.len();
    let descriptors: Vec<ToolDescriptor> = rows
        .iter()
        .filter_map(|row| match serde_json::from_value(row.clone()) {
            Ok(d) => Some(d),
            Err(e) => {
                debug!(error = %e, "tools/search dropped an undecodable descriptor");
                None
            }
        })
        .collect();
    if descriptors.len() < total {
        debug!(
            dropped = total - descriptors.len(),
            total, "tools/search dropped undecodable descriptors"
        );
    }
    Ok(descriptors)
}

/// A human-readable JSON type name, for the not-a-list error above.
fn type_name_of(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Map Core's `{ok,output}` / `{ok,error}` envelope to a `Result`.
pub fn map_core_ok(value: Value) -> Result<Value, String> {
    if value.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(value.get("output").cloned().unwrap_or(Value::Null))
    } else {
        let err = value
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| "tool call failed".to_string());
        Err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimally-valid search row of a given kind.
    fn row(id: &str, kind: &str) -> Value {
        json!({ "id": id, "name": id, "description": "", "kind": kind })
    }

    /// Every kind Core's `ToolKind` can emit must decode to a **named** mirror
    /// variant — this is the parity assertion. `core-api` in particular is
    /// hyphenated on the wire and would otherwise decode as `Unknown`.
    ///
    /// Enumerated from Core's own `ToolKind::ALL` (a dev-dependency; the gateway's
    /// runtime still never links Core) rather than from a list copied into this
    /// file, so a plane Core grows cannot slip past as `Unknown`. That matters more
    /// now than it did: [`crate::tools::handle_search`] branches on
    /// [`ToolKind::Skill`], so a kind that silently degrades to `Unknown` would be
    /// treated as callable.
    #[test]
    fn every_core_tool_kind_decodes_to_a_named_mirror_variant() {
        for kind in ryu_tool_registry::ToolKind::ALL.iter().copied() {
            let wire = kind.wire_name();
            let parsed = descriptors_from_envelope(json!({ "data": [row("s.t", wire)] }))
                .unwrap_or_else(|e| panic!("kind '{wire}' failed to decode: {e}"));
            assert_eq!(parsed.len(), 1, "kind '{wire}' was dropped");
            assert_ne!(
                parsed[0].kind,
                ToolKind::Unknown,
                "kind '{wire}' is a plane Core can emit but this mirror decodes it as \
                 Unknown — add the variant"
            );
            assert_eq!(
                parsed[0].kind.wire_name(),
                wire,
                "kind '{wire}' decoded to a variant that spells itself differently"
            );
        }
        // The one variant that has no Core counterpart, spelled explicitly.
        let unknown = descriptors_from_envelope(json!({ "data": [row("s.t", "teleportation")] }))
            .expect("an unmirrored kind still decodes");
        assert_eq!(unknown[0].kind, ToolKind::Unknown);
        assert_eq!(unknown[0].kind.wire_name(), "unknown");
    }

    /// The regression this module exists for: a `core-api` row (self-API
    /// descriptors are merged into every search unconditionally) and a row of a
    /// kind that does not exist yet must not cost the model the other results.
    #[test]
    fn core_api_and_future_kind_rows_do_not_blank_the_result_list() {
        let parsed = descriptors_from_envelope(json!({
            "object": "list",
            "data": [
                row("exa.search", "mcp"),
                row("ryu.list_conversations", "core-api"),
                row("some.tool", "teleportation"),
                row("plugin.run", "command"),
            ],
        }))
        .expect("a list of decodable rows must not be an Err");
        let ids: Vec<&str> = parsed.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "exa.search",
                "ryu.list_conversations",
                "some.tool",
                "plugin.run"
            ]
        );
        // An unmirrored kind is carried, not dropped: it grants nothing (the
        // gateway authorizes on tool id, never on kind) and dropping it would
        // hide a callable tool from the model.
        assert_eq!(parsed[2].kind, ToolKind::Unknown);
    }

    /// A structurally malformed row (no `id`, wrong-typed `kind`, not even an
    /// object) is dropped on its own — its neighbours survive.
    #[test]
    fn malformed_rows_are_dropped_without_taking_their_neighbours() {
        let parsed = descriptors_from_envelope(json!({
            "data": [
                row("good.one", "mcp"),
                json!({ "name": "no-id", "kind": "mcp" }),
                json!({ "id": "bad.kind", "name": "n", "kind": 5 }),
                Value::String("not even an object".to_string()),
                row("good.two", "app"),
            ],
        }))
        .expect("malformed rows must not fail the whole parse");
        let ids: Vec<&str> = parsed.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec!["good.one", "good.two"]);
    }

    /// An all-garbage *list* yields an empty catalog, not an error — the model
    /// gets "no tools found" and can proceed, which is the whole point of the
    /// row-tolerant parse.
    #[test]
    fn an_all_garbage_list_yields_empty_not_err() {
        let parsed =
            descriptors_from_envelope(json!({ "data": [1, "x", null, json!({ "q": 1 })] }))
                .expect("garbage rows must not fail the parse");
        assert!(parsed.is_empty());
    }

    /// But a body that is not a list at all still errors. A 200 carrying an
    /// error object (auth failure, Core protocol change) must stay loud instead
    /// of masquerading as an empty catalog.
    #[test]
    fn a_non_list_envelope_is_still_an_error() {
        let err = descriptors_from_envelope(json!({ "error": "unauthorized" }))
            .expect_err("a non-list body must not decode as an empty catalog");
        assert!(err.contains("expected a list"), "unhelpful error: {err}");
        assert!(descriptors_from_envelope(json!({ "data": { "id": "x" } })).is_err());
    }

    /// A bare top-level array (no `data` envelope) is still accepted.
    #[test]
    fn a_bare_array_body_decodes_without_the_data_envelope() {
        let parsed = descriptors_from_envelope(json!([row("a.b", "builtin")]))
            .expect("a bare array is a valid body");
        assert_eq!(parsed.len(), 1);
    }

    #[test]
    fn composio_ids_use_legal_model_aliases_and_round_trip() {
        let canonical = "composio.SLACK_SEND_MESSAGE";
        let alias = model_tool_name(canonical);
        assert_eq!(alias, "composio__SLACK_SEND_MESSAGE");
        assert!(
            alias
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')),
            "OpenAI function name contains an illegal character: {alias}"
        );
        assert_eq!(canonical_tool_id(&alias), canonical);
        assert_eq!(canonical_tool_id(canonical), canonical);

        for canonical in ["exa.search", "skills.load", "mcp.server.tool"] {
            let alias = model_tool_name(canonical);
            assert_ne!(alias, canonical);
            assert!(
                alias
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')),
                "OpenAI function name contains an illegal character: {alias}"
            );
            assert_eq!(canonical_tool_id(&alias), canonical);
        }

        let described = DescribedTool {
            id: canonical.to_owned(),
            name: "Send a Slack message".to_owned(),
            description: "send".to_owned(),
            args: Vec::new(),
            shallow: true,
            parameters: None,
        };
        assert_eq!(
            described.to_tool_def()["function"]["name"],
            "composio__SLACK_SEND_MESSAGE"
        );
    }
}
