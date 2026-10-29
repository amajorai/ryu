//! Built-in Spaces tools for agent turns.
//!
//! The HTTP Spaces routes and the agent tool plane share the same SpaceStore, but
//! they do not share an HTTP caller. This module is the agent-plane authorization
//! boundary: the principal comes from the host conversation, and an unresolved
//! principal on a bound node is refused before any Space or agent mutation occurs.

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

use super::{RegistryTool, ToolPrincipal};
use crate::agents::AgentStore;
use crate::server::spaces::{DocAccessMeta, DocFilter, DocOwner, SpaceAccessMeta, SpaceStore};

/// Reserved registry server name for the built-in Spaces provider.
pub const SERVER_NAME: &str = "spaces";

const DEFAULT_SEARCH_LIMIT: usize = 10;
const MAX_SEARCH_LIMIT: usize = 100;

/// Shared description of the optional `space_id` on the read tools.
const DEFAULT_SPACE_ARGUMENT: &str =
    "Readable Space id. Omit it to use the Spaces attached to the calling agent.";

fn object_schema(properties: Value, required: &[&str]) -> Value {
    let mut schema = json!({
        "type": "object",
        "properties": properties,
    });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    schema
}

fn tool(name: &str, description: &str, input_schema: Value) -> RegistryTool {
    RegistryTool {
        id: format!("{SERVER_NAME}.{name}"),
        server: SERVER_NAME.to_owned(),
        name: name.to_owned(),
        description: Some(description.to_owned()),
        input_schema: Some(input_schema),
        ..Default::default()
    }
}

/// The Spaces tools exposed through the generic registry and ACP bridge.
pub fn tools() -> Vec<RegistryTool> {
    vec![
        tool(
            "list_spaces",
            "List Spaces visible to the calling agent. Includes the current agent's attached Space ids.",
            object_schema(json!({}), &[]),
        ),
        tool(
            "list_documents",
            "List documents in a readable Space, by default the Spaces attached to the calling agent.",
            object_schema(
                json!({
                    "space_id": { "type": "string", "description": DEFAULT_SPACE_ARGUMENT }
                }),
                &[],
            ),
        ),
        tool(
            "search",
            "Search a readable Space, by default the Spaces attached to the calling agent, and return ranked matches.",
            object_schema(
                json!({
                    "space_id": { "type": "string", "description": DEFAULT_SPACE_ARGUMENT },
                    "query": { "type": "string", "description": "Search query." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_SEARCH_LIMIT }
                }),
                &["query"],
            ),
        ),
        tool(
            "create_space",
            "Create a user-owned Space. This mutating operation requires human approval unless approval-mode=off.",
            object_schema(
                json!({
                    "name": { "type": "string", "description": "Space name." },
                    "description": { "type": "string", "description": "Optional Space description." }
                }),
                &["name"],
            ),
        ),
        tool(
            "rename_space",
            "Rename an owned Space. System Spaces cannot be renamed. This mutating operation requires human approval unless approval-mode=off.",
            object_schema(
                json!({
                    "space_id": { "type": "string", "description": "Owned Space id." },
                    "name": { "type": "string", "description": "New Space name." }
                }),
                &["space_id", "name"],
            ),
        ),
        tool(
            "create_page",
            "Create a blank page in an owned Space. This mutating operation requires human approval unless approval-mode=off.",
            object_schema(
                json!({
                    "space_id": { "type": "string", "description": "Owned Space id." },
                    "title": { "type": "string", "description": "Page title." },
                    "parent_id": { "type": "string", "description": "Optional parent document id in the same Space." }
                }),
                &["space_id", "title"],
            ),
        ),
        tool(
            "create_file",
            "Upload a file into a writable Space. Provide data_base64 or text. This mutating operation requires human approval unless approval-mode=off.",
            object_schema(
                json!({
                    "space_id": { "type": "string", "description": "Writable Space id." },
                    "title": { "type": "string", "description": "File name / title." },
                    "mime": { "type": "string", "description": "MIME type; defaults to application/octet-stream." },
                    "data_base64": { "type": "string", "description": "Standard base64 file bytes. Provide this or text." },
                    "text": { "type": "string", "description": "UTF-8 file contents. Provide this or data_base64." }
                }),
                &["space_id", "title"],
            ),
        ),
        tool(
            "attach_space",
            "Attach a readable Space to the calling agent's retrieval configuration. The target agent id is server-derived. This mutating operation requires human approval unless approval-mode=off.",
            object_schema(
                json!({
                    "space_id": { "type": "string", "description": "Readable Space id to attach." }
                }),
                &["space_id"],
            ),
        ),
        tool(
            "detach_space",
            "Detach a Space from the calling agent's retrieval configuration. The target agent id is server-derived. This mutating operation requires human approval unless approval-mode=off.",
            object_schema(
                json!({
                    "space_id": { "type": "string", "description": "Space id to detach." }
                }),
                &["space_id"],
            ),
        ),
    ]
}

