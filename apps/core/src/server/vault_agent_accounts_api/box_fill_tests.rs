//! Box fill authorization from metadata alone, and the audited release.

use super::*;
use crate::agents::AgentIdentityMode;
use crate::vault::agent_accounts::fill_sets::{build, CreateInput as SetInput, ItemInput};
use crate::vault::agent_accounts::{create, CreateInput};
use crate::vault::items::{ItemPut, PutAccess};
use serde_json::json;

const BOX: &str = "bx_0123456789abcdef0123456789abcdef";
const SECRET: &str = "hunter2-correct-horse";

fn code(error: &anyhow::Error) -> &'static str {
    error
        .downcast_ref::<VaultError>()
        .map_or("other", VaultError::code)
}

async fn reveals(store: &PluginSecretStore) -> usize {
    let conn = store.conn.lock().await;
    let filter = crate::vault::audit::AuditFilter {
        limit: 500,
        ..Default::default()
    };
    crate::vault::audit::list(&conn, &filter)
        .unwrap()
        .iter()
        .filter(|row| row.action == "item.reveal")
        .count()
}

async fn own(store: &PluginSecretStore, login: &[&str]) -> String {
    let input = CreateInput {
        site: "github.com".into(),
        submit_urls: login.iter().map(|u| (*u).to_owned()).collect(),
        ..CreateInput::default()
    };
    create(
        store,
        Some("agent-1"),
        input,
        &AuditActor::new("agent", Some("agent-1")),
    )
    .await
    .unwrap()
    .id
}

async fn attach(store: &PluginSecretStore, registry: &Registry, user_field: &str, login: &[&str]) {
    let mut values = serde_json::Map::new();
    values.insert("url".into(), json!("https://github.com/login"));
    values.insert(user_field.into(), json!("jay"));
    values.insert("password".into(), json!(SECRET));
    let put: ItemPut = serde_json::from_value(json!({
        "environment": "default", "path": "web", "kind": "login",
        "fields": [
            { "name": "url", "type": "url" },
            { "name": user_field, "type": "text" },
            { "name": "password", "type": "password" },
        ],
        "values": values,
    }))
    .unwrap();
    let user = AuditActor::new("user", Some("u1"));
    store
        .item_put("gh", put, &user, PutAccess::FULL)
        .await
        .unwrap();
    let input = SetInput {
        agent_id: "agent-1".into(),
        items: vec![ItemInput {
            environment: None,
            path: Some("web".into()),
            key: "gh".into(),
            site: None,
            submit_urls: login.iter().map(|u| (*u).to_owned()).collect(),
            box_unbound: false,
        }],
        ttl_secs: None,
    };
    let now = crate::vault::now_millis();
    registry
        .insert(build(store, &input, now).await.unwrap(), now)
        .unwrap();
}

#[tokio::test]
async fn an_own_account_needs_its_login_url_and_the_policy() {
    let store = PluginSecretStore::in_memory().unwrap();
    let registry = Registry::default();
    let bound = own(&store, &["https://auth.github.com/session"]).await;
    let loose = own(&store, &[]).await;
    let now = crate::vault::now_millis();
    let grant = authorize(
        &store,
        &registry,
        None,
        Some("agent-1"),
        BOX,
        &bound,
        FillField::Password,
        now,
    )
    .await
    .unwrap();
    assert_eq!(
        grant.source,
        FillSource::Own {
            account: bound.clone()
        }
    );
    assert_eq!(grant.page_hosts, ["github.com", "www.github.com"]);
    assert_eq!(
        grant.bind_hosts,
        ["github.com", "www.github.com", "auth.github.com"]
    );
    assert_eq!(grant.submit_urls, ["https://auth.github.com/session"]);
    assert!(!grant.unbound);
    let error = authorize(
        &store,
        &registry,
        None,
        Some("agent-1"),
        BOX,
        &loose,
        FillField::Password,
        now,
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("login URL"), "{error}");
    let limited =
        AgentAccountPolicy::from_parts(AgentIdentityMode::Individual, Some(&[] as &[String]));
    let error = authorize(
        &store,
        &registry,
        Some(&limited),
        Some("agent-1"),
        BOX,
        &bound,
        FillField::Password,
        now,
    )
    .await
    .unwrap_err();
    assert_eq!(code(&error), "vault_denied");
    assert_eq!(reveals(&store).await, 0);
}

