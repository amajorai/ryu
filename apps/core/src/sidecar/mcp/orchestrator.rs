//! Built-in orchestration discovery tool (`orchestrator__discover_agents`).
//!
//! Delegation itself already exists: [`super::delegate`]'s `delegate__fanout`
//! routes a subtask to any agent by `agent_id`. What was missing is *discovery* —
//! a way for an orchestrator agent to find out **which** agents exist and **what**
//! each is for, so it can pick a specialist by capability instead of having to
//! already know its id. This provider closes that gap: `discover_agents` returns
//! the installed agents with their `id`, `name`, `description`, and `engine`, with
//! an optional free-text `query` filter over name + description.
//!
//! The pair is deliberate and keeps the model's mental model sharp:
//!   1. `orchestrator__discover_agents` — find the right specialist by description.
//!   2. `delegate__fanout` (with that `agent_id`) — hand it the subtask.
//!
//! Per the Core-vs-Gateway rule this is **Core**: it reads the local agent config
//! store to decide *what can run*. Offered only to agents whose
//! [`crate::agents::AgentRecord::orchestrator_enabled`] capability is on (gated in
//! the bridge), so a non-orchestrator agent never sees it.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use super::RegistryTool;
use crate::agents::AgentStore;

/// Reserved registry server name for the built-in orchestration provider. Must
/// not contain `__` (the tool-id separator).
pub const SERVER_NAME: &str = "orchestrator";

/// Default cap on how many agents `discover_agents` returns when the caller does
/// not specify a `limit`. Keeps the tool result compact for the model.
const DEFAULT_LIMIT: usize = 25;

fn discover_agents_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Optional free-text filter. Case-insensitive; matches agents whose name or description contains every whitespace-separated term. Omit to list all installed agents."
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "description": "Max number of agents to return (default 25)."
            }
        }
    })
}

/// The orchestration tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![RegistryTool {
        id: format!("{SERVER_NAME}__discover_agents"),
        server: SERVER_NAME.to_owned(),
        name: "discover_agents".to_owned(),
        description: Some(
            "List the other agents available to delegate to, with each one's id, name, and \
             description, so you can pick the right specialist for a subtask. Optionally pass a \
             `query` to filter by what an agent does (matched against its name and description). \
             After choosing one, hand it the subtask with the delegate__fanout tool, passing the \
             agent's id. Use this whenever a request would be better handled by a more \
             specialised agent than yourself."
                .to_owned(),
        ),
        input_schema: Some(discover_agents_schema()),
        ..Default::default()
    }]
}

/// Dispatch an `orchestrator` tool call. `store` is an owned clone of the shared
/// [`AgentStore`] (cheap; `Arc` inside). `caller_id` is the agent making the call
/// — it is excluded from results so an orchestrator never delegates to itself.
pub async fn dispatch(
    tool: &str,
    arguments: Value,
    store: AgentStore,
    caller_id: Option<&str>,
) -> Result<Value> {
    match tool {
        "discover_agents" => discover_agents(arguments, store, caller_id).await,
        other => Err(anyhow!("unknown orchestrator tool: '{other}'")),
    }
}

/// Lower-case whitespace terms of a query, for substring matching.
fn query_terms(arguments: &Value) -> Vec<String> {
    arguments
        .get("query")
        .and_then(Value::as_str)
        .map(|q| {
            q.split_whitespace()
                .map(str::to_lowercase)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

async fn discover_agents(
    arguments: Value,
    store: AgentStore,
    caller_id: Option<&str>,
) -> Result<Value> {
    let terms = query_terms(&arguments);
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_LIMIT);

    // Only surface agents the user has actually installed — the same set the
    // agent picker shows — so the model never delegates to a catalog-only agent
    // that isn't really available on this node.
    let installed = store.installed_ids().await?;
    let agents = store.list().await?;

    let mut matched: Vec<Value> = Vec::new();
    for agent in agents {
        if !installed.contains(&agent.id) {
            continue;
        }
        // Never offer the caller itself as a delegation target.
        if caller_id == Some(agent.id.as_str()) {
            continue;
        }
        if !terms.is_empty() {
            let haystack = format!(
                "{} {}",
                agent.name,
                agent.description.as_deref().unwrap_or_default()
            )
            .to_lowercase();
            if !terms.iter().all(|t| haystack.contains(t)) {
                continue;
            }
        }
        matched.push(json!({
            "id": agent.id,
            "name": agent.name,
            "description": agent.description,
            "engine": agent.engine,
        }));
        if matched.len() >= limit {
            break;
        }
    }

    let count = matched.len();
    Ok(json!({ "agents": matched, "count": count }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::CreateAgent;
    use crate::sidecar::adapters::acp::AcpAgentRegistry;

    fn store() -> AgentStore {
        AgentStore::open_in_memory(&AcpAgentRegistry::new()).expect("in-memory agent store")
    }

    #[test]
    fn tool_has_stable_id_and_server() {
        let tools = tools();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].id, "orchestrator__discover_agents");
        assert_eq!(tools[0].server, SERVER_NAME);
        assert!(!tools[0].name.contains("__"));
        assert!(tools[0].input_schema.is_some());
    }

    #[tokio::test]
    async fn discover_lists_installed_agents() {
        let store = store();
        // ryu is seeded installed; list it (caller is someone else).
        let out = discover_agents(json!({}), store.clone(), Some("agent-x"))
            .await
            .unwrap();
        let agents = out["agents"].as_array().unwrap();
        assert!(agents.iter().any(|a| a["id"] == "ryu"));
    }

    #[tokio::test]
    async fn discover_excludes_caller() {
        let store = store();
        let out = discover_agents(json!({}), store.clone(), Some("ryu"))
            .await
            .unwrap();
        let agents = out["agents"].as_array().unwrap();
        assert!(
            !agents.iter().any(|a| a["id"] == "ryu"),
            "the caller must not appear as a delegation target"
        );
    }

    #[tokio::test]
    async fn discover_filters_by_query() {
        let store = store();
        let created = store
            .create(CreateAgent {
                name: "Finance Analyst".to_owned(),
                description: Some("Handles budgets and CFO tasks".to_owned()),
                ..Default::default()
            })
            .await
            .unwrap();
        // Newly created agents are not installed by default; install it so it shows.
        store.set_installed(&created.id, true).await.unwrap();

        let hit = discover_agents(json!({ "query": "cfo budget" }), store.clone(), None)
            .await
            .unwrap();
        assert_eq!(hit["count"], json!(1));
        assert_eq!(hit["agents"][0]["id"], json!(created.id));

        let miss = discover_agents(json!({ "query": "kubernetes" }), store, None)
            .await
            .unwrap();
        assert_eq!(miss["count"], json!(0));
    }

    #[tokio::test]
    async fn unknown_tool_errors() {
        assert!(dispatch("nope", json!({}), store(), None).await.is_err());
    }
}
