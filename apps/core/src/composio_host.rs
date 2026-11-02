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

mod suggestion;

use suggestion::{
    build_connect_suggestion_prompt, connect_suggestion_payload, parse_connect_suggestion,
};

async fn publish_connect_suggestion(owner: &str, run_id: &str, output: Option<&str>) -> Result<()> {
    let Some(suggestion) = output.and_then(parse_connect_suggestion) else {
        return Ok(());
    };
    let store =
        crate::notify::global_store().ok_or_else(|| anyhow!("notification store unavailable"))?;
    let notification_id = format!(
        "ntf_connect_{}",
        ryu_crypto::hmac_sha256_hex(b"ryu-connect-suggestion-id-v1", run_id.as_bytes())
    );
    crate::notify::deliver_connect_suggestion(
        &store,
        &notification_id,
        owner,
        &suggestion.title,
        &suggestion.body,
    )
    .await
    .map_err(|error| anyhow!(error))?;
    Ok(())
}

fn streaming_privacy_output() -> String {
    serde_json::json!({
        "suggest": true,
        "title": crate::notify::CONNECT_SUGGESTION_PRIVACY_TITLE,
        "body": crate::notify::CONNECT_SUGGESTION_PRIVACY_BODY
    })
    .to_string()
}

fn save_streaming_privacy_checkpoint(
    run_id: &str,
    target_id: &str,
    payload_json: &str,
) -> Result<()> {
    use crate::workflow::store::{self, NodeRunState, NodeStatus, RunStatus, WorkflowRun};

    let payload_hash =
        ryu_crypto::hmac_sha256_hex(b"ryu-connect-payload-v1", payload_json.as_bytes());
    let workflow_hash = ryu_crypto::hmac_sha256_hex(
        b"ryu-connect-workflow-v1",
        b"streaming-privacy-suggestion-v1",
    );
    let input = [
        ("__ryu_connect_payload_hash".to_owned(), payload_hash),
        ("__ryu_connect_workflow_hash".to_owned(), workflow_hash),
    ]
    .into();
    let mut run = WorkflowRun::new(
        run_id.to_owned(),
        format!("connect_target_{target_id}"),
        input,
    );
    run.status = RunStatus::Completed;
    run.state.insert(
        "__ryu_connect_streaming_privacy".to_owned(),
        "true".to_owned(),
    );
    run.nodes.insert(
        "prompt".to_owned(),
        NodeRunState {
            status: NodeStatus::Completed,
            output: Some(streaming_privacy_output()),
            error: None,
            attempts: 0,
            wake_at: None,
        },
    );
    store::save_run(&run).map_err(|error| anyhow!("saving Streaming privacy checkpoint: {error}"))
}

async fn publish_connect_suggestion_for_event(
    owner: &str,
    run_id: &str,
    target_id: &str,
    payload_json: &str,
    output: Option<&str>,
) -> Result<()> {
    if crate::presence::streaming_privacy_active() {
        if let Err(error) = save_streaming_privacy_checkpoint(run_id, target_id, payload_json) {
            // Do not retry this delivery after Streaming ends with its event data
            // exposed. Privacy takes priority over a suggestion when the durable
            // marker cannot be written.
            tracing::warn!("Connect suggestion hidden because its Streaming privacy checkpoint failed: {error}");
            return Ok(());
        }
        let private_output = streaming_privacy_output();
        return publish_connect_suggestion(owner, run_id, Some(&private_output)).await;
    }
    publish_connect_suggestion(owner, run_id, output).await
}

/// Run a persisted workflow in response to a trigger, seeding the run's `state`
/// with the raw event payload under the reserved `trigger` key (readable in node
/// templates as `{{trigger.<field>}}`). Returns the run id.
///
/// Implementation note: this seeds state by pre-saving a fresh `WorkflowRun`
/// with `state["trigger"]` set, then calling `run_workflow` with that same
/// `run_id`. It relies on `run_workflow_inner` loading the existing run when the
/// workflow id matches and never clearing `run.state` — keep that path intact.
pub async fn run_workflow_for_trigger(workflow_id: &str, payload_json: &str) -> Result<String> {
    let (workflow, run_id) = seed_trigger_run(workflow_id, payload_json)?;
    crate::workflow::executor::run_workflow(&workflow, Default::default(), run_id.clone())
        .await
        .map_err(|e| anyhow!(e))?;
    Ok(run_id)
}

