//! The ACP wire that carries Ryu's in-process MCP bridge to an agent.
//!
//! `agent-client-protocol` 0.11.1's `SessionBuilder::with_mcp_server` advertised
//! an in-process MCP server in `session/new.mcpServers` as
//! `{"type":"http","name":<name>,"url":"acp:<uuid>","headers":[]}` and served it
//! back over the ACP connection through three extension methods:
//!
//! * `_mcp/connect` `{acp_url}` → `{connection_id}` opens one MCP connection;
//! * `_mcp/message` `{connectionId, method, params}` carries one MCP request or
//!   notification, in either direction, and a request's response is the bare MCP
//!   result;
//! * `_mcp/disconnect` `{connection_id}` closes the connection.
//!
//! 3.x removed that binding. Its replacement (feature `unstable_mcp_over_acp`)
//! declares a `type: "acp"` server that only agents advertising
//! `mcpCapabilities.acp` understand, and that an agent which validates the
//! `mcpServers` union strictly may reject, failing `session/new` outright. It also
//! drives each `mcp/message` without an MCP `initialize`, which the rmcp server
//! behind [`RyuMcpServer`] requires. So Ryu keeps the 0.11 wire byte for byte
//! here: the upgrade does not change what agents see.

use std::collections::HashMap;
use std::sync::Arc;

