use super::*;
use crate::sidecar::mcp::McpRegistry;
use agent_client_protocol::schema::v1::{Diff, ToolCallUpdateFields};

#[path = "acp_tests/acp_spawn_environment.rs"]
mod acp_spawn_environment;
#[path = "acp_tests/capabilities_and_gateway_wrapping.rs"]
mod capabilities_and_gateway_wrapping;
#[path = "acp_tests/codex_egress_and_flagship.rs"]
mod codex_egress_and_flagship;
#[path = "acp_tests/config_write_back_and_ordering.rs"]
mod config_write_back_and_ordering;
#[path = "acp_tests/pi_default_and_gateway_opt_out.rs"]
mod pi_default_and_gateway_opt_out;
#[path = "acp_tests/pi_widgets_fs_and_turns.rs"]
mod pi_widgets_fs_and_turns;
#[path = "acp_tests/plan_mode_option.rs"]
mod plan_mode_option;
#[path = "acp_tests/registry_and_wire_mappers.rs"]
mod registry_and_wire_mappers;
#[path = "acp_tests/scoped_gateway_credentials.rs"]
mod scoped_gateway_credentials;
#[path = "acp_tests/spawn_and_failure_copy.rs"]
mod spawn_and_failure_copy;
#[path = "acp_tests/startup_banner_and_usage.rs"]
mod startup_banner_and_usage;
#[path = "acp_tests/tool_bridge_and_widgets.rs"]
mod tool_bridge_and_widgets;

fn pi_acp_cmd_gated() -> String {
    pi_acp_cmd()
}

fn ryu_widget_raw_output(tool: &str, structured: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "content": [{ "type": "text", "text": "done" }],
        "details": {
            "ryuWidget": {
                "tool": tool,
                "arguments": { "title": "Groceries" },
                "output": { "structuredContent": structured, "content": [] },
            }
        }
    })
}

fn ryu_steps_raw_output(answer: &str, steps: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "content": [{ "type": "text", "text": answer }],
        "details": { "mode": "single", "ryuSteps": steps }
    })
}
