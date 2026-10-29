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

#[tokio::test]
async fn absolute_form_requests_get_credentials_without_exposing_them() {
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    put_secret(store, "QKEY", QUERY_VALUE).await;
    let (upstream, mut seen) = fake_http_upstream().await;
    let mut service = test_service("svc", "127.0.0.1", Some(upstream), "/v1");
    service.allow_insecure_http = true;
    service.substitutions = vec![Substitution {
        placeholder: "__QKEY__".into(),
        reference: "secret:QKEY".into(),
        surfaces: vec![Surface::Query, Surface::Header],
    }];
    add_service(store, service).await;
    let (token, session) = mint(store, &["svc"]).await;
    let port = start(store, loopback_config()).await;

    let response = send_raw(
        port,
        get_via_proxy(
            &format!("http://127.0.0.1:{upstream}/v1/items?key=__QKEY__"),
            Some(token.as_str()),
            "X-Echo: __QKEY__\r\nAuthorization: Bearer agent-supplied\r\n",
        ),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(response.ends_with("ok"));

    let request = seen.recv().await.unwrap().to_ascii_lowercase();
    assert!(
        request.starts_with("get /v1/items?key=q%20value%26x "),
        "{request}"
    );
    assert!(request.contains(&format!("authorization: bearer {TOKEN_VALUE}")));
    assert!(!request.contains("agent-supplied"));
    assert!(request.contains("x-echo: q value&x"));
    assert!(!request.contains("proxy-authorization"));
    assert!(!request.contains(&token.to_ascii_lowercase()));

    let rows = log_rows(store).await;
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.service.as_deref(), Some("svc"));
    assert_eq!(row.outcome, "forwarded");
    assert_eq!(row.status, 200);
    assert_eq!(row.path, "/v1/items");
    assert_eq!(row.session_id.as_deref(), Some(session.id.as_str()));
    let serialized = serde_json::to_string(&rows).unwrap();
    assert!(!serialized.contains(TOKEN_VALUE));
    assert!(!serialized.contains("q value"));

    let conn = store.conn.lock().await;
    let uses: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vault_audit WHERE action = 'secret.use' AND outcome = 'ok'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(uses, 2);
    let leaked: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vault_audit WHERE details LIKE ?1",
            [format!("%{TOKEN_VALUE}%")],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(leaked, 0);
}

#[tokio::test]
async fn refusals_are_specific_and_never_reach_upstream() {
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    let (upstream, mut seen) = fake_http_upstream().await;
    let mut open = test_service("open", "127.0.0.1", Some(upstream), "/open");
    open.allow_insecure_http = true;
    add_service(store, open).await;
    let mut off = test_service("off", "127.0.0.1", Some(upstream), "/off");
    off.allow_insecure_http = true;
    off.enabled = false;
    add_service(store, off).await;
    add_service(
        store,
        test_service("tls-only", "127.0.0.1", Some(upstream), "/tls"),
    )
    .await;
    let mut other = test_service("other", "127.0.0.1", Some(upstream), "/other");
    other.allow_insecure_http = true;
    add_service(store, other).await;
    let mut missing = test_service("missing", "127.0.0.1", Some(upstream), "/missing");
    missing.allow_insecure_http = true;
    missing.auth = ServiceAuth::Bearer {
        token: "secret:NOT_SET".into(),
    };
    add_service(store, missing).await;
    let (token, _) = mint(store, &["open", "off", "tls-only", "missing"]).await;
    let port = start(store, loopback_config()).await;
    let url = |path: &str| format!("http://127.0.0.1:{upstream}{path}");

    let response = send_raw(port, get_via_proxy(&url("/open"), None, "")).await;
    assert!(response.starts_with("HTTP/1.1 407"), "{response}");
    assert!(response
        .to_ascii_lowercase()
        .contains("proxy-authenticate: basic"));
    let response = send_raw(port, get_via_proxy(&url("/open"), Some("rvb_forged"), "")).await;
    assert!(response.starts_with("HTTP/1.1 407"), "{response}");

    let cases = [
        ("/elsewhere", "403", "\"forbidden\""),
        ("/off", "403", "service_disabled"),
        ("/tls", "403", "insecure_scheme"),
        ("/other", "403", "service_not_in_session"),
        ("/missing", "502", "credential_unavailable"),
    ];
    for (path, status, code) in cases {
        let response = send_raw(port, get_via_proxy(&url(path), Some(token.as_str()), "")).await;
        assert!(
            response.starts_with(&format!("HTTP/1.1 {status}")),
            "{path}: {response}"
        );
        assert!(response.contains(code), "{path}: {response}");
    }
    let response = send_raw(
        port,
        get_via_proxy(&url("/elsewhere"), Some(token.as_str()), ""),
    )
    .await;
    assert!(response.contains("proposalHint"));
    assert!(response.contains(PROPOSALS_ENDPOINT));
    assert!(
        seen.try_recv().is_err(),
        "a refused request reached upstream"
    );

    let rows = log_rows(store).await;
    assert_eq!(rows.len(), 6);
    assert!(rows.iter().any(|row| row.outcome == "service_disabled"));
    assert!(rows.iter().all(|row| row.outcome != "forwarded"));
}

