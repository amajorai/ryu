use super::*;

// ── Streaming client timeouts ────────────────────────────────────────────

/// A loopback server that answers with SSE headers plus `first_chunk` (when
/// given) and then goes silent while holding the connection open.
async fn stalling_sse_server(first_chunk: Option<&'static str>) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0u8; 4096];
        let _ = socket.read(&mut request).await;
        if let Some(chunk) = first_chunk {
            let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n";
            let body = format!("{:x}\r\n{chunk}\r\n", chunk.len());
            let _ = socket.write_all(head.as_bytes()).await;
            let _ = socket.write_all(body.as_bytes()).await;
            let _ = socket.flush().await;
        }
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        drop(socket);
    });
    format!("http://{addr}/v1/chat/completions")
}

#[tokio::test]
async fn stream_client_fails_a_stream_that_stalls_after_the_first_chunk() {
    let url = stalling_sse_server(Some("data: {\"choices\":[]}\n\n")).await;
    let read_timeout = std::time::Duration::from_millis(200);
    let client = build_stream_http_client(std::time::Duration::from_secs(5), read_timeout);
    let response = client
        .post(url)
        .body("{}")
        .send()
        .await
        .expect("headers arrive");
    let mut stream = response.bytes_stream();
    let first = stream
        .next()
        .await
        .expect("first chunk")
        .expect("first chunk ok");
    assert!(String::from_utf8_lossy(&first).contains("data:"));
    let started = std::time::Instant::now();
    let error = tokio::time::timeout(std::time::Duration::from_secs(10), stream.next())
        .await
        .expect("the idle read timeout fires, not the test guard")
        .expect("the stream yields an item")
        .expect_err("a stalled stream errors");
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    assert!(error.is_timeout());
    let message = describe_stream_error(&error, read_timeout);
    assert!(message.starts_with("Model stream stalled"), "{message}");
}

#[tokio::test]
async fn stream_client_fails_when_headers_never_arrive() {
    let url = stalling_sse_server(None).await;
    let read_timeout = std::time::Duration::from_millis(200);
    let client = build_stream_http_client(std::time::Duration::from_secs(5), read_timeout);
    let error = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        client.post(url).body("{}").send(),
    )
    .await
    .expect("the idle read timeout fires, not the test guard")
    .expect_err("a silent upstream errors");
    assert!(error.is_timeout());
    assert!(describe_stream_error(&error, read_timeout).contains("stream stalled"));
}

#[test]
fn stream_client_idle_limit_follows_the_hop_kind() {
    // Provider hops keep Gateway parity; local engines and SDK apps can stay
    // silent far longer (prefill, inner model and tool calls).
    assert_eq!(
        StreamHop::Provider.idle_read_timeout(),
        ryu_gw_providers::STREAM_READ_TIMEOUT
    );
    assert_eq!(
        StreamHop::Local.idle_read_timeout(),
        LOCAL_STREAM_IDLE_READ_TIMEOUT
    );
    assert!(LOCAL_STREAM_IDLE_READ_TIMEOUT >= std::time::Duration::from_secs(30 * 60));
    assert!(!std::ptr::eq(
        StreamHop::Provider.http_client(),
        StreamHop::Local.http_client()
    ));
}
