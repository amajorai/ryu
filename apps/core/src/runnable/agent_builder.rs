//! Chat-driven agent builder tools: `get_agent`, `configure_agent`, `create_agent`.
//!
//! These let a builder meta-agent (the left pane of the desktop agent-edit page)
//! mutate a persisted [`AgentRecord`] by tool call — rename it, edit its
//! instructions, add/remove tools, skills, Composio actions, identities, and set
//! its persona. They are exposed through the MCP registry using the same
//! in-process built-in pattern as [`crate::runnable::self_build`].
//!
//! # Core-vs-Gateway placement
//!
//! Editing *what an agent is* (its config record) is orchestration — Core. The
//! Gateway still governs *what an agent is allowed to do* at runtime; this tool
//! only writes the local config store, so no gateway grant is required for v1.
//!
//! # Security / scoping
//!
//! The model authors the `agent_id` argument, so [`configure_agent`] refuses to
//! edit a `built_in` or `locked` record (the flagship `ryu`, the builder
//! meta-agent itself, or any registry agent). Editing among the user's own
//! custom agents is allowed — single-tenant, local-first; the user owns them
//! all. A per-user gateway grant is a future multi-tenant tightening.

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::agents::{AgentStore, CreateAgent, PersonaSlot, UpdateAgent};
use crate::sidecar::mcp::RegistryTool;

/// Reserved server name for the agent-builder tool provider. Must not contain
/// `__` (the tool-id separator).
pub const SERVER_NAME: &str = "agent_builder";

// ── Tool definitions ────────────────────────────────────────────────────────────

/// The tools exposed through the agent-builder provider. Each maps to a
/// `dispatch` branch below.
pub fn tools() -> Vec<RegistryTool> {
    vec![
        RegistryTool {
            id: "agent_builder__get_agent".to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "get_agent".to_owned(),
            description: Some(
                "Read the current configuration of an agent record by id. Call this first to see \
                 the agent's current name, description, instructions (system_prompt), engine, and \
                 the lists of tools, skills, composio_actions, and identity_profile_ids before \
                 changing anything. Required: agent_id."
                    .to_owned(),
            ),
            input_schema: Some(get_agent_schema()),
        },
        RegistryTool {
            id: "agent_builder__configure_agent".to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "configure_agent".to_owned(),
            description: Some(
                "Apply a partial patch to an existing agent record. Only the fields you pass are \
                 changed; everything else is left untouched. For the list fields (tools, skills, \
                 composio_actions, identity_profile_ids) use the *_add / *_remove arrays to add or \
                 remove individual entries without resending the whole list, or *_set to replace \
                 the list entirely. The system_prompt field is the agent's instructions. Cannot \
                 edit a built-in or locked agent. Required: agent_id."
                    .to_owned(),
            ),
            input_schema: Some(configure_agent_schema()),
        },
        RegistryTool {
            id: "agent_builder__create_agent".to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "create_agent".to_owned(),
            description: Some(
                "Create a new custom agent record and return its id. Prefer editing the agent \
                 already being configured (configure_agent) when one exists. Required: name. \
                 Optional: description, system_prompt (instructions), engine, tools, skills."
                    .to_owned(),
            ),
            input_schema: Some(create_agent_schema()),
        },
    ]
}

fn get_agent_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "agent_id": { "type": "string", "description": "The agent record id to read." }
        },
        "required": ["agent_id"]
    })
}

fn configure_agent_schema() -> Value {
    let str_list = json!({ "type": "array", "items": { "type": "string" } });
    json!({
        "type": "object",
        "properties": {
            "agent_id": { "type": "string", "description": "The agent record id to edit (required)." },
            "name": { "type": "string", "description": "New display name." },
            "description": { "type": "string", "description": "Short one-line description of the agent." },
            "system_prompt": { "type": "string", "description": "The agent's full instructions (system prompt)." },
            "engine": { "type": "string", "description": "Engine/runtime id, e.g. 'acp:pi', 'acp:claude', or a local engine id." },
            "persona": {
                "type": "object",
                "description": "Persona: how the agent presents itself.",
                "properties": {
                    "display_name": { "type": "string", "description": "Name the agent uses when introducing itself." },
                    "tone": { "type": "string", "description": "Tone, e.g. 'professional', 'friendly', or a custom phrase." }
                }
            },
            "inference": { "type": "object", "description": "Advanced sampling defaults (temperature, top_p, …)." },
            "tools_add": str_list, "tools_remove": str_list, "tools_set": str_list,
            "skills_add": str_list, "skills_remove": str_list, "skills_set": str_list,
            "composio_actions_add": str_list, "composio_actions_remove": str_list, "composio_actions_set": str_list,
            "identity_profile_ids_add": str_list, "identity_profile_ids_remove": str_list, "identity_profile_ids_set": str_list
        },
        "required": ["agent_id"]
    })
}

