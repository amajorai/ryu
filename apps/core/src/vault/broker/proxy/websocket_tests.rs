//! End-to-end WebSocket brokering against local upstreams (plain and TLS).
//! Nothing here reaches the network.

use futures_util::{SinkExt as _, StreamExt as _};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::{frame::coding::CloseCode, Role};
use tokio_tungstenite::tungstenite::Message;

use super::*;
use crate::plugin_secrets::{SecretCoords, SecretScope, VersionSource, WriteRequest};
use crate::vault::audit::AuditActor;
use crate::vault::broker::netguard::Cidr;
use crate::vault::broker::services::{test_service, ServiceInput, Substitution};
use crate::vault::broker::sessions::{MintRequest, MinterScope};

pub(super) const AUTH_VALUE: &str = "real-auth-token";
const KEY_VALUE: &str = "ws-key-\"value\"";

pub(super) fn leak_store() -> &'static PluginSecretStore {
    Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()))
}

pub(super) async fn put_secret(store: &PluginSecretStore, name: &str, value: &str) {
    store
        .write_secret(WriteRequest {
            coords: SecretCoords {
                scope: SecretScope::Node,
                scope_id: super::super::super::local_node_id(),
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

pub(super) async fn add_service(store: &PluginSecretStore, input: ServiceInput) {
    let conn = store.conn.lock().await;
    services::insert(&conn, input.normalize().unwrap()).unwrap();
}

async fn mint(store: &PluginSecretStore) -> (String, BrokerSession) {
    let conn = store.conn.lock().await;
    sessions::mint(
        &conn,
        MintRequest {
            environment: "default".into(),
            services: vec!["ws".into()],
            label: "test".into(),
            ttl_secs: None,
            minted_by: "operator".into(),
            not_after: None,
            minted_token: None,
            minter_scope: Some(MinterScope {
                subjects: Vec::new(),
                manager: true,
            }),
        },
    )
    .unwrap()
}

pub(super) fn config(extra_roots: Vec<String>) -> BrokerConfig {
    BrokerConfig {
        guard: NetGuard {
            allow_private: false,
            allowlist: vec![Cidr::parse("127.0.0.0/8").unwrap()],
        },
        extra_upstream_roots_pem: extra_roots,
        session_check_interval: Duration::from_millis(50),
        ..BrokerConfig::defaults()
    }
}

pub(super) async fn start(store: &'static PluginSecretStore, config: BrokerConfig) -> u16 {
    let (broker, listener) = Broker::bind(store, config).await.unwrap();
    let port = broker.port();
    tokio::spawn(broker.serve(listener));
    port
}

/// What the upstream saw: handshake headers, then each message received.
pub(super) enum Seen {
    Handshake(HeaderMap),
    Message(Message),
}

/// Accept one WebSocket on `stream`, report it, and echo every data message.
async fn serve_echo<S>(stream: S, seen: mpsc::UnboundedSender<Seen>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let report = seen.clone();
    let callback = move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                         response| {
        let _ = report.send(Seen::Handshake(request.headers().clone()));
        Ok(response)
    };
    let Ok(mut socket) = tokio_tungstenite::accept_hdr_async(stream, callback).await else {
        return;
    };
    while let Some(Ok(message)) = socket.next().await {
        if message.is_text() || message.is_binary() {
            let _ = seen.send(Seen::Message(message.clone()));
            if socket.send(message).await.is_err() {
                return;
            }
        }
    }
}

async fn plain_echo_upstream() -> (u16, mpsc::UnboundedReceiver<Seen>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(serve_echo(stream, tx.clone()));
        }
    });
    (port, rx)
}

/// A TLS echo upstream for `localhost`; returns its CA.
pub(super) async fn tls_echo_upstream() -> (u16, String, mpsc::UnboundedReceiver<Seen>) {
    use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair};
    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let ca_pem = ca_params.self_signed(&ca_key).unwrap().pem();
    let issuer = Issuer::new(ca_params, &ca_key);
    let leaf_key = KeyPair::generate().unwrap();
    let leaf = CertificateParams::new(vec!["localhost".to_owned()])
        .unwrap()
        .signed_by(&leaf_key, &issuer)
        .unwrap();
    let server = rustls::ServerConfig::builder_with_provider(Arc::new(
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
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            if let Ok(tls) = acceptor.accept(stream).await {
                tokio::spawn(serve_echo(tls, tx.clone()));
            }
        }
    });
    (port, ca_pem, rx)
}

