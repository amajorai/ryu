//! Builder meta-agent arms.
// test-exempt: moved verbatim out of sidecar/mcp/mod.rs; covered by the McpRegistry tests under sidecar/mcp/tests/.

use super::Dispatch;
use crate::sidecar::mcp::*;

impl McpRegistry {
    // Built-in self-build provider (U57): scaffold_runnable, install_app,
    // write_ryu_json. Dispatched in-process; requires `self_build_manifests`
    // and `self_build_app_store` to be wired via `with_self_build`.
    pub(super) async fn dispatch_self_build(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
            tool_id,
            arguments,
            allowlist,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        let manifests = self.self_build_manifests.clone().ok_or_else(|| {
            anyhow!(
                "self-build tool '{tool_id}' called but self_build context is not wired; \
                 call McpRegistry::with_self_build at startup"
            )
        })?;
        let app_store = self.self_build_app_store.clone().ok_or_else(|| {
            anyhow!("self-build tool '{tool_id}' called but self_build app_store is not wired")
        })?;
        crate::runnable::self_build::dispatch(tool, arguments, manifests, app_store).await
    }

    // Built-in agent-builder provider: get_agent, configure_agent,
    // create_agent. Lets the builder meta-agent edit an agent record in
    // chat. Requires `agent_store` wired via `with_agent_store` at startup.
    pub(super) async fn dispatch_agent_builder(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
            tool_id,
            arguments,
            allowlist,
            account_policy,
            ..
        } = call;
        if tool == "configure_agent" {
            // Recheck on the actual backend, including aliases and approved
            // replay after the node's tenancy changed.
            require_agent_configuration_node()?;
        }
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        let store = self.agent_store.clone().ok_or_else(|| {
            anyhow!(
                "agent_builder tool '{tool_id}' called but agent_store is not wired; \
                 call McpRegistry::with_agent_store at startup"
            )
        })?;
        crate::runnable::agent_builder::dispatch(
            tool,
            arguments,
            store,
            self.capabilities.clone(),
            account_policy.as_ref(),
        )
        .await
    }

    // Built-in workflow-builder provider: get_workflow, create_workflow,
    // configure_workflow. Lets the builder meta-agent author a workflow
    // definition in chat. Backed by the global file-backed workflow store, so
    // no handle needs wiring (unlike agent_builder).
    pub(super) async fn dispatch_workflow_builder(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
            tool_id,
            arguments,
            allowlist,
            account_policy,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        // A workflow runs with the user's accounts, so a limited agent may
        // read one but not create or change one (as with the Self-API).
        if tool != "get_workflow" {
            require_unrestricted_for_builder(account_policy.as_ref(), "workflows")?;
        }
        crate::runnable::workflow_builder::dispatch(tool, arguments).await
    }

    // Built-in dashboard-builder provider: get_dashboard, create_dashboard,
    // configure_dashboard. Lets the builder meta-agent author a Home
    // dashboard's widget grid in chat, through the `dashboards.*` capabilities
    // on the wired capability consumer (see `with_capabilities`).
    pub(super) async fn dispatch_dashboard_builder(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
            tool_id,
            arguments,
            allowlist,
            account_policy,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        // Dashboard widgets run with the user's accounts, so a limited agent
        // may read one (without its cached widget output) but not create or
        // change one.
        if tool != "get_dashboard" {
            require_unrestricted_for_builder(account_policy.as_ref(), "dashboards")?;
        }
        let mut result = crate::runnable::dashboard_builder::dispatch(
            tool,
            arguments,
            self.capabilities.clone(),
        )
        .await?;
        // A widget's cached output was fetched with the user's accounts, which
        // a limited agent may not use, so only its definition is readable.
        if account_policy
            .as_ref()
            .is_some_and(|policy| !policy.is_unrestricted())
        {
            crate::runnable::dashboard_builder::strip_cached_widget_output(&mut result);
        }
        Ok(result)
    }
}
