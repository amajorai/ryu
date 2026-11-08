//! End-to-end OAuth service injection against a local fake upstream, with a
//! fake token source. Nothing here reaches the network.

use std::sync::Mutex;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use super::*;
use crate::identity::{ConnectionAccessLevel, ConnectionAction};
use crate::vault::broker::netguard::Cidr;
use crate::vault::broker::oauth::OAuthTokens;
use crate::vault::broker::services::{test_service, ServiceAuth};
use crate::vault::broker::sessions::{MintRequest, MinterScope};

const ACCESS_TOKEN: &str = "oauth-access-7f3a";

/// A token source with a fixed status and token result that records who
/// asked; a forced refresh returns the token with a `-refreshed` suffix.
struct FakeTokens {
    status: OAuthStatus,
    token: Result<String, String>,
    /// The connection's access level; actions it does not allow are refused
    /// like the real token source refuses them.
    level: ConnectionAccessLevel,
    calls: Mutex<Vec<(String, ConnectionAction, bool)>>,
}

impl FakeTokens {
    fn new(status: OAuthStatus, token: Result<&str, &str>) -> Arc<Self> {
        Self::with_level(status, token, ConnectionAccessLevel::Full)
    }

    fn with_level(
        status: OAuthStatus,
        token: Result<&str, &str>,
        level: ConnectionAccessLevel,
    ) -> Arc<Self> {
        Arc::new(Self {
            status,
            token: token.map(str::to_owned).map_err(str::to_owned),
            level,
            calls: Mutex::new(Vec::new()),
        })
    }
}

#[async_trait::async_trait]
impl OAuthTokens for FakeTokens {
    async fn status(&self, _owner: &str, _binding: &OAuthBinding) -> OAuthStatus {
        self.status.clone()
    }

    async fn access_token(
        &self,
        owner: &str,
        _binding: &OAuthBinding,
        action: ConnectionAction,
        _session_id: &str,
        force_refresh: bool,
    ) -> anyhow::Result<String> {
        self.calls
            .lock()
            .unwrap()
            .push((owner.to_owned(), action, force_refresh));
        if !self.level.allows(action) {
            anyhow::bail!("MCP connection access level denied this action");
        }
        let token = self.token.clone().map_err(|error| anyhow::anyhow!(error))?;
        Ok(if force_refresh {
            format!("{token}-refreshed")
        } else {
            token
        })
    }
}

/// An upstream that answers `401` to a request bearing `reject` and `200`
/// to anything else, reporting each raw request.
async fn fake_upstream(reject: Option<&'static str>) -> (u16, mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let request = read_all(&mut stream).await;
            // `token*` rejects every token that starts with `token`.
            let rejected = reject.is_some_and(|token| {
                let header = match token.strip_suffix('*') {
                    Some(prefix) => format!("authorization: bearer {prefix}"),
                    None => format!("authorization: bearer {token}\r\n"),
                };
                request.to_ascii_lowercase().contains(&header)
            });
            let _ = tx.send(request);
            let reply: &[u8] = if rejected {
                b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            } else {
                b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok"
            };
            let _ = stream.write_all(reply).await;
            let _ = stream.shutdown().await;
        }
    });
    (port, rx)
}

