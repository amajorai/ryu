//! Routing a registered tool id to its dispatch arm.

use super::Dispatch;
use crate::sidecar::mcp::*;

impl McpRegistry {
    /// Route a registered `server.tool` id to the arm that owns its server.
    pub(super) async fn dispatch_registered(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let tool_id = call.tool_id;
        if server == "plans" {
            return self.dispatch_plans(call, tool).await;
        }
        if server == crate::self_api::SERVER_NAME {
            return self.dispatch_self_api(call, server, tool).await;
        }
        if server == crate::ext_api::SERVER_NAME {
            return self.dispatch_ext_api(call, server, tool).await;
        }
        let is_native_app_tool = server != APP_TOOL_SERVER
            && !capability_tools::is_server(server)
            && !builtin_servers::is_builtin_server(server)
            && self
                .app_tools
                .lock()
                .map(|tools| tools.iter().any(|t| t.id == tool_id))
                .unwrap_or(false);
        // A plugin that does not own a configured server's namespace never
        // intercepts that server's tool ids (`app_tool_namespace`).
        let is_native_app_tool =
            is_native_app_tool && self.native_app_tool_may_claim(server, tool_id).await;
        if server == APP_TOOL_SERVER || is_native_app_tool {
            return self.dispatch_app_tool(call, server, tool).await;
        }
        if server == cloud::SERVER_NAME {
            return self.dispatch_cloud(call, server, tool).await;
        }
        if server == sandbox::SERVER_NAME {
            return self.dispatch_sandbox(call, server, tool).await;
        }
        if server == notify_tool::SERVER_NAME {
            return self.dispatch_notify_tool(call, server, tool).await;
        }
        if server == device_tool::SERVER_NAME {
            return self.dispatch_device_tool(call, server, tool).await;
        }
        if server == artifact_tool::SERVER_NAME {
            return self.dispatch_artifact_tool(call, server, tool).await;
        }
        if server == spaces_tool::SERVER_NAME {
            return self.dispatch_spaces_tool(call, server, tool).await;
        }
        if server == working_memory_tool::SERVER_NAME {
            return self.dispatch_working_memory_tool(call, server, tool).await;
        }
        if server == ui_tool::SERVER_NAME {
            return self.dispatch_ui_tool(call, server, tool).await;
        }
        if server == consent_tool::SERVER_NAME {
            return self.dispatch_consent_tool(call, server, tool).await;
        }
        if server == tasks_tool::SERVER_NAME {
            return self.dispatch_tasks_tool(call, server, tool).await;
        }
        if server == workspace_tool::SERVER_NAME {
            return self.dispatch_workspace_tool(call, server, tool).await;
        }
        if server == routines_tool::SERVER_NAME {
            return self.dispatch_routines_tool(call, server, tool).await;
        }
        if server == channel_tool::SERVER_NAME {
            return self.dispatch_channel_tool(call, server, tool).await;
        }
        if server == agent_inbox_tool::SERVER_NAME {
            return self.dispatch_agent_inbox_tool(call, server, tool).await;
        }
        if server == search_conversations::SERVER_NAME {
            return self.dispatch_search_conversations(call, server, tool).await;
        }
        if server == crate::agent_control::SERVER_NAME {
            return self.dispatch_agent_control(call, server, tool).await;
        }
        if server == threads::SERVER_NAME {
            return self.dispatch_threads(call, server, tool).await;
        }
        if server == delegate::SERVER_NAME {
            return self.dispatch_delegate(call, server, tool).await;
        }
        if server == orchestrator::SERVER_NAME {
            return self.dispatch_orchestrator(call, server, tool).await;
        }
        if server == skills_tool::SERVER_NAME {
            return self.dispatch_skills_tool(call, server, tool).await;
        }
        if capability_tools::is_server(server) {
            return self.dispatch_capability_facade(call, server, tool).await;
        }
        if server == usage_tool::SERVER_NAME {
            return self.dispatch_usage_tool(call, server, tool).await;
        }
        if server == treg_tool::SERVER_NAME {
            return self.dispatch_treg_tool(call, server, tool).await;
        }
        if server == challenges_tool::SERVER_NAME {
            return self.dispatch_challenges_tool(call, server, tool).await;
        }
        if server == marketplace_tool::SERVER_NAME {
            return self.dispatch_marketplace_tool(call, server, tool).await;
        }
        if server == web_fetch::SERVER_NAME {
            return self.dispatch_web_fetch(call, server, tool).await;
        }
        if server == crate::runnable::self_build::SERVER_NAME {
            return self.dispatch_self_build(call, server, tool).await;
        }
        if server == crate::runnable::agent_builder::SERVER_NAME {
            return self.dispatch_agent_builder(call, server, tool).await;
        }
        if server == crate::runnable::workflow_builder::SERVER_NAME {
            return self.dispatch_workflow_builder(call, server, tool).await;
        }
        if server == crate::runnable::dashboard_builder::SERVER_NAME {
            return self.dispatch_dashboard_builder(call, server, tool).await;
        }
        self.dispatch_external_mcp(call, server, tool).await
    }
}
