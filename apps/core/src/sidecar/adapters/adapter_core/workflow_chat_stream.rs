use super::*;

/// Run a workflow as a chat turn: the user's message becomes the workflow's
/// initial input, per-node progress streams back as `data-ryu-workflow` parts,
/// and the run's output is delivered as the assistant reply.
///
/// The chat-input rule is enforced by the caller (`chat_stream` in
/// `crate::server`): only workflows for which
/// [`crate::workflow::accepts_chat_input`] holds are routed here, so a message
/// can never be silently swallowed by a workflow with no entry `Input` node.
/// This is the workflow analog of [`route_team_chat_stream`] — it persists the
/// user turn once, decides *what runs* (Core), and streams the outcome into the
/// same conversation.
///
/// # Streaming model
///
/// The executor runs the whole DAG in one `await` (persisting per-node state to
/// the file-backed run store after every node), so progress is observed by
/// POLLING [`crate::workflow::store::load_run`] while the run executes in a
/// spawned task — no executor changes needed. A `data-ryu-workflow` part is
/// re-emitted on every observed status change, sharing a stable `id`
/// (`"workflow-run"`), so the AI SDK client reconciles it in place: the desktop
/// shows ONE live checklist that updates as steps complete, not a stack of
/// snapshots. An `AwaitingInput` (Awakeable) gate ends the stream with the
/// gate's prompt as the reply text; the run is resumable from the existing
/// `/workflows/runs/:run_id/resume` endpoint.
#[allow(clippy::too_many_lines)]
pub async fn route_workflow_chat_stream(
    mut req: ChatStreamRequest,
    workflow: crate::workflow::Workflow,
    conversations: ConversationStore,
) -> Response {
    if let Err(error) = capture_acp_conversation_generation(&mut req, &conversations).await {
        return error_stream(error);
    }

    use crate::workflow::store::{load_run, RunStatus};

    let user_text = last_user_message(&req.messages);
    let user_message = req
        .messages
        .iter()
        .rev()
        .find(|message| message.role == "user");
    let user_parts = user_message.and_then(UiMessage::render_parts);
    let widget_provenance =
        req.widget_provenance
            .as_ref()
            .map(|p| crate::server::conversations::MessageProvenance {
                source: p.source.to_owned(),
                widget_instance_id: p.widget_instance_id.clone(),
                origin_server: p.origin_server.clone(),
            });

    // Persist the user turn once, exactly like the team path, so the thread
    // keeps the input that drove the run even if the connection drops mid-run.
    if req.persist {
        if let Some(ref conv_id) = req.conversation_id {
            if !user_text.is_empty() || user_parts.is_some() {
                if let Err(e) = conversations
                    .append_message_as_with_render_data(
                        conv_id,
                        "user",
                        &user_text,
                        None,
                        req.author_user_id.as_deref(),
                        req.author_name.as_deref(),
                        Tenancy::Unattributed,
                        widget_provenance.as_ref(),
                        req.client_id.as_deref(),
                        user_parts.as_ref(),
                        user_message.and_then(|message| message.metadata.as_ref()),
                    )
                    .await
                {
                    tracing::warn!("failed to persist workflow-chat user message: {e:#}");
                }
            }
        }
    }

    // Fire the run in the background; the stream below polls its persisted state.
    // The oneshot carries the executor's verdict so a refusal to run (invalid
    // graph, nesting depth — no record is ever written to the store) is
    // reported instead of polling forever.
    let run_id = format!("run_{}", uuid::Uuid::new_v4().simple());
    let mut input = std::collections::HashMap::new();
    input.insert("input".to_string(), user_text.clone());
    let (outcome_tx, mut outcome_rx) = tokio::sync::oneshot::channel();
    let wf = workflow.clone();
    let spawn_run_id = run_id.clone();
    // The run's prompt steps are sub-turns of this turn: carry its attribution.
    let attribution = crate::profile_activity::current_attribution();
    tokio::spawn(crate::profile_activity::with_attribution(
        attribution,
        async move {
            let result = crate::workflow::executor::run_workflow(&wf, input, spawn_run_id).await;
            let _ = outcome_tx.send(result);
        },
    ));

    // Node kind labels keyed by node id, so the progress part can show what
    // each step IS (agent / prompt / tool / …), not just its opaque id.
    let kind_by_id: std::collections::HashMap<String, String> = workflow
        .nodes
        .iter()
        .filter_map(|n| {
            serde_json::to_value(&n.kind).ok().and_then(|v| {
                v.get("type")
                    .and_then(|t| t.as_str())
                    .map(|s| (n.id.clone(), s.to_string()))
            })
        })
        .collect();

    let workflow_id = workflow.id.clone();
    let workflow_name = workflow.name.clone();
    let conversation_id = req.conversation_id.clone();
    let persist = req.persist;

    let stream = async_stream::stream! {
        yield Ok::<_, std::convert::Infallible>(ui_start());

        let mut last_nodes: std::collections::HashMap<String, u8> = std::collections::HashMap::new();
        let mut terminal = false;
        let mut reply_text = String::new();
        // Set once the spawned task's outcome has been received via the oneshot,
        // so the `is_closed` fallback below can't misread a consumed channel.
        let mut outcome_received = false;

        while !terminal {
            let run = load_run(&run_id).ok();
            if let Some(run) = run {
                // Emit a fresh progress part only when the node statuses moved.
                let changed = run.nodes.len() != last_nodes.len()
                    || run.nodes.iter().any(|(id, s)| {
                        last_nodes
                            .get(id)
                            .map(|p| *p != node_status_code(s.status))
                            .unwrap_or(true)
                    });
                if changed {
                    let nodes: Vec<Value> = run
                        .nodes
                        .iter()
                        .map(|(id, s)| {
                            serde_json::json!({
                                "id": id,
                                "kind": kind_by_id.get(id),
                                "status": node_status_str(s.status),
                                "output": s.output,
                                "error": s.error,
                            })
                        })
                        .collect();
                    last_nodes = run
                        .nodes
                        .iter()
                        .map(|(id, s)| (id.clone(), node_status_code(s.status)))
                        .collect();
                    let frame = serde_json::json!({
                        "id": "workflow-run",
                        "workflowId": workflow_id,
                        "workflowName": workflow_name,
                        "runId": run_id,
                        "status": run_status_str(run.status),
                        "nodes": nodes,
                    });
                    yield Ok(ui_data("ryu-workflow", &frame));
                }

                match run.status {
                    RunStatus::Completed => {
                        reply_text = workflow_output_text(&run);
                        terminal = true;
                    }
                    RunStatus::Failed => {
                        let detail = run.error.clone().unwrap_or_else(|| "unknown error".into());
                        reply_text = format!("_Workflow failed: {detail}_");
                        terminal = true;
                    }
                    RunStatus::AwaitingInput => {
                        let prompt = run
                            .awaiting_node
                            .as_deref()
                            .and_then(|id| workflow_awaiting_prompt(&workflow, id));
                        reply_text = match prompt {
                            Some(p) if !p.trim().is_empty() => {
                                format!("**Workflow paused — waiting for input.**\n\n{p}")
                            }
                            _ => "**Workflow paused — waiting for input.**".to_string(),
                        };
                        terminal = true;
                    }
                    RunStatus::Waiting => {
                        let resume_at = run.resume_at.as_deref().unwrap_or("soon");
                        reply_text = format!(
                            "**Workflow paused — a provider limit was reached.** \
                             It resumes on its own at {resume_at}."
                        );
                        terminal = true;
                    }
                    RunStatus::Running => {}
                }
            } else {
                // No run record on disk yet. The executor either is still
                // creating it (first poll) or refused to run at all (invalid
                // graph / nesting depth — no record is ever written). The
                // oneshot reports the latter; otherwise keep polling.
                match outcome_rx.try_recv() {
                    Ok(Err(e)) => {
                        reply_text = format!("_Workflow failed to start: {e}_");
                        terminal = true;
                    }
                    Ok(Ok(_)) => {
                        // The run finished between polls; its final record is
                        // written before the oneshot delivers, so the next
                        // iteration's `load_run` finds it.
                        outcome_received = true;
                    }
                    Err(tokio::sync::oneshot::error::TryRecvError::Closed)
                        if !outcome_received =>
                    {
                        reply_text = "_Workflow failed to start — the executor task terminated unexpectedly._".to_string();
                        terminal = true;
                    }
                    Err(_) => {}
                }
            }

            if !terminal {
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            }
        }

        for frame in synthetic_assistant_frames(&reply_text) {
            yield Ok(frame);
        }
        yield Ok(ui_finish());
        yield Ok(done_sse_frame());

        // Persist the assistant reply once the stream has been produced, so a
        // reload of the conversation re-renders the workflow's answer.
        if persist {
            if let Some(conv_id) = conversation_id {
                if !reply_text.trim().is_empty() {
                    if let Err(e) = conversations
                        .append_message_as(
                            &conv_id,
                            "assistant",
                            &reply_text,
                            None,
                            None,
                            None,
                            Tenancy::Unattributed,
                        )
                        .await
                    {
                        tracing::warn!("failed to persist workflow-chat assistant message: {e:#}");
                    }
                }
            }
        }
    };

    sse_response(Body::from_stream(stream))
}