/// Read one HTTP/1 message: headers plus a Content-Length body.
async fn read_all(stream: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
            let length = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if buf.len() >= end + 4 + length {
                break;
            }
        }
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// A broker with one OAuth service on the fake upstream and an `alice`
/// session for it; returns the broker port, the session token, the upstream
/// port, and the upstream's request feed.
async fn setup(
    tokens: Arc<FakeTokens>,
    scopes: &[&str],
    reject: Option<&'static str>,
) -> (u16, String, u16, mpsc::UnboundedReceiver<String>) {
    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    let (upstream, seen) = fake_upstream(reject).await;
    let mut service = test_service("lin", "127.0.0.1", Some(upstream), "/");
    service.allow_insecure_http = true;
    service.auth = ServiceAuth::OAuth(OAuthBinding {
        plugin: "@ryu/linear".into(),
        server: "linear".into(),
        profile: "personal".into(),
        resource: format!("http://127.0.0.1:{upstream}/mcp"),
        client_id: None,
        scopes: scopes.iter().map(|scope| (*scope).to_owned()).collect(),
    });
    let token = {
        let conn = store.conn.lock().await;
        services::insert(&conn, service.normalize().unwrap()).unwrap();
        let request = MintRequest {
            environment: "default".into(),
            services: vec!["lin".into()],
            label: "test".into(),
            ttl_secs: None,
            minted_by: "user:alice".into(),
            not_after: None,
            minted_token: None,
            minter_scope: Some(MinterScope {
                subjects: vec!["user:alice".into()],
                manager: true,
            }),
        };
        sessions::mint(&conn, request).unwrap().0
    };
    let config = BrokerConfig {
        guard: crate::vault::broker::netguard::NetGuard {
            allow_private: false,
            allowlist: vec![Cidr::parse("127.0.0.0/8").unwrap()],
        },
        ..BrokerConfig::defaults()
    };
    let (broker, listener) = Broker::bind_with_oauth(store, config, tokens)
        .await
        .unwrap();
    let port = broker.port();
    tokio::spawn(broker.serve(listener));
    (port, token, upstream, seen)
}