/// Seed a webhook-triggered run and execute it in the background, returning its
/// run id as soon as the run exists.
///
/// The webhook ingress keeps a durable delivery reservation for every run this
/// returns, and releases it only on `Err` (no run was created). Awaiting the
/// whole run here would either release that reservation after side-effecting
/// nodes already ran (so a sender retry re-runs them) or hold the sender past
/// its timeout. The executor records the run's failure on the run itself.
pub fn start_workflow_for_trigger(workflow_id: &str, payload_json: &str) -> Result<String> {
    let (workflow, run_id) = seed_trigger_run(workflow_id, payload_json)?;
    let background_run_id = run_id.clone();
    tokio::spawn(async move {
        if let Err(error) = crate::workflow::executor::run_workflow(
            &workflow,
            Default::default(),
            background_run_id.clone(),
        )
        .await
        {
            tracing::warn!(
                workflow = %workflow.id,
                run = %background_run_id,
                "webhook-triggered workflow run failed: {error}"
            );
        }
    });
    Ok(run_id)
}

/// Load `workflow_id` and persist a fresh `trigrun_` run whose `state["trigger"]`
/// holds the raw event payload.
fn seed_trigger_run(
    workflow_id: &str,
    payload_json: &str,
) -> Result<(crate::workflow::Workflow, String)> {
    let workflow = crate::workflow::store::load_workflow(workflow_id)
        .map_err(|e| anyhow!("workflow '{workflow_id}' not found: {e}"))?;
    let run_id = format!("trigrun_{}", uuid::Uuid::new_v4().simple());
    let mut run = crate::workflow::store::WorkflowRun::new(
        run_id.clone(),
        workflow.id.clone(),
        Default::default(),
    );
    run.state
        .insert("trigger".to_string(), payload_json.to_string());
    crate::workflow::store::save_run(&run)
        .map_err(|e| anyhow!("seeding trigger run state: {e}"))?;
    Ok((workflow, run_id))
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
            repeat: None,
            kind: NodeKind::Prompt {
                prompt: prompt.to_string(),
                agent_id: Some(agent_id.to_string()),
            },
        }],
        edges: Vec::<WorkflowEdge>::new(),
        triggers: Vec::new(),
        max_concurrency: None,
        created_at: None,
        updated_at: None,
    };
    crate::workflow::executor::run_workflow(&workflow, Default::default(), run_id.clone())
        .await
        .map_err(|e| anyhow!(e))?;
    Ok(run_id)
}

fn connect_run_lock(id: &str) -> Result<Arc<tokio::sync::Mutex<()>>> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock, Weak};
    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| anyhow!("Connect execution lock unavailable"))?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(id).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(id.to_owned(), Arc::downgrade(&lock));
    Ok(lock)
}