fn unavailable() -> Value {
    json!({
        "ok": false,
        "available": false,
        "error": "Spaces are not available on this node"
    })
}

fn require_resolved_principal(principal: &ToolPrincipal) -> Result<()> {
    if principal.is_unresolved() {
        bail!("Spaces are unavailable: this agent turn has no identifiable owner on a shared node");
    }
    Ok(())
}

fn principal_can_read_space(principal: &ToolPrincipal, meta: &SpaceAccessMeta) -> bool {
    match principal {
        ToolPrincipal::Unrestricted => true,
        ToolPrincipal::Unresolved => false,
        ToolPrincipal::Owned { user_id, org_id } => {
            let same_org = matches!(
                (org_id.as_deref(), meta.org_id.as_deref()),
                (Some(caller_org), Some(space_org)) if caller_org == space_org
            );
            meta.system
                || meta.owner_user_id.as_deref() == Some(user_id.as_str())
                || (meta.visibility == "org" && same_org)
        }
    }
}

fn principal_can_write_resource(principal: &ToolPrincipal, meta: &DocAccessMeta) -> bool {
    match principal {
        ToolPrincipal::Unrestricted => true,
        ToolPrincipal::Unresolved => false,
        ToolPrincipal::Owned { user_id, .. } => {
            meta.owner_user_id.as_deref() == Some(user_id.as_str())
        }
    }
}

fn principal_can_write_space(principal: &ToolPrincipal, meta: &SpaceAccessMeta) -> bool {
    match principal {
        ToolPrincipal::Unrestricted => true,
        ToolPrincipal::Unresolved => false,
        ToolPrincipal::Owned { user_id, .. } => {
            meta.owner_user_id.as_deref() == Some(user_id.as_str())
        }
    }
}

/// Resolve and authorize a Space before a by-id operation. `write` is strict
/// owner-write; `allow_system_content` is only for the shared filing drawers
/// used by file/artifact writes, never for rename or deletion-like operations.
pub(crate) async fn require_space_access(
    store: &SpaceStore,
    principal: &ToolPrincipal,
    space_id: &str,
    write: bool,
    allow_system_content: bool,
) -> Result<SpaceAccessMeta> {
    require_resolved_principal(principal)?;
    let meta = store
        .space_access_meta(space_id)
        .await?
        .ok_or_else(|| anyhow!("space not found or inaccessible"))?;
    let allowed = if meta.system && allow_system_content {
        true
    } else if write {
        principal_can_write_space(principal, &meta)
    } else {
        principal_can_read_space(principal, &meta)
    };
    if !allowed {
        bail!("space not found or inaccessible");
    }
    Ok(meta)
}

pub(crate) fn owner_for_principal(principal: &ToolPrincipal) -> DocOwner {
    crate::server::spaces::owner_of(&principal.tenancy())
}

fn required_string(arguments: &Value, name: &str) -> Result<String> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("missing required string argument '{name}'"))
}

fn optional_string(arguments: &Value, name: &str) -> Option<String> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

