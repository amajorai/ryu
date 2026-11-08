//! Box relay sessions: scope, binding, revocation, and the narrower broker a
//! relayed connection gets. Nothing here reaches the network.

use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use super::socket::{admit, router_with};
use super::*;
use crate::plugin_secrets::{SecretCoords, SecretScope, VersionSource, WriteRequest};
use crate::vault::broker::netguard::{Cidr, NetGuard};
use crate::vault::broker::proxy::Broker;
use crate::vault::broker::services::{test_service, ServiceInput, Substitution};
use crate::vault::broker::settings::{self, UnmatchedHostPolicy};
use crate::vault::broker::substitute::Surface;
use crate::vault::broker::BrokerConfig;

const LEASE: &str = "lease-a";
const TOKEN_VALUE: &str = "real-token-123";

fn leak_store() -> &'static PluginSecretStore {
    Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()))
}

fn manager() -> BoxRelayOwner {
    BoxRelayOwner {
        subjects: Vec::new(),
        manager: true,
    }
}

fn admit_all(_: &str) -> bool {
    true
}

async fn put_secret(store: &PluginSecretStore, name: &str, value: &str) {
    store
        .write_secret(WriteRequest {
            coords: SecretCoords {
                scope: SecretScope::Node,
                scope_id: crate::vault::broker::local_node_id(),
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

async fn add(store: &PluginSecretStore, input: ServiceInput) {
    let conn = store.conn.lock().await;
    services::insert(&conn, input.normalize().unwrap()).unwrap();
}

fn relayed(name: &str, host: &str) -> ServiceInput {
    let mut input = test_service(name, host, None, "/");
    input.box_relay = true;
    input
}

/// A relay session over `services`, minted as `cloud_tasks/box_arm` would
/// (bypassing the host checks so a loopback upstream can stand in).
async fn box_session(store: &PluginSecretStore, services: &[&str]) -> (String, String) {
    let conn = store.conn.lock().await;
    let (token, session) = sessions::mint(
        &conn,
        sessions::MintRequest {
            environment: "default".into(),
            services: services.iter().map(|s| (*s).to_owned()).collect(),
            label: "Box".into(),
            ttl_secs: None,
            minted_by: subject_for(LEASE),
            not_after: None,
            minted_token: None,
            minter_scope: Some(MinterScope {
                subjects: Vec::new(),
                manager: true,
            }),
        },
    )
    .unwrap();
    (token, session.id)
}

async fn broker(store: &'static PluginSecretStore) -> (Arc<Broker>, u16) {
    let config = BrokerConfig {
        guard: NetGuard {
            allow_private: false,
            allowlist: vec![Cidr::parse("127.0.0.0/8").unwrap()],
        },
        ..BrokerConfig::defaults()
    };
    let (broker, listener) = Broker::bind(store, config).await.unwrap();
    let port = broker.port();
    tokio::spawn(broker.clone().serve(listener));
    (broker, port)
}

/// A plain HTTP upstream that reports each request head it receives.
async fn upstream() -> (u16, mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (seen, receiver) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let request = read_head(&mut stream).await;
            let _ = seen.send(request);
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
                .await;
        }
    });
    (port, receiver)
}

async fn read_head<S: AsyncRead + Unpin>(stream: &mut S) -> String {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    while !buffer.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
        }
    }
    String::from_utf8_lossy(&buffer).into_owned()
}

/// Send one absolute-form request over a relayed connection bound to `id`.
async fn relayed_request(broker: &Arc<Broker>, id: &str, request: String) -> String {
    let (mut box_end, broker_end) = tokio::io::duplex(64 * 1024);
    tokio::spawn(broker.clone().serve_relayed(broker_end, id.to_owned()));
    box_end.write_all(request.as_bytes()).await.unwrap();
    read_head(&mut box_end).await
}

fn get(port: u16, path: &str, extra: &str) -> String {
    format!("GET http://127.0.0.1:{port}{path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{extra}\r\n")
}