/// Read an HTTP response head (through the blank line) byte by byte, so no
/// frame bytes after it are consumed.
async fn read_head<S: tokio::io::AsyncRead + Unpin>(stream: &mut S) -> String {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        match stream.read_u8().await {
            Ok(byte) => head.push(byte),
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&head).into_owned()
}

/// CONNECT through the broker and complete TLS against the broker CA.
pub(super) async fn intercepted(
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
    let established = read_head(&mut tcp).await;
    assert!(established.starts_with("HTTP/1.1 200"), "{established}");
    let mut roots = rustls::RootCertStore::empty();
    let broker_ca = ca::certificate_pem(store).await.unwrap();
    roots.add(ca::pem_to_der(&broker_ca).unwrap()).unwrap();
    let client = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(client));
    let name = rustls::pki_types::ServerName::try_from("localhost").unwrap();
    connector.connect(name, tcp).await.unwrap()
}

pub(super) fn ws_service(port: u16, reference: &str) -> ServiceInput {
    let mut service = test_service("ws", "localhost", Some(port), "/");
    service.auth = ServiceAuth::Bearer {
        token: "secret:WS_AUTH".into(),
    };
    service.substitutions = vec![Substitution {
        placeholder: "__WS_KEY__".into(),
        reference: reference.into(),
        surfaces: vec![Surface::WebSocket],
    }];
    service
}

pub(super) async fn next_message(seen: &mut mpsc::UnboundedReceiver<Seen>) -> Message {
    loop {
        if let Seen::Message(message) = seen.recv().await.unwrap() {
            return message;
        }
    }
}

pub(super) async fn handshake(seen: &mut mpsc::UnboundedReceiver<Seen>) -> HeaderMap {
    match seen.recv().await.unwrap() {
        Seen::Handshake(headers) => headers,
        Seen::Message(_) => panic!("expected the handshake first"),
    }
}

async fn log_outcomes(store: &PluginSecretStore) -> (Vec<String>, String) {
    let conn = store.conn.lock().await;
    let rows = log::list(&conn, &log::LogFilter::default()).unwrap();
    let outcomes = rows.iter().map(|row| row.outcome.clone()).collect();
    (outcomes, serde_json::to_string(&rows).unwrap())
}

#[tokio::test]
async fn intercepted_websockets_substitute_text_and_redact_echoes() {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
    let store = leak_store();
    put_secret(store, "WS_AUTH", AUTH_VALUE).await;
    put_secret(store, "WS_KEY", KEY_VALUE).await;
    let (upstream, upstream_ca, mut seen) = tls_echo_upstream().await;
    add_service(store, ws_service(upstream, "secret:WS_KEY")).await;
    let (token, _) = mint(store).await;
    let port = start(store, config(vec![upstream_ca])).await;

    let tls = intercepted(store, port, upstream, &token).await;
    let mut request = format!("wss://localhost:{upstream}/stream")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "sec-websocket-extensions",
        HeaderValue::from_static("permessage-deflate"),
    );
    let (mut socket, response) = tokio_tungstenite::client_async(request, tls).await.unwrap();
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);

    let headers = handshake(&mut seen).await;
    assert_eq!(
        headers.get("authorization").unwrap(),
        &format!("Bearer {AUTH_VALUE}")
    );
    assert!(!headers.contains_key("proxy-authorization"));
    assert!(
        !headers.contains_key("sec-websocket-extensions"),
        "compression cannot be rewritten, so it is not offered"
    );

    let sent = r#"{"type":"auth","key":"__WS_KEY__"}"#;
    socket.send(Message::Text(sent.into())).await.unwrap();
    let received = next_message(&mut seen).await.into_text().unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&received).unwrap();
    assert_eq!(parsed["key"], KEY_VALUE, "JSON messages get JSON escaping");
    // The upstream echoes the value; the agent gets the placeholder back.
    let echoed = socket.next().await.unwrap().unwrap().into_text().unwrap();
    assert_eq!(echoed, sent);

    socket
        .send(Message::Binary(b"__WS_KEY__".to_vec()))
        .await
        .unwrap();
    assert_eq!(
        next_message(&mut seen).await.into_data(),
        b"__WS_KEY__".to_vec(),
        "binary messages are relayed unchanged"
    );

    let (outcomes, rows) = log_outcomes(store).await;
    assert!(outcomes.contains(&"websocket".to_owned()), "{outcomes:?}");
    assert!(!rows.contains(AUTH_VALUE) && !rows.contains("ws-key"));
}

