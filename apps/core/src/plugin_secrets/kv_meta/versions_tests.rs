//! Per-version soft delete, undelete, and `deleteVersionAfterSecs` (see
//! `versions.rs`).

use super::tests::{actor, audit_actions, code, coords, request, write};
use super::*;

#[tokio::test]
async fn per_version_soft_delete_hides_versions_until_undeleted() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    write(&store, c.clone(), "one").await;
    write(&store, c.clone(), "two").await;
    write(&store, c.clone(), "three").await;

    let current = store
        .delete_versions(c.clone(), &[3], &actor())
        .await
        .unwrap_err();
    assert!(code(&current).contains("current version"));
    assert_eq!(
        store
            .delete_versions(c.clone(), &[1, 2, 2, 9], &actor())
            .await
            .unwrap(),
        vec![1, 2]
    );
    // Idempotent.
    assert!(store
        .delete_versions(c.clone(), &[1], &actor())
        .await
        .unwrap()
        .is_empty());
    let versions = store.list_versions(&c).await.unwrap();
    assert!(versions[0].deleted_at.is_none());
    assert!(versions[1].deleted_at.is_some() && versions[2].deleted_at.is_some());
    assert!(store.reveal(&c, Some(1), &actor()).await.is_err());
    assert!(store.rollback(c.clone(), 2, &actor()).await.is_err());
    // The current value keeps resolving.
    assert_eq!(store.reveal(&c, None, &actor()).await.unwrap(), "three");

    store
        .destroy(c.clone(), Some(&[1]), &actor())
        .await
        .unwrap();
    assert_eq!(
        store
            .undelete_versions(c.clone(), &[1, 2], &actor())
            .await
            .unwrap(),
        vec![2]
    );
    assert_eq!(store.reveal(&c, Some(2), &actor()).await.unwrap(), "two");
    assert!(store
        .delete_versions(c.clone(), &[], &actor())
        .await
        .is_err());
    let (actions, serialized) = audit_actions(&store).await;
    assert!(actions
        .iter()
        .any(|action| action == "secret.version.delete"));
    assert!(actions
        .iter()
        .any(|action| action == "secret.version.undelete"));
    assert!(!serialized.contains("\"two\""));
}

#[tokio::test]
async fn delete_version_after_soft_deletes_old_non_current_versions() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    let keep = coords("default", "/", "UNLIMITED");
    store
        .write_secret(request(
            c.clone(),
            Some("one"),
            SecretMetadataPatch {
                delete_version_after_secs: Some(Some(3600)),
                ..Default::default()
            },
            &actor(),
            None,
        ))
        .await
        .unwrap();
    write(&store, c.clone(), "two").await;
    write(&store, c.clone(), "three").await;
    write(&store, keep.clone(), "a").await;
    write(&store, keep.clone(), "b").await;
    assert_eq!(store.enforce_delete_version_after().await.unwrap(), 0);
    {
        let conn = store.conn.lock().await;
        conn.execute("UPDATE vault_secret_versions SET created_at = 0", [])
            .unwrap();
    }
    assert_eq!(store.enforce_delete_version_after().await.unwrap(), 2);
    assert_eq!(store.enforce_delete_version_after().await.unwrap(), 0);
    let versions = store.list_versions(&c).await.unwrap();
    assert_eq!(
        versions
            .iter()
            .map(|v| (v.version, v.deleted_at.is_some()))
            .collect::<Vec<_>>(),
        vec![(3, false), (2, true), (1, true)]
    );
    assert!(store
        .list_versions(&keep)
        .await
        .unwrap()
        .iter()
        .all(|v| v.deleted_at.is_none()));
    assert_eq!(store.reveal(&c, None, &actor()).await.unwrap(), "three");
    let report = crate::vault::scheduler::tick(&store, false).await;
    assert_eq!(report.versions_deleted, 0);
}