fn create_agent_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": { "type": "string", "description": "Display name for the new agent." },
            "description": { "type": "string", "description": "Short one-line description." },
            "system_prompt": { "type": "string", "description": "The agent's instructions." },
            "engine": { "type": "string", "description": "Engine/runtime id, e.g. 'acp:pi'." },
            "tools": { "type": "array", "items": { "type": "string" }, "description": "Initial tool allowlist." },
            "skills": { "type": "array", "items": { "type": "string" }, "description": "Initial skill allowlist." }
        },
        "required": ["name"]
    })
}

// ── Dispatch ────────────────────────────────────────────────────────────────────

/// Dispatch a tool call from the MCP registry to the correct agent-builder
/// handler. `store` is an owned clone of the shared [`AgentStore`] (it is
/// `Clone`, holding an `Arc` inside).
pub async fn dispatch(tool: &str, arguments: Value, store: AgentStore) -> Result<Value> {
    match tool {
        "get_agent" => get_agent(arguments, store).await,
        "configure_agent" => configure_agent(arguments, store).await,
        "create_agent" => create_agent(arguments, store).await,
        other => Err(anyhow!("unknown agent_builder tool: '{other}'")),
    }
}

fn require_str<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key].as_str().ok_or_else(|| anyhow!("missing '{key}'"))
}

/// Pull a `["a","b"]` string array out of an argument value, defaulting to empty.
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

