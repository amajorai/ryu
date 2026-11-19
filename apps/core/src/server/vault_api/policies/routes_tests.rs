//! `GET`/`PUT`/`DELETE /api/vault/policies[/{name}]`: admin-only, validated
//! writes, audited changes, and a delete that also drops the policy's
//! bindings.

use super::*;
use crate::server::vault_api::tests::{caller, ctx, node, parts};

fn operator() -> Ctx {
    ctx(None, None, true, Vec::new())
}

fn member_on(store: &'static PluginSecretStore) -> Ctx {
    let mut member = ctx(
        Some(node(NodeScope::Org, None, None)),
        Some(caller("user-1", OrgRole::Member, &[])),
        false,
        Vec::new(),
    );
    member.store = store;
    member
}

fn body(value: Value) -> PolicyBody {
    serde_json::from_value(value).unwrap()
}

fn reader_rules() -> Value {
    json!({
        "description": "CI reads staging",
        "rules": [{ "path": "staging/**", "capabilities": ["list", "read"] }],
    })
}

async fn audited(store: &PluginSecretStore, action: &str) -> Vec<String> {
    let conn = store.conn.lock().await;
    let mut statement = conn
        .prepare("SELECT details FROM vault_audit WHERE action = ?1 ORDER BY seq")
        .unwrap();
    statement
        .query_map([action], |row| row.get::<_, Option<String>>(0))
        .unwrap()
        .map(|row| row.unwrap().unwrap_or_default())
        .collect()
}

#[tokio::test]
async fn only_an_admin_on_sys_policies_lists_writes_or_deletes_policies() {
    let admin = operator();
    let member = member_on(admin.store);
    let (status, _) = parts(list_policies_with(&member).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) =
        parts(put_policy_with(&member, "ci".into(), body(reader_rules())).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = parts(delete_policy_with(&member, "ci").await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // Nothing was written or audited for the refused calls.
    assert!(audited(admin.store, "policy.put").await.is_empty());
    let conn = admin.store.conn.lock().await;
    assert!(crate::vault::policy::list_policies(&conn)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn put_validates_saves_and_audits_and_list_returns_it() {
    let admin = operator();
    let invalid = json!({ "rules": [{ "path": "", "capabilities": ["read"] }] });
    let (status, text) = parts(put_policy_with(&admin, "bad".into(), body(invalid)).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{text}");
    assert!(audited(admin.store, "policy.put").await.is_empty());

    let (status, text) =
        parts(put_policy_with(&admin, "ci".into(), body(reader_rules())).await).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let saved: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(saved["policy"]["name"], "ci");

    // A second PUT replaces the rules instead of adding to them.
    let replaced = json!({ "rules": [{ "path": "prod/**", "capabilities": ["list"] }] });
    let (status, _) = parts(put_policy_with(&admin, "ci".into(), body(replaced)).await).await;
    assert_eq!(status, StatusCode::OK);
    let (status, text) = parts(list_policies_with(&admin).await).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let listed: Value = serde_json::from_str(&text).unwrap();
    let policies = listed["policies"].as_array().unwrap();
    assert_eq!(policies.len(), 1);
    assert_eq!(policies[0]["rules"][0]["path"], "prod/**");
    assert_eq!(policies[0]["description"], "");
    let audits = audited(admin.store, "policy.put").await;
    assert_eq!(audits.len(), 2);
    assert!(audits.iter().all(|details| details.contains("\"ci\"")));
}

#[tokio::test]
async fn delete_removes_the_policy_and_its_bindings_and_reports_a_missing_one() {
    let admin = operator();
    let (status, _) = parts(put_policy_with(&admin, "ci".into(), body(reader_rules())).await).await;
    assert_eq!(status, StatusCode::OK);
    {
        let conn = admin.store.conn.lock().await;
        crate::vault::policy::bind(&conn, "ci", "machine:m1", None, None).unwrap();
        assert_eq!(crate::vault::policy::list_bindings(&conn).unwrap().len(), 1);
    }
    let (status, text) = parts(delete_policy_with(&admin, "ci").await).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap()["deleted"],
        true
    );
    {
        let conn = admin.store.conn.lock().await;
        assert!(crate::vault::policy::list_policies(&conn)
            .unwrap()
            .is_empty());
        assert!(crate::vault::policy::list_bindings(&conn)
            .unwrap()
            .is_empty());
    }
    let (status, text) = parts(delete_policy_with(&admin, "ci").await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap()["deleted"],
        false
    );
    assert_eq!(audited(admin.store, "policy.delete").await.len(), 2);
}

#[tokio::test]
async fn create_only_refuses_an_existing_name_and_replaces_nothing() {
    let admin = operator();
    let mut first = reader_rules();
    first["createOnly"] = json!(true);
    let (status, text) = parts(put_policy_with(&admin, "ci".into(), body(first)).await).await;
    assert_eq!(status, StatusCode::OK, "{text}");

    let second = json!({
        "createOnly": true,
        "rules": [{ "path": "**", "capabilities": ["admin"] }],
    });
    let (status, text) = parts(put_policy_with(&admin, "ci".into(), body(second)).await).await;
    assert_eq!(status, StatusCode::CONFLICT, "{text}");
    assert!(text.contains("already exists"), "{text}");
    let conn = admin.store.conn.lock().await;
    let policies = crate::vault::policy::list_policies(&conn).unwrap();
    assert_eq!(policies.len(), 1);
    assert_eq!(policies[0].rules[0].path, "staging/**");
    drop(conn);
    // Only the first write was audited; without the flag a PUT still replaces.
    assert_eq!(audited(admin.store, "policy.put").await.len(), 1);
    let replace = json!({ "rules": [{ "path": "prod/**", "capabilities": ["list"] }] });
    let (status, _) = parts(put_policy_with(&admin, "ci".into(), body(replace)).await).await;
    assert_eq!(status, StatusCode::OK);
}
