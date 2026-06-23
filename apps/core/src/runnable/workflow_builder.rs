//! Chat-driven workflow builder tools: `get_workflow`, `create_workflow`,
//! `configure_workflow`.
//!
//! These let a builder meta-agent (the left pane of the desktop Workflows page)
//! author and mutate a persisted [`crate::workflow::Workflow`] by tool call —
//! describe a flow in natural language and the model assembles the DAG: add/
//! rename nodes, wire edges, set triggers. They are the workflow analog of
//! [`crate::runnable::agent_builder`] and are exposed through the MCP registry
//! using the same in-process built-in pattern.
//!
//! # Core-vs-Gateway placement
//!
//! Authoring *what a workflow is* (its node/edge definition) is orchestration —
//! Core. The Gateway still governs *what the workflow is allowed to do* when its
//! nodes make model/tool calls at run time; these tools only write the local
//! definition store, so no gateway grant is required for v1.
//!
//! # Write path
//!
//! Every save routes through [`crate::workflow::persist_workflow`] — the single
//! shared path the REST `create_workflow` handler also uses — so a chat edit and
//! a canvas save behave identically (DAG validation, id minting, and trigger
//! reconciliation, Composio included). A DAG-validation failure is returned as a
//! **soft** `{ success: false, error }` value (not a hard tool error) so the
//! model can read the message and self-correct within the same turn.
//!
//! # Two writers, one document
//!
//! The right pane (the React Flow canvas) is also an editor with its own Save
//! button. This builder reads and writes the **persisted** definition; unsaved
//! canvas edits are clobbered when the builder writes and the canvas reloads.
//! That mirrors the agent builder's form re-hydration tension and is the
//! deliberate v1 contract: save canvas edits before driving the chat.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::sidecar::mcp::RegistryTool;
use crate::workflow::{Workflow, WorkflowEdge, WorkflowNode, WorkflowTrigger};

/// Reserved server name for the workflow-builder tool provider. Must not contain
/// `__` (the tool-id separator).
pub const SERVER_NAME: &str = "workflow_builder";

/// Compact reference for the node `type` discriminants and their fields, folded
/// into the create/configure tool descriptions so the model authors valid nodes.
/// Every node object is the flattened wire shape `{ "id": "...", "type": "...",
/// ...kind fields }`. Keep in sync with `crate::workflow::NodeKind`.
const NODE_KIND_REFERENCE: &str = "\
Node object shape: { \"id\": \"unique_id\", \"type\": \"<kind>\", ...fields }. Kinds and their fields:\n\
- input { key?: string }  (entry; reads run input. key defaults to the node id)\n\
- output { key?: string }  (terminal; writes its incoming value to run output)\n\
- prompt { prompt: string, agent_id?: string }  (the \"Agent\" node — runs an LLM/agent; agent_id null = default LLM)\n\
- condition { expr: string }  (branches; outgoing edges use branch \"true\"/\"false\")\n\
- transform { op: string, template?: string }  (op = uppercase|lowercase|trim|json_parse|template|identity; template used when op=template)\n\
- tool { name: string, args?: object }  (calls a Core tool, name = \"<server>__<tool>\" e.g. \"spider__crawl\")\n\
- webhook { url: string, method?: string }  (POST/PUT/PATCH/GET the incoming value)\n\
- set_state { key: string, value: string }  (writes state[key]=value template, passes input through; read later as {{state.key}})\n\
- delay { ms: number }  (durable pause)\n\
- note { text: string }  (documentation only; passes input through)\n\
- while { expr: string, body_workflow_id?: string }  (loop while expr holds when body set; else one-shot gate)\n\
- guardrails { checks: string[] }  (checks = pii|jailbreak|moderation; routed through the Gateway firewall)\n\
- sub_workflow { workflow_id: string }  (runs another saved workflow)\n\
- agent_delegate { delegates: [{ id: string, task: string, agent_id?: string }], caps?: object }  (parallel sub-agent fan-out)\n\
- awakeable { prompt?: string }  (human-in-the-loop pause; resumes via the resume endpoint)\n\
- recipe { recipe: string, params?: object }  (replays a recorded ghost desktop automation)\n\
- ghost_action { action: string, target?: object, params?: object }  (one recorded desktop action: click/type/scroll/...)\n\
Edge object shape: { \"from\": \"node_id\", \"to\": \"node_id\", \"branch\": null|\"true\"|\"false\" }.\n\
Template tokens usable in string fields: {{input}} (incoming value), {{nodes.<id>}} (an upstream node's output), \
{{state.<key>}} (run state), {{trigger.<path>}} (trigger payload field).\n\
A workflow must be an acyclic graph (DAG): no cycles, every edge endpoint must name an existing node, node ids unique.";

