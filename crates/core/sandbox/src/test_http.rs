//! Scripted loopback HTTP/1.1 server for backend unit tests.
//!
//! Each accepted connection carries one request. The script sees the request's
//! zero-based index and raw text and returns either a full response (written
//! with `Connection: close`) or `None` to hold the connection open without
//! answering, which lets a test drive the client's request timeout.

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Hard cap on a test server's lifetime so a broken client cannot hang a test.
const SERVER_DEADLINE: Duration = Duration::from_secs(20);

pub(crate) struct ScriptedServer {
    /// `http://127.0.0.1:<port>` with no trailing slash.
    pub(crate) base_url: String,
    stop: Arc<AtomicBool>,
    handle: JoinHandle<Vec<String>>,
}

impl ScriptedServer {
    /// Start serving `script` on an ephemeral loopback port.
    pub(crate) fn start<F>(script: F) -> Self
    where
        F: Fn(usize, &str) -> Option<String> + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback test server");
        listener
            .set_nonblocking(true)
            .expect("make test listener non-blocking");
        let base_url = format!(
            "http://{}",
            listener.local_addr().expect("test server address")
        );
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = Arc::clone(&stop);
        let handle = std::thread::spawn(move || serve(&listener, &stop_flag, &script));
        Self {
            base_url,
            stop,
            handle,
        }
    }

    /// Stop accepting and return every request received, in arrival order.
    pub(crate) fn finish(self) -> Vec<String> {
        self.stop.store(true, Ordering::SeqCst);
        self.handle.join().expect("test server thread")
    }
}

fn serve<F>(listener: &TcpListener, stop: &AtomicBool, script: &F) -> Vec<String>
where
    F: Fn(usize, &str) -> Option<String>,
{
    let deadline = Instant::now() + SERVER_DEADLINE;
    let mut requests = Vec::new();
    // Unanswered connections stay open until the server stops.
    let mut held = Vec::new();
    while !stop.load(Ordering::SeqCst) && Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream
                    .set_nonblocking(false)
                    .expect("make test stream blocking");
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .expect("set test stream read timeout");
                let request = read_request(&mut stream);
                let reply = script(requests.len(), &request);
                requests.push(request);
                match reply {
                    Some(response) => {
                        // The client may already have given up on this request.
                        let _ = stream.write_all(response.as_bytes());
                    }
                    None => held.push(stream),
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("test server accept failed: {error}"),
        }
    }
    drop(held);
    requests
}

/// Read one request: headers plus a `Content-Length` body, so the socket is
/// drained before the reply (closing with unread bytes would reset it).
fn read_request(stream: &mut TcpStream) -> String {
    let mut data = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let count = match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        data.extend_from_slice(&buffer[..count]);
        let Some(head_end) = data.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let head = String::from_utf8_lossy(&data[..head_end]).to_ascii_lowercase();
        let body_len = head
            .lines()
            .find_map(|line| line.strip_prefix("content-length:"))
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        if data.len() >= head_end + 4 + body_len {
            break;
        }
    }
    String::from_utf8_lossy(&data).into_owned()
}

/// A complete `Connection: close` JSON response.
pub(crate) fn json_response(status: u16, body: &str) -> String {
    format!(
        "HTTP/1.1 {status} Scripted\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

/// The request line (`METHOD /path HTTP/1.1`) of a recorded request.
pub(crate) fn request_line(request: &str) -> &str {
    request.lines().next().unwrap_or_default()
}

/// The body of a recorded request (everything after the blank line).
pub(crate) fn request_body(request: &str) -> &str {
    request
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or_default()
}

/// A header value from a recorded request, matched case-insensitively.
pub(crate) fn request_header<'a>(request: &'a str, name: &str) -> Option<&'a str> {
    let head = request
        .split_once("\r\n\r\n")
        .map_or(request, |(head, _)| head);
    head.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
    })
}
