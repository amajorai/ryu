//! Listener limits: a client that sends its headers too slowly (or idles
//! on a kept-alive connection) is cut off, and connections over the global
//! cap are closed before any byte is read, freeing their slot when they end.

use std::time::Duration;

use super::*;

/// Reads until the server closes the connection; `None` if it stays open
/// past `wait`.
async fn closed_within(stream: &mut TcpStream, wait: Duration) -> Option<String> {
    let mut buf = Vec::new();
    let read = tokio::time::timeout(wait, async {
        let mut chunk = [0u8; 1024];
        loop {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
    })
    .await;
    read.ok()
        .map(|()| String::from_utf8_lossy(&buf).into_owned())
}

#[tokio::test]
async fn a_slow_or_idle_client_is_cut_off_after_the_header_deadline() {
    let store = leak_store();
    let port = start(
        store,
        BrokerConfig {
            header_read_timeout: Duration::from_millis(300),
            ..loopback_config()
        },
    )
    .await;
    // Half a request head, then silence.
    let mut slow = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    slow.write_all(b"GET http://upstream/ HTTP/1.1\r\nHost: up")
        .await
        .unwrap();
    assert!(
        closed_within(&mut slow, Duration::from_secs(5))
            .await
            .is_some(),
        "a half-sent head must not hold the connection open"
    );
    // A connection that never sends anything is closed too.
    let mut idle = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    assert!(closed_within(&mut idle, Duration::from_secs(5))
        .await
        .is_some());
    // A prompt client is still served (refused for lacking credentials).
    let response = send_raw(port, get_via_proxy("http://127.0.0.1:9/x", None, "")).await;
    assert!(response.starts_with("HTTP/1.1 407"), "{response}");
}

#[tokio::test]
async fn connections_over_the_cap_are_closed_and_a_freed_slot_is_reused() {
    let store = leak_store();
    let port = start(
        store,
        BrokerConfig {
            max_connections: 1,
            ..loopback_config()
        },
    )
    .await;
    // The first connection takes the only slot and holds it while idle.
    let holder = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut over = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let _ = over
        .write_all(get_via_proxy("http://127.0.0.1:9/x", None, "").as_bytes())
        .await;
    let answer = closed_within(&mut over, Duration::from_secs(5))
        .await
        .expect("a connection over the cap is closed");
    assert!(
        answer.is_empty(),
        "nothing is served over the cap: {answer}"
    );

    drop(holder);
    // The slot frees once the holder's connection ends.
    let mut served = String::new();
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        served = send_raw(port, get_via_proxy("http://127.0.0.1:9/x", None, "")).await;
        if !served.is_empty() {
            break;
        }
    }
    assert!(served.starts_with("HTTP/1.1 407"), "{served}");
}
