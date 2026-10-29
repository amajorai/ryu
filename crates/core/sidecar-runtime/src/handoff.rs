//! Let a second process reach the store through the running sidecar.
//!
//! The store is sealed with the plugin subkey Core delivers to the sidecar
//! only. The stdio `mcp` server Core registers from the manifest gets no key,
//! so it cannot open a store the sidecar has sealed, and a keyless process must
//! never write plaintext into it. Instead of opening the database it calls the
//! sidecar:
//!
//! - at startup the sidecar writes `secrets/sidecar-handoff.json` (0600) under
//!   its plugin data dir: its loopback port and a random token minted for this
//!   run (never the Core ext token);
//! - that token opens only the routes under [`Handoff`]'s mount prefix that the
//!   sidecar passes to [`authorize`];
//! - the file is replaced on every start and removed on shutdown, so a copied
//!   data dir or backup carries no usable credential once the sidecar restarts.
//!
//! When no sidecar answers, the caller falls back to opening the store itself
//! (which works for a store that is unsealed or whose key it holds).
//!
//! The client speaks plain HTTP/1.1 to `127.0.0.1` only (no proxy, no TLS),
//! with `Connection: close`, so it needs no HTTP client dependency.
//!
//! Shared by every Rust app satellite that hands its MCP server off to its
//! sidecar (behind this crate's `handoff` feature); satellites never depend on
//! `apps/core`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use rand::RngCore as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The handoff file, under `<plugin data dir>/secrets/`.
pub const HANDOFF_FILE: &str = "sidecar-handoff.json";

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

/// What the sidecar publishes for local callers.
#[derive(Clone, Serialize, Deserialize)]
pub struct Handoff {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

impl std::fmt::Debug for Handoff {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Handoff")
            .field("port", &self.port)
            .field("pid", &self.pid)
            .finish_non_exhaustive()
    }
}

fn handoff_path(data_dir: &Path) -> PathBuf {
    data_dir.join("secrets").join(HANDOFF_FILE)
}

/// Mint a token for this run and publish it with `port` (sidecar only).
pub fn publish(data_dir: &Path, port: u16) -> Result<Handoff> {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let handoff = Handoff {
        port,
        token: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes),
        pid: std::process::id(),
    };
    let path = handoff_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    let body = serde_json::to_vec(&handoff).context("serialize the sidecar handoff")?;
    write_private_file(&path, &body)?;
    Ok(handoff)
}

/// Write `bytes` to `path` through an owner-only temp file in the same
/// directory and a rename, so a crash never leaves a half-written file.
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = temp_sibling(path);
    if let Err(error) = write_new_private_file(&tmp, bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    std::fs::rename(&tmp, path).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        anyhow!("replacing {}: {error}", path.display())
    })
}

fn write_new_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write as _;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("creating {}", path.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn temp_sibling(path: &Path) -> PathBuf {
    let mut nonce = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut nonce);
    let suffix: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.{suffix}.tmp"))
}

/// Remove the handoff this process published (best effort, on shutdown).
pub fn withdraw(data_dir: &Path, handoff: &Handoff) {
    if load(data_dir).is_some_and(|current| current.token == handoff.token) {
        let _ = std::fs::remove_file(handoff_path(data_dir));
    }
}

/// Read the published handoff, if any.
pub fn load(data_dir: &Path) -> Option<Handoff> {
    let bytes = std::fs::read(handoff_path(data_dir)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Whether a request may pass: the Core ext token opens every route; the
/// handoff token opens only paths under one of `handoff_prefixes`.
pub fn authorize(
    provided: Option<&str>,
    ext_token: Option<&str>,
    handoff_token: Option<&str>,
    path: &str,
    handoff_prefixes: &[&str],
) -> bool {
    if crate::token_ok(provided, ext_token) {
        return true;
    }
    let (Some(provided), Some(handoff)) = (provided, handoff_token) else {
        return false;
    };
    let path = path.trim_end_matches('/');
    handoff_prefixes.iter().any(|prefix| {
        let prefix = prefix.trim_end_matches('/');
        path == prefix
            || path
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with('/'))
    }) && crate::token_ok(Some(provided), Some(handoff))
}

/// Resolve when SIGINT or SIGTERM arrives (graceful shutdown, so the handoff
/// file is withdrawn).
pub async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}

/// A client for the running sidecar's handoff routes.
#[derive(Clone)]
pub struct SidecarClient {
    port: u16,
    token: String,
}

impl std::fmt::Debug for SidecarClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SidecarClient")
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

/// One response from the sidecar.
#[derive(Debug)]
pub struct SidecarResponse {
    pub status: u16,
    pub body: Value,
}

impl SidecarClient {
    /// Connect to the sidecar that published a handoff in `data_dir`, when it
    /// answers its health probe.
    pub async fn connect(data_dir: &Path) -> Option<Self> {
        let handoff = load(data_dir)?;
        let client = Self {
            port: handoff.port,
            token: handoff.token,
        };
        let probe = tokio::time::timeout(
            PROBE_TIMEOUT,
            client.exchange("GET", "/health", None, false),
        )
        .await
        .ok()?
        .ok()?;
        (200..300).contains(&probe.status).then_some(client)
    }