async fn send(port: u16, token: &str, method: &str, upstream_url: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let request = format!(
        "{method} {upstream_url} HTTP/1.1\r\nHost: upstream\r\nProxy-Authorization: Bearer {token}\r\nAuthorization: Bearer agent-supplied\r\ncontent-length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    read_all(&mut stream).await
}

fn upstream_url(seen_port: u16) -> String {
    format!("http://127.0.0.1:{seen_port}/v1/issues")
}

fn connected() -> OAuthStatus {
    OAuthStatus::of(OAuthState::Connected)
}

#[tokio::test]
async fn connected_services_get_the_minters_access_token() {
    let tokens = FakeTokens::new(connected(), Ok(ACCESS_TOKEN));
    let (port, token, upstream, mut seen) = setup(tokens.clone(), &["read"], None).await;
    let response = send(port, &token, "POST", &upstream_url(upstream)).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(!response.contains(ACCESS_TOKEN));
    let request = seen.recv().await.unwrap().to_ascii_lowercase();
    assert!(
        request.contains(&format!("authorization: bearer {ACCESS_TOKEN}")),
        "{request}"
    );
    assert!(!request.contains("agent-supplied"));
    assert!(!request.contains("proxy-authorization"));
    assert_eq!(
        tokens.calls.lock().unwrap().as_slice(),
        &[("alice".to_owned(), ConnectionAction::Write, false)]
    );
}

#[tokio::test]
async fn missing_scopes_refuse_before_any_token_is_fetched() {
    let status = OAuthStatus {
        state: OAuthState::NeedsScopes,
        missing_scopes: vec!["write".into()],
        expires_at: None,
    };
    let tokens = FakeTokens::new(status, Ok(ACCESS_TOKEN));
    let (port, token, upstream, mut seen) = setup(tokens.clone(), &["read", "write"], None).await;
    let response = send(port, &token, "GET", &upstream_url(upstream)).await;
    assert!(response.starts_with("HTTP/1.1 403"), "{response}");
    let lower = response.to_ascii_lowercase();
    assert!(lower.contains("x-ryu-broker-error: oauth_needs_scopes"));
    assert!(
        response.contains(r#""missingScopes":["write"]"#),
        "{response}"
    );
    assert!(response.contains(r#""service":"lin""#));
    assert!(tokens.calls.lock().unwrap().is_empty());
    assert!(seen.try_recv().is_err());
}

#[tokio::test]
async fn unconnected_and_failed_tokens_fail_closed() {
    let tokens = FakeTokens::new(OAuthStatus::of(OAuthState::NeedsConnect), Ok(ACCESS_TOKEN));
    let (port, token, upstream, mut seen) = setup(tokens, &[], None).await;
    let response = send(port, &token, "GET", &upstream_url(upstream)).await;
    assert!(response.starts_with("HTTP/1.1 428"), "{response}");
    assert!(response.contains("oauth_connect_required"));
    assert!(seen.try_recv().is_err());

    let tokens = FakeTokens::new(
        connected(),
        Err("MCP authentication expired; reconnect required"),
    );
    let (port, token, upstream, mut seen) = setup(tokens, &[], None).await;
    let response = send(port, &token, "GET", &upstream_url(upstream)).await;
    assert!(response.starts_with("HTTP/1.1 428"), "{response}");
    assert!(response.contains("oauth_reconnect_required"));
    assert!(!response.contains("expired"));
    assert!(seen.try_recv().is_err());
}

#[tokio::test]
async fn a_rejected_token_is_refreshed_once_and_resent() {
    let tokens = FakeTokens::new(connected(), Ok(ACCESS_TOKEN));
    let (port, token, upstream, mut seen) = setup(tokens.clone(), &[], Some(ACCESS_TOKEN)).await;
    let response = send(port, &token, "GET", &upstream_url(upstream)).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let first = seen.recv().await.unwrap().to_ascii_lowercase();
    assert!(first.contains(&format!("authorization: bearer {ACCESS_TOKEN}\r\n")));
    let second = seen.recv().await.unwrap().to_ascii_lowercase();
    assert!(
        second.contains(&format!("authorization: bearer {ACCESS_TOKEN}-refreshed")),
        "{second}"
    );
    assert!(seen.try_recv().is_err());
    let forced: Vec<bool> = tokens.calls.lock().unwrap().iter().map(|c| c.2).collect();
    assert_eq!(forced, vec![false, true]);
}

#[tokio::test]
async fn a_second_rejection_reaches_the_agent_without_another_refresh() {
    let tokens = FakeTokens::new(connected(), Ok(ACCESS_TOKEN));
    let every_token = Box::leak(format!("{ACCESS_TOKEN}*").into_boxed_str());
    let (port, token, upstream, mut seen) = setup(tokens.clone(), &[], Some(every_token)).await;
    let response = send(port, &token, "GET", &upstream_url(upstream)).await;
    assert!(response.starts_with("HTTP/1.1 401"), "{response}");
    assert!(seen.recv().await.is_some());
    assert!(seen.recv().await.is_some());
    assert!(seen.try_recv().is_err());
    assert_eq!(tokens.calls.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_read_only_connection_cannot_open_a_websocket() {
    let tokens = FakeTokens::with_level(
        connected(),
        Ok(ACCESS_TOKEN),
        ConnectionAccessLevel::ReadOnly,
    );
    let (port, token, upstream, mut seen) = setup(tokens.clone(), &[], None).await;
    // A plain GET reads, which the connection allows.
    let response = send(port, &token, "GET", &upstream_url(upstream)).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(seen.recv().await.is_some());

    // The upgrade is a GET too, but the channel can write and delete.
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: upstream\r\nProxy-Authorization: Bearer {token}\r\n\
         Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
         Sec-WebSocket-Version: 13\r\n\r\n",
        upstream_url(upstream)
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let response = read_all(&mut stream).await;
    assert!(response.starts_with("HTTP/1.1 403"), "{response}");
    assert!(response.contains("oauth_access_denied"), "{response}");
    assert!(!response.contains(ACCESS_TOKEN));
    assert!(
        tokio::time::timeout(Duration::from_millis(200), seen.recv())
            .await
            .is_err(),
        "nothing is sent upstream"
    );
    let actions: Vec<ConnectionAction> = tokens
        .calls
        .lock()
        .unwrap()
        .iter()
        .map(|call| call.1)
        .collect();
    assert_eq!(
        actions,
        vec![ConnectionAction::Read, ConnectionAction::Delete]
    );
}
