use super::super::{create, AuditActor, CreateInput, PluginSecretStore, VaultError};
use super::*;

fn code(error: &anyhow::Error) -> &'static str {
    error.downcast_ref::<VaultError>().expect("typed").code()
}

#[test]
fn login_urls_must_be_https_on_the_host_without_extras() {
    let ok = |raw: &str| validate_submit_url("example.com", raw).unwrap();
    assert_eq!(
        ok("https://example.com/session"),
        "https://example.com/session"
    );
    assert_eq!(
        ok("https://WWW.Example.com/login"),
        "https://www.example.com/login"
    );
    assert_eq!(ok("https://auth.example.com"), "https://auth.example.com/");
    for bad in [
        "http://example.com/session",
        "https://evil.com/session",
        "https://example.com.evil.com/session",
        "https://notexample.com/session",
        "https://user:pw@example.com/session",
        "https://example.com:8443/session",
        "https://example.com:443/session",
        "https://example.com/session?next=/",
        "https://example.com/session#frag",
        "https://example.com/a/../session",
        "https://example.com/a/%2E%2e/session",
        "https://example.com/./session",
        "https://93.184.216.34/session",
        "https://example.com/two words",
        "",
    ] {
        let error = validate_submit_url("example.com", bad).unwrap_err();
        assert_eq!(code(&error), "vault_invalid_request", "{bad}");
    }
}

#[test]
fn login_url_lists_are_bounded_and_deduplicated() {
    let urls = |list: &[&str]| list.iter().map(|u| (*u).to_owned()).collect::<Vec<_>>();
    assert_eq!(
        validate_submit_urls(
            "example.com",
            &urls(&["https://example.com/a", "https://EXAMPLE.com/a"])
        )
        .unwrap(),
        vec!["https://example.com/a".to_owned()]
    );
    let five = urls(&[
        "https://example.com/1",
        "https://example.com/2",
        "https://example.com/3",
        "https://example.com/4",
        "https://example.com/5",
    ]);
    assert!(validate_submit_urls("example.com", &five).is_err());
    // A stored value that no longer validates is dropped, never widened.
    assert_eq!(
        stored_submit_urls(
            "example.com",
            "https://example.com/login https://evil.com/x http://example.com/y"
        ),
        vec!["https://example.com/login".to_owned()]
    );
}

#[test]
fn box_hosts_are_exact_and_pages_match_without_folding() {
    let hosts = box_page_hosts("example.com").unwrap();
    assert_eq!(hosts, ["example.com", "www.example.com"]);
    assert!(box_page_hosts("localhost").is_none());
    assert!(box_page_hosts("127.0.0.1").is_none());
    assert_eq!(
        box_bind_hosts(
            &hosts,
            &[
                "https://auth.example.com/session".to_owned(),
                "https://example.com/login".to_owned()
            ]
        ),
        ["example.com", "www.example.com", "auth.example.com"]
    );
    assert!(box_page_matches("https://example.com/login", &hosts));
    assert!(box_page_matches("https://www.example.com/", &hosts));
    for bad in [
        "http://example.com/login",
        "https://sub.example.com/login",
        "https://example.com:8443/login",
        "https://localhost/login",
        "http://127.0.0.1/login",
        "not a url",
    ] {
        assert!(!box_page_matches(bad, &hosts), "{bad}");
    }
}