#[tokio::test]
async fn private_upstreams_are_blocked_without_an_allowlist() {
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    let (upstream, mut seen) = fake_http_upstream().await;
    let mut service = test_service("svc", "127.0.0.1", Some(upstream), "/");
    service.allow_insecure_http = true;
    add_service(store, service).await;
    let (token, _) = mint(store, &["svc"]).await;
    let port = start(store, BrokerConfig::defaults()).await;
    let response = send_raw(
        port,
        get_via_proxy(
            &format!("http://127.0.0.1:{upstream}/"),
            Some(token.as_str()),
            "",
        ),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 403"), "{response}");
    assert!(response.contains("netguard_blocked"));
    assert!(seen.try_recv().is_err());
}

#[tokio::test]
async fn sessions_are_rate_limited() {
    let store = leak_store();
    let (token, _) = mint(store, &["svc"]).await;
    let config = BrokerConfig {
        rps: 0.01,
        burst: 1.0,
        ..loopback_config()
    };
    let port = start(store, config).await;
    let first = send_raw(
        port,
        get_via_proxy("http://127.0.0.1:9/", Some(token.as_str()), ""),
    )
    .await;
    assert!(first.starts_with("HTTP/1.1 403"), "{first}");
    let second = send_raw(
        port,
        get_via_proxy("http://127.0.0.1:9/", Some(token.as_str()), ""),
    )
    .await;
    assert!(second.starts_with("HTTP/1.1 429"), "{second}");
    assert!(second.to_ascii_lowercase().contains("retry-after:"));
}

#[tokio::test]
async fn oversized_bodies_are_rejected() {
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    let (upstream, _seen) = fake_http_upstream().await;
    let mut service = test_service("svc", "127.0.0.1", Some(upstream), "/");
    service.allow_insecure_http = true;
    add_service(store, service).await;
    let (token, _) = mint(store, &["svc"]).await;
    let config = BrokerConfig {
        max_request_bytes: 8,
        ..loopback_config()
    };
    let port = start(store, config).await;
    let request = format!(
        "POST http://127.0.0.1:{upstream}/ HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Bearer {token}\r\nContent-Length: 32\r\nConnection: close\r\n\r\n{}",
        "a".repeat(32)
    );
    let response = send_raw(port, request).await;
    assert!(response.starts_with("HTTP/1.1 413"), "{response}");
}

#[tokio::test]
async fn json_bodies_substitute_only_when_opted_in() {
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    put_secret(store, "QKEY", "say \"hi\"").await;
    let (upstream, mut seen) = fake_http_upstream().await;
    let mut service = test_service("svc", "127.0.0.1", Some(upstream), "/");
    service.allow_insecure_http = true;
    service.auth = ServiceAuth::Passthrough;
    service.substitutions = vec![Substitution {
        placeholder: "__QKEY__".into(),
        reference: "secret:QKEY".into(),
        surfaces: vec![Surface::Body],
    }];
    add_service(store, service).await;
    let (token, _) = mint(store, &["svc"]).await;
    let port = start(store, loopback_config()).await;
    let body = r#"{"text":"__QKEY__"}"#;
    let request = format!(
        "POST http://127.0.0.1:{upstream}/__QKEY__ HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let response = send_raw(port, request).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let seen = seen.recv().await.unwrap();
    assert!(seen.contains(r#"{"text":"say \"hi\""}"#), "{seen}");
    // The path surface was not enabled, so the placeholder stays literal there.
    assert!(seen.starts_with("POST /__QKEY__ "), "{seen}");
}

#[tokio::test]
async fn connect_is_intercepted_with_the_broker_ca() {
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    let (upstream, upstream_ca, mut seen) = fake_tls_upstream().await;
    let mut service = test_service("svc", "localhost", Some(upstream), "/");
    service.auth = ServiceAuth::ApiKey {
        header: "X-Api-Key".into(),
        value: "secret:API_TOKEN".into(),
        prefix: String::new(),
    };
    add_service(store, service).await;
    let (token, _) = mint(store, &["svc"]).await;
    let config = BrokerConfig {
        extra_upstream_roots_pem: vec![upstream_ca],
        ..loopback_config()
    };
    let port = start(store, config).await;

    let mut tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("rvb:{token}"));
    tcp.write_all(
        format!(
            "CONNECT localhost:{upstream} HTTP/1.1\r\nHost: localhost:{upstream}\r\nProxy-Authorization: Basic {basic}\r\n\r\n"
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
    let mut tls = connector.connect(server_name, tcp).await.unwrap();
    tls.write_all(b"GET /v1/me HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(response.ends_with("ok"));

    let request = seen.recv().await.unwrap().to_ascii_lowercase();
    assert!(request.starts_with("get /v1/me "), "{request}");
    assert!(request.contains(&format!("x-api-key: {TOKEN_VALUE}")));

    let rows = log_rows(store).await;
    let outcomes: Vec<&str> = rows.iter().map(|row| row.outcome.as_str()).collect();
    assert!(outcomes.contains(&"intercepted"), "{outcomes:?}");
    assert!(outcomes.contains(&"forwarded"), "{outcomes:?}");
    assert!(!serde_json::to_string(&rows).unwrap().contains(TOKEN_VALUE));
}

#[tokio::test]
async fn unmatched_connects_follow_the_environment_policy() {
    let store = leak_store();
    let echo = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = echo.accept().await {
            let mut buf = [0u8; 64];
            if let Ok(n) = stream.read(&mut buf).await {
                let _ = stream.write_all(&buf[..n]).await;
            }
        }
    });
    let (token, _) = mint(store, &["svc"]).await;
    let port = start(store, loopback_config()).await;
    let connect = format!(
        "CONNECT 127.0.0.1:{echo_port} HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Authorization: Bearer {token}\r\n\r\n"
    );

    let denied = send_raw(port, connect.clone()).await;
    assert!(denied.starts_with("HTTP/1.1 403"), "{denied}");
    assert!(denied.contains("proposalHint"));

    {
        let conn = store.conn.lock().await;
        settings::put(&conn, "default", UnmatchedHostPolicy::Passthrough, "").unwrap();
    }
    let mut tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    tcp.write_all(connect.as_bytes()).await.unwrap();
    let established = read_message(&mut tcp).await;
    assert!(established.starts_with("HTTP/1.1 200"), "{established}");
    tcp.write_all(b"ping").await.unwrap();
    let mut echoed = [0u8; 4];
    tcp.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"ping");
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

#[tokio::test]
async fn dot_segment_paths_never_leave_the_service_prefix() {
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    let (upstream, mut seen) = fake_http_upstream().await;
    let mut service = test_service("svc", "127.0.0.1", Some(upstream), "/repos/acme");
    service.allow_insecure_http = true;
    add_service(store, service).await;
    {
        let conn = store.conn.lock().await;
        settings::put(&conn, "default", UnmatchedHostPolicy::Passthrough, "").unwrap();
    }
    let (token, _) = mint(store, &["svc"]).await;
    let port = start(store, loopback_config()).await;
    for path in [
        "/repos/acme/../../user/keys",
        "/repos/acme/%2e%2e/%2e%2e/user/keys",
        "/repos/acme/.%2E/x",
        "/repos/acme/./x",
    ] {
        let response = send_raw(
            port,
            get_via_proxy(
                &format!("http://127.0.0.1:{upstream}{path}"),
                Some(token.as_str()),
                "",
            ),
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 400"), "{path}: {response}");
        assert!(response.contains("invalid_path"), "{path}: {response}");
    }
    assert!(
        seen.try_recv().is_err(),
        "a dot-segment request reached upstream"
    );
    let response = send_raw(
        port,
        get_via_proxy(
            &format!("http://127.0.0.1:{upstream}/repos/acme/issues"),
            Some(token.as_str()),
            "",
        ),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
}

#[tokio::test]
async fn revoking_a_session_stops_an_open_intercepted_connection() {
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    let (upstream, upstream_ca, mut seen) = fake_tls_upstream().await;
    add_service(store, test_service("svc", "localhost", Some(upstream), "/")).await;
    let (token, session) = mint(store, &["svc"]).await;
    // The default (slow) re-check interval, so the per-request check is
    // what refuses the second request.
    let config = BrokerConfig {
        extra_upstream_roots_pem: vec![upstream_ca],
        ..loopback_config()
    };
    let port = start(store, config).await;
    let mut tls = intercepted_tls(store, port, upstream, &token).await;
    tls.write_all(b"GET /first HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await
        .unwrap();
    let first = read_message(&mut tls).await;
    assert!(first.starts_with("HTTP/1.1 200"), "{first}");
    assert!(seen.recv().await.unwrap().contains(TOKEN_VALUE));

    {
        let conn = store.conn.lock().await;
        assert!(sessions::revoke(&conn, &session.id).unwrap());
    }
    tls.write_all(b"GET /second HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let second = read_message(&mut tls).await;
    assert!(second.starts_with("HTTP/1.1 407"), "{second}");
    assert!(
        seen.try_recv().is_err(),
        "a revoked session reached upstream"
    );
}

#[tokio::test]
async fn revoking_a_session_closes_its_raw_tunnels() {
    let store = leak_store();
    let echo_port = echo_server().await;
    {
        let conn = store.conn.lock().await;
        settings::put(&conn, "default", UnmatchedHostPolicy::Passthrough, "").unwrap();
    }
    let (token, session) = mint(store, &["svc"]).await;
    let config = BrokerConfig {
        session_check_interval: Duration::from_millis(50),
        ..loopback_config()
    };
    let port = start(store, config).await;
    let (mut tcp, established) = open_raw_tunnel(port, echo_port, &token).await;
    assert!(established.starts_with("HTTP/1.1 200"), "{established}");
    tcp.write_all(b"ping").await.unwrap();
    let mut echoed = [0u8; 4];
    tcp.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"ping");

    {
        let conn = store.conn.lock().await;
        sessions::revoke(&conn, &session.id).unwrap();
    }
    let mut buf = [0u8; 16];
    let closed = tokio::time::timeout(Duration::from_secs(5), tcp.read(&mut buf))
        .await
        .expect("the tunnel stayed open after revocation");
    assert!(matches!(closed, Ok(0) | Err(_)), "{closed:?}");
}

#[tokio::test]
async fn connects_are_rate_limited_and_tunnels_are_capped() {
    let store = leak_store();
    let echo_port = echo_server().await;
    let (token, _) = mint(store, &["svc"]).await;
    let limited = start(
        store,
        BrokerConfig {
            rps: 0.01,
            burst: 1.0,
            ..loopback_config()
        },
    )
    .await;
    let (_, first) = open_raw_tunnel(limited, echo_port, &token).await;
    assert!(first.starts_with("HTTP/1.1 403"), "{first}");
    let (_, second) = open_raw_tunnel(limited, echo_port, &token).await;
    assert!(second.starts_with("HTTP/1.1 429"), "{second}");
    assert!(second.contains("rate_limited"));

    {
        let conn = store.conn.lock().await;
        settings::put(&conn, "default", UnmatchedHostPolicy::Passthrough, "").unwrap();
    }
    let (token, _) = mint(store, &["svc"]).await;
    let capped = start(
        store,
        BrokerConfig {
            max_tunnels_per_session: 1,
            ..loopback_config()
        },
    )
    .await;
    let (mut open, established) = open_raw_tunnel(capped, echo_port, &token).await;
    assert!(established.starts_with("HTTP/1.1 200"), "{established}");
    let (_, refused) = open_raw_tunnel(capped, echo_port, &token).await;
    assert!(refused.starts_with("HTTP/1.1 429"), "{refused}");
    assert!(refused.contains("too_many_tunnels"));
    open.shutdown().await.unwrap();
    drop(open);
    let mut reopened = false;
    for _ in 0..50 {
        let (_, response) = open_raw_tunnel(capped, echo_port, &token).await;
        if response.starts_with("HTTP/1.1 200") {
            reopened = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(reopened, "a closed tunnel did not release its slot");
}

#[tokio::test]
async fn sealing_the_vault_stops_interception_after_first_use() {
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    add_service(store, test_service("svc", "localhost", Some(443), "/")).await;
    let (token, _) = mint(store, &["svc"]).await;
    let port = start(store, loopback_config()).await;
    let connect = format!(
        "CONNECT localhost:443 HTTP/1.1\r\nHost: localhost\r\nProxy-Authorization: Bearer {token}\r\n\r\n"
    );
    let mut tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    tcp.write_all(connect.as_bytes()).await.unwrap();
    let established = read_message(&mut tcp).await;
    assert!(established.starts_with("HTTP/1.1 200"), "{established}");
    drop(tcp);

    store.keyring.seal();
    let refused = send_raw(port, connect).await;
    assert!(refused.starts_with("HTTP/1.1 503"), "{refused}");
    assert!(refused.contains("vault_sealed"), "{refused}");
}

#[tokio::test]
async fn machine_sessions_resolve_only_what_the_machine_may_use() {
    use crate::vault::policy::{put_policy, Capability, Policy, PolicyRule};
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    put_secret(store, "OTHER", "other-value").await;
    {
        let conn = store.conn.lock().await;
        put_policy(
            &conn,
            &Policy {
                name: "ci".into(),
                description: String::new(),
                rules: vec![
                    PolicyRule {
                        path: "sys/broker/*".into(),
                        capabilities: vec![Capability::Use],
                        deny: false,
                        ..Default::default()
                    },
                    PolicyRule {
                        path: "default/API_TOKEN".into(),
                        capabilities: vec![Capability::Use],
                        deny: false,
                        ..Default::default()
                    },
                ],
            },
        )
        .unwrap();
    }
    let (upstream, mut seen) = fake_http_upstream().await;
    let mut allowed = test_service("allowed", "127.0.0.1", Some(upstream), "/allowed");
    allowed.allow_insecure_http = true;
    add_service(store, allowed).await;
    // An admin pointed this service at a credential the machine has no
    // `use` on.
    let mut other = test_service("other", "127.0.0.1", Some(upstream), "/other");
    other.allow_insecure_http = true;
    other.auth = ServiceAuth::Bearer {
        token: "secret:OTHER".into(),
    };
    add_service(store, other).await;
    let issued = super::super::test_machine_token(store, "ci", vec!["ci".into()]).await;
    let (token, _) = {
        let conn = store.conn.lock().await;
        sessions::mint(
            &conn,
            MintRequest {
                environment: "default".into(),
                services: vec!["allowed".into(), "other".into()],
                label: String::new(),
                ttl_secs: None,
                minted_by: format!("machine:{}", issued.identity_id),
                not_after: Some(issued.expires_at),
                minted_token: Some(issued.accessor.clone()),
                minter_scope: None,
            },
        )
        .unwrap()
    };
    let port = start(store, loopback_config()).await;
    let url = |path: &str| format!("http://127.0.0.1:{upstream}{path}");

    let response = send_raw(
        port,
        get_via_proxy(&url("/allowed"), Some(token.as_str()), ""),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(seen.recv().await.unwrap().contains(TOKEN_VALUE));

    let response = send_raw(
        port,
        get_via_proxy(&url("/other"), Some(token.as_str()), ""),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 403"), "{response}");
    assert!(response.contains("credential_denied"), "{response}");
    assert!(!response.contains("other-value"));
    assert!(
        seen.try_recv().is_err(),
        "a denied credential reached upstream"
    );

    // Revoking the minting token ends the session.
    store
        .token_revoke(&issued.accessor, &AuditActor::system())
        .await
        .unwrap();
    let response = send_raw(
        port,
        get_via_proxy(&url("/allowed"), Some(token.as_str()), ""),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 407"), "{response}");
}

async fn put_card(store: &PluginSecretStore, merchants: &[&str]) {
    put_card_with_cvc(store, merchants, Some("8317")).await;
}

async fn put_card_with_cvc(store: &PluginSecretStore, merchants: &[&str], cvc: Option<&str>) {
    use chrono::Datelike as _;
    let mut values = serde_json::json!({
        "cardholder": "Ada Lovelace",
        "number": "4242 4242 4242 4242",
        "expMonth": "12",
        "expYear": (chrono::Utc::now().year() + 2).to_string(),
    });
    if let Some(cvc) = cvc {
        values["cvc"] = serde_json::json!(cvc);
    }
    let input: crate::vault::items::ItemPut = serde_json::from_value(serde_json::json!({
        "kind": "card",
        "values": values,
        "merchants": merchants,
    }))
    .unwrap();
    store
        .item_put(
            "visa",
            input,
            &AuditActor::new("user", Some("u1")),
            crate::vault::items::PutAccess::FULL,
        )
        .await
        .unwrap();
}

const CARD_BODY: &str = r#"{"card":"__CARD_visa_NUMBER__","cvc":"__CARD_visa_CVC__","exp":"__CARD_visa_EXP_MONTH__/__CARD_visa_EXP_YEAR__"}"#;

fn card_post(host: &str, extra: &str) -> String {
    format!(
        "POST {host} HTTP/1.1\r\nHost: upstream\r\n{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{CARD_BODY}",
        CARD_BODY.len()
    )
}

#[tokio::test]
async fn card_placeholders_substitute_only_on_approved_https_merchant_requests() {
    use crate::vault::items::cards::ApproveInput;
    let store = leak_store();
    put_card(store, &["localhost"]).await;
    let (upstream, upstream_ca, mut seen) = fake_tls_upstream().await;
    // No service covers the merchant: the card alone makes it intercepted
    // even though the environment denies unmatched hosts.
    let (token, session) = mint(store, &["svc"]).await;
    let config = BrokerConfig {
        extra_upstream_roots_pem: vec![upstream_ca],
        ..loopback_config()
    };
    let port = start(store, config).await;

    // First use: no approval yet, nothing is forwarded.
    let mut tls = intercepted_tls(store, port, upstream, &token).await;
    tls.write_all(card_post("/pay", "").as_bytes())
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 428"), "{response}");
    assert!(response.contains("card_approval_required"), "{response}");
    assert!(response.contains("\"last4\":\"4242\""), "{response}");
    assert!(!response.contains("4242424242424242"), "{response}");
    let approvals = store.card_approvals(None, None).await.unwrap();
    assert_eq!(approvals.len(), 1);
    let approval = &approvals[0];
    assert_eq!(approval.requester, format!("broker_session:{}", session.id));
    assert_eq!(approval.agent, "operator");
    assert!(response.contains(&approval.approve_path()), "{response}");
    assert!(seen.try_recv().is_err(), "nothing reached upstream");

    store
        .card_approve(
            &approval.id,
            &ApproveInput::default(),
            &AuditActor::new("user", Some("u1")),
            "user:u1",
        )
        .await
        .unwrap();
    let mut tls = intercepted_tls(store, port, upstream, &token).await;
    tls.write_all(card_post("/pay", "").as_bytes())
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let request = seen.recv().await.unwrap();
    let year = {
        use chrono::Datelike as _;
        chrono::Utc::now().year() + 2
    };
    assert!(
        request.contains(&format!(
            r#"{{"card":"4242424242424242","cvc":"8317","exp":"12/{year}"}}"#
        )),
        "{request}"
    );

    // The single-use approval is spent: the next use is pending again.
    let mut tls = intercepted_tls(store, port, upstream, &token).await;
    tls.write_all(card_post("/pay", "").as_bytes())
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 428"), "{response}");

    let rows = log_rows(store).await;
    let outcomes: Vec<&str> = rows.iter().map(|row| row.outcome.as_str()).collect();
    assert!(outcomes.contains(&"card_approval_required"), "{outcomes:?}");
    assert!(!serde_json::to_string(&rows)
        .unwrap()
        .contains("4242424242424242"));
}

#[tokio::test]
async fn a_placeholder_for_a_missing_card_field_is_refused_and_refunded() {
    use crate::vault::items::cards::ApproveInput;
    let store = leak_store();
    // The security code is optional and this card stores none.
    put_card_with_cvc(store, &["localhost"], None).await;
    let (upstream, upstream_ca, mut seen) = fake_tls_upstream().await;
    let (token, _) = mint(store, &["svc"]).await;
    let config = BrokerConfig {
        extra_upstream_roots_pem: vec![upstream_ca],
        ..loopback_config()
    };
    let port = start(store, config).await;
    let mut tls = intercepted_tls(store, port, upstream, &token).await;
    tls.write_all(card_post("/pay", "").as_bytes())
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 428"), "{response}");
    let approvals = store.card_approvals(None, None).await.unwrap();
    store
        .card_approve(
            &approvals[0].id,
            &ApproveInput::default(),
            &AuditActor::new("user", Some("u1")),
            "user:u1",
        )
        .await
        .unwrap();

    // The request asks for the missing code: refused before sending, the
    // literal placeholder never leaves, and the one-use approval survives.
    let mut tls = intercepted_tls(store, port, upstream, &token).await;
    tls.write_all(card_post("/pay", "").as_bytes())
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 409"), "{response}");
    assert!(response.contains("card_field_missing"), "{response}");
    assert!(!response.contains("4242424242424242"), "{response}");
    assert!(seen.try_recv().is_err(), "nothing reached upstream");

    // The refunded approval still covers a request that needs no code.
    let body = r#"{"card":"__CARD_visa_NUMBER__"}"#;
    let mut tls = intercepted_tls(store, port, upstream, &token).await;
    tls.write_all(
        format!(
            "POST /pay HTTP/1.1\r\nHost: upstream\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(seen
        .recv()
        .await
        .unwrap()
        .contains(r#"{"card":"4242424242424242"}"#));
}

#[tokio::test]
async fn card_placeholders_stay_untouched_off_the_merchant_allowlist_or_over_http() {
    let store = leak_store();
    put_card(store, &["localhost"]).await;
    let (upstream, mut seen) = fake_http_upstream().await;
    let (token, _) = mint(store, &["svc"]).await;
    let port = start(store, loopback_config()).await;
    let auth = format!("Proxy-Authorization: Bearer {token}\r\n");

    // Plain HTTP to the merchant: nothing is substituted, so under `deny`
    // the merchant entry does not open egress to the host.
    let response = send_raw(
        port,
        card_post(&format!("http://localhost:{upstream}/pay"), &auth),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 403"), "{response}");
    assert!(response.contains("denies unmatched hosts"), "{response}");
    assert!(seen.try_recv().is_err(), "nothing reached upstream");

    // Another host (passthrough): untouched as well.
    {
        let conn = store.conn.lock().await;
        settings::put(&conn, "default", UnmatchedHostPolicy::Passthrough, "").unwrap();
    }
    let response = send_raw(
        port,
        card_post(&format!("http://127.0.0.1:{upstream}/pay"), &auth),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let request = seen.recv().await.unwrap();
    assert!(request.contains(CARD_BODY), "{request}");

    // Both were recorded as blocked uses, and no approval was filed.
    assert!(store.card_approvals(None, None).await.unwrap().is_empty());
    let coords = crate::vault::items::ItemCoords::new(None, None, "visa").unwrap();
    let events = store
        .item_events(
            &coords,
            0,
            100,
            0,
            crate::vault::items::EventScope::CurrentItem,
        )
        .await
        .unwrap();
    let blocked: Vec<_> = events
        .iter()
        .filter(|event| event.name == "card_use_blocked")
        .map(|event| event.data["reason"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(blocked, vec!["insecure_scheme", "merchant_not_allowed"]);
}

async fn blocked_reasons(store: &PluginSecretStore) -> Vec<String> {
    let coords = crate::vault::items::ItemCoords::new(None, None, "visa").unwrap();
    store
        .item_events(
            &coords,
            0,
            100,
            0,
            crate::vault::items::EventScope::CurrentItem,
        )
        .await
        .unwrap()
        .iter()
        .filter(|event| event.name == "card_use_blocked")
        .map(|event| event.data["reason"].as_str().unwrap_or_default().to_owned())
        .collect()
}

#[tokio::test]
async fn sessions_use_only_cards_their_minter_may_use() {
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    put_card(store, &["localhost"]).await;
    let (upstream, upstream_ca, mut seen) = fake_tls_upstream().await;
    // A service covers the upstream, so the request is intercepted for it.
    add_service(
        store,
        test_service("shop", "localhost", Some(upstream), "/"),
    )
    .await;
    // A member with no capability on the card minted this session.
    let member = MinterScope {
        subjects: vec!["user:u2".into()],
        manager: false,
    };
    let (token, _) = mint_as(store, &["shop"], "user:u2", member).await;
    let (other_upstream, _, _) = fake_tls_upstream().await;
    let config = BrokerConfig {
        extra_upstream_roots_pem: vec![upstream_ca],
        ..loopback_config()
    };
    let port = start(store, config).await;

    let mut tls = intercepted_tls(store, port, upstream, &token).await;
    tls.write_all(card_post("/pay", "").as_bytes())
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let request = seen.recv().await.unwrap();
    assert!(request.contains(CARD_BODY), "{request}");
    assert!(!request.contains("4242424242424242"), "{request}");
    assert!(store.card_approvals(None, None).await.unwrap().is_empty());
    assert_eq!(blocked_reasons(store).await, vec!["denied"]);

    // The card's merchant host does not open egress under `deny` for a
    // session that may not use the card.
    let connect = format!(
        "CONNECT localhost:{other_upstream} HTTP/1.1\r\nHost: localhost\r\nProxy-Authorization: Bearer {token}\r\n\r\n"
    );
    let denied = send_raw(port, connect).await;
    assert!(denied.starts_with("HTTP/1.1 403"), "{denied}");
}

#[tokio::test]
async fn an_unreachable_merchant_does_not_spend_the_approval() {
    use crate::vault::items::cards::{ApprovalStatus, ApproveInput};
    let store = leak_store();
    put_card(store, &["localhost"]).await;
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap().port()
    };
    let (token, _) = mint(store, &["svc"]).await;
    let port = start(store, loopback_config()).await;

    let mut tls = intercepted_tls(store, port, closed, &token).await;
    tls.write_all(card_post("/pay", "").as_bytes())
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 428"), "{response}");
    let id = store.card_approvals(None, None).await.unwrap()[0]
        .id
        .clone();
    store
        .card_approve(
            &id,
            &ApproveInput::default(),
            &AuditActor::new("user", Some("u1")),
            "user:u1",
        )
        .await
        .unwrap();

    let mut tls = intercepted_tls(store, port, closed, &token).await;
    tls.write_all(card_post("/pay", "").as_bytes())
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 502"), "{response}");
    let approval = store.card_approval(&id).await.unwrap().unwrap();
    assert_eq!(
        (approval.status, approval.uses),
        (ApprovalStatus::Approved, 0)
    );
}

#[tokio::test]
async fn a_card_without_merchants_records_a_blocked_use() {
    let store = leak_store();
    put_card(store, &[]).await;
    let (upstream, mut seen) = fake_http_upstream().await;
    {
        let conn = store.conn.lock().await;
        settings::put(&conn, "default", UnmatchedHostPolicy::Passthrough, "").unwrap();
    }
    let (token, _) = mint(store, &["svc"]).await;
    let port = start(store, loopback_config()).await;
    let auth = format!("Proxy-Authorization: Bearer {token}\r\n");
    let response = send_raw(
        port,
        card_post(&format!("http://127.0.0.1:{upstream}/pay"), &auth),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(seen.recv().await.unwrap().contains(CARD_BODY));
    assert_eq!(blocked_reasons(store).await, vec!["no_merchants"]);
}

#[tokio::test]
async fn password_manager_credentials_wait_for_approval_then_inject() {
    use crate::vault::password_managers::tests::{
        add_cli_account, invocations, BWS_TOKEN, SECRET_ID,
    };
    use crate::vault::password_managers::GrantMode;
    let dir = tempfile::tempdir().unwrap();
    let store = leak_store();
    add_cli_account(store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let (upstream, mut seen) = fake_http_upstream().await;
    let mut service = test_service("bw", "127.0.0.1", Some(upstream), "/v1");
    service.allow_insecure_http = true;
    service.auth = ServiceAuth::Bearer {
        token: format!("bws://{SECRET_ID}"),
    };
    add_service(store, service).await;
    let (token, session) = mint(store, &["bw"]).await;
    let port = start(store, loopback_config()).await;
    let request = || {
        get_via_proxy(
            &format!("http://127.0.0.1:{upstream}/v1/items"),
            Some(token.as_str()),
            "",
        )
    };

    // First use: refused with the approval id; the provider is not called
    // and nothing reaches the upstream.
    let refused = send_raw(port, request()).await;
    assert!(refused.starts_with("HTTP/1.1 403"), "{refused}");
    assert!(
        refused.contains("credential_approval_required"),
        "{refused}"
    );
    assert_eq!(invocations(dir.path()), 0);
    assert!(seen.try_recv().is_err());
    let approvals = store
        .pm_approvals(Some(
            crate::vault::broker::proposals::ProposalStatus::Pending,
        ))
        .await
        .unwrap();
    assert_eq!(approvals.len(), 1);
    assert!(refused.contains(&approvals[0].id));
    // The session's minting principal is the grant subject; the session filed it.
    assert_eq!(
        approvals[0].credential_use.as_ref().unwrap().subject,
        "broker:operator"
    );
    assert_eq!(
        approvals[0].requested_by,
        format!("broker_session:{}", session.id)
    );

    store
        .pm_approve(
            &approvals[0].id,
            GrantMode::Hour,
            "",
            "operator",
            &AuditActor::system(),
        )
        .await
        .unwrap();
    let response = send_raw(port, request()).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let forwarded = seen.recv().await.unwrap().to_ascii_lowercase();
    assert!(
        forwarded.contains("authorization: bearer bw-secret-value"),
        "{forwarded}"
    );
    assert_eq!(invocations(dir.path()), 1);
    let serialized = serde_json::to_string(&log_rows(store).await).unwrap();
    assert!(!serialized.contains("bw-secret-value"));
}

#[tokio::test]
async fn human_sessions_honor_the_minters_role_and_team_denies() {
    use crate::vault::password_managers::tests::{
        add_cli_account, invocations, BWS_TOKEN, SECRET_ID,
    };
    use crate::vault::policy::{bind, put_policy, Capability, Policy, PolicyRule};
    let dir = tempfile::tempdir().unwrap();
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    put_secret(store, "OTHER", "other-value").await;
    add_cli_account(store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    {
        let conn = store.conn.lock().await;
        let deny = |name: &str, path: &str| Policy {
            name: name.into(),
            description: String::new(),
            rules: vec![PolicyRule {
                path: path.into(),
                capabilities: vec![Capability::Use, Capability::Read],
                deny: true,
                ..Default::default()
            }],
        };
        put_policy(&conn, &deny("contractor", "default/API_TOKEN")).unwrap();
        put_policy(&conn, &deny("vendors", "default/OTHER")).unwrap();
        put_policy(
            &conn,
            &deny(
                "no-pm",
                &crate::vault::password_managers::account_key("team"),
            ),
        )
        .unwrap();
        bind(&conn, "contractor", "role:contractor", None, None).unwrap();
        bind(&conn, "vendors", "team:t1", None, None).unwrap();
        bind(&conn, "no-pm", "role:contractor", None, None).unwrap();
    }
    let (upstream, mut seen) = fake_http_upstream().await;
    let mut role_denied = test_service("role", "127.0.0.1", Some(upstream), "/role");
    role_denied.allow_insecure_http = true;
    add_service(store, role_denied).await;
    let mut team_denied = test_service("team", "127.0.0.1", Some(upstream), "/team");
    team_denied.allow_insecure_http = true;
    team_denied.auth = ServiceAuth::Bearer {
        token: "secret:OTHER".into(),
    };
    add_service(store, team_denied).await;
    let mut pm = test_service("pm", "127.0.0.1", Some(upstream), "/pm");
    pm.allow_insecure_http = true;
    pm.auth = ServiceAuth::Bearer {
        token: format!("bws://{SECRET_ID}"),
    };
    add_service(store, pm).await;
    let services = ["role", "team", "pm"];
    let contractor = MinterScope {
        subjects: vec!["user:u1".into(), "role:contractor".into(), "team:t1".into()],
        manager: false,
    };
    let (token, _) = mint_as(store, &services, "user:u1", contractor).await;
    let member = MinterScope {
        subjects: vec!["user:u2".into(), "role:member".into()],
        manager: false,
    };
    let (member_token, _) = mint_as(store, &services, "user:u2", member).await;
    let port = start(store, loopback_config()).await;
    let url = |path: &str| format!("http://127.0.0.1:{upstream}{path}");

    for path in ["/role", "/team", "/pm"] {
        let response = send_raw(port, get_via_proxy(&url(path), Some(token.as_str()), "")).await;
        assert!(response.starts_with("HTTP/1.1 403"), "{path}: {response}");
        assert!(response.contains("credential_denied"), "{path}: {response}");
    }
    assert!(
        seen.try_recv().is_err(),
        "a denied credential reached upstream"
    );
    assert_eq!(invocations(dir.path()), 0);

    // A minter without those roles or teams still resolves both secrets.
    for path in ["/role", "/team"] {
        let response = send_raw(
            port,
            get_via_proxy(&url(path), Some(member_token.as_str()), ""),
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 200"), "{path}: {response}");
        seen.recv().await.unwrap();
    }
}
