use super::*;
use crate::vault::items::{ItemPut, PutAccess};
use serde_json::json;

const NOW: i64 = 1_700_000_000_000;
const BOX_A: &str = "bx_0123456789abcdef0123456789abcdef";
const BOX_B: &str = "bx_fedcba9876543210fedcba9876543210";

fn code(error: &anyhow::Error) -> &'static str {
    error.downcast_ref::<VaultError>().expect("typed").code()
}

fn hosts() -> Vec<String> {
    vec!["github.com".into(), "www.github.com".into()]
}

/// A login item; `username_field` names its text field.
async fn put_login(store: &PluginSecretStore, key: &str, username_field: &str) {
    let mut values = serde_json::Map::new();
    values.insert("url".into(), json!("https://github.com/login"));
    values.insert(username_field.into(), json!("jay"));
    values.insert("password".into(), json!("hunter2-secret"));
    let put: ItemPut = serde_json::from_value(json!({
        "environment": "default",
        "path": "web",
        "kind": "login",
        "fields": [
            { "name": "url", "type": "url" },
            { "name": username_field, "type": "text" },
            { "name": "password", "type": "password" },
        ],
        "values": values,
    }))
    .unwrap();
    store
        .item_put(
            key,
            put,
            &AuditActor::new("user", Some("u1")),
            PutAccess::FULL,
        )
        .await
        .unwrap();
}

fn item(key: &str, submit_urls: &[&str], box_unbound: bool) -> ItemInput {
    ItemInput {
        environment: None,
        path: Some("web".into()),
        key: key.into(),
        site: None,
        submit_urls: submit_urls.iter().map(|u| (*u).to_owned()).collect(),
        box_unbound,
    }
}

async fn registry_with(store: &PluginSecretStore, items: Vec<ItemInput>) -> (Registry, String) {
    let input = CreateInput {
        agent_id: "agent-1".into(),
        items,
        ttl_secs: None,
    };
    let set = build(store, &input, NOW).await.unwrap();
    let registry = Registry::default();
    let id = registry.insert(set, NOW).unwrap().id;
    (registry, id)
}

#[tokio::test]
async fn login_urls_are_validated_and_reported_on_attach() {
    let store = PluginSecretStore::in_memory().unwrap();
    put_login(&store, "github", "username").await;
    let input = |urls: &[&str], unbound| CreateInput {
        agent_id: "agent-1".into(),
        items: vec![item("github", urls, unbound)],
        ttl_secs: None,
    };
    let set = build(&store, &input(&["https://github.com/session"], false), NOW)
        .await
        .unwrap();
    assert_eq!(set.items[0].submit_urls, ["https://github.com/session"]);
    assert!(set.items[0].login_url_bound && !set.items[0].box_unbound);
    let unbound = build(&store, &input(&[], true), NOW).await.unwrap();
    assert!(!unbound.items[0].login_url_bound && unbound.items[0].box_unbound);
    for bad in [
        "https://evil.com/session",
        "http://github.com/session",
        "https://github.com/session?x=1",
    ] {
        let error = build(&store, &input(&[bad], false), NOW).await.unwrap_err();
        assert_eq!(code(&error), "vault_invalid_request", "{bad}");
    }
}

