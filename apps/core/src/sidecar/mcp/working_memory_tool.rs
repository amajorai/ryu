//! Built-in working-memory tool for agent turns.
//!
//! `working_memory.update_working_memory` is how an agent keeps its scratchpad
//! current. The scratchpad itself is injected into every turn by
//! `server::memory_working::turn_context_block`; this tool only writes it.
//!
//! Authorization is server-derived: the owner comes from the host
//! conversation's principal ([`ToolPrincipal`]), the document id from the host
//! conversation (thread scope) or that owner (resource scope), and the mode,
//! template and schema from the calling agent's `MemorySlot.working_memory`. The
//! model supplies only the new content or merge patch, so it can never address
//! another user's or another thread's scratchpad.

use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

use super::{RegistryTool, ToolPrincipal};
use crate::agents::AgentStore;
use crate::server::memory::MemoryStore;
use crate::server::memory_working::{self, UPDATE_TOOL_NAME};

/// Reserved registry server for the working-memory tool. Not `memory`: that
/// name belongs to the capability facade.
pub const SERVER_NAME: &str = "working_memory";

/// The working-memory tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![RegistryTool {
        id: format!("{SERVER_NAME}.{UPDATE_TOOL_NAME}"),
        server: SERVER_NAME.to_owned(),
        name: UPDATE_TOOL_NAME.to_owned(),
        description: Some(
            "Update your working memory (the <working_memory> block in your context). \
             Template mode: pass `content`, the COMPLETE updated Markdown; it replaces the \
             document. Schema mode: pass `data`, a JSON merge patch with only the changed \
             fields (`null` removes a field). Only available when your context contains a \
             <working_memory> block."
                .to_owned(),
        ),
        input_schema: Some(json!({
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "Template mode: the complete updated Markdown document."
                },
                "data": {
                    "type": "object",
                    "description": "Schema mode: a JSON merge patch applied to the stored object."
                }
            }
        })),
        annotations: Some(json!({
            "readOnlyHint": false,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false
        })),
        ..Default::default()
    }]
}

/// The memory owner for a resolved principal, or an error when it is unresolved
/// (an org-bound node with no verified owner: fail closed).
pub(crate) fn owner_for(principal: &ToolPrincipal) -> Result<String> {
    match principal {
        ToolPrincipal::Unrestricted => Ok(ryu_memory::LOCAL_USER.to_owned()),
        ToolPrincipal::Owned { user_id, .. } => Ok(user_id.clone()),
        ToolPrincipal::Unresolved => {
            bail!("working memory requires a verified caller on an organization node")
        }
    }
}

/// Dispatch one working-memory tool call.
pub async fn dispatch(
    tool: &str,
    arguments: Value,
    memory: Option<&MemoryStore>,
    agent_store: Option<&AgentStore>,
    principal: &ToolPrincipal,
    agent_id: Option<&str>,
    host_conversation_id: Option<&str>,
) -> Result<Value> {
    if tool != UPDATE_TOOL_NAME {
        bail!("unknown working memory tool '{tool}'");
    }
    let memory = memory.ok_or_else(|| anyhow!("working memory is unavailable"))?;
    let agent_store = agent_store.ok_or_else(|| anyhow!("working memory is unavailable"))?;
    let config = memory_working::agent_config(agent_store, agent_id)
        .await
        .ok_or_else(|| anyhow!("working memory is not enabled for this agent"))?;
    let owner = owner_for(principal)?;
    memory_working::apply_agent_update(memory, &config, host_conversation_id, &owner, &arguments)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_is_listed_under_its_reserved_server() {
        let listed = tools();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "working_memory.update_working_memory");
        assert_eq!(listed[0].server, SERVER_NAME);
        assert_ne!(SERVER_NAME, "memory");
    }

    #[test]
    fn owner_is_server_derived_and_fails_closed() {
        assert_eq!(
            owner_for(&ToolPrincipal::Unrestricted).unwrap(),
            ryu_memory::LOCAL_USER
        );
        assert_eq!(
            owner_for(&ToolPrincipal::Owned {
                user_id: "alice".into(),
                org_id: Some("org".into()),
            })
            .unwrap(),
            "alice"
        );
        assert!(owner_for(&ToolPrincipal::Unresolved).is_err());
    }

    #[tokio::test]
    async fn dispatch_requires_an_enabled_agent() {
        let memory = MemoryStore::open_in_memory().unwrap();
        let unknown = dispatch(
            "nope",
            json!({}),
            Some(&memory),
            None,
            &ToolPrincipal::Unrestricted,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(unknown.to_string().contains("unknown"));
        let unwired = dispatch(
            UPDATE_TOOL_NAME,
            json!({ "content": "x" }),
            Some(&memory),
            None,
            &ToolPrincipal::Unrestricted,
            Some("agent"),
            Some("conv"),
        )
        .await
        .unwrap_err();
        assert!(unwired.to_string().contains("unavailable"));
    }
}
