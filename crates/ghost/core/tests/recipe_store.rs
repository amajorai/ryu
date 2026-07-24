//! Integration tests for the JSON-file-backed recipe store.
//!
//! Every test uses `RecipeStore::open_at` against a fresh `tempfile::TempDir`, so
//! the real `~/.ghost` / `GHOST_DATA_DIR` store is never read or written.

use std::collections::HashMap;

use ghost_core::recipe::store::RecipeStore;
use ghost_core::recipe::types::{Recipe, RecipeParam, RecipeStep};

fn tmp_store() -> (tempfile::TempDir, RecipeStore) {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = RecipeStore::open_at(dir.path().join("recipes")).expect("open store");
    (dir, store)
}

fn recipe(name: &str) -> Recipe {
    Recipe {
        schema_version: 2,
        name: name.to_string(),
        description: format!("desc for {name}"),
        app: Some("com.example.app".to_string()),
        params: None,
        preconditions: None,
        steps: vec![RecipeStep {
            id: 1,
            action: "click".to_string(),
            target: None,
            params: None,
            wait_after: None,
            note: None,
            on_failure: None,
        }],
        on_failure: None,
    }
}

#[test]
fn save_then_get_roundtrips_the_recipe() {
    let (_dir, store) = tmp_store();
    let r = recipe("open-inbox");
    store.save(&r).expect("save");

    let loaded = store.get("open-inbox").expect("get");
    assert_eq!(loaded.name, "open-inbox");
    assert_eq!(loaded.schema_version, 2);
    assert_eq!(loaded.steps.len(), 1);
    assert_eq!(loaded.steps[0].action, "click");
    assert_eq!(loaded.app.as_deref(), Some("com.example.app"));
}

#[test]
fn get_missing_recipe_is_an_error() {
    let (_dir, store) = tmp_store();
    let err = store.get("does-not-exist").unwrap_err();
    assert!(
        err.to_string().contains("not found") || err.to_string().contains("does-not-exist"),
        "unexpected error: {err}"
    );
}

#[test]
fn save_overwrites_an_existing_recipe() {
    let (_dir, store) = tmp_store();
    store.save(&recipe("dup")).expect("first save");

    let mut updated = recipe("dup");
    updated.description = "second version".to_string();
    updated.steps.push(RecipeStep {
        id: 2,
        action: "type".to_string(),
        target: None,
        params: None,
        wait_after: None,
        note: None,
        on_failure: None,
    });
    store.save(&updated).expect("overwrite");

    let loaded = store.get("dup").expect("get");
    assert_eq!(loaded.description, "second version");
    assert_eq!(loaded.steps.len(), 2);

    // Overwrite must not create a second file: only one recipe is listed.
    assert_eq!(store.list().expect("list").len(), 1);
}

#[test]
fn list_returns_recipes_sorted_by_name() {
    let (_dir, store) = tmp_store();
    for name in ["zebra", "alpha", "mango"] {
        store.save(&recipe(name)).expect("save");
    }
    let names: Vec<String> = store
        .list()
        .expect("list")
        .into_iter()
        .map(|r| r.name)
        .collect();
    assert_eq!(names, vec!["alpha", "mango", "zebra"]);
}

#[test]
fn list_on_empty_store_is_empty() {
    let (_dir, store) = tmp_store();
    assert!(store.list().expect("list").is_empty());
}

#[test]
fn delete_removes_a_recipe_and_missing_delete_errors() {
    let (_dir, store) = tmp_store();
    store.save(&recipe("temp")).expect("save");
    assert_eq!(store.list().expect("list").len(), 1);

    store.delete("temp").expect("delete");
    assert!(store.list().expect("list").is_empty());
    assert!(store.get("temp").is_err());

    // Deleting again (now missing) is an error, not a silent success.
    assert!(store.delete("temp").is_err());
}

#[test]
fn save_json_parses_and_persists() {
    let (_dir, store) = tmp_store();
    let json = r#"{
        "schema_version": 2,
        "name": "from-json",
        "description": "built from a JSON string",
        "steps": []
    }"#;
    let parsed = store.save_json(json).expect("save_json");
    assert_eq!(parsed.name, "from-json");

    // It is actually on disk and reloadable.
    let loaded = store.get("from-json").expect("get");
    assert_eq!(loaded.description, "built from a JSON string");
    assert!(loaded.steps.is_empty());
}

#[test]
fn save_json_rejects_invalid_json() {
    let (_dir, store) = tmp_store();
    assert!(store.save_json("{ not valid json").is_err());
    // A syntactically valid JSON that is missing required fields also fails.
    assert!(store.save_json(r#"{"name":"x"}"#).is_err());
}

#[test]
fn recipe_name_with_path_separators_is_sanitised_to_one_file() {
    let (_dir, store) = tmp_store();
    // A name containing path separators / reserved chars must not escape the store
    // dir or create nested directories — it is flattened into a single file.
    let evil = "../../etc/pa*ss?wd";
    let mut r = recipe(evil);
    r.description = "sanitise me".to_string();
    store.save(&r).expect("save with unsafe name");

    // It round-trips by the exact same name (the sanitisation is deterministic).
    let loaded = store.get(evil).expect("get by unsafe name");
    assert_eq!(loaded.description, "sanitise me");

    // Exactly one recipe file exists and no traversal happened.
    let listed = store.list().expect("list");
    assert_eq!(listed.len(), 1);
}

#[test]
fn params_and_steps_survive_a_disk_roundtrip() {
    let (_dir, store) = tmp_store();
    let mut params = HashMap::new();
    params.insert(
        "recipient".to_string(),
        RecipeParam {
            param_type: "string".to_string(),
            description: "who to email".to_string(),
            required: Some(true),
        },
    );
    let mut r = recipe("with-params");
    r.params = Some(params);
    store.save(&r).expect("save");

    let loaded = store.get("with-params").expect("get");
    let loaded_params = loaded.params.expect("params present");
    assert_eq!(loaded_params.len(), 1);
    let p = &loaded_params["recipient"];
    assert_eq!(p.param_type, "string");
    assert_eq!(p.required, Some(true));
}
