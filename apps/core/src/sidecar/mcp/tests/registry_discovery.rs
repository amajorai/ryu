//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;
use crate::sidecar::mcp::tests::{allow_discovery_test_host, lock_mcp_env};
use serde_json::json;

#[tokio::test]
async fn mcp_server_discovery_timeout_skips_a_stalled_server() {
    tokio::time::pause();
    let discovery = tokio::spawn(discover_mcp_server_with_timeout(
        "stalled".to_owned(),
        async {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            Ok(Vec::new())
        },
    ));
    tokio::time::advance(MCP_DISCOVERY_TIMEOUT + std::time::Duration::from_millis(1)).await;
    for _ in 0..4 {
        tokio::task::yield_now().await;
    }
    let result = discovery.await.unwrap();
    tokio::time::resume();
    let error = result.unwrap_err();
    assert!(error
        .to_string()
        .contains("MCP server 'stalled' tools/list timed out"));
    assert!(error.is::<DiscoveryTimedOut>());
}

#[tokio::test]
async fn legacy_sse_discovery_bounds_each_setup_stage() {
    use std::io::ErrorKind;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let _env_lock = lock_mcp_env();
    for response_prefix in [
        "",
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
        "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 100\r\n\r\npartial",
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let _allow_host = allow_discovery_test_host(address);
        let (started, ready) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            assert!(socket.read(&mut buffer).await.unwrap() > 0);
            socket.write_all(response_prefix.as_bytes()).await.unwrap();
            started.send(()).unwrap();
            // Leave this setup stage unfinished until the client closes it.
            loop {
                match socket.read(&mut buffer).await {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error) if error.kind() == ErrorKind::ConnectionReset => break,
                    Err(error) => panic!("unexpected SSE fixture read error: {error}"),
                }
            }
        });
        let discovery = tokio::spawn(async move {
            client::list_tools(&McpTarget::Sse(McpHttpEndpoint {
                url: format!("http://{address}/sse"),
                headers: BTreeMap::new(),
            }))
            .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(3), ready)
            .await
            .unwrap()
            .unwrap();
        tokio::time::pause();
        tokio::time::advance(std::time::Duration::from_secs(61)).await;
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert!(
            discovery.is_finished(),
            "MCP discovery must bound every setup stage"
        );
        let error = discovery.await.unwrap().unwrap_err();
        assert!(error
            .to_string()
            .contains("legacy MCP SSE connection timed out"));
        tokio::time::resume();
        tokio::time::timeout(std::time::Duration::from_secs(3), server)
            .await
            .expect("timed-out discovery must close its connection")
            .unwrap();
    }
}

#[tokio::test]
async fn http_discovery_runs_concurrently_and_keeps_healthy_servers() {
    use std::sync::atomic::AtomicUsize;
    let _env_lock = lock_mcp_env();
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let (started, mut starts) = tokio::sync::mpsc::unbounded_channel();
    let app = {
        let active = active.clone();
        let peak = peak.clone();
        let gate = gate.clone();
        axum::Router::new().route(
            "/:server",
            axum::routing::post(move |axum::extract::Path(name): axum::extract::Path<String>, axum::Json(body): axum::Json<Value>| {
                let active = active.clone();
                let peak = peak.clone();
                let gate = gate.clone();
                let started = started.clone();
                async move {
                    if body["method"] == "server/discover" {
                        return axum::Json(json!({"jsonrpc":"2.0","id":body["id"],"error":{"code":-32601,"message":"Method not found"}}));
                    }
                    if body["method"] == "initialize" {
                        return axum::Json(json!({"jsonrpc":"2.0","id":body["id"],"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"discovery-fixture","version":"1"}}}));
                    }
                    if body["method"] != "tools/list" {
                        return axum::Json(json!({"jsonrpc":"2.0","id":body["id"],"result":{}}));
                    }
                    peak.fetch_max(active.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                    started.send(name.clone()).unwrap();
                    gate.acquire().await.unwrap().forget();
                    active.fetch_sub(1, Ordering::SeqCst);
                    if name == "fixture-5" {
                        axum::Json(json!({"jsonrpc":"2.0","id":body["id"],"error":{"code":-32000,"message":"unavailable"}}))
                    } else {
                        axum::Json(json!({"jsonrpc":"2.0","id":body["id"],"result":{"tools":[{"name":"probe","description":name,"inputSchema":{"type":"object"}}]}}))
                    }
                }
            }),
        )
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let _allow_host = allow_discovery_test_host(address);
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let registry = Arc::new(McpRegistry::empty());
    for index in 0..6 {
        let name = format!("fixture-{index}");
        registry.servers.write().unwrap().insert(
            name.clone(),
            McpServerConfig {
                enabled: true,
                transport: Some("streamable-http".to_owned()),
                url: Some(format!("http://{address}/{name}")),
                ..Default::default()
            },
        );
    }
    let discovery = {
        let registry = registry.clone();
        tokio::spawn(async move { registry.list_all_tools().await })
    };
    for _ in 0..4 {
        tokio::time::timeout(std::time::Duration::from_secs(3), starts.recv())
            .await
            .unwrap()
            .unwrap();
    }
    assert!(starts.try_recv().is_err());
    gate.add_permits(6);
    let tools = tokio::time::timeout(std::time::Duration::from_secs(3), discovery)
        .await
        .unwrap()
        .unwrap();
    let mut ids: Vec<_> = tools
        .into_iter()
        .filter(|tool| tool.server.starts_with("fixture-"))
        .map(|tool| tool.id)
        .collect();
    ids.sort();
    assert_eq!(
        ids,
        (0..5)
            .map(|index| format!("fixture-{index}.probe"))
            .collect::<Vec<_>>()
    );
    assert_eq!(peak.load(Ordering::SeqCst), 4);
    assert_eq!(active.load(Ordering::SeqCst), 0);
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn empty_allowlist_skips_server_discovery() {
    let _env_lock = lock_mcp_env();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("local stalled MCP endpoint");
    let _allow_host = allow_discovery_test_host(listener.local_addr().unwrap());
    let registry = McpRegistry::empty();
    registry.servers.write().unwrap().insert(
        "stalled".to_owned(),
        McpServerConfig {
            enabled: true,
            transport: Some("streamable-http".to_owned()),
            url: Some(format!("http://{}/mcp", listener.local_addr().unwrap())),
            ..Default::default()
        },
    );
    let tools = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        registry.tools_for_agent(Some(&[])),
    )
    .await
    .expect("an empty allowlist must not wait on any endpoint");
    assert!(tools.is_empty());
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), listener.accept())
            .await
            .is_err(),
        "discovery must not connect for an empty allowlist"
    );
}
