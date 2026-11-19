//! A webhook URL's path and query can carry a token: it must never reach an
//! audit row, through error text or role summaries.

use super::*;
use rusqlite::params;

const URL_SECRETS: [&str; 2] = ["PATHTOKEN", "QUERYTOKEN"];

/// Every audit row's details, as one string.
async fn audit_text(store: &PluginSecretStore) -> String {
    let conn = store.conn.lock().await;
    let mut stmt = conn
        .prepare("SELECT action, details FROM vault_audit")
        .unwrap();
    let rows = stmt
        .query_map([], |row| {
            Ok(format!(
                "{} {}",
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?
            ))
        })
        .unwrap();
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
        .join("\n")
}

#[tokio::test]
async fn a_token_in_a_webhook_url_reaches_no_audit_row() {
    let app = axum::Router::new().route(
        "/hook/PATHTOKEN",
        axum::routing::post(|| async {
            axum::Json(json!({ "data": { "password": "p" }, "revokeData": { "user": "u" } }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/hook/PATHTOKEN?token=QUERYTOKEN",
        listener.local_addr().unwrap()
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let config: ProviderConfig = serde_json::from_value(json!({
        "kind": "webhook", "url": url, "signingSecret": "webhook-signing-secret-0001"
    }))
    .unwrap();
    store
        .dynamic_put_role("tokened", &config, Some(600), Some(600), &actor)
        .await
        .unwrap();
    let issued = store
        .dynamic_issue("tokened", None, None, &actor)
        .await
        .unwrap();

    // The provider goes away: every later call is a connection error, whose
    // reqwest text would end with the URL.
    server.abort();
    let _ = server.await;
    let revoke = store.dynamic_revoke(&issued.lease.id, &actor).await;
    assert!(revoke.is_err());
    let issue = store.dynamic_issue("tokened", None, None, &actor).await;
    assert!(issue.is_err());
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_leases SET expires_at = 0 WHERE id = ?1",
            params![issued.lease.id],
        )
        .unwrap();
    }
    let revoke_errors = |audit: &str| audit.matches("lease.revoke").count();
    let before_reap = revoke_errors(&audit_text(&store).await);
    assert_eq!(store.dynamic_reap().await.unwrap(), 0);
    // The reaper's own attempt wrote its own error row.
    assert!(revoke_errors(&audit_text(&store).await) > before_reap);

    let audit = audit_text(&store).await;
    assert!(audit.contains("lease.revoke"), "{audit}");
    assert!(audit.contains("dynamic.issue"), "{audit}");
    for secret in URL_SECRETS {
        assert!(!audit.contains(secret), "{secret} in:\n{audit}");
    }
    // Nor does the role listing.
    let listed = serde_json::to_string(&store.dynamic_list_roles().await.unwrap()).unwrap();
    for secret in URL_SECRETS {
        assert!(!listed.contains(secret), "{listed}");
    }
}

#[tokio::test]
async fn stored_webhook_summaries_are_reduced_to_their_origin_once() {
    let store = PluginSecretStore::in_memory().unwrap();
    let conn = store.conn.lock().await;
    // A role written before summaries were reduced.
    conn.execute(
        "INSERT INTO vault_dynamic_roles
             (name, provider, default_ttl_secs, max_ttl_secs, summary, created_at, updated_at,
              nonce, ciphertext, key_version)
         VALUES ('old', 'webhook', 60, 60, ?1, 0, 0, x'00', x'00', 0)",
        params![
            json!({ "url": "https://u:pw@hooks.example.com/hook/PATHTOKEN?token=QUERYTOKEN" })
                .to_string()
        ],
    )
    .unwrap();
    init_schema(&conn).unwrap();
    init_schema(&conn).unwrap();
    let summary: String = conn
        .query_row(
            "SELECT summary FROM vault_dynamic_roles WHERE name = 'old'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&summary).unwrap(),
        json!({ "url": "https://hooks.example.com" })
    );
}

#[tokio::test]
async fn the_provider_http_client_drops_the_url_from_its_errors() {
    // The client the HTTP-API providers share (Kubernetes, GCP, Azure,
    // RabbitMQ): nothing listens on port 1, so the send fails with a
    // connection error whose reqwest text would end with the URL.
    let error = super::http::send(
        super::http::HttpCall {
            method: "POST",
            url: "http://127.0.0.1:1/api/PATHTOKEN?token=QUERYTOKEN".into(),
            headers: Vec::new(),
            body: None,
            ca_pem: None,
        },
        super::target_guard::TargetEgress::Trusted,
    )
    .await
    .unwrap_err();
    let text = format!("{error:#}");
    for secret in URL_SECRETS {
        assert!(!text.contains(secret), "{text}");
    }
}

/// Captures formatted log lines for the current thread.
#[derive(Clone, Default)]
struct Captured(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn a_token_in_a_webhook_url_reaches_no_log_line() {
    let captured = Captured::default();
    let sink = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_writer(move || sink.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    // This capture is thread-local. A test on another thread that first hits a
    // callsite (the reaper's warn!, the issue path's errors) caches it as
    // disabled, even while this capture is live, and the event never reaches
    // it. Rebuild the interest cache before each step whose lines are checked,
    // so the capture sees them whatever runs in parallel.
    tracing::callsite::rebuild_interest_cache();

    let app = axum::Router::new().route(
        "/hook/PATHTOKEN",
        axum::routing::post(|| async {
            axum::Json(json!({ "data": { "password": "p" }, "revokeData": { "user": "u" } }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/hook/PATHTOKEN?token=QUERYTOKEN",
        listener.local_addr().unwrap()
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let config: ProviderConfig = serde_json::from_value(json!({
        "kind": "webhook", "url": url, "signingSecret": "webhook-signing-secret-0001"
    }))
    .unwrap();
    store
        .dynamic_put_role("tokened", &config, Some(600), Some(600), &actor)
        .await
        .unwrap();
    let issued = store.dynamic_issue("tokened", None, None, &actor).await.unwrap();
    server.abort();
    let _ = server.await;
    tracing::callsite::rebuild_interest_cache();
    assert!(store.dynamic_issue("tokened", None, None, &actor).await.is_err());
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_leases SET expires_at = 0 WHERE id = ?1",
            params![issued.lease.id],
        )
        .unwrap();
    }
    tracing::callsite::rebuild_interest_cache();
    assert_eq!(store.dynamic_reap().await.unwrap(), 0);

    let logs = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    // The reaper's failure was logged, so the capture saw the warn! line.
    assert!(logs.contains("revoking expired lease"), "{logs}");
    for secret in URL_SECRETS {
        assert!(!logs.contains(secret), "{secret} in:\n{logs}");
    }
}