async fn list_spaces(
    arguments: Value,
    store: &SpaceStore,
    agents: Option<&AgentStore>,
    principal: &ToolPrincipal,
    agent_id: Option<&str>,
) -> Result<Value> {
    let _ = arguments;
    require_resolved_principal(principal)?;
    let (user_id, org_id, node_bound) = principal.filter_args();
    let spaces = store
        .list_spaces(DocFilter::for_caller_with_team(
            user_id, org_id, None, node_bound,
        ))
        .await?;
    let attached_space_ids = match (agents, agent_id) {
        (Some(agents), Some(agent_id)) => agents
            .get(agent_id)
            .await?
            .and_then(|agent| agent.memory)
            .map(|memory| memory.space_ids)
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    Ok(json!({
        "ok": true,
        "spaces": spaces,
        "attached_space_ids": attached_space_ids
    }))
}

/// The Spaces a read tool targets, each already authorized for the principal.
///
/// An explicit `space_id` is used as given and must be readable. Without one the
/// read goes to the calling agent's attached Spaces (its retrieval configuration,
/// the same set auto-recall reads), skipping any the principal can no longer read.
/// That is how an agent reaches the knowledge it was given without
/// `spaces.list_spaces`, which would enumerate every Space its owner can read.
async fn readable_target_spaces(
    arguments: &Value,
    store: &SpaceStore,
    agents: Option<&AgentStore>,
    principal: &ToolPrincipal,
    agent_id: Option<&str>,
) -> Result<Vec<String>> {
    if let Some(space_id) = optional_string(arguments, "space_id") {
        require_space_access(store, principal, &space_id, false, false).await?;
        return Ok(vec![space_id]);
    }
    require_resolved_principal(principal)?;
    let agent_id = agent_id.map(str::trim).filter(|id| !id.is_empty());
    let attached = match (agents, agent_id) {
        (Some(agents), Some(agent_id)) => agents
            .get(agent_id)
            .await?
            .and_then(|agent| agent.memory)
            .map(|memory| memory.space_ids)
            .unwrap_or_default(),
        _ => Vec::new(),
    };
    if attached.is_empty() {
        bail!("missing 'space_id': pass a readable Space id (this agent has no attached Spaces to default to)");
    }
    let mut readable = Vec::with_capacity(attached.len());
    for space_id in attached {
        if require_space_access(store, principal, &space_id, false, false)
            .await
            .is_ok()
        {
            readable.push(space_id);
        }
    }
    if readable.is_empty() {
        bail!("space not found or inaccessible");
    }
    Ok(readable)
}

async fn list_documents(
    arguments: Value,
    store: &SpaceStore,
    agents: Option<&AgentStore>,
    principal: &ToolPrincipal,
    agent_id: Option<&str>,
) -> Result<Value> {
    let space_ids = readable_target_spaces(&arguments, store, agents, principal, agent_id).await?;
    let (user_id, org_id, node_bound) = principal.filter_args();
    let mut listed = Vec::with_capacity(space_ids.len());
    for space_id in space_ids {
        let documents = store
            .list_documents(
                &space_id,
                DocFilter::for_caller_with_team(user_id, org_id, None, node_bound),
            )
            .await?;
        listed.push((space_id, documents));
    }
    if listed.len() == 1 {
        let (space_id, documents) = listed.remove(0);
        return Ok(json!({ "ok": true, "space_id": space_id, "documents": documents }));
    }
    let spaces: Vec<Value> = listed
        .into_iter()
        .map(|(space_id, documents)| json!({ "space_id": space_id, "documents": documents }))
        .collect();
    Ok(json!({ "ok": true, "spaces": spaces }))
}

async fn search(
    arguments: Value,
    store: &SpaceStore,
    agents: Option<&AgentStore>,
    principal: &ToolPrincipal,
    agent_id: Option<&str>,
) -> Result<Value> {
    let query = required_string(&arguments, "query")?;
    let space_ids = readable_target_spaces(&arguments, store, agents, principal, agent_id).await?;
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_SEARCH_LIMIT as u64)
        .clamp(1, MAX_SEARCH_LIMIT as u64) as usize;
    let (user_id, org_id, node_bound) = principal.filter_args();
    if let [space_id] = space_ids.as_slice() {
        let matches = store
            .search_ext(
                space_id,
                &query,
                limit,
                None,
                DocFilter::for_caller_with_team(user_id, org_id, None, node_bound),
            )
            .await?;
        return Ok(json!({ "ok": true, "space_id": space_id, "matches": matches }));
    }
    // Several attached Spaces: search each and keep the closest `limit` overall,
    // each match tagged with the Space it came from.
    let mut ranked = Vec::new();
    for space_id in &space_ids {
        let matches = store
            .search_ext(
                space_id,
                &query,
                limit,
                None,
                DocFilter::for_caller_with_team(user_id, org_id, None, node_bound),
            )
            .await?;
        ranked.extend(matches.into_iter().map(|found| (space_id.clone(), found)));
    }
    ranked.sort_by(|left, right| left.1.distance.total_cmp(&right.1.distance));
    ranked.truncate(limit);
    let matches = ranked
        .into_iter()
        .map(|(space_id, found)| -> Result<Value> {
            let mut value = serde_json::to_value(found)?;
            if let Some(object) = value.as_object_mut() {
                object.insert("space_id".to_owned(), Value::String(space_id));
            }
            Ok(value)
        })
        .collect::<Result<Vec<Value>>>()?;
    Ok(json!({ "ok": true, "space_ids": space_ids, "matches": matches }))
}

