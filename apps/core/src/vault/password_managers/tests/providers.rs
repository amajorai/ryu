//! 1Password: the `op` service-account CLI and a fake Connect server.

use super::*;

// ── 1Password service account (`op`) ──────────────────────────────────────

#[tokio::test]
async fn service_accounts_shell_out_to_op_with_the_token_in_env_only() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    add_cli_account(
        &store,
        dir.path(),
        "svc",
        "1password-service-account",
        OP_TOKEN,
    )
    .await;
    let request = pending(
        store
            .pm_resolve("op://svc@dev/GitHub/token", &consumer("user:a"), &actor())
            .await
            .unwrap(),
    );
    store
        .pm_approve(&request.id, GrantMode::Once, "", "operator", &actor())
        .await
        .unwrap();
    // The account qualifier is optional with one account; the grant key is the
    // qualified reference either way.
    assert_eq!(
        value(
            store
                .pm_resolve("op://dev/GitHub/token", &consumer("user:a"), &actor())
                .await
                .unwrap()
        ),
        "op-secret-value"
    );
    let log = calls(dir.path());
    assert!(log.contains(&"argv:read --no-newline op://dev/GitHub/token".to_owned()));
    assert!(log.contains(&"token-in-argv:no".to_owned()));
    assert!(log.contains(&"env-token:yes".to_owned()));

    // A missing item is a sanitized not-found, and the once grant survives.
    let request = pending(
        store
            .pm_resolve("op://dev/Missing/token", &consumer("user:a"), &actor())
            .await
            .unwrap(),
    );
    let grant = store
        .pm_approve(&request.id, GrantMode::Once, "", "operator", &actor())
        .await
        .unwrap();
    let missing = store
        .pm_resolve("op://dev/Missing/token", &consumer("user:a"), &actor())
        .await
        .unwrap_err();
    let failure = missing.downcast_ref::<ProviderFailure>().unwrap();
    assert_eq!(failure.kind, FailureKind::NotFound);
    assert!(!failure.message.contains("isn't an item"));
    assert_eq!(
        store.pm_grant(&grant.id).await.unwrap().uses_remaining,
        Some(1)
    );
}

// ── 1Password Connect ─────────────────────────────────────────────────────

#[derive(Default)]
struct ConnectFake {
    hits: usize,
    queries: Vec<String>,
}

const VAULT_ID: &str = "vvvvvvvvvvvvvvvvvvvvvvvvv1";
const ITEM_ID: &str = "iiiiiiiiiiiiiiiiiiiiiiiii1";

async fn connect_handler(
    State(fake): State<Arc<Mutex<ConnectFake>>>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let mut fake = fake.lock().unwrap();
    fake.hits += 1;
    fake.queries
        .push(uri.query().unwrap_or_default().to_owned());
    let authorized = headers.get("authorization").and_then(|v| v.to_str().ok())
        == Some(&format!("Bearer {CONNECT_TOKEN}"));
    if !authorized {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(json!({ "message": "bad token" })),
        )
            .into_response();
    }
    let query = url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        .find(|(key, _)| key == "filter")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    let body = match uri.path() {
        "/v1/vaults" if query.contains("name eq \"dev\"") => {
            json!([{ "id": VAULT_ID, "name": "dev" }])
        }
        "/v1/vaults" if query.is_empty() => json!([{ "id": VAULT_ID, "name": "dev" }]),
        "/v1/vaults" => json!([]),
        p if p == format!("/v1/vaults/{VAULT_ID}/items")
            && query.contains("title eq \"GitHub\"") =>
        {
            json!([{ "id": ITEM_ID, "title": "GitHub" }])
        }
        p if p == format!("/v1/vaults/{VAULT_ID}/items") => json!([]),
        p if p == format!("/v1/vaults/{VAULT_ID}/items/{ITEM_ID}") => json!({
            "id": ITEM_ID,
            "sections": [{ "id": "s1", "label": "api" }],
            "fields": [
                { "id": "username", "label": "username", "value": "octocat" },
                { "id": "f1", "label": "token", "value": "connect-secret-value", "section": { "id": "s1" } },
            ],
        }),
        _ => return (StatusCode::NOT_FOUND, axum::Json(json!({}))).into_response(),
    };
    (StatusCode::OK, axum::Json(body)).into_response()
}

async fn serve_connect() -> (String, Arc<Mutex<ConnectFake>>) {
    let fake = Arc::new(Mutex::new(ConnectFake::default()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = axum::Router::new()
        .fallback(connect_handler)
        .with_state(fake.clone());
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });
    (format!("http://{addr}"), fake)
}

async fn add_connect(store: &PluginSecretStore, address: &str, token: &str) -> AccountRecord {
    let input: AccountInput = serde_json::from_value(json!({
        "name": "work", "provider": "1password-connect", "address": address, "token": token,
    }))
    .unwrap();
    store.pm_account_create(input, &actor()).await.unwrap()
}

#[tokio::test]
async fn connect_resolves_by_vault_and_item_title_after_approval() {
    let (address, fake) = serve_connect().await;
    let store = PluginSecretStore::in_memory().unwrap();
    let account = add_connect(&store, &address, CONNECT_TOKEN).await;
    store.pm_account_test(&account.id, &actor()).await.unwrap();
    let after_test = fake.lock().unwrap().hits;

    let reference = "op://dev/GitHub/api/token";
    let request = pending(
        store
            .pm_resolve(reference, &consumer("user:a"), &actor())
            .await
            .unwrap(),
    );
    assert_eq!(
        fake.lock().unwrap().hits,
        after_test,
        "Connect was contacted before approval"
    );
    store
        .pm_approve(&request.id, GrantMode::Hour, "", "operator", &actor())
        .await
        .unwrap();
    assert_eq!(
        value(
            store
                .pm_resolve(reference, &consumer("user:a"), &actor())
                .await
                .unwrap()
        ),
        "connect-secret-value"
    );
    let request = pending(
        store
            .pm_resolve("op://dev/GitHub/username", &consumer("user:a"), &actor())
            .await
            .unwrap(),
    );
    store
        .pm_approve(&request.id, GrantMode::Hour, "", "operator", &actor())
        .await
        .unwrap();
    assert_eq!(
        value(
            store
                .pm_resolve("op://dev/GitHub/username", &consumer("user:a"), &actor())
                .await
                .unwrap()
        ),
        "octocat"
    );
    let queries = fake.lock().unwrap().queries.clone();
    assert!(queries.iter().any(|q| q.contains("filter=")));
}

#[tokio::test]
async fn connect_rejecting_the_token_requires_reconnect() {
    let (address, _fake) = serve_connect().await;
    let store = PluginSecretStore::in_memory().unwrap();
    let account = add_connect(&store, &address, "stale-token").await;
    let request = pending(
        store
            .pm_resolve("op://dev/GitHub/username", &consumer("user:a"), &actor())
            .await
            .unwrap(),
    );
    store
        .pm_approve(&request.id, GrantMode::Day, "", "operator", &actor())
        .await
        .unwrap();
    let refused = store
        .pm_resolve("op://dev/GitHub/username", &consumer("user:a"), &actor())
        .await
        .unwrap_err();
    assert_eq!(
        refused.downcast_ref::<ProviderFailure>().unwrap().kind,
        FailureKind::Auth
    );
    assert_eq!(
        store.pm_account(&account.id).await.unwrap().state,
        AccountState::ReconnectRequired
    );
    let rows = audit_rows(&store).await;
    assert!(rows
        .iter()
        .any(|r| r.action == "pm.resolve" && r.outcome == "reconnect_required"));
}
