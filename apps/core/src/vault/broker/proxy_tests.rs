//! End-to-end broker tests against local fake upstreams (plain HTTP, TLS, and
//! a raw TCP echo). Nothing here reaches the network.

use std::sync::Arc;

use base64::Engine as _;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use super::*;
use crate::plugin_secrets::{SecretCoords, SecretScope, VersionSource, WriteRequest};
use crate::vault::audit::AuditActor;
use crate::vault::broker::netguard::Cidr;
use crate::vault::broker::services::{test_service, ServiceInput, Substitution};
use crate::vault::broker::sessions::{MintRequest, MinterScope};

const TOKEN_VALUE: &str = "real-token-123";
const QUERY_VALUE: &str = "q value&x";

fn leak_store() -> &'static PluginSecretStore {
    Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()))
}

async fn put_secret(store: &PluginSecretStore, name: &str, value: &str) {
    store
        .write_secret(WriteRequest {
            coords: SecretCoords {
                scope: SecretScope::Node,
                scope_id: super::super::local_node_id(),
                environment: "default".into(),
                path: "/".into(),
                binding: None,
                name: name.into(),
            },
            value: Some(value),
            patch: Default::default(),
            actor: &AuditActor::system(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
}

async fn add_service(store: &PluginSecretStore, input: ServiceInput) {
    let conn = store.conn.lock().await;
    services::insert(&conn, input.normalize().unwrap()).unwrap();
}

async fn mint(store: &PluginSecretStore, services: &[&str]) -> (String, BrokerSession) {
    // The unbound local operator: a manager with every capability.
    let operator = MinterScope {
        subjects: Vec::new(),
        manager: true,
    };
    mint_as(store, services, "operator", operator).await
}

async fn mint_as(
    store: &PluginSecretStore,
    services: &[&str],
    minted_by: &str,
    scope: MinterScope,
) -> (String, BrokerSession) {
    let conn = store.conn.lock().await;
    sessions::mint(
        &conn,
        MintRequest {
            environment: "default".into(),
            services: services.iter().map(|s| (*s).to_owned()).collect(),
            label: "test".into(),
            ttl_secs: None,
            minted_by: minted_by.into(),
            not_after: None,
            minted_token: None,
            minter_scope: Some(scope),
        },
    )
    .unwrap()
}

fn loopback_config() -> BrokerConfig {
    BrokerConfig {
        guard: NetGuard {
            allow_private: false,
            allowlist: vec![
                Cidr::parse("127.0.0.0/8").unwrap(),
                Cidr::parse("::1").unwrap(),
            ],
        },
        ..BrokerConfig::defaults()
    }
}

async fn start(store: &'static PluginSecretStore, config: BrokerConfig) -> u16 {
    let (broker, listener) = Broker::bind(store, config).await.unwrap();
    let port = broker.port();
    tokio::spawn(broker.serve(listener));
    port
}

/// Read one HTTP/1 message (headers plus a Content-Length body).
async fn read_message<S: AsyncRead + Unpin>(stream: &mut S) -> String {
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

async fn serve_fake<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    seen: &mpsc::UnboundedSender<String>,
) {
    let request = read_message(&mut stream).await;
    let _ = seen.send(request);
    let _ = stream
        .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
        .await;
    let _ = stream.shutdown().await;
}

/// A plain HTTP upstream that reports each raw request it receives.
async fn fake_http_upstream() -> (u16, mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            serve_fake(stream, &tx).await;
        }
    });
    (port, rx)
}

/// A TLS upstream for `localhost` signed by its own test CA; returns the CA.
async fn fake_tls_upstream() -> (u16, String, mpsc::UnboundedReceiver<String>) {
    use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair};
    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "fake upstream CA");
    let ca_pem = ca_params.self_signed(&ca_key).unwrap().pem();
    let issuer = Issuer::new(ca_params, &ca_key);
    let leaf_key = KeyPair::generate().unwrap();
    let leaf = CertificateParams::new(vec!["localhost".to_owned()])
        .unwrap()
        .signed_by(&leaf_key, &issuer)
        .unwrap();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![leaf.der().clone()],
        rustls::pki_types::PrivateKeyDer::Pkcs8(leaf_key.serialize_der().into()),
    )
    .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            if let Ok(tls) = acceptor.accept(stream).await {
                serve_fake(tls, &tx).await;
            }
        }
    });
    (port, ca_pem, rx)
}

async fn send_raw(port: u16, request: String) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    read_message(&mut stream).await
}

fn get_via_proxy(target: &str, token: Option<&str>, extra: &str) -> String {
    let auth = token
        .map(|token| format!("Proxy-Authorization: Bearer {token}\r\n"))
        .unwrap_or_default();
    format!("GET {target} HTTP/1.1\r\nHost: upstream\r\n{auth}{extra}Connection: close\r\n\r\n")
}

async fn log_rows(store: &PluginSecretStore) -> Vec<LogRow> {
    let conn = store.conn.lock().await;
    log::list(&conn, &log::LogFilter::default()).unwrap()
}

/// CONNECT to `localhost:{upstream}` through the broker and complete TLS
/// against the broker CA.
async fn intercepted_tls(
    store: &PluginSecretStore,
    port: u16,
    upstream: u16,
    token: &str,
) -> tokio_rustls::client::TlsStream<TcpStream> {
    let mut tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    tcp.write_all(
        format!(
            "CONNECT localhost:{upstream} HTTP/1.1\r\nHost: localhost:{upstream}\r\nProxy-Authorization: Bearer {token}\r\n\r\n"
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let established = read_message(&mut tcp).await;
    assert!(established.starts_with("HTTP/1.1 200"), "{established}");
    let broker_ca = ca::certificate_pem(store).await.unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots.add(ca::pem_to_der(&broker_ca).unwrap()).unwrap();
    let client = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(client));
    let server_name = rustls::pki_types::ServerName::try_from("localhost").unwrap();
    connector.connect(server_name, tcp).await.unwrap()
}

/// A TCP echo server that echoes until the peer closes.
async fn echo_server() -> u16 {
    let echo = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = echo.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = echo.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 256];
                loop {
                    match stream.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if stream.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });
    port
}

async fn open_raw_tunnel(port: u16, echo_port: u16, token: &str) -> (TcpStream, String) {
    let mut tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    tcp.write_all(
        format!(
            "CONNECT 127.0.0.1:{echo_port} HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Authorization: Bearer {token}\r\n\r\n"
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let response = read_message(&mut tcp).await;
    (tcp, response)
}

#[path = "proxy/cards_tests.rs"]
mod cards;
#[path = "proxy/forwarding_tests.rs"]
mod forwarding;
#[path = "proxy/password_manager_tests.rs"]
mod password_managers;
#[path = "proxy/tunnel_tests.rs"]
mod tunnels;