#[tokio::test]
async fn the_box_namespace_is_reserved_and_peeking_never_pins() {
    let store = PluginSecretStore::in_memory().unwrap();
    put_login(&store, "github", "username").await;
    let (registry, set_id) = registry_with(&store, vec![item("github", &[], false)]).await;

    // A sidecar cannot report a Box session.
    let error = registry
        .claim("agent-1", Some(&format!("box:{BOX_A}")), "attached:1", NOW)
        .unwrap_err();
    assert_eq!(code(&error), "vault_denied");

    let (peeked_set, peeked) = registry
        .peek_box("agent-1", BOX_A, "attached:1", NOW)
        .unwrap();
    assert_eq!(peeked_set, set_id);
    assert!(!registry.get(&set_id, NOW).unwrap().claimed);
    // Another Box may still peek: nothing is pinned yet.
    assert!(registry
        .peek_box("agent-1", BOX_B, "attached:1", NOW)
        .is_ok());

    registry
        .claim_box("agent-1", BOX_A, &set_id, &peeked, NOW)
        .unwrap();
    assert!(registry.get(&set_id, NOW).unwrap().claimed);
    assert!(registry
        .claim_box("agent-1", BOX_A, &set_id, &peeked, NOW)
        .is_ok());
    for refused in [
        registry
            .peek_box("agent-1", BOX_B, "attached:1", NOW)
            .map(|_| ()),
        registry
            .claim_box("agent-1", BOX_B, &set_id, &peeked, NOW)
            .map(|_| ()),
        registry
            .claim("agent-1", Some("lane-1"), "attached:1", NOW)
            .map(|_| ()),
    ] {
        assert_eq!(code(&refused.unwrap_err()), "vault_denied");
    }
    assert!(registry
        .peek_box("agent-1", "bx/../x", "attached:1", NOW)
        .is_err());
    assert!(registry
        .peek_box("agent-2", BOX_A, "attached:1", NOW)
        .is_err());
}

#[tokio::test]
async fn a_set_attached_again_is_not_claimed_with_a_stale_peek() {
    let store = PluginSecretStore::in_memory().unwrap();
    put_login(&store, "github", "username").await;
    let (registry, set_id) = registry_with(&store, vec![item("github", &[], false)]).await;
    let (_, peeked) = registry
        .peek_box("agent-1", BOX_A, "attached:1", NOW)
        .unwrap();
    registry.revoke(&set_id, NOW);
    let input = CreateInput {
        agent_id: "agent-1".into(),
        items: vec![item("github", &[], false)],
        ttl_secs: None,
    };
    let again = registry
        .insert(build(&store, &input, NOW).await.unwrap(), NOW)
        .unwrap();
    let error = registry
        .claim_box("agent-1", BOX_A, &set_id, &peeked, NOW)
        .unwrap_err();
    assert_eq!(code(&error), "vault_not_found");
    assert!(!registry.get(&again.id, NOW).unwrap().claimed);
}

#[tokio::test]
async fn a_box_username_needs_a_username_named_field() {
    let store = PluginSecretStore::in_memory().unwrap();
    put_login(&store, "named", "login").await;
    put_login(&store, "loose", "handle").await;
    let coords = |key: &str| ItemCoords::new(None, Some("web"), key).unwrap();
    let named = store.item_get(&coords("named"), true).await.unwrap();
    let loose = store.item_get(&coords("loose"), true).await.unwrap();
    assert_eq!(field_for_box(&named, FillField::Username), Some("login"));
    // A desktop fill still falls back to the first text field; a Box does not.
    assert_eq!(field_for(&loose, FillField::Username), Some("handle"));
    assert_eq!(field_for_box(&loose, FillField::Username), None);
    assert_eq!(field_for_box(&loose, FillField::Password), Some("password"));
}

#[tokio::test]
async fn a_box_release_checks_the_exact_page_and_uses_the_box_field_rule() {
    let store = PluginSecretStore::in_memory().unwrap();
    put_login(&store, "loose", "handle").await;
    let (registry, _) = registry_with(&store, vec![item("loose", &[], false)]).await;
    let (_, attached) = registry
        .peek_box("agent-1", BOX_A, "attached:1", NOW)
        .unwrap();
    let agent = AuditActor::new("agent", Some("agent-1"));
    let page = "https://www.github.com/login";
    let password = release_box(
        &store,
        &attached,
        FillField::Password,
        page,
        &hosts(),
        &agent,
    )
    .await
    .unwrap();
    assert_eq!(password, "hunter2-secret");
    let error = release_box(
        &store,
        &attached,
        FillField::Username,
        page,
        &hosts(),
        &agent,
    )
    .await
    .unwrap_err();
    assert_eq!(code(&error), "vault_not_found");
    for wrong in [
        "http://github.com/login",
        "https://gist.github.com/",
        "https://github.com:8443/login",
    ] {
        let error = release_box(
            &store,
            &attached,
            FillField::Password,
            wrong,
            &hosts(),
            &agent,
        )
        .await
        .unwrap_err();
        assert_eq!(code(&error), "vault_denied", "{wrong}");
    }
}