    /// Call `method path` with an optional JSON body; any status is returned.
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<SidecarResponse> {
        tokio::time::timeout(CALL_TIMEOUT, self.exchange(method, path, body, true))
            .await
            .map_err(|_| anyhow!("the app sidecar did not answer in time"))?
    }

    /// [`Self::request`] that turns a non-2xx status into an error carrying
    /// the sidecar's `error` message.
    pub async fn call(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
        let response = self.request(method, path, body).await?;
        if !(200..300).contains(&response.status) {
            let message = response
                .body
                .get("error")
                .and_then(|error| error.get("message").or(Some(error)))
                .and_then(Value::as_str)
                .map_or_else(|| format!("HTTP {}", response.status), str::to_owned);
            bail!("{message}");
        }
        Ok(response.body)
    }

    async fn exchange(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        authorized: bool,
    ) -> Result<SidecarResponse> {
        if !path.starts_with('/') || path.contains(['\r', '\n', ' ']) {
            bail!("invalid sidecar path");
        }
        let payload = match body {
            Some(body) => serde_json::to_vec(body)?,
            None => Vec::new(),
        };
        let mut head = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nAccept: application/json\r\n",
            self.port
        );
        if authorized {
            head.push_str(&format!("Authorization: Bearer {}\r\n", self.token));
        }
        if body.is_some() {
            head.push_str("Content-Type: application/json\r\n");
        }
        head.push_str(&format!("Content-Length: {}\r\n\r\n", payload.len()));
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", self.port))
            .await
            .context("connect to the app sidecar")?;
        stream.write_all(head.as_bytes()).await?;
        stream.write_all(&payload).await?;
        stream.flush().await?;
        let mut raw = Vec::new();
        let mut chunk = [0u8; 16 * 1024];
        loop {
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                break;
            }
            raw.extend_from_slice(&chunk[..read]);
            if raw.len() > MAX_RESPONSE_BYTES {
                bail!("the app sidecar response is too large");
            }
        }
        parse_response(&raw)
    }
}

fn parse_response(raw: &[u8]) -> Result<SidecarResponse> {
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| anyhow!("malformed sidecar response"))?;
    let head = std::str::from_utf8(&raw[..split]).context("malformed sidecar response")?;
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| anyhow!("malformed sidecar status line"))?;
    let chunked = lines.any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("transfer-encoding:") && lower.contains("chunked")
    });
    let mut body = raw[split + 4..].to_vec();
    if chunked {
        body = dechunk(&body)?;
    }
    let body = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&body).into_owned()))
    };
    Ok(SidecarResponse { status, body })
}

fn dechunk(mut input: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = input
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| anyhow!("malformed chunked body"))?;
        let size_text = std::str::from_utf8(&input[..line_end])?;
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .context("malformed chunk size")?;
        input = &input[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if input.len() < size + 2 {
            bail!("truncated chunked body");
        }
        out.extend_from_slice(&input[..size]);
        input = &input[size + 2..];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let mut nonce = [0u8; 8];
        rand::thread_rng().fill_bytes(&mut nonce);
        let dir = std::env::temp_dir().join(format!(
            "ryu-handoff-{}",
            nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn handoff_is_private_replaced_and_withdrawn_only_by_its_owner() {
        let dir = tmp();
        let first = publish(&dir, 4100).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(handoff_path(&dir))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let second = publish(&dir, 4101).unwrap();
        assert_ne!(first.token, second.token);
        withdraw(&dir, &first);
        assert_eq!(load(&dir).unwrap().port, 4101, "a stale owner keeps out");
        withdraw(&dir, &second);
        assert!(load(&dir).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn handoff_token_opens_only_its_prefixes() {
        let ext = Some("ext-token");
        let handoff = Some("handoff-token");
        let prefixes = ["/api/app/items", "/api/app/summary"];
        assert!(authorize(
            Some("ext-token"),
            ext,
            handoff,
            "/api/app/admin",
            &prefixes
        ));
        assert!(authorize(
            Some("handoff-token"),
            ext,
            handoff,
            "/api/app/items",
            &prefixes
        ));
        assert!(authorize(
            Some("handoff-token"),
            ext,
            handoff,
            "/api/app/items/x1",
            &prefixes
        ));
        assert!(!authorize(
            Some("handoff-token"),
            ext,
            handoff,
            "/api/app/itemsx",
            &prefixes
        ));
        assert!(!authorize(
            Some("handoff-token"),
            ext,
            handoff,
            "/api/app/admin",
            &prefixes
        ));
        assert!(!authorize(
            Some("wrong"),
            ext,
            handoff,
            "/api/app/items",
            &prefixes
        ));
        assert!(!authorize(None, ext, handoff, "/api/app/items", &prefixes));
    }

    #[test]
    fn responses_parse_with_length_or_chunks() {
        let plain = b"HTTP/1.1 200 OK\r\ncontent-length: 11\r\n\r\n{\"ok\":true}";
        let parsed = parse_response(plain).unwrap();
        assert_eq!(parsed.status, 200);
        assert_eq!(parsed.body["ok"], true);
        let chunked =
            b"HTTP/1.1 404 Not Found\r\ntransfer-encoding: chunked\r\n\r\n5\r\n{\"err\r\n9\r\nor\":\"no\"}\r\n0\r\n\r\n";
        let parsed = parse_response(chunked).unwrap();
        assert_eq!(parsed.status, 404);
        assert_eq!(parsed.body["error"], "no");
    }
}