/// Resolve an add/remove/set patch for one list field against the current value.
///
/// Returns `None` when none of `{base}_set`, `{base}_add`, `{base}_remove` are
/// present (so the field is left untouched). `*_set` wins outright; otherwise
/// `*_add` appends (deduped, order preserved) and `*_remove` filters.
fn resolve_list(current: &[String], args: &Value, base: &str) -> Option<Vec<String>> {
    let set_key = format!("{base}_set");
    let add_key = format!("{base}_add");
    let remove_key = format!("{base}_remove");
    let has_set = args.get(&set_key).map(Value::is_array).unwrap_or(false);
    let has_add = args.get(&add_key).is_some();
    let has_remove = args.get(&remove_key).is_some();
    if !(has_set || has_add || has_remove) {
        return None;
    }
    if has_set {
        return Some(dedup_preserve(str_array(args, &set_key)));
    }
    let mut out: Vec<String> = current.to_vec();
    for item in str_array(args, &add_key) {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    let to_remove = str_array(args, &remove_key);
    out.retain(|x| !to_remove.contains(x));
    Some(out)
}

fn dedup_preserve(items: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

async fn get_agent(args: Value, store: AgentStore) -> Result<Value> {
    let id = require_str(&args, "agent_id")?;
    match store.get(id).await? {
        Some(record) => Ok(json!({
            "found": true,
            "agent": serde_json::to_value(&record).unwrap_or_default(),
        })),
        None => Ok(json!({ "found": false, "agent_id": id })),
    }
}

async fn configure_agent(args: Value, store: AgentStore) -> Result<Value> {
    let id = require_str(&args, "agent_id")?;
    let record = store
        .get(id)
        .await?
        .ok_or_else(|| anyhow!("no agent with id '{id}'"))?;

    // The model authors `agent_id`; refuse protected rows (ryu, the builder
    // meta-agent, any registry agent). `update` also rejects locked rows, but
    // guarding here gives a clearer message and also blocks editable built-ins.
    if record.built_in || record.locked {
        return Err(anyhow!(
            "agent_builder cannot edit a built-in or locked agent ('{id}'). \
             Create a custom agent or edit one the user owns."
        ));
    }

    let mut patch = UpdateAgent::default();
    if let Some(v) = args["name"].as_str() {
        patch.name = Some(v.to_owned());
    }
    if let Some(v) = args["description"].as_str() {
        patch.description = Some(v.to_owned());
    }
    if let Some(v) = args["system_prompt"].as_str() {
        patch.system_prompt = Some(v.to_owned());
    }
    if let Some(v) = args["engine"].as_str() {
        patch.engine = Some(v.to_owned());
    }
    if let Some(persona) = args.get("persona").filter(|p| p.is_object()) {
        patch.persona = Some(PersonaSlot {
            display_name: persona["display_name"].as_str().map(str::to_owned),
            avatar_url: None,
            tone: persona["tone"].as_str().map(str::to_owned),
        });
    }
    if let Some(inference) = args.get("inference").filter(|i| i.is_object()) {
        patch.inference = serde_json::from_value(inference.clone()).ok();
    }
    patch.tools = resolve_list(&record.tools, &args, "tools");
    patch.skills = resolve_list(&record.skills, &args, "skills");
    patch.composio_actions = resolve_list(&record.composio_actions, &args, "composio_actions");
    patch.identity_profile_ids =
        resolve_list(&record.identity_profile_ids, &args, "identity_profile_ids");

    let updated = store
        .update(id, patch)
        .await?
        .ok_or_else(|| anyhow!("agent '{id}' vanished during update"))?;

    Ok(json!({
        "success": true,
        "agent": serde_json::to_value(&updated).unwrap_or_default(),
        "message": format!("Updated agent '{}'.", updated.name),
    }))
}

async fn create_agent(args: Value, store: AgentStore) -> Result<Value> {
    let name = require_str(&args, "name")?;
    let input = CreateAgent {
        name: name.to_owned(),
        description: args["description"].as_str().map(str::to_owned),
        system_prompt: args["system_prompt"].as_str().map(str::to_owned),
        engine: args["engine"].as_str().map(str::to_owned),
        tools: str_array(&args, "tools"),
        skills: str_array(&args, "skills"),
        ..Default::default()
    };
    let created = store.create(input).await?;
    Ok(json!({
        "success": true,
        "agent_id": created.id,
        "agent": serde_json::to_value(&created).unwrap_or_default(),
        "message": format!("Created agent '{}' with id '{}'.", created.name, created.id),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::adapters::acp::AcpAgentRegistry;

    fn store() -> AgentStore {
        let registry = AcpAgentRegistry::new();
        AgentStore::open_in_memory(&registry).expect("in-memory agent store")
    }

    #[test]
    fn tools_have_stable_ids_and_server() {
        let tools = tools();
        assert_eq!(tools.len(), 3);
        for t in &tools {
            assert_eq!(t.server, SERVER_NAME);
            assert!(t.id.starts_with("agent_builder__"));
            assert!(!t.name.contains("__"));
        }
        let ids: Vec<&str> = tools.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"agent_builder__get_agent"));
        assert!(ids.contains(&"agent_builder__configure_agent"));
        assert!(ids.contains(&"agent_builder__create_agent"));
    }

    #[test]
    fn resolve_list_add_remove_set() {
        let current = vec!["a".to_owned(), "b".to_owned()];
        // No keys → untouched.
        assert_eq!(resolve_list(&current, &json!({}), "tools"), None);
        // Add dedups + preserves order.
        assert_eq!(
            resolve_list(&current, &json!({ "tools_add": ["b", "c"] }), "tools"),
            Some(vec!["a".to_owned(), "b".to_owned(), "c".to_owned()])
        );
        // Remove filters.
        assert_eq!(
            resolve_list(&current, &json!({ "tools_remove": ["a"] }), "tools"),
            Some(vec!["b".to_owned()])
        );
        // Set replaces (and dedups).
        assert_eq!(
            resolve_list(&current, &json!({ "tools_set": ["x", "x", "y"] }), "tools"),
            Some(vec!["x".to_owned(), "y".to_owned()])
        );
    }

    #[tokio::test]
    async fn configure_agent_refuses_built_in() {
        let store = store();
        // `ryu` is a seeded built-in.
        let err = configure_agent(
            json!({ "agent_id": "ryu", "name": "Hacked" }),
            store.clone(),
        )
        .await
        .expect_err("editing a built-in must fail");
        assert!(err.to_string().contains("built-in"));
        // Unchanged.
        let ryu = store.get("ryu").await.unwrap().unwrap();
        assert_ne!(ryu.name, "Hacked");
    }

    #[tokio::test]
    async fn configure_agent_patches_custom_agent() {
        let store = store();
        let created = store
            .create(CreateAgent {
                name: "Helper".to_owned(),
                tools: vec!["a".to_owned()],
                ..Default::default()
            })
            .await
            .unwrap();

        let res = configure_agent(
            json!({
                "agent_id": created.id,
                "name": "Research helper",
                "system_prompt": "Be concise.",
                "tools_add": ["b"],
            }),
            store.clone(),
        )
        .await
        .unwrap();
        assert_eq!(res["success"], json!(true));

        let updated = store.get(&created.id).await.unwrap().unwrap();
        assert_eq!(updated.name, "Research helper");
        assert_eq!(updated.system_prompt.as_deref(), Some("Be concise."));
        assert_eq!(updated.tools, vec!["a".to_owned(), "b".to_owned()]);
    }

    #[tokio::test]
    async fn get_agent_round_trips() {
        let store = store();
        let found = get_agent(json!({ "agent_id": "ryu" }), store.clone())
            .await
            .unwrap();
        assert_eq!(found["found"], json!(true));
        let missing = get_agent(json!({ "agent_id": "nope" }), store)
            .await
            .unwrap();
        assert_eq!(missing["found"], json!(false));
    }

    #[tokio::test]
    async fn create_agent_makes_a_record() {
        let store = store();
        let res = create_agent(
            json!({ "name": "Fresh", "system_prompt": "Hi", "tools": ["x"] }),
            store.clone(),
        )
        .await
        .unwrap();
        let id = res["agent_id"].as_str().unwrap();
        let rec = store.get(id).await.unwrap().unwrap();
        assert_eq!(rec.name, "Fresh");
        assert_eq!(rec.tools, vec!["x".to_owned()]);
    }
}
