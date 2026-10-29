use std::collections::BTreeMap;

use serde_json::json;

use super::*;
use crate::plugin_secrets::PluginSecretStore;

fn actor() -> AuditActor {
    AuditActor::new("user", Some("u1"))
}

fn login_put(values: &[(&str, &str)]) -> ItemPut {
    serde_json::from_value(json!({
        "kind": "login",
        "fields": [
            { "name": "username", "type": "text", "required": true },
            { "name": "password", "type": "password", "required": true },
            { "name": "otp", "type": "totp" },
            { "name": "site", "type": "url" }
        ],
        "values": values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>(),
    }))
    .unwrap()
}

fn coords(key: &str) -> ItemCoords {
    ItemCoords::new(None, None, key).unwrap()
}

fn code(error: &anyhow::Error) -> &'static str {
    error
        .downcast_ref::<VaultError>()
        .expect("typed vault error")
        .code()
}

#[test]
fn keys_and_coordinates_validate() {
    for ok in ["github", "acme.prod_login-1", &"a".repeat(255)] {
        assert!(is_valid_item_key(ok), "{ok}");
    }
    for bad in ["", ".", "..", "a/b", "has space", "é", &"a".repeat(256)] {
        assert!(!is_valid_item_key(bad), "{bad}");
    }
    let c = ItemCoords::new(Some("prod"), Some("db/main"), "pg").unwrap();
    assert_eq!(c.policy_key(), "sys/items/prod/db/main/pg");
    assert_eq!(coords("gh").policy_key(), "sys/items/default/gh");
    assert!(ItemCoords::new(Some("sys"), None, "x").is_err());
    assert!(ItemCoords::new(None, Some("/../x"), "x").is_err());
}

#[test]
fn schema_rules_are_enforced() {
    let field =
        |value: serde_json::Value| -> FieldDefInput { serde_json::from_value(value).unwrap() };
    let defs = normalize_fields(&[
        field(json!({ "name": "user", "type": "email" })),
        field(json!({ "name": "pass", "type": "password" })),
        field(json!({ "name": "pin", "type": "text", "sensitive": true })),
    ])
    .unwrap();
    assert!(!defs[0].sensitive);
    assert!(defs[1].sensitive, "password defaults to sensitive");
    assert!(defs[2].sensitive);

    let downgrade = normalize_fields(&[field(
        json!({ "name": "pass", "type": "password", "sensitive": false }),
    )]);
    assert_eq!(code(&downgrade.unwrap_err()), "vault_invalid_request");
    assert!(normalize_fields(&[]).is_err());
    assert!(normalize_fields(&[
        field(json!({ "name": "a", "type": "text" })),
        field(json!({ "name": "A", "type": "text" })),
    ])
    .is_err());
    assert!(normalize_fields(&[field(json!({ "name": "1bad", "type": "text" }))]).is_err());
    let too_many: Vec<_> = (0..=MAX_FIELDS)
        .map(|i| field(json!({ "name": format!("f{i}"), "type": "text" })))
        .collect();
    assert!(normalize_fields(&too_many).is_err());
    assert!(
        serde_json::from_value::<FieldDefInput>(json!({ "name": "x", "type": "blob" })).is_err()
    );
}

#[test]
fn values_validate_by_type() {
    let def = |field_type| FieldDef {
        name: "f".into(),
        label: None,
        field_type,
        required: false,
        sensitive: false,
    };
    assert_eq!(
        normalize_value(&def(FieldType::Email), " a@b.example ").unwrap(),
        "a@b.example"
    );
    assert!(normalize_value(&def(FieldType::Email), "nope").is_err());
    assert!(normalize_value(&def(FieldType::Url), "ftp://x.example").is_err());
    assert!(normalize_value(&def(FieldType::Url), "https://x.example/login").is_ok());
    assert!(normalize_value(&def(FieldType::Text), "two\nlines").is_err());
    assert!(normalize_value(&def(FieldType::Note), "two\nlines").is_ok());
    assert!(normalize_value(&def(FieldType::Text), "").is_err());
    assert!(normalize_value(&def(FieldType::Text), &"x".repeat(MAX_VALUE_BYTES + 1)).is_err());
}

