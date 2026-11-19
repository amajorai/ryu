//! `GET`/`PUT /api/vault/personal-overrides` and the export it changes, in
//! both states.

use super::super::super::tests::{caller, ctx, node, parts};
use super::super::{export_with, ExportBody};
use super::*;

fn set_body(enabled: bool) -> PersonalOverridesBody {
    serde_json::from_value(json!({ "enabled": enabled })).unwrap()
}

async fn write(ctx: &Ctx, scope: SecretScope, scope_id: &str, value: &str) {
    ctx.store
        .write_secret(WriteRequest {
            coords: SecretCoords::root(scope, scope_id, None, "API_KEY"),
            value: Some(value),
            patch: SecretMetadataPatch::default(),
            actor: &ctx.actor(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
}

async fn exported_api_key(ctx: &Ctx) -> String {
    let body: ExportBody = serde_json::from_value(json!({ "format": "json" })).unwrap();
    let (status, text) = parts(export_with(ctx, body).await).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let content: Value = serde_json::from_str(&text).unwrap();
    let values: Value = serde_json::from_str(content["content"].as_str().unwrap()).unwrap();
    values["API_KEY"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn a_user_reads_and_switches_their_own_setting() {
    let org_node = node(NodeScope::Org, None, None);
    let member = ctx(
        Some(org_node),
        Some(caller("user-1", OrgRole::Member, &[])),
        false,
        Vec::new(),
    );
    let (status, text) = parts(get_with(&member).await).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap(),
        json!({ "userId": "user-1", "enabled": true })
    );

    let (status, text) = parts(put_with(&member, set_body(false)).await).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert!(text.contains(r#""enabled":false"#), "{text}");
    let (_, text) = parts(get_with(&member).await).await;
    assert!(text.contains(r#""enabled":false"#), "{text}");
    assert!(!crate::vault::shared::personal_overrides::enabled(member.store, "user-1").await);
    // Another user on the same store keeps the default.
    assert!(crate::vault::shared::personal_overrides::enabled(member.store, "user-2").await);

    let filter = AuditFilter {
        limit: 10,
        action: Some("vault.personal_overrides".to_owned()),
        ..AuditFilter::default()
    };
    let audited = {
        let conn = member.store.conn.lock().await;
        crate::vault::audit::list(&conn, &filter).unwrap()
    };
    assert_eq!(audited.len(), 1, "the switch is audited");

    let (status, _) = parts(put_with(&member, set_body(true)).await).await;
    assert_eq!(status, StatusCode::OK);
    let (_, text) = parts(get_with(&member).await).await;
    assert!(text.contains(r#""enabled":true"#), "{text}");
}

#[tokio::test]
async fn a_registered_node_without_a_user_is_refused() {
    let anonymous = ctx(
        Some(node(NodeScope::Org, None, None)),
        None,
        true,
        Vec::new(),
    );
    let (status, text) = parts(get_with(&anonymous).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
    let (status, text) = parts(put_with(&anonymous, set_body(false)).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
}

#[tokio::test]
async fn the_local_operator_has_a_setting_of_their_own() {
    let operator = ctx(None, None, true, Vec::new());
    let (status, text) = parts(put_with(&operator, set_body(false)).await).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert!(text.contains(r#""userId":"local""#), "{text}");
}

#[test]
fn the_body_takes_only_enabled() {
    assert!(serde_json::from_value::<PersonalOverridesBody>(json!({})).is_err());
    assert!(serde_json::from_value::<PersonalOverridesBody>(
        json!({ "enabled": true, "user": "x" })
    )
    .is_err());
}

#[tokio::test]
async fn an_export_follows_the_callers_setting() {
    // A manager on an organization node: shared values are off in tests, so
    // the organization's value is exported from this node's store.
    let org_node = node(NodeScope::Org, None, None);
    let manager = ctx(
        Some(org_node),
        Some(caller("user-1", OrgRole::Admin, &[])),
        true,
        Vec::new(),
    );
    write(&manager, SecretScope::Org, "org-1", "org-value").await;
    write(&manager, SecretScope::User, "user-1", "personal-value").await;

    assert_eq!(exported_api_key(&manager).await, "personal-value");
    let (status, _) = parts(put_with(&manager, set_body(false)).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(exported_api_key(&manager).await, "org-value");
}
