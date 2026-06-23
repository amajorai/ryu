//! Search-based tool injection front (#475, P2).
//!
//! This is the gateway-side front of the unified tool gateway. On the
//! openai-compat chat plane it:
//!   1. injects a single `tool_search` meta-tool (Contract 3) so the model can
//!      discover capabilities on demand instead of being handed every tool;
//!   2. runs a buffered tool-call loop ([`run_tool_loop`]) where `tool_search`
//!      hits Core's catalog, the model picks a tool by FQ id, the gateway
//!      describes + injects it, and executes allowlisted calls via Core;
//!   3. exposes `POST /v1/exec/tool` ([`exec`]) as the governance front for
//!      direct tool/code execution (Contract 2).
//!
//! Placement (CLAUDE.md §1): the gateway decides *what is allowed/measured*
//! (allowlist gate, audit, budget) and drives the loop; Core decides *what
//! runs* (search ranking, tool execution). Every privileged op crosses to Core
//! over HTTP via [`catalog_client::CoreCatalog`].

pub mod catalog_client;
pub mod exec;

use serde_json::{json, Value};
use tracing::{debug, info, warn};

use crate::error::GatewayError;
use crate::providers::Provider;

pub use catalog_client::{CoreCatalog, ToolSearchClient};

/// The `tool_search` meta-tool name. Always permitted; never allowlist-gated
/// (Contract 3: search ≠ grant).
pub const TOOL_SEARCH_NAME: &str = "tool_search";

/// Whether the mesh is enabled (B-9). When userspace networking is on, mesh
/// peers appear as `127.0.0.1`, so loopback-trust gates fail open; the exec gate
/// must neutralize loopback trust. Read locally so P2 compiles without P5.
pub fn mesh_enabled() -> bool {
    std::env::var("RYU_MESH_ENABLED")
        .ok()
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            !matches!(v.as_str(), "" | "0" | "false" | "no")
        })
        .unwrap_or(false)
}

/// The `tool_search` function-tool definition (Contract 3, byte-identical to the
/// ACP bridge). Permits the model to query Core's catalog for a capability.
pub fn tool_search_def() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": TOOL_SEARCH_NAME,
            "description": "Search the available tool catalog for tools that can accomplish a task. Returns a ranked list of tool descriptors (id, name, description). Call this FIRST when you need a capability not already provided as a tool, then call the returned tool by its exact id (or describe it for its argument schema).",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Natural-language description of the capability you need (e.g. 'send a slack message')." },
                    "kind":  { "type": "string", "enum": ["mcp","builtin","composio","app","any"], "description": "Optional filter by tool source plane. 'any' (default) searches all.", "default": "any" },
                    "limit": { "type": "integer", "description": "Max results.", "default": 8, "minimum": 1, "maximum": 25 }
                },
                "required": ["query"]
            }
        }
    })
}

/// Identity + governance inputs threaded into the tool loop.
#[derive(Debug, Clone, Default)]
pub struct ToolLoopContext {
    pub agent_id: Option<String>,
    pub user_id: Option<String>,
    /// Effective egress allowlist (FQ tool ids) for this request, from
    /// `x-ryu-tools` (or the legacy `x-ryu-composio-actions`). Empty ⇒ deny all
    /// non-`tool_search` execution (search still works; execution is gated).
    pub allowed: Vec<String>,
}

impl ToolLoopContext {
    /// Whether a tool id is permitted to execute. `tool_search` is always
    /// allowed (Contract 3); every other tool must appear in the allowlist by
    /// its exact fully-qualified id (`e == tool.id` only). Bare-name and
    /// bare-server matches are deliberately rejected — they would let an
    /// allowlist entry like `search` authorize `exa__search`/`composio__search`
    /// across planes (spec §3 security fix #1; lines 218/961/966). Server-scoped
    /// grants, when desired, are expressed as the explicit `<server>__*` id form
    /// upstream, never as a bare-server equality here.
    pub fn is_allowed(&self, tool_id: &str) -> bool {
        if tool_id == TOOL_SEARCH_NAME {
            return true;
        }
        self.allowed.iter().any(|a| a == tool_id)
    }
}

