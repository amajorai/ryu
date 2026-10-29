//! The bridge keeps `agent-client-protocol` 0.11.1's MCP-over-ACP wire: an
//! in-process agent drives it exactly as an agent would.

use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    InitializeRequest, InitializeResponse, McpServer, NewSessionRequest, NewSessionResponse,
    SessionId,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{Agent, ByteStreams, Client, ConnectionTo, Responder, UntypedMessage};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use super::McpOverAcpBridge;
use crate::sidecar::adapters::mcp_bridge::build_ryu_mcp_server;
use crate::sidecar::mcp::McpRegistry;

async fn bridge() -> McpOverAcpBridge {
    let server = build_ryu_mcp_server(
        Arc::new(McpRegistry::empty()),
        Some(vec![]),
        vec![],
        "ryu".to_owned(),
        vec![],
        None,
        None,
        None,
        None,
    )
    .await
    .expect("the meta-tools are always offered");
    McpOverAcpBridge::new(server)
}

#[tokio::test]
async fn declaration_is_the_0_11_http_entry() {
    let declaration = serde_json::to_value(bridge().await.declaration()).unwrap();
    assert_eq!(declaration["type"], "http");
    assert_eq!(declaration["name"], "ryu-registry");
    assert_eq!(declaration["headers"], json!([]));
    let url = declaration["url"].as_str().unwrap();
    assert!(url.starts_with("acp:"), "{url}");
}

async fn send(
    cx: &ConnectionTo<Client>,
    method: &str,
    params: Value,
) -> Result<Value, agent_client_protocol::Error> {
    cx.send_request(UntypedMessage::new(method, params)?)
        .block_task()
        .await
}

fn mcp(connection_id: &str, method: &str, params: Value) -> Value {
    json!({ "connectionId": connection_id, "method": method, "params": params })
}

/// What the fake agent observed, in order.
struct AgentRun {
    declared: Vec<McpServer>,
    foreign_connect: Result<Value, agent_client_protocol::Error>,
    tool_names: Vec<String>,
    after_disconnect: Result<Value, agent_client_protocol::Error>,
}

/// A fake agent that connects to every `acp:` server `session/new` declared and
/// lists its tools, the way an agent's MCP client does.
async fn drive_agent(
    cx: ConnectionTo<Client>,
    mut declared_rx: mpsc::UnboundedReceiver<Vec<McpServer>>,
) -> Result<AgentRun, agent_client_protocol::Error> {
    let declared = declared_rx.recv().await.expect("session/new arrived");
    let McpServer::Http(http) = &declared[0] else {
        panic!("the bridge is declared as an HTTP server");
    };
    let foreign_connect = send(
        &cx,
        "_mcp/connect",
        json!({ "acp_url": "acp:someone-else" }),
    )
    .await;
    let connected = send(&cx, "_mcp/connect", json!({ "acp_url": http.url })).await?;
    let connection_id = connected["connection_id"].as_str().unwrap().to_owned();
    let initialize = json!({
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": { "name": "fake-agent", "version": "1" },
    });
    let initialized = send(
        &cx,
        "_mcp/message",
        mcp(&connection_id, "initialize", initialize),
    )
    .await?;
    assert!(initialized.get("serverInfo").is_some(), "{initialized}");
    cx.send_notification(UntypedMessage::new(
        "_mcp/message",
        mcp(&connection_id, "notifications/initialized", Value::Null),
    )?)?;
    let listed = send(
        &cx,
        "_mcp/message",
        mcp(&connection_id, "tools/list", json!({})),
    )
    .await?;
    let tool_names = listed["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str().map(str::to_owned))
        .collect();
    cx.send_notification(UntypedMessage::new(
        "_mcp/disconnect",
        json!({ "connection_id": connection_id }),
    )?)?;
    let after_disconnect = send(
        &cx,
        "_mcp/message",
        mcp(&connection_id, "tools/list", json!({})),
    )
    .await;
    Ok(AgentRun {
        declared,
        foreign_connect,
        tool_names,
        after_disconnect,
    })
}

#[tokio::test]
async fn an_agent_reaches_ryu_tools_over_the_0_11_wire() {
    let (client_io, agent_io) = tokio::io::duplex(1 << 16);
    let (declared_tx, declared_rx) = mpsc::unbounded_channel();
    let (done_tx, done_rx) = oneshot::channel::<()>();

    let (agent_read, agent_write) = tokio::io::split(agent_io);
    let agent = Agent
        .builder()
        .on_receive_request(
            async move |_request: InitializeRequest,
                        responder: Responder<InitializeResponse>,
                        _cx: ConnectionTo<Client>| {
                responder.respond(InitializeResponse::new(ProtocolVersion::V1))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: NewSessionRequest,
                        responder: Responder<NewSessionResponse>,
                        _cx: ConnectionTo<Client>| {
                drop(declared_tx.send(request.mcp_servers));
                responder.respond(NewSessionResponse::new(SessionId::new("s1")))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(
            ByteStreams::new(agent_write.compat_write(), agent_read.compat()),
            async move |cx: ConnectionTo<Client>| {
                let run = drive_agent(cx, declared_rx).await;
                let _ = done_tx.send(());
                run
            },
        );

    let bridge = bridge().await;
    let (client_read, client_write) = tokio::io::split(client_io);
    let client = Client.builder().connect_with(
        ByteStreams::new(client_write.compat_write(), client_read.compat()),
        async move |cx: ConnectionTo<Agent>| {
            cx.send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;
            let mut request = NewSessionRequest::new(std::env::temp_dir());
            request.mcp_servers.push(bridge.declaration());
            let guard = bridge.attach(&cx)?;
            let session = cx
                .build_session_from(request)
                .block_task()
                .start_session()
                .await?;
            let _ = done_rx.await;
            drop(session);
            drop(guard);
            Ok(())
        },
    );

    let (agent, client) = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::join!(agent, client)
    })
    .await
    .expect("the exchange finished in time");
    client.expect("client ran");
    let run = agent.expect("agent ran");

    assert_eq!(run.declared.len(), 1);
    assert!(
        run.foreign_connect.is_err(),
        "a connect for another server's acp: URL is not claimed"
    );
    assert!(
        run.tool_names.iter().any(|name| name == "tool_search"),
        "{:?}",
        run.tool_names
    );
    assert!(
        run.after_disconnect.is_err(),
        "a disconnected connection no longer answers"
    );
}