/// The caller must authorize the target for this Core user before calling.
/// Connect owns provider delivery; this function owns only resumable Core work.
/// An AwaitingInput checkpoint is a durable handoff to the existing approval UI,
/// not permission to bypass that approval by replaying the inbox event.
pub async fn run_connect_target(
    owner: &str,
    delivery_id: &str,
    target: &ryu_composio::triggers::TriggerSubscription,
    payload: &serde_json::Value,
) -> Result<String> {
    use crate::workflow::store::{self, RunStatus, WorkflowRun};
    let run_id = ryu_composio::consumer::execution_id(owner, delivery_id, &target.id)?;
    let lock = connect_run_lock(&run_id)?;
    let _guard = lock.lock().await;
    let payload_json = serde_json::to_string(payload)?;
    let suggestion_target = target.target_kind == "agent";
    if suggestion_target {
        if target.agent_id.is_empty() {
            return Err(anyhow!("Invalid Connect agent target"));
        }
    }
    let agent_payload_json = if suggestion_target {
        match connect_suggestion_payload(payload, crate::presence::streaming_privacy_active())? {
            Some(payload) => payload,
            None => {
                publish_connect_suggestion_for_event(
                    owner,
                    &run_id,
                    &target.id,
                    &payload_json,
                    None,
                )
                .await?;
                return Ok(run_id);
            }
        }
    } else {
        payload_json.clone()
    };
    let agent_guidance = if suggestion_target {
        match crate::sidecar::agent_runner::global_agent_runner() {
            Some(runner) => runner.suggestion_guidance(&target.agent_id).await?,
            None => None,
        }
    } else {
        None
    };
    // The suggestion is read in the node's UI language (decided when the run
    // is built; a later language change applies to the next event).
    let suggestion_locale = if suggestion_target {
        crate::i18n::locale::node_locale().await
    } else {
        "en"
    };
    let workflow = match target.target_kind.as_str() {
        "workflow" => store::load_workflow(
            target
                .workflow_id
                .as_deref()
                .ok_or_else(|| anyhow!("Missing Connect workflow target"))?,
        )?,
        "agent" if !target.agent_id.is_empty() => Workflow {
            id: format!("connect_target_{}", target.id),
            name: "Connect trigger".to_owned(),
            description: None,
            nodes: vec![WorkflowNode {
                id: "prompt".to_owned(),
                retry: None,
                timeout_ms: None,
                repeat: None,
                kind: NodeKind::Prompt {
                    // Passing no agent id keeps this analysis on Core's default
                    // model route; selected-agent ACP runtimes and tools never run.
                    agent_id: None,
                    prompt: build_connect_suggestion_prompt(
                        agent_guidance.as_deref(),
                        &agent_payload_json,
                        suggestion_locale,
                    ),
                },
            }],
            edges: vec![],
            triggers: vec![],
            max_concurrency: None,
            created_at: None,
            updated_at: None,
        },
        _ => return Err(anyhow!("Invalid Connect target kind")),
    };
    if suggestion_target && crate::presence::streaming_privacy_active() {
        publish_connect_suggestion_for_event(owner, &run_id, &target.id, &payload_json, None)
            .await?;
        return Ok(run_id);
    }
    let payload_hash =
        ryu_crypto::hmac_sha256_hex(b"ryu-connect-payload-v1", payload_json.as_bytes());
    let workflow_hash =
        ryu_crypto::hmac_sha256_hex(b"ryu-connect-workflow-v1", &serde_json::to_vec(&workflow)?);
    match store::load_run(&run_id) {
        Ok(existing) => {
            if existing.workflow_id != workflow.id
                || existing.input.get("__ryu_connect_payload_hash") != Some(&payload_hash)
            {
                return Err(anyhow!("Connect delivery checkpoint identity mismatch"));
            }
            match existing.status {
                RunStatus::Completed => {
                    if suggestion_target {
                        publish_connect_suggestion_for_event(
                            owner,
                            &run_id,
                            &target.id,
                            &payload_json,
                            existing
                                .nodes
                                .get("prompt")
                                .and_then(|node| node.output.as_deref()),
                        )
                        .await?;
                    }
                    return Ok(run_id);
                }
                // A run parked on a provider limit wakes itself (see
                // `workflow::auto_resume`); redelivery must not run it twice.
                RunStatus::AwaitingInput | RunStatus::Waiting => return Ok(run_id),
                RunStatus::Failed => {
                    return Err(anyhow!(
                        "Connect delivery run failed; use workflow recovery controls"
                    ))
                }
                RunStatus::Running => {}
            }
            if existing.input.get("__ryu_connect_workflow_hash") != Some(&workflow_hash) {
                return Err(anyhow!(
                    "Connect workflow changed since its checkpoint; review the run"
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let input = [
                ("__ryu_connect_payload_hash".to_owned(), payload_hash),
                ("__ryu_connect_workflow_hash".to_owned(), workflow_hash),
            ]
            .into();
            let mut run = WorkflowRun::new(run_id.clone(), workflow.id.clone(), input);
            run.state.insert("trigger".to_owned(), agent_payload_json);
            store::save_run(&run)?;
        }
        Err(_) => return Err(anyhow!("Connect delivery checkpoint unavailable")),
    }
    let run =
        crate::workflow::executor::run_workflow(&workflow, Default::default(), run_id.clone())
            .await
            .map_err(|error| anyhow!(error))?;
    match run.status {
        RunStatus::Completed => {
            if suggestion_target {
                publish_connect_suggestion_for_event(
                    owner,
                    &run_id,
                    &target.id,
                    &payload_json,
                    run.nodes
                        .get("prompt")
                        .and_then(|node| node.output.as_deref()),
                )
                .await?;
            }
            Ok(run_id)
        }
        RunStatus::AwaitingInput => Ok(run_id),
        _ => Err(anyhow!(
            "Connect delivery did not reach a durable completion or approval checkpoint"
        )),
    }
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

    async fn agent_may_receive(
        &self,
        agent_id: &str,
        connected_account_id: &str,
        account_entity: &str,
    ) -> Result<bool> {
        let Some(store) = crate::agents::global() else {
            return Ok(account_entity.is_empty());
        };
        let record = store.get(agent_id).await?;
        Ok(agent_may_receive_from(
            record.as_ref(),
            agent_id,
            connected_account_id,
            account_entity,
        ))
    }
}

/// The delivery-time account check. A user account (`account_entity` empty)
/// needs the agent's policy to allow it; an agent without a record keeps
/// today's behaviour. An own-entity account must be exactly this agent's
/// entity, and its record must exist and allow that account's events.
fn agent_may_receive_from(
    record: Option<&crate::agents::AgentRecord>,
    agent_id: &str,
    connected_account_id: &str,
    account_entity: &str,
) -> bool {
    use crate::agent_access::AgentAccountPolicy;
    if account_entity.is_empty() {
        return record.is_none_or(|record| {
            AgentAccountPolicy::from_record(record).allows_composio_account(connected_account_id)
        });
    }
    AgentAccountPolicy::is_own_composio_entity(account_entity, agent_id)
        && record.is_some_and(|record| {
            AgentAccountPolicy::from_record(record)
                .allows_own_composio_trigger(connected_account_id)
        })
}

/// Install Core's host implementation. Called once at boot.
pub fn install() {
    ryu_composio::set_global_host(Arc::new(CoreComposioHost));
}

#[cfg(test)]
mod connect_suggestion_tests;
#[cfg(test)]
mod trigger_delivery_tests;
