//! Connected-account access ceilings shared by MCP OAuth and Composio.
//!
//! OAuth scopes and Gateway grants describe what a provider/app can offer. This
//! module describes the owner's additional ceiling for one connected account.
//! It is intentionally conservative when a provider does not publish enough
//! metadata to classify an action: unknown actions are refused even under Full.

use serde_json::Value;

use crate::agent_execution::ToolEffect;
use crate::identity::{ConnectionAccessLevel, ConnectionAction};

pub const COMPOSIO_PROVIDER: &str = "composio";
pub const MCP_PROVIDER: &str = "mcp";

/// Stable key for one manifest-owned MCP OAuth binding.
pub fn mcp_connection_key(profile_id: &str, plugin_id: &str, server_name: &str) -> String {
    format!("{profile_id}:{plugin_id}:{server_name}")
}

/// Stable key for one direct Composio toolkit connection.
pub fn composio_connection_key(toolkit: &str) -> String {
    toolkit.trim().to_ascii_lowercase()
}

/// Convert the existing tool-effect metadata into the smaller action ladder a
/// connected-account ceiling needs. Delete is kept distinct from ordinary
/// writes so `Write access` cannot remove records.
pub fn action_for_tool(
    tool_id: &str,
    annotations: Option<&Value>,
    http_method: Option<&str>,
) -> ConnectionAction {
    if let Some(method) = http_method {
        return match method.trim().to_ascii_uppercase().as_str() {
            "GET" | "HEAD" | "OPTIONS" | "TRACE" => ConnectionAction::Read,
            "DELETE" => ConnectionAction::Delete,
            "POST" | "PUT" | "PATCH" => {
                if has_delete_token(tool_id) {
                    ConnectionAction::Delete
                } else {
                    ConnectionAction::Write
                }
            }
            _ => ConnectionAction::Unknown,
        };
    }

    if annotations
        .and_then(Value::as_object)
        .and_then(|value| value.get("destructiveHint"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return ConnectionAction::Delete;
    }
    if annotations
        .and_then(Value::as_object)
        .and_then(|value| value.get("readOnlyHint"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return ConnectionAction::Read;
    }

    match crate::agent_execution::classify_tool_with_metadata(tool_id, annotations, http_method) {
        ToolEffect::Read | ToolEffect::Preview => ConnectionAction::Read,
        ToolEffect::Mutate | ToolEffect::External => {
            if has_delete_token(tool_id) {
                ConnectionAction::Delete
            } else {
                ConnectionAction::Write
            }
        }
        ToolEffect::Unknown => ConnectionAction::Unknown,
    }
}

/// Resolve the toolkit prefix used by Composio's action slugs, such as
/// `GITHUB_CREATE_ISSUE` or `SLACK_SEND_MESSAGE`. Unknown/malformed ids return
/// `None`; callers then use the safe default policy rather than guessing a
/// different account.
pub fn composio_toolkit_for_action(tool_id: &str) -> Option<String> {
    let slug = tool_id
        .strip_prefix("composio.")
        .or_else(|| tool_id.strip_prefix("composio__"))?
        .trim();
    let toolkit = slug
        .split(|character: char| matches!(character, '_' | '-'))
        .find(|part| !part.is_empty())?;
    Some(toolkit.to_ascii_lowercase())
}

fn has_delete_token(tool_id: &str) -> bool {
    tool_id
        .split(|character: char| !character.is_ascii_alphanumeric())
        .any(|token| {
            matches!(
                token.to_ascii_lowercase().as_str(),
                "delete"
                    | "remove"
                    | "destroy"
                    | "erase"
                    | "purge"
                    | "clear"
                    | "drop"
                    | "revoke"
                    | "uninstall"
            )
        })
}

/// Safe human-readable error used when a selected connection ceiling rejects a
/// provider action. The provider id and action are labels, not credentials.
pub fn denied_message(
    provider: &str,
    connection_key: &str,
    level: ConnectionAccessLevel,
    action: ConnectionAction,
) -> String {
    let level = level.as_str().replace('_', " ");
    let action = match action {
        ConnectionAction::Read => "read",
        ConnectionAction::Write => "write",
        ConnectionAction::Delete => "delete",
        ConnectionAction::Unknown => "unclassified",
    };
    format!(
        "{provider} connection '{connection_key}' is limited to {level} access; {action} actions are blocked"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_classification_separates_reads_writes_and_deletes() {
        assert_eq!(
            action_for_tool("gmail.list_messages", None, Some("GET")),
            ConnectionAction::Read
        );
        assert_eq!(
            action_for_tool("gmail.update_message", None, None),
            ConnectionAction::Write
        );
        assert_eq!(
            action_for_tool("composio.GITHUB_DELETE_ISSUE", None, None),
            ConnectionAction::Delete
        );
        assert_eq!(
            action_for_tool(
                "remote.change",
                Some(&serde_json::json!({ "destructiveHint": true })),
                None,
            ),
            ConnectionAction::Delete
        );
    }

    #[test]
    fn unknown_effects_stay_unknown() {
        assert_eq!(
            action_for_tool("vendor.mystery", None, None),
            ConnectionAction::Unknown
        );
    }

    #[test]
    fn composio_action_prefix_is_the_policy_key() {
        assert_eq!(
            composio_toolkit_for_action("composio.GITHUB_CREATE_ISSUE").as_deref(),
            Some("github")
        );
        assert_eq!(
            composio_toolkit_for_action("composio__SLACK_SEND_MESSAGE").as_deref(),
            Some("slack")
        );
        assert!(composio_toolkit_for_action("github.create_issue").is_none());
    }

    #[test]
    fn access_levels_keep_delete_out_of_write() {
        assert!(ConnectionAccessLevel::RiskBased.allows(ConnectionAction::Read));
        assert!(!ConnectionAccessLevel::RiskBased.allows(ConnectionAction::Write));
        assert!(
            ConnectionAccessLevel::RiskBased.allows_with_approval(ConnectionAction::Write, true)
        );
        assert!(ConnectionAccessLevel::ReadOnly.allows(ConnectionAction::Read));
        assert!(!ConnectionAccessLevel::ReadOnly.allows(ConnectionAction::Write));
        assert!(ConnectionAccessLevel::Write.allows(ConnectionAction::Write));
        assert!(!ConnectionAccessLevel::Write.allows(ConnectionAction::Delete));
        assert!(ConnectionAccessLevel::Full.allows(ConnectionAction::Delete));
        assert!(!ConnectionAccessLevel::Full.allows(ConnectionAction::Unknown));
    }
}