#[tokio::test]
async fn an_unresolvable_placeholder_closes_the_websocket_before_upstream() {
    let store = leak_store();
    put_secret(store, "WS_AUTH", AUTH_VALUE).await;
    let (upstream, upstream_ca, mut seen) = tls_echo_upstream().await;
    add_service(store, ws_service(upstream, "secret:MISSING")).await;
    let (token, _) = mint(store).await;
    let port = start(store, config(vec![upstream_ca])).await;

    let tls = intercepted(store, port, upstream, &token).await;
    let url = format!("wss://localhost:{upstream}/stream");
    let (mut socket, _) = tokio_tungstenite::client_async(url, tls).await.unwrap();
    handshake(&mut seen).await;
    socket
        .send(Message::Text("key __WS_KEY__".into()))
        .await
        .unwrap();
    match socket.next().await {
        Some(Ok(Message::Close(Some(frame)))) => assert_eq!(frame.code, CloseCode::Policy),
        other => panic!("expected a policy close, got {other:?}"),
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(200), next_message(&mut seen))
            .await
            .is_err(),
        "the message never reaches upstream"
    );
}

/// Send an absolute-form upgrade through the broker over plain TCP.
async fn absolute_upgrade(port: u16, upstream: u16, token: &str) -> (TcpStream, String) {
    let mut tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    tcp.write_all(
        format!(
            "GET http://127.0.0.1:{upstream}/ws HTTP/1.1\r\nHost: 127.0.0.1:{upstream}\r\n\
             Proxy-Authorization: Bearer {token}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let head = read_head(&mut tcp).await;
    (tcp, head)
}

#[tokio::test]
async fn absolute_form_upgrades_relay_unchanged_and_close_with_the_session() {
    let store = leak_store();
    put_secret(store, "WS_AUTH", AUTH_VALUE).await;
    let (upstream, mut seen) = plain_echo_upstream().await;
    let mut service = test_service("ws", "127.0.0.1", Some(upstream), "/");
    service.auth = ServiceAuth::Bearer {
        token: "secret:WS_AUTH".into(),
    };
    service.allow_insecure_http = true;
    add_service(store, service).await;
    let (token, session) = mint(store).await;
    let port = start(store, config(Vec::new())).await;

    let (tcp, head) = absolute_upgrade(port, upstream, &token).await;
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    assert!(head
        .to_ascii_lowercase()
        .contains("sec-websocket-accept: s3pplmbitxaq9kygzzhzrbk+xoo="));
    let headers = handshake(&mut seen).await;
    assert_eq!(
        headers.get("authorization").unwrap(),
        &format!("Bearer {AUTH_VALUE}")
    );
    let mut socket =
        tokio_tungstenite::WebSocketStream::from_raw_socket(tcp, Role::Client, None).await;
    // No `websocket` substitution: the placeholder is relayed as written.
    socket
        .send(Message::Text("__WS_KEY__".into()))
        .await
        .unwrap();
    assert_eq!(
        next_message(&mut seen).await.into_text().unwrap(),
        "__WS_KEY__"
    );
    assert_eq!(
        socket.next().await.unwrap().unwrap().into_text().unwrap(),
        "__WS_KEY__"
    );

    {
        let conn = store.conn.lock().await;
        assert!(sessions::revoke(&conn, &session.id).unwrap());
    }
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match socket.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "revoking the session closes the WebSocket");
}

#[tokio::test]
async fn upgrades_are_refused_like_requests_and_non_101_answers_pass_through() {
    let store = leak_store();
    let (token, _) = mint(store).await;
    let port = start(store, config(Vec::new())).await;
    // No service covers the host and the default policy denies it.
    let (_, head) = absolute_upgrade(port, 9, &token).await;
    assert!(head.starts_with("HTTP/1.1 403"), "{head}");

    // An upstream that does not switch protocols answers as itself.
    let plain = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let plain_port = plain.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = plain.accept().await {
            let _ = read_head(&mut stream).await;
            let _ = stream
                .write_all(b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 4\r\n\r\nnope")
                .await;
        }
    });
    let mut service = test_service("ws", "127.0.0.1", Some(plain_port), "/");
    service.auth = ServiceAuth::Passthrough;
    service.allow_insecure_http = true;
    add_service(store, service).await;
    let (_, head) = absolute_upgrade(port, plain_port, &token).await;
    assert!(head.starts_with("HTTP/1.1 401"), "{head}");
    let (outcomes, _) = log_outcomes(store).await;
    assert!(outcomes.contains(&"forbidden".to_owned()), "{outcomes:?}");
    assert!(outcomes.contains(&"forwarded".to_owned()), "{outcomes:?}");
}
