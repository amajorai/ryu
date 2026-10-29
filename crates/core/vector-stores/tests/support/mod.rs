//! A tiny scripted HTTP/1.1 server for backend wire tests.
//!
//! Every request is recorded (method, path with query, headers, JSON body) and
//! answered by the test's handler. One request per connection (`connection:
//! close`), which reqwest handles transparently.

#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

type Handler = dyn Fn(&Recorded) -> (u16, Value) + Send + Sync;

pub struct MockServer {
    pub url: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
}

impl MockServer {
    pub async fn start(
        handler: impl Fn(&Recorded) -> (u16, Value) + Send + Sync + 'static,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let handler: Arc<Handler> = Arc::new(handler);
        let log = Arc::clone(&requests);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let handler = Arc::clone(&handler);
                let log = Arc::clone(&log);
                tokio::spawn(async move {
                    let Some(request) = read_request(&mut socket).await else {
                        return;
                    };
                    let (status, body) = handler(&request);
                    log.lock().unwrap().push(request);
                    // `{"$location": url}` answers with a `location` header (redirect tests).
                    let location = body["$location"]
                        .as_str()
                        .map(|url| format!("location: {url}\r\n"))
                        .unwrap_or_default();
                    let payload = if body.is_null() || !location.is_empty() {
                        String::new()
                    } else {
                        body.to_string()
                    };
                    let response = format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n{location}content-length: {}\r\nconnection: close\r\n\r\n{payload}",
                        payload.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        Self { url, requests }
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }

    /// The single recorded request for `method` + `path` (ignoring a query string).
    pub fn find(&self, method: &str, path: &str) -> Recorded {
        let matches: Vec<_> = self
            .requests()
            .into_iter()
            .filter(|r| r.method == method && r.path.split('?').next() == Some(path))
            .collect();
        assert_eq!(
            matches.len(),
            1,
            "expected one {method} {path}, got {matches:?}"
        );
        matches.into_iter().next().unwrap()
    }
}

async fn read_request(socket: &mut tokio::net::TcpStream) -> Option<Recorded> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(position) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break position + 4;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_owned();
    let path = request_line.next()?.to_owned();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect();
    let length = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    while buffer.len() < header_end + length {
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let body_bytes = &buffer[header_end..(header_end + length).min(buffer.len())];
    let body = if body_bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(body_bytes).unwrap_or(Value::Null)
    };
    Some(Recorded {
        method,
        path,
        headers,
        body,
    })
}
