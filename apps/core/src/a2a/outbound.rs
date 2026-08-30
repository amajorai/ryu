use std::{
    collections::HashMap,
    convert::Infallible,
    sync::{Mutex, OnceLock},
};

use anyhow::{anyhow, Context, Result};
use axum::{body::Body, response::Response};
use chrono::Utc;
use ryu_a2a::{
    outbound_task_record_id,
    protocol::{
        AgentCard, Artifact, CancelTaskRequest, Message, Part, PartContent, Role,
        SendMessageRequest, SendMessageResponse, StreamResponse, Task, TaskArtifactUpdateEvent,
        TaskState as ProtocolTaskState, TaskStatus, TaskStatusUpdateEvent,
    },
    select_endpoint, A2aClient, ClientLimits, EndpointPolicy, StoreError, TaskCreate,
    TaskDirection, TaskState,
};
use serde_json::{json, Value};
use tokio::sync::watch;
use uuid::Uuid;

use super::runtime::runtime;
use crate::{
    routing_policy::reactive::{FailureKind, TurnWatch},
    sidecar::adapters::{
        error_stream, sse_response, ui_finish, ui_message_text, ui_start, ui_text_delta,
        ui_text_end, ui_text_start, ChatStreamRequest,
    },
};

const DEFAULT_TENANT: &str = "default";
const LOCAL_OWNER: &str = "local";
const DONE_FRAME: &[u8] = b"data: [DONE]\n\n";

#[derive(Clone)]
struct ActiveOutbound {
    generation: Uuid,
    cancel: watch::Sender<bool>,
}

static OUTBOUND_TASKS: OnceLock<Mutex<HashMap<String, ActiveOutbound>>> = OnceLock::new();

struct OutboundRegistration {
    conversation_id: Option<String>,
    generation: Uuid,
}

impl Drop for OutboundRegistration {
    fn drop(&mut self) {
        let Some(conversation_id) = &self.conversation_id else {
            return;
        };
        if let Ok(mut active) = outbound_tasks().lock() {
            let is_current = active
                .get(conversation_id)
                .is_some_and(|entry| entry.generation == self.generation);
            if is_current {
                active.remove(conversation_id);
            }
        }
    }
}

fn outbound_tasks() -> &'static Mutex<HashMap<String, ActiveOutbound>> {
    OUTBOUND_TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_outbound(
    conversation_id: Option<String>,
) -> (watch::Receiver<bool>, OutboundRegistration) {
    let (cancel, receiver) = watch::channel(false);
    let generation = Uuid::new_v4();
    if let Some(conversation_id) = &conversation_id {
        if let Ok(mut active) = outbound_tasks().lock() {
            active.insert(
                conversation_id.clone(),
                ActiveOutbound { generation, cancel },
            );
        }
    }
    (
        receiver,
        OutboundRegistration {
            conversation_id,
            generation,
        },
    )
}

/// Request cancellation of the remote task currently serving a local chat.
pub(crate) fn request_cancel(conversation_id: &str) -> bool {
    outbound_tasks()
        .lock()
        .ok()
        .and_then(|active| active.get(conversation_id).cloned())
        .is_some_and(|active| active.cancel.send(true).is_ok())
}