async fn create_space(
    arguments: Value,
    store: &SpaceStore,
    principal: &ToolPrincipal,
) -> Result<Value> {
    require_resolved_principal(principal)?;
    let name = required_string(&arguments, "name")?;
    let description = optional_string(&arguments, "description");
    let space_id = store
        .create_space(
            &name,
            description.as_deref(),
            &owner_for_principal(principal),
        )
        .await?;
    Ok(json!({ "ok": true, "space_id": space_id, "id": space_id }))
}

async fn rename_space(
    arguments: Value,
    store: &SpaceStore,
    principal: &ToolPrincipal,
) -> Result<Value> {
    let space_id = required_string(&arguments, "space_id")?;
    let name = required_string(&arguments, "name")?;
    let meta = require_space_access(store, principal, &space_id, true, false).await?;
    if meta.system {
        bail!("system Spaces cannot be renamed");
    }
    if !store.rename_space(&space_id, &name).await? {
        bail!("space not found or inaccessible");
    }
    Ok(json!({ "ok": true, "space_id": space_id, "name": name }))
}

async fn create_page(
    arguments: Value,
    store: &SpaceStore,
    principal: &ToolPrincipal,
) -> Result<Value> {
    let space_id = required_string(&arguments, "space_id")?;
    let title = required_string(&arguments, "title")?;
    require_space_access(store, principal, &space_id, true, false).await?;
    let owner = owner_for_principal(principal);
    let document_id = match optional_string(&arguments, "parent_id") {
        Some(parent_id) => {
            let actual_space = store
                .document_space_id(&parent_id)
                .await?
                .ok_or_else(|| anyhow!("parent document not found or inaccessible"))?;
            if actual_space != space_id {
                bail!("parent document is not in the target Space");
            }
            let parent_meta = store
                .get_access_meta(&parent_id)
                .await?
                .ok_or_else(|| anyhow!("parent document not found or inaccessible"))?;
            if !principal_can_write_resource(principal, &parent_meta) {
                bail!("parent document is not writable");
            }
            store
                .create_child_page(&space_id, &title, &parent_id, &owner)
                .await?
        }
        None => store.create_page(&space_id, &title, &owner).await?,
    };
    Ok(json!({
        "ok": true,
        "space_id": space_id,
        "document_id": document_id,
        "id": document_id
    }))
}