#[test]
fn totp_seeds_normalize_from_base32_and_otpauth() {
    assert_eq!(
        normalize_totp_seed("jbsw y3dp ehpk 3pxp").as_deref(),
        Some("JBSWY3DPEHPK3PXP")
    );
    assert_eq!(
        normalize_totp_seed(
            "otpauth://totp/Acme:alice?secret=JBSWY3DPEHPK3PXP&issuer=Acme&period=30"
        )
        .as_deref(),
        Some("JBSWY3DPEHPK3PXP")
    );
    assert_eq!(
        normalize_totp_seed("JBSWY3DPEHPK3PX1"),
        None,
        "1 is not Base32"
    );
    assert_eq!(normalize_totp_seed("JBSWY3DP"), None, "too short");
    assert_eq!(
        normalize_totp_seed("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP"),
        None
    );
    assert_eq!(normalize_totp_seed("otpauth://totp/x?issuer=Acme"), None);
    // A multibyte character across the scheme-prefix boundary is rejected,
    // not a slicing panic.
    assert_eq!(normalize_totp_seed("aéééééé"), None);
    assert_eq!(normalize_totp_seed("otpauth:/é"), None);
}

#[tokio::test]
async fn put_is_an_idempotent_upsert() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (outcome, created) = store
        .item_put(
            "github",
            login_put(&[("username", "alice")]),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap();
    assert_eq!(outcome, PutOutcome::Created);
    assert_eq!(created.version, 1);
    assert_eq!(created.status, ItemStatus::PendingCollection);
    assert!(created.id.starts_with("itm_"));
    assert_eq!(created.available_operations, vec!["collect", "reveal"]);

    // Same schema and same values: unchanged, same id and version.
    let (outcome, again) = store
        .item_put(
            "github",
            login_put(&[("username", "alice")]),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap();
    assert_eq!(outcome, PutOutcome::Unchanged);
    assert_eq!((again.id.as_str(), again.version), (created.id.as_str(), 1));

    // A different value or schema conflicts instead of overwriting.
    let error = store
        .item_put(
            "github",
            login_put(&[("username", "bob")]),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_conflict");
    let other_schema: ItemPut = serde_json::from_value(json!({
        "kind": "login",
        "fields": [{ "name": "username", "type": "text" }]
    }))
    .unwrap();
    let error = store
        .item_put("github", other_schema, &actor(), PutAccess::FULL)
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_conflict");

    // Unknown fields are rejected before anything is written.
    let error = store
        .item_put(
            "other",
            login_put(&[("nope", "x")]),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_invalid_request");
    assert_eq!(store.item_list(None, None).await.unwrap().len(), 1);
}

#[tokio::test]
async fn reads_return_only_non_sensitive_values() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .item_put(
            "github",
            login_put(&[
                ("username", "alice"),
                ("password", "hunter2"),
                ("otp", "JBSWY3DPEHPK3PXP"),
            ]),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap();
    let view = store.item_get(&coords("github"), true).await.unwrap();
    assert_eq!(view.status, ItemStatus::Ready);
    assert_eq!(view.available_operations, vec!["reveal"]);
    let by_name: BTreeMap<_, _> = view
        .fields
        .iter()
        .map(|f| (f.def.name.as_str(), f))
        .collect();
    assert_eq!(by_name["username"].value.as_deref(), Some("alice"));
    assert!(by_name["password"].has_value);
    assert_eq!(by_name["password"].value, None);
    assert_eq!(by_name["otp"].value, None);
    assert!(!by_name["site"].has_value);

    let serialized = serde_json::to_string(&view).unwrap();
    assert!(!serialized.contains("hunter2"));
    assert!(!serialized.contains("JBSWY3DP"));

    let hidden = store.item_get(&coords("github"), false).await.unwrap();
    assert!(hidden.fields.iter().all(|f| f.value.is_none()));

    assert_eq!(
        store
            .item_reveal(&coords("github"), "password", &actor())
            .await
            .unwrap(),
        "hunter2"
    );
    let error = store
        .item_reveal(&coords("github"), "site", &actor())
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_not_found");
}

#[tokio::test]
async fn values_are_sealed_at_rest() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .item_put(
            "github",
            login_put(&[("username", "alice"), ("password", "hunter2")]),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap();
    let conn = store.conn.lock().await;
    let blobs: Vec<Vec<u8>> = {
        let mut stmt = conn
            .prepare("SELECT ciphertext FROM vault_item_values")
            .unwrap();
        let rows = stmt.query_map([], |row| row.get(0)).unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    };
    assert_eq!(blobs.len(), 2);
    for blob in blobs {
        assert!(!blob.windows(7).any(|w| w == b"hunter2"));
        assert!(!blob.windows(5).any(|w| w == b"alice"));
    }
    assert!(crate::vault::ENCRYPTED_TABLES.contains(&"vault_item_values"));
}

#[tokio::test]
async fn patch_is_optimistic_and_tracks_status() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (_, item) = store
        .item_put(
            "github",
            login_put(&[("username", "alice"), ("password", "p1")]),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap();
    assert_eq!(item.status, ItemStatus::Ready);

    let patch = |version: i64, id: &str, body: serde_json::Value| -> ItemPatch {
        let mut body = body;
        body["expectedVersion"] = json!(version);
        body["expectedId"] = json!(id);
        serde_json::from_value(body).unwrap()
    };

    // Stale version and wrong id both conflict.
    let error = store
        .item_patch(
            "github",
            patch(7, &item.id, json!({ "values": { "password": "p2" } })),
            &actor(),
        )
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_conflict");
    let error = store
        .item_patch(
            "github",
            patch(1, "itm_other", json!({ "values": { "password": "p2" } })),
            &actor(),
        )
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_conflict");

    // Clearing a required value moves the item back to pending_collection;
    // omitted values are kept.
    let cleared = store
        .item_patch(
            "github",
            patch(
                1,
                &item.id,
                json!({ "values": { "password": null }, "description": "work" }),
            ),
            &actor(),
        )
        .await
        .unwrap();
    assert_eq!(cleared.version, 2);
    assert_eq!(cleared.status, ItemStatus::PendingCollection);
    assert_eq!(cleared.description.as_deref(), Some("work"));
    let username = cleared
        .fields
        .iter()
        .find(|f| f.def.name == "username")
        .unwrap();
    assert!(username.has_value);

    let restored = store
        .item_patch(
            "github",
            patch(
                2,
                &item.id,
                json!({ "values": { "password": "p3" }, "description": null }),
            ),
            &actor(),
        )
        .await
        .unwrap();
    assert_eq!(restored.version, 3);
    assert_eq!(restored.status, ItemStatus::Ready);
    assert_eq!(restored.description, None);
    assert_eq!(
        store
            .item_reveal(&coords("github"), "password", &actor())
            .await
            .unwrap(),
        "p3"
    );

    // Invalid values and unknown fields roll back the whole patch.
    let error = store
        .item_patch(
            "github",
            patch(
                3,
                &item.id,
                json!({ "values": { "username": "bob", "otp": "not base32!" } }),
            ),
            &actor(),
        )
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_invalid_request");
    let unchanged = store.item_get(&coords("github"), true).await.unwrap();
    assert_eq!(unchanged.version, 3);
    let username = unchanged
        .fields
        .iter()
        .find(|f| f.def.name == "username")
        .unwrap();
    assert_eq!(username.value.as_deref(), Some("alice"));

    // A patch body cannot change the schema.
    assert!(serde_json::from_value::<ItemPatch>(json!({
        "expectedVersion": 3, "expectedId": item.id, "fields": []
    }))
    .is_err());
}

#[tokio::test]
async fn delete_honors_expected_version_and_keeps_the_timeline() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .item_put(
            "github",
            login_put(&[("username", "alice")]),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap();
    let error = store
        .item_delete(&coords("github"), Some(9), &actor())
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_conflict");
    assert!(store
        .item_delete(&coords("github"), Some(1), &actor())
        .await
        .unwrap());
    assert!(!store
        .item_delete(&coords("github"), None, &actor())
        .await
        .unwrap());
    let error = store.item_get(&coords("github"), false).await.unwrap_err();
    assert_eq!(code(&error), "vault_not_found");
    let remaining: i64 = store
        .conn
        .lock()
        .await
        .query_row("SELECT COUNT(*) FROM vault_item_values", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(remaining, 0);

    let events = store
        .item_events(&coords("github"), 0, 100, 0, EventScope::History)
        .await
        .unwrap();
    let names: Vec<_> = events.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["created", "deleted"]);
}

#[tokio::test]
async fn events_page_by_cursor_and_never_carry_values() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (_, item) = store
        .item_put(
            "github",
            login_put(&[("username", "alice"), ("password", "hunter2")]),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap();
    let patch: ItemPatch = serde_json::from_value(json!({
        "expectedVersion": 1,
        "expectedId": item.id,
        "values": { "password": null }
    }))
    .unwrap();
    store.item_patch("github", patch, &actor()).await.unwrap();
    store
        .item_reveal(&coords("github"), "username", &actor())
        .await
        .unwrap();

    let all = store
        .item_events(&coords("github"), 0, 100, 0, EventScope::History)
        .await
        .unwrap();
    let names: Vec<_> = all.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["created", "updated", "status_changed", "revealed"]
    );
    assert_eq!(all[0].actor_id.as_deref(), Some("u1"));
    let serialized = serde_json::to_string(&all).unwrap();
    assert!(!serialized.contains("hunter2"));
    assert!(!serialized.contains("alice"));

    let page = store
        .item_events(&coords("github"), all[1].seq, 1, 0, EventScope::History)
        .await
        .unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].name, "status_changed");

    // Other items' events are not mixed in.
    store
        .item_put("other", login_put(&[]), &actor(), PutAccess::FULL)
        .await
        .unwrap();
    let tail = store
        .item_events(&coords("github"), all[3].seq, 100, 0, EventScope::History)
        .await
        .unwrap();
    assert!(tail.is_empty());
}