// ── Tool definitions ────────────────────────────────────────────────────────────

/// The tools exposed through the workflow-builder provider. Each maps to a
/// `dispatch` branch below.
pub fn tools() -> Vec<RegistryTool> {
    vec![
        RegistryTool {
            id: "workflow_builder__get_workflow".to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "get_workflow".to_owned(),
            description: Some(
                "Read the current definition of a workflow by id. Call this first to see the \
                 workflow's name, description, nodes (each with its type and config), edges, and \
                 triggers before changing anything. Required: workflow_id."
                    .to_owned(),
            ),
            input_schema: Some(get_workflow_schema()),
        },
        RegistryTool {
            id: "workflow_builder__create_workflow".to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "create_workflow".to_owned(),
            description: Some(format!(
                "Create a new workflow and return its id. Prefer editing the workflow already \
                 being built (configure_workflow) when one exists. Provide the full graph: nodes \
                 (an array of node objects) and edges (an array of edge objects) wiring them \
                 together. Required: name.\n\n{NODE_KIND_REFERENCE}"
            )),
            input_schema: Some(create_workflow_schema()),
        },
        RegistryTool {
            id: "workflow_builder__configure_workflow".to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "configure_workflow".to_owned(),
            description: Some(format!(
                "Apply a partial patch to an existing workflow. Only the fields you pass change. \
                 PREFERRED for incremental edits: nodes_upsert (add or replace nodes by id), \
                 nodes_remove (ids to delete — incident edges are removed automatically), \
                 edges_add (edges to add), edges_remove (edges to delete, matched on from+to). \
                 Use nodes_set / edges_set / triggers_set only to REPLACE a whole list at once. \
                 Set name / description to rename. The graph must stay a valid DAG; an invalid \
                 result is rejected with a message so you can fix it. Required: workflow_id.\n\n{NODE_KIND_REFERENCE}"
            )),
            input_schema: Some(configure_workflow_schema()),
        },
    ]
}

fn node_array_schema() -> Value {
    json!({
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "id": { "type": "string" },
                "type": { "type": "string" }
            },
            "required": ["id", "type"],
            "additionalProperties": true
        }
    })
}

fn edge_array_schema() -> Value {
    json!({
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "from": { "type": "string" },
                "to": { "type": "string" },
                "branch": { "type": ["string", "null"] }
            },
            "required": ["from", "to"]
        }
    })
}

fn get_workflow_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "workflow_id": { "type": "string", "description": "The workflow id to read." }
        },
        "required": ["workflow_id"]
    })
}

fn create_workflow_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": { "type": "string", "description": "Display name for the new workflow." },
            "description": { "type": "string", "description": "Short one-line description." },
            "nodes": node_array_schema(),
            "edges": edge_array_schema(),
            "triggers": { "type": "array", "items": { "type": "object" }, "description": "Trigger objects (omit for manual-only)." }
        },
        "required": ["name"]
    })
}

fn configure_workflow_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "workflow_id": { "type": "string", "description": "The workflow id to edit (required)." },
            "name": { "type": "string", "description": "New display name." },
            "description": { "type": "string", "description": "New one-line description." },
            "nodes_upsert": node_array_schema(),
            "nodes_remove": { "type": "array", "items": { "type": "string" }, "description": "Node ids to remove (incident edges removed too)." },
            "nodes_set": node_array_schema(),
            "edges_add": edge_array_schema(),
            "edges_remove": edge_array_schema(),
            "edges_set": edge_array_schema(),
            "triggers_set": { "type": "array", "items": { "type": "object" }, "description": "Replace the trigger list entirely." }
        },
        "required": ["workflow_id"]
    })
}

// ── Dispatch ────────────────────────────────────────────────────────────────────

/// Dispatch a tool call from the MCP registry to the correct workflow-builder
/// handler. No store handle is needed: the workflow store is a set of global
/// file-backed functions ([`crate::workflow::store`]).
pub async fn dispatch(tool: &str, arguments: Value) -> Result<Value> {
    match tool {
        "get_workflow" => get_workflow(arguments),
        "create_workflow" => create_workflow(arguments).await,
        "configure_workflow" => configure_workflow(arguments).await,
        other => Err(anyhow!("unknown workflow_builder tool: '{other}'")),
    }
}

fn require_str<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key].as_str().ok_or_else(|| anyhow!("missing '{key}'"))
}

/// A soft, model-readable failure (not a hard tool error) so the model can read
/// the message and retry within the same turn.
fn soft_error(message: impl Into<String>) -> Value {
    json!({ "success": false, "error": message.into() })
}

