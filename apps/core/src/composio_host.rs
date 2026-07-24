//! Core's implementation of the extracted [`ryu_composio::ComposioHost`] seam.
//!
//! The `ryu-composio` crate owns the whole composio surface — key resolution,
//! catalog/connect HTTP, the trigger-subscription store, poll, HMAC webhook
//! verification, and action execution. What it cannot own — because they are the
//! orchestration kernel that stays in Core — are the two run fan-outs a matched
//! trigger fires: seeding + starting a *workflow* run (`crate::workflow`), and
//! dispatching an *agent* run (`crate::sidecar::agent_runner`). This shim holds
//! exactly those two functions plus the [`ryu_composio::ComposioHost`] adapter
//! that lets the crate's trigger store reach them; Core installs it once at boot
//! via [`ryu_composio::set_global_host`].
//!
//! Placement (CLAUDE.md §1): "what runs" (start a workflow / an agent) is Core.
//! No composio *decision* lives here — this is pure workflow/agent-engine glue,
//! which is why it is kernel, not the extracted capability.
//!
//! Precedent: `apps/core/src/webhook_ingress_host.rs` (`CoreWebhookIngressHost`).

use std::sync::Arc;

use anyhow::{anyhow, Result};
use async_trait::async_trait;

use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};

/// Run a persisted workflow in response to a trigger, seeding the run's `state`
/// with the raw event payload under the reserved `trigger` key (readable in node
/// templates as `{{trigger.<field>}}`). Returns the run id.
///
/// Implementation note: this seeds state by pre-saving a fresh `WorkflowRun`
/// with `state["trigger"]` set, then calling `run_workflow` with that same
/// `run_id`. It relies on `run_workflow_inner` loading the existing run when the
/// workflow id matches and never clearing `run.state` — keep that path intact.
pub async fn run_workflow_for_trigger(workflow_id: &str, payload_json: &str) -> Result<String> {
    let workflow = crate::workflow::store::load_workflow(workflow_id)
        .map_err(|e| anyhow!("workflow '{workflow_id}' not found: {e}"))?;
    let run_id = format!("trigrun_{}", uuid::Uuid::new_v4().simple());

    // Seed the trigger payload into the run state before executing.
    let mut run = crate::workflow::store::WorkflowRun::new(
        run_id.clone(),
        workflow.id.clone(),
        Default::default(),
    );
    run.state
        .insert("trigger".to_string(), payload_json.to_string());
    crate::workflow::store::save_run(&run)
        .map_err(|e| anyhow!("seeding trigger run state: {e}"))?;

    crate::workflow::executor::run_workflow(&workflow, Default::default(), run_id.clone())
        .await
        .map_err(|e| anyhow!(e))?;
    Ok(run_id)
}

/// Run a single agent prompt for a fired trigger. Returns the run id.
///
/// Routes through the global agent runner so the *configured* agent handles the
/// event via the real chat path (its engine binding, gateway routing, tools,
/// persona) — fixing the prior bug where the ephemeral Prompt-node workflow
/// ignored `agent_id`. Falls back to that ephemeral workflow when no runner is
/// published (headless/tests); that path now also routes the agent correctly.
pub async fn run_agent(agent_id: &str, prompt: &str) -> Result<String> {
    let run_id = format!("agentrun_{}", uuid::Uuid::new_v4().simple());
    if let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() {
        runner
            .run(
                Some(agent_id.to_string()),
                run_id.clone(),
                prompt.to_string(),
            )
            .await
            .map_err(|e| anyhow!(e))?;
        return Ok(run_id);
    }

    let workflow = Workflow {
        id: format!("ephemeral_{}", uuid::Uuid::new_v4().simple()),
        name: "composio trigger run".to_string(),
        description: None,
        nodes: vec![WorkflowNode {
            id: "prompt".to_string(),
            retry: None,
            timeout_ms: None,
            kind: NodeKind::Prompt {
                prompt: prompt.to_string(),
                agent_id: Some(agent_id.to_string()),
            },
        }],
        edges: Vec::<WorkflowEdge>::new(),
        triggers: Vec::new(),
        created_at: None,
        updated_at: None,
    };
    crate::workflow::executor::run_workflow(&workflow, Default::default(), run_id.clone())
        .await
        .map_err(|e| anyhow!(e))?;
    Ok(run_id)
}

/// Core's `ComposioHost` — the kernel side of the composio trigger fan-out seam.
pub struct CoreComposioHost;

#[async_trait]
impl ryu_composio::ComposioHost for CoreComposioHost {
    async fn run_workflow_for_trigger(
        &self,
        workflow_id: &str,
        payload_json: &str,
    ) -> Result<String> {
        run_workflow_for_trigger(workflow_id, payload_json).await
    }

    async fn run_agent(&self, agent_id: &str, prompt: &str) -> Result<String> {
        run_agent(agent_id, prompt).await
    }
}

/// Install Core's host implementation. Called once at boot.
pub fn install() {
    ryu_composio::set_global_host(Arc::new(CoreComposioHost));
}
