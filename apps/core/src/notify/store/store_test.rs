use super::*;
use ryu_notify::NotifyTarget;

/// Token-only views of the device queries, as the older assertions read them.
impl NotifyStore {
    async fn push_tokens(&self) -> Result<Vec<String>> {
        Ok(tokens(self.push_targets().await?))
    }

    async fn push_tokens_for_user(&self, user_id: &str) -> Result<Vec<String>> {
        Ok(tokens(self.push_targets_for_user(user_id).await?))
    }

    async fn run_finished_push_tokens(&self, owner: Option<&str>) -> Result<Vec<String>> {
        Ok(tokens(self.run_finished_push_targets(owner).await?))
    }
}

fn tokens(targets: Vec<PushTarget>) -> Vec<String> {
    targets.into_iter().map(|target| target.token).collect()
}

/// A NotifyStore in a fresh, unique temp directory.
fn temp_dir() -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("ryu-notify-test-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn temp_store() -> NotifyStore {
    NotifyStore::open(temp_dir().join("notify.db")).expect("open temp store")
}

#[tokio::test]
async fn policy_alert_claim_debounces_within_cooldown() {
    let store = temp_store();
    assert!(store.claim_policy_alert("k1", 300).await.unwrap());
    assert!(!store.claim_policy_alert("k1", 300).await.unwrap());
    assert!(store.claim_policy_alert("k2", 300).await.unwrap());
    assert!(store.claim_policy_alert("k1", 0).await.unwrap());
}

