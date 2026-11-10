//! Absolute-form forwarding, refusals, limits, and CONNECT interception.

use super::*;

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