use agent_client_protocol::schema::v1::{McpServer, McpServerHttp};
use agent_client_protocol::{
    Agent, ConnectionTo, Dispatch, DynamicHandlerGuard, HandleDispatchFrom, Handled, Responder,
    UntypedMessage,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use super::mcp_bridge::RyuMcpServer;

const MCP_CONNECT: &str = "_mcp/connect";
const MCP_MESSAGE: &str = "_mcp/message";
const MCP_DISCONNECT: &str = "_mcp/disconnect";

/// Ryu's MCP server, ready to be offered to one ACP session.
pub(crate) struct McpOverAcpBridge {
    acp_url: String,
    server: Arc<RyuMcpServer>,
}

impl McpOverAcpBridge {
    pub(crate) fn new(server: RyuMcpServer) -> Self {
        Self {
            acp_url: format!("acp:{}", uuid::Uuid::new_v4()),
            server: Arc::new(server),
        }
    }

    /// The `session/new.mcpServers` entry that points the agent at this bridge.
    pub(crate) fn declaration(&self) -> McpServer {
        McpServer::Http(McpServerHttp::new(self.server.name(), self.acp_url.clone()))
    }

    /// Serve the bridge on `cx` until the returned guard is dropped. Register it
    /// before `session/new` is sent: the agent may connect while handling it.
    pub(crate) fn attach(
        self,
        cx: &ConnectionTo<Agent>,
    ) -> Result<DynamicHandlerGuard<Agent>, agent_client_protocol::Error> {
        cx.add_dynamic_handler(BridgeHandler {
            acp_url: self.acp_url,
            server: self.server,
            connections: HashMap::new(),
        })
    }
}

#[derive(Deserialize)]
struct ConnectParams {
    acp_url: String,
}

#[derive(Deserialize)]
struct DisconnectParams {
    connection_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WrappedMessage {
    connection_id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

/// A message from the agent to one MCP connection.
enum ToServer {
    Request(WrappedMessage, Responder<Value>),
    Notification(WrappedMessage),
}

/// One open MCP connection. Dropping it (disconnect, or the bridge going away
/// with its session) stops the connection's server.
struct BridgeConnection {
    to_server: mpsc::UnboundedSender<ToServer>,
    task: tokio::task::AbortHandle,
}

impl Drop for BridgeConnection {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct BridgeHandler {
    acp_url: String,
    server: Arc<RyuMcpServer>,
    connections: HashMap<String, BridgeConnection>,
}

impl BridgeHandler {
    fn connect(
        &mut self,
        request: UntypedMessage,
        responder: Responder<Value>,
        cx: &ConnectionTo<Agent>,
    ) -> Result<Handled<Dispatch>, agent_client_protocol::Error> {
        let ours = serde_json::from_value::<ConnectParams>(request.params.clone())
            .is_ok_and(|params| params.acp_url == self.acp_url);
        if !ours {
            return Ok(Handled::No {
                message: Dispatch::Request(request, responder),
                retry: false,
            });
        }
        let connection_id = format!("mcp-over-acp-connection:{}", uuid::Uuid::new_v4());
        let (to_server, inbound) = mpsc::unbounded_channel();
        let task = tokio::spawn(run_connection(
            Arc::clone(&self.server),
            connection_id.clone(),
            cx.clone(),
            inbound,
        ))
        .abort_handle();
        self.connections
            .insert(connection_id.clone(), BridgeConnection { to_server, task });
        responder.respond(json!({ "connection_id": connection_id }))?;
        Ok(Handled::Yes)
    }

    /// Hand an `_mcp/message` to its connection, or decline it when it names a
    /// connection this bridge does not own.
    fn forward(&self, dispatch: Dispatch) -> Handled<Dispatch> {
        let (params, request) = match &dispatch {
            Dispatch::Request(message, _) => (&message.params, true),
            Dispatch::Notification(message) => (&message.params, false),
            Dispatch::Response(..) => {
                return Handled::No {
                    message: dispatch,
                    retry: false,
                };
            }
        };
        let Ok(wrapped) = serde_json::from_value::<WrappedMessage>(params.clone()) else {
            return Handled::No {
                message: dispatch,
                retry: false,
            };
        };
        let Some(connection) = self.connections.get(&wrapped.connection_id) else {
            return Handled::No {
                message: dispatch,
                retry: false,
            };
        };
        let message = match dispatch {
            Dispatch::Request(_, responder) if request => ToServer::Request(wrapped, responder),
            _ => ToServer::Notification(wrapped),
        };
        if let Err(mpsc::error::SendError(message)) = connection.to_server.send(message) {
            if let ToServer::Request(_, responder) = message {
                drop(responder.respond_with_error(connection_closed()));
            }
        }
        Handled::Yes
    }

    fn disconnect(&mut self, notification: UntypedMessage) -> Handled<Dispatch> {
        let removed = serde_json::from_value::<DisconnectParams>(notification.params.clone())
            .ok()
            .and_then(|params| self.connections.remove(&params.connection_id));
        if removed.is_some() {
            Handled::Yes
        } else {
            Handled::No {
                message: Dispatch::Notification(notification),
                retry: false,
            }
        }
    }
}

impl HandleDispatchFrom<Agent> for BridgeHandler {
    fn describe_chain(&self) -> impl std::fmt::Debug {
        "RyuMcpOverAcpBridge"
    }

    async fn handle_dispatch_from(
        &mut self,
        message: Dispatch,
        connection: ConnectionTo<Agent>,
    ) -> Result<Handled<Dispatch>, agent_client_protocol::Error> {
        match message {
            Dispatch::Request(request, responder) if request.method == MCP_CONNECT => {
                self.connect(request, responder, &connection)
            }
            Dispatch::Notification(notification) if notification.method == MCP_DISCONNECT => {
                Ok(self.disconnect(notification))
            }
            Dispatch::Request(ref request, _) if request.method == MCP_MESSAGE => {
                Ok(self.forward(message))
            }
            Dispatch::Notification(ref notification) if notification.method == MCP_MESSAGE => {
                Ok(self.forward(message))
            }
            other => Ok(Handled::No {
                message: other,
                retry: false,
            }),
        }
    }
}

fn connection_closed() -> agent_client_protocol::Error {
    agent_client_protocol::Error::internal_error().data("Ryu MCP bridge connection closed")
}

/// One JSON-RPC frame for the MCP server: a request when `id` is set. Null
/// params are omitted, as the 0.11 transport did.
fn frame(id: Option<Value>, method: &str, params: Value) -> Value {
    let mut frame = json!({ "jsonrpc": "2.0", "method": method });
    if let Some(id) = id {
        frame["id"] = id;
    }
    if !params.is_null() {
        frame["params"] = params;
    }
    frame
}

async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, frame: &Value) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(frame)?;
    line.push(b'\n');
    writer.write_all(&line).await?;
    writer.flush().await
}

/// The MCP error object of a JSON-RPC error response, as an ACP error.
fn mcp_error(error: &Value) -> agent_client_protocol::Error {
    let code = error
        .get("code")
        .and_then(Value::as_i64)
        .and_then(|code| i32::try_from(code).ok())
        .unwrap_or(-32603);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("MCP error");
    agent_client_protocol::Error::new(code, message).data(error.get("data").cloned())
}

/// Drive one MCP connection: a fresh Ryu MCP server on one end of an in-memory
/// pipe, and the agent's `_mcp/message` traffic on the other.
async fn run_connection(
    server: Arc<RyuMcpServer>,
    connection_id: String,
    cx: ConnectionTo<Agent>,
    mut inbound: mpsc::UnboundedReceiver<ToServer>,
) {
    let (client_end, server_end) = tokio::io::duplex(64 * 1024);
    let serving = tokio::spawn(async move {
        if let Err(error) = server.serve_connection(server_end).await {
            tracing::debug!(%error, "Ryu MCP bridge connection ended");
        }
    });
    // Abort the server with this task, whatever ends it.
    let _serving = AbortOnDrop(serving.abort_handle());
    let (read, mut write) = tokio::io::split(client_end);
    let mut lines = BufReader::new(read).lines();
    // The agent's answers to server-initiated requests, written back in order.
    let (replies_tx, mut replies) = mpsc::unbounded_channel::<Value>();
    let mut pending: HashMap<u64, Responder<Value>> = HashMap::new();
    let mut next_id: u64 = 0;
    loop {
        tokio::select! {
            message = inbound.recv() => {
                let written = match message {
                    None => break,
                    Some(ToServer::Request(message, responder)) => {
                        next_id += 1;
                        let id = next_id;
                        let request = frame(Some(json!(id)), &message.method, message.params);
                        pending.insert(id, responder);
                        write_frame(&mut write, &request).await
                    }
                    Some(ToServer::Notification(message)) => {
                        write_frame(&mut write, &frame(None, &message.method, message.params)).await
                    }
                };
                if written.is_err() {
                    break;
                }
            }
            Some(reply) = replies.recv() => {
                if write_frame(&mut write, &reply).await.is_err() {
                    break;
                }
            }
            line = lines.next_line() => {
                let Ok(Some(line)) = line else { break };
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    tracing::debug!("Ryu MCP bridge server wrote a non-JSON line");
                    continue;
                };
                from_server(message, &connection_id, &cx, &mut pending, &replies_tx);
            }
        }
    }
    for (_, responder) in pending.drain() {
        drop(responder.respond_with_error(connection_closed()));
    }
}

struct AbortOnDrop(tokio::task::AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Route one frame the MCP server wrote: a response resolves the agent's
/// pending `_mcp/message`; a request or notification is wrapped and sent to the
/// agent.
fn from_server(
    message: Value,
    connection_id: &str,
    cx: &ConnectionTo<Agent>,
    pending: &mut HashMap<u64, Responder<Value>>,
    replies: &mpsc::UnboundedSender<Value>,
) {
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        let Some(responder) = message
            .get("id")
            .and_then(Value::as_u64)
            .and_then(|id| pending.remove(&id))
        else {
            return;
        };
        let answered = match message.get("error") {
            Some(error) => responder.respond_with_error(mcp_error(error)),
            None => responder.respond(message.get("result").cloned().unwrap_or(Value::Null)),
        };
        if let Err(error) = answered {
            tracing::debug!(%error, "Ryu MCP bridge could not answer the agent");
        }
        return;
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let wrapped = match UntypedMessage::new(
        MCP_MESSAGE,
        json!({ "connectionId": connection_id, "method": method, "params": params }),
    ) {
        Ok(wrapped) => wrapped,
        Err(error) => {
            tracing::debug!(%error, "Ryu MCP bridge could not wrap a server message");
            return;
        }
    };
    let Some(id) = message.get("id").cloned() else {
        if let Err(error) = cx.send_notification_to(Agent, wrapped) {
            tracing::debug!(%error, "Ryu MCP bridge could not notify the agent");
        }
        return;
    };
    let sent = cx.send_request_to(Agent, wrapped);
    let replies = replies.clone();
    tokio::spawn(async move {
        let reply = match sent.block_task().await {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": i32::from(error.code), "message": error.message, "data": error.data },
            }),
        };
        drop(replies.send(reply));
    });
}

#[cfg(test)]
#[path = "acp_mcp_over_acp_tests.rs"]
mod tests;
