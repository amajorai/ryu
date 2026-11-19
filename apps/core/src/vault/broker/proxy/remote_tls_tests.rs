//! The remote listener over TLS, end to end on 127.0.0.1.

use super::*;
use crate::vault::broker::delegation::{self, SessionAttrs};
use crate::vault::broker::remote::RemoteConfig;

async fn start_tls_remote(store: &'static PluginSecretStore) -> u16 {
    let (broker, _loopback) = Broker::bind(store, loopback_config()).await.unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = RemoteConfig::parse(
        Some(&listener.local_addr().unwrap().to_string()),
        Some("127.0.0.0/8"),
        None,
        true,
    )
    .unwrap()
    .unwrap();
    assert_eq!(config.url, Some(format!("https://127.0.0.1:{port}")));
    tokio::spawn(broker.serve_remote(listener, config));
    port
}

async fn tls_client(
    store: &PluginSecretStore,
    port: u16,
) -> std::io::Result<tokio_rustls::client::TlsStream<TcpStream>> {
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
    let tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let name = rustls::pki_types::ServerName::try_from("127.0.0.1").unwrap();
    tokio_rustls::TlsConnector::from(Arc::new(client))
        .connect(name, tcp)
        .await
}

#[tokio::test]
async fn the_tls_remote_listener_serves_remote_sessions_over_a_broker_ca_certificate() {
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    let (upstream, mut seen) = fake_http_upstream().await;
    let mut service = test_service("svc", "127.0.0.1", Some(upstream), "/");
    service.allow_insecure_http = true;
    add_service(store, service).await;
    let (local_only, _) = mint(store, &["svc"]).await;
    let (remote, session) = mint(store, &["svc"]).await;
    {
        let conn = store.conn.lock().await;
        delegation::insert(
            &conn,
            &session.id,
            &SessionAttrs {
                on_behalf_of: None,
                remote: true,
            },
        )
        .unwrap();
    }
    let port = start_tls_remote(store).await;
    let url = format!("http://127.0.0.1:{upstream}/");

    // The handshake verifies against the broker CA for the listen address.
    let mut tls = tls_client(store, port).await.unwrap();
    tls.write_all(get_via_proxy(&url, Some(&remote), "").as_bytes())
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let forwarded = seen.recv().await.unwrap();
    assert!(forwarded.contains(TOKEN_VALUE), "{forwarded}");

    // A loopback-only session is still refused over TLS.
    let mut tls = tls_client(store, port).await.unwrap();
    tls.write_all(get_via_proxy(&url, Some(&local_only), "").as_bytes())
        .await
        .unwrap();
    let response = read_message(&mut tls).await;
    assert!(response.starts_with("HTTP/1.1 407"), "{response}");

    // Plain HTTP to the TLS listener gets no HTTP answer.
    let mut plain = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let _ = plain
        .write_all(get_via_proxy(&url, Some(&remote), "").as_bytes())
        .await;
    let mut reply = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(15), plain.read_to_end(&mut reply)).await;
    assert!(
        !String::from_utf8_lossy(&reply).starts_with("HTTP/1.1"),
        "{}",
        String::from_utf8_lossy(&reply)
    );
}
