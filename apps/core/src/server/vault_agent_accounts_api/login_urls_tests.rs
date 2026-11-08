use axum::http::StatusCode;

use super::*;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::agent_accounts::{self, CreateInput};
use crate::vault::audit::AuditActor;

fn operator(store: &'static PluginSecretStore) -> Ctx {
    Ctx {
        store,
        node: None,
        node_id: "local".into(),
        caller: None,
        manager: true,
        policies: Vec::new(),
        jwt: None,
    }
}

fn reader(store: &'static PluginSecretStore) -> Ctx {
    let policy: crate::vault::policy::Policy = serde_json::from_value(json!({
        "name": "items",
        "rules": [{ "path": "sys/items/**", "capabilities": ["list", "read"] }],
    }))
    .unwrap();
    Ctx {
        manager: false,
        policies: vec![policy],
        ..operator(store)
    }
}

fn query(agent: &str) -> AccountQuery {
    AccountQuery {
        agent_id: Some(agent.into()),
        site: None,
    }
}

async fn body(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn store_with_account(agent: &str) -> (&'static PluginSecretStore, String) {
    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    let account = agent_accounts::create(
        store,
        Some(agent),
        CreateInput {
            site: "https://example.com".into(),
            ..CreateInput::default()
        },
        &AuditActor::new("agent", Some(agent)),
    )
    .await
    .unwrap();
    (store, account.id)
}

async fn audit_rows(store: &'static PluginSecretStore) -> Vec<crate::vault::audit::AuditRow> {
    let conn = store.conn.lock().await;
    let filter = crate::vault::audit::AuditFilter {
        limit: 200,
        ..Default::default()
    };
    crate::vault::audit::list(&conn, &filter).unwrap()
}

#[tokio::test]
async fn a_valid_change_is_stored_reported_and_audited() {
    let (store, id) = store_with_account("agent-1").await;
    let change = json!({ "account": id, "submit_urls": ["https://example.com/session"] });
    let (status, answered) =
        body(set(&operator(store), &query("agent-1"), change, None).await).await;
    assert_eq!(status, StatusCode::OK, "{answered}");
    assert_eq!(
        answered["account"]["submit_urls"],
        json!(["https://example.com/session"])
    );
    assert!(answered["account"].get("password").is_none(), "{answered}");
    let listed = agent_accounts::list(store, Some("agent-1"), None)
        .await
        .unwrap();
    assert_eq!(listed[0].submit_urls, ["https://example.com/session"]);

    let replace = json!({ "account": id, "submit_urls": ["https://auth.example.com/login"] });
    let (status, _) = body(set(&operator(store), &query("agent-1"), replace, None).await).await;
    assert_eq!(status, StatusCode::OK);

    let rows = audit_rows(store).await;
    let changes: Vec<_> = rows.iter().filter(|r| r.action == AUDIT_ACTION).collect();
    assert_eq!(changes.len(), 2, "{rows:?}");
    let details = serde_json::to_string(&rows).unwrap();
    assert!(
        details.contains("\"before\":[\"https://example.com/session\"]"),
        "{details}"
    );
    assert!(
        details.contains("\"after\":[\"https://auth.example.com/login\"]"),
        "{details}"
    );
    assert!(details.contains("agent-1"), "{details}");
}

#[tokio::test]
async fn invalid_urls_are_refused_and_nothing_changes() {
    let (store, id) = store_with_account("agent-1").await;
    for urls in [
        json!(["https://evil.example.net/session"]),
        json!(["http://example.com/session"]),
        json!(["https://user:pw@example.com/session"]),
        json!(["https://example.com/session#x"]),
        json!([
            "https://example.com/a",
            "https://example.com/b",
            "https://example.com/c",
            "https://example.com/d",
            "https://example.com/e"
        ]),
    ] {
        let change = json!({ "account": id, "submit_urls": urls });
        let (status, refused) =
            body(set(&operator(store), &query("agent-1"), change, None).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{urls}: {refused}");
    }
    let unknown_field = json!({ "account": id, "submit_urls": [], "site": "evil.example.net" });
    let (status, _) =
        body(set(&operator(store), &query("agent-1"), unknown_field, None).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let listed = agent_accounts::list(store, Some("agent-1"), None)
        .await
        .unwrap();
    assert!(listed[0].submit_urls.is_empty());
    assert!(audit_rows(store)
        .await
        .iter()
        .all(|r| r.action != AUDIT_ACTION));
}

#[tokio::test]
async fn another_agents_account_and_unauthorized_callers_are_refused() {
    let (store, id) = store_with_account("agent-1").await;
    let change = || json!({ "account": id, "submit_urls": ["https://example.com/session"] });
    // The account is not in agent-2's folder.
    let (status, _) = body(set(&operator(store), &query("agent-2"), change(), None).await).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // Create needs `write` on the agent's folder, and so does this.
    let (status, _) = body(set(&reader(store), &query("agent-1"), change(), None).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // An agent that acts as the user has no accounts of its own.
    let as_user =
        AgentAccountPolicy::from_parts(crate::agents::AgentIdentityMode::Managed, Some(&[]));
    let (status, _) = body(
        set(
            &operator(store),
            &query("agent-1"),
            change(),
            Some(&as_user),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let listed = agent_accounts::list(store, Some("agent-1"), None)
        .await
        .unwrap();
    assert!(listed[0].submit_urls.is_empty());
    assert!(audit_rows(store)
        .await
        .iter()
        .all(|r| r.action != AUDIT_ACTION));
}