async fn create_file(
    arguments: Value,
    store: &SpaceStore,
    principal: &ToolPrincipal,
) -> Result<Value> {
    let space_id = required_string(&arguments, "space_id")?;
    let title = required_string(&arguments, "title")?;
    require_space_access(store, principal, &space_id, true, true).await?;
    let mime = optional_string(&arguments, "mime")
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    let bytes = if let Some(data_base64) = arguments.get("data_base64").and_then(Value::as_str) {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(data_base64.as_bytes())
            .map_err(|error| anyhow!("invalid base64 in 'data_base64': {error}"))?
    } else if let Some(text) = arguments.get("text").and_then(Value::as_str) {
        text.as_bytes().to_vec()
    } else {
        bail!("create_file requires content: provide 'data_base64' or 'text'");
    };
    if bytes.len() > crate::server::uploads::MAX_UPLOAD_BYTES {
        bail!(
            "file exceeds {} byte limit",
            crate::server::uploads::MAX_UPLOAD_BYTES
        );
    }
    let byte_size = bytes.len();
    let created = crate::space_file_index::create_file_indexed_detached(
        store,
        &space_id,
        &title,
        &bytes,
        &mime,
        &owner_for_principal(principal),
    )
    .await?;
    Ok(json!({
        "ok": true,
        "space_id": space_id,
        "document_id": created.document_id,
        "id": created.document_id,
        "mime": mime,
        "byte_size": byte_size,
        "index": created.index.to_json()
    }))
}

async fn set_space_attachment(
    arguments: Value,
    store: &SpaceStore,
    agents: Option<&AgentStore>,
    principal: &ToolPrincipal,
    agent_id: Option<&str>,
    attached: bool,
) -> Result<Value> {
    let space_id = required_string(&arguments, "space_id")?;
    require_space_access(store, principal, &space_id, false, false).await?;
    let agent_id = agent_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow!("Spaces access changes require a server-derived calling agent"))?;
    let agents = agents.ok_or_else(|| anyhow!("agent store is not wired on this node"))?;
    let updated = agents
        .set_space_access(agent_id, &space_id, attached)
        .await?
        .ok_or_else(|| anyhow!("calling agent not found"))?;
    let space_ids = updated
        .memory
        .map(|memory| memory.space_ids)
        .unwrap_or_default();
    Ok(json!({
        "ok": true,
        "agent_id": agent_id,
        "space_id": space_id,
        "attached": attached,
        "space_ids": space_ids
    }))
}

