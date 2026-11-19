use super::*;
use crate::plugin_secrets::SecretResolutionContext;
use crate::vault::broker::services::test_service;
use crate::vault::policy::PolicyRule;

fn policy(rules: Vec<PolicyRule>) -> Vec<Policy> {
    vec![Policy {
        name: "p".into(),
        description: String::new(),
        rules,
    }]
}

fn use_rule(path: &str) -> PolicyRule {
    PolicyRule {
        path: path.into(),
        capabilities: vec![Capability::Use],
        ..Default::default()
    }
}

fn leak_store() -> &'static PluginSecretStore {
    Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()))
}

async fn with_service(store: &PluginSecretStore) {
    let conn = store.conn.lock().await;
    services::insert(&conn, test_service("gh", "api.github.com", None, "/")).unwrap();
}

fn status(result: Result<Value, Response>) -> StatusCode {
    match result {
        Ok(_) => StatusCode::OK,
        Err(response) => response.status(),
    }
}

#[tokio::test]
async fn members_need_a_session_and_use_on_the_service() {
    let store = leak_store();
    with_service(store).await;
    let mut operator = Ctx::test_member(store, "alice", policy(vec![use_rule("sys/broker/gh")]));
    operator.caller = None;
    assert_eq!(
        status(list_member_values(&operator, "gh").await),
        StatusCode::UNAUTHORIZED
    );
    let outsider = Ctx::test_member(store, "bob", Vec::new());
    assert_eq!(
        status(put_member_value(&outsider, "gh", "secret:API_TOKEN", Some("v")).await),
        StatusCode::FORBIDDEN
    );
    let alice = Ctx::test_member(store, "alice", policy(vec![use_rule("sys/broker/*")]));
    assert_eq!(
        status(list_member_values(&alice, "missing").await),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        status(put_member_value(&alice, "gh", "secret:OTHER", Some("v")).await),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        status(put_member_value(&alice, "gh", "secret:API_TOKEN", Some("")).await),
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn a_member_value_is_personal_and_wins_only_for_that_member() {
    let store = leak_store();
    with_service(store).await;
    let alice = Ctx::test_member(store, "alice", policy(vec![use_rule("sys/broker/gh")]));
    let listed = list_member_values(&alice, "gh").await.unwrap();
    assert_eq!(listed["slots"][0]["reference"], "secret:API_TOKEN");
    assert_eq!(listed["slots"][0]["provided"], false);

    let saved = put_member_value(&alice, "gh", "secret:API_TOKEN", Some("alice-token"))
        .await
        .unwrap();
    assert_eq!(saved["provided"], true);
    assert!(!saved.to_string().contains("alice-token"));
    let listed = list_member_values(&alice, "gh").await.unwrap();
    assert_eq!(listed["slots"][0]["provided"], true);
    assert!(!listed.to_string().contains("alice-token"));

    // Stored in Alice's personal scope, not as a shared or node value.
    let infos = store.list_vault_secrets().await.unwrap();
    assert_eq!(infos.len(), 1);
    assert_eq!(infos[0].scope, SecretScope::User);
    assert_eq!(infos[0].scope_id, "alice");

    let as_user = |user: &str| SecretResolutionContext {
        user_id: Some(user.to_owned()),
        ..SecretResolutionContext::node_only("node-1", Vec::new())
    };
    assert_eq!(
        store
            .resolve_vault_secret("API_TOKEN", &as_user("alice"))
            .await
            .unwrap()
            .as_deref(),
        Some("alice-token")
    );
    assert_eq!(
        store
            .resolve_vault_secret("API_TOKEN", &as_user("bob"))
            .await
            .unwrap(),
        None
    );

    let cleared = put_member_value(&alice, "gh", "secret:API_TOKEN", None)
        .await
        .unwrap();
    assert_eq!(cleared["changed"], true);
    let listed = list_member_values(&alice, "gh").await.unwrap();
    assert_eq!(listed["slots"][0]["provided"], false);
    let audits: i64 = {
        let conn = store.conn.lock().await;
        conn.query_row(
            "SELECT COUNT(*) FROM vault_audit WHERE action LIKE 'broker.member_value.%'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(audits, 2);
}