#[tokio::test]
async fn an_attached_item_is_peeked_never_pinned_by_authorize() {
    let store = PluginSecretStore::in_memory().unwrap();
    let registry = Registry::default();
    attach(
        &store,
        &registry,
        "username",
        &["https://github.com/session"],
    )
    .await;
    let now = crate::vault::now_millis();
    let grant = authorize(
        &store,
        &registry,
        None,
        Some("agent-1"),
        BOX,
        "attached:1",
        FillField::Username,
        now,
    )
    .await
    .unwrap();
    assert!(grant.set_id().is_some());
    assert!(!registry.list(Some("agent-1"), now)[0].claimed);
    let no_agent = authorize(
        &store,
        &registry,
        None,
        None,
        BOX,
        "attached:1",
        FillField::Password,
        now,
    )
    .await;
    assert_eq!(code(&no_agent.unwrap_err()), "vault_denied");
    let individual = AgentAccountPolicy::from_parts(AgentIdentityMode::Individual, None);
    let refused = authorize(
        &store,
        &registry,
        Some(&individual),
        Some("agent-1"),
        BOX,
        "attached:1",
        FillField::Password,
        now,
    )
    .await;
    assert_eq!(code(&refused.unwrap_err()), "vault_denied");
    // The release reveals the one value, audited.
    let page = "https://www.github.com/login";
    let password = authorize(
        &store,
        &registry,
        None,
        Some("agent-1"),
        BOX,
        "attached:1",
        FillField::Password,
        now,
    )
    .await
    .unwrap();
    let value = release(&store, &password, Some("agent-1"), page)
        .await
        .unwrap();
    assert_eq!(value.expose_secret(), SECRET);
    assert!(!format!("{value:?}").contains(SECRET));
    assert_eq!(reveals(&store).await, 1);
}

#[tokio::test]
async fn a_box_username_needs_a_username_named_field_and_a_login_url() {
    let store = PluginSecretStore::in_memory().unwrap();
    let registry = Registry::default();
    attach(&store, &registry, "handle", &["https://github.com/session"]).await;
    let now = crate::vault::now_millis();
    let error = authorize(
        &store,
        &registry,
        None,
        Some("agent-1"),
        BOX,
        "attached:1",
        FillField::Username,
        now,
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("username"), "{error}");

    let unbound = PluginSecretStore::in_memory().unwrap();
    let registry = Registry::default();
    attach(&unbound, &registry, "username", &[]).await;
    let error = authorize(
        &unbound,
        &registry,
        None,
        Some("agent-1"),
        BOX,
        "attached:1",
        FillField::Password,
        now,
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("login URL"), "{error}");
}

#[test]
fn own_account_refusals_follow_the_policy() {
    assert!(own_account_refusal(None, "acct").is_none());
    let unlimited = AgentAccountPolicy::from_parts(AgentIdentityMode::Managed, None);
    assert!(own_account_refusal(Some(&unlimited), "acct").is_none());
    let limited =
        AgentAccountPolicy::from_parts(AgentIdentityMode::Managed, Some(&[] as &[String]));
    assert!(own_account_refusal(Some(&limited), "acct").is_some());
    let allowed = AgentAccountPolicy::from_parts(
        AgentIdentityMode::Individual,
        Some(&["agent:acct".to_owned()]),
    );
    assert!(own_account_refusal(Some(&allowed), "acct").is_none());
    assert!(own_account_refusal(Some(&allowed), "other").is_some());
}
