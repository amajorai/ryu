use super::*;
use crate::vault::items::{ItemPut, PutAccess};
use serde_json::json;

const SEED: &str = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const NOW: i64 = 1_700_000_000_000;

fn user() -> AuditActor {
    AuditActor::new("user", Some("u1"))
}

fn agent() -> AuditActor {
    AuditActor::new("agent", Some("agent-1"))
}

fn code(error: &anyhow::Error) -> &'static str {
    error.downcast_ref::<VaultError>().expect("typed").code()
}

async fn put_login(store: &PluginSecretStore, key: &str, url: Option<&str>) {
    let mut values = serde_json::Map::new();
    values.insert("username".into(), json!("jay"));
    values.insert("password".into(), json!("hunter2-secret"));
    values.insert("otp".into(), json!(SEED));
    if let Some(url) = url {
        values.insert("url".into(), json!(url));
    }
    let put: ItemPut = serde_json::from_value(json!({
        "environment": "default",
        "path": "web",
        "kind": "login",
        "fields": [
            { "name": "url", "type": "url" },
            { "name": "username", "type": "text" },
            { "name": "password", "type": "password" },
            { "name": "otp", "type": "totp" },
        ],
        "values": values,
    }))
    .unwrap();
    store
        .item_put(key, put, &user(), PutAccess::FULL)
        .await
        .unwrap();
}

fn input(agent: &str, items: Vec<ItemInput>) -> CreateInput {
    CreateInput {
        agent_id: agent.into(),
        items,
        ttl_secs: None,
    }
}

fn item(key: &str, site: Option<&str>) -> ItemInput {
    ItemInput {
        environment: None,
        path: Some("web".into()),
        key: key.into(),
        site: site.map(str::to_owned),
        submit_urls: Vec::new(),
        box_unbound: false,
    }
}

#[tokio::test]
async fn build_derives_sites_and_never_holds_values() {
    let store = PluginSecretStore::in_memory().unwrap();
    put_login(&store, "github", Some("https://github.com/login")).await;
    put_login(&store, "bare", None).await;

    let set = build(&store, &input("agent-1", vec![item("github", None)]), NOW)
        .await
        .unwrap();
    assert!(set.id.starts_with("fs_"));
    assert_eq!(set.expires_at, NOW + 3_600_000);
    let attached = &set.items[0];
    assert_eq!(attached.handle, "attached:1");
    assert_eq!(attached.host, "github.com");
    assert_eq!(
        attached.fields,
        vec![FillField::Username, FillField::Password, FillField::Totp]
    );
    let serialized = serde_json::to_string(&set).unwrap();
    assert!(!serialized.contains("hunter2"), "{serialized}");
    assert!(!serialized.contains(SEED), "{serialized}");

    // No url field and no site: refused rather than guessed.
    let error = build(&store, &input("agent-1", vec![item("bare", None)]), NOW)
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_invalid_request");
    let set = build(
        &store,
        &input("agent-1", vec![item("bare", Some("gitlab.com"))]),
        NOW,
    )
    .await
    .unwrap();
    assert_eq!(set.items[0].host, "gitlab.com");

    for bad in [
        input("agent-1", vec![]),
        input("", vec![item("github", None)]),
        input("agent-1", vec![item("github", None), item("github", None)]),
        CreateInput {
            ttl_secs: Some(MAX_TTL_SECS + 1),
            ..input("agent-1", vec![item("github", None)])
        },
    ] {
        assert!(build(&store, &bad, NOW).await.is_err());
    }
    let error = build(&store, &input("agent-1", vec![item("missing", None)]), NOW)
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_not_found");
}

#[tokio::test]
async fn sets_are_immutable_per_agent_and_pinned_to_one_browser_session() {
    let store = PluginSecretStore::in_memory().unwrap();
    put_login(&store, "github", Some("https://github.com")).await;
    let registry = Registry::default();
    let set = build(&store, &input("agent-1", vec![item("github", None)]), NOW)
        .await
        .unwrap();
    registry.insert(set.clone(), NOW).unwrap();

    // One active set per agent: a second is refused until the first is revoked.
    let second = build(&store, &input("agent-1", vec![item("github", None)]), NOW)
        .await
        .unwrap();
    let error = registry.insert(second.clone(), NOW).unwrap_err();
    assert_eq!(code(&error), "vault_conflict");

    // A fill without a browser session id is refused.
    let error = registry
        .claim("agent-1", None, "attached:1", NOW)
        .unwrap_err();
    assert_eq!(code(&error), "vault_denied");
    // The first session claims the set; another session is refused.
    let claimed = registry
        .claim("agent-1", Some("lane-a"), "attached:1", NOW)
        .unwrap();
    assert_eq!(claimed.key, "github");
    assert!(registry.get(&set.id, NOW).unwrap().claimed);
    let error = registry
        .claim("agent-1", Some("lane-b"), "attached:1", NOW)
        .unwrap_err();
    assert_eq!(code(&error), "vault_denied");
    // Another agent has nothing attached; an unknown handle is not found.
    let error = registry
        .claim("agent-2", Some("lane-a"), "attached:1", NOW)
        .unwrap_err();
    assert_eq!(code(&error), "vault_not_found");
    let error = registry
        .claim("agent-1", Some("lane-a"), "attached:2", NOW)
        .unwrap_err();
    assert_eq!(code(&error), "vault_not_found");

    // Revocation frees the agent for a new one; expiry drops the set.
    assert_eq!(registry.revoke(&set.id, NOW).unwrap().id, set.id);
    registry.insert(second.clone(), NOW).unwrap();
    assert_eq!(registry.list(None, NOW).len(), 1);
    assert!(registry.list(Some("agent-1"), second.expires_at).is_empty());
    assert!(registry.get(&second.id, NOW).is_none());
}

#[tokio::test]
async fn release_is_site_bound_audited_and_yields_codes_not_seeds() {
    let store = PluginSecretStore::in_memory().unwrap();
    put_login(&store, "github", Some("https://github.com")).await;
    let set = build(&store, &input("agent-1", vec![item("github", None)]), NOW)
        .await
        .unwrap();
    let attached = &set.items[0];
    let page = "https://github.com/login";

    let password = release(&store, attached, FillField::Password, page, &agent())
        .await
        .unwrap();
    assert_eq!(password, "hunter2-secret");
    let username = release(&store, attached, FillField::Username, page, &agent())
        .await
        .unwrap();
    assert_eq!(username, "jay");
    let code_value = release(&store, attached, FillField::Totp, page, &agent())
        .await
        .unwrap();
    assert_eq!(code_value.len(), 6);
    assert_ne!(code_value, SEED);

    for wrong in [
        "https://github.com.evil.io/login",
        "http://github.com/login",
        "https://gist.github.com/",
    ] {
        let error = release(&store, attached, FillField::Password, wrong, &agent())
            .await
            .unwrap_err();
        assert_eq!(code(&error), "vault_denied", "{wrong}");
    }
    let error = release(&store, attached, FillField::Email, page, &agent())
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_not_found");

    // A different item recreated under the same key is not the attached one.
    let coords = attached.coords().unwrap();
    store.item_delete(&coords, None, &user()).await.unwrap();
    put_login(&store, "github", Some("https://github.com")).await;
    let error = release(&store, attached, FillField::Password, page, &agent())
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_not_found");
}
