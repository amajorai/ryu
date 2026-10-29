//! Box session client tests. Shared fakes and fixtures live here; the tests
//! are grouped by topic.

use super::commands::validate_run_id;
use super::*;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const BOX_ID: &str = "bx_0123456789abcdef0123456789abcdef";

#[derive(Clone, Debug)]
struct Captured {
    head: String,
    body: String,
}

impl Captured {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap()
    }

    fn header(&self, name: &str) -> Option<String> {
        let prefix = format!("{}:", name.to_ascii_lowercase());
        self.head.lines().find_map(|line| {
            line.to_ascii_lowercase()
                .starts_with(&prefix)
                .then(|| line[prefix.len()..].trim().to_owned())
        })
    }

    fn request_line(&self) -> &str {
        self.head.lines().next().unwrap_or_default()
    }
}

/// A fake Box: serves the canned `(status, body)` responses in order,
/// one per connection, and captures every request.
async fn fake_box(responses: Vec<(u16, &'static str)>) -> (String, Arc<Mutex<Vec<Captured>>>) {
    fake_box_with_headers(
        responses
            .into_iter()
            .map(|(status, body)| (status, "", body))
            .collect(),
    )
    .await
}

/// [`fake_box`] with extra raw header lines (each ending in `\r\n`) per
/// response.
async fn fake_box_with_headers(
    responses: Vec<(u16, &'static str, &'static str)>,
) -> (String, Arc<Mutex<Vec<Captured>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let captured = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&captured);
    tokio::spawn(async move {
        for (status, extra_headers, body) in responses {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_request(&mut stream).await;
            sink.lock().unwrap().push(request);
            let response = format!(
                    "HTTP/1.1 {status} Canned\r\nContent-Type: application/json\r\n{extra_headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.shutdown().await.ok();
        }
    });
    (format!("http://{address}/v1"), captured)
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> Captured {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    let header_end = loop {
        let count = stream.read(&mut buffer).await.unwrap();
        assert!(count > 0, "client closed before sending headers");
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let head = String::from_utf8_lossy(&bytes[..header_end]).into_owned();
    let length = head
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|value| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    while bytes.len() < header_end + length {
        let count = stream.read(&mut buffer).await.unwrap();
        assert!(count > 0, "client closed before sending the body");
        bytes.extend_from_slice(&buffer[..count]);
    }
    Captured {
        head,
        body: String::from_utf8_lossy(&bytes[header_end..header_end + length]).into_owned(),
    }
}

fn workspace() -> WorkspaceId {
    WorkspaceId(BOX_ID.to_owned())
}

fn prompt_spec(env_value: &str) -> ManagedPromptSpec {
    ManagedPromptSpec {
        provider: ManagedProvider::Codex,
        text: "fix the failing test".into(),
        cwd: "repo".into(),
        env: vec![("OPENAI_API_KEY".into(), env_value.into())],
        timeout_secs: 600,
    }
}

fn session_spec(size: BoxSize) -> DisposableBoxSpec {
    let mut labels = BTreeMap::new();
    labels.insert("session".to_owned(), "conv-1".to_owned());
    labels.insert("owner".to_owned(), "user-hash".to_owned());
    DisposableBoxSpec {
        name: "ryu-session-1".into(),
        image: None,
        network: BoxNetwork::Egress,
        ttl_seconds: 14_400,
        setup: Vec::new(),
        size,
        desktop: true,
        labels,
    }
}

const READY_BOX: &str = r#"{"ok":true,"box":{"id":"bx_0123456789abcdef0123456789abcdef","status":"ready","size":"large","runningSince":"2026-10-19T04:00:00.000Z","desktop":{"ready":true,"viewers":1,"width":1280,"height":800},"placement":{"tier":"hetzner","provider":"hetzner","location":"nbg1","serverType":"cx43","isolation":"vm"}}}"#;

mod client_tests;
mod session_create_tests;
mod session_verb_tests;