#[tokio::test]
async fn event_wait_returns_when_a_new_event_lands() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .item_put(
            "github",
            login_put(&[("username", "alice")]),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap();
    let cursor = store
        .item_events(&coords("github"), 0, 100, 0, EventScope::History)
        .await
        .unwrap()
        .last()
        .unwrap()
        .seq;

    let waiter = {
        let store = store.clone();
        tokio::spawn(async move {
            store
                .item_events(&coords("github"), cursor, 100, 30, EventScope::History)
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    store
        .item_reveal(&coords("github"), "username", &actor())
        .await
        .unwrap();
    let events = tokio::time::timeout(Duration::from_secs(10), waiter)
        .await
        .expect("long-poll woke up")
        .unwrap()
        .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].name, "revealed");
}

#[tokio::test(start_paused = true)]
async fn event_wait_times_out_empty() {
    let store = PluginSecretStore::in_memory().unwrap();
    let events = store
        .item_events(&coords("missing"), 0, 10, 2, EventScope::History)
        .await
        .unwrap();
    assert!(events.is_empty());
}

#[tokio::test]
async fn list_narrows_by_environment_and_folder() {
    let store = PluginSecretStore::in_memory().unwrap();
    let mut prod = login_put(&[]);
    prod.environment = Some("prod".into());
    prod.path = Some("/team".into());
    store
        .item_put("a", prod, &actor(), PutAccess::FULL)
        .await
        .unwrap();
    store
        .item_put("b", login_put(&[]), &actor(), PutAccess::FULL)
        .await
        .unwrap();

    assert_eq!(store.item_list(None, None).await.unwrap().len(), 2);
    let only = store.item_list(Some("prod"), Some("team")).await.unwrap();
    assert_eq!(only.len(), 1);
    assert_eq!(
        (only[0].key.as_str(), only[0].path.as_str()),
        ("a", "/team")
    );
    assert_eq!(only[0].field_count, 4);
    assert!(store
        .item_list(Some("default"), Some("/team"))
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn rewrap_reseals_item_values() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .item_put(
            "github",
            login_put(&[("username", "alice"), ("password", "hunter2")]),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        store.keyring.rotate(&conn).unwrap();
    }
    let rewritten = store.rewrap_all(&actor()).await.unwrap();
    assert!(rewritten >= 2);
    assert_eq!(
        store
            .item_reveal(&coords("github"), "password", &actor())
            .await
            .unwrap(),
        "hunter2"
    );
}

#[tokio::test]
async fn put_does_not_confirm_values_the_caller_cannot_read() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .item_put(
            "github",
            login_put(&[("username", "alice"), ("password", "hunter2")]),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap();
    let write_only = PutAccess {
        plain: false,
        sensitive: false,
    };
    let plain_only = PutAccess {
        plain: true,
        sensitive: false,
    };

    // A write-only caller gets the same conflict for a right and a wrong
    // password guess, and the message never names the field.
    let mut messages = Vec::new();
    for guess in ["hunter2", "wrong"] {
        for access in [write_only, plain_only] {
            let error = store
                .item_put(
                    "github",
                    login_put(&[("password", guess)]),
                    &actor(),
                    access,
                )
                .await
                .unwrap_err();
            assert_eq!(code(&error), "vault_conflict");
            assert!(!error.to_string().contains("password"));
            messages.push(error.to_string());
        }
    }
    messages.dedup();
    assert_eq!(messages.len(), 1, "{messages:?}");

    // Non-sensitive values compare for `use`; nothing compares write-only.
    let (outcome, _) = store
        .item_put(
            "github",
            login_put(&[("username", "alice")]),
            &actor(),
            plain_only,
        )
        .await
        .unwrap();
    assert_eq!(outcome, PutOutcome::Unchanged);
    let error = store
        .item_put(
            "github",
            login_put(&[("username", "alice")]),
            &actor(),
            write_only,
        )
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_conflict");
    let (outcome, _) = store
        .item_put("github", login_put(&[]), &actor(), write_only)
        .await
        .unwrap();
    assert_eq!(outcome, PutOutcome::Unchanged);

    // A `read` caller can confirm, and the confirmation is audited.
    let (outcome, _) = store
        .item_put(
            "github",
            login_put(&[("username", "alice"), ("password", "hunter2")]),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap();
    assert_eq!(outcome, PutOutcome::Unchanged);
    let confirms: i64 = store
        .conn
        .lock()
        .await
        .query_row(
            "SELECT COUNT(*) FROM vault_audit WHERE action = 'item.put_confirm'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(confirms >= 1);
}

#[tokio::test]
async fn put_conflicts_on_a_different_description() {
    let store = PluginSecretStore::in_memory().unwrap();
    let mut first = login_put(&[]);
    first.description = Some("Work account".into());
    store
        .item_put("github", first.clone(), &actor(), PutAccess::FULL)
        .await
        .unwrap();
    let (outcome, _) = store
        .item_put("github", first, &actor(), PutAccess::FULL)
        .await
        .unwrap();
    assert_eq!(outcome, PutOutcome::Unchanged);
    let mut other = login_put(&[]);
    other.description = Some("Personal account".into());
    let error = store
        .item_put("github", other, &actor(), PutAccess::FULL)
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_conflict");
    let error = store
        .item_put("github", login_put(&[]), &actor(), PutAccess::FULL)
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_conflict");
}

#[tokio::test]
async fn current_item_events_exclude_earlier_items_at_the_same_key() {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .item_put(
            "github",
            login_put(&[("username", "alice")]),
            &actor(),
            PutAccess::FULL,
        )
        .await
        .unwrap();
    store
        .item_reveal(&coords("github"), "username", &actor())
        .await
        .unwrap();
    store
        .item_delete(&coords("github"), None, &actor())
        .await
        .unwrap();
    let none = store
        .item_events(&coords("github"), 0, 100, 0, EventScope::CurrentItem)
        .await
        .unwrap();
    assert!(none.is_empty(), "no current item, no events");

    let (_, recreated) = store
        .item_put("github", login_put(&[]), &actor(), PutAccess::FULL)
        .await
        .unwrap();
    let current = store
        .item_events(&coords("github"), 0, 100, 0, EventScope::CurrentItem)
        .await
        .unwrap();
    let names: Vec<_> = current.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["created"]);
    assert_eq!(current[0].item_id, recreated.id);
    let history = store
        .item_events(&coords("github"), 0, 100, 0, EventScope::History)
        .await
        .unwrap();
    let names: Vec<_> = history.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["created", "revealed", "deleted", "created"]);
}

#[tokio::test]
async fn environments_holding_items_cannot_be_deleted() {
    let store = PluginSecretStore::in_memory().unwrap();
    let mut staged = login_put(&[]);
    staged.environment = Some("staging".into());
    store
        .item_put("github", staged, &actor(), PutAccess::FULL)
        .await
        .unwrap();
    let error = store
        .delete_environment("staging", &actor())
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_conflict");
    let staging = ItemCoords::new(Some("staging"), None, "github").unwrap();
    store.item_delete(&staging, None, &actor()).await.unwrap();
    store.delete_environment("staging", &actor()).await.unwrap();
}