#[tokio::test]
async fn a_box_gets_only_enabled_marked_relayable_services_its_owner_may_use() {
    let store = PluginSecretStore::in_memory().unwrap();
    add(&store, relayed("github", "api.github.com")).await;
    add(
        &store,
        test_service("unmarked", "api.openai.com", None, "/"),
    )
    .await;
    let mut disabled = relayed("disabled", "api.anthropic.com");
    disabled.enabled = false;
    add(&store, disabled).await;
    add(&store, relayed("address", "10.0.0.7")).await;
    let mut other_port = relayed("other-port", "git.example.com");
    other_port.port = Some(8443);
    add(&store, other_port).await;
    let conn = store.conn.lock().await;
    let names = |owner: &BoxRelayOwner, admits: &(dyn Fn(&str) -> bool + Sync)| {
        relay_services(&conn, "default", owner, admits)
            .unwrap()
            .into_iter()
            .map(|service| service.name().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(names(&manager(), &admit_all), vec!["github"]);
    // The Box's allowlist must admit the host.
    assert!(names(&manager(), &|host| host != "api.github.com").is_empty());
    // An owner with no `use` grant gets nothing.
    let user = BoxRelayOwner {
        subjects: vec!["user:u1".into()],
        manager: false,
    };
    assert!(names(&user, &admit_all).is_empty());
}

#[tokio::test]
async fn a_relay_session_belongs_to_one_box_and_ends_with_it() {
    let store = PluginSecretStore::in_memory().unwrap();
    assert!(mint(&store, LEASE, &manager(), 600, &admit_all)
        .await
        .unwrap()
        .is_none());
    add(&store, relayed("github", "api.github.com")).await;
    let grant = mint(&store, LEASE, &manager(), 600, &admit_all)
        .await
        .unwrap()
        .unwrap();
    assert!(!format!("{grant:?}").contains(&grant.token));
    assert_eq!(grant.hosts, vec!["api.github.com"]);
    assert!(grant.ca_pem.starts_with("-----BEGIN CERTIFICATE-----"));
    let session = {
        let conn = store.conn.lock().await;
        sessions::lookup(&conn, &grant.token, None)
            .unwrap()
            .unwrap()
    };
    assert!(is_box_session(&session));
    assert_eq!(session.minted_by, "box:lease-a");
    assert_eq!(session.services, vec!["github"]);
    assert!(session.expires_at <= session.created_at + 600_000);
    // Another Box's teardown leaves it alone; its own ends it.
    assert_eq!(revoke(&store, "lease-b").await.unwrap(), 0);
    assert_eq!(revoke(&store, LEASE).await.unwrap(), 1);
    let conn = store.conn.lock().await;
    assert!(sessions::lookup(&conn, &grant.token, None)
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn the_relay_admits_only_a_live_box_session_for_its_own_lease() {
    let store = leak_store();
    let (token, id) = box_session(store, &["svc"]).await;
    let headers = |token: &str, lease: Option<&str>| {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        if let Some(lease) = lease {
            headers.insert(LEASE_HEADER, lease.parse().unwrap());
        }
        headers
    };
    assert_eq!(
        admit(store, &headers(&token, Some(LEASE))).await,
        Some(id.clone())
    );
    // Another Box's lease, or none, is refused.
    assert_eq!(admit(store, &headers(&token, Some("lease-b"))).await, None);
    assert_eq!(admit(store, &headers(&token, None)).await, None);
    // A session that is not a Box's is refused.
    let human = {
        let conn = store.conn.lock().await;
        let request = sessions::MintRequest {
            environment: "default".into(),
            services: vec!["svc".into()],
            label: "human".into(),
            ttl_secs: None,
            minted_by: "operator".into(),
            not_after: None,
            minted_token: None,
            minter_scope: None,
        };
        sessions::mint(&conn, request).unwrap().0
    };
    assert_eq!(admit(store, &headers(&human, Some(LEASE))).await, None);
    revoke(store, LEASE).await.unwrap();
    assert_eq!(admit(store, &headers(&token, Some(LEASE))).await, None);
}

#[tokio::test]
async fn the_loopback_listener_refuses_a_box_session() {
    let store = leak_store();
    let (port, _seen) = upstream().await;
    let mut service = test_service("local", "127.0.0.1", Some(port), "/");
    service.allow_insecure_http = true;
    add(store, service).await;
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    let (token, _) = box_session(store, &["local"]).await;
    let (_broker, listener) = broker(store).await;
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", listener))
        .await
        .unwrap();
    let auth = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        format!("rvb:{token}"),
    );
    let request = get(
        port,
        "/x",
        &format!("Proxy-Authorization: Basic {auth}\r\n"),
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    assert!(read_head(&mut stream).await.starts_with("HTTP/1.1 407"));
}

#[tokio::test]
async fn a_relayed_session_reaches_its_services_and_nothing_else() {
    let store = leak_store();
    let (port, mut seen) = upstream().await;
    let (other, mut other_seen) = upstream().await;
    let mut service = test_service("local", "127.0.0.1", Some(port), "/");
    service.allow_insecure_http = true;
    add(store, service).await;
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    {
        // Passthrough would forward an unmatched host for a local session.
        let conn = store.conn.lock().await;
        settings::put(&conn, "default", UnmatchedHostPolicy::Passthrough, "").unwrap();
    }
    let (_, id) = box_session(store, &["local"]).await;
    let (broker, _) = broker(store).await;
    // The Box's own Proxy-Authorization is ignored: the relay's session applies.
    let response = relayed_request(
        &broker,
        &id,
        get(port, "/x", "Proxy-Authorization: Basic eDp5\r\n"),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let head = seen.recv().await.unwrap().to_ascii_lowercase();
    assert!(
        head.contains(&format!("authorization: bearer {TOKEN_VALUE}")),
        "{head}"
    );
    let refused = relayed_request(&broker, &id, get(other, "/y", "")).await;
    assert!(refused.starts_with("HTTP/1.1 403"), "{refused}");
    assert!(other_seen.try_recv().is_err());
    // A revoked session ends the relay.
    revoke(store, LEASE).await.unwrap();
    let ended = relayed_request(&broker, &id, get(port, "/x", "")).await;
    assert!(ended.starts_with("HTTP/1.1 407"), "{ended}");
}

#[tokio::test]
async fn a_relayed_session_substitutes_placeholders_in_headers_only() {
    let store = leak_store();
    let (port, mut seen) = upstream().await;
    let mut service = test_service("local", "127.0.0.1", Some(port), "/");
    service.allow_insecure_http = true;
    service.substitutions = vec![Substitution {
        placeholder: "__KEY__".into(),
        reference: "secret:API_TOKEN".into(),
        surfaces: vec![Surface::Header, Surface::Query],
    }];
    add(store, service).await;
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    let (_, id) = box_session(store, &["local"]).await;
    let (broker, _) = broker(store).await;
    let response = relayed_request(
        &broker,
        &id,
        get(port, "/x?k=__KEY__", "X-Key: __KEY__\r\n"),
    )
    .await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let head = seen.recv().await.unwrap();
    assert!(head.contains(&format!("x-key: {TOKEN_VALUE}")), "{head}");
    assert!(head.contains("/x?k=__KEY__"), "{head}");
}

#[tokio::test]
async fn the_relay_socket_carries_a_box_connection_to_the_broker() {
    use futures_util::{SinkExt as _, StreamExt as _};
    use tokio_tungstenite::tungstenite::{client::IntoClientRequest as _, Message};

    let store = leak_store();
    let (port, mut seen) = upstream().await;
    let mut service = test_service("local", "127.0.0.1", Some(port), "/");
    service.allow_insecure_http = true;
    add(store, service).await;
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    let (token, _) = box_session(store, &["local"]).await;
    let (broker, _) = broker(store).await;
    let source: socket::Source = Arc::new(move || Some((store, broker.clone())));
    let app: axum::Router = router_with(source);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let relay = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let request = |token: &str| {
        let mut request = format!("ws://127.0.0.1:{relay}{RELAY_PATH}")
            .into_client_request()
            .unwrap();
        let headers = request.headers_mut();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        headers.insert(LEASE_HEADER, LEASE.parse().unwrap());
        request
    };
    let refused = tokio_tungstenite::connect_async(request("rvb_unknown")).await;
    assert!(refused.is_err());
    let (mut socket, _) = tokio_tungstenite::connect_async(request(&token))
        .await
        .unwrap();
    socket
        .send(Message::Binary(get(port, "/x", "").into_bytes()))
        .await
        .unwrap();
    let mut reply = Vec::new();
    while let Some(Ok(message)) = socket.next().await {
        if let Message::Binary(data) = message {
            reply.extend_from_slice(&data);
        }
        if reply.ends_with(b"ok") {
            break;
        }
    }
    assert!(String::from_utf8_lossy(&reply).starts_with("HTTP/1.1 200"));
    assert!(seen
        .recv()
        .await
        .unwrap()
        .to_ascii_lowercase()
        .contains(TOKEN_VALUE));
}