/// Parse a JSON array of node objects into [`WorkflowNode`]s. Returns the first
/// parse error verbatim so the model knows which node was malformed.
fn parse_nodes(value: &Value) -> Result<Vec<WorkflowNode>, String> {
    let arr = value
        .as_array()
        .ok_or_else(|| "expected an array of node objects".to_owned())?;
    let mut out = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        let node: WorkflowNode = serde_json::from_value(item.clone())
            .map_err(|e| format!("node #{i} is invalid: {e}"))?;
        out.push(node);
    }
    Ok(out)
}

/// Parse a JSON array of edge objects into [`WorkflowEdge`]s.
fn parse_edges(value: &Value) -> Result<Vec<WorkflowEdge>, String> {
    let arr = value
        .as_array()
        .ok_or_else(|| "expected an array of edge objects".to_owned())?;
    let mut out = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        let edge: WorkflowEdge = serde_json::from_value(item.clone())
            .map_err(|e| format!("edge #{i} is invalid: {e}"))?;
        out.push(edge);
    }
    Ok(out)
}

/// Parse a JSON array of trigger objects into [`WorkflowTrigger`]s.
fn parse_triggers(value: &Value) -> Result<Vec<WorkflowTrigger>, String> {
    let arr = value
        .as_array()
        .ok_or_else(|| "expected an array of trigger objects".to_owned())?;
    let mut out = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        let trigger: WorkflowTrigger = serde_json::from_value(item.clone())
            .map_err(|e| format!("trigger #{i} is invalid: {e}"))?;
        out.push(trigger);
    }
    Ok(out)
}

