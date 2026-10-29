//! The ACP agent: session bookkeeping and the Core stream → ACP update mapping.
//!
//! One ACP session is one Core conversation; the session id IS the conversation
//! id, which makes `session/load` a straight history read. Each session pins a
//! Ryu agent; the node's agents are offered as ACP session modes so an editor's
//! mode picker doubles as the agent picker.
//!
//! `session/prompt` runs in a spawned task (never inside the dispatch loop), so
//! `session/cancel` and the client's `session/request_permission` answers keep
//! flowing while a turn streams.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1::{
    AgentCapabilities, CancelNotification, ContentBlock, ContentChunk, EmbeddedResourceResource,
    Implementation, InitializeRequest, InitializeResponse, LoadSessionRequest, LoadSessionResponse,
    NewSessionRequest, NewSessionResponse, PermissionOption, PermissionOptionKind,
    PromptCapabilities, PromptRequest, PromptResponse, RequestPermissionOutcome,
    RequestPermissionRequest, SessionId, SessionMode, SessionModeState, SessionNotification,
    SessionUpdate, SetSessionModeRequest, SetSessionModeResponse, StopReason, ToolCall,
    ToolCallContent, ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields, ToolKind,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Agent, Client, ConnectTo, ConnectionTo, Responder};
use base64::Engine as _;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::core_http::{AgentSummary, CoreClient, CoreError};
use crate::endpoint::CoreEndpoint;
use crate::sse::{decode_line, CoreEvent, LineBuffer};

mod prompt_convert;
mod question;
mod run;
mod session_state;
mod translate;

use prompt_convert::*;
use question::*;
use run::*;
use translate::*;

/// How the ACP server reaches Core and which agent new sessions start with.
#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub endpoint: CoreEndpoint,
    /// `--agent`: the Ryu agent new sessions use. `None` = Core's default.
    pub agent: Option<String>,
}

/// Longest text rendered into a tool call's content block. The full value still
/// travels as `rawOutput`; this only bounds what the editor shows inline.
const MAX_TOOL_TEXT_CHARS: usize = 8_000;

#[derive(Debug, Clone)]
struct Turn {
    role: &'static str,
    text: String,
}

struct Session {
    conversation_id: String,
    agent_id: Option<String>,
    agents: Vec<AgentSummary>,
    cwd: Option<String>,
    /// Text-only history replayed to Core on every turn (Core's chat API takes
    /// the conversation's messages from the client, as the CLI does).
    transcript: Vec<Turn>,
    /// Present while a prompt is streaming.
    active: Option<CancellationToken>,
}

struct State {
    core: CoreClient,
    default_agent: Option<String>,
    sessions: Mutex<HashMap<String, Session>>,
}

/// Everything a running prompt needs, captured when it starts.
struct PromptJob {
    session_id: SessionId,
    conversation_id: String,
    agent_id: Option<String>,
    cwd: Option<String>,
    history: Vec<Turn>,
    cancel: CancellationToken,
}

fn invalid_params(message: impl Into<String>) -> agent_client_protocol::Error {
    agent_client_protocol::Error::new(
        agent_client_protocol::ErrorCode::InvalidParams.into(),
        message.into(),
    )
}

fn internal_error(message: impl Into<String>) -> agent_client_protocol::Error {
    agent_client_protocol::Error::new(
        agent_client_protocol::ErrorCode::InternalError.into(),
        message.into(),
    )
}

/// Serve the ACP agent over `transport` until the connection fails.
pub async fn serve(
    config: ServerConfig,
    transport: impl ConnectTo<Agent> + 'static,
) -> Result<(), agent_client_protocol::Error> {
    serve_until(config, transport, std::future::pending()).await
}

/// Serve until `shutdown` resolves (the stdio runner resolves it when the
/// client closes stdin; the protocol crate fails pending requests on EOF but
/// does not end the `connect_with` foreground). On shutdown every in-flight Core run is asked to stop, so a closed
/// editor does not leave a turn running in Ryu.
pub async fn serve_until(
    config: ServerConfig,
    transport: impl ConnectTo<Agent> + 'static,
    shutdown: impl std::future::Future<Output = ()>,
) -> Result<(), agent_client_protocol::Error> {
    let state = Arc::new(State {
        core: CoreClient::new(config.endpoint),
        default_agent: config.agent,
        sessions: Mutex::new(HashMap::new()),
    });
    let on_initialize = Arc::clone(&state);
    let on_new = Arc::clone(&state);
    let on_load = Arc::clone(&state);
    let on_mode = Arc::clone(&state);
    let on_prompt = Arc::clone(&state);
    let on_cancel = Arc::clone(&state);

    Agent
        .builder()
        .name("ryu")
        .on_receive_request(
            async move |_request: InitializeRequest,
                        responder: Responder<InitializeResponse>,
                        _cx: ConnectionTo<Client>| {
                match on_initialize.core.health().await {
                    Ok(()) => responder.respond(initialize_response()),
                    Err(error) => responder.respond_with_error(error.into()),
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: NewSessionRequest,
                        responder: Responder<NewSessionResponse>,
                        _cx: ConnectionTo<Client>| {
                responder.respond_with_result(on_new.new_session(request).await)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: LoadSessionRequest,
                        responder: Responder<LoadSessionResponse>,
                        cx: ConnectionTo<Client>| {
                responder.respond_with_result(on_load.load_session(request, &cx).await)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: SetSessionModeRequest,
                        responder: Responder<SetSessionModeResponse>,
                        _cx: ConnectionTo<Client>| {
                responder.respond_with_result(on_mode.set_mode(&request))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: PromptRequest,
                        responder: Responder<PromptResponse>,
                        cx: ConnectionTo<Client>| {
                let job = match on_prompt.begin_prompt(&request.session_id) {
                    Ok(job) => job,
                    Err(error) => return responder.respond_with_error(error),
                };
                let state = Arc::clone(&on_prompt);
                let task_cx = cx.clone();
                cx.spawn(async move {
                    let session_key = job.session_id.0.to_string();
                    let outcome = run_prompt(&state, &task_cx, job, &request.prompt).await;
                    state.end_prompt(&session_key, outcome.transcript);
                    if let Err(error) = responder.respond_with_result(outcome.result) {
                        tracing::warn!("failed to answer session/prompt: {error:?}");
                    }
                    Ok(())
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_notification(
            async move |notification: CancelNotification, _cx: ConnectionTo<Client>| {
                on_cancel.cancel(&notification.session_id);
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .connect_with(transport, async move |_cx: ConnectionTo<Client>| {
            shutdown.await;
            state.stop_active_runs().await;
            Ok(())
        })
        .await
}

fn initialize_response() -> InitializeResponse {
    // Advertise only what Core's chat API actually accepts: text, images (as
    // AI SDK `file` parts), and embedded text resources (as document parts).
    // Audio is not accepted by Core chat. No client fs/terminal capability is
    // required: tools run inside Ryu, under Ryu's own policy.
    InitializeResponse::new(ProtocolVersion::LATEST)
        .agent_capabilities(
            AgentCapabilities::new()
                .load_session(true)
                .prompt_capabilities(
                    PromptCapabilities::new()
                        .image(true)
                        .audio(false)
                        .embedded_context(true),
                ),
        )
        .agent_info(Implementation::new("ryu", env!("CARGO_PKG_VERSION")).title("Ryu"))
}

#[cfg(test)]
mod tests;