/// Merge the `tool_search` meta-tool (and any always-on tools) into the request
/// body, preserving caller-supplied tools and deduping by `function.name`.
///
/// Called AFTER budget enforcement (B-12): a `Restrict` budget action strips
/// `tools`, and the caller skips injection in that case so the strip is not
/// undone. `always_on` tool definitions are injected verbatim.
pub fn inject_search_tool(body: &mut Value, always_on: &[Value]) {
    let mut tools: Vec<Value> = body
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut seen: std::collections::HashSet<String> = tools
        .iter()
        .filter_map(|t| t["function"]["name"].as_str().map(str::to_string))
        .collect();

    let push_unique =
        |def: Value, seen: &mut std::collections::HashSet<String>, tools: &mut Vec<Value>| {
            if let Some(name) = def["function"]["name"].as_str() {
                if seen.insert(name.to_string()) {
                    tools.push(def);
                }
            }
        };

    push_unique(tool_search_def(), &mut seen, &mut tools);
    for def in always_on {
        push_unique(def.clone(), &mut seen, &mut tools);
    }

    body["tools"] = Value::Array(tools);
}

/// Run the buffered, search-based tool-call loop over a non-streaming provider.
///
/// Decision A (streaming): on the streaming path the caller buffers via this
/// loop with `stream:false`, then synthesizes the final SSE from the returned
/// turn. This function only does the non-streamed loop; the caller owns the SSE
/// synthesis.
///
/// Each round:
///   1. `provider.complete` produces an assistant turn.
///   2. If it has no `tool_calls`, return it (terminal).
///   3. Append the assistant turn, then for each tool call:
///      - `tool_search` → query Core's catalog, describe each hit, inject the
///        described tool defs into `body["tools"]`, and return the descriptor
///        list as the tool result.
///      - any other id → allowlist gate; denial returns an error *result* (not
///        an execution); allowed ids execute via Core `call_tool`.
///   4. Loop until no tool calls or `max_rounds` is reached.
pub async fn run_tool_loop(
    body: &mut Value,
    provider: &dyn Provider,
    model: &str,
    catalog: &dyn CoreCatalog,
    ctx: &ToolLoopContext,
    max_rounds: u8,
    describe_top_n: usize,
) -> Result<Value, GatewayError> {
    // The buffered loop must never request a stream from the provider. Also
    // strip `stream_options` (e.g. `{include_usage:true}`, injected on the
    // streaming path before the tools branch): OpenAI / OpenAI-compat providers
    // reject `stream_options` on a non-streaming request with HTTP 400. The
    // buffered completion carries `usage` regardless, and `value_to_sse_stream`
    // re-synthesizes the usage frame for the stream observer.
    body["stream"] = Value::Bool(false);
    if let Some(obj) = body.as_object_mut() {
        obj.remove("stream_options");
    }

    let mut response = provider.complete(model, body).await?;

    for round in 0..max_rounds {
        let tool_calls = match response["choices"][0]["message"]["tool_calls"].as_array() {
            Some(tc) if !tc.is_empty() => tc.clone(),
            _ => break, // terminal turn
        };

        info!(round, count = tool_calls.len(), "unified tool-call round");

        // Append the assistant turn carrying the tool_calls.
        if let Some(msgs) = body["messages"].as_array_mut() {
            msgs.push(response["choices"][0]["message"].clone());
        }

        for tc in &tool_calls {
            let name = tc["function"]["name"].as_str().unwrap_or("");
            let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
            let tool_call_id = tc["id"].as_str().unwrap_or("");
            let input: Value = serde_json::from_str(args_str).unwrap_or_else(|_| json!({}));

            let result: Value = if name == TOOL_SEARCH_NAME {
                handle_search(body, catalog, ctx, input, describe_top_n).await
            } else if ctx.is_allowed(name) {
                match catalog
                    .call_tool(name, input, ctx.agent_id.as_deref(), ctx.user_id.as_deref())
                    .await
                {
                    Ok(out) => out,
                    Err(e) => {
                        warn!(tool = name, error = %e, "tool execution failed; returning error result");
                        json!({ "error": e })
                    }
                }
            } else {
                warn!(tool = name, "tool not in allowlist; denying execution");
                json!({ "error": format!("tool '{name}' is not allowed for this request") })
            };

            if let Some(msgs) = body["messages"].as_array_mut() {
                msgs.push(json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": result.to_string(),
                }));
            }
        }

        response = provider.complete(model, body).await?;
    }

    // If the loop exhausted `max_rounds` while the model was still emitting
    // tool calls, the final turn carries no content. Mark it `length` so the
    // client/observer can tell the turn was truncated rather than an empty stop.
    let still_calling = response["choices"][0]["message"]["tool_calls"]
        .as_array()
        .is_some_and(|tc| !tc.is_empty());
    if still_calling {
        if let Some(choice) = response["choices"].get_mut(0) {
            choice["finish_reason"] = Value::String("length".to_string());
        }
    }

    Ok(response)
}