/// The node status as the compact wire string the desktop renders.
fn node_status_str(s: crate::workflow::store::NodeStatus) -> &'static str {
    use crate::workflow::store::NodeStatus;
    match s {
        NodeStatus::Pending => "pending",
        NodeStatus::Running => "running",
        NodeStatus::Completed => "completed",
        NodeStatus::Failed => "failed",
        NodeStatus::Skipped => "skipped",
    }
}

/// A small integer code for diffing node statuses (comparable, no string churn).
fn node_status_code(s: crate::workflow::store::NodeStatus) -> u8 {
    use crate::workflow::store::NodeStatus;
    match s {
        NodeStatus::Pending => 0,
        NodeStatus::Running => 1,
        NodeStatus::Completed => 2,
        NodeStatus::Failed => 3,
        NodeStatus::Skipped => 4,
    }
}

/// The run status as the wire string the desktop renders.
fn run_status_str(s: crate::workflow::store::RunStatus) -> &'static str {
    use crate::workflow::store::RunStatus;
    match s {
        RunStatus::Running => "running",
        RunStatus::Completed => "completed",
        RunStatus::Failed => "failed",
        RunStatus::AwaitingInput => "awaiting_input",
        RunStatus::Waiting => "waiting",
    }
}

/// The value an `Awakeable` gate is waiting on, for the reply text. Mirrors
/// what the resume endpoint surfaces via the run's `awaiting_node`.
fn workflow_awaiting_prompt(
    workflow: &crate::workflow::Workflow,
    awaiting_node: &str,
) -> Option<String> {
    use crate::workflow::NodeKind;
    workflow.nodes.iter().find_map(|n| {
        if n.id == awaiting_node {
            if let NodeKind::Awakeable { prompt } = &n.kind {
                return prompt.clone();
            }
        }
        None
    })
}

/// The run's output rendered as the assistant reply: the single output value
/// verbatim, a JSON block for a multi-key output map, or a quiet note when the
/// workflow produced no output at all.
fn workflow_output_text(run: &crate::workflow::store::WorkflowRun) -> String {
    if run.output.is_empty() {
        return "_(Workflow completed with no output.)_".to_string();
    }
    if run.output.len() == 1 {
        return run.output.values().next().cloned().unwrap_or_default();
    }
    serde_json::to_string_pretty(&run.output).unwrap_or_default()
}
