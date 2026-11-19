//! Link records: metadata in `vault_share_links`, secrets sealed in
//! `plugin_secrets` under [`SECRETS_OWNER`].

use super::*;

fn actor(id: &str) -> AuditActor {
    AuditActor::new("user", Some(id))
}

#[tokio::test]
async fn secrets_are_sealed_apart_from_metadata_and_dropped_when_empty() {
    let store = PluginSecretStore::in_memory().unwrap();
    let secrets = LinkSecrets {
        request_key: Some("scalar".into()),
        pending_answer: None,
    };
    let info = store
        .share_link_record(
            NewShareLink {
                id: "vr_1",
                kind: "request",
                label: Some("Key"),
                target: Some(json!({ "name": "API_KEY" })),
                expires_at: 42,
            },
            &secrets,
            &actor("u1"),
        )
        .await
        .unwrap();
    assert_eq!(info.status, "open");
    assert_eq!(info.created_by.as_deref(), Some("u1"));
    // The metadata table has no secret columns; the secret is sealed.
    {
        let conn = store.conn.lock().await;
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(vault_share_links)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(!columns.iter().any(|column| column == "ciphertext"));
        let sealed: Vec<u8> = conn
            .query_row(
                "SELECT ciphertext FROM plugin_secrets WHERE plugin_id = ?1 AND key = 'vr_1'",
                [SECRETS_OWNER],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!sealed.windows(6).any(|window| window == b"scalar"));
    }
    let (_, read) = store.share_link_get("vr_1").await.unwrap();
    assert_eq!(read.request_key.as_deref(), Some("scalar"));

    store
        .share_link_update("vr_1", "claimed", &LinkSecrets::default(), &actor("u1"))
        .await
        .unwrap();
    let (info, read) = store.share_link_get("vr_1").await.unwrap();
    assert_eq!(info.status, "claimed");
    assert!(read.request_key.is_none());
    assert_eq!(store.get(SECRETS_OWNER, "vr_1").await.unwrap(), None);
}

#[tokio::test]
async fn listing_filters_by_creator_and_unknown_links_are_not_found() {
    let store = PluginSecretStore::in_memory().unwrap();
    assert!(store.share_link_list(None).await.unwrap().is_empty());
    for (id, who) in [("vs_a", "u1"), ("vs_b", "u2")] {
        store
            .share_link_record(
                NewShareLink {
                    id,
                    kind: "share",
                    label: None,
                    target: None,
                    expires_at: 1,
                },
                &LinkSecrets::default(),
                &actor(who),
            )
            .await
            .unwrap();
    }
    assert_eq!(store.share_link_list(None).await.unwrap().len(), 2);
    let mine = store.share_link_list(Some("u2")).await.unwrap();
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].id, "vs_b");
    assert!(store.share_link_get("nope").await.is_err());
    assert!(store
        .share_link_update("nope", "revoked", &LinkSecrets::default(), &actor("u1"))
        .await
        .is_err());
}
