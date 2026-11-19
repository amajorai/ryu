use serde_json::json;

use super::*;

fn actor() -> AuditActor {
    AuditActor::new("user", Some("u1"))
}

fn code(error: &anyhow::Error) -> &'static str {
    error
        .downcast_ref::<VaultError>()
        .expect("typed vault error")
        .code()
}

fn field(value: Value) -> FieldDefInput {
    serde_json::from_value(value).unwrap()
}

async fn login(store: &PluginSecretStore) -> (ItemCoords, ItemView) {
    let put: ItemPut = serde_json::from_value(json!({
        "kind": "login",
        "fields": [
            { "name": "username", "type": "text", "required": true },
            { "name": "password", "type": "password", "required": true },
        ],
        "values": { "username": "ada", "password": "pw-1" },
    }))
    .unwrap();
    let (_, view) = store
        .item_put("legacy", put, &actor(), PutAccess::FULL)
        .await
        .unwrap();
    (ItemCoords::new(None, None, "legacy").unwrap(), view)
}

#[tokio::test]
async fn an_optional_field_is_appended_and_keeps_existing_values() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (coords, before) = login(&store).await;
    let added = store
        .item_add_field(
            &coords,
            &before.id,
            before.version,
            &field(json!({ "name": "notes", "label": "Notes", "type": "text" })),
            &actor(),
        )
        .await
        .unwrap();
    assert_eq!(added.version, before.version + 1);
    assert_eq!(added.status, ItemStatus::Ready);
    let names: Vec<&str> = added.fields.iter().map(|f| f.def.name.as_str()).collect();
    assert_eq!(names, ["username", "password", "notes"]);
    assert!(!added.fields[2].has_value);
    assert_eq!(
        store
            .item_reveal(&coords, "password", &actor())
            .await
            .unwrap(),
        "pw-1"
    );

    // The new field takes values like any other.
    let patch: ItemPatch = serde_json::from_value(json!({
        "expectedVersion": added.version,
        "expectedId": added.id,
        "values": { "notes": "kept" },
    }))
    .unwrap();
    let patched = store.item_patch("legacy", patch, &actor()).await.unwrap();
    assert!(patched.fields[2].has_value);

    let events = store
        .item_events(&coords, 0, 50, 0, EventScope::CurrentItem)
        .await
        .unwrap();
    let added_event = events.iter().find(|e| e.name == "field_added").unwrap();
    assert_eq!(added_event.data["field"], "notes");
}

#[tokio::test]
async fn adding_a_field_is_optimistic_and_never_rewrites_the_schema() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (coords, view) = login(&store).await;
    let notes = field(json!({ "name": "notes", "type": "text" }));

    let stale = store
        .item_add_field(&coords, &view.id, view.version + 1, &notes, &actor())
        .await
        .unwrap_err();
    assert_eq!(code(&stale), "vault_conflict");

    let duplicate = field(json!({ "name": "Password", "type": "text" }));
    let error = store
        .item_add_field(&coords, &view.id, view.version, &duplicate, &actor())
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_conflict");

    let required = field(json!({ "name": "pin", "type": "text", "required": true }));
    let error = store
        .item_add_field(&coords, &view.id, view.version, &required, &actor())
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_invalid_request");

    let bad_name = field(json!({ "name": "1bad", "type": "text" }));
    let error = store
        .item_add_field(&coords, &view.id, view.version, &bad_name, &actor())
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_invalid_request");

    let missing = ItemCoords::new(None, None, "absent").unwrap();
    let error = store
        .item_add_field(&missing, &view.id, view.version, &notes, &actor())
        .await
        .unwrap_err();
    assert_eq!(code(&error), "vault_not_found");

    let unchanged = store.item_get(&coords, false).await.unwrap();
    assert_eq!(unchanged.version, view.version);
    assert_eq!(unchanged.fields.len(), 2);
}
