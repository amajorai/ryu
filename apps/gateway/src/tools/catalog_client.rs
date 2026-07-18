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

use crate::config::CoreProviderConfig;

/// Source plane of a tool — mirror of Core's `ToolKind` (Contract 1). Serialized
/// lowercase: `mcp|builtin|composio|app`. The gateway never matches on it
/// directly; it is carried through for logging and synthesis decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolKind {
    Mcp,
    Builtin,
    Composio,
    App,
}

/// A tool descriptor returned by `GET /api/tools/search` (Contract 1, consumed
/// here). The gateway only needs `id`/`name`/`description` to relay to the model
/// via `tool_search` results; the remaining fields are deserialized for wire
/// fidelity but not read by the gateway.
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

    /// The full OpenAI function-tool definition for this tool, keyed by its
    /// fully-qualified id so the model emits a `tool_call` the loop can route
    /// back to Core by exact id.
    pub fn to_tool_def(&self) -> Value {
        json!({
            "type": "function",
            "function": {
                "name": self.id,
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
    async fn call_tool(
        &self,
        tool_id: &str,
        arguments: Value,
        agent_id: Option<&str>,
        user_id: Option<&str>,
        host_conversation_id: Option<&str>,
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
        // Contract 1 envelope: { object:"list", data:[ToolDescriptor] }.
        let data = body.get("data").cloned().unwrap_or_else(|| body.clone());
        serde_json::from_value(data).map_err(|e| format!("tools/search parse failed: {e}"))
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
    ) -> Result<Value, String> {
        let body = json!({
            "tool": tool_id,
            "arguments": arguments,
            "agent_id": agent_id,
            "user_id": user_id,
            // Server-derived host conversation → Core's `ToolPrincipal`. Omitted-as-
            // null preserves the fail-closed default on a bound node.
            "host_conversation_id": host_conversation_id,
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