/// String list out of an argument value, defaulting to empty.
fn str_array(args: &Value, key: &str) -> Vec<String> {
    args[key]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn get_workflow(args: Value) -> Result<Value> {
    let id = require_str(&args, "workflow_id")?;
    match crate::workflow::store::load_workflow(id) {
        Ok(workflow) => Ok(json!({
            "found": true,
            "workflow": serde_json::to_value(&workflow).unwrap_or_default(),
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(json!({ "found": false, "workflow_id": id }))
        }
        Err(e) => Err(anyhow!("failed to read workflow '{id}': {e}")),
    }
}

async fn create_workflow(args: Value) -> Result<Value> {
    let name = require_str(&args, "name")?.to_owned();

    let nodes = match args.get("nodes") {
        Some(v) if !v.is_null() => match parse_nodes(v) {
            Ok(n) => n,
            Err(e) => return Ok(soft_error(e)),
        },
        _ => Vec::new(),
    };
    let edges = match args.get("edges") {
        Some(v) if !v.is_null() => match parse_edges(v) {
            Ok(e) => e,
            Err(e) => return Ok(soft_error(e)),
        },
        _ => Vec::new(),
    };
    let triggers = match args.get("triggers") {
        Some(v) if !v.is_null() => match parse_triggers(v) {
            Ok(t) => t,
            Err(e) => return Ok(soft_error(e)),
        },
        _ => Vec::new(),
    };

    let workflow = Workflow {
        id: String::new(), // empty → persist_workflow mints a `wf_…` id
        name,
        description: args["description"].as_str().map(str::to_owned),
        nodes,
        edges,
        triggers,
        created_at: None,
        updated_at: None,
    };

    match crate::workflow::persist_workflow(workflow).await {
        Ok(saved) => Ok(json!({
            "success": true,
            "workflow_id": saved.id,
            "workflow": serde_json::to_value(&saved).unwrap_or_default(),
            "message": format!("Created workflow '{}' with id '{}'.", saved.name, saved.id),
        })),
        Err(e) => Ok(soft_error(e)),
    }
}

async fn configure_workflow(args: Value) -> Result<Value> {
    let id = require_str(&args, "workflow_id")?;
    let mut workflow = match crate::workflow::store::load_workflow(id) {
        Ok(w) => w,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(soft_error(format!(
                "no workflow with id '{id}'. Use create_workflow to make a new one."
            )));
        }
        Err(e) => return Err(anyhow!("failed to read workflow '{id}': {e}")),
    };

    if let Some(v) = args["name"].as_str() {
        workflow.name = v.to_owned();
    }
    if let Some(v) = args["description"].as_str() {
        workflow.description = Some(v.to_owned());
    }

    // ── Nodes ────────────────────────────────────────────────────────────────
    if let Some(set) = args.get("nodes_set").filter(|v| v.is_array()) {
        // Wholesale replace.
        match parse_nodes(set) {
            Ok(nodes) => workflow.nodes = nodes,
            Err(e) => return Ok(soft_error(e)),
        }
    } else {
        // Incremental: upsert by id, then remove (with edge cascade).
        if let Some(upsert) = args.get("nodes_upsert").filter(|v| v.is_array()) {
            let incoming = match parse_nodes(upsert) {
                Ok(n) => n,
                Err(e) => return Ok(soft_error(e)),
            };
            for node in incoming {
                if let Some(existing) = workflow.nodes.iter_mut().find(|n| n.id == node.id) {
                    *existing = node;
                } else {
                    workflow.nodes.push(node);
                }
            }
        }
        let remove = str_array(&args, "nodes_remove");
        if !remove.is_empty() {
            workflow.nodes.retain(|n| !remove.contains(&n.id));
            // Cascade: drop edges touching a removed node so the DAG stays valid.
            workflow
                .edges
                .retain(|e| !remove.contains(&e.from) && !remove.contains(&e.to));
        }
    }

    // ── Edges ────────────────────────────────────────────────────────────────
    if let Some(set) = args.get("edges_set").filter(|v| v.is_array()) {
        match parse_edges(set) {
            Ok(edges) => workflow.edges = edges,
            Err(e) => return Ok(soft_error(e)),
        }
    } else {
        if let Some(add) = args.get("edges_add").filter(|v| v.is_array()) {
            let incoming = match parse_edges(add) {
                Ok(e) => e,
                Err(e) => return Ok(soft_error(e)),
            };
            for edge in incoming {
                let dup = workflow
                    .edges
                    .iter()
                    .any(|e| e.from == edge.from && e.to == edge.to && e.branch == edge.branch);
                if !dup {
                    workflow.edges.push(edge);
                }
            }
        }
        if let Some(rm) = args.get("edges_remove").filter(|v| v.is_array()) {
            let to_remove = match parse_edges(rm) {
                Ok(e) => e,
                Err(e) => return Ok(soft_error(e)),
            };
            workflow
                .edges
                .retain(|e| !to_remove.iter().any(|r| r.from == e.from && r.to == e.to));
        }
    }

    // ── Triggers ───────────────────────────────────────────────────────────────
    if let Some(set) = args.get("triggers_set").filter(|v| v.is_array()) {
        match parse_triggers(set) {
            Ok(triggers) => workflow.triggers = triggers,
            Err(e) => return Ok(soft_error(e)),
        }
    }

    match crate::workflow::persist_workflow(workflow).await {
        Ok(saved) => Ok(json!({
            "success": true,
            "workflow": serde_json::to_value(&saved).unwrap_or_default(),
            "message": format!(
                "Updated workflow '{}' ({} nodes, {} edges).",
                saved.name,
                saved.nodes.len(),
                saved.edges.len()
            ),
        })),
        Err(e) => Ok(soft_error(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_have_stable_ids_and_server() {
        let tools = tools();
        assert_eq!(tools.len(), 3);
        for t in &tools {
            assert_eq!(t.server, SERVER_NAME);
            assert!(t.id.starts_with("workflow_builder__"));
            assert!(!t.name.contains("__"));
        }
        let ids: Vec<&str> = tools.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"workflow_builder__get_workflow"));
        assert!(ids.contains(&"workflow_builder__create_workflow"));
        assert!(ids.contains(&"workflow_builder__configure_workflow"));
    }

    #[test]
    fn parse_nodes_reads_flattened_kind() {
        let value = json!([
            { "id": "in", "type": "input" },
            { "id": "say", "type": "prompt", "prompt": "Hi {{input}}" },
            { "id": "out", "type": "output" }
        ]);
        let nodes = parse_nodes(&value).expect("valid nodes");
        assert_eq!(nodes.len(), 3);
        assert_eq!(nodes[0].id, "in");
        assert!(matches!(nodes[1].kind, crate::workflow::NodeKind::Prompt { .. }));
    }

    #[test]
    fn parse_nodes_reports_bad_node() {
        // `transform` requires `op`; omitting it is a parse error pointing at #0.
        let value = json!([{ "id": "x", "type": "transform" }]);
        let err = parse_nodes(&value).expect_err("missing op must fail");
        assert!(err.contains("node #0"), "got: {err}");
    }

    #[test]
    fn parse_edges_round_trips_branch() {
        let value = json!([
            { "from": "a", "to": "b" },
            { "from": "b", "to": "c", "branch": "true" }
        ]);
        let edges = parse_edges(&value).expect("valid edges");
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0].branch, None);
        assert_eq!(edges[1].branch.as_deref(), Some("true"));
    }

    #[test]
    fn parse_triggers_reads_tagged_union() {
        let value = json!([{ "type": "schedule", "every": "1h" }]);
        let triggers = parse_triggers(&value).expect("valid triggers");
        assert_eq!(triggers.len(), 1);
        assert!(matches!(triggers[0], WorkflowTrigger::Schedule { .. }));
    }

    #[test]
    fn unknown_tool_errors() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt
            .block_on(dispatch("nope", json!({})))
            .expect_err("unknown tool must error");
        assert!(err.to_string().contains("unknown workflow_builder tool"));
    }
}