/// Dispatch a Spaces tool call after the registry has resolved its server-derived
/// principal and calling agent id.
pub async fn dispatch(
    tool: &str,
    arguments: Value,
    spaces: Option<&SpaceStore>,
    agents: Option<&AgentStore>,
    principal: &ToolPrincipal,
    agent_id: Option<&str>,
) -> Result<Value> {
    let Some(store) = spaces else {
        return Ok(unavailable());
    };
    match tool {
        "list_spaces" => list_spaces(arguments, store, agents, principal, agent_id).await,
        "list_documents" => list_documents(arguments, store, agents, principal, agent_id).await,
        "search" => search(arguments, store, agents, principal, agent_id).await,
        "create_space" => create_space(arguments, store, principal).await,
        "rename_space" => rename_space(arguments, store, principal).await,
        "create_page" => create_page(arguments, store, principal).await,
        "create_file" => create_file(arguments, store, principal).await,
        "attach_space" => {
            set_space_attachment(arguments, store, agents, principal, agent_id, true).await
        }
        "detach_space" => {
            set_space_attachment(arguments, store, agents, principal, agent_id, false).await
        }
        other => Err(anyhow!("unknown Spaces tool '{other}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::{AgentStore, CreateAgent, MemorySlot};
    use crate::sidecar::adapters::AcpAgentRegistry;

    fn owned(user_id: &str) -> DocOwner {
        DocOwner::owned(Some(user_id), Some("org1"))
    }

    #[tokio::test]
    async fn exposes_the_agent_spaces_capability_set() {
        let ids: Vec<String> = tools().into_iter().map(|tool| tool.id).collect();
        for id in [
            "spaces.list_spaces",
            "spaces.list_documents",
            "spaces.search",
            "spaces.create_space",
            "spaces.rename_space",
            "spaces.create_page",
            "spaces.create_file",
            "spaces.attach_space",
            "spaces.detach_space",
        ] {
            assert!(ids.iter().any(|candidate| candidate == id), "missing {id}");
        }
    }

    #[tokio::test]
    async fn creates_and_uploads_with_the_resolved_owner() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let principal = ToolPrincipal::Owned {
            user_id: "alice".to_owned(),
            org_id: Some("org1".to_owned()),
        };
        let space = dispatch(
            "create_space",
            json!({ "name": "Alice notes" }),
            Some(&spaces),
            None,
            &principal,
            Some("agent_alice"),
        )
        .await
        .unwrap()["space_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let page = dispatch(
            "create_page",
            json!({ "space_id": space, "title": "Draft" }),
            Some(&spaces),
            None,
            &principal,
            Some("agent_alice"),
        )
        .await
        .unwrap();
        let page_meta = spaces
            .get_access_meta(page["document_id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(page_meta.owner_user_id.as_deref(), Some("alice"));

        let file = dispatch(
            "create_file",
            json!({ "space_id": space, "title": "note.txt", "text": "hello" }),
            Some(&spaces),
            None,
            &principal,
            Some("agent_alice"),
        )
        .await
        .unwrap();
        let file_meta = spaces
            .get_access_meta(file["document_id"].as_str().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(file_meta.owner_user_id.as_deref(), Some("alice"));
    }

    #[tokio::test]
    async fn unresolved_principal_cannot_mutate_spaces_or_access() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let space = spaces
            .create_space("Alice", None, &owned("alice"))
            .await
            .unwrap();
        let result = dispatch(
            "create_page",
            json!({ "space_id": space, "title": "No owner" }),
            Some(&spaces),
            None,
            &ToolPrincipal::Unresolved,
            Some("agent_alice"),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn owner_gate_blocks_a_different_users_space() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let bob_space = spaces
            .create_space("Bob", None, &owned("bob"))
            .await
            .unwrap();
        let alice = ToolPrincipal::Owned {
            user_id: "alice".to_owned(),
            org_id: Some("org1".to_owned()),
        };
        let result = dispatch(
            "rename_space",
            json!({ "space_id": bob_space, "name": "Taken" }),
            Some(&spaces),
            None,
            &alice,
            Some("agent_alice"),
        )
        .await;
        assert!(result.is_err());
    }

    #[test]
    fn org_visibility_requires_two_present_matching_org_ids() {
        let principal = ToolPrincipal::Owned {
            user_id: "alice".to_owned(),
            org_id: None,
        };
        let meta = SpaceAccessMeta {
            owner_user_id: None,
            org_id: None,
            visibility: "org".to_owned(),
            team_id: None,
            system: false,
        };
        assert!(!principal_can_read_space(&principal, &meta));
    }

    #[tokio::test]
    async fn attachment_mutates_only_the_server_derived_agent() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let space = spaces
            .create_space("Shared", None, &owned("alice"))
            .await
            .unwrap();
        let registry = AcpAgentRegistry::new();
        let agents = AgentStore::open_in_memory(&registry).unwrap();
        let agent = agents
            .create(CreateAgent {
                name: "Alice agent".to_owned(),
                memory: Some(MemorySlot {
                    space_ids: Vec::new(),
                    read_levels: vec!["user".to_owned()],
                    write_enabled: false,
                    ..Default::default()
                }),
                ..Default::default()
            })
            .await
            .unwrap();
        let principal = ToolPrincipal::Owned {
            user_id: "alice".to_owned(),
            org_id: Some("org1".to_owned()),
        };
        let attached = dispatch(
            "attach_space",
            json!({ "space_id": space }),
            Some(&spaces),
            Some(&agents),
            &principal,
            Some(&agent.id),
        )
        .await
        .unwrap();
        assert_eq!(attached["attached"], true);
        assert_eq!(attached["space_ids"][0], space);
        let detached = dispatch(
            "detach_space",
            json!({ "space_id": attached["space_id"] }),
            Some(&spaces),
            Some(&agents),
            &principal,
            Some(&agent.id),
        )
        .await
        .unwrap();
        assert_eq!(detached["attached"], false);
        assert_eq!(detached["space_ids"], json!([]));
    }

    #[tokio::test]
    async fn read_tools_default_to_the_calling_agents_attached_spaces() {
        let spaces = SpaceStore::open_in_memory().unwrap();
        let knowledge = spaces
            .create_space("Knowledge", None, &owned("alice"))
            .await
            .unwrap();
        let notes = spaces
            .create_space("Notes", None, &owned("alice"))
            .await
            .unwrap();
        for (space, title, body) in [
            (&knowledge, "Profile", "Builds things in Singapore."),
            (&notes, "Todo", "Ship the Singapore release."),
        ] {
            spaces
                .import_document(space, title, body, "page", None, &owned("alice"))
                .await
                .unwrap();
            spaces
                .index_unindexed_documents_in_space(space)
                .await
                .unwrap();
        }
        let agents = AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap();
        let agent = agents
            .create(CreateAgent {
                name: "Reader".to_owned(),
                memory: Some(MemorySlot {
                    space_ids: vec![knowledge.clone()],
                    read_levels: Vec::new(),
                    write_enabled: false,
                    ..Default::default()
                }),
                ..Default::default()
            })
            .await
            .unwrap();
        let alice = ToolPrincipal::Owned {
            user_id: "alice".to_owned(),
            org_id: Some("org1".to_owned()),
        };
        let call = |tool: &'static str, arguments: Value, agent_id: String| {
            let spaces = &spaces;
            let agents = &agents;
            let alice = &alice;
            async move {
                dispatch(
                    tool,
                    arguments,
                    Some(spaces),
                    Some(agents),
                    alice,
                    Some(agent_id.as_str()),
                )
                .await
            }
        };

        // No `space_id`: the one attached Space, in the explicit-call shape.
        let listed = call("list_documents", json!({}), agent.id.clone())
            .await
            .unwrap();
        assert_eq!(listed["space_id"], knowledge);
        assert_eq!(listed["documents"].as_array().unwrap().len(), 1);
        let found = call("search", json!({ "query": "Singapore" }), agent.id.clone())
            .await
            .unwrap();
        assert_eq!(found["space_id"], knowledge);
        assert!(!found["matches"].as_array().unwrap().is_empty());

        // An explicit id still targets exactly that readable Space.
        let explicit = call(
            "list_documents",
            json!({ "space_id": notes }),
            agent.id.clone(),
        )
        .await
        .unwrap();
        assert_eq!(explicit["space_id"], notes);

        // Several attached Spaces: one listing each, and merged search results
        // tagged with the Space they came from.
        agents
            .set_space_access(&agent.id, &notes, true)
            .await
            .unwrap();
        let listed = call("list_documents", json!({}), agent.id.clone())
            .await
            .unwrap();
        assert_eq!(listed["spaces"].as_array().unwrap().len(), 2);
        let found = call(
            "search",
            json!({ "query": "Singapore", "limit": 5 }),
            agent.id.clone(),
        )
        .await
        .unwrap();
        assert_eq!(found["space_ids"].as_array().unwrap().len(), 2);
        let matches = found["matches"].as_array().unwrap();
        assert!(!matches.is_empty());
        assert!(matches.iter().all(|found| found["space_id"].is_string()));

        // An agent with nothing attached must still name a Space.
        let bare = agents
            .create(CreateAgent {
                name: "Bare".to_owned(),
                ..Default::default()
            })
            .await
            .unwrap();
        let error = call("search", json!({ "query": "Singapore" }), bare.id.clone())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("space_id"), "{error:#}");

        // Another member cannot read Alice's private attached Space through the
        // default either.
        let bob = ToolPrincipal::Owned {
            user_id: "bob".to_owned(),
            org_id: Some("org1".to_owned()),
        };
        let refused = dispatch(
            "list_documents",
            json!({}),
            Some(&spaces),
            Some(&agents),
            &bob,
            Some(&agent.id),
        )
        .await;
        assert!(refused.is_err());
    }
}
