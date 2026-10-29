//! Protocol-level tests: a real ACP client drives `ryu_acp_server::serve` over
//! an in-memory duplex, while an axum server stands in for Core's HTTP API.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, InitializeRequest, InitializeResponse, LoadSessionRequest,
    NewSessionRequest, PromptRequest, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome, SessionNotification, SessionUpdate,
    SetSessionModeRequest, StopReason, TextContent, ToolCallStatus, ToolKind,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Agent, ByteStreams, Client, ConnectionTo, Responder};
use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use ryu_acp_server::{serve, serve_until, CoreEndpoint, ServerConfig};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Notify};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

const TOKEN: &str = "test-node-token";

#[path = "protocol/fake_core.rs"]
mod fake_core;

use fake_core::*;

// ── ACP client harness ───────────────────────────────────────────────────────

#[derive(Clone, Copy)]
enum PermissionReply {
    Select(&'static str),
    Cancel,
}

#[derive(Default)]
struct ClientLog {
    updates: Mutex<Vec<SessionUpdate>>,
    permission_requests: Mutex<Vec<RequestPermissionRequest>>,
    first_message_chunk: Notify,
}

fn config(url: &str, agent: Option<&str>) -> ServerConfig {
    ServerConfig {
        endpoint: CoreEndpoint {
            url: url.to_owned(),
            token: Some(TOKEN.to_owned()),
        },
        agent: agent.map(str::to_owned),
    }
}

/// Start the ACP server on one end of a duplex and run `body` as the client.
async fn run_client<R: Send + 'static>(
    config: ServerConfig,
    reply: PermissionReply,
    body: impl AsyncFnOnce(
        ConnectionTo<Agent>,
        Arc<ClientLog>,
    ) -> Result<R, agent_client_protocol::Error>,
) -> (R, Arc<ClientLog>) {
    let (client_io, server_io) = tokio::io::duplex(1 << 16);
    let (server_read, server_write) = tokio::io::split(server_io);
    tokio::spawn(async move {
        let _ = serve(
            config,
            ByteStreams::new(server_write.compat_write(), server_read.compat()),
        )
        .await;
    });
    let (client_read, client_write) = tokio::io::split(client_io);
    let log = Arc::new(ClientLog::default());
    let on_update = Arc::clone(&log);
    let on_permission = Arc::clone(&log);
    let main_log = Arc::clone(&log);
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        Client
            .builder()
            .on_receive_notification(
                async move |notification: SessionNotification, _cx: ConnectionTo<Agent>| {
                    if matches!(notification.update, SessionUpdate::AgentMessageChunk(_)) {
                        on_update.first_message_chunk.notify_one();
                    }
                    on_update.updates.lock().unwrap().push(notification.update);
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                async move |request: RequestPermissionRequest,
                            responder: Responder<RequestPermissionResponse>,
                            _cx: ConnectionTo<Agent>| {
                    on_permission
                        .permission_requests
                        .lock()
                        .unwrap()
                        .push(request);
                    let outcome = match reply {
                        PermissionReply::Select(option) => RequestPermissionOutcome::Selected(
                            SelectedPermissionOutcome::new(option),
                        ),
                        PermissionReply::Cancel => RequestPermissionOutcome::Cancelled,
                    };
                    responder.respond(RequestPermissionResponse::new(outcome))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(
                ByteStreams::new(client_write.compat_write(), client_read.compat()),
                async move |cx: ConnectionTo<Agent>| body(cx, main_log).await,
            ),
    )
    .await
    .expect("client finished in time")
    .expect("client ran");
    (result, log)
}

async fn initialize(
    cx: &ConnectionTo<Agent>,
) -> Result<InitializeResponse, agent_client_protocol::Error> {
    cx.send_request(InitializeRequest::new(ProtocolVersion::V1))
        .block_task()
        .await
}

fn text_prompt(
    session_id: agent_client_protocol::schema::v1::SessionId,
    text: &str,
) -> PromptRequest {
    PromptRequest::new(session_id, vec![ContentBlock::Text(TextContent::new(text))])
}

fn chunk_text(update: &SessionUpdate) -> Option<(&'static str, String)> {
    let (kind, chunk) = match update {
        SessionUpdate::AgentMessageChunk(chunk) => ("message", chunk),
        SessionUpdate::AgentThoughtChunk(chunk) => ("thought", chunk),
        SessionUpdate::UserMessageChunk(chunk) => ("user", chunk),
        _ => return None,
    };
    match &chunk.content {
        ContentBlock::Text(text) => Some((kind, text.text.clone())),
        _ => None,
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[path = "protocol/basics.rs"]
mod basics;
#[path = "protocol/interactions.rs"]
mod interactions;
#[path = "protocol/lifecycle_and_errors.rs"]
mod lifecycle_and_errors;