/// Handle a `tool_search` call: query Core's catalog, describe the top hits and
/// inject their tool defs so the model can call them next round. Returns the
/// descriptor list (id/name/description) as the tool result the model sees.
async fn handle_search(
    body: &mut Value,
    catalog: &dyn CoreCatalog,
    ctx: &ToolLoopContext,
    input: Value,
    describe_top_n: usize,
) -> Value {
    let query = input["query"].as_str().unwrap_or_default();
    let kind = input["kind"].as_str();
    let limit = input["limit"]
        .as_u64()
        .map(|n| n as usize)
        .filter(|n| *n > 0)
        .unwrap_or(8)
        .min(25);

    let descriptors = match catalog
        .search(query, kind, limit, ctx.agent_id.as_deref())
        .await
    {
        Ok(d) => d,
        Err(e) => {
            warn!(error = %e, "tool_search failed");
            return json!({ "error": format!("tool_search failed: {e}") });
        }
    };

    // Describe the top-N hits and inject their full tool defs so the model can
    // call them by exact id next round. Search ≠ grant: execution is still
    // allowlist-gated in the loop above.
    let mut existing: std::collections::HashSet<String> = body
        .get("tools")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|t| t["function"]["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let mut to_inject: Vec<Value> = Vec::new();
    for d in descriptors.iter().take(describe_top_n) {
        if existing.contains(&d.id) {
            continue;
        }
        match catalog.describe(&d.id).await {
            Ok(described) => {
                existing.insert(d.id.clone());
                to_inject.push(described.to_tool_def());
            }
            Err(e) => {
                debug!(id = %d.id, error = %e, "describe failed; skipping injection");
            }
        }
    }

    if !to_inject.is_empty() {
        let tools = body.get_mut("tools").and_then(Value::as_array_mut);
        match tools {
            Some(arr) => arr.extend(to_inject),
            None => body["tools"] = Value::Array(to_inject),
        }
    }

    // The result the model sees: a compact descriptor list.
    let listed: Vec<Value> = descriptors
        .iter()
        .map(|d| {
            json!({
                "id": d.id,
                "name": d.name,
                "description": d.description,
            })
        })
        .collect();
    json!({ "object": "list", "data": listed })
}

/// Synthesize an OpenAI SSE stream from a buffered non-streamed completion.
///
/// Emits, in order:
///   1. a `chat.completion.chunk` with the final assistant content as a `delta`
///      and `finish_reason`;
///   2. a terminal `{choices:[],usage:{...}}` chunk carrying the buffered
///      response's usage so the stream observer records real tokens;
///   3. `data: [DONE]`.
///
/// Only the final (post-loop) assistant content is streamed; intermediate
/// tool-call turns stay internal.
pub fn value_to_sse_stream(response: &Value) -> axum::body::Body {
    let id = response["id"].as_str().unwrap_or("chatcmpl-buffered");
    let model = response["model"].as_str().unwrap_or("unknown");
    let created = response["created"].as_u64().unwrap_or(0);
    let content = response["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    let finish_reason = response["choices"][0]["finish_reason"]
        .as_str()
        .unwrap_or("stop");
    let usage = response.get("usage").cloned().unwrap_or_else(|| json!({}));

    let content_chunk = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "delta": { "role": "assistant", "content": content },
            "finish_reason": finish_reason,
        }],
    });

    let usage_chunk = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [],
        "usage": usage,
    });

    let payload = format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        content_chunk, usage_chunk
    );
    axum::body::Body::from(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::GatewayError;
    use crate::providers::Provider;
    use async_trait::async_trait;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    // ── Mock provider ──────────────────────────────────────────────────────────

    /// A provider that returns a scripted sequence of completion responses, one
    /// per `complete` call. When the script is exhausted it repeats the last
    /// entry (so a tool-emitting last entry drives the loop to `max_rounds`).
    struct ScriptedProvider {
        responses: Vec<Value>,
        calls: AtomicUsize,
        /// Bodies seen on each complete call (to assert injection).
        seen_bodies: Mutex<Vec<Value>>,
    }

    impl ScriptedProvider {
        fn new(responses: Vec<Value>) -> Self {
            Self {
                responses,
                calls: AtomicUsize::new(0),
                seen_bodies: Mutex::new(Vec::new()),
            }
        }
        fn call_count(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl Provider for ScriptedProvider {
        fn name(&self) -> &'static str {
            "scripted"
        }
        fn complete<'a>(
            &'a self,
            _model: &'a str,
            body: &'a Value,
        ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, GatewayError>> + Send + 'a>>
        {
            let idx = self.calls.fetch_add(1, Ordering::SeqCst);
            self.seen_bodies.lock().unwrap().push(body.clone());
            let resp = self
                .responses
                .get(idx)
                .or_else(|| self.responses.last())
                .cloned()
                .unwrap_or_else(|| json!({}));
            Box::pin(async move { Ok(resp) })
        }
        fn complete_stream<'a>(
            &'a self,
            _model: &'a str,
            _body: &'a Value,
        ) -> Pin<
            Box<
                dyn std::future::Future<Output = Result<axum::body::Body, GatewayError>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move { Err(GatewayError::ProviderError("no stream".into())) })
        }
    }

    // ── Mock catalog ───────────────────────────────────────────────────────────

    #[derive(Default)]
    struct MockCatalog {
        search_results: Vec<catalog_client::ToolDescriptor>,
        described: std::collections::HashMap<String, catalog_client::DescribedTool>,
        executed: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl CoreCatalog for MockCatalog {
        async fn search(
            &self,
            _query: &str,
            _kind: Option<&str>,
            _limit: usize,
            _agent: Option<&str>,
        ) -> Result<Vec<catalog_client::ToolDescriptor>, String> {
            Ok(self.search_results.clone())
        }
        async fn describe(&self, id: &str) -> Result<catalog_client::DescribedTool, String> {
            self.described
                .get(id)
                .cloned()
                .ok_or_else(|| format!("unknown {id}"))
        }
        async fn call_tool(
            &self,
            tool_id: &str,
            _arguments: Value,
            _agent_id: Option<&str>,
            _user_id: Option<&str>,
        ) -> Result<Value, String> {
            self.executed.lock().unwrap().push(tool_id.to_string());
            Ok(json!({ "ran": tool_id }))
        }
        async fn forward_exec(&self, _path: &str, _body: Value) -> Result<Value, String> {
            Err("not implemented in mock".into())
        }
    }

    fn descriptor(id: &str, name: &str) -> catalog_client::ToolDescriptor {
        catalog_client::ToolDescriptor {
            id: id.to_string(),
            name: name.to_string(),
            description: format!("desc {name}"),
            kind: catalog_client::ToolKind::Builtin,
            arg_names: vec![],
            arg_descriptions: vec![],
            score: Some(1.0),
        }
    }

    fn described(id: &str, name: &str) -> catalog_client::DescribedTool {
        catalog_client::DescribedTool {
            id: id.to_string(),
            name: name.to_string(),
            description: format!("desc {name}"),
            args: vec![catalog_client::DescribedArg {
                name: "query".into(),
                r#type: "string".into(),
                description: "the query".into(),
                required: true,
            }],
            shallow: false,
            parameters: None,
        }
    }

    fn tool_call(id: &str, name: &str, args: &str) -> Value {
        json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": id,
                        "type": "function",
                        "function": { "name": name, "arguments": args }
                    }]
                }
            }]
        })
    }

    fn final_text(text: &str) -> Value {
        json!({
            "id": "chatcmpl-x",
            "model": "m",
            "choices": [{
                "message": { "role": "assistant", "content": text },
                "finish_reason": "stop"
            }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 5 }
        })
    }

    #[tokio::test]
    async fn search_injects_described_defs_then_executes() {
        let catalog = {
            let mut c = MockCatalog::default();
            c.search_results = vec![descriptor("exa__search", "search")];
            c.described
                .insert("exa__search".into(), described("exa__search", "search"));
            c
        };
        // Round 1: model calls tool_search. Round 2: model calls exa__search.
        // Round 3: model returns final text.
        let provider = ScriptedProvider::new(vec![
            tool_call("c1", TOOL_SEARCH_NAME, r#"{"query":"web search"}"#),
            tool_call("c2", "exa__search", r#"{"query":"rust"}"#),
            final_text("done"),
        ]);
        let ctx = ToolLoopContext {
            agent_id: Some("agent1".into()),
            user_id: None,
            allowed: vec!["exa__search".into()],
        };
        let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
        inject_search_tool(&mut body, &[]);

        let out = run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 6, 5)
            .await
            .unwrap();
        assert_eq!(out["choices"][0]["message"]["content"], "done");

        // The body's tools must now include the described exa__search def.
        let names: Vec<&str> = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["function"]["name"].as_str())
            .collect();
        assert!(names.contains(&TOOL_SEARCH_NAME));
        assert!(names.contains(&"exa__search"));
        // The allowed tool was executed.
        assert_eq!(
            catalog.executed.lock().unwrap().as_slice(),
            &["exa__search"]
        );
    }

    #[tokio::test]
    async fn allowlist_denial_returns_error_not_execution() {
        let catalog = MockCatalog::default();
        let provider = ScriptedProvider::new(vec![
            tool_call("c1", "exa__search", r#"{"query":"x"}"#),
            final_text("ok"),
        ]);
        let ctx = ToolLoopContext {
            agent_id: Some("agent1".into()),
            user_id: None,
            allowed: vec![], // nothing allowed
        };
        let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
        let _ = run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 6, 5)
            .await
            .unwrap();
        // No execution happened.
        assert!(catalog.executed.lock().unwrap().is_empty());
        // The tool message carries an error result.
        let tool_msg = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["role"] == "tool")
            .expect("a tool result message");
        let content = tool_msg["content"].as_str().unwrap();
        assert!(content.contains("not allowed"), "got: {content}");
    }

    #[tokio::test]
    async fn loop_terminates_at_max_rounds() {
        let catalog = MockCatalog::default();
        // Provider always emits a tool_search call → infinite without the cap.
        let provider =
            ScriptedProvider::new(vec![tool_call("c", TOOL_SEARCH_NAME, r#"{"query":"x"}"#)]);
        let ctx = ToolLoopContext::default();
        let mut body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
        let _ = run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 3, 5)
            .await
            .unwrap();
        // 1 initial complete + 3 rounds each ending in a follow-up complete = 4.
        assert_eq!(provider.call_count(), 4);
    }

    #[tokio::test]
    async fn run_tool_loop_strips_stream_options_for_provider() {
        // stream_options would be injected on the streaming path before the
        // tools branch; the buffered loop forces stream:false and must remove it
        // so OpenAI-family providers don't 400 on a non-streaming request.
        let catalog = MockCatalog::default();
        let provider = ScriptedProvider::new(vec![final_text("done")]);
        let ctx = ToolLoopContext::default();
        let mut body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "stream": true,
            "stream_options": { "include_usage": true }
        });
        let _ = run_tool_loop(&mut body, &provider, "m", &catalog, &ctx, 6, 5)
            .await
            .unwrap();
        // The provider must have seen stream:false and no stream_options.
        let seen = provider.seen_bodies.lock().unwrap();
        let first = &seen[0];
        assert_eq!(first["stream"], false);
        assert!(
            first.get("stream_options").is_none(),
            "stream_options must be stripped: {first}"
        );
    }

    #[test]
    fn inject_search_tool_dedupes_and_merges() {
        let mut body = json!({
            "tools": [{ "type": "function", "function": { "name": "existing", "parameters": {} } }]
        });
        let always =
            json!({ "type": "function", "function": { "name": "always1", "parameters": {} } });
        inject_search_tool(&mut body, std::slice::from_ref(&always));
        // re-inject: tool_search must not duplicate.
        inject_search_tool(&mut body, &[]);
        let names: Vec<&str> = body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["function"]["name"].as_str())
            .collect();
        assert_eq!(names.iter().filter(|n| **n == TOOL_SEARCH_NAME).count(), 1);
        assert!(names.contains(&"existing"));
        assert!(names.contains(&"always1"));
    }

    #[test]
    fn shallow_described_tool_synthesizes_permissive_schema() {
        let dt = catalog_client::DescribedTool {
            id: "composio__SLACK".into(),
            name: "SLACK".into(),
            description: "".into(),
            args: vec![],
            shallow: true,
            parameters: None,
        };
        let params = dt.to_function_parameters();
        assert_eq!(params["type"], "object");
        assert!(params["properties"]["arguments"].is_object());
    }

    #[tokio::test]
    async fn value_to_sse_carries_usage_and_content() {
        let resp = final_text("hello");
        let body = value_to_sse_stream(&resp);
        let bytes = axum::body::to_bytes(body, 1 << 20).await.unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        // Final assistant content is streamed as a delta.
        assert!(
            text.contains("\"content\":\"hello\""),
            "missing content: {text}"
        );
        // A terminal usage frame carries the buffered turn's token counts so the
        // stream observer records real tokens.
        assert!(
            text.contains("\"prompt_tokens\":10"),
            "missing usage: {text}"
        );
        assert!(
            text.contains("\"completion_tokens\":5"),
            "missing usage: {text}"
        );
        assert!(
            text.trim_end().ends_with("data: [DONE]"),
            "missing DONE: {text}"
        );
    }

    #[test]
    fn allowlist_matches_fully_qualified_id_only() {
        // Bare-server / bare-name entries must NOT authorize a FQ id
        // (spec §3 security fix #1, lines 218/961/966 — no cross-plane bypass).
        let bare = ToolLoopContext {
            agent_id: None,
            user_id: None,
            allowed: vec!["spider".into(), "crawl".into()],
        };
        assert!(
            !bare.is_allowed("spider__crawl"),
            "bare server/name must not grant a fully-qualified tool"
        );
        // The exact FQ id authorizes.
        let exact = ToolLoopContext {
            agent_id: None,
            user_id: None,
            allowed: vec!["spider__crawl".into()],
        };
        assert!(exact.is_allowed("spider__crawl"));
        // tool_search is always allowed; an unrelated id is not.
        assert!(exact.is_allowed(TOOL_SEARCH_NAME));
        assert!(!exact.is_allowed("exa__search"));
    }
}
