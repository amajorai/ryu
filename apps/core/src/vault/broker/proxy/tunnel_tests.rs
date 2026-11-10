//! Intercepted and raw tunnels: path confinement, revocation, caps, and sealing.

use super::*;

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
    let issued = crate::vault::broker::test_machine_token(store, "ci", vec!["ci".into()]).await;
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