#[tokio::test]
async fn an_account_target_carries_only_validated_login_urls() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::new("agent", Some("agent-1"));
    let account = create(
        &store,
        Some("agent-1"),
        CreateInput {
            site: "https://www.example.com/signup".into(),
            submit_urls: vec!["https://example.com/session".into()],
            ..CreateInput::default()
        },
        &actor,
    )
    .await
    .unwrap();
    assert_eq!(account.submit_urls, ["https://example.com/session"]);
    let target = account_target(&store, Some("agent-1"), &account.id)
        .await
        .unwrap();
    assert_eq!(target.host, "example.com");
    assert_eq!(target.submit_urls, ["https://example.com/session"]);
    // Another agent cannot read it.
    assert!(account_target(&store, Some("agent-2"), &account.id)
        .await
        .is_err());
    // A login URL on another host is refused at create.
    let refused = create(
        &store,
        Some("agent-1"),
        CreateInput {
            site: "example.com".into(),
            submit_urls: vec!["https://evil.com/session".into()],
            ..CreateInput::default()
        },
        &actor,
    )
    .await
    .unwrap_err();
    assert_eq!(code(&refused), "vault_invalid_request");
    // Reading the target revealed nothing: no reveal row in the audit log.
    let conn = store.conn.lock().await;
    let rows = crate::vault::audit::list(
        &conn,
        &crate::vault::audit::AuditFilter {
            limit: 100,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(rows.iter().all(|row| !row.action.contains("reveal")));
}

#[tokio::test]
async fn login_urls_are_set_replaced_and_cleared_under_the_create_rules() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::new("operator", None);
    let account = create(
        &store,
        Some("agent-1"),
        CreateInput {
            site: "example.com".into(),
            ..CreateInput::default()
        },
        &actor,
    )
    .await
    .unwrap();
    assert!(account.submit_urls.is_empty());

    let urls = vec![
        "https://example.com/session".to_owned(),
        "https://auth.example.com/login".to_owned(),
    ];
    let set = set_submit_urls(&store, Some("agent-1"), &account.id, &urls, &actor)
        .await
        .unwrap();
    assert!(set.before.is_empty());
    assert_eq!(set.account.submit_urls, urls);
    let target = account_target(&store, Some("agent-1"), &account.id)
        .await
        .unwrap();
    assert_eq!(target.submit_urls, urls);

    let replaced = set_submit_urls(
        &store,
        Some("agent-1"),
        &account.id,
        &["https://www.example.com/signin".to_owned()],
        &actor,
    )
    .await
    .unwrap();
    assert_eq!(replaced.before, urls);
    assert_eq!(
        replaced.account.submit_urls,
        ["https://www.example.com/signin"]
    );

    // Each create rule holds, and a refusal leaves the stored URLs alone.
    for bad in [
        vec!["https://evil.com/session".to_owned()],
        vec!["http://example.com/session".to_owned()],
        vec!["https://example.com/session?next=/".to_owned()],
        vec!["https://example.com/a".to_owned(); 5],
    ] {
        let error = set_submit_urls(&store, Some("agent-1"), &account.id, &bad, &actor)
            .await
            .unwrap_err();
        assert_eq!(code(&error), "vault_invalid_request", "{bad:?}");
    }
    // Another agent's folder does not hold the account.
    let error = set_submit_urls(&store, Some("agent-2"), &account.id, &urls, &actor)
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_not_found");
    let kept = account_target(&store, Some("agent-1"), &account.id)
        .await
        .unwrap();
    assert_eq!(kept.submit_urls, ["https://www.example.com/signin"]);

    let cleared = set_submit_urls(&store, Some("agent-1"), &account.id, &[], &actor)
        .await
        .unwrap();
    assert!(cleared.account.submit_urls.is_empty());
}

#[tokio::test]
async fn an_account_without_a_login_url_field_is_refused() {
    use crate::vault::items::{ItemPut, PutAccess};
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::new("operator", None);
    // The schema accounts had before login URLs.
    let put: ItemPut = serde_json::from_value(serde_json::json!({
        "environment": super::super::ENVIRONMENT,
        "path": "agent-1",
        "kind": super::super::KIND,
        "fields": [
            { "name": "site", "label": "Site", "type": "url", "required": true },
            { "name": "password", "label": "Password", "type": "password", "required": true },
        ],
        "values": { "site": "https://example.com", "password": "pw-legacy-1" },
    }))
    .unwrap();
    store
        .item_put("example.com--legacy00", put, &actor, PutAccess::FULL)
        .await
        .unwrap();
    let error = set_submit_urls(
        &store,
        Some("agent-1"),
        "example.com--legacy00",
        &["https://example.com/session".to_owned()],
        &actor,
    )
    .await
    .unwrap_err();
    assert_eq!(code(&error), "vault_conflict");
    assert!(
        error.to_string().contains("create a new account"),
        "{error}"
    );
}