pub(crate) async fn route_peer_chat<F, Fut>(
    req: ChatStreamRequest,
    peer_id: String,
    persist: F,
    turn_watch: TurnWatch,
) -> Response
where
    F: FnOnce(String, &'static str) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let runtime = match runtime() {
        Ok(runtime) => runtime,
        Err(_) => return error_stream("A2A storage is unavailable".to_owned()),
    };
    let resolved = match runtime
        .store
        .resolve_peer_for_transport(DEFAULT_TENANT, &peer_id)
    {
        Ok(resolved) => resolved,
        Err(StoreError::AuthenticationFailed) => {
            return error_stream("This A2A peer is not trusted".to_owned());
        }
        Err(_) => return error_stream("The A2A peer is unavailable".to_owned()),
    };
    let card: AgentCard = match resolved
        .peer
        .agent_card
        .clone()
        .ok_or_else(|| anyhow!("missing Agent Card"))
        .and_then(|value| serde_json::from_value(value).context("invalid Agent Card"))
    {
        Ok(card) => card,
        Err(_) => return error_stream("Discover this A2A peer before chatting".to_owned()),
    };
    let endpoint = match select_endpoint(&card, outbound_policy(), &[]) {
        Ok(endpoint) => endpoint,
        Err(_) => return error_stream("The peer has no compatible A2A v1 endpoint".to_owned()),
    };
    let tenant = endpoint.tenant.clone();
    let client = A2aClient::new(
        endpoint,
        resolved.credential,
        outbound_policy(),
        ClientLimits::default(),
    );
    let user_text = req
        .messages
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .map(ui_message_text)
        .unwrap_or_default();
    if user_text.trim().is_empty() {
        return error_stream("A remote A2A agent needs a user message".to_owned());
    }
    let conversation_id = req.conversation_id.clone();
    let (mut cancel, registration) = register_outbound(conversation_id.clone());
    let mut message = Message::new(Role::User, vec![Part::text(user_text)]);
    message.context_id = conversation_id;
    if let Ok(tasks) = runtime.store.list_tasks_owned(
        DEFAULT_TENANT,
        LOCAL_OWNER,
        message.context_id.as_deref(),
        None,
        None,
        20,
        0,
    ) {
        message.task_id = tasks
            .into_iter()
            .find(|task| {
                task.peer_id.as_deref() == Some(peer_id.as_str())
                    && matches!(
                        task.state,
                        TaskState::InputRequired | TaskState::AuthRequired
                    )
            })
            .and_then(|task| {
                task.protocol_task
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
    }
    let request_message = message.clone();
    let request = SendMessageRequest {
        message,
        configuration: None,
        metadata: Some(HashMap::from([("ryuHopCount".to_owned(), Value::from(1))])),
        tenant,
    };
    let supports_streaming = card.capabilities.streaming != Some(false);
    let stream = async_stream::stream! {
        let _registration = registration;
        let mut persist = Some(persist);
        let text_id = format!("a2a-{}", Uuid::new_v4());
        let mut text_open = false;
        let mut reply = String::new();
        let mut remote_task_id: Option<String> = request_message.task_id.clone();
        let mut outcome = "completed";
        let mut failure: Option<String> = None;

        yield Ok::<_, Infallible>(ui_start());

        if supports_streaming {
            match client.send_streaming_message(&request).await {
                Ok(mut events) => loop {
                    let event = tokio::select! {
                        changed = cancel.changed() => {
                            if changed.is_ok() && *cancel.borrow() {
                                if let Some(task_id) = &remote_task_id {
                                    if let Ok(task) = client.cancel_task(&CancelTaskRequest {
                                        id: task_id.clone(),
                                        metadata: None,
                                        tenant: request.tenant.clone(),
                                    }).await {
                                        let _ = persist_task_snapshot(&peer_id, &task);
                                    }
                                }
                                outcome = "failed";
                                break;
                            }
                            continue;
                        }
                        event = events.recv() => event,
                    };
                    let Some(event) = event else {
                        break;
                    };
                    let event = match event {
                        Ok(event) => event,
                        Err(_) => {
                            outcome = "failed";
                            failure = Some("The remote A2A stream failed".to_owned());
                            break;
                        }
                    };
                    if let Err(error) = persist_stream_event(&peer_id, &request_message, &event) {
                        tracing::warn!(peer_id, "failed to persist outbound A2A event: {error:#}");
                    }
                    if let Some(task_id) = stream_task_id(&event) {
                        remote_task_id = Some(task_id.to_owned());
                    }
                    let mut delta = stream_text(&event);
                    if delta.is_empty() && reply.is_empty() {
                        if let StreamResponse::Task(task) = &event {
                            if task.status.state.is_terminal() {
                                delta = task_text(task);
                            }
                        }
                    }
                    if !delta.is_empty() {
                        if !text_open {
                            text_open = true;
                            yield Ok::<_, Infallible>(ui_text_start(&text_id));
                        }
                        reply.push_str(&delta);
                        turn_watch.mark_content();
                        yield Ok::<_, Infallible>(ui_text_delta(&text_id, &delta));
                    }
                    if let Some(terminal) = terminal_state(&event) {
                        if !matches!(terminal, ProtocolTaskState::Completed) {
                            outcome = "failed";
                            if matches!(terminal, ProtocolTaskState::Failed | ProtocolTaskState::Rejected) {
                                failure = Some("The remote A2A agent did not complete the task".to_owned());
                            }
                        }
                        break;
                    }
                },
                Err(_) => {
                    outcome = "failed";
                    failure = Some("Could not start the remote A2A stream".to_owned());
                }
            }
        } else {
            match client.send_message(&request).await {
                Ok(response) => {
                    if let Err(error) = persist_send_response(&peer_id, &request_message, &response) {
                        tracing::warn!(peer_id, "failed to persist outbound A2A response: {error:#}");
                    }
                    let text = send_response_text(&response);
                    if !text.is_empty() {
                        text_open = true;
                        reply.push_str(&text);
                        turn_watch.mark_content();
                        yield Ok::<_, Infallible>(ui_text_start(&text_id));
                        yield Ok::<_, Infallible>(ui_text_delta(&text_id, &text));
                    }
                    if matches!(
                        response,
                        SendMessageResponse::Task(ref task)
                            if !matches!(task.status.state, ProtocolTaskState::Completed)
                    ) {
                        outcome = "failed";
                    }
                }
                Err(_) => {
                    outcome = "failed";
                    failure = Some("The remote A2A request failed".to_owned());
                }
            }
        }

        if text_open {
            yield Ok::<_, Infallible>(ui_text_end(&text_id));
        }
        if let Some(failure) = failure {
            turn_watch.record_failure(&peer_id, None, FailureKind::Other, &failure);
            yield Ok::<_, Infallible>(ui_error(&failure));
        }
        if let Some(persist) = persist.take() {
            persist(reply, outcome).await;
        }
        yield Ok::<_, Infallible>(ui_finish());
        yield Ok::<_, Infallible>(DONE_FRAME.to_vec());
    };
    sse_response(Body::from_stream(stream))
}

fn persist_send_response(
    peer_id: &str,
    request: &Message,
    response: &SendMessageResponse,
) -> Result<()> {
    match response {
        SendMessageResponse::Task(task) => persist_task_snapshot(peer_id, task),
        SendMessageResponse::Message(message) => {
            let task_id = message
                .task_id
                .clone()
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            let context_id = message
                .context_id
                .clone()
                .or_else(|| request.context_id.clone())
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            let task = Task {
                id: task_id,
                context_id,
                status: TaskStatus {
                    state: ProtocolTaskState::Completed,
                    message: Some(message.clone()),
                    timestamp: Some(Utc::now()),
                },
                artifacts: None,
                history: Some(vec![request.clone(), message.clone()]),
                metadata: None,
            };
            persist_task_snapshot(peer_id, &task)
        }
    }
}

fn persist_stream_event(peer_id: &str, request: &Message, event: &StreamResponse) -> Result<()> {
    match event {
        StreamResponse::Task(task) => persist_task_snapshot(peer_id, task),
        StreamResponse::StatusUpdate(update) => persist_status_update(peer_id, request, update),
        StreamResponse::ArtifactUpdate(update) => persist_artifact_update(peer_id, request, update),
        StreamResponse::Message(message) => persist_outbound_message(peer_id, request, message),
    }
}

fn persist_task_snapshot(peer_id: &str, task: &Task) -> Result<()> {
    let runtime = runtime()?;
    let value = serde_json::to_value(task)?;
    let record_id = outbound_task_record_id(peer_id, &task.id);
    match runtime
        .store
        .get_task_owned(DEFAULT_TENANT, LOCAL_OWNER, &record_id)
    {
        Ok(existing) => {
            if existing.peer_id.as_deref() != Some(peer_id) {
                return Err(anyhow!("remote task id conflicts with a different peer"));
            }
            runtime.store.transition_task(
                DEFAULT_TENANT,
                LOCAL_OWNER,
                &record_id,
                protocol_state_to_store(&task.status.state),
                &value,
            )?;
        }
        Err(StoreError::NotFound) => {
            runtime.store.create_task(TaskCreate {
                id: record_id.clone(),
                context_id: task.context_id.clone(),
                tenant_id: DEFAULT_TENANT.to_owned(),
                owner_id: LOCAL_OWNER.to_owned(),
                peer_id: Some(peer_id.to_owned()),
                local_agent_id: None,
                direction: TaskDirection::Outbound,
                state: protocol_state_to_store(&task.status.state),
                protocol_task: value.clone(),
            })?;
        }
        Err(error) => return Err(error.into()),
    }
    runtime
        .store
        .append_event(DEFAULT_TENANT, LOCAL_OWNER, &record_id, "task", &value)?;
    Ok(())
}

fn persist_status_update(
    peer_id: &str,
    request: &Message,
    update: &TaskStatusUpdateEvent,
) -> Result<()> {
    let runtime = runtime()?;
    let record_id = outbound_task_record_id(peer_id, &update.task_id);
    let task = match runtime
        .store
        .get_task_owned(DEFAULT_TENANT, LOCAL_OWNER, &record_id)
    {
        Ok(existing) => {
            if existing.peer_id.as_deref() != Some(peer_id) {
                return Err(anyhow!("remote task id conflicts with a different peer"));
            }
            let mut task: Task = serde_json::from_value(existing.protocol_task)?;
            task.status = update.status.clone();
            task
        }
        Err(StoreError::NotFound) => Task {
            id: update.task_id.clone(),
            context_id: update.context_id.clone(),
            status: update.status.clone(),
            artifacts: None,
            history: Some(vec![request.clone()]),
            metadata: None,
        },
        Err(error) => return Err(error.into()),
    };
    persist_task_snapshot(peer_id, &task)
}

fn persist_artifact_update(
    peer_id: &str,
    request: &Message,
    update: &TaskArtifactUpdateEvent,
) -> Result<()> {
    let runtime = runtime()?;
    let record_id = outbound_task_record_id(peer_id, &update.task_id);
    let mut task = match runtime
        .store
        .get_task_owned(DEFAULT_TENANT, LOCAL_OWNER, &record_id)
    {
        Ok(existing) => {
            if existing.peer_id.as_deref() != Some(peer_id) {
                return Err(anyhow!("remote task id conflicts with a different peer"));
            }
            serde_json::from_value::<Task>(existing.protocol_task)?
        }
        Err(StoreError::NotFound) => Task {
            id: update.task_id.clone(),
            context_id: update.context_id.clone(),
            status: TaskStatus {
                state: ProtocolTaskState::Working,
                message: None,
                timestamp: Some(Utc::now()),
            },
            artifacts: None,
            history: Some(vec![request.clone()]),
            metadata: None,
        },
        Err(error) => return Err(error.into()),
    };
    merge_artifact(&mut task, update);
    persist_task_snapshot(peer_id, &task)?;
    runtime.store.append_task_item(
        DEFAULT_TENANT,
        LOCAL_OWNER,
        &record_id,
        &format!("{}-{}", update.artifact.artifact_id, Uuid::new_v4()),
        ryu_a2a::TaskItemKind::Artifact,
        &serde_json::to_value(&update.artifact)?,
    )?;
    Ok(())
}

fn persist_outbound_message(peer_id: &str, request: &Message, message: &Message) -> Result<()> {
    let Some(task_id) = &message.task_id else {
        return Ok(());
    };
    let runtime = runtime()?;
    let record_id = outbound_task_record_id(peer_id, task_id);
    match runtime
        .store
        .get_task_owned(DEFAULT_TENANT, LOCAL_OWNER, &record_id)
    {
        Ok(existing) => {
            if existing.peer_id.as_deref() != Some(peer_id) {
                return Err(anyhow!("remote task id conflicts with a different peer"));
            }
            let state = existing.state;
            let mut task: Task = serde_json::from_value(existing.protocol_task)?;
            task.history
                .get_or_insert_with(Vec::new)
                .push(message.clone());
            runtime.store.transition_task(
                DEFAULT_TENANT,
                LOCAL_OWNER,
                &record_id,
                state,
                &serde_json::to_value(task)?,
            )?;
            Ok(())
        }
        Err(StoreError::NotFound) => {
            let context_id = message
                .context_id
                .clone()
                .or_else(|| request.context_id.clone())
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            persist_task_snapshot(
                peer_id,
                &Task {
                    id: task_id.clone(),
                    context_id,
                    status: TaskStatus {
                        state: ProtocolTaskState::Working,
                        message: None,
                        timestamp: Some(Utc::now()),
                    },
                    artifacts: None,
                    history: Some(vec![request.clone(), message.clone()]),
                    metadata: None,
                },
            )
        }
        Err(error) => Err(error.into()),
    }
}

fn merge_artifact(task: &mut Task, update: &TaskArtifactUpdateEvent) {
    let artifacts = task.artifacts.get_or_insert_with(Vec::new);
    if let Some(existing) = artifacts
        .iter_mut()
        .find(|artifact| artifact.artifact_id == update.artifact.artifact_id)
    {
        if update.append == Some(true) {
            existing.parts.extend(update.artifact.parts.clone());
            existing.name = update
                .artifact
                .name
                .clone()
                .or_else(|| existing.name.clone());
            existing.description = update
                .artifact
                .description
                .clone()
                .or_else(|| existing.description.clone());
        } else {
            *existing = update.artifact.clone();
        }
    } else {
        artifacts.push(update.artifact.clone());
    }
}

fn protocol_state_to_store(state: &ProtocolTaskState) -> TaskState {
    match state {
        ProtocolTaskState::Unspecified => TaskState::Unknown,
        ProtocolTaskState::Submitted => TaskState::Submitted,
        ProtocolTaskState::Working => TaskState::Working,
        ProtocolTaskState::Completed => TaskState::Completed,
        ProtocolTaskState::Failed => TaskState::Failed,
        ProtocolTaskState::Canceled => TaskState::Canceled,
        ProtocolTaskState::InputRequired => TaskState::InputRequired,
        ProtocolTaskState::Rejected => TaskState::Rejected,
        ProtocolTaskState::AuthRequired => TaskState::AuthRequired,
    }
}

fn stream_task_id(event: &StreamResponse) -> Option<&str> {
    match event {
        StreamResponse::Task(task) => Some(&task.id),
        StreamResponse::Message(message) => message.task_id.as_deref(),
        StreamResponse::StatusUpdate(update) => Some(&update.task_id),
        StreamResponse::ArtifactUpdate(update) => Some(&update.task_id),
    }
}

fn terminal_state(event: &StreamResponse) -> Option<&ProtocolTaskState> {
    match event {
        StreamResponse::Task(task) if task.status.state.is_terminal() => Some(&task.status.state),
        StreamResponse::StatusUpdate(update) if update.status.state.is_terminal() => {
            Some(&update.status.state)
        }
        _ => None,
    }
}

fn stream_text(event: &StreamResponse) -> String {
    match event {
        StreamResponse::Message(message) => message_text(message),
        StreamResponse::StatusUpdate(update) => update
            .status
            .message
            .as_ref()
            .map(message_text)
            .unwrap_or_default(),
        StreamResponse::ArtifactUpdate(update) => artifact_text(&update.artifact),
        StreamResponse::Task(_) => String::new(),
    }
}

fn send_response_text(response: &SendMessageResponse) -> String {
    match response {
        SendMessageResponse::Task(task) => task_text(task),
        SendMessageResponse::Message(message) => message_text(message),
    }
}

fn task_text(task: &Task) -> String {
    task.status
        .message
        .as_ref()
        .map(message_text)
        .filter(|text| !text.is_empty())
        .or_else(|| {
            task.artifacts
                .as_ref()
                .map(|artifacts| artifacts.iter().map(artifact_text).collect::<String>())
                .filter(|text| !text.is_empty())
        })
        .or_else(|| {
            task.history.as_ref().and_then(|history| {
                history
                    .iter()
                    .rev()
                    .find(|message| message.role == Role::Agent)
                    .map(message_text)
            })
        })
        .unwrap_or_default()
}

fn artifact_text(artifact: &Artifact) -> String {
    parts_text(&artifact.parts)
}

fn message_text(message: &Message) -> String {
    parts_text(&message.parts)
}

fn parts_text(parts: &[Part]) -> String {
    parts
        .iter()
        .filter_map(|part| match &part.content {
            PartContent::Text(text) => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn ui_error(message: &str) -> Vec<u8> {
    format!(
        "data: {}\n\n",
        json!({ "type": "error", "errorText": message })
    )
    .into_bytes()
}

fn outbound_policy() -> EndpointPolicy {
    EndpointPolicy {
        allow_loopback_http: cfg!(debug_assertions)
            && std::env::var("RYU_A2A_ALLOW_LOOPBACK_HTTP").as_deref() == Ok("1"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_append_preserves_prior_parts() {
        let mut task = Task {
            id: "task-1".to_owned(),
            context_id: "context-1".to_owned(),
            status: TaskStatus {
                state: ProtocolTaskState::Working,
                message: None,
                timestamp: None,
            },
            artifacts: Some(vec![Artifact {
                artifact_id: "reply".to_owned(),
                name: None,
                description: None,
                parts: vec![Part::text("hello ")],
                metadata: None,
                extensions: None,
            }]),
            history: None,
            metadata: None,
        };
        merge_artifact(
            &mut task,
            &TaskArtifactUpdateEvent {
                task_id: "task-1".to_owned(),
                context_id: "context-1".to_owned(),
                artifact: Artifact {
                    artifact_id: "reply".to_owned(),
                    name: None,
                    description: None,
                    parts: vec![Part::text("world")],
                    metadata: None,
                    extensions: None,
                },
                append: Some(true),
                last_chunk: Some(true),
                metadata: None,
            },
        );
        assert_eq!(task_text(&task), "hello world");
    }

    #[test]
    fn cancel_registry_does_not_remove_a_newer_turn() {
        let conversation = format!("cancel-test-{}", Uuid::new_v4());
        let (_first_receiver, first) = register_outbound(Some(conversation.clone()));
        let (_second_receiver, second) = register_outbound(Some(conversation.clone()));
        drop(first);
        assert!(request_cancel(&conversation));
        drop(second);
        assert!(!request_cancel(&conversation));
    }
}
