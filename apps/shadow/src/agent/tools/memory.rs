use anyhow::Result;
use async_trait::async_trait;
use serde_json::json;

use super::super::{AgentTool, Tool, ToolResult};

/// Query semantic memory by category and text.
pub struct GetKnowledgeTool;

#[async_trait]
impl AgentTool for GetKnowledgeTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "get_knowledge".to_string(),
            description: "Query semantic memory for stored facts, preferences, patterns, relationships, or skills".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "enum": ["preference", "fact", "pattern", "relationship", "skill"],
                        "description": "Type of memory to query"
                    },
                    "query": {
                        "type": "string",
                        "description": "Text to search for"
                    }
                },
                "required": ["query"]
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let query = params["query"].as_str().unwrap_or("");
        let category = params["category"].as_str();

        match crate::memory::MEMORY_STORE.get() {
            Some(store) => {
                let entries = store.lock().unwrap().query(category, query)?;
                Ok(ToolResult {
                    tool_name: "get_knowledge".to_string(),
                    result: json!({ "entries": entries }),
                    error: None,
                })
            }
            None => Ok(ToolResult {
                tool_name: "get_knowledge".to_string(),
                result: json!({ "entries": [] }),
                error: Some("Memory store not initialized".to_string()),
            }),
        }
    }
}

/// Create or update a persistent directive (reminder, habit, automation, watch).
pub struct SetDirectiveTool;

#[async_trait]
impl AgentTool for SetDirectiveTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "set_directive".to_string(),
            description: "Create a persistent directive — a reminder, habit, automation rule, or watch condition that Shadow will monitor".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "directive_type": {
                        "type": "string",
                        "enum": ["reminder", "habit", "automation", "watch"]
                    },
                    "content": {
                        "type": "string",
                        "description": "Description of the directive"
                    },
                    "trigger_pattern": {
                        "type": "string",
                        "description": "Optional: context pattern that triggers this directive"
                    },
                    "priority": {
                        "type": "integer",
                        "default": 5,
                        "description": "Priority 1-10"
                    }
                },
                "required": ["directive_type", "content"]
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let directive_type = params["directive_type"].as_str().unwrap_or("reminder");
        let content = params["content"].as_str().unwrap_or("");
        let trigger_pattern = params["trigger_pattern"].as_str().map(|s| s.to_string());
        let priority = params["priority"].as_u64().unwrap_or(5) as u8;

        let directive = crate::memory::Directive {
            id: uuid::Uuid::new_v4().to_string(),
            directive_type: directive_type.to_string(),
            content: content.to_string(),
            trigger_pattern,
            action: None,
            priority,
            expires_at: None,
            created_at: chrono::Utc::now().timestamp() as u64,
        };

        match crate::memory::MEMORY_STORE.get() {
            Some(store) => {
                store.lock().unwrap().create_directive(&directive)?;
                Ok(ToolResult {
                    tool_name: "set_directive".to_string(),
                    result: json!({ "id": directive.id, "created": true }),
                    error: None,
                })
            }
            None => Ok(ToolResult {
                tool_name: "set_directive".to_string(),
                result: json!({ "created": false }),
                error: Some("Memory store not initialized".to_string()),
            }),
        }
    }
}

/// List active directives.
pub struct GetDirectivesTool;

#[async_trait]
impl AgentTool for GetDirectivesTool {
    fn definition(&self) -> Tool {
        Tool {
            name: "get_directives".to_string(),
            description: "List all active directives (reminders, habits, automations, watches)"
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "type_filter": {
                        "type": "string",
                        "enum": ["reminder", "habit", "automation", "watch"],
                        "description": "Optional filter by directive type"
                    }
                }
            }),
        }
    }

    async fn execute(&self, params: serde_json::Value) -> Result<ToolResult> {
        let type_filter = params["type_filter"].as_str();

        match crate::memory::MEMORY_STORE.get() {
            Some(store) => {
                let directives = store.lock().unwrap().list_active(type_filter)?;
                Ok(ToolResult {
                    tool_name: "get_directives".to_string(),
                    result: json!({ "directives": directives }),
                    error: None,
                })
            }
            None => Ok(ToolResult {
                tool_name: "get_directives".to_string(),
                result: json!({ "directives": [] }),
                error: Some("Memory store not initialized".to_string()),
            }),
        }
    }
}
