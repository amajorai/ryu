//! Closed coding tools for a server-bound cloud conversation.
use super::RegistryTool;
use serde_json::{json, Value};

pub const SERVER_NAME: &str = "cloud";
pub fn tools() -> Vec<RegistryTool> {
    [
        ("exec", "Run a shell command in this conversation's isolated cloud workspace.", json!({"type":"object","properties":{"command":{"type":"string","maxLength":65536}},"required":["command"],"additionalProperties":false}), false),
        ("read_file", "Read a text file inside this conversation's cloud working directory.", json!({"type":"object","properties":{"path":{"type":"string","maxLength":4096}},"required":["path"],"additionalProperties":false}), true),
        ("write_file", "Write a text file inside this conversation's cloud working directory.", json!({"type":"object","properties":{"path":{"type":"string","maxLength":4096},"content":{"type":"string","maxLength":65536}},"required":["path","content"],"additionalProperties":false}), false),
        ("list_files", "List files inside this conversation's cloud working directory.", json!({"type":"object","properties":{"path":{"type":"string","maxLength":4096}},"required":["path"],"additionalProperties":false}), true),
    ].into_iter().map(|(name,description,input_schema,read_only)| RegistryTool {
        id: format!("{SERVER_NAME}.{name}"), server: SERVER_NAME.into(), name:name.into(),
        description:Some(description.into()),input_schema:Some(input_schema),
        annotations:Some(json!({"readOnlyHint":read_only,"destructiveHint":!read_only,"openWorldHint":false})),
        ..Default::default()
    }).collect()
}
pub fn is_tool(tool: &str) -> bool {
    matches!(
        tool,
        "cloud.exec" | "cloud.read_file" | "cloud.write_file" | "cloud.list_files"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn schemas_never_accept_workspace_or_policy_selection() {
        for tool in tools() {
            let schema = tool.input_schema.unwrap();
            assert_eq!(schema["additionalProperties"], false);
            for field in ["workspaceId", "environmentId", "owner", "network", "cwd"] {
                assert!(schema["properties"].get(field).is_none());
            }
            assert!(is_tool(&tool.id));
        }
        assert!(!is_tool("cloud.stop"));
        assert!(!is_tool("sandbox.sandbox_exec"));
    }
}
