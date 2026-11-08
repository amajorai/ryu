//! Keyset-paginated, authorization-filtered listing (see `kv_meta.rs`).

use super::tests::{actor, code, coords, write};
use super::*;

#[tokio::test]
async fn paginated_listing_is_stable_filtered_and_never_leaks_hidden_names() {
    let store = PluginSecretStore::in_memory().unwrap();
    for (env, path, name) in [
        ("default", "/", "A"),
        ("default", "/", "B"),
        ("default", "/app", "C"),
        ("default", "/app/db", "D"),
        ("default", "/apples", "E"),
        ("prod", "/", "A"),
        ("default", "/", "HIDDEN"),
    ] {
        write(&store, coords(env, path, name), "v").await;
    }
    store
        .soft_delete(coords("default", "/", "B"), &actor())
        .await
        .unwrap();
    let visible = |info: &VaultSecretInfo| info.name != "HIDDEN";
    let mut seen = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let page = store
            .list_secrets_page(&ListFilter::default(), after.as_deref(), 2, visible)
            .await
            .unwrap();
        assert!(page.secrets.len() <= 2);
        seen.extend(page.secrets.iter().map(|info| info.coords().policy_key()));
        if let Some(next) = &page.next_after {
            let decoded = String::from_utf8(URL_SAFE_NO_PAD.decode(next).unwrap()).unwrap();
            assert!(!decoded.contains("HIDDEN"));
        }
        match page.next_after {
            Some(next) => after = Some(next),
            None => break,
        }
    }
    assert_eq!(
        seen,
        vec![
            "default/A",
            "default/app/C",
            "default/app/db/D",
            "default/apples/E",
            "prod/A",
        ]
    );

    // Recursive SCAN of a folder does not match sibling prefixes.
    let scan = store
        .list_secrets_page(
            &ListFilter {
                environment: Some("default".into()),
                path: Some("/app".into()),
                recursive: true,
                include_deleted: false,
            },
            None,
            DEFAULT_PAGE_LIMIT,
            |_| true,
        )
        .await
        .unwrap();
    assert_eq!(
        scan.secrets
            .iter()
            .map(|info| info.name.as_str())
            .collect::<Vec<_>>(),
        vec!["C", "D"]
    );
    assert!(scan.next_after.is_none());
    let flat = store
        .list_secrets_page(
            &ListFilter {
                environment: Some("default".into()),
                path: Some("/".into()),
                recursive: false,
                include_deleted: true,
            },
            None,
            10,
            |_| true,
        )
        .await
        .unwrap();
    assert_eq!(
        flat.secrets
            .iter()
            .map(|info| info.name.as_str())
            .collect::<Vec<_>>(),
        vec!["A", "B", "HIDDEN"]
    );
    let bad = store
        .list_secrets_page(&ListFilter::default(), Some("not-a-cursor"), 2, |_| true)
        .await
        .unwrap_err();
    assert!(code(&bad).starts_with("vault_invalid"));
}
