//! Shared fixtures for the custody tests: a scripted MCP server and seeded bindings.

use super::*;

pub(super) async fn legacy_fixture() -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let writers: Arc<Mutex<HashMap<usize, tokio::net::tcp::OwnedWriteHalf>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let closed = Arc::new(AtomicUsize::new(0));
    let closed_count = closed.clone();
    let task = tokio::spawn(async move {
        let mut next = 0;
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            next += 1;
            let id = next;
            let writers = writers.clone();
            let closed = closed_count.clone();
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let headers_end = loop {
                    let mut buffer = [0; 1024];
                    let n = stream.read(&mut buffer).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(at) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        break at + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&bytes[..headers_end]).to_string();
                assert!(headers
                    .to_ascii_lowercase()
                    .contains("authorization: bearer fixture-fresh"));
                assert!(headers
                    .to_ascii_lowercase()
                    .contains("x-workspace: fixture-workspace-secret"));
                if headers.starts_with("GET ") {
                    if headers.starts_with("GET /unauthorized") {
                        stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer error=\"invalid_token\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                        return;
                    }
                    let (mut reader, mut writer) = stream.into_split();
                    writer.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
                    let endpoint = if headers.starts_with("GET /cross") {
                        "https://other.example/message".into()
                    } else {
                        format!("/message?session={id}")
                    };
                    let event = format!("event: endpoint\r\ndata: {endpoint}\r\n\r\n");
                    writer
                        .write_all(format!("{:x}\r\n{}\r\n", event.len(), event).as_bytes())
                        .await
                        .unwrap();
                    writers.lock().await.insert(id, writer);
                    let mut buf = [0; 1];
                    let _ = reader.read(&mut buf).await;
                    closed.fetch_add(1, Ordering::SeqCst);
                    writers.lock().await.remove(&id);
                    return;
                }
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|v| v.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                while bytes.len() < headers_end + length {
                    let mut buf = [0; 1024];
                    let n = stream.read(&mut buf).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buf[..n]);
                }
                let frame: serde_json::Value =
                    serde_json::from_slice(&bytes[headers_end..headers_end + length]).unwrap();
                let notification = r#"{"jsonrpc":"2.0","method":"notifications/post-accepted"}"#;
                stream.write_all(format!("HTTP/1.1 202 Accepted\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{notification}",notification.len()).as_bytes()).await.unwrap();
                if frame.get("id").is_none() || frame["method"] == "stall" {
                    return;
                }
                let path = headers
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap();
                let session = Url::parse(&format!("http://fixture{path}"))
                    .unwrap()
                    .query_pairs()
                    .find(|(k, _)| k == "session")
                    .unwrap()
                    .1
                    .parse::<usize>()
                    .unwrap();
                let value = if frame["method"] == "echo" {
                    serde_json::json!({"header":"fixture-workspace-secret"})
                } else {
                    serde_json::json!({"ok":true})
                };
                let response = serde_json::json!({"jsonrpc":"2.0","id":frame["id"],"result":value});
                let event = format!(
                    ": heartbeat\n\ndata: {{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}}\n\ndata: {response}\n\n"
                );
                if let Some(writer) = writers.lock().await.get_mut(&session) {
                    writer
                        .write_all(format!("{:x}\r\n{}\r\n", event.len(), event).as_bytes())
                        .await
                        .unwrap();
                }
            });
        }
    });
    (origin, closed, task)
}
pub(super) async fn configured_seed(
    base: &str,
    path: &str,
) -> (
    Arc<McpOAuthManager>,
    McpBinding,
    crate::mcp_transport::McpConfiguration,
) {
    let (manager, binding) = seeded(base, path, false).await;
    let configuration = crate::mcp_transport::McpConfiguration {
        transport: crate::mcp_transport::TransportMode::Sse,
        static_headers: [("x-workspace".into(), "fixture-workspace-secret".into())].into(),
    };
    let record = manager
        .store
        .find_mcp_oauth_connection("owner", "profile", "plugin", "server")
        .await
        .unwrap()
        .unwrap();
    let mut bundle = open_bundle(&manager.store, &record).await.unwrap();
    bundle.static_headers_hash = crate::mcp_transport::McpConfiguration {
        static_headers: configuration.static_headers.clone(),
        ..Default::default()
    }
    .fingerprint()
    .unwrap();
    manager
        .store
        .upsert_mcp_oauth_connection(
            "owner",
            "profile",
            "plugin",
            "server",
            base,
            base,
            None,
            &[],
            Some(i64::MAX),
            &SecretState::new(serde_json::to_string(&bundle).unwrap()),
        )
        .await
        .unwrap();
    (manager, binding, configuration)
}
use std::sync::atomic::{AtomicUsize, Ordering};
pub(super) async fn fixture() -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let calls = calls.clone();
            tokio::spawn(async move {
                let mut bytes = vec![0; 65536];
                let n = stream.read(&mut bytes).await.unwrap();
                let request = String::from_utf8_lossy(&bytes[..n]);
                let (status, headers, body) = if request.starts_with("POST /token") {
                    calls.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    (
                        "200 OK",
                        "",
                        "{\"access_token\":\"fixture-fresh\",\"refresh_token\":\"fixture-refresh\",\"expires_in\":3600}",
                    )
                } else if request.starts_with("POST /redirect") {
                    ("302 Found", "Location: http://127.0.0.1/forbidden\r\n", "")
                } else if request.starts_with("POST /echo") {
                    ("200 OK", "", "fixture-fresh")
                } else {
                    assert!(request
                        .to_ascii_lowercase()
                        .contains("authorization: bearer fixture-fresh"));
                    (
                        "200 OK",
                        "Content-Type: text/event-stream\r\n",
                        "data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n",
                    )
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            });
        }
    });
    (url, count, task)
}
pub(super) async fn seeded(
    base: &str,
    path: &str,
    expired: bool,
) -> (Arc<McpOAuthManager>, McpBinding) {
    let store = crate::IdentityStore::open_in_memory().unwrap();
    let binding = McpBinding {
        owner_user_id: "owner".into(),
        profile_id: "profile".into(),
        plugin_id: "plugin".into(),
        server_name: "server".into(),
        resource_url: format!("{base}/{path}"),
        client_id: Some("client".into()),
    };
    let bundle = TokenBundle {
        access_token: if expired {
            "fixture-old"
        } else {
            "fixture-fresh"
        }
        .into(),
        refresh_token: Some("fixture-refresh".into()),
        id_token: None,
        token_type: "Bearer".into(),
        client_id: "client".into(),
        client_secret: None,
        token_endpoint: format!("{base}/token"),
        revocation_endpoint: None,
        issuer: base.into(),
        resource: base.into(),
        mcp_server_url: binding.resource_url.clone(),
        declared_client_id: binding.client_id.clone(),
        static_headers_hash: crate::mcp_transport::default_configuration_hash(),
    };
    store
        .upsert_mcp_oauth_connection(
            "owner",
            "profile",
            "plugin",
            "server",
            base,
            base,
            None,
            &[],
            Some(if expired { 0 } else { i64::MAX }),
            &SecretState::new(serde_json::to_string(&bundle).unwrap()),
        )
        .await
        .unwrap();
    (McpOAuthManager::new(store, None, None), binding)
}
