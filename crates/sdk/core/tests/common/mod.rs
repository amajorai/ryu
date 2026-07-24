//! A minimal one-shot HTTP/1.1 mock server for exercising the gateway clients
//! without a real gateway. It binds an ephemeral loopback port, serves exactly
//! one request with a canned response, and hands the captured raw request back so
//! a test can assert on the method, path, headers, and body the client sent.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// The raw bytes a client sent, split into the request line + headers blob and
/// the decoded body.
pub struct CapturedRequest {
    pub head: String,
    pub body: String,
}

impl CapturedRequest {
    /// Case-insensitive lookup of a header value from the captured head.
    pub fn header(&self, name: &str) -> Option<String> {
        let want = name.to_ascii_lowercase();
        self.head.lines().find_map(|line| {
            let (k, v) = line.split_once(':')?;
            if k.trim().to_ascii_lowercase() == want {
                Some(v.trim().to_string())
            } else {
                None
            }
        })
    }

    /// The request line, e.g. `POST /v1/chat/completions HTTP/1.1`.
    pub fn request_line(&self) -> &str {
        self.head.lines().next().unwrap_or("")
    }
}

/// A running mock server: its base URL and a receiver for the single captured
/// request.
pub struct MockServer {
    pub base_url: String,
    pub captured: oneshot::Receiver<CapturedRequest>,
}

/// Spawn a mock server that answers the first request with the given HTTP status
/// and body, then closes. `content_type` sets the response header.
pub fn spawn(status: u16, content_type: &str, body: &str) -> MockServer {
    let content_type = content_type.to_string();
    let body = body.to_string();
    let (tx, rx) = oneshot::channel();

    // Bind synchronously so `base_url` is known before we return.
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind mock");
    std_listener.set_nonblocking(true).expect("nonblocking");
    let addr = std_listener.local_addr().expect("local_addr");
    let base_url = format!("http://{addr}");

    tokio::spawn(async move {
        let listener = TcpListener::from_std(std_listener).expect("from_std");
        let (mut socket, _) = listener.accept().await.expect("accept");

        // Read the full request: headers, then body per Content-Length.
        let mut buf: Vec<u8> = Vec::new();
        let mut tmp = [0u8; 4096];
        let header_end = loop {
            if let Some(pos) = find_double_crlf(&buf) {
                break pos;
            }
            let n = socket.read(&mut tmp).await.expect("read head");
            if n == 0 {
                break buf.len();
            }
            buf.extend_from_slice(&tmp[..n]);
        };

        let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
        let content_length = parse_content_length(&head);
        let mut body_bytes = buf[(header_end + 4).min(buf.len())..].to_vec();
        while body_bytes.len() < content_length {
            let n = socket.read(&mut tmp).await.expect("read body");
            if n == 0 {
                break;
            }
            body_bytes.extend_from_slice(&tmp[..n]);
        }

        let _ = tx.send(CapturedRequest {
            head,
            body: String::from_utf8_lossy(&body_bytes).to_string(),
        });

        let reason = reason_phrase(status);
        let response = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await.expect("write");
        socket.flush().await.expect("flush");
    });

    MockServer {
        base_url,
        captured: rx,
    }
}

fn find_double_crlf(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_content_length(head: &str) -> usize {
    head.lines()
        .find_map(|line| {
            let (k, v) = line.split_once(':')?;
            if k.trim().eq_ignore_ascii_case("content-length") {
                v.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0)
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "Status",
    }
}