#[tokio::test]
async fn run_finished_pushes_are_opt_in_per_owned_device() {
    let store = temp_store();
    store
        .register_push_token("tok-alice", Some("ios"), Some("alice"))
        .await
        .unwrap();
    store
        .register_push_token("tok-solo", Some("android"), None)
        .await
        .unwrap();
    // Registered devices start opted out.
    assert!(store
        .run_finished_push_tokens(Some("alice"))
        .await
        .unwrap()
        .is_empty());
    // Another member cannot opt alice's device in.
    assert!(!store
        .set_push_token_run_finished("tok-alice", Some("bob"), true)
        .await
        .unwrap());
    assert!(store
        .set_push_token_run_finished("tok-alice", Some("alice"), true)
        .await
        .unwrap());
    assert!(store
        .set_push_token_run_finished("tok-solo", None, true)
        .await
        .unwrap());
    assert_eq!(
        store.run_finished_push_tokens(Some("alice")).await.unwrap(),
        vec!["tok-alice"]
    );
    assert_eq!(
        store.run_finished_push_tokens(None).await.unwrap(),
        vec!["tok-solo"]
    );
    assert!(store
        .set_push_token_run_finished("tok-alice", Some("alice"), false)
        .await
        .unwrap());
    assert!(store
        .run_finished_push_tokens(Some("alice"))
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn owner_scoped_push_token_removal_cannot_cross_members() {
    let store = temp_store();
    store
        .register_push_token("tok-owner", Some("ios"), Some("alice"))
        .await
        .unwrap();

    assert!(!store
        .remove_push_token_for_user("tok-owner", "bob")
        .await
        .unwrap());
    assert_eq!(store.push_tokens().await.unwrap(), vec!["tok-owner"]);
    assert!(store
        .remove_push_token_for_user("tok-owner", "alice")
        .await
        .unwrap());
    assert!(store.push_tokens().await.unwrap().is_empty());
}

#[tokio::test]
async fn push_token_registration_cannot_transfer_another_members_device() {
    let store = temp_store();
    assert!(store
        .register_push_token("tok-owner", Some("ios"), Some("alice"))
        .await
        .unwrap());
    assert!(!store
        .register_push_token("tok-owner", Some("android"), Some("bob"))
        .await
        .unwrap());
    assert!(store
        .remove_push_token_for_user("tok-owner", "alice")
        .await
        .unwrap());
}

#[tokio::test]
async fn alert_delivery_roundtrips() {
    let store = temp_store();
    let empty = store.get_alert_delivery().await.unwrap();
    assert!(empty.emails.is_empty() && empty.targets.is_empty());
    let cfg = AlertDeliveryTargets {
        targets: vec![NotifyTarget::Webhook {
            url: "https://example.test/hook".to_string(),
        }],
        emails: vec!["ops@example.test".to_string()],
    };
    store.set_alert_delivery(&cfg).await.unwrap();
    let read = store.get_alert_delivery().await.unwrap();
    assert_eq!(read.emails, vec!["ops@example.test".to_string()]);
    assert_eq!(read.targets.len(), 1);
}

fn file_bytes(path: &std::path::Path) -> String {
    let mut text = String::new();
    for suffix in ["", "-wal", "-journal"] {
        let candidate = PathBuf::from(format!("{}{suffix}", path.display()));
        if let Ok(bytes) = std::fs::read(candidate) {
            text.push_str(&String::from_utf8_lossy(&bytes));
        }
    }
    text
}

fn test_cipher() -> FieldCipher {
    FieldCipher::new(&[0x33; 32])
}

#[tokio::test]
async fn alert_delivery_is_sealed_on_disk_and_round_trips() {
    let path = temp_dir().join("notify.db");
    let store = NotifyStore::open_with_cipher(path.clone(), Some(test_cipher())).unwrap();
    let cfg = AlertDeliveryTargets {
        targets: vec![
            NotifyTarget::Telegram {
                bot_token: "123456:sealed-bot-token".into(),
                chat_id: "42".into(),
            },
            NotifyTarget::Webhook {
                url: "https://hooks.slack.test/services/T/B/sealed-hook".into(),
            },
        ],
        emails: vec![],
    };
    store.set_alert_delivery(&cfg).await.unwrap();
    let read = store.get_alert_delivery().await.unwrap();
    assert_eq!(read.targets, cfg.targets);
    let stored: String = store
        .conn
        .lock()
        .await
        .query_row("SELECT json FROM alert_delivery WHERE id = 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(FieldCipher::is_sealed(&stored));
    drop(store);
    let bytes = file_bytes(&path);
    assert!(!bytes.contains("sealed-bot-token"));
    assert!(!bytes.contains("sealed-hook"));
}

#[tokio::test]
async fn credential_writes_fail_closed_without_a_key() {
    let store = NotifyStore::open_with_cipher(temp_dir().join("notify.db"), None).unwrap();
    assert!(store
        .set_alert_delivery(&AlertDeliveryTargets::default())
        .await
        .is_err());
    assert!(store
        .register_push_token("ExponentPushToken[x]", None, None)
        .await
        .is_err());
    // The inbox itself still works.
    assert!(store.claim_policy_alert("k", 60).await.unwrap());
}

#[tokio::test]
async fn legacy_plaintext_is_read_then_resealed_on_open() {
    let path = temp_dir().join("notify.db");
    {
        // A store written by an older build: plaintext JSON and tokens.
        let legacy = NotifyStore::open_with_cipher(path.clone(), None).unwrap();
        let conn = legacy.conn.lock().await;
        conn.execute(
            "INSERT INTO alert_delivery (id, json) VALUES (1, ?1)",
            params![r#"{"targets":[{"kind":"telegram","bot_token":"999:legacy-bot-token","chat_id":"7"}],"emails":["ops@example.test"]}"#],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO push_tokens (token, platform, user_id, created_at, run_finished)
             VALUES ('ExponentPushToken[legacy-device]', 'ios', 'alice', 'now', 1)",
            [],
        )
        .unwrap();
        drop(conn);
        // Legacy plaintext reads without a key.
        assert_eq!(
            legacy.get_alert_delivery().await.unwrap().emails,
            vec!["ops@example.test".to_string()]
        );
        assert_eq!(
            legacy.push_tokens().await.unwrap(),
            vec!["ExponentPushToken[legacy-device]"]
        );
    }
    let store = NotifyStore::open_with_cipher(path.clone(), Some(test_cipher())).unwrap();
    // Readers still see the same values.
    let cfg = store.get_alert_delivery().await.unwrap();
    assert!(matches!(
        &cfg.targets[0],
        NotifyTarget::Telegram { bot_token, .. } if bot_token == "999:legacy-bot-token"
    ));
    assert_eq!(
        store.run_finished_push_tokens(Some("alice")).await.unwrap(),
        vec!["ExponentPushToken[legacy-device]"]
    );
    // Lookups by the plaintext token still find the migrated row.
    assert!(store
        .set_push_token_run_finished("ExponentPushToken[legacy-device]", Some("alice"), false)
        .await
        .unwrap());
    drop(store);
    let bytes = file_bytes(&path);
    assert!(!bytes.contains("legacy-bot-token"));
    assert!(!bytes.contains("legacy-device"));
}

/// Write the plaintext rows an older build left, then close the store.
async fn write_legacy_plaintext(path: &std::path::Path) {
    let legacy = NotifyStore::open_with_cipher(path.to_owned(), None).unwrap();
    let conn = legacy.conn.lock().await;
    conn.execute(
        "INSERT INTO alert_delivery (id, json) VALUES (1, ?1)",
        params![r#"{"targets":[{"kind":"telegram","bot_token":"999:debt-bot-token","chat_id":"7"}],"emails":[]}"#],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO push_tokens (token, platform, user_id, created_at, run_finished)
         VALUES ('ExponentPushToken[debt-device]', 'ios', 'alice', 'now', 1)",
        [],
    )
    .unwrap();
}

#[tokio::test]
async fn a_reseal_that_scrubs_cleanly_leaves_no_debt() {
    let path = temp_dir().join("notify.db");
    write_legacy_plaintext(&path).await;
    let store = NotifyStore::open_with_cipher(path.clone(), Some(test_cipher())).unwrap();
    let conn = store.conn.lock().await;
    assert!(!ryu_crypto::content_sqlite::compaction_owed(&conn, NOTIFY_STORE).unwrap());
    let secure_delete: i64 = conn
        .query_row("PRAGMA secure_delete", [], |row| row.get(0))
        .unwrap();
    assert_eq!(secure_delete, 1);
}

#[tokio::test]
async fn a_scrub_that_fails_still_opens_the_store_and_stays_owed() {
    let path = temp_dir().join("notify.db");
    write_legacy_plaintext(&path).await;
    // A reader holding an old snapshot blocks the WAL checkpoint the scrub
    // needs, so `finish_store` fails after the credentials are sealed.
    let reader = Connection::open(&path).unwrap();
    reader.execute_batch("BEGIN").unwrap();
    let _: i64 = reader
        .query_row("SELECT count(*) FROM push_tokens", [], |row| row.get(0))
        .unwrap();
    let store = NotifyStore::open_with_cipher(path.clone(), Some(test_cipher()))
        .expect("a failed scrub must not stop the store from opening");
    let conn = store.conn.lock().await;
    let stored: String = conn
        .query_row("SELECT json FROM alert_delivery WHERE id = 1", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(FieldCipher::is_sealed(&stored));
    let token: String = conn
        .query_row("SELECT token FROM push_tokens", [], |r| r.get(0))
        .unwrap();
    assert!(FieldCipher::is_sealed(&token));
    assert!(
        ryu_crypto::content_sqlite::compaction_owed(&conn, NOTIFY_STORE).unwrap(),
        "the scrub debt stays recorded for the next start"
    );
}

#[tokio::test]
async fn push_tokens_are_sealed_and_found_by_digest() {
    let path = temp_dir().join("notify.db");
    let store = NotifyStore::open_with_cipher(path.clone(), Some(test_cipher())).unwrap();
    assert!(store
        .register_push_token("ExponentPushToken[sealed-device]", Some("ios"), Some("bob"))
        .await
        .unwrap());
    // Re-registering the same token updates the row instead of adding one.
    assert!(store
        .register_push_token(
            "ExponentPushToken[sealed-device]",
            Some("android"),
            Some("bob")
        )
        .await
        .unwrap());
    assert_eq!(
        store.push_tokens_for_user("bob").await.unwrap(),
        vec!["ExponentPushToken[sealed-device]"]
    );
    assert!(store
        .remove_push_token("ExponentPushToken[sealed-device]")
        .await
        .unwrap());
    assert!(store.push_tokens().await.unwrap().is_empty());
    store
        .register_push_token("ExponentPushToken[kept-device]", None, None)
        .await
        .unwrap();
    drop(store);
    assert!(!file_bytes(&path).contains("kept-device"));
}

#[tokio::test]
async fn notification_roundtrips_and_acks() {
    let store = temp_store();
    let row = NotificationRow {
        id: "ntf_1".into(),
        user_id: Some("u1".into()),
        title: "hi".into(),
        body: None,
        level: "info".into(),
        workflow_run_id: None,
        node_id: None,
        ack_required: false,
        acked: false,
        read_at: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        source_app_id: Some("@ryu/monitors".into()),
        archived_at: None,
    };
    store.insert_notification(&row).await.unwrap();
    // Un-archived filter is the default view.
    let live = store
        .list_notifications_for_user("u1", 10, Some(false))
        .await
        .unwrap();
    assert_eq!(live.len(), 1);
    assert_eq!(live[0].source_app_id.as_deref(), Some("@ryu/monitors"));
    // No filter sees everything.
    let all = store
        .list_notifications_for_user("u1", 10, None)
        .await
        .unwrap();
    assert_eq!(all.len(), 1);
    assert!(store.mark_notification_read("ntf_1").await.unwrap());
    assert!(store.mark_notification_acked("ntf_1").await.unwrap());
    // Archive hides the row from the live feed but keeps it readable.
    assert!(store.mark_notification_archived("ntf_1").await.unwrap());
    assert!(store
        .list_notifications_for_user("u1", 10, Some(false))
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        store
            .list_notifications_for_user("u1", 10, Some(true))
            .await
            .unwrap()
            .len(),
        1
    );
    // Re-archive is a no-op; un-archive restores it.
    assert!(!store.mark_notification_archived("ntf_1").await.unwrap());
    assert!(store.mark_notification_unarchived("ntf_1").await.unwrap());
    assert_eq!(
        store
            .list_notifications_for_user("u1", 10, Some(false))
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn push_tokens_with_owners_reports_each_registering_member() {
    let store = temp_store();
    store
        .register_push_token("tok-alice", Some("ios"), Some("alice"))
        .await
        .unwrap();
    store
        .register_push_token("tok-solo", Some("android"), None)
        .await
        .unwrap();
    let mut owners: Vec<(String, Option<String>)> = store
        .push_targets()
        .await
        .unwrap()
        .into_iter()
        .map(|target| (target.token, target.owner))
        .collect();
    owners.sort();
    assert_eq!(
        owners,
        vec![
            ("tok-alice".to_owned(), Some("alice".to_owned())),
            ("tok-solo".to_owned(), None),
        ]
    );
}

#[tokio::test]
async fn push_token_locale_is_owner_scoped_and_validated() {
    let store = temp_store();
    store
        .register_push_token("tok-alice", Some("ios"), Some("alice"))
        .await
        .unwrap();
    store
        .register_push_token("tok-solo", Some("android"), None)
        .await
        .unwrap();
    let locale_of = |targets: Vec<PushTarget>, token: &str| {
        targets
            .into_iter()
            .find(|target| target.token == token)
            .and_then(|target| target.locale)
    };
    // Registered devices start without a locale (the node's is used).
    assert_eq!(
        locale_of(store.push_targets().await.unwrap(), "tok-alice"),
        None
    );
    // Another member cannot set alice's device language.
    assert!(!store
        .set_push_token_locale("tok-alice", Some("bob"), Some("de"))
        .await
        .unwrap());
    assert!(store
        .set_push_token_locale("tok-alice", Some("alice"), Some(" ja "))
        .await
        .unwrap());
    assert!(store
        .set_push_token_locale("tok-solo", None, Some("pt-BR"))
        .await
        .unwrap());
    let targets = store.push_targets_for_user("alice").await.unwrap();
    assert_eq!(locale_of(targets, "tok-alice").as_deref(), Some("ja"));
    let targets = store.run_finished_push_targets(None).await.unwrap();
    assert!(
        targets.is_empty(),
        "locale does not opt a device in to run pushes"
    );
    assert_eq!(
        locale_of(store.push_targets().await.unwrap(), "tok-solo").as_deref(),
        Some("pt-BR")
    );
    // A malformed tag clears the locale instead of storing it.
    assert!(store
        .set_push_token_locale("tok-solo", None, Some("<script>"))
        .await
        .unwrap());
    assert_eq!(
        locale_of(store.push_targets().await.unwrap(), "tok-solo"),
        None
    );
}

#[tokio::test]
async fn unowned_push_targets_exclude_member_devices() {
    let store = temp_store();
    store
        .register_push_token("tok-alice", Some("ios"), Some("alice"))
        .await
        .unwrap();
    store
        .register_push_token("tok-solo", Some("android"), None)
        .await
        .unwrap();
    assert_eq!(
        tokens(store.push_targets_unowned().await.unwrap()),
        vec!["tok-solo".to_owned()]
    );
}
